# M13.7.8 fixed acceptance assets — argument-unit writing, held-out validation

Status: see [the report](../../../../docs/research/M13_7_8_ARGUMENT_UNIT_HELDOUT_VALIDATION.md).

- `heldout.json`: **held-out** topic「视觉自监督表示学习中的对比与非对比方法综述」— SimCLR (2002.05709v3),
  MoCo (1911.05722v3), BYOL (2006.07733v3), SimSiam (2011.10566v1). Five sections (引言 / 基于负样本的对比框架 /
  无负样本的孪生方法 / 综合比较与局限性 / 结论与展望), 10 direct + 2 partial evidence records, 4 bibliography keys,
  the production-shaped `instructions`, and an `argumentUnits` block (per-section role / task / `evidenceIds` /
  `doNotExplain` with owner / upper-bound `targetLengthWords`, a shared `lengthPolicy` and the
  `lengthInstructionReplace` wording swap used by the length-bearing arms). None of these papers or this topic was used
  by M13.7.2–M13.7.7 (Transformer, DPR/RAG, LoRA/QLoRA, FedAvg/SCAFFOLD) and they have no prior occurrence in the repo.
- `sources-abstracts.json`: the four public arXiv abstracts exactly as fetched on 2026-10-12 from the abstract pages
  (`<meta name="citation_abstract">`; the export API answered 429 at fetch time), with page SHA256. Every `quote` in
  `heldout.json` is asserted to be an exact substring of these abstracts before freeze. Verification level is
  **abstract** — public excerpts, manually scoped; not full-text grounding, not a production Grounding/Judge verdict.
- `protocol.json`: arms A/B/C/D and the hypotheses each carries, model, 20-Writer-task budget with separate
  request (assistant-turn) accounting, pre-registered gate (≥ 30 % relative drop of `restatedCharShare` + full
  `mustRetain` checklist + no unknown key + no new quote-exceeding claim + no short-write task avoidance), manual
  reading rules, per-section must-retain checklist, fact-audit red flags, and the design limits (no H3-only arm).
- `concept-markers.json`: deterministic concept-distribution markers and two negative controls (E11 / E12 partial
  escalation) for `scripts/acceptance/m13-7-8-evaluate.mjs`. Frozen before the first LIVE request and **not widened
  afterwards**; marker misses are reported next to manual counts instead.
- `freeze-sha256.json`: SHA256 of the frozen inputs (LF and CRLF forms) plus the runner / evaluator / detector files.

Runner: `scripts/acceptance/argument-unit-writing-live.mjs` (production `buildSectionPrompt` + `PiRuntimeAdapter`,
no production code change). Arms differ only through existing parameters:

| arm | evidence | length | task block |
| --- | --- | --- | --- |
| `baseline` (A) | full 12-record snapshot | 约350字 | — |
| `evidence-only` (C, H1) | `argumentUnits.evidenceIds` | 约350字 | — |
| `length-only` (D, H2) | full snapshot | upper bound 180/400/400/320/160 + `lengthPolicy` | — |
| `argument-unit` (B, H1+H2+H3) | `argumentUnits.evidenceIds` | same as D | role / task / doNotExplain |

```bash
export PROJECTS_ROOT=/private/data/projects
node scripts/acceptance/argument-unit-writing-live.mjs /repo scripts/acceptance/fixtures/m13-7-8/heldout.json /private/live/glm-baseline --arm baseline --model zai-coding-cn/glm-5.3
node scripts/acceptance/argument-unit-writing-live.mjs /repo scripts/acceptance/fixtures/m13-7-8/heldout.json /private/live/glm-argument-unit --arm argument-unit --model zai-coding-cn/glm-5.3
node scripts/acceptance/argument-unit-writing-live.mjs /repo scripts/acceptance/fixtures/m13-7-8/heldout.json /private/live/glm-evidence-only --arm evidence-only --model zai-coding-cn/glm-5.3
node scripts/acceptance/argument-unit-writing-live.mjs /repo scripts/acceptance/fixtures/m13-7-8/heldout.json /private/live/glm-length-only --arm length-only --model zai-coding-cn/glm-5.3
node scripts/acceptance/m13-7-8-evaluate.mjs /repo /private/live/glm-baseline scripts/acceptance/fixtures/m13-7-8/concept-markers.json scripts/acceptance/fixtures/m13-7-8/heldout.json > glm-baseline.eval.json
node scripts/acceptance/m13-7-8-compare.mjs glm-baseline.eval.json glm-argument-unit.eval.json glm-evidence-only.eval.json glm-length-only.eval.json
```

Run arms one at a time under the same private parent: `model-budget.json` reserves one Writer task per section
(max 20) and records the assistant turns each task spent; it is not a concurrent lock. `--dry-run` writes prompts only.
Private outputs (prompts, raw outputs, usage, detector reports, evaluation JSON, logs) live outside Git at
`D:\PaperTeamData\M13_7_8` on the machine that ran them.
