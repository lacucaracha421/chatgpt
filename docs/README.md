# Lakomics Documentation Map

This directory maps current Lakomics references and retained historical records.
Start with the [repository overview](../README.md) for the product and applications.

Documentation reconciliation: 2026-09-09 against source commit `0c61206`. This records
source/document consistency, not new native acceptance or production verification.

## Application entry points

- [Desktop setup and behavior](../_tools/app/README.md): Windows and Linux Tauri application.
- [Linux platform setup and acceptance limits](operations/linux-desktop.md).
- [Android build, current source version and acceptance](../android/README.md).
- [Browser collector (active, `extension-list/`)](../extension-list/README.md). The older [collector overview](../extension/README.md) and [operation guide](edge-extension.md) describe the frozen legacy `extension/`.

Package-path reconciliation: 2026-09-12. The active desktop package and shared
mobile frontend are under `_tools/app/`, relative to the repository root.
Older dated records may still use `app/`; preserve those historical paths and
resolve present-day commands against the current package. This path update does
not renew older native acceptance or production verification results.

Current summaries and the living backlog take precedence over older dated rollout
paragraphs. Source version, built artifact, deployed service and installed client
are separate states; a dated test result only covers its recorded revision and inputs.

## Choose references by task

Applicable `AGENTS.md` instructions govern the work. Read the references needed
for the current task; this list is a map, not a mandatory reading sequence.

- `../CONTEXT.md` — product vocabulary and domain boundaries when behavior or terminology is affected.
- `../DESIGN.md` — current design language for visual changes.
- `agents/pc-design-reference.md` — PC shell, content, and interaction contracts for affected desktop UI.
- `adr/README.md` — architecture decision status when changing architectural boundaries.
- `roadmap/lakomics-backlog.md` — active pending work when checking priorities, recording a request, or resuming a tracked item.
- `roadmap/lakomics-completed.md` — completed/superseded/historical records; not an executable backlog.

## Current reference documents

- `agents/pc-design-reference.md` — Chrome 03b shell, Asset browsing, selection, floating surfaces, search, Works physicality, responsive/performance rules, and current implementation checkpoint.
- `agents/works-viewer-design.md` — type-specific Works presentation inside the shared PC design: manga shelf, game exhibit, video poster archive, Showcase.
- `agents/lakomics-works-handoff-v2.md` — Collection/Works product and architecture boundaries.
- `agents/domain.md` — how to resolve documentation/domain conflicts.
- `agents/implementation.md` — implementation/shared-UI rules, review scope, and verification evidence.
- `agents/cloud-capture.md` — Cloud Capture / sync architecture and known gaps.
- `agents/mobile.md` — Mobile direction and current checkpoint.
- `agents/mobile-character-contract.md` — implemented character read publication/API/mobile navigation, authority limits and verification evidence.
- `research/server-authority-model-audit-20260913.md` — current PC/server/mobile data mapping, character and Collection gaps, and server-authority transition design inputs; execution status lives in CLOUD-AUTH-001.
- `research/server-authority-v2-product-decisions-20260915.md` — confirmed Server Authority v2 product decisions, Android/mobile audit findings, and pre-design migration constraints; not an implementation plan.
- `research/server-authority-v2-pc-audit-20260915.md` — PC publication/recovery audit: stale-snapshot risks, local-vs-shared state, and safe retirement order.
- `adr/0037-server-authority-v2-replica-and-command-contract.md` — proposed common per-domain authority, client-replica/outbox, recovery and fence contract for the next CLOUD-POST-001 batches.
- `agents/mobile-consumption-ux.md` — approved Mobile Home/Library/viewer behavior.
- `edge-extension.md` — legacy `extension/` collector routing and Cloud Library behavior (frozen); the active collector is documented in `../extension-list/README.md`, with source rules in `../extension-list/AGENTS.md`.
- `agents/catalog-troubleshooting.md` — catalog transport/checkpoint behavior and rollout safeguards.
- `operations/linux-desktop.md` — Linux desktop setup, filesystem guarantees, system media tools, and platform limitations.
- `operations/pc-migration.md` — backup, recovery, credential portability, and PC migration.
- `research/pc-ui-design-decisions-20260923.md` — open PC UI consistency decisions and visual-direction proposals from the 2026-09-23 screenshot review; not approved design.
- `research/reference-projects.md` — optional external-project research, not adopted implementation.
- [Seed-first character automation and Jev evaluation direction](research/character-autonomy-and-jev-direction-20260921.md) — user automation requirements, source-verified constraints, corrected assumptions, and staged evidence/Jev experiments; research direction, not runtime activation or a second backlog.
- `research/character-classification-quiet-workflow-design-20260911.md` — approved quiet character workflow, parent-folder inference scope, reference curation, and normal-folder conversion.
- `research/character-reference-delta-reconsideration-design-20260911.md` — accepted batched reference expansion and delta-only historical reconsideration contract.
- `research/character-ingestion-flow-audit-20260912.md` — image arrival cases, character classification paths, failure visibility gaps, historical refresh coverage, and bottleneck candidates; diagnostic findings, not an implementation plan.
- `agents/issue-tracker.md` — backlog and explicitly requested GitHub Issue tracking boundaries.
- `performance/online-catalog-query-regression-20260905.md` — measured Online Catalog query-plan/performance record.
- `performance/desktop-navigation-20260912.md` — folder/tab/cover optimization changes, synthetic before/after measurements, targeted checks, and native acceptance limits.
- `operations/catalog-hybrid-count-gate.md` — retained CATALOG-007A native acceptance evidence.

