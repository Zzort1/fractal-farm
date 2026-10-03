/**
 * The AWS call log: every traced event as one line, newest first, in the
 * vocabulary AWS itself uses — s3:GetObject, sqs:SendMessage,
 * ecs:UpdateService — with who made the call, on what, and how it went.
 *
 * Refreshes four times a second rather than per event, so a load test cannot
 * flood the page with renders.
 */
import { useEffect, useState } from "react";

const FILTERS = {
  all: () => true,
  http: (e) => e.type === "request" || e.type === "response",
  s3: (e) => e.svc === "s3",
  sqs: (e) => e.svc === "sqs",
  ecs: (e) => e.type === "task" || e.type === "scale" || e.type === "scaler",
  render: (e) => e.type === "render" || e.type === "worker" || e.type === "coalesced",
};

const SOURCE_CLASS = { memory: "c-cyan", store: "c-lime", render: "c-magenta", browser: "c-sky" };

const pad = (n, w = 2) => String(n).padStart(w, "0");
const clock = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};
const kb = (bytes) => (bytes ? `${(bytes / 1024).toFixed(1)} KB` : "");
const ms = (v) => (v === undefined || v === null ? "" : `${v}ms`);

/** Who made the call, as shown in the actor column. */
function actorOf(e) {
  if (e.actor === "worker" || e.worker) return { text: e.worker ?? e.workerId, cls: "c-magenta" };
  if (e.actor === "poll") return { text: "poll", cls: "c-gold" };
  if (e.req) return { text: `api #${e.req}`, cls: "c-cyan" };
  if (e.type === "scale" || e.type === "scaler") return { text: "scaler", cls: "c-violet" };
  if (e.type === "task") return { text: "ecs", cls: "c-violet" };
  if (e.type === "render") return { text: e.workerId, cls: "c-magenta" };
  return { text: e.inst ?? "api", cls: "c-cyan" };
}

/**
 * @param {Object} e - Trace event
 * @returns {{op: string, opCls: string, detail: string, result: string, resultCls: string}|null} Display line
 */
function describe(e) {
  switch (e.type) {
    case "request":
      return { op: "elb:Forward", opCls: "c-sky", detail: `GET ${e.path}${e.query ? `?${e.query}` : ""}`, result: "", resultCls: "" };
    case "response": {
      const ok = e.status === 200;
      const cls = ok ? SOURCE_CLASS[e.source] ?? "c-text" : e.status === 202 ? "c-gold" : e.status >= 400 ? "c-red" : "c-muted";
      return {
        op: `http:${e.status}`,
        opCls: cls,
        detail: ok ? `${e.source} · ${e.key}` : e.status === 202 ? `rendering · ${e.key}` : (e.error ?? e.location ?? ""),
        result: [ms(e.ms), kb(e.bytes)].filter(Boolean).join(" · "),
        resultCls: cls,
      };
    }
    case "call": {
      const cls = e.svc === "s3" ? "c-lime" : e.svc === "sqs" ? "c-gold" : "c-text";
      const statusCls = e.status === "error" ? "c-red" : e.status === 404 ? "c-orange" : "c-muted";
      let detail = e.key ?? e.res;
      if (e.op === "sqs:GetQueueAttributes" || e.op === "queue:depth") detail = `${e.res} · visible ${e.visible} · in flight ${e.inflight}`;
      return {
        op: e.op,
        opCls: cls,
        detail,
        result: [e.status === "error" ? e.error : e.status, ms(e.ms), kb(e.bytes)].filter((v) => v !== "" && v !== undefined).join(" · "),
        resultCls: statusCls,
      };
    }
    case "cache":
      return { op: "lru:get", opCls: "c-cyan", detail: e.key, result: e.hit ? "HIT" : "miss", resultCls: e.hit ? "c-cyan" : "c-muted" };
    case "coalesced":
      return { op: "coalesce", opCls: "c-gold", detail: `joined render in flight · ${e.key}`, result: "", resultCls: "" };
    case "render":
      return {
        op: "render",
        opCls: "c-magenta",
        detail: e.key,
        result: `${e.renderMs}ms cpu · waited ${e.waitedMs}ms${e.via === "tile-header" ? " · via tile header" : ""}`,
        resultCls: "c-magenta",
      };
    case "worker":
      return { op: `worker:${e.state}`, opCls: e.state === "failed" ? "c-red" : "c-magenta", detail: e.key ?? "", result: e.error ?? "", resultCls: "c-red" };
    case "task":
      return {
        op: "ecs:Task",
        opCls: "c-violet",
        detail: `${e.service} ${e.taskId} ${e.from ?? "∅"} → ${e.to}${e.az ? ` · ${e.az}` : ""}${e.ip ? ` · ${e.ip}` : ""}`,
        result: e.cpu ? `${e.cpu / 1024} vCPU${e.memory ? ` · ${e.memory / 1024} GB` : ""}` : (e.reason ?? ""),
        resultCls: "c-muted",
      };
    case "scale":
      return { op: "ecs:UpdateService", opCls: "c-violet", detail: `fractal-worker desired ${e.from} → ${e.to}`, result: e.reason, resultCls: e.to > e.from ? "c-lime" : "c-orange" };
    case "scaler":
      return { op: "scaler:tick", opCls: "c-violet", detail: `queue ${e.visible} + ${e.inflight} in flight · wants ${e.wanted}`, result: e.reason, resultCls: "c-muted" };
    case "job-timeout":
      return { op: "job:timeout", opCls: "c-red", detail: e.key, result: "re-queued on next request", resultCls: "c-red" };
    default:
      return null;
  }
}

