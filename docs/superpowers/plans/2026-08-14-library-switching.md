# Library Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users open a different Lakomics library from Settings while preserving the current library on cancellation or failure.

**Architecture:** Keep library opening centralized in `LibraryProvider`, but make failed opens non-destructive when a library is already active. Settings owns the native picker and calls the context operation; `LibraryScreen` keys the workspace by `library.root` so a successful switch resets all library-scoped UI state through a normal React remount.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Tauri dialog plugin, Rust/Tauri regression suite

## Global Constraints

- Add `다른 저장소 열기` only to Settings → General beside the current library path.
- Canceling or failing a switch must preserve the current library and its visible path.
- Persist a path only after `gateway.openLibrary(path)` succeeds.
- A successful different-root switch must remount the library workspace and reload library-scoped data.
- Disable duplicate switch actions while selection/opening or Settings maintenance is pending.
- Reuse `LibraryProvider.openLibrary`, `commandErrorMessage`, the existing native directory picker, and shared buttons; add no dependencies.
- Do not move, copy, or delete library files.
- Do not add recent-library history or migrate origin-scoped `localStorage` in this change.

---

## File Structure

- Modify `app/src/library/LibraryContext.tsx`: preserve an active library when a new open fails.
- Create `app/src/library/LibraryContext.test.tsx`: verify successful initialization and non-destructive failed switching through the public context interface.
- Modify `app/src/settings/SettingsView.tsx`: add the General-section picker action, pending state, and switch error display.
- Modify `app/src/settings/SettingsView.test.tsx`: cover cancellation, success, failure, and pending-button behavior.
- Modify `app/src/app/App.tsx`: key `LibraryWorkspace` by the active library root.
- Modify `app/src/app/App.test.tsx`: prove a different-root switch remounts and reloads the workspace.

### Task 1: Preserve the current library when a switch fails

**Files:**
- Create: `app/src/library/LibraryContext.test.tsx`
- Modify: `app/src/library/LibraryContext.tsx:29-42`

**Interfaces:**
- Consumes: `LibraryGateway.openLibrary(path): Promise<LibrarySummary>`.
- Produces: unchanged `openLibrary(path): Promise<void>` context API with non-destructive failure semantics.

- [ ] **Step 1: Write a failing context regression test**

Create a test probe that renders `library?.root`, `error`, and a button calling `openLibrary("D:\\Broken")`. Initialize `localStorage["lakomics.libraryPath"]` to `C:\\Current`, resolve the first gateway call with `{ root: "C:\\Current" }`, and reject the second with `new Error("switch failed")`.

```tsx
function Probe() {
  const { library, error, openLibrary } = useLibrary();
  return <>
    <span>{library?.root ?? "none"}</span>
    {error && <span role="alert">{error}</span>}
    <button onClick={() => void openLibrary("D:\\Broken")}>switch</button>
  </>;
}

it("keeps the current library when opening another library fails", async () => {
  localStorage.setItem(LIBRARY_PATH_STORAGE_KEY, "C:\\Current");
  const libraryGateway = gateway();
  vi.mocked(libraryGateway.openLibrary)
    .mockResolvedValueOnce({ root: "C:\\Current" })
    .mockRejectedValueOnce(new Error("switch failed"));
  render(<LibraryProvider gateway={libraryGateway}><Probe /></LibraryProvider>);

  expect(await screen.findByText("C:\\Current")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "switch" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("switch failed");
  expect(screen.getByText("C:\\Current")).toBeVisible();
  expect(localStorage.getItem(LIBRARY_PATH_STORAGE_KEY)).toBe("C:\\Current");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd test -- --run src/library/LibraryContext.test.tsx
```

Expected: FAIL because the catch branch currently calls `setLibrary(null)` and the probe renders `none`.

- [ ] **Step 3: Implement the minimal context fix**

Remove the destructive state reset from the catch branch while retaining the established error mapping:

```tsx
      } catch (error) {
        setError(commandErrorMessage(error, "라이브러리를 열 수 없습니다."));
      }
```

