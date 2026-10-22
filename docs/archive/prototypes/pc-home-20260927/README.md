# PC Home redesign mockups (2026-09-27)

Throwaway PC design mockups for the user's request (2026-09-27) to rework the desktop Home: remove the duplication between the Home index and the content area, put 메모, a brief 연결, 전송 and 자산 현황 in the index, and put 발매 예정 with cover images, 확인할 것, 작가 다시 보기 and 오늘의 AV 배우 in the content, referencing the tablet Home the user accepted (direction A of `../home-redesign-20260927/`, shipped in 0.8.50).

Open `index.html` directly (no network; fonts load from `_tools/app/src/styles/fonts/`). `index.html?frame=<id>` renders one 1440 × 900 window at 1:1 for screenshots; ids are `a`, `b`, `b-private`. All imagery is generated SVG placeholders (colour fields and simple figures); titles, names and numbers are fictional.

| Screen | File | What it shows |
| --- | --- | --- |
| A | `a.png` | Stacked content: the 발매 예정 cover shelf across the full width (tablet shelf: date rail above each cover, NEW for released volumes, 관심 for wishlist games/movies, kind chips and 발매 캘린더 in the heading, "+N 더 보기" end cap); below it 확인할 것 as one row of number tiles (only non-zero queues; 태거 검토 marked 새); at the bottom 작가 다시 보기 (wide) and 오늘의 AV 배우 (narrow). |
| B | `b.png` | Two columns, keeping the current PC Home's wide-left / narrow-right frame: left = images (shelf with 4 covers, then 작가 다시 보기 with 3 artists: avatar, name, reason such as "142일 동안 안 봄" / "1년 전 오늘 저장" / "이번 주 새 작품 6장", owned count, a clipped strip of their images at their own ratios); right = 확인할 것 as a ledger list (number + label + one note line) and 오늘의 AV 배우 below it (portrait from the latest front cover, Korean and Japanese name, 출연작 / 소장 counts, latest work with product code and date, three recent owned jackets). |
| B private | `b-private.png` | B in privacy mode: the AV performer section, the AV 품번 queue row and the AV count in 자산 현황 disappear; covers and artist thumbnails keep their slots as quiet empty blocks (titles, names and dates stay), so the layout does not jump. |

The Home index is the same in all three: 메모 (three pinned notes + 새 메모), 연결 (one line of dots for 서버 · 태블릿 · 확장, one line of detail; a problem turns its dot and the line red, here "확장 · 어제 22:10 이후 수집 없음"), 전송 (received count, sending progress), 자산 현황 (이미지 · 영상, collections per type, then 오늘 / 이번 주 added and 휴지통).

## What moved versus the current Home

- 메모 and 연결: were in both the index and the content; now index only. 연결 shrinks from five rows to two lines.
- 전송 and 자산 현황: content right column → index, in compact form. 자산 현황 gains image/video split and per-type collection counts; 미분류 is not repeated there because it is already a 확인할 것 row.
- 신간 and 발매 예정: two small-cover lists → one cover shelf (released first, then by date; manga, games and movies mixed).
- 확인할 것: unchanged content (zero rows hidden), new 태거 검토 row; shape depends on A/B.
- New: 작가 다시 보기 (same picks as the Artist hub's 오늘, so both places agree) and 오늘의 AV 배우.

## Recommendation

**B.** It keeps the frame the user already approved for the PC Home (priority ledger, wide left / narrow right), so the change reads as "the content was sorted out" rather than a new screen. The actionable queue stays in one fixed place (top right) with room for each row's note (e.g. 태거 검토 "추천 31 · 검토로 돌림 17", which A's tiles have to truncate at narrower windows), while the images take two thirds of the width, in line with DESIGN.md's media-first priority. A shows more covers at once (7 vs 4) but pushes the queue to the middle of the screen and squeezes the AV card; it is the better choice only if the cover shelf matters more than the queue.

## Open questions for the user

1. A or B (recommended B)?
2. 자산 현황: is image/video + per-type collections the right set, or keep 오늘 / 이번 주 / 전체 as today? Should 미분류 also appear there (the request listed it, but it duplicates the 확인할 것 row)?
3. 연결 · 확장: the PC may not know the collector's status; if it does not, drop the 확장 dot or show "마지막 수집 N시간 전" instead (unverified in source).
4. 작가 다시 보기: three artists (as mocked) or two? Keep "다시 고르기" on Home, or only in the Artist hub?
5. 오늘의 AV 배우: pick rule (random among performers with owned works, not repeated for N days?), and should the Japanese name come from a new field? The portrait is cropped from the right half of the latest front cover — acceptable, or should the user pick a portrait per performer?
6. Privacy mode: empty cover/thumbnail blocks (as mocked), or hide 작가 다시 보기 entirely and show titles only in the shelf?
7. When 확인할 것 is empty in B, should 오늘의 AV 배우 move up into its place (likely) — confirm.

## Decision (user, 2026-09-27)
Direction **B** (two columns: covers + artist revisit left; 확인할 것 + 오늘의 AV 배우 right) with the shared Home index sidebar (메모, 연결, 전송, 자산 현황); privacy variant as mocked. Sub-questions follow the README recommendations.
