# Home redesign and card draw (2026-10-15)

Mockups for `HOME-REDESIGN-001` and `CARD-GACHA-001`. Open `index.html` directly (Edge/Chrome may need
`--allow-file-access-from-files`); `index.html?only=<id>` shows one frame alone (`frameA`, `frameB`, `keys`,
`frameDraw`, `frameC`, `frameL`, `frameTab`, `sendStates`, `d`).

- A: PC Home 1440 × 900, A (recommended: two-week release calendar + tools left, today's card + 오늘 할 것 right)
  and B (current cover row on top, three columns below). Tools follow the user's 2026-10-15 decision:
  전송 (drop/paste sends at once; route 직접/서버; tablet-offline falls back to the server), 빠른 메모, 링크 보관.
- B: draw flow key frames, a live draw (click the pack in frame A), and the result screen.
- C: card album (series → character slots, detail panel); 링크 보관 view; tablet portrait sketch.
- D: open decisions with recommended defaults.

The card look is unchanged from `../gacha-cards-20261013/` (copied into `cards.css`/`cards.js`; `backgrounds.js`
and the Anton font are linked from that folder). All art is procedural demo art; names and numbers are examples.
One engine change: card art is decoded while face up before the face-down deal, because Chromium did not paint
art first laid out on a hidden back face. Rendering was checked with headless Edge only; no native app check.
