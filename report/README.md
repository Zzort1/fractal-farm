# Report scaffold

`main.tex` is an Overleaf-ready scaffold of the A3 report in Nigel's usual
report style, following the brief's required structure.

- **Orange "Your writing" boxes** list what each section must cover. Replace
  each with your own prose — the brief requires the report to be drafted by
  you (GenAI may only refine style).
- Tables, schemas, measurements and TikZ diagrams are project facts taken
  from the repository and the live deployment; check and own them.
- Grey boxes are screenshots still to capture.

## Upload to Overleaf

Upload `main.tex` and the `Images/` folder (add `qut logo.jpg` there and
uncomment the line on the title page if you want the logo).

## Screenshots to capture

| Label | What |
|---|---|
| `fig:ui-main` | Whole interface: controls, viewer, control room |
| `fig:ui-workers` | Worker tint overlay after zooming into new tiles |
| `fig:ui-fleet` | Control room mid scale-out (run `npm run loadtest` against the public URL) |

Also worth capturing for the report or appendix: ECS services page, SQS queue
monitoring graphs during a load test, the scaler log showing `Scaled` lines,
and the ALB target group health.

## Still to produce

- AWS diagram with official icons (draw.io), replacing the TikZ draft
- Pricing Calculator estimate and its public share link
- Measurements for the 50-user estimate (Table "Inputs to the 50-user estimate")
