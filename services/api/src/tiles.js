/**
 * Serving one tile request through the cache layers.
 *
 *   1. in-memory cache     microseconds; per instance (shared in the cloud)
 *   2. tile store          milliseconds; durable, shared by everyone
 *   3. render              seconds; queue a job and wait for a worker
 *
 * Every hit is copied up into the faster layer above it. The CDN edge sits in
 * front of all of this in the cloud; it caches the 200 responses because their
 * URLs are immutable, and never the 202s.
 *
 * Two behaviours keep a burst of identical requests from becoming a burst of
 * identical renders:
 *
 *  - **Request coalescing.** While a tile is being rendered, later requests for
 *    it join the existing wait instead of queueing another job.
 *  - **Bounded waiting.** A request waits a short time for its render, then
 *    answers 202 and the client polls. Connections are not held for the length
 *    of a slow render, and a lost job is re-queued once its wait expires.
 */
import { canonicalParams, getFractal, isValidTile, tileKey, tileUrl } from "@fractal-farm/core";

/** How long a queued job may go unanswered before it is assumed lost. */
const JOB_TIMEOUT_MS = 120_000;

export class TileService {
  /**
   * @param {Object} deps - { queue, store, cache, notifier, stats, renderWaitMs }
   */
  constructor({ queue, store, cache, notifier, stats, renderWaitMs }) {
    this.queue = queue;
    this.store = store;
    this.cache = cache;
    this.notifier = notifier;
    this.stats = stats;
    this.renderWaitMs = renderWaitMs;
    /** key → Promise resolving when the tile's job completes or times out */
    this.pending = new Map();
  }

  /**
   * Resolve a tile request.
   * @param {{fractal: string, z: number, x: number, y: number, search: URLSearchParams, rawQuery: string}} request - Parsed request
   * @returns {Promise<Object>} One of { status: 200, body, source } | { status: 202 } | { status: 301, location } | { status: 400|404, error }
   */
  async get({ fractal: fractalId, z, x, y, search, rawQuery }) {
    const fractal = getFractal(fractalId);
    if (!fractal) return { status: 404, error: `Unknown fractal: ${fractalId}` };
    if (!isValidTile(fractal, z, x, y)) return { status: 404, error: "Tile out of range" };

    // canonicalParams throws ParamError on bad input; the caller maps it to 400.
    const { params, query, key: paramKey } = canonicalParams(fractalId, search);

    if (rawQuery !== query) {
      return { status: 301, location: tileUrl({ fractal: fractalId, query, z, x, y }) };
    }

    const key = tileKey({ fractal: fractalId, paramKey, z, x, y });

    const cached = this.cache.get(key);
    if (cached) return { status: 200, body: cached, source: "memory", key };

    const stored = await this.store.get(key);
    if (stored) {
      this.cache.set(key, stored);
      return { status: 200, body: stored, source: "store", key };
    }

    let done = this.pending.get(key);
    if (done) {
      this.stats.count("coalesced");
    } else {
      done = this.#enqueue(key, { fractal: fractalId, params, paramKey, z, x, y });
    }

    const payload = await Promise.race([done, delay(this.renderWaitMs)]);
    if (!payload) return { status: 202, key };

    const rendered = await this.store.get(key);
    if (!rendered) return { status: 202, key };

    this.cache.set(key, rendered);
    return { status: 200, body: rendered, source: "render", key };
  }

  /**
   * Queue a render and remember that it is in flight.
   * @param {string} key - Tile key
   * @param {Object} spec - Canonical tile spec
   * @returns {Promise<Object|null>} Completion payload, or null if the job timed out
   */
  #enqueue(key, spec) {
    // Subscribe before sending, so even an instant completion is not missed.
    const done = this.notifier.waitFor(key, JOB_TIMEOUT_MS).then((payload) => {
      this.pending.delete(key);
      if (!payload) this.stats.count("jobTimeouts");
      return payload;
    });

    this.pending.set(key, done);
    this.stats.count("enqueued");

    this.queue.send({ ...spec, key, enqueuedAt: Date.now() }).catch((error) => {
      // The job never reached the queue; let the next request try again.
      console.error("Failed to enqueue", key, error.message);
      this.pending.delete(key);
    });

    return done;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms));
