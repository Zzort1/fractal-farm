/**
 * The fractal catalogue.
 *
 * Every fractal here is **per-pixel independent**: a pixel's value depends only
 * on its own coordinate and the parameters. That property is what lets the
 * plane be cut into tiles and rendered by any worker in any order. Fractals
 * that accumulate random samples over the whole image (Buddhabrot, flame
 * fractals, chaos-game IFS) are deliberately absent — one tile cannot be
 * rendered without rendering all of them.
 *
 * A kernel writes two numbers into `out` rather than returning an object,
 * because it runs 65,536 times per tile and allocation would dominate:
 *
 *   out[0]  value — smooth iteration count, or Lyapunov magnitude; -1 = interior
 *   out[1]  class — 0 for plain escape-time; root index for Newton; stability for Lyapunov
 *
 * The browser colours these numbers. Workers never choose colours, so palette
 * changes cost nothing in the cloud and never fragment the tile cache.
 */

/** Escape radius squared. Large, so the smoothing formula is accurate. */
const BAILOUT_SQ = 256 * 256;
const LOG2 = Math.log(2);

/** Iteration budgets offered. Discrete on purpose — see params.js. */
export const ITERATION_STEPS = [64, 128, 256, 512, 1024, 2048, 4096];

/**
 * Smooth (continuous) iteration count, which removes visible colour banding.
 * @param {number} n - Iterations completed
 * @param {number} magSq - |z|^2 at escape
 * @param {number} logPower - ln(power of z)
 * @returns {number} Fractional iteration count
 */
function smooth(n, magSq, logPower) {
  return n + 1 - Math.log(Math.log(magSq) / 2 / LOG2) / logPower;
}

/**
 * Classic Mandelbrot z → z² + c, with the main cardioid and period-2 bulb
 * rejected analytically. Those two regions are interior points that would
 * otherwise run every iteration, and they cover much of the home view.
 */
function mandelbrot(re, im, p, out) {
  const xq = re - 0.25;
  const q = xq * xq + im * im;
  if (q * (q + xq) <= 0.25 * im * im || (re + 1) * (re + 1) + im * im <= 0.0625) {
    out[0] = -1;
    out[1] = 0;
    return;
  }

  let zr = 0;
  let zi = 0;
  let x2 = 0;
  let y2 = 0;
  let n = 0;
  const max = p.iter;

  while (n < max && x2 + y2 <= BAILOUT_SQ) {
    zi = 2 * zr * zi + im;
    zr = x2 - y2 + re;
    x2 = zr * zr;
    y2 = zi * zi;
    n += 1;
  }

  out[0] = n >= max ? -1 : smooth(n, x2 + y2, LOG2);
  out[1] = 0;
}

/** Julia set for a fixed c: same recurrence, but z starts at the pixel. */
function julia(re, im, p, out) {
  let zr = re;
  let zi = im;
  let x2 = zr * zr;
  let y2 = zi * zi;
  let n = 0;
  const max = p.iter;

  while (n < max && x2 + y2 <= BAILOUT_SQ) {
    zi = 2 * zr * zi + p.cim;
    zr = x2 - y2 + p.cre;
    x2 = zr * zr;
    y2 = zi * zi;
    n += 1;
  }

  out[0] = n >= max ? -1 : smooth(n, x2 + y2, LOG2);
  out[1] = 0;
}

/** Multibrot z → z^d + c, giving (d-1)-fold symmetry. */
function multibrot(re, im, p, out) {
  let zr = 0;
  let zi = 0;
  let n = 0;
  let magSq = 0;
  const max = p.iter;
  const d = p.power;

  while (n < max && magSq <= BAILOUT_SQ) {
    // z^d by repeated multiplication: exact, and faster than polar form for small d.
    let pr = zr;
    let pi = zi;
    for (let k = 1; k < d; k += 1) {
      const t = pr * zr - pi * zi;
      pi = pr * zi + pi * zr;
      pr = t;
    }
    zr = pr + re;
    zi = pi + im;
    magSq = zr * zr + zi * zi;
    n += 1;
  }

  out[0] = n >= max ? -1 : smooth(n, magSq, Math.log(d));
  out[1] = 0;
}

/**
 * Burning Ship: absolute values before squaring. The imaginary axis is
 * negated so the ship sits upright with screen-up as +im.
 */
