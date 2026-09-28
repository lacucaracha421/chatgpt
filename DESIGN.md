# Lakomics Design Language

> 상태: 현재 PC Lakomics의 최상위 시각·상호작용 원칙. 2026-09-06의 Lab 06 콘텐츠 방향과 Chrome 03b 실제 개편을 통합한 기준이다.
> 상세 구현 기준은 `docs/agents/pc-design-reference.md`를 따른다. 매체별 Works 문법은 `docs/agents/works-viewer-design.md`를 따른다.
> Spacing, type, radius, colour roles and shared controls for **both PC and the Android tablet** are defined in section 12 (Foundation, decided 2026-09-28); where an older line below disagrees, section 12 wins.

Lakomics는 장시간 사용하는 Windows 데스크톱 개인 미디어 아카이브다. 이미지·영상과 작품이 화면의 주인공이며, 앱 chrome은 자료를 찾고 정리하고 다시 감상하기 위한 조용한 도구여야 한다.

## 1. 핵심 인상

- 깔끔하고 밀도 높은 개인 아카이브.
- dark neutral 기반의 단정한 사각형, 얇은 선, 작은 반경.
- 작품과 자산의 색이 화면 분위기를 만들고 UI는 한발 물러난다.
- 기능만 남긴 무미건조한 도구도, 오래 보면 피로한 테마 장식도 피한다.
- NieR:Automata에서 참고한 것은 절제된 구획·버튼·표식이지 게임 HUD 복제가 아니다.
- mymind/Cosmos/Raindrop에서 참고한 것은 이미지 배치와 정돈감이다.
- Criterion/A24/Delicious Library의 소장감은 매체별 Collection 표현에만 제한적으로 쓴다.

## 2. 시각적 우선순위

1. 미디어와 작품 아트워크
2. 현재 위치와 선택 상태
3. 지금 작업에 필요한 조작
4. 메타데이터와 상태
5. 관리·provider·유지보수 기능

앱 chrome, 통계, 설명 문구가 자료보다 먼저 눈에 들어오면 실패다.

## 3. PC shell

PC의 기본 shell은 **Chrome 03b B 좌측 중심 구조**다.

- 가장 왼쪽은 에셋·컬렉션·망가 같은 큰 영역을 바꾸는 좁은 area rail이다.
- Next to it is the persistent contextual index for the current area: Classification and Albums for Assets; for Collections, the `작품 유형` list (게임/만화/영화/AV) with the `신간` and `발매 캘린더` rows, then sort and 내 별점 for the library grid; the matching browsing context for Manga. Collections have no Library/Showcase mode: the Showcase is a collapsible `쇼케이스` row in the content above `전체`.
- 본문 위에는 얇은 위치/창 영역만 남기고 예전의 전체 수평 toolbar를 중복하지 않는다.
- 검색은 평소 돋보기 아이콘만 보인다. 검색을 지원하는 화면에서만 실제 입력 surface를 연다.
- 에셋의 보기 설정은 인덱스 하단에서 필요할 때만 오른쪽 non-modal panel로 연다. 단순 개폐로 갤러리 폭·스크롤·선택을 바꾸지 않는다.
- 화면별 정렬·필터·관리 기능은 그 문맥에 가장 가까운 인덱스나 임시 surface에 둔다. 빈 toolbar를 유지하기 위해 기능을 복제하지 않는다.
- 창 제어는 한 곳에만 둔다. 입력·메뉴·슬라이더가 native drag region으로 오인되지 않아야 한다.

## 4. 표면과 형태

카드보다 **명도 차이 → 1px separator → 간격 → typography** 순으로 계층을 만든다.

- Radius has four steps (section 12): 0 media tiles · 2 marks (badges, checkboxes, covers) · 4 controls, rows, menus/popovers · 8 dialogs and tablet bottom sheets.
- dialog: 필요할 때만 더 큰 surface와 shadow.
- shadow는 실제로 떠 있는 menu/dialog/drag preview와 의미 있는 collectible object에만 쓴다.
- 일반 grid tile, toolbar, settings row, sidebar section에 장식용 shadow를 퍼뜨리지 않는다.
- glassmorphism, 장식용 gradient, 큰 rounded card, pill 모양 배지·버튼, 강한 glow는 사용하지 않는다. The one round control is the toggle switch (section 12).
- NieR-motif exception: current-location selection may use square corners, a hard 1px ivory echo offset 3px right/down, and a small dark square mark at the right end of the selected row. There is no ivory square cursor outside or to the left of the row. The echo masks its interior with the actual panel background; blurred/decorative shadows remain banned. Index section labels may use a small square and a fading 1px hairline.

## 5. Typography와 색

