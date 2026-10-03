/**
 * Live cost meter: a running estimate of what the system costs per hour,
 * from the tasks actually running and the request rates actually observed.
 *
 * Prices are approximate on-demand list prices for ap-southeast-2 (Sydney)
 * and exclude free tiers; they are for showing how cost moves with scaling,
 * not for billing. Check them against the AWS Pricing Calculator.
 */
export const PRICES = {
  region: "ap-southeast-2",
  fargateVcpuHour: 0.04856,
  fargateGbHour: 0.00532,
  albHour: 0.0252,
  albLcuHour: 0.008,
  s3GetPer1k: 0.00044,
  s3PutPer1k: 0.0055,
  sqsPerMillion: 0.4,
};

/**
 * Fargate bills from image pull to stop, so pending tasks count too.
 * @param {Array} tasks - Fleet tasks
 * @returns {{perHour: number, vcpu: number, gb: number, billed: number}} Compute cost
 */
export function computeHourly(tasks = []) {
  const billed = tasks.filter((t) => ["PENDING", "ACTIVATING", "RUNNING", "DEACTIVATING", "STOPPING"].includes(t.lastStatus));
  const vcpu = billed.reduce((n, t) => n + (t.cpu || 0) / 1024, 0);
  const gb = billed.reduce((n, t) => n + (t.memory || 0) / 1024, 0);
  return {
    perHour: vcpu * PRICES.fargateVcpuHour + gb * PRICES.fargateGbHour,
    vcpu,
    gb,
    billed: billed.length,
  };
}

/**
 * Request-driven cost at the observed rates, extrapolated to an hour.
 * @param {Object} m - Rates from the trace bus
 * @returns {number} USD per hour
 */
export function requestsHourly(m) {
  const perHour = (perS) => perS * 3600;
  return (
    (perHour(m.s3GetPerS + m.s3HeadPerS) / 1000) * PRICES.s3GetPer1k +
    (perHour(m.s3PutPerS) / 1000) * PRICES.s3PutPer1k +
    // Each job costs a send, a receive and a delete; depth reads are one call each.
    (perHour(m.sqsSendPerS * 3 + m.sqsAttrPerS) / 1e6) * PRICES.sqsPerMillion
  );
}

/** @returns {number} Fixed hourly cost of the load balancer (one LCU assumed) */
export function fixedHourly() {
  return PRICES.albHour + PRICES.albLcuHour;
}

export const money = (usd) => (usd >= 1 ? `$${usd.toFixed(2)}` : usd >= 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(4)}`);
