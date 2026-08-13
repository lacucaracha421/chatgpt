# Notification Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make temporary notifications dismissible and keep completed ingestion results from covering the interface indefinitely or overflowing with long text.

**Architecture:** Extend the existing `Toast` presentation API with an optional dismiss callback while leaving its existing five-second `useAutoDismiss` ownership in callers. Split each `WorkTray` row into a local component that owns only its eight-second terminal-state timer, including hover/focus pause state, and continues to remove work through the existing `dismissWork` callback.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, CSS, Heroicons

## Global Constraints

- Running ingestion work never auto-dismisses.
- Completed or failed work auto-dismisses after 8,000 milliseconds.
- Temporary Toast state continues to auto-dismiss after 5,000 milliseconds.
- Hover or focus pauses a work result timer and resumes the remaining duration.
- At most three skipped/failure details are visible; the rest use `외 N건`.
- Persistent load errors with retry controls do not auto-dismiss.
- No new dependency, global notification store, queue, history view, or ingestion performance work.

---

### Task 1: Dismissible, Truncated Toast

**Files:**
- Create: `app/src/shared/ui/Toast.test.tsx`
- Modify: `app/src/shared/ui/Toast.tsx`
- Modify: `app/src/styles/global.css`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/manga/MangaBrowser.tsx`
- Modify: `app/src/similarity/SimilarityReviewBrowser.tsx`
- Modify: `app/src/settings/SettingsView.tsx`
- Modify: `app/src/safety/TrashBrowser.tsx`

**Interfaces:**
- Consumes: existing `Toast` children/action props and each caller's state setter.
- Produces: `ToastProps.onDismiss?: () => void`, `.ui-toast__message`, and an `알림 닫기` button.

- [ ] **Step 1: Write the failing Toast behavior test**

```tsx
it("exposes the full truncated message and dismisses it", async () => {
  const onDismiss = vi.fn();
  const user = userEvent.setup();
  render(<Toast onDismiss={onDismiss}>very-long-notification-message</Toast>);

  expect(screen.getByText("very-long-notification-message")).toHaveClass("ui-toast__message");
  expect(screen.getByText("very-long-notification-message")).toHaveAttribute("title", "very-long-notification-message");
  await user.click(screen.getByRole("button", { name: "알림 닫기" }));
  expect(onDismiss).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd test -- --run src/shared/ui/Toast.test.tsx`

Expected: FAIL because `Toast` has no `onDismiss` prop or `알림 닫기` button.

- [ ] **Step 3: Implement the minimal Toast API and styling**

Add `onDismiss?: () => void`, wrap content in `.ui-toast__message`, preserve string content in `title`, and render the existing icon-sized `Button` with `XMarkIcon` only when the callback exists.

```tsx
const fullMessage = typeof children === "string" ? children : undefined;
<span className="ui-toast__message" title={fullMessage}>{children}</span>
{onDismiss && (
  <Button size="icon" variant="ghost" aria-label="알림 닫기" onClick={onDismiss}>
    <XMarkIcon aria-hidden="true" />
  </Button>
)}
```

Use CSS overflow instead of JavaScript string slicing:

```css
.ui-toast { min-width: 0; }
.ui-toast__message {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 4: Connect dismiss callbacks only to temporary Toast state**

Pass the matching clear function to temporary messages: `setMessage(null)`, `dismissMessage(null)`, `setCopyMessage(null)`, `setExtensionError(null)`, or `setError(null)`. Leave `currentFirstError`, `currentNextError`, backup-list load errors, and trash load errors without `onDismiss` because their retry/loading UI depends on the error state.

- [ ] **Step 5: Run the focused and affected tests**

Run: `npm.cmd test -- --run src/shared/ui/Toast.test.tsx src/assets/AssetBrowser.test.tsx src/settings/SettingsView.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```powershell
git add app/src/shared/ui/Toast.tsx app/src/shared/ui/Toast.test.tsx app/src/styles/global.css app/src/app/App.tsx app/src/classification/ClassificationSidebar.tsx app/src/assets/AssetBrowser.tsx app/src/manga/MangaBrowser.tsx app/src/similarity/SimilarityReviewBrowser.tsx app/src/settings/SettingsView.tsx app/src/safety/TrashBrowser.tsx
git commit -m "fix: make temporary notifications dismissible"
```

### Task 2: Expiring, Compact Work Results

**Files:**
- Modify: `app/src/ingestion/WorkTray.test.tsx`
- Modify: `app/src/ingestion/WorkTray.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: existing `WorkTrayProps.dismissWork(workId)` and terminal `IngestionWork | MetadataImportWork` states.
- Produces: per-row 8,000 ms terminal timer, `결과 닫기` button, three-detail limit, and `.work-tray__detail`/`.work-tray__overflow` presentation hooks.

- [ ] **Step 1: Write failing timer tests**

Add tests using fake timers that prove these independent behaviors:

```tsx
it("dismisses a completed result after eight seconds", () => {
  vi.useFakeTimers();
  const dismissWork = vi.fn();
  render(<WorkTray works={[work({ id: "done", status: "completed" })]} retryFailed={vi.fn()} dismissWork={dismissWork} openReview={vi.fn()} openExisting={vi.fn()} />);
  act(() => vi.advanceTimersByTime(7_999));
  expect(dismissWork).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(dismissWork).toHaveBeenCalledWith("done");
});

it("does not dismiss running work", () => {
  vi.useFakeTimers();
  const dismissWork = vi.fn();
  render(<WorkTray works={[work({ status: "running" })]} retryFailed={vi.fn()} dismissWork={dismissWork} openReview={vi.fn()} openExisting={vi.fn()} />);
  act(() => vi.advanceTimersByTime(8_000));
  expect(dismissWork).not.toHaveBeenCalled();
});
```

Add separate hover and focus tests: consume 3,000 ms, pause longer than 8,000 ms, resume, then verify dismissal only after the remaining 5,000 ms.

- [ ] **Step 2: Run timer tests and verify RED**

Run: `npm.cmd test -- --run src/ingestion/WorkTray.test.tsx`

Expected: FAIL because terminal work has no timer and interaction does not pause it.

- [ ] **Step 3: Implement one local row timer**

Extract the existing mapped row body into `WorkTrayRow` inside `WorkTray.tsx`. Keep `remainingMs`, `startedAt`, and the latest `dismissWork` callback in refs. An effect starts only for terminal work; cleanup subtracts elapsed time. Drive pause with `pointerInside || focusInside` and use `onPointerEnter`, `onPointerLeave`, `onFocus`, and `onBlur` on the row.

```tsx
const AUTO_DISMISS_MS = 8_000;
const remainingMs = useRef(AUTO_DISMISS_MS);
const startedAt = useRef(0);
const dismissRef = useRef(dismissWork);
dismissRef.current = dismissWork;

useEffect(() => {
  if (work.status === "running" || paused) return;
  startedAt.current = Date.now();
  const timer = window.setTimeout(() => dismissRef.current(work.id), remainingMs.current);
  return () => {
    window.clearTimeout(timer);
    remainingMs.current = Math.max(0, remainingMs.current - (Date.now() - startedAt.current));
  };
}, [paused, work.id, work.status]);
```

- [ ] **Step 4: Run timer tests and verify GREEN**

Run: `npm.cmd test -- --run src/ingestion/WorkTray.test.tsx`

Expected: timer, running, hover, and focus tests PASS.

- [ ] **Step 5: Write failing compact-result tests**

Render metadata work containing four combined skipped/failure details. Assert that the first three are present, the fourth is absent, `외 1건` is visible, the long detail has `.work-tray__detail` and its full text in `title`, and clicking `결과 닫기` calls `dismissWork`.

- [ ] **Step 6: Run compact-result test and verify RED**

Run: `npm.cmd test -- --run src/ingestion/WorkTray.test.tsx`

Expected: FAIL because all details render and the close control is a text button.

- [ ] **Step 7: Implement compact rendering and layout protection**

Slice combined skipped/failure details once:

```tsx
const details = [...work.skipped, ...work.failures];
const visibleDetails = details.slice(0, 3);
const hiddenDetailCount = details.length - visibleDetails.length;
```

Render the existing retry actions after details, replace header close text with an icon button labeled `결과 닫기`, and apply one-line ellipsis to headers, summaries, details, and item rows. Add `max-width: 100%` and `min-width: 0` to the grid children so long unbroken names cannot widen the fixed tray.

- [ ] **Step 8: Run WorkTray tests and verify GREEN**

Run: `npm.cmd test -- --run src/ingestion/WorkTray.test.tsx`

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```powershell
git add app/src/ingestion/WorkTray.tsx app/src/ingestion/WorkTray.test.tsx app/src/styles/global.css
git commit -m "fix: expire and compact ingestion results"
```

### Task 3: Full Verification

**Files:**
- Verify all modified files from Tasks 1 and 2.

**Interfaces:**
- Consumes: completed Toast and WorkTray behavior.
- Produces: verified frontend test and build evidence.

- [ ] **Step 1: Run the complete frontend test suite**

Run: `npm.cmd test -- --run`

Expected: 38 or more test files pass with zero failures.

- [ ] **Step 2: Run the production frontend build**

Run: `npm.cmd run build`

Expected: TypeScript and Vite exit with code 0.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff main...HEAD --check` and `git status --short`

Expected: no whitespace errors and no uncommitted production/test changes.
