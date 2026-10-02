# Build stages

Small, verified steps, as in A2: each stage ends with something visibly
working and a note of what proved it. Nothing is retagged or deleted from
Assessment 2 until after the A2 oral.

| Stage | What | Proves | Status |
|---|---|---|---|
| 0 | Local draft: core maths, adapters, API, workers, UI, load test | Whole design works on one machine | **done** |
| 1 | Account probe: SQS, S3, ECS, ECR, ELB, Route 53 allowed; Application Auto Scaling, EC2 ASG, ElastiCache, CloudFront, SNS denied — see [stage-1-permissions.md](stage-1-permissions.md) | Know the constraints | **done** |
| 2 | AWS adapters: SQS (+DLQ) queue, S3 store, store-polling notifier; standalone worker | Same code, cloud backing | **done** |
| 3 | Containers: Dockerfiles, ECR, ECS services for API and worker (reuse A2 cluster) | Runs on Fargate | **done** |
| 4 | Public path: ALB (dispatcher-push), Route 53 `n5453313-fractal.cab432.com`, ACM | HTTPS entry point | **done** |
| 5 | **Worker auto-scaling**: self-built controller (target tracking on backlog per worker via ecs:UpdateService, min 0) | Metric-based scaling, scale-to-zero | **done** |
| 6 | **Caching**: ElastiCache (shared memory layer + pub-sub notifier), CloudFront edge in front of tiles and the static site | Edge + in-memory caching | |
| 7 | API scaling on ALB request count; resilience (timeouts, retries, DLQ alarm) | Second scaling type | |
| 8 | Persistence extras: DynamoDB share links/bookmarks with TTL; S3 lifecycle on cold tiles | Structured store, garbage collection | |
| 9 | Observability: CloudWatch dashboard, cache-hit and render-time metrics, control room reading cloud metrics | Monitoring | |
| 10 | Evidence: load tests, scaling graphs, cost model for 50 users, submission YAML | Report inputs | |

## Patterns mapped (brief requires ≥ 8)

| Category | Pattern | Where |
|---|---|---|
| Storage | Unstructured store | Tiles in S3 (local: files) |
| Storage | Structured store | DynamoDB share links / run ledger (stage 8) |
| Caching | Edge caching | CloudFront on immutable tile URLs |
| Caching | In-memory caching | Per-instance LRU now; ElastiCache shared |
| Communication | Message queue | SQS job queue + dead-letter queue |
| Communication | Publish-subscribe | "tile ready" notifications |
| Communication | Polling | 202 + client retry; SQS long polling |
| Compute | Containers | API and workers on ECS Fargate |
| Scaling | Metric-based | Workers on backlog per task |
| Scaling | (second) | API on ALB request count |
| Distribution | Worker-pull | Workers receive jobs when free |
| Distribution | Dispatcher-push | ALB in front of API tasks |
| Any of | Event-driven, stateless design, resilience (retries, timeouts, idempotency, coalescing), configuration management, monitoring, garbage collection, interfaces (Web UI, API, SSE) | throughout |

## Stage 0 evidence (local, 2026-10-03)

Load test: 16 users, 20 s, Lyapunov at 1024 iterations (the heaviest tile).

| Workers | Tiles/s | p50 time to tile | p95 | Errors |
|---|---|---|---|---|
| 4 | 12.8 | 1793 ms | 2526 ms | 0 |
| 12 | 36.9 | 630 ms | 928 ms | 0 |

Three times the workers gave 2.9× the throughput: the work is genuinely
parallel, which is the property the cloud scaling stages rely on.

Smoke checks: non-canonical URL → 301; unknown parameter → 400; out-of-range
tile → 404; repeat request → `x-cache: memory`; tile header carries worker id.

## Stage 5 evidence (AWS, 2026-10-03)

Load test against https://n5453313-fractal.cab432.com — 24 users, 150 s,
Lyapunov at 2048 iterations, 30% popular tiles. Scaler policy: target 4 jobs
per worker, 0–8 workers, 60 s scale-in cool-down, 10 s tick.

| Time (UTC) | Scaler decision |
|---|---|
| 23:42:45 | 1 → 6 — "scale out: backlog 22 needs 6 at 4/worker" |
| 23:43:05 | 6 → 8 — "scale out: backlog 32 needs 8 at 4/worker" (max) |
| 23:46:15 | 8 → 0 — "scale to zero: idle for the whole cool-down" |

ECS started the five tasks 10 s after the first decision. Results: 164 tiles,
0 errors, 17.7% hit ratio; time to tile p50 12.8 s, p95 72 s.

**Finding — tune next.** Fargate renders far slower than a desktop core: a
2048-iteration Lyapunov tile takes p50 5.5 s, p95 8.7 s on a 0.5 vCPU worker
(n = 145), so 8 workers deliver ~1.4 tiles/s and a 4-job backlog per worker
means ~22 s waits. AWS's guidance for SQS-based scaling sets the target from
*acceptable latency ÷ average processing time*; with 5.5 s tiles and a ~6 s
latency goal the target should be ~1 job per worker, not 4. Larger workers
(1 vCPU) halve render time at the same cost per CPU-second.

Cache display fix (same day): repeat views are answered by the browser's
HTTP cache and never reach the server, so the server's hit ratio understated
caching. The control room now shows this browser's layer mix (Resource
Timing detects 0-byte browser-cache responses) and a rolling 60 s server
hit ratio.
