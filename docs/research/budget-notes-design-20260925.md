# Budget notes ("가계부") inside Lakomics Notes — design (2026-09-25)

Status: Accepted in simplified form by the user on 2026-09-25 (section 7). Not implemented yet.

- Mockups: `docs/prototypes/budget-notes-20260925/` (`index.html` plus PNG renders).
- Builds on `docs/research/notes-v2-design-20260924.md` ("notes-v2") and its fixtures in `tests/fixtures/notes-v2/`.

## 1. Request and scope

The user asked on 2026-09-25 (translated):

> Put the monthly-subscription view in Notes: what I subscribed to and when, when it ends (not everything is monthly), how much it costs, and how much I spend in total every month. Actually, make it more like a household ledger (가계부) … write down what I want to spend on what, in advance.

After reviewing the first draft, the user narrowed the scope (translated):

> Don't build complex categories; do include monthly income. This isn't a grand household ledger. It's for "I bought X, I want to buy Y", "what goes out every month", "I spent this much here".

The feature therefore has four parts:

1. **Recurring charges** with any cycle.
2. **Plans** (사고 싶은 것).
3. **Entries** (what I spent).
4. **Monthly income**, which feeds one headline number.

The design has no categories, no budgets per category, and KRW only.

Constraints:

- It runs on two devices: the Linux PC (Tauri app) and the Galaxy Tab S11 (Android app, touch-first, portrait 800 × 1280 CSS px).
- Notes are end-to-end encrypted (ADR-0035) and synced through a server that never sees their content.
- Notes v2 already supports typed notes with per-id merges.
- The feature must need **no server change**.

## 2. Reference apps: what we took

| App | Concept | Taken |
| --- | --- | --- |
| 뱅크샐러드 가계부 2.0 | Remaining money on the first screen, with fixed costs already excluded, plus "오늘은 ₩N까지" | One headline number that already subtracts committed charges; a quiet daily line |
| 토스 소비 | A daily "what you can still spend" | The daily line |
| Monarch (Flex budgeting) | Fixed, non-monthly (annual renewals, planned purchases) and one flex number | Recurring total, plans, and one "left to spend" number |
| Bobby / Rocket Money | Manual subscriptions with custom cycles, next bill date, trial and cancel state, monthly total | Arbitrary cycles, next charge, trial and 해지 state, monthly-equivalent and yearly totals |
| 편한가계부 / Money Manager (Realbyte) | Repeat schedules on entries; fast entry | Recurring schedules and fast entry |
| YNAB | Plan spending before it happens | Plans, reduced to a simple list |

Deliberately left out:

- Bank or card linking, SMS parsing, OCR.
- Categories and category budgets, per the user's decision.
- Foreign currencies and exchange rates, per the user's decision.
- Investments and account balances.
- Rollover, installments, reminders.
- Charts beyond one progress bar.

Sources:

