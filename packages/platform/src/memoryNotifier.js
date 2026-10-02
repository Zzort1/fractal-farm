/**
 * "Tile ready" notifications: publish-subscribe on tile keys.
 *
 * A request that misses every cache subscribes to its tile's key and waits;
 * the worker that finishes the tile publishes on that key. With several API
 * instances in the cloud the worker cannot know which instance is waiting,
 * so this becomes a shared pub-sub channel (Redis) — the interface is the same.
 */
import { EventEmitter } from "node:events";

export class MemoryNotifier {
  constructor() {
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
  }

  /**
   * @param {string} key - Tile key
   * @param {Object} payload - Completion details
   * @returns {Promise<void>}
   */
  async publish(key, payload) {
    this.events.emit(key, payload);
  }

  /**
   * Wait for one completion of `key`.
   * @param {string} key - Tile key
   * @param {number} timeoutMs - Longest wait
   * @returns {Promise<Object|null>} Payload, or null on timeout
   */
  waitFor(key, timeoutMs) {
    return new Promise((resolve) => {
      const onReady = (payload) => {
        clearTimeout(timer);
        resolve(payload);
      };
      const timer = setTimeout(() => {
        this.events.off(key, onReady);
        resolve(null);
      }, timeoutMs);
      this.events.once(key, onReady);
    });
  }
}
