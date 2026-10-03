/**
 * The strip above the map: the numbers behind the animation, refreshed twice
 * a second — traffic, latency, caching, the queue, the Fargate fleet, and a
 * running cost estimate built from what is actually billed right now.
 */
import { useEffect, useRef, useState } from "react";
import { PRICES, computeHourly, fixedHourly, money, requestsHourly } from "./pricing.js";

const SPEEDS = [1, 0.5, 0.25];

/**
 * @param {Object} props - { bus, fleet, stats, platform, speed, onSpeed, showControl, onShowControl, onExplain }
 * @returns {JSX.Element} Strip
 */
export default function HoodMetrics({ bus, fleet, stats, platform, speed, onSpeed, showControl, onShowControl, onExplain }) {
  const [, setTick] = useState(0);
  const session = useRef({ usd: 0, last: performance.now(), opened: Date.now() });

  const m = bus.metrics(10);
  const compute = computeHourly(fleet?.tasks ?? []);
  const local = platform === "local";
  const perHour = local ? 0 : compute.perHour + fixedHourly() + requestsHourly(m);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(timer);
  }, []);

  // Integrate the running rate into a cost for this viewing session.
  const nowMs = performance.now();
  session.current.usd += (perHour * (nowMs - session.current.last)) / 3_600_000;
  session.current.last = nowMs;

  const depth = stats?.queue ?? { visible: 0, inflight: 0, deadLetters: 0 };
  const pct = (v) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);
  const num = (v, d = 1) => (v === null || v === undefined ? "–" : v.toFixed(d));
  const openMin = Math.max(1, Math.round((Date.now() - session.current.opened) / 60000));

  return (
    <div className="hood-metrics">
      <div className="hm hm-sky">
        <b>{num(m.requestsPerS)}</b>
        <span>req/s via ALB</span>
        <small>
          p50 {m.p50 ?? "–"} ms · p95 {m.p95 ?? "–"} ms
        </small>
      </div>
      <div className="hm hm-cyan">
        <b>{pct(m.hitShare)}</b>
        <span>served from cache</span>
        <small>server 60 s: {pct(stats?.recentHitRatio)}</small>
      </div>
      <div className="hm hm-gold">
        <b>
          {depth.visible}
          <em> + {depth.inflight}</em>
        </b>
        <span>SQS waiting + in flight</span>
        <small className={depth.deadLetters ? "c-red" : ""}>DLQ {depth.deadLetters}</small>
      </div>
      <div className="hm hm-magenta">
        <b>
          {fleet?.workers?.running ?? "–"}
          <em>/{fleet?.workers?.desired ?? "–"}</em>
        </b>
        <span>workers running/desired</span>
        <small>{num(m.rendersPerS)} renders/s</small>
      </div>
      <div className="hm hm-violet">
        <b>{local ? "local" : `${num(compute.vcpu, 2)}`}</b>
        <span>{local ? "no cloud billing" : "vCPU billed now"}</span>
        <small>{local ? "worker threads" : `${num(compute.gb, 1)} GB · ${compute.billed} tasks`}</small>
      </div>
      <div className="hm hm-lime" title={`Approximate ${PRICES.region} on-demand list prices; excludes free tier. Verify with the AWS Pricing Calculator.`}>
        <b>{local ? "$0" : money(perHour)}</b>
        <span>per hour at this rate*</span>
        <small>
          {local ? "—" : `${money(session.current.usd)} over ${openMin} min · ≈${money(perHour * 730)}/mo`}
        </small>
      </div>
      <div className="hm-controls">
        <div className="chips">
          {SPEEDS.map((s) => (
            <button key={s} type="button" className={`chip${speed === s ? " active" : ""}`} onClick={() => onSpeed(s)}>
              {s === 1 ? "1×" : s === 0.5 ? "½×" : "¼×"}
            </button>
          ))}
        </div>
        <label className="toggle-inline">
          <input type="checkbox" checked={showControl} onChange={(e) => onShowControl(e.target.checked)} />
          control traffic
        </label>
        <small className="hint">
          {bus.received.toLocaleString()} events
          {bus.droppedTotal ? ` · ${bus.droppedTotal.toLocaleString()} sampled` : ""}
        </small>
      </div>
      <div className="hm-explain">
        <button type="button" className="explain-button" onClick={() => onExplain("waiting")} title="Narrate the next tile that misses every cache, live">
          ◎ Follow next miss
        </button>
        <button type="button" className="explain-button" onClick={() => onExplain("latest")} title="Replay the most recently rendered tile, step by step">
          ↺ Explain latest tile
        </button>
        <button type="button" className="explain-button" onClick={() => onExplain("tour")} title="A guided walk through the architecture">
          ✦ Guided tour
        </button>
      </div>
    </div>
  );
}
