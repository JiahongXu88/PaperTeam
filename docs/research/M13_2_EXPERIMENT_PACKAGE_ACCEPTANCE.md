# M13.2 Experiment Package Understanding — final acceptance

Date: 2026-10-08. Baseline: `3e91b2ea42b43d982b180157fbfb5f9133f70f7f`. Implementation source: `ed8bbceca1f5a23b8f57079f5c149b4a0df51238`. `DATABASE_DECISION = NO_GO`.

## Track A — ECS reliability acceptance

Server: Aliyun Singapore ECS `47.84.130.164`, Ubuntu 24.04, x86_64, 4 vCPU / 16 GiB RAM. SSH was made with the author's existing key path and strict host checking. The ED25519 fingerprint matched the previously trusted fingerprint `SHA256:plKQAp/U4N++DCdCJKfUfzPnKtGnfSjy/NxJX97SsnM`; no host verification bypass was used.

The preflight found a clean `main` checkout, healthy Docker Compose services, zero active workflows, eight projects, `127.0.0.1:8080` web binding, and an unexposed internal backend. The backend used the same named volumes throughout: `paperteam_paperteam-projects:/data/projects`, `paperteam_paperteam-runtime:/data/runtime`, and `paperteam_paperteam-hf:/data/hf-cache`. The `/data` ext4 disk remained mounted. No real project or model cache was removed.

The deployment advanced the server checkout to `ed8bbceca1f5a23b8f57079f5c149b4a0df51238` by fast-forward. Backend and Web were built sequentially, then only those two services were recreated. Final Docker health was healthy, `/health` returned `ok`, `/ready` returned true, Doctor reported all checks PASS, and active workflow count was zero. The isolated synthetic project was archived and deleted through the project API; the project count returned from nine to eight.

On ECS Linux, six targeted test files (110 tests) were run in a temporary checkout and isolated data root. SIGKILL recovery was exercised in child processes for Figure Append, Figure Replace and Revision Restore. Evidence forward-compatible unknown fields, concurrent External Instruction writes, and Source/Retrieval consistency suites passed. No production backend process was killed. The independent process-cut tests were not run inside the production Docker container.

| Gate | Result | Evidence |
| --- | --- | --- |
| Windows targeted M13 recovery suite | PASS | 7 files / 100 tests before package workflow integration |
| GitHub CI | PASS | Commit `ed8bbce`; build, typecheck, full test suite, Docker build, health, figure compile and persistence smoke |
| Linux Integration | PASS | Commit `ed8bbce`; native Docling full ingestion and Docling Docker lifecycle workflow |
| ECS Docker runtime | PASS | `ed8bbce`; Backend and Web healthy; loopback-only exposure retained |
| ECS isolated process interruption | PASS | Child-process SIGKILL recovery tests on host, temporary checkout and test data root |
| ECS data persistence | PASS | Package, confirmations, source mappings, dataset hash, Evidence and Figure persisted across backend container restart/recreation |
| ECS post-restart recovery | PASS | Existing package and figure endpoints served data after restart; no active user workflow interrupted |

### M13 recovery details

- EvidenceStore load/save preserved unknown fields in regression tests.
- Figure Append and Replace recovered after process interruption; lineage and Figure registry consistency were verified.
- RevisionStore restore recovered after interrupted writes; corrupt revision registry remained fail-closed.
- ExternalInstructionStore concurrent updates and Source/Retrieval index consistency passed the targeted Linux suites.
- Docker container restart was checked separately from child-process SIGKILL tests. No fault was injected into the live production Backend.

## Track B — Experiment Package acceptance

### Architecture and safety

A project-scoped manifest and original ZIP are stored under `experiments/<packageId>`. Package identity is archive SHA-256; duplicate upload is idempotent. The upload endpoint accepts bounded `application/zip` streams (16 MiB archive, 200 entries, 20 MiB per file, 64 MiB total inflated bytes, depth 8, compression ratio 100). ZIP entry metadata and CRC are validated before Source registration; file streams are bounded. Path traversal, absolute paths, drive paths, case/Unicode collisions, links/special files, encrypted entries, unsupported compression, malformed archives, extreme ratios, nested archive recursion, count and depth limits are handled explicitly. Archive code is never executed. Temporary files are cleaned on failure.

The implementation reuses SourceStore, IngestionService and existing parsers; it does not introduce a second general document parser. Original package hash, entry-relative path, file hash, Source ID, ParsedDocument block and table/JSON anchors are retained. Unsupported formats and parser failures remain visible in the manifest. The package is distinct from the literature library. Raw experiment sources are omitted from generic retrieval and literature prompt digests. Workflow labels are bounded and secret-like values are stripped; logs, configurations, notebook text, source code and arbitrary previews are not passed to the Researcher prompt.

Deterministic facts (paths, hashes, parsed values and anchors) remain separate from inferred roles and relations. Grouping is candidate-based and uses directory/name/config/table hints. Shared dataset names do not prove protocol compatibility. Conflicts remain visible and block confirmation. No aggregate selects the best seed or merges incompatible protocols. Unit and direction stay `unknown` when not established. Package import and author confirmation never create `grounded_verified` Evidence.

### Product and downstream integration

The Project page has an Experiment Packages workbench with ZIP upload, progress/error states, file inventory, parser status, role/group candidates, warnings/conflicts, metric preview, role/group edits and batch confirmation. Confirmed results link into existing Dataset/Figure APIs and the Evidence candidate flow. UI state distinguishes parsed, linked, author-confirmed and Evidence verification.

