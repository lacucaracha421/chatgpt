# Lakomics Backlog

Living source of truth for **active** Lakomics work only. Completed, superseded, applied, and incident-only records live in [lakomics-completed.md](lakomics-completed.md).

Reconciled 2026-09-20 after the user separated completed server-authority rollouts from remaining client cleanup, accepted current media delivery, and closed the current character-accuracy improvement pass. See the [closure record](lakomics-completed.md#closure-checkpoint--2026-09-20--authority-scope-split-and-product-acceptance). This is a scope/status reconciliation, not a new deployment or Windows full-system audit.

Updated 2026-09-23 (evening): the Android 0.7 browse-first redesign, thumbnail loading work (0.7.4–0.7.6) and the in-range dependency update are archived in the [2026-09-23 evening checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-23-evening--mobile-07-thumbnails-and-dependencies). `CHAR-AUTO-007` reached stage 2d (shadow scoring) that evening.

Updated 2026-09-24: `CHAR-AUTO-007` stage 3 (per-series S36 publication) is implemented; `DEV-TEST-001` is archived in the [2026-09-24 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-24--rust-test-runtime).

Updated 2026-09-28: the 2026-09-27/28 Home, artist, release-calendar, notes and tablet-parity implementation slices are reconciled in the [2026-09-28 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-28--home-artist-release-calendar-and-tablet-parity). Production Linux library: schema v109 (migrations 0107–0109, with the recorded pre-migration backup); Windows PC remains pending (`WIN-SYNC-001`). Android 0.8.61 is installed on the tablet. This records source and history alignment, not a new Windows or full native audit.

Updated 2026-09-30: the design foundation, Home/Settings/calendar redesigns, artist/auto-tag source slices and the PC/tablet 에셋 round are reconciled in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round). Android 0.8.85 was installed and confirmed by the user; the last PC release binary predates later source fixes. Source migrations reach 0115; production application beyond the recorded v109 state is not claimed. This is a scope/status reconciliation against `main` through `c60e57f9`, not a new deployment or Windows full-system audit.

## Current priority

Updated 2026-09-30 from the current source and `main` history. The active redesign order is PC 에셋 (source and tablet port complete), 망가, then 컬렉션; each round is PC first and tablet in the same round. Remaining work, in priority order:

1. **망가 redesign** — active round. Design record and 2026-09-30 decisions: `docs/prototypes/pc-manga-20260929/README.md` (A–D, no resume, 판본 in the PC detail, tablet sheet/reader). Slices, PC first: (1) toolbar + shared card, (2) detail overlay panel, (3) one immersive reader for local and online, (4) load more instead of the pager, (5) sidebar index — frequent tags/artists from bookmarks plus pins stored in the library (user, 2026-09-30: a new migration; production migration needs its own approval and backup) and local folders with counts plus the vanished-folder cleanup (production write, approval when reached), (6) tablet. Mockups from now on are plain HTML under `docs/prototypes/` that load the app's real CSS. Sharing follows `DESIGN.md` §12 ("What PC and tablet share"); the ratchet `src/shared/sharedLayers.test.ts` fails on new tablet copies (baseline 24 exports, 4 control classes — shrink it as copies are replaced).
2. **컬렉션 redesign** — after 망가, finish the decided PC showcase/news/list/detail surfaces and then the tablet round; 신간 follows the chosen dense ledger direction.
3. **USER-REQ-20260924 / USER-REQ-20260926B** — start Collections authority slice 1, then implement tablet Collection creation; tablet character creation remains dropped by the PC-only decision.
4. **USER-REQ-20260927 / HOME-DASH-001** — record native PC acceptance for the current Home, artist, AV and calendar source; keep the release calendar PC-sourced.
5. **PC-RELEASE-FEEDBACK-20260929** — release-check character-folder picker items 4–5; late calendar covers remain `HOLD` by the user's decision.
6. **TABLET-PARITY-001** — retain only the unbuilt tablet server work, tablet 작가 edit path, performer-profile publication, the next IGDB refetch and any explicitly unverified acceptance.
7. **ARTIST-SUGGEST-001** — perform targeted/native acceptance of the implemented style-suggestion flow; do not reimplement it.
8. **AUTO-TAG-001** — keep production import/apply behind explicit approval; the PC inbox/import path is implemented.
9. **PC-DECLUTTER-001 / WIN-SYNC-001 / VAULT-ENC-001** — complete the Windows acceptance gates when the Windows PC is available; the recorded production target remains v109.
10. **PC-REVIEW-001** — resolve or verify only the residual findings that remain open below.
11. **PERF-ALL-001** — move the remaining PC sync state out of `notes_state` and gather the still-missing native or measured evidence.
12. **CLOUD-POST-001** — decide and implement only the remaining Character/Collection publication and compatibility cleanup.
13. **PC-UI-001 / ARTIST-001** — complete native PC acceptance of the implemented consistency and Artist hub surfaces.
14. **HOME-OPT-001** — findings (1)–(8) are fixed in source (2026-09-30); remaining: look at the PC dev build and the tablet (reserved section heights, failed/empty states), and the measurement pass.
15. **CHAR-AUTO-007** — enable/watch the recorded S36 results on the 백합 series.

The shared design foundation has one open follow-up: the GalleryTile preview still shows the old selection look. The finished 에셋, Home/Settings/calendar and shared-component records are in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round).

`SIMILARITY-004` (existing-library near-duplicate discovery) and mobile tab-switching improvement were closed on 2026-09-23 at the user's confirmation; see the [closure record](lakomics-completed.md#closure-checkpoint--2026-09-23--similarity-discovery-and-mobile-tab-switching).

`MEDIA-R2-001` is closed at the currently satisfactory media-delivery scope; extra variants are not required. `CHAR-AUTO-001` is closed for this improvement pass; future concrete classification mistakes can open bounded follow-up work rather than keeping a permanent accuracy task active.

Next candidate after the redesign order: AV source-and-candidate selection (`LONG-001`), optional provider work (`CATALOG-002B`). Style-based artist suggestions are implemented but remain `VERIFY`; the validation, mockups `docs/prototypes/artist-style-suggest-20260928/`, and the user's A (+ C inspector box, D reposter flag) decision are recorded in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round). Similar-video calibration stays deferred until representative samples naturally appear.

## Status legend

- `IN_PROGRESS` — active implementation lane.
- `PARTIAL` — useful implementation exists; a material current-product gap remains.
- `TODO` — executable work not yet implemented.
- `VERIFY` — implementation exists; only targeted acceptance remains.
- `MERGE CANDIDATE` — fold into another active item rather than build separately.
- `HOLD` — intentionally deferred or gated.

`DONE`, `APPLIED`, and `OBSOLETE` items are archived in [lakomics-completed.md](lakomics-completed.md) and should not be selected from this file.

## Repository-wide execution rules

- Preserve existing user data and provider bindings; prefer additive/reversible changes.
- Do not rerun the completed full Cloud Library backfill unless a separately approved recovery operation requires it.
- Do not replace `kdata.db` wholesale for catalog work.
- Keep count/pagination correctness in Rust/SQLite rather than frontend-only filtering.
- Native Android is the production mobile architecture; do not revive the browser-extension prototype as the client architecture.
- Reuse the existing Collection presentation renderer rather than creating parallel renderers.
- Before each implementation batch, re-check Git status/diff and concurrent ownership.
- Production data writes, deployments, device installation, and Git writes still require their own explicit authorization.

# Cloud / Mobile authority

## CLOUD-POST-001 — 서버 원천화 이후 클라이언트 구조 정리

Status: `PARTIAL` — remaining client/publication cleanup only. The completed authority
rollouts are separated into the [2026-09-20 closure record](lakomics-completed.md#closure-checkpoint--2026-09-20--authority-scope-split-and-product-acceptance).
Do not repeat the bookmark, Album, Classification or Asset lifecycle cutovers.

Remaining scope:
- Character and Collection structures still use PC-owned publication. Decide their
  ownership and migration contract before replacing that path; the shipped mobile
  character-exclusion channel is not full Character authority.
- Retire or repurpose manual publication controls and one-way publication state only
  where an equivalent live authority-backed consumer exists. `useMobilePublications`
  still serves unmigrated domains and must not be removed wholesale.
- Review retained compatibility readers, staging data and fenced writers against actual
  consumers and recovery needs before retiring anything. A retained fence or migration
  is not itself unfinished functionality.

Preserve the PC SQLite replica and workstation-only filesystem/compute state, durable
pending intent, domain-specific cursors/revisions and local presentation preferences.
Broader worker architecture, mobile editing and browsing-cache expansion remain in
`CLOUD-WORK-001`, `MOBILE-WRITE-002` and `MOBILE-CACHE-001`; this item does not restart
those deferred scopes.

Acceptance: any selected cleanup removes a demonstrated obsolete client/publication
path without losing a live consumer, offline intent, authority fence or recovery path.
New domain activation, deployment and production-data writes require separate approval.

## MOBILE-CACHE-001 — Android durable metadata replica

Status: `HOLD` — post-authority optimization.

Current mobile binary caching (`MediaRepository` / `ThumbnailCache`) is useful, but much of the browsing metadata is still held in React `Map` caches or `localStorage`. Add a small durable Android metadata database once the server change contracts are stable.

- Persist browse metadata, revisions/cursors and durable outgoing intents in a local database rather than relying on process-memory caches for normal startup.
- Startup should render the last committed local state first, then fetch/apply server changes in the background.
- Keep binary media in the existing bounded media cache; metadata replica and media cache are separate concerns.
- Revisit `PickerLibrary`'s independent JSON snapshot after this exists. Prefer deriving Picker/album views from the durable replica rather than maintaining another full-library metadata copy.
- Preserve explicit cache invalidation when the configured server/library identity changes.

Acceptance: after one successful sync, relaunching the Android app can show the previous library view without waiting for a full remote page load; later server changes update it incrementally without losing pending local intent.

## VAULT-ENC-001 — Lakomics-encrypted Private Vault (ADR-0039)

Status: `VERIFY` — Linux accepted (real USB, 2026-09-24; event-driven detection and the rail entry checked 2026-09-26); Windows acceptance remains (compile + real USB, including same-letter card swaps).

Replace VeraCrypt with Lakomics' own per-file encryption so a USB plugged into another computer shows nothing readable. The user copies the VeraCrypt contents (including `.lakomics/`) to the trusted PC, formats the 64 GB USB as exFAT, then imports.

Stages:
1. Crypto core: vault format, key wrapping (password, recovery key), chunked AES-256-GCM objects with seekable reads, encrypted atomic index, orphan cleanup. No UI.
2. Create/unlock/lock, remember-on-this-PC (OS credential store), import from a plaintext folder keeping old titles/custom thumbnails, encrypted thumbnails, browse through the media protocol with `no-store`.
3. In-app add, export, vault trash and empty; ranged video playback in the in-app player.
4. Native acceptance on Windows and Linux: real USB removal, credential store, large videos.

Also fix the bugs found in the 2026-09-24 audit where they survive the rewrite: scans that delete titles/thumbnails after partial failures, uncached full-image responses, per-tile status probes, and focus-only removal detection.

## WIN-SYNC-001 — Update the Windows PC after the 2026-09-24 changes

Status: `TODO` — the user's Windows PC remains unavailable as of 2026-09-28; the Linux library now requires at least schema v109.

Once the Linux PC publishes Collections with the personal-edit handshake, the older Windows build is refused for Collection publication only (other domains and local data are unaffected). On the Windows PC: pull `main` (requires the commits to be pushed first), rebuild, and verify:
- Collection publication resumes.
- Private Vault on Windows: Credential Manager remember/auto-unlock, USB detection by drive letter, removal lock, in-app video playback.
- FAULT game in WebView2 (`http://tauri.localhost` → `http://lakomics.localhost` original-image reads).
- Collections authority (docs/research/collection-authority-design-20260924.md) may be activated before this update; the old Windows build is then fenced for Collections and its local-only edits are not carried over (the upgrade produces a salvage report).
- Library schema: the production Linux library is at v109 (migrations 0107–0109, 2026-09-28, with a pre-migration backup); the Windows build must be at least as new before it opens that library.

## USER-REQ-20260924 — User requests, 2026-09-24 evening

Status: `PARTIAL` — the delivered request batch is archived in the [2026-09-26 checkpoint](lakomics-completed.md#user-req-20260924--delivered-items) and the later shared redesign slices are in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round). Remaining:

- Mobile design consistency with the PC app is archived as `MOBILE-DESIGN-001`; the Home/artist surfaces are implemented in `HOME-DASH-001` and `TABLET-PARITY-001`.
- PC: start Collections authority slice 1 (docs/research/collection-authority-design-20260924.md). Only slice 0 exists (`c38a2bc`, server module, inactive); slice 1 is not started.
- `VERIFY`: lightweight processing mode (`05b18b6`) must be re-checked as features keep being added — part of `PERF-ALL-001`.
- Battery: reduced in 0.8.6 (`f25ddd8`); further work is part of `PERF-ALL-001`.

NovelAI app items from this batch are in `nai_frontend/docs/BACKLOG.md` (NAI-009).


## USER-REQ-20260926B — User requests, 2026-09-26 (second batch)

Status: `PARTIAL` — the mobile UI, PC Notes/release captions and chat-style 전송 redesign are archived in the [2026-09-28 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-28--home-artist-release-calendar-and-tablet-parity); the later shared redesign slices are recorded in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round). Tablet character creation was dropped by the user's 2026-09-27 PC-only character decision. Remaining: tablet Collection creation, which still needs the Collections authority slice 1.

## HOME-DASH-001 — Information dashboard Home (tablet first)

Status: `VERIFY` — the PC and tablet Home source is implemented through `60d4e3a6`, `3a82a445`, `8fa77090`, `a0dff198` and `48c8d2c8`; the shipped redesign is archived in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round). Remaining: native PC acceptance for the current source, the still-open `HOME-OPT-001` findings, and the decision to keep the release calendar PC-sourced.

## USER-REQ-20260927 — PC redesigns and fixes requested 2026-09-27 (evening)

Status: `VERIFY` — the requested PC Home, artist grid, 새 캐릭터 제안, tagger review speed, AV detail/performer page/portrait picker, Collections sections, TV anime calendar and top-bar titles are implemented in `532b7cc0`, `21b5aea1`, `b5c4eafa` and later commits; the source slices are recorded in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round). Native PC acceptance on the current build is unverified; keep this item only for that check and any concrete regression.

## TABLET-PARITY-001 — Bring the tablet app up to the 2026-09-27 PC features

Status: `PARTIAL` — the Home, calendar, Collections, shared-components and 에셋 ports are implemented through `c60e57f9` and archived in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round); Android 0.8.85 was installed and confirmed by the user. Remaining: tablet server support for subtree folder listing, shelf projection and batch album/folder moves; tablet 작가 editing/further 작가-tab port; publication of the AV performer profile; the next IGDB refetch; and any unrecorded native acceptance outside the supplied port confirmation. The dated-game fix is source/device-recorded, while the release calendar remains PC-sourced. The one-off TMDB 400 and leftover diagnostics remain unverified.

## AUTO-TAG-001 — Automatic image tags and tagger character signal

Status: `PARTIAL` — the PC tag import, veto/recommendation review and 새 캐릭터 제안 are implemented in `b00f3bfe`, `532b7cc0` and `e8e34e5e`; the machine-local auto-tag/style inbox is implemented in `e88c21ff` and archived in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round). Remaining: explicit approval before production import/apply, with the preview/apply gate preserved. Tablet tagger recommendations, vetoed pairs and character registration remain dropped by the 2026-09-27 PC-only decision. Findings and mockups remain at [tagger-character-signal-20260927](../research/tagger-character-signal-20260927.md) and `docs/prototypes/auto-tags-20260927/`.

