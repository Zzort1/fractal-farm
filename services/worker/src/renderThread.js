/**
 * CPU thread entry point. Rendering is pure synchronous maths; running it
 * here keeps the worker's main event loop free to talk to the queue (and,
 * on SQS, to extend message visibility) while a heavy tile renders.
 */
import { parentPort } from "node:worker_threads";
import { renderTile } from "@fractal-farm/core";

parentPort.on("message", ({ seq, spec }) => {
  try {
    const tile = renderTile(spec);
    parentPort.postMessage({ seq, tile }, [tile.values.buffer, tile.classes.buffer]);
  } catch (error) {
    parentPort.postMessage({ seq, error: error.message });
  }
});
