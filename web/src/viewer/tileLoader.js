/**
 * Fetches tiles in priority order and keeps the decoded results.
 *
 * Each frame the viewer hands over the tiles it wants, nearest the centre
 * first. The loader fetches the most important ones it does not have, a few
 * at a time. A 202 means "the farm is rendering it": the tile is retried with
 * backoff, but only while it is still wanted — pan away and the polling for
 * it simply stops.
 */
import { decodeTile } from "@fractal-farm/core";

const MAX_CONCURRENT = 6;
const MAX_ENTRIES = 900;
const RETRY_BASE_MS = 350;
const RETRY_MAX_MS = 2500;

export class TileLoader {
  /**
   * @param {{onChange: Function}} options - Called whenever a tile changes state
   */
  constructor({ onChange }) {
    this.onChange = onChange;
    this.entries = new Map();
    this.wanted = [];
    this.wantedSet = new Set();
    this.active = 0;
  }

  /**
   * @param {string} url - Tile URL
   * @returns {Object|undefined} Entry
   */
  get(url) {
    return this.entries.get(url);
  }

  /**
   * Declare which tiles are wanted now, most important first.
   * @param {string[]} urls - Tile URLs
   * @returns {void}
   */
  want(urls) {
    this.wanted = urls;
    this.wantedSet = new Set(urls);
    this.#pump();
  }

  #pump() {
    const now = performance.now();

    for (const url of this.wanted) {
      if (this.active >= MAX_CONCURRENT) break;
      const entry = this.entries.get(url);
      if (!entry || ((entry.state === "waiting" || entry.state === "error") && entry.retryAt <= now)) {
        this.#load(url, entry);
      }
    }

    this.#evict();
  }

  async #load(url, previous) {
    const entry = previous ?? { state: "new", attempts: 0, sawPending: false };
    entry.state = "loading";
    entry.attempts += 1;
    this.entries.set(url, entry);
    this.active += 1;

    try {
      const response = await fetch(url);

      if (response.status === 202) {
        entry.sawPending = true;
        this.#retryLater(entry, "waiting");
      } else if (response.ok) {
        const tile = decodeTile(await response.arrayBuffer());
        entry.state = "ready";
        entry.tile = tile;
        // A tile that made us wait was rendered for us, whatever layer the
        // final poll happened to be answered from.
        entry.source = entry.sawPending ? "render" : (response.headers.get("x-cache") ?? "edge");
        entry.arrivedAt = performance.now();
        entry.stamp = null;
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      entry.error = error.message;
      this.#retryLater(entry, "error");
    } finally {
      this.active -= 1;
      this.onChange();
      this.#pump();
    }
  }

  #retryLater(entry, state) {
    entry.state = state;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 1.5 ** Math.min(entry.attempts - 1, 6));
    entry.retryAt = performance.now() + delay;
    setTimeout(() => this.#pump(), delay + 5);
  }

  #evict() {
    if (this.entries.size <= MAX_ENTRIES) return;
    // Map order is insertion order: drop the oldest tiles nobody wants now.
    for (const [url, entry] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES * 0.8) break;
      if (!this.wantedSet.has(url) && entry.state !== "loading") this.entries.delete(url);
    }
  }

  /** Forget everything, e.g. after the server cache was flushed. */
  clear() {
    this.entries.clear();
  }
}