- The source path is PC-only: the user's nightly machine-local output can be consumed from the configured inbox, and tagger-review application is optional. Automatic import of that daily output remains open; production-library writes still need explicit approval, and there is no tablet/server path.
- New images: tagged daily at 03:00 on the Linux laptop with v1.0 then canary (user decision 2026-09-27): systemd user timer `lakomics-daily-tag.timer` → `~/.cache/lakomics-oss/daily/daily.sh` (read-only on the library; output `daily/out/<model>/*.npz`, log `daily/logs/daily.log`). Runs only while the user session is up and the PC is awake; a missed night is not caught up. Importing the daily output into the app is still a manual step (auto_tags_export.py --daily + Settings › 자동 태그); automating that import is open.
- New taggers appear irregularly (PixAI v0.9 2025-08 → v1.0 2026-09-15; canary a one-off 2026-07-29; WD v3 unchanged since 2024). Check about quarterly; re-run on a rented GPU and compare against the confirmed decisions before switching.
- The PixAI/canary evaluation numbers and the stopped Camie trial are archived in the 2026-09-30 checkpoint and the research note; do not switch models from these notes alone.
- `532b7cc0` (migration 0106; mockups `docs/prototypes/new-character-suggest-20260927/`) retains register, merge, ignore and postpone for unregistered tagger characters.

## ARTIST-SUGGEST-001 — 닮은 작가 후보 (artist suggestions from art style)

Status: `VERIFY` — the direction chosen by the user is implemented in `e88c21ff`; the source path is archived in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round). Native/user acceptance of the current PC flow is not recorded.

- The chosen design remains A (grouped by suggested artist) plus C (inspector box) and D (`퍼온 계정 — 작가 아님`); mockups remain at [artist-style-suggest-20260928](../prototypes/artist-style-suggest-20260928/index.html). The source never assigns automatically. The remaining task is targeted/native acceptance of the shipped flow, not another trial or automatic-assignment design.

## TABLET-FEEDBACK-20260928 — Tablet real-use feedback, 2026-09-28 evening

Collected by the user while using tablet 0.8.64; the source and later device records are archived in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round).

- **Resolved in source/device records:** `f9104c13` (0.8.67) fixed the sort/filter opening feedback, filter-chip pressed state, memo 저장됨 label and caret placement, Folder/Album remount appearance, character-folder thumbnail keys, Showcase counts/stale type and 출처 열기 target. `40da202d`, `bde76a5f`, `4731c0de`, `63908e13` and `c60e57f9` carried the shared controls, Home/Collections/Notes treatment and 에셋 port forward.
- **Still open bugs and polish:** Home's `마법소녀를 동경해서` thumbnail still needs comparison with the stable 신간 calendar-cover path; Catalog image-request path optimisation remains open. Checked 2026-09-30: the thumbnail-size setting persists in source (`lakomics.mobile.density`, one device-wide key; folder/tab/rotation/remount covered) — only an Android process restart is left to confirm on the device; the bottom-tab switch no longer fades the new tab in from 0.4 opacity (that fade let the sharp backdrop show through), so tabs appear at once — the tab entrance animation is gone; confirm on the device and decide whether a content-only animation should return.
- **Design decisions/source slices delivered:** the Home text/shelf treatment, transition, Collections section folding and shared segmented control, outside-cover 신간 bookmark, 에셋 분류 · 앨범 · 작가 entry points, and fixed-heading Notes direction are implemented in the commits listed above and the linked checkpoint. The tablet 작가 tab port/edit path, including rename/hide, is deferred by the user; the separate 메모 `피드백` kind remains unimplemented.
- **Later / questions:** after the PC AV work, carry the AV design to the tablet and Home. The tablet AV performer page should show the StashDB profile fields chosen on 2026-09-28 (생년월일·나이, 키, 사이즈, 가슴 유형, 활동, 링크), but PC publication from `collection_person_profiles` and the server snapshot model is still required; the chosen StashDB portrait may follow later.
- **Catalog refresh reach (answered 2026-09-28):** a tablet 카탈로그 갱신 (`POST /v1/mobile-catalog/refresh`) updates only the server publication (`mobile_catalog_server_additions`, re-applied over later PC publications); the PC never reads it and only catches up on its own kHentai update. Decided 2026-09-28: the PC imports the server additions into its local catalog (the PC stays the catalog owner and publisher; its own kHentai update keeps running) — do not switch the PC to read the server catalog.
- **HOLD — 가계부 import (decided 2026-09-28):** no personal API exists (Naver Pay has no consumer API; 오픈뱅킹/마이데이터 need a registered business and review or a licence). When resumed: import the Excel/CSV history the user downloads from Naver Pay (결제내역 → 엑셀 다운로드) and their card companies, one parser per source, user confirms before saving. Notification capture (NotificationListenerService, restricted setting on sideloaded apps) is the optional later step.

## USER-FEEDBACK-20260928B — Second feedback batch, 2026-09-28 night

- **Fixed in 0.8.67 (`f9104c13`):** the tablet Home memo preview no longer shows escaped Markdown; the completed record is in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round).
- **Tablet:** animate new images arriving when a list refreshes (new tiles fade/slide in instead of popping).
- **PC 메모:** full-screen editing, sidebar removal, caret placement and Ctrl+Z/visible undo are implemented in `60d4e3a6` and later Notes commits. Remaining: the sync button's distracting re-render behavior.
- **PC 망가:** the reader spread flicker is fixed in `298ae2ac`. Remaining: remove metadata for local folders that no longer exist, with the user's choice of confirm flow because it writes production data; and show local-folder counts in the sidebar.
- **PC 카탈로그:** automatic confirmation of duplicate editions remains open: auto-confirm only certain matches, keep the rest in review, log decisions and allow undo.
- **PC 에셋:** the sidebar/nav, album mosaic, artist filtering/search, plain-click focus, character picker/drop target, viewer and folder/character design are implemented in `ff4887e8`, `57cb571c`, `bb768b59`, `d44edc0c` and the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round). Remaining: tablet server work for subtree listing/shelf projection/batch moves; tablet 작가 rename/hide/edit path and the user's deferred further 작가-tab port; and the separate safe-undo task. Safe undo remains unbuilt because a simple restore can overwrite another device's folder change, fail to restore consumed tagger candidates and break `Cleared` decision provenance; it needs an authority-revision-conditional restore, candidate restoration and an explicit compensation decision kind.
- **PC Home:** Home D/E, the one-scroll centre/right layout, 이어 보기, 이어지는 시리즈 and 즐겨찾는 배우 are implemented in `60d4e3a6`, `3a82a445` and `1d6f4e2e`; the tablet Home A source is `8fa77090` and the tablet pick was installed as 0.8.69. Decided 2026-09-30 (user): no resume anywhere — 이어 보기 is removed from Home, local manga always opens at page 1 and library videos at 0:00 (the 0114 progress tables stay unused; the online-catalog progress goes in 망가 slice 1). Remaining gaps: favourite performers open AV Collections rather than a performer route, and AV 신작 still has no release feed.
- **Tablet Home aligned to PC D:** the source decision and Home A implementation are archived in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round); the tablet does not yet have the PC-only continue/favourite-performer data paths.
- **PC 에셋 main screen:** the decided grid A, overlay inspector, viewer B/C and folder D records and source are archived in `docs/prototypes/pc-assets-20260929/` and `docs/prototypes/pc-folders-20260929/`; release checks and the two source-only picker items remain separated in `PC-RELEASE-FEEDBACK-20260929`.
- **PC 망가 redesign (mockups 2026-09-29):** `docs/prototypes/pc-manga-20260929/` — A catalog grid (source segmented control, language/sort in the toolbar, index sidebar, fixed-ratio cards with scrim page badge, corner bookmark, progress line, skeletons, no bottom pager), B detail as the overlay side panel, C immersive reader like the asset viewer, D local with folder counts and the vanished-folder notice. Sidebar index decided (user, 2026-09-29): frequent tags and artists are counted from the bookmarked works (no new tracking), plus tags/artists the user pins. Decided 2026-09-29: A–D as drawn. Next active redesign round after 에셋 (it reuses the overlay panel, immersive viewer and shelf components built there).
- **PC 컬렉션 redesign (mockups 2026-09-29):** `docs/prototypes/pc-collections-20260929/` — A list with toolbar sort/rating and shared-shelf showcase, B one detail template (game), C manga ownership card (Switch, stepper, no 저장), D AV on the same template, E 신간 with app dates. Manga ownership: **C2** (one strip under the title actions; user, 2026-09-29). 신간 is to be redesigned from scratch (user: E wastes space and is hard to read); picked **G** (dense ledger: one row per work with owned range, unowned volume chips — NEW filled, upcoming dashed with date — date and state; counts 새로 나옴 · 나왔지만 아직 없음 · 발매 예정 on top; 일본 uses the same rows with "한국보다 N권 앞섬"; user, 2026-09-29). Other screens await review; implemented after 망가.
- **AV case:** the PC free horizontal rotation is source-implemented in `57cb571c`; tablet `AvCollections.tsx` still uses face stops and must align in the 컬렉션 tablet round.
- **Redesign order:** the user set PC 에셋 (complete, tablet port complete) → 망가 → 컬렉션. Each round remains PC first, then tablet in the same round.
- **Tablet 에셋 port — later server work (user, 2026-09-29):** the UI port shipped in `c60e57f9`; still to add on the server + Android allowlist: 전체 (subtree) listing for folders, folder shelf thumbnails/counts, and multi-image album/folder moves. Tablet character assignment reuses the existing queued review decision (`origin:"viewer"`, PC applies it later) — Astra (read-only, 2026-09-29) found it only accepts assets already in the character's published series (else `characterReviewOutsideSeries`; PC skips ineligible ones and never moves), so the tablet picker offers the current series only until a later server + PC move-and-accept path exists. Decided (user, 2026-09-29): deep character classification stays on the PC; the tablet port drops multi-select character assignment; the viewer keeps its existing single-asset editors. Multi-select stays (user): long-press selection with a selection bar whose first action is 앨범에 추가 (one native album-membership command per asset until the later batch server op). Astra's server design for the later work: extend `/v1/library/classifications` with an opt-in `parent_id` shelf projection (direct children, distinct subtree image counts, newest available cover, listGeneration; do not repurpose `asset_count`); `include_descendants` on `/v1/library/assets` with the mode bound in the cursor (shared decoder expects four payload slots — update it) and in tablet URL/cache/navigation identity; both are query-only, so no NetworkPolicy widening; cover legacy snapshot and authority branches, generation advance, cursor-mode rejection. Server deploys are approved by the user for this work.
- **Tablet 에셋 port — device feedback:** `c60e57f9` implements the PC-like player, toolbar, shared selection look, draggable filmstrip and folder/character presentation; Android 0.8.85 was installed and confirmed by the user. Further tablet 작가-tab alignment is deferred to its own port later.
- **Character edit panel usability (on hold, user 2026-09-29):** the 캐릭터 정보 panel (CharacterRegistry + ReferenceRegionChoices) reflows at every step of 인물 영역 조정 (correction list, then chooser, pushing content down) and shows shifting buttons (필요한 인물만 확인 / 인물 영역 조정 / 추천 영역 사용 / 닫기). Proposed direction: adjust on the reference tile itself with the current crop outlined, one "인물 확인 N장" line for flagged tiles, fixed panel order as mockup F. The user wants the character classification flow cleaned up first, then redesign this.
- **PC browser preview with fake data:** `57cb571c` implements the dev-only fixture gateway and `npm run dev:preview` path. It remains development-only and does not touch the production library or release builds.
- **Shared-asset audit:** the CSS order/type-role/control issues were fixed in `ba73e69c`; SectionLabel, Badge, EmptyState, skeletons, Settings rows, edge-stripe removal and shared logic landed in `8b81f859`, `40da202d`, `bde76a5f` and `4731c0de`. The GalleryTile preview still shows the old selection look; full native coverage remains separate.
- **PC 설정 remake:** design A at `docs/prototypes/settings-remake-20260929/` and the shared rows/removals are implemented in `60d4e3a6`; native acceptance remains under `USER-REQ-20260927 / HOME-DASH-001` and `PC-DECLUTTER-001`.
- **PC rail 찾기:** the user rarely uses it. Decided 2026-09-28: keep the rail button for now and later look for ways to make 찾기 more convenient (not removal).
- **PC 자연어 검색 (on hold, 2026-09-28: the auto tags already work well):** earlier trial `docs/research/oss-trial-clip-20260927.md` (SigLIP2-base P@10 KO 0.25 / EN 0.53 / image 0.64; Korean about half of English). Proposal to decide: tag search first on the auto tags (Korean query → tags), SigLIP2 only as a fallback for mood/scene queries (~1 h backfill on this PC).
- **PC animation polish** like the tablet — last, after everything above.
- **PC video thumbnails** are intermittently not generated. Read-only investigation 2026-09-28: 458 of 459 videos are `ready`; the one missing (`authority-VTkMaI.mp4`, a normal 5.7 s H.264/AAC MP4 materialised from Asset Authority) is `pending` with no error and no outputs — preparation never started. Likely cause: lightweight mode (`workload.lightweight = true` in `library-machine.json`) disables `useVideoPreparation` (`App.tsx` ~355) and the Rust loop stops when restricted, and preparation is only triggered from the UI. Fix proposal: generate the poster even in lightweight mode (scrub/proxy later), wake preparation after Asset Authority materialisation and on workload changes, show "가벼운 모드로 대기 중" on pending tiles, and store the stage/attempts/last FFmpeg error instead of only `video_preparation_failed`. Decided 2026-09-29 (user): solve it by making lightweight mode clearly visible — the pending tiles and the app should show that lightweight mode is on and holding video preparation — rather than generating posters in lightweight mode; do it after the Home redesign.
- **PC 발매 캘린더:** the captions, spacing, day groups, cover bookmark, top row and cache are implemented in `595b7401`, `d83a2453` and `48c8d2c8`; the decided design A remains at `docs/prototypes/release-calendar-20260929/`. Keep only the native/first-open acceptance gap in `HOME-DASH-001` and the user-deferred late-cover note in `PC-RELEASE-FEEDBACK-20260929`.
- **Light "종이" theme (decided 2026-09-28, later):** add a Settings theme choice; default stays the dark "먹색" + ivory; the light theme swaps token values only (page `#f3f1ec`, ink-dark selection instead of ivory); palettes tried in `docs/prototypes/design-foundation-20260928/part4.html`.
- **Design rules — foundation implemented 2026-09-28:** `DESIGN.md` section 12, role tokens, shared controls and the ratchet source checks are archived in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round). The GalleryTile preview still shows the old selection look. The tablet WebView memory measurements and the user's decision to keep only the two bug-like guards remain recorded under `HOME-OPT-001`.
- **Decided 2026-09-28 (user):** PC 메모 edits in a full editor that replaces the 메모 area (Esc/back returns to the list); remove the 메모 sidebar and move the kind filters (전체 · 메모 · 체크리스트 · 가계부 · 피드백) to top chips; vanished local manga folders: show a "없어진 폴더 N개" list, delete only the selected ones, automatic backup first; duplicate editions: auto-confirm only certain matches (same title, artist, page count and near-identical cover), keep the rest in review, log auto decisions and allow undo.

## PC-RELEASE-FEEDBACK-20260929 — Release-build use feedback, 2026-09-29 evening

Collected while the user tried the release build of `57cb571c`; implementation and release evidence are archived in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round).

Status: `VERIFY` — items 1–3 and 6–13 were checked by the user in the 2026-09-29 release build; items 4–5 are implemented in `d44edc0c` but release-build acceptance is not recorded. The late PC calendar-cover appearance is `HOLD` by the user's decision; no fix is selected.