A bounded `GET /api/projects/:id/experiment-packages/workflow-context` returns up to 100 observations from current author-confirmed result groups with package/file/Source/block/cell or JSON-path anchors. `research.idea` consumes this structured context. Its prompt explicitly calls it untrusted author-provided experimental data, not externally verified Evidence. Raw logs and configuration text are excluded. The same integration is covered by a scripted Workflow test; no real model was invoked.

Evidence stays `user_confirmed` / `unverified` after author confirmation. A package metric alone is not Evidence verification. Experiment protocol and original source anchors remain available for review.

### ECS end-to-end synthetic fixture

The public synthetic normal fixture was uploaded as actual ZIP bytes through the running PaperTeam HTTP service to an isolated project. It produced nine visible entries; one Notebook parser failure was retained as a partial status instead of being presented as complete parsing. CSV and JSON parser output, group candidates, row/column anchors and author confirmations were accessible. HOTA `63.4` and IDF1 `76.0` were traced to `main/results.csv` row 2 columns D/E. No synthetic number is presented as a real research result.

The confirmed CSV was selected through the actual Dataset/Figure service (`datasetHash=9e5cb3a3407e61fc7408c2a91380cb893b5aa4e3794518e1f5ad71a7b3ab342a`). PaperTeam generated a real vector PDF (5,998 bytes, `%PDF-`), inserted it into `sections/results.tex`, and built the manuscript successfully with XeLaTeX. The Figure registry, insertion record, build record and Evidence status were still readable after backend restart/recreation. The author-confirmed Evidence record remained unverified. The temporary project was then deleted; the ECS returned to eight projects.

The end-to-end fixture used synthetic values. It exercised actual ZIP parsing, existing parsers, Source/Dataset/Figure services, real XeLaTeX and persistent storage. The earlier local integration harness used fake Figure/LaTeX compilers; that local harness is not counted as ECS compilation.

### Feature and test matrix

| Capability | Result | Limits / evidence |
| --- | --- | --- |
| ZIP upload and archive safety | PASS | Bounded streaming and malicious ZIP unit fixtures |
| Browser directory upload | NOT_IMPLEMENTED | ZIP is the supported complete path; users can zip a local folder |
| File inventory and existing parser reuse | PASS | CSV, JSON, YAML, logs/text and Notebook are visible; per-file failure is preserved |
| Role classification and experiment grouping | PASS | Conservative deterministic candidates; not a claim of universal semantic accuracy |
| Metric extraction and provenance | PASS | Numeric observations with source cell / JSON path; no inferred unit/direction |
| Config/result links and protocol conflicts | PASS | Matched and conflicting fields are exposed; no automatic merge |
| Author confirmation | PASS | Batch group confirmation; changes invalidate previous decisions |
| Source and Dataset integration | PASS | Canonical Source IDs, provenance and datasetHash are retained |
| Evidence boundary | PASS | User-confirmed status is not externally verified; no automatic grounding |
| Figure and manuscript integration | PASS | Real ECS PDF generation, insertion and XeLaTeX build on synthetic fixture |
| Workflow integration | PASS | Bounded confirmed-result context endpoint and `research.idea` stage test; ECS endpoint returned eight anchored observations after restart |
| Frontend tests | PASS | 31 files / 294 tests; component/integration level, not browser automation |
| Browser E2E | PENDING | CUA reported no available browsers or apps in this environment |
| Live model inference | NOT_VERIFIED | Deterministic understanding works without a model; no model call or token cost claimed |
| Real research data validation | NOT_VERIFIED | No lawful user dataset was available; only explicitly synthetic fixtures were used |

### Test fixtures and automated tests

Committed synthetic fixtures cover a normal main/baseline/ablation package, incomplete and ambiguous material, protocol conflicts, and malicious archive cases including traversal, drive paths, case/Unicode collision, symlink, extreme compression, nested ZIP, file count and depth. Fixture values are labelled synthetic.

Final local verification: Backend 263 test files, 2,909 passed / 19 skipped; Frontend 31 files, 294 passed; backend build and typecheck passed; `git diff --check` passed. The full GitHub CI and Linux Integration workflows for `ed8bbce` passed. The first CI attempt caught a pre-existing cancellation-test race; the test now waits until the fake runtime has entered the actual hanging call before cancellation. The full suite passed after that deterministic synchronization fix.

## Final status and limits

- Archive import supports ZIP, not direct browser directory selection.
- Understanding is deterministic and conservative; it does not infer arbitrary protocols reliably and has no LLM classifier.
- No numeric aggregation or cross-protocol comparison is automatic.
- Browser E2E and live model inference remain unverified. Component tests and deterministic service/Workflow tests are not represented as browser or live model tests.
- No genuine research materials were available for validation. Synthetic fixture outputs are not research evidence.
- Dockerfile Docling stage resolved Torch 2.14.1 and CUDA 13 libraries despite CPU-only hardware; deployment completed with about 38 GiB free on `/`. This is an image-size and rebuild-time risk; no global prune was run. The existing HF cache volume was preserved.
- No SQLite, PostgreSQL, Redis or object-storage system was introduced. `DATABASE_DECISION = NO_GO` remains in force.

Overall: **PASS for the stated implementation and synthetic ECS acceptance gates.** M13.2 is complete with the listed optional/unavailable checks clearly pending; this is not a validation of any real scientific finding.
