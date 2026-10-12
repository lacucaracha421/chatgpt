# Arca Live picker panel — design spec (2026-10-13)

Status: proposal for `COLLECTOR-PICKER-001`, desktop Chrome, Arca Live post writing (`arca.live/b/{channel}/write`) only. Open `index.html` (static, no network; grey rectangles stand in for artwork, the Arca page is a rough stand-in, amber dashed boxes/tags are annotations). Frames: A dark (folder chosen, 3 selected, hover), B light (inserting: 넣음 / 실패 / 올리는 중 / 대기), C–G states, H preview, I toolbar button states.

Visual language: the extension's own palette and font (`extension-list/options/options.css`, `src/context-menu/menu.css`: `Pretendard Variable` stack, ink accent on light, ivory accent on dark), DESIGN.md §12 sizes (PC roles 20/15/12, controls 32/28, badges 20 radius 2, spacing 4–32). No new tokens.

## 1. Entry points

- **Toolbar button.** Inserted directly after Arca's `button#imagesMultiUpload-1[data-cmd=imagesMultiUpload]` ("이미지 업로드"), inside the same toolbar group.
  - Markup: `<button type="button" class="lakomics-arca-pick" aria-label="Lakomics에서 그림 넣기" aria-pressed="false" aria-keyshortcuts="Alt+Shift+L">` + the Lakomics mark (`M2 2h8v2H4v16h14v-6h2v8H2zM8 8h12v4H8z`, viewBox 22×24, drawn 18×20, `fill: currentColor`).
  - No `data-cmd`, no `fr-*` classes and no `title`, so Froala does not treat it as its own command and no tooltip appears (DESIGN.md §9).
  - Size and icon colour: copy the neighbour button's computed `width`, `height`, `color` and `margin` once on insertion. Hover face `color-mix(in srgb, currentColor 10%, transparent)`, pressed face (panel open, `aria-pressed="true"`) 18%, keyboard focus a 2px focus-blue outline inset 2px (`#2f6fdb` light, `#7db1ff` dark).
  - Insertion is idempotent: a `MutationObserver` on `form#article_write_form` re-adds the button if Froala rebuilds the toolbar. If the toolbar is never found, there is no button and the shortcut still works.
- **Shortcut** `Alt+Shift+L`: a manifest `commands` entry, so the user can rebind it at `chrome://extensions/shortcuts`. It toggles the panel. Only on `arca.live/b/*/write` (and the edit page if its URL differs, to be checked); elsewhere it does nothing.
- The panel never opens by itself.

## 2. Panel placement

