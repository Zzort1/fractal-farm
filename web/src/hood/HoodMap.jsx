/**
 * "Under the hood": the system's architecture, drawn live.
 *
 * Every moving thing on this canvas is caused by a real trace event — a
 * request reaching the ALB, an s3:GetObject, a job dropping into SQS, a tile
 * header naming the Fargate task that rendered it, an ecs:UpdateService from
 * the scaler. Task boxes are the actual ECS tasks, created, moved and retired
 * as the fleet reader reports their lifecycle. Nothing loops for decoration.
 *
 * Coordinates are CSS pixels; the context is scaled by devicePixelRatio.
 */
import { useEffect, useRef } from "react";
import { workerColour } from "@fractal-farm/core";

const C = {
  bg: "#06031a",
  grid: "rgba(155, 93, 229, 0.06)",
  text: "#f4f1ff",
  muted: "#a99fd6",
  sky: "#4cc9f0",
  cyan: "#00f5d4",
  lime: "#9ef01a",
  gold: "#ffd60a",
  magenta: "#ff2bd6",
  violet: "#9b5de5",
  orange: "#ff7b00",
  red: "#ff4d6d",
  white: "#ffffff",
  grey: "#6c6694",
};

const SOURCE = { memory: C.cyan, store: C.lime, render: C.magenta };
const MONO = 'ui-monospace, "Cascadia Code", Consolas, monospace';
const MAX_PARTICLES = 700;

/** Static components and where they sit, as fractions of the canvas. */
const STATIC = {
  browser: { fx: 0.075, fy: 0.45, w: 168, h: 66, colour: C.sky },
  r53: { fx: 0.245, fy: 0.1, w: 190, h: 58, colour: C.violet },
  alb: { fx: 0.245, fy: 0.45, w: 190, h: 84, colour: C.sky },
  scaler: { fx: 0.45, fy: 0.86, w: 210, h: 66, colour: C.violet },
  cw: { fx: 0.655, fy: 0.075, w: 178, h: 56, colour: C.grey },
  s3: { fx: 0.655, fy: 0.27, w: 196, h: 76, colour: C.lime },
  sqs: { fx: 0.655, fy: 0.56, w: 196, h: 104, colour: C.gold },
  dlq: { fx: 0.655, fy: 0.84, w: 170, h: 54, colour: C.red },
  ecs: { fx: 0.815, fy: 0.075, w: 176, h: 56, colour: C.violet },
  ecr: { fx: 0.935, fy: 0.075, w: 120, h: 56, colour: C.grey },
};

const short = (id) => String(id ?? "").replace(/^task-/, "");

/**
 * @param {{bus: Object, fleet: Object|null, stats: Object|null, held: number, speed: number, showControl: boolean}} props - Data and options
 * @returns {JSX.Element} Canvas
 */
