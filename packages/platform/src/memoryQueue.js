/**
 * In-process job queue with the same contract as a managed message queue.
 *
 * Workers *pull*: they call receive() when they are free, so a slow worker
 * never has work pushed onto it. A received message is invisible to other
 * workers until it is acknowledged or returned, and a message that fails
 * `maxAttempts` times moves to a dead-letter list instead of looping forever.
 * The cloud adapter swaps this for SQS without the callers changing.
 */
export class MemoryQueue {
  /**
   * @param {{maxAttempts?: number}} options - Retry policy
   */
  constructor({ maxAttempts = 3 } = {}) {
    this.maxAttempts = maxAttempts;
    this.visible = [];
    this.inflight = 0;
    this.deadLetters = [];
    this.waiters = [];
  }

  /**
   * Enqueue a job.
   * @param {Object} job - Job body
   * @returns {Promise<void>}
   */
  async send(job) {
    this.#deliver({ job, attempts: 0 });
  }

  /**
   * Take the next job, waiting up to waitMs for one to arrive (long polling).
   * @param {{waitMs?: number}} options - Wait budget
   * @returns {Promise<{job: Object, attempts: number, ack: Function, retry: Function}|null>} A lease on one job, or null if none arrived
   */
  receive({ waitMs = 20000 } = {}) {
    const next = this.visible.shift();
    if (next) return Promise.resolve(this.#lease(next));

    return new Promise((resolve) => {
      const waiter = (message) => {
        clearTimeout(timer);
        resolve(this.#lease(message));
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, waitMs);
      this.waiters.push(waiter);
    });
  }

  /**
   * @returns {{visible: number, inflight: number, deadLetters: number}} Queue depth
   */
  depth() {
    return {
      visible: this.visible.length,
      inflight: this.inflight,
      deadLetters: this.deadLetters.length,
    };
  }

  #deliver(message) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.visible.push(message);
  }

  #lease(message) {
    this.inflight += 1;
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      this.inflight -= 1;
      return true;
    };

    return {
      job: message.job,
      attempts: message.attempts + 1,
      ack: () => {
        settle();
      },
      // Hand the job back untouched — not a failure, e.g. the worker is stopping.
      release: () => {
        if (!settle()) return;
        this.visible.unshift(message);
        const waiter = this.waiters.shift();
        if (waiter) waiter(this.visible.shift());
      },
      retry: (reason) => {
        if (!settle()) return;
        const attempts = message.attempts + 1;
        if (attempts >= this.maxAttempts) {
          this.deadLetters.push({ job: message.job, attempts, reason: String(reason ?? "") });
        } else {
          this.#deliver({ job: message.job, attempts });
        }
      },
    };
  }
}
