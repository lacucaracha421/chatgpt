# Collection objects (cases and books) — approved design, 2026-10-04

Status: approved by the user on 2026-10-04 from the HTML prototype `docs/prototypes/game-case-depth-20261004/` (published as a private artifact; the local file embeds real library covers and stays out of the repository). This document is the implementation spec. PC is canonical; the tablet shares the same components (`mobile-client/CollectionWork.tsx` imports `CollectionCase`, `CaseInside`, `MangaBook`; `CollectionShelf.tsx` imports `LightCase`), so it follows in the same round. Where tablet data lacks a field, the face falls back as specified below.

Units: the work-stage case uses `--ch` (case height), `--cw = --ch * --ratio`, `--cd` (closed depth). Values below are relative to those so the shelf and work sizes stay one model.

## 1. Case geometry: two shallow trays joined by a flat spine

Replace the current single-plane lid and outer-face-only walls in `collections/case/CollectionCase.{tsx,css}`.

- **Trays.** The base tray occupies z ∈ [−cd/2, 0], the lid tray z ∈ [0, +cd/2]; each tray depth `--d = cd/2`. Closed, they meet at z = 0, which leaves a visible seam on the side walls (intended).
- **Walls.** Each tray has top, bottom and outer walls, each drawn as two planes: the outer face and an inner face inset by the wall thickness `--t = 2px` (`backface-visibility: hidden` on both). Add a rim lip (thin strip, width `--t`) on each wall top. Wall shading: outer top `#26282c`, outer bottom `#141518`, outer side `#1f2124`; inner top `#0e0f11`, inner bottom `#1a1c1f`, inner side `#15171a` (multiply over the platform plastic tint as today, so Switch 2 red / clear / black AV keep their colour).
- **Base hinge side.** No full wall; a low ridge (height d/2, facing inward) where the spine folds.
- **Spine.** Width cd. Open, it lies flat at the back plane between the two trays; closed, it is the left wall. Inner face of the spine: two living-hinge grooves at 22 % and 78 % width (2 px dark line + 1 px highlight).
- **Opening.** The lid turns a full 90° relative to the spine (today 86°), so the open lid lies flat; together with the flat spine this removes the "-_-" gap. Keep the existing 560 ms `--ease-standard` timing, drag behaviour and `prefers-reduced-motion` rule.
- **Text selection.** Already shipped: dragging never selects printed text (`user-select: none` on `.kase` / light case).

## 2. Tray interior

Plastic grain: a very faint SVG `feTurbulence` noise (alpha ≈ .05) as a data URI background on tray floors, lid inside and spine inside, over a `160deg` light-to-dark gradient.

**Game card cases (Switch / Switch 2):** a raised frame inset 9 % × 10 % on the floor; two horizontal ribs near the top (14 %–86 % width, at 15 % and 17.5 %); embossed `GAME CARD` (11 px, letter-spacing .32 em, colour ≈ floor with 1 px light/dark text shadows) at 40 % height; a recessed card well (bottom 8 %, centred, 28 % width, aspect 21:31, inset shadow) with retention nubs above and below, a finger notch beside it, and the game card showing a label cut from the front cover (`background-position: center 25%`, cover) with gold contacts at the bottom.

**Disc cases (PS5, other disc platforms, films, AV):** a moulded ring recess (86 % width, centred at 46 % height, inset shadow), two thumb cut-outs at the left/right of the ring, the disc (inset 3 %) printed with a label cut from the front cover plus a silver centre ring, a petal hub (27 % width; `repeating-conic-gradient` 20°/4°, raised button), and an embossed `PUSH` at the bottom. The disc-case aspect follows the front image ratio as today (Blu-ray ≈ .79, DVD ≈ .71).

## 3. Lid inside: the record as a game manual

