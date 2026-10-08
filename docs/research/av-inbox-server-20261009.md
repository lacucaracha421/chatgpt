# AV inbox step 1: server candidates and artwork preparation

Source contract, 2026-10-09. Server and contract only. This extends the approved
[AV link design](av-link-design-20260927.md),
[people authority contract](collection-authority-av-step3a-20261007.md), and
[StashDB relay contract](collection-authority-av-step4-stashdb-20261008.md).
The approved chooser, privacy rules, per-field choices and manual-surface protection
remain unchanged. There is no deployment or production-library operation here.
Collections authority contract version remains **1**; no new apply command is added.

## Routes and authentication

All `/v1/av-inbox` routes require ordinary Lakomics client credentials; publisher
credentials also qualify. Collector-only credentials cannot review, prepare or
change candidates. Authentication runs before body parsing, storage or provider I/O.
IDs are the original `requestId` UUID strings, not the feed sequence or a work ID.
Responses use the existing `detail` error envelope. Body-bearing inbox requests
accept at most 2048 bytes, with exactly the documented keys; empty actions send `{}`.

| Method / path | Request | Response |
| --- | --- | --- |
| `GET /v1/av-inbox` | `limit=1..100` (default 100), optional `before` sequence, `includeClosed=false` | `{items, nextBefore, hasMore}` |
| `GET /v1/av-inbox/{id}` | None | `{inbox, candidate, matches}` |
| `GET /v1/av-inbox/{id}/jacket` | None | Authenticated, stored full jacket bytes with original MIME; `private, no-store` |
| `POST /v1/av-inbox/{id}/retry` | `{}` | Detail response; requeues candidate |
| `POST /v1/av-inbox/{id}/fix-code` | `{productCode: "ABW-100"}` | Detail response; requeues corrected normalized code |
| `POST /v1/av-inbox/{id}/dismiss` | `{}` | Detail response; clears candidate, hides item |
| `POST /v1/av-inbox/{id}/artwork` | `{x1, x2, surfaces: ["front", "spine", "back"]}` | `{items: [prepared artwork]}` |
| `POST /v1/av-inbox/{id}/applied` | `{workId: "client-generated-work-id"}` | Detail response; records applied work |

List order is descending intake sequence (newest first), with exclusive `before`
pagination. It excludes `dismissed` and `applied` unless `includeClosed=true`.
`nextBefore` is the last returned sequence only when another page exists, otherwise
null. Every list item and `inbox` in detail contains:

```text
id, requestId, sequence, productCode, normalizedCode, sourceUrl, receivedAt,
status, attempts, lastError, fetchedAt, appliedWorkId, titleJa
```

`productCode` always retains the trimmed original collector input for old-feed
compatibility and immutable POST replay. Display/fetch/apply the **normalizedCode**,
which is updated by fix-code. `titleJa` is null until a candidate is stored.
`lastError` is a fixed public code, never a raw exception or provider response.
`candidate` is null when unavailable; otherwise:

```text
metadata: {
 normalized_id, title, date, makers:[], labels:[], series:[],
 actresses:[{name,image_url}], directors:[], genres:[],
 cover_image_url, thumbnail_image_url, volume
},
fields: {titleJa, releaseDate, maker, label, series, genres},
jacketWidth, jacketHeight, jacketUrl,
defaultSplit: {x1, x2, isWrap, useSpine},
performers: [{nameJa, nameKo, wikidataId, fanzaActressId}],
directors: [{nameJa, nameKo, wikidataId, fanzaActressId}]
```

`metadata` is the PC Movie-shaped normalized snapshot, not arbitrary upstream JSON.
Provider image URLs retained there are provenance only. Clients fetch `jacketUrl`
relative to their configured Lakomics API base, with Lakomics authentication;
they must not download the jacket or enrich names directly from providers.
`volume` is retained as provider JSON and is **not** converted into runtime minutes.
Release dates convert RFC3339 timestamps to a calendar date in Japan (UTC+9).
Scalar/null `series` becomes an array; maker/label/series names join with `, `.

