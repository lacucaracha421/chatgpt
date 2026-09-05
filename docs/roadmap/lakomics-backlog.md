# Lakomics Backlog

Living source of truth for Lakomics bugs, product work, cloud/mobile follow-ups, Collection/Works evolution, and long-term ideas.

This backlog was reconciled on 2026-09-05 against:

- the full repository audit snapshot taken from the real `C:\chatgpt` codebase and production databases;
- `docs/agents/mobile-consumption-ux.md`;
- `docs/agents/works-viewer-design.md`;
- `docs/roadmap/works-collection-visual-redesign-plan.md`;
- current code, schemas, ADRs, `CONTEXT.md`, and `DESIGN.md`.

Current code and migrations remain authoritative for implemented behavior. Git history retains the old verbose completion notes; this file intentionally keeps completed work compact so stale historical text does not look executable.

## Status legend

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

Status: `PARTIAL`

The major feature is implemented and already proved against the real library:

- prepare -> upload -> commit replication exists;
- retries, reconciliation, incremental replication, mobile APIs, and media tickets exist;
- the completed real-library backfill must not be rerun by default;
- Galaxy Tab browsing from the server replica has been verified.

Remaining closure:

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
- then return this item to `DONE`.

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

Status: `PARTIAL`

Already present:

- Cloud enablement/base URL/token status;
- connection test;
- manual inbound sync;
- recovery/backfill controls;
- transient manual result summaries.

Missing:

- durable last attempt;
- durable last success independent of later failure;
- sanitized last error;
- persisted last processed summary;
- current combined actionable problem count;
- conditional `동기화 문제 N` navigation into the existing Cloud Settings/recovery surface.

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
Status: `BLOCKED` — grouped COUNT performance gate; backend foundation only.

Durable handles/preferences, conservative lineage validation and source publication
revision tracking are implemented. The materializer/grouped query remains unexposed;
API/UI work was not started. On 131,210 real works, default grouped UUID COUNT was
about 1,008ms versus 522ms with saved policy, and 434ms versus 14ms with reveal.
An internal numeric covering-index experiment still added 132–166ms for default
queries. Review an exact default-count preparation/cache lifecycle before continuing;
do not mark this item DONE or activate grouped search with the current COUNT path.
See [measured performance gate and remaining implementation](../operations/catalog-lineage-performance-gate.md).

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

Status: `TODO`
Prerequisite: CATALOG-007A.

After lineage groups are stable, add a bounded review candidate system using combinations such as normalized title + artist/group + compatible category/page/language evidence.

Requirements:

- title alone is never automatic identity;
- explicit confirm / false-positive / split decisions;
- manual decisions survive group rebuilds/algorithm versions;
- canary review before enabling broader candidate generation.

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

## NOTE-001A — Revision-safe server Notes foundation

Parent item: legacy `NOTE-001`
Status: `TODO`

Notes are a separate everyday text domain, not Asset metadata.

Initial server model:

- client-generated stable ID;
- title/body;
- monotonically increasing revision;
- created/updated timestamps;
- tombstone deletion;
- cursor-paginated list;
- versioned JSON export/recovery.

Updates/deletes require expected revision and return conflict instead of last-write-wins.

Reuse the existing authenticated Cloud API and server SQLite patterns. Ensure server DB backup/recovery exists before real notes become relied upon.

## NOTE-001B — Desktop Notes section

Status: `TODO`
Prerequisite: NOTE-001A.

Add a dedicated sidebar destination and list/editor with explicit unsaved/saving/saved/error/conflict states.

A conflict must offer a safe decision such as reload server copy or duplicate the local draft as a new note. React must never receive/store the Cloud bearer token.

## STATS-001 — Personal statistics

Status: `PARTIAL`

Split into two truthful phases.

### STATS-001A — Inventory Statistics

Status: `TODO`
No activity prerequisite.

Use current authoritative data for bounded aggregates such as:

- media-kind totals;
- collected counts by local month;
- top creators;
- current direct classification counts;
- favorites;
- reliable original/derivative storage totals.

Aggregate in Rust/SQL, not React, and make metric definitions visible.

### STATS-001B — Activity Statistics

Status: `TODO`
Prerequisites: BUG-013 and STATS-001A.

Add only recorded-era activity views, for example:

- most-opened assets/Collections;
- long-unseen items;
- recent bounded daily patterns.

Record Collection opens with the same deliberate-session semantics used for Asset opens. If daily rollups are needed, use bounded aggregate rows rather than unbounded raw history.

Always show the telemetry start date. Never infer past opens from file dates or exposure counts.

## IDEA-001 — More varied Revisit mixes

Status: `PARTIAL`

Current creator/date/surprise foundation exists, but preference weights and open history are not yet trustworthy inputs.

### IDEA-001A — Scoring, feedback, and cooldown correctness

Status: `TODO`
Prerequisite: BUG-013.

- version the daily slate algorithm;
- apply hard recent-exposure cooldown then explicit fallback tiers;
- use days since open/exposure, counts, collected age, favorite where available, and saved preference weights;
- add a small `덜 보기` feedback affordance;
- keep one deterministic complete slate transaction per local date/revision.

