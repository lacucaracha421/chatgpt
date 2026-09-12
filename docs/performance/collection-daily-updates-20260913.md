# Collection daily updates — 2026-09-13

Implementation scope: desktop MangaDex/Kakao daily metadata refresh and separate
notification lists. Tests and timing below use the Linux host; no production
library was opened, migrated, indexed or refreshed for this verification.

## Actual provider timing

The opt-in Rust test `live_provider_latency_sample` reads public sample titles.
It reads the configured Kakao key through the OS credential backend and prints no
key bytes or response payloads. It does not open a Library. Measurements use the
Rust debug test build and include parsing; these are samples, not a release-build
benchmark or timing of the user's entire collection.

| Lookup | Requests | Before parser caching | After parser caching |
| --- | ---: | ---: | ---: |
| MangaDex, Dungeon Meshi (3 lookups) | 2 each | 0.672 / 0.410 / 0.390 s | 0.541 / 0.300 / 0.665 s |
| Kakao, 던전밥 | 1 | 0.244 s | 0.060 s |
| Kakao, 원피스 | 20 | 8.521 s | 1.967 s |
| Kakao, 명탐정 코난 | 20 | 6.661 s | 2.005 s |

Returned parsed book-item counts remained 14, 290 and 693 respectively; these are
search results before selecting the connected series, not unique owned volumes.
MangaDex returned 37 cover candidates each time.

For the final Kakao long-title samples, measured network time was 0.569/0.535 s
and explicit pacing time was 1.302/1.333 s. HTTP requests are spaced by at least
100 ms. MangaDex metadata uses at least 250 ms. Both clients reuse their HTTP
connection pools. These intervals are application settings, not measured API
quotas. Requests stop on transport/rate-limit failures and retry later.

Network/cache conditions changed between runs, so the entire wall-clock difference
cannot be attributed to parsing. A separate local comparison compiled the exact
old and new `parse_volume_product` functions against the same regex dependency,
checked equal results for 1,000 generated Korean manga titles, then measured:

- Before: 5,657,517 microseconds.
- After: 3,825 microseconds.

The local comparison isolates repeated regex compilation. Both implementations
use the same expressions and title/volume rules. This is synthetic parser evidence,
not a production throughput claim.

## Scaling and runtime visibility

A work needs a MangaDex detail request plus its cover pages, or all Kakao search
pages. API time therefore depends on result-page count as well as work count.
Automatic passes process at most eight works per provider per batch, stop starting
new works once a batch has spent 15 seconds, and continue pending batches after a
one-second pause. An in-flight work can exceed 15 seconds; provider requests and
multi-page fetching have separate bounds. Images are not bulk-downloaded by the
daily pass.

At 100 works, roughly two requests per MangaDex work imply an approximately
50-second pacing floor before batch pauses and additional network/DB work. For
Kakao, 100 one-page works imply roughly a 10-second pacing floor, while 100
20-page works imply roughly 200 seconds. These are extrapolations, not a measured
full-library run. A mixed collection combines both providers' work.

Each provider list exposes actual request count, processing time, network time,
pacing delay, remaining work and retry time. The remaining-time estimate uses the
current run's average processing time and excludes the other provider and batch
pauses; it is not a promised completion time. Skipped invalid/missing works retry
the next day. Temporary transport/server failures retry after 5s, 30s, 2m,
then 10m (capped); successes reset the consecutive-failure count. Quota failures
back off through 1m/2m/5m/15m and honor Retry-After or MangaDex's epoch header,
with an upper bound of 24h. Authentication/access errors retain a one-hour wait.
The scheduler wakes at the earliest provider deadline. Legacy generic transport
cooldowns are interpreted using the shorter first retry; quota/auth waits remain.
Safe persisted diagnostics identify the work, request stage and HTTP/transport
category without storing URLs, queries, credentials or response bodies.

## Verification

- Focused Rust tests cover bounded continuation, no rechecking within 24 hours,
  independent provider cooldown, malformed-work deferral, explicit-zero ownership,
  migration preservation, MangaDex baseline/deduplication, pagination over 100
  covers, and Kakao's count-entry/subscription combinations including future dates.
- Existing MangaDex flow, Kakao, book-title parsing and ownership tests were run.
- Seven focused frontend tests cover provider separation, grouping, click routing,
  explicit confirmation/failure, count entry, batching and library unmount behavior.
- TypeScript check passed.
- An isolated browser fixture used the real CollectionBrowser/ReleaseInbox/shared
  virtual grid with 240 notifications. Verified provider switching, no images,
  grouping, title-to-work ID routing, provider-scoped confirmation, and keyboard
  End navigation to item 180. The 180-item list rendered 10 rows in the measured
  viewport. This does not prove a native Tauri window or native command integration.
- The broader CollectionBrowser test run had three pre-existing cover-runtime mock
  failures (`coverSourceUrl` missing); those unrelated mocks were left unchanged.
- Windows-native, Linux-native application acceptance, and production schema-v73
  migration remain unverified. No commit, push, deployment or production write was
  performed.

## Retry and control follow-up (2026-09-13)

- Reproduced both the one-hour transient wait and the missed short retry deadline
  in focused tests before fixing them. Isolated-library tests cover escalating
  retries, quota headers, resuming without duplicate work, rejected-work deferral,
  legacy status compatibility and safe diagnostics.
- The ownership checkbox replaces the hidden menu action and redundant status
  prose. Rating remains an exact-value filter (0–5 in 0.5 steps), displayed as
  ten cells with all/unrated presets. No ownership/notification gating changed.
- Browser fixture uses the actual workspace navigation, collection detail and
  library controls. It verifies checkbox changes, segmented slider keyboard
  input and sidebar layout; this is not native Tauri/production acceptance.
- After the retry changes, the opt-in Rust provider probe also passed without
  opening a library: MangaDex samples 846/362/646ms (two requests each); Kakao
  samples 81/2042/2017ms (one/twenty/twenty requests). These are connectivity
  samples, not evidence that a previous intermittent failure cannot recur.
- Browser drag produced 2.0 points; End then Left produced 4.5 points. The
  checkbox and count remain on the same row at the default 240px index width.
