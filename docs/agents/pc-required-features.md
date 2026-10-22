# What still needs the PC

Source checkpoint: 2026-10-22 at `2e8db984`; Android 0.9.140 (277).
This describes source capabilities. Deployment/installation evidence is in the
[completed ledger](../roadmap/lakomics-completed.md) and [backlog](../roadmap/lakomics-backlog.md);
no native, device or live-server check was performed in this pass.

## PC-only work

- Character registration/reference management, recognition, learning, member runs, new-character suggestions and deep character management. Favourite-character manual entries are a separate shared feature.
- Classification folder move/delete and deep tree reorganization. Tablet can create/rename child folders and edit icons/colors.
- Artist merge/detach, auto-tag management, similarity computation and review application, catalog baseline publication and duplicate-edition application.
- Local file/folder import, manga folder/ZIP/CBZ import, local manga access and native drag-out; original video derivatives/transcoding and local analysis jobs.
- Private Vault creation/write management; tablet can read an attached vault through Android storage access.
- Local jacket import/cropping and local/Wikimedia portrait tools. Arbitrary tablet portrait crop remains [AV-AUTHORITY-001](../roadmap/lakomics-backlog.md#av-authority-001--av-acceptance-and-remaining-profile-polish).
- Metadata backup/recovery tools, subject to authority-aware fencing: adopted server authority refuses whole-database snapshot restore. See [PC migration](../operations/pc-migration.md).

Natural-language search is paused (`7b9e092e`); retained Python workers/routes do not make it an available PC feature.

## Shared tools that work with the PC off

- Server-first Companion capture and Asset lifecycle, shared library browsing/search/media tickets, Asset classification, Likes, Trash/restore, Album creation/rename/membership and supported folder management.
- Collections authority: create/edit Works, rating/memo/Showcase/status/platform/ownership, artwork/bindings and Trash through supported commands. Remaining publisher-only operations stay fenced.
- Server AV inbox lookup/apply, StashDB people/portraits and supported performer profile edits; these are not a PC-only projection.
- Server MangaDex/Kakao bindings and release checks, per-provider notification acknowledgement, release calendar and wishlist; the calendar/wishlist fallback remains recorded in the backlog. Aladin is legacy.
- Curated favourite characters, manual name entries, related Works and later Asset-character links. Cover-only media stays out of ordinary Asset lists/counts/search/Home; existing Assets reused as covers stay ordinary. Recognition remains PC-owned.
- Encrypted Notes/ledger, Home calendar/day memo, cards/card album, catalog bookmarks/server refresh, and device transfer (direct where reachable, otherwise server relay).

## Publication and delayed application

The PC still publishes the character tree/review data, artists/display tags,
similarity and catalog duplicate candidates, and the initial catalog baseline.
Character review/exclusions, artist overlays and similarity/catalog decisions can
be recorded on tablet before the PC applies its local work. New server Assets are
materialized locally when the PC runs. Fresh PC-only changes need publication
before server reads, including the Arca picker, can show them.

The old Home AV-pick lane is retired. Home upcoming and AV lookup have server-owned
paths; do not infer current ownership from older publication-lane counts.

## Historical guidance and limits

The removed `extension/` routing modes, automatic download fallback and
`/v1/extension-backup` envelope are historical. The active collector is
[extension-list/](../../extension-list/README.md), with pairing/profile settings
and explicit temporary downloads. Its Arca picker separately uses PC-first/server-fallback reads.

Production domain activation, older credential-role exposure and recipient Photo
Picker compatibility were not rechecked here. Current source/migrations/contracts
define supported commands; [ADR-0037](../adr/0037-server-authority-v2-replica-and-command-contract.md)
remains Proposed for its generic architecture.
