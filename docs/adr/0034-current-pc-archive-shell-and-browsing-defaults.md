# ADR 0034 — Current PC archive shell and browsing defaults

**Status:** Accepted

**Supersedes:**
- `0013-justified-row-asset-gallery.md` as the exclusive/default PC Asset layout decision;
- `0026-icon-buttons-without-tooltips.md` as a universal prohibition on contextual icon tooltips.

## Context

The original PC UI assumed a conventional sidebar + persistent horizontal toolbar, justified rows as the normal Asset layout, and no icon tooltips. The 2026-09-05/06 design exploration and subsequent real-app redesign established a different stable desktop model.

Keeping the old ADRs marked Accepted makes current code and current design documentation contradictory.

## Decision

- The PC shell uses the Chrome 03b left-centric structure: narrow area rail, persistent contextual index, and media-first content area. A permanent old-style horizontal toolbar is not required.
- Asset browsing defaults to date-grouped masonry/waterfall with creator + `HH:mm` below each asset. Justified rows remain an available alternative layout.
- Search is icon-first and only connects to screens with a real search contract.
- Temporary view controls may use anchored non-modal panels when that keeps content geometry stable.
- Short, non-interactive tooltips are allowed for ambiguous explicit PC shell icon controls. Accessible names remain mandatory; tooltips are not required on every button.
- Feature state remains owned by the relevant browser/preferences layer. Shell rearrangement does not authorize new persistence or domain merging.

## Consequences

`DESIGN.md` and `docs/agents/pc-design-reference.md` define the current detailed UI rules. The superseded ADRs remain historical records and must not be used to revert the current shell or Asset default.

This ADR changes UI/navigation defaults only. It does not change Asset/Classification/Album/Collection ownership, provider behavior, file lifecycle, or Mobile design.
