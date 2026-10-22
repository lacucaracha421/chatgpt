# Lakomics

Lakomics is a personal media library for collecting, classifying, rediscovering,
and viewing images, GIFs, videos, and Works such as games, manga, movies, and AV.
The PC manages a local Media Vault, the Android tablet uses shared library data
through the Cloud API, and a browser collector saves media while browsing.

## At a glance

| Component | What it is for | Platform | Documentation |
| --- | --- | --- | --- |
| Desktop | Import and organize Assets, manage characters, browse Works and manga, and publish library data | Windows and Linux; Tauri 2, React, Rust | [Desktop guide](_tools/app/README.md) |
| Android tablet | Browse shared media, change supported library and Collection data, read manga, and exchange files | Android; React frontend in a Java WebView shell | [Android guide](android/README.md) |
| Cloud API | Serve shared library reads, authoritative changes, captures, releases, cards, and transfers | FastAPI server and object storage | [Cloud reference](docs/agents/cloud-capture.md) |
| Browser collector | Capture media, translate text/images, process YouTube subtitles, and insert library images into Arca Live posts | Chromium MV3; desktop browsers and supported Android extension browsers | [Lakomics Companion](extension-list/README.md) |

This guide describes reachable features in the source checked on 2026-10-22 at `2e8db984`,
not installed-client versions or a new live-service/device verification.
Features are for **PC and tablet** unless marked otherwise. Connection,
publication, provider credentials, or a running PC may be required as stated.

### Find your way

- Open Home (홈), Assets (에셋), Collections (컬렉션), Manga (망가, PC), Catalog (카탈로그, tablet), and Notes (메모) from main navigation.
- Open Transfer (전송), Artists (작가), Unsorted (미분류), Similarity Review (유사 검토), Trash (휴지통), and Settings (설정) from their entries or More (더보기).
- Use Find (찾기) to jump to a Work, folder, character, tag, artist, note, menu, or settings section by name, with Korean initial-consonant matching.
- Search the current area from its search control, or narrow Find results with its scope choices.
- Return through the current area's history; PC Escape/mouse Back and Android Back close the foremost surface before leaving its screen.

See [product vocabulary](CONTEXT.md): an Asset is a managed media file; a
classification folder organizes it; an Album is a manually assembled list;
a Collection represents a Work. Online Catalog is a separate browsing area.

## Home (홈)

### Calendar and things to check

- Browse a Sunday–Saturday month grid of saved images and game, movie, anime, and linked manga releases; select a day to inspect its entries.
- Write a selected-day memo, add or edit ledger entries, and inspect the monthly total; subscriptions and wishlist lists start folded.
- Korean lunar/election holiday dates are supplied for 2026–2027; later years need an updated holiday table.
- See collected-image counts by date and reopen the corresponding Assets from the calendar.
- See ledger payment reminders alongside releases and open their associated note; daily cards sit beside the compact Transfer column.
- Open Today's tasks (오늘 할 것) to reach character confirmation, similar-image review, Unsorted Assets, pending captures, or received AV codes where applicable.
- Check server/device connection summaries and open the relevant destination when work is waiting.
- Open character Confirmation (확인) on PC; tablet confirmation appears when the PC has published the review capability and candidates.

### Daily cards and card album

- Open Today's card (오늘의 카드), tear open a five-card pack, reveal its cards, and choose which to keep in the shared album.
- Receive a daily pack at the 05:00 reset and a bonus pack after saving 50 images that day; resume an unfinished keep step.
- Collect cards made from registered characters and library images, with rarity, duplicate counts, levels, and serial numbers.
- Browse Card Album (카드 앨범) by series and rarity and inspect the rarities owned for each character.
- Open a card full-screen on PC and tablet; use original-Asset/character-folder links on PC where available.
- Move unwanted cards to the album's own Trash and restore them there, separately from Asset Trash.

