# Native Select Dark Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every shared native `Select` popup readable in Lakomics' dark Windows/WebView2 UI.

**Architecture:** Keep the native HTML select, retain its native dark color-scheme hint, and explicitly paint option foreground/background colors at the shared `.ui-select` CSS boundary. Verify the CSS through the existing shared-toolbar tests, compilation, and the real Windows/WebView2 popup because jsdom does not paint native option popups.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library, jsdom

## Global Constraints

- Apply the fix only through the shared `.ui-select` styling boundary.
- Preserve native select behavior, keyboard navigation, accessibility, structure, labels, state, and layout.
- Add no dependency or custom dropdown implementation.
- Do not commit unless the user explicitly requests it.

---

### Task 1: Shared native select dark popup

**Files:**
- Modify: `app/src/styles/global.css:414-433`

**Interfaces:**
- Consumes: `Select({ label, children, ...SelectHTMLAttributes<HTMLSelectElement> })`
- Produces: every `.ui-select select` advertises `color-scheme: dark`, and every contained `option` has the Lakomics dark background and text colors

- [x] **Step 1: Add the minimal shared CSS declarations**

Keep the existing `.ui-select select` dark color-scheme declaration and add:

```css
.ui-select option {
  color: var(--color-text);
  background: var(--color-bg);
}
```

- [x] **Step 2: Verify relevant frontend behavior and compilation**

Run: `npx vitest run src/assets/AssetToolbar.test.tsx`

Expected: the toolbar test file passes.

Run: `npm run build`

Expected: TypeScript and Vite production build pass; the existing chunk-size warning may remain.

- [x] **Step 3: Verify the actual debug app popup**

Run: `npm run tauri -- dev`

Expected: opening a shared toolbar select shows every selected and unselected option with readable contrast on a dark native popup.