`matches` is a deterministic list (by work ID) of live AV authority works whose
`details.av.productCode` normalizes to the candidate code, in the active Collections
library: `{libraryId, workId, name, entityRevision}`. Trashed/tombstoned works are
excluded. An inactive authority returns no matches; ambiguous authority fails with
the existing authority error. No match is auto-applied. Multiple matches stay
explicit so clients cannot silently select a duplicate. Clients read the full work
through their authority replica/baseline/feed before composing edits.

## Statuses and actions

| Status | Meaning |
| --- | --- |
| `queued` | Eligible for a worker attempt |
| `fetching` | Attempt in progress, crash lease or persisted upstream-202 backoff |
| `found` | Complete snapshot and confirmed stored jacket ready for review |
| `not_found` | LibreDMM metadata returned 404 |
| `error` | Invalid code, provider/decoding/storage failure or readiness timeout |
| `dismissed` | User discarded candidate; normally hidden |
| `applied` | Client explicitly reported its accepted authority application |

Retry/fix clear the previous candidate, error, fetched time, attempts and readiness
budget. They increment a generation and requeue under the new code. Dismiss also
increments generation and clears the candidate. These actions can supersede an
in-flight fetch; its result cannot resurrect a dismissed/replaced item. Retry can
reopen a dismissed item. Invalid corrected codes are rejected before mutation.
An applied item cannot be retried, fixed or dismissed; resend with a fresh request
ID if a new candidate is wanted. Unknown inbox IDs return `404 avInboxNotFound`.

Applied is an **explicit client acknowledgement**, not server inference. After all
chosen authority commands have accepted receipts, the client sends `/applied`.
The server requires `found` and verifies that the named live authority AV work has
the same normalized code, then records its library/work identity. Repeating the
same acknowledgement returns the current applied detail; a different work ID is
`409 avInboxStateConflict`. The acknowledgement does not verify every selected
surface/field: only the client knows the user's choices. It is not an atomic batch
of authority commands and does not undo already accepted commands. If a client
crashes after authority acceptance, it resumes its immutable operations and retries
the acknowledgement; the item remains visible until then.

## Storage, worker and limits

The six-column `av_lookup_requests` feed table and its body digest remain intact.
A companion `av_inbox`, keyed by `request_id`, adds normalized code, status,
attempts, last error, fetched time, started time, next attempt time, generation,
candidate JSON, applied work and applied library. `av_inbox_name_cache` stores
per-Japanese-name mapping JSON with fetched time. Startup additively creates tables
and seeds missing state for retained feed records. It does not access the production
library or replace/backfill a catalog database.

New intake and inbox state commit together. Actionable rows (including errors and
not-found) are retained until reviewed. On insert, the existing bounded 1000-row
prune removes feed records older than 30 days only if closed (`dismissed`/`applied`)
or lacking inbox state. Associated inbox state is removed too. Candidate/jacket and
unused prepared objects are not deleted from blob storage by this module; existing
storage retention applies. Review volume therefore affects retained storage.

The jacket bytes use `work-artwork/mobile/{sha256}`, the shared content-addressed
artwork namespace. `_stored_blob` confirms HEAD size/type after storage; confirmed
receipts are registered in `mobile_collection_artwork`. Candidate JSON retains the
jacket manifest, dimensions, default split and name mappings, so restarts do not
need provider downloads for stored candidates. Jacket reads verify storage length,
MIME and SHA-256 against the stored manifest. Shared artwork admission is
nonblocking: an occupied decoder/storage lane returns `providerBusy` (worker items
become retryable errors).

