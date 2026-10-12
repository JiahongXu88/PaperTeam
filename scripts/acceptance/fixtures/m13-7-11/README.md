# M13.7.11 — Production Writing E2E & Quality Closure fixtures

Frozen before the first LIVE request of the round (see `protocol.json`; hashes in `freeze-sha256.json`).

- `frozen-outline-qec-run2.json` — the real GLM-5.3 Planner outline produced by the M13.7.10 production acceptance
  (run 2, seven sections, Planner-assigned roles). Both A/B arms save this outline verbatim; no Planner request is made.
- `protocol.json` — arms, HITL protocol, budget, evaluation rules and verdict rules for the round.
- Research inputs (fixture / abstracts / concept markers) are the unchanged M13.7.9 QEC files under `../m13-7-9/`.

Drivers: `../../argument-unit-ab-live.mjs` (same-condition production A/B), `../../survey-tail-live.mjs`
(Stage Replay → Review / Gate / Revision / PDF through the production orchestrator), `../../idea-planner-live.mjs`
(idea_to_paper real Planner + section-aware evidence allocation). Shared glue: `../../lib/m13-7-live.mjs`.
