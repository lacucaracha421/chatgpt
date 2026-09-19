# UI/UX Pro Max: provenance and Lakomics adaptation

Reviewed and adapted on 2026-09-19. This is a project-local instruction adaptation, not a full plugin installation or endorsement of all upstream recommendations.

## Candidate selection

GitHub repository metadata and the linked source documents were inspected on the review date. Stars are a time-specific popularity signal, not evidence of security, accessibility compliance, or measured effectiveness on Lakomics.

| Candidate | Observed repository stars | Observed scope and decision |
| --- | ---: | --- |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | 128,937 | Selected. MIT license, local searchable UX/stack guidance, existing reusable corpus in this checkout, non-archived, latest main commit dated 2026-09-19. Retain useful interaction/accessibility checks without its generic design-system generation workflow. |
| [anthropics/skills — frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | 177,090 | Repository-wide count, not the individual skill. Official Anthropic source; reviewed SKILL.md emphasizes intentional visual identity and critique. Less focused on detailed interaction/reference lookup. No content imported; its per-skill license was not evaluated for redistribution. |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | 69,061 | Repository metadata identifies Apache-2.0 and recent activity. README describes broad design commands plus installer hooks and a downloadable engine. Useful alternative, but its full runtime and extra product/design records are unnecessary here. No content, runtime, or hooks imported. |

Metadata sources: GitHub REST `/repos/nextlevelbuilder/ui-ux-pro-max-skill`, `/repos/anthropics/skills`, and `/repos/pbakaus/impeccable`. Candidate comparisons are bounded inspection, not comprehensive repository security audits. Unselected candidates were inspected at their current `main`; only the adopted source is pinned below.

## Adopted source

- Repository: [Next Level Builder UI/UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill).
- Inspected `main` revision: `de5f12b400775997d213524ef02a7c7d2746806f`.
- Instruction source: [`.claude/skills/ui-ux-pro-max/SKILL.md`](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/de5f12b400775997d213524ef02a7c7d2746806f/.claude/skills/ui-ux-pro-max/SKILL.md).
- License source: [`LICENSE`](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/de5f12b400775997d213524ef02a7c7d2746806f/LICENSE). Copyright (c) 2024 Next Level Builder. Terms retained in [LICENSE-UI-UX-PRO-MAX.txt](../LICENSE-UI-UX-PRO-MAX.txt).
- Local starting checkout: `fdd6c184cbd168935eef8a42759c6c77bdcdbdc0`. It already contained `.claude/skills/ui-ux-pro-max/SKILL.md`, `data/`, `references/`, and `scripts/`. The existing instructions and relevant local references were inspected before adaptation.

The pinned revision records the instruction/license source reviewed for this change. It does not claim every pre-existing local CSV, script, or reference is byte-identical to that upstream revision. Those resources are retained unchanged, including their existing provenance metadata and tests; this change does not refresh or recertify the entire corpus.

## Intentional changes

- Preserve accessibility, feedback, responsive layout, state clarity, performance, and narrowly targeted domain/stack lookup.
- Make existing Lakomics design references, shared UI, typography, and tokens the starting point, rather than generating a new visual system for each page.
- Replace broad aesthetic exploration with media-first dark-neutral archive guardrails, distinct selection/focus states, no tooltips, restrained motion, and type-specific Works presentation.
- Separate desktop density and keyboard interaction from Android touch targets, orientation, safe areas, and Back behavior. Do not confuse CSS pixels, points, and dp.
- Add explicit review-only versus implementation scope, authority/data-safety boundaries, and proportionate visual/behavioral verification.
- Remove required `--design-system`/persistence workflows, design dials, plugin-root environment assumptions, mandatory package/runtime setup, and generic SaaS fallbacks.
- Reuse the existing local corpus through optional repository-relative, non-persisting Python searches. Search results and upstream reference prose are subordinate recommendations, not authority to install packages or override product rules.

## Installation and maintenance

- Canonical instructions: [SKILL.md](SKILL.md).
- Claude discovery adapter: [`.claude/skills/ui-ux-pro-max/SKILL.md`](../../../.claude/skills/ui-ux-pro-max/SKILL.md). It loads the canonical instructions rather than maintaining a divergent copy.
- Supporting resources intentionally remain under `.claude/skills/ui-ux-pro-max/`. Install/share this through the repository, not by copying only the canonical directory if optional search is needed. The instructions and product references remain usable without Python.
- The separate pre-existing `.claude/skills/web-design-guidelines/` skill is unchanged. It is not part of this adaptation and is not automatically activated or made authoritative by it.
- No global configuration, plugin installer, network-on-use requirement, lifecycle hook, dependency, browser runtime, app code, production-data write, or Git write was added.
- Review upstream changes manually before porting them. Preserve local product and permission boundaries; record a new source revision and retain the license when adopting an update.
- Confirm `ui-ux-pro-max` in the next Zed conversation's available skill catalog. Files on disk establish installation, not runtime activation or improved design outcomes.
