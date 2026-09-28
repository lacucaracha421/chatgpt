# 캐릭터에 넣기 from any gallery (2026-09-29)

Throwaway PC mockups replacing the removed sidebar character drop rows (user: no sidebar rows; improve the select-then-assign flow in the content area). Today the gallery has no character action; only `SeriesBrowser` has a hidden, ungrouped `<details>` picker without thumbnails, suggestions or undo. Open `index.html`; `?frame=a|a2|b`.

| Screen | File | What it shows |
| --- | --- | --- |
| A (recommended) | `a.png` | Selection bar gets 캐릭터 (C); a bracketed search popover: 추천 (tagger guesses ≥ 0.85 aggregated over the selection, "8장 중 7장"), 최근, then series → group → character sorted by count; one click/Enter assigns (Ctrl+click for several); moves into the character's series folder like the old drop. |
| A′ | `a2.png` | After assigning: brief character mark on the moved tiles and a one-line notice with 되돌리기 and 열기. |
| B (companion) | `b.png` | Dragging a selection raises a bottom tray of suggested/recent character tiles plus "다른 캐릭터…"; drop to assign. |
