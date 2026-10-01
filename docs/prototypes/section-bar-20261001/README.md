# Section bar (2026-10-01)

Accepted 2026-10-01. One thin bar of a tab's sections (컬렉션 게임·만화·영화·AV, 에셋 전체·이미지·영상,
망가 카탈로그·북마크·로컬, 메모 kinds) under the top bar, the same part on PC and tablet.

- PC: always visible, fixed under the top bar while the list scrolls; sort and view controls sit at its right end.
  The 컬렉션 type rows leave the sidebar index; the 에셋 kind and 망가 source leave the toolbar.
- Tablet: the bar is the top of the list and scrolls away with it (no scroll-direction auto-hide). Once it is off
  screen the top-bar title reads "컬렉션 · 게임 ⌄"; pulling the top bar down (or tapping the title) drops the bar
  like Android's notification shade. Picking a section or scrolling the list closes it.
- Rejected: auto-hide on scroll direction (option 1) — distracting on screens that scroll often.

Revised 2026-10-01 (user): on PC the bar also scrolls away with the list instead of staying pinned. Once it is off
screen the title reads "컬렉션 · 게임 ⌄"; resting the pointer on the top bar (150 ms) drops the bar back down under it,
and it closes 300 ms after the pointer leaves the top bar and the bar. Clicking the title toggles it.
