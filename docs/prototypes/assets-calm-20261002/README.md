# 에셋 화면 덜 복잡하게 (2026-10-02)

Mockup for backlog `PC-POLISH-20261002` item 2, based on a comparison of Eagle, Google Photos, Apple Photos, Lightroom
and Immich. Accepted by the user on 2026-10-02 ("시안대로", with attention to smooth motion):

- Tiles show the image only: no file name or creator, not even on hover (user: the info panel is enough).
- One badge: video duration as 「▶ 0:42」; favourite heart and the select circle appear on hover (heart always in the
  favourites view); the duration hides on very small tiles.
- Date headings are small muted text without the rule; the count shows on hover; the scrubber bubble carries the date.
- Sidebar counts only for the selected and hovered entries; folder-group ＋ · ⋯ appear on hover.
- Toolbar: title, search, 보기 (sort and the size slider move into the 보기 menu).
- The info panel docks beside the grid and pushes it aside instead of covering tiles (I toggles it).
- The folder shelf row shows only at a folder's top level and never stacks on top of date headings.
- Motion: short, purposeful (DESIGN.md §10): the panel slides 200 ms and visible tiles glide to their new places
  (FLIP), hover elements fade in 90 ms; reduced motion switches instantly.
