# Toast Auto-Dismiss Bugfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three toast auto-dismiss regressions identified in commit `b95b5cf`.

**Architecture:** Keep the shared `useAutoDismiss` hook unchanged. Make each caller pass only transient state, clear caller-owned action state when its toast expires, and add the missing sidebar caller.

**Tech Stack:** React 19, TypeScript 5.8, Vitest 4, Testing Library

## Global Constraints

- Do not redesign the shared `Toast` component or add dependencies.
- Preserve persistent backup-load recovery UI.
- Expire an undo action with the toast that presents it.
- Modify only the affected callers and their tests.

---

### Task 1: Preserve backup-load errors

**Files:**
- Modify: `app/src/settings/SettingsView.tsx:23-30`
- Test: `app/src/settings/SettingsView.test.tsx`

**Interfaces:**
- Consumes: `useAutoDismiss(value, dismiss, ms?)`
- Produces: persistent `error` when `backups === null`, a working backup reload trigger, and transient restore errors when backups are loaded

- [ ] **Step 1: Write the failing test**

Import `act` and `fireEvent` from Testing Library and `MetadataBackup` from the library types. Change `afterEach(cleanup)` to restore real timers before cleanup. Add a test that rejects the first `listMetadataBackups` call, keeps the error visible for five seconds, clicks retry, resolves the second call, and renders the recovered empty state.

```tsx
afterEach(() => { vi.useRealTimers(); cleanup(); });

it("keeps backup load errors visible for retry", async () => {
  vi.useFakeTimers();
  let rejectBackups!: (error: Error) => void;
  let resolveRetry!: (backups: MetadataBackup[]) => void;
  const failed = new Promise<MetadataBackup[]>((_resolve, reject) => { rejectBackups = reject; });
  const retried = new Promise<MetadataBackup[]>((resolve) => { resolveRetry = resolve; });
  const gateway = createGateway();
  vi.mocked(gateway.listMetadataBackups).mockReturnValueOnce(failed).mockReturnValueOnce(retried);
  render(<LibraryProvider gateway={gateway}><SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} /></LibraryProvider>);
  fireEvent.click(screen.getByRole("button", { name: "안전" }));
  act(() => vi.advanceTimersByTime(0));
  await act(async () => { rejectBackups(new Error("backup failed")); await failed.catch(() => undefined); });
  act(() => vi.advanceTimersByTime(5_000));
  expect(screen.getByText("backup failed")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  act(() => vi.advanceTimersByTime(0));
  await act(async () => { resolveRetry([]); await retried; });
  expect(gateway.listMetadataBackups).toHaveBeenCalledTimes(2);
  expect(screen.getByText("사용할 수 있는 백업이 없습니다.")).toBeVisible();
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm.cmd test -- src/settings/SettingsView.test.tsx`

Expected: FAIL first because `useAutoDismiss(error, setError)` removes the error and retry button; after preserving it, FAIL because the button does not start a second request.

- [ ] **Step 3: Write the minimal implementation**

```tsx
const [backupRetryVersion, setBackupRetryVersion] = useState(0);
useAutoDismiss(backups === null ? null : error, setError);
// Include backupRetryVersion in the backup-loading effect dependencies,
// clear error on successful load, and increment the version from Retry.
```

- [ ] **Step 4: Run the test to verify GREEN**

Run: `npm.cmd test -- src/settings/SettingsView.test.tsx`

Expected: PASS.

### Task 2: Expire asset undo state with its toast

**Files:**
- Modify: `app/src/assets/AssetBrowser.tsx:32-42`
- Test: `app/src/assets/AssetBrowser.test.tsx`

**Interfaces:**
- Consumes: the existing `message`, `undoAssetIds`, and `useAutoDismiss`
- Produces: a stable dismiss callback that clears both states

- [ ] **Step 1: Write the failing test**

Change the existing cleanup hook to `afterEach(() => { vi.useRealTimers(); cleanup(); });`. Add an integration test that trashes an asset, advances five seconds, triggers an unrelated favorite error, and verifies that the old undo button does not return.

