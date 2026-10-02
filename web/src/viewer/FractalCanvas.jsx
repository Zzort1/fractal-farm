/**
 * The fractal viewer: a hand-written tile map on a <canvas>.
 *
 * ## Coordinates
 *
 * The view is a point in the complex plane (cx, cy) and a continuous zoom.
 * At zoom z the fractal's home square is 256·2^z device pixels wide, so one
 * device pixel covers  ps = span / (256·2^z)  of the plane. Tiles are fetched
 * at the integer level L nearest to z and stretched by 2^(z−L), which is what
 * makes zooming continuous while tiles stay discrete (and cacheable).
 *
 * ## What the overlays show
 *
 *  - worker colours: each tile tinted by the worker that rendered it, so
 *    scaling out is literally visible as more colours appearing;
 *  - source flashes: a tile's border flashes by where it came from —
 *    sky-blue browser cache, cyan server memory, lime store, magenta fresh
 *    render, gold CDN edge;
 *  - a dashed, marching border on tiles the farm is still rendering.
 */
import { useEffect, useRef } from "react";
import { TILE_SIZE, getFractal, tileUrl, workerColour } from "@fractal-farm/core";
import { colouriseTile } from "./colourise.js";
import { getPalette, paletteLut } from "./palettes.js";
import { TileLoader } from "./tileLoader.js";

export const SOURCE_COLOURS = {
  browser: "#4cc9f0",
  memory: "#00f5d4",
  store: "#9ef01a",
  render: "#ff2bd6",
  edge: "#ffd60a",
};

const FLASH_MS = 1400;
const ANCESTOR_DEPTH = 8;
const ZOOM_ANIMATION_MS = 280;

/**
 * The view that fits a fractal's home square into the canvas.
 * @param {Object} fractal - Fractal definition
 * @param {number} width - Canvas width, device px
 * @param {number} height - Canvas height, device px
 * @returns {{cx: number, cy: number, zoom: number}} View
 */
function homeView(fractal, width, height) {
  return {
    cx: fractal.home.re,
    cy: fractal.home.im,
    zoom: Math.log2((Math.min(width, height) * 0.92) / TILE_SIZE),
  };
}

/**
 * @param {Object} props - { fractalId, query, params, colour, overlays, resetToken, onViewChange, onPick }
 * @returns {JSX.Element} Viewer
 */
