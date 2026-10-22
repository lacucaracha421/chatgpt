# Lakomics Documentation Map

Start with the [repository overview](../README.md) for the product and applications.
This map was reconciled on 2026-10-22 against `2e8db984`; it routes readers to retained
references without renewing their dated acceptance or deployment evidence.

## Start by task

| Task | References |
| --- | --- |
| Desktop setup | [Desktop package](../_tools/app/README.md), [Windows](operations/windows-desktop.md), [Linux](operations/linux-desktop.md) |
| Android | [Build and capabilities](../android/README.md), [mobile direction](agents/mobile.md), [consumption UX](agents/mobile-consumption-ux.md) |
| Browser capture, translation and picker | [Active Companion collector](../extension-list/README.md), [Cloud Capture](agents/cloud-capture.md) |
| Cloud and domain authority | [Capture and sync](agents/cloud-capture.md), [authority product decisions](research/server-authority-v2-product-decisions-20260915.md), [ADR index](adr/README.md) |
| Works and AV | [Product boundaries](agents/lakomics-works-handoff-v2.md), [presentation](agents/works-viewer-design.md), [server inbox](research/av-inbox-server-20261009.md), [person profiles](research/av-person-profile-edit-20261009.md) |
| Assets and characters | [PC design](agents/pc-design-reference.md), [quiet classification](research/character-classification-quiet-workflow-design-20260911.md), [mobile character contract](agents/mobile-character-contract.md) |
| Notes and ledger | [Accepted design](../DESIGN.md#notes-and-ledger-accepted-2026-10-02), [retained ledger contract](research/budget-notes-design-20260925.md) |
| Performance or recovery | [Measurement method](agents/implementation.md#performance-work), [catalog troubleshooting](agents/catalog-troubleshooting.md), [PC migration and recovery](operations/pc-migration.md) |

## Product, design and architecture

Read applicable repository instructions and only the references needed for the task.
Separate implemented facts from authority to change them:

1. Current code, migrations, schemas and contracts define the inspected implementation.
2. [Repository instructions](../AGENTS.md), [domain vocabulary](../CONTEXT.md) and [design language](../DESIGN.md) define repository and product rules. `DESIGN.md` §12 is the shared PC/tablet foundation; PC design comes first.
3. [Accepted ADRs](adr/README.md) define architecture constraints. Proposed ADRs, including ADR-0037, remain proposals within their stated scope.
4. [PC design](agents/pc-design-reference.md), [Works presentation](agents/works-viewer-design.md) and relevant subsystem contracts define stable intent. Dated implementation sections are evidence for their recorded checkpoint.
5. The [backlog](roadmap/lakomics-backlog.md) records intended work; the [completed ledger](roadmap/lakomics-completed.md) and Git history record closure and provenance.

See also [domain conflict resolution](agents/domain.md), [implementation and review](agents/implementation.md)
and [portable user preferences](agents/user-preferences.md).

## Subsystem contracts and retained research

- [PC responsibilities](agents/pc-required-features.md), [mobile character publication](agents/mobile-character-contract.md) and [manga index](agents/manga-index-contract.md).
- [Collection objects](research/collection-objects-design-20261004.md), [authority design](research/collection-authority-design-20260924.md) and [retained activation/runbook record](research/collection-authority-1b-plan-20261006.md). Consult current source and backlog before acting on dated batch sections.
- [Character reference deltas](research/character-reference-delta-reconsideration-design-20260911.md), [automation research direction](research/character-autonomy-and-jev-direction-20260921.md) and [mobile review design](research/mobile-character-review-design-20260924.md).
- [Release calendar](research/server-release-calendar-20261009.md) and [motion system](research/motion-system-20261004.md).

Research is scoped evidence or design input, not runtime activation or an execution queue.

## Operations and verification

Use the current [Windows](operations/windows-desktop.md), [Linux](operations/linux-desktop.md)
and [migration](operations/pc-migration.md) guides for commands and recovery boundaries.
The [PowerShell Rust-test wrapper](../scripts/cargo-test.ps1) is available when Git Bash
cannot start in the Windows sandbox.

Measurement kits: [native desktop](../_tools/app/scripts/native-check/README.md),
[frontend](../_tools/app/scripts/perf/README.md), [Android device](../android/tools/PERFORMANCE.md)
and [local API](../server/lakomics-api/tools/PERFORMANCE.md).
Static checks, frontend fixtures, native acceptance, device checks and production sync
are separate evidence levels. Source versions do not establish installed or deployed
versions. Historical recovery records do not authorize a backfill or catalog replacement.

## Prototype references

These are specimens, not production code or blanket approval of every alternative.
Shared design rules and current screen references take precedence.

- Foundation and core screens: [foundation](prototypes/design-foundation-20260928/), [calm Asset grid](prototypes/assets-calm-20261002/), [Find priority](prototypes/find-priority-20261013/), [Notes/ledger](prototypes/notes-ledger-20261002/), [section controls](prototypes/section-bar-20261001/).
- Recent screen rounds: [classic Home calendar](prototypes/home-calendar-classic-20261018/), [cards](prototypes/gacha-cards-20261013/), [card back/pack](prototypes/card-back-pack-20261015/), [shelves](prototypes/spine-shelf-20261017/), [picker panel](prototypes/picker-panel-ux-20261021/), [favourite characters](prototypes/fav-characters-20261022/), [tablet structure](prototypes/tablet-structure-20261017/).
- Retained with limited or uncertain applicability: [Collection shortcuts](prototypes/collection-shortcuts-20261001/) and [Home/Find alternatives](prototypes/home-more-find-20261002/). Their presence does not establish an active navigation or layout decision.

Other retained specimens remain under `prototypes/`; use their local notes and the
backlog to establish scope. Superseded bundles are indexed in the archive below.

## Work tracking, brand and history

The [backlog](roadmap/lakomics-backlog.md) is the single active work queue.
Completed, superseded and historical entries belong in the [completed ledger](roadmap/lakomics-completed.md),
with existing anchors preserved; neither dated plans nor the archive create new tasks.

The [brand guide](brand/README.md) distinguishes the selected identity and production
assets from retained design studies.

Use the [historical archive index](archive/README.md) for superseded guides, concluded
operations and measurements, executed research/plans and older prototype bundles.
Archive paths, commands and versions are intentionally dated and are not current guidance.
