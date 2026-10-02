/**
 * Parameter canonicalisation: the cache-key discipline.
 *
 * Every parameter that changes pixels is part of a tile's identity, so every
 * variation a client can express is another copy of the tile in every cache
 * layer. Two rules keep that bounded:
 *
 *  1. **Snap** — iterations come from a fixed list and numbers are rounded to
 *     a fixed precision, so near-identical requests share one cached tile.
 *  2. **One spelling** — parameters are emitted in sorted order with no
 *     defaults omitted, so "the same tile" is always the same string. The API
 *     redirects any other spelling to the canonical one.
 *
 * Together these are also a defence: an attacker cannot bust the cache (and
 * force unbounded rendering) by appending junk or jittering decimals.
 */
import { getFractal } from "./fractals.js";

/** Decimal places kept for free numeric parameters. */
const NUMBER_PRECISION = 4;

export class ParamError extends Error {
  constructor(message) {
    super(message);
    this.name = "ParamError";
  }
}

/**
 * Format a number with no trailing zeros and no "-0".
 * @param {number} value - Number to format
 * @returns {string} Stable textual form
 */
function formatNumber(value) {
  const fixed = Number(value.toFixed(NUMBER_PRECISION));
  return String(Object.is(fixed, -0) ? 0 : fixed);
}

/**
 * Validate and snap one parameter against its definition.
 * @param {Object} def - Parameter definition
 * @param {string|number|undefined} raw - Supplied value
 * @returns {string|number} Canonical value
 */
function canonicalValue(def, raw) {
  if (raw === undefined || raw === null || raw === "") return def.default;

  if (def.type === "select") {
    const match = def.options.find((option) => String(option) === String(raw));
    if (match === undefined) {
      throw new ParamError(`${def.key} must be one of ${def.options.join(", ")}`);
    }
    return match;
  }

  const number = Number(raw);
  if (!Number.isFinite(number) || number < def.min || number > def.max) {
    throw new ParamError(`${def.key} must be a number from ${def.min} to ${def.max}`);
  }
  return Number(formatNumber(number));
}

/**
 * Turn arbitrary input into the canonical parameter set for a fractal.
 *
 * Unknown keys are rejected rather than ignored: ignoring them would let
 * `?x=1`, `?x=2`, ... each create a distinct CDN cache entry for one tile.
 *
 * @param {string} fractalId - Fractal id
 * @param {Object|URLSearchParams} input - Raw parameters
 * @returns {{params: Object, query: string, key: string}} Canonical parameters, URL query and storage key segment
 */
export function canonicalParams(fractalId, input = {}) {
  const fractal = getFractal(fractalId);
  if (!fractal) throw new ParamError(`Unknown fractal: ${fractalId}`);

  const raw = input instanceof URLSearchParams ? Object.fromEntries(input) : { ...input };
  const known = new Set(fractal.params.map((def) => def.key));

  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new ParamError(`Unknown parameter: ${key}`);
  }

  const params = {};
  for (const def of fractal.params) {
    params[def.key] = canonicalValue(def, raw[def.key]);
  }

  const pairs = Object.keys(params)
    .sort()
    .map((key) => [key, typeof params[key] === "number" ? formatNumber(params[key]) : String(params[key])]);

  return {
    params,
    query: pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"),
    // Path-safe on S3 and on Windows filesystems alike.
    key: pairs.map(([k, v]) => `${k}=${v}`).join(","),
  };
}

/**
 * Default parameters for a fractal.
 * @param {string} fractalId - Fractal id
 * @returns {Object} Default parameter values
 */
export function defaultParams(fractalId) {
  return canonicalParams(fractalId, {}).params;
}
