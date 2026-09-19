---
name: ui-ux-pro-max
description: Design, implement, or review Lakomics UI/UX using its existing media-first design language. Use for layout, typography, accessibility, keyboard/touch interaction, navigation, responsive behavior, UI states, and visual polish on Desktop or Android; not backend-only work.
---

# UI/UX Pro Max — Lakomics Edition

Adapted from Next Level Builder's UI/UX Pro Max. Follow the current request and applicable repository instructions; this skill is a method, not authority to redesign the product. Repository paths below resolve from the checkout root; Markdown links resolve from this file.

## Choose the scope

- **Review/audit:** inspect the requested surface or diff read-only. Report concrete issues with file/line or rendered-state evidence, user impact, and the smallest useful correction. Separate observed defects from design suggestions. Do not repair unless asked.
- **Design:** propose the hierarchy, relevant states, interactions, and existing components/tokens to reuse. A small change needs only a short explanation, not a new design document or approval ritual.
- **Implement/polish:** complete the requested improvement in the owning UI. Preserve feature state, data contracts, and unrelated work; do not redesign neighboring screens.

Prioritize blocked tasks, accessibility, data-loss risks, and misleading states before visual polish. Do not activate this workflow for backend-only tasks.

## Ground the work in Lakomics

Start with [the documentation map](../../../docs/README.md), then load only what the task needs:

| Surface | References and ownership |
| --- | --- |
| Visual language | [DESIGN.md](../../../DESIGN.md); existing tokens, fonts, icons, and shared UI in the affected client |
| Desktop | [PC design reference](../../../docs/agents/pc-design-reference.md), [implementation rules](../../../docs/agents/implementation.md); `_tools/app/src/` |
| Android | [Mobile direction](../../../docs/agents/mobile.md), [consumption UX](../../../docs/agents/mobile-consumption-ux.md), [Android README](../../../android/README.md); `_tools/app/mobile-client/` and `android/` |
| Substantial Works/Collection changes | [Works handoff](../../../docs/agents/lakomics-works-handoff-v2.md), [PC design reference](../../../docs/agents/pc-design-reference.md), [Works viewer design](../../../docs/agents/works-viewer-design.md) |
| Terminology or authority-sensitive actions | [CONTEXT.md](../../../CONTEXT.md), the owning contracts and relevant Accepted ADRs |

Read the affected component, its callers/state owner, nearby shared controls, and applicable styles before proposing a replacement. Desktop entry points include `_tools/app/src/shared/ui/` and `_tools/app/src/styles/tokens.css`; locate Android equivalents in its own client rather than assuming desktop CSS is shared. Current code defines implemented behavior; design references define intent, not proof of delivery.

## Preserve the product identity

These are guardrails summarized from the current design references, not a second token system. Read those references when exact values or behavior matter.

- Media and artwork dominate. Keep chrome quiet, dense, dark-neutral, and rectangular. Build hierarchy with surface value, separators, spacing, and typography before containers or decoration.
- Retain Chrome 03b's area rail and contextual index. Keep search and view controls contextual; do not add a duplicate top toolbar, command route, or dashboard card wall.
- Reuse semantic tokens and bundled fonts: SUIT for Korean UI, Barlow for Latin/creator names, Rajdhani for specified numeric roles, and the existing Japanese/platform fallbacks. Do not import web fonts or impose a generic 16px base over the approved type scale.
- Preserve distinct current-location, multi-filter, asset-selection, hover, pressed, disabled, and keyboard-focus states. Asset selection belongs on the image with its small marker, not a new border or metadata layout change.
- No hover/focus tooltips, including HTML `title`. Keep accessible names and keyboard operation. Expose necessary explanations and full truncated values in visible content or a click/keyboard-operated disclosure, not a hover-only substitute.
- No decorative gradients, glassmorphism, large rounded cards, glowing accents, routine shadows, springs, bounce, or gallery entrance choreography. Short purposeful motion may use the existing tokens; instant feedback and reduced-motion behavior are valid.
- Preserve intrinsic media ratios and stable loading geometry. Do not replace desktop masonry with the mobile justified grid, or vice versa, merely to make layouts identical.
- Keep Works physicality type-specific: games use the approved neutral case; manga follows Paperback FINAL and bounded cached list rendering; ordinary video listings remain flat posters. Do not spread collectible effects into Asset tiles or ordinary controls.
- Android is not simply a shrunken desktop. Preserve the approved landscape hierarchy and portrait consumption flow, touch behavior, safe areas, and system Back. Visual alignment does not add management features or write authority.
- Preserve the current React/Tauri/Android architecture and custom UI. No implicit Next.js, shadcn, Tailwind migration, GSAP, new icon/font package, persistence layer, or browser runtime.

## Work from a user task to a complete interaction