One daemon worker starts/stops through `AppLifecycle`; drain signals its stop event
and wakes its idle wait. Join participates in the shared shutdown budget. It
processes one candidate at a time with no in-memory pending queue. A read-only due
check takes no write lock
when nothing is ready. Only a due row opens a short `BEGIN IMMEDIATE` claim;
the conditional update rechecks status, next attempt time and generation, and a
lost claim explicitly rolls back. SQLite claim transactions close before HTTP.
With no due item, the worker waits until the earliest queued/fetching attempt,
capped at 60 seconds (also 60 seconds for an empty inbox). New intake/seeded state,
retry and fix-code wake the worker through an in-process event after commit.
Stop/drain also wake idle and pacing waits promptly.
An attempt persists `fetching`, increments attempts, starts a readiness budget once,
and leases the item for 120 seconds. A restart resumes due queued/fetching items,
preserving attempts and backoff; it may wait for the previous crash lease to expire.
Unexpected attempt exceptions become terminal `error` with `providerUnavailable`;
the log includes only the request ID, never exception text or provider bodies.
The loop continues with the next item. A process crash leaves the persisted lease
available for recovery.
Use a **single API process**: request spacing/lane admission are process-local,
not cluster-wide rate controls. Concurrent client actions are generation-guarded.

Transport is `work_providers.outbound`: no redirects/proxies, five-second socket
waits and a 25-second per-attempt budget checked around HTTP/encoding/storage.
LibreDMM metadata request starts are at least two seconds apart; Wikidata starts
are at least one second apart. An upstream metadata 202 keeps `fetching` and schedules
10, 20, 40, then 60-second delays, capped at the original start +600 seconds. At
expiry the item becomes `error` with `avLookupReadyTimeout`, without another HTTP
request. Metadata 404 alone is `not_found`; image 404 is an image/provider error.
Other failures are terminal until the user retries. Stop wakes pacing waits; DB
state remains recoverable. Pillow/R2 calls and OS DNS are not forcibly cancelled;
existing storage socket/retry policy can outlive the nominal deadline/shutdown join.

Bounds: 1 MiB metadata/Wikidata replies and stored candidate JSON, 8 MiB jacket,
16 million pixels checked before decode, static JPEG/PNG/WebP only. MIME and decoded
format must match. Jacket coordinates preserve the PC decoder's original pixel
orientation: no EXIF rotation or resizing. Image downloads accept only the PC's
known hosts `pics.dmm.co.jp`, `awsimgsrc.dmm.co.jp`, `image.mgstage.com`, upgrade HTTP
to HTTPS, and reject URL credentials/explicit ports. Clients cannot supply URLs.

Product code normalization follows `provider.rs`: ASCII uppercase/trim; standard
CID prefixes (`h_` + digits, numeric, `k9`) and suffixes (`r`, `bod`, `tk`) normalize
to label and at least three serial digits. Explicit hyphenated codes retain longer
zero-padded serials; compact codes trim leading zeroes. FC2-PPV and numeric amateur
families are preserved. Invalid intake codes remain compatible with POST validation
and enter inbox `error: invalidProductCode` for correction.

Wikidata uses Japanese label/alt-label SPARQL, human P31, optional Korean label and
FANZA P9781, only sending names in escaped batches of 20. Exactly one distinct
Q entity resolves a name; ambiguity stays Japanese-only. Successful mappings,
including unresolved names, cache for 30 days with at most 2000 entries. Failed
requests do not cache and degrade to Japanese-only, preserving a usable candidate.
No performer portrait is fetched during candidate lookup.

## Default split and artwork preparation

A width/height ratio >=1.2 is a wrap. Each face width is
`min(round(height * 0.703), floor(width / 2))`: the back starts at the left, front
at the right, with middle `[x1,x2)` offered as spine only when 1–12% of full width.
A non-wrap defaults to `x1=x2=0`, front only. This task specifies the ratio defaults;
it does not port the later PC image-seam refinement in `spine.rs`.

Artwork preparation requires a `found` item. Split coordinates are strict integer
**pixels**, `0 <= x1 <= x2 <= jacketWidth`; surfaces are a nonempty unique subset
of front/spine/back. Every chosen surface must have positive width. The spine-width
heuristic controls the default offer, not a prohibition on user-adjusted crops.
A non-wrap requires `{x1:0,x2:0,surfaces:["front"]}` and uses the whole image.

Crops are front `[x2,width)`, spine `[x1,x2)`, back `[0,x1)` over the full height.
Each becomes metadata-free RGB JPEG quality 88, no resizing, within the existing
artwork byte cap (16 MiB). Optional 360px WebP thumbnails use the shared helper.
Every original/thumbnail receives storage confirmation before its manifest is
returned. A generation/status recheck rejects a concurrent candidate change;
blobs already prepared in that race may remain unused.

