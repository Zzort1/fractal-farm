import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRACTALS,
  ParamError,
  canonicalParams,
  decodeTile,
  decodeValue,
  encodeTile,
  isValidTile,
  renderTile,
} from "../src/index.js";

test("canonical params sort keys and fill defaults", () => {
  const { query, key, params } = canonicalParams("julia", { cim: "0.15600001", iter: "1024" });
  assert.equal(params.cre, -0.8);
  assert.equal(query, "cim=0.156&cre=-0.8&iter=1024");
  assert.equal(key, "cim=0.156,cre=-0.8,iter=1024");
});

test("near-identical inputs collapse to one cache key", () => {
  const a = canonicalParams("julia", { cre: "-0.80001", cim: "0.156" });
  const b = canonicalParams("julia", { cre: "-0.8", cim: "0.15600" });
  assert.equal(a.key, b.key);
});

test("unknown keys and off-list iterations are rejected", () => {
  assert.throws(() => canonicalParams("mandelbrot", { bust: "1" }), ParamError);
  assert.throws(() => canonicalParams("mandelbrot", { iter: "999" }), ParamError);
  assert.throws(() => canonicalParams("nope", {}), ParamError);
});

test("tile range is enforced", () => {
  const m = FRACTALS.mandelbrot;
  assert.ok(isValidTile(m, 0, 0, 0));
  assert.ok(!isValidTile(m, 1, 2, 0));
  assert.ok(!isValidTile(m, m.maxZoom + 1, 0, 0));
});

test("encode/decode round-trips, header included", () => {
  const { params } = canonicalParams("mandelbrot", {});
  const tile = renderTile({ fractal: "mandelbrot", params, z: 0, x: 0, y: 0, size: 32 });
  const bytes = encodeTile({ ...tile, renderMs: 42, workerId: "worker-7" });
  const back = decodeTile(bytes.buffer);

  assert.equal(back.width, 32);
  assert.equal(back.renderMs, 42);
  assert.equal(back.workerId, "worker-7");
  assert.deepEqual(back.values, tile.values);
  assert.deepEqual(back.classes, tile.classes);
});

test("the home Mandelbrot tile has both interior and escaping pixels", () => {
  const { params } = canonicalParams("mandelbrot", {});
  const { values } = renderTile({ fractal: "mandelbrot", params, z: 0, x: 0, y: 0, size: 64 });
  assert.ok(values.some((v) => v === 0), "expected interior points");
  assert.ok(values.some((v) => v > 0), "expected escaping points");
});

test("every fractal renders a non-uniform home tile", () => {
  for (const id of Object.keys(FRACTALS)) {
    const { params } = canonicalParams(id, {});
    const { values, classes } = renderTile({ fractal: id, params, z: 0, x: 0, y: 0, size: 32 });
    const distinct = new Set(Array.from(values, (v, i) => `${v}:${classes[i]}`));
    assert.ok(distinct.size > 4, `${id} produced a near-uniform tile`);
  }
});

test("Newton classes name roots 1..d", () => {
  const { params } = canonicalParams("newton", { degree: "4" });
  const { classes } = renderTile({ fractal: "newton", params, z: 0, x: 0, y: 0, size: 32 });
  const seen = new Set(classes);
  for (let k = 1; k <= 4; k += 1) assert.ok(seen.has(k), `root ${k} missing`);
});

test("decodeValue inverts the encoding", () => {
  assert.equal(decodeValue(0, 512), -1);
  assert.ok(Math.abs(decodeValue(65535, 512) - 512) < 1e-9);
});