An initial failure remains on the setup screen because `library` is already `null`; an active library remains mounted because no replacement state is committed.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm.cmd test -- --run src/library/LibraryContext.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add app/src/library/LibraryContext.tsx app/src/library/LibraryContext.test.tsx
git commit -m "fix: preserve library after failed switch"
```

### Task 2: Add the Settings library picker action

**Files:**
- Modify: `app/src/settings/SettingsView.tsx:18-145`
- Modify: `app/src/settings/SettingsView.test.tsx`

**Interfaces:**
- Consumes: `useLibrary().openLibrary(path): Promise<void>`, `useLibrary().error`, and Tauri `open({ directory: true, multiple: false, defaultPath })`.
- Produces: `다른 저장소 열기` button and a Settings-local `switchingLibrary` pending state.

- [ ] **Step 1: Write failing cancellation and success tests**

Add tests that initialize the current library through `localStorage`, wait for `C:\\Current`, and use the existing mocked Tauri `open` function:

```tsx
it("keeps the current library when switching is cancelled", async () => {
  localStorage.setItem("lakomics.libraryPath", "C:\\Current");
  const gateway = createGateway();
  vi.mocked(gateway.openLibrary).mockResolvedValue({ root: "C:\\Current" });
  vi.mocked(open).mockResolvedValue(null);
  render(<LibraryProvider gateway={gateway}><SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} /></LibraryProvider>);

  await screen.findByText("C:\\Current");
  await userEvent.click(screen.getByRole("button", { name: "다른 저장소 열기" }));

  expect(open).toHaveBeenCalledWith({ directory: true, multiple: false, defaultPath: "C:\\Current" });
  expect(gateway.openLibrary).toHaveBeenCalledTimes(1);
});

it("opens a selected library and disables duplicate switching while pending", async () => {
  localStorage.setItem("lakomics.libraryPath", "C:\\Current");
  const gateway = createGateway();
  let resolveSwitch!: (summary: { root: string }) => void;
  vi.mocked(gateway.openLibrary)
    .mockResolvedValueOnce({ root: "C:\\Current" })
    .mockReturnValueOnce(new Promise((resolve) => { resolveSwitch = resolve; }));
  vi.mocked(open).mockResolvedValue("D:\\Next");
  render(<LibraryProvider gateway={gateway}><SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} /></LibraryProvider>);

  const button = await screen.findByRole("button", { name: "다른 저장소 열기" });
  await userEvent.click(button);
  expect(button).toBeDisabled();
  resolveSwitch({ root: "D:\\Next" });
  expect(await screen.findByText("D:\\Next")).toBeVisible();
});
```

- [ ] **Step 2: Run the focused Settings tests and verify RED**

Run:

```powershell
npm.cmd test -- --run src/settings/SettingsView.test.tsx
```

Expected: FAIL because the `다른 저장소 열기` button does not exist.

- [ ] **Step 3: Implement the picker and pending behavior**

Read `error` and `openLibrary` from context, add `switchingLibrary` state, and add this operation:

```tsx
  async function chooseLibraryFolder() {
    if (switchingLibrary || pending || metadataImportRunning) return;
    setSwitchingLibrary(true);
    try {
      const selected = await open({ directory: true, multiple: false, defaultPath: library?.root });
      if (typeof selected === "string") await openLibrary(selected);
    } finally {
      setSwitchingLibrary(false);
    }
  }
```

Render the action and error in the General library property:

```tsx
        <dl className="settings-view__property">
          <dt>라이브러리 폴더</dt>
          <dd className="settings-view__path">{library?.root ?? "열리지 않음"}</dd>
          <Button size="sm" disabled={switchingLibrary || pending || metadataImportRunning} onClick={() => void chooseLibraryFolder()}>
            {switchingLibrary ? "여는 중…" : "다른 저장소 열기"}
          </Button>
          {error && <dd className="settings-view__row-message" role="alert">{error}</dd>}
        </dl>
