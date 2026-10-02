# Build stages

Small, verified steps, as in A2: each stage ends with something visibly
working and a note of what proved it. Nothing is retagged or deleted from
Assessment 2 until after the A2 oral.

| Stage | What | Proves | Status |
|---|---|---|---|
| 0 | Local draft: core maths, adapters, API, workers, UI, load test | Whole design works on one machine | **done** |
| 1 | Account probe: confirm SQS, S3, ECS, ElastiCache, CloudFront, Application Auto Scaling, CloudWatch permissions under the CAB432 guardrails | No surprises later | |
| 2 | AWS adapters: SQS (+DLQ) queue, S3 store; worker as its own entry point | Same code, cloud backing | |
| 3 | Containers: Dockerfiles, ECR, ECS services for API and worker (reuse A2 cluster) | Runs on Fargate | |
| 4 | Public path: ALB (dispatcher-push), Route 53 `n5453313-fractal.cab432.com`, ACM | HTTPS entry point | |
| 5 | **Worker auto-scaling**: target tracking on queue backlog per task, min 0 | Metric-based scaling, scale-to-zero | |
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
