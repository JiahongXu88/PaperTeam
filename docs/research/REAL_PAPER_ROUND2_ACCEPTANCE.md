# Real Research Paper — Round 2 Unattended Acceptance (desensitized)

> Status: **IN PROGRESS** — this file is updated at the delivery checkpoints
> (A: before run start, B: first real run terminal, C: fixes + regression,
> D: task end). It contains engineering facts only. Manuscript text, LaTeX,
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

## C. Checkpoint C — fixes and regression

_pending — three fixes are implemented and unit-tested in the working tree
(see RUN_LOG in the private repo); full backend suite running; commit/push and
bounded re-run follow._

## D. Checkpoint D — final

_pending_
