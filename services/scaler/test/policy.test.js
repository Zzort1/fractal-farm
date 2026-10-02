import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/policy.js";

const policy = { min: 0, max: 10, targetPerWorker: 4, scaleInCooldownMs: 60_000 };

test("scales out immediately to meet the backlog target", () => {
  const d = decide({ now: 0, visible: 17, inflight: 3, desired: 1 }, policy);
  assert.equal(d.desired, 5); // 20 / 4
});

test("any backlog wakes at least one worker from zero", () => {
  const d = decide({ now: 0, visible: 1, inflight: 0, desired: 0 }, policy);
  assert.equal(d.desired, 1);
});

test("never exceeds max", () => {
  const d = decide({ now: 0, visible: 500, inflight: 0, desired: 2 }, policy);
  assert.equal(d.desired, 10);
});

test("holds during cool-down, then scales in", () => {
  let memory;
  let d = decide({ now: 0, visible: 0, inflight: 2, desired: 5 }, policy);
  assert.equal(d.desired, 5, "first low reading only starts the clock");
  memory = d.memory;

  d = decide({ now: 30_000, visible: 0, inflight: 2, desired: 5 }, policy, memory);
  assert.equal(d.desired, 5, "still cooling down");
  memory = d.memory;

  d = decide({ now: 61_000, visible: 0, inflight: 2, desired: 5 }, policy, memory);
  assert.equal(d.desired, 1, "scales in after the cool-down");
});

test("a burst during cool-down resets the clock", () => {
  let d = decide({ now: 0, visible: 0, inflight: 0, desired: 3 }, policy);
  d = decide({ now: 40_000, visible: 12, inflight: 0, desired: 3 }, policy, d.memory);
  assert.equal(d.memory.lowSince, null);
  d = decide({ now: 50_000, visible: 0, inflight: 0, desired: 3 }, policy, d.memory);
  assert.equal(d.desired, 3, "cool-down restarted at 50 s");
});

test("scales to zero when idle and min allows it", () => {
  let d = decide({ now: 0, visible: 0, inflight: 0, desired: 2 }, policy);
  d = decide({ now: 60_000, visible: 0, inflight: 0, desired: 2 }, policy, d.memory);
  assert.equal(d.desired, 0);
});

test("respects a non-zero minimum", () => {
  let d = decide({ now: 0, visible: 0, inflight: 0, desired: 3 }, { ...policy, min: 1 });
  d = decide({ now: 60_000, visible: 0, inflight: 0, desired: 3 }, { ...policy, min: 1 }, d.memory);
  assert.equal(d.desired, 1);
});
