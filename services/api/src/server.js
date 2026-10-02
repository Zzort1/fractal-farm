/**
 * Fractal Farm tile API.
 *
 *   GET  /tiles/{fractal}/{z}/{x}/{y}?{params}   a tile (200), "rendering" (202) or a redirect to the canonical URL (301)
 *   GET  /api/fractals                           the catalogue
 *   GET  /api/stats                              one stats snapshot
 *   GET  /api/events                             stats as a Server-Sent Events stream
 *   POST /api/cache/flush                        empty this instance's memory cache (demo)
 *   POST /api/workers  {"count": n}              local mode: set the worker count by hand
 *   GET  /healthz                                load balancer health check
 *
 * Stateless apart from caches: any instance can answer any request, which is
 * what lets a load balancer spread requests across however many are running.
 */
import { createServer } from "node:http";
import { ParamError, listFractals } from "@fractal-farm/core";
import { createPlatform, loadConfig } from "@fractal-farm/platform";
import { LocalWorkerPool } from "./localWorkers.js";
import { Stats } from "./stats.js";
import { TileService } from "./tiles.js";

const config = loadConfig();
const platform = createPlatform(config);
const stats = new Stats({ queue: platform.queue, cache: platform.cache, platform: config.platform });
const tiles = new TileService({ ...platform, stats, renderWaitMs: config.renderWaitMs });

const localWorkers =
  config.platform === "local" ? new LocalWorkerPool({ ...platform, stats }) : null;

const TILE_PATH = /^\/tiles\/([a-z0-9-]+)\/(\d{1,2})\/(\d{1,15})\/(\d{1,15})$/;
const MAX_BODY_BYTES = 4096;

/**
 * @param {Object} response - Node response
 * @param {number} status - HTTP status
 * @param {Object} body - JSON body
 * @param {Object} headers - Extra headers
 * @returns {void}
 */
function sendJson(response, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.byteLength,
    "cache-control": "no-store",
    ...headers,
  });
  response.end(payload);
}

/**
 * @param {Object} request - Node request
 * @returns {Promise<Object>} Parsed JSON body
 */
async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new ParamError("Request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ParamError("Body is not valid JSON");
  }
}

/**
 * @param {Object} response - Node response
 * @param {RegExpMatchArray} match - Tile path match
 * @param {URL} url - Request URL
 * @returns {Promise<void>}
 */
async function handleTile(response, match, url) {
  stats.count("requests");

  const result = await tiles.get({
    fractal: match[1],
    z: Number(match[2]),
    x: Number(match[3]),
    y: Number(match[4]),
    search: url.searchParams,
    rawQuery: url.search.replace(/^\?/, ""),
  });

  switch (result.status) {
    case 200:
      stats.count(result.source);
      response.writeHead(200, {
        "content-type": "application/x-fractal-tile",
        "content-encoding": "gzip",
        "content-length": result.body.byteLength,
        // Immutable: the bytes behind this URL can never change.
        "cache-control": "public, max-age=31536000, immutable",
        "x-cache": result.source,
      });
      response.end(result.body);
      return;

    case 202:
      stats.count("pending");
      sendJson(response, 202, { status: "rendering" }, { "retry-after": "1" });
      return;

    case 301:
      stats.count("redirects");
      response.writeHead(301, {
        location: result.location,
        "cache-control": "public, max-age=86400",
      });
      response.end();
      return;

    default:
      stats.count("rejected");
      sendJson(response, result.status, { error: result.error });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");

  try {
    if (request.method === "GET") {
      const match = url.pathname.match(TILE_PATH);
      if (match) return await handleTile(response, match, url);

      if (url.pathname === "/healthz") return sendJson(response, 200, { status: "ok" });
      if (url.pathname === "/api/fractals") return sendJson(response, 200, { fractals: listFractals() });
      if (url.pathname === "/api/stats") return sendJson(response, 200, stats.snapshot());
      if (url.pathname === "/api/events") return stats.subscribe(response);
    }

    if (request.method === "POST" && url.pathname === "/api/cache/flush") {
      platform.cache.clear();
      return sendJson(response, 200, { flushed: true });
    }

    if (request.method === "POST" && url.pathname === "/api/workers") {
      if (!localWorkers) {
        return sendJson(response, 409, { error: "Worker count is managed by auto-scaling in this environment" });
      }
      const { count } = await readJson(request);
      if (!Number.isFinite(count)) throw new ParamError("count must be a number");
      return sendJson(response, 200, { workers: await localWorkers.setCount(count) });
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof ParamError) {
      stats.count("rejected");
      return sendJson(response, 400, { error: error.message });
    }
    console.error("Request failed", request.method, url.pathname, error);
    if (!response.headersSent) sendJson(response, 500, { error: "Internal error" });
  }
});

server.listen(config.port, config.host, async () => {
  console.log(`Fractal Farm API (${config.platform}) on http://localhost:${config.port}`);
  if (localWorkers) {
    const count = await localWorkers.setCount(config.localWorkers);
    console.log(`  ${count} local render workers started`);
  }
});
