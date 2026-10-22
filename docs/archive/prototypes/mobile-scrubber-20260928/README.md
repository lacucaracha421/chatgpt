# Tablet scrubber mockups (2026-09-28)

Throwaway tablet design mockups for a horizontal scrubber above the bottom bar: fast seeking in long lists (에셋 grid, 컬렉션, 카탈로그). Not visible until the band above the bottom bar is touched.

Open `index.html` directly (no network; fonts from `_tools/app/src/styles/fonts/`). `index.html?frame=<id>` renders one 800 × 1280 tablet screen; ids `a1`, `a2`, `a3`, `b`. Imagery is generated colour blocks.

| Screen | File | What it shows |
| --- | --- | --- |
| A① (recommended) | `s-a1.png` | Idle: nothing drawn; a ~28 px band above the bottom bar takes touches (dashed outline only in the mockup). Only a horizontal drag that starts in the band scrubs, so vertical grid scrolling is unaffected. |
| A② | `s-a2.png` | While flinging the grid: a 2 px progress hairline appears in the band for ~1 s. |
| A③ | `s-a3.png` | Touched: a translucent bar rises above the bottom bar with ticks for the sort key (date → years large / months small; name → ㄱ ㄴ ㄷ … A; otherwise 10 %), a thumb, and a bubble "2025년 3월 · 1,240 / 8,912". Haptic tick when crossing a major tick; the list dims slightly. On release it stays at that position; the bar fades after 0.8 s. Unloaded ranges show neutral placeholders first. |
| B (alternative) | `s-b.png` | Filmstrip: ~24–30 evenly sampled thumbnails with a framed window at the current position. Easier to find by picture, but thicker and needs extra thumbnails per list. |
