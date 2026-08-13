# Settings Layout Refresh Implementation Plan

> **For agentic workers:** Execute inline; the user explicitly prohibited subagents. Steps use checkbox syntax for tracking.

**Goal:** Turn Settings into a compact desktop preference window without changing behavior.

**Architecture:** Keep one `SettingsView`; introduce semantic layout wrappers and reusable CSS classes for navigation, section headers, property rows, and list rows. Reuse existing shared controls and tokens.

**Tech Stack:** React, TypeScript, CSS, Vitest, Testing Library

## Global Constraints

- No new dependencies or components.
- Preserve every existing setting action and persistence path.
- Follow `DESIGN.md`: separators over cards, 4px spacing scale, restrained accent.

### Task 1: Semantic settings layout

**Files:** `app/src/settings/SettingsView.tsx`, `app/src/settings/SettingsView.test.tsx`

- [ ] Add a failing test for vertical navigation, active section, section heading, and property rows.
- [ ] Wrap navigation and content in a two-column body.
- [ ] Add section heading/description and normalize property rows while preserving labels and actions.
- [ ] Run the focused Settings test.

### Task 2: Compact desktop styling

**Files:** `app/src/styles/global.css`

- [ ] Replace top-tab styles with a vertical navigation list.
- [ ] Add a scrollable content pane, compact property rows, and separator-based backup rows.
- [ ] Verify narrow-window behavior collapses to a compact horizontal navigation strip.
- [ ] Run all frontend tests and the production build.
