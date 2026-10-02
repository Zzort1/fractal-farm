/**
 * Right panel: the system, live. Everything here comes from the API's stats
 * stream, so it shows what the cloud is doing rather than what this browser did.
 */
import { SOURCE_COLOURS } from "../viewer/FractalCanvas.jsx";
import Sparkline from "./Sparkline.jsx";
import { useStats } from "./useStats.js";

const formatBytes = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

const postJson = (path, body) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

/**
 * @param {{onFlushed: Function}} props - Called after the server cache is flushed
 * @returns {JSX.Element} Panel
 */
export default function ControlRoom({ onFlushed }) {
  const { stats, connected } = useStats();

  if (!stats) {
    return (
      <aside className="panel panel-right">
        <h2>
          <span className={`dot ${connected ? "dot-lime" : "dot-red"}`} />
          Control room
        </h2>
        <p className="hint">Connecting to the farm…</p>
      </aside>
    );
  }

  const { counters, history, workers, queue, cache, recent } = stats;
  const latest = history.at(-1) ?? {};
  const served = counters.memory + counters.store + counters.render;
  const share = (n) => (served ? (n / served) * 100 : 0);
  const busy = workers.filter((w) => w.state === "busy").length;

  const setWorkers = (count) => postJson("/api/workers", { count });
  const flush = async () => {
    await postJson("/api/cache/flush");
    onFlushed();
  };

  return (
    <aside className="panel panel-right">
      <h2>
        <span className={`dot ${connected ? "dot-lime pulse" : "dot-red"}`} />
        Control room <small>{stats.platform}</small>
      </h2>

      <div className="kpis">
        <div className="kpi kpi-magenta">
          <b>{latest.requests ?? 0}</b>
          <span>requests/s</span>
        </div>
        <div className="kpi kpi-cyan">
          <b>{latest.rendered ?? 0}</b>
          <span>renders/s</span>
        </div>
        <div className="kpi kpi-lime">
          <b>{Math.round(stats.hitRatio * 100)}%</b>
          <span>cache hits</span>
        </div>
        <div className="kpi kpi-gold">
          <b>{queue.visible}</b>
          <span>queued · {queue.inflight} in flight</span>
        </div>
      </div>

      <section>
        <h3>Where tiles came from</h3>
        <div className="stacked-bar">
          <span style={{ width: `${share(counters.memory)}%`, background: SOURCE_COLOURS.memory }} />
          <span style={{ width: `${share(counters.store)}%`, background: SOURCE_COLOURS.store }} />
          <span style={{ width: `${share(counters.render)}%`, background: SOURCE_COLOURS.render }} />
        </div>
        <div className="legend">
          <span>
            <i style={{ background: SOURCE_COLOURS.memory }} />
            memory {counters.memory}
          </span>
          <span>
            <i style={{ background: SOURCE_COLOURS.store }} />
            store {counters.store}
          </span>
          <span>
            <i style={{ background: SOURCE_COLOURS.render }} />
            rendered {counters.render}
          </span>
        </div>
        <p className="hint">
          {counters.coalesced} coalesced · {counters.pending} polls · {counters.redirects} redirects ·{" "}
          {counters.rejected} rejected · {queue.deadLetters} dead-lettered
        </p>
      </section>

      <section>
        <h3>
          Queue depth <small>last 2 min</small>
        </h3>
        <Sparkline values={history.map((h) => h.queueDepth)} colour="#ffd60a" />
        <h3>
          Busy workers <small>of {workers.length}</small>
        </h3>
        <Sparkline values={history.map((h) => h.busyWorkers)} colour="#ff2bd6" max={workers.length} />
        <h3>Requests per second</h3>
        <Sparkline values={history.map((h) => h.requests)} colour="#00f5d4" />
      </section>

      <section>
        <h3>
          Workers <small>{busy} busy</small>
          {stats.platform === "local" && (
            <span className="stepper">
              <button type="button" onClick={() => setWorkers(workers.length - 1)} aria-label="Remove a worker">
                −
              </button>
              <button type="button" onClick={() => setWorkers(workers.length + 1)} aria-label="Add a worker">
                +
              </button>
            </span>
          )}
        </h3>
        <div className="workers">
          {workers.map((worker) => (
            <div key={worker.id} className={`worker ${worker.state}`} style={{ "--worker": worker.colour }}>
              <i />
              <span className="worker-id">{worker.id}</span>
              <span className="worker-stat">
                {worker.tiles} tiles · {worker.avgMs}ms
              </span>
            </div>
          ))}
          {workers.length === 0 && <p className="hint">No workers — scaled to zero.</p>}
        </div>
      </section>

      <section>
        <h3>
          Memory cache <small>{cache.entries} tiles</small>
        </h3>
        <div className="meter">
          <span style={{ width: `${Math.min(100, (cache.bytes / cache.maxBytes) * 100)}%` }} />
        </div>
        <p className="hint">
          {formatBytes(cache.bytes)} of {formatBytes(cache.maxBytes)} · {cache.evictions} evicted
        </p>
        <button type="button" className="button button-ghost" onClick={flush}>
          Flush memory cache
        </button>
      </section>

      <section className="feed-section">
        <h3>Recent renders</h3>
        <ol className="feed">
          {recent.slice(0, 14).map((render) => (
            <li key={`${render.key}-${render.at}`}>
              <i style={{ background: render.colour }} />
              <span className="feed-key">{render.key}</span>
              <span className="feed-ms">{render.renderMs}ms</span>
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}
