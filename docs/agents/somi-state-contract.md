# Somi shared state, version 1

Somi metadata is separate from the catalog and library databases. The server
lazily creates `data/somi.sqlite3` beside its control database. PC UI reads and
writes only its existing `somi/somi.db`; it never waits for the server to save a
bookmark or page. No tablet implementation is included in this step.

## Authentication and discovery

Every route uses the same `api_auth.client_guard` as mobile catalog bookmark
reads and writes: `Authorization: Bearer <ordinary cloud credential>`. Registered
client and publisher credentials and the legacy shared client credential work;
missing, invalid and revoked credentials return 401. No publisher-only operation,
library activation, library ID, epoch, kone session or hidden window is required.
`GET /v1/mobile-catalog/status` advertises `capabilities.somiStateVersion: 1`.

## Wire contract

All request and response names use camelCase. Unknown write fields are rejected.
IDs match `[A-Za-z0-9_-]{22}` exactly. `changedAt` is a nonnegative integer UTC
Unix timestamp in **milliseconds**. `postSeconds` is a nonnegative integer Unix
timestamp in **seconds**. Both fit SQLite signed 64-bit integers. Clients use
their last local timestamp plus one when their clock has not advanced.

| Route | Request | Success |
| --- | --- | --- |
| `GET /v1/somi/state?since=0&limit=200` | `since`: last successfully applied revision, initially 0. `limit`: 1–200, default 200. | `{items, nextRevision, latestRevision, hasMore}` |
| `PUT /v1/somi/bookmarks/{post_id}` | `{bookmarked, title, writerHandle, writerName, coverKey, postSeconds, changedAt}` | Stored winning bookmark row |
| `PUT /v1/somi/progress/{post_id}` | `{page, changedAt}` | Stored winning progress row |

Bookmark fields: `bookmarked` is a strict boolean; `title` is at most 1024 Unicode
characters; `writerHandle` and `writerName` at most 256 each. These strings may be
empty but contain no ASCII control characters. `coverKey` is empty or exactly 64
lowercase hexadecimal characters. `page` is the viewer's **one-based** page number,
1–1,000,000. Numbers must be JSON integers, not strings, floats or booleans. Invalid
fields return 422; request bodies over 16 KiB return 413.

Each returned row adds `postId`, `kind` (`bookmark` or `progress`) and `revision`
to that kind's request fields. There is one stored row per `(postId, kind)`.
The two kinds resolve conflicts independently. A strictly newer `changedAt`
wins. An equal or older timestamp returns HTTP 200 with the stored winner,
without moving the revision. Identical retries are harmless.

The server assigns globally increasing revisions in the same transaction as the
winning write. A bookmark with `bookmarked: false` remains a tombstone and is
included in changes. No expiration/pruning of these rows is implemented.

The change response contains current rows whose revision is greater than `since`,
ordered by revision, rather than every historical mutation. Read and write
timestamps never act as cursors. Apply each page and persist `nextRevision`
atomically. Continue while `hasMore` is true. `latestRevision` is the latest server
revision at that page's read snapshot; do not jump to it before applying intervening
pages. The final page's `nextRevision` equals `latestRevision`. A cursor ahead of
the server returns 409; do not silently advance or discard local changes.

## PC behavior and tablet reuse

PC first pushes dirty rows, adopts each returned winner, then pulls changes.
A failed push keeps its dirty row; a reply cannot acknowledge a more recent local
edit. Applying a pull page and its cursor is atomic. Cursors are scoped to the
configured cloud endpoint. Existing reading rows migrate in place with timestamps
converted from seconds to milliseconds and marked dirty.

Entering Somi and window focus trigger reconciliation at most once per minute.
Local bookmark changes trigger it immediately. Page writes happen locally on each
turn; a single background timer waits for four seconds of inactivity before
reconciliation, and viewer close flushes. Changes arriving during a successful
sync request another pass. Failures remain silent and back off for one minute;
404 responses back off for an hour. Missing credentials therefore stay local
without repeated requests. A later trigger retries; there is no busy retry loop.

Bookmark rows survive kone logout and are hidden while logged out. The bookmark
view includes stored metadata when a post is absent from the board index or gone.
Opening still uses the existing kone reader and its gone message. Bookmark toggles
never call `article/get`. Covers are saved in the device's existing thumbnail cache
using board-list cover resolution, without uploading any image to this service.

Only the listed metadata travels to these routes. Cookies, account records,
images, signed URLs and page addresses stay on the device. A tablet must acquire
its own kone session and images, reuse this state contract, and keep the same
local-first, conflict and retry semantics. Deployment and native acceptance are
separate from implementation and tests.
