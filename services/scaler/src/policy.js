/**
 * Target tracking on queue backlog per worker — the scaling decision, as a
 * pure function so it can be tested and reasoned about apart from AWS.
 *
 * The tracked metric is  backlog / workers,  where backlog counts jobs waiting
 * *and* jobs being rendered. Holding it near a target keeps the expected wait
 * for a new tile roughly constant (target × time per tile) however busy the
 * site gets — which is the property users actually feel.
 *
 * Scaling is deliberately asymmetric:
 *
 *  - **Out fast.** The moment the backlog needs more workers, ask for them:
 *    a Fargate task takes tens of seconds to start, so hesitating only adds
 *    to the delay users already face.
 *  - **In slowly.** Only after the lower count has been sufficient for a
 *    whole cool-down period, so a pause between bursts does not discard
 *    workers that are about to be needed again (flapping).
 *
 * With `min = 0` the fleet scales to zero when idle: no cost when nobody is
 * exploring, at the price of one cold start for the first visitor after.
 */

/**
 * @typedef {Object} Policy
 * @property {number} min - Fewest workers (0 allows scale-to-zero)
 * @property {number} max - Most workers (cost and account ceiling)
 * @property {number} targetPerWorker - Backlog each worker should carry
 * @property {number} scaleInCooldownMs - How long a lower count must suffice before scaling in
 */

/**
 * @typedef {Object} Observation
 * @property {number} now - Clock, ms
 * @property {number} visible - Jobs waiting in the queue
 * @property {number} inflight - Jobs being rendered
 * @property {number} desired - Worker count currently requested
 */

/**
 * Decide the worker count.
 *
 * @param {Observation} observation - What the system looks like now
 * @param {Policy} policy - Scaling policy
 * @param {{lowSince: number|null}} memory - Carried between calls
 * @returns {{desired: number, reason: string, wanted: number, memory: {lowSince: number|null}}} Decision
 */
export function decide({ now, visible, inflight, desired }, policy, memory = { lowSince: null }) {
  const backlog = visible + inflight;
  const clamp = (n) => Math.min(policy.max, Math.max(policy.min, n));

  // Workers needed to bring backlog-per-worker down to the target. Any
  // backlog at all needs at least one worker, even below the target.
  const wanted = clamp(backlog === 0 ? 0 : Math.max(1, Math.ceil(backlog / policy.targetPerWorker)));

  if (wanted > desired) {
    return {
      desired: wanted,
      wanted,
      reason: `scale out: backlog ${backlog} needs ${wanted} at ${policy.targetPerWorker}/worker`,
      memory: { lowSince: null },
    };
  }

  if (wanted === desired) {
    return { desired, wanted, reason: "steady", memory: { lowSince: null } };
  }

  // wanted < desired: start (or continue) the cool-down clock.
  const lowSince = memory.lowSince ?? now;
  const waited = now - lowSince;

  if (waited < policy.scaleInCooldownMs) {
    return {
      desired,
      wanted,
      reason: `holding: ${wanted} would do, cooling down ${Math.round(waited / 1000)}/${Math.round(policy.scaleInCooldownMs / 1000)}s`,
      memory: { lowSince },
    };
  }

  return {
    desired: wanted,
    wanted,
    reason: wanted === 0 ? "scale to zero: idle for the whole cool-down" : `scale in: ${wanted} sufficed for the whole cool-down`,
    memory: { lowSince: null },
  };
}
