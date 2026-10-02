/**
 * Turn a decoded tile's numbers into pixels.
 *
 * Three colouring schemes, one per kind of fractal:
 *
 *   escape    position along the palette = √(smooth iterations) × density + offset.
 *             The square root keeps bands visible both near the set (huge
 *             counts) and far from it (tiny counts).
 *   basin     palette slice picked by which root a Newton pixel converged to,
 *             swept along by how long it took, and gently darkened.
 *   lyapunov  ordered regions coloured by how stable they are; chaotic
 *             regions fall back to a dim tint of the interior colour.
 */

const VALUE_MAX = 65534;

/**
 * Colourise one tile into an RGBA buffer.
 *
 * @param {Object} tile - Decoded tile { values, classes }
 * @param {Object} options - { kind, scale, classCount, density, offset, lut }
 * @param {Uint8ClampedArray} out - RGBA output, width × height × 4
 * @returns {void}
 */
export function colouriseTile(tile, { kind, scale, classCount, density, offset, lut }, out) {
  const { values, classes } = tile;
  const table = lut.lut;
  const size = lut.size;
  const [ir, ig, ib] = lut.inside;
  const k = scale / VALUE_MAX;
  const n = values.length;

  for (let i = 0; i < n; i += 1) {
    const encoded = values[i];
    const o = i * 4;
    out[o + 3] = 255;

    if (encoded === 0) {
      out[o] = ir;
      out[o + 1] = ig;
      out[o + 2] = ib;
      continue;
    }

    const value = (encoded - 1) * k;
    let position;
    let shade = 1;

    if (kind === "escape") {
      position = Math.sqrt(value) * density + offset;
    } else if (kind === "basin") {
      // Each root owns a slice of the palette; convergence time sweeps
      // through it, so basins glow with gradients instead of flat fills.
      position = (classes[i] - 1) / classCount + Math.sqrt(value) * density * 0.6 + offset;
      shade = Math.max(0.35, 1 / (1 + value * 0.04));
    } else if (classes[i] === 1) {
      position = Math.sqrt(value / scale) * density * 3 + offset;
    } else {
      // Chaotic Lyapunov region: a dim wash, brighter where more chaotic.
      const glow = Math.min(value, 1) * 0.35;
      const c = ((Math.floor(offset * size) % size) + size) % size;
      out[o] = ir + (table[c * 3] - ir) * glow;
      out[o + 1] = ig + (table[c * 3 + 1] - ig) * glow;
      out[o + 2] = ib + (table[c * 3 + 2] - ib) * glow;
      continue;
    }

    const index = ((Math.floor((position - Math.floor(position)) * size) % size) + size) % size;
    out[o] = table[index * 3] * shade;
    out[o + 1] = table[index * 3 + 1] * shade;
    out[o + 2] = table[index * 3 + 2] * shade;
  }
}