## Execution tracking

Pending product/design work is tracked only in `roadmap/lakomics-backlog.md`. Completed/superseded records move to `roadmap/lakomics-completed.md`; that archive must not become a competing task list. Do not create a competing design plan when an active item already exists.

The old `roadmap/works-collection-visual-redesign-plan.md` is retired. Current actionable Works/AV scope is represented by active `WORKS-001` and `LONG-001`; completed presentation work is preserved in `roadmap/lakomics-completed.md`.

## Source-of-truth order

Separate implemented facts from authority to change them.

1. Current checkout code, migrations, schemas, and type/contracts define the inspected implementation.
2. `AGENTS.md`, `CONTEXT.md`, and `DESIGN.md` define repository/product rules.
3. Accepted ADRs define active architecture constraints.
4. `agents/pc-design-reference.md` and relevant current subsystem references define stable UX/subsystem intent.
5. `roadmap/lakomics-backlog.md` describes active planned/incomplete work; it does not prove implementation. `roadmap/lakomics-completed.md` preserves closure/history and is not a source of new authorization.
6. Git history is historical context only.

## Historical / superseded design records

- `agents/approved-design-direction.md` — superseded Lab 06 decision log pointer; current rules moved to `pc-design-reference.md`.
- `agents/approved-chrome-direction.md` — superseded Chrome 03b comparison/handoff pointer; current rules moved to `pc-design-reference.md`.
- `roadmap/works-collection-visual-redesign-plan.md` — retired implementation plan; do not execute it as a current plan.
- `prototypes/lakomics-works-v6-reference.html` — retained historical Works visual/interaction reference, not production code or current visual source of truth.

## Device research records

- `research/android-cloud-media-provider-poc-20260906.md` — Galaxy Tab S11 Android Photo Picker / custom `CloudMediaProvider` device PoC, album-filtering findings, ADB eligibility caveats, and the related temporary/one-use media inbox proposal. This is validated research evidence, not an adopted replacement for the current Mobile roadmap.

## Retained execution plans

Dated files under `research/` preserve original design, batch contracts and acceptance
evidence. They are not a second source of active task status or fresh authorization.
In particular, [the mobile catalog plan](research/mobile-catalog-execution-plan-20260908.md)
and [three-lane coordination record](research/parallel-roadmap-execution-20260908.md)
predate later Reader and deployment work. `MOBILE-006` is archived as completed; use the Android README for the current implementation and the active `CLOUD-AUTH-001` / `MOBILE-007` / `MOBILE-008` entries for remaining Mobile work.
Character batch records, video-similarity plans and AV/cover plans likewise retain
their recorded scope; consult the corresponding backlog item before resuming work.
