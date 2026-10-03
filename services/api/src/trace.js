/**
 * The trace: every AWS call, cache decision and fleet change, as it happens.
 *
 * The control-room stats are one-second summaries; this is the event-level
 * record behind them, streamed to the "Under the hood" view over Server-Sent
 * Events in small batches (every 100 ms).
 *
 * ## Who did what
 *
 * Adapter calls are attributed through AsyncLocalStorage: a tile request runs
 * inside a context naming its request id, a completion poll inside one naming
 * the poll, a local worker inside one naming the worker. A wrapped S3 or SQS
 * call reads that context, so an event knows its actor without any function
 * signatures changing.
 *
 * ## Honesty rules
 *
 * Events are only ever emitted for things that happened. When the event rate
 * exceeds the budget, request-level events are dropped and *counted* — the
 * viewer shows "sampled" rather than pretending to see everything — while
 * rare, important events (renders, scaling, task changes) are always kept.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const BATCH_MS = 100;
const RING_SIZE = 1500;

/** Events that are always kept, however busy the system is. */
const ALWAYS_KEEP = new Set(["render", "scale", "task", "scaler", "worker", "hello", "dlq"]);

export const context = new AsyncLocalStorage();

/**
 * @returns {Object} The current attribution context (may be empty)
 */
export function currentContext() {
  return context.getStore() ?? {};
}

export class Trace {
  /**
   * @param {{instanceId: string, platform: string, maxPerSecond?: number}} options - Identity and budget
   */
  constructor({ instanceId, platform, maxPerSecond = 300 }) {
    this.instanceId = instanceId;
    this.platform = platform;
    this.maxPerSecond = maxPerSecond;
    this.seq = 0;
    this.ring = [];
    this.batch = [];
    this.clients = new Set();
    this.windowStart = Date.now();
    this.windowCount = 0;
    this.dropped = 0;
    this.droppedTotal = 0;

    this.timer = setInterval(() => this.#flush(), BATCH_MS);
    this.timer.unref();
  }

  /**
   * Record one event.
   * @param {string} type - Event type
   * @param {Object} fields - Event details
   * @returns {void}
   */
  emit(type, fields = {}) {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;

    if (!ALWAYS_KEEP.has(type) && this.windowCount > this.maxPerSecond) {
      this.dropped += 1;
      this.droppedTotal += 1;
      return;
    }

    const event = { seq: (this.seq += 1), t: now, type, inst: this.instanceId, ...fields };
    this.ring.push(event);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    if (this.clients.size) this.batch.push(event);
  }

  /**
   * Time an async operation and record it as an AWS-style call.
   * @param {string} op - Operation, e.g. "s3:GetObject"
   * @param {Object} fields - Resource details
   * @param {Function} fn - The operation
   * @param {Function} outcome - Maps the result to { status, ...extra }
   * @returns {Promise<any>} The operation's result
   */
  async call(op, fields, fn, outcome = () => ({ status: "ok" })) {
    const started = performance.now();
    const ctx = currentContext();
    try {
      const result = await fn();
      this.emit("call", { op, ...fields, ...ctx, ms: round(performance.now() - started), ...outcome(result) });
      return result;
    } catch (error) {
      this.emit("call", {
        op,
        ...fields,
        ...ctx,
        ms: round(performance.now() - started),
        status: "error",
        error: error.name || error.message,
      });
      throw error;
    }
  }

  /**
   * Attach an SSE client: a hello with recent history, then live batches.
   * @param {Object} response - Node response
   * @returns {void}
   */
  subscribe(response) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      // Ask proxies not to buffer the stream.
      "x-accel-buffering": "no",
    });
    const hello = {
      instanceId: this.instanceId,
      platform: this.platform,
      serverTime: Date.now(),
      recent: this.ring.slice(-400),
    };
    response.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));
  }

  #flush() {
    if (!this.clients.size) {
      this.batch = [];
      return;
    }
    if (!this.batch.length && !this.dropped) {
      // A comment line every 15 s keeps idle connections open through the
      // load balancer's 60 s idle timeout.
      if (Date.now() - (this.lastWrite ?? 0) > 15000) {
        for (const client of this.clients) client.write(": keep-alive\n\n");
        this.lastWrite = Date.now();
      }
      return;
    }
    this.lastWrite = Date.now();
    const frame = `event: batch\ndata: ${JSON.stringify({ events: this.batch, dropped: this.dropped })}\n\n`;
    this.batch = [];
    this.dropped = 0;
    for (const client of this.clients) client.write(frame);
  }
}

const round = (ms) => Math.round(ms * 10) / 10;
