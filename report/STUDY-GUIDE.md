# Writing the A3 report — a study guide

This guide teaches you *what to understand* and *how to write it*. It does not
contain report text: the brief requires the report to be drafted by you, and
the coordinator may interview you on it. If you can answer the "check
yourself" questions out loud, you can write the section — and defend it.

---

## Part 1 — The paragraph recipe

Markers in CAB432 reward **reasoning**, not description. Almost every
paragraph in sections 2–4 should be a *decision paragraph*:

| Step | Ask yourself | Signal words |
|---|---|---|
| 1. Context | What situation forced a choice? | "Because…", "Unlike…" |
| 2. Requirement | Which requirement (FR/NFR) is at stake? | "To meet NFR2…" |
| 3. Options | What else could have been done? | "Alternatives were…" |
| 4. Choice | What did you pick? | "I chose…" |
| 5. Trade-off | What did it cost? | "The cost is…", "In exchange…" |
| 6. Evidence | How do you know it worked? | numbers, figures, tables |

### Worked example — on a *different* system

Imagine a pizza shop's online ordering site. Here is the same decision written
badly and well.

**Weak (description only):**

> The system uses a message queue. Orders are put on the queue and the kitchen
> app reads them. Queues are scalable and reliable.

Why it is weak: it says *what*, never *why*; "scalable and reliable" is generic
and could describe any system; nothing is measured; no alternative appears.

**Strong (recipe applied):**

> Friday-night ordering peaks at roughly ten times the weekday rate, but the
> kitchen can only cook a fixed number of pizzas at once (context). If the
> website called the kitchen system directly, a peak would either time out
> customers or overload the kitchen display (requirement: orders must never be
> lost, NFR3). A direct API call or a shared database table polled by the
> kitchen were considered (options). Orders are instead placed on a queue that
> the kitchen app pulls from at its own pace (choice). The trade-off is that
> customers no longer get an instant "accepted by kitchen" confirmation; the
> site shows "received" and the kitchen confirms later (trade-off). In a
> simulated Friday peak of 400 orders in ten minutes, no order was lost and the
> longest wait before the kitchen saw an order was 3 minutes (evidence).

Notice: specific numbers, a named requirement, a rejected alternative, an
honest cost, and evidence. That shape — not the pizza — is what to reuse.

### Three more habits

- **Name your system, not cloud computing.** "Queues decouple producers and
  consumers" is textbook. "The API never waits for a worker; it hands over a
  job and answers 202" is *your* system.
- **Every claim earns a number or a figure reference.** "Fast" → "≈2 ms from
  memory, ≈120 ms from S3 (measured)".
- **Admit limits before the marker finds them.** An honest limitation with a
  fix scores better than a hidden one.

---

## Part 2 — Understand each section

### Executive summary
**What the marker wants:** in one page, could a busy engineer decide whether to
read on? Write it *last*.

**Check yourself**
- In two sentences, what does Fractal Farm do and why does it need the cloud?
- Which three design decisions would you defend first?
- What is your single strongest piece of evidence?

### 1. Introduction
**Understand the problem first.** A tile of a fractal at high zoom can need
up to 4,096 iterations per pixel × 65,536 pixels. Ask yourself:

- *Q: Why can't one big server do this?*
  Think about demand shape: nobody, then a class of 30 all exploring at once.
  What does a fixed server cost at 3 a.m.? What happens to it at the peak?
- *Q: What property of fractals makes them cloud-friendly?*
  Four: expensive, independent tiles, deterministic, popular regions. For each
  one, which cloud idea does it unlock? (Hint: deterministic → caching forever.)

**Requirements:** the table is in the scaffold. Your job is to explain *where
each NFR came from*. Tie each to the problem: spiky demand → NFR1, repeat
visits → NFR2, anonymous public site → NFR4.

**Check yourself**
- Why is "colours are free" a requirement and not just a feature?
- What is out of scope and why (accounts, infinite zoom, CDN)?

### 2. Vendor-agnostic architecture
**The trap:** naming AWS services here. Say "object store", "job queue",
"container orchestrator", "load balancer".

**Ideas to understand**

- *Q: Why are there three separate compute roles (API, workers, controller)?*
  They scale on different signals: the API on requests, workers on backlog,
  the controller never (it is a singleton). Mixing them would force one size
  and one signal on all.

- *Q: Why do workers pull rather than have work pushed to them?*
  A tile can take 6 ms or 8 s. A pusher must guess who is free; a puller only
  asks when free. What happens with push when one worker gets three slow tiles?

- *Q: Why is "tiles are pure functions" the keystone?*
  If the same URL always means the same bytes, no cache ever needs
  invalidating, and a duplicate render is merely wasted, never wrong. Find
  two other decisions in the system that would be unsafe without this.

- *Q: What is canonicalisation protecting against?*
  Picture someone requesting `?iter=512&junk=1`, `&junk=2`, … Every variant is
  a new cache entry and a new render. What did you do about it (snap, sort,
  reject, redirect)?

