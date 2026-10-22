# PC AV performer page (2026-09-30)

Follows the merged work screen (`../pc-collection-viewer-20260930/`) and the shelf (`../pc-collection-cases-20260930/`); the file is generated from the cases mockup, so it carries that mockup's CSS and helpers and adds the `.pf` rules and `framePerformer`.

One frame: a header band holds the person (portrait, name, favourite, 프로필 facts in three label/value columns, 내 메모) — a separate left column was rejected as taking too much room (user, 2026-09-30); below it the full width stands the works on the list shelf (cover-led light case, real spine beside it, a click turns a case to the front, a double-click opens that work screen, the work the user came from is marked 이 작품), with 역할 filter, 정렬 and 보기 in the toolbar, then 자주 함께 나온 배우 and 레이블.

No new data: every item exists on the current page (`src/collections/av/AvPerformerPage.tsx`). Imagery is colour blocks; the private preview injects the library's one real work and its portrait (never committed).

Status: awaiting the user's review. Implementation belongs with the list shelf slice (same parts).
