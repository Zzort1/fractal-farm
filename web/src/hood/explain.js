/**
 * Words for the "Under the hood" view: what each component is, how one
 * tile's journey reads as a story, and a guided tour of the design.
 *
 * Journeys are rebuilt from the trace history, never invented: every step
 * cites events that actually happened, with their real timings.
 */

// ---------------------------------------------------------------------------
// Hover descriptions
// ---------------------------------------------------------------------------

export const NODE_INFO = {
  browser: {
    title: "Your browser",
    what: "The React client. Requests 256×256 tiles by canonical URL, keeps decoded tiles in memory and in the HTTP cache, and colours them locally.",
    aws: "No AWS service: tile URLs are immutable, so the browser may cache them for a year.",
    pattern: "Client-side caching · numbers, not colours",
  },
  r53: {
    title: "Amazon Route 53 — DNS",
    what: "Alias A record n5453313-fractal.cab432.com → the load balancer, so the name survives task and IP changes.",
    aws: "Hosted zone cab432.com. Your browser resolves the name once and caches it, so DNS is not animated per request.",
    pattern: "Networking & DNS",
  },
  alb: {
    title: "Application Load Balancer",
    what: "The single public entry point. Terminates TLS, redirects HTTP to HTTPS, health-checks every API task and forwards each request to a healthy one.",
    aws: "n5453313-a3-alb · :443 TLS 1.3 (ACM) · :80 → 301 · target group n5453313-a3-api-tg, IP targets :8080, GET /healthz every 10 s.",
    pattern: "Dispatcher-push load distribution",
  },
  s3: {
    title: "Amazon S3 — tile store",
    what: "The durable, shared cache layer. Tiles are pure functions of their URL, so once stored they are valid forever. Workers write; the API reads; completion polls check.",
    aws: "Private bucket n5453313-fractal-tiles · public access blocked · objects stored gzip with Cache-Control immutable.",
    pattern: "Unstructured storage · durable cache layer",
  },
  sqs: {
    title: "Amazon SQS — render queue",
    what: "Holds one job per tile that missed every cache. Workers long-poll it; a received job is hidden for 60 s and only deleted once its tile is safely in S3.",
    aws: "n5453313-a3-render-queue · visibility 60 s · long poll 20 s · retention 1 h · redrive to the DLQ after 3 receives.",
    pattern: "Message queue · worker-pull · at-least-once delivery",
  },
  dlq: {
    title: "SQS dead-letter queue",
    what: "Where a job lands after failing three times, so a poison job cannot loop forever and can be inspected later.",
    aws: "n5453313-a3-render-dlq · 4-day retention.",
    pattern: "Fault isolation",
  },
  ecs: {
    title: "Amazon ECS — control plane",
    what: "Keeps every service at its desired task count: places Fargate tasks, replaces failed ones, and registers API tasks with the load balancer.",
    aws: "Cluster n5453313-a2-cluster (reused from A2) · services fractal-api, fractal-worker, fractal-scaler.",
    pattern: "Orchestration · containers",
  },
  ecr: {
    title: "Amazon ECR — image registry",
    what: "Private registry holding the three container images. A new task pulls its image from here before it can start.",
    aws: "n5453313-fractal-api / -worker / -scaler · tagged by git commit and latest · scan on push.",
    pattern: "Immutable deployments",
  },
  scaler: {
    title: "fractal-scaler — the scaling controller",
    what: "Every 10 s: reads queue depth, wants ceil(backlog ÷ target) workers, scales out at once, scales in only after a 60 s cool-down, and to zero when idle.",
    aws: "Its own Fargate service, applying decisions with ecs:UpdateService (Application Auto Scaling is not granted in this account).",
    pattern: "Metric-based auto-scaling (target tracking)",
  },
  cw: {
    title: "Amazon CloudWatch",
    what: "Logs from every container, plus metrics the scaler emits as structured log lines — no metrics API permission needed.",
    aws: "Log groups /ecs/n5453313-fractal-* · namespace n5453313/FractalFarm: Backlog, BacklogPerWorker, DesiredWorkers, RunningWorkers.",
    pattern: "Monitoring · Embedded Metric Format",
  },
  api: {
    title: "API task — Fargate",
    what: "Stateless tile API: canonicalises the URL, checks its in-memory LRU, then S3, otherwise queues a render and waits up to 2 s before answering 202. Also serves this web app and the live streams.",
    aws: "Service fractal-api · 0.25 vCPU · 0.5 GB · 160 MB LRU · registered behind the ALB.",
    pattern: "Stateless compute · in-memory caching",
  },
  worker: {
    title: "Render worker — Fargate",
    what: "Pulls one job at a time, renders 65,536 pixels on a worker thread, gzips the tile, writes it to S3, then deletes the message. Checks S3 first, so a duplicate job is harmless.",
    aws: "Service fractal-worker · 0.5 vCPU · 1 GB · no inbound ports · 0–8 tasks set by the scaler.",
    pattern: "Worker-pull · idempotent consumer · scale-to-zero",
  },
};