function burningShip(re, im, p, out) {
  let zr = 0;
  let zi = 0;
  let x2 = 0;
  let y2 = 0;
  let n = 0;
  const max = p.iter;
  const ci = -im;

  while (n < max && x2 + y2 <= BAILOUT_SQ) {
    zi = Math.abs(2 * zr * zi) + ci;
    zr = x2 - y2 + re;
    x2 = zr * zr;
    y2 = zi * zi;
    n += 1;
  }

  out[0] = n >= max ? -1 : smooth(n, x2 + y2, LOG2);
  out[1] = 0;
}

/** Tricorn (Mandelbar): z → conj(z)² + c. */
function tricorn(re, im, p, out) {
  let zr = 0;
  let zi = 0;
  let x2 = 0;
  let y2 = 0;
  let n = 0;
  const max = p.iter;

  while (n < max && x2 + y2 <= BAILOUT_SQ) {
    zi = -2 * zr * zi + im;
    zr = x2 - y2 + re;
    x2 = zr * zr;
    y2 = zi * zi;
    n += 1;
  }

  out[0] = n >= max ? -1 : smooth(n, x2 + y2, LOG2);
  out[1] = 0;
}

const NEWTON_EPS = 1e-6;
const LOG_NEWTON_EPS = Math.log(NEWTON_EPS);

/**
 * Newton's method on z^d − 1. Each pixel converges to one of d roots of
 * unity; the class records which, and the value how quickly.
 */
function newton(re, im, p, out) {
  const d = p.degree;
  let zr = re;
  let zi = im;
  const max = p.iter;

  for (let n = 0; n < max; n += 1) {
    // a = z^(d-1)
    let ar = 1;
    let ai = 0;
    for (let k = 1; k < d; k += 1) {
      const t = ar * zr - ai * zi;
      ai = ar * zi + ai * zr;
      ar = t;
    }
    // f = z^d − 1,  f' = d·z^(d-1)
    const fr = ar * zr - ai * zi - 1;
    const fi = ar * zi + ai * zr;
    const dr = d * ar;
    const di = d * ai;
    const den = dr * dr + di * di;

    if (den < 1e-30) break; // derivative vanished: no root is reachable

    zr -= (fr * dr + fi * di) / den;
    zi -= (fi * dr - fr * di) / den;

    for (let k = 0; k < d; k += 1) {
      const angle = (2 * Math.PI * k) / d;
      const er = zr - Math.cos(angle);
      const ei = zi - Math.sin(angle);
      const distSq = er * er + ei * ei;

      if (distSq < NEWTON_EPS * NEWTON_EPS) {
        // Convergence is quadratic, so log(dist) roughly doubles per step;
        // this fraction smooths the step boundaries away.
        const ratio = Math.log(distSq) / 2 / LOG_NEWTON_EPS;
        const frac = Math.log(Math.max(ratio, 1)) / LOG2;
        out[0] = Math.max(0, n + 1 - Math.min(frac, 1));
        out[1] = k + 1;
        return;
      }
    }
  }

  out[0] = -1;
  out[1] = 0;
}

/** Lyapunov sequences offered. Each gives a distinct landscape. */
export const LYAPUNOV_SEQUENCES = ["AB", "AABAB", "ABBAB", "BBBBBBAAAAAA"];
const LYAPUNOV_WARMUP = 64;

/**
 * Lyapunov exponent of the logistic map with r alternating between a (re)
 * and b (im) according to the sequence. Every pixel runs the full budget —
 * there is no early escape — which makes this the heaviest fractal per tile,
 * and the natural choice for a load test.
 */
function lyapunov(re, im, p, out) {
  const seq = p.seq;
  const len = seq.length;
  let x = 0.5;
  let sum = 0;
  const total = LYAPUNOV_WARMUP + p.iter;

  for (let n = 0; n < total; n += 1) {
    const r = seq.charCodeAt(n % len) === 65 ? re : im; // 65 = "A"
    x = r * x * (1 - x);
    if (n >= LYAPUNOV_WARMUP) {
      sum += Math.log(Math.abs(r * (1 - 2 * x)) + 1e-12);
    }
  }

  const lambda = sum / p.iter;

  if (!Number.isFinite(lambda)) {
    out[0] = -1;
    out[1] = 0;
  } else if (lambda < 0) {
    out[0] = -lambda; // stable: deeper negative = more ordered
    out[1] = 1;
  } else {
    out[0] = lambda; // chaotic
    out[1] = 2;
  }
}

const iterParam = (fallback) => ({
  key: "iter",
  label: "Max iterations",
  type: "select",
  options: ITERATION_STEPS,
  default: fallback,
});

