/**
 * Colour palettes, as gradient stops expanded into lookup tables.
 *
 * Colouring happens only in the browser. Workers send numbers (smooth
 * iteration counts), so switching palette, stretching bands or cycling colours
 * is instant, costs the cloud nothing, and never fragments the tile cache.
 */

const LUT_SIZE = 1024;

/** Twelve evenly spaced hues, for the rainbow palette. */
const rainbowStops = Array.from({ length: 13 }, (_, i) => `hsl(${(i * 30) % 360}, 100%, 55%)`);

export const PALETTES = [
  {
    id: "nebula",
    name: "Neon Nebula",
    stops: ["#0b0033", "#3a0ca3", "#7209b7", "#f72585", "#ff9e00", "#fff3b0", "#4cc9f0", "#0b0033"],
    inside: "#05010f",
  },
  {
    id: "tropical",
    name: "Tropical",
    stops: ["#03045e", "#0077b6", "#00f5d4", "#9ef01a", "#fee440", "#f15bb5", "#9b5de5", "#03045e"],
    inside: "#010221",
  },
  {
    id: "solar",
    name: "Solar Flare",
    stops: ["#120000", "#7a0000", "#ff3c00", "#ffb000", "#fff6c2", "#ff6a00", "#3d0000", "#120000"],
    inside: "#000000",
  },
  {
    id: "aurora",
    name: "Aurora",
    stops: ["#020024", "#00ff87", "#60efff", "#0061ff", "#ff00e5", "#020024"],
    inside: "#01000f",
  },
  {
    id: "candy",
    name: "Candy",
    stops: ["#ff99c8", "#fcf6bd", "#d0f4de", "#a9def9", "#e4c1f9", "#ff5d8f", "#ff99c8"],
    inside: "#2b193d",
  },
  {
    id: "inferno",
    name: "Inferno",
    stops: ["#000004", "#420a68", "#932667", "#dd513a", "#fca50a", "#fcffa4", "#000004"],
    inside: "#000000",
  },
  {
    id: "ocean",
    name: "Deep Ocean",
    stops: ["#001219", "#005f73", "#0a9396", "#94d2bd", "#e9d8a6", "#ee9b00", "#ca6702", "#001219"],
    inside: "#000a0e",
  },
  {
    id: "rainbow",
    name: "Rainbow",
    stops: rainbowStops,
    inside: "#000000",
  },
];

/**
 * Parse any CSS colour into RGB using a 1×1 canvas — the browser already
 * knows every colour syntax, so there is no parser to maintain.
 */
const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
probe.canvas.width = 1;
probe.canvas.height = 1;

/**
 * @param {string} colour - Any CSS colour
 * @returns {[number, number, number]} RGB
 */
export function toRgb(colour) {
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = colour;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

const lutCache = new Map();

/**
 * Expand a palette's stops into a cyclic RGB lookup table.
 * @param {Object} palette - Palette definition
 * @returns {{lut: Uint8ClampedArray, size: number, inside: number[]}} Lookup table
 */
export function paletteLut(palette) {
  const cached = lutCache.get(palette.id);
  if (cached) return cached;

  const stops = palette.stops.map(toRgb);
  const segments = stops.length - 1;
  const lut = new Uint8ClampedArray(LUT_SIZE * 3);

  for (let i = 0; i < LUT_SIZE; i += 1) {
    const position = (i / LUT_SIZE) * segments;
    const s = Math.floor(position);
    const t = position - s;
    // Smoothstep easing gives softer transitions than straight lines.
    const e = t * t * (3 - 2 * t);
    const a = stops[s];
    const b = stops[Math.min(s + 1, segments)];
    lut[i * 3] = a[0] + (b[0] - a[0]) * e;
    lut[i * 3 + 1] = a[1] + (b[1] - a[1]) * e;
    lut[i * 3 + 2] = a[2] + (b[2] - a[2]) * e;
  }

  const result = { lut, size: LUT_SIZE, inside: toRgb(palette.inside) };
  lutCache.set(palette.id, result);
  return result;
}

/**
 * @param {string} id - Palette id
 * @returns {Object} Palette (first one if unknown)
 */
export function getPalette(id) {
  return PALETTES.find((palette) => palette.id === id) ?? PALETTES[0];
}

/**
 * CSS gradient for a palette swatch.
 * @param {Object} palette - Palette definition
 * @returns {string} linear-gradient()
 */
export function paletteCss(palette) {
  return `linear-gradient(90deg, ${palette.stops.join(", ")})`;
}