- Font (2026-09-28, replaces SUIT + Barlow): Pretendard for Korean and Latin text on PC and tablet. Japanese keeps Yu Gothic UI/Meiryo as fallback.
- Rajdhani Medium is only for large standalone numbers (the `number` type role: stats, calendar day numbers, D-day). Numbers inside a line (counts, dates, times) use Pretendard with tabular figures; existing Rajdhani inline numbers move over when their screen is migrated.
- 폰트 파일과 라이선스를 앱에 포함해 오프라인에서도 표시한다. Segoe UI/Malgun Gothic은 폴백으로 유지한다.
- Type sizes follow the four roles in section 12 (PC title 20 · body 15 · meta 12 · number 24). The 2026-09-08 sizes 13/16/18 are legacy and are removed as screens migrate.
- 설정 → 일반의 앱 전체 배율은 80·90·100·110·125·150%를 지원하며 기본값은 100%다. WebView 배율로 모든 UI와 미디어를 함께 조절하고, 이 PC의 UI 설정에 저장해 다음 실행에도 적용한다.
- monospace는 경로·ID·timestamp 같은 실제 기술 값에만 제한한다.
- 사용자 폴더/앨범 이름을 uppercase로 바꾸지 않는다.
- dark neutral surface가 기본이며, accent는 선택·focus·valid drop·중요한 confirmation에만 쓴다.

## 6. 선택과 컨트롤

선택의 역할을 구분한다.

- **Current location / slab**: the most specific navigation location uses `--color-sidebar-selection` / `--color-accent` with `--color-on-accent`, square corners, and `--selection-echo` (`--selection-echo-surface` on the standalone Settings surface). A selected row carries its own small dark mark (`--selection-mark-size`) at the right end; never add a separate ivory square to the left of or outside the row. Retain existing inner markers such as Classification tree icons. Blurred/decorative selection shadows remain banned.
- **Parent context / tint**: when a parent level and a more specific child are both current, only the child keeps the slab. The parent (the area rail, Notes scopes) uses `--color-selection-context` with `--color-selection-context-text`; hover uses `--color-selection-context-hover`; no echo or mark. Collection type, `신간`, `발매 캘린더` and update-provider destinations remain slabs.
- **Index section labels**: preserve font size/color and add a 5px square (`--color-section-mark`) followed by a fading 1px hairline (`--section-label-rule`).
- **복수 선택 필터**: 중성 회색 면, 반복 사각 표식 없음. 누런/올리브 selection은 사용하지 않는다.
- **자산 자체의 선택**: 좌상단 작은 사각 표식 + 이미지에만 청록색 선택 음영(`--asset-selection-tint`). 2026-09-06 사용자가 기존 중성 회색 음영의 낮은 가시성을 이유로 승인한 값이다. 바깥 selection outline과 metadata 영역의 색·여백 변화로 선택을 표현하지 않는다.
- keyboard focus는 selection과 별도 상태다. focus가 이동했다고 선택으로 보이거나, 선택 때문에 focus가 사라지면 안 된다.
- 일반 icon action은 quiet하게 두고, 한 화면에 강한 primary surface를 여러 개 만들지 않는다.

아이콘은 선 기반·기하학적 형태를 우선하고 stroke, optical size, baseline을 일관되게 맞춘다. 사용자 지정 Classification icon/color는 제품 데이터이므로 전역 미학을 이유로 덮어쓰지 않는다.

## 7. Gallery와 자산 정보

PC 자산 기본 보기는 **수집일별 masonry/waterfall**이다. justified row는 대체 보기로 남긴다.

- 이미지는 원본 비율을 존중한다.
- 날짜 group heading이 수집일을 맡는다.
- 이미지 바로 아래 한 줄에 왼쪽 작가, 오른쪽 `HH:mm` 수집 시각을 둔다. 날짜를 반복하지 않는다.
- 정렬·group·시각은 같은 `collectedAt`과 같은 표시 시간대에서 계산한다.
- 긴 작가명과 누락 메타데이터를 정직하게 처리하고, 가짜 현재 시각을 채우지 않는다.
- metadata가 켜져 있을 때도 이미지 감상을 방해하는 overlay로 바꾸지 않는다.
- dense scrolling에서는 hover scale, pointer-tracked transform, 타일별 shadow를 사용하지 않는다.

## 8. Collection / Works의 물성

모든 매체를 같은 카드 효과로 만들지 않는다.

