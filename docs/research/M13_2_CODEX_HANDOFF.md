# M13.2 Codex handoff

Date: 2026-10-08. Branch `main`. Implementation source commit: `ed8bbceca1f5a23b8f57079f5c149b4a0df51238`. M13.2 acceptance verdict: implementation and synthetic ECS acceptance PASS; real research data and browser/live-model checks remain explicitly unverified or pending. `DATABASE_DECISION = NO_GO`.

## What shipped

- Project-scoped Experiment Package manifest and retained original ZIP. Import is hash-idempotent, atomic, bounded and resumable.
- ZIP safety checks for traversal, absolute/drive paths, duplicate normalized names, links/special files, encrypted/unsupported entries, CRC, nested archives, entry count/depth, per-file and total inflated size, compression ratio and raw upload size. Package code is never executed.
- Existing `SourceStore` → `IngestionService` → `ParsedDocument` parsers are reused. Source IDs and hashes, package paths, block IDs, cell and JSON path anchors remain available.
- Conservative role/group candidates, numeric observations, config/result relation hints and protocol conflicts. Ambiguity remains visible. No best-seed selection, invented data or automatic statistics.
- Project page Experiment Packages tab for ZIP upload, inventory, candidates, conflicts, metric preview, role/group edits, batch confirmation and Dataset/Figure/Evidence entry points.
- Confirmed result groups become available through existing Dataset/Figure APIs. `research.idea` consumes a bounded structured view at `GET /api/projects/:id/experiment-packages/workflow-context`; this context is current-source checked, limited to 100 observations, anchor-preserving, secret-filtered and excludes raw logs/configs/previews.
- Evidence remains `user_confirmed` / `unverified` until its existing verification workflow says otherwise. Figures retain dataset/spec/source truthfulness gates.

## Current production acceptance state

ECS `47.84.130.164` was deployed to `ed8bbce`; strict SSH host-key verification matched the author's previously trusted fingerprint. Backend/Web are healthy, web is bound to `127.0.0.1:8080`, backend is internal, named project/runtime/HF volumes are intact, Doctor PASS, `/health=ok`, `/ready=true`, zero active workflows and eight projects after test cleanup.

The synthetic normal ZIP was uploaded through actual ECS HTTP. One Notebook parser failure was visible as partial status. Confirmed result rows generated a 5,998-byte vector PDF and a successful XeLaTeX manuscript build. Package, workflow context, Figure and Evidence state survived backend container restart/recreation. No actual research dataset was supplied. Linux child-process SIGKILL tests were run in a temporary checkout/test root, never against production data or processes.

GitHub CI and Linux Integration passed on the implementation source commit. Backend local full suite: 2,909 passed / 19 skipped; Frontend: 294 passed. The first CI run exposed a race in the existing repair-loop cancellation test; `ed8bbce` waits for the mock runtime call to enter the hang before cancelling, and the full suite then passed.

## Limits to preserve

- ZIP is the complete upload route; direct directory selection is not implemented.
- No live LLM classification was added or called. Do not describe deterministic heuristics as universal understanding.
- Browser E2E was not run because no browser/app surface was available. Component tests are not browser E2E.
- Synthetic fixture values are test values, never real findings. No research conclusion can be inferred from them.
- `Experiment File ≠ Verified Evidence`; author confirmation remains `user_confirmed` / `unverified`, not `grounded_verified`.
- Metrics retain every observed row; do not select best seed or compare unknown units/directions/protocols.
- Preserve Docker port exposure: only loopback Web `127.0.0.1:8080`; do not expose unauthenticated Backend or Web publicly.
- Do not run `docker compose down -v`, volume deletion or global Docker prune. The Docling Docker image currently includes large CUDA dependencies and has a rebuild/storage cost.
- Do not introduce a database; `DATABASE_DECISION = NO_GO` remains active.

## Useful files

- Design freeze: `docs/research/M13_2_EXPERIMENT_PACKAGE_DESIGN.md`
- Final acceptance: `docs/research/M13_2_EXPERIMENT_PACKAGE_ACCEPTANCE.md`
- HTTP contract: `docs/API_CONTRACT.md`
- ZIP validation and package domain: `backend/src/experiments/`
- Project workbench: `frontend/src/components/project/`
- Synthetic and malicious ZIP fixtures: `backend/test/fixtures/experiments/`
- Main package integration tests: `backend/test/experiments/experimentPackages.test.ts`

## Suggested follow-up

Use an author-provided lawful real package for manual validation, add Playwright/browser E2E when a browser is available, and consider a separately bounded CPU-only Docling dependency build so code-only deploys do not resolve CUDA packages. Keep those as follow-ups; they were not silently treated as completed in this acceptance.
