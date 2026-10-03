/**
 * Wrap the platform adapters so every call they make is traced.
 *
 * Wrapping is done in place, on the adapter objects themselves, so anything
 * holding a reference — the store-polling notifier, local workers — is traced
 * too. Operation names follow AWS's own "service:Action" form in the cloud,
 * and say plainly what stands in for them locally.
 */
import { currentContext } from "./trace.js";

const currentContextSafe = () => currentContext();

const NAMES = {
  aws: {
    get: "s3:GetObject",
    has: "s3:HeadObject",
    put: "s3:PutObject",
    send: "sqs:SendMessage",
    depth: "sqs:GetQueueAttributes",
    bucket: "n5453313-fractal-tiles",
    queue: "n5453313-a3-render-queue",
  },
  local: {
    get: "fs:readFile",
    has: "fs:stat",
    put: "fs:writeFile",
    send: "queue:enqueue",
    depth: "queue:depth",
    bucket: ".data/tiles",
    queue: "in-memory queue",
  },
};

/**
 * @param {{queue: Object, store: Object}} platform - Adapters to wrap
 * @param {import("./trace.js").Trace} trace - Where events go
 * @param {string} platformName - "aws" or "local"
 * @returns {void}
 */
export function instrumentPlatform({ queue, store }, trace, platformName) {
  const n = NAMES[platformName] ?? NAMES.local;

  const get = store.get.bind(store);
  store.get = (key) =>
    trace.call(n.get, { svc: "s3", res: n.bucket, key }, () => get(key), (bytes) => ({
      status: bytes ? 200 : 404,
      bytes: bytes?.byteLength ?? 0,
    }));

  const has = store.has.bind(store);
  store.has = (key) =>
    trace.call(n.has, { svc: "s3", res: n.bucket, key }, () => has(key), (present) => ({
      status: present ? 200 : 404,
    }));

  const put = store.put.bind(store);
  store.put = (key, bytes) =>
    trace.call(n.put, { svc: "s3", res: n.bucket, key, bytes: bytes.byteLength }, () => put(key, bytes), () => ({
      status: 200,
    }));

  const send = queue.send.bind(queue);
  queue.send = (job) =>
    trace.call(n.send, { svc: "sqs", res: n.queue, key: job.key }, () => send(job), () => ({ status: 200 }));

  // Local mode only: workers live in this process, so their side of the queue
  // is visible too. (In the cloud the API never receives — workers do.)
  if (platformName === "local") {
    const receive = queue.receive.bind(queue);
    queue.receive = async (options) => {
      const lease = await receive(options);
      if (!lease) return lease;
      trace.emit("call", { op: "queue:receive", svc: "sqs", res: n.queue, key: lease.job.key, status: 200, ms: 0, ...currentContextSafe() });
      const ack = lease.ack;
      lease.ack = async () => {
        await ack();
        trace.emit("call", { op: "queue:delete", svc: "sqs", res: n.queue, key: lease.job.key, status: 200, ms: 0, ...currentContextSafe() });
      };
      return lease;
    };
  }

  const depth = queue.depth.bind(queue);
  queue.depth = () =>
    trace.call(n.depth, { svc: "sqs", res: n.queue, control: true }, () => Promise.resolve(depth()), (d) => ({
      status: 200,
      visible: d.visible,
      inflight: d.inflight,
      deadLetters: d.deadLetters,
    }));
}