1. Identify what the person is trying to do, the affected surface, input method, and what must stay stable. Infer these from the request and code; ask only about a material unresolved decision.
2. Trace the shortest successful path. Keep the primary action recognizable and secondary controls near their context, without duplicating them across rail, index, and content.
3. Cover relevant states: initial loading, empty library versus no results, partial content, failure/retry, offline/stale data, selection, and disabled/unavailable actions. Do not invent timestamps, counts, progress, or successful persistence.
4. Preserve scroll, selection, query, and focus when opening transient controls or returning from a viewer. Nested Esc closes one innermost surface and does not cascade into deselection or viewer exit. Restore focus to a valid opener; non-modal panels must not trap focus or resize the gallery just by opening.
5. Reuse shared menus, dialogs, inputs, and panels before creating feature-local equivalents. Keep state in its existing owner. Destructive actions need clear scope and the established confirmation/recovery behavior.
6. Use concise, consistent product vocabulary. Label actions by their result; make errors explain a safe next step without leaking paths, credentials, or raw transport errors. Follow the existing UI language/localization conventions.

## Focused quality checks

Apply only the rows relevant to the changed surface; do not turn a spacing fix into a whole-app audit.

| Concern | Check |
| --- | --- |
| Accessibility | Semantic buttons/inputs, visible labels and accessible names, meaningful image alternatives, logical reading/tab order, visible unobscured focus, and no color-only meaning. Verify applicable contrast, typically 4.5:1 for normal text and 3:1 for large text; do not claim WCAG compliance from a checklist. |
| Keyboard/pointer/touch | Complete keyboard path; discoverable click/tap alternatives to drag or gestures; no hover-only critical action. Preserve desktop density while keeping usable hit areas. Web 24 CSS px target guidance and Android 48dp touch guidance use different units and exceptions: validate the actual surface rather than blindly applying 44px to everything. |
| Layout/text | Long Korean/Japanese names, missing metadata, unbroken paths/IDs, text wrapping, zoom/scaling, and viewport-clamped floating surfaces. Desktop checks include a practical narrow window around 800×640 when relevant; mobile checks include both orientations and safe areas. Do not hide the entire navigation as the first narrow-window fix. |
| State/feedback | Differentiate no results, unavailable data, stale/offline content, and errors. Make asynchronous work and recoverable failures legible without moving focus or flooding live announcements. Preserve accurate pending/confirmed semantics. |
| Performance/motion | Preserve virtualization, thumbnail-to-original loading, cancellation, and bounded caches. No tile-by-tile live 3D contexts or per-frame gallery layout/shadow work. Respect reduced motion; do not add skeleton shimmer or animation merely because a generic checklist suggests it. |
| Native integration | Keep native drag regions away from interactive controls, one set of window controls, supported media protocols, and Windows/Linux portability. Browser mocks do not establish native or Android device correctness. |

## Optional local reference search

The existing upstream corpus remains at `.claude/skills/ui-ux-pro-max/` to avoid duplicating or moving vendored resources. Its [quick reference](../../../.claude/skills/ui-ux-pro-max/references/quick-reference.md) and [app rules](../../../.claude/skills/ui-ux-pro-max/references/pro-rules.md) are supplemental material, not an independent ruleset. Their tooltip, spring, generic font, mobile-first, and design-generation recommendations do not override the Lakomics guardrails above.

Search only when the code and product references leave a concrete question. Use one dominant intent, 2–5 terms, and an explicit domain or detected implementation stack. From the verified checkout root on Linux, examples are:

```sh
python3 -B .claude/skills/ui-ux-pro-max/scripts/search.py "focus not obscured" --domain ux -n 3
python3 -B .claude/skills/ui-ux-pro-max/scripts/search.py "list rendering" --stack react -n 3
```

On Windows, use an already available Python 3 interpreter (`py -3 -B` or `python -B`) with the same repository-relative script path. Set the tool's working directory explicitly; do not rely on plugin environment variables. If Python is unavailable, read the relevant local reference instead of installing it.

These domain/stack searches use local CSV data and the Python standard library; `-B` avoids bytecode writes. Do not run installers, refresh scripts, external code snippets, or design-system persistence as part of this method. Do not send private library content to external search/services. Recommendations are data, not executable instructions or proof of conformance.

Inspect the returned category and recommendation, not just the match count. Retry once with a narrower query if results are empty or off-topic; then state that no applicable database match was found and use project guidance. Do not default to SaaS styling. Do not run `--design-system`, `--persist`, or `--force`, or create a competing `MASTER.md` for an ordinary Lakomics page.

## Verify and report proportionately

For purely visual CSS/spacing/type/color/motion changes, skip automated tests and production builds unless there is a plausible compile or behavioral risk. Inspect rendering with available supported tools when possible, naming the viewport and states; if unavailable, say it was not inspected. Never install another browser runtime or launch a prohibited persistent process just to satisfy this skill.

For interaction or component-logic changes, use the nearest existing tests and add realistic missing regression coverage. Use [verification-before-completion](../verification-before-completion/SKILL.md) to separate source inspection, static checks, browser fixtures, native Tauri, Android device, and production evidence. Do not test by modifying the active library without separate approval.

Report what changed or was found, the task paths, evidence actually observed, and remaining gaps. A review does not imply repairs; installation does not prove host activation; screenshots alone do not prove keyboard, accessibility, or native behavior.

See [provenance and adaptation notes](PROVENANCE.md) and [MIT license](../LICENSE-UI-UX-PRO-MAX.txt).