4. **Character folder assign dialog:** release-check the current picker implemented in `d44edc0c`; the folder D/character-folder decisions and mockups remain at `docs/prototypes/pc-folders-20260929/`.
5. **Character choices limited to the series:** release-check the series-scoped picker implemented in `d44edc0c`; it keeps the visible 모든 시리즈 row and the decided 미분류 / 전체 behavior.

## HOME-OPT-001 — Home optimisation and debugging pass (PC and tablet)

Status: `VERIFY` — findings (1)–(8) are fixed in source (finding (1) in `8fa77090`, (2)–(8) on 2026-09-30 with focused tests: PC 36, tablet Home 36, Rust home 30). Native PC and tablet acceptance is not recorded; the measurement pass below is still open.

- Measure first: time to first useful Home paint and number/size of requests on PC (dev and release) and on the tablet (cold and warm start), and which sections wait on which reads (overview, calendar, wishlist, revisit slate, artist today, AV pick, memos, exchange).
- Look for Home bugs the redesign may have introduced: layout shifts while sections load, stale counts after returning from another screen, shelf scroll/drag edge cases, privacy mode, empty states, offline/server-down behaviour, one-screen fit on the tablet with long names.
- Read-only audit 2026-09-29, rechecked against current source (not device/native checks). Fixed: tablet 관심 목록 removal from the Home sheet did not hide the title and a second tap re-added it (`8b3d3177`); finding (1), the tablet 신간 shelf overflow, is resolved in source by `8fa77090` (`_tools/app/mobile-client/home.css` now uses `overflow-x:auto`), but device reachability is not recorded. Remaining, most severe first: (2) tablet AV placeholder never resolves when the pick read fails offline (`homeDashboard.ts` `useHomeAvPick` rethrows non-404), and a 404 day drops the AV column after the placeholder showed (layout shift); (3) PC `get_home_overview` fails as a whole when any sub-read (tagger counts, AV pick, server status) errors, and HomeView swallows it, leaving 자산 현황 / AV 배우 / 태거 / 처리 대기 blank with no retry; (4) PC layout shifts while loading: AV 배우 section and 자산 현황 mount only after the overview, the empty shelf reserves 256px vs 280px game cards, and "새 신간 없음" shows while releases are still loading; (5) PC "모두 확인함" can flash before slower 검토 counts arrive; (6) PC Home open past midnight keeps yesterday's date, D-days and 오늘 +N until something else re-renders; (7) PC privacy mode race can show the AV 품번 count if privacy turns on during a pending count read (`AvLinkInbox.tsx`); (8) tablet offline banner treats any non-`ApiError` (e.g. a parse error) as offline and misses proxy 5xx. **Fixed in source 2026-09-30:** (2) the tablet AV section ends in a failed/empty state in place with 다시 시도; (3) optional overview reads degrade per field (`failed` list) and each section retries; (4) sections reserve their final size with skeletons and empty wording waits for the read; (5) 모두 확인함 waits for every count; (6) one timer at local midnight (`src/shared/useLocalDayClock.ts`); (7) stale AV 품번 count replies are ignored under privacy mode; (8) only connect/timeout failures count as offline, server errors show 서버가 요청을 처리하지 못했습니다. Known weak point: the tablet offline test matches the Android error sentences literally (`MainActivity.java` message mapping).
- Fix what the measurements and checks show; no speculative rewrites (see docs/agents/implementation.md, Performance work).


### Tablet WebView memory — code investigation 2026-09-28 (read-only, not yet measured on the device)

Likely causes, ranked: (1) `Viewer.tsx` decodes originals at full resolution plus up to two neighbour originals; the neighbour filter is 8 MiB of compressed bytes with no pixel limit (a 8000×20000 page is ~610 MiB decoded — fits the 704 MB spike); (2) `CatalogReader.tsx` keeps 3–7 pages mounted (hidden with `display:none`) and decodes each via `Image().decode()` and again in the DOM; (3) Collections and Catalog stay mounted while hidden after leaving the tab (`App.tsx` ~709–733), with non-virtualised grids that keep every scrolled-in `<img>` and a selected detail's hero original; (4) `ArtworkMemory`/`homeArtworkCache` have no size bound; (5) `MainActivity.onTrimMemory()` only locks the vault and releases no WebView resources. Gallery (virtualised), warmers, transport maps and object URLs look fine. Measured 2026-09-28 on the tablet (0.8.65, `dumpsys meminfo` every 3 s, renderer PID + app PID): idle renderer 47 MB / app 78 MB; reading ~20–30 manga pages → app 493 MB peak (graphics 374 MB), renderer 313 MB peak, renderer stays at 160 MB afterwards; Collections scroll then switch tab → app 474 MB peak (graphics 347 MB), renderer settles at ~121 MB, app 124 MB. The retained renderer growth reproduces the earlier 55 → 170 MB report but is mostly reclaimed later (cache-like, not a leak); the tall-image case was not measured (no sample found). Decided 2026-09-28 (user: memory is not tight, fix only bug-like issues): only two guards were made — the viewer no longer prefetches neighbours above 24 MP, and the reader page `<img>` lost a redundant `will-change` layer. The broader ideas stay parked: add a pixel budget for originals (dimensions in media tickets, downscaled variant for huge images), shrink reader/viewer preloads, virtualise Catalog/Collections grids, clear `src` on dropped images, and trim on `onTrimMemory`.
## PC-DECLUTTER-001 — PC app declutter (concepts A+B+C, staged)

Status: `VERIFY` — stages C and A, the Artist hub replacement and the Home surface are implemented in `57a4fa85`, `532b7cc0`, `60d4e3a6` and `3a82a445`; the shipped redesign slices are archived in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round). Remaining: native Windows acceptance and any concrete declutter regression. Concepts in `docs/prototypes/pc-declutter-20260924/` remain the design record.
1. **C — Quiet chrome first** (lowest risk, mostly moving things): one top bar merging title bar and list header; one status indicator ("작업 N") opening a single panel for sync, running jobs, review queues and lightweight mode; selection bar that appears only while selecting; merged release notices; Settings › 일반 trimmed to ~7 items with maintenance/diagnostics under 고급 › 복구·진단; experimental/recovery buttons off the character series header.
2. **A — Focused navigation**: rail reduced to 에셋 · 컬렉션 · 망가; everything else via a `Ctrl+K` 이동 palette and 더보기, with review-queue counts shown only when non-zero; Artist/다시 보기는 now separate implemented surfaces.
3. **B — Task-first Home**: the current PC/tablet Home is implemented as the later information dashboard; native acceptance and any follow-up interaction changes remain in `HOME-DASH-001`.
Ideas to carry to mobile (MOBILE-DESIGN-001): single status indicator, zero-hiding queues, neutral filters, search icon only where searchable, conclusion-first settings, continue-watching.

## PC-REVIEW-001 — Fix findings of the 2026-09-25 PC app review

Status: `PARTIAL` — the ten high findings and the 2026-09-26 follow-up fixes are committed; the current residual list below is still open or unverified. The 2026-09-28 Home/calendar work does not close these review items. Native Windows, live-provider and any explicitly marked production checks remain separate. Report: [`docs/research/pc-app-review-2026-09-25.md`](../research/pc-app-review-2026-09-25.md).

The original ten high findings are retained in the linked review report as historical context; the 2026-09-25/26 source fixes are committed. Only the residual or unverified items below are active here.

Fixed 2026-09-26 (Rust/vitest tests; native Tauri, Windows and live-server checks pending):
- Server authority restore: the Asset replica now re-baselines before the Album/Classification lanes (they wait while it is pending), and those baselines keep a released Asset's relations and queue them again, so a re-uploaded Asset keeps its Albums and Classification.
- Skipped mobile character exclusions: durable `skip_reason` on the receipt (migration 0099) and shown in 상태 → 서버 동기화 ("적용하지 못한 모바일 캐릭터 제외 N개 · 최근: …").
- ADR-0039 wording: backup-index session is read-only as a whole; `save_index` copies `index.bin` to `index.prev.bin` first.
- Restore guard: `assets` probe (Asset authority adoption blocks a whole-database restore).
- UI thread: library open no longer holds the library lock while opening (previous runtime is stopped after the swap); trash list/trash/restore/policy commands, scan cancel and the IGDB/TMDB/Aladin/Kakao credential commands run off the UI thread.
- Window focus no longer relays three refresh events in the desktop app (the native pass already wakes on focus and emits real changes).
- A locked drag-out leftover or orphan artwork file no longer stops the library from opening (and no longer fails a finished Collection delete); Windows empty credential blob no longer reaches `from_raw_parts`; the extension token file is created 0600 on Unix and an empty leftover is regenerated.

Still open or unverified: Asset-lane restore/error recovery and relation re-baseline edge cases; repeated content-hash mismatch handling; dropped Asset lifecycle intent detail; non-trash sync work on the UI thread; `empty_trash`/purge lock scope; TrashBrowser retention reset; IGDB screenshot hero labeling; the authority-path purge guard re-review; Aladin/Kakao volume-renumbering retry; in-flight artwork cleanup; long HEVC/ProRes ffmpeg limits; and S36 rollback after a trashed automatic acceptance. Each remains open unless a later source or acceptance record proves otherwise.

## OSS-SCAN-20260926 — Open-source projects worth using (idea)

Status: `HOLD` — the 2026-09-26 survey and sqlite-vec, Chinese Whispers, vPDQ, PixAI and Camie trials are recorded; nothing was installed or adopted. Reopen a bounded trial only for a concrete product need. GPL/AGPL projects are reimplement-only: borrow ideas, never copy code.

Suggested order: sqlite-vec → imgutils-style clustering for `CHAR-AUTO-003` → vPDQ for `SIMILARITY-003` → evaluate the PixAI tagger.