export const TASK_STATES = {
  PROVISIONING: "ECS is reserving Fargate capacity and attaching a network interface.",
  PENDING: "Pulling the image from ECR and starting the container.",
  ACTIVATING: "Registering with the load balancer / finishing start-up.",
  RUNNING: "Up and taking work.",
  DEACTIVATING: "Draining: no new work; finishing what it has.",
  STOPPING: "Received SIGTERM; has 30 s to finish its current tile.",
  DEPROVISIONING: "Releasing its network interface.",
  STOPPED: "Gone. Fargate billing stopped.",
};

// ---------------------------------------------------------------------------
// Journeys: one tile's story from the trace
// ---------------------------------------------------------------------------

const ms = (v) => (v === undefined || v === null ? "" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v * 10) / 10} ms`);
const kb = (b) => (b ? `${(b / 1024).toFixed(1)} KB` : "");
const reqKey = (e) => `${e.inst}#${e.req}`;
const apiNode = (e) => `api:${String(e.inst ?? "").replace(/^task-/, "")}`;
const workerNode = (id) => `wk:${String(id ?? "").replace(/^task-/, "")}`;

/**
 * The tile key an event refers to, if any.
 * @param {Object} e - Trace event
 * @returns {string|null} Tile key
 */
export function keyOf(e) {
  return e?.key ?? null;
}

/**
 * Rebuild one tile's journey from trace events.
 * @param {Array} events - Trace history
 * @param {string} key - Tile key
 * @returns {{key: string, steps: Array, complete: boolean, started: number|null, finished: number|null}} Journey
 */
export function buildJourney(events, key) {
  const reqs = new Set(events.filter((e) => e.key === key && e.req).map(reqKey));
  const related = events
    .filter((e) => e.key === key || (e.type === "request" && reqs.has(reqKey(e))))
    .sort((a, b) => a.t - b.t || a.seq - b.seq);

  // Group per request cycle; everything else (polls, workers, renders) stands alone.
  const cycles = new Map();
  const loose = [];
  for (const e of related) {
    if (e.req && (e.actor === "api" || e.type === "request" || e.type === "response" || e.type === "cache" || e.type === "coalesced")) {
      const k = reqKey(e);
      if (!cycles.has(k)) cycles.set(k, []);
      cycles.get(k).push(e);
    } else {
      loose.push(e);
    }
  }

  const steps = [];
  let first = true;
  const cycleList = [...cycles.values()].sort((a, b) => a[0].t - b[0].t);
  for (const cycle of cycleList) {
    if (first) {
      steps.push(...detailedCycle(cycle));
      first = false;
    } else {
      steps.push(condensedCycle(cycle));
    }
  }

  // Loose events: merge runs of completion polls.
  for (let i = 0; i < loose.length; i += 1) {
    const e = loose[i];
    if (e.actor === "poll" && /HeadObject|stat/.test(e.op)) {
      const run = [e];
      while (loose[i + 1] && loose[i + 1].actor === "poll" && /HeadObject|stat/.test(loose[i + 1].op)) run.push(loose[(i += 1)]);
      steps.push(pollStep(run));
    } else {
      const step = looseStep(e);
      if (step) steps.push(step);
    }
  }

  // Many events share a millisecond; the server's sequence number keeps
  // their true order.
  for (const step of steps) step.seq = step.events?.[0]?.seq ?? 0;

  // A local worker reports its render after writing the tile; the render
  // really happened just before the write, so narrate it there.
  for (const step of steps) {
    if (!step.renderBy) continue;
    const write = steps.find((x) => x.writeBy === step.renderBy);
    if (write) {
      step.at = write.at;
      step.seq = write.seq - 0.5;
    }
  }

  steps.sort((a, b) => a.at - b.at || a.seq - b.seq);
  const responses = related.filter((e) => e.type === "response");
  const final = responses.find((e) => e.status === 200);
  const started = related[0]?.t ?? null;
  const finished = final?.t ?? null;
  if (final && started !== null) {
    steps.push({
      at: final.t + 0.5,
      tone: "lime",
      title: `Done in ${ms(final.t - started)}`,
      text: summaryText(related, final, started),
      highlight: ["browser"],
      events: [],
    });
  }
  return { key, steps, complete: Boolean(final), started, finished };
}

