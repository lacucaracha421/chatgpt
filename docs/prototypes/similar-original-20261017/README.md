# Similar images: original clues and the recommended button (SIM-ORIGINAL-001, UI part)

Status: proposal, 2026-10-17. Open `index.html`: the PC review (switch between cases a–e; `?case=a|b|c|d|e` opens one), tablet portrait and landscape (`tablet.html`, follows the switcher), all five cases at a glance, and the reason-sentence table. Pages load the app's real `fonts.css`, `tokens.css`, `shared-base.css`, `shared-surfaces.css`, `controls.css`, `chrome.css`, `similarity/similarity-review.css` and `video/VideoSimilarity.css` (PC), or `mobile-client/mobile.css`, `characterReview.css` and `similarityReview.css` (tablet). `clues.css` is the NEW shared piece; `page.css` and the tablet `<style>` hold the mockup frame and the rules marked CHANGED. `cases.js` holds the example data and the rendering the components will do.

Scope: the area under the two images and the action row of the image similarity review, on PC and tablet. The 이미지/영상 tabs, the historical scan strip, the tablet top bar, the compare modes (깜빡임/와이프), zoom/pan, undo and the decision pipeline are unchanged. Clear-cut artist-vs-reposter near-identical pairs are auto-resolved upstream and never reach this screen; the screen handles every remaining pair the same way.

## 1. Layout

**PC** (`SimilarityReviewBrowser.tsx`):

```text
┌ preview A ──────────────┐  label  ┌ preview B ──────────────┐   (A/B scrim badge top-left of each)
│                         │ column  │                         │
└─────────────────────────┘         └─────────────────────────┘
                 A  권장  │         │ B                              header row
   @kuroba_rin_ 알 수 없음 │  계정 › │ @shiro_neko_art 작가           rows: 1px line between,
              6.2 19:40   │ ‹ 게시  │ 6.3 21:05                      deciding row has a face
            1,200 × 1,697 │ 해상도 › │ 2,480 × 3,508
              793 KB JPEG │  크기 › │ 4.7 MB PNG
───────────────────────────────────────────────────────────────────
 Reason sentence (body)                         [A 유지 · B 휴지통] [B 유지 · A 휴지통] [둘 다 보관]
 Existing hint (meta, faint)
```

- `.similarity-review__comparison` becomes one grid: `minmax(0,1fr) var(--clue-label-width) minmax(0,1fr)`, row 1 = the two previews (columns 1 and 3, the label column is the gap between them), row 2 = the clue table spanning all three columns. `--clue-label-width` is `calc(var(--type-meta) * 9)` (108 px PC, 117 px tablet), so each value sits directly under its own image.
- Previews keep `AssetImage`/privacy mask and contain-fit; the side name moves onto the image as a `Badge variant="scrim"` at the top-left (`--space-2` inset). The `h3`, the filename and the per-panel `<dl>` go.
- The top line `.similarity-review__difference` (`출처 정보가 더 충분한 …` · `해상도 … → …` · `새 이미지가 … 더 큼`) is removed; the table replaces it.
- Footer `.similarity-review__actions` becomes a two-column grid: left the reason sentence (`--type-body`, `--color-text`) with the existing hint below it (`--type-meta`, `--color-faint`, left-aligned); right the three buttons (`grid-row: 1 / span 2`).

**Tablet** (`mobile-client/SimilarityReview.tsx`):

- Portrait: panes stacked (unchanged), the clue table below them, then the footer: reason sentence (body, centred), the three-button grid, the existing hint (meta, faint). Landscape: panes side by side with `column-gap: var(--clue-label-width)` so values line up under their images as on PC.
- `MetaStrip` and `.similarity-metas` are removed and replaced by the same shared table. The pane tag becomes the shared scrim `Badge` (was a local 4px-radius, weight-700 label). Panes lose their 1px border and 8px radius (media tiles are radius 0); background `--color-sidebar` as on PC.
- The `권장` badge inside the button is removed (the primary face says it; the header row carries `권장`). Button text uses `--type-body` (the current 13px is off-role).
- In compare mode (깜빡임/와이프) the table and footer stay below the stage unchanged.

