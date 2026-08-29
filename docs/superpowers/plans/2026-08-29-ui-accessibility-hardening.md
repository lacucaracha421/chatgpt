# UI Accessibility and Interaction Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the approved UI reliability batch with keyboard video scrubbing, safe invalid-duration controls, verified quick-preview cleanup, artwork backdrop dismissal, and visible clipboard failure feedback.

**Architecture:** Keep behavior inside the components that already own it. Reuse the existing video scrub state, Radix overlay, shared Toast, and quick-preview timer cleanup; do not add shared hooks, new dependencies, or visual treatments.

**Tech Stack:** React 19, TypeScript 7, Vitest 4, Testing Library, Radix Dialog, existing Lakomics shared UI

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-29-ui-accessibility-hardening-design.md` exactly.
- Preserve the existing visual structure, CSS tokens, pointer behavior, and Works collectible interaction.
- Do not add a shared media-seeking abstraction or replace the scrub bar with a native range input.
- Do not touch `C:\New_lakomics_assets`; this batch needs no library operation.
- Use RED → GREEN for every production behavior change and keep each commit independently testable.
- Leave transfer archives and `.tmp-*` paths untracked.

---

### Task 1: Add keyboard control to the video tile scrub slider

**Files:**
- Modify: `app/src/video/VideoTileMedia.tsx`
- Test: `app/src/video/VideoTileMedia.test.tsx`

**Interfaces:**
- Consumes: stored video duration in milliseconds, scrub frame count, current played ratio, and `onRequestActive()`.
- Produces: focusable `div[role="slider"]` behavior for ArrowLeft, ArrowRight, Home, and End.

- [ ] **Step 1: Write the failing keyboard scrub test**

Add this test beside the existing pointer scrub tests:

```tsx
it("seeks the scrub slider by keyboard in five-second steps and clamps endpoints", () => {
  const request = vi.fn();
  render(<VideoTileMedia asset={video()} active onRequestActive={request} onReleaseActive={vi.fn()} onRetry={vi.fn()} />);
  const slider = screen.getByRole("slider", { name: "영상 탐색" });
  const media = screen.getByLabelText("clip.webm 미리보기") as HTMLVideoElement;

  expect(slider).toHaveAttribute("tabindex", "0");
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  expect(slider).toHaveAttribute("aria-valuenow", "5000");
  act(() => vi.advanceTimersByTime(120));
  expect(media.currentTime).toBe(5);

  fireEvent.keyDown(slider, { key: "End" });
  expect(slider).toHaveAttribute("aria-valuenow", "10000");
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  expect(slider).toHaveAttribute("aria-valuenow", "10000");

  fireEvent.keyDown(slider, { key: "Home" });
  fireEvent.keyDown(slider, { key: "ArrowLeft" });
  expect(slider).toHaveAttribute("aria-valuenow", "0");
  expect(request).toHaveBeenCalled();
});
```

Add `act` to the Testing Library import because the test advances the existing fake timer.

- [ ] **Step 2: Run the focused test and verify RED**

Run from `app`:

```powershell
npm test -- src/video/VideoTileMedia.test.tsx -t "seeks the scrub slider by keyboard"
```

Expected: FAIL because the slider has no `tabIndex` and does not change `aria-valuenow` on keydown.

- [ ] **Step 3: Represent the active scrub target as an exact ratio**

Replace frame-only preview state with ratio state so keyboard values do not get rounded back through the frame count:

```tsx
const [previewRatio, setPreviewRatio] = useState<number | null>(null);
const previewFrame = previewRatio === null
  ? null
  : Math.round(previewRatio * Math.max(0, asset.media.scrubFrameCount - 1));