- *Q: Why scale on backlog per worker, not CPU?*
  A busy worker is at 100% CPU whether one or fifty jobs wait. Which metric
  actually tells you how long a new user will wait? (Wait ≈ backlog per worker
  × time per tile.)

- *Q: Why scale out fast but in slowly?*
  Starting a container takes tens of seconds. What happens if you remove
  workers during a 20-second lull between bursts?

- *Q: What is the cost of scale-to-zero?*
  The first visitor after idle waits for a cold start. What still works for
  them meanwhile? (Cached tiles.) When would you set min = 1 instead?

- *Q: How does a waiting request learn the tile is ready?*
  Ideal: publish-subscribe. Deployed: polling the object store with backoff.
  Measured cost: 6 ms render vs 600–750 ms end-to-end. Why was polling chosen?

**Limitations to own:** no shared memory cache across API instances (hit rate
falls as you add instances — why?), no edge cache, double-precision zoom limit,
abandoned jobs still rendered, singleton controller.

**Check yourself**
- Draw the agnostic diagram from memory and narrate one tile request.
- Name eight patterns and point to where each lives.
- For three patterns, name the alternative you rejected and why.

### 3. Vendor-specific implementation (AWS)
**The story of this section is constraint.** You probed the account and found
managed auto-scaling, ElastiCache, CloudFront and SNS unavailable.

- *Q: How did you tell a guardrail from a missing permission?*
  "Explicit deny in an identity-based policy" vs "no identity-based policy
  allows". Why does that difference matter for what you do next?

- *Q: Is building your own scaler "cheating" the requirement?*
  What does Application Auto Scaling actually do every minute? (Read a
  metric, compare to a target, set desired count.) Your controller does the
  same loop. What do you gain (visibility, testability) and lose (you own its
  availability; coarser 10 s tick)?

- *Q: Why public subnets with public IPs?*
  How else would a task reach ECR, SQS and S3? (NAT gateway — what does it
  cost per month?) What protects the tasks anyway? (Security group membership.)

- *Q: Why Fargate rather than EC2 or Lambda for workers?*
  EC2 Auto Scaling is denied; Lambda scaling doesn't count for the brief and
  suits short functions, not long pull loops. What does per-second billing
  mean for scale-to-zero?

- *Q: What does the load-test timeline show?*
  Decision at 23:42:45, tasks started 10 s later, max reached, queue drained,
  zero at 23:46:15. And the honest part: p50 12.8 s. Work out why from
  5.5 s per tile × target 4. What does AWS's guidance (acceptable latency ÷
  processing time) suggest the target should be?

**Check yourself**
- Map every box in the agnostic diagram to an AWS service.
- Explain the security posture of a worker task in one breath.
- What would change if ElastiCache were granted tomorrow?

### 4. Application implementation
**No code here.** Explain data, messages and flows.

- *Q: What data exists, and why is each in its store?* Use the data table:
  tiles (immutable blobs → object store), jobs (transient → queue), status
  (overwritten → small object), metrics (time series → monitoring).
- *Q: Why a binary tile with a header?* What does the header let the control
  room do even when a tile came from a cache?
- *Q: Walk a miss.* Use the sequence figure: browser → API → memory → store →
  queue → worker → store → poll → 200. Then walk a hit. Where do they diverge?
- *Q: What happens when…* a worker dies mid-render? a job always fails? the
  queue is unreachable? the API task is unhealthy? the controller dies? For
  each: how is it detected, how does it recover, what does the user see?
- *Q: What did the browser-cache bug teach you?* The server only sees
  requests that get past the browser; the browser replays old headers.

**Check yourself**
- Explain coalescing with a concrete example of three users.
- Why does the API answer 202 after 2 s instead of waiting?

### 5. Cost and sustainability
- Work out the inputs before opening the calculator: requests per user per
  minute, share served by each cache layer, renders per hour, seconds per
  render, therefore average worker count. Show your arithmetic.
- Separate fixed costs (ALB, API, scaler running 730 h) from elastic ones
  (workers, requests). Which dominates at 50 users? At 0?
- Sustainability angle: every cache hit is a render (energy) not repeated;
  workers exist only while needed; colouring happens on devices already on.

**Check yourself**
- What does scaling from 0 to 8 workers do to the hourly bill?
- What cost risk did the account create (log retention)?

### 6. Reflection
Structure each example as *I assumed → I found (source) → so I changed*:

- Assumed managed scaling → probe showed it denied → built a controller.
- Assumed target 4 was fine → AWS SQS scaling guidance → target should be ≈1.
- Assumed server hit % told the truth → Resource Timing spec → added the
  browser layer to the display.
- Tags in the CLI shorthand → bucket lost `purpose` silently → verify every
  creation, script everything.

**Check yourself**
- Which source changed a decision, and what was the decision before and after?
- What would you research next and why?

---

## Part 3 — How I can help next

1. **Write a section, paste it, ask for feedback.** I'll point out missing
   reasoning, generic sentences, unsupported claims and limits you skipped —
   without rewriting it for you.
2. **Style polish** on finished paragraphs (allowed by the brief).
3. **Mock interview:** I ask the "check yourself" questions; you answer.
