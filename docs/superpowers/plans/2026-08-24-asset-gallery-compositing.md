# Asset Gallery Compositing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the asset-loading sentence and prevent stale virtual-row imagery from showing through gallery gaps.

**Architecture:** Keep gallery virtualization and status state intact. Change only the status-bar presentation, retain the original virtual overscan, and paint each transformed gallery row plus its following vertical gap with the existing opaque background token.

**Tech Stack:** React 19, TypeScript 7, CSS, Testing Library, Vitest, Tauri/WebView2

## Global Constraints

- Keep `AssetBrowserStatus.loading` unchanged.
- Do not change pagination, date-rail behavior, virtual-row positioning, or image sizing.
- Use the existing `--color-bg` design token.
- Preserve unrelated working-tree changes.

---

### Task 1: Keep the status bar count stable during loading

**Files:**
- Modify: `app/src/layout/StatusBar.tsx:20`
- Test: `app/src/layout/AppShell.test.tsx:8-20`

**Interfaces:**
- Consumes: `AssetBrowserStatus.loadedCount` and the existing `loading` field.
- Produces: the leading status text `${loadedCount}개 자산` for both loading states.

- [x] Change the loading-state assertion to require `3개 자산` and reject `자산을 불러오는 중입니다.`.
- [x] Run `npm test -- --run src/layout/AppShell.test.tsx` and verify it fails on the old loading sentence.
- [x] Replace the conditional leading status text with `${status.loadedCount}개 자산`.
- [x] Run the same test file and verify it passes.

### Task 2: Make virtual-row gaps opaque

**Files:**
- Modify: `app/src/assets/AssetGallery.tsx`
- Test: `app/src/assets/AssetGallery.test.tsx`

**Interfaces:**
- Consumes: `.asset-gallery__row` and the existing `--color-bg` token.
- Produces: opaque transformed rows whose painted height includes the following gallery gap.

- [x] Assert that a rendered row has the opaque gallery background token.
- [x] Run the focused background test and verify the assertion fails before implementation.
- [x] Paint each virtual row with `var(--color-bg)` and extend its painted height through the following gallery gap.
- [x] Add a regression assertion for the vertical gap coverage and verify it fails before implementation.
- [x] Run `npm test -- --run src/assets/AssetGallery.test.tsx src/layout/AppShell.test.tsx` and verify both files pass without unhandled errors.
- [x] In the running Tauri development app, perform rapid wheel scrolling and date-rail dragging and inspect the gaps for stale imagery.

### Task 3: Record the verified implementation

**Files:**
- Commit only the status, gallery, CSS, and focused test files changed by this visual fix.

**Interfaces:**
- Consumes: the verified Task 1 and Task 2 changes.
- Produces: one local Git commit; no push or pull request.

- [x] Run `git diff --check` for the targeted files.
- [x] Commit with message `fix: stabilize asset gallery compositing`.