- **게임**: 접합부가 보이는 닫힌 neutral case. 앞표지가 주인공이며 플랫폼 띠·가짜 책등·가짜 뒷표지를 만들지 않는다.
- **만화**: 승인된 Paperback FINAL의 얇은 단행본을 사용한다. 목록은 정적 렌더 캐시, 큰 표지 감상창의 한 권만 실시간 3D로 표시한다. 권 순서·선택권의 작은 lift·가리지 않는 하단 표지 스트립을 유지한다. 선반은 support cue이지 가구 시뮬레이션이 아니다.
- **영화/영상**: 일반 목록은 평면 poster archive다. 게임 케이스나 책 물성을 강제하지 않는다.
- **상세**: 원본 hero/backdrop 뒤에 표지를 겹치고 하단을 넓게 fade한다. 표지에는 fade를 걸지 않는다.
- 배경이 없으면 가짜 blurred background를 만들지 않고 상단 공간을 접어 compact 정보 배치로 전환한다.

물성은 Library < Detail < Showcase 순으로 강해질 수 있지만, ordinary UI와 Asset tile에는 전염시키지 않는다. 쇼케이스는 매체별로 사용자가 고른 표지만 촘촘히 전시하며 9개까지 3×3, 10개부터 4×4, 16개 초과는 다음 페이지로 이어진다.

## 9. Floating surface와 tooltip

- menu, context menu, popover, 보기 설정은 같은 얇은 경계 언어를 쓴다.
- 파괴적 확인은 dialog, 즉시 선택은 menu/popover로 역할을 나눈다.
- 커서를 올리거나 키보드 focus를 옮겼을 때 뜨는 tooltip은 사용하지 않는다. 공통 tooltip과 HTML `title` 말풍선 모두 포함한다.
- 아이콘 버튼의 `aria-label`과 키보드 조작은 유지한다. 추가 설명은 필요하면 `aria-description`으로 제공하고, 화면에서 필요한 안내는 실제 내용이나 클릭해서 여는 surface에 둔다. A necessary explanation goes behind a single ⓘ help button at one side (section 12, Words).
- nested menu/popover를 부모 panel의 바깥 클릭으로 오인하지 않는다.
- Esc는 가장 안쪽 surface부터 한 단계씩 닫고 같은 입력이 뒤의 선택 해제·viewer 종료까지 연쇄되지 않게 한다.
- 마우스 뒤로가기와 Esc의 화면 이동 기록은 현재 탭 안으로 제한한다. 주요 탭 전환은 뒤로가기 기록에 넣지 않으며, 같은 탭에서 돌아갈 화면이나 닫을 surface가 없으면 현재 화면을 유지한다.

## 10. Motion과 성능

- 일반 UI 전환은 대체로 80–160ms 범위의 opacity/background/border/짧은 위치 변화로 충분하다.
- spring, bounce, 장식용 entrance animation, 상시 animation을 피한다.
- sidebar/panel open-close는 공간 관계를 이해시키기 위한 짧은 motion만 허용한다.
- gallery scroll 중 레이아웃 재계산·shadow·transform을 매 프레임 추가하지 않는다.
- 게임 case/만화 cover의 작은 lift·depth는 수집품 감상이라는 의미가 있을 때만 제한적으로 허용한다.
- reduced motion과 keyboard path를 깨지 않는다.
- 공통 모델·단일 렌더러·상한 있는 캐시를 공유한다. 타일마다 3D 컨텍스트를 만들지 않고, 화면 밖 작업은 취소하고 유휴 상태에서는 그리기를 멈춘다.

## 11. 피해야 할 것

- 기존 화면을 다시 SaaS dashboard/card wall로 감싸기.
- 빈 공간을 채우기 위한 설명문, 통계 카드, 장식 panel.
- 모든 곳에 아이보리/베이지를 칠해 NieR 테마처럼 만들기.
- fake retro, scanline, 기계 HUD, 과도한 Persona식 장식.
- media 비율을 희생하는 획일적 crop.
- 한 기능을 rail/index/topbar에 중복 노출.
- prototype 수치·가상 데이터·임시 레이블을 production contract로 하드코딩.

디자인 판단이 애매하면 **alignment, hierarchy, state clarity, media visibility**를 장식보다 우선한다.

## 12. Foundation (PC and tablet)

Decided with the user on 2026-09-28 from `docs/prototypes/design-foundation-20260928/` (`index.html`, `part2.html`). PC and the Android tablet share one foundation; they differ only in size. Values are tokens in `_tools/app/src/styles/tokens.css` (PC) with tablet overrides in `_tools/app/mobile-client/mobile.css`; shared control styles live in `_tools/app/src/styles/controls.css`. Use the role tokens, never raw numbers.

### Spacing

Steps are **4 · 8 · 12 · 16 · 24 · 32** (`--space-1/2/3/4/6/8`). The closer the relationship, the smaller the step.

| Step | Use |
| --- | --- |
| 4 | icon↔text, badge↔badge, title↔its meta line |
| 8 | groups within one row, list items |
| 12 | vertical padding in rows and cards, cover↔text |
| 16 | horizontal padding in rows and cards, PC screen side gutter |
| 24 | between sections, tablet screen side gutter |
| 32 | large top/bottom page space, around empty states |

