/**
 * Build the infrastructure adapters for the configured platform.
 *
 *   capability     local (now)              aws (later stages)
 *   job queue      MemoryQueue              SQS + dead-letter queue
 *   tile store     FileStore                S3
 *   memory cache   MemoryCache (per API)    + ElastiCache, shared
 *   notifier       MemoryNotifier           ElastiCache pub-sub
 *
 * Services depend only on these interfaces, so moving to the cloud is a
 * configuration change rather than a code fork.
 */
import { loadConfig } from "./config.js";
import { FileStore } from "./fileStore.js";
import { MemoryCache } from "./memoryCache.js";
import { MemoryNotifier } from "./memoryNotifier.js";
import { MemoryQueue } from "./memoryQueue.js";

export { loadConfig };

/**
 * @param {Object} config - From loadConfig()
 * @returns {{queue: Object, store: Object, cache: MemoryCache, notifier: Object}} Adapters
 */
export function createPlatform(config) {
  if (config.platform === "local") {
    return {
      queue: new MemoryQueue({ maxAttempts: config.maxAttempts }),
      store: new FileStore({ root: config.dataDir }),
      cache: new MemoryCache({ maxBytes: config.memoryCacheBytes }),
      notifier: new MemoryNotifier(),
    };
  }

  throw new Error(
    `PLATFORM=${config.platform} is not implemented yet — the AWS adapters arrive in a later stage`,
  );
}
