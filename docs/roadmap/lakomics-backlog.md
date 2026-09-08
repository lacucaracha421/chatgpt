# Lakomics Backlog

Living source of truth for Lakomics bugs, product work, cloud/mobile follow-ups, Collection/Works evolution, and long-term ideas.

The backlog was reconciled from the 2026-09-05 full repository audit and its document routing was refreshed on 2026-09-06 against:

- the real `C:\chatgpt` codebase and audited production-data findings;
- `docs/agents/mobile-consumption-ux.md`;
- `docs/agents/pc-design-reference.md`;
- `docs/agents/works-viewer-design.md`;
- current code, schemas, ADRs, `CONTEXT.md`, and `DESIGN.md`.

Current code and migrations remain authoritative for implemented behavior. Git history retains the old verbose completion notes; this file intentionally keeps completed work compact so stale historical text does not look executable.

2026-09-06 Collection follow-up: reconciled against commit `9a99ed5` and the
recorded checks from that implementation. This refresh covers Collection presentation,
ownership/release notifications, and the catalog bookmark filter fix; it is not a new
repository-wide or production-data audit. Unrelated Cloud/Mobile acceptance gates remain unchanged.

## Status legend

2026-09-07 refresh: reconciled current Mobile/extension work through `6524c4c`,
the Collection deployment/cover-repair evidence, and the user's confirmation that
extension 15.59 is activated and Arca downloads are faster. This is a documentation
refresh, not a new production audit or measured throughput benchmark.

- `IN PROGRESS`: currently being implemented
- `PARTIAL`: useful implementation exists, but a material acceptance condition is still missing
- `TODO`: planned executable work
- `VERIFY`: implementation exists but still needs explicit real-world verification
- `MERGE CANDIDATE`: real scope, but should be implemented as part of another listed batch rather than independently
- `HOLD`: intentionally deferred or gated long-term work
- `KEEP`: existing behavior is intentionally retained
- `DONE`: implemented and sufficiently verified
- `OBSOLETE`: superseded or incident-only work that should not be selected for implementation

## Repository-wide execution rules

- Preserve existing user data and provider bindings.
- Prefer additive, reversible changes over rewrites.
- Do not rerun the completed full Cloud Library backfill unless a separately approved recovery operation requires it.
- Do not replace `kdata.db` wholesale for catalog work.
- Do not use frontend-only filtering where count/pagination correctness belongs in the Rust/SQLite query boundary.
- Do not extend the browser-extension mobile prototype into the production Android architecture; native transport is the production destination.
- Do not build a second Collection renderer for Shelf/Display mode; it must consume the normal presentation contract.
- Do not copy GPL/AGPL reference source into Lakomics without an explicit license decision. Reimplement validated concepts.
- Before each implementation batch, re-check Git status/diff and establish ownership of concurrent working-tree changes.

---

# P0 — correctness and operational truth

## CLOUD-006 — Full library cloud replication for mobile

Status: `DONE` — user accepted closure on 2026-09-06.

The major feature is implemented and already proved against the real library:

- prepare -> upload -> commit replication exists;
- retries, reconciliation, incremental replication, mobile APIs, and media tickets exist;
- the completed real-library backfill must not be rerun by default;
- Galaxy Tab browsing from the server replica has been verified.

Accepted closure criteria (user confirmation; no new operational run in this update):

- a paused supervisor must never start a new queued replica cycle;
- the current pause guard and regression test must be executed and verified in the real app;
- an in-flight cycle may finish, but no next cycle may begin while paused;
- paused state must survive restart with pending work unchanged;
- Resume must process the existing queued work once without reseeding/full backfill.

The repository-audit candidate `CLOUD-008` is absorbed into this item. Do not create a second long-lived Cloud pause feature after this closes.

Acceptance:

- focused supervisor timer/control-state tests pass;
- real pause -> wait -> restart -> resume passes with a queued item;
- idle incremental replication still works automatically;
- user confirmation closes this item; do not rerun the full backfill.

## BUG-013 — Asset viewer opens are never recorded

Status: `DONE`
Original scheduling note (completed): P1 correctness prerequisite after CLOUD-006 closure.

Original pre-fix audit evidence (not current behavior):

- `recordAssetOpened` exists through gateway, Tauri, Rust, schema, and tests;
- production viewer code has no caller;
- the audited live `asset_activity` rows had exposure history but zero recorded opens.

Original goal (implemented session semantics are recorded below):

- record one open per active asset transition in the full Asset Viewer;
- count initial viewer entry and next/previous/sibling navigation;
- do not count hover, selection, thumbnail visibility, preload, or Inspector-only interaction;
- deduplicate StrictMode/rerenders within one uninterrupted viewer session;
- close/reopen of the same asset is a new deliberate open;
- telemetry failure must never block viewer rendering.

No migration is required. Do not fabricate historical open data.

Implemented evidence:

- the full Asset Viewer records initial entry and active-asset navigation through the existing activity gateway;
- a viewer-session asset-ID set prevents rerender/StrictMode duplicates and resets on close;
- rejected or synchronously failing telemetry is isolated from viewer rendering;
- focused frontend coverage includes selection/non-viewer exclusion, previous/next and source-group navigation, close/reopen, StrictMode, and telemetry failure.

This is a prerequisite for activity-based `STATS-001B` and `IDEA-001` scoring.

## CLOUD-UI-001 — Durable Cloud status, diagnostics, and problem surface

Status: `VERIFY`

Already present:

- Cloud enablement/base URL/token status;
- connection test;
- manual inbound sync;
- recovery/backfill controls;
- transient manual result summaries.

Implemented status boundary (schema v38 onward, retained and extended):

- durable last attempt;
- durable last success independent of later failure;
- sanitized last error;
- persisted last processed summary;
- current combined actionable problem count;
- conditional `동기화 문제 N` navigation into the existing Cloud Settings/recovery surface.

2026-09-06 implementation: the existing `cloud_activity` persistence already records
attempt/success/error/processed summaries per direction and metadata publishing. The
new sidebar indicator consumes the existing supervisor event stream, with one initial
read and no additional timer. It counts current failed queue items plus independent
capture/metadata errors; a replication error is not added again when failed assets
already represent it. Settings explains that count and links to existing recovery
controls. Public queue errors are fixed messages and resolved queue entries no longer
appear as current errors. Native acceptance of this new indicator remains separate
from the user-accepted CLOUD-006 pause behavior.

Verification: focused UI status/count/navigation tests and the Rust queue-error
redaction/resolution test passed. The new indicator has not been exercised in the
native app; use existing data/status and do not seed a new backfill for verification.

Direction:

- extend the existing local settings/status boundary rather than create a second diagnostics service;
- persist only sanitized public errors, never tokens, signed URLs, object keys, or local paths;
- reuse the existing supervisor polling cadence rather than add another timer.

Prerequisite: close the CLOUD-006 pause semantics first.

---

# P1 — Online Manga Catalog lane

## CATALOG-002A — Provider-aware identity contract

Parent item: legacy `CATALOG-002`
Status: `DONE`

Goal:

- make every public catalog identity explicitly `(provider, provider_work_id)` before persistent grouping or a second provider;
- keep the existing VCK/kHentai catalog database and numeric IDs unchanged internally;
- preserve existing bookmarks and reading progress, which are already provider-namespaced;
- legacy state without provider defaults to kHentai;
- do not introduce a generic plugin system.

This is the prerequisite for provider-safe groups and Heliotrope coexistence.

Completed evidence (2026-09-05):

- public Rust/TypeScript catalog work, detail, gallery, bookmark, progress, command, and thumbnail contracts now carry `(provider, providerWorkId)` explicitly;
- legacy search payloads without `provider` deserialize as `kHentai`, while the existing numeric VCK database IDs and provider-namespaced bookmark/progress rows remain unchanged;
- React keys and pending/open state use a composite provider-qualified key, with regression coverage proving equal provider work IDs do not collide;
- the `heliotrope` namespace is recognized for durable identity isolation, but search/detail/read paths fail closed without enabling Heliotrope network integration or migration.

## CATALOG-003 — Independent Japanese-language source

Status: `DONE`

Implemented and fixture-verified:

- typed Korean/Japanese ingestion on the existing authenticated VPS transport, with Korean legacy default and a Japanese response acknowledgement;
- provider/language-qualified `CrawlState` checkpoints and status, Korean legacy migration, independent resumable cursors, and a zero-boundary Japanese initial pass;
- atomic work/tag/checkpoint page commits, low-ID Japanese upserts, replay/rollback coverage, and canonical cross-language membership preservation;
- separate Settings progress/error/recovery, Japanese-only checkpoint reset, bounded manual initial pages, and automatic incremental updates only after initial completion;
- Korean default browsing and existing search/visibility/performance behavior preserved; no schema/index change or catalog replacement.