```json
{"items":[{
 "surface":"front", "kind":"cover", "provider":"libredmm",
 "providerImageId":"SSIS-001:<jacket-sha256>:378:422:front",
 "width":378, "height":538, "language":"ja",
 "original":{"sha256":"<jpeg-sha256>","sizeBytes":12345,"contentType":"image/jpeg"},
 "thumbnail":{"sha256":"<webp-sha256>","sizeBytes":1234,"contentType":"image/webp"}
}]}
```

`thumbnail` may be null. Strip `surface`, add `workId` and a new `artworkId`, and
copy all remaining item fields into `addArtwork`. No client upload/confirmation
round-trip is needed. `addArtwork` already accepts bounded provider text, so
`libredmm` needs no provider allowlist or external-binding change. This prepares
blobs only; it changes neither work selections nor metadata.

Common errors: 401 existing auth; 422 `invalidProductCode`, `invalidAvSplit`,
`invalidAvInboxAction`; 413 `avLookupRequestTooLarge`; 409
`avInboxCandidateUnavailable`, `avInboxStateConflict`, `avInboxWorkMismatch`;
provider transport/image/storage errors retain the existing relay codes.

## Client application sequence and expected state

Every command uses `PUT /v1/collections/authority/commands`, ordinary credentials,
and `{libraryId, epoch, contractVersion:1, operationId, commandType, ...}`.
Use one immutable UUID per operation and replay the same payload after uncertainty.
Persist the chosen work/artwork/person IDs, prepared manifests and operations in
client durable progress/outbox state before sending. Do not regenerate IDs on retry.
Read confirmed authority state and preceding FIFO intents; never guess a revision.

1. If new, `createWork` with `{workId,type:"av",name:<normalized code by default>,
   legacyKind:null,fields:{},binding:null}`. An unbound new work starts at revision 1.
   Existing work: use the user-selected live match and its full confirmed entity.
2. Prepare only surfaces where the user chose candidate, then for each surface
   send `addArtwork` with its receipt and stable new artwork ID. It has no work
   expected revision and **does not bump the work revision**. Follow it with
   `selectArtwork`: front uses `slot:"work"`, kind `cover`; spine/back use matching
   slot/kind. `expectedArtworkId` is the confirmed/predicted current ID for that
   slot (null for a new work). Keep sends nothing; Clear sends `artworkId:null`
   with that same selection expectation. Changed selections bump work revision
   once; no-ops do not. Never replace a manual choice without the user's selection.
3. `setAvDetails` with `{workId,changes,expected}`: exactly the same nonempty subset
   of `productCode,titleJa,maker,label,series,genres,releaseDate`. Expected values
   come from current authority AV details; absent text/date defaults to null and
   genres to `[]`. Include the normalized productCode for new work so matching
   and acknowledgement can succeed. Only selected metadata fields are changed;
   empty fields are checked by default in the approved chooser. This is field CAS,
   with **no expectedRevision**; changed details bump work revision once.
4. `setAvCredits` with `{workId,credits,people,expectedRevision}`. Credits are the
   complete desired list `{personId,role:"performer"|"director",order,creditName}`;
   preserve existing credits that the user keeps. New people use stable client IDs
   and `{personId,displayName,nameJa}`; linked existing people need no new person
   record. User-kept Korean name becomes displayName, Japanese remains nameJa.
   Use the latest receipted work entityRevision after all preceding commands,
   including changed selections/details and pending person edits. This command
   increments the work once on change, and new people start at person revision 1.
   Example: create 1, three changed selections =>4, changed details =>5, credits
   expectedRevision **5** =>6. Accepted no-ops/replays do not advance that count.
5. Only after every chosen command accepts, `POST /{id}/applied {workId}`. Persist
   pending acknowledgement separately so a network failure cannot reapply choices.

