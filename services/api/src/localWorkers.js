/**
 * Local mode only: a pool of render workers inside the API process, each on
 * its own CPU thread.
 *
 * `setCount` lets the control room add and remove workers by hand. That is a
 * stand-in, for development, of what the cloud does automatically: there the
 * worker count is owned by the scaling controller, which reacts to queue
 * depth, and this module is not loaded at all.
 *
 * The pool also presents itself in the same shape as the cloud fleet, so the
 * "Under the hood" view works identically on a laptop.
 */
import { randomBytes } from "node:crypto";
import os from "node:os";
import { startWorker } from "@fractal-farm/worker";
import { context } from "./trace.js";

export const MAX_LOCAL_WORKERS = 16;

const NO_TRACE = { emit() {} };

export class LocalWorkerPool {
  /**
   * @param {Object} deps - { queue, store, notifier, stats, trace }
   */
  constructor({ queue, store, notifier, stats, trace = NO_TRACE }) {
    this.deps = { queue, store, notifier };
    this.stats = stats;
    this.trace = trace;
    this.workers = [];
    this.startedAt = new Map();
  }

  /**
   * @param {number} count - Desired worker count
   * @returns {Promise<number>} Worker count now running
   */
  async setCount(count) {
    const target = Math.max(0, Math.min(MAX_LOCAL_WORKERS, Math.round(count)));

    while (this.workers.length < target) {
      const id = `local-${randomBytes(3).toString("hex")}`;
      const onEvent = (event) => {
        this.stats.workerEvent(event);
        this.#traceWorker(event);
      };
      // Everything this worker does — queue receives, store writes — is
      // attributed to it in the trace.
      const worker = context.run({ actor: "worker", worker: id }, () =>
        startWorker({ id, ...this.deps, onEvent }),
      );
      this.workers.push(worker);
      this.startedAt.set(id, Date.now());
      this.trace.emit("task", { service: "workers", taskId: id, from: null, to: "RUNNING", cpu: 1024, memory: 0 });
    }

    while (this.workers.length > target) {
      const worker = this.workers.pop();
      this.trace.emit("task", { service: "workers", taskId: worker.id, from: "RUNNING", to: "DEACTIVATING" });
      await worker.stop();
      this.stats.removeWorker(worker.id);
      this.startedAt.delete(worker.id);
      this.trace.emit("task", { service: "workers", taskId: worker.id, from: "DEACTIVATING", to: "STOPPED" });
    }

    return this.workers.length;
  }

  #traceWorker(event) {
    if (event.type === "rendered") {
      this.trace.emit("render", {
        workerId: event.workerId,
        renderMs: Math.round(event.renderMs),
        waitedMs: event.waitedMs,
        key: event.key,
        bytes: event.bytes,
        via: "direct",
      });
    } else if (event.type === "busy" || event.type === "failed" || event.type === "expired" || event.type === "duplicate") {
      this.trace.emit("worker", { state: event.type, workerId: event.workerId, key: event.key, error: event.error });
    }
  }

  /**
   * The pool in the same shape as the cloud fleet snapshot.
   * @returns {Object} Fleet picture
   */
  snapshot() {
    const n = this.workers.length;
    return {
      at: new Date().toISOString(),
      workers: { desired: n, running: n, pending: 0 },
      api: { desired: 1, running: 1, pending: 0 },
      tasks: [
        { id: "local-api", service: "api", lastStatus: "RUNNING", az: os.hostname(), ip: "127.0.0.1", cpu: 0, memory: 0, startedAt: null },
        ...this.workers.map((w) => ({
          id: w.id,
          service: "workers",
          lastStatus: "RUNNING",
          az: os.hostname(),
          ip: "127.0.0.1",
          cpu: 1024,
          memory: 0,
          startedAt: this.startedAt.get(w.id),
        })),
      ],
      scaler: null,
    };
  }
}
