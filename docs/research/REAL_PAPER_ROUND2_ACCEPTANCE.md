# Real Research Paper — Round 2 Unattended Acceptance (desensitized)

> Status: **COMPLETE (Round 2 = PARTIAL: Draft ready, Final not reachable with the authorized material)** —
> checkpoints A (before run start), B (first real run terminal), C (fixes + regression), D (task end). It contains engineering facts only. Manuscript text, LaTeX,
> experiment details, raw logs and PDFs are never committed to this public
> repository; they are synced to a private artifacts repository controlled by
> the author.

## 0. Scope

- Project: the existing real research project (vehicle MOT identity-switch
  suppression), project id `p-14afa81bd7fa`, workflow `idea_to_paper`.
- Starting baseline: M13.6 complete, `c9e826b774a89a3c74d5625caeee84f6c01009e5`
  (local HEAD = origin/main, working tree clean, CI + Linux Integration green).
- Goal: re-run the complete Research → Writing → Review → Revision → Quality
  Gate → PDF loop on the same project with the M13.6 fixes (experiment package
  auto-onboarding + academic metadata 429 recovery), diagnose and fix blocking
  engineering issues, and report honestly whether a Final is reachable.
- Author authorization used in this round: the **Dev25** (development split)
  scope of the main experiment group only. Confirmation13 / Full38 remain
  undecided (not injected into the workflow context). This is a writing-time
  authorization, not an external verification of the metrics.

## A. Checkpoint A — before the run (2026-10-10 18:40 local)

| Item | Result |
| --- | --- |
| Git | `main` @ `c9e826b` = `origin/main`, clean |
| Dev services | backend :3000 (Pi in-process runtime healthy), vite :5173, started fresh for this round |
| Experiment package | 1 package, schema **v2** already on disk, hash unchanged (`9fa6ff16…5bb8`), 25 files / 36 observations; `POST /ensure-upgraded` is a no-op (idempotent) |
| Scopes before | main@Dev25 / main@Confirmation13 / main@Full38 all `candidate` + `undecided`; `workflow-context` → 0 observations (confirms the M13.6 §1.1 finding on the live project) |
| Authorization | via the UI one-shot flow (checkbox + 「用于本文写作」) → `main@Dev25` = `confirmed` + `allowed`; other two scopes unchanged (`undecided`) |
| workflow-context after | **8 observations, all `split=Dev25`, groupId `main`, sourceId `S014` (data/overall_metrics.csv rows 2–3)**; values identical to the raw CSV inside the original ZIP |
| Source check | every observation `sourceId` exists in the project source index |
| Model | default `glm/claude-fable-5-1` (custom provider, anthropic-messages), maxTokens 65536, contextWindow 200000, reasoning on, thinkingRequest default; all 7 agents inherit the default; Test Connection ok (4.5 s) |
| Quality baseline (previous run `w-4addeb3593de`) | citation metadata 31 checked: 5 verified / 26 unverifiable; quality gate FAIL (unsupported claims 18, academicScore 40); Draft PDF 20 pages; no Final |
| New run | **`w-d678566b94c1`** started through the UI (「重新生成论文」), `idea_to_paper`, 2026-10-10T10:40:16Z |
| Monitoring | read-only observer outside the repo (SSE + seq de-dupe + reconnect, 15 s state poll, 30 s health/PID/RSS) |
| Private artifacts repo | `JiahongXu88/PaperTeam-RealPaper-Results`, verified `visibility: PRIVATE` before any push |

Early observation (first minutes of research): OpenAlex and Semantic Scholar
returned 429 on the initial parallel queries; the shared provider cooldown then
short-circuited subsequent queries for ~60 s instead of retrying (no request
storm). Crossref/arXiv continued.

## B. Checkpoint B — first real run terminal state (run `w-d678566b94c1`)

**Terminal: `completed` / label `draft`, Draft PDF `art-draft-rev9` (21 pages,
xelatex+bibtex, 0 diagnostics). Quality Gate: FAIL (honest). No Final.**

