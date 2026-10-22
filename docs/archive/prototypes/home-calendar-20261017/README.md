# Home month calendar, day memo and ledger (HOME-CAL-001, 2026-10-17)

Status: proposal (design mockup and spec). App source is unchanged. Backlog: [`HOME-CAL-001`](../../../roadmap/lakomics-backlog.md#home-cal-001). Decisions recorded there (month grid, 링크 보관 off Home, right column order, one memo per day, ledger v1 with read-only subscriptions, privacy hides amounts, tablet follows) are taken as final; the open points are listed at the end.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page: PC states A–F (1920 × 1080 and 1440 × 900 windows, scaled; 실제 크기 shows 1:1 with sideways scroll), tablet section G, decisions, gaps. Frame A is interactive. |
| `tablet.html` | One portrait tablet (800 × 1280), loaded three times by `index.html` in iframes (`#home`, `#sheet`, `#private`). It loads `mobile.css` instead of the PC base CSS, as the tablet does. Interactive. |
| `homecal.css` | **Proposed** CSS. Each block names the app file it would join. |
| `homecal.js` | Markup with the app's class names, stand-in data in the shapes of the real sources, and the light interactions (select day, ‹ › 오늘, arrow keys, quick entry, edit row, tablet sheet). |
| `mock.css` | Mockup only: the light 종이 theme stand-in (from `tablet-structure-20261017/page.css`), stand-in pictures, the stand-in booster pack. |
| `page.css` | Mockup only: document, scaled frames, fake PC window chrome. |
| `tablet-page.css` | Mockup only: fake tablet chrome (status bar, bottom nav). |
| `app-css/` | Copies of the app's CSS in the repository layout (relative imports keep working): `src/styles/{tokens,fonts,shared-base,shared-surfaces,shared-toolbars,shared-states,shared-hover,controls,surface-motion,chrome}.css`, `src/styles/fonts/PretendardVariable.woff2` (+ OFL), `src/home/{home,homeAttention,homeCalendar,homeTools}.css`, `src/cards/album.css`, `src/notes/ledger/ledger.css`, `mobile-client/{mobile,home,library,avInbox}.css`, `mobile-client/homeTablet/homeTablet.css`, `mobile-client/cards/tabletCards.css`. Copied 2026-10-17; the tablet Home files were being edited by another worker at the time. |

The page follows `prefers-color-scheme`; the 자동 / 어둡게 / 밝게 switch sets `data-theme` on `<html>` and forwards it to the tablet iframes by `postMessage`. The app itself ships only the dark theme.

## PC layout

- Home keeps layout A: left column (calendar) and right column `minmax(0, min(400px, …))` from `home.css`.
- **Left column:** the month calendar and the **day panel** (`.home-month-layout`, a container named `homemonth`).
  - Left column ≥ 1100 px (a maximised 1920 window): the panel sits **beside** the grid, 340 px, behind a hairline, scrolling inside itself; day cells 136 px high.
  - Narrower: the panel sits **under** the grid, full width, with three columns 발매·저장 이미지 | 메모 | 가계부; day cells 112 px.
- **Right column, top to bottom:** 오늘의 카드 (compact: stage 168 px, pack 80 px wide) → 오늘 할 것 → 전송 (drop box 88 px, recent sends) → 빠른 메모 (fills the rest, at least 160 px). 링크 보관 is removed from Home.

### Why an always-visible panel (placement decision)

- The panel is always present and shows **today** until another day is picked. Picking a day swaps only the panel's content in one step; nothing opens, slides or blanks (no-flash rule), and nothing pops in.
- Today's memo and quick entry are therefore one click away, which is the everyday use.
- Beside the grid on wide windows, because Home's left column then has ~1,380 px and the cells stay near-square (≈140 px). Under the grid on narrow windows, because a side panel there would squeeze cells to ~80 px; under the grid the wide strip fits three columns.
- Rejected: a side sheet opened on click (an open/close surface for every look, and it covers the right column); a popover on the cell (covers the neighbouring days, too small for editing rows); expanding a row under the selected week (other weeks jump under the pointer when the selection moves between weeks).
- When the panel is under the grid and mostly off screen, picking a day scrolls the Home scroller smoothly until the panel is in view; no scroll when it is already visible. Reduced motion jumps.

## Month calendar

- Header (`.home-month__head`): month title in the title role (`10월`; another year `2027년 1월`, DESIGN §12 Dates), `‹` `오늘` `›` (icon buttons named 이전 달 / 다음 달; 오늘 is disabled when the current month and today are already shown), then right-aligned **쓴 돈** (the month's ledger entries) and **예정** (the month's unconfirmed subscription charges), then the `발매 캘린더 ›` link to the existing release calendar view (`calendarView()` in `HomeView.tsx`). A `지난 NEW N개` menu stays in the header while NEW releases exist that the visible month cannot place (undated or earlier); the former `M.D 이후 N개` link is dropped (paging replaces it).
- Grid: Monday first, **always six week rows** so paging never changes the height; weekday row as today (`.home-cal__weekday`, weekend fainter). Days of the neighbouring months show their markers dimmed (opacity .42) and are selectable without paging.
- Marks:
  - Today: the filled accent square behind the date only (user 2026-10-15, unchanged).
  - Current week: a quiet `--color-surface` face across its seven cells.
  - Selected day: the current-location slab (DESIGN §4/§6): accent face, on-accent text, the hard 3 px echo masked with the page background, the small dark square (`--selection-mark-size`) in the cell's top-right corner. If today is selected, its square inverts.
  - Hover lightens the face (PC), press darkens; keyboard focus is the blue outline, separate from selection.
- Cell content, top to bottom, all `meta` size, one line each:
  1. Date (`10.1` on a month's first day, else the day number) · saved-image badge `🖼 30장` (past and today only, as now) · `D-3` badge on future days with a release.
  2. One release line: `NEW` badge first when fresh, the title (`releaseDisplayTitle`, ellipsis), then the kind (`애니`, `22권`) when it fits whole, or a plain `+N` badge when the day has more releases. NEW releases sort first.
  3. One payment line: subscription icon + `클로드 159,000원` (the existing `calendarPayments` label), `+N` badge when more.
  4. Foot: a document mark when the day has a memo; right-aligned wallet icon + the day's spending `25,800원`.
- The whole cell is one button that selects the day (accessible name: date, weekday, release count, saved count, 메모 있음, spending). Releases open from the panel, not from the cell (one target per cell).
- Keyboard: the grid is one tab stop (roving `tabindex`); arrow keys move the selection by a day or week and page the month when leaving it; Enter moves focus into the panel; PageUp / PageDown page months; Home key = 오늘.
- Paging swaps the grid in one step once the next month's data is shaped (no slide); the panel keeps the selected day.

## Day panel

Header: `10월 15일 (목)` (body, 600; weekday muted), an accent `오늘` badge on today, a `오늘로` text link on other days. Sections (each with the shared `SectionLabel`), hidden when empty except 메모 and 가계부:

1. **발매 N** — the day's releases as `.home-arrival-row` rows (`HomeReleaseList` markup: 32 × 44 cover, title, kind, NEW or D-day badge). A row opens what Home opens today: the collection, or the release detail dialog (which also acknowledges the notice).
2. **저장한 이미지** — one `.home-attention-row` (photo mark, `30장`, chevron) opening 에셋 › 전체 scrolled to that date heading (needs a new "open at date" parameter on the asset view; the gallery already groups by local `collectedAt` date).
3. **메모** — one text area in the 빠른 메모 look (no blue focus line, caret marks focus), 3 lines; saved as typed with the 빠른 메모 debounce, on blur and when leaving Home; clearing the text deletes the memo. Limit 500 characters. A conflict shows the 빠른 메모 conflict line.
4. **가계부** — header action = the day's total (entries + that day's unconfirmed charges). Rows are the 가계부's own (`LedgerView` entry rows: icon, name, tag, `₩` amount):
   - manual entries, then confirmed subscription entries (`고정·구독 확정`), then the day's **unconfirmed charges as read-only rows** (`고정·구독 자동`, muted, not a button: confirming or skipping stays in 메모 › 가계부, so nothing is entered twice);
   - empty: one inline `기록 없음` line;
   - below: the 가계부 quick entry (`TextInput` "예: 점심 8000" + 추가, `parseQuickEntry`), dated the selected day; Enter adds. The new row expands (140 ms) and tints toward `--color-success`, fading over 1.4 s (in-place success, no toast);
   - clicking an entry turns it into the 가계부 `EntryForm` in place (날짜, 나간 돈/들어온 돈, 금액, 이름, 저장, 취소, 삭제); Enter saves, Esc cancels; changing the date moves the entry (and its month note, as `LedgerView` does). 삭제 collapses the row and shows the "되돌리기" toast.

## Privacy mode

- Every amount shows `••••` (the secret-note mask, letter-spacing 2px, `aria-label="금액 숨김"`): cell payment and spending, header 쓴 돈 / 예정, panel rows and totals, and the 오늘 할 것 subscription rows (`구독 이번 달`, reminders) which are not masked today.
- Release covers use the existing privacy mask. Names and memo text stay visible (open question).
- Entry rows do not open the edit form (it would reveal the amount); quick entry still works.

## Tablet (follows the PC)

- Portrait one column: the same month section on top (shared `HomeCalendar` month variant, tablet tokens: meta 13, ‹ › 오늘 at 44 px), then the right column's order as two pairs: **오늘의 카드 | 오늘 할 것**, **전송 | 빠른 메모** (tablet `TabletDailyCard` and `TabletTransfer` as today). 링크 보관 leaves the tablet Home too.
- `TabletWeekStrip` (this week / next week) is replaced by month paging: ‹ ›, and a horizontal swipe (56 px, the strip's rule) pages months.
- Tapping a day opens the **day sheet**: the existing `BottomSheet` (auto height, at most 85 %, 닫기 at the bottom; swipe down, outside tap, 닫기 and Back close it) with the same sections. 가계부 rows are the shared rows; `기록 추가` and tapping a row open the tablet 가계부's existing entry sheet stacked above. The calendar keeps the selected-day slab while the sheet is open.
- Saved-image counts have no tablet source today (`Home.tsx`: "Saved-image counts have no tablet source"); showing them needs a server read of per-day counts.

## Data the UI needs

| Data | Shape | Source |
| --- | --- | --- |
| Releases | rows with `date`, `name`, `kind`, `volume?`, `fresh`, `cover` | Today's `newlyReleasedRows` (NEW since last visit) + `upcomingRows` (local manga volumes with a Korean date, wishlist titles with an exact date, from today on). The month grid needs the whole visible range (42 days, past included); past releases that are not NEW need a new shaping from the wishlist (released, exact date) and the local volume board. |
| Saved-image counts | `{date, count}` per day, images only | `gateway.listAssetDateBuckets(calendarSavedQuery())`, widened from 14 to 42 local days (DST-safe boundaries as now). Past and today only. |
| Subscription charges | `{key, date, name, amount, noteId}` read-only | `calendarPayments()` (unconfirmed charges of ledger notes, trial rules), widened to the visible range. |
| Day memo | `{date, text, revision}` | New. One per local date, ≤ 500 characters. |
| Ledger entry | `{id, date, amount, memo, createdAt, revision}` | The existing 가계부 `LedgerEntry` already is `{id, date, amount, name, in?, createdAt, recurring?, planned?}` inside `ledger-month` notes (name = memo; revision = the month note's server revision). |
| Month totals | `{month, spent, planned}` | Derived: entries of the month (`ledgerEntries(monthNotesOf())`) and unconfirmed charges of the month (`monthCharges`). |

**Storage and sync are implementation scope.** Recommended (see open question 1): ledger entries are written into the existing 가계부 (one ledger, month notes), which is already end-to-end encrypted, synced through the server with revisions and conflict copies, and read and written by the tablet; day memos go into one hidden note per month (`day-memo-month`, deterministic HMAC id like `ledger-month`, `archived: true`), so neither needs a new server table or deploy. The backlog's approved alternative is new server persistence (a deploy; the server would see the text). Either way: writes are optimistic with revision checks; a conflict keeps both versions as the notes store does; offline edits queue like 빠른 메모.

## Motion and states

- First load: Home's existing first-load skeleton / launch splash. Later reads (new month data, sync) keep the shown content and swap in one step.
- No animation on day selection or month paging. Ledger rows add/remove with the 140 ms Home presence collapse; reduced motion switches at once.
- Errors: one line + `다시 시도` per source as today (`저장한 이미지 수를 확인할 수 없습니다`, `신간을 확인할 수 없습니다`); a failed memo or entry save keeps the draft and shows the store's error line.
- Locked notes (keyring locked or concealed): 메모 and 가계부 show the 빠른 메모 locked line (`메모를 열어야 쓸 수 있습니다` + 메모 열기); cells show no memo or spending marks.

## 링크 보관

Removed from Home on PC and tablet; the feature and its note stay. Today its only entry points are the Home tile and its full screen (`HomeLinks expanded`), plus the raw `링크 보관` note in 메모. Proposal: add `링크 보관` to the 더보기 destinations and to 찾기 (Ctrl+Q) commands, opening the existing full screen (PC); on the tablet, the 더보기 sheet row.

## Open questions

1. Ledger storage: write into the existing 가계부 (recommended; one place for money, no deploy) or a separate Home ledger on the server? If several 가계부 notes exist, use the one with subscriptions, or pick one in Settings?
2. Day memo storage: hidden month notes in the existing E2E notes sync (recommended) or a new server table?
3. Selected-day mark: the slab (proposed) or a quiet tint with a bold date?
4. Keep past releases on past days (proposed) or keep today's rule (past days show only unopened NEW)?
5. Cell click only selects the day (proposed) or a release line inside the cell still opens the release directly?
6. Privacy mode: amounts only (proposed) or memo text too?
7. Money format: cells keep `159,000원` (calendar) and panel rows keep `₩159,000` (가계부), or unify?
8. 링크 보관 entry point: 더보기 + 찾기 (proposed) or only the note in 메모?
9. Tablet saved-image counts: add the server per-day count read (proposed) or leave tablet cells without counts?

## Unverified

- Not seen in the running app; static mockup with copied CSS and stand-in data and pictures.
- The light theme is the planned 종이 palette, page-only; `album.css` hard-codes the dark card stage, so 오늘의 카드 text is unreadable there (an app issue that matters only once a light theme ships).
- Cost of the 42-day saved-count read and of shaping past releases was not measured.
- The tablet Home CSS was copied while another worker was editing it.
