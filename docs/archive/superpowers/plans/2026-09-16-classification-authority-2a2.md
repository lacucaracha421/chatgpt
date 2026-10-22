# Classification Authority 2A.2 Implementation Plan

> **For agentic workers:** Execute inline in the current checkout; repository rules prohibit subagents. Use TDD and preserve unrelated worktree changes.

**Goal:** Prepare digest-bound Classification activation and make all legacy Classification write/security paths authority-safe without activating production.

**Architecture:** Activation derives canonical Classification state only from the stored v2 staging snapshot inside one `BEGIN IMMEDIATE` transaction and creates epoch 1/cursor 0 atomically. While inactive, legacy behavior stays unchanged; after activation, snapshot publication is rejected, asset replication stops mutating Classification relations while continuing Asset replication, and security-sensitive capture/SAF membership reads use canonical authority state.

**Tech Stack:** FastAPI, Python sqlite3, existing ADR-0037 authority registry and Classification staging/authority modules.

**Spec:** `docs/adr/0037-server-authority-v2-replica-and-command-contract.md`

## Global Constraints
- Do not activate or deploy production in this task.
- Do not modify PC/Android consumers in this batch.
- Preserve unrelated manga worktree changes.
- No Git commit/push without separate authorization.

---

### Task 1: Digest-bound activation
- [x] Add failing integration tests for publisher-only activation, digest mismatch, v1 refusal, idempotent retry, and staged trash/unmaterialized assignments.
- [x] Add minimal activation parser/state import/route using the stored v2 snapshot and one write transaction.
- [x] Re-run focused activation tests.

### Task 2: Legacy write fences
- [x] Add failing tests proving active authority fences `PUT /v1/classifications` without changing staging state.
- [x] Add failing tests proving `POST /v1/replication/commit` still commits Asset metadata but cannot overwrite Classification relations after activation.
- [x] Implement the snapshot fence and conditional Classification-relation suppression; preserve inactive behavior.

### Task 3: Authority-aware security reads
- [x] Add failing tests proving SAF `/contains/` follows authority assignment/hierarchy instead of stale legacy tables after activation.
- [x] Add failing tests proving extension capture validation rejects a Classification deleted from authority even when the staged legacy projection still contains it.
- [x] Switch only these security-sensitive reads at active authority; keep inactive fallback unchanged.

### Task 4: Verification and ADR
- [x] Run focused cutover + Classification staging/authority + replication/mobile/capture suites.
- [x] Run the full server suite because `app.py` shared routes change.
- [x] Run `git diff --check` and update ADR with exact landed behavior/evidence.