- Host: `<div id="lakomics-arca-picker">` appended to `document.documentElement`, with a **closed** shadow root holding all panel DOM and CSS. Position `fixed; top:0; right:0; bottom:0; width:360px; z-index:2147483646`, one below the context menu's max so the right-click menu still shows above it.
- Docked to the right edge at full viewport height, with a 1px left line and a soft shadow. It is edge-attached, so radius 0 and no corner brackets.
- **Do not cover the editor text column.** On open, measure `form#article_write_form`. If at least 376px (360 + 16) is free to its right, the panel overlays that free gutter (normally Arca's right sidebar), as in frame A. If not, push the page by adding a class that sets `margin-right:360px` on `<html>`.
  - Verify Arca's fixed navbar and footer with that class. If they break, overlay instead and scroll the caret into view.
  - Under 1024px of viewport width, always overlay.
- Theme follows Arca, not the OS. Detect the `dark-theme` class (seen on the editor; check `html` and `body`) and set `data-theme="dark"` on the host. Watch the class with a `MutationObserver` so an Arca theme toggle swaps the panel at once.

## 3. Anatomy (top to bottom)

| Part | Size | Content |
| --- | --- | --- |
| Header | 48 high; padding 0 8 0 16; gap 8 | Lakomics mark 14×16 (accent) · folder button (fills width, 32 high, face `--field`, radius 4, folder icon 16, path: parents muted + `›`, leaf weight 600, ellipsis from the left part, chevron 16) · close ✕ (28 square compact button, `aria-label="닫기"`) |
| Scope row | 36 high; padding 0 16 | toggle 32×18 + `하위 폴더 포함` (muted body) · right: eligible count `1,284장` (meta, faint, tabular) |
| Grid | rest of height | 3 columns, full bleed, 2px gaps, square crops (`object-fit: cover`), about 118px tiles, **18 per batch**, scrolls when the window is short. `role="grid" aria-multiselectable="true"` |
| Selection tray | 64 high; padding 0 8 0 16 | only when 1+ selected: 48px thumbnails in selection order, gap 4, number badge 16 high at the top-left, ✕ on hover (`aria-label="선택 해제"`) · `선택 해제` compact button (clears all) |
| Job list | 32 + 48 per row (max 4 rows visible, then scroll) | replaces the tray while inserting (§5) |
| Notice | 40 high | one-line problems tied to the page (editor not found) |
| Footer | 56 high; padding 0 16 0 8 | `다른 그림` compact button (refresh icon, faint `R` hint) · delayed busy label · primary `본문에 넣기 (N장)` (32 high) |

**Tile:**
- Default: the image only.
- Hover or keyboard focus: an empty 16px square check mark at the top-left (white 1.5px border, soft shadow) and a 28px scrim **⤢ preview button** at the bottom-right (`aria-label="크게 보기"`). Both fade in over 90 ms.
- Selected: a 2px accent ring inside the tile, plus a dark 1px line under the ring for contrast on bright art. The top-left shows a **number badge** (20 high, radius 2, accent face, on-accent text, weight 600, tabular) holding the insertion order.
- Keyboard focus: a 2px focus-blue inner ring.
- Inserted in this panel session: a scrim badge `✓ 넣음` at the bottom-left.
- Failed: the number badge turns danger red.
- No coloured edge stripes anywhere.

**Folder popover** (frame E):
- Anchored under the folder button, 8px in from both panel edges. It is a floating surface: square, 1px line, NieR corner brackets in the accent colour. It opens in 140 ms (fade + 4px rise).
- Search field `폴더 찾기` (32 high, face only; while typing, a 2px focus-blue bottom line).
- Tree rows: 32 high, 16px indent per level, chevron 16, name, count (meta, faint). The current folder is weight 600 with a 5px accent square at the right end. A keyboard row gets a 2px focus outline.
- Search filters the tree to matches and their ancestors, with the matched characters underlined and bold.
- Data comes from the existing `GET /v1/classifications` tree, using the collector's model in `src/classification-tree.js` (pins and order as already stored).

**Preview** (frame H):
- Opens only from the tile's ⤢ button or `P`, never from a click or a long hover on the tile.
- A floating surface to the **left of the panel**, over the page: about 590–620px wide (`min(620px, 100vw − 360 − 48)`), 40–48px from the top and bottom, with corner brackets.
- Header 44: position `5 / 18` (meta) · selection button (`선택` with an empty check box, or the number badge + `선택됨`) · ✕.
- Stage: the image with `contain` on a darkened face, plus 32px scrim ‹ › buttons.
- Footer 32: `1,536×2,048 · 1.4MB` (meta).
- It uses a larger preview rendition from the extension API, not the original.

## 4. Behaviour

- **First open:** no folder yet, so the popover opens at once and focus moves to its search field. After that, the last folder and the toggle are remembered in `chrome.storage.local`.
- **Batch:** the PC returns up to 18 random eligible images from the scope. The panel session keeps a seen set (in memory, until the panel's page unloads). `다른 그림` asks for images not in the seen set. When fewer than 18 unseen remain, it fills with the least recently seen, and the count reads `1,284장 · 모두 봄`.
- **Selection:**
  - Clicking a tile toggles it. A new selection appends to the end of the order; removing one renumbers the rest.
  - Selections **survive `다른 그림`** and folder changes; the tray keeps showing them.
  - There is no drag reordering in this round. To change the order, remove a picture and add it again.
- **Insert** (`본문에 넣기 (N장)`):
  - One image at a time, in selection order, at the remembered caret (§6).
  - The background fetches each original from the PC only at this point and hands the bytes to the content script.
  - The content script builds a `File` and dispatches a synthetic `paste` (with a `DataTransfer`) on `.write-body .fr-element.fr-view`, so Arca uploads the file itself.
  - Success means a new `img.fr-fic` whose `src` is on `ac.arca.live` appears (`MutationObserver`). The caret is then placed after that image and the next one starts.
  - Timeout is 60 s, which marks the image `실패 · 시간 초과`.
  - Never touch `textarea#content` directly (Arca mirrors it), and never click 작성하기 or submit.
  - The isolated-world dispatch and large or multiple images are still unverified (see the backlog).
- **No flash:**
  - `다른 그림` and a folder or toggle change keep the current grid on screen. The current grid is `inert`, not dimmed.
  - The new batch loads into detached `<img>` elements; when all of them pass `decode()` (cap 1.5 s; any that miss show the plain tile face), the grid children swap in one step.
  - Skeleton tiles appear only on the very first load, after 300 ms, breathing (opacity .55 → 1, 2.4 s).
- **Delayed busy labels:** `불러오는 중` (footer, next to `다른 그림`) and `올리는 중` (job rows) appear only after 400 ms. Once shown, they stay at least about 300 ms so they never blink. Reuse the `BUSY_DELAY_MS = 400` pattern from `src/youtube/content.js` (or lift it into a shared helper).
- **Motion:**
  - The panel slides in 16px with a fade over 200 ms, easing in with `cubic-bezier(.2,0,0,1)`, and leaves in 140 ms.
  - The popover and preview take 140 ms; hover controls 90 ms.
  - Everything is instant under `prefers-reduced-motion: reduce`, and the skeleton is static.
- **Privacy:**
  - Thumbnails and previews are `blob:` URLs created inside the closed shadow root and revoked when they are swapped out.
  - Nothing goes into page DOM outside the shadow root, and the site receives no bytes before `본문에 넣기`.
  - No absolute paths or tokens reach the page.
  - The private vault, trash, locked library and missing originals are excluded on the PC side.

## 5. States and strings (Korean UI)

| State | Where | Text / control |
| --- | --- | --- |
| Toolbar button | button | `aria-label="Lakomics에서 그림 넣기"` |
| Panel | host | `aria-label="Lakomics 그림 넣기"` (`role="complementary"`, not modal) |
| Folder | header | path, e.g. `캐릭터 › 블루 아카이브 › 아로나`; popover search placeholder `폴더 찾기` |
| Scope | row | `하위 폴더 포함`, count `1,284장`, all seen `1,284장 · 모두 봄` |
| Refresh | footer | `다른 그림` (+ faint `R`), busy `불러오는 중` |
| Selection | tray / tile | `선택 해제`; preview `선택` / `선택됨`; tile `aria-label="그림 5"`, selected `aria-description="2번째"` |
| Insert | footer | `본문에 넣기 (3장)`; disabled with 0 selected (shows `본문에 넣기`) and while a job runs |
| Job header | section label | `본문에 넣기 2/4` · `중지` (stops the queued rows; they stay selected) |
| Job rows | list | `대기` (faint) · `올리는 중` (muted, delayed) · `✓ 넣음` (success colour) · `실패` (danger) + reason in meta + `다시 시도` |
| Failure reasons | job row meta | `시간 초과` · `용량 초과` · `형식 미지원` · `원본 없음` · `PC 연결 끊김` |
| Done | tile | `✓ 넣음` badge on tiles inserted this session |
| PC not running / unreachable | body (EmptyState) | `PC Lakomics에 연결되지 않음` · hint `PC에서 Lakomics를 켜면 바로 이어집니다` · `다시 시도`; also retries silently every 5 s while open and swaps in when connected |
| Library locked | body | `PC Lakomics가 잠겨 있음` · `다시 시도` |
| Not paired | body | `연결 설정 필요` · `연결 설정` (opens the extension's pairing page) |
| Folder empty | body | `이 폴더에 그림 없음`; when the toggle is off and descendants have images: hint `하위 폴더에 4,102장` + button `하위 폴더 포함` |
| Editor not found | notice above footer | `본문 편집기를 찾지 못함` · `다시 시도`; browsing and selecting still work, insert disabled |
| Batch failed | toast-like notice line | `그림을 불러오지 못함` · `다시 시도` (old grid stays) |

Errors are one line plus `다시 시도`, and codes go to the console only. A job with no failures needs no success toast: the rows and tile badges already say `넣음`.

**After a job:**
- Succeeded images leave the selection.
- Failed ones stay selected with red numbers, so `본문에 넣기 (1장)` retries them. A row's `다시 시도` retries just that image at the current caret.
- The job list stays until the user selects something new; then the tray replaces it.

## 6. Keyboard and focus

- **Open** (button or `Alt+Shift+L`):
  - Save the editor's caret `Range` first. While the panel is open, keep updating it on `selectionchange` while the focus is inside `.fr-element`.
  - Focus moves to the first tile, or to the popover search on first use.
  - If the caret was never placed in the body, images go to the end of the body.
- **Grid:** one tab stop with roving `tabindex`.
  - `←/→` move by one tile and `↑/↓` by a row; `Home`/`End` jump to the ends.
  - `Space` toggles the focused tile's selection.
  - `Enter` runs `본문에 넣기` (nothing happens with 0 selected).
  - `P` opens the preview, and `R` runs `다른 그림`.
- **Tray:** one tab stop. `←/→` move, and `Delete`/`Backspace` removes the focused picture from the selection.
- **Tab order:** folder · ✕ · toggle · grid · tray · `선택 해제` · `다른 그림` · `본문에 넣기`.
- **Popover:** `↑/↓` move, `→/←` expand or collapse, `Enter` chooses and closes, and typing filters.
- **Preview:** `←/→` previous and next, `Space` select toggle, `Esc` close; focus returns to the tile's position.
- **Esc** closes the innermost surface only (popover → preview → panel) and never chains.
  - Closing the panel (Esc, ✕, the toolbar button, the shortcut) restores the saved range and focuses `.fr-element`, so typing continues where the user left off.
- **Scope of key handling:** keys are handled only when the event target is inside the panel host; the page's own shortcuts are untouched.
- **Focus while inserting:** the panel keeps focus during a job. The caret moves in the editor programmatically after each image.
- **Not a focus trap:** the user may click back into the editor at any time with the panel still open. The next insert then uses the new caret.
- **Live region:** one polite region announces `1장 넣음`, `2번 실패`, `모두 넣음`.

## 7. Not in this round

Reordering by drag, pinned or recent scopes, per-channel default scope, search by tag or character, the tablet (Titanium) bottom sheet, and other sites. When the tablet comes, it reuses this panel with DESIGN.md §12 touch sizes (44 controls, 17/13 type, bottom sheet).

## Open questions for the user

1. **After a successful insert, should the panel stay open (to add more pictures; Esc goes back to typing), or close by itself and return to the editor?** Recommended: stay open.
2. **When one picture fails in a multi-picture insert, continue with the rest, or stop there?** Continuing (recommended) keeps the order of the pictures that worked, and a retried picture goes in at the caret wherever it is then. Stopping keeps the exact order but needs a decision for every failure.
