/**
 * "Tile ready" detection by polling the store — the completion signal *is*
 * the object appearing.
 *
 * Used when no shared pub-sub channel is available (ElastiCache and SNS are
 * denied in the CAB432 account). It works across any number of API and worker
 * instances with no extra infrastructure, at the cost of a little latency and
 * some HEAD requests. Polling backs off from 100 ms to 2 s, so a fast render
 * is noticed quickly while a long wait stays cheap.
 *
 * publish() is a no-op: the worker's store write already announced it.
 */
const FIRST_POLL_MS = 100;
const MAX_POLL_MS = 2000;

export class StorePollingNotifier {
  /**
   * @param {{store: Object}} options - Store to watch
   */
  constructor({ store }) {
    this.store = store;
  }

  async publish() {}

  /**
   * @param {string} key - Tile key
   * @param {number} timeoutMs - Longest wait
   * @returns {Promise<Object|null>} { polled: n } once present, or null on timeout
   */
  async waitFor(key, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let delay = FIRST_POLL_MS;
    let polls = 0;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, deadline - Date.now())));
      polls += 1;
      try {
        if (await this.store.has(key)) return { polled: polls };
      } catch {
        // A failed check is just a missed poll; keep waiting.
      }
      delay = Math.min(MAX_POLL_MS, delay * 1.6);
    }
    return null;
  }
}
