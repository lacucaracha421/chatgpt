# Shared Manga index

Source contract for Manga round slice 6. Deployment, production migration and
native/device acceptance are separate operations; this document does not authorize them.

## HTTP contract

All routes require the existing client credential (publisher credentials also qualify).
The prefix is `/v1/mobile-catalog/index`.

| Method and route | Request | Response |
| --- | --- | --- |
| `GET /pins` | Exactly `libraryId` and `epoch` query parameters | `libraryId`, `epoch`, `contractVersion: 1`, `revision`, `items`; ETag/304 supported |
| `PUT /pins/{kind}/{namespace}` | JSON command below | Authority identity, list `revision`, `changed` and the accepted entity state |
| `GET /frequent` | Optional `language`, `categories`, `excludedTags`, `revealBlocked`, using Catalog search encoding | `ready`, `publicationRevision`, `bookmarkCount`, `tags`, `artists`, `tagLimit: 8`, `artistLimit: 5` |

The command has exactly these fields:

```json
{
  "libraryId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "epoch": 1,
  "contractVersion": 1,
  "operationId": "00000000-0000-0000-0000-000000000001",
  "expectedRevision": 0,
  "desiredState": true,
  "value": "example_tag",
  "label": "Example label"
}
```

The entity identity is `(kind, namespace, value)`. `kind` is `tag` or `artist`;
namespace is 1–32 lowercase ASCII letters. `artist` requires namespace `artist`;
`tag` excludes that namespace. Value and label are nonblank, contain no control
characters, and are limited to 200 and 400 UTF-8 bytes respectively. Value stays
in JSON so spaces, Unicode, quotes and slashes never become path segments.
Commands are bounded to 4096 bytes.

Each snapshot item carries `kind`, `namespace`, `value`, `label`, `desiredState`,
`entityRevision`, `createdAt`, `updatedAt`. Deletion is `desiredState: false` and
keeps a tombstone. A snapshot is coherent, unpaginated and bounded to 4096 entities
and 3 MiB; a mutation that would make recovery unreadable is refused atomically.

An identical operation-id retry returns its durable receipt. Reusing an id with
different command contents fails. An idempotent desired state leaves list/entity
revisions unchanged. A label change on a live pin increments them. Stale entity
revisions return 409 with `detail.code: revisionConflict`, `detail.current` (the
entity state) and `detail.authorityCursor` (the list revision). Receipts have the
same 180-day retry window as bookmarks. Tombstones remain in the bounded snapshot.

## Authority and client merge

Pins share the active bookmark library/epoch fence and require no separate
activation action. Publications never replace pin state. Aggregate sync status
advertises `manga-index-pins` with the same identity and its own list revision, so
the existing PC status watcher notices a tablet pin change.

Migration 0119 adds PC synchronization state, entity revisions and an outbox.
Existing 0118 pins become pending intents. Local pin changes and their outgoing
operations commit together. PC pulls replace `manga_index_pins` from the complete
snapshot, then overlay pending local intents; a pull never enqueues anything.
Confirmation retires only the operation actually sent, preserving a superseding
user action. A final-read failure forces another full pull on the next pass.
Adopted pin authority also blocks unsafe whole-database restore.

Tablet intents and the last observed snapshot live in one durable storage record
per endpoint and library. Sends include the endpoint fence already used by mobile
outboxes. A different connection or library cannot receive an old connection's
intent. A storage failure refuses the visible change and shows an inline error.

Both clients preserve operation ids across transport retries. A revision conflict
keeps user intent, adopts the current revision and retries once with a new operation
id, or completes without another write when the server already has the requested
state. Further conflicts remain queued. Epoch changes rebase only within the same
library. Undelivered intent remains overlaid and marked pending on the tablet.

## Tablet presentation and counting

The filter sheet places pinned chips, the top eight non-pinned tags, and the top
five non-pinned artists before the unchanged device filter controls. A solid
pushpin marks pinned chips. Tap selects one condition (or clears the same one);
long-press pins/unpins and suppresses the tap. Scrolling cancels a pending press;
Shift+F10 provides the equivalent pin action for a keyboard.

The removable `name ×` chip sits directly above the list. It remains visible when
the sheet closes and leaves the search draft intact. The existing quoted namespace
grammar adds one condition with AND, parenthesizing typed expressions. Index search
uses latest order rather than a time-limited popularity window; clearing restores
the selected browse sort.

Frequent counts start from live authority bookmarks and probe the immutable published
catalog, counting distinct works per exact tag/artist identity. They respect the
catalog's language, categories, excluded tags and reveal-blocked policy. Namespaces
`language`, `temp` and `parody:original` are excluded. Labels use the same published
translations as tablet details. Counted entries are returned in count-descending,
identity order; the sheet applies display limits after removing pins, retaining
the full count projection for pinned chips. Pins without eligible bookmarked works
display zero. `bookmarkCount` counts all authoritative bookmarks, as on the PC.

An old server, inactive bookmark authority, missing publication or offline read
hides the index quietly. Existing filter controls remain available according to
their original capability rules. A pin action in an already-loaded sheet can still
queue offline and uses the existing inline error/status presentation. Foreground,
network-restored and visible safety retries resume delivery.

## File ownership

- Server deployment files: `server/lakomics-api/manga_index.py`, `mobile_catalog.py`,
  `sync_status.py`. Tests: `tests/test_manga_index.py`, `tests/test_sync_authority.py`.
- PC: migration `0119_manga_index_pin_sync.sql`; library `manga_index_sync.rs`,
  `manga_index_sync_tests.rs`, `manga_index.rs`, `manga_index_tests.rs`, `db.rs`,
  `mod.rs`, `authority_pass.rs`, `restore_guard.rs`; cloud `client.rs`.
- Shared UI: `src/manga/MangaPinIcon.tsx`, `MangaIndex.tsx`.
- Tablet: `mobile-client/Catalog.tsx`, `CatalogSettings.tsx`, `Catalog.css`,
  `CatalogIndex.tsx`, `CatalogIndex.test.tsx`, `mangaIndexPins.ts`, `useMangaIndex.ts`.
- Android: `NetworkPolicy.java`, `NetworkPolicyTest.java`. The platform-free test
  remains in the existing `android/build.py` check list and can run independently.
