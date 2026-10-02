/**
 * Live system statistics, streamed to the control room.
 *
 * Counters accumulate; once a second a snapshot (with per-second rates and a
 * rolling history for sparklines) is pushed to every connected browser over
 * Server-Sent Events — a one-way stream on plain HTTP, which is all a
 * dashboard needs.
 *
 * Local mode sees worker events directly. In the cloud, workers are separate
 * containers the API cannot hear from, so it learns about them from the tiles
 * they produce — every tile header names its worker and render time — and
 * reads queue depth from SQS.
 */
import { workerColour } from "@fractal-farm/core";

const HISTORY_SECONDS = 120;
const RECENT_RENDERS = 40;
/** Cloud mode: a worker seen this recently counts as busy; after WORKER_FORGET_MS it is dropped. */
const WORKER_ACTIVE_MS = 4000;
const WORKER_FORGET_MS = 5 * 60 * 1000;

export class Stats {
  /**
   * @param {{queue: Object, cache: Object, platform: string, fleet?: Object}} deps - Sources of gauge readings
   */
  constructor({ queue, cache, platform, fleet = null }) {
    this.fleet = fleet;
    this.queue = queue;
    this.cache = cache;
    this.platform = platform;
    this.startedAt = Date.now();
    this.counters = {
      requests: 0,
      memory: 0,
      store: 0,
      render: 0,
      pending: 0,
      coalesced: 0,
      enqueued: 0,
      rendered: 0,
      failed: 0,
      duplicates: 0,
      jobTimeouts: 0,
      redirects: 0,
      rejected: 0,
    };
    this.workers = new Map();
    this.recent = [];
    this.history = [];
    this.clients = new Set();
    this.lastCounters = { ...this.counters };
    this.depth = { visible: 0, inflight: 0, deadLetters: 0 };

    // Never overlap ticks: a slow SQS read should delay one frame, not stack them.
    let ticking = false;
    this.timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      this.#tick()
        .catch((error) => console.error("Stats tick failed:", error.message))
        .finally(() => (ticking = false));
    }, 1000);
    this.timer.unref();
  }

  /**
   * @param {string} name - Counter name
   * @param {number} by - Increment
   * @returns {void}
   */
  count(name, by = 1) {
    this.counters[name] = (this.counters[name] ?? 0) + by;
  }

  /**
   * Record a worker lifecycle event.
   * @param {Object} event - From the worker loop
   * @returns {void}
   */
  workerEvent(event) {
    const worker = this.workers.get(event.workerId) ?? {
      id: event.workerId,
      colour: workerColour(event.workerId),
      state: "idle",
      tiles: 0,
      totalMs: 0,
      lastMs: 0,
      key: null,
    };
    this.workers.set(event.workerId, worker);

    switch (event.type) {
      case "idle":
        worker.state = "idle";
        worker.key = null;
        break;
      case "busy":
        worker.state = "busy";
        worker.key = event.key;
        break;
      case "rendered":
        worker.tiles += 1;
        worker.totalMs += event.renderMs;
        worker.lastMs = event.renderMs;
        this.count("rendered");
        this.recent.unshift({
          key: event.key,
          workerId: event.workerId,
          colour: worker.colour,
          renderMs: Math.round(event.renderMs),
          waitedMs: event.waitedMs,
          at: Date.now(),
        });
        this.recent.length = Math.min(this.recent.length, RECENT_RENDERS);
        break;
      case "duplicate":
        this.count("duplicates");
        break;
      case "failed":
      case "crashed":
        this.count("failed");
        console.error(`Worker ${event.workerId} ${event.type}:`, event.error);
        break;
      default:
        break;
    }
  }

  /**
   * @param {string} workerId - Worker that has stopped
   * @returns {void}
   */
  removeWorker(workerId) {
    this.workers.delete(workerId);
  }

  /**
   * @returns {Object} Current snapshot
   */
  snapshot() {
    const served = this.counters.memory + this.counters.store + this.counters.render;
    return {
      platform: this.platform,
      uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      counters: { ...this.counters },
      hitRatio: served ? (this.counters.memory + this.counters.store) / served : 0,
      queue: this.depth,
      cache: this.cache.stats(),
      workers: [...this.workers.values()].map((w) => ({
        id: w.id,
        colour: w.colour,
        state: this.#workerState(w),
        key: w.key,
        tiles: w.tiles,
        lastMs: Math.round(w.lastMs),
        avgMs: w.tiles ? Math.round(w.totalMs / w.tiles) : 0,
      })),
      recent: this.recent,
      fleet: this.fleet?.snapshot() ?? null,
      history: this.history,
    };
  }

  /**
   * Attach an SSE client.
   * @param {Object} response - Node response
   * @returns {void}
   */
  subscribe(response) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify(this.snapshot())}\n\n`);
    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));
  }

  /**
   * Cloud mode: record a render observed through its tile header.
   * @param {{workerId: string, renderMs: number, key: string, waitedMs?: number}} render - What the tile says
   * @returns {void}
   */
  observeRender(render) {
    this.workerEvent({ type: "rendered", ...render });
    this.workers.get(render.workerId).lastSeen = Date.now();
  }

  #workerState(worker) {
    if (worker.lastSeen === undefined) return worker.state;
    return Date.now() - worker.lastSeen < WORKER_ACTIVE_MS ? "busy" : "idle";
  }

  async #refreshDepth() {
    try {
      this.depth = await this.queue.depth();
    } catch (error) {
      console.error("Queue depth unavailable:", error.message);
    }
  }

  async #tick() {
    await this.#refreshDepth();

    for (const [id, worker] of this.workers) {
      if (worker.lastSeen !== undefined && Date.now() - worker.lastSeen > WORKER_FORGET_MS) {
        this.workers.delete(id);
      }
    }

    const c = this.counters;
    const last = this.lastCounters;
    const servedNow = c.memory + c.store + c.render - (last.memory + last.store + last.render);
    const hitsNow = c.memory + c.store - (last.memory + last.store);

    this.history.push({
      t: Date.now(),
      requests: c.requests - last.requests,
      rendered: c.rendered - last.rendered,
      hitRatio: servedNow ? hitsNow / servedNow : null,
      queueDepth: this.depth.visible,
      // In the cloud, messages in flight are exactly the jobs workers hold.
      busyWorkers:
        this.platform === "local"
          ? [...this.workers.values()].filter((w) => w.state === "busy").length
          : this.depth.inflight,
      workers: this.fleet?.snapshot()?.workers?.running ?? this.workers.size,
    });
    if (this.history.length > HISTORY_SECONDS) this.history.shift();
    this.lastCounters = { ...c };

    if (this.clients.size === 0) return;
    const frame = `data: ${JSON.stringify(this.snapshot())}\n\n`;
    for (const client of this.clients) client.write(frame);
  }
}
