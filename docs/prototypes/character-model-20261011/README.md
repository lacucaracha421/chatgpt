# Character classification model — final proposal (2026-10-11)

Status: decisions and follow-up answers confirmed by the user on 2026-10-11; one small choice (레굴루스's group, a tie) is left to the cleanup preview; not implemented. No code or library changes were made. Open `index.html` (loads the app's real `fonts.css`, `tokens.css`, `controls.css`); all page text is in Korean for the user.

User request (2026-10-11): make the character classification area consistent on PC and tablet: groups that can hold extras, an extras pool with promotion to a character, excluded folders, plain wording, the value of candidate review/scoring, the tablet 만화 › 밴드물 view, and no raw model names in the UI.

## Confirmed decisions

1. **리버스 teams become groups.** 라플라스, 가방팟, 전쟁 and the other team sub-folders/sub-series become groups of 리버스. Images without a character go to each group's 기타. Disk files never move (assets are content-addressed); only the classification changes. Recognition compares an image with every character of its nearest registered series (`character_scope.rs:111–131`), so filing directly in 리버스 loses nothing. Registering a sub-folder as a series is what narrowed the comparison.
2. A **기타** bucket: one per group and one per series. It is a manual-only member that is never a recognition target or learning source.
3. 기타 stays one unnamed bucket. When the taggers read the same name on 5 or more images in it, the 기타 card shows a promotion suggestion.
4. Promotion starts recognition at once when 5 references are chosen; otherwise the character starts as manual. There is no automatic historical pass.
5. One rule for nested series and intermediate folders: nested series appear as series cards; the tablet opens `folder:` nodes as ordinary folders; nested-series images leave the parent's 미분류.
6. One **확인** list replaces 태거 검토, 후보 확인, S36 시험 채점 확인 and the tablet 캐릭터 검토. Scoring, accuracy and readiness move to 설정 › 고급 diagnostics.
7. **No recognizer selector.** The learning recognizer (S36) takes over automatically when the code's readiness passes:
   - at least 30 judged S36 automatic candidates (`READY_REVIEWED`);
   - at least 50 manual accepted examples (`READY_EXAMPLES`);
   - fewer than 2 wrong in the current code (`character_shadow_review.rs:849–877`); replaced by a ratio, see D below.

   Otherwise the base recognizer (B36) runs. A 아님 on a wrong placement removes it, blocks it from returning, and counts as wrong (exceeding the allowed wrong count returns the character to base). A 맞음 becomes a learning example.
8. The vocabulary batch on the page.
9. **Model names become concepts:**
   - 자동 태그 (PixAI and canary) *reads* names: 확실 when both agree, 불확실 when only one does.
   - 인식 *recognizes* faces: 기본 인식 (B36) and 학습 인식 (S36).

   Raw names remain only in 설정 › 고급 diagnostics. The page lists every UI string with a model name (file:line) and its replacement. WD, Kaloscope, CCIP, SigLIP and Qwen do not appear in UI strings; they are only in comments and keys.

## Follow-up answers (user, 2026-10-11)

- **A.** Every 리버스 sub-folder becomes a group except 버전 표지, which stays a plain folder. That is 13 groups: 라플라스, 라야시키, 가방팟, 전쟁, 아르고스팟, 카카졸데, 런던, 파리, 중국, 재건, 뱀파이어, 라모나, 4.0. 런던 and 파리 are version names, not places.
  - 마커스, the one-character series, becomes the 리버스 character 마커스 with no group. The 10 images in its folder without a character go to the 리버스 series 기타.
  - 전쟁, 파리, 라모나 and 4.0 start as 기타-only groups. Empty-group deletion must keep a group whose 기타 has images.