function detailedCycle(cycle) {
  const steps = [];
  let queued = false;
  for (const e of cycle) {
    switch (e.type) {
      case "request":
        steps.push({
          at: e.t,
          tone: "sky",
          title: "Browser asks for the tile",
          text: `GET ${e.path}${e.query ? `?${e.query}` : ""}. Route 53 already gave the browser the load balancer's address; the ALB terminates TLS and forwards the request to API task ${e.inst} on port 8080.`,
          why: "One stable, health-checked entry point spreads requests over however many API tasks exist (dispatcher-push).",
          highlight: ["browser", "alb", apiNode(e)],
          events: [e],
        });
        break;
      case "cache":
        steps.push({
          at: e.t,
          tone: e.hit ? "cyan" : "muted",
          title: e.hit ? "Memory cache: HIT" : "Memory cache: miss",
          text: e.hit
            ? "The API task already holds this tile in its in-memory LRU, so it answers without calling any AWS service."
            : "Not in this API task's in-memory LRU, so it looks further down the cache layers.",
          why: "Memory is microseconds; every hit is an S3 read and a render that never happen.",
          highlight: [apiNode(e)],
          events: [e],
        });
        break;
      case "call": {
        const step = apiCallStep(e, queued);
        if (/SendMessage|enqueue/.test(e.op)) queued = true;
        if (step) steps.push(step);
        break;
      }
      case "coalesced":
        steps.push({
          at: e.t,
          tone: "gold",
          title: "Joined a render already in flight",
          text: "Another request is already waiting for this tile, so this one joins that wait instead of queueing a second, identical job.",
          why: "Request coalescing: a burst of identical misses costs one render, not many.",
          highlight: [apiNode(e), "sqs"],
          events: [e],
        });
        break;
      case "response":
        steps.push(responseStep(e));
        break;
      default:
        break;
    }
  }
  return steps;
}

function apiCallStep(e, queued = false) {
  if (/GetObject|readFile/.test(e.op) && e.status === 200 && queued) {
    return {
      at: e.t,
      tone: "lime",
      title: `Finished tile read back from S3 (${ms(e.ms)})`,
      text: `The render landed, so the API fetched it once (${kb(e.bytes)}) and put it in memory for every request waiting on it.`,
      why: "One read serves all coalesced requests and every later poll.",
      highlight: [apiNode(e), "s3"],
      events: [e],
    };
  }
  if (/GetObject|readFile/.test(e.op)) {
    return e.status === 200
      ? {
          at: e.t,
          tone: "lime",
          title: `S3: found it (${ms(e.ms)})`,
          text: `${e.op} on ${e.res} returned the stored tile (${kb(e.bytes)}). Someone rendered it earlier; it is copied into memory for next time.`,
          why: "S3 is the durable, shared cache: a render done once serves everyone, forever.",
          highlight: [apiNode(e), "s3"],
          events: [e],
        }
      : {
          at: e.t,
          tone: "orange",
          title: `S3: not there yet (${e.status}, ${ms(e.ms)})`,
          text: `${e.op} on ${e.res} found nothing — this tile has never been rendered.`,
          why: "A miss in every cache layer is the only case that costs compute.",
          highlight: [apiNode(e), "s3"],
          events: [e],
        };
  }
  if (/SendMessage|enqueue/.test(e.op)) {
    return {
      at: e.t,
      tone: "gold",
      title: `Render job queued (${ms(e.ms)})`,
      text: `${e.op} put a job on ${e.res}. The message carries the canonical tile spec and its storage key, so any worker can render it.`,
      why: "The API never renders: it hands off to the queue and stays free for other requests.",
      highlight: [apiNode(e), "sqs"],
      events: [e],
    };
  }
  return null;
}

