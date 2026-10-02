/**
 * Least-recently-used byte cache.
 *
 * Bounded by bytes, not entries, because that is what actually runs out. A
 * JavaScript Map iterates in insertion order, so re-inserting on every hit
 * keeps the least recently used entry first, ready to evict.
 */
export class MemoryCache {
  /**
   * @param {{maxBytes: number}} options - Byte budget
   */
  constructor({ maxBytes }) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.entries = new Map();
    this.evictions = 0;
  }

  /**
   * @param {string} key - Cache key
   * @returns {Buffer|undefined} Cached bytes
   */
  get(key) {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /**
   * @param {string} key - Cache key
   * @param {Buffer} value - Bytes to cache
   * @returns {void}
   */
  set(key, value) {
    if (value.byteLength > this.maxBytes) return;

    const existing = this.entries.get(key);
    if (existing) {
      this.bytes -= existing.byteLength;
      this.entries.delete(key);
    }

    this.entries.set(key, value);
    this.bytes += value.byteLength;

    while (this.bytes > this.maxBytes) {
      const [oldestKey, oldest] = this.entries.entries().next().value;
      this.entries.delete(oldestKey);
      this.bytes -= oldest.byteLength;
      this.evictions += 1;
    }
  }

  /** @returns {void} */
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  /**
   * @returns {{entries: number, bytes: number, maxBytes: number, evictions: number}} Usage
   */
  stats() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      evictions: this.evictions,
    };
  }
}
