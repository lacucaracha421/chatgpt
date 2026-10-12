# Claude opinion marker, ordering and settings — design spec (2026-10-12)

Status: proposal for `CHAR-CLAUDE-001` slice 1 (see `docs/roadmap/lakomics-backlog.md#char-claude-001`). Not implemented. Open `index.html`: it loads the app's real `fonts.css`, `tokens.css`, `shared-base.css`, `settings.css`, `shared-management.css`, `controls.css`, `characters/ConfirmList.css` and `mobile-client/characterReview.css`. Only the document frame and the rules marked "Proposed additions" in its `<style>` are local. Page text is Korean for the user. The real tokens have no light theme (`DESIGN.md` §12 Theme: 종이 is a later option), so the mockup is dark only.

Rendering was checked with headless Edge (1400 px wide, every section). The running app was not opened.

## Behaviour in one paragraph

Claude only says yes. Its "no" and "unsure" answers never appear anywhere, and they never remove, hide, demote or re-sort a recommendation. When Claude agrees that a recommended image shows the character, the item gets the marker **Claude 동의** and moves to the front of its character group. Everything else keeps today's order and today's look. The marker is advice only: the bulk "모두 맞음", 아님 marks, keyboard decisions and their undo work exactly as today.

## Decisions

1. **Wording: `Claude 동의`.** "Claude" is a product the user picked and pays for, with its own API key, so it is treated like the provider names that already appear in the UI (`TMDB 평점`, `IGDB 평점`, the StashDB and TMDB settings rows). The 2026-10-11 rule (`docs/prototypes/character-model-20261011/README.md`, decision 9) bans *internal recognizer codes* (S36, B36, PixAI, canary) because they mean nothing to the user. Neither the model family nor the version (`Haiku`, `claude-haiku-5-5`) appears in UI strings, because the model may change. `맞음` was rejected because it is the user's own decision word in 확인; `동의` makes clear this is a second opinion.
2. **PC grid placement:** a `scrim` Badge over the image's top-left corner. The zoom button is top-right and the 아님 mark is centred, so they never collide. Because it floats over the picture, it never changes tile height or caption wrapping, so its arrival cannot shift the grid. It is not added to the caption reason badges, because a new badge there could wrap to a second line and push the next row down.
3. **Reason text:** shown only in the PC one-at-a-time panel, as one muted meta line `Claude · <reason>`. The panel is already an opened surface. Hover tooltips and `title` bubbles are banned (§9). The grid and the tablet card show the badge only.
4. **Ordering:** inside each character group, items Claude agreed with come first (a stable partition). Everything else keeps the existing order, and the order of the groups does not change. The ranking is fixed when an item is first shown, so an opinion that arrives while the list is open adds the marker in place without moving anything (see Ordering rule).
5. **Group header count:** `Claude 동의 N`, shown only when N > 0. It is the last element of the header (after the reference thumbnails), so its appearance never shifts the name, count or references. The same text appears on 확인 overview character rows.
6. **Tablet:** the same `Badge` and the same string. The badge leads the caption's reason badges and does not sit on the image, because the card's top-left corner is where the swipe stamp (다음/맞음) appears. The tablet's pill-shaped `.review-chip` is replaced by the shared `Badge` in the same change (§12: tablet copies are replaced when a later round touches the same piece).
7. **Settings:** one group, `라이브러리 › Claude 의견`, placed directly after the `캐릭터` group. It holds the key, the on/off switch, the monthly cap with this month's spend, and the job status with its action. Keeping the key next to the job it pays for avoids splitting one feature across 연결 and 라이브러리. The tablet has no settings for this: the PC owns the key and runs the job.

## Read model (shared by PC and the tablet feed)

- `src/characters/confirmModel.ts`, `ConfirmItem`: add `claude: { reason: string | null } | null`.
  - It is present only for a **current yes** opinion, meaning the stored opinion's asset hash and reference snapshot both match today's.
  - A stale opinion, "no", "unsure", an error, or no opinion yet all read as `null`. The UI never sees the difference.