## 2. The clue table (NEW shared piece)

`src/similarity/SimilarityClues.tsx` + `src/similarity/similarity-clues.css`, used by both clients (tablet imports it like other shared pieces). It takes plain data and never branches on the client; sizes come from tokens (`--type-body/meta`, `--row-height` 32/48, `--badge-height`).

Props (plain data, mapped by each client):

```ts
type ClueSideKey = "a" | "b";                       // a = existing / A, b = candidate / B
type ClueKey = "account" | "posted" | "resolution" | "bytes";
type ClueSideData = {
  handle: string | null;       // "@shiro_neko_art" (X only); null → show host
  host: string | null;         // "pixiv.net" (hostname without www.)
  role: "artist" | "reposter" | "unknown";
  postedAt: string | null;     // source_published_at
  width: number | null; height: number | null; byteSize: number | null; format: string;
};
type Props = {
  names: [string, string];                         // ["A","B"] or ["기존 이미지","새 이미지"]
  sides: [ClueSideData, ClueSideData];
  clues: Record<ClueKey, ClueSideKey | null>;      // which side each clue favours
  reason: ClueKey | null;                          // the clue that decided; null = no recommendation
};
```

Structure: a real `<table>` (`table-layout: fixed`, `border-collapse`), visually hidden `<caption>단서 비교</caption>`.

| Part | Content | Style |
| --- | --- | --- |
| Header row | `{name}` + `Badge` `권장` on the recommended side | name weight 600; A right-aligned, B left-aligned; badge plain (`--color-surface-elevated`, muted), `--space-2` after the name |
| Row `계정` | `handle` (or `host` in `--color-muted`, or `—`) + plain `Badge`: `작가` / `퍼온 계정` / `알 수 없음` | badges are all the same plain variant; no colour per role |
| Row `게시` | `displayDateTime(postedAt, now, { withTime: true })` → `6.3 21:05`, `2025.8.14 21:03`, `21:05` today, `어제 21:05`; missing → `—` in `--color-faint` | tabular figures |
| Row `해상도` | `2,480 × 3,508` (`toLocaleString`) | tabular |
| Row `크기` | `formatBytes(byteSize)` + format (`4.7 MB` `PNG`), the format in meta `--color-muted` with `--space-2` before it | tabular |
| Centre cell (`<th scope="row">`) | the label, with a 14px Heroicons chevron (stroke 2, `--color-muted`) in a fixed 16px slot on the favoured side: `‹ 게시` favours A, `해상도 ›` favours B; ties have no chevron | meta, `--color-faint`; label slot fixed width (4em) so chevrons line up |

Value emphasis per row (weight + colour, never colour alone):

- favoured side: `--color-text`, weight 600 (`data-favoured`);
- the other side: `--color-muted`, weight 400 (`data-other`);
- tie or not comparable: both `--color-text`, weight 400, no chevron.

The deciding row (`reason`): every cell gets the `--color-surface` face and its label turns `--color-text` (`data-deciding`). No edge stripe, underline, accent colour or extra square (DESIGN §12). Rows are `--row-height` with a 1px `--color-border` line between rows; cells `0 var(--space-3)` padding, ellipsis on overflow.

Accessibility: the centre `<th>` carries visually hidden text ` · {name} 쪽` when a side is favoured, so a screen reader hears `게시 · B 쪽`. Chevrons are `aria-hidden`.

## 3. Recommendation rule and reason sentence

The rule lives in Rust (it replaces `provenance_rank` in `src-tauri/src/library/similarity.rs`, backlog SIM-ORIGINAL-001). Rust also computes the per-clue favours and the deciding clue, so the clients only render; there is no second copy of the rule in TypeScript.

Per clue (each returns the favoured side or `null`):

