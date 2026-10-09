# Kakao unlinked works — mockup (2026-10-09)

Status: proposal, awaiting the user's choice. Mockup only; no app source changed.

Request (user, 2026-10-09): 122 of 150 manga works have no Kakao (Kakao/Daum book search) binding and 10 of the 28 bound works hold only some volumes, because linking is manual per work. Show the works without a Kakao link and link each with one click, the work leaving the list without a flash.

`index.html` loads the app's real `fonts.css`, `tokens.css`, `shared-base.css`, `controls.css` and `collections/book-connect.css` (the shipped Kakao dialog), so the dialog is the real one with small changes. PC frames are 1440×900; tablet frames are 800×1280 portrait, shown at 75 %. In the A-1 and B-1 PC frames you can click 찾기 (or a cover) and then 연결 or 연결 안 함 to see the row or cover leave. `?only=<frame id>` (`pcA`, `pcA2`, `pcA3`, `tabA1`, `pcB`, `pcB2`, `tabB1`, `strip`) shows a single shot for screenshots; `shot-*.png` are the render checks.

## Shared rules (both variants)

- **One click:** the existing Kakao dialog (`KakaoConnectDialog` on PC, `BindSearchSheet` on the tablet) opens with the search already run. The work is named at the top (cover, name, owned volumes). A result whose title equals the query is pre-selected, so a correct match takes one more click (연결). Busy text follows the delayed-busy rule: a skeleton only after 300 ms and "검색 중…" only after 400 ms.
- **Default query:** the work name if it contains Hangul; otherwise the first Korean (`ko`) alternate title from the work's MangaDex binding; otherwise the name, marked 한국어 제목 없음. The source shows as a faint label. An edited query is kept for that work, and a successful link stores it as the binding query, as today.
- **After linking:** the dialog closes (140 ms); then the row tints toward `--color-success` with a check (140 ms), holds about 0.6 s, and folds away (height to 0 with a fade, 220 ms, ease-in-out) while the rows below glide up. The count drops once when the fold starts, and focus moves to the next row's 찾기. Reduced motion removes the row at once. There is no success toast. A failure keeps the dialog open with one line and 다시 시도.
- **연결 안 함:** a ghost button at the dialog's bottom left (the dialog is where you learn there is no Korean edition) and on row hover. It reuses the existing `hideConnectionPrompt` flag (작품 편집 → 카카오 연결 안내 숨기기), which PC, tablet and server already share, and it shows a 되돌리기 toast. The 제외 tab lists these works with 다시 점검, so the list can reach zero.
- **Tablet:** a tablet link is a request the PC applies (`fileBindRequest`). A requested work leaves the list immediately into a folded **PC 적용 대기 N** line at the bottom.

## Variant A — 연결 점검 screen (recommended)

- **Entry:** a new shortcut on the 만화 section bar's shortcut row, after 쇼케이스 and 신간, labelled **연결 점검 122**. It is hidden at 0. The tablet puts the same entry in the shade's second row.
- **PC:** the shortcut swaps the list for the view (as 신간 does), with the title ‹ Kakao 연결 점검. A segmented control switches between **미연결 122 · 일부 권 10 · 제외 0**. Each 48px row shows a cover, the name with author · volumes, an **editable query field**, the query source and **찾기**; 연결 안 함 appears on hover or focus. Keyboard: ↑↓ moves between rows, Enter searches and Enter in the dialog links.
- **일부 권:** one small square per known volume, filled when the binding has that volume, with the missing range as text (`13–14권 없음`). **다시 연결** opens the same dialog with the bound query, the bound groups already ticked and look-alike groups listed first. **이대로 두기** moves the work to 제외.
- **Tablet:** the shortcut opens the bottom overlay (the existing Collections shortcut surface). Rows are 64px and the whole row opens the sheet; a trailing ⋯ (44px) holds 연결 안 함. The second line shows `검색어 … · MangaDex` only when the query differs from the name.

## Variant B — Kakao filter on the normal 만화 list

- **PC:** a **Kakao ⌄** menu beside 정렬 and 내 별점 offers 전체 / 미연결 122 / 일부 권 10 / 제외. The usual 격자/선반/책장 view is filtered, with the heading `Kakao 미연결 122` and 필터 초기화. While the filter is on, clicking a cover opens the Kakao dialog (hover shows a 찾기 scrim badge), and the query appears under the title only when it differs from the name. 일부 권 shows an `8/13권` scrim badge. A linked cover gets a check, fades out, and its neighbours glide into place (FLIP).
- **Tablet:** a filter chip `Kakao 미연결 122 ✕` at the top of the list, and a Kakao segmented row in the existing 보기 sheet. Tapping a cover opens the sheet; long press opens the work.
- **Trade-off:** no new screen, but the query cannot be seen or edited before the dialog opens, and a cover click changes meaning while the filter is on.

## Placement notes

- `MangaConnections.tsx` / `mangaConnections.css` render the per-work 발매 정보 block inside a work screen; that block is not a list home. Both variants reuse only the connect dialogs.
- 더보기 is the app-wide queue panel; a cleanup for one Collection type is too narrow for it.
- Found while mocking: the shipped `book-connect.css` marks a pressed result with `box-shadow: inset 2px 0 var(--color-accent)`, a left accent edge stripe that `DESIGN.md` §12 forbids. The mockup overrides it to face-only, so fix it when the dialog is touched.

## Open questions for the user

1. A or B? (Recommendation: A.)
2. Entry: the shortcut-row item **연결 점검 N**, hidden at 0, or a quieter ⋯ menu item? Should it also appear in Home 확인할 것?
3. 일부 권: what is "all volumes" — the MangaDex volume count, the owned/local volumes, or the highest Kakao volume number?
4. 이대로 두기 for partial works needs a new per-work mark, because `hideConnectionPrompt` only covers unlinked works. Add it, or keep partial works listed until they are fixed?
5. Tablet: skip the "이 작품으로 연결할까요?" confirm step when the sheet is opened from this list (a single 연결 요청)?
6. Walk-through: after 연결, should the dialog move straight on to the next work, with a 건너뛰기 button, instead of returning to the list?
7. Is pre-selecting the exact-title result acceptable, or should every link be an explicit pick?

## Implementation notes (for the controller)

- The list needs per-manga-work Kakao binding state, the bound volume range, a reference volume count and the MangaDex `ko` alternate title. Check what the PC library read and the tablet server read already expose before adding a read.
- `KakaoConnectDialog` already takes `initialQuery`; it needs to search on open, show the work line, pre-select an exact match and gain 연결 안 함. `BindSearchSheet` already searches on open.
- Another agent is changing the Kakao search code (`aladin*.rs`, `kakao_books.rs`, `collection_bindings.py`, `KakaoConnectDialog.tsx`), so schedule the implementation after that work lands.
