# Tablet parity mockups (2026-09-27)

Throwaway design mockups for `TABLET-PARITY-001`: bring the Android tablet app (Galaxy Tab S11, portrait 800 × 1280 CSS px, touch-first) up to the PC features of 2026-09-27. Stage 2 (Home additions), stage 3 (artist screen entered from Home) and stage 4 (AV tab in 컬렉션) are mocked here; stage 1 (PC publishers) has no UI.

Open `index.html` directly (no network; fonts load from `_tools/app/src/styles/fonts/`). `index.html?frame=<id>` renders one 800 × 1280 frame at 1:1; add `&ann=0` to hide the yellow notes. The PNGs were taken with headless Google Chrome at DPR 1 with the notes visible. All covers, posters, portraits and illustrations are generated placeholders; names, titles and product codes are fictional. The AV detail case can really be dragged and snapped on the page (앞면 · 책등 · 뒷면); the screenshots show the resting pose.

The page reuses the visual code of the accepted tablet Home A (`../home-redesign-20260927/`, shipped in 0.8.50) and the AV case renderer of `../av-detail-20260927/` (PC 1A), so the look is the established one rather than a new direction.

## User decisions applied (2026-09-27)

- **No character classification on the tablet.** The 캐릭터 검토 tile is hidden from Home's 확인할 것 in every frame, which keeps 처리 대기 (pending captures), 유사 이미지 and 중복 판본. Character review screens and the viewer's 캐릭터에 추가 button are hidden; the viewer's "○○에서 제외" stays. The tagger review badge screen from the brief was dropped. The 캐릭터 검토 tile was removed at the user's decision on 2026-09-27 (no character classification on the tablet).
- **Home order: most used first.** 전송 → 신간 · 발매 예정 → 메모 (includes 가계부) at the top; 확인할 것 → 다시 보기 → 자산 현황 at the bottom. **오늘의 AV 배우 sits between the two groups, directly under 메모** (it is a light "today" card, it disappears cleanly in privacy mode, and it keeps review work at the bottom as requested). Home A's visual language is unchanged: number tiles cut by 1px lines, the dated cover shelf and justified image rows. The status line became a 전송 section of two tiles (sending progress; received files with thumbnails), because it is now the first thing on the screen.

## Revision 2 (user feedback, 2026-09-27)