```

- [ ] **Step 4: Add and run the failed-switch Settings test**

Add a test whose second `gateway.openLibrary` call rejects with `new Error("switch failed")`. Assert that `C:\\Current` remains visible and the alert contains `switch failed`.

Run:

```powershell
npm.cmd test -- --run src/settings/SettingsView.test.tsx
```

Expected: all Settings tests pass.

- [ ] **Step 5: Commit Task 2**

```powershell
git add app/src/settings/SettingsView.tsx app/src/settings/SettingsView.test.tsx
git commit -m "feat: switch libraries from settings"
```

### Task 3: Reset workspace state after a successful root change

**Files:**
- Modify: `app/src/app/App.tsx:64-70`
- Modify: `app/src/app/App.test.tsx`

**Interfaces:**
- Consumes: `LibrarySummary.root` from `useLibrary()`.
- Produces: a new `LibraryWorkspace` React instance whenever the active root changes.

- [ ] **Step 1: Write a failing App remount test**

Mock `@tauri-apps/plugin-dialog` in `App.test.tsx`, open `C:\\Current` from local storage, navigate to Settings, and select `D:\\Next`. Configure `listClassifications` to return an old root on its first workspace load and a new root after switching. Assert that the new root appears and the old root disappears.

```tsx
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { open } from "@tauri-apps/plugin-dialog";

it("remounts and reloads the workspace after switching library roots", async () => {
  localStorage.setItem("lakomics.libraryPath", "C:\\Current");
  const libraryGateway = gateway();
  vi.mocked(libraryGateway.openLibrary).mockImplementation(async (path) => ({ root: path }));
  vi.mocked(libraryGateway.listClassifications)
    .mockResolvedValueOnce([{ ...games, id: "old-root", name: "Old library" }])
    .mockResolvedValue([{ ...games, id: "new-root", name: "New library" }]);
  vi.mocked(open).mockResolvedValue("D:\\Next");
  render(<App gateway={libraryGateway} subscribeDrops={noDrops} />);

  expect(await screen.findByRole("treeitem", { name: "Old library" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "설정" }));
  await userEvent.click(screen.getByRole("button", { name: "다른 저장소 열기" }));

  expect(await screen.findByRole("treeitem", { name: "New library" })).toBeVisible();
  expect(screen.queryByRole("treeitem", { name: "Old library" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused App test and verify RED**

Run:

```powershell
npm.cmd test -- --run src/app/App.test.tsx
```

Expected: FAIL because `LibraryWorkspace` retains its existing component state after `library.root` changes.

- [ ] **Step 3: Key the workspace by library root**

Change `LibraryScreen` to:

```tsx
  return library
    ? <LibraryWorkspace key={library.root} subscribeDrops={subscribeDrops} startAssetDrag={startAssetDrag} />
    : <LibrarySetup selectFolder={selectFolder} />;
```

- [ ] **Step 4: Run focused and full verification**

Run:

```powershell
npm.cmd test -- --run src/library/LibraryContext.test.tsx src/settings/SettingsView.test.tsx src/app/App.test.tsx
npm.cmd test -- --run
npm.cmd run build
Push-Location src-tauri
try { cargo test } finally { Pop-Location }
```

Expected: focused tests pass, all frontend test files pass, Vite builds successfully, and all Rust tests pass.

- [ ] **Step 5: Rebuild and manually verify the Tauri application**

Run:

```powershell
Get-Process -Name lakomics -ErrorAction SilentlyContinue | Stop-Process -Force
npm.cmd run tauri -- build --debug --no-bundle
Start-Process -FilePath 'C:\chatgpt\app\src-tauri\target\debug\lakomics.exe' -WindowStyle Hidden
```

Confirm Settings → General can switch to a different library and cancellation changes nothing. The invalid-library preservation path is covered by the deterministic automated tests above.

- [ ] **Step 6: Commit Task 3**

```powershell
git add app/src/app/App.tsx app/src/app/App.test.tsx
git commit -m "fix: reset workspace after library switch"
```