export default function HoodMap(props) {
  const canvasRef = useRef(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const state = {
      W: 0,
      H: 0,
      dyn: new Map(), // "api:<id>" | "wk:<id>" → task node
      particles: [],
      pulses: [],
      banners: [],
      edgeHeat: new Map(), // edge key → last activity time
      nodeHeat: new Map(),
      gone: new Set(), // task nodes already faded out; ECS lists stopped tasks for a while
    };
    const now = () => performance.now();
    const dur = (ms) => ms / (propsRef.current.speed || 1);

    // ---------- geometry ----------

    const staticBox = (id) => {
      const s = STATIC[id];
      return { x: s.fx * state.W, y: s.fy * state.H, w: s.w, h: s.h };
    };

    const box = (id) => {
      if (STATIC[id]) return staticBox(id);
      const node = state.dyn.get(id);
      return node ? { x: node.x, y: node.y, w: node.w, h: node.h } : null;
    };

    const apiId = (inst) => {
      const key = `api:${short(inst)}`;
      if (state.dyn.has(key)) return key;
      const first = [...state.dyn.keys()].find((k) => k.startsWith("api:"));
      return first ?? ensureNode("api", short(inst) || "api").key;
    };

    const workerId = (id) => {
      const key = `wk:${short(id)}`;
      if (!state.dyn.has(key)) ensureNode("worker", short(id), { lastStatus: "RUNNING", ephemeral: true });
      return key;
    };

    function ensureNode(kind, id, task = {}) {
      const key = `${kind === "api" ? "api" : kind === "worker" ? "wk" : "sc"}:${id}`;
      let node = state.dyn.get(key);
      if (!node) {
        node = {
          key,
          kind,
          id,
          born: now(),
          x: kind === "worker" ? state.W * 0.87 : state.W * 0.45,
          y: state.H * 0.5,
          w: kind === "worker" ? 168 : 196,
          h: kind === "worker" ? 58 : 76,
          renders: 0,
          lastMs: null,
          busyUntil: 0,
          ...task,
        };
        state.dyn.set(key, node);
      }
      return node;
    }

    // ---------- fleet → task nodes ----------

    function syncFleet() {
      const fleet = propsRef.current.fleet;
      const tasks = fleet?.tasks ?? [];
      const seen = new Set();
      for (const task of tasks) {
        if (task.service !== "api" && task.service !== "workers") continue;
        const kind = task.service === "api" ? "api" : "worker";
        if (state.gone.has(`${kind === "api" ? "api" : "wk"}:${task.id}`)) continue;
        const node = ensureNode(kind, task.id, {});
        Object.assign(node, {
          lastStatus: task.lastStatus,
          az: task.az,
          ip: task.ip,
          cpu: task.cpu,
          memory: task.memory,
          revision: task.revision,
          ephemeral: false,
        });
        if (task.lastStatus === "STOPPED" && !node.diedAt) node.diedAt = now();
        seen.add(node.key);
      }
      // Tasks the fleet no longer lists have gone; let them fade out.
      for (const node of state.dyn.values()) {
        if (!seen.has(node.key) && !node.ephemeral && !node.diedAt && fleet) {
          node.lastStatus = "STOPPED";
          node.diedAt = now();
        }
        if (node.diedAt && now() - node.diedAt > 4000) {
          state.dyn.delete(node.key);
          state.gone.add(node.key);
        }
        if (node.ephemeral && now() - (node.lastActive ?? node.born) > 60_000) state.dyn.delete(node.key);
      }
    }

    function placeDynamic() {
      const apis = [...state.dyn.values()].filter((n) => n.kind === "api").sort((a, b) => a.born - b.born);
      const workers = [...state.dyn.values()].filter((n) => n.kind === "worker").sort((a, b) => a.born - b.born);
      const apiGap = Math.min(96, (state.H * 0.5) / Math.max(1, apis.length));
      apis.forEach((n, i) => {
        n.tx = state.W * 0.45;
        n.ty = state.H * 0.45 + (i - (apis.length - 1) / 2) * apiGap;
      });
      const cols = 2;
      const rows = Math.max(1, Math.ceil(workers.length / cols));
      const rowGap = Math.min(70, (state.H * 0.62) / rows);
      workers.forEach((n, i) => {
        n.tx = state.W * (i % cols === 0 ? 0.805 : 0.928);
        n.ty = state.H * 0.3 + Math.floor(i / cols) * rowGap;
        n.w = Math.min(168, Math.max(124, state.W * 0.112));
      });
      for (const n of [...apis, ...workers]) {
        if (n.tx === undefined) continue;
        n.x += (n.tx - n.x) * 0.12;
        n.y += (n.ty - n.y) * 0.12;
      }
    }

    // ---------- effects ----------

    function particle(path, colour, options = {}) {
      if (state.particles.length > MAX_PARTICLES) state.particles.splice(0, state.particles.length - MAX_PARTICLES);
      state.particles.push({
        path,
        colour,
        start: now() + dur(options.delay ?? 0),
        dur: dur(options.dur ?? 650),
        size: options.size ?? 3,
        hollow: options.hollow ?? false,
        label: options.label ?? null,
      });
      for (let i = 0; i < path.length - 1; i += 1) {
        state.edgeHeat.set(edgeKey(path[i], path[i + 1]), { t: now() + dur(options.delay ?? 0), colour });
      }
    }

    function pulse(node, colour, text = null, options = {}) {
      state.pulses.push({ node, colour, text, start: now() + dur(options.delay ?? 0), dur: dur(options.dur ?? 900) });
      state.nodeHeat.set(node, { t: now(), colour });
    }

    function banner(text, sub, colour) {
      state.banners.push({ text, sub, colour, start: now(), dur: 4200 });
      if (state.banners.length > 3) state.banners.shift();
    }

    const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

    // ---------- events → effects ----------

    function onEvent(e) {
      const showControl = propsRef.current.showControl;
      switch (e.type) {
        case "request":
          particle(["browser", "alb", apiId(e.inst)], C.white, { size: 2.6, dur: 520 });
          break;

        case "cache":
          if (e.hit) pulse(apiId(e.inst), C.cyan, "LRU hit", { delay: 480, dur: 700 });
          break;

        case "coalesced":
          pulse(apiId(e.inst), C.gold, "+1 coalesced");
          break;

        case "call": {
          if (e.control && !showControl) break;
          const isWorker = e.actor === "worker";
          const from = isWorker ? workerId(e.worker) : apiId(e.inst);
          if (e.svc === "s3") {
            const put = /Put|write/.test(e.op);
            const get = /GetObject|readFile/.test(e.op);
            const colour = put ? C.magenta : e.status === 200 ? C.lime : e.status === 404 ? C.orange : C.red;
            particle([from, "s3"], colour, { size: put ? 4.5 : 2.4, dur: 450, label: put ? "PutObject" : null });
            if (get && e.status === 200) particle(["s3", from], C.lime, { size: 3.6, dur: 450, delay: 420 });
            if (e.actor === "poll") pulse("s3", C.gold, null, { dur: 400 });
          } else if (e.svc === "sqs") {
            if (/receive/.test(e.op)) {
              particle(["sqs", from], C.gold, { size: 3.6, dur: 500 });
            } else if (/delete/.test(e.op)) {
              particle([from, "sqs"], C.grey, { size: 2, dur: 450 });
            } else if (e.control) {
              particle([from, "sqs"], C.grey, { size: 1.6, dur: 450 });
            } else {
              particle([from, "sqs"], C.gold, { size: 4, dur: 520, label: "SendMessage" });
              pulse("sqs", C.gold, null, { delay: 500, dur: 500 });
            }
          }
          break;
        }

        case "render": {
          const wk = workerId(e.workerId);
          const node = state.dyn.get(wk);
          if (node) {
            node.renders += 1;
            node.lastMs = e.renderMs;
            node.lastActive = now();
          }
          if (e.via === "tile-header") {
            // Workers are other containers: their side is replayed from the
            // tile header the moment the API sees the finished tile.
            particle(["sqs", wk], C.gold, { size: 3.6, dur: 450 });
            pulse(wk, C.magenta, `${e.renderMs}ms`, { delay: 420, dur: 900 });
            particle([wk, "s3"], C.magenta, { size: 4.6, dur: 450, delay: 700 });
          } else {
            pulse(wk, C.magenta, `${e.renderMs}ms`, { dur: 900 });
          }
          if (node) node.busyUntil = now() + 700;
          break;
        }

        case "worker": {
          const node = state.dyn.get(workerId(e.workerId));
          if (node && e.state === "busy") node.busyUntil = now() + 1500;
          if (e.state === "failed") pulse(workerId(e.workerId), C.red, "failed");
          break;
        }

        case "response": {
          const colour = e.status === 200 ? (SOURCE[e.source] ?? C.white) : e.status === 202 ? C.gold : e.status >= 400 ? C.red : C.grey;
          const size = e.bytes ? Math.min(6, 2 + e.bytes / 40000) : 2.4;
          particle([apiId(e.inst), "alb", "browser"], colour, { size, dur: 560, hollow: e.status === 202 });
          if (e.status >= 400) pulse(apiId(e.inst), C.red, String(e.status));
          break;
        }

        case "task": {
          if (e.service !== "workers" && e.service !== "api") break;
          const key = e.service === "api" ? `api:${e.taskId}` : `wk:${e.taskId}`;
          const node = ensureNode(e.service === "api" ? "api" : "worker", e.taskId, {});
          node.lastStatus = e.to;
          if (e.to === "PROVISIONING") particle(["ecs", key], C.violet, { size: 3.4, dur: 700, label: "RunTask" });
          if (e.to === "PENDING") particle(["ecr", key], C.violet, { size: 4, dur: 900, label: "image pull" });
          if (e.to === "RUNNING") pulse(key, C.lime, "RUNNING", { dur: 1400 });
          if (e.to === "STOPPED") {
            pulse(key, C.orange, "STOPPED", { dur: 1400 });
            node.diedAt = node.diedAt ?? now();
          }
          break;
        }

        case "scale":
          particle(["scaler", "ecs"], C.violet, { size: 5.5, dur: 800, label: "UpdateService" });
          pulse("ecs", C.violet, `desired ${e.from}→${e.to}`, { delay: 780, dur: 1800 });
          banner(`ecs:UpdateService  desired ${e.from} → ${e.to}`, e.reason, e.to > e.from ? C.lime : C.orange);
          break;

        case "scaler":
          particle(["scaler", "sqs"], C.grey, { size: 2, dur: 600, label: showControl ? "GetQueueAttributes" : null });
          particle(["scaler", "cw"], C.grey, { size: 2, dur: 900, delay: 200 });
          particle(["scaler", "s3"], C.grey, { size: 2, dur: 800, delay: 300 });
          break;

        case "job-timeout":
          pulse(apiId(e.inst), C.red, "job timeout");
          break;

        default:
          break;
      }
    }

    const unsubscribe = propsRef.current.bus.subscribe((events) => {
      // Spread a batch across its 100 ms window instead of firing it at once.
      events.forEach((e, i) => {
        const stagger = events.length > 1 ? (i / events.length) * 100 : 0;
        if (stagger) setTimeout(() => onEvent(e), stagger);
        else onEvent(e);
      });
    });

    // ---------- drawing ----------

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function drawZone(x0, y0, x1, y1, label, colour) {
      ctx.save();
      roundRect(x0, y0, x1 - x0, y1 - y0, 14);
      ctx.fillStyle = "rgba(76, 201, 240, 0.035)";
      ctx.fill();
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = colour;
      ctx.font = `600 10.5px ${MONO}`;
      ctx.fillText(label, x0 + 12, y0 + 16);
      ctx.restore();
    }

    function drawNode(b, colour, title, lines, options = {}) {
      const t = now();
      const x = b.x - b.w / 2;
      const y = b.y - b.h / 2;
      const heat = state.nodeHeat.get(options.key);
      const hot = heat ? Math.max(0, 1 - (t - heat.t) / 900) : 0;
      const alpha = options.alpha ?? 1;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = colour;
      ctx.shadowBlur = 10 + hot * 22 + (options.glow ?? 0);
      roundRect(x, y, b.w, b.h, 9);
      const fill = ctx.createLinearGradient(x, y, x, y + b.h);
      fill.addColorStop(0, "rgba(28, 16, 70, 0.95)");
      fill.addColorStop(1, "rgba(12, 6, 36, 0.95)");
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.shadowBlur = 0;
      if (options.dashed) ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.4 + hot * 1.4;
      ctx.strokeStyle = colour;
      ctx.stroke();
      ctx.setLineDash([]);

      // Accent bar
      ctx.fillStyle = colour;
      ctx.fillRect(x + 1, y + 8, 3, b.h - 16);

      ctx.fillStyle = C.text;
      ctx.font = `700 12px ${MONO}`;
      ctx.fillText(fit(title, b.w - 20), x + 12, y + 18);
      ctx.font = `10.5px ${MONO}`;
      lines.forEach((line, i) => {
        if (!line) return;
        const [text, lineColour] = Array.isArray(line) ? line : [line, C.muted];
        ctx.fillStyle = lineColour;
        ctx.fillText(fit(text, b.w - 20), x + 12, y + 34 + i * 14);
      });
      ctx.restore();
    }

    function fit(text, width) {
      let s = String(text);
      if (ctx.measureText(s).width <= width) return s;
      while (s.length > 3 && ctx.measureText(`${s}…`).width > width) s = s.slice(0, -1);
      return `${s}…`;
    }

    function drawQueueStack(b, visible, inflight) {
      const cols = 15;
      const size = 9;
      const gap = 2.5;
      const x0 = b.x - b.w / 2 + 12;
      const y0 = b.y + b.h / 2 - 14;
      const total = Math.min(visible + inflight, cols * 2);
      for (let i = 0; i < total; i += 1) {
        const cx = x0 + (i % cols) * (size + gap);
        const cy = y0 - Math.floor(i / cols) * (size + gap);
        ctx.fillStyle = i < inflight ? "rgba(255, 214, 10, 0.25)" : C.gold;
        ctx.strokeStyle = C.gold;
        ctx.lineWidth = 1;
        ctx.fillRect(cx, cy, size, size);
        ctx.strokeRect(cx + 0.5, cy + 0.5, size - 1, size - 1);
      }
      if (visible + inflight > cols * 2) {
        ctx.fillStyle = C.gold;
        ctx.font = `700 10px ${MONO}`;
        ctx.fillText(`+${visible + inflight - cols * 2}`, x0 + cols * (size + gap) + 2, y0 + 8);
      }
    }

    function centre(id) {
      const b = box(id);
      return b ? { x: b.x, y: b.y } : null;
    }

    function drawEdge(a, b, base = "rgba(169, 159, 214, 0.18)") {
      const p = centre(a);
      const q = centre(b);
      if (!p || !q) return;
      const heat = state.edgeHeat.get(edgeKey(a, b));
      const t = now();
      const hot = heat ? Math.max(0, 1 - (t - heat.t) / 1200) : 0;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      const mx = (p.x + q.x) / 2;
      ctx.bezierCurveTo(mx, p.y, mx, q.y, q.x, q.y);
      ctx.strokeStyle = base;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (hot > 0) {
        ctx.globalAlpha = hot * 0.9;
        ctx.strokeStyle = heat.colour;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([4, 6]);
        ctx.lineDashOffset = -t / 30;
        ctx.stroke();
      }
      ctx.restore();
    }

    function pointOnPath(path, f) {
      const pts = path.map(centre);
      if (pts.some((p) => !p)) return null;
      const segments = pts.length - 1;
      const s = Math.min(segments - 1, Math.floor(f * segments));
      const local = f * segments - s;
      const p = pts[s];
      const q = pts[s + 1];
      // Follow the same curve the edges are drawn with.
      const mx = (p.x + q.x) / 2;
      const u = local;
      const bx = (1 - u) ** 3 * p.x + 3 * (1 - u) ** 2 * u * mx + 3 * (1 - u) * u ** 2 * mx + u ** 3 * q.x;
      const by = (1 - u) ** 3 * p.y + 3 * (1 - u) ** 2 * u * p.y + 3 * (1 - u) * u ** 2 * q.y + u ** 3 * q.y;
      return { x: bx, y: by };
    }

    function drawParticles(t) {
      const alive = [];
      const calm = state.particles.length < 24;
      for (const p of state.particles) {
        if (t < p.start) {
          alive.push(p);
          continue;
        }
        const f = (t - p.start) / p.dur;
        if (f >= 1) continue;
        alive.push(p);
        const eased = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
        const pos = pointOnPath(p.path, eased);
        if (!pos) continue;
        // Trail
        for (let k = 1; k <= 4; k += 1) {
          const back = pointOnPath(p.path, Math.max(0, eased - k * 0.025));
          if (!back) break;
          ctx.globalAlpha = 0.18 * (1 - k / 5);
          ctx.fillStyle = p.colour;
          ctx.beginPath();
          ctx.arc(back.x, back.y, p.size * (1 - k * 0.15), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.shadowColor = p.colour;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, p.size, 0, Math.PI * 2);
        if (p.hollow) {
          ctx.strokeStyle = p.colour;
          ctx.lineWidth = 1.6;
          ctx.stroke();
        } else {
          ctx.fillStyle = p.colour;
          ctx.fill();
        }
        ctx.shadowBlur = 0;
        if (p.label && calm && f > 0.15 && f < 0.85) {
          ctx.font = `600 9.5px ${MONO}`;
          ctx.fillStyle = p.colour;
          ctx.fillText(p.label, pos.x + 7, pos.y - 6);
        }
      }
      state.particles = alive;
    }

    function drawPulses(t) {
      state.pulses = state.pulses.filter((p) => t < p.start + p.dur);
      for (const p of state.pulses) {
        if (t < p.start) continue;
        const b = box(p.node);
        if (!b) continue;
        const f = (t - p.start) / p.dur;
        ctx.save();
        ctx.globalAlpha = 1 - f;
        ctx.strokeStyle = p.colour;
        ctx.lineWidth = 2;
        roundRect(b.x - b.w / 2 - f * 10, b.y - b.h / 2 - f * 10, b.w + f * 20, b.h + f * 20, 12);
        ctx.stroke();
        if (p.text) {
          ctx.font = `700 11px ${MONO}`;
          ctx.fillStyle = p.colour;
          ctx.fillText(p.text, b.x + b.w / 2 - ctx.measureText(p.text).width - 6, b.y - b.h / 2 - 6 - f * 14);
        }
        ctx.restore();
      }
    }

    function drawBanners(t) {
      state.banners = state.banners.filter((b) => t < b.start + b.dur);
      state.banners.forEach((b, i) => {
        const f = (t - b.start) / b.dur;
        const alpha = f < 0.1 ? f / 0.1 : f > 0.8 ? (1 - f) / 0.2 : 1;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = `700 15px ${MONO}`;
        const w = Math.max(ctx.measureText(b.text).width, 200) + 36;
        const x = state.W / 2 - w / 2;
        const y = 16 + i * 52;
        roundRect(x, y, w, 44, 10);
        ctx.fillStyle = "rgba(6, 3, 26, 0.88)";
        ctx.fill();
        ctx.strokeStyle = b.colour;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = b.colour;
        ctx.fillText(b.text, x + 18, y + 19);
        ctx.font = `11px ${MONO}`;
        ctx.fillStyle = C.muted;
        ctx.fillText(fit(b.sub ?? "", w - 36), x + 18, y + 35);
        ctx.restore();
      });
    }

    function drawLegend() {
      const items = [
        ["request", C.white],
        ["memory hit", C.cyan],
        ["S3", C.lime],
        ["SQS job", C.gold],
        ["render / PutObject", C.magenta],
        ["202 rendering", C.gold, true],
        ["ECS / scaling", C.violet],
        ["error / 404", C.orange],
      ];
      ctx.save();
      ctx.font = `10px ${MONO}`;
      let x = state.W * 0.3;
      const y = state.H - 14;
      for (const [label, colour, hollow] of items) {
        ctx.beginPath();
        ctx.arc(x, y - 3, 4, 0, Math.PI * 2);
        if (hollow) {
          ctx.strokeStyle = colour;
          ctx.stroke();
        } else {
          ctx.fillStyle = colour;
          ctx.fill();
        }
        ctx.fillStyle = C.muted;
        ctx.fillText(label, x + 8, y);
        x += ctx.measureText(label).width + 26;
      }
      ctx.restore();
    }

    function statusColour(status) {
      switch (status) {
        case "RUNNING":
          return C.magenta;
        case "PROVISIONING":
        case "PENDING":
        case "ACTIVATING":
          return C.violet;
        case "DEACTIVATING":
        case "STOPPING":
        case "DEPROVISIONING":
          return C.orange;
        case "STOPPED":
          return C.grey;
        default:
          return C.magenta;
      }
    }

    function frame() {
      const p = propsRef.current;
      const t = now();
      const { stats, fleet } = p;
      const m = p.bus.metrics(10);

      syncFleet();
      placeDynamic();

      ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, state.W, state.H);
      // Faint grid
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      for (let x = 0; x < state.W; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, state.H);
        ctx.stroke();
      }
      for (let y = 0; y < state.H; y += 32) {
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(state.W, y + 0.5);
        ctx.stroke();
      }

      const local = p.platform === "local";
      drawZone(state.W * 0.16, state.H * 0.24, state.W * 0.555, state.H * 0.955, local ? "this computer · API process" : "VPC vpc-007bab53… · public subnets 2a/2b/2c · SG default", C.sky);
      drawZone(state.W * 0.735, state.H * 0.2, state.W * 0.995, state.H * 0.955, local ? "worker threads" : "VPC · ECS cluster n5453313-a2-cluster · Fargate", C.magenta);
      ctx.save();
      ctx.font = `600 10.5px ${MONO}`;
      ctx.fillStyle = C.lime;
      ctx.globalAlpha = 0.7;
      ctx.fillText(local ? "local stand-ins" : "regional services · public endpoints", state.W * 0.655 - 92, state.H * 0.16);
      ctx.restore();

      const apis = [...state.dyn.values()].filter((n) => n.kind === "api");
      const workers = [...state.dyn.values()].filter((n) => n.kind === "worker");

      // Edges
      drawEdge("browser", "alb");
      drawEdge("r53", "browser", "rgba(155, 93, 229, 0.18)");
      for (const a of apis) {
        drawEdge("alb", a.key);
        drawEdge(a.key, "s3");
        drawEdge(a.key, "sqs");
      }
      for (const w of workers) {
        drawEdge("sqs", w.key);
        drawEdge(w.key, "s3");
      }
      drawEdge("sqs", "dlq", "rgba(255, 77, 109, 0.18)");
      drawEdge("scaler", "sqs");
      drawEdge("scaler", "ecs");
      drawEdge("scaler", "cw");
      drawEdge("scaler", "s3");

      // Static nodes
      const depth = stats?.queue ?? { visible: 0, inflight: 0, deadLetters: 0 };
      const scaler = fleet?.scaler;
      const fmt = (v, d = 1) => (v === null || v === undefined ? "–" : Number(v).toFixed(d));

      drawNode(staticBox("browser"), C.sky, "Browser", [
        `${p.held} tiles held · HTTP cache`,
        `${fmt(m.requestsPerS)} req/s · ${fmt(m.bytesOutPerS / 1024, 0)} KB/s in`,
        [`hits ${m.hitShare === null ? "–" : Math.round(m.hitShare * 100)}% of served`, C.cyan],
      ], { key: "browser" });
      drawNode(staticBox("r53"), C.violet, "Route 53", [
        local ? "localhost (no DNS)" : "n5453313-fractal.cab432.com",
        ["A alias → ALB · cached by browser", C.muted],
      ], { key: "r53" });
      drawNode(staticBox("alb"), C.sky, local ? "Vite proxy :5173" : "ALB n5453313-a3-alb", [
        local ? "→ API :8787" : ":443 TLS 1.3 · :80 → 301",
        `targets ${apis.length} · /healthz 10 s`,
        [`${fmt(m.requestsPerS)} req/s · p50 ${fmt(m.p50, 0)} ms · p95 ${fmt(m.p95, 0)} ms`, C.text],
      ], { key: "alb" });
      drawNode(staticBox("s3"), C.lime, local ? "fs .data/tiles" : "S3 n5453313-fractal-tiles", [
        `GET ${fmt(m.s3GetPerS)}/s · HEAD ${fmt(m.s3HeadPerS)}/s`,
        [`PUT ${fmt(m.s3PutPerS)}/s · gzip · immutable`, C.magenta],
        local ? "stand-in for S3" : "private · public access blocked",
      ], { key: "s3" });
      drawNode(staticBox("sqs"), C.gold, local ? "in-memory queue" : "SQS a3-render-queue", [
        [`visible ${depth.visible} · in flight ${depth.inflight}`, C.text],
        local ? "worker-pull" : "visibility 60 s · long poll 20 s",
      ], { key: "sqs" });
      drawQueueStack(staticBox("sqs"), depth.visible, depth.inflight);
      drawNode(staticBox("dlq"), C.red, local ? "dead letters" : "SQS a3-render-dlq", [
        [`${depth.deadLetters} messages`, depth.deadLetters ? C.red : C.muted],
        "after 3 receives",
      ], { key: "dlq" });
      drawNode(staticBox("ecs"), C.violet, "ECS control plane", [
        local ? "local pool" : "cluster n5453313-a2-cluster",
        [`workers ${fleet?.workers?.running ?? "–"}/${fleet?.workers?.desired ?? "–"} running/desired`, C.text],
      ], { key: "ecs" });
      drawNode(staticBox("ecr"), C.grey, "ECR", ["3 images", "api·worker·scaler"], { key: "ecr" });
      drawNode(staticBox("cw"), C.grey, "CloudWatch", ["Logs + EMF metrics", "n5453313/FractalFarm"], { key: "cw" });
      drawNode(staticBox("scaler"), C.violet, local ? "scaler (cloud only)" : "fractal-scaler", [
        [scaler?.reason ?? (local ? "manual: + / − in control room" : "waiting for status"), C.text],
        scaler ? `target ${scaler.policy.targetPerWorker}/worker · ${scaler.policy.min}–${scaler.policy.max} · tick 10 s` : "",
        scaler ? `wants ${scaler.wanted} · desired ${scaler.service?.desired}` : "",
      ], { key: "scaler" });

      // Task nodes
      for (const a of apis) {
        const cache = stats?.cache;
        const mine = short(a.id) === short(p.bus.instance);
        drawNode(a, C.cyan, `api ${a.id}`, [
          [a.lastStatus ?? "RUNNING", statusColour(a.lastStatus) === C.magenta ? C.lime : statusColour(a.lastStatus)],
          `${a.az ?? "?"} · ${a.ip ?? "?"}`,
          a.cpu ? `${a.cpu / 1024} vCPU · ${a.memory / 1024} GB · rev ${a.revision ?? "?"}` : "",
          mine && cache ? [`LRU ${cache.entries} tiles · ${(cache.bytes / 1048576).toFixed(1)} MB`, C.cyan] : ["(not the instance streaming)", C.muted],
        ].filter(Boolean), { key: a.key, alpha: a.diedAt ? Math.max(0, 1 - (t - a.diedAt) / 4000) : 1 });
      }
      for (const w of workers) {
        const colour = statusColour(w.lastStatus);
        const busy = t < w.busyUntil;
        const tint = local ? workerColour(w.id) : workerColour(`task-${w.id}`);
        const starting = ["PROVISIONING", "PENDING", "ACTIVATING"].includes(w.lastStatus);
        const age = t - w.born;
        const scale = Math.min(1, age / 500);
        const b = { x: w.x, y: w.y, w: w.w * (0.6 + 0.4 * scale), h: w.h * (0.6 + 0.4 * scale) };
        drawNode(b, busy ? C.magenta : colour, w.id, [
          [w.lastStatus === "RUNNING" ? (busy ? "RENDERING" : "RUNNING · idle") : w.lastStatus ?? "RUNNING", busy ? C.magenta : colour],
          w.renders ? `${w.renders} tiles · last ${w.lastMs} ms` : `${w.az ?? ""} ${w.ip ?? ""}`.trim(),
        ], {
          key: w.key,
          dashed: starting,
          glow: busy ? 16 : 0,
          alpha: w.diedAt ? Math.max(0, 1 - (t - w.diedAt) / 4000) : scale,
        });
        // Worker identity dot — same colour as the explorer's tile tint.
        ctx.beginPath();
        ctx.arc(b.x + b.w / 2 - 12, b.y - b.h / 2 + 12, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = tint;
        ctx.fill();
      }
      if (!workers.length) {
        ctx.save();
        ctx.font = `600 12px ${MONO}`;
        ctx.fillStyle = C.muted;
        ctx.fillText("scaled to zero — the next miss wakes a worker", state.W * 0.745, state.H * 0.3);
        ctx.restore();
      }

      drawParticles(t);
      drawPulses(t);
      drawBanners(t);
      drawLegend();
    }

    let raf = 0;
    const loop = () => {
      frame();
      raf = requestAnimationFrame(loop);
    };

    const resize = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      state.W = canvas.clientWidth;
      state.H = canvas.clientHeight;
      canvas.width = Math.round(state.W * dpr);
      canvas.height = Math.round(state.H * dpr);
    });
    resize.observe(canvas);
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      unsubscribe();
    };
  }, []);

  return <canvas ref={canvasRef} className="hood-canvas" />;
}
