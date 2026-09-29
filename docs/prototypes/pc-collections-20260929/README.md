# PC 컬렉션 redesign mockups (2026-09-29)

Throwaway mockups drawn from the user's screenshots of the current 컬렉션 area (2026-09-29 18:54–18:55), carrying over the 에셋/망가 decisions (toolbar controls, shared shelf, section labels, face-only chips). Open `index.html`; `index.html?frame=a|b|c|d|e` renders one 1440 × 900 screen. Imagery is generated colour blocks.

| Screen | File | What it shows |
| --- | --- | --- |
| A | `a.png` | List: toolbar `게임 181` · 정렬 · 내 별점 (moved up from the sidebar); sidebar keeps 유형 and 소식 only (신간 count, 발매 캘린더 관심 N); 쇼케이스 on the shared shelf; cards = case cover + title + maker · year · ★. |
| B | `b.png` | One detail template (game): hero background, cover, title once (+ original title, date, maker, stars, actions), right column facts (developer, publisher, platforms, genre chips), sections below (개요, 스크린샷 · 아트워크 shelf); management behind the ⋯ menu; the sidebar stays the Collections index. |
| C | `c.png` | Same template for manga: right column 소장 card (edition segmented control, owned-count stepper, 신간 알림 Switch, latest/unowned, sources; applies immediately, no 저장 button); 권별 표지 grid with unowned volumes dimmed and dashed. |
| D | `d.png` | Same template for AV: cover with 앞면 · 책등 · 뒷면 below, product code, maker/label/tags on the right, 출연 · 감독 and 메모 sections. |
| E | `e.png` | 신간: 한국 정발 · 일본 as the shared segmented control, check time in app format ("15:20 확인"), rows with owned-through and the next volume with date and 발매됨 / D-n. |
| C1 / C2 | `c1.png`, `c2.png`, `c1-narrow.png` | Manga ownership placement: C1 continues the right info column; C2 is one strip under the title actions. **Picked: C2** (2026-09-29). `c1-narrow.png` shows the detail at a 1000 px window. |
| F | `f.png` | 신간 redesign: cover wall per unowned volume, split into 발매 예정 (D-n on the cover, dimmed) and 나왔지만 아직 없음 (NEW first). |
| G | `g.png` | 신간 redesign: dense ledger, one 44 px row per work with owned range, unowned volume chips (NEW filled, upcoming dashed with date), date and state; counts on top. **Picked** (2026-09-29). |
| H | `h.png` | 신간 redesign: two columns, 살 차례 (released, unowned) and 곧 나옴 (by month with D-n). |

Current problems these address: sort and rating filter in the sidebar, no count in the toolbar, thin-scrollbar showcase strip, the title shown three times on detail pages, work facts placed in the sidebar index, a floating 작품 관리 link, the 신간 알림 checkbox, AV detail and performer pages built differently from the other types, bordered + filled tag chips, stray selection dots in the artwork dialog, and locale dates in 신간 ("2026. 9. 29. PM 6:37:21").