- **Home C (new, recommended).** The user found A/B "too wide and stretched — long horizontal strips". C keeps the agreed priority and Home A's visual language but puts sections side by side as blocks: 전송 (two stacked tiles) | 메모 (Todo, 가계부); a shorter 신간 · 발매 예정 shelf (146 px covers instead of 200); 오늘의 AV 배우 card | 확인할 것 (three stacked tiles); 다시 보기 as two 248 px collage blocks (1년 전 오늘, 오늘의 작가) | 자산 현황 as four small number tiles. The whole Home fits one screen (1,160 px of content for a 1,156 px viewport, vs 1,516 px for A). A and B stay below for comparison.
- **Defaults applied:** 관심 bookmark on every game / movie / anime poster; the shelf also shows upcoming titles not yet marked; the "캐릭터 자동 태그 %" tile is dropped (Home C); privacy mode is a new tablet toggle in Settings, and while it is on **the AV tab is hidden** (`av-private` now shows the type tabs without AV) and Home shows empty image blocks with no AV card; the artist screen keeps its short "PC 앱에서" line.
- **메모 as portrait cards (home-c, home-c-private).** Todo and 가계부 are now two tall cards side by side inside the 메모 block (Todo: the first five checklist lines with checkboxes; 가계부: this month's total and the top three categories), about the same height as the 전송 block; covers and revisit blocks were trimmed so Home C still fits one screen (1,155 px of content).
- **AV list: both views.** A **작품 · 배우별** switch in the list header: `av-list-a` shows 작품 (4-column case grid + 배우 filter chip), `av-list-b` shows 배우별 (one shelf per performer).

## Screens

| Frame id | Screenshot | What it shows |
| --- | --- | --- |
| `home-c` | `home-c.png` | **Home C (recommended, revision 2)**: blocks side by side, whole Home on one screen (see Revision 2). 오늘의 AV 배우 sits between the top group and 확인할 것, next to it. |
| `home-c-private` | `home-c-private.png` | Home C in privacy mode: image blocks empty, no AV card, 확인할 것 widens to one row of three tiles. |
| `home-a` | `home-a.png` | Home A (comparison), top of the page: 전송 tiles (서버 dot in the heading), 신간 · 발매 예정 shelf mixing manga volumes with game / movie / anime posters (kind chip, date rail with D-day, a bookmark toggle at each poster's top-right corner for the 관심 목록, "관심 ·" prefix on wished items; manga has no toggle because Collections already track its volumes), 메모 (Todo, 가계부), the new 오늘의 AV 배우 band (round portrait, Korean and Japanese name, 소장 / 출연작, latest work as a mini DVD case with code and date), and the start of 확인할 것. |
| `home-a-2` | `home-a-2.png` | Home A scrolled to the bottom: 확인할 것 as three tiles in one row (처리 대기 · 유사 이미지 · 중복 판본), 다시 보기 with 1년 전 오늘 on the left and **오늘의 작가** (PC's artist pick, replacing "다시 만난 작가") on the right as the same 2 : 1 collage as the artist screen, plus a line with the other two picks; 자산 현황 as one row of five tiles. |
| `home-b` | `home-b.png` | **Home B**, same order, but under 확인할 것 a two-column row like PC Home B: 작가 다시 보기 (three artists: avatar, name, reason, owned count, a strip of images) and a vertical 오늘의 AV 배우 card; 1년 전 오늘 moves below as one full-width row. |
| `home-b-2` | `home-b-2.png` | Home B scrolled to the bottom. |
| `home-private` | `home-private.png` | Home A in **비공개 모드** (a lock pill in the top bar): covers, posters, received thumbnails and revisit images become quiet empty blocks of the same size (titles, dates, names and counts stay), and the 오늘의 AV 배우 band is removed entirely. |
| `home-sheet` | `home-sheet.png` | Tapping a poster opens a bottom sheet: poster, kind, title and original title, release date with weekday and D-day, platform, developer, genre, a short description, **관심 목록에 추가** (primary) and 닫기, and a hint that the wishlist is shared with the PC and applied when the PC connects (source IGDB/TMDB shown). |
| `artists` | `artists.png` | **작가** screen, entered from Home only (Home's 작가 전체 and the 오늘의 작가 caption): 오늘 mosaic (1 large + 4 small, last cell "+N"), reason and dates under it, 모은 그림 / 처음 저장 / 최근 저장, the other two of today's picks, then 주요 작가 as a 3-column grid of square collage tiles (mobile CoverGroup 2 : 1 split) with name, handle, count and "최근 30일 N장 · 저장 MM.DD". Read-only: no pin, hide or re-pick. |
| `artists-search` | `artists-search.png` | Search in the top bar by name, handle or 초성 (ㅎㄴ matches 하늘빛, 호노카, 한낮고양이; Latin names also match a Korean reading); matched syllables underlined; results use the same tiles. The keyboard is omitted. |
| `artist` | `artist.png` | Artist detail: avatar, name, handles, stats (모은 그림, 처음 저장, 최근 저장, N일 동안 안 봄), a quiet dashed line "이름 바꾸기 · 다른 작가와 합치기 · 숨기기는 PC 앱에서" where edit actions would be, sort / image / video chips, and a justified image grid (tap opens the viewer). The top-right icon opens the artist's pixiv / X profile. |
| `av-list-a` | `av-list-a.png` | **컬렉션 › AV, 작품 view**: the 작품 · 배우별 switch, the same top bar type tabs as the other types (게임 · 만화 · 영화 · AV) with 신간 and search, 쇼케이스 fold, 전체 row with sort / 내 별점 / **배우** chips, and a 4-column grid of DVD keepcases (static snapshots at a slight angle) with product code, release date, my rating and performer. |
| `av-list-b` | `av-list-b.png` | 배우별 view of the same list:  one horizontal shelf per performer (portrait or initials, Korean and Japanese name, 소장 N편, "+N 모두 보기"). |
| `av-private` | `av-private.png` | 컬렉션 in 비공개 모드 (switched on in Settings): the type tabs show only 게임 · 만화 · 영화; the AV tab is hidden (if it was open, the list returns to 게임). |
| `av-detail` | `av-detail.png` | AV detail adapted from PC 1A: colour atmosphere from the cover (no blurred cover), the rotatable case centred with 앞면 / 책등 / 뒷면 stops and a hint (drag to rotate, double-tap to enlarge), then product code with copy and source line, Japanese title, release date and runtime, 메이커 / 레이블 / 시리즈 as filter links with library counts, genre chips, my rating and memo. |
| `av-detail-2` | `av-detail-2.png` | Lower part: 출연 strip (round portraits; a performer without a picked or Commons photo shows initials; the director with initials), and horizontal shelves 같은 배우의 다른 작품 (performer chips when there are two or more), 같은 시리즈 (order numbers, 이 작품, 발매 예정), 같은 레이블, then 자세한 정보 collapsed. Shelves with no other works are hidden. |

Page length (measured in the frames): Home C 1,155 px (one screen; privacy 1,027 px); Home A 1,516 px and Home B 1,495 px of content for a 1,156 px viewport, about 1.3 screens; Home A in privacy mode 1,300 px.

## Recommendation

- **Home: C** (revision 2). Same priority as A, noticeably less empty width and no scrolling on the device. Earlier comparison of A and B: It keeps Home A's single column and adds only one new section (the AV band); the artist pick takes over the existing 다시 만난 작가 slot with the same collage the artist screen uses, so tapping it leads somewhere that looks the same. In privacy mode the AV band simply disappears without leaving a hole. B mirrors PC Home B, but at 800 px the artist strips shrink to about 70 px tall and the AV card squeezes the case; it is only better if seeing three artists at once matters more than image size.
- **Artist screen: as mocked** (one design). A 3-column grid gives about 248 px tiles, close to the PC's cell size, and the mosaic keeps the PC hero at full width with its details underneath.
- **AV list: both views** behind the 작품 · 배우별 switch (user request); 작품 is the default because it matches the other collection types.
- **AV detail: as mocked** (PC 1A stacked vertically): case first, identity second, people and shelves below, 자세한 정보 folded.

## Decisions for the user

Revision 2 settled the earlier questions (transfer tiles, bookmark on every poster, unmarked titles shown, auto-tag tile dropped, privacy toggle in Settings with the AV tab hidden, both AV views, the "PC 앱에서" line). Still open:

1. Home C (recommended) as the layout to build?
2. In Home C the shelf covers are smaller (146 px tall). Is that still large enough, or trade the 자산 현황 block for bigger covers?
3. Which view should the AV list open in by default: 작품 (as mocked), or whichever the user used last?

## Data notes

- The server already has `/v1/home/upcoming` (+ wishlist intents), `/v1/home/av-pick`, `/v1/library/artists` and the cover media ticket route, but the PC does not publish to them yet (stage 1). AV Collections are excluded from the replica today (`cloud/collections.rs`), so the AV tab needs that publish first. A wishlist change made on the tablet is an intent the PC applies; the sheet says so.
- New server routes used by the app must be allowlisted in `NetworkPolicy.java`, or the app shows 오프라인.
