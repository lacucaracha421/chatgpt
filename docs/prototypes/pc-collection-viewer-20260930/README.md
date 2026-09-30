# Collections 크게 보기 — one model for list, detail and viewer (2026-09-30)

Decision (user, 2026-09-30): **unify the models.** Today the app mixes three techniques — a pre-rendered image for game cases and manga covers in lists (`PhysicalCover`), a live WebGL book in the manga cover viewer (`PaperbackLive`), and a CSS 3D DVD case for AV (`DvdCase`). The redesign uses one case model for games, AV (and films): a light version on the shelf (front, spine, top) and the full version in detail and viewer (plastic rim, moving gloss, hinge, opening lid, 내 기록 slip, media). Manga keeps its live 3D book and gains the accepted shelf.

Open `index.html` (it loads the app's real `tokens.css` / `controls.css`). `#open`, `#flat`, `#art` start in a mode. Imagery is generated colour blocks; the private review page injects real covers (`window.LAKOMICS_REAL_GAMES`, `window.LAKOMICS_REAL_COVERS`, never committed).

| Frame | What it shows |
| --- | --- |
| 1 · 게임 크게 보기 | An immersive viewer like the 에셋 viewer: top bar (back, position, title, device · date, 정면으로, 정보, 닫기), edge-wide previous/next, a bottom strip. The case turns freely by drag. The strip holds the views of the object — 케이스 · 안쪽 (the lid folds open in place; the slip is readable at this size) — followed by the work's screenshots and artwork, each shown large when picked. |
| 2 · AV 크게 보기 | The same viewer and model. AV has full jacket art, so the strip adds 펼친 표지 (back, spine and front laid flat as one sheet with fold lines — today's flat view). |
| 3 · 만화 크게 보기 | One big book that leans toward the pointer (the app's live 3D book: the spine shows a strip of the cover, the side shows paper edges, nothing printed is invented). The strip is the accepted shelf; a spine click, the edge areas or the arrow keys change the volume. |

Flow: shelf or grid → a click picks, a double-click opens the work's detail (the full case on its stage, as in `../pc-collection-cases-20260930/` frame 1) → a double-click on the case or cover opens this viewer.

Review round 2026-09-30 (user): the manga book **faces straight front at rest** and leans only while the pointer is over it. The open case now holds more than the slip: under the 내 기록 slip a **작품 정보 card** (game: 개발사, 배급사, 발매, 플랫폼, 장르; AV: 품번, 메이커, 레이블, 발매, 태그), and in the tray a paper note (game: 개요; AV: 출연 · 감독). Other data that could go inside: external score, series entries owned, play dates (start/finish), and screenshots as loose prints.

Later the same day (user): the Switch game card sits at the **bottom centre** of the tray (the user's correction; not mid-right or lower right); the game 개요 note is **removed** — of 388 game entries only 10 have an overview and none is Korean (IGDB English), while films have Korean overviews (14 of 14) and manga mostly not (3 of 147 Korean), so an overview note is only worth showing for films.

**Decision (user, 2026-09-30): detail and viewer are one screen.** A double-click on a work in the list opens this screen directly; the separate work-detail page (directions 가 · 나 · 다 in `../pc-collection-detail-20260930/`) is dropped. Consequences drawn here: the top bar carries 쇼케이스 · 편집 · 작품 관리; the position counter and the edge areas move between works of the list (manga: between volumes); a 정보 panel (ⓘ) docks on the right and pushes the stage and the strip, holding 내 기록 (edited there), 작품 정보, AV 출연 · 감독 (links to the performer page) and manga 소장 (owned count, 신간 알림, edition). `#noinfo` starts with the panel closed.

**Case spine (user, 2026-09-30):** no invented dark hinge bands over the spine. With a real spine image, show it untouched. Without one, the spine continues the cover around the corner — the cover's left edge colours stretched across the spine — instead of a cut-out strip of the figure (the manga shelf keeps its accepted cover strips).

**Spine without real art — final (user, 2026-09-30):** the stretched and the blurred cover edge were both rejected. The spine shows **the case's own plastic colour with the work's title** set sideways in one spine typeface. Candidates are switchable in the mockup (책등 글자): IBM Plex Sans KR 700 (default, recommended: compact, clean, distinct from the UI's Pretendard), Gothic A1 900, Pretendard 800 (already bundled), Do Hyeon (the most condensed, retro), Black Han Sans, Noto Serif KR 900 — all SIL OFL on Google Fonts. The mockup loads them from Google Fonts; the app would have to bundle the chosen file for offline use on PC and tablet (a new font asset — confirm before adding). `#plex`, `#dohyeon` … start on a font.

Status: awaiting the user's review.

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

Work-screen bookcase (2026-09-30): the manga volume strip has no band background and no boxed recess; the volumes stand on a thin plank that fades out at both ends over a soft shadow. The book and the strip centre in the area left of the info panel.