function responseStep(e) {
  if (e.status === 202) {
    return {
      at: e.t,
      tone: "gold",
      title: `202 "rendering" after ${ms(e.ms)}`,
      text: "The API waited its 2 s budget; the render is not finished, so it answered 202 instead of holding the connection. The browser shows a dashed border and retries with backoff.",
      why: "Bounded waiting keeps connections free; the slow work stays asynchronous.",
      highlight: [apiNode(e), "alb", "browser"],
      events: [e],
    };
  }
  if (e.status === 200) {
    const how = { memory: "from the API task's memory", store: "from S3", render: "fresh from the render farm" }[e.source] ?? "";
    return {
      at: e.t,
      tone: e.source === "render" ? "magenta" : e.source === "store" ? "lime" : "cyan",
      title: `200 OK ${how} (${ms(e.ms)})`,
      text: `The tile (${kb(e.bytes)}, gzip) goes back through the ALB to the browser, which decodes the numbers and colours them with your palette.`,
      why: "The URL is immutable, so the browser may now cache this tile for a year.",
      highlight: [apiNode(e), "alb", "browser"],
      events: [e],
    };
  }
  return {
    at: e.t,
    tone: "red",
    title: `${e.status} ${e.error ?? ""}`,
    text: e.location ? `Redirected to the canonical spelling: ${e.location}` : "Rejected before any AWS call was made.",
    why: "Canonical URLs keep the cache key space bounded and block cache-busting.",
    highlight: [apiNode(e), "browser"],
    events: [e],
  };
}

function condensedCycle(cycle) {
  const request = cycle.find((e) => e.type === "request");
  const response = cycle.find((e) => e.type === "response");
  const parts = [];
  for (const e of cycle) {
    if (e.type === "cache") parts.push(e.hit ? "memory HIT" : "memory miss");
    if (e.type === "call" && /Get|read/.test(e.op)) parts.push(`S3 ${e.status}`);
    if (e.type === "coalesced") parts.push("joined in-flight render");
    if (e.type === "call" && /Send|enqueue/.test(e.op)) parts.push("queued");
  }
  const outcome = response ? (response.status === 202 ? `202 after ${ms(response.ms)}` : `${response.status} ${response.source ?? ""} in ${ms(response.ms)}`) : "…";
  return {
    at: (request ?? cycle[0]).t,
    tone: response?.status === 200 ? "cyan" : "gold",
    title: `Browser retries (request #${(request ?? cycle[0]).req})`,
    text: `${parts.join(" → ")} → ${outcome}.`,
    why: response?.status === 200 ? "The render landed between retries, so this retry was answered from a cache layer." : "Polling with backoff: the browser keeps asking only while the tile is still on screen.",
    highlight: [apiNode(request ?? cycle[0]), "alb", "browser"],
    events: cycle,
  };
}

function pollStep(run) {
  const found = run.find((e) => e.status === 200);
  return {
    at: run[0].t,
    tone: found ? "lime" : "gold",
    title: found ? `Completion poll: tile appeared (after ${run.length} checks)` : `Completion poll: ${run.length} checks, not yet`,
    text: `The API's waiter checks S3 for the finished tile with ${run[0].op}, backing off from 100 ms to 2 s between checks.`,
    why: "SNS and ElastiCache pub-sub are denied in this account, so the object appearing in S3 is the completion signal.",
    highlight: [apiNode(run[0]), "s3"],
    events: run,
  };
}