### IDEA-001B — Theme expansion

Status: `TODO`
Prerequisite: IDEA-001A.

Candidate themes:

- one focused creator per bundle;
- bounded period nostalgia;
- recently collected but rarely opened;
- favorite + discovery only when favorites exist;
- cross-classification discovery;
- Collection-level high-rated discovery only where Collection scores actually exist.

A theme label must match its actual selection logic. Missing data should omit/fallback rather than fabricate meaning.

---

# Mobile lane — Galaxy Tab production client

The approved consumption specification is `docs/agents/mobile-consumption-ux.md`.

The current browser/mobile-extension prototype remains a verified behavioral reference, not the preferred production destination.

## MOBILE-001 — Direct authenticated native Android shell

Status: `TODO`

Goal:

- establish the production Android client boundary without extension injection or `chrome.storage`;
- direct authenticated server client;
- Android secure token storage;
- classifications/assets/Revisit/media-ticket API parity sufficient for read-only browsing;
- reusable cache/auth/request-cancellation foundation for consumption UI and DocumentsProvider.
- read-only access to server-stored pending Capture previews so a mobile client can show newly saved media while the desktop is offline;
- keep pending Capture identity/state separate from canonical Cloud Library Asset identity/state;
- reuse the existing authenticated pending-list/download boundary or a minimal mobile-safe adapter rather than exposing R2 object keys or credentials;
- define deterministic reconciliation after desktop processing so a pending Capture can disappear or be replaced when the canonical library result becomes observable.

Pending Capture visibility is a presentation/preview feature, not early admission into the canonical library. The local Lakomics library remains authoritative. The server must not promote a Capture into a canonical Asset merely so mobile can display it.

Do not change the stable browser X Collector merely to support the native client.

## MOBILE-004 — Approved portrait-first consumption UX

Status: `TODO`
Prerequisite for production integration: MOBILE-001. Pure layout/state algorithms may be developed/tested earlier.

Initial destinations:

- Home;
- Library.

Home order:

1. optional Continue card restoring useful prior context;
2. dominant canonical Recent gallery using `{type: "recent"}`;
3. secondary Revisit/discovery that must not delay first useful Recent paint.

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

First pass explicitly excludes:

- Collections/Showcase;
- Online Manga Catalog;
- classification editing/bulk management;
- a third `display.webp` derivative;
- server/mobile write-back.

Device gate: pass all documented Galaxy Tab S11 portrait checks first, then landscape, and measure cold/warm first visual, original replacement, adjacent navigation, and video first frame before adding another derivative.

## MOBILE-002 — Read-only Android DocumentsProvider

Status: `TODO`
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

# Works / Collection presentation lane

Stable product intent: `docs/agents/works-viewer-design.md`.
Concrete visual plan: `docs/roadmap/works-collection-visual-redesign-plan.md`.

The central principle is a shared Lakomics shell with type-specific viewing grammar:

- Manga = volume-centered personal shelf;
- Game = hero/package-centered work exhibit;
- Video = poster-centered archive; series expand into seasons/episodes;
- Showcase = a higher-appreciation view using the same primitives, not a separate renderer.

Artwork > work identity > personal state > useful provider metadata > provider/maintenance controls.

## LONG-002A — Type-aware presentation foundation and normal Works visual pass

Parent item: legacy `LONG-002`
Status: `TODO`
Legacy LONG-002 remains `PARTIAL` because type-specific classes and a game package seed already exist.

Shared primitives should remain lightweight DOM/CSS:

- `WorkTile`;
- `PhysicalCover`;
- `ArtworkStrip`;
- `RelatedWorksRail`;
- `MetadataLine`;
- a small `collectionType -> presentation preset` mapping.

No Three.js/WebGL for ordinary grids. Dense library grids remain static or use one restrained hover/focus lift; no continuous pointer tracking.

### LONG-002A.1 — Manga Shelf Grid quality baseline

Implement first as the visual calibration target.

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

Preserve current hero + package foundation, then improve composition:

- reduce excessive hero vertical dominance so lower content enters the viewport earlier;
- make hero, package, title, and identity one coherent composition;
- use compact sentence-like metadata instead of field-box rhythm;
- personal rating outranks provider state/external scores;
- `ArtworkStrip` adapts gracefully to 1, 2, 3, or many screenshots instead of leaving a dead lower half;
- move `작품 관리` toward quiet overflow chrome;
- richer IGDB data is added only when it becomes structural UI such as release history, franchise/related works, or useful artwork.

### LONG-002A.3 — Type-specific Collection library `WorkTile`

Preserve the current compact toolbar/search/sort/rating shell.

At a glance:

- Game reads as a shallow package collection;
- Manga reads as shallow books/shelf library;
- Video reads as a flat poster archive.

Reduce redundant body headings when the toolbar already communicates Collection -> Library/Showcase -> type, allowing artwork to begin sooner.

Do not turn the normal library into a decorative showcase.

## WORKS-001 — Video Works: film + series / TV animation