<a id="quick-memo-and-kept-links"></a>
### Quick memo, links, and transfer

- Write in Quick memo (빠른 메모) without leaving Home and keep it with synchronized Notes data.
- Open Link keeping (링크 보관) from More or Find, paste a URL, retain its title/available preview, and reopen it; PC also supports dropping, copying, and removing links.
- Browse all kept links or only image links and import available images with Images to Assets (이미지를 에셋으로) — PC-only expanded link tools.
- Drop files onto Home's Transfer tile (전송) to send them to another device — PC-only; a Home file drop is a transfer action.

## Library and Assets (에셋)

### Import and export

- Import images, GIFs, and supported videos with File import (파일 가져오기) or drag and drop into an Asset view — PC-only.
- Import into the open classification folder, or into Unsorted when no concrete classification is selected — PC-only.
- Keep user source files: the Media Vault receives managed copies, and exact-byte duplicates reuse the existing Asset.
- Inspect added, duplicate, similarity-review, and failure counts after import, and open an existing duplicate — PC-only.
- Receive browser captures with source, creator, publication date, and chosen classification; cloud capture can accept media while the PC is off.
- Explicitly re-save a previously deleted capture to revive it; automatic retries of an old capture do not revive it.
- Export from the viewer or drag selected Assets to another application as copies on PC; Linux recipients have separate [acceptance limits](docs/operations/linux-desktop.md#linux-drag-out-follow-up-2026-09-09).
- Save an ordinary Asset's original to the gallery (Pictures/Movies/Download › Lakomics) or share it through the Android share sheet from the tablet viewer (원본 저장, 원본 공유).
- Import legacy metadata from a chosen folder in Settings → Advanced (고급), or repeat the last folder import — PC-only.

### Browse, filter, and select

- Browse all Assets, Unsorted, recent saves, Likes, classification folders, Albums, and character galleries.
- Switch Waterfall (폭포수)/Equal-height rows (같은 높이), adjust thumbnail density, and browse images grouped by date.
- Sort by newest, oldest, Likes, or random order, and reshuffle the random view.
- Filter images/videos and square/landscape/portrait proportions, use available video-length controls, and clear filters from their active chip.
- Jump through long lists with the scrubber's date or position feedback.
- Select several Assets for classification, Album, Like, or Trash changes; tablet offers select all, drag selection and long-press action sheets.
- Use click, Ctrl-click, Shift-click, Ctrl+A for loaded Assets, and keyboard focus navigation — PC-only.
- Open a context menu without changing selection — PC-only; actions target the pointed Asset or the applicable selection.
- Open Information (정보) for an Asset or selection; PC uses a docked panel and tablet a touch-sized sheet.
- Inspect artist, source post, publication date, filename, collected date, classification, tags, and saved image text where present.
- Open other Assets from the same source post from Information when that group is available.

### Classification folders, Albums, and Likes

- Create classification folders (top-level and child) and rename them on either client; edit folder icons/colors on either client. Folder move/delete remain PC-only.
- Share pinned folders across clients; PC offers an accordion, follow-current-location and recent-folder controls. Tablet offers a folder drawer, recent destinations and long-press action sheets.
- Move Assets between classifications; each Asset has at most one direct classification, while parent views can include descendants.
- Browse child-folder shelves and breadcrumbs, and distinguish directly stored images (미분류) from the full descendant scope (전체).
- Reorder classification folders/shelf entries on PC; the published order is used by tablet navigation and the collector.
- Create/rename Albums (앨범) on PC and tablet, move them within the Album hierarchy on either client, and reuse Assets in several Albums without duplication.
- Add/remove selected Assets from an Album, including removing them only from the current Album.
- Toggle an Asset's Like heart; membership in the designated Likes Album (마음에 들어요) is the same state on PC and tablet.
- Keep a same-named ordinary Album separate from the designated Likes Album; the designated Album cannot be deleted.

### Image viewer and saved translation

- Open images/GIFs full-screen, move through the current list, zoom/pan, and return to the gallery.
- Navigate with previous/next controls or the filmstrip and drag/scrub the strip to nearby Assets.
- Reveal PC controls near their own viewer edges, or tap to show/hide tablet controls.
- Open Information, source URL, Like, classification, or Trash actions from the viewer where offered.
- Read saved image translations with numbered regions and white notes over the image; toggle Translation (번역) and inspect original/Korean text in Information.
- Read translated lines without usable positions in Information rather than losing them.

### Video viewing and preparation

- Play videos with play/pause, seeking, timeline preview, sound/volume, fullscreen, and previous/next navigation.
- Hover a ready video tile for muted playback or inspect its preview frames — PC-only.
- Use the same Asset filmstrip across images and videos, with video playback controls alongside it.
- Choose the current video frame as its thumbnail from the viewer's frame action — PC-only.
- Watch background poster/scrub-frame preparation after PC import; incompatible originals receive a Playback Proxy.
- Keep the managed original when using a Playback Proxy; preparation does not create a second independent Asset.

### Similar-image and similar-video review

- Open Similarity Review (유사 검토) from More/Home and compare existing and incoming images before completing an import.
- Choose Keep existing (기존 이미지 유지), Replace with new (새 이미지로 교체), or Keep both (둘 다 보관).
- Compare account identity, publication time, resolution, file size, and format in the clue table, with a recommendation and reason.
- Prefer a known original artist over a repost account; available date/quality clues help decide, while ties or missing evidence stay for review.
- Let clear repost cases resolve automatically under the original-author rules; discarded images go to Trash.
- Preserve the existing Asset's relevant Like/classification state on replacement while retaining the incoming image's source/collected date.
- Scan existing library images for similarity candidates from the review screen — PC-only.
- Compare side-by-side, flicker, or wipe views with touch zoom/pan — tablet-only; choices use supported server application or queued PC delivery.
- Select 2–100 videos and choose Compare selected videos (선택한 영상 비교) — PC-only; inspect matching frames, stop/resume analysis, keep either/both, or mark different.
- Keep video comparison separate from import duplicate detection: videos do not automatically enter image-similarity review.

### Tags and artists

- Inspect/edit automatic-tag decisions separately from direct classification and filter Assets with tag choices — PC-only.
- Import automatic-tag files or configure their inbox, inspect results, and preview applying tag judgments in Settings → Library — PC-only.
- Open Artists (작가) for pinned/major artists and rediscovery; PC also offers single-image and identity-cleanup views.
- Browse an artist's Assets/counts on PC and tablet, with rediscovery and similar-style suggestion tools on PC.
- Search artists; PC offers name/latest-save/image-count sorting and Unknown artist (작가 미상) browsing.
- Rename, pin, or hide artists on PC and tablet; merge identities or detach linked identities/assigned Assets on PC.
- Assign Assets to an artist or preview filling artist links from source URLs — PC-only; original creator fields are preserved.
- Review possible duplicate artists, configure major-artist criteria, and exclude folders from artist discovery — PC-only.
- Mark Repost accounts (퍼온 계정) in artist management to exclude them from style recommendations and inform original-author similarity decisions — PC-only.

## Characters (캐릭터)

### Series, groups, and references

- Browse characters inside series classifications, with character groups and Other (기타) destinations where configured.
- Register a character's name, series, representative image, references, and the detected person in each reference — PC-only.
- Inspect reference crops, change the selected person, remove unusable references, and add suggested references — PC-only.
- Register an existing character folder with a scope preview, or organize its contents into a character group — PC-only.
- Convert a parent folder into a classification container (분류함) using its preview to keep child series separately organized — PC-only.
- Move characters between series, edit group membership/order, or convert/unregister arrangements through management dialogs — PC-only.
- Assign/exclude an image from a character in the gallery/viewer; manual negatives prevent the same automatic membership from returning.

### Confirmation (확인)

- Open Confirmation from Home or the series/character review action, narrowed to one character, a series, or the whole queue.
- Compare Tag suggestions (태그 추천), Recognition suggestions (인식 추천), and Recheck (다시 확인) with references — PC-only.
- Mark Correct (맞음), Incorrect (아님), or Correct, wrong region (맞음 · 위치 틀림) when a detected crop is present — PC-only.
- Switch to batch review (모아 보기), mark incorrect images, and confirm the remaining images together — PC-only.
- Find Learning characters (배우는 중인 캐릭터) in the folded section and include them in series batch confirmation — PC-only.
- Review published candidates on tablet in direct or mark-and-save mode; queued judgments show PC-application status until republished.

### Suggestions, learning, and automation

- Browse New character suggestions (새 캐릭터 제안), inspect samples, set a minimum image count, and register/merge a suggestion — PC-only.
- Postpone/ignore suggestions and reopen ignored suggestions when needed — PC-only.
- Let the PC classify new/pending images using reference recognition and tag evidence; manual judgments provide learning feedback.
- Enable/pause automation, broader parent-folder recognition, and reference reinforcement in Settings → Library — PC-only.
- Enable Claude review for clear automatic judgments, leaving ambiguous cases in Confirmation — PC-only, with an Anthropic key; images/references are sent to Anthropic.
- Run series-member identification on eligible series images, including images with one accepted character when other members remain undecided; pending review and manual decisions are protected.
- For 2–5-member series, high-confidence Sonnet results can be accepted automatically; 6+ member series use Haiku-only recommendations for user confirmation. A “none” result does not guarantee automatic filing.
- Prepare missing recognition references on demand and inspect a backlog run’s counts, estimate and spending limit before starting — PC-only.
- Inspect recognition, learning examples, and decision status in Settings → Advanced → Character recognition status (캐릭터 인식 상태) — PC-only.

See the [character publication contract](docs/agents/mobile-character-contract.md)
for tablet reads and the PC's recognition responsibilities.

## Collections and Works (컬렉션)

### Browse and present your collection

- Switch Games (게임), Manga (만화), Movies (영화), and AV: typed Collections representing Works.
- Browse flat cover Grid (격자) or physical Shelf (선반), adjust density, and retain view choices per type.
- Open Bookshelf (책장) for manga volume spines and game/AV case spines; adjust manga/game/AV spine size.
- Group supported shelves by device/year or leave them ungrouped; sort by release date, added date, or title.
- Search Work titles and filter by an exact personal rating or Unrated (미평가).
- Pull a book/case out from its shelf, turn it, or open its details.
- Open Work artwork/facts, turn/zoom and open/close a supported 3D book/case, or reset to Front (정면으로).
- Browse manga volume covers/spines, game platform cases, AV jackets, and movie posters/backdrops.
- Create/edit a Work through the available Collection forms; tablet creation requires Collections authority capability.
- Rate a Work in half-star steps out of five, leave a memo, and edit its type-specific personal record.
- Delete/restore a Collection through Collection Trash without deleting its referenced Assets.

### Games and platforms

- Search IGDB to add/connect a game and choose metadata/cover/hero artwork on PC; tablet offers supported connection/artwork controls.
- Refresh an IGDB binding from management and keep external information separate from personal records.
- Choose Owned device (소유 기기): Switch, Switch 2, PS4, PS5, or PC; case/spine presentation follows that choice.
- Browse Steam-style PC, PlayStation, and red Switch/Switch 2 spines with Nintendo marks in Bookshelf.
- Fetch available LaunchBox game spines from Collections → View (보기) → Management (관리) — PC-only.

### Manga Collections and releases

- Add/connect a manga Work through MangaDex; connect Kakao separately for Korean published volumes and dates.
- Select multiple Kakao series (up to 40), map parts with their own volume numbering and ranges, and clean up obsolete ranges when changing the selection without changing the Work’s identity.
- Browse numbered volumes/alternate editions, choose the displayed edition, and inspect covers in the book view.
- Record owned-volume counts and inspect owned, unowned, and upcoming volumes on the bookshelf.
- Enable Release Watch (신간 감시) for a supported binding, refresh information, and review unacknowledged changes in New releases (신간).
- Review Kakao binding issues from Connection check (연결 점검), including missing volume ranges or matches needing attention.
- Keep manga Collection presentation distinct from reading manga files; the separate Manga area provides the reader.

### Movies and series

- Search TMDB to add/connect a movie, choose posters/backdrops, refresh information, or change the matched record.
- Inspect synopsis, production facts, external scores, and season information when supplied by the connected record.
- Keep personal ratings/notes alongside provider information without treating external scores as your rating.

### Favourite characters

- Open Characters (캐릭터) beside Showcase to curate favourite characters in your own order; this is separate from the four Work types.
- Choose representative images and open a profile, related Works, and automatically gathered character Assets with cover-to-detail transitions.
- Add a character by name without an Asset character; link it to an Asset character later. Paste or drop a cover image on PC.
- Newly imported cover-only images stay out of Asset lists, counts, search and Home. Reusing an existing Asset as a cover keeps it an ordinary Asset.

### Showcase and release wishlist

- Add/remove Works in Showcase (쇼케이스) independently of personal ratings and browse the curated display by type.
- Arrange Showcase order on PC; tablet reads the shared selection and offers supported Showcase changes.
- Open the separate text-list release calendar (발매 캘린더) for games, movies, and anime; search and narrow to Interest (관심) entries.
- Add/remove release wishlist entries and acknowledge release notifications; the server shares this state between PC and tablet.

See [Works boundaries](docs/agents/lakomics-works-handoff-v2.md) and
[Works viewing](docs/agents/works-viewer-design.md) for deeper reference.

## AV library and received codes

### Works, people, and jackets

- Browse AV Works/performer views in Collections, open performer pages, and follow related Works.
- Edit product code, release information, maker/label/series, performers, and personal notes through AV controls.
- Inspect alternate names, portraits, profile facts, and library Works for linked people; edit supported personal/profile fields.
- Choose jacket front/spine/back artwork — PC-only for local-file jacket import/cropping.
- Search/refresh StashDB profiles and choose portraits when the server/provider is configured.
- Use available alternate portrait sources and crop a portrait from a cover on either client — local-file and Wikimedia portrait tools are PC-only.

### AV inbox and linking

- Send a code from Cover lookup (표지 찾기) or a recognized-code control in the collector.
- Open Received codes (받은 품번) in AV Collections on PC and tablet, inspect results, and retry, correct, or dismiss codes.
- Review candidate metadata/people/artwork, then create a new AV Collection or link an existing one through the supported authority controls.
- Resolve suggested person matches or select existing people while applying a candidate; tablet also offers sequential candidate review.
- Keep failed/ambiguous lookups visible for a decision; external lookup cannot guarantee a match for every code.

## Manga catalog and reader

### Local Manga (로컬 망가)

- Choose a Manga Root (망가 폴더) in PC Settings and browse existing series without turning page files into Assets.
- Drop folders or ZIP/CBZ archives into the local Manga screen to import them — PC-only.
- Search title/artist, sort recent/title/artist/page count, and browse folder/tag/artist indexes — PC-only.
- Pin index entries, refresh series/covers, and inspect vanished-folder/catalog-recovery actions — PC-only.
- Open a local series in filename-number order — PC-only local-file access.

### Online Catalog (온라인 카탈로그)

- Search remote manga independently of Collections, switch Korean/Japanese, and inspect details/editions.
- Search titles, artists, or namespaced tags; tap a detail tag to search matching Works.
- Sort latest, views, or daily/weekly/monthly popularity; browse bookmarks with their available sort choices.
- Add/remove bookmarks for quick reopening and share bookmark state between PC and tablet.
- Inspect grouped editions, change the representative edition, and review duplicate candidates with supported tools.
- Configure avoided tags/categories and hidden results, or temporarily reveal blocked results.
- Request new catalog entries or refresh publication, with readiness and update status visible.
- Read a Work/edition without creating a Collection or importing pages as Assets.

### Reader controls

- Read local manga on PC or Online Catalog manga on PC and tablet in the full-screen reader.
- Navigate pages horizontally, open page/overview controls, zoom/pan, and show/hide controls.
- Set PC reading direction, cover-alone behavior, margins, and page gaps in reader options.
- Read one page in tablet portrait or Japanese two-page spreads after the cover in landscape, with pinch zoom/bounded pan.
- Reopen at the device's saved position where offered; bookmarks are a quick shelf rather than followed-series subscriptions.

## Notes and ledger (메모)

### Memos and tasks

- Create Text (글) or To-do (할 일) sections in the shared editor and add/reorder sections and task rows.
- Check tasks and collapse completed rows; older checklists open through To-do mode.
- Pin/color/label/search/archive notes and restore them or send them to the combined Trash.
- Hide a memo's list preview while keeping the note available to open.
- Synchronize encrypted notes, inspect conflicts, and preserve a conflicting copy when needed.
- Export encrypted Notes backups or add notes from one — PC-only backup-file controls; reveal the recovery key from Notes tools.

### Secret notes and ledger

- Create Secret notes (암호 메모) with named sensitive fields, masked values, reveal, and copy controls.
- Unlock protected notes with device protection/recovery keys; tablet supports PIN/biometrics and relocks on leaving/backgrounding.
- Open Ledger (가계부) to record spending/income, browse months, and inspect totals.
- Manage recurring payments/subscriptions and planned purchases (사고 싶은 것), with due dates and payment records.
- Open ledger payment reminders from Home's calendar.

## Cloud, synchronization, and file transfer

### Shared library and authority

- Connect the PC in Settings → Connection (연결), control capture receiving/replication separately, and inspect sync status.
- Browse published cloud Assets, thumbnails, metadata, classifications, Albums, characters, and Collections with the PC off.
- Change supported shared Asset, Album, classification, and Collection data through server commands, depending on the active capability.
- Keep PC-managed originals/a local replica; Collections/artwork/bindings/Trash and server-owned calendar/wishlist state are not just PC backups.
- Inspect pending, failed, or held synchronization in status/work panels and use available retry/recovery controls.
- Publish PC-computed character results and catalog reads; recognition and unconverted PC workflows still require the PC.
- Pair a PC browser by short-lived link or use the separate tablet/extension QR flow.
- Retain collector preferences/completed subtitles through supported server settings/cache routes, with local fallback.

### Transfer (전송)

- Send arbitrary files from Transfer, Home's tile, or file/folder pickers independently of Asset import.
- Send folders as one ZIP, inspect progress, retry failures, cancel supported work, and open received files.
- Transfer directly over LAN/Tailscale when reachable, with server relay fallback, and inspect the route in Transfer.
- Receive while the Android app is open into Downloads, or send from another app's Android share sheet.
- Check received/sent status and arrival badges and choose a registered device; each file is limited to 2 GB.
- Keep received files outside the library until explicitly imported.

See the [Cloud reference](docs/agents/cloud-capture.md) for transport details;
read its older PC-authority descriptions alongside current domain contracts.

## Android tablet specifics

### Shared screens and touch

- Use Home, Assets, Collections, Catalog, and Notes from bottom navigation with the same core media/Work presentation as PC.
- Drill into folders, Albums, series/groups, and artists using cards, breadcrumbs, sheets, and search.
- Select multiple Assets for Album/classification/Like/Trash changes, including character galleries.
- Turn/pinch-zoom supported books/cases and use portrait layouts and Android Back.
- Pull supported lists to refresh and retain old content while the next screen/list is prepared.

### Storage and Android integration

- Cache cloud media, enable thumbnail prefetch, inspect usage, and clear cached media in Settings.
- Select media through the read-only DocumentsProvider or supported Android Photo Picker integration; recipient compatibility varies.
- Save temporary images through the device flow without permanent ingestion.
- Unlock an attached encrypted vault through Android folder access and browse folders/media independently of cloud caching.
- Configure connection/device transfer credentials, privacy/NSFW options, and storage controls in tablet Settings.

See [Android setup and limitations](android/README.md). The tablet collector
runs in a separate extension-capable browser such as Helium.

## Browser collector: Lakomics Companion

### Capture and X discovery

- Hold media to open the edge classification picker, choose a destination, and explicitly save to Lakomics.
- Navigate the folder dial/children, save to parents, use pins, and reorder/hide collector destinations in options.
- Save supported X images, progressive videos, and GIF-like MP4 with source/media identity; saved indicators identify existing captures.
- Enable Save auto-like after permanent X capture; Like failures are reported separately from capture success.
- Temporarily download images/supported X MP4 on PC, or use the tablet's image-only temporary-save path.
- Open X's recommendation gallery, filter popularity/artist affinity, collect feed images, hide cards, and reset learned preferences.
- Save from X's photo-viewer translation bar or retry a capture when Retry (재시도) is offered.

### Text, page, and image translation

- Automatically translate X posts into Korean with links/mentions and an expandable original.
- Translate selections into Korean, translate-and-copy Japanese/English, or replace selected input text from the context menu.
- Translate a page in place or below its original and switch back to original text.
- Translate image text with numbered regions/positioned notes, inspect original/Korean lines, copy results, and toggle originals.
- Save from the image translation surface with translated lines/positions for later viewing in Lakomics.
- Use two-finger hold or edge-drag translation on touch devices and the selection Translation (번역) chip where offered.
- Choose models/keys/fallbacks and a shared term dictionary, inspect AI usage by feature, and clear caches in options.

### YouTube subtitles and local ASR

- Press YouTube's AI button to clean Korean captions or translate other languages on desktop/mobile YouTube.
- Watch completed chunks while others process, resume failures, retranslate, and switch original/processed captions with Shift+A.
- Set subtitle model, register, size, position, speaker markings/colors, glossary, and original-text display.
- Choose YouTube captions or optional PC Japanese transcription; Kotoba ASR/speaker diarization require a separate PC service.
- Reuse completed local/shared results and fall back to YouTube captions when local ASR is unavailable.

See [local ASR setup](_tools/asr/README.md); this service is PC-only.

### Context menu and Arca Live picker

- Open the custom menu on supported HTTP(S) pages/frames, selections, links, images, and media; Shift+right-click keeps the browser menu.
- Copy links/images, download pages/posters/current video frames where allowed, or send AV codes through Cover lookup (표지 찾기).
- Exclude sites or disable the menu; protected pages, DRM/CORS, and site handling can limit actions.
- Open Arca Live's post-editor image panel via toolbar or Alt+Shift+L; choose a folder/character/group, browse random or newest images, load more newest results, and insert selections.
- Search folders/characters in one flat list with Up/Down/Enter; use the docked desktop panel or portrait tablet sheet.
- The picker tries the PC connection first and falls back to the paired server; tablet uses the server relay. Unpublished PC-only changes need publication before they appear through the server.
- Insert using Arca's paste/upload handling and close via controls/tablet swipe; the picker does not submit posts.

See the [collector guide](extension-list/README.md) for gestures and pairing.

## Settings, privacy, and maintenance

### Display and background work

- Enable Privacy mode (비공개 모드) to mask sensitive previews/restrict relevant surfaces, separately from the NSFW filter.
- Enable the NSFW filter for eligible all-ages Asset display on PC and tablet.
- Toggle case/book sounds on PC and tablet; change application zoom, library location, and Manga Root on PC.
- Choose Windows animation behavior or Always on (항상 켜기) in PC settings, then restart to apply changes.
- Enable Saving mode (절약 모드) manually or after configured PC inactivity to reduce heavy work, then return gradually to normal.
- Inspect running/queued imports, media preparation, character work, and synchronization in the PC Work panel (작업).

### Trash, backups, and private vault

- Open combined Trash (휴지통) for Assets, Collections, and Notes and restore records of the selected kind.
- Set PC Asset Trash retention, disable automatic deletion, or explicitly empty Asset Trash.
- Metadata recovery does not replace missing originals. Full-database snapshot restore is fenced after server authority adoption; use only the recovery actions available for the active library and follow the [migration guide](docs/operations/pc-migration.md).
- Inspect server recovery points and available replica/replication repair controls in PC advanced settings; snapshot controls may be unavailable under active authority.
- Create/open an encrypted Private Vault (비밀 보관함), manage password/recovery setup, and lock it independently of Privacy mode — PC-only setup.
- Import vault images/videos/folders, organize folders, export media, and manage vault Trash — PC-only management.
- Browse/view an unlocked attached vault on tablet; it is separate from normal Assets and Notes.

### Statistics and optional play

- Open Statistics (통계) for counts, original/derivative sizes, most-opened media/Works, and recent activity — PC-only.
- Choose Play FAULT (FAULT로 플레이) in supported character/gallery views to play with eligible library images — PC and tablet, subject to privacy/content restrictions.

## Paused / not available

- Natural-language image search (NL-SEARCH-001) is paused since 2026-10-17; retained captions, embeddings, routes, and code do not make it available.
- Reading manga files inside Collections, File Workshop, Web Radar, catalog series grouping, and cross-device text/URL transfer remain backlog work.
- The retired Home AV pick, legacy collector, old checklist editor, and Markdown-rendered memo mode are not current entry points; the realistic-case upgrade was dropped.

The [living backlog](docs/roadmap/lakomics-backlog.md) records remaining scope.
Some older docs predate tablet AV/editing and server authority; current UI/domain
contracts take precedence over historical summaries.

## Development

Desktop prerequisites are pinned by [.node-version](.node-version),
[_tools/app/package.json](_tools/app/package.json), and
[_tools/app/rust-toolchain.toml](_tools/app/rust-toolchain.toml). Follow the
[desktop README](_tools/app/README.md), [Windows guide](docs/operations/windows-desktop.md)
and [Linux guide](docs/operations/linux-desktop.md) for platform setup and limitations.

After platform setup, run from `_tools/app/` on either Windows or Linux:

```sh
npm ci
npm run tauri -- dev
```

The current desktop package and shared mobile frontend are under `_tools/app/`.
From the repository root, use `bash scripts/check-project.sh` for the full check
and `bash scripts/cargo-test.sh -- <filter>` for targeted Rust tests; on Windows,
`powershell -NoProfile -File scripts/cargo-test.ps1 -- <filter>` is the sandbox alternative.

Use a disposable library for development verification. Read [AGENTS.md](AGENTS.md)
for repository workflow and production-library boundaries. Android uses its own
[build and connection procedure](android/README.md#build).

## Documentation

- [Document map](docs/README.md)
- [Product definitions](CONTEXT.md) and [design rules](DESIGN.md)
- [Architecture decisions and their current status](docs/adr/README.md)
- [Implementation and review guidelines](docs/agents/implementation.md)
- [PC responsibilities and tablet independence](docs/agents/pc-required-features.md)
- [Backup and PC migration](docs/operations/pc-migration.md)
- [Windows desktop operations](docs/operations/windows-desktop.md)
- [Linux desktop operations and acceptance limits](docs/operations/linux-desktop.md)
- [Completed and historical work](docs/roadmap/lakomics-completed.md)
