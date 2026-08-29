# Native Select Dark Popup Design

## Problem

Lakomics uses dark foreground colors on its shared native `Select`, but Windows WebView2 can render the opened native option popup with a light background. Unselected options then appear as light text on a light surface and become unreadable.

## Scope

- Apply the fix to every shared `Select` rendered through `.ui-select`.
- Preserve native select behavior, keyboard navigation, and accessibility.
- Do not change dropdown structure, option labels, application state, or filtering behavior.
- Do not add a custom dropdown component or dependency.

## Design

Declare `color-scheme: dark` on `.ui-select select` as the native control hint, and explicitly set `.ui-select option` to `background: var(--color-bg)` and `color: var(--color-text)`. The explicit option colors are required because Windows WebView2 can ignore the select's dark color scheme when painting the opened popup. Existing Lakomics spacing, borders, and toolbar arrow styling remain unchanged.

Applying the option colors at the shared `.ui-select` boundary is preferred over changing the root color scheme, which could alter unrelated native controls. Replacing the select with a custom popover is out of scope and would recreate keyboard and accessibility behavior unnecessarily.

## Verification

1. Add the shared native color-scheme hint and explicit option color declarations.
2. Run the existing shared-toolbar tests and production build.
3. Confirm in the debug app that all options in a shared toolbar select remain readable on a black native popup. This visual check is required because jsdom does not compute native `option` popup colors.

## Success Criteria

- Selected and unselected options are readable in the opened Windows/WebView2 popup.
- Every shared `Select` receives the correction without per-call-site changes.
- Existing select behavior and layout remain unchanged.
