/**
 * Cloud mode: what the container fleet looks like right now.
 *
 * Every few seconds: the worker and API services' desired/running/pending
 * counts from ECS, and the scaling controller's latest decision (it writes a
 * status object to S3 each tick). The control room shows these so a scaling
 * event can be watched as it happens: reason → desired count → tasks starting.
 */
import { DescribeServicesCommand, ECSClient } from "@aws-sdk/client-ecs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

const REFRESH_MS = 5000;

export class Fleet {
  /**
   * @param {{region: string, cluster: string, services: Object, bucket: string}} options - Where to look
   */
  constructor({ region, cluster, services, bucket }) {
    this.ecs = new ECSClient({ region });
    this.s3 = new S3Client({ region });
    this.cluster = cluster;
    this.services = services;
    this.bucket = bucket;
    this.state = null;

    const refresh = () => this.#refresh().catch((error) => console.error("Fleet refresh failed:", error.message));
    refresh();
    this.timer = setInterval(refresh, REFRESH_MS);
    this.timer.unref();
  }

  async #refresh() {
    const [described, scaler] = await Promise.all([
      this.ecs.send(
        new DescribeServicesCommand({ cluster: this.cluster, services: Object.values(this.services) }),
      ),
      this.#scalerStatus(),
    ]);

    const byName = Object.fromEntries((described.services ?? []).map((s) => [s.serviceName, s]));
    const counts = (name) => {
      const s = byName[name];
      return s ? { desired: s.desiredCount, running: s.runningCount, pending: s.pendingCount } : null;
    };

    this.state = {
      at: new Date().toISOString(),
      workers: counts(this.services.workers),
      api: counts(this.services.api),
      scaler,
    };
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