| Clue | Favours | Tie / not comparable |
| --- | --- | --- |
| `account` | role rank `artist` > `unknown` > `reposter` (see open question 1) | same handle (case-insensitive), same role, or both without a handle |
| `posted` | the earlier `source_published_at` | either side missing, or equal to the minute |
| `resolution` | larger `width × height` | equal pixel count, or either missing |
| `bytes` | larger `byte_size` | difference under 2% of the larger (proposed: keeps a re-encode from producing a recommendation out of noise), or either missing |

`reason` = the first non-null clue in the order account → posted → resolution → bytes; the recommended side is `clues[reason]`; `reason = null` ⇔ `recommendedAssetId = null`. Recommend for incoming pairs too (today only historical pairs get one).

Reason sentence, one line, in `src/similarity/clues.ts` (`reasonSentence`), shared by both clients. `{X}` is the recommended side's name; all current names take `를`.

| Deciding clue | Sentence |
| --- | --- |
| `account`, recommended side is `artist` | `작가 계정에 올라온 {X}를 권장합니다.` |
| `account`, recommended side is `unknown` (other is `reposter`) | `퍼온 계정이 아닌 {X}를 권장합니다.` |
| `posted` | `먼저 올라온 {X}를 권장합니다.` |
| `resolution` | `해상도가 더 큰 {X}를 권장합니다.` (if open question 2 is accepted and both sides share the account: `같은 계정이라 해상도가 더 큰 {X}를 권장합니다.`) |
| `bytes` | `파일이 더 큰 {X}를 권장합니다.` |
| none | `단서가 같거나 없어 권장하지 않습니다.` in `--color-muted` |

## 4. Buttons