- New tiny module `src/characters/claudeOpinion.ts` with no imports beyond types, so the tablet can import it:
  - `export const CLAUDE_AGREE = "Claude 동의";`
  - `export const claudeAgreeCount = (n: number) => \`${CLAUDE_AGREE} ${displayCount(n)}\`;` using `src/shared/displayDate.ts`.
  - `export const claudeReasonLine = (reason: string | null) => reason?.trim() ? \`Claude · ${clip(reason.trim(), 80)}\` : null;` (`clip` adds `…`).
  - `export function claudeFirst<T>(items: readonly T[], agreed: (item: T) => boolean): T[]`: a stable partition, agreed items first.
- Ask Claude for the reason in Korean, one short clause of 80 characters or fewer. Keep the existing rule that the "tiny = absent" instruction never goes into the prompt (backlog).

## PC 확인 list

### `ConfirmList.tsx`

- Keep `const rankAgreed = useRef(new Map<string, boolean>())`, created on mount (every time the dialog opens).
  - After each read, for every item key **not yet in the map**, store `item.claude !== null`.
  - Existing keys keep their stored value, including across kind-tab switches and the focus/inbound reloads.
- Pass the map to `groupByCharacter(shown, key => rankAgreed.current.get(key) === true)`.
- `ordered`, `eligible`, shift-range (`keyRange`) and the one-at-a-time walk all keep deriving from `groups`, so they follow the same order automatically.
- A tile is "late" when `item.claude !== null && rankAgreed.current.get(item.key) === false`. Pass `late` to the tile for the fade class.
- One-at-a-time panel (`confirm-list__panel`):
  - When `current.claude`, render `<Badge>{CLAUDE_AGREE}</Badge>` (plain) as the **first** child of `.confirm-list__badges`, before the `reasonBadges` output. Do not add it to `reasonBadges()`, because that function also feeds the grid caption.
  - Right after `.confirm-list__references`, render `<p className="confirm-list__meta">{claudeReasonLine(current.claude.reason)}</p>` when that returns non-null.

### `confirmModel.ts`

- `groupByCharacter(items, agreed?: (key: string) => boolean)`: after grouping, apply `claudeFirst` to each group's `items` when `agreed` is given. Group order is still "first appearance".
  - Because the partition happens inside groups, a group whose first item moves does not change its own position.
  - Compute the group order from the **unpartitioned** list, as today.
- `ConfirmCounts` / `ConfirmTally`: add `claude: number` (items with `claude !== null`). It is **not** a kind: do not add it to `CONFIRM_KINDS`, `total` or `confirmSplitText`. `emptyConfirmCounts`, `confirmCounts` and `tallyConfirm` fill it.

### `ConfirmGrid.tsx`

- Group header: after the `<ul className="confirm-grid__refs">` (or after the count when there are no references), render `{claudeCount > 0 && <span className="confirm-grid__group-claude">{claudeAgreeCount(claudeCount)}</span>}`.
  - `claudeCount` is the live count of `group.items` with `claude !== null`, not the snapshot.
  - As today, the header exists only when `grouped`.
- Tile: inside `.confirm-grid__pick`, after `<Picture>` and before the 아님 mark, render `{item.claude && <Badge variant="scrim" className={\`confirm-grid__claude${late ? " confirm-grid__claude--late" : ""}\`}>{CLAUDE_AGREE}</Badge>}`. Do the same in the `single` (한 장씩 보기 필요) button branch.
- Accessibility: append ` · Claude 동의` to the pick button's `aria-label` when `item.claude`. The badge text is also read, so give it `aria-hidden="true"` to avoid double reading.

### `ConfirmList.css` (copy from the mockup's "Proposed additions")

```css
.confirm-grid__claude { position: absolute; top: var(--space-1); left: var(--space-1); pointer-events: none; transition: opacity var(--motion-small) var(--ease-out); }
.confirm-grid__claude--late { animation: confirm-list-in var(--motion-small) var(--ease-out); }
.confirm-grid__tile[data-marked] .confirm-grid__claude { opacity: .55; }
.confirm-grid__group-claude { font-size: var(--type-meta); line-height: var(--line-meta); color: var(--color-muted); white-space: nowrap; }
```

- The keyframe `confirm-list-in` already exists in that file, and `@media (prefers-reduced-motion)` handling follows the file's existing motion.
- The badge keeps the shared `scrim` variant: no colour or size override. The accent colour is not used: it is reserved for selection, primary, on and NEW.
- When the user marks a tile 아님, the badge dims to 0.55 like the caption, so the user's judgment visibly wins.

### `ConfirmOverview.tsx`

