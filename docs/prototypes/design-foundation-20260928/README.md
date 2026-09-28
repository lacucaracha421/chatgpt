# Design foundation specimens (2026-09-28)

Throwaway specimens used to decide the shared PC + tablet foundation now recorded in `DESIGN.md` section 12. Open the HTML files directly; they load the real `tokens.css`, and the font comparison and `part2.html` load Pretendard from a CDN (network needed).

| File | What it shows | Decisions |
| --- | --- | --- |
| `index.html` / `full.png` | Font comparison (SUIT + Barlow, SUIT + Inter, Pretendard), spacing ladder, four type roles per device, badges, checkboxes | Pretendard; spacing 4 · 8 · 12 · 16 · 24 · 32; PC 20/15/12/24 and tablet 22/17/13/28; square 2px badges; square-mark checkbox |
| `part2.html` / `part2.png` | Radius, buttons, compact buttons, inputs, toggles (square variants and round), segmented control and tabs, icons, colour roles, row heights, a combined settings slice | Radius 0/2/4/8; PC buttons 32 (toolbar 28), tablet 44 (compact 36); compact button = text + icon without face or border; inputs face-only with a blue underline while typing; round toggle; "one cue for thin elements" |

Sample data and colours are placeholders.