- **B.** Emptied team folders are removed after their images move up into 리버스. Files on disk are unchanged.
- **C.** Each character joins the group whose folder holds most of its images. Images without a character go to the 기타 of the group named after their folder. Applying this to today's data:
  - 28 of 31 characters land in groups; 마커스, 레콜레타 and 소더비 stay outside.
  - 레굴루스 is a 7/7 tie between 가방팟 and 라플라스, chosen in the cleanup preview.
  - Six assignments rest on a single image and are marked in the table.
- **D.** Learning recognition switches per character. 리버스 returns to the base recognizer.
  - The absolute wrong count is replaced by a ratio: allowed wrong = `max(1, floor(0.05 × judged))`.
  - A character switches with ≥ 30 judged, ≥ 50 examples and wrong ≤ allowed. It falls back when wrong exceeds the allowance and returns once it is within it again.
  - Today this switches 젠레스 › 수나 (0/74) and 남궁우 (2/44, allowed 2). 시시아 (3/36) and 아리아 (5/46) stay base.
- **Sidebar:** groups return to the PC classification sidebar under their series, before folders.
  - Each is one non-expanding row (icon, name, count) that opens the group screen.
  - The row stays selected while a member character or the group's 기타 is open. The context menu offers 그룹 열기 / 그룹 편집.
  - 기타 and characters get no sidebar rows (the user removed character rows on 2026-09-28).
  - Reuse the `character-group:` virtual rows removed from `src/classification/ClassificationSidebar.tsx` in `60d4e3a6`, and the existing `character_sidebar_counts` (`character_hub.rs:66–72`), now including 기타.
  - The tablet uses the same order in 에셋 › 분류 and on series screens.

## Evidence (read-only, 2026-10-11)

Library: `library.sqlite` and `.cache/characters/s36_shadow.sqlite` were opened with `mode=ro` and `query_only`; from `character-runtime.json` only the series names were read.

- 리버스 holds 1,640 images directly. Its 15 sub-folders, 3 of them registered series, are tabulated on the page with image counts, images without a character, and member candidates.
- Nested-series images in 리버스 미분류: 253 (라플라스 132, 마커스 96, 라야시키 25).
- S36 judged candidates (`s36-knn3-v2`):
  - automatic: 290 of 302 accepted;
  - recommended: 59 of 82;
  - S36 acceptances judged again: 69 of 71 kept.
- Per-character readiness today: 1 ready (수나), 2 hold, 1 keep, 230 collecting.

## Work order (slices)

1. **Display and wording** (no schema change):
   - PC sidebar group rows and the same tablet order;
   - tablet 밴드물 and nested-series cards;
   - the parent 미분류 rule;
   - vocabulary and model names, including the `DESIGN.md` Words example "S36 제외".
2. **기타, promotion and series unregister** (one migration):
   - 기타 pointers on `character_groups` and `character_series`;
   - unique internal names because of `UNIQUE(series_classification_id, display_name)`;
   - the empty-group trigger keeps groups whose 기타 has images, and 기타-only groups are allowed;
   - automatic acceptance clears 기타 membership;
   - historical refresh includes 기타;
   - counts include 기타;
   - additive `role:"extras"` in the publication.
3. **리버스 cleanup tool.** A preview, then one run, with a backup first. Steps:
   1. move 히사베스, 로렌츠 and 마커스 to 리버스;
   2. unregister 라플라스, 라야시키 and 마커스;
   3. create the 13 groups and assign members;
   4. lift the images into 리버스 and delete the empty folders;
   5. after one comparison pass, fill each group's 기타 from the recorded original folder.

   This is a library write approved at run time.
4. **One 확인 list.** S36 candidates are shown for all series so readiness accrues, plus the 설정 › 고급 status screen.
5. **Per-character automatic S36 ownership with the ratio rule.** Remove the selector and 리버스's manual switch. Review cross-engine conflicts separately.

## Not verified

- The running app was not opened on PC or tablet.
- The server projection was inferred from the PC exporter.
- Sidebar group counts are estimates (distinct images of the proposed members plus 기타 before the comparison pass).
- Whether moving images out of a former nested series enqueues recognition by itself needs checking during implementation.
