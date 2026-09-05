# Lakomics Documentation Map

This directory contains only current or intentionally retained Lakomics documentation.

## Read first

1. `../AGENTS.md` — repository workflow, safety boundaries, and document routing.
2. `../CONTEXT.md` — product vocabulary and domain boundaries.
3. `../DESIGN.md` — current visual and interaction language.
4. `adr/README.md` — architecture decision status index.
5. `roadmap/lakomics-backlog.md` — living bugs, priorities, and future work.

## Current reference documents

- `agents/domain.md` — how to interpret repository documentation and resolve conflicts.
- `agents/implementation.md` — implementation/shared-UI rules, complete review scope, and verification-evidence reuse.
- `agents/cloud-capture.md` — current Cloud Capture / inbound-outbound sync architecture and known gaps.
- `agents/mobile.md` — Mobile direction and current checkpoint, with clearly labeled retained initial-rollout design and future native Android/file-picker work.
- `agents/mobile-consumption-ux.md` — approved, not-yet-implemented Mobile Home/Library, justified-row gallery, viewer-fit, state-continuity, and progressive media-loading design.
- `agents/lakomics-works-handoff-v2.md` — current Works / Collection product and architecture reference.
- `agents/works-viewer-design.md` — type-specific Works browsing/viewer presentation direction for manga shelves, game exhibits, and film/series poster archives.
- `agents/claude-ollama.md` — repository-local Claude Code + Ollama Cloud launcher notes.
- `agents/issue-tracker.md` — when to use the living backlog versus GitHub Issues.
- `edge-extension.md` — current bundled X Collector routing and Cloud Library behavior; `../extension/AGENTS.md` owns extension development/generation rules.
- `agents/catalog-troubleshooting.md` — catalog transport/checkpoint behavior, recorded deployment/canary results, and authorization/retained-backup safeguards for future operations.
- `operations/pc-migration.md` — backup, recovery, credential portability, and PC migration procedures; production writes require separate approval.
- `research/reference-projects.md` — optional external-project research, not adopted implementation or a second backlog.
- `performance/online-catalog-query-regression-20260905.md` — measured Online Catalog query plans, performance fix, and read-only benchmark reproduction.
- `operations/catalog-hybrid-count-gate.md` — CATALOG-007A exact prepared/routed COUNT evidence and current acceptance boundary; preserves the earlier stopped gate as history.
- `prototypes/lakomics-works-v6-reference.html` — retained Works visual/interaction reference only; not production code.

## Current execution plans

- `roadmap/works-collection-visual-redesign-plan.md` — staged PC Works / Collection visual redesign plan covering Manga Shelf Grid, Game Exhibit refinement, type-aware library tiles, Film/Series Video Works, and Showcase polish. Task status still belongs in the living backlog.

## Source-of-truth order

Separate implemented facts from authority to change them. Code describes what exists; it does not override user intent, repository safety rules, or authorization. Read only the documents relevant to the task. When sources disagree:

1. Current checkout code, migrations, schemas, and type/contracts define the inspected implementation. `main` is the integration baseline; include task commits and working changes when assessing ongoing work.
2. `AGENTS.md`, `CONTEXT.md`, and `DESIGN.md` define repository/product rules.
3. Accepted ADRs define active architecture constraints.
4. Current domain references under `docs/agents/` describe stable subsystem intent.
5. `docs/roadmap/lakomics-backlog.md` describes work that is planned, in progress, or intentionally deferred; it does not prove a feature is implemented.
6. Git history is historical context only.

## Intentionally retained records

- `roadmap/cloud-c004-investigation-handoff.md` — resolved, chronological CLOUD-004 investigation. Its original intermediate instructions/hypotheses are historical, not current execution steps.
- Dated results in `performance/online-catalog-query-regression-20260905.md`, migration/rollout evidence, ADRs, and the backlog's explicitly labeled legacy audit index remain records of their measured state.
- Older extension release/setup notes and `../extension/pc-app-patch/README.md` are version-specific references. Use `edge-extension.md` and the manifest for current behavior/version; do not reapply an incorporated patch.

Preserve these records. Add a current-status or supersession pointer when necessary rather than rewriting the past or treating completed rollout commands as authorization to repeat them.

## Historical plans

The old dated `docs/superpowers/plans/`, `docs/superpowers/specs/`, one-off acceptance notes, `feature-candidates.md`, and the previous `product-change-backlog.md` were useful during implementation but became duplicated and stale.

They are intentionally not kept in the current tree. Their full contents remain recoverable from Git history if historical rationale is needed. New long-lived decisions should be promoted into an ADR or a current reference document; new bugs and product ideas should go into the living roadmap instead of creating another parallel backlog.