- `CharacterRow`, including the rows under 더 보기: when `character.counts.claude > 0`, append ` · Claude 동의 N` after the `Split` inside `.crv-character__t`. Use the same meta styling as `Split`, separated by `<span aria-hidden="true"> · </span>`.
- Series headers, the index and the page summary stay unchanged. Words rule: the count matters where the user picks a character.

## Tablet review (`mobile-client/CharacterReview.tsx`, ~line 508)

- `ReviewItem` (`characterReviewDelivery.ts`): add optional `claude?: true`. An older server omits it, which means no badge.
- Caption, `.review-sources`:
  - Replace `<span className="review-chip">` with `<Badge key={source}>{SOURCE_LABEL[source]}</Badge>`, imported from `./ui`.
  - When `current.claude`, prepend `<Badge>{CLAUDE_AGREE}</Badge>`, importing `CLAUDE_AGREE` from `../src/characters/claudeOpinion`.
  - The Badge's tablet size (24 px, icon 16) comes from the tablet tokens. Do not restyle it.
- `characterReview.css`: delete the `.review-chip` rule (it uses a pill radius, which §12 bans), and set `.review-sources { gap: var(--space-1); }`.
- No reason text and no long press on the tablet: long press would fight the card drag, and the card has no detail surface.
- The card content never changes while it is shown (opinions arrive with the feed), so the badge never appears mid-view and there is no layout jump.
- **Feed order** (`src-tauri/src/library/character_review_feed.rs`):
  - Add `claude: bool` to the published item (serialize only when true).
  - After the merge, reorder **within each target's own slots**: collect the positions a target occupies in the merged order, then refill those positions with that target's items, agreed first, each part keeping its existing order. Targets keep their interleaving.
  - A character-scoped feed (`CharacterReviewChip`) therefore shows agreed items first, matching the PC group rule.
- Server (`server/lakomics-api`): accept and relay the additive item field. Changing and deploying the server needs the user's approval (backlog).

## Settings (`src/settings/SettingsView.tsx`, PC only)

- New component `src/settings/ClaudeOpinionSettings.tsx`, rendered in the `library` section directly after the `캐릭터` `SettingsGroup`:

  ```tsx
  <SettingsGroup title="Claude 의견" help="Claude가 확인 목록의 추천을 레퍼런스와 비교해, 같은 캐릭터라고 볼 때만 'Claude 동의'를 붙입니다. 아니라고 하거나 모르겠다고 하면 아무것도 표시하지 않습니다. 이미지와 레퍼런스가 Anthropic으로 전송됩니다.">
  ```

- Move `CredentialRow`, `InlineEdit` and `ConfirmLine` unchanged from `SettingsView.tsx` into `src/settings/CredentialRow.tsx` (a pure move) and import them from both files.

Rows, top to bottom (the shared `SettingsRow` and `.settings-view__*` classes, no new row CSS):

| Row | Control | Status line (`settings-view__status`) |
|---|---|---|
| `Claude API 키` | `CredentialRow` with `name="Claude API 키"` and `placeholder="API 키 (sk-ant-…)"`; password field; Badge `설정됨`/`없음`; `입력`/`바꾸기`/`삭제`; delete confirm `Claude API 키 설정을 삭제할까요?` (generated) | — |
| `의견 받기` | `<Switch aria-label="의견 받기">`; applies immediately; disabled while saving | — |
| `월 한도` | `<Select label="월 한도" className="claude-opinion__cap">` with options `$1 $2 $5 $10 $20 $50 $100`, default `$5`; applies immediately | `이번 달 $0.84 사용` (`$` plus two decimals, tabular, spend in local-time calendar month) |
| `상태` | see the states below | see the states below |

The cap select's own visible label repeats the row name. Hide it with the mockup rule `.claude-opinion__cap > span { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }`; the label stays for screen readers.

**Key storage:** the OS credential store, through the same backend mechanism as the TMDB/StashDB tokens (keyring entry; never in settings JSON, logs or the repository). Never send `ANTHROPIC_API_KEY` through the environment.

### States of the 상태 row

