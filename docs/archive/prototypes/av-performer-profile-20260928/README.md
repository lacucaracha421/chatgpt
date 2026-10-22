# AV performer profile from StashDB — mockups (2026-09-28)

Throwaway PC design mockups for adding a StashDB profile to 컬렉션 › AV › 배우 (`src/collections/av/AvPerformerPage.tsx`). Fields are the ones the user chose: name (Korean, Japanese, aliases), birth date and age, height, body measurements (StashDB inches shown in cm), breast type (natural / enhanced), career years, links. Other StashDB fields (country, ethnicity, eye/hair colour) are left out.

Open `index.html` directly (no network; fonts load from `_tools/app/src/styles/fonts/`). `index.html?frame=<id>` renders one 1440 × 900 window; ids `a`, `b`, `c`. Imagery is generated colour blocks; the performer and values are fictional.

| Screen | File | What it shows |
| --- | --- | --- |
| A (recommended) | `s-a.png` | Current layout kept. Left column: smaller portrait with source line (StashDB · 원본 · 바꾸기), names, a 프로필 list (생년월일 + 만 나이, 키, 사이즈 B/W/H with cup, 가슴 cup + 자연/보형 pill, 활동 start – 현역/end + 년차), link chips (X, Instagram, FANZA, 공식 프로필, 위키, "+N" expands), "StashDB · N일 전 확인" with refresh, then the library stats. Rows with no value are hidden. |
| B (alternative) | `s-b.png` | Header strip: small portrait, names and the profile as large numbers in one row; links top right; works use the full width. |
| C | `s-c.png` | 대표 이미지 바꾸기 gains a StashDB tab (image grid with original sizes, preview); the chosen photo is stored in the library so it shows offline and on the tablet. |

StashDB data shape checked read-only on 2026-09-28 (`searchPerformer`): `birth_date`, `height` (cm), `band_size`/`waist_size`/`hip_size` (inches), `cup_size`, `breast_type` (NATURAL/FAKE/NA), `career_start_year`/`career_end_year`, `urls { url site { name } }`, `images { url width height }`.
