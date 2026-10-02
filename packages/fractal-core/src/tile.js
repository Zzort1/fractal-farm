/**
 * Tile geometry, rendering and the binary tile format.
 *
 * Tiles follow the same pyramid as web maps: zoom level z divides a fractal's
 * home square into 2^z × 2^z tiles, each TILE_SIZE pixels square. A tile is
 * therefore named by (fractal, params, z, x, y), and that name is both its URL
 * and its cache key in every layer.
 *
 * ## Wire format (little-endian)
 *
 *   offset  size  field
 *   0       4     magic "FRT1"
 *   4       2     width
 *   6       2     height
 *   8       4     render time, ms
 *   12      20    worker id, ASCII, NUL-padded
 *   32      2·N   values  — Uint16, 0 = interior, else 1 + value/scale·65534
 *   32+2N   N     classes — Uint8
 *
 * The header makes a tile self-describing: wherever it is served from — memory,
 * object store, CDN edge — it still says which worker rendered it and how long
 * that took, which is what the viewer's worker overlay draws.
 */
import { getFractal } from "./fractals.js";

export const TILE_SIZE = 256;
export const HEADER_BYTES = 32;
const MAGIC = "FRT1";
const WORKER_ID_BYTES = 20;
const VALUE_MAX = 65534;

/**
 * Complex-plane bounds of one tile.
 * @param {Object} fractal - Fractal definition
 * @param {number} z - Zoom level
 * @param {number} x - Tile column
 * @param {number} y - Tile row
 * @param {number} size - Pixels per side
 * @returns {{re0: number, im0: number, step: number}} Top-left corner and pixel size
 */
export function tileBounds(fractal, z, x, y, size = TILE_SIZE) {
  const { re, im, span } = fractal.home;
  const tileSpan = span / 2 ** z;

  return {
    re0: re - span / 2 + x * tileSpan,
    im0: im + span / 2 - y * tileSpan,
    step: tileSpan / size,
  };
}

/**
 * Whether (z, x, y) names a real tile of this fractal.
 * @param {Object} fractal - Fractal definition
 * @param {number} z - Zoom level
 * @param {number} x - Tile column
 * @param {number} y - Tile row
 * @returns {boolean} True when in range
 */
export function isValidTile(fractal, z, x, y) {
  if (![z, x, y].every(Number.isSafeInteger)) return false;
  if (z < 0 || z > fractal.maxZoom) return false;
  const count = 2 ** z;
  return x >= 0 && y >= 0 && x < count && y < count;
}

/**
 * Render one tile. Pure and synchronous: the same input always yields the
 * same output, which is what makes every cache layer safe to keep forever.
 *
 * @param {{fractal: string, params: Object, z: number, x: number, y: number, size?: number}} spec - Canonical tile spec
 * @returns {{width: number, height: number, values: Uint16Array, classes: Uint8Array}} Raw tile data
 */
export function renderTile({ fractal: fractalId, params, z, x, y, size = TILE_SIZE }) {
  const fractal = getFractal(fractalId);
  if (!fractal) throw new Error(`Unknown fractal: ${fractalId}`);
  if (!isValidTile(fractal, z, x, y)) throw new Error(`Tile out of range: ${z}/${x}/${y}`);

  const { re0, im0, step } = tileBounds(fractal, z, x, y, size);
  const scale = fractal.valueScale(params);
  const values = new Uint16Array(size * size);
  const classes = new Uint8Array(size * size);
  const out = new Float64Array(2);

  for (let j = 0; j < size; j += 1) {
    const im = im0 - (j + 0.5) * step;
    for (let i = 0; i < size; i += 1) {
      fractal.kernel(re0 + (i + 0.5) * step, im, params, out);
      const index = j * size + i;
      values[index] = out[0] < 0 ? 0 : 1 + Math.round(Math.min(out[0] / scale, 1) * VALUE_MAX);
      classes[index] = out[1];
    }
  }

  return { width: size, height: size, values, classes };
}

/**
 * Recover a kernel value from its 16-bit encoding.
 * @param {number} encoded - Stored value
 * @param {number} scale - The fractal's value scale for these params
 * @returns {number} Value, or -1 for interior points
 */
