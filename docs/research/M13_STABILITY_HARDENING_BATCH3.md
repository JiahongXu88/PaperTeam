# M13 Stability Hardening Batch 3

Date: 2026-10-08. Baseline: `23fc30519c7aa8f9ece0706af484f98f1db4a4fb`, `main == origin/main`, clean worktree. `DATABASE_DECISION = NO_GO`.

## Audit scope and verdict

Read M13.0 assessment, M13.1 handoff, project status, `RevisionStore`, Figure insertion recovery, and followed the live API/workflow call paths for revision, external instructions, Source deletion, retrieval, and Evidence update. No real project data was modified. This is a code and isolated fixture assessment, not a claim that any user incident occurred.

| Level | Finding | Evidence and disposition |
| --- | --- | --- |
| P0 | Corrupt `revisions.json` was treated as empty state | `RevisionStore.load()` caught every error and returned revision 0. A subsequent commit could overwrite the authoritative registry. Now only ENOENT creates empty state; malformed data fails closed with `REVISION_STORE_CORRUPTED`. Fixture regression verifies original bytes remain. |
| P1 | Restore could leave a half restored Manuscript and no new revision | HTTP `POST /versions/:n/restore` and workflow validation rollback call the same store. Original code deleted files, copied snapshot files, then registered revision with no durable intent. Fixed with per-project restore intent, snapshot fingerprint verification, atomic per-file writes, preflight, restart completion and conflict detection. No historical snapshot is mutated. |
| P1 | Concurrent external instruction RMW could lose an opinion or state update | HTTP add/batch/remove and workflow dispatch/verification shared `external-instructions.json` without a queue. Fixed with per-project queue and recomputation on the latest records; the complex in-place planner update uses compare-and-merge, rejecting same-comment conflicts. |
| P1 | Bad external instruction JSON or resolution trace could be erased on the next write | `load()` swallowed all read/parse failures, and the defensive decoder omitted an invalid `resolutionTrace`. It now treats only ENOENT as empty and rejects invalid store structure, unreadable records or unreadable trace. |
| P1 | Ordinary revision commit could reuse a partial, unregistered `rev-N` snapshot | A failed copy leaves an orphan directory, and the next commit previously copied over it without removing extra files. A new guard only reuses an exact matching complete snapshot; otherwise it fails closed. A journal for ordinary commits remains future work. |
| P2 | Source deletion followed by explicit retrieval invalidation failure | HTTP catches invalidation failure. Source index is authoritative; every subsequent search compares its signature and reloads from current Source items, removing deleted chunks. Added a regression omitting explicit invalidation: zero ghost hits. Cleanup can be delayed; no new journal justified by this tested path. |
| P2 | EvidenceStore full-file rewrite | Only `updateVerification` API and workflow `markUsage` use update rewrites; M13.0 measured at most two records/2.8 KB in actual project data. `safeMarkUsage` is best-effort usage metadata, not evidence verification. No actual performance bottleneck observed; no event journal added. |
| P2 | SourceStore removes binary/derived files before saving the source index | Failure before index update can leave an indexed source with missing content. This is a distinct delete ordering issue; no fault injection of file permissions or disk failure was run here. Deferred for an isolated design that preserves provenance and supports retry of cleanup. |
| P3 | Reviewer round and stage audit raw writes | These are uniquely named or reconstructible artifacts, not authoritative revision/evidence registries. No mechanical replacement. |

Existing protections retained: Figure intent and lineage recovery; EvidenceStore unknown-line preservation; evidence promotion idempotency; revision patch rollback on validation failure; revision fingerprint deduplication; SourceInUse Evidence guard; checkpoint authority over asynchronous event logs. Cross-process writers remain outside the declared single-process deployment model.

## Restore design and behavior

