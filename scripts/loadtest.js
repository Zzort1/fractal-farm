/**
 * Load generator: simulated explorers requesting tiles.
 *
 *   node scripts/loadtest.js [--base http://localhost:8787] [--users 24]
 *        [--duration 60] [--fractal lyapunov] [--iter 1024] [--hot 0.4]
 *
 * Each virtual user picks a tile, polls through any 202 until it has the
 * tile, then picks another. A `--hot` fraction of picks come from a small set
 * of popular tiles (everyone starts at the home view), the rest from a random
 * deep zoom — that skew is what gives a realistic cache hit ratio rather than
 * 0% (all unique) or 100% (all identical).
 *
 * Reports throughput, where tiles came from, and time-to-tile percentiles.
 */
import { canonicalParams, getFractal, tileUrl } from "@fractal-farm/core";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);

const base = args.base ?? "http://localhost:8787";
const users = Number(args.users ?? 24);
const durationMs = Number(args.duration ?? 60) * 1000;
const fractalId = args.fractal ?? "lyapunov";
const hotShare = Number(args.hot ?? 0.4);
const fractal = getFractal(fractalId);
const { query } = canonicalParams(fractalId, args.iter ? { iter: args.iter } : {});

/** Popular tiles: the first three zoom levels, which every visitor sees. */
const hot = [];
for (let z = 0; z <= 2; z += 1) {
  for (let x = 0; x < 2 ** z; x += 1) for (let y = 0; y < 2 ** z; y += 1) hot.push({ z, x, y });
}

function pick() {
  if (Math.random() < hotShare) return hot[Math.floor(Math.random() * hot.length)];
  const z = 4 + Math.floor(Math.random() * Math.min(10, fractal.maxZoom - 4));
  const n = 2 ** z;
  return { z, x: Math.floor(Math.random() * n), y: Math.floor(Math.random() * n) };
}

const results = { tiles: 0, sources: {}, polls: 0, errors: 0, latencies: [] };
const deadline = Date.now() + durationMs;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function user() {
  while (Date.now() < deadline) {
    const url = base + tileUrl({ fractal: fractalId, query, ...pick() });
    const started = Date.now();
    let waited = false;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url);
        if (response.status === 202) {
          results.polls += 1;
          waited = true;
          await sleep(500);
          continue;
        }
        await response.arrayBuffer();
        if (!response.ok) throw new Error(String(response.status));
        const source = waited ? "render" : (response.headers.get("x-cache") ?? "edge");
        results.sources[source] = (results.sources[source] ?? 0) + 1;
        results.tiles += 1;
        results.latencies.push(Date.now() - started);
      } catch {
        results.errors += 1;
        await sleep(500);
      }
      break;
    }
  }
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

const report = setInterval(() => {
  const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  console.log(
    `${String(remaining).padStart(3)}s left · ${results.tiles} tiles · ${JSON.stringify(results.sources)} · ${results.polls} polls · ${results.errors} errors`,
  );
}, 5000);

console.log(`${users} users × ${durationMs / 1000}s on ${fractalId} (${query}) against ${base}, ${hotShare * 100}% hot`);
await Promise.all(Array.from({ length: users }, user));
clearInterval(report);

const sorted = results.latencies.sort((a, b) => a - b);
const hits = (results.sources.memory ?? 0) + (results.sources.store ?? 0) + (results.sources.edge ?? 0);
console.log("\n— summary —");
console.log(`tiles          ${results.tiles} (${(results.tiles / (durationMs / 1000)).toFixed(1)}/s)`);
console.log(`sources        ${JSON.stringify(results.sources)}`);
console.log(`hit ratio      ${results.tiles ? ((hits / results.tiles) * 100).toFixed(1) : 0}%`);
console.log(`time to tile   p50 ${percentile(sorted, 0.5)}ms · p95 ${percentile(sorted, 0.95)}ms · max ${sorted.at(-1) ?? 0}ms`);
console.log(`polls/errors   ${results.polls} / ${results.errors}`);
