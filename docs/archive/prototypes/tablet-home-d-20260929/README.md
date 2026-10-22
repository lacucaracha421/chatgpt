# Tablet Home aligned to PC Home D (2026-09-29)

Throwaway tablet mockups for the handoff item "tablet Home aligned to PC D". The current tablet Home (0.8.68) only received the type/spacing pass; these move it to PC D's content (`../pc-home-minimal-20260929/`, frame D) with the tablet type roles (22/17/13/28) and let it scroll instead of forcing one screen. The bottom sections marked "PC 결정 후" come from the PC scroll round (`../pc-home-scroll-20260929/`) and follow that decision. Open `index.html`; `index.html?frame=a|b&y=900` renders one 800 × 1280 screen scrolled by `y`. Imagery is generated colour blocks.

| Screen | Files | What it shows |
| --- | --- | --- |
| A (recommended) | `a.png`, `a-scrolled.png` | One column in PC D order: 캘린더 shelf, 다시 보기 · 작가, AV 배우 · 검토 (the PC right column laid sideways; the top-bar review badge moves into 검토), two large memo blocks, 자산 현황 with server/PC dots; then 이어지는 시리즈, 이어 보기, 즐겨찾는 배우. |
| B | `b.png`, `b-scrolled.png` | Main column + 256px side column scrolling together (side = 메모, AV 배우, 검토, 자산 현황), closest to the PC but narrow in portrait. |
