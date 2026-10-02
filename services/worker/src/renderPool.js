/**
 * One dedicated render thread, restarted if it crashes.
 */
import { Worker } from "node:worker_threads";

export class RenderThread {
  constructor() {
    this.seq = 0;
    this.pending = new Map();
    this.#spawn();
  }

  #spawn() {
    this.thread = new Worker(new URL("./renderThread.js", import.meta.url));

    this.thread.on("message", ({ seq, tile, error }) => {
      const entry = this.pending.get(seq);
      if (!entry) return;
      this.pending.delete(seq);
      if (error) entry.reject(new Error(error));
      else entry.resolve(tile);
    });

    this.thread.on("error", (error) => this.#failAll(error));

    this.thread.on("exit", (code) => {
      if (this.closed) return;
      this.#failAll(new Error(`Render thread exited with code ${code}`));
      this.#spawn();
    });
  }

  #failAll(error) {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  /**
   * @param {Object} spec - Canonical tile spec
   * @returns {Promise<Object>} Raw tile data
   */
  render(spec) {
    const seq = (this.seq += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.thread.postMessage({ seq, spec });
    });
  }

  /** @returns {Promise<void>} */
  async close() {
    this.closed = true;
    await this.thread.terminate();
  }
}
