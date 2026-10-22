# Game and AV cases, and the shelf view (2026-09-30)

Follow-up to `../pc-collection-detail-20260930/` after the user accepted the manga shelf and asked for new 3D models for games and AV plus more ideas of the same kind. Open `index.html` (it loads the app's real `tokens.css` / `controls.css`); `index.html#open` starts with both cases open. Imagery is generated colour blocks; the private review page injects real game covers through `window.LAKOMICS_REAL_GAMES` (never committed).

| Frame | What it shows |
| --- | --- |
| 1 · 게임 케이스 | One CSS 3D case sized from the cover's ratio: plastic rim, a gloss that follows the turn, hinge notches and an opening lip. Drag turns it (←/→ 15°, Home front). 열기 / double-click / Enter opens it like a real case: the spine folds flat on the back-left edge and the lid folds on the spine, so lid, spine and tray lie side by side. Inside the lid is the **내 기록 slip** (들인 날, 상태, 별점, 메모); the tray holds a cartridge or a disc. The 기기 choice changes the plastic tint and the media. The spine shows a vertical strip of the real cover (cut at the figure's head, as on the manga shelf), never fabricated printing; disc and cartridge carry no artwork. |
| 2 · AV 케이스 | The same model as a black DVD case. AV works already have front, spine and back artwork, so all three faces use real images; opening shows the disc and the slip. |
| 3 · 목록을 선반으로 | A 선반 view mode for the Collections list, cover-led (see the decision below): turned cases on shelves grouped by device or release year, titles underneath. |

New needs: the cover-focus position for spines (`../pc-collection-detail-20260930/cover_focus.py`; on 37 game covers: 12 head, 11 close-up, 12 box centre, 2 without a person → middle), the 상태 / 기기 record fields, and an open state for the existing case components.

Real spines (investigated 2026-09-30): the LaunchBox Games Database has a "Box - Spine" image type (retail spines only). Its public daily metadata archive (`Metadata.zip`, 108 MB; images under `images.launchbox-app.com/<FileName>`; no API) lists a spine for 34,709 of 188,843 games — Switch 441 / 6,587, Switch 2 10 / 214, PS5 120 / 1,050, PS4 354 / 4,846, Windows 1,584 / 38,944. Of the library's 37 games with a cover, matched by English title, 35 exist there and **19 have a real spine on at least one platform**. The shelf therefore mixes them: a real spine where one exists (its true, much thinner width), a cover strip otherwise; the 3D case uses the real spine on its side too. Open points: matching needs the English title (IGDB), one game can have spines for several platforms (prefer the owned device), some Windows entries look fan-made, and LaunchBox's terms of use were not checked — check them before any automatic download. The downloaded archive and spine images stay outside the repository (`~/.cache/lakomics-oss/launchbox/`).

Thin real spines (user, 2026-09-30: "too thin to see" at the 196 px shelf height, where a Switch spine is about 12 px wide). Three answers are in the mockup under 꽂는 법: **세워 꽂기** with the spine under the pointer growing 1.9×; **크게 한 줄** (one 400 px tall row that scrolls sideways; spines about 24 px); **눕혀 쌓기** (cases lie flat in piles per device, so a spine reads left to right at 330 px length; works without a spine as a horizontal band of the cover). `#big` / `#stack` / `#year` start on a variant.

**Decision (user, 2026-09-30): no spine-only shelves for games.** Spine-only rows were hard to tell apart ("뭐가 뭔지 구분이 안 돼"); 세워 꽂기, 크게 한 줄 and 눕혀 쌓기 are dropped. The shelf is now **cover-led**: each case stands turned about 30° so the cover leads and the spine shows a little beside it (the real spine where one exists, a strip of the cover otherwise), with the title under the case; a click turns the case to face front, a double-click opens the work. (The manga shelf, which uses strips of each volume's own cover, stays as accepted.)

Follow-ups the same day: the turned cases got real depth (their own perspective, a top face, light from the upper left, a cast shadow; the picked case turns to the front and comes forward), and the shelf was redrawn as one plank per row seen from the same height as the cases — a top surface narrowing toward the wall, a front lip that catches the light, and the plank's shadow on the wall — with titles under the plank.

**Cases per row (user, 2026-09-30):** the toolbar gets the same 보기 menu as the 에셋 toolbar (`src/assets/GalleryViewMenu.tsx`: 배치 + the shared `Slider`); here 배치 is 격자 · 선반 and the slider sets 한 줄에 N개 (5–12), from which the case size follows. The tablet equivalent is the 보기 옵션 sheet with its stepped 썸네일 크기 slider. When built, extract the menu shell into a shared piece instead of copying it per screen. `#row6` … `#row12` start on a count. **Decided (user, 2026-09-30): count-based everywhere** — the 에셋 보기 menu also changes from a pixel size to 한 줄에 N개, and the tablet follows with the same rule.

**No 개요 on game and manga detail (user, 2026-09-30):** the library has no Korean game overviews (10 of 388 entries have one, all English) and manga overviews are mostly not Korean (3 of 147); films keep theirs (14 of 14 Korean).

**Case spine (user, 2026-09-30):** no invented dark hinge bands over the spine. With a real spine image, show it untouched. Without one, the spine continues the cover around the corner — the cover's left edge colours stretched across the spine — instead of a cut-out strip of the figure (the manga shelf keeps its accepted cover strips).

**Spine without real art — final (user, 2026-09-30):** the stretched and the blurred cover edge were both rejected. The spine shows **the case's own plastic colour with the work's title** set sideways in one spine typeface. Candidates are switchable in the mockup (책등 글자): IBM Plex Sans KR 700 (default, recommended: compact, clean, distinct from the UI's Pretendard), Gothic A1 900, Pretendard 800 (already bundled), Do Hyeon (the most condensed, retro), Black Han Sans, Noto Serif KR 900 — all SIL OFL on Google Fonts. The mockup loads them from Google Fonts; the app would have to bundle the chosen file for offline use on PC and tablet (a new font asset — confirm before adding). `#plex`, `#dohyeon` … start on a font.

Status: awaiting the user's review of the cover-led shelf and the case model.

## Platform spine templates (2026-09-30)

For a game without a real spine image the spine follows its platform's own package layout (user: "PS5나 스위치2의 패키지 책등을 그대로 따와서"), replacing the plain case-colour + title spine:

- Switch 2: red block with the platform mark at the top, the title on a band in the work colour, red block with the publisher at the foot.
- Switch: all red, small mark at the top, white title, publisher at the foot.
- PS5: white block with the platform mark and a thin blue line, black body with a white title, publisher at the foot.
- PC and unknown devices keep the case colour with the title.

The platform marks in the private preview are cut from real spine scans and are not in this repository; the committed mockup draws plain blocks in the same proportions. The app needs those marks as assets (licensing unchecked) before this can ship as drawn.

Case rim (2026-09-30): the plastic rim around the printed insert is thin (2px, 3px on the large case) and there is no rim on the edges where the front, spine and back meet, so the wrap reads as one sheet.

Spine title font (user, 2026-09-30): Noto Sans KR 700 ("noto gothic"); the switcher stays for comparison. The private preview also shows the library's one real AV work (real cover, spine and back; the performer portrait is the stored crop of the cover); the committed mockup keeps colour blocks and sample text.

Stage floor (2026-09-30): no horizon line or darker floor band; the case stands in a soft pool of light that fades into the background, with a tight contact shadow under a wide ambient one. The strip under the stage has no background of its own.
