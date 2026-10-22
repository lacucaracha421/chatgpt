# AV candidate dialog cleanup (2026-10-18)

Status: proposal (design mockup and spec). App source is unchanged. User request: "AV 컬렉션 표지 생성 창이 너무 난잡한 거 같은데, 한 번 정리 가능할까?" The area is an existing screen that no redesign round has touched yet (`AvLinkChooserDialog`, tablet `AvInboxChooser`). User decisions folded in during this round: AV directors are no longer imported; AV genres are shown in Korean through a fixed literal translation table.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page: audit (0), PC states A–F as before/after pairs (1440 × 900 window, scaled; 실제 크기 shows 1:1), tablet section G, decisions, gaps. Static. |
| `tablet.html` | One portrait tablet (800 × 1280), loaded five times by `index.html` in iframes (`#a-before`, `#a-after`, `#e-before`, `#e-after`, `#b-after`). Loads `mobile.css` instead of the PC base CSS, as the tablet does. |
| `avcover.js` | Stand-in candidates in the shapes of `AvLinkCandidate` / `InboxDetail`; the **current** markup (copied from `AvLinkChooserDialog.tsx` and `AvInboxChooser.tsx` with their class names) and the **proposed** markup; the mockup genre table. |
| `avcover.css` | **Proposed** CSS (would replace the chooser blocks of `src/collections/avLink.css` and `mobile-client/avInbox.css`). |
| `mock.css` | Mockup only: the light 종이 theme stand-in (from `../../archive/prototypes/home-calendar-20261017/`), stand-in pictures, frame helpers. |
| `page.css`, `tablet-page.css` | Mockup only: document and tablet frame. |
| `img/*.svg` | Stand-in jackets at real pixel sizes: `a-wrap` 2184 × 1468 (split 1032/1152, the server default), `b-wrap43` 2184 × 1638 (4:3, no spine, x1 = x2 = 1092) with `b-dvd` 800 × 438 (spine 382–418, as in `test_spineless_digital_jacket_takes_the_spine_of_the_dvd_wrap`), `c-wrap800` 800 × 538 (378/422), `d-front` 800 × 1135, `e-wrap` 2184 × 1468 and `e-old` 800 × 538 (the existing work's covers). |
| `app-css/` | Copies of the app's CSS in the repository layout (relative imports keep working), copied 2026-10-18: `src/styles/{tokens,fonts,shared-base,shared-surfaces,shared-toolbars,shared-states,shared-hover,controls,surface-motion,chrome}.css`, `src/styles/fonts/PretendardVariable.woff2` (+ OFL), `src/collections/avLink.css`, `mobile-client/{mobile,library,avInbox}.css`. |

### Files `index.html` loads (for publishing)

```
index.html
app-css/src/styles/tokens.css
app-css/src/styles/fonts.css            (imported by tokens.css)
app-css/src/styles/fonts/PretendardVariable.woff2
app-css/src/styles/shared-base.css
app-css/src/styles/shared-surfaces.css
app-css/src/styles/shared-toolbars.css
app-css/src/styles/shared-states.css
app-css/src/styles/shared-hover.css
app-css/src/styles/controls.css
app-css/src/styles/surface-motion.css   (imported by controls.css)
app-css/src/styles/chrome.css
app-css/src/collections/avLink.css
avcover.css
mock.css
page.css
avcover.js
tablet.html                             (iframe)
  app-css/mobile-client/mobile.css      (imports tokens.css and controls.css above)
  app-css/mobile-client/library.css
  app-css/mobile-client/avInbox.css
  tablet-page.css
img/a-wrap.svg
img/b-wrap43.svg
img/b-dvd.svg
img/c-wrap800.svg
img/d-front.svg
img/e-wrap.svg
img/e-old.svg
```

`fonts.css` also names Anton, Cinzel and Noto Sans KR files that are not copied; nothing on this page uses them (they 404 harmlessly). No external hosts. The page follows `prefers-color-scheme`; 자동 / 어둡게 / 밝게 sets `data-theme` and forwards it to the tablet iframes by `postMessage`. The app itself ships only the dark theme.

## What was cluttered (audit)

Rendered statically with the app CSS for five candidates (screenshots listed at the end).

1. The destination — the most important decision — is a sentence with an underlined link in the header ("이 품번과 맞는 AV 컬렉션이 없어요. 기존 컬렉션에 연결…"); choosing opens a native select in place.
2. The same picture appears four times: jacket, the 뒤/옆/앞 zones on it, and three "지금 → 후보" crop pairs below. For a new collection the three "지금" boxes are all "없음".
3. Too many controls at once: 3 × 3 surface buttons (the three 유지 are always disabled for a new collection), a checkbox per field, a native select + input per person, genre toggles, 거절 · 나중에 · 만들기, and ✕ · 원본 페이지 열기.
4. Three names for the same parts: 뒤 · 옆 · 앞 on the jacket, 뒤표지 · 책등 · 앞표지 in the cards, "뒤 | 옆 | 앞" in the hint.
5. 46 px translucent zone letters over the artwork, pixel badges in the zone corners, and a permanent "원본 2184 × 1468 · 책등 120px · 5.5%" line.
6. Always-on instructions ("펼친 재킷 · 선을 끌어 뒤 | 옆 | 앞 나누기", "체크한 항목만 들어갑니다", 출처 line, a "LibreDMM" column heading) — against DESIGN §12 Words.
7. Two equal columns that scroll separately; the surface choices fall below the fold of the cover column.
8. Borrowed DVD spine (SNOS-130): the two lines are 1 px apart and read as one, the spine zone is invisible, the meta reads "책등 1px · 0.0%", and the spine card shows text ("DVD 표지에서") instead of the spine.
9. Front-only candidate: half-visible "뒤 / 옆" letters at the left edge, "책등 0px · 0.0%", and disabled buttons for surfaces that do not exist.
10. Metadata is a fully expanded 9-row table that looks like nine decisions although it is almost always accepted as is; genres are raw Japanese including sale tags ("セール対象商品", "KMPグループ大感謝祭40％オフセール", "サンプル動画").
11. Non-shared parts and legacy sizes: native checkbox/select/input, a local segmented control, 13/18 px type and 30/38/46/78 px heights, `window.confirm`, and "후보를 불러오는 중…" text.
12. Two ways to close (✕ and 나중에); the title ("새 AV 컬렉션으로 만들기 / 후보 확인") repeats the destination choice.

Adjacent, out of scope: the inbox rows (`AvLinkInbox.tsx`: "Chrome에서 보낸 품번 · 적용 전", two-line status explanations) carry similar prose; record separately if wanted.

## Proposed layout (PC)

Dialog `workspace` size reduced to `min(80rem, 100vw − 24px) × min(50rem, 100vh − 24px)` (1280 × 800 at 1440 × 900).

```
┌──────────────────────────────────────────────────────────────────────┐
│ SONE-512  LibreDMM · 21:45                                        ↗  │ 56
├───────────────────────────────────────────────┬──────────────────────┤
│  (stage, --color-bg)                          │ ■ 넣을 곳 ─────────  │
│   ┌──────────────┬─┬──────────────┐           │ ▣ MIDV-032  2022 …   │
│   │   back       │s│   front      │  ← hero   │ ＋ 새 컬렉션       ▪ │
│   │              │p│              │    jacket │    이름 [SONE-512] 원제로
│   └──────────────┴─┴──────────────┘           │ 🔍 다른 컬렉션…        │
│     뒤표지 ⌄      책등 ⌄     앞표지 ⌄           │ ■ 정보 ───── 자세히 ⌄ │
│   ⚠ 책등이 좁아요  ↺ 자동으로     2184 × 1468   │ 원제 / 발매 / 제작 /   │
│                                               │ 출연 / 장르 (읽기만)   │
├───────────────────────────────────────────────┴──────────────────────┤
│ 거절                         표지 3면 · 정보 6개   [나중에] [만들기]    │ 64
└──────────────────────────────────────────────────────────────────────┘
          minmax(0, 1fr)                                400 px
```

- **Header (56):** the product code in the title role (20, 600), then the faint meta `LibreDMM · 21:45`, then one quiet icon button `LibreDMM 원본 페이지 열기` (↗) at the right. No ✕ (see decisions). The dialog's accessible title is `AV 후보 SONE-512`.
- **Stage (left):** `--color-bg` face, one step darker than the dialog, so the jacket is the first thing seen. The jacket is centred, as large as fits (`height ≤ 560`, width ≤ the stage), aspect kept. Nothing is printed on the artwork except the cut lines and, where a surface keeps its current image, a scrim `지금` badge.
- **Side (right, 400 px):** `넣을 곳` then `정보`; it scrolls on its own only when 자세히 is open.
- **Footer (64):** `거절` (danger) at the left; at the right the faint summary (`표지 3면 · 정보 6개`, or `넣을 곳을 고르세요`), `나중에` (secondary) and one primary: `만들기` (new) or `적용` (existing).

Narrow windows (below ~1000 px wide or 640 px high): the body becomes one scrolling column — stage, then side — with the jacket at `min(560px, 60vh)`; header and footer stay fixed. Not drawn; check at 800 × 640 and 125% scale during implementation.

## Stage: split editor and surface choices

**Lines.** Keep today's cut line (2 px white with a black outline and a small cap; accent while hovered, focused or dragged) — it reads on any jacket. Hit area 12 px on PC, 44 px on the tablet. Drag with the pointer; `←/→` 1 px, `Shift+←/→` 10 px (unchanged); `role="slider"` with `aria-valuenow` in jacket pixels.

- **Numbers only while needed:** while a line is focused or dragged, a small elevated badge next to it reads `뒤표지 1,100 · 책등 20px` (or `앞표지 …`). Otherwise no pixel numbers on or under the jacket; the original size stays as one faint `2184 × 1468` at the stage's bottom right.
- **Warning:** when a jacket's own spine is below 1% or above 12% of the width, one danger meta line under the labels: `책등이 좁아요` / `책등이 넓어요` (replaces "책등이 너무 넓거나 좁아요 — 선을 확인하세요").
- **자동으로** (quiet, ↺) appears only after the lines were moved or while the warning shows; it restores the server estimate (`defaultSplit`).
- **Borrowed spine** (`isWrap && useSpine && x1 === x2`, e.g. SNOS-130): draw **one joined line** with a wider cap instead of two lines 1 px apart. Its accessible description says pulling it apart cuts a spine from this jacket. Pulling the halves apart by ≥ 1% of the width switches to cutting the spine from this jacket — today's server rule (`SPINE_MIN_SHARE`) unchanged; then `DVD` leaves the spine label and 자동으로 appears. Today the PC keeps a 1 px gap between the lines; the server already treats that as "no spine of its own", so the joined line can send `x1 === x2` or keep the 1 px internally.
- **Front-only** (`isWrap` false): no lines and no spine/back labels for a new collection.

**Surface labels = surface choices.** Under the jacket, centred under each zone: `뒤표지 ⌄`, `책등 ⌄`, `앞표지 ⌄` (compact quiet buttons, body size, muted). A label adds its state only when it is not the plain candidate: `지금` (keep the current image), `없음` (clear), `DVD` (borrowed spine). One term set everywhere: 뒤표지 · 책등 · 앞표지 (the single letters 뒤/옆/앞 are retired).

- A label opens the shared `Menu` (PC; tablet: bottom sheet) with one row per available choice, each with its thumbnail and size: `후보` (the crop, e.g. `1,032 × 1,468`; for a borrowed spine `DVD 표지의 책등` with the DVD spine strip), `지금 것 유지` (current image, its size; only when the work has that surface), `비우기`. The current choice is weight 600 with the 5 px accent square (§12 menus). Spine thumbnails lie sideways, 160 px long, so the strip is readable.
- **The stage shows the result.** A kept surface shows the current image inside its zone (contained, `--color-surface` behind) with a `지금` scrim badge; a cleared zone is dimmed (`--color-bg` 78%). So the jacket preview is what the case will get.
- Front-only + existing work: the label row also carries `책등 지금 ⌄ · 뒤표지 지금 ⌄` at its right end (choices: 지금 것 유지 / 비우기), since those surfaces have no zone.
- Defaults are unchanged (`resetFromCandidate`): new → candidate where the candidate has the surface, else clear; existing → keep where the work has the surface, else candidate.
- Removed: the three "지금 → 후보" crop pairs, the 3 × 3 segmented buttons, zone letters and pixel badges, the "원본 … · 책등 …px · …%" line, the "펼친 재킷 · 선을 끌어…" hint.

## Side: 넣을 곳

`SectionLabel` "넣을 곳", then a radio group of rows (two-line row height; tablet 64):

- Each existing collection with the same product code (`matches`, or `current`): 28 × 40 cover thumbnail, name, faint meta `2022 · 표지 3면`.
- `새 컬렉션` (＋ mark). While chosen, a `이름` field sits under it (shared `Field` + `TextInput`, prefilled with the product code) with a quiet `원제로` button (the former 원제로 채우기).
- `다른 컬렉션…` (magnifier) opens an anchored picker with a search field over the AV collections (tablet: bottom sheet) instead of the native select. Picking one adds it as a chosen row and reloads the candidate for it (`getCandidate(inboxId, id)`, as today).
- Chosen row: a faint text-tinted face (`color-mix(--color-text 7%)`), weight 600 and the 5 px accent square at the right. Arrow keys move inside the group (radio semantics).
- Starting choice as today: one match → that match; none → 새 컬렉션; several → nothing chosen (primary disabled, summary `넣을 곳을 고르세요`).
- A chosen collection whose product code differs shows a danger meta `품번이 다른 컬렉션` on its row and disables the primary (the tablet already blocks this).

## Side: 정보

`SectionLabel` "정보" (existing work: "바뀌는 정보") with a quiet `자세히 ⌄` / `접기 ⌃` action.

**Collapsed (default): read-only summary.**
- New: the original title (body, `lang="ja"`, 3-line clamp), then label/value rows with a 48 px faint meta label: `발매` (shared date formatter), `제작` (maker · label), `시리즈` (only when present), `출연` (names, + `새 인물 N` badge when people will be created), `장르` (Korean names, hidden tags left out).
- Existing: only what will change — filled empty fields (`레이블 ティッシュ`), differing values that are left alone (`발매 2023.8.1 → 2023.8.11` + `다름 · 그대로 둠`), added people (`+ 早乙女りん` + `새 인물 1`) and added genres (`+ 치녀 · 기승위 · 펠라치오`), then a faint `같음 N개`.

**자세히 (expanded):** the same data, editable, in the 400 px column:
- One row per field (원제, 발매일, 제작사, 레이블, 시리즈): shared `Checkbox`, faint label, the candidate value; for an existing work a meta line `지금 … ` with a `같음` / `다름` / `빈 칸` badge. Defaults as today (`fieldChecks`): checked when the candidate has a value and the work's field is empty (or always for a new collection); disabled when equal or empty.
- `출연 N`: one row per performer — `Checkbox`, name (a `TextInput` for the Korean display name when it will be a new person), Japanese name in meta, and one quiet `새 인물 ⌄` / `기존 인물 ⌄` button that opens a small popover: search existing performers (today's `searchPeople` + credit check), `새 인물로`. Already linked performers show a check mark and `이미 연결됨`, no controls.
- `장르 N`: shared `FilterChip`s with the Korean names (pressed = applied); a faint `판매·샘플 태그 N개 숨김` line when tags were left out.
- **No 감독 row** (below).

## Removed, merged, moved

| Today | Proposal |
| --- | --- |
| Title "새 AV 컬렉션으로 만들기 / 후보 확인" + code | Code as the title; destination says new/existing |
| Header prose + underlined link + native select | 넣을 곳 rows + 다른 컬렉션… picker |
| "출처 LibreDMM · 21:45 조회" + "원본 페이지 열기" button | Faint `LibreDMM · 21:45` + ↗ icon button |
| ✕ and 나중에 | 나중에 (and Esc) only (decision) |
| 뒤/옆/앞 zone letters, pixel badges, size/spine line | Nothing on the art; numbers on focus/drag; one faint size |
| Three 지금 → 후보 crop pairs + 9 buttons | Labels under the zones with one menu each; result shown on the jacket |
| "자동 추정으로" always shown | `자동으로` only after a move or with the warning |
| 9-row checkbox table, "LibreDMM" column, "체크한 항목만…" | Read-only summary; 자세히 for the checkboxes |
| Native select + input per person | One link button + popover per person |
| 감독 row | Removed (not imported) |
| Raw Japanese genres incl. sale tags | Korean names; sale/sample/distribution tags hidden |
| `window.confirm` for 거절 | App confirmation dialog: jacket thumbnail, `후보를 거절할까요?`, button `거절` |
| "후보를 불러오는 중…" | Skeleton in the dialog's shape (jacket block + side lines), shown after 300 ms |
| Local segmented buttons, legacy sizes | Shared `Button`, `Checkbox`, `TextInput`/`Field`, `Menu`, `Badge`, `SectionLabel`, `FilterChip`; §12 roles |

## States and behaviour

- **Loading:** skeleton (jacket-shaped block, three label stubs, side rows) fading in after 300 ms; nothing for fast loads.
- **Error loading:** one line + `다시 시도` in the stage. **Apply error:** one-line toast with `다시 시도`; the dialog stays. **Stale (`av_stale`):** reload the candidate for the same destination, keep the user's line positions and choices where still valid, and show one meta line in the footer `다른 곳에서 바뀌어 다시 읽었어요`.
- **Busy:** buttons disabled; the primary shows `만드는 중` / `적용하는 중` through the shared delayed busy label (only after ~400 ms).
- **Privacy mode:** the jacket, menu thumbnails and destination thumbnails become plain `--color-surface` faces (no "비공개 모드" text); everything else is unchanged.
- **Keyboard:** Tab order ↗ → line 1 → line 2 → 뒤표지 → 책등 → 앞표지 → (자동으로) → 넣을 곳 group (arrows) → 이름 → 원제로 → 다른 컬렉션… → 자세히 → (fields) → 거절 → 나중에 → primary. Enter/Space/↓ opens a label menu; Esc closes the innermost surface first (menu, popover, picker), then the dialog (= 나중에). Focus returns to the inbox row's opener.
- **Motion:** menus/popovers 140 ms (shared); 자세히 expands in place with the 140 ms open/close timing; content never blanks while a destination reload runs (old content stays, `inert`, until the new candidate is ready).
- **Tablet re-check notice** (`previous` plan): one line under the title, `다시 확인함 · 표지 바뀜` (instead of the current three-sentence status).

## Tablet (follows the PC)

The same pieces stacked in the tall stacked `BottomSheet`: sheet title = the code with the faint `LibreDMM · 21:45` beside it (BottomSheet `heading`), ↗ next to ✕ (`headerActions`; the sheet keeps ✕ by sheet convention), then the full-bleed dark stage with the jacket at sheet width, labels (44 px), 넣을 곳 (64 px rows), 정보 summary with 자세히, and the sticky footer. Label menus, the person popover and the 다른 컬렉션 picker open as bottom sheets. Lines have 44 px handles.

Sharing (DESIGN §12 "What PC and tablet share"): the stage (jacket + lines + labels + menu content), the destination list, the facts summary/field list and the genre table are one set of shared pieces under `src/collections/` that take plain data; the PC dialog and the tablet sheet arrange them. Data access stays per client (PC `avLinkClient` local commands; tablet server inbox `avInboxApply`).

## Directors are no longer imported (user decision)

Remove the 감독 row from the dialog and stop sending directors on apply; directors already credited on a work stay. Where it happens today (no code changed in this round):

- **Server lookup:** `server/lakomics-api/av_inbox.py` — `parse_movie` keeps `directors` (~line 153, counted at ~161), director names are resolved with the performers (`names` at ~170 and ~559), and the candidate carries `directors=[…]` (~564). The server may keep parsing them but should stop resolving names for them (saves lookups) or drop them from the candidate.
- **PC (Rust):** `_tools/app/src-tauri/src/library/av_link/apply.rs` (~59, ~128, ~301 `request.directors`, role `"director"`) and `routed_apply.rs` (~206, ~406–408, `parsed.movie.directors`); `models.rs` / `provider.rs` carry the field. Accept an empty list; the UI sends `directors: []`.
- **PC UI:** `src/collections/AvLinkChooserDialog.tsx` — the `감독` `PeopleRow`, `peopleChecks.directors`, `directors` drafts and `peopleRequest(candidate.directors, …)` in `apply()`; candidate `directors` enrichment in `load()`.
- **Tablet:** `mobile-client/avInboxApply.ts` (people built from `c.directors` at ~118, change detection `출연·감독` at ~106 → `출연`, validation at ~195) and `mobile-client/AvInboxChooser.tsx` (the `['performer','director']` loop).

## AV genres in Korean (user decision)

- **One fixed table**, not live machine translation: `src/collections/avGenreNames.ts` (next to the MangaDex `genreNames.ts`, same pattern), exporting e.g. `avGenreName(ja)`, `isHiddenAvGenre(ja)` and `displayAvGenres(list)`. The tablet imports it from `src/` (as it imports `performerName`); no copy. If the server ever needs the names (server-side search or a server-rendered list), move the map to a JSON file (`src/collections/avGenreNames.json`) that the TS module imports and the server deploy ships; today the server stores and serves the original strings and does not translate.
- **Literal translations, no euphemisms or softening** (user: "에둘러 표현하지 말고 번역해 줘"). Starter entries used in the mockup: 単体作品 단독 출연작 · ハメ撮り POV 섹스 · 美乳 예쁜 가슴 · 巨乳 큰 가슴 · 淫乱・ハード系 음란·하드 · 3P・4P 3P·4P · 中出し 질내사정 · フェラ 펠라치오 · 騎乗位 기승위 · 潮吹き 분수 · 痴女 치녀 · 人妻・主婦 유부녀·주부 · 美少女 미소녀 · スレンダー 슬렌더 · ドラマ 드라마 · デビュー作品 데뷔작 · 寝取り・寝取られ・NTR NTR · 素人 아마추어 · 企画 기획물 · 水着 수영복 · 野外・露出 야외·노출. The full DMM genre list is collected and filled in during implementation.
- **Fallback:** a tag not in the table shows its original Japanese (e.g. `ギリモザ`).
- **Stored value stays the original.** Translation is display-time, like MangaDex tags; search matches either the Korean name or the stored original.
- **Hidden as non-genres:** sale, event, sample and point tags — anything containing `セール`, `％オフ`/`%オフ`, `感謝祭`, `キャンペーン`, `期間限定`, `ポイント還元`/`ポイントN倍`, and exactly `サンプル動画`. Proposed (decision): also the quality/distribution tags `ハイビジョン`, `4K`, `独占配信`, `配信専用`. Hidden tags are not offered (or applied) from the candidate and are left out wherever stored AV genres are shown (collection info panel `CollectionInfoPanel.tsx`, tablet `Collections.tsx`, AV edit panels, this dialog); already stored ones stay in the data.

## Decisions for the user

| Item | Proposal | Alternative |
| --- | --- | --- |
| Where surface choices live | Label menus under the jacket; the jacket shows the result | A separate row of three result tiles with a choice under each |
| Existing-work default | Keep today's rule: keep the current image | Default to the candidate when it is larger than the current image (e.g. 2184 vs 800 px) |
| Closing | Drop the PC ✕; 나중에 and Esc | Keep ✕ as well |
| 거절 confirmation | App confirmation dialog with the jacket thumbnail | No confirmation + "되돌리기" toast (needs server undo) |
| Quality/distribution tags | Hide `ハイビジョン`, `4K`, `独占配信`, `配信専用` | Translate and show them (고화질, 4K, 독점 배포, 전송 전용) |
| Tablet line editing | Movable lines on the tablet too (today: server split only) | Tablet shows the lines read-only |
| New collection name | Product code, with 원제로 | Original title by default |

## Not verified

- Not seen in the running app; both versions are static renders of copied app CSS with stand-in jackets, titles and names (product codes are real formats only).
- Showing the borrowed DVD spine on the PC needs its image in the PC candidate (the server's `spineSource`); `AvLinkCandidate` has no such field today.
- Narrow windows (800 × 640), 125% app scale, and long Korean/Japanese titles in the side column were not drawn.
- The light theme is the page-only 종이 stand-in.
- The genre table is a starter subset; the hide patterns must be checked against the real DMM tag list (e.g. that no real genre contains `セール`).

## Screenshots (audit, headless Edge)

In the session scratchpad, not the repository: `shots/{a,b,c,d,e}-{before,after}.png`, `b-after-menu.png`, `e-after-details.png`, `f-after-line.png`, `tablet-{a-before,a-after,e-before,e-after,b-after}.png`.