/**
 * The catalogue. `home` is the square of the complex plane that tile 0/0/0
 * covers — every deeper tile subdivides it. `valueScale` is the largest value
 * the tile encoding must represent, given the parameters.
 */
export const FRACTALS = {
  mandelbrot: {
    id: "mandelbrot",
    name: "Mandelbrot",
    kind: "escape",
    blurb: "z → z² + c. The original, with infinite seahorses.",
    home: { re: -0.6, im: 0, span: 3.2 },
    maxZoom: 40,
    params: [iterParam(512)],
    valueScale: (p) => p.iter,
    kernel: mandelbrot,
  },
  julia: {
    id: "julia",
    name: "Julia",
    kind: "escape",
    blurb: "One shape for every c. Shift-click the Mandelbrot to pick one.",
    home: { re: 0, im: 0, span: 3.4 },
    maxZoom: 40,
    params: [
      iterParam(512),
      { key: "cre", label: "c (real)", type: "number", min: -2, max: 2, step: 0.0001, default: -0.8 },
      { key: "cim", label: "c (imag)", type: "number", min: -2, max: 2, step: 0.0001, default: 0.156 },
    ],
    presets: [
      { name: "Dragon", cre: -0.8, cim: 0.156 },
      { name: "Douady rabbit", cre: -0.123, cim: 0.745 },
      { name: "Dendrite", cre: 0, cim: 1 },
      { name: "San Marco", cre: -0.75, cim: 0 },
      { name: "Siegel disk", cre: -0.391, cim: -0.587 },
      { name: "Spiral galaxy", cre: 0.285, cim: 0.01 },
    ],
    valueScale: (p) => p.iter,
    kernel: julia,
  },
  multibrot: {
    id: "multibrot",
    name: "Multibrot",
    kind: "escape",
    blurb: "z → zᵈ + c. Higher powers, more symmetry.",
    home: { re: 0, im: 0, span: 3.2 },
    maxZoom: 36,
    params: [
      iterParam(512),
      { key: "power", label: "Power d", type: "select", options: [3, 4, 5, 6], default: 3 },
    ],
    valueScale: (p) => p.iter,
    kernel: multibrot,
  },
  "burning-ship": {
    id: "burning-ship",
    name: "Burning Ship",
    kind: "escape",
    blurb: "Absolute values before squaring. Look for the rigging.",
    home: { re: -0.45, im: 0.5, span: 3.6 },
    maxZoom: 40,
    params: [iterParam(512)],
    valueScale: (p) => p.iter,
    kernel: burningShip,
  },
  tricorn: {
    id: "tricorn",
    name: "Tricorn",
    kind: "escape",
    blurb: "The Mandelbrot's mirror-image cousin.",
    home: { re: -0.3, im: 0, span: 4 },
    maxZoom: 40,
    params: [iterParam(512)],
    valueScale: (p) => p.iter,
    kernel: tricorn,
  },
  newton: {
    id: "newton",
    name: "Newton",
    kind: "basin",
    blurb: "Newton's method on zᵈ − 1. Colour = which root wins.",
    home: { re: 0, im: 0, span: 4 },
    maxZoom: 40,
    params: [
      iterParam(64),
      { key: "degree", label: "Degree d", type: "select", options: [3, 4, 5, 6], default: 3 },
    ],
    valueScale: (p) => p.iter,
    kernel: newton,
  },
  lyapunov: {
    id: "lyapunov",
    name: "Lyapunov",
    kind: "lyapunov",
    blurb: "Order vs chaos in the logistic map. The heavyweight.",
    home: { re: 3, im: 3, span: 2 },
    maxZoom: 24,
    params: [
      iterParam(256),
      { key: "seq", label: "Sequence", type: "select", options: LYAPUNOV_SEQUENCES, default: "AB" },
    ],
    // Exponents beyond ±4 are visually indistinguishable; clamp there.
    valueScale: () => 4,
    kernel: lyapunov,
  },
};

/**
 * @param {string} id - Fractal id
 * @returns {Object|undefined} Fractal definition
 */
export function getFractal(id) {
  return Object.hasOwn(FRACTALS, id) ? FRACTALS[id] : undefined;
}

/**
 * Metadata safe to send over the wire or render in UI (no kernels).
 * @returns {Array<Object>} Fractal descriptions
 */
export function listFractals() {
  return Object.values(FRACTALS).map(({ kernel, valueScale, ...rest }) => rest);
}