| Item | Result |
| --- | --- |
| Wall clock | 45 min 24 s (10:40:17Z → 11:25:41Z), of which ≈ 11 min waiting at 5 HITL gates |
| Agent time by phase | research 319 s · writing 398 s · review 451 s · revision 891 s · build 8.5 s |
| Model turns / tokens | 78 turns; output 171 653; cache read 3 006 702; cache write 912 241; fresh input ≈ 0.3 k (all `glm/claude-fable-5-1`); cost: NOT_AVAILABLE (provider returns cost=0) |
| Stages | 24 stage executions, 0 retries, 0 stage errors; 3 review/gate/revision rounds (r3–r5) then `hitl.revision_overflow` → `accept_draft` → `build.draft` |
| HITL decisions (all through the UI) | feasibility `approve` (level LOW, honest) · outline `approve` · evidence_supply `continue` · revision_validation r3 `approve` · revision_validation r4 **`reject`** (see fix 3) · revision_overflow `accept_draft` |

### B.1 Experiment-data path (M13.6 direction A) — verified on the live run

- Researcher report: no experimental numbers at all (neither Dev25 nor unauthorized).
- Feasibility: explicitly states only Dev25 (8 observations) is authorized and
  that Full38 is unauthorized and must not be quoted; level LOW with an
  honest `suggestedTargetAdjustment`.
- Outline/abstract: uses 79→67 and labels it "Dev25 主实验组" (the NB-11
  outline discipline now holds on the live project).
- Writer: results section contains exactly the 8 authorized values with the
  "作者确认、未经外部核验" qualifier; experimental-setup describes Dev25 as a
  project-internal split.
- Isolation: the final PDF contains **zero** occurrences of Confirmation13,
  Full38, 121, 87→ or 28.1 %. The workspace guard kept the Writer out of the
  unauthorized files.
- Revision r3 (rev 7) honestly downgraded the Full38-derived "bootstrap
  heterogeneity" assertion to a stated hypothesis; the fact-preservation guard
  flagged this as `placeholder_regression` / `dataset_split_changed`
  (keyword false positives — all 8 numbers were preserved). Approved after
  diff inspection; logged as follow-up NB-R2-1.

### B.2 Citation path (M13.6 direction B) — defect found

| Round | checked | verified | unverifiable (all `rate_limited`) |
| --- | --- | --- | --- |
| r3 (10:54Z) | 31 | 6 | 25 (crossref 22, openalex 3) |
| r4 (11:07Z) | 31 | 5 | 26 |
| r5 (11:19Z) | 31 | 11 | 20 |

- OpenAlex answered `Retry-After: 47128` s (≈ 13 h) → capped 120 s cooldown; Crossref
  and arXiv returned 429 without Retry-After → 10 s default cooldown. OpenAlex
  field fixes could not be exercised (provider unavailable for this host today).
- The M13.6 recovery pass logged "N 条限流条目等待 **0s** 后补查" in all three
  rounds and recovered nothing. Root cause (code): the wait was computed as
  `min` over *stale per-entry* `retryAfterMs` snapshots (the last entry failed
  with 12 ms left), not from the live cooldown registry; the pass was single-shot;
  the cooldown short-circuit is silent. See fix 1 (Checkpoint C).
- Improvement across rounds came only from cooldowns expiring between rounds.

### B.3 Quality path — honest FAIL, two engineering gaps found

Gate r5 reasons: unsupported claims 25 (opaque 27 counted), major 4 effective,
academicScore 54 (< 80), styleRisk 36 (> 35), feasibility LOW.

- **Gap A (fix 2):** the authorized Dev25 numbers themselves (results table,
  abstract, conclusion) are counted as *opaque unsupported* claims, and the
  claim-resolution contract would direct the Writer to **delete** them
  (`remove_unsupported_detail`). The existing "作者数据覆盖" exemption
  (`claimGapAudit`) only runs for existing-paper workflows and only sees
  `user_confirmed` Evidence, never the M13.5/M13.6 workflow context.
