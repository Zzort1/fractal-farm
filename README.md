# Fractal Farm

CAB432 Assessment 3 (n5453313). A distributed fractal tile render farm: an
explorer zooms into seven kinds of fractal while a pool of workers renders
tiles behind layered caches, and a live control room shows the system scaling.

Fractal tiles are a near-perfect cloud workload: **expensive** (CPU-bound
maths), **parallel** (every tile is independent), **deterministic** (the same
URL always yields the same bytes, so every cache may keep it forever), and
**skewed** (everyone visits the same famous regions, so caching pays).

## Run it locally

Needs Node 22+. No cloud account required.

```powershell
npm install
npm run dev          # API + 4 local workers on :8787, web on :5173
```

Open http://localhost:5173.

| Command | What it does |
|---|---|
| `npm test` | Unit tests for the fractal maths, tile format and cache-key rules |
| `npm run build` | Production build of the web client into `web/dist` |
| `npm run loadtest -- --users 16 --duration 30 --fractal lyapunov --iter 1024` | Simulated explorers; reports throughput, cache sources, latency |
| `node scripts/contact-sheet.js out.png` | Renders every fractal headlessly into one PNG |

In the control room, **+ / −** next to *Workers* changes the local worker
count by hand — a stand-in for the auto-scaling the cloud does by itself.

## Layout

```
packages/
  fractal-core/   pure maths, tile geometry, canonical params, binary tile format
                  — shared by browser, API and workers, so all three agree on cache keys
  platform/       infrastructure adapters (queue, store, cache, notifier), local now, AWS later
services/
  api/            tile API: canonicalise → memory → store → queue + wait; stats stream
  worker/         pull a job, render on a CPU thread, store, announce
web/              React client; canvas tile engine, palettes and charts all hand-written
scripts/          dev launcher, load generator, contact sheet
docs/             stage plan and design notes
```

## Request path

```
browser ──GET /tiles/{fractal}/{z}/{x}/{y}?{canonical params}──▶ API
  API: non-canonical? ─▶ 301 to canonical URL
       memory cache hit? ─▶ 200  (x-cache: memory)
       store hit? ─▶ copy to memory ─▶ 200  (x-cache: store)
       already rendering? ─▶ join that wait (coalescing)
       else ─▶ queue job ─▶ wait ≤ 2 s for "tile ready"
                 ready ─▶ 200 (x-cache: render) · not yet ─▶ 202, client polls
worker: receive job ─▶ already stored? ack (idempotent) ─▶ render on thread
        ─▶ gzip ─▶ store ─▶ publish "ready" ─▶ ack · failure ─▶ retry ─▶ dead-letter
```

Workers return **numbers, not colours** (smooth iteration counts). The browser
applies the palette, so recolouring is free and never fragments the cache.

See [docs/STAGES.md](docs/STAGES.md) for the build plan towards AWS.
