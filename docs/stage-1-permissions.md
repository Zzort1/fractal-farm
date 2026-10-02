# Stage 1 — account permissions probe

Run: 2026-10-03, `bash infra/probe.sh`, as
`AWSReservedSSO_CAB432-STUDENT` (n5453313). Read-only: nothing was created.

## Result

| Area | Service | Result |
|---|---|---|
| Containers | ECS, ECR | allowed |
| Messaging / storage | SQS, S3, DynamoDB | allowed |
| Network / edge | EC2 describe, ELBv2, Route 53, ACM | allowed |
| Observability / config | CloudWatch metrics + dashboards, Logs, Secrets Manager, SSM, Cognito, API Gateway v2 | allowed |
| **Scaling** | **Application Auto Scaling** | **not granted** — "no identity-based policy allows" |
| **Scaling** | **EC2 Auto Scaling** | **explicit deny** |
| **Caching** | **ElastiCache** (serverless and node-based) | **explicit deny** |
| **Caching** | **CloudFront** | **explicit deny** |
| Messaging | SNS | explicit deny |

The explicit denies come from
`arn:aws:iam::901444280953:policy/Do-Not-Delete-LT1-AllowPolicy-AND-DenyPolicy-1`.

Hints that these may be enabled for A3: the account already holds the
service-linked roles `AWSServiceRoleForApplicationAutoScaling_ECSService` and
`AWSServiceRoleForApplicationAutoScaling_ElastiCacheRG`, and a
`CAB432MemcachedSG` security group exists.

## Consequences for the design

The brief makes auto-scaling (not Lambda) and caching mandatory, and the
managed services for both are currently unavailable. Options, in order of
preference:

1. **Ask the teaching team** whether ElastiCache, CloudFront and Application
   Auto Scaling will be enabled for A3 (likely after A2 presentations end).
2. **Meanwhile, design so the managed services are a drop-in.** The platform
   adapters already isolate cache, notifier and queue. Fallbacks that work
   under today's policy:
   - *Metric-based scaling* — a small controller that reads queue backlog and
     sets the worker service's desired count via `ecs:UpdateService`
     (target tracking implemented by hand; to be verified that the call is
     permitted).
   - *In-memory caching* — per-instance LRU (exists), plus optionally a
     self-managed Valkey/Redis container on Fargate as the shared layer.
     That is also a managed-vs-unmanaged comparison for the report.
   - *Edge caching* — no allowed AWS equivalent of CloudFront; immutable
     `Cache-Control` already lets browsers cache tiles.

## Network facts for later stages

| Item | Value |
|---|---|
| VPC | `vpc-007bab53289655834` (172.31.0.0/16) |
| Public subnets | `subnet-05a3b8177138c8b14` (2a), `subnet-075811427d5564cf9` (2b), `subnet-04ca053dcbe5f49cc` (2c) |
| Security groups | `default` `sg-078997505ad1c6bbc` (all traffic from itself), `CAB432SG` `sg-032bd1ff8cf77dbb9` (80/443/8080… from anywhere) — new groups/rules are denied (A2 finding) |
| Hosted zone | `cab432.com` `Z02680423BHWEVRU2JZDQ` |
| ECS cluster | `n5453313-a2-cluster` (reusable per FAQ; keep `assessment 2` tag until after the A2 oral) |
| Task roles | `Execution-Role-CAB432-ECS`, `Task-Role-CAB432-ECS` (policies not readable by students) |
