# Lakomics Documentation Map

This directory contains current Lakomics references plus a small number of intentionally retained historical records.

## Read first

1. `../AGENTS.md` — repository workflow, safety boundaries, and document routing.
2. `../CONTEXT.md` — product vocabulary and domain boundaries.
3. `../DESIGN.md` — concise current design language.
4. `agents/pc-design-reference.md` — detailed current PC shell/content/interaction contract.
5. `adr/README.md` — architecture decision status index.
6. `roadmap/lakomics-backlog.md` — the living source for pending work.

## Current reference documents

- `agents/pc-design-reference.md` — Chrome 03b shell, Asset browsing, selection, floating surfaces, search, Works physicality, responsive/performance rules, and current implementation checkpoint.
- `agents/works-viewer-design.md` — type-specific Works presentation inside the shared PC design: manga shelf, game exhibit, video poster archive, Showcase.
- `agents/lakomics-works-handoff-v2.md` — Collection/Works product and architecture boundaries.
- `agents/domain.md` — how to resolve documentation/domain conflicts.
- `agents/implementation.md` — implementation/shared-UI rules, review scope, and verification evidence.
- `agents/cloud-capture.md` — Cloud Capture / sync architecture and known gaps.
- `agents/mobile.md` — Mobile direction and current checkpoint.
- `agents/mobile-consumption-ux.md` — approved Mobile Home/Library/viewer behavior.
- `edge-extension.md` — current bundled X Collector routing and Cloud Library behavior; `../extension/AGENTS.md` owns extension source rules.
- `agents/catalog-troubleshooting.md` — catalog transport/checkpoint behavior and rollout safeguards.
- `operations/pc-migration.md` — backup, recovery, credential portability, and PC migration.
- `research/reference-projects.md` — optional external-project research, not adopted implementation.
- `performance/online-catalog-query-regression-20260905.md` — measured Online Catalog query-plan/performance record.
- `operations/catalog-hybrid-count-gate.md` — retained CATALOG-007A native acceptance evidence.

## Execution tracking

Pending product/design work is tracked only in `roadmap/lakomics-backlog.md`. Do not create a competing design plan when an item already exists there.

The old `roadmap/works-collection-visual-redesign-plan.md` is retired. Its remaining actionable scope is already represented by LONG-002A, WORKS-001, LONG-002B, LONG-004 and related backlog entries.

## Source-of-truth order

Separate implemented facts from authority to change them.

1. Current checkout code, migrations, schemas, and type/contracts define the inspected implementation.
2. `AGENTS.md`, `CONTEXT.md`, and `DESIGN.md` define repository/product rules.
3. Accepted ADRs define active architecture constraints.
4. `agents/pc-design-reference.md` and relevant current subsystem references define stable UX/subsystem intent.
5. `roadmap/lakomics-backlog.md` describes planned/incomplete work; it does not prove implementation.
6. Git history is historical context only.

## Historical / superseded design records

- `agents/approved-design-direction.md` — superseded Lab 06 decision log pointer; current rules moved to `pc-design-reference.md`.
- `agents/approved-chrome-direction.md` — superseded Chrome 03b comparison/handoff pointer; current rules moved to `pc-design-reference.md`.
- `roadmap/works-collection-visual-redesign-plan.md` — retired implementation plan; do not execute it as a current plan.
- `prototypes/lakomics-works-v6-reference.html` — retained historical Works visual/interaction reference, not production code or current visual source of truth.

## Device research records

- `research/android-cloud-media-provider-poc-20260906.md` — Galaxy Tab S11 Android Photo Picker / custom `CloudMediaProvider` device PoC, album-filtering findings, ADB eligibility caveats, and the related temporary/one-use media inbox proposal. This is validated research evidence, not an adopted replacement for the current Mobile roadmap.
