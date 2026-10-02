/**
 * Standalone render worker — the process each worker container runs.
 *
 * One worker per container, rendering one tile at a time: capacity is added
 * by running more containers, which is exactly what the scaling policy
 * controls. The worker needs no inbound network access at all; it only
 * pulls from the queue and writes to the store.
 */
import os from "node:os";
import { createPlatform, loadConfig } from "@fractal-farm/platform";
import { startWorker } from "./loop.js";

/** Fargate gives a task 30 s between SIGTERM and SIGKILL by default. */
const SHUTDOWN_GRACE_MS = 25_000;

/**
 * A short, readable id: the ECS task id when running on ECS, else the host.
 * @returns {Promise<string>} Worker id
 */
async function workerId() {
  const metadata = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (metadata) {
    try {
      const task = await (await fetch(`${metadata}/task`)).json();
      return `task-${task.TaskARN.split("/").pop().slice(0, 8)}`;
    } catch {
      // Fall through to the hostname.
    }
  }
  return (process.env.INSTANCE_ID || os.hostname()).slice(0, 20);
}

const config = loadConfig();
const platform = createPlatform(config);
const id = await workerId();

const log = (event) => {
  if (event.type === "idle" || event.type === "busy") return;
  console.log(JSON.stringify({ ...event, at: new Date().toISOString() }));
};

const worker = startWorker({ id, ...platform, onEvent: log });
console.log(JSON.stringify({ message: "Worker started", workerId: id, platform: config.platform }));

let stopping = false;
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ message: "Worker stopping", workerId: id, signal }));
  await worker.stop({ graceMs: SHUTDOWN_GRACE_MS });
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
