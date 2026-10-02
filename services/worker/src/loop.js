/**
 * The render worker loop: worker-pull load distribution.
 *
 * A worker asks the queue for one job only when it is free, so load spreads
 * itself across however many workers exist — nothing has to know the worker
 * count, and adding workers (scaling out) needs no reconfiguration anywhere.
 *
 * Every step is safe to repeat. A queue may deliver a message twice, and a
 * crashed worker's message is redelivered to another; checking the store
 * first turns a duplicate into a cheap no-op instead of a wasted render.
 */
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { encodeTile } from "@fractal-farm/core";
import { RenderThread } from "./renderPool.js";

const gzipAsync = promisify(gzip);

/**
 * Start one worker.
 * @param {Object} options - { id, queue, store, notifier, onEvent }
 * @returns {{id: string, stop: Function}} Handle
 */
export function startWorker({ id, queue, store, notifier, onEvent = () => {} }) {
  const thread = new RenderThread();
  let running = true;

  const loop = async () => {
    onEvent({ type: "idle", workerId: id });
    let backoffMs = 500;

    while (running) {
      let lease;
      try {
        lease = await queue.receive({ waitMs: 20000 });
        backoffMs = 500;
      } catch (error) {
        // The queue being briefly unreachable must not kill the worker.
        onEvent({ type: "receive-error", workerId: id, error: error.message });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 10000);
        continue;
      }

      if (!lease || !running) {
        await lease?.release();
        continue;
      }

      const { job } = lease;

      try {
        if (await store.has(job.key)) {
          await notifier.publish(job.key, { workerId: id, duplicate: true });
          await lease.ack();
          onEvent({ type: "duplicate", workerId: id, key: job.key });
          continue;
        }

        onEvent({ type: "busy", workerId: id, key: job.key });

        const started = performance.now();
        const tile = await thread.render(job);
        const renderMs = performance.now() - started;

        const bytes = await gzipAsync(encodeTile({ ...tile, renderMs, workerId: id }));
        await store.put(job.key, bytes);
        await notifier.publish(job.key, { workerId: id, renderMs });
        await lease.ack();

        onEvent({
          type: "rendered",
          workerId: id,
          key: job.key,
          renderMs,
          bytes: bytes.byteLength,
          waitedMs: Date.now() - job.enqueuedAt,
          attempts: lease.attempts,
        });
      } catch (error) {
        // Stopping mid-render is a scale-in, not a fault: return the job unpenalised.
        if (!running) {
          await lease.release();
          continue;
        }
        await lease.retry(error.message);
        onEvent({ type: "failed", workerId: id, key: job.key, error: error.message });
      } finally {
        if (running) onEvent({ type: "idle", workerId: id });
      }
    }
  };

  const done = loop().catch((error) => onEvent({ type: "crashed", workerId: id, error: error.message }));

  return {
    id,
    /**
     * Stop taking work. With a grace period, a render already under way may
     * finish and be stored first — how a container honours SIGTERM on scale-in.
     * @param {{graceMs?: number}} options - How long to let current work finish
     * @returns {Promise<void>}
     */
    stop: async ({ graceMs = 0 } = {}) => {
      running = false;
      if (graceMs > 0) {
        await Promise.race([done, new Promise((resolve) => setTimeout(resolve, graceMs))]);
      }
      await thread.close();
    },
  };
}