function looseStep(e) {
  if (e.type === "render") {
    const remote = e.via === "tile-header";
    return {
      at: e.t,
      tone: "magenta",
      title: `Rendered by ${e.workerId} in ${ms(e.renderMs)}`,
      text: remote
        ? `Fargate task ${e.workerId} received the job from SQS, rendered 65,536 pixels in ${ms(e.renderMs)} of CPU, gzipped the tile and wrote it to S3. The job spent ${ms(e.waitedMs)} from queueing to completion. (Read from the tile's own header: the API cannot see inside the worker.)`
        : `Worker ${e.workerId} rendered the tile in ${ms(e.renderMs)}; ${ms(e.waitedMs)} after it was queued.`,
      why: "Workers pull work only when free, so load spreads itself however many workers exist.",
      highlight: ["sqs", workerNode(e.workerId), "s3"],
      events: [e],
      renderBy: remote ? null : e.workerId,
    };
  }
  if (e.type === "call" && e.actor === "worker") {
    const node = workerNode(e.worker);
    if (/receive/.test(e.op)) return { at: e.t, tone: "gold", title: `${e.worker} takes the job`, text: `${e.op}: the job is now invisible to other workers for 60 s.`, why: "If this worker died now, the job would simply reappear for another.", highlight: ["sqs", node], events: [e] };
    if (/stat|Head/.test(e.op)) return { at: e.t, tone: "muted", title: `${e.worker} checks it is not already done`, text: `${e.op} → ${e.status}. A duplicate delivery would stop here at no cost.`, why: "Idempotent consumer: at-least-once delivery is safe.", highlight: [node, "s3"], events: [e] };
    if (/write|Put/.test(e.op)) return { at: e.t, tone: "magenta", title: `${e.worker} stores the tile (${kb(e.bytes)})`, text: `${e.op} writes the gzipped tile atomically, so no reader ever sees half a tile.`, why: "The store write is also the completion signal the API is polling for.", highlight: [node, "s3"], events: [e], writeBy: e.worker };
    if (/delete/.test(e.op)) return { at: e.t, tone: "muted", title: `${e.worker} acknowledges the job`, text: `${e.op}: only now is the job removed from the queue.`, why: "Deleting last means a crash at any earlier point leads to a retry, not a lost tile.", highlight: [node, "sqs"], events: [e] };
  }
  if (e.type === "worker" && e.state === "busy") return null;
  if (e.type === "job-timeout") return { at: e.t, tone: "red", title: "Job presumed lost", text: "No completion within 120 s: the next request for this tile will queue it again.", why: "Timeouts turn a silent loss into a retry.", highlight: ["sqs"], events: [e] };
  return null;
}

function summaryText(related, final, started) {
  const render = related.find((e) => e.type === "render");
  const polls = related.filter((e) => e.actor === "poll").length;
  const retries = new Set(related.filter((e) => e.type === "request").map(reqKey)).size - 1;
  const parts = [`Total ${ms(final.t - started)} from first request to pixels`];
  if (render) parts.push(`render ${ms(render.renderMs)} on ${render.workerId}`);
  if (retries > 0) parts.push(`${retries} browser ${retries === 1 ? "retry" : "retries"}`);
  if (polls) parts.push(`${polls} S3 completion checks`);
  return `${parts.join(" · ")}. Every later view of this tile is a cache hit.`;
}

// ---------------------------------------------------------------------------
// Drill-in: which log lines belong to a map component
// ---------------------------------------------------------------------------

const bare = (id) => String(id ?? "").replace(/^task-/, "");

/**
 * @param {string} nodeId - Map node id ("s3", "api:1a2b3c4d", "wk:…")
 * @returns {{label: string, match: Function}|null} Call-log focus
 */