| State | Status text | Control |
|---|---|---|
| No key | (rows 2–4 are not rendered; only the key row shows) | — |
| Ready, pending > 0 | `의견 받을 추천 N건` | `Button size="sm" variant="secondary"`: `지금 의견 받기` |
| Ready, pending 0 | `모두 받음 · <localDateTime(lastFinishedAt)>` (today reads just `21:45`) | `지금 의견 받기`, disabled |
| Switch off | same text as Ready | `지금 의견 받기`, disabled; nothing is sent; existing markers stay |
| Running | `<BusyLabel busy delay={400} idle={previous status text}>의견 받는 중 12 / 35</BusyLabel>`; the numbers update in place (tabular) | `Button size="sm" variant="quiet"`: `취소` (stops after the request in flight; then back to Ready with the remaining count) |
| Monthly cap reached | `한도 도달 · 남은 N건은 11.1부터` (first day of next month via `displayDate`; another year reads `2027.1.1`) | `지금 의견 받기`, disabled; raising `월 한도` re-enables it immediately; **not** danger colour, because this is not an error |
| Error | one line, `tone="off"`: `API 키가 맞지 않습니다` (401/403), `연결하지 못했습니다` (network), or `의견을 받지 못했습니다` (other) | `다시 시도` (secondary) |

- **Appearing rows:** when a key is saved, rows 2–4 ease in over 140 ms (opacity plus a 4 px rise; reduced motion snaps). Use the shared `MotionPresence` if it fits. When a key is deleted, they leave the same way. Nothing appears from nothing, and nothing blanks.
- **Delayed busy label:** follow the user's rule. "의견 받는 중" never shows for runs shorter than 400 ms and never blinks, because `BusyLabel`/`useDelayedBusy` keep it at least 400 ms once shown.
- **Status source:** poll the job status with the existing workload-aware delay (`workloadPollDelay`), as other settings jobs do, only while the 라이브러리 section is open. Suggested gateway names: `getClaudeOpinionStatus`, `setClaudeApiKey`, `deleteClaudeApiKey`, `setClaudeOpinionSettings({ enabled, monthlyCapUsd })`, `startClaudeOpinions`, `cancelClaudeOpinions`. The status shape is `{ configured, enabled, monthlyCapUsd, spentThisMonthUsd, pending, running: { done, total } | null, capped: boolean, lastFinishedAt, error: "auth" | "network" | "other" | null }`.
- **Cap enforcement** is in the backend: check the estimated cost before each request, and stop with `capped` before the request that would exceed the cap.

## No-flash and motion checklist

- The marker never changes layout: a scrim overlay on PC, and a static caption row on the tablet.
- A late opinion on PC adds the badge with a 180 ms fade (`--motion-small`), with no reorder. The group count updates its number in place. The count span, when it first appears, uses the same fade.
- Reordering happens only when the 확인 list is opened again. The grid's existing first-load intro covers that open.
- Opinions never empty or blank the list. They arrive through the existing "keep old content until the new read lands" path.

## Tests to add or update

- `confirmModel.test.ts`:
  - `groupByCharacter` with `agreed` is a stable partition inside groups, and the group order is unchanged.
  - `claude` is counted, but not in `total` or the split text.
- `ConfirmList.test.tsx`:
  - An item that gains `claude` on a reload keeps its position and gets `.confirm-grid__claude--late`.
  - The panel shows the badge first and the reason line; an empty reason renders no line.
- `ConfirmGrid`: the header count appears only when it is > 0; the `aria-label` suffix.
- `CharacterReview` (mobile test): the `Claude 동의` Badge leads the sources when `claude: true`; there is no `.review-chip`.
- `character_review_feed_tests.rs`: the within-target slot reorder, and the field is omitted when false.
- `SettingsView.test.tsx` / the new component's test:
  - No key shows only the key row.
  - Running shows the busy text only after 400 ms (fake timers).
  - Capped shows a disabled button without a danger tone.
  - Error shows `다시 시도`.
- `src/shared/sharedPieces.test.ts` needs no new rule; `designFoundation.test.ts` should stay green, because the new CSS uses only tokens.

## Open questions for the user (2)

1. **Folded candidates (더 보기):** recommendations of characters still far from switching to 학습 인식 are folded and left out of the counts. When Claude agrees with one of them, should it stay folded (proposal: yes in slice 1; its 더 보기 row shows `Claude 동의 N`, so it is easy to find), or move up into the counted 확인 list?
2. **When the job runs:** with `의견 받기` on, should new recommendations get Claude's opinion automatically (proposal: yes, when the PC is idle, within the monthly cap, paused in 절약 모드), or only when the user presses `지금 의견 받기`?