export default function FractalCanvas(props) {
  const canvasRef = useRef(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const engineRef = useRef(null);

  // One engine for the life of the component; props flow in through propsRef.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const state = {
      view: null,
      dirty: true,
      drag: null,
      anim: null,
      cursor: null,
      lastReport: "",
      needsHome: true,
    };
    const loader = new TileLoader({ onChange: () => (state.dirty = true) });
    engineRef.current = { state, loader };

    const dpr = () => window.devicePixelRatio || 1;
    const fractal = () => getFractal(propsRef.current.fractalId);
    const pixelSize = (zoom) => fractal().home.span / (TILE_SIZE * 2 ** zoom);

    const clampView = () => {
      const f = fractal();
      const { view } = state;
      const min = Math.log2(Math.min(canvas.width, canvas.height) / TILE_SIZE) - 1.5;
      view.zoom = Math.min(Math.max(view.zoom, min), f.maxZoom + 1.5);
      const half = f.home.span / 2;
      view.cx = Math.min(Math.max(view.cx, f.home.re - half), f.home.re + half);
      view.cy = Math.min(Math.max(view.cy, f.home.im - half), f.home.im + half);
    };

    /** Zoom to `zoom`, keeping the plane point under screen pixel (sx, sy) fixed. */
    const zoomAt = (zoom, sx, sy) => {
      const { view } = state;
      const before = pixelSize(view.zoom);
      const fx = view.cx + (sx - canvas.width / 2) * before;
      const fy = view.cy - (sy - canvas.height / 2) * before;
      view.zoom = zoom;
      clampView();
      const after = pixelSize(view.zoom);
      view.cx = fx - (sx - canvas.width / 2) * after;
      view.cy = fy + (sy - canvas.height / 2) * after;
      clampView();
      state.dirty = true;
    };

    const toPlane = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const sx = (clientX - rect.left) * dpr();
      const sy = (clientY - rect.top) * dpr();
      const ps = pixelSize(state.view.zoom);
      return {
        sx,
        sy,
        re: state.view.cx + (sx - canvas.width / 2) * ps,
        im: state.view.cy - (sy - canvas.height / 2) * ps,
      };
    };

    /** Colourise a tile on demand, reusing the result until colours change. */
    const tileCanvas = (entry, stamp, colourOptions) => {
      if (!entry.canvas) {
        entry.canvas = new OffscreenCanvas(entry.tile.width, entry.tile.height);
        entry.image = new ImageData(entry.tile.width, entry.tile.height);
      }
      if (entry.stamp !== stamp) {
        colouriseTile(entry.tile, colourOptions, entry.image.data);
        entry.canvas.getContext("2d").putImageData(entry.image, 0, 0);
        entry.stamp = stamp;
      }
      return entry.canvas;
    };

    const draw = (now) => {
      const p = propsRef.current;
      const f = fractal();
      const W = canvas.width;
      const H = canvas.height;
      if (!W || !H || !f) return;

      if (state.needsHome) {
        state.view = homeView(f, W, H);
        state.needsHome = false;
        state.dirty = true;
      }

      if (state.anim) {
        const t = Math.min(1, (now - state.anim.start) / ZOOM_ANIMATION_MS);
        const eased = 1 - (1 - t) ** 3;
        zoomAt(state.anim.from + (state.anim.to - state.anim.from) * eased, state.anim.sx, state.anim.sy);
        if (t >= 1) state.anim = null;
      }

      const busy = state.animating || p.colour.cycle;
      if (!state.dirty && !busy) return;
      state.dirty = false;
      state.animating = false;

      const { view } = state;
      const ps = pixelSize(view.zoom);
      const level = Math.max(0, Math.min(f.maxZoom, Math.round(view.zoom)));
      const tileSpan = f.home.span / 2 ** level;
      const tilePx = tileSpan / ps;
      const worldLeft = f.home.re - f.home.span / 2;
      const worldTop = f.home.im + f.home.span / 2;
      const viewLeft = view.cx - (W / 2) * ps;
      const viewTop = view.cy + (H / 2) * ps;
      const last = 2 ** level - 1;

      const x0 = Math.max(0, Math.floor((viewLeft - worldLeft) / tileSpan));
      const x1 = Math.min(last, Math.floor((viewLeft + W * ps - worldLeft) / tileSpan));
      const y0 = Math.max(0, Math.floor((worldTop - viewTop) / tileSpan));
      const y1 = Math.min(last, Math.floor((worldTop - viewTop + H * ps) / tileSpan));

      const palette = getPalette(p.colour.paletteId);
      const offset = (p.colour.offset + (p.colour.cycle ? (now / 1000) * p.colour.cycleSpeed : 0)) % 1;
      const colourOptions = {
        kind: f.kind,
        scale: f.valueScale(p.params),
        classCount: p.params.degree ?? 1,
        density: p.colour.density,
        offset,
        lut: paletteLut(palette),
      };
      const stamp = `${palette.id}|${p.colour.density}|${offset.toFixed(4)}`;

      ctx.fillStyle = "#07041a";
      ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingQuality = "high";

      // Visit tiles nearest the centre first: they are fetched first, too.
      const centreX = (view.cx - worldLeft) / tileSpan;
      const centreY = (worldTop - view.cy) / tileSpan;
      const visible = [];
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          visible.push({ x, y, d: (x + 0.5 - centreX) ** 2 + (y + 0.5 - centreY) ** 2 });
        }
      }
      visible.sort((a, b) => a.d - b.d);

      const wanted = [];
      const overlays = [];

      for (const { x, y } of visible) {
        const url = tileUrl({ fractal: f.id, query: p.query, z: level, x, y });
        const entry = loader.get(url);
        const sx = (worldLeft + x * tileSpan - viewLeft) / ps;
        const sy = (viewTop - (worldTop - y * tileSpan)) / ps;
        const dx = Math.floor(sx);
        const dy = Math.floor(sy);
        const dw = Math.floor(sx + tilePx) - dx;
        const dh = Math.floor(sy + tilePx) - dy;

        if (entry?.state === "ready") {
          ctx.drawImage(tileCanvas(entry, stamp, colourOptions), dx, dy, dw, dh);
          overlays.push({ entry, dx, dy, dw, dh });
          continue;
        }

        wanted.push(url);

        // Until this tile arrives, stretch the best ancestor already held.
        for (let k = 1; k <= ANCESTOR_DEPTH && level - k >= 0; k += 1) {
          const factor = 2 ** k;
          const px = Math.floor(x / factor);
          const py = Math.floor(y / factor);
          const parent = loader.get(tileUrl({ fractal: f.id, query: p.query, z: level - k, x: px, y: py }));
          if (parent?.state === "ready") {
            const sub = TILE_SIZE / factor;
            ctx.drawImage(
              tileCanvas(parent, stamp, colourOptions),
              (x - px * factor) * sub,
              (y - py * factor) * sub,
              sub,
              sub,
              dx,
              dy,
              dw,
              dh,
            );
            break;
          }
        }

        if (entry?.sawPending || entry?.state === "waiting") {
          overlays.push({ entry, dx, dy, dw, dh, pending: true });
        }
      }

      loader.want(wanted);
      drawOverlays(ctx, overlays, p.overlays, now, dpr());
      if (overlays.some((o) => o.pending || now - (o.entry.arrivedAt ?? 0) < FLASH_MS)) {
        state.animating = true;
      }

      const report = {
        cx: view.cx,
        cy: view.cy,
        zoom: view.zoom,
        level,
        tiles: visible.length,
        loading: wanted.length,
        held: loader.held(),
        cursor: state.cursor,
      };
      const key = JSON.stringify(report);
      if (key !== state.lastReport) {
        state.lastReport = key;
        p.onViewChange?.(report);
      }
    };

    let raf = 0;
    const frame = (now) => {
      draw(now);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const resize = new ResizeObserver(() => {
      canvas.width = Math.round(canvas.clientWidth * dpr());
      canvas.height = Math.round(canvas.clientHeight * dpr());
      if (state.view) clampView();
      state.dirty = true;
    });
    resize.observe(canvas);

    const onWheel = (event) => {
      event.preventDefault();
      if (!state.view) return;
      const unit = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 400 : 1;
      const { sx, sy } = toPlane(event.clientX, event.clientY);
      state.anim = null;
      zoomAt(state.view.zoom - event.deltaY * unit * 0.0022, sx, sy);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const onPointerDown = (event) => {
      canvas.setPointerCapture(event.pointerId);
      state.drag = { x: event.clientX, y: event.clientY, moved: 0 };
    };

    const onPointerMove = (event) => {
      if (!state.view) return;
      const point = toPlane(event.clientX, event.clientY);
      state.cursor = { re: point.re, im: point.im };
      state.dirty = true;

      if (!state.drag) return;
      const ps = pixelSize(state.view.zoom) * dpr();
      const dx = event.clientX - state.drag.x;
      const dy = event.clientY - state.drag.y;
      state.drag.moved += Math.abs(dx) + Math.abs(dy);
      state.drag.x = event.clientX;
      state.drag.y = event.clientY;
      state.view.cx -= dx * ps;
      state.view.cy += dy * ps;
      clampView();
    };

    const onPointerUp = (event) => {
      const drag = state.drag;
      state.drag = null;
      if (drag && state.view && drag.moved < 5 && event.shiftKey) {
        const { re, im } = toPlane(event.clientX, event.clientY);
        propsRef.current.onPick?.({ re, im });
      }
    };

    const onDoubleClick = (event) => {
      if (!state.view) return;
      const { sx, sy } = toPlane(event.clientX, event.clientY);
      const step = event.altKey ? -1.5 : 1.5;
      state.anim = { from: state.view.zoom, to: state.view.zoom + step, sx, sy, start: performance.now() };
    };

    const onLeave = () => {
      state.cursor = null;
      state.dirty = true;
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("dblclick", onDoubleClick);

    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("dblclick", onDoubleClick);
    };
  }, []);

  // A new fractal, or the reset button, returns to the home view.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.state.needsHome = true;
    engine.state.anim = null;
  }, [props.fractalId, props.resetToken]);

  // Server cache flushed: drop local copies so the next views go back to the farm.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !props.clearToken) return;
    engine.loader.clear();
    engine.state.dirty = true;
  }, [props.clearToken]);

  // Overlay or colour changes need a redraw even when nothing else moves.
  useEffect(() => {
    if (engineRef.current) engineRef.current.state.dirty = true;
  }, [props.query, props.colour, props.overlays]);

  return <canvas ref={canvasRef} className="fractal-canvas" />;
}