Revision/selection conflicts stop the remaining apply sequence for reconciliation;
refresh confirmed state and retain the user's pending choices. Do not blindly
rewrite expected state. Commands are individually transactional, not one all-or-
nothing application. Report partial acceptance and resume safely. Current
`setAvCredits` supports names/IDs of authority people, but **does not accept
wikidataId/fanzaActressId**. These remain candidate provenance/matching hints; steps
2/3 must not send undeclared keys or imply canonical identity persistence. An
identity-field command extension would be a separately scoped follow-up.

## Compatibility, migration and deployment order

`POST /v1/av-lookups` keeps its strict 4 KiB intake, original receipt keys,
request-ID/body-digest replay and per-credential 30/minute limiter. Collector,
ordinary client and publisher sends still work. Invalid normalizable-code content
is handled in inbox state, not by breaking old POST acceptance.
`GET /v1/av-lookups?after&limit` remains publisher-only, sequence-ascending and
byte-shape compatible: `{items:[{sequence,requestId,productCode,sourceUrl,receivedAt}],
nextAfter,hasMore}`. It does not ack/hide items based on new inbox state. Old PCs
can continue fetching local candidates; their authority-active local apply fence
remains until step 2. Server and old PC may duplicate provider fetching temporarily.

1. Separately authorize server deployment with a verified control-DB backup.
   Deploy intake, new inbox module and registration together. Verify existing
   Pillow and R2 configuration; no new keys/dependencies are needed. Startup queues
   retained intake records, potentially including codes already reviewed on an old
   PC. Verify single-process deployment and throughput/retained storage. No Cloud
   Library backfill, authority reactivation or catalog replacement is involved.
2. Update PC only after server routes are available. Switch its list/detail/actions
   and jacket reads to the server inbox; stop local provider fetching in the new
   authority path. Keep explicit older-server handling and the local inactive path
   until retirement is separately scoped. Map states to the approved AV list/chooser
   and Home count/privacy behavior. Route apply through the durable sequence above.
   Reconcile pre-existing local inbox items: for unresolved codes missing server
   items, resend code/sourceUrl with a stable migration requestId persisted locally
   (reuse the original UUID only if its original body is known unchanged). A code
   resend deduplicates by requestId, **not code**; avoid repeated migration inserts.
   Candidates are re-fetched by the server rather than uploading local snapshots.
   For locally applied/dismissed items, match/review their server record before
   marking/dismissing it; never automatically reapply old local choices.
3. Tablet reads the same server inbox, previews with authentication, and composes
   the same authority apply sequence with durable retry/ack progress. It must handle
   concurrent PC choices and refresh on state/revision conflicts. Whether the
   tablet chooser offers adjustable jacket split lines is decided in step 3's
   design round; the server accepts any valid split either way. Bring its approved
   AV flow along with PC step 2, preserving prior content, privacy and offline reads.
   A fetch error does
   not hide existing collection data. Candidate application needs server access.

Remaining client decisions: explicit duplicate-match selection, partial-apply and
pending-ack presentation, local-inbox migration reconciliation, and whether a future
canonical Wikidata/FANZA identity extension is wanted. The existing approved UI and
selection rules do not need redesign. Native PC, tablet-device, real provider and
production acceptance remain separate from this source task.

## Verification scope

Unit tests use disposable authority SQLite, fake R2 and a fail-closed mocked
outbound opener. Coverage includes PC normalization/date/series/name rules,
ambiguity/cache fallback, persisted 202 scheduling/restart/timeout, not-found versus
image errors, generation races, default splits, JPEG crops and confirmed manifests
accepted by the actual `addArtwork`, authority revisions/application/acknowledgement,
route handlers/auth/legacy shapes, pruning and lifecycle/pacing, read-only empty
and not-due cycles, conditional claim races, capped earliest-due waits, intake and
retry/fix-code wakeups after commit, prompt idle shutdown, unexpected-exception
terminal state and continued processing with request-ID-only logs.

Verified 2026-10-09: the full server suite (`.venv/bin/python -m unittest discover -s tests` in
`server/lakomics-api`) ran 2040 tests, OK (2 skipped opt-in performance benchmarks).
