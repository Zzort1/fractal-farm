// Render every fractal's level-1 view through the real renderer and colouriser into one PNG — a headless visual check, and handy for report figures.
// Usage: node scripts/contact-sheet.js out.png
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { FRACTALS, canonicalParams, renderTile } from "@fractal-farm/core";
import { colouriseTile } from "../web/src/viewer/colourise.js";

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const palettes = {
  nebula: { stops: ["#0b0033","#3a0ca3","#7209b7","#f72585","#ff9e00","#fff3b0","#4cc9f0","#0b0033"], inside: "#05010f" },
  tropical: { stops: ["#03045e","#0077b6","#00f5d4","#9ef01a","#fee440","#f15bb5","#9b5de5","#03045e"], inside: "#010221" },
};
function lutOf(p) {
  const stops = p.stops.map(hex), seg = stops.length - 1, N = 1024, lut = new Uint8ClampedArray(N * 3);
  for (let i = 0; i < N; i++) { const pos = (i / N) * seg, s = Math.floor(pos), t = pos - s, e = t*t*(3-2*t), a = stops[s], b = stops[Math.min(s+1, seg)];
    for (let c = 0; c < 3; c++) lut[i*3+c] = a[c] + (b[c]-a[c]) * e; }
  return { lut, size: N, inside: hex(p.inside) };
}
const T = 256, ids = Object.keys(FRACTALS), cols = 4, rows = Math.ceil(ids.length / cols), cell = 2 * T;
const W = cols * cell, H = rows * cell, img = new Uint8Array(W * H * 4);
ids.forEach((id, n) => {
  const f = FRACTALS[id]; const { params } = canonicalParams(id, {});
  const lut = lutOf(n % 2 ? palettes.tropical : palettes.nebula);
  const ox = (n % cols) * cell, oy = Math.floor(n / cols) * cell;
  const t0 = performance.now();
  for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
    const tile = renderTile({ fractal: id, params, z: 1, x: tx, y: ty });
    const out = new Uint8ClampedArray(T * T * 4);
    colouriseTile(tile, { kind: f.kind, scale: f.valueScale(params), classCount: params.degree ?? 1, density: 0.35, offset: 0, lut }, out);
    for (let j = 0; j < T; j++) img.set(out.subarray(j*T*4, (j+1)*T*4), ((oy + ty*T + j) * W + ox + tx*T) * 4);
  }
  console.log(id.padEnd(13), (performance.now() - t0).toFixed(0) + "ms for 4 tiles");
});
// minimal PNG encoder
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (~c) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const raw = Buffer.alloc(H * (W * 4 + 1)); for (let y = 0; y < H; y++) { raw[y*(W*4+1)] = 0; Buffer.from(img.buffer, y*W*4, W*4).copy(raw, y*(W*4+1)+1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(process.argv[2], Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
