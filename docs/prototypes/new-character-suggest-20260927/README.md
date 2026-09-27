# New character suggestions mockups (2026-09-27)

Throwaway PC design mockups for "새 캐릭터 제안": the image taggers (PixAI v1.0 and canary, see `docs/research/tagger-character-signal-20260927.md`) recognise Danbooru characters the user has not registered yet (e.g. 32 images in the 명조 folder tagged `carlotta_(wuthering_waves)`). The mockups show where these suggestions appear and how the user registers, merges, postpones or ignores them. Nothing is created or classified automatically.

Open `index.html` directly (no network; fonts load from `_tools/app/src/styles/fonts/`). `index.html?frame=<id>` renders one 1440 × 900 window at 1:1 for screenshots; ids are `home`, `a`, `merge`, `b`, `register`. All imagery is generated SVG placeholders (colour fields and simple shapes); game character names are used only as text labels.

| Screen | File | What it shows |
| --- | --- | --- |
| 0 | `s-home.png` | Entry: the existing 캐릭터 검토 tile in Home 확인할 것 gets "새 캐릭터 7" in its note line (no new tile). When there are no review candidates, the same tile reads "새 캐릭터 제안 7명". Opens the review overview. |
| 1A | `s-a.png` | Character review overview with a collapsible "새 캐릭터 제안 7명" section at the top, grouped by series (with the matched series folder, or "시리즈 폴더 없음"). Row: proposed Korean name (editable), small Danbooru tag, count, confidence (● both taggers agree / ○ one tagger only, naming it when only one found any), 4 samples + "+N", location (inside the series folder vs elsewhere), actions 등록 · 다른 캐릭터와 같음… · 나중에 · 무시. Filters: minimum count (5장 이상), 시리즈 폴더 안에 있는 것만, 무시한 것 숨기기, counts of postponed/ignored and 무시 목록. The index gets a "새 캐릭터 제안 7" row above the series list. The existing review summary and groups follow below. |
| 1A merge | `s-merge.png` | A costume/alias tag (`changli_(swimsuit)_(wuthering_waves)`) shows "장리와 같을 수 있음" and puts "장리와 같음" first. The popover lists the series' characters with the recommended one preselected, "이 태그를 장리로 기억" (future images go straight to 장리's candidates), and the result "7장을 장리의 검토 후보로 넣어요. 바로 확정하지 않아요." |
| 1B | `s-b.png` | Series page (에셋 › 게임 › 명조): after the registered character tiles, dashed "제안" tiles with a faded 2 × 2 sample mosaic, name, count and agreement. Heading "캐릭터 6 · 제안 4" with 제안 숨기기. Clicking a tile opens a small card with the same content and actions as the 1A row. |
| 2 | `s-register.png` | Register dialog (interactive in the HTML): name prefilled from the tag, series folder prefilled from the tag's copyright qualifier, optional group, "명조 폴더 밖 이미지도 후보로" and "태그를 이 캐릭터에 연결". Top 5 by tagger score are preselected as references (teal asset-selection tint + number, up to 8); the rest form the 검토 후보 grid (score, one-tagger scores in yellow, "밖" for outside the folder). Click a candidate to promote it, click a reference to demote it, × to leave an image out. Footer: "카를로타를 만들고 25장을 검토 후보로 넣어요 · 참조 5장 · 뺀 2장"; fewer than 5 references warns that it starts as manual. Primary button 캐릭터 만들기. |

## Recommendation

**A as the home of suggestions, with B's dashed tiles as a secondary pointer on the series page, both opening the same card and dialog.**

- A puts all triage in one place: filters, the ignore list, suggestions whose images sit outside any series folder (호시노 has no 블루 아카이브 folder, so B cannot show it at all), and the same page where the user already works through character candidates. Registering here flows directly into reviewing the new candidates.
- B is where the user notices a missing character while browsing a series, so a quiet dashed tile after the registered ones is useful; but on its own it hides folderless suggestions and makes ignore/filters awkward. Keep it limited (only suggestions passing the filters, 제안 숨기기 per series).
- If only one is built first: A.
- Home stays unchanged apart from the count in the existing tile's note line.

## Open questions for the user

1. Direction: A + B pointer (recommended), A only, or B only?
2. Korean name source: Danbooru tags are English romanisations; the proposed name needs a dictionary (hand-made or from the taggers' tag lists) or it starts as the romanised name for the user to edit. Which is acceptable?
3. Default filters: minimum image count (3 / 5 / 10), and whether one-tagger-only suggestions are shown by default or only when both taggers agree.
4. References: preselect the top 5 by tagger score (as mocked) or start with none so the user always picks? Should images outside the series folder be allowed as references?
5. Register result: should the remaining images go to review as candidates (as mocked), or should high-score both-tagger images be accepted directly?
6. 무시: forget this tag for good (as mocked, with a 무시 목록 to undo), or only until more images appear?
7. Suggestions with no series folder: pick a folder at registration (as mocked), or offer to create the series folder from the tag's copyright name?
8. "태그를 이 캐릭터에 연결" and "이 태그를 장리로 기억": on by default (as mocked)?

## Decisions (user, 2026-09-27)
Recommendations accepted: A (review overview top) as the main place with B (dashed tiles in the series page) as a secondary entry; Korean names from a reviewed tag → Korean dictionary (as in the NAI app), editable at registration; default filter ≥ 5 images, one-tagger suggestions shown with a marker; top 5 by tagger score preselected as references, references only from inside the series folder; all remaining images go to review as candidates (no auto-confirm on registration); 무시 is permanent with an undo list; suggestions without a series folder pick a folder at registration; tag linking on by default. Build after the tagger veto/recommendation backend lands (same character review area).