export function focusFor(nodeId) {
  if (nodeId.startsWith("api:")) {
    const id = nodeId.slice(4);
    return { label: `api ${id}`, match: (e) => bare(e.inst) === id && e.actor !== "worker" };
  }
  if (nodeId.startsWith("wk:")) {
    const id = nodeId.slice(3);
    return {
      label: `worker ${id}`,
      match: (e) => bare(e.worker) === id || bare(e.workerId) === id || (e.type === "task" && e.taskId === id),
    };
  }
  const byNode = {
    browser: ["browser ⇄ ALB", (e) => e.type === "request" || e.type === "response"],
    alb: ["ALB traffic", (e) => e.type === "request" || e.type === "response"],
    r53: ["browser ⇄ ALB", (e) => e.type === "request" || e.type === "response"],
    s3: ["S3", (e) => e.svc === "s3"],
    sqs: ["SQS", (e) => e.svc === "sqs"],
    dlq: ["SQS", (e) => e.svc === "sqs"],
    ecs: ["ECS", (e) => e.type === "task" || e.type === "scale"],
    ecr: ["ECS tasks", (e) => e.type === "task"],
    scaler: ["scaler", (e) => e.type === "scale" || e.type === "scaler"],
    cw: ["scaler", (e) => e.type === "scale" || e.type === "scaler"],
  }[nodeId];
  return byNode ? { label: byNode[0], match: byNode[1] } : null;
}

// ---------------------------------------------------------------------------
// Guided tour
// ---------------------------------------------------------------------------

export const TOUR = [
  {
    title: "1 · The browser asks for numbers, not pictures",
    text: "The client requests 256×256 tiles by a canonical, immutable URL. Tiles hold smooth iteration counts; your palette is applied in the browser, so restyling never costs the cloud anything.",
    why: "Deterministic tiles are what make every cache layer safe to keep forever.",
    highlight: ["browser"],
  },
  {
    title: "2 · One stable front door",
    text: "Route 53 maps n5453313-fractal.cab432.com to the Application Load Balancer, which terminates TLS and dispatches each request to a healthy API task.",
    why: "Tasks come and go; the name and the load balancer do not (dispatcher-push).",
    highlight: ["r53", "alb"],
  },
  {
    title: "3 · Stateless API, memory first",
    text: "Each API task canonicalises the request (redirecting or rejecting anything else), then checks its in-memory LRU. A hit returns in well under a millisecond.",
    why: "Stateless tasks can be added or replaced freely; memory is the fastest cache layer.",
    highlight: ["alb", "api:*"],
  },
  {
    title: "4 · S3: the shared, durable cache",
    text: "On a memory miss the API reads S3. Anything rendered once by anyone is here forever and is copied into memory on the way out.",
    why: "Render once, serve everyone — the property that makes the farm cheap at scale.",
    highlight: ["api:*", "s3"],
  },
  {
    title: "5 · A true miss becomes a job",
    text: "If S3 has nothing, the API sends a job to SQS, waits up to 2 s, then answers 202 so the browser polls. Concurrent misses for the same tile join one job.",
    why: "Asynchronous hand-off keeps the request tier responsive whatever the render cost.",
    highlight: ["api:*", "sqs"],
  },
  {
    title: "6 · Workers pull, render, store, acknowledge",
    text: "Each Fargate worker takes one job when free, checks S3 first (duplicates are harmless), renders on a CPU thread, writes the tile, then deletes the message.",
    why: "Worker-pull spreads load automatically; deleting last means crashes cause retries, never lost tiles.",
    highlight: ["sqs", "wk:*", "s3"],
  },
  {
    title: "7 · Failure has somewhere to go",
    text: "A job a worker fails on reappears after its 60 s visibility timeout. After three attempts it moves to the dead-letter queue instead of looping.",
    why: "Fault isolation: one bad tile cannot stall the farm.",
    highlight: ["sqs", "dlq"],
  },
  {
    title: "8 · The scaler closes the loop",
    text: "Every 10 s the scaler reads the queue backlog and sets the worker count with ecs:UpdateService: out immediately, in after a 60 s cool-down, to zero when idle. ECS places the tasks; each pulls its image from ECR.",
    why: "Target tracking on backlog per worker holds the expected wait steady as demand changes.",
    highlight: ["scaler", "ecs", "ecr", "wk:*"],
  },
  {
    title: "9 · Everything is observable",
    text: "Containers log to CloudWatch; the scaler publishes metrics as structured log lines. This view is driven by the API's own trace stream of every AWS call it makes.",
    why: "Separate components need separate evidence — and evidence is what the demo shows.",
    highlight: ["cw", "scaler"],
  },
];
