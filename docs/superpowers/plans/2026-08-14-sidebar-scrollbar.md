# Sidebar Scrollbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the native classification sidebar scrollbar so it is subtle at rest and clearer during hover or drag interactions.

**Architecture:** Keep the sidebar's existing native scrolling and scope all changes to `.classification-sidebar` in the global stylesheet. Use standards-based Firefox properties plus Chromium/WebView pseudo-elements, reusing existing Lakomics color and radius tokens without JavaScript or a new component.

**Tech Stack:** CSS, React/Vite regression suite, Tauri desktop build

## Global Constraints

- Style only the scrollbar owned by `.classification-sidebar`.
- Use an 8px scrollbar with a transparent track.
- Use a low-contrast neutral thumb at rest and a higher-contrast neutral thumb during hover or drag.
- Chromium/WebView provides the hover and active states; Firefox uses the same low-contrast native thumb as a standards-based fallback because it does not expose equivalent thumb-state selectors.
- Reuse existing color and radius tokens; do not add gradients, shadows, accent color, dependencies, JavaScript measurements, or custom scroll synchronization.
- Do not change the gallery date scrollbar or scrollbars in settings, dialogs, and other panels.
- Do not add a brittle unit test for static pseudo-element CSS.

---

## File Structure

- Modify `app/src/styles/global.css`: add sidebar-scoped native scrollbar styling next to the existing `.classification-sidebar` layout rule.
- No new runtime or test files are required because this is a static, browser-native presentation change.

### Task 1: Style and verify the classification sidebar scrollbar

**Files:**
- Modify: `app/src/styles/global.css:595-608`

**Interfaces:**
- Consumes: existing `--color-sidebar`, `--color-muted`, and `--radius-sm` CSS tokens.
- Produces: native Firefox and Chromium/WebView scrollbar styling scoped to `.classification-sidebar`.

- [ ] **Step 1: Record the current stylesheet and application baseline**

Run:

```powershell
git diff --check
npm.cmd test -- --run
npm.cmd run build
```

Expected: the worktree has no whitespace errors, all frontend tests pass, and the production frontend build exits with code 0.

- [ ] **Step 2: Add the minimal sidebar-scoped CSS**

Add immediately after the existing `.classification-sidebar` rule in `app/src/styles/global.css`:

```css
.classification-sidebar {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--color-muted) 32%, transparent) transparent;
}

.classification-sidebar::-webkit-scrollbar {
  width: 8px;
}

.classification-sidebar::-webkit-scrollbar-track {
  background: transparent;
}

.classification-sidebar::-webkit-scrollbar-thumb {
  min-height: 32px;
  background: color-mix(in srgb, var(--color-muted) 32%, transparent);
  border: 2px solid transparent;
  border-radius: var(--radius-sm);
  background-clip: padding-box;
}

.classification-sidebar::-webkit-scrollbar-thumb:hover,
.classification-sidebar::-webkit-scrollbar-thumb:active {
  background: color-mix(in srgb, var(--color-muted) 68%, transparent);
  background-clip: padding-box;
}
```

Keep the existing layout declarations unchanged. The transparent border creates breathing room inside the 8px native gutter without changing sidebar padding.

- [ ] **Step 3: Verify the stylesheet and frontend regressions**

Run:

```powershell
git diff --check
npm.cmd test -- --run
npm.cmd run build
```

Expected: no whitespace errors, 39 frontend test files and 298 tests pass, and Vite completes the production build.

- [ ] **Step 4: Rebuild and visually inspect the desktop application**

Run:

```powershell
Get-Process -Name lakomics -ErrorAction SilentlyContinue | Stop-Process -Force
npm.cmd run tauri -- build --debug --no-bundle
Start-Process -FilePath 'C:\chatgpt\app\src-tauri\target\debug\lakomics.exe' -WindowStyle Hidden
```

In the running application, confirm:

- the sidebar scrollbar is 8px wide with no visible track;
- the idle thumb is subdued against `--color-sidebar`;
- hover and active states increase contrast without using the accent color;
- the scrollbar does not overlap folder labels or the resize handle;
- the gallery date scrollbar and other scrollable panels are unchanged.

- [ ] **Step 5: Commit the implementation**

```powershell
git add app/src/styles/global.css
git commit -m "style: refine sidebar scrollbar"
```