const seekToRatio = (ratio: number, live: boolean) => {
  const clamped = Math.max(0, Math.min(1, ratio));
  setPreviewRatio(clamped);
  if (seekTimer.current !== null) window.clearTimeout(seekTimer.current);
  seekTimer.current = window.setTimeout(() => {
    if (videoRef.current) videoRef.current.currentTime = clamped * asset.media.durationMs / 1_000;
  }, 120);
  if (live) setScrubbing(true);
};
```

Make `scrubTo` compute the pointer ratio and call `seekToRatio(ratio, live)`. Change `leave` to clear `previewRatio`, and calculate display progress with:

```tsx
const scrubRatio = previewRatio ?? playedRatio;
```

- [ ] **Step 4: Add the minimal keyboard handler**

After `scrubRatio` is known, add:

```tsx
const scrubWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
  const durationMs = Math.max(0, asset.media.durationMs);
  const currentMs = Math.round(scrubRatio * durationMs);
  const nextMs = event.key === "ArrowLeft"
    ? currentMs - 5_000
    : event.key === "ArrowRight"
      ? currentMs + 5_000
      : event.key === "Home"
        ? 0
        : event.key === "End"
          ? durationMs
          : null;
  if (nextMs === null) return;
  event.preventDefault();
  event.stopPropagation();
  onRequestActive();
  seekToRatio(durationMs > 0 ? Math.max(0, Math.min(durationMs, nextMs)) / durationMs : 0, false);
};
```

Attach `tabIndex={0}` and `onKeyDown={scrubWithKeyboard}` to the existing slider element.

- [ ] **Step 5: Run the video tile test file and verify GREEN**

Run:

```powershell
npm test -- src/video/VideoTileMedia.test.tsx
```

Expected: all tile pointer, playback, cleanup, and keyboard tests PASS.

- [ ] **Step 6: Commit the keyboard scrub change**

```powershell
git add -- app/src/video/VideoTileMedia.tsx app/src/video/VideoTileMedia.test.tsx
git commit -m "fix: add keyboard video tile scrubbing"
```

### Task 2: Guard the video player timeline when duration is unavailable

**Files:**
- Modify: `app/src/video/VideoPlayer.tsx`
- Test: `app/src/video/VideoPlayer.test.tsx`

**Interfaces:**
- Consumes: native `durationchange` events and stored `asset.media.durationMs`.
- Produces: `timelineAvailable: boolean`, a disabled zero-duration timeline, and automatic recovery when a positive native duration arrives.

- [ ] **Step 1: Make the video fixture accept a duration override**

Change the fixture signature and media field:

```tsx
function videoAsset(durationMs = 100_000): AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> } {
  return {
    id: "video-1",
    title: null,
    originalName: "sample.webm",
    byteSize: 1,
    width: 1920,
    height: 1080,
    collectedAt: "2026-08-09T00:00:00Z",
    favorite: false,
    sourceUrl: null,
    sourcePublishedAt: null,
    creatorName: null,
    creatorHandle: null,
    creatorUrl: null,
    importSource: null,
    importBatchId: null,
    originalModifiedAt: null,
    media: { kind: "video", durationMs, preparationState: "ready", scrubFrameCount: 11 },
  };
}
```

- [ ] **Step 2: Write the failing zero-duration recovery test**

```tsx
it("disables an unavailable timeline and restores it when valid metadata arrives", () => {
  render(<VideoPlayer asset={videoAsset(0)} />);
  const video = screen.getByLabelText("sample.webm 영상");
  const timeline = screen.getByRole("slider", { name: "재생 위치" });

  setMediaNumber(video, "duration", 0);
  fireEvent.durationChange(video);
  expect(timeline).toBeDisabled();
  expect(screen.getByText("0:00 / 0:00")).toBeInTheDocument();

  setMediaNumber(video, "duration", 30);
  fireEvent.durationChange(video);
  expect(timeline).not.toBeDisabled();
  expect(timeline).toHaveAttribute("max", "30");
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```powershell
npm test -- src/video/VideoPlayer.test.tsx -t "disables an unavailable timeline"
```

Expected: FAIL because the range input remains enabled when both duration sources are zero.

- [ ] **Step 4: Add a validated duration boundary**

Replace the duration derivation with:

```tsx
const storedDuration = Number.isFinite(asset.media.durationMs) && asset.media.durationMs > 0
  ? asset.media.durationMs / 1_000
  : 0;
const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : storedDuration;
const timelineAvailable = safeDuration > 0;
const hoverTime = hoverRatio === null || !timelineAvailable ? 0 : hoverRatio * safeDuration;
```

Render the hover preview only when `timelineAvailable`, add `disabled={!timelineAvailable}`, use zero for the unavailable value, and guard both timeline handlers:

```tsx
value={timelineAvailable ? Math.min(currentTime, safeDuration) : 0}
onChange={(event) => {
  if (!timelineAvailable) return;
  const next = Number(event.currentTarget.value);
  if (videoRef.current) videoRef.current.currentTime = next;
  setCurrentTime(next);
}}
onPointerMove={(event) => {
  if (!timelineAvailable) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  setHoverRatio(Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))));
}}
```

- [ ] **Step 5: Run the video player tests and verify GREEN**

```powershell
npm test -- src/video/VideoPlayer.test.tsx
```

Expected: all player tests PASS, including the later positive duration recovery.

- [ ] **Step 6: Commit the duration guard**

```powershell
git add -- app/src/video/VideoPlayer.tsx app/src/video/VideoPlayer.test.tsx
git commit -m "fix: guard unavailable video timelines"
```

### Task 3: Lock in the existing quick-preview unmount cleanup

**Files:**
- Test: `app/src/assets/AssetGallery.test.tsx`
- Verify only: `app/src/assets/AssetGallery.tsx`

**Interfaces:**
- Consumes: `quickPreviewTimerRef` cleanup already owned by `AssetGallery`.
- Produces: regression evidence that a pending 150 ms preview timer is cleared on unmount.

- [ ] **Step 1: Add the cleanup regression test**

```tsx
it("clears a pending quick preview when the gallery unmounts", () => {
  vi.useFakeTimers();
  const clearTimeout = vi.spyOn(window, "clearTimeout");
  const { unmount } = render(<AssetGallery items={[asset(0)]} />);

  fireEvent.pointerEnter(screen.getByRole("button", { name: "asset-0.png 빠른 확대 미리보기" }));
  unmount();

  expect(clearTimeout).toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(150));
  expect(screen.queryByRole("img", { name: /빠른 미리보기/ })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test and confirm the existing behavior**

```powershell
npm test -- src/assets/AssetGallery.test.tsx -t "clears a pending quick preview"
```

Expected: PASS immediately. The investigation found that production cleanup already exists at the component boundary; a production edit would be redundant.

- [ ] **Step 3: Run the complete gallery test file**

```powershell
npm test -- src/assets/AssetGallery.test.tsx
```

Expected: all gallery tests PASS with no late state-update warning.

- [ ] **Step 4: Commit the regression coverage**

```powershell
git add -- app/src/assets/AssetGallery.test.tsx
git commit -m "test: cover quick preview unmount cleanup"
```

### Task 4: Close Work artwork from the empty backdrop

**Files:**
- Modify: `app/src/collections/WorkArtworkGallery.tsx`
- Create: `app/src/collections/WorkArtworkGallery.test.tsx`

**Interfaces:**
- Consumes: `activeId` and the existing Radix overlay.
- Produces: backdrop-only click dismissal without changing image or navigation behavior.

- [ ] **Step 1: Create the failing backdrop behavior test**

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { WorkArtworkGallery } from "./WorkArtworkGallery";

afterEach(cleanup);

describe("WorkArtworkGallery", () => {
  it("closes only when the empty backdrop is clicked", async () => {
    const user = userEvent.setup();
    render(<WorkArtworkGallery workTitle="Astral Chain" artworks={[{ id: "shot-1", kind: "screenshot", selected: false }]} />);

    await user.click(screen.getByRole("button", { name: "스크린샷 크게 보기" }));
    const dialog = screen.getByRole("dialog", { name: "Astral Chain 스크린샷 감상" });
    fireEvent.click(screen.getByRole("img", { name: "Astral Chain 스크린샷" }));
    expect(dialog).toBeInTheDocument();

    fireEvent.click(document.querySelector(".manga-cover-viewer__backdrop")!);
    expect(screen.queryByRole("dialog", { name: "Astral Chain 스크린샷 감상" })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

```powershell
npm test -- src/collections/WorkArtworkGallery.test.tsx
```

Expected: FAIL because clicking the current overlay does not clear `activeId`.

- [ ] **Step 3: Attach dismissal to the overlay only**

Change the overlay to:

```tsx
<RadixDialog.Overlay
  className="manga-cover-viewer__backdrop"
  aria-label="아트웍 감상 닫기"
  onClick={() => setActiveId(null)}
/>
```

Do not add a Content click handler and do not change `pointerEvents`, navigation controls, or CSS.

- [ ] **Step 4: Run the focused and game detail tests**

```powershell
npm test -- src/collections/WorkArtworkGallery.test.tsx src/collections/GameCollectionDetail.test.tsx
```

Expected: both files PASS.

- [ ] **Step 5: Commit the backdrop dismissal**

```powershell
git add -- app/src/collections/WorkArtworkGallery.tsx app/src/collections/WorkArtworkGallery.test.tsx
git commit -m "fix: close artwork viewer from backdrop"
```

### Task 5: Show clipboard failure feedback in the Asset inspector

**Files:**
- Modify: `app/src/assets/AssetInspector.tsx`
- Test: `app/src/assets/AssetInspector.test.tsx`

**Interfaces:**
- Consumes: `navigator.clipboard.writeText`, `commandErrorMessage`, shared `Toast`, and `useAutoDismiss`.
- Produces: transient `copyError: string | null` feedback and preserved success check-icon behavior.

- [ ] **Step 1: Write the failing clipboard rejection test**

Add `vi.unstubAllGlobals()` to the existing `afterEach`, then add:

```tsx
it("shows feedback when copying the source URL fails", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockRejectedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[asset("a")]} open onOpenChange={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "출처 복사" }));

  expect(await screen.findByText("출처를 복사하지 못했습니다.")).toBeVisible();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npm test -- src/assets/AssetInspector.test.tsx -t "shows feedback when copying"
