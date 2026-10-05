# What still needs the PC

Status: current reference. Source audit on 2026-10-06 against `ce8a7c5` (Android `0.9.29`,
versionCode 166). This records what the checked-out code does, not production state: which
authority domains are active in production comes from
[the completed log](../roadmap/lakomics-completed.md) and is not re-verified here. Native,
device and live-server behavior was not exercised. Re-audit before relying on a line here
after the related code changes.

Planned moves of PC work to the server are tracked in
[`SERVER-INDEP-001`](../roadmap/lakomics-backlog.md#server-indep-001--move-server-solvable-pc-work-to-the-server);
this page only describes the current boundary.

Paths are relative to the repository root. Shorthand: `tauri/` = `_tools/app/src-tauri/src/`,
`mobile/` = `_tools/app/mobile-client/`, `api/` = `server/lakomics-api/`,
`android/` = `android/src/com/lakomics/mobile/`.

## How the boundary is enforced

- Server tokens carry a `publisher` (PC) or `client` (tablet, extension) role; `publisher_guard`
  accepts only PC tokens (`api/api_auth.py:29-132`). Some older snapshot/replica routes still
  check only the shared token (`require_auth`, `api/app.py:103`), so "publisher-only" is not
  enforced there.
- The tablet can call only the routes in its native allowlist (`android/NetworkPolicy.java:24-131`).
- The PC runs one native loop (`tauri/workload.rs:555-823`) that imports analysis results,
  publishes 12 lanes (`tauri/cloud/auto_publication.rs:155-254`), applies tablet intents and runs
  the shared-authority pass (`tauri/library/authority_pass.rs`). Anything below marked
  "waits for the PC" takes effect on the next pass after the PC app is running and online.

## 1. Only possible on the PC

No tablet UI, and the server refuses the command from a non-PC token where a route exists.

| Feature | Evidence |
| --- | --- |
| Create, rename, move, restyle or delete classification folders | Server requires publisher for every command except `setAssetClassification` (`api/classification_authority.py:1565-1571`); PC commands `tauri/lib.rs:316-320` |
| Create, rename or delete albums | Tablet writer is membership-only (`android/AlbumMembershipOutbox.java:7`). The server would accept these from a client (`api/album_authority.py:169-177`); only the tablet UI is missing |
| Empty the Library Trash / permanent delete | `tombstoneAsset` is publisher-only (`api/asset_authority.py:71-76`); tablet says "비우기는 PC에서 할 수 있습니다" (`mobile/LibraryTrash.tsx:159`); PC two-phase purge `tauri/library/trash.rs:169-326` |
| Character registration and reference images | PC commands `tauri/lib.rs:427-496`; tablet reads references only (`mobile/characterModel.ts:6`) |
| Artist merge and detach | Tablet: "합치기는 PC 앱에서" (`mobile/Artists.tsx:65,178`); PC `tauri/lib.rs:291-301` |
| Auto-tag editing, tagger recommendations and review | No tablet code; tablet only uses tags as search suggestions (`mobile/useTagSuggestions.ts:15`) |
| Natural-language search | PC Python query worker (`tauri/library/nl_search_worker.rs:153`); nothing published, no tablet code |
| AV editing, StashDB people/portraits, applying a product-code match | PC commands `tauri/lib.rs:~497-525`; only a projection reaches the tablet (`tauri/cloud/collections_av.rs:1-4`) |
| Create a new Collection | No tablet code. The inactive Collections authority would allow it (`api/collection_authority.py:112-116`) |
| Collection volumes, volume sources, purge and provider snapshots | Publisher-only in the Collections authority (`api/collection_authority.py:3056-3070`); still PC-local while that domain is inactive |
| Private Vault: unlock with write access, add or change contents | PC `tauri/library/private_vault/`, `tauri/lib.rs:626-644`. The tablet can only read an attached vault USB (`android/PrivateVault.java:19`) |
| Direct file/folder import, manga folder/ZIP/CBZ import | `tauri/library/ingestion.rs:55`, `tauri/library/manga_import.rs`; the tablet has no upload path except Exchange |
| Drag-out to other apps | `tauri/library/drag_out.rs` |
| Metadata backup and restore (local and cloud) | `tauri/library/backup.rs:100-199`, `tauri/cloud/metadata_backup.rs:34-60` |
| Catalog first publication to mobile | User-triggered PC command (`tauri/cloud/catalog.rs:1-33`); tablet: "PC 설정의 온라인 카탈로그에서 모바일에 게시해 주세요" (`mobile/Catalog.tsx:502`) |

## 2. Computation and lookups that only the PC runs

The server is a small VPS and holds only a Kakao key (`api/collection_bindings.py:35-40`).
Other provider keys live in the PC's OS credential store (`tauri/library/credential.rs:19-30`).

- **Image analysis:** auto-tag/rating import from the machine-local inbox
  (`tauri/library/auto_tag_inbox.rs:202-224`), character detection and S36 review
  (`tauri/library/character_worker.rs:649`), image and video similarity
  (`tauri/library/similarity_scan.rs`, `tauri/library/video_similarity/`), artist-style analysis
  (`tauri/library/artist_style.rs`). The models run in external Python jobs on the PC.
- **Video:** FFmpeg posters, scrub frames and playback derivatives (`tauri/library/video_media.rs`).
  The server only makes a poster thumbnail for capture-created Assets (`api/image_thumbnails.py`)
  and does no transcoding.
- **PC library originals and thumbnails to R2:** uploaded by PC replication
  (`tauri/cloud/backfill.rs`); presigned original uploads are publisher-only
  (`api/asset_uploads.py:194`).
- **Provider lookups:** Collection metadata and covers (Kakao, Aladin, MangaDex, IGDB, TMDB,
  LaunchBox), manga new-volume checks (`tauri/library/release_watch.rs:86-101`), the Home
  release calendar (IGDB/TMDB, `tauri/library/release_calendar.rs`), AV product-code lookups
  (LibreDMM, `tauri/library/av_link/mod.rs:533`), and the PC catalog (`kdata.db`) updater.

## 3. Tablet actions that wait for the PC

The tablet records the request on the server; the change is applied by the PC later. Most
show a pending state on the tablet meanwhile.

| Tablet action | What the tablet sees before the PC applies it | Evidence |
| --- | --- | --- |
| Artist rename, hide, pin | Shown at once (server overlay) | `api/library_artists.py:1-20`; PC `tauri/library/home_publications.rs:542-610` |
| Character review decisions, "캐릭터에 추가" | "PC 반영 대기" | `mobile/CharacterReview.tsx`, `mobile/CharacterAddSheet.tsx:11,35`; PC `tauri/library/character_review_sync.rs` |
| Character exclusions | Hidden on the tablet at once; PC applies later | `api/character_exclusions.py:28,185` |
| Similarity review keep/discard | Pair leaves the queue; nothing moves to Trash until the PC applies it | `api/similarity_review.py:1-12`; `mobile/SimilarityReview.tsx:229-231` |
| Catalog duplicate-edition decisions | "PC가 켜지면 카탈로그에 반영돼요" | `mobile/CatalogDuplicates.tsx:20`; PC `tauri/library/catalog_duplicate_sync.rs` |
| Home wishlist add/remove/mute | Pending overlay | `api/home_upcoming.py:3-9` |
| AV product code ("품번 보내기", also from the Chrome extension) | Code waits in the server inbox | `api/av_lookup_requests.py:136-154`; `mobile/AvCollections.tsx:88-113` |
| MangaDex/Kakao Collection binding | Search runs on the server; the bind waits: "PC가 켜지면 적용" | `api/collection_bindings.py:82-140,909-913`; `mobile/CollectionBindings.tsx` |
| Collection status/platform, new-volume alerts, owned volumes | Applied by the PC | `mobile/collectionEditDelivery.ts:82-130` |
| Collection rating, Showcase, memo | Shown at once on the published row; the PC pulls the log later | `api/collection_personal_edits.py:1-11` |
| Media captured while the assets domain is inactive | "PC 수신 대기" in the extension until the PC imports it | `api/capture_routes.py:181,269`; `tauri/cloud/captures.rs` |
| New server Assets appearing in the PC library | Downloaded when the PC runs | `tauri/library/asset_authority.rs:1067-1148` |

## 4. Data that exists only after the PC publishes it

The tablet reads these, but they are produced by the PC and are as fresh as its last
publication: the character tree and review feed (`api/mobile_characters.py` reports
`authority: "pc"`), Collections including the AV projection (`api/mobile_collections.py`),
Home upcoming releases and AV pick (`api/home_publications.py`; the tablet does not call
`/v1/home/av-pick` today), artists, display tags (`api/library_search.py`), the similarity and
duplicate-edition candidate feeds, unread manga release events, and the catalog baseline.
The hourly server catalog refresh starts only after one PC catalog publication exists
(`api/mobile_catalog_refresh.py:134`).

## 5. Works with the PC off

- **Collecting with the Chrome extension.** The active `extension-list/` sends every save to the
  paired server (`extension-list/src/save-client.js:241`), which downloads the original to R2.
  With the assets authority active, the capture becomes an Asset at once and the server makes its
  thumbnail (`api/capture_routes.py:197-256`). Saving into a folder the server does not know yet
  fails with "분류 목록 갱신 필요" (`api/capture_routes.py:62-76`).
- **Library on the tablet:** browsing, search, originals and video playback through media tickets.
- **Organizing on the tablet:** folder assignment, single or batch (`mobile/ClassificationBatchSheet.tsx`);
  album membership and likes (`mobile/AlbumMembershipEditor.tsx`); trash and restore
  (`mobile/libraryTrashModel.ts`). A trash of an image that a pending similarity decision keeps
  is refused until the PC applies that decision (`api/asset_authority.py:688-694`).
- **Catalog:** bookmarks, server refresh ("새 작품 가져오기", `api/mobile_catalog_refresh.py`),
  manga index pins, device-only visibility settings.
- **Notes and ledger:** end-to-end encrypted and server-synced (`api/notes.py`,
  `android/NotesCrypto.java`). A new tablet needs the PC's recovery key once (`mobile/Notes.tsx:256`).
- **Transfer (전송):** server relay (`api/file_exchange.py`). The PC appears as a target only
  after its transfer screen has been opened once.
- **Manga release inbox "확인":** server-owned acknowledgement (`api/collection_releases.py:1-17`).

## Corrections to older documents

- [`edge-extension.md`](../edge-extension.md) routing modes (`auto`/`pc`/`cloud`), the
  browser-download fallback and "local-only classifications" describe the removed `extension/`.
  The active collector has none of them. It never calls the PC loopback interface on port 32145,
  though the PC still serves it (`tauri/extension_api.rs`). Its unused `result.localOnly`
  branch (`extension-list/src/content.js:175`) is a leftover.
- The AV area is not PC-only for viewing: the tablet browses AV works and performers, gated by
  privacy mode (`mobile/Collections.tsx:427`), and edits rating/memo/status like other Collections.
- The Private Vault is not desktop-only for reading: the tablet reads an attached vault USB
  through Android storage access.
- The server holds a Kakao key and runs MangaDex/Kakao binding searches itself; "the server holds
  no provider keys" in older Collection designs is out of date.
- The comment at `api/app.py:997-1002` says classification "ships no activation route", but
  `api/classification_authority.py:1370` has one.

## Not verified

- Production activation of each authority domain (taken from the completed log).
- Whether any tablet still holds the shared token that older `require_auth` routes accept.
- Whether artist-style suggestions are excluded from the artists publication.
- No native PC, Android device or live-server run was part of this audit.