`manuscript/restore-intent.json` is excluded from Manuscript fingerprint and snapshots. The intent is written atomically before the first destructive operation. It records the historical revision, base/target revision, target fingerprint, stable timestamp, and each worktree path's before/after SHA-256 (null means absent). The source snapshot must be nonempty and match the revision registry fingerprint before intent creation and on recovery. All worktree files are preflighted before recovery writes. Each write checks its original/target hash again; unexpected bytes or an extra file yield HTTP 409 `REVISION_RECOVERY_REQUIRED` and preserve those bytes. Per-file replacement, new revision snapshot copies, registry update and intent completion follow in order. The new snapshot is verified before registry registration. Atomic write temporary files for this sequence live under `manuscript/revisions/`, outside the worktree fingerprint. Windows rename retries are inherited from `util/atomic.ts`; no directory swap is assumed.

After interruption, `restore()` or `commit()` on a reconstructed Store can finish a pending intent. Read-only revision queries detect pending recovery and return a structured conflict instead of trusting a half restored tree. If the registry already contains the intended restore record, recovery only marks the intent complete and never overwrites subsequent worktree edits. Retrying the same restore after completion does not create another revision while the worktree still matches the source snapshot. An intentional later restore after further edits remains a new operation because the API has no request idempotency key.

Successful restore keeps the prior user-visible behavior: uncommitted worktree content is discarded as part of replacing the manuscript with the selected historical snapshot. The intent records hashes, not a backup of those bytes. A conflict after interruption requires human reconciliation; it does not silently revert post-failure edits. Historical snapshots are unchanged, and revision number/restoredFrom advance normally, so Review/Quality Gate staleness continues to use the existing revision check.

Limits: file hash preflight is not an atomic compare-and-swap against an unrelated process or editor; an edit occurring in the narrow check/write interval can still race. Power-loss durability of directory entries is not verified. Orphan atomic temp files under `revisions/` can remain after a kill, but cannot enter the fingerprint. No server restart or production workload was run.

## Fault injection and regressions

- Isolated Windows Vitest fixtures cover normal restore, missing/empty/corrupt snapshot, failure immediately after intent, after worktree deletion/replacement, after new snapshot copy, before registry commit, and after registry commit. Reconstructed Store retries complete exactly one new revision and preserve rev-1 bytes.
- Independent `vite-node` child is killed with `SIGKILL` after deletion, after file replacement, after new snapshot copy and after registry commit. Parent reconstructs Store from disk and verifies recovery and revision count. These are real process terminations, separate from injected `EIO` exceptions.
- Post-interruption external editing yields `REVISION_RECOVERY_REQUIRED`; `commit` is also blocked, and edited bytes and pending intent stay intact. Corrupt registry stays untouched. Orphan snapshot mismatch fails closed.
- Concurrent external instruction tests cover distinct adds, duplicate adds, add/remove, batch import plus status update, stale same-comment status conflict, and update plus add. Existing dispatch/closure workflow tests pass.
- Source retrieval test omits explicit invalidate after authoritative deletion and verifies no ghost chunk or indexed Source survives next search.

## Validation and handoff

Windows targeted tests: 9 files / 106 tests passed (single worker), including existing version restart, revision validation workflow, external instruction workflow, retrieval HTTP and new crash cases; a subsequent 2-file / 34-test run passed after adding the malformed trace regression, bringing the affected suite to 107 distinct passing cases. Backend typecheck, lightweight build and `git diff --check` passed. GitHub CI/Linux Integration are pending at this report revision. No local full Vitest, Docker build, model calls, LaTeX load, server start, SSH or real project writes.

Unverified: Linux filesystem behavior until CI, power-loss durability, multi-process writes, real external editor race, full workflow regression, Source deletion under forced I/O failure, large Evidence corpus. `SERVER_RESTART_REQUIRED_LATER` for production restart validation.

Next: isolate SourceStore delete ordering and retryable cleanup, then consider ordinary commit journaling if the partial-snapshot failure window is observed or a low-complexity design is proven. Reassess Evidence storage only when measured record count/frequency crosses M13.0's threshold. Git commits and final HEAD are recorded in the final task response; no server was started.
