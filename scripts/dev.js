/**
 * Start the API (with local workers) and the web dev server together, with
 * coloured, prefixed output. Ctrl+C stops both.
 */
import { spawn } from "node:child_process";

const processes = [
  { name: "api", colour: "\x1b[35m", args: ["run", "dev:api"] },
  { name: "web", colour: "\x1b[36m", args: ["run", "dev:web"] },
];

const children = processes.map(({ name, colour, args }) => {
  // One command string: npm is a shell script on Windows, so it needs a shell.
  const child = spawn(`npm ${args.join(" ")}`, { shell: true, env: process.env });
  const prefix = `${colour}[${name}]\x1b[0m `;
  const relay = (stream) => (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) stream.write(prefix + line + "\n");
    }
  };
  child.stdout.on("data", relay(process.stdout));
  child.stderr.on("data", relay(process.stderr));
  child.on("exit", (code) => {
    console.log(`${prefix}exited (${code})`);
    shutdown();
  });
  return child;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) {
      // On Windows the shell wrapper must be killed with its whole tree.
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill("SIGINT");
    }
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