Replace the two memo slips (`CaseInside`) with a manual booklet held by two raised clips:
- Booklet: paper `#f1ede4`, ink `#1d1f22`, rotated −0.8°, page-stack shadow (2 px and 4 px offsets) plus a soft drop; two staples on the left edge.
- Cover strip (top 30 %): the work's hero artwork (else the front cover) as `cover`.
- Title (12 px, 800, `text-wrap: balance`, `word-break: keep-all`), then `취급 설명서` (8 px, .2 em tracking, muted).
- Owner form, a 1 px bordered table with dark label cells: **상태** as three printed check boxes (하는 중 / 완료 / 보류 — use the work's real status values and labels; the current one filled), **별점** as ★★★★☆ from `myScore`, **기기** (owned platform) or a blank writing line when unset. Labels must never wrap (`white-space: nowrap`).
- Footer: developer · publisher on the left, release date on the right.
- Clips: raised tabs (gradient `#34373c → #1f2125`, highlight, shadow) at 17 % and 62 % height, overlapping the booklet edge.

Films use the same booklet with director / release / runtime.

## 4. AV (DVD case, black plastic)

Same geometry and disc tray as §1–2. Specific to AV:
- **Disc label:** the front cover cut plus the product code, maker and label set around the rim (SVG `textPath` on a circle of radius 41 % of the disc; `textLength` fits one full turn; 7.5 px, 800, white, .14 em tracking).
- **Lid inside:** a smaller booklet (top 6 %, height 50 %) with the product code large (16 px, 900), maker under it, rows 레이블 / 발매 / 수록, and a bottom line with the watched check and the score.
- **Cast cards:** up to three instant-photo cards (white frame `#fbfaf7`, 4 px border, name strip under the photo) at the bottom of the lid inside (bottom 6 %, height 30 %, each 29 % wide at 2 % / 35.5 % / 69 %, rotations −5° / 1.5° / 5°), using the stored person portrait crops (the same crop source as the performer UI). More than three people: the third card shows `+N` for the rest. One or two people: centre the cards. Director as a small line (7 px, .06 em, 55 % white) above the cards at the left. Remove the old tray note `출연 · 감독` (`note` prop).
- Privacy mode masks every face as today.

## 5. Back cover when no back artwork exists

Games and films have no stored back art; AV usually has one (keep using it). Generated back, built from what the work has:
- **Hero band** (top 30 %): hero artwork (`40% 50% / cover`), fading into the back colour `#121a24`, title over it (12 px, 800).
- **Copy:** overview, up to 7 lines (8 px, line-height 1.55), ellipsis.
- **Screenshots row** (3 × 16:9) only when the work has screenshot artworks; otherwise the row is omitted and the rest moves up.
- **Facts:** 개발 / 배급 / 발매 / 장르 (games), 감독 / 제작 / 개봉 / 장르 (films), localized like the info panel.
- **Footer band** (13 % height, platform colour, e.g. Switch 2 `#e6482d`): publisher on the left, platform name on the right. No invented rating or barcode for games.
- Missing hero: use the front cover darkened instead. Missing overview: omit the copy.

## 6. Manga book

### 6.1 Orientation
The spine sits on the **right** of the front cover (right-to-left books); today `MangaBook` puts it on the left. The page edge moves to the left accordingly.

### 6.2 Generated back cover
Replaces today's darkened front image (`.manga-bb-back img { filter: brightness(.55) }`):
- Background: the cover's dominant colour (average of a small downsample of the cover; fall back to `#5a3f3d`).
- A picture cut from the cover (44 % width, aspect 4:5, `50% 36% / 190% auto`) with a 3 px paper frame, centred at the top (margin 10 %).
- `<series> <volume>` (11 px, 800), then the volume synopsis (8.5 px, up to 4 lines, ellipsis).
- Bottom row (padding-top 5 %): publisher (9 px, 800) with the publication date under it; a white code box (50 % width) with a **real EAN-13 barcode drawn from the volume ISBN-13**, `ISBN <13 digits>` and `값 N원` when the price is known.
- Volume data needed: `isbn13` and the publication date already reach the frontend (`CollectionVolume`). Add the Kakao volume source's `contents` (synopsis), `price` and `publisher` to the volume read model (`library/collection_volume.rs` query + `CollectionVolume` type), PC only in this round; the tablet replica does not carry them yet, so the tablet shows the back without synopsis/price (ISBN + date + publisher if present).
- Without ISBN: no code box. Without synopsis: omit it. Never use the series `overview` here (it can be a wrong provider match).

### 6.3 Spine template (shelf and work book)
`MangaSpineFace` gets fixed bands so the illustration is the same size and place on every book:
- Title band: from 6 % to 44 % of the height; the title fits inside it (existing `fitSpineTitle` shrink, then two columns, right column first).
- Volume number circle at 48 %.
- Illustration box: 58 %–77 % (fixed), cover cut by the stored focus as today.
- Author band: 79 %–93.5 %; one vertical column per name part, right to left (e.g. `Shinohara` | `Kenta`), more than two parts → first part + rest; font shrinks to fit but never below 7 px; never clipped.
- Bar at 95.5 %.
- Digits in vertical text: 1–2 digit runs as one upright cell (`text-combine-upright`, already in `verticalText.ts`), 3+ digit runs upright digit by digit (`text-orientation: upright`), never sideways.

## 7. Verification

- Unit tests for geometry-independent logic: EAN-13 encoding (known ISBN → bit string), author column split and minimum size, digit-run classification, cast card layout for 0–5 people, back-cover field fallbacks.
- Existing case/book tests keep passing; update snapshot-like expectations deliberately.
- Visual check: headless Edge screenshots of the work stage (closed, open front, open angle, side, back) on a test library, compared with the prototype; then the user checks the real app (WebView2) and the tablet.
