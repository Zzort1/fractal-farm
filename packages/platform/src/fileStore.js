/**
 * Durable tile store on the local filesystem, standing in for an object store.
 *
 * Keys are the tile keys from core (slash-separated), so the directory layout
 * matches the eventual bucket layout exactly. Writes go to a temporary file
 * and are renamed into place, so a reader never sees half a tile — the same
 * all-or-nothing guarantee an object store PUT gives.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class FileStore {
  /**
   * @param {{root: string}} options - Root directory
   */
  constructor({ root }) {
    this.root = path.resolve(root, "tiles");
  }

  #pathFor(key) {
    const resolved = path.resolve(this.root, `${key}.bin.gz`);
    // Keys come from canonicalised input, but never trust that to stay true.
    if (!resolved.startsWith(this.root + path.sep)) {
      throw new Error(`Key escapes the store: ${key}`);
    }
    return resolved;
  }

  /**
   * @param {string} key - Tile key
   * @returns {Promise<Buffer|null>} Stored bytes, or null when absent
   */
  async get(key) {
    try {
      return await readFile(this.#pathFor(key));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * @param {string} key - Tile key
   * @returns {Promise<boolean>} True when present
   */
  async has(key) {
    try {
      await stat(this.#pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} key - Tile key
   * @param {Buffer} bytes - Gzipped tile
   * @returns {Promise<void>}
   */
  async put(key, bytes) {
    const target = this.#pathFor(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes);
    try {
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
