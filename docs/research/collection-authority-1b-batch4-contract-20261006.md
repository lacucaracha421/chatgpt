# Collections authority 1B batch 4 contract

This implementation is dormant until separately approved authority activation. It
does not activate a library, deploy a server, migrate production data, or retire
the inactive publication lanes.

## Providers and merge ownership

MangaDex, Kakao and Aladin fetch on the PC. An adopted active PC queues
`bindProvider` when identity/configuration changes and `applyProviderSnapshot`
when the raw snapshot or PC provider-value projection changes. The exporter and
command path share that projection, including MangaDex `originalTitle`.

The PC does not merge provider work fields or replace the binding snapshot before
acceptance. Accepted receipt entities and the ordered change feed materialize the
server's resulting values. Artwork, discovered volumes and book sources use the
batch 3 command helpers; their existing optimistic projections remain separate
from provider field merge ownership. New MangaDex works are created with empty
provider fields and then receive a binding/snapshot command.

Snapshot commands carry the confirmed or FIFO-predicted `baseSnapshotDigest`.
`providerSnapshotStale` records a durable drop, applies the conflict's confirmed
binding, refetches the provider once outside the database lock and queues a new
immutable snapshot intent. A second stale refusal or failed refetch leaves drop
evidence and does not block unrelated outbox commands.

## Tracking and shared acknowledgements

Ownership count replacement (including explicit zero) uses
`setOwnershipTracking`. Individual physical/digital edits use publisher-only
`setVolumeOwnership`. FIFO ownership projection accounts for earlier count
replacement and individual edits when computing expectations. Subscriptions use
`setReleaseSubscription`. These controls materialize confirmed state through
receipt/feed rather than modifying shared tracking tables ahead of acceptance.

The tablet already uses `/v1/collections/releases/acknowledge` for individual and
all-work confirmation. Therefore acknowledgements must remain shared. Two minimal
authority commands reuse the existing server release store:

- Publisher `recordReleaseEvent`: `workId`, `eventId`, `provider`, `kind`,
  `volumeNumber`, `previousValue`, `currentValue`, `detectedAt`.
- Client `acknowledgeReleaseEvents`: `workId`, `eventIds` (1–500 unique IDs).

Both keep authority receipts and revisioned full work states. Work
`derived.releaseEvents` carries full events including `readAt` for the PC replica;
`derived.unreadReleaseCount` carries the count. The tablet's existing ACK route
atomically invokes the authority shim while preserving its existing request/reply
shape. Unknown/already-read IDs remain no-ops. Inactive `/v1/collections` response
composition is unchanged; a regression test compares response bytes.
The tablet's all-work ACK is split into deterministic 500-ID authority commands
inside the same transaction. PC commands use the existing bounded release-store
retention as well as the tablet route.

Provider/source/volume commands refresh the server's derived release schedule.
Worker cooldowns, seen-volume baselines and subscription check times stay local.
Repeated unchanged snapshots, ownership choices and pending acknowledgements are
deduplicated. Successful active refreshes receive a local daily cooldown even when
no binding command is needed.
Active workers count newly queued release intents rather than waiting for local
feed events, so new MangaDex volumes still trigger their scoped cover downloads.

## Replay, fences and writer guard

Active personal-edit replay consumes local receipts/cursors as skipped; the server
shim already owns shared edits. Binding requests are fenced before provider calls.
Release-read replay advances only its local cursor; the work feed owns read state.
The active PC full unread-set upload is disabled and the server rejects legacy
release uploads, preventing an old publication from replacing authority events.
Inactive replay/publication keeps its existing path.
Automatic personal-edit, binding-request and release-read receive lanes return
quietly while active before obtaining credentials or contacting the server. The
explicit personal/read replay entry points remain cursor-only if invoked.

TMDB/IGDB apply, refresh and artwork replacement, IGDB connect on a hand-made
game, book import and legacy package execution return the existing Korean fence:
"서버 이전 후 다음 단계에서 다시 지원합니다." Automatic IGDB information filling
returns quietly while active. Low-level legacy writers also have fences, except
the existing core-record helpers whose callers already own transactional routing.

Batch 4 file-wide writer exemptions are removed. Named routed/fenced functions,
embedded fixtures, local worker state and the batch 6 startup book-kind backfill
retain explicit bounded exemptions. Startup normalization remains batch 6 work.

## Acceptance limits

No app launch, device checks, production-library access or real-server requests
are part of this batch. The server unit suite must run in WSL; this host's WSL
startup returns `Wsl/Service/E_ACCESSDENIED`. Python AST checks establish syntax
only and do not substitute for server execution. Native and deployed cross-device
acceptance remain unverified until separately authorized checks.