const isControl = (e) => e.control || e.type === "scaler";

/**
 * @param {{bus: Object, onFollow?: Function, focus?: Object|null, onClearFocus?: Function}} props - Trace bus; follow a tile; component focus from the map
 * @returns {JSX.Element} Panel
 */
export default function CallLog({ bus, onFollow, focus = null, onClearFocus }) {
  const [, setTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("all");
  const [showControl, setShowControl] = useState(false);

  useEffect(() => {
    if (paused) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(timer);
  }, [paused]);

  const lines = [];
  for (let i = bus.events.length - 1; i >= 0 && lines.length < 160; i -= 1) {
    const e = bus.events[i];
    if (!showControl && isControl(e)) continue;
    if (!FILTERS[filter](e)) continue;
    if (focus && !focus.match(e)) continue;
    const line = describe(e);
    if (line) lines.push({ e, ...line });
  }

  return (
    <aside className="panel panel-left call-log">
      <h2>
        <span className={`dot ${bus.connected ? "dot-lime pulse" : "dot-red"}`} />
        AWS call log <small>{bus.platform ?? "connecting"} · instance {bus.instance ?? "?"}</small>
      </h2>
      <div className="log-controls">
        <div className="chips">
          {Object.keys(FILTERS).map((name) => (
            <button key={name} type="button" className={`chip${filter === name ? " active" : ""}`} onClick={() => setFilter(name)}>
              {name}
            </button>
          ))}
        </div>
        <div className="log-toggles">
          <button type="button" className={`chip${paused ? " active" : ""}`} onClick={() => setPaused((p) => !p)}>
            {paused ? "▶ resume" : "❚❚ pause"}
          </button>
          <label className="toggle-inline">
            <input type="checkbox" checked={showControl} onChange={(event) => setShowControl(event.target.checked)} />
            control traffic
          </label>
        </div>
        {focus && (
          <div className="log-focus">
            focus: <b>{focus.label}</b>
            <button type="button" onClick={onClearFocus} aria-label="Clear focus">
              ✕
            </button>
          </div>
        )}
        <p className="hint">
          Click a line to explain that tile's journey · {bus.received.toLocaleString()} events received
          {bus.droppedTotal > 0 && <span className="c-orange"> · {bus.droppedTotal.toLocaleString()} sampled out under load</span>}
        </p>
      </div>
      <ol className="log-lines">
        {lines.map(({ e, op, opCls, detail, result, resultCls }) => {
          const actor = actorOf(e);
          return (
            <li
              key={`${e.inst}-${e.seq}`}
              className={e.key ? "followable" : ""}
              onClick={e.key ? () => onFollow?.(e.key) : undefined}
              title={e.key ? "Explain this tile's journey, step by step" : undefined}
            >
              <span className="log-time">{clock(e.t)}</span>
              <span className={`log-actor ${actor.cls}`}>{actor.text}</span>
              <span className={`log-op ${opCls}`}>{op}</span>
              <span className="log-detail">{detail}</span>
              <span className={`log-result ${resultCls}`}>{result}</span>
            </li>
          );
        })}
        {lines.length === 0 && <li className="hint">Waiting for traffic — zoom the mini fractal to make some.</li>}
      </ol>
    </aside>
  );
}