Status: `TODO`

The current Collection implementation and TMDB flow are film/movie-only. The product category must expand conceptually to Video Works without forcing an immediate persistence rename.

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

Status: `TODO`

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

Status: `TODO`
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

- CATALOG-003 — `PARTIAL`
- CATALOG-004 — `PARTIAL`
- CATALOG-005 — `MERGE CANDIDATE` with CATALOG-006
- CATALOG-006 — `MERGE CANDIDATE` with CATALOG-005
- CATALOG-007 — `TODO` split into A/B
- CATALOG-002 — `PARTIAL` split into provider-key foundation + Heliotrope
- CLOUD-UI-001 — `PARTIAL`
- CLOUD-006 — `PARTIAL`
- NOTE-001 — `TODO` split server/desktop
- STATS-001 — `PARTIAL` split inventory/activity
- IDEA-001 — `PARTIAL` split correctness/themes
- LONG-001 — `TODO`
- LONG-002 — `PARTIAL` split foundation/focused interaction
- LONG-003 — `TODO` in audit, intentionally `HOLD` here until security gate is approved
- LONG-004 — `MERGE CANDIDATE` consuming LONG-002 renderer

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

Candidates intentionally absorbed rather than added as standalone backlog:

- `CLOUD-008` -> CLOUD-006 pause closure;
- `PERF-004` -> CATALOG-004 query/hydration batch;
- `DOC-001` -> completed by this 2026-09-05 truth-alignment rewrite.

---

# Dependency-safe master execution roadmap

This is a dependency map, not a list of unfinished tasks: consult each active item status above and skip completed work. Historical audit-index statuses do not supersede later completion evidence.

This is the authoritative dependency order, not a prohibition on parallel work in independent subsystems. In particular, Collection presentation and pure Mobile layout/state work may proceed in parallel once worktree ownership is clear.

0. **Backlog truth alignment — DONE by this reconciliation**
   - retire UI-003 and CLOUD-003 from executable work;
   - correct EXT-002 Cloud-first wording;
   - remove stale MANGA-001/performance completion ambiguity;
   - reopen CLOUD-UI-001 and CLOUD-006 as `PARTIAL`;
   - promote the approved Mobile/Works scope above.

1. **CLOUD-006 pause closure**
   - validate current pause guard/test and real pause/restart/resume.

2. **BUG-013 Asset-open recording**
   - begin trustworthy activity data immediately.

3. **CLOUD-UI-001 durable status**
   - persistent operational truth before further server/mobile expansion.

4. **CATALOG-002A provider-key contract**

5. **CATALOG-003 independent Japanese source**

6. **CATALOG-004 AST compiler + bulk tag hydration**

7. **CATALOG-005/006 unified visibility/block policy**

8. **CATALOG-007A lineage groups**

9. **CATALOG-007B reviewed heuristic groups**

10. **CATALOG-002B optional Heliotrope**

11. **NOTE-001A server foundation**

12. **NOTE-001B desktop Notes**

13. **STATS-001A inventory statistics**

14. **STATS-001B activity statistics**

15. **IDEA-001A Revisit scoring/cooldown**

16. **IDEA-001B Revisit themes**

17. **LONG-002A presentation foundation / normal Works visual pass**
    - Manga Shelf Grid establishes the aesthetic quality bar;
    - Game Exhibit refinement;
    - type-specific `WorkTile` library surface.

18. **WORKS-001 Video Works Film/Series expansion**
    - TMDB TV/season/episode structure and Video archive viewer.

19. **LONG-001 AV model and explicit cover roles**

20. **LONG-002B focused complete-cover interaction**

21. **LONG-004 optional Display/Shelf mode**

22. **LONG-003 Phase 0 threat model/format/recovery gate**

23. **LONG-003 Phase 1 encrypted metadata/image copy-in**

24. **LONG-003 Phase 2 health/recovery/key rotation**

25. **LONG-003 Phase 3 authenticated video chunks**

## Separately promoted Mobile production order

M1. **MOBILE-001 native authenticated shell**
- may begin after the immediate Cloud correctness/status foundation is stable;
- production mobile work does not require waiting for the entire catalog/Notes lane.

M2. **MOBILE-004 approved consumption UX**
- production integration after M1;
- justified-row calculator, cancellation/state models, and tests may start earlier.

M3. **MOBILE-002 read-only DocumentsProvider**
- technically parallel with M2 after the M1 auth/cache boundary is stable;
- ship after/alongside consumption according to product priority.

M4. **MOBILE-003 global tombstone deletion**
- only after read-only behavior is stable and the high-risk acknowledgement/grace-period protocol is explicitly approved.

## Parallelism note for the Collection lane

LONG-002A has no catalog/Notes dependency. After the immediate correctness gates (roughly steps 0–3), its visual prototype work can proceed without waiting for catalog batches 4–16, provided it does not collide with another agent’s Collection files.

The first recommended aesthetic implementation is still **Manga Shelf Grid**, because it calibrates cover density, physical depth, shadow, hover, and appreciation behavior used by the rest of Works.
