# AV product-code link mockups (2026-09-27)

Throwaway PC design mockups for `LONG-001`: the collector sends a product code (품번) from a JavLibrary-like page, the PC fetches LibreDMM metadata and a wrap jacket (`back | spine | front`, 800 × 438) as candidates, and the user chooses what to apply. Nothing is applied automatically.

Open `index.html` directly (no network; fonts load from `_tools/app/src/styles/fonts/`). `index.html?frame=<id>` renders one 1440 × 900 window at 1:1 for screenshots; ids are `1a`, `1b`, `2`, `2new`, `3`. All imagery is generated SVG placeholders; titles, names and people are fictional.

| Screen | File | What it shows |
| --- | --- | --- |
| 1A | `s1a.png` | A "받은 품번" ledger section at the top of Collections › AV, a count badge on the AV index row. Rows: code, received time, status (조회 중 / 찾음 / 못 찾음 + 다시 시도 · 품번 고치기), match (기존 컬렉션에 후보 추가 → name / 새 AV 컬렉션 만들기), 후보 보기, dismiss. Disappears when empty. |
| 1B | `s1b.png` | A fifth tile "AV 품번 4건" in the PC Home 확인할 것 strip that opens an anchored queue panel with the same rows and a link to Collections › AV. |
| 2 | `s2.png` | Candidate chooser for an existing collection: wrap jacket with two draggable split lines (mouse drag, or focus a line and use ← → / Shift for 10 px), live 앞 / 옆 / 뒤 crops with 후보 사용 / 유지 / 비우기 and 파일…, spine-width warning outside 1–12 %, 자동 추정으로 reset; metadata diff (field, current, LibreDMM, apply checkbox) for 원제, 발매일, 제작사, 레이블, 시리즈, 출연 (matched to existing people or 새 인물), 감독, 장르 (per-genre toggles); 거절 / 나중에 / 적용 with a live change count. |
| 2-new | `s2new.png` | Same chooser when no collection matches: header 새 AV 컬렉션으로 만들기 with 기존 컬렉션에 연결…, a name field prefilled with the code plus 원제로 채우기, everything checked by default, 유지 disabled, primary 새 컬렉션 만들기. |
| 3 | `s3.png` | Extension side on a neutral, fictional work page: a 컬렉션에 보내기 button right after the page's 品番 value, the success toast "PC로 보냈어요 · SSIS-001", a failure toast with 다시, and the button states (처음 / 보내는 중 / 보냄). |

Chooser defaults: a field is pre-checked only when the current value is empty; differing values (e.g. 발매일) stay unchecked so manual values are never overwritten silently; identical values show as 같음. A surface defaults to 후보 사용 only when it is currently empty, otherwise 유지. Already linked people are left alone.

## Recommendation for screen 1

**A, plus a count-only pointer on Home.** The queue belongs next to what it changes: the AV area already carries the privacy rules (PC-only, not in mobile lists, hidden in privacy mode), so codes and Japanese titles never appear on Home or in other areas. The user sends codes deliberately from Chrome and will usually go to the AV area to act on them, so a strip there matches intent; it also leaves room for batch review ("찾은 것 차례로 보기"). B's strength, being noticed at launch, can be kept cheaply by a Home 확인할 것 tile that shows only a number ("AV 품번 4건") and opens Collections › AV, without the panel, and is hidden in privacy mode.

## Open questions for the user

1. Queue place: A only, A + count tile on Home (recommended), or B with the panel?
2. Should a received code that matches an existing collection with no missing fields be offered at all, or only when something differs?
3. 거절: forget the candidate only, or also block that code from being re-queued until sent again?
4. Name for a new collection: code (as mocked), Japanese title, or code + title?
5. Genres: store all LibreDMM genres, or only the checked ones (as mocked), and should genres become filterable tags later?
6. Spine: when the spine estimate is outside 1–12 %, save only front and back by default?
7. Extension: button only on pages where the code is found in the info table, and also add "컬렉션에 보내기" to the existing selected-text chip (AV 표지 찾기)?
8. Performer matching: name-only matching can mis-link same-named people; is choosing from the dropdown enough, or should new matches always start as 새 인물?
