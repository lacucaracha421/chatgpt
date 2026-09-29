# PC 에셋 main screen redesign (2026-09-29)

Throwaway mockups for the PC asset grid, inspector, viewer and folder header, drawn from the user's screenshots of the current app (2026-09-29). Open `index.html`; `index.html?frame=a|b|c|d` renders one 1440 × 900 screen. Imagery is generated colour blocks.

| Screen | File | What it shows |
| --- | --- | --- |
| A | `a.png` | Grid + inspector: count, kind segment, sort and layout in the toolbar (moved up from 보기 설정); tiles without time captions (artist · time on hover); one date-header style; inspector ordered artist → same post → characters/auto tags → source → file, app date style (9.29 07:20), 72px label column; one-line selection bar that drops labels before wrapping. |
| B (recommended) | `b.png` | Immersive viewer: top bar with position (12 / 9,453), artist, folder and date, actions (캐릭터, 앨범, source, favourite, move, trash, info, close); edge-wide previous/next areas; bottom filmstrip; bars fade when the mouse is still. |
| C | `c.png` | Viewer with the inspector docked (B after pressing i); the same inspector component as A. |
| D | `d.png` | Folder view: characters, suggestions (dashed, 제안 mark) and subfolders in one horizontally scrolling shelf (wheel, drag, arrow) instead of 1·2·3 pages; 미분류 / 전체 이미지 as the shared segmented control with counts. |

Problems in the current screen that these address: time caption under every tile; date headers differ between 전체 and album views; no count or sort in the toolbar; paged folder header; viewer shows no position, artist or info and uses boxed arrows; the selection bar wraps labels vertically when the inspector is open; inspector dates use the locale format ("2026. 9. 29. AM 7:20:00").
