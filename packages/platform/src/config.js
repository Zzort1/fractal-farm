/**
 * Configuration, from the environment only.
 *
 * Nothing about where the system runs is baked into code: the same images run
 * locally and on AWS, and only these values differ. `PLATFORM=local` (the
 * default) needs no cloud account at all.
 */

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * @param {Object} env - Usually process.env
 * @returns {Object} Resolved configuration
 */
export function loadConfig(env = process.env) {
  return {
    platform: env.PLATFORM || "local",
    region: env.AWS_REGION || "ap-southeast-2",

    port: int(env.PORT, 8787),
    host: env.HOST || "0.0.0.0",

    /** Local mode: where tiles are written in place of an object store. */
    dataDir: env.DATA_DIR || ".data",

    /** In-memory tile cache budget per API instance. */
    memoryCacheBytes: int(env.MEMORY_CACHE_MB, 64) * 1024 * 1024,

    /** How long a tile request waits for a render before answering 202. */
    renderWaitMs: int(env.RENDER_WAIT_MS, 2000),

    /** Local mode: render workers started inside the API process. */
    localWorkers: int(env.LOCAL_WORKERS, 4),

    /** Attempts before a job is dead-lettered (local; SQS uses its redrive policy). */
    maxAttempts: int(env.MAX_ATTEMPTS, 3),

    /** AWS mode: where tiles and jobs live. */
    tileBucket: env.TILE_BUCKET,
    queueUrl: env.QUEUE_URL,
    dlqUrl: env.DLQ_URL,

    /** A name for this process in logs and tile headers. */
    instanceId: env.INSTANCE_ID,
  };
}
