# PHOSPHOR — isolated arcade prototype

Run from `C:\chatgpt\app`: `npm run dev -- --host 127.0.0.1 --port 1437`, then open `http://127.0.0.1:1437/phosphor.html`. Uses the existing React / TypeScript / Vite installation.

## Revised direction

A Japanese arcade image-territory game, with a compact score/lives/time HUD, saturated purple/pink/cyan/yellow palette, hard-edged lettering, tiled concealed field and original pixel monsters. The image itself is the reward. No artificial film wear, persistent scanline overlay, large editorial title panel or results covering the cleared image.

User-selected images determine the experience. The game does not inspect subject matter, add classifications, infer focal content, crop or alter source images. Sample artwork remains the three original offline illustrations.

## Rules and controls

- Enter / GAME START begins a stage. Arrows / WASD move; Space + direction starts a trail. X / DRAW arms drawing. Onscreen directions support tapping or holding.
- Reconnect to safe ground to claim enemy-free regions. **Both guardians retain their regions.** Simply splitting them apart reveals only the trail; carve empty corners with L/U paths or wait until enemies share one side.
- Clear at **80%** with three lives and 150 seconds. Border cells are excluded from percentage. The interior core and rival threaten live trails; a separate perimeter spark threatens the player on the outer edge.
- Before starting, choose **보고 싶은 위치 선택**, then click the image or move the marker with arrow keys. The chosen 5×5-cell window must be fully recovered to earn **5,000 points, +10 seconds and a 3-second enemy/fuse freeze**. A thin line through the marker is insufficient. The default window is the center. Nothing is classified automatically.
- The fuse starts after `max(cols, rows) / 22 + 0.8` seconds. The delay follows board traversal size so portrait and landscape stages are not penalized by the same arbitrary timer.
- Reconnect again within nine seconds for a chain bonus. Revealing an area triggers a brief local flash and a short top-edge score popup, then leaves the image unobstructed.
- P / Escape pauses. R / RESTART resets a stage. EXIT returns to selection, or invokes the host callback.
- After game over, **이어하기** preserves revealed territory, restores three lives and 90 seconds, and halves the stage score. RESTART remains available for a fresh run.
- Stage clear shows the full image immediately; results and the next-stage button are in the HUD. There is no result overlay to dismiss.

## Image selection / integration

Select or drop multiple local images to replace the playlist. Invalid images can be skipped. Selection order is stage order. Local files use object URLs, without upload or persistence.

```tsx
import { Phosphor } from './prototypes/phosphor/Phosphor';
<Phosphor selectedAssetUrls={selectedAssetUrls} onExit={closeGame} />
```

Initial URLs are read on mount. Remount for a new host selection; the host owns its URLs. Extreme aspect ratios use a board bounded to 0.35–2.8 with contain-fit image letterboxing. The stylesheet currently owns page root/body/control styling; scope it before embedding in production.

## Files

- `app/phosphor.html`, `main.tsx`: independent entry point.
- `engine.ts`: DOM-free territory, guardians, collision, timer, focus and continue rules.
- `presentation.ts`: Canvas images, pixel sprites, reveal effects and synthesized audio.
- `Phosphor.tsx`, `phosphor.css`: controls, selection, responsive arcade HUD.
- `art.ts`: original sample illustrations.
- `engine.test.ts`: targeted gameplay checks.

## Validation / limits

The revision was visually inspected on desktop and at 390×844 with portrait art. Real browser key input carved an L-shaped 8.7% region around a manually placed focus, earned the focus reward, then expanded to 30.0%. Tests cover five image ratios, both guarded regions, the old two-cut strategy remaining below clear, focus-window recovery, collision, pause, fuse, 80% clear, buffered input and continue preserving the image.

Final verification results and any environment interruption are reported in the task response. No production/native integration, database, tagging, sync, metadata or server changes are included. No saved state, gamepad or video stages. Audible mix and physical touch-device acceptance remain unverified. Hot reload may invalidate selected local object URLs; reselect files in that case.

The main remaining design question is human playtesting: whether recovering chosen portions is satisfying enough over a full playlist, and whether two guardians offer readable opportunities across varied compositions. Automatic content analysis is not assumed as a solution.
