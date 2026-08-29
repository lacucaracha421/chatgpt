# UI Accessibility and Interaction Hardening Design

## Goal

Complete the next UI reliability batch without visual redesign: keyboard-accessible video tile scrubbing, safe zero-duration playback controls, verified quick-preview cleanup, backdrop dismissal for Work artwork, and visible source-copy failure feedback.

## Scope

This batch includes:

- `VideoTileMedia` keyboard interaction for the existing custom slider.
- `VideoPlayer` handling when neither native media metadata nor stored metadata provides a positive duration.
- A regression test for the existing quick-preview unmount timer cleanup.
- Empty-backdrop dismissal in `WorkArtworkGallery` without changing artwork navigation.
- User-visible feedback when `AssetInspector` cannot copy a source URL.

This batch excludes visual restyling, a shared media-seeking abstraction, provider behavior, persistence changes, and the separate low-priority security and database hardening backlog.

## Design

### Video tile keyboard scrubbing

Keep the existing `div[role="slider"]` and its visual treatment. Make it keyboard-focusable and handle these keys:

- `ArrowLeft`: move backward 5 seconds.
- `ArrowRight`: move forward 5 seconds.
- `Home`: move to 0.
- `End`: move to the media duration.

Clamp every target to `[0, duration]`. A handled key prevents the browser default and stops propagation so the surrounding asset tile does not interpret it. Keyboard seeking requests the tile's active preview, updates the preview frame and ARIA value immediately, and seeks the video when the active media element is available. Pointer behavior remains unchanged.

### Zero-duration video player

Continue preferring a finite positive native duration and falling back to a finite positive stored duration. If neither exists, treat the timeline as unavailable:

- Render a stable `0:00 / 0:00` time display.
- Disable the timeline range input.
- Do not calculate hover preview time or frames from a fabricated duration.
- Ignore timeline changes while no valid duration exists.

Playback controls remain available because a file with unusable duration metadata may still start or expose better metadata later.

### Quick-preview cleanup

`AssetGallery` already clears `quickPreviewTimerRef` during unmount. Do not change production behavior. Add a regression test that schedules a quick preview, unmounts before the 150 ms delay, advances timers, and verifies the timer was cleared without rendering a late preview.

### Work artwork backdrop dismissal

The Radix overlay is the empty backdrop surface. Clicking that overlay clears `activeId`, closing the dialog. Content controls and artwork remain separate portal siblings and keep their existing previous/next, close, and keyboard behavior. No CSS or animation changes are required.

### Source-copy failure feedback

`AssetInspector` currently swallows clipboard rejection. Add a dedicated copy-feedback state, reuse `commandErrorMessage`, the shared `Toast`, and `useAutoDismiss`, and show `출처를 복사하지 못했습니다.` when clipboard writing fails. A successful copy clears any prior error and retains the existing check-icon feedback.

## Error and lifecycle rules

- No state update may occur from the quick-preview delay after unmount.
- Invalid, zero, negative, infinite, or `NaN` durations never reach range calculations.
- Keyboard scrub values and ARIA values remain clamped to the same duration boundary.
- Clipboard errors are presented without exposing browser-specific exception details unless the established command error formatter intentionally preserves a safe message.
- Changing the inspected asset clears stale copy feedback.

## Verification

Use test-first regression coverage:

- `VideoTileMedia.test.tsx`: focusability, 5-second arrow movement, Home/End, clamping, and no surrounding tile action.
- `VideoPlayer.test.tsx`: zero native and stored duration disables the timeline and remains stable; a later valid duration re-enables it.
- `AssetGallery.test.tsx`: pending quick-preview timer is cleared on unmount.
- A focused `WorkArtworkGallery` test: backdrop click closes while artwork/control clicks do not.
- `AssetInspector.test.tsx`: clipboard rejection exposes failure feedback and success retains current behavior.

After focused tests pass, run the complete frontend test suite and production build. No active-library operation is required.