```

Expected: FAIL because clipboard rejection is currently swallowed.

- [ ] **Step 3: Reuse the shared transient feedback pattern**

Add imports:

```tsx
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
```

Add state and lifecycle handling before the conditional return:

```tsx
const [copyError, setCopyError] = useState<string | null>(null);
useAutoDismiss(copyError, setCopyError);
```

Clear `copyError` in the existing `assetIds` effect. Update `copySource`:

```tsx
try {
  await navigator.clipboard.writeText(asset.sourceUrl);
  setCopyError(null);
  setCopied(true);
  window.setTimeout(() => setCopied(false), 1_500);
} catch (error) {
  setCopied(false);
  setCopyError(commandErrorMessage(error, "출처를 복사하지 못했습니다."));
}
```

Render the shared feedback once inside the inspector:

```tsx
{copyError && <Toast onDismiss={() => setCopyError(null)}>{copyError}</Toast>}
```

- [ ] **Step 4: Run the Asset inspector tests and verify GREEN**

```powershell
npm test -- src/assets/AssetInspector.test.tsx
```

Expected: copy success, copy rejection, editing, Escape, and metadata tests all PASS.

- [ ] **Step 5: Commit the clipboard feedback**

```powershell
git add -- app/src/assets/AssetInspector.tsx app/src/assets/AssetInspector.test.tsx
git commit -m "fix: report source copy failures"
```

### Task 6: Verify the complete frontend batch

**Files:**
- Verify every file changed in Tasks 1–5.

**Interfaces:**
- Consumes: all completed UI behavior changes and regression tests.
- Produces: a clean frontend test/build result and a whitespace-clean diff.

- [ ] **Step 1: Run the focused batch together**

```powershell
npm test -- src/video/VideoTileMedia.test.tsx src/video/VideoPlayer.test.tsx src/assets/AssetGallery.test.tsx src/collections/WorkArtworkGallery.test.tsx src/collections/GameCollectionDetail.test.tsx src/assets/AssetInspector.test.tsx
```

Expected: every listed test file PASS with no unhandled rejection or late state-update warning.

- [ ] **Step 2: Run the complete frontend suite**

```powershell
npm test
```

Expected: all frontend tests PASS.

- [ ] **Step 3: Run the production build**

```powershell
npm run build
```

Expected: TypeScript and Vite build PASS; the existing large-chunk advisory may remain.

- [ ] **Step 4: Check the final diff and worktree**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors, no tracked implementation changes left uncommitted, and only the pre-existing transfer archives or `.tmp-*` paths remain untracked.
