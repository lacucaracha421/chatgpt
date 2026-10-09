# Dormant server release calendar contract (2026-10-09)

Audited `release_calendar.rs`, `release_wishlist.rs`, `home_publications.rs`,
`igdb.rs`, `tmdb.rs`, `server_release_checks.rs`, `home_upcoming.py`, and the
Kakao worker. Server/fixture changes only; no activation, deployment, live
provider calls, production library access, or PC handover.

## Snapshot compatibility

The existing `GET /v1/home/upcoming` reads the same store. Document keys:
`generatedAt, rangeStart, rangeEnd, entries, wishlist, sources`. Upload-only
`version`/`intentCursor` are excluded from the digest. Response metadata remains
version 1, revision, publishedAt, acknowledgedThrough, pending, and ETag/signals.

Public entry keys: `id, kind, title, originalTitle, date, precision, region,
platforms, releaseType, cover, popularity, port`; releaseType is null. Internal
provider/externalId/dates/watched are omitted. IDs: `igdb:<id>`, `tmdb:<id>`,
`tmdb:tv:<show>:s<season>`. Text replaces Unicode controls with spaces, trims,
and truncates by characters (500 title/original, 16 region, 32 platforms × 100).
Popularity is a float; negative/nonfinite values publish as null.

Covers match PC validation: IGDB ASCII alphanumeric/underscore IDs become
`https://images.igdb.com/igdb/image/upload/t_cover_big/<id>.jpg`; TMDB ASCII
alphanumeric `/_.-` paths starting `/`, without `..`, become
`https://image.tmdb.org/t/p/w342<path>`. Invalid/over-2048-character URLs are null.
Entries sort by date, precision rank exact/month/quarter/year/tbd, descending
popularity, then ID. Period overlap and rangeEnd are exclusive. Window:
today minus 7 through today plus 183 days. **Timezone difference:** the server
pins today to UTC+09:00; PC uses OS-local today.

Public sources include **igdb and tmdb movies only**, in that order, with
fetchedAt/errorCode. Anime entries are included; PC publication omits tmdb_tv
status. Worker status exposes all three lanes. Canonical JSON uses the existing
sorted-key compact Unicode encoder. The shared fixture pins public entry values
and canonical bytes with fixed inputs; independent clocks cannot produce
identical complete snapshot bytes including publication timestamps.

## Provider parity

| Lane | Query, filtering, normalization |
| --- | --- |
| IGDB | Exact fields/APICalypse query pinned in fixture; two pages × 500, hypes >= 30, sort hypes descending, version_parent null, parent_game null or remake/remaster types 8/9. Platforms in order: 6 PC, 167 PS5, 48 PS4, 508 Switch 2, 130 Switch, 169 Xbox Series, 49 Xbox One. Query enforces popularity/parent rules; parser excludes add-on types. Cancelled/canceled dates are ignored. date_format wins over deprecated category; missing format plus timestamp means exact. Month/quarter/year normalize to first day. Region names or numeric fallback; headline Korea → Asia → worldwide → earliest elsewhere, most precise on ties. Earliest row per region/platform wins **before** window filtering, so same-platform later releases may disappear. Old major-platform periods set port; only overlapping dates/platforms remain. Korean localization uses KR identifier or korea region name. First accepted ID wins; bare years stay, TBD does not. |
| Movies | Three Discover pages, region KR, types 2\|3, ko-KR, popularity descending, no adult/video; inclusive query end = rangeEnd−1. Inspect first 60 results, not 60 unique IDs. Reject primary date strictly before rangeStart−365 days. Deduplicate accepted titles only. Detail dates choose earliest KR theatrical type 2/3 plus primary worldwide date, then headline/overlap. **Actual PC behavior:** missing KR detail permits a worldwide fallback. Korean title falls back to original. |
| Anime | Three Discover TV pages, JP origin, animation genre 16, ko-KR, popularity descending, air_date window, no adult. Stable-sort and read 60 unique positive show IDs; 404 skips a show, other errors fail the lane. Detail ID must match and seasons must be an array. Only season >= 1 with overlapping exact start; no specials, undated or continuing old seasons. Season 1 uses show name; later seasons append a meaningful Korean label or ` · 시즌 N`, excluding generic Season/시즌 labels. Season poster falls back to show poster, region JP, names fall back to originals, first season ID wins. |

## Dormant worker and publication

`LAKOMICS_RELEASE_CALENDAR` defaults OFF: startup creates plain state/status
tables, but no thread or requests. Missing any provider credential also prevents
startup. `serverReleaseCalendar` joins the Collections status feature list used
by the PC Kakao gate only with switch on, all keys, and a live non-draining worker.
An old PC still publishes full snapshots; handover is a later step.