Operational gate verified: the production VPS language contract and Japanese
acknowledgement passed. The bounded real-source canary passed with exactly two
pages / 100 Japanese works on a verified SQLite backup's disposable copy,
including ID 4169846 below the prior global/Korean maximum 4169932. Independent
checkpoint progression, reopen/resume, replay idempotence, unchanged Korean
state, and both language memberships on 16 overlapping works were verified.
Post-canary SQLite quick-check passed and the original catalog SHA-256 was
unchanged. No active-catalog ingestion or broad initial crawl was run.
See [catalog troubleshooting](../agents/catalog-troubleshooting.md#bounded-real-source-canary-deployment-gate)
for the exact procedure and retained-backup requirement before active-catalog mutation.

Prerequisite: CATALOG-002A.

## CATALOG-004 — Advanced VCK-style query language + result hydration fix

Status: `DONE`

Before this completed batch, the implementation supported plain title text and one exact `namespace:value` form. The implemented result is recorded below; this is not pending work.

Target grammar is deliberately bounded:

- plain and quoted title terms;
- `namespace:value`;
- unary `-` / `NOT`;
- explicit `AND` / `OR`;
- parentheses;
- implicit AND between adjacent primaries;
- `id:<value>`;
- `category:<alias-or-code>`;
- `uploader:<value>`;
- `pages`, `pages>`, `pages>=`, `pages<`, `pages<=`.

Implementation:

- small Rust tokenizer/parser/AST/compiler adjacent to the current catalog query code;
- precedence: NOT > AND/implicit AND > OR;
- bound parameters only; user values are never interpolated into SQL;
- keep provider, language, expunged, category policy, and blocked-tag policy outside user syntax as mandatory/default predicates;
- structured syntax errors must preserve the previous valid result set in the UI.

Performance scope folded into this item:

- replace current per-result artist/series `tags_for()` calls with one bounded bulk tag hydration query for the page;
- this absorbs the audit candidate `PERF-004`; do not create a separate performance project for the same query surface;
- measure before adding FTS5 or temporary hit tables.

Completed evidence (2026-09-05):

- a bounded Rust tokenizer/parser/AST/compiler now supports title and quoted terms, exact namespace predicates, unary negation, explicit and implicit Boolean operators, parentheses, typed ID/category/uploader predicates, and page-count comparisons with source-positioned syntax errors;
- every user value is compiled to a SQLite bound parameter, including escaped title wildcard patterns, while provider, optional language scope, bookmark scope, and mandatory expunged policy remain outside the user expression;
- result artist/series hydration is one bulk query for a non-empty page (zero for an empty page), replacing the former per-result `2N` lookup path with parity coverage through the 100-result page limit;
- the desktop keeps the previous valid result set when a structured `catalog_query_syntax` error arrives and still ignores stale search responses;
- the representative 100-result fixture query, including bulk hydration, measured approximately 5–6 ms in the recorded debug test runs; no FTS5 or temporary hit tables were added.

Prerequisite: CATALOG-002A. CATALOG-003 may proceed independently after that contract.

## CATALOG-005 + CATALOG-006 — Catalog visibility/block policy

Status: `DONE`
Completed as one implementation batch after CATALOG-004; the retained requirements below are not a new execution request.

One persistent policy must cover:

- hidden categories;
- exact blocked `(namespace, value)` tags;
- temporary `reveal blocked` override;
- one Settings management surface;
- identical predicates in result and count queries;
- future group representatives chosen only from visible members.

Persistence belongs in additive `library.sqlite` preference tables so existing metadata backup/restore protects it.

Do not implement either feature as post-pagination React filtering.

Completed evidence (2026-09-05):

- schema v34 adds global hidden-category and exact `(namespace, value)` blocked-tag preference tables in `library.sqlite`; a full v33 fixture migration preserves existing catalog bookmark data;
- one reusable Rust visibility predicate is composed into the shared result/count `WHERE` clause, while `revealBlocked` removes only that predicate and leaves provider, language, bookmark, expunged, and user-query constraints intact;
- Settings manages persistent categories and exact tags with load retry, and the catalog's temporary reveal control re-queries page zero without React post-pagination filtering; reopening the catalog reloads policy-filtered counts;
- verification passed 38 focused Rust tests, 77 focused frontend tests, all 682 frontend tests, TypeScript typecheck, and the production frontend build.

## CATALOG-007A — Strong-lineage duplicate groups

Parent item: legacy `CATALOG-007`
Status: `DONE`

Strong-lineage grouping is now end-to-end. Conservative provider-safe lineage
materialization, durable group handles/preferences, source-revision tracking, exact
group cardinality/pagination, six eagerly prepared default counts, bounded exact
COUNT routing, streamed grouped API delivery, lazy editions, and manual/automatic
representative selection are implemented. The earlier grouped COUNT blocker was
closed with real-data measurements and the final native Tauri acceptance passed on
an isolated library/profile: 105 fixture works produced exactly two cards (one
singleton plus one 104-edition lineage group), editions loaded 40 → 80 → 104, and a
manual representative persisted across dialog reopen before automatic selection was
restored. The active production library was not opened or migrated for this check.
See [final COUNT and native acceptance evidence](../operations/catalog-hybrid-count-gate.md);
the earlier [stopped performance gate](../operations/catalog-lineage-performance-gate.md)
is retained as historical evidence.

Goal:

- materialize only high-confidence provider-safe lineage groups first;
- result cardinality and pagination operate on groups/singletons, not raw rows folded in React;
- return representative + stable group ID + version count;
- every edition remains accessible;
- no provider work is deleted or irreversibly merged.

Representative ranking must consider:

- manual representative when present;
- preferred language;
- current visibility/block policy;
- completeness/thumb availability;
- deterministic lineage/current-edition signal;
- deterministic tie-break.

Prerequisites: CATALOG-002A, CATALOG-003, CATALOG-004, CATALOG-005/006.

## CATALOG-007B — Reviewed heuristic duplicate groups

Status: `DONE` — accepted by the user on 2026-09-06 after hands-on testing.
Implementation/native checks passed. The user explicitly waived the remaining
incident-audit gate; the unavailable pre-incident provider DB/checkpoint baseline
remains an evidence limitation, not a completion blocker. No recovery was performed.
Prerequisite: CATALOG-007A.

Implemented in the working tree:

- Schema **37** adds `online_catalog_review_candidates` (replaceable) and
  `online_catalog_review_decisions` (authoritative) in library.sqlite. Both use
  ordered pairs of existing kHentai provider-work anchors from 007A; no new UUID
  identity system, canonical provider writes, or foreign keys to replaceable data.
- Manual canary generation reads at most the latest **500 IDs** using the Works
  primary key. Eligible active works require an exact whitespace/case-normalized
  title or Japanese-title match of at least eight characters, shared exact
  artist/group tag, identical nonempty language sets, equal positive page counts,
  and equal known category. Punctuation, numbers and edition qualifiers remain.
  Title alone cannot create a candidate or a grouping relationship.
- 2026-09-06 extension: a Korean alternate title appended with ` | ` may be
  excluded from the comparison key while retaining bracketed identity qualifiers.
  Only these non-exact title matches permit a positive page-count difference of
  at most two pages and 10% of the shorter work. The review reason discloses the
  difference; this neither merges automatically nor selects a newer edition.
  Seven focused Rust review tests passed, including the 32/34-page example and
  exclusions for differing event/franchise/edition, language and larger page gaps.
- Each work has at most two title keys, each bucket at most **8** works; larger
  buckets are skipped. At most **3,500** pair examinations, **50** stored candidates,
  and **65** fetched creator/language tags per work (overflow is ineligible).
  Tag hydration uses the existing WorkId/Namespace primary key. Generation reports
  inspected works, comparisons and skipped buckets; it is absent from search SQL.
- The first canary permits at most **500 manual decisions**. Decisions are never
  removed to make room. Confirmation is accepted only for a current pending
  candidate; source revision, group generation and candidate algorithm must match.
  The request also carries a digest of the displayed evidence/context; regeneration
  in another window cannot make an old review screen authorize a replacement pair.
  False positive is permanent in this surface; split replaces a confirmation with
  a permanent veto. Neither veto can be undone through an ordinary confirm call.
- Rebuild applies confirmations above indivisible strong-lineage components,
  then uses existing oldest-handle reconciliation. A veto inside a transitive
  heuristic component quarantines that entire heuristic component; its strong
  components remain intact. Confirmations conflicting with a veto fail atomically.
  Existing strong lineage takes precedence when the source itself later proves
  a rejected pair is lineage-related; the veto remains stored, not deleted.
- Decisions do not depend on algorithm/source versions and keep dormant anchors.
  Candidate refresh cannot overwrite them. Historical handles resolve through
  existing anchors after confirm/split. Provider identities, bookmarks, reading
  progress and manual representative preferences retain their original scope.
- Review Dialog uses shared UI, shows both evidence works/current group UUIDs,
  titles, creators, pages, languages, category, reason and decision state. Opening
  lists only; generating and deciding require explicit actions. Metadata includes
  hidden works, as disclosed in the dialog. Save refreshes grouped search; pending
  candidates from a previous group generation become non-actionable.
- Review writes rebuild membership transactionally and invalidate prepared counts
  through generation; eager preparation refreshes counts afterward. Review can
  incur a full membership rebuild; no new discovery work is added to ordinary
  grouped COUNT/page queries. Whole-catalog review latency is not benchmarked.

Verified on 2026-09-05 (base/HEAD `5206961d44c3531228814bc96ee42c28880e3c16`):

- `cargo test --manifest-path src-tauri/Cargo.toml --lib catalog_ -- --nocapture`
  from app: **156 passed / 9 opt-in ignored**, exit 0. Includes grouped search,
  COUNT, lineage, schema preservation and bounded synthetic performance fixtures.
- Final expanded `--lib catalog_review -- --nocapture`: **6 passed**, exit 0.
  Covers title-only exclusion, multisignal candidates, source/version changes,
  reopen, veto regeneration suppression, indirect conflicts, stable handles,
  retained provider-work state, bounded discovery and v36→37 preservation.
- `npx vitest run src/manga/CatalogReviewDialog.test.tsx
  src/manga/OnlineCatalogBrowser.test.tsx src/library/client.test.ts`:
  **44 passed**, exit 0. `npx tsc --noEmit`: exit 0 after final frontend edits.
  After adding displayed-evidence concurrency tokens, the affected client/review
  subset passed **15 tests** and TypeScript returned exit 0 again.
- Corrected native acceptance used `npm run tauri -- dev --config <isolated.json>
  --no-watch`, a distinct app identifier, explicit fresh WebView2 dataDirectory,
  and a disposable six-work library. The blank setup page and fixture library
  path were verified before use. Actual WebView2/Tauri IPC and rendered UI showed
  5 groups before/after generation (2 candidates, 4 comparisons); confirm changed
  this to 4 groups/3 editions with the old public UUID. False positive persisted.
  Full restart after fixture source/derived-algorithm invalidation retained both
  decisions. Split returned 5 groups and the original 2-edition lineage; refresh
  and another full restart retained split/rejection with zero pending candidates.
  Native grouped page and exact COUNT both returned 5. The fixture has no catalog
  transport credentials, so unrelated updater failure is outside this acceptance.
  Final token-contract native check added two disposable works: a stale review
  token was rejected with 7 groups unchanged; valid confirm/split returned 6→7
  groups, while previous split/rejection decisions remained authoritative.
- Scoped critical self-review (not independent) checked automatic merge entry
  points, stale decisions, transitive vetoes, identity reconciliation, bounds,
  search coupling and provider scope. No cross-provider/Heliotrope code was added.
  `git diff --check` passed. Existing catalog acceptance-document edits and
  concurrently changed Phosphor prototype files were preserved outside this task.

**Production-boundary incident — not an authorized rollout:** the first native
launch relied on APPDATA/LOCALAPPDATA/WEBVIEW2_USER_DATA_FOLDER overrides, which
did not isolate the existing Tauri profile. It automatically opened
`C:\New_lakomics_assets`, migrated library.sqlite **36→37**, rebuilt group generation
**2→3**, and logged **6 automatic cloud-backfill commits** before the process was
stopped. Read-only comparison against the automatic pre-migration snapshot found
identical complete rows in group membership, handles, representative preferences,
bookmarks and reading progress; there are **zero manual review decisions** in the
production library. This does not establish absence of other startup/job side
effects. The preserved backup is
`C:\New_lakomics_assets\backups\pre-migration-20260905-092612-v36-165ef5b1-02d2-4488-af18-1f856a71d5aa.sqlite`.
No rollback or further production write was attempted. Recovery/disposition
requires separate explicit authority; this incident prevents an unconditional
DONE claim. Later isolated acceptance does not erase it. Test app processes were
stopped; Git writes and deployment were not performed.

**Production incident audit, 2026-09-05:** see the
[complete comparison, startup checklist and evidence limits](../operations/catalog-007b-incident-audit.md).
The exact comparison used the v36 backup named above against current
`C:\New_lakomics_assets\library.sqlite`; all SQL ran on disposable immutable copies.
The original DBs/sidecars and complete library file inventory remained unchanged
between the audit snapshot and final filesystem fence (09:53:46–10:04:31 UTC).

- Full keyed comparison of the 40→42 table union found **no deleted rows and no
  changed pre-existing user-domain rows**. Schema differences are exactly the two
  schema37 tables, both empty. Collections, classification definitions, ordering,
  favorites/personal metadata, trash, Revisit and library/cloud settings match.
- All 131,213 group members/handles, representative preferences (empty), 251
  bookmarks and 35 reading-progress rows match. Generation2→3 changes the grouping
  algorithm prefix, not provider revision. Six prepared counts retain their values;
  all context hashes and independent read-only COUNT results match.
- The six logged backfill commits were **six newly imported cloud captures**
  (three images, three videos), not old pending local uploads. Exactly six assets,
  six classification relations, six acknowledged receipts, six synced revision-1
  queue rows and three ready video records were added. All six originals match
  stored SHA-256/size. Preserve these results; rollback would discard acknowledged
  captures. Four older pending trash-asset queue rows remain unchanged.
- Startup recovery, ordering, artwork, similarity, backup scheduling, trash,
  release-watch, capture, video, replication, catalog preparation/update and view
  caches were traced. Surviving incident files comprise the six originals, three
  image thumbnails, 37 video derivatives, ten catalog thumbnails, two DB files and
  the migration backup. All 8,220 prior originals and referenced video/artwork files
  are present. Remote classification/saved-X snapshot publication is also invoked
  by capture polling; its outcome is not proven by the local log.
- Before/current library and current catalog copies passed full SQLite integrity
  and foreign-key checks; group-anchor/oldest-handle checks passed. No recovery was
  performed or indicated by these local results. Existing isolated native evidence
  remains applicable; this audit changed no implementation and did not relaunch.
- **Remaining evidence gap:** kdata.db mtime is inside the incident and its Korean
  attempt timestamp advanced. The unchanged provider revision, old crawl/progress
  timestamps and update transaction code support start/status-only writes. The
  retained backup contains no kdata.db, so exact source rows and Korean/Japanese
  checkpoint deltas cannot be proved. No source corruption was found. The user
  explicitly waived this audit gate on 2026-09-06 and accepted completion; no
  further baseline search is required for this item. A complete
  pre-incident filesystem manifest is also unavailable for transient/unreferenced
  files; all surviving incident-window files are accounted for.

Deferred: broader/fuzzy rules, whole-catalog discovery, negative-decision reversal,
more than 500 decisions, cross-provider/Heliotrope grouping, and production rollout.

## CATALOG-002B — Optional Heliotrope coexistence

Parent item: legacy `CATALOG-002`
Status: `TODO`

Goal:

- add Heliotrope as a disabled-by-default second metadata provider behind the authenticated Japanese VPS;
- keep a separate provider cache;
- preserve VCK/kHentai as the default/current provider;
- never assume Heliotrope metadata implies Lakomics can resolve/read pages;
- if no verified page resolver exists, reading stays unavailable for that provider;
- provider disable/cache clear must not remove user bookmarks/progress.

Prerequisites: CATALOG-002A and CATALOG-007A; preferably complete reviewed grouping behavior first.

---

# P2 — Personal library features

## CHAR-UI-001 — Series / character navigation, registration, and review UX

Status: `IMPLEMENTED — NATIVE ACCEPTANCE PENDING` — user approved implementation on 2026-09-08. Shared headers, in-gallery character registration, fixed-character review, and shared asset context menus are implemented. Windows/Linux native interaction acceptance remains pending.

### User requirements

1. **Ordinary folders:** remove the unconditional `캐릭터 검토` beside the folder name. Move `시리즈로 등록` into that header location, using a compact icon or similarly concise control instead of the separate content-area button.
2. **Series folders:** restore the series name in the header. Move character registration and hero-image controls into the same header; shorten labels or use icons. Match existing shared controls, icon style, spacing, and states. Compact the `수집 후 자동 분류` control at the far right, preferably an icon. Replace the character tile's `분석 준비됨` subtitle with a check mark beside its name; retain explanations for not-ready/inactive states.
3. **Character folders:** remove the `시리즈로` button and `캐릭터 에셋` heading. Put the character name in the header, with a small image count immediately beside it. Source clarification: the current `시리즈로` button navigates to the parent series; it does not promote a character into a series. The requested removal still stands; preserve a natural navigation route to the parent.
4. **Character registration / editing:** remove the `관련 폴더` UI. Select the representative thumbnail and reference images directly from the existing series asset gallery instead of a separate picker window. Reuse its `전체 보기` / `미분류만 보기` interaction. Other characters' assets must not appear in either picker, including when changing the gallery filter. Account for both other characters' confirmed assets and reference images; an existing character's own images remain available when editing that character.
5. **Review entry / left area:** expose analysis/review entry only inside a character folder. Fix the vertical/wrapped `시리즈 폴더` label. Fix the review context, character settings, and other character-specific information to the character from which review was opened; remove redundant series/character selection.
6. **Review right area:** fix the review target to the current character. Remove `선택 캐릭터 분석` and other redundant selection-oriented controls. The approved concise `분석` action retains the underlying analysis/retry capability.
7. **Review filters:** consolidate the excessive `추천`, `미확정`, `다중 후보`, etc. sections. The approved grouping uses two main views and compact additional filters, retaining unresolved work and failures.
8. **Image decisions:** show only the current character's decision in the selected image panel. Use `승인` / `거절`; do not list decision controls for every registered character.
9. **Context menus:** remove `캐릭터 검토` from asset-repository context menus. Restore normal context-menu behavior in registered series folders. Menu disappearance is user-reported; native reproduction and the exact affected surface (asset versus gallery background) remain to be checked during implementation.

### Existing behavior to preserve

- A confidently recognized image captured into a root category can be assigned to its series and character automatically.
- One physical image may appear in several recognized characters' folders. Unknown companions do not block a recognized character; ambiguous identities for the same person stay for review.
- `거절` applies to the current image/character pair, not every character in that image. Approving or rejecting here must preserve other characters' existing decisions and memberships.
- Manual series analysis remains scoped to that series; simplifying the visible review context must not remove competing-character checks needed for safe automatic decisions.
- Keep comparison checkpoints, resumability, and global background-work visibility when rearranging controls. Do not interpret UI-only requests as authorization to erase existing folder links, decision history, or recognition settings.
- Preserve Windows and Linux behavior and the existing asset-gallery/context-menu contracts. No Mobile redesign is included in this item.

### Accepted design direction

- Use the same compact location header for ordinary, series, and character folders. Show the current name on the left, context actions beside it, and automation state at the far right. Avoid creating an additional toolbar row. A breadcrumb or existing back navigation can replace the removed `시리즈로` button.
- Treat icon-only automation as a stateful control: distinguish on/off, running, and failure using shape/badge as well as color. Keep short tooltips and accessible names; do not hide failures behind a permanently indistinguishable icon. Global progress/pause remains available outside character folders, while review entry remains inside them.
- Define the name-adjacent check as **reference setup ready**, not **all images analyzed / all classifications correct**. This prevents an apparently completed check while background work remains.
- Use an in-place selection mode with `대표 이미지 선택` or `기준 이미지 선택 2/5`, plus `완료` and `취소`. Preserve the registration draft, gallery position, and prior filter on exit. Thumbnail selection is single-select; reference selection shows its existing required count. Other characters' assets remain excluded even under `전체 보기`; make that restricted selection scope clear.
- Make the review presentation character-specific while retaining internal comparisons against other plausible characters. A small read-only ambiguity reason may be useful, without exposing other characters' approval buttons.
- Start with two prominent review views, `검토 대기` and `확정`. Group recommendation/ambiguous-candidate work under review waiting; expose `전체`, `일치 없음`, `분석 필요`, `거절`, and failures through a compact filter or status entry. Failures must retain a visible count and retry route. These names and grouping were approved for this implementation.
- Remove the redundant word `선택 캐릭터`; retain a concise `분석` or `다시 분석` action for existing images, changed references, and failed work. Automatic classification alone is not a substitute for recovery controls.

### Acceptance checklist

- Verify ordinary folder, series folder, and character folder headers side by side, including long names and narrow window widths.
- Verify registration draft preservation, thumbnail single-selection, reference selection count, cancellation, and scrolling without opening a second picker window.
- Verify other characters' images cannot reappear through `전체 보기`, pagination, refresh, or a concurrent classification while selecting references/thumbnail.
- In a shared Towa/Noel image, review opened from Towa displays only Towa's decision controls and cannot remove Noel's membership.
- Check both asset and background context menus in ordinary, series, and character folders; preserve ordinary actions and multi-selection behavior.
- Check preparation, automation on/off, running, paused, failed, and completed states; distinguish reference readiness from analysis completion.

### Implementation evidence (2026-09-08)

- Existing ViewToolbar, anchored panel, buttons, Heroicons, design tokens, and date-grouped masonry gallery are reused. Ordinary-folder registration is contributed into the existing header; series/character names and actions share that header. Portrait tiles remain 3:4 with a 220px minimum column.
- Representative/reference selection uses the existing gallery with Done/Cancel, retained draft/filter/scroll state, and a restricted browse scope. SQL excludes other characters' confirmed/reference images before pagination, including unsaved characters and All mode. Strict saves revalidate eligibility inside the write transaction; existing stored folder links are preserved.
- Review entry is character-only; two main views plus compact filters, current-character approval/rejection, analysis/recovery, history, and close controls remain. Internal automatic competing-character comparisons and global automation status remain intact.
- Targeted frontend suite: 86 tests passed (characters, asset browser/toolbar, shared ViewToolbar); TypeScript checked. Character Rust suite: 27 passed, 4 pre-existing ignored tests. Additional targeted selection checks cover strict reference and thumbnail rejection without changing the previous references.
- Isolated browser fixture exercised series/character headers, registry-to-gallery selection and cancellation, fixed-character evidence, asset/background context menus, and automatic on/off. Layout inspected at 1280px and 900px, including long character names, using the real shared components and synthetic media; no production library writes were used for this verification.
- Linux dev app was rebuilt and relaunched through `npm run tauri -- dev` after verification. Remaining acceptance: native Windows/Linux titlebar/window controls, real media/drag-and-drop and production background running/paused/error states. Browser evidence and successful startup do not establish those native behaviors.

## NOTE-001A — Revision-safe server Notes foundation

Parent item: legacy `NOTE-001`
Status: `DONE` — encrypted API deployed; live HTTPS checks and verified SQLite backup completed.

Notes are a separate everyday text domain, not Asset metadata.

Initial server model:

- client-generated stable ID;
- versioned AES-256-GCM envelope; title/body and tombstone encrypted on PC;
- monotonically increasing revision;
- created/updated timestamps;
- tombstone deletion;
- cursor-paginated list;
- versioned JSON export/recovery.

Updates/deletes require expected revision and return conflict instead of last-write-wins.

Reuse the existing authenticated Cloud API and server SQLite patterns. Ensure server DB backup/recovery exists before real notes become relied upon.

2026-09-07 implementation: `server/lakomics-api/notes.py` provides authenticated paginated GET and revision-checked/idempotent PUT. Server tests cover authentication, vault separation, opaque storage, pagination and conflict retries. [ADR-0035](../adr/0035-encrypted-personal-notes.md) records the user's separate recovery-key decision. Deployment completed after user approval. Verified server backup: `/home/linuxuser/lakomics-api/backups/notes-20260907T084216Z/lakomics.sqlite3`. Live HTTPS encrypted PUT/GET/decryption, retry, stale revision 409, missing-auth 401, existing Collections and service health passed. The isolated test note was removed by exact vault/ID.

## NOTE-001B — Desktop Notes section

Status: `PARTIAL` — desktop implementation and isolated checks; native acceptance pending.
Prerequisite: NOTE-001A.

Add a dedicated sidebar destination and list/editor with explicit unsaved/saving/saved/error/conflict states.

A conflict must offer a safe decision such as reload server copy or duplicate the local draft as a new note. React must never receive/store the Cloud bearer token.

2026-09-07 implementation: Notes below Revisit, list/editor, title/body search, pin, immediate encrypted local autosave, trash/restore, sync status, conflict-copy recovery, recovery-key setup and encrypted file backup/import. Schema 43 stores ciphertext and durable pending state; key stays in Windows Credential Store. Rust fixture tests cover wrong keys/tamper, local CAS, conflict preservation, atomic backup recovery and two-device encrypted exchange. Frontend tests cover in-flight edits, stale sync, save retry, editor flows, setup, navigation and close guards. Browser checks use an isolated in-memory UI fixture. Remaining: real Windows credential/dialog/close behavior, active-library migration approval, server backup and live sync acceptance. Mobile Notes is outside this PC task.

2026-09-07 deployment checkpoint: actual Windows Credential Store persistence across Library reopen, wrong-key rejection and cleanup passed an opt-in native test using a temporary library. Live server checks passed after approval. The pre-existing dev watcher had already applied schema 43 before that approval; the earlier no-production-change claim was incorrect. Its automatic v42 backup `pre-migration-20260907-080946-v42-9246ca7d-c8cc-48d9-a93b-3ddbb7dd1d2b.sqlite` passed quick_check. Current-state backup `before-notes-deployment-20260907-174041.sqlite` also passed. Active schema 43 quick_check is ok, with zero user Notes. Latest dev app is running. Remaining native UI acceptance: user key setup, file dialogs and close-during-edit through the actual Tauri window; native UI automation was unavailable.

## STATS-001 — Personal statistics

Status: `PARTIAL`

Split into two truthful phases.

### STATS-001A — Inventory Statistics

Status: `VERIFY`
No activity prerequisite.

Use current authoritative data for bounded aggregates such as:

- media-kind totals;
- collected counts by local month;
- top creators;
- current direct classification counts;
- favorites;
- reliable original/derivative storage totals.

Aggregate in Rust/SQL, not React, and make metric definitions visible.

Implemented 2026-09-06: Management -> Statistics shows normal-Asset totals,
favorites/unclassified counts, Collection total, local collection-month buckets (24),
top creators/direct classifications (10), and recorded original bytes. Explicit
derivative measurement snapshots at most 10,000 registered paths, releases the DB
lock, and reports measured/missing/partial totals. No full filesystem scan on entry.

### STATS-001B — Activity Statistics

Status: `VERIFY`
Prerequisites: BUG-013 and STATS-001A.

Add only recorded-era activity views, for example:

- most-opened assets/Collections;
- long-unseen items;
- recent bounded daily patterns.

Record Collection opens with the same deliberate-session semantics used for Asset opens. If daily rollups are needed, use bounded aggregate rows rather than unbounded raw history.

Always show the telemetry start date. Never infer past opens from file dates or exposure counts.

Implemented 2026-09-06: most-opened Assets/Collections, Assets not opened for at least
30 days, and recorded daily opens. v42 adds Collection activity, a start timestamp and
bounded daily triggers (90 retained dates; 30 displayed); existing counters are never
backfilled into dates. Legacy Asset cumulative telemetry start remains explicitly
unknown. Collection recording uses a per-detail-session set and isolates failures.

Verification for A/B: four focused Rust tests and four frontend tests passed, including
migration without fabricated history, trash exclusion, direct counts, session replay,
and optional storage measurement/retry. TypeScript passed. On 2026-09-06 the user
authorized v42 application: SQLite backup `before-statistics-v42-20260906-212711.sqlite`
was retained, quick-check passed, and all 43 pre-existing tables retained identical
row counts and data hashes before app startup. Collection/daily history starts empty;
no historical activity was fabricated. Feature-level native/visual acceptance remains open.

## IDEA-001 — More varied Revisit mixes

Status: `PARTIAL` — IDEA-001A scoring/feedback/cooldown is implemented; IDEA-001B theme expansion remains.

The creator/date/surprise foundation now consumes BUG-013 deliberate opens and recorded exposures.
Mobile Home's classification/date/creator discovery improvements remain separate from the PC theme work below.

### IDEA-001A — Scoring, feedback, and cooldown correctness

Status: `DONE` (2026-09-08)
Prerequisite: BUG-013.

- version the daily slate algorithm;
- apply hard recent-exposure cooldown then explicit fallback tiers;
- use days since open/exposure, counts, collected age, favorite where available, and saved preference weights;
- add a small `덜 보기` feedback affordance;
- keep one deterministic complete slate transaction per local date/revision.

Implemented evidence: Revisit v2 applies a 14-day exposure / 30-day open strict cooldown with
3-day / 7-day fallback before an open fallback, then scores age since open/exposure, counts,
collected age and favorite state. Recommendation-type feedback reduces bundle frequency and
creator feedback down-ranks that creator, both clamped at -5. Creator bundles now contain one
creator rather than a mixed pool. Existing v1 daily bundle IDs are regenerated once into the v2
algorithm while same-day v2 slates remain deterministic. Rust Revisit tests pass 10/10, the full Revisit frontend passes 13/13, and TypeScript passes. No production library was opened for this work.

### IDEA-001B — Theme expansion

Status: `TODO`
Prerequisite: IDEA-001A.

Candidate themes:

- favorite-seeded discovery only when favorites provide real evidence;
- bounded period nostalgia;
- recently collected but rarely opened;
- favorite + discovery only when favorites exist;
- cross-classification discovery;
- bounded collection-session/source-group rediscovery where durable grouping exists;
- Collection-level high-rated discovery only where Collection scores actually exist.

A theme label must match its actual selection logic. Missing data should omit/fallback rather than fabricate meaning.

---

## IDEA-002 — Asset date timeline exploration

Status: `HOLD`

User decision (2026-09-06): defer changes to Asset Repository scrolling. Of the explored alternatives, the date timeline was the most appealing, but its fit with Lakomics remains uncertain; this is not an approved implementation direction.

- Revisit a compact date timeline showing daily asset counts and allowing direct date jumps for large libraries.
- Preserve date grouping and the time caption beneath each asset; account for both sparse days and days containing many assets.
- Evaluate compatibility with the restrained NieR:Automata-inspired UI and existing browsing workflow before adopting it.
- Screen-by-screen paging and calendar drill-down were comparison ideas, not accepted requirements. Do not assume the proposed paging/timeline combination was approved.
- Keep current scrolling behavior until the user resumes this discussion.

---

# Similarity / media identity lane

Czkawka is a design/reference source only. Keep Lakomics' existing PDQ-based fingerprint and review semantics; do not replace them with Czkawka's image hash stack wholesale. `czkawka_core` is MIT-licensed, but any code reuse still requires an explicit dependency/license decision.

## SIMILARITY-002A — EXIF orientation normalization before PDQ

Status: `DONE` (2026-09-08)

- normalize decoded image orientation from EXIF before generating the existing full + 5% crop PDQ fingerprints;
- preserve the current quality gate, distance threshold, crop tolerance, and Similarity Review decisions;
- add fixtures proving equivalent rotated-by-metadata images converge without increasing unrelated-image false positives.

Implemented evidence: the existing `image` decoder now applies EXIF orientation before PDQ and
new ingestion thumbnails use the same orientation. Display dimensions follow the oriented image.
Schema 47 clears only JPEG/JPEG-extension/WebP PDQ state so the existing bounded indexer lazily
recomputes old orientation-capable hashes instead of mixing old and new hash semantics; PNG/GIF
state is left alone. The actual EXIF-6 JPEG fixture converges at the existing PDQ <=20 threshold,
and the v46->v47 migration fixture passes. Quality 50, distance 20, 5% crop fingerprints and
Similarity Review decisions were not widened. The final Rust library regression is 774 passed / 0 failed / 18 explicit ignored. Czkawka remains a design/reference source only.

## SIMILARITY-002B — PDQ geometric-invariance candidates

Status: `TODO`
Prerequisite: SIMILARITY-002A.

- detect mirror/flip and 90/180/270-degree transformed reposts while keeping canonical stored fingerprints unchanged where practical;
- prefer query-time/incoming-image transform hashes first so the existing library does not require an unconditional full reindex;
- keep aspect/quality gates and run the existing PDQ minimum-distance check as final verification;
- benchmark false positives on real Lakomics artwork before widening default matching behavior.

## SIMILARITY-003 — Similar-video fingerprinting and review

Status: `PARTIAL` — the bounded implementation slice is complete: explicit 2–100-video
temporal PDQ analysis, durable pause/resume, separate normal-video pair decisions and the
existing review surface's video pane are integrated. Full Rust regression is 769/769 passed,
and explicit native FFmpeg re-encode/resolution plus timeout/cancellation checks pass.
`PARTIAL` is retained for the representative real-video positive/hard-negative accuracy gate
and production-library/native product acceptance. See
[execution evidence](../research/video-similarity-execution-plan-20260908.md).

- extend the existing FFmpeg/video preparation foundation with bounded temporal frame sampling;
- use duration/window gates before expensive comparison;
- detect re-encode/resolution variants and evaluate trimmed/subclip, letterbox/crop, and watermark cases;
- reuse the existing Similarity Review decision surface rather than creating a second duplicate workflow;
- treat audio fingerprinting as a later optional signal, not a first-pass dependency.

## PERF-SIMILARITY — Metric index / BK-tree gate

Status: `HOLD`

The current linear PDQ scan is retained. A recorded release benchmark scanned 50,000 candidate rows in about 41 ms, so a BK-tree or equivalent metric index is not justified yet.

Reopen only when representative 100k+ / 250k+ library benchmarks or measured ingestion latency show the candidate scan is a material bottleneck. If adopted, index both stored full/crop PDQ hashes and deduplicate asset IDs before the existing exact policy checks.

---

# Mobile lane — Galaxy Tab production client

The approved consumption specification is `docs/agents/mobile-consumption-ux.md`.

The current browser/mobile-extension prototype remains a verified behavioral reference, not the preferred production destination.

## MOBILE-001 — Direct authenticated native Android shell

Status: `PARTIAL`

Installed APK 0.3.3 (10) implements direct authenticated browsing, Keystore credentials,
lifecycle/back handling, pending Capture previews and a shared 1 GiB media cache with
usage/clear controls. Galaxy Tab browsing is in use; the earlier no-install checkpoint
is superseded. Remaining scope: Android system Share quick-save, optional extension
update management, and full provider/lifecycle acceptance. The extension's device-local
temporary save is implemented (EXT-006 below); it is not a general Android Share receiver.

Goal:

- establish the production Android client boundary without extension injection or `chrome.storage`;
- direct authenticated server client;
- Android secure token storage;
- classifications/assets/Revisit/media-ticket API parity sufficient for read-only browsing;
- reusable cache/auth/request-cancellation foundation for consumption UI and DocumentsProvider.
- an optional Extension Manager inside the same APK, while keeping the browser extension and Mobile library as independent runtimes;
- the manager may check versions, obtain a fixed-ID signed CRX, and hand the user into Titanium for install/update;
- signed-CRX adoption is gated by real Galaxy Tab verification: stable extension ID, update-over-existing behavior, browser restart, device reboot, and post-reboot usability;
- do not require a Titanium/Chromium rebuild, do not assume an external APK can call Chromium internal extension APIs, and do not assume silent install;
- retain unpacked SAF loading as a development/fallback route if the packed-extension gate fails.
- accept Android share intents for images/videos/screenshots so a system screenshot can be sent directly into Lakomics;
- provide a lightweight quick-save sheet with recent classifications plus permanent-save vs temporary/one-use storage choices;
- treat direct in-app screen capture (for example via MediaProjection) as an optional later enhancement; the first pass should rely on the system screenshot + Share flow.
- read-only access to server-stored pending Capture previews so a mobile client can show newly saved media while the desktop is offline;
- keep pending Capture identity/state separate from canonical Cloud Library Asset identity/state;
- reuse the existing authenticated pending-list/download boundary or a minimal mobile-safe adapter rather than exposing R2 object keys or credentials;
- define deterministic reconciliation after desktop processing so a pending Capture can disappear or be replaced when the canonical library result becomes observable.

Pending Capture visibility is a presentation/preview feature, not early admission into the canonical library. The local Lakomics library remains authoritative. The server must not promote a Capture into a canonical Asset merely so mobile can display it.

Do not change the stable browser X Collector merely to support the native client.

## MOBILE-004 — Approved portrait-first consumption UX

Status: `PARTIAL`
Installed Home/Library supports full-aspect justified rows, three densities, continuous
cursor loading, progressive media viewing and retained state. Continue/이어보기 and
the idle scroll-hint section were removed at user request; sidebar buttons lead the
Home/Library controls, and the native app hides system bars. Home adds visited/daily
classifications and date/creator Revisit groups. User device use and visual acceptance
are recorded; systematic cold/warm timing, large-video reliability and the complete
gesture/lifecycle matrix remain open. Do not restart the initial Home implementation.
Prerequisite for production integration: MOBILE-001. Pure layout/state algorithms may be developed/tested earlier.

Initial destinations:

- Home;
- Library.

Home order:

1. dominant canonical Recent gallery using `{type: "recent"}`;
2. visited classifications and daily classification covers;
3. secondary date/creator Revisit that must not delay first useful Recent paint.

Do not restore Continue/이어보기 cards without a new user request.

Gallery requirements:

- justified rows preserving every item’s full intrinsic aspect ratio;
- ragged final row allowed;
- video uses the same geometry with a clear marker;
- Large / Balanced / Compact target-row-height modes;
- density preference persisted on device;
- reflow should preserve the visual anchor where practical;
- bounded pagination/DOM.

State continuity:

- keep the previous useful grid until the new view’s first page commits;
- ignore stale/superseded requests;
- restore route/view, density, viewer sequence, and scroll position when returning;
- on foreground/visibility return, Home/Recent re-entry, or explicit refresh, silently refresh the first useful page instead of requiring a full page reload;
- reconcile changed server state in place so newly replicated canonical Assets appear without blanking the current grid or losing the visual anchor;
- portrait classification navigation is a drawer/sheet; landscape may use a persistent sidebar.

Pending Capture preview:

- Home/Recent may compose server-stored pending Captures with canonical Cloud Library results so media saved while the PC is offline becomes visible promptly;
- pending items must carry an explicit lightweight state such as `처리 대기` and must never count as canonical Asset/classification membership;
- ordering may use the server-received/capture time, but canonical Asset ordering remains authoritative once desktop ingestion finishes;
- after desktop processing, `Added` should converge to the canonical Asset without showing both copies;
- confirmed `ExactDuplicate` must not remain as a second pending tile once the existing canonical Asset is known;
- `ReviewPending` remains non-canonical and should be surfaced as review-needed or kept out of the ordinary canonical Recent stream until resolved;
- mobile does not independently reimplement the desktop duplicate/similarity decision; before desktop processing, a pending Capture may still later prove to be a duplicate.

Viewer requirements:

- image/video initially fit completely inside the usable Galaxy Tab viewport;
- contain/letterbox rather than crop;
- image pinch zoom only; pan only after zoom beyond fitted scale;
- fitted horizontal gesture belongs to previous/next;
- native video controls remain usable and do not trigger gallery swipes.

Progressive loading:

- reuse the already rendered thumbnail immediately;
- request original in the background;
- decode original before in-place replacement;
- never blank a useful thumbnail while loading;
- original failure leaves thumbnail/poster with non-destructive retry;
- preload at most previous and next image originals, deduplicated by asset/variant;
- do not preload neighboring video originals.

Remaining exclusions (Collections shipped separately in MOBILE-005):

- Online Manga Catalog;
- classification editing/bulk management;
- a third `display.webp` derivative;
- server/mobile write-back.

Device gate: pass all documented Galaxy Tab S11 portrait checks first, then landscape, and measure cold/warm first visual, original replacement, adjacent navigation, and video first frame before adding another derivative.

## MOBILE-002 — Read-only Android DocumentsProvider

Status: `PARTIAL`
The main APK now contains both read-only DocumentsProvider and API33+ CloudMediaProvider,
with classification folders/albums, stable identities, complete metadata snapshots,
cancellation and a shared 1 GiB cache. Selected file transfers are bounded to 512 MiB.
The old PoC remains installed separately; it is not the sole Picker implementation.
Full SAF grants/multi-select/recipient/cancellation and provider restart acceptance remain
open. A local temporary image was read successfully through the test recipient, but a
later real attachment Photo Picker showed an empty '이 기기에서' list despite existing
MediaStore files. Diagnose the launch/filter/provider difference; do not treat the test
recipient result as proof for every website. Samsung Gallery > albums > all did show
임시보관 with three files.
Prerequisite: MOBILE-001. May proceed in parallel with MOBILE-004 after the native cache/auth boundary is stable.

Initial boundary:

- one read-only Lakomics root in Android system file picker;
- classification folders;
- stable asset document IDs;
- cached cursor metadata;
- thumbnail support;
- short-lived on-demand media-ticket download to app cache;
- cancellation/cleanup and `notifyChange` after refresh;
- no rename/move/delete/upload-on-close in the first version.

## MOBILE-005 — Read-only Collections on Android

Status: `DONE` — deployed, source-cover repair verified and Galaxy Tab presentation
accepted by the user on 2026-09-07. All 340 Collections have primary cover references;
2,332 volume/edition covers are published. APK 0.3.2 removed cover effects/black boxes
and duplicate volume captions; current installed APK is 0.3.3. Manga Catalog remains
separate work under MOBILE-006/007/008.

Goal: PC-off Collection browsing, with PC owning metadata/artwork and Android viewing only. Keep game package/hero, manga volume shelf and movie poster/backdrop distinctions. Preserve IDs, editions and manual Showcase ordering; do not import provider artwork into Assets or expose provider configuration/local paths.

- [x] Server (`server/lakomics-api/mobile_collections.py`, registration in `app.py`, focused isolated-DB tests): authenticated immutable artwork preparation, atomic complete Collection snapshot publication with compare-and-swap revision, paginated type/search/Showcase list, detail and short-lived artwork tickets. Unpublished, empty and failed states must differ. Old snapshot remains readable after failed publication.
- [x] PC (`app/src-tauri/src/cloud/collections.rs`, cloud client/command registration and targeted fixture tests): side-effect-free snapshot extraction from existing committed rows; no provider fetch, migration or lazy volume/artwork import. Omit local paths/raw bindings. Explicit publication uploads content-addressed artwork first, then complete metadata; interruption cannot publish an incomplete snapshot. Make the operation callable through an explicit PC control, not a new automatic polling loop.
- [x] Android/React (`android` native read allowlist/shared media cache, `app/mobile-client/Collections.tsx` and owning navigation): library/type/Showcase browsing, retained list state, cover-led detail and edition-aware volume appreciation; read-only controls only. Reuse PC presentation primitives where their runtime is compatible, otherwise match the existing material/geometry without importing Tauri/provider code.
- [x] Isolated server/PC fixtures, mobile navigation tests, TypeScript/build and browser layouts passed. Explicitly authorized deployment/publication and subsequent Galaxy Tab cover/volume viewing and user polish acceptance completed. Detailed historical checkpoints follow; their earlier pending gates are superseded by the final source-cover/device evidence.

Contract v1: GET `/v1/collections` accepts `type=game|manga|movie`, `q`, `showcase`, `limit<=48`, opaque `cursor`; replies `{ready,revision,publishedAt,items,nextCursor}`. GET `/v1/collections/{id}` replies `{revision,item}`. Public item uses the existing camelCase CollectionSummary display fields (without sourcePath), and detail adds camelCase volumes plus artwork descriptors `{id,kind,selected,thumbnailAvailable,originalAvailable}`. POST `/v1/collections/{id}/artworks/{artworkId}/media-ticket` takes `{variant:thumbnail|original}` and returns the existing Ticket shape. PC-only POST `/v1/collections/artworks/prepare` takes `{sha256,sizeBytes,contentType}`, returns `{objectKey,uploadUrl,requiredHeaders}` (null URL on an existing exact object). PC-only PUT `/v1/collections/replica` takes `{version:1,baseRevision:null|string,collections:[...]}`; private artwork variants are `{sha256,sizeBytes,contentType,objectKey}` under `work-artwork/mobile/<sha256>`. Server validates referenced objects before atomic publication and rejects stale baseRevision. No Android access to prepare/publish routes.

Verification checkpoint: 81 server tests (including 12 Collection cases), PC publisher
fixtures, PC TypeScript, 45 mobile tests, mobile TypeScript/Vite and Android build
passed. Native policy/cache/transfer and packaged asset/signature checks passed.
Browser fixtures covered type/list/detail/volume navigation at tablet and phone widths.
Final integration review was inline, not independent.

Deployment/publication was explicitly approved and completed. The first snapshot's
cover omissions were repaired in the later source-cover publication below; do not
repeat the first publication or treat its earlier device-pending note as current.
Current APK 0.3.3 retains the PC icon and user-accepted plain-cover/volume polish.
Source-cover repair completed (2026-09-07): publication revision `3b640e2627ad526d7b3a8764bca87adc6cc4f04796a9373881d5c3910a196898`; 340 works, 2,803 artwork records, 5,588 unique blobs (4,204 uploaded in this repair), 2,332 volume/edition covers. Full comparison with the preceding replica confirmed 261 recovered primary covers, all 79 existing selected covers retained, and every existing volume ID/number/edition/label/release field retained. Every current work and volume has a thumbnail reference. Type pagination had 181 game, 147 manga and 12 movie records with no duplicate IDs; representative original and thumbnail downloads passed SHA-256 checks. Service active/running, NRestarts=0. Galaxy Tab SM-X730 running installed APK 0.3.1 was woken and refreshed: the game grid loaded covers and a previously missing manga (Prison School) displayed its primary cover and ordered 28-volume shelf. No APK rebuild/install was needed. The operation opened the source DB READ_ONLY and wrote previews only to TEMP. Prior replica backup: `/home/linuxuser/lakomics-api/backups/collections-before-source-20260907T053812Z.json`. An interrupted preparation attempt left its TEMP preview directory; manual cleanup was blocked by automatic approval policy, and no workaround deletion was attempted. The successful attempt retained normal TempDir lifecycle cleanup.

## MOBILE-006 — Shared Manga Catalog browsing

Status: `PARTIAL`; shared catalog browsing and the v2 performance/Reader server slice are
deployed. The current publication was upgraded in place to the v2 projection with unchanged
revision; production default search is now prepared server-side and the authenticated Reader
returns ordered validated page manifests. Android 0.4.3 uses a fullscreen one-page reader with
horizontal page navigation, screen-fit rendering, 1x–5x pinch zoom and bounded drag while
retaining device-local position, ±2 page prefetch, one-shot expired-manifest refresh and shared
native cover/page caching. Reader chrome appears only on a short tap. Selecting bookmark scope
forces Latest sort. Server evidence includes 16 Python catalog/replica tests, production-scale
timing and a real k-hentai/siam-cdn Reader canary. `PARTIAL` remains only for APK 0.4.3 Galaxy
Tab install and native reader/cold-warm acceptance.

User scope: PC-style catalog design with minimal editing. Search preserves provider/work
identity, language scope, blocked tags/categories and confirmed edition groups. The legacy
upstream proxy is not the shared search contract. Reader is read-only; offline full-gallery
download and cross-device reading progress remain deferred.

## MOBILE-007 — Catalog bookmark changes across devices

Status: `TODO`; follows the catalog read contract. Add/remove bookmarks from Android with stable `(provider, providerWorkId)` identity, idempotent operation IDs, durable retry and an explicit conflict rule. Preserve PC local authority from ADR-0033; define remote change receipt/PC application acknowledgements before enabling writes. Do not implement toggles that can invert twice after retries, or let a stale PC snapshot erase accepted mobile changes. Test offline/reconnect, duplicate requests, deletion tombstones and concurrent PC/mobile changes.

## MOBILE-008 — Catalog update requests and status

Status: `TODO`. Android can request a catalog DB refresh and see queued/running/completed/failed state, last successful update and errors while continuing to read the prior index. Bound and deduplicate jobs; persist crash/retry state. Resolve the relationship between the existing PC updater and server-side update worker before deployment, keeping the same catalog identity/grouping rules. The proposed target is server-side refresh available with PC off; if this needs a materially different authority/runtime arrangement, discuss that decision with the user. User data/bookmarks must survive catalog replacement. Operating a worker, deploying services and first production ingestion require explicit approval after implementation and isolated tests.

## MOBILE-003 — Safe global deletion / tombstone protocol

Status: `HOLD`
Risk: HIGH.
Prerequisite: native client plus explicit conflict/acknowledgement design; preferably after MOBILE-004/MOBILE-002 are stable read-only consumers.

Never propagate immediate deletion by default across PC, server, R2, mobile cache, and potentially offline clients.

Required concepts before implementation:

- tombstone;
- grace period;
- client acknowledgement/reconciliation;
- explicit purge;
- conflict/recovery behavior.

---

# Extension follow-up — 2026-09-07

## EXT-005 — Deep list navigation and folder ordering

Status: `DONE`

Window/list mode traverses the actual hierarchy beyond levels 2/3/4/5, with deeper
surfaces becoming darker. The save-check pop animation is removed. Settings embeds
the real list and supports hold/drag ordering within siblings, automatic persistence,
rollback on failure and keyboard ordering. Model/DOM/worker tests and browser checks
passed. Actual Galaxy Tab long-press reorder ergonomics remain a follow-up observation;
do not confuse the verified temporary-save long press with a full reorder device test.

## EXT-006 — Device-only temporary image saving

Status: `DONE` — core save and local album path verified; recipient compatibility is
tracked by MOBILE-002 rather than closed by this status.

The separate green root-list action opens APK 0.3.3, downloads directly and publishes
to `Pictures/Lakomics/임시보관/` without server upload. Real Titanium handoff, complete
MediaStore write and a test recipient's 30,320-byte read passed. Samsung Gallery's
all-albums view shows the folder; it need not appear among selected major albums.
The current implementation intentionally opens a save-progress Activity. Removing
that transition was discussed as a UX improvement, not implemented or committed.

## EXT-007 — Arca JPEG download URL optimization

Status: `DONE` — user confirmed extension 15.59 activation and improved speed.

Only `https://arca.live/` pages use the bounded JPEG optimization for both temporary
and permanent saves. Known positive width <=1280 keeps the selected JPEG URL without
forcing orig; explicit original requests, unknown/large widths and other formats
retain their prior handling. ArcaRefresher attribution/MIT notice is included.
34 focused URL/controller tests passed. User-observed improvement is not a numerical
throughput benchmark or proof of byte/quality equivalence for every source image.

---

# Works / Collection presentation lane

Current PC visual baseline: `docs/agents/pc-design-reference.md`.
Stable type-specific Works intent: `docs/agents/works-viewer-design.md`.

The central principle is a shared Lakomics shell with type-specific viewing grammar:

- Manga = volume-centered personal shelf;
- Game = hero/package-centered work exhibit;
- Video = poster-centered archive; series expand into seasons/episodes;
- Showcase = a higher-appreciation view using the same primitives, not a separate renderer.

Artwork > work identity > personal state > useful provider metadata > provider/maintenance controls.

## LONG-002A — Type-aware presentation foundation and normal Works visual pass

Parent item: legacy `LONG-002`
Status: `DONE` — user accepted the Collection finishing checks on 2026-09-06.
Legacy LONG-002 remains `PARTIAL` only for the separate later focused-cover/Display
scope. Normal type-specific presentation and its user visual acceptance are complete.

2026-09-05 first reskin slice: Quiet Archive typography/fallback and Works depth tokens,
flat Collection captions, Manga cover baselines/shared support lines and below-cover release
captions, conditional edition controls, and Game hero/package calibration are implemented.
Existing CollectionOverlay/CollectionCard/GameCollectionDetail tests: 51 passed; TypeScript
check passed. Isolated browser fixtures covered mixed cover ratios, 20 volumes, multiple/single
editions, long Korean/Japanese titles, keyboard focus, and sparse Game art at 960/800px widths.
Native Tauri visual acceptance for that first slice was unverified; no active production
library was opened or mutated for that check. The later implementation below supersedes
its pending Game composition and type-specific tile wording.

Implemented follow-up (2026-09-06, `9a99ed5`):

- Game case dimensions follow the cover aspect ratio with bounded scaling, preserving
  the full image without exposed empty case areas; Manga shelf content wraps within
  the available width; Film posters use a transparent surround.
- Artwork candidates and galleries preserve portrait images. Only the candidate image
  row scrolls horizontally; selection/navigation actions stay in the dialog width.
- IGDB hero choices include both artworks and screenshots, with smaller candidate
  thumbnails; TMDB candidate thumbnails are also smaller. Live provider latency is
  not guaranteed by these changes.
- Collection cover/artwork viewers consume Back before leaving the work detail.
- Work information, editions, ownership, release status and management controls use
  the existing sidebar. Detail views omit the redundant work-type navigation; the
  library retains it. The notification button shares the search/add centerline.
- Game/Manga/Film cards show release dates below creator/company, formatted `YY.M.D`
  with a full-year fallback. Film metadata selects the earliest available TMDB release
  date; this does not imply every previously saved work has been refreshed.
- Existing `CollectionCard`, physical cover and artwork gallery components provide
  the type-specific presentation; do not add a second renderer just to introduce the
  planned `WorkTile`/`ArtworkStrip` names.

Verification: focused frontend/Rust checks and TypeScript passed during implementation.
The latest spacing-only adjustment was not agent browser-tested. The user accepted
clipping, portrait artwork, sidebar density and Back behavior on 2026-09-06;
this is user acceptance, not a new automated/native test run. Film/Series expansion remains WORKS-001, and
complete-cover interaction remains LONG-002B.

Shared presentation primitives should remain lightweight and type-aware:

- type-aware `WorkTile`;
- thin book/package presentation primitive where reuse is real;
- `ArtworkStrip`;
- `RelatedWorksRail`;
- `MetadataLine`;
- a small `collectionType -> presentation preset` mapping.

Ordinary grids prefer DOM/CSS and bounded static rendering. The approved closed game case may keep the current bounded 2D projection/canvas path for edge quality; this is not permission to introduce Three.js/WebGL or continuous pointer tracking.

### LONG-002A.1 — Manga Shelf Grid quality baseline

Implemented baseline; use the retained criteria below for final visual acceptance.

Normal manga detail:

- replace independent `CollectionVolumeGrid` tiles with an open shelf presentation;
- shelf is only a horizontal support/contact cue, not simulated furniture;
- cover front remains roughly 90–95% of perceived object;
- minimal book/page-edge depth;
- shared baseline and subtle contact shadow;
- routine state moves below/around the cover rather than obscuring artwork;
- hide edition controls when only one edition exists;
- prefer meaningful edition names over numbered implementation drawers;
- clicking a volume prioritizes cover appreciation with ordered previous/next.

This manga shelf is part of the normal type-specific detail preset. It is **not** the later LONG-004 global Display/Shelf mode.

### LONG-002A.2 — Game Exhibit refinement

The hero/package composition and artwork improvements above are implemented. Use the
following criteria for final refinement, rather than restarting the visual pass:

- reduce excessive hero vertical dominance so lower content enters the viewport earlier;
- make hero, package, title, and identity one coherent composition;
- use compact sentence-like metadata instead of field-box rhythm;
- personal rating outranks provider state/external scores;
- `ArtworkStrip` adapts gracefully to 1, 2, 3, or many screenshots instead of leaving a dead lower half;
- move `작품 관리` toward quiet overflow chrome;
- richer IGDB data is added only when it becomes structural UI such as release history, franchise/related works, or useful artwork.

### LONG-002A.3 — Type-specific Collection library `WorkTile`

Preserve the current Chrome 03b contextual shell and its icon-first search/settings behavior; do not recreate the retired horizontal toolbar.

At a glance:

- Game reads as a shallow package collection;
- Manga reads as shallow books/shelf library;
- Video reads as a flat poster archive.

Reduce redundant body headings when the contextual index/current location already communicates Collection -> Library/Showcase -> type, allowing artwork to begin sooner.

Do not turn the normal library into a decorative showcase.

## WORKS-002 — Simple manga ownership and Korean release notifications

Status: `DONE` — user accepted the Collection finishing checks on 2026-09-06.

Implemented (2026-09-06, `9a99ed5`):

- One current-owned count per edition; saving N records ownership of volumes 1..N.
  Physical/digital choices are absent from the UI. Schema v41 retains compatible
  volume ownership storage; decreasing the count, including zero, is atomic.
- Show latest released volume, missing count and next scheduled volume/date.
  Upcoming volumes are excluded from missing count; unavailable dates stay unknown.
- Korean publication tracking uses the connected Kakao series and an enabled release
  subscription. App startup/hourly checks query works due after 24 hours; this is
  app-running polling, not an OS push notification service.
- New provider volumes (including scheduled ones), date changes and scheduled-to-released
  transitions create persistent events. Opening a work does not acknowledge them;
  explicit confirmation clears the selected events.
- A grid cover badge, total inbox count and in-app discovery message expose unread
  events. Badge numbers count events, not distinct new volumes or missing volumes.
- Ownership only changes the missing count; it does not suppress release events.

Verification already recorded: TypeScript, three focused frontend tests and four Rust
tracking tests passed. The authorized v40 -> v41 active-library migration passed
SQLite quick-check with existing collection, volume, bookmark and release-event rows
preserved. This is migration evidence, not proof of real future-provider detection.

The user accepted the remaining Collection finishing checks on 2026-09-06. No new
native/provider test was run to mark this status. No reseeding or production-data
mutation is authorized by this item.

Known boundaries: Kakao must publish the information; MangaDex-only connections cannot
detect Korean releases. Publisher changes may create a separate series and are deliberately
deferred by the user. Publisher-announcement crawling, OS notifications and off-app polling
are not implemented or implicitly approved follow-up scope.

## WORKS-001 — Video Works: film + series / TV animation

Status: `PARTIAL`

The Collection persistence type remains `movie`, while TMDB now supports both Film
and TV Series. Numeric movie bindings stay unchanged; TV uses `tv:ID`, so the same
numeric provider ID cannot collide across media types.

Film poster, artwork browsing, sidebar and earliest-release-date improvements shipped
in `9a99ed5`. The following 2026-09-06 TV extension is implemented in the working tree:

- Film/Series search selector with lightweight metadata/artwork preview;
- explicit apply/refresh caches all returned season/episode metadata and season posters
  in the existing binding/artwork lifecycle; no new TV schema or background polling;
- local season poster selector, selected-season summary, paged compact episode list
  (50 rows), air dates/runtimes/descriptions and aggregate cast;
- existing metadata overrides and chosen poster/backdrop survive refresh; existing
  movie imports remain compatible and cached series details reopen offline.

Verification: 20 focused TMDB Rust tests and 33 matched frontend tests passed;
TypeScript passed. Native API/import and user visual acceptance remain unverified.
Full explicit TV import/refresh still fetches season endpoints/posters sequentially;
preview and artwork replacement do not wait for the full episode sync.

Remaining broader scope: provider related-work rails and richer Film cast/release-history
presentation. Episode still grids are not part of the default compact presentation.

Structural distinction:

- Film: one work, poster/backdrop, runtime, release history, cast/staff, related works;
- Series: work -> seasons -> episodes, season posters, selected-season summary, compact episode list, aggregate cast/staff;
- animation vs live action is an attribute/filter/presentation nuance, not the main structural type split;
- TV anime therefore uses the Series structure, while anime films use Film.

Provider/API direction:

- extend TMDB integration to TV search/detail, seasons, episodes, season images, and appropriate credits/relations;
- preserve current provider ownership/refresh rules and local usability when the network fails;
- cache only data needed for normal browsing;
- external/provider score remains visually secondary to personal state.

Video visual grammar:

- shared backdrop + poster hero;
- Film content sequence: identity -> overview -> cast/staff -> artwork -> release history -> related works -> personal state;
- Series content sequence: identity -> season poster grid -> selected season/episodes -> cast/staff -> artwork -> related works -> personal state;
- default episode presentation is compact, not a giant still grid.

Data-model/type migration should be decided only when the concrete Film/Series contract requires it. Do not rename `movie` merely for cosmetic consistency.

Dependency: use LONG-002A primitives/presets for final presentation; provider/data work can be developed in a reviewable adjacent batch.

## LONG-001 — AV typed Collections, people relations, and full cover sets

Status: `PARTIAL` — the manual-first implementation slice is complete: local AV Collection
type, independent person identities with ordered performer/director relations, and manual
front/spine/back artwork selection are integrated. Backup/restore, ownership and full Rust
regression pass, and the bundled Tauri app builds/opens without the dev server. `PARTIAL` is
retained for native file-picker/subjective visual acceptance, production-library migration,
and the later external-provider portion of the broader LONG-001 scope. AV is
excluded before artwork collection from the current Mobile Collections replica;
it remains part of ordinary metadata recovery and is not an encrypted vault.

Extend the existing Collection work model rather than create a parallel work system.

Required foundation:

- AV Collection type;
- normalized people + Collection-person role/order relations;
- explicit front/spine/back artwork roles using the existing Collection-owned artwork lifecycle;
- front-only remains valid;
- full surfaces unlock richer focused presentation;
- provider import uses preview/apply and never silently overwrites manual intent;
- AV metadata is not coupled to acquisition/download or Private Vault.

Prerequisite for full-cover interaction: LONG-002A should establish the presentation contract first.

## LONG-002B — Focused complete-cover interaction

Status: `PARTIAL` — the focused interaction implementation is complete: front/spine/back
snap and original-image view use actual registered AV cover surfaces and the existing case
renderer. Keyboard, missing-surface and privacy behavior are covered by the green 893-test
frontend suite, and the bundled Tauri app starts successfully. `PARTIAL` is retained for
subjective native visual acceptance with real user cover media. Initial stops change immediately without free-angle rotation; missing
artwork is never synthesized. See [execution evidence](../research/av-covers-execution-plan-20260908.md).
Prerequisites: LONG-002A and truthful front/spine/back surfaces from LONG-001.

- activate side/back interaction only in focused/detail contexts;
- front remains default;
- snap to predictable front/side/back stops;
- keyboard and reduced-motion support;
- missing surfaces fall back to front-only/neutral thickness;
- never invent a fake illustrated spine from unrelated artwork.

## LONG-004 — Optional Display / Shelf mode

Status: `MERGE CANDIDATE`

This remains real product scope, but it must not own a separate rendering system.

Implement only after LONG-002A is stable, as an opt-in view consuming the same presets, artwork roles, filters, and Showcase membership/order.

Potential views remain:

- bookshelf;
- DVD/video shelf;
- game package display;
- showcase cabinet.

Rules:

- normal productive grid remains available/default unless the user chooses otherwise;
- front artwork stays recognizable; shelf realism never forces spine-only browsing;
- bounded/virtualized rendering for larger sets;
- only view-mode preference persists, not transient object rotation;
- no room, furniture, lamp, wall, window, or heavy material simulation.

## LONG-003 — Private Vault

Status: `HOLD`
Risk: CRITICAL/HIGH.

This is an encrypted private-media program, not an extension of normal Trash or AV metadata.

Do not put real user media into a Vault format until all of the following are independently resolved and tested:

1. threat model and leakage budget;
2. key lifecycle + user-held recovery path;
3. versioned authenticated-encryption/object format;
4. nonce/associated-data rules and known-answer/tamper tests;
5. wrong-key and corruption health behavior;
6. encrypted metadata/thumbnails and plaintext-cache rules;
7. interrupted copy/upload/atomic commit semantics;
8. independent security review.

Initial adoption is copy-in only; original normal media remains intact. Video authenticated chunks are a later phase after metadata/image recovery is proven.

---

# Reconciled legacy status index — audit baseline

The 2026-09-05 repository audit classified the original 55 backlog items as **38 DONE, 8 PARTIAL, 4 TODO, 3 MERGE CANDIDATE, 2 OBSOLETE**. The active items above replace stale verbose wording; this index preserves the audit result.

## DONE

2026-09-06 follow-up (outside the original 55-item audit counts): catalog bookmark
entry now starts in Latest instead of retaining a restrictive day ranking. The
reported disappearance was filter visibility, not deleted bookmarks; the recorded
read-only inspection found 253 bookmarks intact. Focused catalog tests passed.

- CLOUD-001 — Cloud Capture batch drain
- CLOUD-004 — X media Cloud/VPS routing failure fallback corrected
- CLOUD-002 — Cloud inbound app integration
- CLOUD-005 — PC-independent saved-X-media snapshot
- BUG-001 — Collection entry error toast
- BUG-002 — Manga list scan failure from unsupported thumbnail
- BUG-004 — Video preview preparation reliability
- BUG-005 — Historical manga Collection entry error no longer reproducible
- VERIFY-001 — X -> VPS -> PC E2E verification
- UI-004 — Transition/preview flashing
- UI-007 — Video viewer controls
- BUG-003 — X drag-save native selection highlight
- BUG-006 — Sidebar counts after drag/drop move
- BUG-007 — Same-scope mutation scroll preservation
- NAV-001 — Shared back navigation
- UX-009 — Loading/error/retry/tooltip consistency
- UI-006 — Easier asset selection clearing
- UI-005 — Collection cover aspect/crop handling
- UI-001 — Similarity Review placement
- BUG-008 — Catalog viewer page-edge focus highlight
- BUG-009 — Video preview/selection conflict
- BUG-010 — Impossible future catalog dates
- BUG-011 — Drag-out re-entry import overlay
- UI-010 — Richer video previews
- BUG-012 — Stable custom overlay gallery scrollbar
- CATALOG-001 — Fragile catalog transport moved behind Japanese VPS
- MANGA-001 — Orphaned local manga recovery foundation and targeted cleanup
- UI-009 — VCK-inspired manga reader parity
- CLOUD-007 — Replica work recovery after video poster preparation
- EXT-001 — Extension settings reorganization
- EXT-002 — **Cloud-first** extension save policy (`Cloud -> PC -> browser download` where supported)
- EXT-003 — Same-X-post media grouping
- EXT-004 — Adaptive/hidden secondary donut tags
- PERF-001 — Current cache/media optimization policy
- PERF-003 — Collection artwork fast path
- PERF-002 — Intended per-scope view-state preservation
- OPS-001 — Backup/migration/settings portability
- UI-008 — Top-bar rework

## PARTIAL / TODO / MERGE CANDIDATE

These are detailed in active sections above:

- CATALOG-002 — provider-key foundation DONE; optional Heliotrope remains `TODO`
- CLOUD-UI-001 — `VERIFY`
- NOTE-001 — `TODO` split server/desktop
- STATS-001 — `PARTIAL` split inventory/activity
- IDEA-001 — `PARTIAL`; IDEA-001A `DONE`, IDEA-001B `TODO`
- LONG-001 — `PARTIAL` implementation complete; provider/native/product acceptance remains
- LONG-002 — LONG-002A `DONE`; LONG-002B `PARTIAL` only for native visual acceptance
- LONG-003 — `TODO` in audit, intentionally `HOLD` here until security gate is approved
- LONG-004 — `MERGE CANDIDATE` consuming LONG-002 renderer

Later completions superseding the audit: CLOUD-006, BUG-013, CATALOG-003/004/005/006,
CATALOG-007A/B, LONG-002A, WORKS-002, MOBILE-005 and EXT-005/006/007 are DONE.
MOBILE-001/002/004 remain PARTIAL for the specific remaining work in their sections.
MOBILE-006 has its read implementation complete and remains PARTIAL for rollout/device acceptance;
MOBILE-007/008 are the next catalog implementation sequence.

## OBSOLETE / incident-only

### UI-003 — Replace Asset Repository scrollbar with a native/standard scrollbar

Status: `OBSOLETE`

Superseded by the later runtime-verified BUG-012 solution: the accepted implementation is the custom overlay scrollbar with native scroll ownership and stable reserved range. Do not reintroduce the older native-only request.

### CLOUD-003 — Long-video asynchronous Capture handling

Status: `OBSOLETE`

No validated incident currently requires an async redesign. Keep the current bounded synchronous path and ambiguous-timeout confirmation behavior. Reopen only if a reproducible long-video timeout race produces real failures.

---

# Newly promoted scope from the reconciliation

The audit was read-only, so it recorded several candidates without mutating this backlog. This reconciliation promotes only independent, evidence-backed scope:

- BUG-013 — real Asset viewer open recording;
- MOBILE-001 — native authenticated Android shell;
- MOBILE-002 — read-only DocumentsProvider;
- MOBILE-003 — global deletion/tombstone protocol, held until safe;
- MOBILE-004 — approved Mobile consumption UX;
- WORKS-001 — Video Works Film/Series + TV animation expansion.

2026-09-07 user-promoted similarity follow-up:

- SIMILARITY-002A — EXIF orientation normalization before PDQ;
- SIMILARITY-002B — mirror/flip/rotation-aware PDQ candidate search;
- SIMILARITY-003 — similar-video fingerprinting on the existing FFmpeg foundation;
- PERF-SIMILARITY — BK-tree/metric-index optimization held behind measured scale/latency gates.

Candidates intentionally absorbed rather than added as standalone backlog:

- `CLOUD-008` -> CLOUD-006 pause closure;
- `PERF-004` -> CATALOG-004 query/hydration batch;
- `DOC-001` -> completed by this 2026-09-05 truth-alignment rewrite.

---

# Dependency-safe master execution roadmap

This is a dependency map, not a list of unfinished tasks: consult each active item status above and skip completed work. Historical audit-index statuses do not supersede later completion evidence.

This is the authoritative dependency order, not a prohibition on parallel work in independent subsystems. In particular, Collection presentation and pure Mobile layout/state work may proceed in parallel once worktree ownership is clear.

Completed prerequisites: CLOUD-006, BUG-013, CATALOG-002A/003/004/005/006/007A/007B,
LONG-002A and WORKS-002. Do not schedule them again.

Remaining work, grouped by dependency rather than one mandatory serial queue:

1. **CLOUD-UI-001 and STATS-001A/B — native acceptance** of already implemented UI.
2. **IDEA-001B — Revisit theme expansion.** IDEA-001A scoring/cooldown/feedback is DONE.
3. **NOTE-001A → NOTE-001B — revision-safe server Notes, then desktop Notes.**
4. **CATALOG-002B — optional Heliotrope coexistence.** Not a prerequisite for the
   existing-provider Mobile catalog lane.
5. **WORKS-001 — remaining related-work/richer Film presentation.** TV/season/episode
   structure already exists; do not restart that foundation.
6. **LONG-001 / LONG-002B acceptance → LONG-004 — AV relations/cover roles and focused
   full-cover interaction are implemented; finish real-media/native acceptance before optional
   Display mode using the same renderer.**
7. **LONG-003 — HOLD:** threat model/format/recovery approval before encrypted
   metadata/images, recovery/key rotation and later video chunks.

## Separately promoted Similarity order

S1. **SIMILARITY-002A EXIF orientation normalization — DONE**
- schema 47 safely reindexes orientation-capable stored hashes; current PDQ and review thresholds are preserved.

S2. **SIMILARITY-002B geometric-invariance candidates**
- after S1; validate false positives on real artwork before enabling broadly.

S3. **SIMILARITY-003 similar-video fingerprinting — implementation complete / accuracy gate open**
- bounded analysis and Similarity Review integration are implemented; next work is representative
  real-video calibration/holdout validation rather than another architecture prototype.

S4. **PERF-SIMILARITY BK-tree / metric index**
- HOLD until measured 100k+ / 250k+ scale or ingestion latency justifies it.

## Separately promoted Mobile production order

M1. **MOBILE-002 recipient compatibility:** reproduce the real attachment Picker's
empty local folders; verify SAF grants, multi-select, cancellation and restart.

M2. **MOBILE-001/004 remaining shell/consumption work:** cold/warm media measurements,
large-video/retry behavior, full gesture/lifecycle checks, system Share quick-save and
optional extension update management. The installed app/Home/cache are not new work.

M3. **MOBILE-005 Collections — DONE.** Keep the deployed cover/volume implementation.

M4. **MOBILE-006 shared Manga Catalog reads — server/v2 deployed / device acceptance open:**
versioned replica, PC-style search/list/detail/bookmark filter, Reader endpoint, native cover/page
cache and v2 latency projection are deployed. The current publication was upgraded in place.
Next is APK 0.4.3 Galaxy Tab install plus reader interaction and cold/warm timing acceptance.

M5. **MOBILE-007 bookmark changes:** after read identity/revision contract, with
idempotent retries and PC receipt/conflict semantics.

M6. **MOBILE-008 DB refresh requests:** define PC/server updater responsibility;
implement durable jobs while the previous index stays readable.

M7. **MOBILE-003 global deletion — HOLD** until explicitly approved safe protocol.

## Parallelism note for the Collection lane

Remaining Works/Collection expansion has no blanket catalog/Notes dependency.
Use each item's actual prerequisites and preserve ownership of shared files.

The Manga Shelf Grid and Game/Film normal presentation baseline are implemented.
LONG-002A and WORKS-002 are user-accepted; do not restart the shelf reskin.
CLOUD-UI-001 and STATS-001A/B await native acceptance. WORKS-001 has the TV/season/episode
structure implemented, with related-work/richer Film surfaces still partial.
