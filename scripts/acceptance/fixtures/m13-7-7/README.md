# M13.7.7 fixed acceptance assets — argument-unit input organization & same-harness model contrast

Status: **PARTIAL (development sample only; no production writing change merged)**.
See [the report](../../../../docs/research/M13_7_7_CROSS_SECTION_ROOT_CAUSE_AND_REDESIGN.md).

- `dev.json`: LoRA/QLoRA. Identical `outline`, `evidence`, `bibliography` and `instructions`
  to `../m13-7-4/dev.json` (a **seen** regression sample, not held-out), plus an
  `argumentUnits` block: per-section role (framing / develop / compare / conclude), task,
  assigned `evidenceIds`, `doNotExplain` concepts with their owner section, per-section
  `targetLengthWords`, and a `lengthPolicy` that makes the target an upper bound.
- `protocol.json`: arms, model ids, 20-underlying-request cap, evaluation gate, frozen before
  the first provider request.
- `concept-markers.json`: deterministic concept-distribution markers used by
  `scripts/acceptance/m13-7-7-evaluate.mjs`. The QLoRA mechanism pattern was widened to
  accept “四位” after the first outputs used that spelling; this only changes how hits are
  counted, never prompts, fixture, thresholds or outputs. All arms were re-evaluated with
  the final markers.
- `freeze-sha256.json`: SHA256 of the three JSON inputs in LF and CRLF form.

The runner `scripts/acceptance/argument-unit-writing-live.mjs` uses only the production
`buildSectionPrompt` / `buildRevisePrompt` builders and `PiRuntimeAdapter`; the
argument-unit arm changes nothing in production code — it passes per-section evidence,
`targetLengthWords` and `extraInstructions` through parameters that already exist.
Custom providers stored by the Settings UI are registered exactly as `backend/src/index.ts`
does, so a second model can run through the same harness. Credentials are never read by
the runner beyond the Pi credential store; set `PROJECTS_ROOT` to a private directory.

```bash
export PROJECTS_ROOT=/private/data/projects
node scripts/acceptance/argument-unit-writing-live.mjs /repo scripts/acceptance/fixtures/m13-7-7/dev.json /private/data/live/glm-baseline --arm baseline --model zai-coding-cn/glm-5.3
node scripts/acceptance/argument-unit-writing-live.mjs /repo scripts/acceptance/fixtures/m13-7-7/dev.json /private/data/live/fable-baseline --arm baseline --model <provider>/claude-fable-5-1
node scripts/acceptance/argument-unit-writing-live.mjs /repo scripts/acceptance/fixtures/m13-7-7/dev.json /private/data/live/glm-argument-unit --arm argument-unit --model zai-coding-cn/glm-5.3
node scripts/acceptance/argument-unit-writing-live.mjs /repo scripts/acceptance/fixtures/m13-7-7/dev.json /private/data/live/glm-collapse --arm collapse --model zai-coding-cn/glm-5.3 --source /private/data/live/glm-baseline --max-targets 3
node scripts/acceptance/m13-7-7-evaluate.mjs /repo /private/data/live/glm-baseline scripts/acceptance/fixtures/m13-7-7/concept-markers.json
```

Run arms one at a time under the same private parent: `model-budget.json` counts assistant
turns (underlying requests) and is not a concurrent lock. `--dry-run` writes prompts only.
Recorded execution: 18 tasks / 19 requests (Fable spent two turns on its first section
because it read the `academic-writing-zh` skill). Private outputs, prompts, usage, detector
reports and logs are outside Git at `D:\PaperTeamData\M13_7_7` on the machine that ran them.