export function decodeValue(encoded, scale) {
  return encoded === 0 ? -1 : ((encoded - 1) / VALUE_MAX) * scale;
}

/**
 * Serialise a rendered tile.
 * @param {Object} tile - { width, height, values, classes, renderMs, workerId }
 * @returns {Uint8Array} Encoded bytes
 */
export function encodeTile({ width, height, values, classes, renderMs = 0, workerId = "" }) {
  const n = width * height;
  const bytes = new Uint8Array(HEADER_BYTES + n * 3);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < 4; i += 1) bytes[i] = MAGIC.charCodeAt(i);
  view.setUint16(4, width, true);
  view.setUint16(6, height, true);
  view.setUint32(8, Math.min(Math.round(renderMs), 0xffffffff), true);

  const id = String(workerId).slice(0, WORKER_ID_BYTES);
  for (let i = 0; i < id.length; i += 1) bytes[12 + i] = id.charCodeAt(i) & 0x7f;

  for (let i = 0; i < n; i += 1) view.setUint16(HEADER_BYTES + i * 2, values[i], true);
  bytes.set(classes, HEADER_BYTES + n * 2);

  return bytes;
}

/**
 * Parse an encoded tile.
 * @param {ArrayBuffer|Uint8Array} input - Encoded bytes
 * @returns {{width: number, height: number, renderMs: number, workerId: string, values: Uint16Array, classes: Uint8Array}} Tile
 */
export function decodeTile(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== MAGIC) throw new Error(`Not a tile (magic ${JSON.stringify(magic)})`);

  const width = view.getUint16(4, true);
  const height = view.getUint16(6, true);
  const n = width * height;
  if (bytes.byteLength < HEADER_BYTES + n * 3) throw new Error("Tile truncated");

  let workerId = "";
  for (let i = 0; i < WORKER_ID_BYTES && bytes[12 + i] !== 0; i += 1) {
    workerId += String.fromCharCode(bytes[12 + i]);
  }

  // Read through DataView so decoding never depends on host endianness.
  const values = new Uint16Array(n);
  for (let i = 0; i < n; i += 1) values[i] = view.getUint16(HEADER_BYTES + i * 2, true);

  return {
    width,
    height,
    renderMs: view.getUint32(8, true),
    workerId,
    values,
    classes: bytes.slice(HEADER_BYTES + n * 2, HEADER_BYTES + n * 3),
  };
}

/**
 * Read only the header of an encoded tile — who rendered it, and how fast.
 * @param {Uint8Array} bytes - Encoded (uncompressed) tile, or at least its first 32 bytes
 * @returns {{width: number, height: number, renderMs: number, workerId: string}} Header
 */
export function readTileHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC) throw new Error("Not a tile");

  let workerId = "";
  for (let i = 0; i < WORKER_ID_BYTES && bytes[12 + i] !== 0; i += 1) {
    workerId += String.fromCharCode(bytes[12 + i]);
  }
  return {
    width: view.getUint16(4, true),
    height: view.getUint16(6, true),
    renderMs: view.getUint32(8, true),
    workerId,
  };
}

/**
 * Storage key for a tile: identical in memory, object store and logs.
 * @param {{fractal: string, paramKey: string, z: number, x: number, y: number}} spec - Tile identity
 * @returns {string} Key
 */
export function tileKey({ fractal, paramKey, z, x, y }) {
  return `${fractal}/${paramKey}/${z}/${x}/${y}`;
}

/**
 * Canonical public URL path for a tile. Immutable: the bytes behind a given
 * URL never change, so edge caches may hold it indefinitely.
 * @param {{fractal: string, query: string, z: number, x: number, y: number}} spec - Tile identity
 * @returns {string} URL path with query
 */
export function tileUrl({ fractal, query, z, x, y }) {
  return `/tiles/${fractal}/${z}/${x}/${y}?${query}`;
}

/**
 * A stable, vivid colour for a worker id, so every view of the system —
 * tile overlay, worker list, render feed — shows the same worker the same way.
 * @param {string} id - Worker id
 * @returns {string} CSS colour
 */
export function workerColour(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  }
  const hue = (hash >>> 0) % 360;
  return `hsl(${hue}, 95%, 62%)`;
}
