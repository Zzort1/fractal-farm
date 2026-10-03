/**
 * The explainer: a narrated, step-by-step walk through either one tile's
 * real journey (rebuilt from the trace) or a guided tour of the design.
 *
 * Each step spotlights its components on the map and re-enacts its events
 * slowly; live traffic is muted on the map meanwhile (the call log stays
 * live). A journey that is still in progress keeps growing as its events
 * arrive, so "follow next miss" narrates a tile as it is being made.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { TOUR, buildJourney } from "./explain.js";

const STEP_MS = 3200;

const TONES = {
  sky: "var(--sky)",
  cyan: "var(--cyan)",
  lime: "var(--lime)",
  gold: "var(--gold)",
  magenta: "var(--magenta)",
  violet: "var(--violet)",
  orange: "var(--orange)",
  red: "var(--red)",
  muted: "var(--muted)",
};

const rel = (ms) => (ms >= 1000 ? `+${(ms / 1000).toFixed(2)}s` : `+${Math.round(ms)}ms`);

/**
 * @param {{bus: Object, mode: string, tileKey?: string, speed: number, onKey: Function, onClose: Function}} props - What to explain
 * @returns {JSX.Element} Panel
 */
export default function Explainer({ bus, mode, tileKey, speed, onKey, onClose }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [, setTick] = useState(0);
  const listRef = useRef(null);

  // Live journeys grow: rebuild a few times a second.
  useEffect(() => {
    if (mode !== "journey") return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), 400);
    return () => clearInterval(timer);
  }, [mode]);

  // "Follow next miss": wait for the next job to be queued, then follow its tile.
  useEffect(() => {
    if (mode !== "waiting") return undefined;
    return bus.subscribe((events) => {
      const queued = events.find((e) => e.type === "call" && /SendMessage|enqueue/.test(e.op) && e.key);
      if (queued) onKey(queued.key);
    });
  }, [mode, bus, onKey]);

  // Capture this tile's events into our own store the moment it is chosen,
  // and keep adding to it: the shared history is a short ring that a busy
  // system overwrites in seconds.
  const capture = useRef(null);
  useEffect(() => {
    if (mode !== "journey" || !tileKey) return undefined;
    const store = {
      key: tileKey,
      events: bus.events.filter((e) => e.key === tileKey),
      // Request lines carry no key; keep recent ones to match by request id.
      requests: bus.events.filter((e) => e.type === "request"),
      droppedAtStart: bus.droppedTotal,
    };
    capture.current = store;
    return bus.subscribe((events) => {
      for (const e of events) {
        if (e.key === tileKey) store.events.push(e);
        else if (e.type === "request") {
          store.requests.push(e);
          if (store.requests.length > 4000) store.requests.splice(0, 2000);
        }
      }
    });
  }, [mode, tileKey, bus]);

  const captured = capture.current?.key === tileKey ? capture.current : null;
  const journey =
    mode === "journey" && tileKey
      ? buildJourney(captured ? [...captured.requests, ...captured.events] : bus.events, tileKey)
      : null;
  const sampled = captured && bus.droppedTotal > captured.droppedAtStart;
  const steps = mode === "tour" ? TOUR : (journey?.steps ?? []);
  const step = steps[Math.min(index, steps.length - 1)];

  // Mute live traffic on the map while explaining; restore on close.
  useEffect(() => {
    bus.ui.muteLive = mode !== "waiting";
    return () => {
      bus.ui.muteLive = false;
      bus.ui.highlight = [];
    };
  }, [bus, mode]);

  // Entering a step: spotlight it and re-enact its events.
  const stepId = step ? `${mode}:${tileKey}:${index}` : null;
  useEffect(() => {
    if (!step) return;
    bus.ui.highlight = step.highlight ?? [];
    if (step.events?.length) bus.replay(step.events);
    listRef.current?.querySelector(".ex-step.current")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId]);

  // Auto-advance; a live journey waits at its end for more to happen.
  useEffect(() => {
    if (!playing || !steps.length) return undefined;
    if (index >= steps.length - 1) {
      if (mode === "tour" || journey?.complete) setPlaying(false);
      return undefined;
    }
    const timer = setTimeout(() => setIndex((i) => i + 1), STEP_MS / (speed || 1));
    return () => clearTimeout(timer);
  }, [playing, index, steps.length, mode, journey?.complete, speed]);

  // A new subject starts from the top.
  useEffect(() => {
    setIndex(0);
    setPlaying(true);
  }, [mode, tileKey]);

  const startedAt = journey?.started ?? 0;
  const title = useMemo(() => {
    if (mode === "tour") return "Guided tour of the architecture";
    if (mode === "waiting") return "Waiting for the next cache miss…";
    return "Journey of one tile";
  }, [mode]);

  return (
    <div className="explainer">
      <div className="ex-head">
        <div>
          <b>{title}</b>
          {tileKey && mode === "journey" && <code title={tileKey}>{tileKey}</code>}
        </div>
        <button type="button" className="ex-close" onClick={onClose} aria-label="Close explainer">
          ✕
        </button>
      </div>

      {mode === "waiting" ? (
        <p className="ex-wait">
          Zoom the mini fractal into somewhere new (or run a load test). The first tile that misses every cache will be followed
          from request to pixels, live.
        </p>
      ) : (
        <>
          <div className="ex-progress">
            <span style={{ width: `${steps.length ? ((index + 1) / steps.length) * 100 : 0}%` }} />
          </div>

          {step && (
            <div className="ex-current" style={{ "--tone": TONES[step.tone] ?? "var(--sky)" }}>
              <div className="ex-current-title">
                <i />
                <b>{step.title}</b>
                {mode === "journey" && step.at && <small>{rel(step.at - startedAt)}</small>}
              </div>
              <p>{step.text}</p>
              {step.why && (
                <p className="ex-why">
                  <b>Why:</b> {step.why}
                </p>
              )}
            </div>
          )}

          <div className="ex-controls">
            <button type="button" onClick={() => setIndex(0)} aria-label="First step">
              ⏮
            </button>
            <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))} aria-label="Previous step">
              ◀
            </button>
            <button type="button" className="ex-play" onClick={() => setPlaying((p) => !p)}>
              {playing ? "❚❚ pause" : "▶ play"}
            </button>
            <button type="button" onClick={() => setIndex((i) => Math.min(steps.length - 1, i + 1))} aria-label="Next step">
              ▶
            </button>
            <button type="button" onClick={() => step && bus.replay(step.events ?? [])} aria-label="Replay this step">
              ↻
            </button>
            <span className="ex-count">
              {steps.length ? index + 1 : 0} / {steps.length}
              {mode === "journey" && !journey?.complete ? " · live" : ""}
            </span>
          </div>

          <ol className="ex-steps" ref={listRef}>
            {steps.map((s, i) => (
              <li
                key={`${i}-${s.title}`}
                className={`ex-step${i === index ? " current" : ""}${i < index ? " done" : ""}`}
                style={{ "--tone": TONES[s.tone] ?? "var(--sky)" }}
                onClick={() => {
                  setIndex(i);
                  setPlaying(false);
                }}
              >
                <i />
                <span>{s.title}</span>
                {mode === "journey" && s.at && <small>{rel(s.at - startedAt)}</small>}
              </li>
            ))}
          </ol>
          {mode === "journey" && !steps.length && (
            <p className="ex-wait">No events for this tile are left in the history. Try “Follow next miss”.</p>
          )}
          {sampled && (
            <p className="hint ex-foot c-orange">
              The system is busy: some events were sampled out, so this journey may be missing steps.
            </p>
          )}
          <p className="hint ex-foot">Live traffic is paused on the map while explaining; the call log stays live.</p>
        </>
      )}
    </div>
  );
}
