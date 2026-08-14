# Sidebar Scrollbar Design

## Goal

Make the classification sidebar scrollbar feel native to Lakomics' dark desktop interface without changing scrolling behavior or affecting other scrollable areas.

## Scope

- Style only the scrollbar owned by `.classification-sidebar`.
- Keep the existing native scrolling implementation.
- Support Chromium/WebView through `::-webkit-scrollbar` selectors and Firefox through `scrollbar-width` and `scrollbar-color`.
- Do not change the gallery's custom date scrollbar or scrollbars in settings, dialogs, and other panels.

## Visual behavior

- Use an 8px scrollbar so it remains easy to target without dominating the narrow sidebar.
- Keep the track transparent so it visually merges with `--color-sidebar`.
- Render the thumb with a low-contrast neutral color derived from existing design tokens.
- Increase thumb contrast when the user hovers over the scrollbar or drags the thumb.
- Use a small radius consistent with existing Lakomics controls; do not add shadows, gradients, or accent color.
- Reserve the native scrollbar gutter as it works today; do not add custom layout padding or JavaScript measurements.

## Implementation

Add the sidebar-specific scrollbar declarations next to the existing `.classification-sidebar` rule in `app/src/styles/global.css`. Reuse existing color and radius tokens with `color-mix`; do not introduce a component, dependency, or JavaScript scroll synchronization.

## Verification

- Do not add a brittle unit test for static pseudo-element CSS.
- Run the full frontend test suite and production frontend build to catch regressions.
- Rebuild and launch the Tauri desktop application, then confirm the idle, hover, and drag appearances in the real sidebar.