- Order never changes: keep A (existing), keep B (candidate), keep both. Only the face moves.
- The recommended decision uses `Button variant="primary"` (ivory, the screen's one primary); the other two are `secondary`. With no recommendation all three are `secondary`. `둘 다 보관` is never primary.
- The primary button gets `aria-description="권장"`.
- Labels (move the tablet `CHOICES` into `src/similarity/clues.ts` and use it on both clients):

| Pair | keep_existing | replace_existing | keep_both | Side names |
| --- | --- | --- | --- | --- |
| historical (both clients) | `A 유지 · B 휴지통` | `B 유지 · A 휴지통` | `둘 다 보관` | `A` / `B` (PC changes from `이미지 A` / `이미지 B`) |
| incoming (PC only) | `기존 이미지 유지` | `새 이미지로 교체` | `둘 다 보관` | `기존 이미지` / `새 이미지` |

- The hint lines stay as they are (PC historical/incoming hints; tablet server-apply/PC-apply hints), now `--color-faint` meta under the reason (PC) or under the buttons (tablet).

## 5. States and motion

- **Pair change (no flash):** the table, reason and button faces belong to the pair. They change in the same render as the images, once the next pair's images are ready (PC keeps the current pair on screen while `load()` runs; tablet already swaps on the queue head). No fade or slide on the table; the button face uses its existing 120 ms colour transition. No layout shift: the table has a fixed row count and row height, missing values render `—`.
- **First load:** existing skeleton/loading line; the table is not rendered before the first pair arrives.
- **Pending decision (PC):** buttons disabled as today; the primary keeps its face while disabled.
- **Privacy mode:** previews are masked as today; the table still shows (handles are not image content). If the user wants handles hidden in privacy mode, mask the account row values with `•••` — not in this proposal.
- **Older PC feeding a newer tablet / older tablet:** missing `clues`/`reason` → render the table with no chevrons, no deciding row, no reason line, and the primary face still taken from `recommendedAssetId` / `recommendation`.
- **Same account (case d):** both account cells show the same handle and badge; no chevron.

## 6. Data mapping

| Shown | PC source (`SimilarityReviewSummary`) | Tablet source (`SimilarityItem` / server `Side`) |
| --- | --- | --- |
| handle | `asset.creatorHandle` when the source is X (`sourceUrl` host x.com / twitter.com), else null | NEW `accountHandle: string \| null` |
| host | hostname of `asset.sourceUrl` | NEW `sourceHost: string \| null` (or derive from existing `sourceLabel`) |
| role | NEW `existing.accountRole` / `candidate.accountRole` | NEW `accountRole: "artist" \| "reposter" \| "unknown"` |
| posted | `asset.sourcePublishedAt` (already on `AssetSummary`) | NEW `sourcePublishedAt: string \| null` |
| resolution, size, format | `asset.width/height/byteSize`, `format` | `width/height/byteSize/format` (existing) |
| favours, deciding clue | NEW `clues`, `reason` on the summary | NEW `clues`, `reason` on the item |

`accountRole`: resolve the handle through the artist scope. An artist that matches the handle and is not marked `reposter` → `artist` (hidden artists still count); marked `reposter` → `reposter`; no match or no handle → `unknown`.

Wire changes (order matters because both ends are strict): server `similarity_review.py` `Side`/`Item` (`extra="forbid"`) accept the new optional fields first; then the PC `FeedSide`/`FeedItem` in `src-tauri/src/cloud/similarity_review.rs` (`deny_unknown_fields`) send them; the tablet `similarityReviewDelivery.ts` types read them as optional.

## 7. Files

- NEW `_tools/app/src/similarity/clues.ts` — labels (`계정`, `게시`, `해상도`, `크기`), role labels (`작가`, `퍼온 계정`, `알 수 없음`), `reasonSentence`, side names, `SIMILARITY_CHOICES`.
- NEW `_tools/app/src/similarity/SimilarityClues.tsx`, `similarity-clues.css` (imported from `styles/global.css` for PC and from the tablet screen).
- `_tools/app/src/similarity/SimilarityReviewBrowser.tsx` — previews with scrim badge, `SimilarityClues`, footer reason + hint + buttons with the primary rule; remove `ReviewAssetPanel`'s `h3`/filename/`dl`, `reviewRecommendation`, `comparisonSummary`.
- `_tools/app/src/similarity/similarity-review.css` — comparison grid and footer grid (`page.css` CHANGED rules); drop the `__asset`, `__filename`, `__difference` rules.
- `_tools/app/src/library/types.ts` — `SimilarityReviewSummary.clues/reason`, `SimilarityReviewAsset.accountRole`.
- `_tools/app/mobile-client/SimilarityReview.tsx` — remove `MetaStrip` and the in-button badge; render `SimilarityClues` and the reason line; scrim `Badge` pane tags; `CHOICES` from the shared module.
- `_tools/app/mobile-client/similarityReview.css` — remove `.similarity-meta*`, `.similarity-badge`, `.similarity-pane-tag`; pane radius/border; landscape `column-gap`; footer rules (tablet `<style>` CHANGED block).
- `_tools/app/mobile-client/similarityReviewDelivery.ts` — optional new side/item fields.
- Rust/server per §6 and the backlog item.

## 8. Checks for the implementation round

Visual parts need no new tests. Worth unit tests: Rust per-clue favours and `reason` (artist vs unknown, two reposters, same account, missing post time, 2% byte tie); `reasonSentence` for each reason; one PC and one tablet render test that the recommended decision is the only `primary` button and that no button is primary when `reason` is null. Device check: tablet portrait/landscape fit (landscape leaves about 345 px per image at 1280 × 800).

## Open questions

1. **Does a known artist beat an unknown account?** The mockup ranks `artist` > `unknown` > `reposter`, so in case (a) the artist side is recommended even though the unknown account posted a day earlier. The alternative: account decides only artist vs reposter, and an unknown account (possibly the artist's second account) falls through to post time (case a would then recommend 기존 이미지).
2. **Same account, different post times (case d):** the stated rule recommends the earlier post, which can be a lower-resolution first upload while the later one is the artist's high-resolution re-upload. Proposal: when both sides are the same account, skip post time and let resolution decide (toggle `(d) 같은 계정이면 해상도로` in the mockup).

Wording note: the brief said `퍼가는 계정`; the mockup uses `퍼온 계정`, the term the 작가 screens already use for the `reposter` flag (`ArtistPage.tsx`, `ArtistHub.tsx`), per the one-term rule in DESIGN §12.
