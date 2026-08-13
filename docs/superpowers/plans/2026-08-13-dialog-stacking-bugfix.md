# Dialog Stacking Bugfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shared dialog overlay and content render above all ordinary application content so sidebar tree rows cannot appear brightly through the asset viewer.

**Architecture:** Keep stacking ownership in the existing shared dialog boundary. Add two semantic z-index tokens between the highest ordinary application overlay (`1100`) and floating menus (`1200`), then apply them to the shared overlay and dialog content.

**Tech Stack:** React 19, Radix Dialog, CSS custom properties, Vitest, Testing Library, jsdom

## Global Constraints

- Preserve sidebar hierarchy layering and behavior.
- Apply the fix to both default and fullscreen shared dialogs.
- Do not change overlay color, animation, dependencies, or unrelated layering.
- Keep floating menus above dialog content.

---

### Task 1: Shared Dialog Layer Contract

**Files:**
- Modify: `app/src/shared/ui/Dialog.test.tsx`
- Modify: `app/src/styles/tokens.css`
- Modify: `app/src/styles/global.css`
- Modify: `app/vite.config.ts`

**Interfaces:**
- Consumes: existing `.ui-dialog`, `.ui-dialog__overlay`, and `--z-floating-menu` CSS contracts
- Produces: `--z-dialog-overlay` and `--z-dialog-content` tokens used by the shared dialog styles

- [ ] **Step 1: Write the failing regression test**

Load the production token and global styles in `Dialog.test.tsx`, render an open dialog, and assert the browser-computed layer order:

```tsx
import "../../styles/tokens.css";
import "../../styles/global.css";

it("layers shared dialog content above its overlay and application content", async () => {
  const user = userEvent.setup();
  render(<DialogFixture />);
  await user.click(screen.getByRole("button", { name: "열기" }));

  const dialog = screen.getByRole("dialog");
  const overlay = document.querySelector<HTMLElement>(".ui-dialog__overlay");
  expect(overlay).not.toBeNull();

  const overlayLayer = Number(window.getComputedStyle(overlay!).zIndex);
  const dialogLayer = Number(window.getComputedStyle(dialog).zIndex);
  const floatingMenuLayer = Number(window.getComputedStyle(document.documentElement).getPropertyValue("--z-floating-menu"));

  expect(overlayLayer).toBeGreaterThan(1);
  expect(dialogLayer).toBeGreaterThan(overlayLayer);
  expect(floatingMenuLayer).toBeGreaterThan(dialogLayer);
});
```

This test catches removal or inversion of the shared layer ordering while allowing exact token values to change.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/shared/ui/Dialog.test.tsx`

Expected: FAIL because `.ui-dialog` and `.ui-dialog__overlay` currently compute to a non-numeric `z-index` (`auto`). If jsdom does not resolve custom properties through `z-index`, inspect the generated stylesheet and replace only the numeric extraction with a small test helper that resolves a `var(--token)` value from `document.documentElement`; keep the ordering assertions unchanged.

- [ ] **Step 3: Implement the minimal shared CSS fix**

Add the semantic tokens after the existing overlay-related tokens in `tokens.css`:

```css
--z-dialog-overlay: 1110;
--z-dialog-content: 1120;
```

Apply them in `global.css`:

```css
.ui-dialog {
  z-index: var(--z-dialog-content);
}

.ui-dialog__overlay {
  z-index: var(--z-dialog-overlay);
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- src/shared/ui/Dialog.test.tsx`

Expected: both shared dialog tests PASS with no warnings or errors.

- [ ] **Step 5: Run full frontend verification**

Run: `npm run check`

Expected: all Vitest tests PASS, TypeScript compilation succeeds, and the Vite production build exits successfully.

- [ ] **Step 6: Inspect the final diff**

Run: `git diff --check && git diff -- app/src/shared/ui/Dialog.test.tsx app/src/styles/tokens.css app/src/styles/global.css`

Expected: no whitespace errors; the diff contains only the regression test, two dialog layer tokens, and two shared dialog `z-index` declarations.

- [ ] **Step 7: Commit the bugfix**

```bash
git add app/src/shared/ui/Dialog.test.tsx app/src/styles/tokens.css app/src/styles/global.css docs/superpowers/plans/2026-08-13-dialog-stacking-bugfix.md
git commit -m "fix: keep dialogs above sidebar content"
```
