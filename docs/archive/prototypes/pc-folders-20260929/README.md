# PC folder and character-folder screens (2026-09-29)

Throwaway mockups that refine the approved folder direction D (`../pc-assets-20260929/d.png`) against the current toolbar (`AssetToolbar.tsx`, `GalleryViewMenu.tsx`) and redraw the character folder (today `characters/SeriesBrowser.tsx`) in the same frame. Open `index.html`; `index.html?frame=a|b|c|d|e|f` renders one 1440 × 900 screen. Imagery is generated colour blocks. On the overview page the shelves scroll with the wheel, drag and arrows.

| Screen | File | What it shows |
| --- | --- | --- |
| A | `a.png` | Ordinary folder (게임 › 리버스): toolbar with the title only, 전체 · 이미지 · 영상, 정렬, 보기. One horizontal shelf (characters → suggestions with dashed outline and 제안 badge → subfolders; wheel, drag, arrow; no edge fade). 미분류 / 전체 segmented control with counts right under the shelf, ⓘ help beside it. Date-grouped grid with no captions; the hovered tile shows ★ and ⋯ as small dark squares on the top-right corner and an artist · time badge bottom-left; the hovered character card shows its edit button on the image corner. |
| B | `b.png` | Character folder (블아 › 하스미): breadcrumb title with 편집 and 캐릭터 더보기 (⋯) beside it; 편집 carries a small red ! when a reference needs a person check. A character has no subfolders, so its shelf is empty and dropped; only the label row stays (이미지 412 · 후보 8 확인 for S36). No 미분류/전체 control (nothing below a character). |
| C | `c.png` | B with three images selected: the shared selection bar (캐릭터 C, 이 캐릭터에서 제외, favourite on/off, 작가 지정, trash, clear) and the current `CharacterAssignPicker` anchored above 캐릭터, scoped to 블아: search field with a removable 블아 scope badge, 추천, then the series' groups (트리니티, 게헨나); 하스미 is shown as 현재; a fixed 모든 시리즈 row closes the list. |
| D | `d.png` | Series folder 블아 (미분류) using the same shelf (group → characters → suggestion → folders) and 후보 24 확인. Two images selected, picker searching "링크": "블아에 없음", then 다른 시리즈 results (each says the file moves to that series folder) and a 새 캐릭터 row ("블아에 “링크” 만들기") replacing the old dialog's 새 캐릭터 button. |
| E | `e.png` | A with the 보기 menu open (배치, 크기, 비율, 정보 — no 하위 폴더 포함) and the ⓘ popover that explains 미분류 / 전체. |
| F | `f.png` | B with the edit panel open from 편집 (today's anchored character panel): name, representative image, references 12/25 with 추천으로 보강 and an add tile, the reference that needs a person check marked ! with one line "인물 확인 1장", description, 자동 분류, 저장. References appear only here. |

## Decisions

- **미분류 / 전체 replaces 하위 폴더 포함.** Every folder opens on 미분류; the choice is not remembered (user). Both answer one question: "show only what is still loose in this folder, or everything below it?". 미분류 = images filed directly in this folder that are not in any character or subfolder (the default, matching today's `directOnly` default); 전체 = everything below, characters and subfolders included. The segmented control sits under the shelf, next to the things it includes, and appears only in folders that have characters or subfolders. The 하위 폴더 포함 switch leaves the 보기 menu; `directOnly` becomes the state of this control rather than a second control.
- **Toolbar stays today's.** Title only (no count), 종류 segment, 정렬, 보기. Counts live where they explain something: segment counts, shelf label, date headings. "제안 숨기기" and "후보 N 확인" move to the right end of the shelf label row because they only concern the shelf.
- **Shelf.** No right-edge gradient (the user dislikes dims over pictures); the last card is simply clipped and a floating arrow shows there is more (a left arrow appears once scrolled, D). Hover tools sit on the image corner so captions never move.
- **Character folder = folder D without a shelf.** References and the representative image live only in the edit panel behind 편집 (F), together with 추천으로 보강. A character has no subfolders, so the shelf is dropped; 후보 N 확인 stays on the label row. The "needs a person check" signal moves to a small red ! on the 편집 button and on the affected reference inside the panel. Rare actions (FAULT로 플레이, 과거 미분류 이미지 갱신, 일반 폴더로 전환, S36 자동 분류에서 제외) go in 캐릭터 더보기.
- **Feedback 4 (old dialog).** The series view's `<details>` "캐릭터 지정…" checkbox box and the character view's header selection buttons (선택 수, 해제, 이 캐릭터에서 제외) are replaced by the shared `SelectionBar` with its anchored `CharacterAssignPicker`, exactly as in 에셋. Character-folder-only actions join the bar (이 캐릭터에서 제외; 참조 설정 when a reference is selected). Pressing C opens the picker, as elsewhere.
- **Feedback 5 (series-only list).** Inside a series or one of its characters the picker opens with a scope badge (블아) in the search field and lists only that series: 추천 (suggestions limited to the series), recent (limited to the series), then the series' groups and ungrouped characters. The current character shows as 현재. Reasons: images in a series folder almost always belong to that series; assigning to another series moves the file, so it should take a deliberate step. Ways out: the always-visible 모든 시리즈 row at the end of the list, removing the badge (× or Backspace on an empty field), or typing a name — when the series has no match, 다른 시리즈 results follow automatically with "폴더 옮김" in their context, plus a row to create the character in this series.
- **Selection look** follows the approved 에셋 mockups (2px inset ivory ring and filled square check); no dimming of the picture.

## Decided (user, 2026-09-29)

1. Keep the label 미분류.
2. The 미분류 / 전체 choice is not remembered: every folder opens on 미분류.
3. References are shown only inside the character edit panel, not on the character folder's shelf (B, F); the red "needs checking" signal sits on 편집.
4. The character picker ends with a visible 모든 시리즈 row, in addition to typing to reach other series (C, D).
5. No character list in the sidebar; the title breadcrumb is enough and the sidebar mark stays on the series folder.

## Open questions for the user

None open from this round.
