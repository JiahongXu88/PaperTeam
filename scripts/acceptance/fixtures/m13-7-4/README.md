# M13.7.4 frozen acceptance assets — PARTIAL

The candidate is **rejected**, not a production feature waiting to be restored.
See [the report](../../../../docs/research/M13_7_4_CHAPTER_RESPONSIBILITY_PLANNING.md).

- `dev.json`: LoRA/QLoRA; production ordinary-paper section prompt.
- `heldout.json`: federated aggregation and SCAFFOLD; production survey section prompt, two independent pairs in opposite arm order.
- `protocol.json`: criteria, model and 40-request cap fixed before generation.
- `freeze-sha256.json`: SHA256 of the LF-encoded JSON inputs. On Windows normalize CRLF to LF before verification.
- `rejected-candidate.patch`: complete final candidate, including schema, Planner/Writer/Workflow wiring and five targeted tests. Apply only to an isolated copy of `af65ce45afc08123f7253d3e62146abf4f9a8081` for reproducing this failed experiment. Do not apply to main as an accepted improvement.

The public abstracts were checked against the versioned arXiv pages. Evidence is
manually scoped fixture data, **not** a new production Grounding/Judge result.
`E9` deliberately contains an unsupported universal claim with only a mechanism
quote and remains partial in both arms. Survey expression contexts are frozen
manual projections; this does not exercise Matrix/Synthesis generation end to end.
The contract is manually fixed to isolate its consumption from Planner randomness.
Separate real Planner checks failed validation and are included in cost/results.

Sources: [LoRA v2](https://arxiv.org/abs/2106.09685v2),
[QLoRA v1](https://arxiv.org/abs/2305.14314v1),
[Federated Averaging v4](https://arxiv.org/abs/1602.05629v4),
[SCAFFOLD v4](https://arxiv.org/abs/1910.06378v4).

On Linux, with existing installed lockfile dependencies, built baseline and
candidate, and an isolated runtime containing already authorized server-local
model settings:

```bash
node scripts/acceptance/chapter-responsibility-live.mjs \
  /isolated/baseline /isolated/candidate ./dev.json /private/data/dev before,after
node scripts/acceptance/chapter-responsibility-live.mjs \
  /isolated/baseline /isolated/candidate ./heldout.json /private/data/heldout-1 before,after
node scripts/acceptance/chapter-responsibility-live.mjs \
  /isolated/baseline /isolated/candidate ./heldout.json /private/data/heldout-2 after,before
```

Use distinct new output directories under the **same private parent**. Run one
process at a time: the reservation ledger is not a concurrent database/lock.
`plan` runs production `WriterService.planOutline` with the same fixture structure
as feedback; ordinary and survey inputs select their respective prompts. It allows
at most three bounded attempts, all charged to the shared ledger. Do not mistake
completed model requests for a validated outline. No new dependencies, server,
credential export, deployment or destructive cleanup is performed by the runner.

Actual execution added one five-section developer-only treatment retry before
held-out freeze; it reused the original development baseline. Total: 35 section
requests + 5 planning requests = 40, all retained, including unsuccessful plans.
No held-out-informed prompt changes were made. Planning smoke processes briefly
overlapped due to orchestration error; section A/B was serial. No claim of stable
latency improvement or complete workflow success is made.

Private outputs, prompts, evidence, usage, hashes and unsuccessful logs are stored
outside Git at `D:\PaperTeamData\M13_7_4`. Neither test scores nor keyword counts
override the semantic quality gate.
