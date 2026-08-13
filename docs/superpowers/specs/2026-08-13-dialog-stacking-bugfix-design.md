# Dialog Stacking Bugfix Design

## Goal

Ensure every shared dialog, including the fullscreen asset viewer, renders above all application content. Sidebar tree rows must remain dimmed by the dialog overlay instead of appearing brightly through it.

## Root Cause

The sidebar hierarchy refinement gives tree rows a local positive `z-index` so they render correctly against hierarchy connectors. The shared Radix dialog portal renders its overlay and content without an explicit layer order. Those dialog elements therefore do not reliably cover positioned application elements with a positive `z-index`.

## Design

- Add shared dialog layer tokens to the existing design-token set.
- Place the dialog overlay above ordinary application content.
- Place dialog content one layer above its overlay so it remains visible and interactive.
- Apply the same layer order to default and fullscreen dialogs through the shared dialog styles.
- Preserve the sidebar hierarchy layering, dialog markup, focus behavior, keyboard handling, and visual appearance.

## Alternatives Rejected

- Removing the sidebar row `z-index` risks regressing the hierarchy connector rendering it was introduced to support.
- Raising only the asset viewer would leave other shared dialogs vulnerable to the same stacking defect.
- Adding a new wrapper or component is unnecessary because the existing shared dialog styles are the correct boundary for this rule.

## Tests

- Add a regression check that the shared dialog overlay and content use the intended layer tokens.
- Keep the existing asset-viewer and shared-dialog behavior tests passing.
- Run the complete frontend test suite and production build.

## Scope

No sidebar redesign, overlay color change, animation, new dependency, or unrelated layering cleanup is included.
