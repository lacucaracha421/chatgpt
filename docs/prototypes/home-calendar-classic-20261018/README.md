# Home month calendar, classic look (2026-10-18)

Status: proposal (design mockup). App source is unchanged. Follows the user's request of 2026-10-18: the Home month calendar (HOME-CAL-001, spec in [`../home-calendar-20261017/README.md`](../home-calendar-20261017/README.md)) is hard to read; make it look like an ordinary calendar, Sunday to Saturday, even if it departs from the design theme (Samsung One UI Calendar as a reference).

Only the **grid's presentation** changes. Content, data, the day panel (PC), the day sheet (tablet), selection, keyboard, paging, privacy mode and the no-flash rules stay as in the HOME-CAL-001 spec.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page: PC Home left column at 1:1 (grid + 340 px day panel, interactive: click or arrow keys), two tablet portrait frames (Home, and the day sheet opened by a double tap). Switches for privacy mode, holidays and the saved-image display. URL parameters for checks: `?day=2026-10-30&privacy=on&saved=count&holidays=off&tabletzoom=1`. |
| `calendar.css` | **Proposed** CSS for the grid (would replace the `.home-cal--month` rules in `src/home/homeMonth.css`). Tablet differences are only token sizes. |
| `calendar.js` | Stand-in data (October 2026, today = Sunday 10.18) and the light interactions. |
| `page.css` | Mockup only: document, frames, and a stand-in for the unchanged day panel / sheet. |
| `app-css/` | Copies of the app's `tokens.css`, `fonts.css` (+ Pretendard), `controls.css`, `surface-motion.css` (2026-10-18). |

Dark theme only, as the app ships only dark.

## What changes against the current calendar

- **Week order:** Sunday first (일 월 화 수 목 금 토), still six rows. Sunday and holiday dates and the 일 heading are red, Saturday blue (two calendar-only colours, `--cal-sun` / `--cal-sat`).
- **Grid lines:** thin lines between all rows and columns (today: only a top line per cell, gaps between columns). No outer left/right edge.
- **Date:** top-left, body size (PC 15, tablet 17) at weight 600, instead of muted meta text. The first of a month keeps `10.1` / `11.1`. Adjacent-month days are dimmed (.38) and stay selectable.
- **Today:** a filled white **circle** on the number (today: an ivory square). The one round mark, as every calendar draws it.
- **Selected day:** a 2 px light frame inside the cell (today: the full ivory slab with echo and corner square). The cell face underneath does not change, so text colours never flip.
- **Current-week face:** removed (the circle is enough).
- **Entries as event chips:** each release is one line, 20 px (tablet 22 px), 13 px text, on a solid face: by default **one slate colour for every release** (user 2026-10-18), or coloured by kind with the 막대 색 switch (see Palette); the title ellipsizes, a manga volume (`112권`) stays whole. **NEW** releases are solid yellow chips with dark text. Subscription charges are outlined chips in the one-colour mode (filled grey in the kind mode) with the repeat icon, name and amount (`무료 끝남` for a trial end). A cell shows up to three lines: all entries when three or fewer, otherwise two chips and `+N`. NEW first, then other releases, then charges.
- **Memo:** a small document mark at the right end of the date row (as today, moved up).
- **Spending:** wallet icon + `25,800원` at the bottom right (as today); `••••` in privacy mode.
- **Saved-image heat:** kept, but as a soft wash over the whole cell (eight steps of a steel blue, 2–13 %) instead of the strong strip behind the date; adjacent-month days get the lightest wash. See open question 2.
- **Dropped from the cell:** the `D-3` badge on future release days (the D-day stays in the day panel rows). Kind icons inside chips (the tint carries the kind; the panel shows icon and word).
- **Off the theme on purpose:** the whole calendar palette below (user 2026-10-18: "기존 테마는 무시하고 시안에 맞게 조화로운 색"), the round today mark, and 13 px chip text on the PC (one step above the 12 px meta role). The month head, the day panel and the tablet sheet keep the app's tokens and Pretendard.
- **Tablet:** the same grid with tablet tokens (date 17, chips 13, today circle 30 px, cells about 107 × 118 px). Charge chips show the name only (the amount is in the day sheet); a trial end keeps `무료 끝남`. Tap selects, a second tap within 300 ms opens the day sheet, sideways swipe pages months: unchanged.

## Palette

One set for this calendar only, deliberately **not** the app theme (no ivory accent, no `--color-focus` blue in the grid). Values are `--cal-*` / `--kind-*` custom properties at the top of `calendar.css`; the page background stays the app's `#161718`.

