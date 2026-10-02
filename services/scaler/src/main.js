/**
 * The worker scaling controller: a control loop over the render fleet.
 *
 * Every tick it observes the queue (SQS) and the worker service (ECS),
 * decides a worker count with the target-tracking policy, and applies it with
 * ecs:UpdateService. ECS then does the rest — starting or stopping Fargate
 * tasks to match — exactly as it would for a managed scaling policy.
 *
 * Why a controller of our own: the CAB432 account does not grant Application
 * Auto Scaling, and denies EC2 Auto Scaling outright. The account does allow
 * ecs:UpdateService from the task role, so the managed service's job — read
 * a metric, compare to a target, adjust desired count — is done here in the
 * open, where each decision and its reason can be seen.
 *
 * Each tick also writes:
 *  - one Embedded Metric Format log line, which CloudWatch turns into metrics
 *    (Backlog, BacklogPerWorker, DesiredWorkers, RunningWorkers) with no
 *    extra API permission needed;
 *  - a small status object to S3, which the API reads to show the scaler's
 *    latest decision in the control room.
 */
import { DescribeServicesCommand, ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPlatform, loadConfig } from "@fractal-farm/platform";
import { decide } from "./policy.js";

const env = process.env;
const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== undefined && value !== "" ? Number(value) : fallback);

const CLUSTER = env.ECS_CLUSTER || "n5453313-a2-cluster";
const SERVICE = env.WORKER_SERVICE || "n5453313-fractal-worker";
const INTERVAL_MS = num(env.SCALER_INTERVAL_MS, 10_000);
const STATUS_KEY = "status/scaler.json";

const policy = {
  min: num(env.MIN_WORKERS, 0),
  max: num(env.MAX_WORKERS, 8),
  targetPerWorker: num(env.TARGET_BACKLOG_PER_WORKER, 4),
  scaleInCooldownMs: num(env.SCALE_IN_COOLDOWN_MS, 60_000),
};

const config = loadConfig();
const { queue } = createPlatform(config);
const ecs = new ECSClient({ region: config.region });
const s3 = new S3Client({ region: config.region });

let memory = { lowSince: null };
const history = [];

async function readService() {
  const result = await ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [SERVICE] }));
  const service = result.services?.[0];
  if (!service) throw new Error(`Service ${SERVICE} not found in ${CLUSTER}`);
  return {
    desired: service.desiredCount,
    running: service.runningCount,
    pending: service.pendingCount,
  };
}

/** One Embedded Metric Format record: a log line CloudWatch also reads as metrics. */
function emitMetrics(values) {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "n5453313/FractalFarm",
            Dimensions: [["Service"]],
            Metrics: [
              { Name: "Backlog", Unit: "Count" },
              { Name: "BacklogPerWorker", Unit: "Count" },
              { Name: "DesiredWorkers", Unit: "Count" },
              { Name: "RunningWorkers", Unit: "Count" },
            ],
          },
        ],
      },
      Service: SERVICE,
      ...values,
    }),
  );
}

async function tick() {
  const [depth, service] = await Promise.all([queue.depth(), readService()]);
  const backlog = depth.visible + depth.inflight;
  const now = Date.now();

  const decision = decide({ now, visible: depth.visible, inflight: depth.inflight, desired: service.desired }, policy, memory);
  memory = decision.memory;

  if (decision.desired !== service.desired) {
    await ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: SERVICE, desiredCount: decision.desired }));
    history.unshift({ at: new Date(now).toISOString(), from: service.desired, to: decision.desired, reason: decision.reason });
    history.length = Math.min(history.length, 20);
    console.log(JSON.stringify({ message: "Scaled", from: service.desired, to: decision.desired, reason: decision.reason }));
  }

  emitMetrics({
    Backlog: backlog,
    BacklogPerWorker: service.running ? backlog / service.running : backlog,
    DesiredWorkers: decision.desired,
    RunningWorkers: service.running,
    Reason: decision.reason,
  });

  const status = {
    at: new Date(now).toISOString(),
    policy,
    queue: depth,
    service: { ...service, desired: decision.desired },
    wanted: decision.wanted,
    reason: decision.reason,
    history,
  };
  await s3
    .send(
      new PutObjectCommand({
        Bucket: config.tileBucket,
        Key: STATUS_KEY,
        Body: JSON.stringify(status),
        ContentType: "application/json",
        CacheControl: "no-store",
      }),
    )
    .catch((error) => console.error("Status write failed:", error.message));
}

console.log(JSON.stringify({ message: "Scaler started", cluster: CLUSTER, service: SERVICE, intervalMs: INTERVAL_MS, policy }));

let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));

while (!stopping) {
  const started = Date.now();
  try {
    await tick();
  } catch (error) {
    // A failed observation skips one decision; it never guesses.
    console.error(JSON.stringify({ message: "Tick failed", error: error.message }));
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, INTERVAL_MS - (Date.now() - started))));
}
console.log(JSON.stringify({ message: "Scaler stopped" }));
