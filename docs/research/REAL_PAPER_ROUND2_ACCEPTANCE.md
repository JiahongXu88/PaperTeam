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

## B. Checkpoint B — first real run terminal state

_pending_

## C. Checkpoint C — fixes and regression

_pending_

## D. Checkpoint D — final

_pending_