| Role | Hex | Use | Contrast |
| --- | --- | --- | --- |
| Ink | `#F5F6F7` | date numbers, chip text on kind faces, today circle | 16.6:1 on the page |
| Ink on light | `#17181A` | number in the today circle, NEW chip text | 16.4:1 on the circle, 12.0:1 on NEW |
| Selected frame | `#E8EAED` | 2 px frame of the selected day | 14.9:1 on the page |
| Muted | `#A9AEB5` | weekday names, memo mark, wallet icon and spending, saved count | 8.0:1 on the page |
| Soft | `#CDD1D6` | `+N`, subscription chip text | 11.7:1 on the page, 8.6:1 on the subscription chip |
| Line | `#2E3135` | grid lines | (decorative) |
| Sunday / holiday | `#F97770` | Sunday and holiday dates, 일 heading, holiday names | 6.8:1 on the page |
| Saturday | `#6AA7F4` | Saturday dates, 토 heading | 7.2:1 on the page |
| 망가 | `#986021` | manga chip face (amber) | ink text 4.8:1 |
| 게임 | `#005D32` | game chip face (green) | ink text 7.4:1 |
| 애니 | `#2B6EA1` | anime chip face (blue) | ink text 5.0:1 |
| 영화 | `#693265` | movie chip face (plum) | ink text 8.6:1 |
| NEW | `#F8D14F` | NEW release chip face (yellow) | dark text 12.0:1; volume `#5A4A12` 5.9:1 |
| Subscription | `#2D3137` | subscription charge chip face | soft text 8.6:1 |
| Release (one colour, default) | `#385064` | every release chip face in the 한 색 mode, and the day panel's cover swatches | ink text 7.8:1 |
| Subscription outline (one colour) | `#464B52` | 1 px inside outline of the subscription chip in the 한 색 mode (face transparent) | soft text 11.7:1 on the page |
| Saved heat | `#7F95B5` | mixed 2–13 % into the page for the eight heat steps | (background wash) |

- **Two chip modes** (switch 막대 색 on the page, `?chips=one|kind`): **한 색** (default) gives every release the slate `#385064` and leaves NEW the only bright chip; the kind is shown only in the day panel / sheet (`망가 · 16권`), the chip itself carries no kind cue. The subscription chip then becomes an outline (transparent face, `#464B52` line, repeat icon on PC), so it never reads as a release. **종류별** keeps the four kind faces below and the filled grey subscription chip.
- **All chip text passes WCAG AA** (≥ 4.5:1); the weakest is 망가 at 4.8:1. The volume (`23권`) uses the same colour as the title at weight 400, so it keeps the same contrast.
- **Kinds:** near-equal chroma (OKLCH C 0.105), hues spread round the wheel (amber 65°, green 155°, blue 245°, plum 330°). Lightness is spread on purpose (OKLCH L 0.41–0.54), so the faces stay apart under colour-vision deficiency: the smallest pairwise OKLab distance in Machado simulations is 7.0 (protan, 망가/게임), 8.5 (deutan, 게임/영화), 10.6 (tritan, 게임/애니), against 14.3 with normal vision.
- **NEW** stands out by lightness (a light yellow face with dark text among four mid-dark faces), not only by hue; its yellow sits apart from the amber 망가 for all three deficiency types.
- **Weekends:** Sunday red and Saturday blue are light text colours, so they never meet the dark chip faces as equals; no kind face is red or pink (the earlier pink 애니 is gone), and the blue 애니 face is much darker than the Saturday blue.
- **Today and selection** are neutral white, so they read as the calendar's own marks rather than as content colours.
- The day panel and tablet sheet show the kind faces on their cover placeholders only; their NEW / 오늘 badges keep the app's ivory (unchanged panels).

## Holidays

The app has **no holiday data** (no holiday source in desktop, tablet, Rust or server code). The mockup hard-codes October 2026: 10.3 개천절, 10.5 대체공휴일, 10.9 한글날, shown as a red date plus the name beside it. It is open question 1.

## Open questions

1. **Korean public holidays in red with their names?** Recommended: yes, from a small bundled table of fixed-date holidays plus a yearly list of lunar and substitute days (설날, 추석, 부처님오신날, 대체공휴일), updated with app releases; no network source. If not wanted, only Sundays turn red (the 공휴일 switch shows that).
2. **Saved-image counts in the cell:** soft wash over the cell (proposed, keeps the user's 2026-10-17 "heat only" choice but quieter), the plain count `🖼 30` at the bottom left, or nothing in the cell (count only in the panel)? Recommended: the soft wash; switch to the count if the wash still reads as a selection.
3. **Release chips in one colour (default in the mockup) or by kind?** 한 색: one slate face, only NEW bright, kind only in the day panel; calmer, and NEW is found at a glance. 종류별: four kind faces; a busy month is scannable by kind. Recommended: 한 색, as the user asked to see first; kind colours stay available as the 종류별 variant if the kind turns out to matter at a glance.

## Unverified

- Static mockup with stand-in data; not seen in the running app or on the tablet. Rendered only with headless Edge at 1600 px (PC 1:1, tablet at 80 % and 1:1).
- Chip contrast is computed from the hex values (WCAG formula); colour-vision distances are from Machado 2009 simulations, not tested with users. Rendering checked by eye in headless Edge.
- Light (종이) theme not designed; the calendar colours would need light values.