/**
 * Draw the worker tints, source flashes and pending markers.
 * @param {CanvasRenderingContext2D} ctx - Context
 * @param {Array} items - Tiles drawn this frame
 * @param {{workers: boolean, sources: boolean}} show - Which overlays are on
 * @param {number} now - Frame time
 * @param {number} dpr - Device pixel ratio
 * @returns {void}
 */
function drawOverlays(ctx, items, show, now, dpr) {
  ctx.save();
  ctx.font = `${Math.round(11 * dpr)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
  ctx.textBaseline = "top";

  for (const { entry, dx, dy, dw, dh, pending } of items) {
    if (pending) {
      const pulse = 0.55 + 0.45 * Math.sin(now / 180);
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = SOURCE_COLOURS.render;
      ctx.lineWidth = 2 * dpr;
      ctx.setLineDash([8 * dpr, 6 * dpr]);
      ctx.lineDashOffset = -now / 25;
      ctx.strokeRect(dx + dpr, dy + dpr, dw - 2 * dpr, dh - 2 * dpr);
      ctx.setLineDash([]);
      if (dw > 90 * dpr) {
        ctx.fillStyle = SOURCE_COLOURS.render;
        ctx.fillText("rendering…", dx + 8 * dpr, dy + 8 * dpr);
      }
      ctx.globalAlpha = 1;
      continue;
    }

    if (show.workers && entry.tile.workerId) {
      const colour = workerColour(entry.tile.workerId);
      ctx.globalAlpha = 0.24;
      ctx.fillStyle = colour;
      ctx.fillRect(dx, dy, dw, dh);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = colour;
      ctx.lineWidth = dpr;
      ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);

      if (dw > 120 * dpr) {
        const label = `${entry.tile.workerId} · ${entry.tile.renderMs}ms`;
        const pad = 4 * dpr;
        const width = ctx.measureText(label).width + pad * 2;
        ctx.globalAlpha = 0.75;
        ctx.fillStyle = "#07041a";
        ctx.fillRect(dx + 6 * dpr, dy + 6 * dpr, width, 17 * dpr);
        ctx.globalAlpha = 1;
        ctx.fillStyle = colour;
        ctx.fillText(label, dx + 6 * dpr + pad, dy + 9 * dpr);
      }
    }

    const age = now - (entry.arrivedAt ?? -Infinity);
    if (show.sources && age < FLASH_MS) {
      const fade = 1 - age / FLASH_MS;
      ctx.globalAlpha = fade * 0.28;
      ctx.fillStyle = SOURCE_COLOURS[entry.source] ?? SOURCE_COLOURS.edge;
      ctx.fillRect(dx, dy, dw, dh);
      ctx.globalAlpha = fade;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 3 * dpr;
      ctx.strokeRect(dx + 1.5 * dpr, dy + 1.5 * dpr, dw - 3 * dpr, dh - 3 * dpr);
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}
