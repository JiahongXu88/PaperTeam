# M13.7.9 fixed acceptance assets — academic redundancy evaluation + argument-unit refinement (B2)

Status: **PASS — Ready for Production Integration** (recorded execution: 30 Writer tasks / 30 assistant turns on
`zai-coding-cn/glm-5.3`; B2 harmful share 14.3 % → 1.6 % on `heldout-alignment`, 9.8 % → 0.0 % on `heldout-qec`, must-retain
checklists complete, signposts and verbatim comparison carries 0, cost −18.5 % / −22.9 %; H3-only alone does not de-duplicate).
Production writing path unchanged — see [the report](../../../../docs/research/M13_7_9_ACADEMIC_REDUNDANCY_AND_ARGUMENT_UNIT_REFINEMENT.md)
(verdict, held-out tables and the dev-stage calibration log live there; this README only describes the frozen assets).

## Files

- `dev-simclr.json` — **development set**: byte-identical copy of `m13-7-8/heldout.json` (outline / evidence / bibliography /
  instructions / `argumentUnits` = M13.7.8 Arm B) plus `argumentUnitsV2` (B2). The topic was already used by M13.7.8 and is
  not held-out; it is only used to compare B2 against the frozen A / B outputs and to calibrate the classifier.
- `heldout-alignment.json` — **held-out topic 1**「大语言模型偏好对齐方法综述：人类反馈强化学习、直接偏好优化与 AI 反馈」—
  InstructGPT (2203.02155), DPO (2305.18290), Constitutional AI (2212.08073), RLAIF vs RLHF (2309.00267). Five sections
  (引言 / 基于人类偏好的对齐 / 以 AI 反馈替代人类标注 / 综合比较与局限性 / 结论与展望), 10 direct + 2 partial evidence
  records, 4 bibliography keys, production-shaped `instructions`, `argumentUnitsV2` only (B2; no Arm-B block).
- `heldout-qec.json` — **held-out topic 2**「超导量子纠错实验综述：表面码规模扩展与突破盈亏平衡的逻辑量子比特」—
  Acharya et al. 2022 (2207.06431), Acharya et al. 2024 (2408.13687), Sivak et al. (2211.09116), Ni et al. (2211.09319).
  Five sections (引言 / 表面码逻辑量子比特的规模扩展 / 突破盈亏平衡的逻辑量子比特实验 / 综合比较与局限性 / 结论与展望),
  10 direct + 2 partial, numerically dense (≥ 12 must-retain numbers).
- `sources-abstracts-alignment.json`, `sources-abstracts-qec.json` — the eight public arXiv abstracts exactly as fetched on
  2026-10-12 (`<meta name="citation_abstract">`, entities decoded, whitespace collapsed) with page SHA256. Every `quote` in
  the two held-out fixtures was cut out of these abstracts by anchors and asserted to be an exact substring before freeze.
  Verification level is **abstract** — not full-text grounding, not a production Grounding / Judge verdict.
- `concept-markers-alignment.json`, `concept-markers-qec.json` — deterministic concept-distribution markers and two
  negative controls per topic for `scripts/acceptance/m13-7-9-evaluate.mjs`. Frozen before the first held-out request and
  **not widened afterwards**; marker misses are reported next to manual counts.
- `protocol.json` — pre-registration: stages, both held-out topics, independence check, budget (30 Writer tasks for the
  whole round, single ledger), arms, order, H3-only topic-selection rule, classifier thresholds and rule order, metric A /
  metric B definitions, discriminative floor, per-topic gate, verdict rules, priority order, must-retain checklists,
  fact-audit red flags, design limits, no-tuning rule.
- `freeze-sha256.json` — SHA256 of the frozen inputs (LF and CRLF forms) plus the classifier / detector / runner / evaluator
  files and the `WriterService` dist used by every LIVE arm.

## Arms (runner: `scripts/acceptance/argument-unit-writing-live.mjs`; production code unchanged)

| arm | evidence | length | task block |
| --- | --- | --- | --- |
| `baseline` (A) | full 12-record snapshot | 约350字 | — |
| `argument-unit` (B, dev only) | `argumentUnits.evidenceIds` | upper bound 180/400/400/320/160 + `lengthPolicy` | role / task / doNotExplain with「见 X 一节」pointers |
| `argument-unit-v2` (B2) | same partition | same | `argumentUnitsV2`: role label / task / doNotExplain concepts (no pointers) / behavioural `crossSectionPolicy` |
| `task-only` (H3-only) | full snapshot | 约350字 (as A) | B2 task block without the `lengthPolicy` line |

B → B2 differences are enumerated in `dev-simclr.json#argumentUnitsV2.changes`; the dry-run prompt diff is confined to the
task block (`===== 本节论证任务 =====`), everything else byte-identical.

```bash
export PROJECTS_ROOT=/private/data/projects
R=scripts/acceptance/argument-unit-writing-live.mjs; B="--model zai-coding-cn/glm-5.3 --max-tasks 30 --budget-file /private/M13_7_9/model-budget.json"
node $R /repo scripts/acceptance/fixtures/m13-7-9/dev-simclr.json        /private/M13_7_9/dev/glm-argument-unit-v2            --arm argument-unit-v2 $B
node $R /repo scripts/acceptance/fixtures/m13-7-9/heldout-alignment.json /private/M13_7_9/heldout/alignment-glm-baseline      --arm baseline $B
node $R /repo scripts/acceptance/fixtures/m13-7-9/heldout-alignment.json /private/M13_7_9/heldout/alignment-glm-argument-unit-v2 --arm argument-unit-v2 $B
node $R /repo scripts/acceptance/fixtures/m13-7-9/heldout-qec.json       /private/M13_7_9/heldout/qec-glm-baseline            --arm baseline $B
node $R /repo scripts/acceptance/fixtures/m13-7-9/heldout-qec.json       /private/M13_7_9/heldout/qec-glm-argument-unit-v2    --arm argument-unit-v2 $B
node $R /repo scripts/acceptance/fixtures/m13-7-9/heldout-<selected>.json /private/M13_7_9/heldout/<selected>-glm-task-only  --arm task-only $B
node scripts/acceptance/m13-7-9-evaluate.mjs /repo /private/M13_7_9/heldout/qec-glm-baseline scripts/acceptance/fixtures/m13-7-9/concept-markers-qec.json scripts/acceptance/fixtures/m13-7-9/heldout-qec.json > qec-glm-baseline.eval.json
node scripts/acceptance/m13-7-9-compare.mjs qec-glm-baseline.eval.json qec-glm-argument-unit-v2.eval.json
node scripts/acceptance/m13-7-9-classify.mjs /repo /private/M13_7_9/heldout/qec-glm-baseline --roles introduction=framing,surface=develop,breakeven=develop,comparison=compare,conclusion=conclude --markdown
```

`--dry-run` writes prompts only. Private outputs (prompts, raw outputs, usage, detector / classifier reports, evaluation
JSON, logs, budget ledger, calibration dumps, raw abstract pages) live outside Git at `D:\PaperTeamData\M13_7_9`.
