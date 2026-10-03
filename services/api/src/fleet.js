/**
 * Cloud mode: what the container fleet looks like right now, task by task.
 *
 * Every few seconds this reads, from ECS, each service's desired/running/
 * pending counts and every task's lifecycle state, Availability Zone, private
 * IP, size and task-definition revision; and, from S3, the scaling
 * controller's latest decision. Differences from the previous reading become
 * trace events — a task moving PROVISIONING → PENDING → RUNNING, a scaling
 * decision — so the "Under the hood" view can show tasks being born and dying.
 */
import { DescribeServicesCommand, DescribeTasksCommand, ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

const REFRESH_MS = 4000;
/** Keep stopped tasks visible briefly, so their exit can be shown. */
const STOPPED_VISIBLE_MS = 90_000;

const NO_TRACE = { emit() {} };

export class Fleet {
  /**
   * @param {{region: string, cluster: string, services: Object, bucket: string, trace?: Object}} options - Where to look
   */
  constructor({ region, cluster, services, bucket, trace = NO_TRACE }) {
    this.ecs = new ECSClient({ region });
    this.s3 = new S3Client({ region });
    this.cluster = cluster;
    this.services = services;
    this.bucket = bucket;
    this.trace = trace;
    this.state = null;
    this.tasks = new Map();
    this.lastScalerAt = null;
    this.seenScaleEvents = new Set();

    const refresh = () => this.#refresh().catch((error) => console.error("Fleet refresh failed:", error.message));
    refresh();
    this.timer = setInterval(refresh, REFRESH_MS);
    this.timer.unref();
  }

  async #refresh() {
    const names = Object.values(this.services);
    const [described, tasks, scaler] = await Promise.all([
      this.ecs.send(new DescribeServicesCommand({ cluster: this.cluster, services: names })),
      this.#readTasks(),
      this.#scalerStatus(),
    ]);

    const byName = Object.fromEntries((described.services ?? []).map((s) => [s.serviceName, s]));
    const counts = (name) => {
      const s = byName[name];
      return s ? { desired: s.desiredCount, running: s.runningCount, pending: s.pendingCount } : null;
    };

    this.#diffTasks(tasks);
    this.#diffScaler(scaler);

    this.state = {
      at: new Date().toISOString(),
      workers: counts(this.services.workers),
      api: counts(this.services.api),
      scalerService: counts(this.services.scaler),
      tasks,
      scaler,
    };
  }

  async #readTasks() {
    const arns = [];
    const serviceOf = new Map();
    for (const [role, serviceName] of Object.entries(this.services)) {
      for (const desiredStatus of ["RUNNING", "STOPPED"]) {
        const listed = await this.ecs.send(
          new ListTasksCommand({ cluster: this.cluster, serviceName, desiredStatus }),
        );
        for (const arn of listed.taskArns ?? []) {
          arns.push(arn);
          serviceOf.set(arn, role);
        }
      }
    }
    if (!arns.length) return [];

    const tasks = [];
    for (let i = 0; i < arns.length; i += 100) {
      const described = await this.ecs.send(
        new DescribeTasksCommand({ cluster: this.cluster, tasks: arns.slice(i, i + 100) }),
      );
      for (const task of described.tasks ?? []) {
        const stoppedAt = task.stoppedAt ? new Date(task.stoppedAt).getTime() : null;
        if (stoppedAt && Date.now() - stoppedAt > STOPPED_VISIBLE_MS) continue;

        const eni = (task.attachments ?? []).flatMap((a) => a.details ?? []);
        tasks.push({
          arn: task.taskArn,
          id: task.taskArn.split("/").pop().slice(0, 8),
          service: serviceOf.get(task.taskArn),
          lastStatus: task.lastStatus,
          desiredStatus: task.desiredStatus,
          health: task.healthStatus,
          az: task.availabilityZone,
          ip: eni.find((d) => d.name === "privateIPv4Address")?.value ?? null,
          cpu: Number(task.cpu),
          memory: Number(task.memory),
          revision: task.taskDefinitionArn?.split(":").pop(),
          createdAt: task.createdAt ? new Date(task.createdAt).getTime() : null,
          startedAt: task.startedAt ? new Date(task.startedAt).getTime() : null,
          stoppedAt,
          stoppedReason: task.stoppedReason ?? null,
        });
      }
    }
    return tasks.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  #diffTasks(tasks) {
    const next = new Map(tasks.map((t) => [t.arn, t]));
    for (const task of tasks) {
      const previous = this.tasks.get(task.arn);
      if (!previous || previous.lastStatus !== task.lastStatus) {
        this.trace.emit("task", {
          service: task.service,
          taskId: task.id,
          from: previous?.lastStatus ?? null,
          to: task.lastStatus,
          az: task.az,
          ip: task.ip,
          cpu: task.cpu,
          memory: task.memory,
          reason: task.stoppedReason,
        });
      }
    }
    this.tasks = next;
  }

  #diffScaler(scaler) {
    if (!scaler || scaler.at === this.lastScalerAt) return;
    this.lastScalerAt = scaler.at;
    this.trace.emit("scaler", {
      reason: scaler.reason,
      wanted: scaler.wanted,
      desired: scaler.service?.desired,
      visible: scaler.queue?.visible,
      inflight: scaler.queue?.inflight,
      at: scaler.at,
    });
    // Oldest first, so a burst of decisions replays in order.
    for (const event of [...(scaler.history ?? [])].reverse()) {
      if (this.seenScaleEvents.has(event.at)) continue;
      this.seenScaleEvents.add(event.at);
      // Do not replay history from before this process started watching.
      if (this.primed) this.trace.emit("scale", { ...event, op: "ecs:UpdateService" });
    }
    this.primed = true;
  }

  async #scalerStatus() {
    try {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: "status/scaler.json" }));
      return JSON.parse(await result.Body.transformToString());
    } catch {
      return null;
    }
  }

  /** @returns {Object|null} Latest fleet picture */
  snapshot() {
    return this.state;
  }
}