- Vector search: [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) (8.1k★, MIT/Apache-2.0, Rust crate) — kNN over CCIP (later CLIP) embeddings inside the existing SQLite library and on the Python API; brute force is fine at ~9k items. Risk: extension loading on Windows and Linux. Upgrade path for an approximate index (`PERF-SIMILARITY`): [unum-cloud/usearch](https://github.com/unum-cloud/usearch) (Apache-2.0, Rust/Python, memory-mapped).
- Character discovery: [deepghs/imgutils](https://github.com/deepghs/imgutils) (414★, MIT) — source of the CCIP model already used; has CCIP/LPIPS clustering built in. Use it as the reference for `CHAR-AUTO-003` instead of julyx10/lap.
- Tagging: [PixAI tagger](https://huggingface.co/pixai-labs/pixai-tagger-v1.0) (Apache-2.0; ONNX `deepghs/pixai-tagger-v0.9-onnx`) — v0.9 ~13.5k Danbooru tags, v1.0 lists 30,877 incl. 8,308 characters (model-card dates inconsistent, unverified). Could propose characters with no references yet and back up the CCIP kNN. Medium effort (sidecar model + thresholds).
- Similar videos: [facebook/ThreatExchange](https://github.com/facebook/ThreatExchange) vPDQ/TMK (~1.4k★, BSD) — per-frame PDQ with a shared-frame match rule, reuses the existing PDQ code; best fit for `SIMILARITY-003`. References only: [qarmin/czkawka](https://github.com/qarmin/czkawka) (33.7k★; core MIT, Krokiet/Cedinia GUIs GPL-3.0) and [Farmadupe/vid_dup_finder_lib](https://github.com/Farmadupe/vid_dup_finder_lib) (25★, small, similar-length videos only).
- In-process inference: [pykeio/ort](https://github.com/pykeio/ort) (2.5k★, MIT/Apache-2.0, ONNX Runtime) — run CCIP/tagger/CLIP inside the desktop app and eventually retire the Python sidecar. High effort (packaging on both platforms).
- Manga metadata: [Snd-R/komf](https://github.com/Snd-R/komf) (713★, MIT; ~14 providers incl. MangaUpdates, AniList, MAL, BookWalker, MangaDex, Bangumi, Webtoons) and [keiyoushi/extensions-source](https://github.com/keiyoushi/extensions-source) (4.7k★, Apache-2.0; Mihon source parsers; Kakao source not confirmed) — references for catalog metadata and release tracking.
- UX references (AGPL/GPL, ideas only): [immich-app/immich](https://github.com/immich-app/immich) (115k★) timeline scrubber, "N years ago" memories, face-cluster merge and duplicate review (`IDEA-002`, `STATS-001`); [stashapp/stash](https://github.com/stashapp/stash) (13k★) scrapers/plugins, fingerprint matching, performer pages (`LONG-001`, `ARTIST-001`); [julyx10/lap](https://github.com/julyx10/lap) (3.1k★, same Tauri+Rust+SQLite stack).
- **Second scan 2026-09-26 (read-only; stars/licences from the GitHub API that day).** Top 5: [Litestream](https://github.com/benbjohnson/litestream) (Apache-2.0) — continuous SQLite replication of the VPS Cloud API DB to R2 with point-in-time restore (ops sidecar, no app code); [es-hangul](https://github.com/toss/es-hangul) (MIT) — 초성/jamo search and romanization in the desktop and tablet frontends; [fast_image_resize](https://github.com/Cykooz/fast_image_resize) (Apache-2.0) — SIMD thumbnail resize (measure first); [ThumbHash](https://github.com/evanw/thumbhash) (MIT) — ~25-byte blurred placeholders for tablet tiles before thumbnails decode; [Lindera](https://github.com/lindera/lindera) (MIT, + young `lindera-sqlite` FTS5 tokenizer) — Korean/Japanese morphology for title/notes search. Also: yet-another-react-lightbox / PhotoSwipe (MIT) for the tablet viewer; jxl-oxide (JPEG XL decode, if needed); ffmpeg-sidecar (MIT) for preview sprites and vPDQ frames; rusqlite_migration only if hand-rolled migrations hurt; manga-ocr (Apache-2.0) and comic-translate (Apache-2.0) for Japanese image-text OCR/translation (manga-image-translator is GPL → ideas only); realcugan/Real-ESRGAN ncnn binaries for cover upscaling (Upscayl AGPL → ideas only); KGen/TIPO (Apache-2.0) tag-to-prompt expansion and a1111 tagcomplete CSVs (MIT) for the NAI app dictionary; restic/kopia/rclone for library backups to R2 (ops; production runs need approval). Not recommended: cr-sqlite/sqlite-sync (server authority already solves sync; sqlite-sync is ELv2), aesthetic-predictor-v2-5 (AGPL, inactive).
- No strong Android-specific candidate found (AndroidX Media3 for native playback is an unverified assumption).

## AI-JEV-002 — Jev for text candidate decisions (idea)

Status: `IDEA` — noted 2026-09-26 at the user's request; not started. Jev (TypeSafe AI) takes structured text evidence and typed choices, so it fits text candidate decisions better than the visual character task evaluated in [the 2026-09-21 note](../research/character-autonomy-and-jev-direction-20260921.md) (`AI-JEV-001`, removed earlier). Candidates, best first: (1) choosing the MangaDex/Kakao/IGDB/TMDB match when connecting a Collection — past manual choices are ready ground truth; (2) ambiguous catalog duplicate-edition pairs (same work / other edition / unsure) to shrink the tablet review queue; (3) mapping Kakao/Aladin release volumes to owned volumes; (4) suggesting a classification folder for saved X posts from text/hashtags/creator; (5) ledger category suggestions. Before starting: recheck the API contract and pricing, get the user's consent for sending titles/authors (metadata only, no images), and run shadow mode against a deterministic baseline; adopt only on a measured gain.

## TRANSFER-REVIEW-001 — Deferred findings of the 2026-09-26 transfer-path review

Status: `TODO` (low priority; single-user setup makes them unlikely). Fixed: outbox identity (`5b7c5c2`), exchange retries and crash-safe receive (`8443890`), bind recheck at commit and similarity withdrawal across pages (`f4a5672`), tablet thumbnail revision (`5b7c5c2` + server `4209a38`), and the second-pass upload/page/ZIP bounds (`0c2b7118`). Live R2 verification and the remaining design edges below are unverified:
- Exchange upload bound to the reserved length: the presigned PUT now signs `Content-Length` (the declared size), so storage refuses any other body length; the HEAD size check at completion stays as the backstop. Not yet verified against live R2.
- Exchange inbox pages: `GET /v1/exchange/inbox?after=<nextCursor>`; every response carries `nextCursor` (`null` on the last page), and a request without `after` still gets the oldest 100, so old clients are unchanged. The PC client and the tablet follow the cursor (up to 20 pages); the PC sweeps orphaned part files only after a complete listing.
- Desktop ZIP creation enforces the 2 GiB cap per copied chunk, before writing the chunk that would pass it.
- Exchange orphan cleanup resumes each sweep after the last key the previous sweep listed (`StartAfter`, kept in memory by the sweeper, wrapping to the start after the last page).

Remaining:
- Catalog duplicate decisions are scoped by server address only; a `libraryId` on `/v1/mobile-catalog/duplicates` and its decisions route would scope them per library.
- Similarity-review withdrawal accepted after the PC read the log but before the next feed PUT still leaves the image in Library Trash (known design edge).

## SERVER-REVIEW-20260924 — Remaining judgment calls of the Cloud API review

Status: `TODO` (low priority; single-user setup). From [`docs/research/server-review-2026-09-24.md`](../research/server-review-2026-09-24.md) §3; items 1, 2, 4 and 7 were fixed in `39d9ed02` (2026-09-24), and item 3 is implemented/deployed with the 0.8.42 client path. Remaining:
- 3: the source and recorded deployment cover the similarity-kept trash refusal; broader native/production re-verification is unverified.
- 5: a legacy Collection memo over 10,000 characters answers 422 instead of a conflict (unreachable unless legacy data exceeds the old limit).
- 6: `mobile_collection_edits`, `mobile_collection_edit_noops`, `mobile_character_review_decisions` and `mobile_similarity_review_decisions` have no retention.
- 8: the shared legacy token can send `trashAsset` / `restoreAsset` (matches the design; noted only).
- 9: structural commands parse the body before the role check, so a client-role caller sees 422 vs 401 (cosmetic).

## PERF-ALL-001 — Whole-app benchmark and optimization pass

Status: `PARTIAL` — the benchmark and optimization batches are implemented; migrations `0114` and `0115` add Home continuation/favourite and release-port tracking, but the remaining shared product work is moving PC sync state out of `notes_state` at a future migration. Tablet connectivity callbacks, one-request Library pages, the R2 video path, `list_albums` join, lightweight-mode gates and the dated request reductions are already covered by the recorded commits and later builds. Windows/native checks and fresh render/interaction measurements remain unverified where they are not covered by the user checks. The source and migration slices are recorded in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round).

Lightweight-mode audit 2026-09-27: the exchange poll and PC Home S36 candidate count are now gated by `bf40389`; the audit was code-only and measured cost remains unverified.

Apply `docs/agents/implementation.md` → "Performance work" across Lakomics, one user-visible path at a time: measure on the real platform first, gate with deterministic metrics (render/commit counts, query counts, bytes, request counts, instruction counts), confirm each metric tracks real latency, then lock wins with tighten-only thresholds. Candidate paths: PC Library open/scroll and viewer, character and similarity screens, Collections/Works; Android Library/viewer (instrumentation `LakomicsPerf` + `android/tools/perf_summary.py` exists), Catalog, cold start; Cloud API hot endpoints (`tools/poll_benchmark.py` exists) and idle request volume per client; Rust indexing/ingest. Start by listing the paths with their current numbers, then pick the worst.

Folded-in scope (2026-09-26; completed portions are archived):
- Battery: further Android reduction after 0.8.6 (`f25ddd8`) — polling, thumbnail warm-up, background work.
- `PC-POLL-002` (remaining desktop pollers) and `BIND-POLL-001` (tablet connect-request pickup) — archived as done.
- Re-verify lightweight processing mode (`05b18b6`) against everything added since — source gate is present; measured acceptance is unverified.
- Covers load slowly right after the app starts (USER-REQ-20260926) — bounded warm-up fix is archived; reopen only for a new measured regression.
- Move PC sync state kept in `notes_state` (Collections release sync, personal-edit v2 receipts, binding sync) into a proper table at the next planned migration (0098).

# Future-work notes — 2026-09-21

User-requested notes for later work, not an implementation start or priority change. Related entries below retain their existing status; these notes clarify or extend the requested scope without marking anything delivered.

## Mobile app

- **(Closed 2026-09-24: current physical-cover 3D is enough) Collection 3D model viewer:** view actual 3D models in Collection, rather than merely giving covers a 3D presentation. This clarifies the earlier `MOBILE-UX-001` 3D feasibility question; renderer and supported formats remain undecided.
- **(Done 2026-09-26, [archived](lakomics-completed.md#collections-release-notifications-and-the-tablet-신간-screen)) New-release notifications:** Collections only, in-app.
- **(`DROPPED` 2026-09-27, user: no on-device duplicate discovery on the tablet; reviewing PC-discovered pairs stays) Asset duplicate checking:** make duplicate checking available in the mobile Asset Library. Build on the completed desktop `SIMILARITY-004` discovery where relevant; keep this distinct from Catalog edition duplicates.
- **(Done 2026-09-26, [archived](lakomics-completed.md#manga-catalog-duplicate-edition-checking)) Manga Catalog duplicate-edition checking.** Follow-up gaps: no server `origin` field to label automatic decisions on mobile; `includesServerWorks` unused; desktop decisions are not reported to the server; a decision-log restart replays old decisions.
- **Asset Library multi-select move:** select multiple assets and move them together. Clarified 2026-09-24: both targets — add to albums and change classification (folders). Coordinate with `MOBILE-WRITE-002`; the destination and move semantics remain to be defined.

## Shared — Desktop and mobile

- **(Implemented 2026-09-28; archived in the [2026-09-28 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-28--home-artist-release-calendar-and-tablet-parity)) Artist rediscovery on Home:** the PC and tablet now expose `오늘의 작가` / `작가 다시 보기`; future artist improvements stay in `ARTIST-001`.
- **(Deferred 2026-09-24: hope S36 improves it; revisit later) Competing character candidates in multi-person images:** improve the competing-candidate system when one image contains multiple people. Track as a bounded follow-up to the accepted character-classification pass, not a reopening of all accuracy work.

## Browser extension

These follow-ups apply to the active collector in `extension-list/` and relate to `EXT-011` / `EXT-012` (both closed 2026-09-23 and archived); they remain pending requests of their own.

- **(Done, user-confirmed 2026-09-24) Animation polish:** refine the semicircle menu's entrance and roulette-spinning animations for a more professional presentation.
- **(Done, user-confirmed 2026-09-24) Selection feedback:** improve the extension menu's visual selection effects.
- **(Done, user-confirmed 2026-09-24) Twitter/X GIF downloads:** support downloading GIF media from Twitter/X posts.

## Suggested implementation sequence — retained for later selection

Recorded at the user's request after the backlog review. This is a recommendation, not a replacement for Current priority / Current execution order, an activation of HOLD items, or authorization to implement or deploy. Existing item statuses remain unchanged.

Suggested first sequence:

1. **Extension polish:** refine entrance, roulette and selection effects. (The persistent-semicircle-after-navigation bug was confirmed resolved by the user on 2026-09-23.)
2. **Mobile multi-select move:** define album-membership changes versus actual folder/file moves before implementation; coordinate the chosen write scope with `MOBILE-WRITE-002`.

Mobile tab switching and `SIMILARITY-004` from the original sequence were completed on 2026-09-23. If prioritizing everyday usability, start with extension reliability.

Other follow-up candidates, without a fixed order:

- **(Done, user-confirmed 2026-09-24) Twitter/X GIF downloads:** inspect the current extraction/save path and add the missing support.
- **(Done 2026-09-26) New-release notifications:** Collections release inbox and 신간 screen, in-app only.
- **Mobile Asset duplicate review:** expose candidate inspection and decisions separately from the discovery operation above.
- **(Done 2026-09-26) Mobile Manga Catalog edition review:** 중복 판본 검토 in Android 0.8.18.
- **(Closed 2026-09-24) Collection 3D model viewer:** decide supported model formats, touch interaction and device performance limits; this is not the existing physical-cover renderer.
- **Multi-person character competition:** collect concrete mistakes and improve the affected arbitration cases without reopening the entire accepted classification pass.
- **Film Collection polish (`WORKS-001`):** implemented and accepted; archived in the 2026-09-26 checkpoint.
- **AV metadata and cover acquisition (`LONG-001`):** fetch candidates and let the user choose artwork without silently replacing manual choices.

Keep larger foundation work separately scoped: durable mobile metadata (`MOBILE-CACHE-001`), additional mobile edit domains (`MOBILE-WRITE-002`), remaining Character/Collection ownership and publication cleanup (`CLOUD-POST-001`), server-owned jobs with PC workers (`CLOUD-WORK-001`), and safe global deletion (`MOBILE-003`). This recommendation does not restart completed authority rollouts or promote deferred architecture work.

Do not count implemented flows awaiting acceptance as new feature builds: PC-off Capture, early Asset visibility during classification, existing extension flows, similar-video sample validation and statistics verification. Catalog refresh retains its bounded acceptance/grouping-reconciliation scope. New extension bugs and feature requests above remain separate pending work. Optional providers, clustering/Jev experiments, large-scale similarity indexing and date-timeline exploration remain lower priority or deferred under their existing entries.

### First recommended batch — extension reliability and interaction polish

Planning checkpoint, 2026-09-21: source inspection only; no implementation, browser reproduction, device acceptance or deployment. This expands recommendation 1 above without changing the existing priority list; `EXT-011` / `EXT-012` were later closed on 2026-09-23.

Subsequent visual study: [three One UI-inspired concepts](../prototypes/collector-one-ui-concepts/index.html) and [comparison image](../prototypes/collector-one-ui-concepts/overview.png) present A — Everyday Light, B — Midnight Edge, and C — Soft Orbit. All show a separated center, spaced rounded sectors and the same selected folder. The standalone prototype only previews local selection; it performs no saves or network requests and does not implement dial motion or production lifecycle behavior. Headless Chrome rendering at 1680×1100 was inspected and JavaScript syntax checked. This is not live-extension, touch, animation or navigation-bug acceptance. The user subsequently chose B's dark appearance as the refinement base, not as production acceptance.

Refined B visual prototype: [interactive root-screen study](../prototypes/collector-one-ui-concepts/b-refined.html), [ordinary selected folder](../prototypes/collector-one-ui-concepts/b-refined.png), and [selected branch folder](../prototypes/collector-one-ui-concepts/b-refined-branch.png). Save and Temporary save now share one continuous central panel; checkmarks, branch chevrons and repeated destination text are removed. At the user's subsequent request, the central text labels are replaced by coordinated outline icons: folder-with-inward-arrow for Save and download-to-tray for Temporary save, retaining accessible action names and keyboard controls. Character and Game sectors expose a second surface behind the front face. Headless Chrome renders at 560×1080 were inspected in both selection states; focused jsdom checks passed for six sectors, two layered branches, mouse/keyboard selection, selected-branch styling and preview-only actions. The original three concepts remain intact. This is still a local prototype: no actual saving, dial rotation, production extension changes or device acceptance. The following motion checkpoint adds fixture child navigation to the previously static study.

Motion checkpoint, 2026-09-21: the user accepted the refined visual direction and requested entrance, save and child-navigation animation without perceived waiting. The same HTML now loads `b-refined.js`: entrance is 140 ms, child/Back transitions are 110 ms, and simulated successful-save dismissal runs for 100 ms alongside icon feedback. Selection and navigation state change synchronously; no action awaits animation completion and new input replaces in-flight effects rather than queueing. Single tap selects, double tap or ArrowRight opens fixture children, and the lower central action becomes Back inside folders. The standalone Replay control can interrupt dismissal; reduced motion skips effects while preserving actions and cleanup. Actual save success must remain receipt-driven when integrated, not inferred from an animation.

Verification: `node --test docs/prototypes/collector-one-ui-concepts/b-refined.test.mjs` passed 11 tests covering immediate interaction, nested navigation/Back, icon-only actions, simulated saves, stale-completion protection, reduced motion, gap dismissal and page departure. A bounded headless Chrome check observed real Web Animations progression, immediate selection during entrance, child-transition timing, simultaneous dismissal, interrupted reopening and reduced-motion behavior with no runtime exceptions. Root and [mid-transition child](../prototypes/collector-one-ui-concepts/b-motion-child.png) renders were inspected at 560×1080. This validates the local motion prototype, not the live extension navigation bug, production saves or Galaxy Tab touch feel.

Smoothing follow-up: the user found child navigation abrupt. Source inspection showed immediate removal of the old sector tree followed by a 70%-opaque incoming page over 110 ms. The prototype now keeps one non-interactive, accessibility-hidden outgoing snapshot for a 140 ms fade and crossfades the new page in over 180 ms with no ring translation. Incoming controls still activate synchronously. Rapid navigation replaces the outgoing snapshot rather than stacking pages; replay, reduced motion, save completion and page departure clean up the snapshot. Entrance and save durations remain unchanged. A new regression check failed against the previous immediate-removal implementation, then all 14 focused tests passed after the change. Bounded Chrome checks confirmed both layers at intermediate opacity, immediate selection during the crossfade, interruption cleanup and reduced motion without runtime exceptions; the 70 ms transition frame was inspected. Perceived smoothness on the user's device remains a user acceptance check.

Implementation checkpoint, 2026-09-21 (`extension-list/` 3.0.0.30): the user approved the refined B motion and explicitly expanded this batch to include X GIF-like media. The active renderer now uses dark rounded/separated sectors, rear branch layers and one icon-only central panel (upper Save, lower Temporary/Back). Entrance is 140 ms; folder navigation crossfades one inert outgoing snapshot for 140 ms with immediately usable incoming controls over 180 ms; confirmed-success feedback and exit run concurrently for 100 ms. Reduced motion skips these effects and dial coasting. Existing live hierarchy, pins/order, rotary overflow, explicit-save and opening-release behavior remain intact.

The controller now observes navigation for armed, pending and open invocations, with unconditional disposal even while locked or saving. Navigation API commits and page departure are handled directly, with history/hash events and a session-scoped URL poll on older browsers. Late state/save/unlock callbacks cannot take ownership of a newer menu; an accepted save is not resubmitted or reported as cancelled. The source-level cause was missing navigation teardown combined with guarded ordinary dismissal. The user's exact live X incident has not been reproduced on their device.

X progressive MP4 resources exposed by a mounted player or its `source` child are retained; otherwise the worker resolves the selected media through the existing public endpoint. Mixed-media ordinals, nested players, avatars/posters and quote boundaries are covered, and unavailable selected media never falls back to a different video. X animations served as MP4 retain MP4 bytes and the existing `video` capture contract; actual GIF handling remains supported. PC temporary downloads accept these X videos; Android's image-only temporary intent remains unchanged. No new dependency, permission, backend deployment or production-library write was introduced.

Verification: the combined worktree passed all **160 extension tests** with `npm test`. A bounded headless Chrome fixture loaded the actual renderer/controller and checked both edges, settings preview, rounded hit geometry and the central gutter, immediate controls, real 140/180 ms crossfade progression, interrupted navigation, receipt-gated 100 ms exit, reopening, reduced motion, real Navigation API cleanup while input-locked, and touch-release unlock. Root/left/settings/transition renders were inspected at 560×900 with no runtime exceptions in the final run. This is browser-fixture evidence, not installed-extension, live-server or Galaxy Tab/Titanium acceptance. The supplied post `2100596455262331116` remains unverified publicly; do not infer that it is private or deleted. Reload the extension and collecting tabs to activate this revision. Existing `EXT-011` / `EXT-012` device-acceptance status is unchanged.

The following initial plan is retained as context; the implementation checkpoint above supersedes its prototype-only status and original GIF exclusion.

**Scope and preserved behavior:** active `extension-list/` only. Keep the edge-attached semicircle, six visible folders, fixed central actions, live classification tree and portable order/pins. Preserve single-tap selection, double-tap child navigation, explicit Save, opening-finger protection and Back restoring selection/dial position. The user's subsequent design direction replaces the earlier warm-gray/NieR-like visual treatment with a Samsung One UI-inspired presentation for this extension surface only; it does not redesign Desktop or the Android app. The subsequent user request includes Twitter/X GIF support through existing capture/download contracts. Pairing changes, backend changes, new permissions/dependencies and legacy `extension/` edits remain excluded.

**Inspected baseline:** `src/content.js` owns the gesture/session and asynchronous opening; its scroll/wheel/blur cancellation only resets the armed phase, and it has no collector navigation teardown. `src/arc-collector.js` has internal disposal for DOM, timers and animation frames, but exposes `close` as the guarded `cancel` action, which is blocked while busy or input-locked. This supports a navigation-lifecycle hypothesis, not a confirmed cause of the user's incident. The dial already has continuous position, bounded momentum, friction, late detent capture and stable wedge/label nodes; do not replace it with a new animation engine. The current arc CSS has no entrance/exit transition or reduced-motion branch. Use the active README and manifest as the extension baseline; the older `docs/edge-extension.md` describes legacy UI.

1. **Reproduce and fix navigation cleanup first.**
   - Exercise same-document navigation on X, browser Back/Forward, normal document navigation and page restoration. Cover pending state loading, open idle, opening-finger lock, spinning and in-flight save states; determine which reproduces the report.
   - Select the smallest navigation detection supported by the actual extension/browser context. Do not assume that a content-script History API wrapper observes page-world calls, or that `popstate` covers `pushState` / `replaceState`.
   - Separate ordinary guarded dismissal from unconditional session disposal on navigation. Clear overlay/backdrop, animation frames, timers, pointer ownership, input locks and click suppression; make disposal idempotent and allow the next page to open a fresh collector.
   - Invalidate stale asynchronous opening/UI callbacks so a late result cannot recreate the old menu, close a newer session, steal focus or show stale failure UI. UI disposal must not be described as cancelling an already submitted save, nor trigger a retry/duplicate save; preserve legitimate save results and existing side-effect semantics.
   - Acceptance: navigation leaves no stale menu or input-blocking layer, late state responses cannot reopen it, and the next collection gesture works normally. Ordinary scrolling while an idle menu is open is not navigation.
2. **Redesign the static geometry and surfaces before tuning motion.**
   - User direction: emphasize a polished Samsung/One UI-like system-control appearance rather than the existing NieR-like instrument treatment. This is a visual reference, not Samsung branding, affiliation or verified compliance with an official specification.
   - Separate the central action cluster from the surrounding folder ring with a visible radial gutter. Separate adjacent folder sectors with consistent gaps and soften each sector's corners, retaining the overall semicircular arrangement rather than replacing it with a rectangular grid.
   - Initial visual-study values, not approved device measurements: central-to-ring gutter around 8–12 CSS px and adjacent-sector gaps around 4–6 CSS px at the current tablet size. Adjust against actual label space and touch targets rather than shrinking every control to force these numbers.
   - Refined B direction: keep Save and Temporary save together inside one continuous rounded central panel, not as a detached button below the menu. Give Save the larger primary area and Temporary save a smaller lower area, with a quiet internal gap. Use icon-only central actions: folder-with-inward-arrow for Save and download-to-tray for Temporary save. Keep accessible names and keyboard focus without adding hover tooltips or repeating destination text. Preserve explicit-save safety and the root/child action semantics when adapting this design to the live collector; the current refinement previews the root screen only.
   - Use the selected B direction: graphite/dark-neutral surfaces, readable light labels, restrained elevation and a blue selection accent. Replace beige/olive tones, metallic gradients and heavy machined rims. Keep disabled actions visibly muted; do not add a theme-setting system in this batch.
   - Use consistent, readable labels and preserve folder names. Indicate child folders with a second subtly offset sector surface visible behind the front face, rather than chevrons, counts or new icons. Keep the extra layer within the sector's allocated bounds so gutters remain open; distinguish it from selection through geometry rather than blue color. No Samsung logo, proprietary font acquisition or new icon dependency.
   - The current sectors use polygon clip paths: rounded outer corners on the button alone will not round each wedge. Choose the smallest geometry change that actually produces rounded, separated sectors while retaining node reuse and matching hit areas.
   - Gaps inside the menu envelope must not select a neighboring folder, submit media, dismiss the menu accidentally or click through to the page. Preserve deliberate outside dismissal and usable ring dragging. Check both left and right edges, long Korean/Japanese names and the settings preview.
3. **Define selection, press and keyboard-focus feedback.**
   - Refined B default: quiet dark-neutral sector; hover: subtle tonal change on mouse devices; press: immediate restrained feedback without moving hit targets; selected: blue surface, stronger label weight and a subtle inner edge. Remove selection checkmarks. Keep a separate visible keyboard-focus treatment, including the runtime label overlay outside the clipped sector.
   - Keep the chosen folder obvious even after pointer release and during rotation without permanently repeating its name inside the central Save button. Before live integration, resolve destination visibility when the selected sector rotates out of view; the static prototype does not exercise this case.
   - Distinguish selected, focused, disabled and saving states. Maintain accessible names, `aria-pressed`, contrast and opening-release protection; animation must not delay selection or trigger saving.
4. **Add restrained entrance and dismissal motion.**
   - Initial tuning proposal: 120–160 ms entrance with a small inward movement from the chosen edge and opacity; 80–120 ms ordinary dismissal. Aim for a smooth system panel, not a theatrical roulette reveal. No bounce, overshoot, staged folder reveal or long input delay.
   - Keep left/right mirroring separate from the animated transform. Navigation disposal is immediate and must never wait for `animationend` / `transitionend`.
   - Reduced motion removes positional animation and avoids delaying cleanup. Do not animate every settings-preview render.
5. **Refine the existing roulette/dial feel.**
   - Retain continuous direct manipulation, bounded momentum and late nearest-slot settling. Tune acceleration/deceleration from observed wheel, trackpad and touch behavior rather than merely increasing speed or adding exaggerated rotations.
   - Keep the central buttons stationary; separated sectors and their labels travel together without popping, clipping or changing selection identity. Preserve Back restoration, short lists and overflow behavior.
   - Stop animation work when settled or disposed. Reduced motion should retain direct manipulation but avoid prolonged post-release coasting. Verify interruption by a new drag, direction reversal and navigation; preserve no-save/no-selection behavior after a drag.

**Execution and verification:** implement in the numbered order, starting with a regression reproduction for navigation and then a static visual pass before motion tuning. Expected source scope is `extension-list/src/content.js` and `extension-list/src/arc-collector.js`, plus the active README and focused tests as needed. Use `node --test tests/content-gesture.test.mjs tests/controller.test.mjs tests/arc-collector.test.mjs` from `extension-list/` for lifecycle/interaction changes; add cases for navigation during pending opening, locked/busy states, late callbacks and fresh reopening. Geometry changes also need real rendered/hit-area inspection, not just DOM assertions. Inspect default/selected/pressed/focus/disabled/saving states, left/right layouts, rotation and reduced motion. Check Desktop Chromium and Galaxy Tab/Titanium separately; fixture success cannot establish native touch or live capture acceptance. Any save acceptance that writes production data requires its own authorization. No tests or visual runtime checks have been run for this planning checkpoint.

# Mobile portrait usability feedback

## MOBILE-UX-001 — Portrait real-use follow-up

Status: `PARTIAL` — the browse-first redesign and later Catalog/Notes/Home parity work are shipped through Android 0.8.85, including the 에셋 port recorded in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round); the tablet's earlier release and acceptance records remain in the 2026-09-28 checkpoint and `android/README.md`. The 0.8.85 confirmation covers the 에셋 port only. Remaining: landscape two-pane Library, older dimension/duplicate-check evaluations, 3D model files and classification-capacity investigation. The 3-column root card option is dropped.

- `HOLD` 2026-09-28 (user): landscape layout is on hold — the need is not clear yet. Discussed reasons to turn the tablet: wide content (video, landscape art), two-page manga spreads, a stand/keyboard setup, split screen (each app becomes a narrow portrait-like window), comfort. If it returns, start from which of these the user actually does; a two-pane Library only helps long browsing sessions.

2026-09-19 Galaxy Tab feedback after the first portrait UI pass. These are user-reported observations and requested improvements, not independently reproduced defects or confirmed root causes. Keep portrait as the priority; landscape redesign remains later.

- **New-asset thumbnails missing on mobile, including after PC startup:** the initial report associated missing thumbnails with the PC app being off, but the user subsequently reports that starting the PC app still does not make new-asset thumbnails appear on mobile. This supersedes the assumption that running PC resolves the symptom; the initial report alone did not establish a root cause. The affected-asset trace and subsequent image-only server fix are recorded below. Verify real tablet rendering separately from server generation and delivery. The current media-delivery scope was subsequently accepted under archived `MEDIA-R2-001`; extra media variants are not required by this report. If a new ingest or worker dependency is demonstrated, coordinate with `CLOUD-INGEST-002` / `CLOUD-WORK-001`; this report does not authorize those broader migrations.
- **Asset Viewer information-panel design:** reorganize the panel for compact portrait use, reducing wasted space and redundant text while keeping the asset visually primary.
- **Asset Viewer information parity and copying:** the panel exposes less information than PC. Compare the actual PC/mobile fields and make useful missing information available on mobile. The first implementation copies creator text, the source URL, and a file-information summary; binary asset copying is not included.
- **Asset dimensions on the server:** include the asset's pixel width and height in server-backed metadata so mobile can display dimensions consistently with PC, including when the PC app is not running after synchronization. Trace existing extraction, synchronization, API and mobile presentation fields before deciding what is missing; no missing schema or confirmed transport defect is asserted yet. Coordinate with the Viewer information-parity item. Any production metadata backfill requires separate approval.
- **Sidebar folder-type icons:** add distinct icons for Character folders and Group folders so their types are recognizable at a glance.
- **Nested-folder selection highlight:** the user reports that the white selected-state highlight overlaps the line below the folder's `>` marker. The proposed direction is to limit the highlight to the folder-icon area so it does not overlap the hierarchy line; confirm the exact visual bounds against the current UI or a screenshot before implementation.

- **Character-folder thumbnail cropping:** the user reports that Character-folder thumbnails are too wide and appear cropped. Inspect the portrait container aspect ratio and image-fit behavior, then adjust the presentation to keep the character recognizable without distortion. The exact crop/container cause has not been verified.
- **Character-folder Back destination:** after entering a Character folder and going back, the user lands in a category labeled Series, whose purpose is unclear and which the user considers unnecessary. Reproduce the entry/return path and identify whether Series is an intentional parent screen, an exposed internal grouping, or an incorrect navigation fallback. Check both in-app and Android Back because the reported Back mechanism is unspecified. Prefer returning to the actual prior browsing context without an unnecessary intermediate screen; do not remove underlying classification data based on this UI report. Cause and intended destination remain to be verified.
- **Catalog hidden-tag controls:** place PC-style excluded-tag entry in a dedicated Catalog settings panel opened from a top-bar icon. A namespaced entry such as `female:scat` hides works carrying that tag; it is not a title substring exclusion or an ordinary search term. Trace PC matching/normalization and shared-policy ownership before adding writes, preserving namespace semantics and avoiding PC/mobile overwrite conflicts.
- **Catalog category controls:** replace the first-pass single-category selector with a checklist in the same Catalog settings panel, using existing PC categories. The user can include several categories at once, such as Doujinshi, Manga and Artist CG; selected categories combine with OR, then intersect with the search and exclusion policy. Do not require category query syntax or leave a separate category-filter row in the gallery. Preserve the chosen settings across searches. Define all/none selection and storage/sync behavior explicitly during implementation.
- **Catalog automatic refresh cadence:** the user subsequently requested a one-hour interval. The server-side incremental scheduler is implemented and tested in the later checkpoint below; deployment remains pending. Distinguish provider ingestion from mobile publication detection and bookmark polling.
- **Catalog duplicate checking (evaluation):** the user asks whether the PC's duplicate-check feature can be brought to mobile and suspects it may depend on a running PC. Trace the existing Catalog duplicate-check data and execution dependencies, distinguish already-known results from newly computed checks, and assess PC-off support before choosing an implementation. Neither the dependency nor mobile feasibility is confirmed; do not conflate this with general near-duplicate similarity scanning.

### 2026-09-20 next portrait pass: requested scope

The following records the requested scope; the implementation checkpoint below
identifies delivered source versus still-open investigations. The user's attached
PC sidebar screenshot is the visual reference. Keep artwork
primary, controls compact, and landscape redesign deferred.

1. **Catalog settings and search:** use the top-bar settings icon and category/hidden-tag contracts above. Make ordinary space-separated input find the same relevant indexed names/tags as underscore-separated input; reproduce the failing query path before changing parsing. Preserve explicit namespaces, quoted expressions and operators rather than blindly replacing all spaces with underscores. Verify category inclusion, excluded tags, pagination/counts and search together, not just the first visible page.
2. **PC-aligned mobile sidebar:** use the screenshot's compact hierarchy, separators, folder rows and consistent icon language as a reference without mechanically shrinking desktop hit targets. Remove the Recent saved tab and make All the default destination, retaining chronological access through the existing All ordering rather than deleting recent assets or metadata. Reproduce and correct malformed Album icons. Reuse the PC icons and corresponding semantics for expanding only the selected folder, collapsing all folders and related tree controls; inspect the PC actions instead of guessing from glyphs. Preserve the earlier selection-fill and direct Character Back fixes.
3. **Collection long-text balance (design):** titles and creator/studio names that exceed two lines currently disturb the visual balance, per the user. Inspect actual card layouts and representative long Korean/Japanese/Latin values. Evaluate a consistent reserved title area (for example, two lines), a bounded secondary creator line and full text on the existing detail surface. Do not shrink text per item, introduce hover-only disclosure or change cover proportions merely to accommodate a long name. The exact layout remains a design decision, not accepted implementation.
4. **3D feasibility (investigation):** assess the intended use before choosing a renderer: displaying actual 3D model assets and giving Collection covers a 3D presentation are different scopes. Evaluate Android WebView/device GPU compatibility, memory, battery, loading and a usable static fallback. No engine dependency, per-card live 3D contexts, asset conversion pipeline or server rendering is approved by this record.
5. **Character classification server load (investigation):** locate where current inference, reference embeddings, matching and result synchronization actually execute; do not assume all classification runs on the VPS. Separately estimate/measure whether server-side execution is viable on the existing small server, including model residency, CPU/GPU needs, concurrent work and impact on the API. Thumbnail-generation success does not establish classification capacity. Do not migrate inference or run a production classification/backfill workload merely to evaluate it.
6. **Settings-window cleanup:** audit the mobile settings window end to end and retain settings for currently used, functioning features. Consolidate duplicates, remove obsolete or nonfunctional placeholder controls, reduce redundant explanation, and keep context-specific Catalog options in Catalog settings rather than duplicating them globally. Trace actual consumers before removing an apparently unused option. Preserve necessary connection/authentication, security, data-safety and recovery controls in an appropriately compact secondary section; do not delete saved configuration or user data as part of UI cleanup. This is a mobile cleanup request, not blanket permission to remove PC settings or their underlying capabilities.

Suggested implementation order: Catalog settings/search, sidebar and global settings
cleanup, then Collection typography. Keep the 3D and classification-capacity questions
as bounded investigations rather than coupling them to these UI changes. Previously
open dimensions, duplicate-check evaluation, video/GIF thumbnails and real-device
interaction acceptance remain tracked; this pass does not mark them complete.

### 2026-09-20 next portrait bundle: source checkpoint

- **Catalog settings:** a single contextual top-bar button opens the shared dialog. Category checkboxes combine with OR; unrestricted/all is the default, an empty selection returns no works, and several categories can be included together. A single `namespace:value` input, such as `female:scat`, adds exact namespaced avoidance tags. Apply commits the draft once; opening, cancelling or applying unchanged settings preserves browsing state and unsent search text.
- **Ownership:** display preferences are stored on this device, scoped to the configured endpoint. They do not write `/visibility` or synchronize settings back to PC. The published PC policy still applies unless the existing explicit reveal option is used; device exclusions still apply when revealing that policy. New additive read parameters are advertised by `capabilities.displayPreferencesVersion:1`. An unsupported server keeps legacy browsing when no local filter is active; saved filters are never silently ignored, and capability-check failure has a retry action.
- **Server query:** categories and avoidance tags constrain eligibility before grouping, counts, pagination, detail, editions and reader access. Filtered queries bypass baked pages/counts and retain the conditions in signed tokens. JSON filter, normalized-query and native-path bounds prevent oversized preferences from breaking page navigation. No new write authority, catalog replacement or production backfill is introduced.
- **Search:** opt-in `searchMode=mobile` allows a whole plain phrase such as `john doe` to match exact tags stored as `john_doe` or `john doe`, with the same convenience for `artist:john doe`. The existing title-word branch remains; underscores and percent signs do not become SQL wildcards. Explicit operators/quotes retain their grammar, with separator aliases only on exact tag values. Clients omitting the mode retain the previous parser.
- **Sidebar/global settings:** Library starts at All; the redundant Recent saved sidebar entry is removed (the separate Home destination remains). Nested indentation and selection stay outside the expander/connector; Album appearance uses PC icon/color mappings. Collapse-all and current-path actions use the PC glyphs. Connection editing is collapsed when configured, while authentication, private-network security, media-cache operations and picker recovery remain available.
- **Collection/Viewer:** cards reserve a two-line title area and keep creator/studio text on one ellipsized line. The existing detail view exposes full names. Viewer information avoids a duplicate section/row heading while retaining values, copy actions and nested Back behavior. Cover proportions are unchanged.

Verification on the local checkout: the full mobile suite passed **293 tests / 26 files**; two subsequent publication-check regression tests were added, and that focused file passed **3 tests**. Mobile TypeScript/Vite production build passed. The real SQLite query suite passed **30 tests**, including the shared PC fixture, exact tag aliases, literal wildcard characters, prepared/fallback eligibility, counts and editions. The final HTTP/cursor suite could not import because local Python lacks `fastapi`; syntax checks passed, but HTTP acceptance is **not** claimed. Earlier worker results do not establish acceptance of the final rewritten query implementation.

Rendered fixture checks covered 390x844 and 800x1280 portrait and 1280x800 landscape. Final Catalog-dialog checks confirmed 11 initially checked categories, one tag input, visible Apply actions, no horizontal overflow and no runtime exceptions. Collection long-text and nested-sidebar screenshots were also inspected. These are browser fixtures, not Galaxy Tab, live Catalog or native acceptance. No new server deployment, APK build/install, Git commit/push or production-library write was performed for this bundle. Next operational step: separately authorize final server API verification/deployment and APK delivery, then accept the portrait interactions on the tablet.

### 2026-09-20 authorized API rollout and APK delivery

This operational checkpoint supersedes the source checkpoint's pending deployment/build/install and missing-FastAPI verification gaps, not its remaining real-device interaction gaps.

- **Server tests:** 71 final Catalog/filter/search/replica/refresh tests passed in 4.669 seconds in an isolated remote stage, using the existing production venv and live dependency modules. No production configuration, database or startup was loaded by those tests.
- **Deployment:** only `mobile_catalog.py`, `mobile_catalog_query.py` and `mobile_catalog_replica.py` were replaced after baseline/candidate SHA-256 verification. Rollback source copies and a SQLite online main-database backup (`quick_check=ok`) remain at `/home/linuxuser/lakomics-catalog-release-20260920/rollback-064`. Existing thumbnail code and `app.py` stayed unchanged; dimensions were not deployed. The API and existing HTTPS local proxy ended active/running with `NRestarts=0`.
- **Read-only live acceptance:** public tailnet HTTPS health/status returned 200 and advertised `displayPreferencesVersion:1`. Legacy browsing and pre-deployment cursors/detail contexts still worked. Empty categories returned zero items/count; multiple categories plus avoidance tags supported list/count/pagination/detail/editions. Empty-category detail access returned 404; unauthenticated status returned 401. A real artist query returned identical nonempty results for underscore and space spellings. Representative filtered pages took 2.0–2.2 seconds, count about 1.0 second and alias searches about 1.0 second; no sustained capacity claim follows. Publication `ba0e4c2bc7558bee67db0b386a0cfc90108ea5437c39e83510124e76629a1795`, its policy revision and publication count remained unchanged by these checks. No refresh, catalog backfill or production-library write was performed.
- **APK:** 0.6.4 (20), 1,246,628 bytes, SHA-256 `79619ce24f82f6fceca652b96f9402a7720d507d3117ef617a0aeccc4fc53279`. Mobile TypeScript/Vite and native release build passed, including existing native regression checks; alignment and v2/v3 signatures matched the existing installation identity. Settings version checks passed 8 tests.
- **Galaxy Tab S11:** target `SM-X730` was verified, in-place `adb install -r` succeeded, package metadata confirmed 0.6.4 (20), and `am start -W` reported `Status: ok` with the process alive afterward. No uninstall, data/cache reset or credential replacement occurred. Another app was foregrounded during subsequent inspection, so no further UI manipulation was attempted. This confirms installation/startup only, not the new portrait controls' visual/touch acceptance or end-to-end authenticated browsing.
- **Still open:** tablet acceptance of the Catalog dialog/search, nested sidebar controls, Settings and Collection/Viewer polish; the separately tracked dimensions, duplicate-check, video/GIF, 3D and classification-capacity work. No Git commit/push was performed for this bundle.

### 2026-09-20 icon cleanup delivered as 0.6.5

Following device feedback, Catalog settings uses a funnel instead of the global settings sliders. The Album heading's decorative folder icon and the expand-all folder control are removed; individual expansion, collapse-all and current-path expansion remain. App/Albums/Catalog tests passed 71 cases, and Settings passed 8 cases after the version bump. TypeScript/Vite and native APK build/checks passed, including alignment and existing-signer v2/v3 verification. APK SHA-256: `eddedb3266781d6dfed7ad46fd3774dccae9e1d099732124207e7e68b357d03e`. Authorized in-place installation on Galaxy Tab S11 succeeded; installed version 0.6.5 (21) and cold startup `Status: ok` were verified without uninstall or data reset. Visual/touch acceptance remains separate. No additional server deployment or Git write occurred.

### 2026-09-20 media metadata and parallel investigation checkpoint

At this source checkpoint, no production deployment, dependency installation,
historical repair, APK delivery or Git write had occurred. The authorized rollout
below supersedes the deployment/tool-installation gap, not tablet acceptance.

- **New Capture media:** `image_thumbnails.py` now queues image/GIF/video insertions.
  Existing image key recipes remain unchanged. GIF uses Pillow's first frame without
  FFmpeg or a full animation scan; total GIF duration remains unknown. MP4/MOV and
  WebM/Matroska use one bounded FFmpeg poster frame, with source rotation reflected in
  dimensions and declared video duration in milliseconds. GIF-kind MP4 retains its
  canonical kind. Animated PNG/WebP remain unsupported.
- **Metadata/read path:** a strict, bounded sidecar supplies source width/height, not
  the 512 px tile size. Thumbnail publication and missing metadata update atomically
  after rechecking visibility and source identity. Existing values win; incompatible
  partial dimensions are not combined. Ordinary Library and Album readers already
  expose these fields. Character publications still freeze Asset display metadata;
  an existing snapshot needs a later PC publication to reflect updated availability
  or dimensions. This batch does not change snapshot or lifecycle authority.
- **Resource/operational limits:** one encode at a time, 50 MiB image/GIF or 128 MiB
  video download, 24 MP source ceiling, 20 s outer timeout, bounded tool output and
  per-process resource limits. Parent process-group cleanup also handles an encoder
  that exits before its tool. These are protective bounds, not a sustained-load
  benchmark or an aggregate memory reservation. Missing tools produce terminal
  `encodeToolUnavailable` and do not block subsequent eligible jobs. Startup neither
  scans historical Assets nor retries terminal jobs. Rollout must include the
  existing application dimension migration before installing the worker and must
  provision video tools separately; read-only host checks found no FFmpeg/FFprobe.
- **Verification:** local `python3 -B -m unittest tests.test_image_thumbnails
  tests.test_media_thumbnail_worker tests.test_media_thumbnail_encode -q` passed
  **162 tests in 25.009 s**, no skips. Coverage includes real MP4/MOV/WebM/Matroska,
  real rotation metadata, short clips, GIF without FFmpeg, pipe floods/timeouts,
  descendant cleanup, queue upgrade without historical enqueue, publication races,
  metadata validation and preserving existing metadata. In isolated remote stage
  `/home/linuxuser/lakomics-media-test-20260920-uzl9_c32`, the existing venv ran
  `tests.test_image_thumbnail_api`, `tests.test_replication_api` and
  `tests.test_album_assets`: **54 tests passed in 2.835 s**. The copied app source,
  fake R2 and temporary SQLite were used without loading production settings/DB;
  encoder/worker/API-test hashes matched the local files. HTTP coverage confirms
  promoted image/GIF dimensions and thumbnail/original tickets without PC. A
  Starlette/httpx deprecation warning was non-failing. Video decoding was verified
  locally, not on the server or tablet. No Windows/native Android acceptance is claimed.

Investigation conclusions (source inspection, not new implementation):

- **Catalog refresh:** desktop defaults to enabled with a 3600 s due interval
  (`0018_online_catalog.sql`); `useOnlineCatalogUpdate.ts` checks immediately at
  mount and hourly thereafter. Mobile Catalog's 5 s publication check detects
  published changes; it does not ingest new works. `CatalogRefresh.tsx` observes
  refresh jobs at 2 s while busy / 30 s idle / 10 s after error. Its explicit request
  starts server-owned provider fetching (`mobile_catalog_refresh.py`), so it works
  independently of PC; no periodic server ingestion scheduler is implemented.
  Existing request bounds include one active job, up to 40 pages and 16 MiB staging.
- **Catalog edition merge review (not Asset duplicate review):** candidate generation and decisions remain PC-local in
  `catalog_review.rs`. Published groups can be browsed without PC, but groups are
  not pending candidates: generation skips pairs already in the same group. A
  mobile review feature needs an explicit candidate/evidence export and a decision
  authority contract; existing group data is not sufficient to reconstruct it.
- **Character capacity:** inference currently runs in the PC Python ONNX runtime
  with CPU execution (6 intra-op / 1 inter-op threads); the API serves the published
  snapshot, not inference. Collections, Characters and Catalog visibility have
  automatic dirty/debounced publication lanes in `auto_publication.rs`, not only
  manual publishing. The observed server has 1 vCPU and about 1.6 GiB RAM, with
  about 950 MiB available and 811 MiB swap used at the check. This snapshot does not
  establish active swapping or model throughput. Keep inference on PC for now;
  moving it to the shared VPS needs a separately scoped isolated model-memory and
  latency benchmark, not an unmeasured production trial.
- **3D:** desktop already has a shared custom WebGL2 physical-cover renderer and
  raster caching (`src/collections/physical/`); mobile currently uses flat artwork.
  Reuse/adaptation is feasible in principle, with static gallery fallback and at most
  one active interactive cover, but touch, WebView GPU behavior and battery cost need
  device validation. The bundled page and native media cache share
  `https://app.lakomics.local`; absent CORS headers alone are not a blocker on that
  same-origin path. Actual GLB/glTF model viewing is a separate unimplemented feature,
  not interchangeable with 3D book covers; no new renderer dependency is adopted.

The server rollout/tool-installation gate was subsequently authorized and completed
below. Next acceptance is new captures in the tablet Library/viewer. Historical
metadata/thumbnail repair remains separately scoped. After that, prioritize a small
portrait 3D-cover prototype or the duplicate-review contract rather than moving
character inference onto the VPS without capacity evidence.

### 2026-09-20 authorized media rollout

- **Tools:** installed official Ubuntu FFmpeg/FFprobe `7:8.0.1-3ubuntu2` with
  `--no-install-recommends`: 127 new packages including dependencies, no upgrades or
  removals. Unrelated service restarts were deferred; no dependency was added to
  the application's Python environment.
- **Host verification:** copied current sources/tests to the isolated
  `/home/linuxuser/lakomics-media-release-20260920-uazynrio/candidate` stage.
  Image worker, media worker, media encoder, thumbnail API, replication API and
  Album assets suites passed **216 tests in 111.294 s**, with no skips, using the
  existing venv, installed video tools, temporary SQLite and fake R2. This includes
  real MP4/MOV/WebM/Matroska and rotated-video decoding on the deployment host.
  The existing Starlette/httpx deprecation warning was non-failing.
- **Backup and scope:** retained original `app.py`, `album_authority.py`,
  `image_thumbnails.py` and `image_thumbnail_encode.py`, their SHA-256 manifest and
  a SQLite online backup under the release directory's `rollback/`; backup
  `PRAGMA quick_check` returned `ok`. Live/candidate module comparison found exactly
  these four differences. Guarded baseline and candidate hashes were checked before
  replacement, and deployed hashes matched afterward. No Catalog module changed.
- **Deployment:** stopped the API, replaced only those four modules, and started it
  with its existing service/configuration. Startup added nullable width/height/
  duration columns and upgraded the media INSERT trigger. The API-dependent existing
  HTTPS proxy stopped with the API and was explicitly restarted. Both finished
  `active/running`, `NRestarts=0`; no new service or public port was provisioned.
- **Live acceptance:** tailnet HTTPS health, authenticated Library list/generation,
  Catalog status and sync status returned 200. Three listed Assets carried the
  dimension/duration response fields; Catalog display-preferences version remained 1.
  An existing thumbnail ticket and WebP download returned 200 (24,950 bytes);
  unauthenticated Library access returned 401. All 22 completed thumbnail jobs and
  canonical lifecycle rows matched the pre-deployment backup. Existing metadata
  remained unknown (zero rows with dimensions/duration), confirming no historical
  fill or automatic repair at this checkpoint.
- **Remaining:** no new production Capture was created for testing and no tablet
  rendering was inspected. Verify a newly saved eligible image/GIF/video in the
  Gallery and Viewer. Historical repair, Character snapshot refresh, APK delivery,
  Git commit/push and sustained-load acceptance were not part of this rollout.

### 2026-09-20 authorized existing-video thumbnail repair

The user confirmed new thumbnail generation on the tablet, then explicitly requested
repair of existing video thumbnails. A read-only audit found four visible, committed
MP4 Assets with missing thumbnail keys, valid digests and sizes below the 128 MiB
worker limit (largest 11,658,049 bytes). Only those four IDs were enqueued through
`image_thumbnails.enqueue`; no failed job was reset and no second worker was started.
A checked SQLite backup and target/result manifests are retained in
`/home/linuxuser/lakomics-media-release-20260920-uazynrio/video-repair-v2icyb6u/`.

All four jobs finished `done` on their first attempt with no errors. Source dimensions
and duration were populated alongside the new thumbnails. Original object keys,
digests, sizes, content types and canonical kinds were unchanged. The authenticated
mobile media-ticket API returned four successful WebP tickets, and all four signed
downloads returned 200 with valid WebP signatures. The final visible supported-video
missing-thumbnail count was zero; the API remained active/running with `NRestarts=0`.
This confirms server generation and delivery; tablet rendering of these four repaired
items has not yet been separately confirmed. No APK or Git write was performed.

### 2026-09-23 video thumbnail limits and repair

Two X videos saved from the extension on 2026-09-23 showed no mobile thumbnail; both
jobs were terminal `sourceUndecodable`, while the files were valid. A 4K (3840x2160)
H.264 frame could not be decoded inside the 384 MiB encoder address-space cap (it
decodes at 768 MiB, peak RSS ~180 MiB, ~7 s CPU on the 1 vCPU host). The other video
(1426x1920) decoded fine on re-run: it had run out of time under load, and a timeout
was classified as terminal. Fix: video runs use 768 MiB, 30 s CPU and a 20 s decode
wall clock (worker bound 60 s); images are unchanged. A tool that runs out of wall
clock or CPU now exits `EXIT_TIMED_OUT` (8) and the worker retries it as
`encodeTimedOut`. Server tests 1,241/1,241 passed; the candidate encoder produced both
thumbnails on the host before deployment. Deployed after user approval (previous files
in `backups/video-thumb-limits-20260923T075105Z/`, service active, `NRestarts=0`), then
only the two failed jobs were re-queued with `retry_terminal`; both finished `done` on
the first attempt. Tablet rendering of these two items was not separately inspected.

### 2026-09-20 later posters, Asset filters and hourly refresh

**Implementation checkpoint (subsequent deployment/install recorded below):**

- Video poster recipe v2 uses an accurate duration-relative seek: 10% of duration,
  clamped to 0.5–3 seconds and capped at half-duration for sub-second clips. A clean
  no-frame result permits one first-frame fallback; tool failure/timeout does not.
  Long black introductions can still be black: this is not brightness-based scanning.
  Image/GIF recipes remain unchanged and existing video keys are not regenerated.
- Shared mobile Library/Album/Character filters: images (including GIF), videos;
  PC-compatible square ratio 0.8–1.25 inclusive, landscape and portrait; new mobile
  duration buckets under 30 s, 30–60 s, 1–5 min, and >=5 min. Server SQL filters before
  pagination. Cursor filter/scope binding preserves shipped unfiltered legacy layouts.
  Strict `filterVersion:1` checks include continuation and generation-change retries.
  Failed choices retain the previous committed gallery without relabelling it.
- Character membership/order/revision remain published; live technical metadata and
  visibility are overlaid at read time. Refresh invalidates technical-page caches even
  when publication revision is unchanged. Nested Back closes filters first.
- Durable per-language hourly scheduling reuses the existing bounded Catalog worker.
  Initial adoption waits one hour; zero/missing baselines are not backfilled. Partial
  checkpoints resume, failed/manual activity defers its own language, and one active
  job does not indefinitely postpone the other language. Idle due checks run every
  minute. Fetching already stops at each language's saved watermark; actual additions
  still copy the immutable artifact and prepare indexes/counts. No-change passes avoid
  artifact copies. This is not a full client delta protocol or old-work metadata refresh.

**Authorized production metadata repair completed:**

- Before: 8,956 visible committed Assets missing dimensions, including 421 videos
  missing duration. Imported 8,647 normal PC-backup rows only after exact ID, SHA-256,
  byte-size and kind matches (416 durations), then processed 309 remaining originals
  sequentially (304 images, 5 videos). About 228 MB of originals, not the full library,
  were needed; temporary encoded thumbnails were discarded, never uploaded/replaced.
- Final visible totals: 8,531 images, 5 GIFs, 427 videos. Missing dimensions/video
  durations: **zero**. Across all 8,999 stored Asset rows, exactly 8,956 changed only
  technical metadata; all other columns, including source/thumb keys and timestamps,
  were unchanged. `PRAGMA quick_check=ok`; API and proxy remained active. Authenticated
  live Library read confirmed all 40 returned Assets carried dimensions.
- Checked online backups, exact target manifests and result records are retained at
  `/home/linuxuser/lakomics-metadata-repair-20260920-kchr7f54/`; first pre-repair backup
  is `apply-ctl8p4ww/before.sqlite3`. The published PC metadata snapshot was read-only.
  The helper is operator-only, not a background scheduler; no catalog backfill, media
  re-upload, service restart, new deployment, APK install or Git write was performed.
- Extraction was a single sequential low-priority operator process using the deployed
  bounded encoder. The ordinary thumbnail worker stayed running, so this does not claim
  a global single-encoder lock or sustained-load benchmark for the repair.

**Verification and remaining acceptance:**

- Controller-observed local encoder/worker suites passed 180 tests; metadata helper and
  operator-fixture coverage passed 44 tests. Remote isolated scheduler/filter/thumbnail
  API selection passed 55 tests; the final filter-only check passed 31. Adjacent Library,
  Album, Character, replication and real-encoder selection ran 237 tests: 236 passed and
  one lacked a copied Character fixture; copying that existing fixture made the remaining
  test pass. Production DB/settings were not loaded by these tests.
- Mobile changed-surface checks and TypeScript passed. Full mobile suite: 339 passed,
  one Catalog Reader manifest-refresh timing assertion failed (expected two calls,
  observed three). The isolated Catalog file rerun passed all 36 tests. This suggests
  timing sensitivity, not a confirmed root cause; Catalog UI was not changed and no
  blanket full-suite success is claimed.
- Source review corrected an overflowing Character cursor, legacy classification cursor
  compatibility, a generation-retry filter-contract gap and stale Character technical
  cache reuse. At this source-test checkpoint native rendering and deployment remained
  unverified; the subsequent authorized delivery is recorded below.

**Authorized 0.6.6 delivery completed:**

- Deployed only `app.py`, `album_authority.py`, `mobile_characters.py`, `asset_filters.py`,
  `mobile_catalog_refresh.py`, `image_thumbnails.py` and `image_thumbnail_encode.py`.
  Candidate hashes matched local sources; their parsed implementations matched the
  previously verified isolated stage. Original modules, hash manifest and checked online
  DB backup remain under `/home/linuxuser/lakomics-mobile-066-release-20260920-0q0724jr/rollback/`.
  Operator metadata repair helpers were not installed into the service.
- Live HTTPS checks passed nine filter cases (83 returned rows across initial/continuation
  pages), disjoint pagination, mismatched-filter rejection, two actual pre-deployment
  Library/classification cursors, authentication and Character live technical fields.
  Korean/Japanese schedules were armed about 3,597 seconds ahead; zero jobs were active.
  No provider refresh was forced. Assets, Asset authority, domain state, Character
  publication and Catalog pointer fingerprints were unchanged across rollout.
- API and its dependent HTTPS proxy were both restarted as required and finished
  active/running with `NRestarts=0`. Deployed source hashes matched the candidate.
- APK `android/build/lakomics-mobile-0.6.6-release.apk`: 1,250,724 bytes, SHA-256
  `05bc479deba0d6debc7492ddbfb2f0f665bc5dbea8ca1a4a6d8841b69a0359ef`.
  Existing-certificate v2/v3 signing, alignment, manifest version and all 12 bundled
  asset bytes were verified. TypeScript/Vite and native release packaging completed;
  version-specific Settings tests passed 8/8. No dependencies or signing key were added.
- Galaxy Tab S11 accepted the in-place update to 0.6.6 (22), preserving first installation
  at `2026-09-08 17:56:50`. Cold launch returned `Status: ok`; the process remained running.
  A native portrait screenshot showed the gallery and active image/landscape filter state.
  No account reset, uninstall, cache clear or provider-setting changes were made.
- Remaining: first scheduled production refresh, fresh-video poster v2 end-to-end capture,
  exhaustive on-device Album/Character/duration interactions and landscape acceptance.
  Existing poster keys remain unchanged. No Git commit/push was performed.

**Next UI proposal, not implemented:** use a roughly 100 ms content opacity transition
only after new content commits, a 120–160 ms short drawer transition and a 120 ms folder
chevron rotation. Keep the old gallery until ready, honor reduced motion, and avoid tile
staggering, springs, sliding galleries or animated heights that disturb virtualization.

**Duplicate workflows stay separate:** Asset duplicate review compares image/video
files; Catalog edition merge review groups editions of a work. The earlier
`catalog_review.rs` investigation covers only the latter. Neither mobile review workflow
is implemented by this batch; do not treat published edition groups as Asset duplicates
or as pending merge candidates.

### 2026-09-19 implementation and investigation checkpoint

- **Thumbnail refresh:** reproduced a client-side failure in both Home and Gallery: a mounted asset initially marked `thumbnail_available:false` did not reload when fresh metadata changed that flag to `true`. Both effects now observe availability/pending transitions; two regression cases failed before the fix and passed afterward, with pause behavior retained. This client regression is separate from the live publication failure confirmed below; fixing refresh cannot supply an unregistered thumbnail. No queue repair, retry expansion or full backfill was run.
- **Affected-asset investigation (`x.com/hbd_bday/status/2101294431509057626/photo/1`):** after user-assisted SSH authentication, read-only inspection of the service-configured server database confirmed capture `70a9b791-5688-44da-bd9a-8090f1a6784b` was promoted at `2026-09-19T13:45:17.738847+00:00` to Asset `0846fbe5-7578-5562-9195-88dd93342926`. The Asset is normal and committed, retains the capture inbox original key, and has `thumbnail_key=NULL`. The live `/v1/library/media-tickets` response independently returned thumbnail `ok:false,error:unavailable` and original `ok:true,content_type:image/jpeg,size_bytes:723518`; signed URLs and credentials were not printed. Deployed `asset_authority.promote_capture` inserts new Assets without thumbnail metadata, confirming the affected ingestion path. PC source tracing shows local image thumbnails can be generated during authority materialization, but server-owned Assets are excluded from legacy outbound upserts. Thus this case has a server-side thumbnail publication gap, not merely stale mobile rendering; physical absence of all possible orphan thumbnail objects was not audited. The running Linux desktop holds its library lock under `before-linux-backup/New_lakomics_assets`; its data was not queried and local materialization for this Asset remains unverified. At that read-only investigation checkpoint no production writes, cache reset, queue reconciliation or backfill were performed. The user subsequently authorized deployment and recent missing-image-thumbnail repair, recorded below.
- **Portrait UI:** Character and Group sidebar icons are distinct; the selection fill is confined to the folder button, outside the expander/hierarchy line. Portrait Character cards use a 3:4 contain frame. Direct Character entry now returns to the previous committed browsing context/scroll instead of the synthetic Series overview, while in-browser drill-down retains parent navigation. Entry-state timing and filter-only Back regressions are covered.
- **Viewer:** compact information dialog shows available creator name/handle, source, source publication date, collection date, dimensions, duration, format and size. Publication date is not inferred from storage dates. Explicit text-copy actions use a bounded Android clipboard bridge that acknowledges the actual write; no clipboard read or file copy is added. Back/Escape closes information before the Viewer; failures have separate feedback.
- **Dimensions:** confirmed that general Asset replication omitted local width/height/duration and that server projections returned null. Added optional strict integer fields, nullable additive columns, legacy-omission preservation and mobile projection reads. Existing rows remain unknown until a separately authorized metadata update. No production migration, deployment or publication was performed.
- **Catalog category selector:** reuses the PC's category IDs/labels. The selector is independent of the user's search expression and composes a parenthesized expression through the existing `text` API; no unknown query parameter or new write authority. Typed advanced expressions are not rewritten.
- **Refresh cadence, source evidence:** PC upstream collection defaults to 3,600 seconds while the PC app is open; the actual configured library interval was not read. Server refresh is request-driven, not periodic, and accepted work can finish with PC/mobile closed. Foreground mobile checks publication changes every five seconds; this is not upstream collection. Refresh-job status uses two seconds while active and thirty seconds while idle. No schedule was changed.
- **Hidden tags and duplicates remain open:** the server applies published visibility policy, but Android has no policy-write allowlist/replica contract. Shared editing must account for PC publication overwrites; no ad-hoc whole-policy write was opened. New Catalog duplicate candidate generation currently runs in PC-local Rust over the Catalog database. Published grouping remains readable with PC off, but there is no mobile review/candidate API. This is distinct from general Asset similarity scanning.

Verification: full mobile suite passed 251 tests with two workers; after the final filter-only Back correction and information-dialog accessibility adjustment, 91 affected tests passed. Mobile TypeScript/Vite build passed. Browser fixtures covered 800x1280 and 390x844 portrait plus a 1280x800 landscape preservation check: 18 states, zero page horizontal overflow/runtime exceptions; these are not device acceptance. Android native policy/cache/replica checks, including eight clipboard-policy checks, and APK v2/v3 signing passed. Rust cloud coverage passed 134 tests (one ignored), including the dimension payload test. The Python API suite could not import because this host lacks `botocore` (and the server runtime dependencies); syntax checks passed, not API acceptance. Some Viewer tests retain React `act(...)` warnings.

Device delivery: built `android/build/lakomics-mobile-0.6.3-release.apk` with the existing signing identity (version unchanged), SHA-256 `8f80189d0d830d696a70890c29f75556f9d6fd477fef7e667b7027676c8f51a6`. Installed in place on the Galaxy Tab S11 (`SM-X730`) without uninstalling or clearing data; activity cold-start returned `Status: ok`. Installation/startup is not touch, clipboard, or live-thumbnail acceptance.

### Server image-thumbnail deployment and repair

The user authorized applying server image generation and initially repairing the latest 16 images, then expanded repair to all recent images missing thumbnails. Deployed only the thumbnail startup/shutdown hooks, `r2.py`'s bounded background client, `image_thumbnails.py`, `image_thumbnail_encode.py`, and the pinned Pillow 12.3.0 requirement. Existing local dimension/schema changes were excluded from the deployed artifact and remain undeployed. The previous runtime sources matched repository HEAD before patching; rollback code and a consistent read-only SQLite backup were retained privately on the server before restart.

New promoted image Assets enqueue durably in their creation transaction. A single lock-protected worker generates static JPEG/PNG/WebP thumbnails without a PC, with bounded downloads, child CPU/memory/time/pixel limits, safe retries, and visibility/digest-checked publication. No original is replaced, no lifecycle revision is changed, and no historical scan runs at startup. GIF/video and animated image formats are outside this worker's scope.

Verification: 313 targeted tests passed in an isolated release directory using the server Python environment, synthetic databases and fake storage (`test_image_thumbnails`, `test_image_thumbnail_api`, `test_capture_api`, `test_asset_authority`, `test_mobile_library_api`, and the deployed-baseline replication tests plus startup cleanup). These checks exercise real child encoding, promotion-to-mobile API delivery, queue/retry/visibility limits and lifecycle shutdown. A pre-existing httpx/Starlette deprecation warning remains. Review caught and corrected unsafe threaded `preexec_fn`, pre-decode pixel checking, alpha handling and worker restart semantics; controller verification also corrected thread-unsafe/timing-dependent test code and missing fixture shutdown.

During preparation two new images arrived, so the repair selection was rechecked and frozen at execution rather than silently changing an already-written batch. The latest 16 missing images completed; the expanded request added the one remaining recent missing image. All 17 jobs finished on their first attempt. Live verification returned 34 successful original/thumbnail tickets and downloaded/decoded all 17 WebP thumbnails (584,732 bytes total). The reported `hbd_bday` Asset now serves a 410x512, 44,688-byte WebP thumbnail. Original object keys, digests, sizes, media types and canonical authority-row fingerprints remained unchanged for all 17. At the final audit there were zero visible committed image Assets with `thumbnail_key=NULL`. This is not an audit of every pre-existing thumbnail object's storage health.

The API restarted successfully, health returned HTTP 200 and the worker lock was held; final service memory accounting was approximately 98 MiB (not a peak-load measurement). No full Cloud backfill, catalog/dimension deployment, mobile cache reset or APK rebuild was performed. The user subsequently confirmed that the repaired thumbnails are visible on Galaxy Tab. This accepts post-repair device rendering; future live capture with the PC off remains separate from verified server delivery and synthetic automatic-enqueue tests.

Remaining acceptance: verify a new live capture with the PC off; verify real tablet copy, nested Back, icons, framing and category filtering. Server dimension API execution and rollout, and any existing-row metadata update, are separate gates. Browser fixtures and successful packaging do not prove live synchronization.

# Mobile media / development tooling (2026-09-23)

## MOBILE-PERF-002 — First-view thumbnail latency

Status: `HOLD` — the client-side warm-up covers everyday browsing. Reconfirmed 2026-09-24: stay on hold; revisit with measurements during `PERF-ALL-001` if new-image thumbnails feel slow.

On the tablet an uncached thumbnail takes about 1.5–2.4 s: the Tokyo API answers a ticket in about 0.07–0.1 s and the nearest Cloudflare edge (ICN) is 3 ms away, so the time is R2 storage response latency. 0.7.4 parallelised and prefetched; 0.7.6 warms the whole Library into the native cache (about 200 thumbnails/min). Remaining slow cases are newly captured images and a cleared cache. Options if they matter: serve thumbnails from the Tokyo server's disk (13 GB free on 2026-09-23; ~360 MB for the current library) in batched requests, or move derived thumbnails to an APAC-hinted bucket. Both need server work, a copy of production thumbnails and deployment approval.

# Character classification

The character UI/management workflow and current accuracy-improvement pass are accepted and archived. [CHAR-AUTO-001](lakomics-completed.md#char-auto-001--current-accuracy-improvement-pass) retains the implementation evidence, delivery limits and policy for case-driven follow-up. Batch-classification visibility remains a separate verification item below.

## CHAR-AUTO-007 — Evidence-based accuracy plan (2026-09-23 re-analysis)

Status: `IN_PROGRESS` — stage 3 implemented 2026-09-24 as a machine-local per-series switch (see Current priority); next is enabling series on the user's PC and spot-checking S36 acceptances. Earlier: stages 1–2d done (2026-09-23): full-library S36 features extracted, a shadow policy pinned in `_tools/app/character-runtime/s36_policy.json` (automatic knn3 ≤ 0.1304 after ≥100 prior rejections, recommendations ≤ 0.1490), and in-app shadow scoring recording verdicts. The S36 review screen (stage 4 brought forward; series view → `S36 확인`) lets the user judge `automatic`/`recommended` shadow candidates through the normal manual decision path and shows running automatic precision and recommendation acceptance. Stage 3 used these judgments (232/241 correct at knn3 ≤ 0.1085).

Two read-only analyses of the active library (an Opus pass and an independent Fable review; scripts in the session scratchpad, not tracked) found:
- The CCIP metric model is exactly `0.5 × (1 − cosine)` of L2-normalized features, so comparisons need no ONNX batching.
- Random grouped cross-validation overstated gains (contrast score AUC 0.90) through target-prior leakage and same-day batch correlation. Chronological replay gives B36 AUC ≈ 0.61 and S36 ≈ 0.73–0.74 (recall at 2% FP ≈ 0.13 vs ≈ 0.33–0.38). Expect roughly one-third recall at a strict error budget, not 60%.
- S36 features beat B36 in every measured condition; B36+S36 fusion added nothing.
- Most rejections are unregistered people (open set), so "nearest registered character" arbitration is unsafe; competitors should be same-series only.
- Automatic acceptances after 2026-09-13 were never manually confirmed (14 later rejections, 0 confirmations), so their precision is unknown, not high.
- The 2026-09-11 안조 false-positive burst came from multi-person anchors voting with every crop before region handling existed. Current code already withholds unresolved multi-person anchors; 안조 now has 3 usable anchors and cannot auto-confirm.

Stages:
1. **Chronological feature-replay evaluator** (in progress): each prediction uses only earlier manual decisions, excludes same-post/PDQ neighbours, reports walk-forward thresholds and a target-prior leakage canary. All later changes are judged with it.
2. **S36 switch in shadow mode**: needs a full-library S36 feature extraction into the library cache (about 3.5–4.6 CPU hours, separate approval) and recalibrated thresholds.
3. **Scoring**: positive gallery = references + manual acceptances only; subtract the nearer of own manual rejections and same-series competitors. Keep automatic confirmation strict; growth goes to recommendations.
4. **Fast review loop** for recommendations so new manual decisions feed stage 3.

User follow-up for 안조: select regions for anchors `e60e44a1` (crop #1 or #2) and `90394071` (crop #4), and add the four manual acceptances as supporting references.

## CHAR-AUTO-008 — Multi-form characters and reference quality hints

Status: `TODO` — measure with the CHAR-AUTO-007 evaluator first.

Some characters have distinct forms (아리아: robot form and human form). With per-reference voting a minority form rarely reaches the six-vote automatic rule, although it does not hurt the majority form.
- Short term: add at least six references for each form that should auto-confirm.
- Direction: cluster a character's references into forms/outfits (auto-suggested, user-confirmable) and count votes within a form, so automatic confirmation means "six references of the same form".
- Reference hints in character settings should flag only isolated references that belong to no form cluster, not a whole second form. Observed isolated cases on 2026-09-23: 수나 `aeffff69` (abstract chibi), `5c2ca1c1` (backlit silhouette); 모니에 `720276e7` (legs only), `f29f450c` (blue silhouette). Also verify 수나 `ec4e8499`, whose automatically inferred region may be a different person. Thresholds for hints must come from the evaluator, not the ad-hoc 0.19 median used in the audit.

## CHAR-AUTO-009 — Person crop quality and main-character focus

Status: `HOLD` — measured 2026-09-23: in the chronological S36 + knn3 crop-policy comparison the current crop policy (P0) was best (recall 34.6% at ~3% FP) and every alternative (fragment/mascot filtering, head extension, box merging, main-character-only) was slightly worse. The user chose to keep the current crops and not adopt main-character-only. Reopen only with concrete new failure cases; the text below is the original proposal.

User reports (2026-09-23): crops sometimes cut a face in half or pick up mascots, and multi-person images attach minor background characters. A random sample of 72 library crops showed roughly: ~10 non-human/mascot crops (mascot cats, chibi mushrooms, plush toys, objects), ~10 fragments (half faces, hat/hand/legs only), ~5 boxes containing several people, and frequent duplicate boxes for the same person (full body plus upper body, overlapping manga panels).

User decisions:
- **Main characters only:** in multi-person images, classify only the prominent people — those comparable in size to the largest person. Equal-size group art keeps everyone.
- **Minor characters are ignored**: no automatic membership and no recommendation.

Direction, in order of expected safety:
1. Drop fragments, very small crops and non-human detections from classification.
2. Keep the whole head inside a person crop (locate the head and extend the box when it is cut).
3. Merge duplicate boxes of the same person.
4. Consider a different person detector only if 1–3 are insufficient.

Before enabling the main-character rule, measure how many existing manual acceptances are small/background people so the prominence threshold does not drop images the user deliberately assigned. Existing memberships are not removed retroactively without a separate decision.

## CHAR-AUTO-003 — Cluster-based character candidate research

Status: `HOLD`

2026-09-26: Chinese Whispers over S36 implemented as a shadow-only report (`character-runtime/candidate_groups.py`, `be4c5e1`). Unfiltered "expand known" groups were style clusters (5–10 % correct); with distance checks 9 groups / 73 images at ~70 % visual precision, largely overlapping the existing S36 recommendation threshold. The user identifies new characters instantly, so new-candidate groups are low value. User decision: **stop here** — no PC review screen; keep the tool for later (e.g. `CHAR-AUTO-008` multi-form work).

Idea 2026-09-26 (user): julyx10/lap (GPL-3.0 photo manager) groups faces by building a top-K nearest-neighbour graph over embeddings and running Chinese Whispers with one distance threshold (no cluster count needed; memory bounded at N×K). Its InsightFace `buffalo_s` models are real-photo only and do not fit illustrated characters, but the same graph + Chinese Whispers over our CCIP person-crop embeddings could propose "these unassigned images look like one character" as new-character candidates. Reimplement from the algorithm (do not copy GPL code); evaluate against existing labels before exposing it.

Keep clustering/re-identification research deferred while explicit-reference classification remains usable. Reopen only if real-world accuracy evidence shows it solves a recurring gap better than reference/arbitration tuning.

# Similarity / media identity

## SIMILARITY-003 — Similar-video fingerprinting and review

Status: `PARTIAL` — implementation exists; verification is deferred because representative duplicate/variant videos have not naturally appeared yet.

2026-09-26 vPDQ trial ([report](../research/oss-trial-vpdq-20260926.md)): adds trim/subclip detection the fixed 12-slot check cannot do (0 false positives; 8–14 real candidate pairs vs 7). User decision: **later**, as an opt-in extension of the current video similarity, not a replacement.

Do not redesign the architecture without evidence. When suitable samples exist, validate re-encode/resolution positives plus trim/crop/watermark hard cases in the existing Similarity Review surface. Audio remains optional.

Reference: [video similarity execution record](../research/video-similarity-execution-plan-20260908.md).

## PERF-SIMILARITY — Metric index / BK-tree gate

Status: `HOLD`

Linear PDQ candidate scanning remains the default. Reopen only if historical discovery or representative 100k+/250k+ measurements show it is a material bottleneck.

# Works / Collections

## LONG-001 — AV metadata/cover acquisition and candidate selection

Status: `PARTIAL`

Decided 2026-09-27 (user): **LibreDMM** is the source (keyless; tested from Korea: SSIS-001 and ABW-100 return title, date, maker, label, actresses, genres and the `pl` wrap jacket `back | spine | front`, 800×438 for DVD/BD; FC2-PPV answers 202 = queued, retry later). DMM/FANZA affiliate API dropped: the affiliate site is geo-blocked in Korea and registration requires a Japanese address. JavLibrary is only for browsing: collector 3.0.0.43 opens a JavLibrary search tab for a selected product code (right-click menu on PC, floating chip on touch). The user wants the collector linked to AV Collections (send a product code from the browser → PC fetches LibreDMM candidates → user picks front/spine/back). Research: [av-sources-20260926](../research/av-sources-20260926.md). Implemented and committed 2026-09-27: design [av-link-design-20260927](../research/av-link-design-20260927.md), mockups `docs/prototypes/av-link-20260927/`, server `POST/GET /v1/av-lookups` (`67e0cd97`), collector 3.0.0.44 (`b9c4f89a`), PC migration 0104 and LibreDMM/Wikidata chooser (`b00f3bfe`). Waiting: server deploy approval, PC start with backup, and native check. Korean performer names come from Wikidata (6/6 sample names found).

Current manual AV Collection, people/roles, front/spine/back surfaces, and focused viewing remain usable. The remaining inconvenience is acquisition, especially manual number entry and manual cover setup.

Future direction:
1. one or more external sources fetch metadata and cover candidates;
2. Lakomics presents those candidates separately from acquisition;
3. the user explicitly chooses which candidate becomes front / spine / back, or rejects all;
4. provider refresh never silently overwrites manual choices;
5. fetching and applying stay separate so a source can be replaced without redesigning the chooser.

Do not couple this to Private Vault or create a second Collection artwork lifecycle.

# Catalog / optional providers

## CATALOG-002B — Optional Heliotrope coexistence

Status: `TODO` — low priority / optional.

Keep VCK/kHentai as the default provider. If Heliotrope is revisited, isolate its cache and never assume metadata availability implies a valid page resolver. Provider disable/cache clear must preserve bookmarks/progress.

# Desktop UI consistency

## PC-UI-001 — PC UI consistency pass

Status: `VERIFY` — the documented consistency fixes are implemented; native visual acceptance of the remaining items is still pending. The source and shared foundation records are in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round).

From a 2026-09-23 review of the design documents against real-app screenshots on the Linux host. Fix small items first; items marked *decision* need a user choice before implementation. Options and recommendations for the open decisions, plus larger visual-direction proposals, are in [PC UI design decisions pending](../research/pc-ui-design-decisions-20260923.md).

1. **Fixed 2026-09-23:** Settings: unchecked checkboxes (e.g. 비공개 모드) are nearly invisible on the dark surface, and labels mix action (`켜기`) with state (`켜짐`).
2. **Fixed 2026-09-23:** Settings: `캐릭터 누락 보완` stayed at `확인 중...` because every Settings open re-hashed the ~150 MB S36 model; successful verification is now cached in-process by path, length and modification time.
3. **Fixed 2026-09-23:** TV detail: season selection uses a white outline box instead of the documented selection language.
4. **Fixed 2026-09-23:** TV detail: season synopsis spans the full content width; limit it to the same reading measure as the work synopsis.
5. **Fixed 2026-09-23:** Character series view: removed the empty band; the overview now separates group, total character (including grouped members), and ordinary-folder counts. Group detail headings stay unchanged.
6. **Fixed 2026-09-23:** Manga catalog: the edition button appears only for 2 or more editions; covers show a static neutral loading icon without motion or layout shift, then the image or the existing failure state.
7. **Fixed 2026-09-23:** Work detail: a back chevron to the left of the title replaces the detail-close X beside window controls, preserving the existing exit and Escape/back handlers.
8. **Fixed 2026-09-23:** Collection index: two simultaneous ivory selections; resolved by the N4 selection treatment (parent level tinted, most specific level keeps the slab).
9. **Fixed 2026-09-23:** Collection cards/info/details, TV seasons/episodes and Asset date headings share the viewer-local current-year rule: `MM.DD`, otherwise `YYYY.MM.DD`; year-only values keep `YYYY`, month-only values keep `YYYY.MM`, and ranges use `–`. Invalid input passes through unchanged. Stored values, grouping/sorting, caption times and Revisit date headings stay unchanged.
10. **Fixed 2026-09-23:** Collection genre displays translate the eight exact TV-only English genre names; the whole Asset library uses `전체` in index and title. The Manga catalog DB update timestamp has a muted database icon and accessible description; its full local date/time remains explicit.
11. **Fixed 2026-09-23:** Gallery captions leave unknown creators empty while retaining the right-aligned time and accessible collected-time description.
12. **Dropped 2026-09-23:** the "cropped TV backdrop" was a scrolled screenshot, not a defect.

Native visual acceptance of items 5–7 and 9–11 remains pending.

**Documentation follow-up done 2026-09-26:** `docs/agents/pc-design-reference.md` now records the date, selection (selected-row mark, N4 parent tint) and toggle-label rules and names `tokens.css` properties instead of color literals; character rules moved to the quiet character workflow doc, manga ownership to `lakomics-works-handoff-v2.md`, renderer budgets to `works-viewer-design.md`, and verification logs/statistics notes to `lakomics-completed.md`.

# Desktop verification / low-priority exploration

## STATS-001 — Personal statistics

Status: `PARTIAL`

Inventory and recorded-era activity statistics are implemented. Remaining work is targeted native acceptance/metric-definition cleanup only; do not infer historical activity from file timestamps.

## ARTIST-001 — Replace Revisit tab with an Artist hub

Status: `VERIFY` — phase 1 shipped in `57a4fa85`; the later artist grid, PC Home integration and related reads shipped in `532b7cc0` and `b5c4eafa`. The source-fill preview/apply path, conservative merge suggestions, pins/hide, user-defined display names and PC-authoritative link records are present. Tablet read-only entry is tracked in `TABLET-PARITY-001`; style-based 닮은 작가 suggestions are implemented separately in `e88c21ff`. Native PC acceptance is unverified. The source slices are recorded in the [2026-09-30 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-30--design-foundation-homesettingscalendar-redesigns-and-the-에셋-round).

## IDEA-002 — Asset date timeline exploration

Status: `HOLD`

Keep the timeline idea deferred until there is a concrete browsing need beyond the current date-grouped library and Revisit flows.

# Optional AI / development tooling experiments