- Realbyte help: [repeat/installment](https://help.realbyteapps.com/hc/en-us/articles/360046668993-How-to-set-up-a-repeat-schedule-installment). It returned HTTP 403 to direct fetch, so the search snippets were used.
- 뱅크샐러드: [fnnews](https://www.fnnews.com/news/202108110917557518).
- 토스: [토스피드](https://toss.im/tossfeed/article/toss-user-interview-timeline), [데일리팝](https://www.dailypop.kr/news/articleView.html?idxno=74964).
- Monarch: [flex budgeting](https://help.monarch.com/hc/en-us/articles/32125337244052-Using-Flex-Budgeting).
- Bobby and Rocket Money: [comparison](https://www.subnesio.one/blog/subscription-tracker-apps-compared), [Rocket Money help](https://help.rocketmoney.com/en/articles/2185531-managing-your-bills-and-subscriptions).
- YNAB: [targets](https://support.ynab.com/en_us/how-to-use-targets-rk5kkI9ks).

## 3. Concept and screens

A **가계부** is one note in the Notes list. It is created pinned: the fourth option in the "새 메모" sheet.

Opening it shows a month switcher (‹ 2026년 9월 ›), a quiet "수입 N" button that edits this month's income, and four sections:

1. **이번 달**
2. **기록**
3. **고정·구독**
4. **계획**

The month data lives in hidden month notes (section 4.1). Those never appear in the list, search, labels or counts.

**Vocabulary** (Korean UI):

- 수입: this month's income, plus any 들어온 돈 entries.
- 쓴 돈: spent.
- 예정: charges and plans still due this month.
- **쓸 수 있는 돈** = 수입 − 쓴 돈 − 예정.

### 3.1 Tablet

- **Notes list** (`notes-card.png`): the ledger card shows this month's 쓸 수 있는 돈, a 4 px bar and the next charge.
- **이번 달** (`overview.png`), from top to bottom:
  - A large 쓸 수 있는 돈 figure and "하루 약 ₩93,700 · 남은 날 6일".
  - One thin bar: solid = spent, hatched = 예정, empty = free.
  - Four plain figures separated by hairlines: 수입, 쓴 돈, 예정, 고정·구독 이번 달.
  - Short sections: 다가오는 결제 (the next 3 charges), 이번 달 계획 (with 샀어요), and 최근 기록.
  - The FAB is "+ 기록".
  - Past months show final figures. Future months show only income, charges and plans.
  - If no income is set, the large figure becomes 쓴 돈, with a quiet "수입을 적으면 쓸 수 있는 돈이 보여요".
- **기록**: entries grouped by day, newest first, with day totals.
  - Recurring charges whose date has passed appear inline in muted text with a repeat icon. They are derived, not stored.
  - Tapping a derived charge offers 실제 금액으로 확정 or 이번 달은 건너뜀.
- **고정·구독** (`subscriptions.png`): one list covering subscriptions and fixed bills (월세, 보험, 통신), sorted by next charge.
  - The top shows the 월 환산 합계, the 1년 total, this month's charges, the active count, and a line such as "10월부터 디즈니+ +9,900" when a trial ends.
  - Each row shows a neutral monogram, the name, the cycle (매월 27일 / 매년 3월 14일 / 3개월마다 · 12일 / 매주 월요일), the next date with "N일 후", and the amount. Non-monthly items add their monthly equivalent in small text.
  - Badges: 체험 중 · 첫 결제 …, and 해지함 · … 만료. Ended items collapse under 종료됨.
  - Add and edit happen in a sheet with these fields: 이름, 금액, 주기 (매주/매월/매년 × N), 첫 결제일, 체험 중, 만료일, 메모.
- **계획**: grouped by 이번 달 / later months / 언젠가. Each plan has an optional month.
  - 샀어요 opens the entry sheet pre-filled; saving links the entry and marks the plan done with the actual amount.
  - 안 사기로 함 marks it dropped.
- **기록 sheet** (`add-entry.png`):
  - The amount goes in on an in-app keypad (1–9, 000, 0, ⌫). The Android keyboard never opens for the amount, so the layout does not jump.
  - The name is optional, with one-tap chips of recent names. Only the name field opens the keyboard.
  - Date chips: 오늘 (default), 어제, 다른 날.
  - A 나간 돈 / 들어온 돈 switch. 들어온 돈 covers refunds and one-off extra income.
  - Actions: 저장, 저장하고 하나 더.

### 3.2 PC

`pc-ledger.png`:

- The existing Notes shell stays: area rail, Notes index and list. The ledger note is selected with the existing slab and echo.
- The main area has two panes:
  - **Left:** the month summary, upcoming charges, and this month's plans.
  - **Right:** the sections. 기록 has an inline row (날짜 · 금액 · 이름 · 추가) above the day-grouped table.
- Keyboard:
  - Ctrl+N focuses the row. Tab moves between fields. Enter adds.
  - A leading `+` in the amount means 들어온 돈.
  - Alt+←/→ changes the month.
  - `isComposing` is respected.
- There are no tooltips. Hints are a single muted line.

### 3.3 Design rules applied

- Dark neutral surfaces. Hierarchy comes from contrast, 1 px separators and typography, with no stat cards (DESIGN.md §4, §11).
- The accent colour is used only for the primary action and the spent bar.
- Rajdhani Numbers with tabular figures for amounts.
- Sheets reuse `BottomSheet.tsx`. Motion stays at the existing 80–160 ms fades.

## 4. Data model

Everything lives **inside the encrypted plaintext** of ordinary notes:

- Envelope `version: 1`, same AAD, same `schema: 2`.
- Two new `type` values. Older v2 clients already open unknown types read-only.
- No server, envelope, backup or local DB migration change.

Money and date formats:

- Amounts are **integer won**, with 0 ≤ amount < 10¹².
- Dates are local calendar dates `YYYY-MM-DD` with no time zone. Months are `YYYY-MM`.

### 4.1 Storage: one ledger note plus one hidden note per month

Putting all entries in one note would reach the 256 KiB plaintext limit after about 1,200–1,500 entries, and every entry would re-upload the whole history. One note per entry would mean thousands of notes. That is heavy, because Android decrypts every note on each `state()`, and it leaks each purchase as a separate server write.

**The chosen layout is a `ledger` note (the plan) plus one `ledger-month` note per calendar month:**

- A typical month is about 8–15 KB.
- An edit uploads only the current month.
- Old months rarely change.

**Month note ids** are deterministic, so two offline devices creating "2026-09" converge on one note:

```text
hex(HMAC-SHA256(notesKey, "lakomics-ledger-month:1:" + ledgerId + ":" + month))[0..32]
```

- The result matches the server id pattern `^[a-f0-9-]{32,64}$` (`server/lakomics-api/notes.py:10`).
- It uses HMAC with the notes key rather than a plain hash. The ledger id is visible to the server, so a plain hash would let the server label the months.
- The id is computed natively: Rust uses `ring::hmac`, which is already a dependency; Android uses `javax.crypto.Mac`.
- A shared fixture vector pins the result.

**Month notes on older clients and in the trash:**

- Month notes are always written with `archived: true`. Older v2 clients, which see them as read-only unknown types, keep them in 보관함.
- Ledger-aware clients hide month notes everywhere.
- Trashing the ledger hides its months, and restoring brings them back.
- A month whose ledger no longer exists is shown read-only in 보관함.

### 4.2 Payloads

Ledger note:

```jsonc
{
  "schema": 2, "type": "ledger", "title": "가계부",
  "body": "…derived text fallback (4.5)…",
  "income": 2300000,                          // default monthly income, or null
  "recurring": [
    {"id": "uuid", "name": "넷플릭스", "amount": 17000,
     "every": 1, "unit": "month",             // "week" | "month" | "year"; every 1..120
     "start": "2026-01-03",                   // first paid charge; also the day anchor
     "trial": false,                          // true: free trial until start
     "until": null,                           // no charge on or after this date (cancelled/ends)
     "memo": "", "order": "V"}
  ],
  "planned": [
    {"id": "uuid", "name": "러닝화", "amount": 89000, "month": "2026-09",  // null = 언젠가
     "memo": "", "dropped": false, "order": "V"}
  ],
  "pinned": true, "deleted": false, "createdAt": "…", "updatedAt": "…"
}
```

Month note:

```jsonc
{
  "schema": 2, "type": "ledger-month", "title": "가계부 2026년 9월",
  "body": "…derived text fallback…",
  "ledger": "<ledger note id>", "month": "2026-09",
  "income": null,                              // this month's income if different, else null
  "entries": [
    {"id": "uuid", "date": "2026-09-25", "amount": 9500, "name": "점심 김치찌개", "createdAt": "…"},
    {"id": "uuid", "date": "2026-09-24", "amount": 18000, "name": "택배 반품 환불", "in": true, "createdAt": "…"},
    {"id": "uuid", "date": "2026-09-29", "amount": 28000, "name": "ChatGPT Plus", "createdAt": "…",
     "recurring": {"id": "<recurring id>", "date": "2026-09-29"}},   // confirms or skips (amount 0) one charge
    {"id": "uuid", "date": "2026-09-19", "amount": 22000, "name": "접이식 우산", "createdAt": "…",
     "planned": "<planned id>"}                                        // buys a plan
  ],
  "pinned": false, "deleted": false, "archived": true, "createdAt": "…", "updatedAt": "…"
}
```

Field rules:

- Entries sort by `(date desc, createdAt desc, id)`. They have no order key.
- `in: true` marks money in: a refund or one-off income. This is the "second income line", kept trivial.
- Moving an entry to another month writes the target month first, then removes the entry from the source. Readers dedupe by id and prefer the copy whose month matches its date.
- `ledger` and `month` are immutable, so a draft that changes them is refused.

### 4.3 Derived values (shared TypeScript only)

Charge dates for a recurring item:

- Charges fall on `start + k·every·unit` for k ≥ 0, strictly before `until`.
- For monthly and yearly items, the 29th–31st clamp to the last day of the month. Each date is recomputed from `start`, so the day never drifts (31 Jan → 28 Feb → 31 Mar).
- Weekly charges fall on `start + 7·k·every` days.

Monthly equivalent:

| Unit | Formula |
| --- | --- |
| month | `amount / every` |
| year | `amount / (12·every)` |
| week | `amount · 52 / (12·every)` |

- The result is rounded to the won.
- The 월 환산 합계 counts items active today, excluding those in trial or ended.
- The yearly total is the monthly total × 12.

Month summary for month M on day T. For past months T is the month's end; for future months T is its start.

- A charge dated in M is **confirmed** when an entry in M carries `recurring = {id, date}`. That entry's amount replaces the charge.
- 수입 = (M's `income` ?? the ledger's `income`) + Σ `in` entries.
- 쓴 돈 = Σ non-`in` entries + Σ unconfirmed charges dated ≤ T.
- 예정 = Σ unconfirmed charges dated > T + Σ plans with `month = M` that are neither done nor dropped.
- A plan is **done** when any entry in any month note references it. Done state is never stored separately, so buying never needs a write to two notes.
- 쓸 수 있는 돈 = 수입 − 쓴 돈 − 예정.
- 하루 약 = 쓸 수 있는 돈 ÷ remaining days including today. It is shown for the current month only.

All date math runs only in TypeScript. PC and mobile already share `src/notes/*`. Native code never computes charges.

### 4.4 Limits (validated in Rust, Java and the UI)

| Item | Limit |
| --- | --- |
| Recurring items | ≤ 200; name ≤ 100 code points, memo ≤ 500 |
| Plans | ≤ 300; name ≤ 100, memo ≤ 500 |
| Entries per month | ≤ 500; name ≤ 100 |
| Amount | integer won, 0 ≤ x < 10¹² |
| Fallback body of ledger types | ≤ 24 KiB, truncated with "… N건 더" |
| Whole plaintext | ≤ 256 KiB (unchanged); the envelope stays under 600000 hex |

Size estimates, measured on a generated sample with UUID ids and the category reference removed:

- One entry is about 160 bytes of JSON with a short name.
- Worst case: 500 × (about 110 B + 100 Korean code points × 3 B) ≈ 205 KB, plus a 24 KiB body ≈ 230 KB, which is under 256 KiB.
- A typical month of 60–100 entries is about 10–17 KB.
- A ledger note with 30 recurring items and 50 plans is about 15 KB.

### 4.5 Text fallback body

Native code regenerates `body` on every save, as it already does for checklist and secret notes. Pre-ledger clients show it read-only. It deliberately contains no derived dates, so it never goes stale.

```text
# 가계부
월 수입 ₩2,300,000

## 고정·구독
- 넷플릭스 ₩17,000 · 매월 · 2026-01-03부터
- 닌텐도 온라인 ₩19,900 · 매년 · 2025-11-02부터 · 2026-11-02 만료

## 사고 싶은 것
- 러닝화 ₩89,000 · 2026-09
- 모니터암 ₩45,000 · 언젠가
```

A month note's body starts with `# 2026년 9월 기록 (41건)`, followed by one line per entry, newest first, for example `- 09-25 ₩9,500 점심 김치찌개` or `- 09-24 +₩18,000 택배 반품 환불`.

### 4.6 Merge rules

These extend notes-v2 §4 and the `rules` in `merge-vectors.json`.

A ledger merge **never produces a whole-note keep-both copy** unless the schema or type is the problem. For a month note, a whole-note copy would double every entry.

1. **Scalars:**
   - `income` collision → the remote value wins, like `color`.
   - `title` collision → the remote value wins. A lost rename is cheaper than a forked ledger.
   - `pinned`, `deleted`, `archived`, `createdAt` and `updatedAt` follow notes-v2.
   - `ledger` and `month` are immutable.
2. **Collections** (`recurring`, `planned`, `entries`) merge per id, applying the notes-v2 one-side rule to each field:
   - Added on either side → keep.
   - Deleted on one side and unchanged on the other → delete.
   - Deleted on one side and edited on the other → keep the edited item.
   - An `order` collision → the remote value wins.
3. **Field collision** (both sides changed the same field differently) → **fork the item**:
   - The remote version keeps the id. The local version is added with a new UUID and `"forkOf": "<id>"`.
   - Both are shown with a "두 기기에서 다르게 고침" marker and an 이것만 남기기 action on each. Choosing one deletes the other and clears `forkOf`.
   - Until the user resolves it, both count, so spending is over-stated rather than hidden, and the month shows "확인할 기록 N건".
4. **Missing base for a `ledger-month`:** use an empty month as the base. When two devices create the same month concurrently (same deterministic id), both sides' entries are unioned, which is correct because every entry id is unique.
5. `body` is excluded from the merge and regenerated. Unknown keys follow the existing one-side rule, with collisions going to the remote.
6. A merge result that breaks a limit keeps both copies (existing rule). Readers still union month notes that share `(ledger, month)` and dedupe entries by id, so nothing is double-counted.

### 4.7 Forward compatibility

- **Current v2 clients** (PC, and the APK from 0.8.15) open unknown types read-only with the fallback body. Pin, trash, archive and restore patch only those keys and keep every byte (notes-v2 §12). Their merge treats an unknown type as a conflict, which yields a keep-both copy only during the short mixed-version window.
- **Keys added later** are preserved per item by the existing unknown-key rules.
- **Search:** the Notes search matches the ledger title only. The ledger's 기록 section searches entry names and amounts in memory.

## 5. Rollout and size

No server release and no DB migration are needed. A short ADR should amend ADR-0035 to record the two note types, the fork-on-collision rule and the HMAC month ids.

Release order:

1. **PC first.** It ships the model, native code, UI and fixtures in one release, so Rust tests catch merge bugs before a device is involved. Until the tablet updates, it shows the ledger read-only, so entries should be added only on the PC.
2. **APK second**, with the model port and the touch UI.

Rough sizes, including tests:

| Component | Change | Size (lines) |
| --- | --- | --- |
| Shared TS `_tools/app/src/notes/ledger/` | Types and limits, won formatting and keypad parsing, `cycle.ts` (charges, clamp, monthly equivalent), `summary.ts` (month figures, done plans, dedupe, forks) | about 250 + 250 tests |
| Rust `src-tauri/src/library/notes/` (new `ledger.rs`), `notes.rs` | Types and validation, canonical key order, fallback bodies, fork and empty-base merge, draft passthrough, `notes_ledger_month_id` (`ring::hmac`) | about 350 + 250 tests |
| Fixtures `tests/fixtures/notes-v2/` | Ledger and month payload examples, `ledger-merge-vectors.json`, HMAC vector | about 150 |
| Android `NotesModel.java`, `NotesRepository.java`, bridge | Model and merge port, month-id op, same fixtures in `NotesModelTest` | about 350 |
| PC UI `src/notes/ledger/*`, `NotesView.tsx` | Two-pane view, entry row, recurring and plan editors, new-note entry, list preview, hidden months | about 400 |
| Mobile `mobile-client/NoteLedger*.tsx`, `ledger.css`, `Notes.tsx` | Overview, sections, keypad sheet, recurring and plan sheets, card, hidden months | about 550 |

**The total is about 2,500 lines including tests,** down from about 4,000 in the first draft (roughly −35–40%). Removing categories, category budgets, currency fields and estimates also removes one merge collection, two editors and the category chip grid. No new npm, Cargo or Gradle dependency is needed.

Order of work: the shared TS model and the fixtures first; then Rust and Java in parallel; then the PC and mobile UI.

## 6. Test plan

- **TS (vitest):**
  - Clamping the 31st into February, including leap years.
  - `every: 3` months.
  - Weekly charges across a month boundary.
  - `until` falling on a charge day (the charge is excluded).
  - A trial that ends before `start`.
  - A yearly item that falls inside or outside the month.
  - Rounding of the monthly equivalent.
  - A confirmed charge replaces the derived one; a 0-amount entry skips it.
  - An `in` entry adds to income.
  - Figures for past, current and future months.
  - A plan done across months, and a dropped plan.
  - Dedupe of the same entry across two month notes.
  - Counting of forked entries.
  - No income set → the fallback headline.
- **Rust:**
  - Limits and immutable fields.
  - Canonical serialization, and the fallback body including its truncation.
  - The shared merge vectors: an amount collision forks the entry, delete versus edit, empty-base union of a month.
  - The HMAC vector.
  - A two-device mock server where both devices add entries to a new month offline → one month note holding every entry, with no copies.
  - Unknown keys survive a round trip.
- **Java:** the same fixtures and HMAC vector, and cross-platform opening of payloads sealed on the other device.
- **UI:**
  - The keypad (000, ⌫, leading zeros, maximum digits).
  - 저장하고 하나 더, and the recent-name chips.
  - 샀어요 pre-fills the sheet and links the entry.
  - The PC entry row works with Tab and Enter only, including the `+` prefix.
  - Month notes stay out of the list, search, labels and counts.
  - A simulated older client renders the ledger read-only.
- **Native acceptance** (each is a separate evidence level):
  - PC `npm run tauri -- dev`.
  - Tablet APK: keypad sheet, no IME jump.
  - A real server round trip with an offline concurrent entry on both devices.
  - The 0.8.15 APK viewing a ledger read-only.
- **Data safety:** use a test vault or key. The real notes vault needs user approval.

## 7. User decisions (2026-09-25)

1. **Income, not budgets.** A default monthly income on the ledger note, which each month can override. One-off extra income and refunds are 들어온 돈 entries. There are no categories and no per-category budgets or bars; an entry is date + name + amount.
2. **Headline:** 이번 달 쓸 수 있는 돈 = this month's income − spent − remaining scheduled charges this month − this month's plans. Approved.
3. **Currency:** KRW only. Foreign-currency fields are removed.
4. **Location:** one 가계부 note in the Notes list, pinned automatically, with the months hidden inside it. Approved.

Deferred: rollover, installments, reminders before a charge, yearly report, a PIN lock like 암호 메모, multiple ledgers in the UI.

## 8. Evidence and gaps

- Read:
  - `AGENTS.md` and `DESIGN.md`.
  - The notes-v2 design and its fixtures.
  - `mobile-client/Notes.tsx` and `notes.css`; `src/notes/NotesView.tsx` and `notes.css`.
  - The server id pattern and the Rust notes limits (`notes/model.rs:11-21`).
  - `Cargo.toml` (`ring`, `sha2`).
  - `docs/prototypes/mobile-design-20260925/` for style: top bar B and 60 px navigation.
- The mockups were re-rendered after the simplification with headless Google Chrome at DPR 1 (800 × 1232 tablet, 1440 × 900 PC) and inspected, with the annotations moved off the content. The numbers are fictional but consistent: 2,300,000 − 1,612,500 − 124,890 = 562,610.
- Not verified:
  - Keypad feel and IME behaviour on the Tab S11.
  - The real viewport height (a 48 px inset is assumed).
  - The byte estimates, which come from a generated sample, not the Rust serializer.