```tsx
it("expires the trash undo action with its toast", async () => {
  const user = userEvent.setup();
  const gateway = createGateway({ items: [asset(0)], nextCursor: null });
  vi.mocked(gateway.setAssetFavorite).mockRejectedValue(new Error("favorite failed"));
  renderBrowser(gateway);
  const tile = await screen.findByRole("option", { name: "asset-0.png" });
  await user.click(tile);
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "휴지통으로 이동" }));
  await act(async () => { await Promise.resolve(); });
  act(() => vi.advanceTimersByTime(5_000));
  fireEvent.doubleClick(screen.getByRole("option", { name: "asset-0.png" }));
  fireEvent.click(screen.getByRole("button", { name: "즐겨찾기 켜기" }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText("favorite failed")).toBeVisible();
  expect(screen.queryByRole("button", { name: "실행 취소" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm.cmd test -- src/assets/AssetBrowser.test.tsx`

Expected: FAIL because `undoAssetIds` survives the first toast and decorates the later error toast.

- [ ] **Step 3: Write the minimal implementation**

Move the auto-dismiss call below the undo state and pass a stable callback.

```tsx
const [undoAssetIds, setUndoAssetIds] = useState<string[] | null>(null);
const dismissMessage = useCallback((value: null) => {
  setMessage(value);
  setUndoAssetIds(null);
}, []);
useAutoDismiss(message, dismissMessage);
```

- [ ] **Step 4: Run the test to verify GREEN**

Run: `npm.cmd test -- src/assets/AssetBrowser.test.tsx`

Expected: PASS.

### Task 3: Auto-dismiss classification errors

**Files:**
- Modify: `app/src/classification/ClassificationSidebar.tsx:13-68`
- Test: `app/src/classification/ClassificationSidebar.test.tsx`

**Interfaces:**
- Consumes: the existing `message` state and `useAutoDismiss`
- Produces: five-second auto-dismiss behavior consistent with other transient mutation toasts

- [ ] **Step 1: Write the failing test**

Import `act` from Testing Library and change the existing cleanup hook to restore real timers before cleanup. Add a test that rejects classification creation, confirms the error appears, advances five seconds, and confirms it disappears.

```tsx
afterEach(() => { vi.useRealTimers(); cleanup(); });

it("auto-dismisses classification mutation errors", async () => {
  vi.useFakeTimers();
  let rejectCreate!: (error: Error) => void;
  const failed = new Promise<ClassificationEntry>((_resolve, reject) => { rejectCreate = reject; });
  const fixtureGateway = gateway();
  vi.mocked(fixtureGateway.createClassification).mockReturnValue(failed);
  renderSidebar(fixtureGateway);
  fireEvent.click(screen.getByRole("button", { name: "분류 추가" }));
  fireEvent.change(screen.getByLabelText("이름"), { target: { value: "Broken" } });
  fireEvent.click(screen.getByRole("button", { name: "추가" }));
  await act(async () => { rejectCreate(new Error("create failed")); await failed.catch(() => undefined); });
  expect(screen.getByText("create failed")).toBeVisible();
  act(() => vi.advanceTimersByTime(5_000));
  expect(screen.queryByText("create failed")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm.cmd test -- src/classification/ClassificationSidebar.test.tsx`

Expected: FAIL because the sidebar never schedules dismissal.

- [ ] **Step 3: Write the minimal implementation**

```tsx
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
// ...
useAutoDismiss(message, setMessage);
```

- [ ] **Step 4: Run the test to verify GREEN**

Run: `npm.cmd test -- src/classification/ClassificationSidebar.test.tsx`

Expected: PASS.

### Task 4: Verify and commit

**Files:**
- Include: the six implementation and test files above
- Include: `docs/superpowers/plans/2026-08-11-toast-auto-dismiss-bugfix.md`
- Exclude: existing unrelated workspace changes

**Interfaces:**
- Consumes: all three completed task changes
- Produces: verified frontend behavior and a focused Git commit

- [ ] **Step 1: Run full verification**

Run: `npm.cmd run check`

Expected: all Vitest tests pass and `tsc && vite build` exits successfully.

- [ ] **Step 2: Check the patch**

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 3: Commit only the requested files**

```powershell
git add -- docs/superpowers/plans/2026-08-11-toast-auto-dismiss-bugfix.md app/src/settings/SettingsView.tsx app/src/settings/SettingsView.test.tsx app/src/assets/AssetBrowser.tsx app/src/assets/AssetBrowser.test.tsx app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx
git commit -m "fix: complete toast auto-dismiss behavior"
```
