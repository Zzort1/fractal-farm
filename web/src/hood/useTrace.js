/**
 * The browser end of the trace: one EventSource on /api/trace, a ring of
 * recent events for the call log, rolling one-minute windows for rates and
 * latency percentiles, and subscribers (the animated map) that receive each
 * batch as it lands.
 */
import { useEffect, useRef, useState } from "react";

const RING = 800;
const WINDOW_MS = 60_000;

function createBus() {
  return {
    events: [],
    listeners: new Set(),
    instance: null,
    platform: null,
    connected: false,
    received: 0,
    droppedTotal: 0,
    window: [], // { t, kind, ms?, bytes?, source?, status? }

    push(events, dropped = 0) {
      const now = Date.now();
      this.droppedTotal += dropped;
      for (const event of events) {
        this.received += 1;
        this.events.push(event);
        const kind = windowKind(event);
        if (kind) this.window.push({ t: now, kind, ms: event.ms, bytes: event.bytes, source: event.source, status: event.status });
      }
      if (this.events.length > RING) this.events.splice(0, this.events.length - RING);
      while (this.window.length && now - this.window[0].t > WINDOW_MS) this.window.shift();
      for (const listener of this.listeners) listener(events, dropped);
    },

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },

    // --- explainer channel: replays and shared view state -------------------

    /** Components to spotlight on the map ("api:*" / "wk:*" mean all of a kind). */
    ui: { highlight: [], muteLive: false },
    replayListeners: new Set(),

    /** Re-enact past events on the map, slowly and labelled. */
    replay(events) {
      for (const listener of this.replayListeners) listener(events);
    },

    onReplay(listener) {
      this.replayListeners.add(listener);
      return () => this.replayListeners.delete(listener);
    },

    /**
     * Rates and latency over the last `seconds`.
     * @param {number} seconds - Window length
     * @returns {Object} Metrics
     */
    metrics(seconds = 10) {
      const since = Date.now() - seconds * 1000;
      const recent = this.window.filter((w) => w.t >= since);
      const count = (kind) => recent.filter((w) => w.kind === kind).length;
      const responses = recent.filter((w) => w.kind === "response");
      const tiles = responses.filter((w) => w.status === 200);
      const latencies = responses.map((w) => w.ms ?? 0).sort((a, b) => a - b);
      const pct = (p) => (latencies.length ? Math.round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]) : null);
      const bytesOut = tiles.reduce((n, w) => n + (w.bytes ?? 0), 0);
      return {
        seconds,
        requestsPerS: count("request") / seconds,
        s3GetPerS: count("s3:get") / seconds,
        s3HeadPerS: count("s3:head") / seconds,
        s3PutPerS: count("s3:put") / seconds,
        sqsSendPerS: count("sqs:send") / seconds,
        sqsAttrPerS: count("sqs:attr") / seconds,
        rendersPerS: count("render") / seconds,
        p50: pct(0.5),
        p95: pct(0.95),
        hitShare: tiles.length ? tiles.filter((w) => w.source !== "render").length / tiles.length : null,
        bytesOutPerS: bytesOut / seconds,
        status202: responses.filter((w) => w.status === 202).length,
      };
    },
  };
}

/** Which rolling counter an event feeds, if any. */
function windowKind(event) {
  switch (event.type) {
    case "request":
    case "response":
    case "render":
      return event.type;
    case "call":
      if (event.op === "s3:GetObject" || event.op === "fs:readFile") return "s3:get";
      if (event.op === "s3:HeadObject" || event.op === "fs:stat") return "s3:head";
      if (event.op === "s3:PutObject" || event.op === "fs:writeFile") return "s3:put";
      if (event.op === "sqs:SendMessage" || event.op === "queue:enqueue") return "sqs:send";
      if (event.op === "sqs:GetQueueAttributes") return "sqs:attr";
      return null;
    default:
      return null;
  }
}

/**
 * @param {boolean} enabled - Connect only while the view is open
 * @returns {Object} The bus (stable across renders)
 */
export function useTrace(enabled) {
  const busRef = useRef(null);
  if (!busRef.current) busRef.current = createBus();
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const bus = busRef.current;
    const source = new EventSource("/api/trace");

    source.addEventListener("hello", (message) => {
      const hello = JSON.parse(message.data);
      bus.instance = hello.instanceId;
      bus.platform = hello.platform;
      bus.connected = true;
      bus.push(hello.recent ?? []);
      setTick((t) => t + 1);
    });
    source.addEventListener("batch", (message) => {
      const { events, dropped } = JSON.parse(message.data);
      bus.connected = true;
      bus.push(events, dropped);
    });
    source.onerror = () => {
      bus.connected = false;
      setTick((t) => t + 1);
    };

    return () => {
      source.close();
      bus.connected = false;
    };
  }, [enabled]);

  return busRef.current;
}