6, 10, 14, 18 and 20 are off-scale (`--space-compact` and `--space-5` are legacy). 1px lines and 2px media-tile gaps are lines, not spacing. Rows are separated by a 1px line, not extra space.

### Type

Four roles; emphasis comes from weight (600) and colour, not from another size.

| Role | PC | Tablet | Use |
| --- | --- | --- | --- |
| title (`--type-title`) | 20 | 22 | screen and detail titles |
| body (`--type-body`) | 15 | 17 | labels, item titles, buttons, inputs |
| meta (`--type-meta`) | 12 | 13 | dates, counts, captions, section names, badge text |
| number (`--type-number`) | 24 | 28 | large standalone numbers, Rajdhani |

Section names use meta in `--color-faint`. Only showcase/detail hero titles over artwork may be larger. A screen that shows a size outside its device's four roles breaks the rule.

### Radius

0 media tiles and edge-attached surfaces · 2 marks (badges, checkboxes, covers, selection) · 4 buttons, inputs, row cards, menus/popovers · 8 dialogs and tablet bottom sheets (top corners). 50% only for content that is itself round (a performer face). No pill shapes except the toggle switch.

### Colour roles

Colour values stay as they are; this fixes where they may appear.

- `--color-accent` (ivory): selection, the primary button, checked/on state, NEW. Never decoration.
- `--color-focus` (blue): keyboard focus and the active text input only.
- `--color-danger`: delete, failure, errors. `--color-success`: completed/synced states.
- Surfaces: `--color-bg` page, `--color-sidebar` index/panels, `--color-surface` rows and inputs, `--color-surface-elevated` menus and badges. Text: `--color-text`, `--color-muted` (meta, icons), `--color-faint` (section names, hints).
- Platform brand colours only inside platform badges; work colours only in artwork.

### Words

Leave out text the screen does not need: explanations, captions that restate what is visible, type/status labels, instructions and filler. Content, names, numbers and icons carry the screen. When an explanation is really necessary, put it behind one help button (ⓘ, icon button) at one side of the screen or section; it opens a small popover on click or tap. It is never a hover tooltip (section 9) and never an always-visible paragraph.

### One cue for thin elements

Large blocks (cards, dialogs, the primary button) may combine a face and a border. **Thin or small elements use one cue — a face or a line, never both.** This is why inputs are face-only and compact buttons have neither.

### Controls

| Control | PC | Tablet | Shape |
| --- | --- | --- | --- |
| Button (`--control-height`) | 32 | 44 | primary (ivory, one per screen or dialog), secondary (face + border), ghost (text only), danger (red text, faint red border); icon buttons are square |
| Compact button (`--control-height-compact`) | 28 | 36, 44 hit area | toolbars and list headers: no face or border, weight 400, `--color-muted` text with a 16px icon; a face appears only on hover/press |
| Text input, search, select | 32 | 44 | face only (`--color-surface`), no border, no resting underline; while typing, a 2px `--color-focus` bottom line and square bottom corners; label above in meta; error = red border and one meta line below |
| Checkbox (`--checkbox-size`) | 16 | 20 | square mark: 1.5px border, radius 2; checked = accent border with an inner solid accent square |
| Toggle switch | 32×18 | 40×22 | round track and round knob (the one round control); on = accent track, dark knob |
| Badge (`--badge-height`) | 20 | 24 | radius 2, padding 0 8, icon 14/16, gap 4, weight 600 meta text; variants: plain (`--color-surface-elevated` + muted text), icon-only (square), count (tabular), accent (NEW), danger; a tappable tablet badge keeps an invisible 44 hit area |
| Segmented control | control height | control height | 2–4 filters of the same list; joined cells, radius 4, selected = `--color-filter-selected` |
| Tabs | control height | control height | switch to different content; text + 2px accent underline on the selected tab |

Use a toggle for a single setting that applies immediately; use checkboxes to pick several items that a button then applies.

### Icons and rows

- Heroicons outline, stroke 1.5. Sizes 16 (inside badges and buttons), 20 (PC default: rows, toolbars), 24 (tablet default: top and bottom bars). Solid icons only for an on state (heart, pin). Icons follow text colour: muted at rest, bright when pressed or selected.
- List rows: PC one line 32 · two lines 48; tablet one line 48 · two lines 64. Rows with a cover use the two-line height.
- Touch targets on the tablet are at least 44.

### Rollout

The foundation applies to new and redesigned screens now (Home, Settings and the release calendar first). Existing screens are migrated screen by screen, checking wrapping and truncation on the device; there is no big-bang restyle. A style test (`src/styles/designFoundation.test.ts`) fails when a CSS file gains off-scale spacing, off-role font sizes or pill radii beyond its recorded baseline; lower the baseline when a screen is cleaned up.