One daemon, 30-second initial delay, 10-minute wakes, sequential requests, shared
relay locks/pacing (IGDB 250 ms, TMDB 100 ms). Busy interactive work yields the
wake. Bounds: 240 seconds/wake, 180 seconds/source, 128 calendar queries plus
bounded OAuth/401 retry, 20-second request deadlines, 5-second socket cap,
4 MiB/provider reply, 500 rows/Discover page, 3000 entries, 8 MiB/document.
Interactive IGDB retains its existing 2 MiB default. No artwork downloads.
Budget exhaustion discards incomplete source results, preserves completed caches,
and rotates nextProvider to avoid starvation; a later wake retries that source
from the start.

PC **calendar** cadence/backoff is ported, rather than Kakao's progressive table:
success fresh for 24 hours, failure backoff 1 hour per lane. Manual run permits
retry after 1 minute but retains a 1-hour success minimum; Settings Immediate
bypass is not exposed. Public errors: credential_not_configured,
invalid_credential, rate_limited, timed_out, unavailable, invalid_response.
Content older than 180 days is excluded for every lane, as PC does, and expired
server cache content is cleared.

Fetches hold no database lock. BEGIN IMMEDIATE reloads the latest wishlist,
validates the normal Upload contract, and atomically updates caches and the same
snapshot/digest/known-ID/cover-reference store, including wishlist artwork blobs.
**No intent application:** intent_sequence, acknowledged_through, pruned_through,
pending intents and receipts remain untouched. Wishlist contents/events stay exact.
The PC retains stable-ID matching (no fuzzy matching), manual IDs/provider fetches,
watched flags, port platform scoping, add/remove/mute/unmute, exact-event ACKs,
ordered intentCursor handling, and date_set/date_changed/released detection.
Its wishlist runner remains 24-hourly, 6-hourly within 14 days, stopping after
30 days past release, 40 titles/run with IGDB batches of ten.

Unchanged content writes no snapshot/revision/cover refs. **Intentional freshness
difference:** fetchedAt-only changes stay in worker state/status; published
fetchedAt remains the previous publication's value until semantic content changes.
generatedAt changes only on publication. Error/cache-availability/range changes
are semantic; worker bookkeeping still records completed checks. Fresh wakes
with no changed day/expiry/content perform no writes or requests.

## Routes and verification

Client-authenticated `GET /v1/home/upcoming/calendar/status`: version,
enabled/configured/alive/busy, wake counters/times/stopReason/nextProvider and
three source fetchedAt/attemptedAt/errorCode/due records.
`POST /v1/home/upcoming/calendar/run`: `{}` or `{"version":1}`, queues Manual,
returns `{"version":1,"queued":true}`. Auth precedes availability. Disabled:
404 releaseCalendarUnavailable; missing keys/dead worker: run 503; invalid/large
body: 422/413; over six requests/client/minute: 429 releaseCalendarRateLimited
with Retry-After.

`fixtures/release_calendar.json` starts with format/version metadata: ordered
provider responses → literal expected public entries. Rust adapter is left to
the controller. Plain-Python tests use real in-memory SQLite for parity, budgets,
no writes, backoff, expiry, gating, rollback and latest wishlist/cursor preservation.
HTTP/auth/relay/lifecycle/blob-cover integration needs existing API dependencies.
WSL/full-suite, Rust parity, live and native acceptance remain unverified.


## Review notes (2026-10-09) that gate activation

- **H1 (PC handover, step 2):** the PC applies a tablet wishlist "add" only from its own calendar cache (`home_publications.rs` ~510 `cached_title`, no provider calls), so an entry that exists only in the server-built calendar is acknowledged as a silent no-op. Step 2 must let the PC take the title from the published snapshot (or the intent must carry the title).
- **H2:** never publish an empty/partial calendar over an existing good document — publish only when every lane has a non-expired successful fetch (or over a server-owned document).
- **M1:** while an old PC still publishes, PC and server overwrite each other's calendar part (wishlist/cursor stay safe). Server publishes only over its own document, and switch ON only after the PC handover ships.
- **M2:** a publish failure rolls back provider caches → full refetch every 10 min. Commit provider state separately; record `stopReason: publish_failed`; log the exception class.
- **M3:** worker TMDB requests hold the provider lock (incl. pacing sleep) so interactive tablet TMDB calls get 429; sleep outside the lock or give interactive calls a short wait.
- Low parity gaps: non-object rows/null lists (Rust skips, Python fails the lane), NaN/Infinity in JSON, invalid Twitch token reply mapping, Unicode vs ASCII lowercase of IGDB regions. Clear TMDB-derived server data if the switch is later turned off for good.
