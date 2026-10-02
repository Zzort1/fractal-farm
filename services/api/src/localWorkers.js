/**
 * Local mode only: a pool of render workers inside the API process, each on
 * its own CPU thread.
 *
 * `setCount` lets the control room add and remove workers by hand. That is a
 * stand-in, for development, of what the cloud does automatically: there the
 * worker count is owned by the container service's auto-scaling policy, which
 * reacts to queue depth, and this module is not loaded at all.
 */
import { randomBytes } from "node:crypto";
import { startWorker } from "@fractal-farm/worker";

export const MAX_LOCAL_WORKERS = 16;

export class LocalWorkerPool {
  /**
   * @param {Object} deps - { queue, store, notifier, stats }
   */
  constructor({ queue, store, notifier, stats }) {
    this.deps = { queue, store, notifier };
    this.stats = stats;
    this.workers = [];
  }

  /**
   * @param {number} count - Desired worker count
   * @returns {Promise<number>} Worker count now running
   */
  async setCount(count) {
    const target = Math.max(0, Math.min(MAX_LOCAL_WORKERS, Math.round(count)));

    while (this.workers.length < target) {
      const id = `local-${randomBytes(3).toString("hex")}`;
      this.workers.push(
        startWorker({ id, ...this.deps, onEvent: (event) => this.stats.workerEvent(event) }),
      );
    }

    while (this.workers.length > target) {
      const worker = this.workers.pop();
      await worker.stop();
      this.stats.removeWorker(worker.id);
    }

    return this.workers.length;
  }
}