- **Gap B (fix 3):** revision r4 (rev 8) appended the Writer's per-item
  execution notes (markdown bullets such as `- f-…：…`, `- c-…：WEAKEN——…`) to
  the end of two section files. Fact preservation caught it (`added_number`),
  the only safe decision was `reject` (restore rev 7). The substantive r4
  edits (fixing the discussion's leftover bootstrap assertion) were lost with
  it, which is why two "discussion contradicts results" majors remain in r5.
- Remaining majors that are genuine research-material limits (not engineering):
  no ablation / fair baseline / reproducibility details (tracker, detector,
  hyper-parameters, Dev25 composition) in the authorized material; 0 verified
  literature evidence (79 pending candidates were not promoted this round).

## C. Checkpoint C — fixes and regression (commits `9606553`, `4247ad7`)

### C.1 Fixes (all with regression tests; backend typecheck clean)

| # | Area | Defect observed on run `w-d678566b94c1` | Fix | Tests |
| --- | --- | --- | --- | --- |
| 1 | citation (M13.6 §2) | recovery pass waited "0 s" (min over stale per-entry `retryAfterMs`), ran once, every re-query hit the silent cooldown short-circuit → 0 recovered in 3 rounds | `rateLimitRecovery.ts`: shared bounded multi-pass loop driven by the live `ProviderCooldownRegistry.earliestRecoveryMs()`, zero-progress guard, per-pass logs; used by `CitationService` and `CitationIntegrityService`. `ScholarlyHttpClient` provider pacing (`minRequestIntervalMs`; production arXiv 3 s / Crossref 1 s, test stack off). `citation-report.metadata` gains `byErrorKind` / `recovery` / `http`. Budget 60 s → 120 s | `rateLimitRecoveryLoop.test.ts` (10), existing `rateLimitRecovery` (9) + `scholarlyHttp` (12) green |
| 2 | review / quality | authorized Dev25 numbers counted as opaque UNSUPPORTED claims; claim resolution would direct the Writer to delete them | `claimGrounding`: disclosure `author_experiment_data` when all claim numbers are covered by workflow-context observations (numeric compare, letter-glued digits like `Dev25` ignored); not counted in rule 4, informational rule `author_experiment_data_reported`; `claimResolution` → `author_decision_required`. CONTRADICTED / partially covered claims unchanged; nothing becomes SUPPORTED | `authorExperimentDataClaims.test.ts` (5), `Gates.test.ts` (+1) |
| 3 | writer | revision appended per-item execution notes (markdown bullets) to section files → fact-preservation `added_number` → author forced to reject the round | `stripRevisionExecutionNotes` in `reviseSection` (also on-disk fallback path); deterministic, logged, never removes LaTeX lines | `revisionExecutionNotes.test.ts` (4, incl. the rev-8 sample) |

Full backend suite on the fix tree: 3044 passed / 3 failed → 2 pre-existing
SSE flakes (`sseCancelSemantics`, `httpWorkflowApi`; pass when run alone) + 1
pacing-induced 5 s timeout in `httpResources` (test stack now disables pacing;
fixed before commit). Second full run on the final tree: see Checkpoint D.

### C.2 Fix 1 validated on the real manuscript before any re-run

`POST /api/projects/:id/citation-check` on the same 31-entry bibliography with the
fixed backend (fresh cooldown registry):

| | run 6 r3 | run 6 r4 | run 6 r5 | after fix 1 |
| --- | --- | --- | --- | --- |
| verified | 6 | 5 | 11 | **22** |
| unverifiable (rate_limited) | 25 | 26 | 20 | 9 |
| recovery | 0 recovered | 0 | 0 | 1 pass, 18 retried, 9 recovered; 2nd pass fell 2 s outside the 60 s budget → budget raised to 120 s |

Telemetry: 63 requests, 7×429, 46 cooldown skips, 31 s pacing wait. OpenAlex
still returns `Retry-After ≈ 44 567 s` for this host; the OpenAlex field fixes
remain untested today (provider unavailable, not a code path failure).

### C.3 Re-run decision and the second defect found by the re-run

Criteria met (task §7.1): fix 2 changes the scientific-fact consumption path,
fix 3 changes revision behaviour, fix 1 changes citation outcomes. Backend
rebuilt on `4247ad7`; **run 7 `w-43cfc5703257`** started 11:41:43Z.

Run 7 exposed a fourth defect, specific to *re-running `idea_to_paper` on a
project that already has a manuscript* (exactly this task's scenario): the new
`outline.plan` / `writing.sections` commits rewrote the section files, and the
quality gate compared them to the previous run's final manuscript with
*revision* preservation rules → `fact_preservation` (22 findings — including
"TBD" = tracking-by-detection matched as a placeholder token) and
`citation_keys_preserved` (24 keys) failed; `judgeConvergence` saw the previous
run's rounds in iteration-history → REGRESSED → `SYSTEM_FAILED` →
`hitl.revision_stalled` with no revision attempted, and `build.draft` would have
refused the Draft (`FACT_PRESERVATION_FAILED`). Run 7 was cancelled at that gate
(31 min, 49 turns) — the only sane option.

| # | Area | Fix | Tests |
| --- | --- | --- | --- |
| 4 | workflow / quality (`0a5d832`, refined `560a8de`) | `isFreshDraftRewrite`: outline/writing commits of a run whose revision chain has records from *before* that run are "not comparable" for fact / citation preservation (first-run outline→writing keeps the existing visibility, which two CI e2e suites assert); `IterationRecord.runId` + `iterationsForRun` so convergence/outcome/delta are judged within the current run | `freshDraftPreservation` (7); `citationPreservationGate` / `factPreservationGate` e2e green |
| 5 | citation (`c3da2ef`) | providers whose `Retry-After` exceeds the cooldown cap (OpenAlex: 12–13 h) are marked unavailable; the recovery wait hint skips them (runs 7/8 lost 90–100 s per round waiting for OpenAlex) | `unavailableProvider` (3; unit-level only, not exercised by a live run) |

CI: `0a5d832` CI failed on the two preservation e2e suites (the first version of
fix 4 was too broad) → `560a8de` CI + Linux Integration green.

**Run 8 `w-00fb26766399`** started 12:14:45Z on `0a5d832` (fixes 1–4 live).

## D. Checkpoint D — final (run `w-00fb26766399`)

**Terminal: `completed` / label `draft`, Draft PDF `art-draft-rev15` (22 pages,
0 diagnostics). Quality Gate FAIL (honest, `QUALITY_NOT_REACHED`). No Final.**

| Item | run 6 (M13.6 code) | run 8 (all fixes) |
| --- | --- | --- |
| Wall clock / HITL wait | 45m24s / ≈11 min | 42m10s / ≈5 min |
| Turns · output · cache read · cache write | 78 · 171 653 · 3.01 M · 0.91 M | 104 · 151 815 · 6.02 M · 0.69 M |
| Stage errors / retries | 0 / 0 | 0 / 0 |
| Citation (cited → verified / rate_limited) | 31 → 6 / 25 (r3), 11 / 20 (r5) | 21 → **19 / 2** (both rounds; the 2 are OpenAlex-only) |
| Gate: opaque unsupported | 27 (incl. the Dev25 numbers) | 20 (literature only; Dev25 claim exempt as author data) |
| Gate: fact / citation preservation | n/a | not comparable for the fresh draft ✔ (no false SYSTEM_FAILED) |
| Gate: critical / major (effective) · score · styleRisk | 0 / 4 · 54 · 36 | 0 / 6 · 40 · 46 |
| Terminal classification at the stalled gate | QUALITY_NOT_REACHED (overflow) | QUALITY_NOT_REACHED (CONVERGED) |
| HITL | approve / approve / continue / **approve** / **reject** (leaked notes) / accept_draft | approve / approve / continue / **reject** (fabricated formulas) / accept_draft |

Run 8 observations:

- The Writer, asked by the plan for "method precision", **invented formulas and
  hyper-parameters** (a linear uncertainty radius, a linear gap bound, "匀速模型")
  that do not exist in the author's method notes; the fact guard flagged them
  (`formula_added`) and the revision was rejected (restore). This is the right
  guard behaviour; the Writer-side rule is logged as follow-up NB-R2-3.
- No execution-note leak in any run-8 revision (fix 3 had nothing to strip).
- Fix 2 exempted the authorized Dev25 results claim; the abstract in run 7 used
  rounded ranges (0.626–0.628) which are deliberately *not* exempted.
- Remaining gate blockers are research-material limits: 0 verified literature
  evidence (79 pending candidates were not promoted — an author action), no
  ablation / fair baseline / reproducibility details in the authorized package,
  Confirmation13 / Full38 unauthorized. The Draft states all of these as pending.

Three-run totals: output 401 921 tokens, cache read 10.84 M, cache write 1.90 M;
**cost NOT_AVAILABLE** (provider returns cost=0). Full backend suite on the final
tree: 3054 passed / 20 skipped / 3 failed = the pre-existing SSE timing flakes (`httpWorkflowApi` 409, `sseCancelSemantics` ×2, `orchestratorHardening` file-level) which pass when run alone (19/19). GitHub CI / Linux Integration on `c3da2ef`: CI **success** and Linux Integration **success** (both confirmed via the Actions API at 21:17 local; also green on `560a8de`).

### D.1 Delivery

- Public: `JiahongXu88/PaperTeam` main — code fixes 1–5 + tests + this report.
  Commits this round: `9875ee0`, `9606553`, `4247ad7`, `0d94aef`, `0a5d832`, `560a8de`, `c3da2ef`, plus the final report commit.
- Private (verified `visibility: PRIVATE` before every push):
  `JiahongXu88/PaperTeam-RealPaper-Results` — Draft PDFs rev9 (21 p) and rev15 (22 p),
  LaTeX snapshots, review / gate / claim-grounding / citation reports, run traces,
  HITL payloads, 18 UI screenshots, monitor data, run log and the private final
  report. Nothing from the private set is in the public repo.
- Local: `D:\Reports\PaperTeamRuns\RealPaperRound2\` (FINAL_REPORT.md, RUN_LOG.md, artifacts/, shots/, logs/).

### D.2 Verdict

| | |
| --- | --- |
| 原始项目复用 | yes — same project, no new project, historical runs kept |
| 实验包自动升级 | v2 already on disk; `ensure-upgraded` idempotent (verified) |
| Dev25 授权与来源核对 | yes — UI one-shot, provenance checked against the ZIP fact ledger |
| Confirmation13 / Full38 隔离 | yes — undecided; zero occurrences in all PDFs |
| Workflow Context | 8 Dev25 observations, re-verified before each run |
| Fable 模型与 Tool Calling | stable — 231 turns across 3 runs, no provider errors, no thinking-signature 400 |
| Research / Writing / Reviewer / Revision | all executed; Reviewer honest; Revision guarded (2 rejects were correct) |
| Citation Verification | 6/31 → 19/21 verified; remaining = OpenAlex ban (provider-side) |
| Quality Gate | FAIL (honest) both runs |
| Draft PDF | rev9 21 p, rev15 22 p (clean text, no leaked notes, no unauthorized scopes) |
| Final PDF | not produced (gate not passed; not forced) |
| Bugs fixed | 5 (+ test-stack pacing, CI refinement) |
| Re-runs | 2 (run 7 cancelled on a real defect; run 8 completed) |
| ENGINEERING_STABLE | true |
| EXPERIMENT_CONTEXT_VALID | true |
| RESEARCH_INTEGRITY_PRESERVED | true |
| WORKFLOW_COMPLETED | true (runs 6 and 8) |
| DRAFT_READY | true |
| PUBLICATION_READY | false |
| REAL_PAPER_ROUND2 | **PARTIAL** |
| PUBLIC_GITHUB_SYNCED | true |
| PRIVATE_ARTIFACTS_SYNCED | true |

Author decisions outstanding: Full38 / Confirmation13 authorization; promotion of
pending literature candidates; the missing experiments (E01–E11); method-detail
source material for the Writer (NB-R2-3).
