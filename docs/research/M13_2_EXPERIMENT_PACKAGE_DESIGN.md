# M13.2 Experiment Package Understanding — design freeze

Date: 2026-10-08. Baseline: `3e91b2ea42b43d982b180157fbfb5f9133f70f7f` on clean `main`. `DATABASE_DECISION = NO_GO`.

## Existing boundaries

`SourceStore` owns content hashes and canonical `S###` IDs. `IngestionService` owns parsers and `ParsedDocumentStore`; CSV/XLSX/JSON/YAML/Notebook/text/image/code/PDF already have readers. `FigureService` projects parsed table/record blocks into datasets with `sourceId`, `blockId`, and `datasetHash`, and checks the current source again before compilation. Evidence verification is a separate state machine. An experiment package is an organizational artifact, not a reference paper and not verified evidence.

The existing LaTeX ZIP reader loads a `Buffer` and reads local headers. Its limits are insufficient for this entry point: it lacks duplicate Unicode/case-fold path rejection, symlink/special-file rejection, ratio/depth limits, and central-directory validation. Experiment upload will have a bounded raw request stream and its own strict ZIP validation; it will not raise the global JSON limit.

## Storage and state

`<project>/experiments/<packageId>/manifest.json` is the authoritative, atomically written record. `packageId` is derived from archive SHA-256; importing identical bytes is idempotent. The manifest contains schema version, original name, archive hash, timestamps, phase (`inventory`, `importing`, `understanding`, `ready`, `partial`), file entries, candidate groups/relations, observations, warnings, author decisions, and source mappings. Original ZIP bytes are retained under the package directory for a retry after interruption. Package records are project-scoped and serialized in-process. A corrupt manifest fails closed rather than appearing as an empty package.

An entry carries the exact relative path, file SHA-256, size, parser/status, optional canonical source ID, role suggestion with rationale and confidence, and optional author override. Source mappings are checked against current source hash when read or confirmed. Missing or changed sources invalidate their confirmations. The path is package metadata; Source IDs retain their existing rules. Files selected for parsing become Sources via `SourceStore.add` and `IngestionService.ingest`; unsupported files remain visible only in the package inventory. Identical file bytes across ZIPs may map to one canonical Source.

Archive acceptance is all-or-nothing for structural hazards. Per-file parser failures are recorded and do not discard other entries. Manifest phase is persisted before and after each mapping, so a retry can reconcile a source created just before a crash by its content hash. Derived groups and observations are recomputed from parsed sources; author decisions are applied after candidate generation and retain their explicit status. Atomic JSON writes prevent a half manifest from looking complete. No package file is executed.

## Understanding and truthfulness

Inventory path, hash, parser result, table cell, config field, and provenance are deterministic facts. File roles, cross-file relations, and protocol equivalence are suggestions with evidence, confidence and `needs_confirmation`. Path tokens (`main`, `baseline`, `ablation`, `config`, `logs`), structured field overlap (`model`, `dataset`, `seed`, `run`, `split`, protocol) and table headers drive conservative grouping. A shared dataset token alone never proves a shared protocol. Conflicts are explicit and prevent group confirmation. Metrics retain the original value and `sourceId`/`blockId` plus cell or JSON path. Units and optimization direction default to `unknown`; no best-seed selection, invented values, automatic comparison or evidence promotion.

Author confirmation is a batch action over selected groups, with explicit role/group edits for ambiguous entries. Confirmed means an author accepted the grouping and input use, not external verification. Confirmed numeric Sources are discoverable through existing Dataset/Figure APIs. Evidence remains an independent proposal and verification workflow; package import never writes `grounded_verified`.

LLM interpretation is optional and bounded. Deterministic import must work without a key. Model suggestions, if enabled, receive only size-limited redacted summaries, never raw ZIP/log/config content, and remain unconfirmed. Initial release may expose deterministic understanding while live-model inference remains `NOT_VERIFIED`; the acceptance report must not label it complete.

## HTTP and UI contract

`POST /api/projects/:id/experiment-packages` accepts `application/zip` as a bounded binary stream with `X-Package-Name`; `GET` lists packages; `GET /:packageId` returns manifest and current mapping validity; `PATCH /:packageId` edits roles/groups; `POST /:packageId/confirm` confirms selected groups. Limits: archive 16 MiB, 200 files, 20 MiB per file, 64 MiB total inflated, depth 8, compression ratio 100. Limits apply before extraction and while streaming. Structured 4xx errors distinguish unsafe archive, size limit, corrupt archive, and conflicting confirmations. Browser directory selection can submit the same logical file inventory in a later phase only if it has equally strong path and size controls; ZIP is the first complete upload route.

Project page adds an Experiment Packages tab for upload, file/group/metric inspection and batch confirmation. Confirmed dataset links enter the existing Figures tab; generation and manuscript insertion keep Figure truthfulness and recovery guards. UI labels distinguish parsed, linked, author-confirmed, and evidence-verified.

## Acceptance gates

Use three clearly synthetic fixtures: normal main/baseline/ablation, incomplete/ambiguous, and malicious ZIPs. Test structural safety, parser reuse, provenance, idempotency, interruption/restart, source drift, conflicting protocols, HTTP contracts, frontend states, and a generated PDF from an actual parsed fixture dataset. Windows/CI and ECS results are reported separately. ECS deployment requires verified SSH identity, clean server tree, no active workflow, localhost-only web binding, and preservation of volumes and local credentials.
