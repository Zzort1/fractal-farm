/**
 * Build the infrastructure adapters for the configured platform.
 *
 *   capability     local                    aws
 *   job queue      MemoryQueue              SQS + dead-letter queue
 *   tile store     FileStore                S3
 *   memory cache   MemoryCache              MemoryCache, per API instance
 *   notifier       MemoryNotifier           polling the store (no pub-sub
 *                                            is permitted in the CAB432 account)
 *
 * Services depend only on these interfaces, so moving to the cloud is a
 * configuration change rather than a code fork.
 */
import { loadConfig } from "./config.js";
import { FileStore } from "./fileStore.js";
import { MemoryCache } from "./memoryCache.js";
import { MemoryNotifier } from "./memoryNotifier.js";
import { MemoryQueue } from "./memoryQueue.js";
import { S3Store } from "./s3Store.js";
import { SqsQueue } from "./sqsQueue.js";
import { StorePollingNotifier } from "./storePollingNotifier.js";

export { loadConfig };

/**
 * @param {Object} config - From loadConfig()
 * @returns {{queue: Object, store: Object, cache: MemoryCache, notifier: Object}} Adapters
 */
export function createPlatform(config) {
  const cache = new MemoryCache({ maxBytes: config.memoryCacheBytes });

  if (config.platform === "local") {
    return {
      queue: new MemoryQueue({ maxAttempts: config.maxAttempts }),
      store: new FileStore({ root: config.dataDir }),
      cache,
      notifier: new MemoryNotifier(),
    };
  }

  if (config.platform === "aws") {
    const store = new S3Store({ region: config.region, bucket: config.tileBucket });
    return {
      queue: new SqsQueue({ region: config.region, queueUrl: config.queueUrl, dlqUrl: config.dlqUrl }),
      store,
      cache,
      notifier: new StorePollingNotifier({ store }),
    };
  }

  throw new Error(`Unknown PLATFORM: ${config.platform} (expected local or aws)`);
}
