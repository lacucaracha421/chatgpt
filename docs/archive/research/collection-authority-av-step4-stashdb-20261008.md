# AV authority step 4a: StashDB server relay and person profiles

Source contract, 2026-10-08. Server and contract only; PC routing is part B and
Android interaction is part C. This extends [step 3a](collection-authority-av-step3a-20261007.md).
Contract version remains **1**. No deployment, authority activation, production
library operation, dependency installation, or credential provisioning is included.

## Credentials and endpoints

All endpoints below accept ordinary Lakomics client credentials (publisher
credentials also work). Requests without valid credentials fail before provider I/O.
The server reads `LAKOMICS_STASHDB_API_KEY` at request time using the existing
provider credential validator. Status reports only a boolean; neither responses,
receipts, database payloads, nor error messages contain the key. The GraphQL
endpoint is fixed to `https://stashdb.org/graphql` and uses the `ApiKey` header.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /v1/providers/status` | Existing authentication | Existing `tmdb`, `igdb` booleans plus `stashdb` |
| `GET /v1/providers/stashdb/search` | `query` (1–200 characters, trimmed, nonblank, no control characters) | `{items, status, matchedId}` |
| `GET /v1/providers/stashdb/performers/{stashdbId}` | Performer ID | Full normalized performer, images and preview URLs |
| `GET /v1/providers/stashdb/image` | `stashdbId`, `imageId` | Verified image bytes, private cache for 86400 seconds |
| `POST /v1/providers/stashdb/portrait` | Exactly `{stashdbId, imageId}` | Confirmed JPEG blob manifest, dimensions and attribution |

IDs use 1–128 ASCII letters, digits, underscores or hyphens. Clients cannot supply
an image URL. Every image fetch looks up the performer again and resolves the
chosen image ID from its current provider response. Search and detail return only
relative Lakomics image-proxy URLs in `images[].url`, `previewUrl` and `imageUrl`;
resolve these against the configured API base and use Lakomics authentication.
Do not load them against the frontend origin or contact StashDB from the client.
`imageUrl` is the existing PC candidate name; `previewUrl` is its relay equivalent.

Search asks `searchPerformer(term:$t,limit:5)` using the PC fields, including gender
and disambiguation for provider validation. Detail asks `findPerformer(id:$id)` and
checks the returned ID. Only female or unspecified-gender performers are eligible,
matching the existing PC behavior. Disambiguation is queried but not projected,
as in the current PC parser.

Each normalized performer includes:

```text
stashdbId, name, aliases, birthDate, heightCm,
bandIn, waistIn, hipIn, cup, breastType, careerStart, careerEnd,
urls: [{url, site: {name}}],
images: [{id, url: <Lakomics proxy URL>, width, height}],
previewUrl, imageUrl
```

Dates support year, year-month and calendar-date precision. Invalid optional values
become null. Height is 1–300 cm; band/waist/hip are 1–200 **inches**; cup is nonblank
and at most 20 characters; breast type is `NATURAL`, `FAKE` or `NA`. Career years
are 1900–2200 and end cannot precede start. Names/aliases retain their provider
text, with the PC limits (500 characters, at most 100 aliases). Safe HTTP(S) links
have no embedded credentials; links are bounded to 2000 characters and 100 entries.
Images need positive dimensions and bounded IDs; at most 500 are returned.

Search `status` is a read-only hint: `none` when there are no eligible candidates;
`matched` when exactly one eligible candidate matches the query by name or alias;
otherwise `ambiguous`. Matching maps fullwidth ASCII to ASCII, collapses whitespace
and lowercases, as the PC does. `matchedId` is populated only for `matched`.
An unrelated singleton remains ambiguous. These states do not mutate a person.
The client shows candidates, the user picks, then the client sends `setPersonProfile`.
Dismissal closes the chooser locally; no persisted ambiguous/none profile is added.

## Image authentication and address boundary

The [upstream Stash-box README](https://github.com/stashapp/stash-box/blob/master/README.md#api-keys-and-authorization)
documents `ApiKey` authentication and public S3 image storage configuration. The
inspected [image handler](https://github.com/stashapp/stash-box/blob/master/internal/api/routes_image.go)
has no user/role check, and the [authentication middleware](https://github.com/stashapp/stash-box/blob/master/internal/api/server.go)
allows anonymous requests when no credentials are present. The existing PC image
downloader sends no key. This supports the inference that images are intended to
be public, **not** verification of current live StashDB image authentication.
No authenticated live StashDB lookup or image probe was performed for this task.

The relay handles either case: it sends `ApiKey` only to fixed HTTPS
`stashdb.org/images/...` routes. It also accepts HTTPS `cdn.stashdb.org/images/...`
with **no credential header**. Other hosts, URL credentials, ports, query strings,
fragments and traversal paths are excluded; unsupported images are omitted from
normalized results. Redirects and environment HTTP proxies are disabled by the
existing transport. A new image host requires an explicit code/contract change,
never forwarding the server key to an arbitrary provider-returned destination.
Attribution may contain the safe raw image URL as provenance, but it is not a
client download instruction and contains no appended key.

## Authority command

`PUT /v1/collections/authority/commands` adds an ordinary-client command:

```json
{
  "libraryId": "<active library>",
  "epoch": 1,
  "contractVersion": 1,
  "operationId": "<immutable UUID>",
  "commandType": "setPersonProfile",
  "personId": "<existing person>",
  "stashdbId": "<chosen performer ID or null>",
  "expectedRevision": 1
}
```

Clients never submit profile fields. A non-null ID causes the server to fetch and
normalize that performer itself; the same ID in a new operation refreshes it.
`null` clears both the profile and its StashDB identity, and works without a key.
The person must already exist (baseline or `setAvCredits`). This command never
creates or renames a person, changes their memo/favorite, chooses a portrait, or
creates a work/provider binding.

Authority library/epoch/version and immutable-operation checks run before provider
I/O. An existing accepted operation replays its original receipt without fetching,
even when the key has been removed or the provider changed. Reusing its ID with a
different command payload is `409 operationConflict`. The initial person read is
closed before HTTP; the write transaction repeats authority and operation checks.
An identical desired profile and ID is a receipted no-op before person revision
CAS. Otherwise `expectedRevision` must equal the current person revision; conflicts
return `409 revisionConflict` with `current.person` containing the full entity.
A concurrent memo/portrait/profile edit during the fetch is therefore preserved.
Failed provider calls write no profile or accepted receipt.

A changed profile increments `entity_revision` once. As for `setPerson`, every
non-tombstoned work crediting the person is republished with work revision +1.
The seven baseline/feed sections are unchanged; updated profiles and StashDB IDs
arrive through those works' `avPeople`. Work CAS intents composed against an older
work revision can conflict. A person with no surviving credits still receives a
full-person receipt and a person revision change, without inventing a people feed
section.

The ordinary receipt contains the existing envelope, `changed`, `changeSequence`,
`authorityCursor`, `entities`, `updatedAt`, and **`person` (full entity)**. A no-op
has `changed:false` and no change sequence. Replay returns the exact original
receipt. The full person includes `entityRevision`, `portraitSelection`,
`portraitImage` and the additive `stashdbId` (null after clear).

## Storage and compatibility

The confirmed text profile belongs to `collection_authority_people.payload.profile`:

```text
{source:"stashdb", name, aliases, birthDate, heightCm,
 bandIn, waistIn, hipIn, cup, breastType, careerStart, careerEnd,
 urls:[{site:<site name string>, url}]}
```

This is the current PC publication / `CollectionPersonProfile` shape. URLs flatten
`site.name` only for storage. `payload.stashdbId` holds the chosen provider identity
separately; no raw GraphQL snapshot, image list, search candidates or credential is
stored. There is no new migration or table. Identical refresh data does not advance
revision merely to record a fetch timestamp. Normalized profiles and the resulting
person payload retain the 64 KiB person publication bound.

Default `GET /v1/collections/people/{id}` keeps its existing keys and profile shape;
it excludes the new StashDB identity. `?authority=1`, command receipts and work
`avPeople` include `stashdbId`, so B/C can request photo detail on demand. Older
clients ignore unknown authority keys and retain their text/portrait reads.
Existing staged profiles have no chosen identity; B must ask the user to select a
performer rather than guessing an ID from the name. The PC's direct StashDB
implementation, credential store and authority fences are untouched until B.

## Photo to confirmed portrait

`POST /v1/providers/stashdb/portrait` resolves the image server-side, verifies MIME
against actual image format and validates dimensions before decode. Static JPEG,
PNG and WebP are supported; animation, GIF and corrupt/mismatched data are rejected.
EXIF orientation is applied, aspect ratio is preserved, and the image is encoded
to JPEG at quality 88, without upscaling, at most 1600 pixels per side and 5 MiB.
Metadata is not copied into the new JPEG.

The resulting bytes use the existing content-addressed artwork object key and
`_stored_blob` storage HEAD/length/content-type confirmation. Only after storage
confirmation is the manifest written to `mobile_collection_artwork`, the exact
receipt checked by `setPersonPortrait` and `addArtwork`.

```json
{
  "original": {"sha256": "<digest>", "sizeBytes": 12345, "contentType": "image/jpeg"},
  "width": 1200,
  "height": 1600,
  "attribution": {
    "source": "stashdb",
    "sourceUrl": "<safe provider image URL>",
    "license": null,
    "author": null
  }
}
```

Preparing this blob does not choose the portrait or alter the profile. The client
sends `setPersonPortrait` with `portrait:{kind:"image", ...<this response>}` and the
confirmed person's `expectedRevision`. No second upload is needed. Existing
portrait CAS, Home cover references/media tickets and receipts apply unchanged.
Retries deduplicate storage by JPEG digest; an unused prepared blob has the same
retention behavior as unused provider artwork. Attribution does not assert a
license or author the provider does not supply.

## Limits and failures

The relay reuses the TMDB/IGDB transport and limiter: one StashDB request at a time
per API process, no unbounded waiting queue, 0.1 seconds between GraphQL requests,
25-second provider budget, at most five-second individual HTTP socket waits,
1 MiB raw GraphQL replies, bounded normalized results, no redirects/proxies.
Photo preparation additionally uses the shared artwork decoder/storage lane.
Image downloads are limited to 15 MiB and 24 Mi pixels before decode; portrait
request bodies are at most 2048 bytes. Credentials are never interpolated into URLs.
These are per-process controls, not a cluster-wide provider quota.
Clients must serialize StashDB preview fetches and handle `providerBusy` rather
than start an entire photo grid's requests concurrently. Each preview resolves
the photo against a fresh performer lookup; A adds no provider-response cache.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 401 | Existing auth response | Invalid Lakomics credentials |
| 422 | `providerQueryInvalid`, `providerIdentityInvalid`, `providerArtworkInvalid` | Invalid client query, ID or photo request |
| 422 | `invalidCollectionCommand`, `invalidCollectionRevision` | Invalid authority command; profile data is forbidden |
| 404 | `personNotFound` | Unknown authority person |
| 404 | `providerNotFound` | Missing provider performer or selected image |
| 409 | `revisionConflict`, `operationConflict` | Person CAS or immutable-operation mismatch |
| 409 | `artworkBlobUnconfirmed` | Existing portrait command received an unconfirmed manifest |
| 503 | `providerNotConfigured` | Missing or invalid server key |
| 503 | `providerImageDecoderUnavailable` | Pillow unavailable |
| 429 | `providerBusy`, `providerRateLimited` | Occupied lane or upstream rate limit |
| 504 | `providerTimeout` | Provider deadline/socket timeout |
| 413 | `providerRequestTooLarge`, `providerResponseTooLarge` | Request, upstream, profile or JPEG size limit |
| 422 | `providerImageInvalid` | Invalid MIME/format/dimensions/pixels or unsupported portrait format |
| 502 | `providerUnauthorized` | Upstream 401/403; inspect server credential configuration |
| 502 | `providerRedirectRefused`, `providerInvalidResponse`, `providerUnavailable` | Redirect, invalid GraphQL/JSON, connection or other upstream failure |
| 409 | `providerArtworkMismatch` | Stored blob HEAD differs from the produced manifest |
| 502 | `providerArtworkStorageUnavailable` | Blob storage or receipt persistence failure |

The existing relay uses 502 for upstream unavailability and 503 for missing server
configuration; this step preserves those meanings. GraphQL error messages are never
forwarded. Existing authority activation/library/epoch/version errors also apply.
The provider budget is checked around image encoding and storage calls; synchronous
Pillow work and the service's existing R2 socket/retry policy are not a hard wall-clock
cancellation boundary. DNS resolution is OS-controlled, as for the existing relay.

## Deployment order and follow-up parts

1. Separately authorize deployment, preserve the current server database backup,
   and deploy the server module, registrations and command changes together. No
   backfill, catalog replacement or new dependency is needed. Verify Pillow and
   storage receipt writes in the existing service environment.
2. The user provisions `LAKOMICS_STASHDB_API_KEY` through a root-only systemd
   drop-in outside the repository and restarts the authorized service. Verify the
   boolean status, authenticated search/detail and both image paths with an
   explicitly authorized live check; this source task does not do it.
3. B deploys PC routing only after the new server is available. When Collections
   authority is active, use server status/search/detail and immutable
   `setPersonProfile` outbox intents for choose/refresh/clear. Use confirmed person
   revisions and receive the full person from receipts/feed; persist the additive
   StashDB identity separately from the old text profile. Plan FIFO revision
   expectations and work revision bumps as in step 3a. Keep the inactive direct
   StashDB path during compatibility rollout. Handle old servers and profiles
   without IDs explicitly. Do not upload client-supplied provider profile data.
4. C reads the text profile plus authority identity, requests photos from the relay,
   displays authenticated previews and prepares a chosen photo through `/portrait`.
   Then enqueue `setPersonPortrait` with the returned manifest and current revision.
   The tablet does **not** crop work covers (user decision). Preserve prior content
   until new content is ready and preserve offline reads/provider failure behavior.

B/C must settle UI details for the candidate chooser, dismissal, explicit refresh,
not-configured status and concurrent-edit conflicts. There is no server automatic
refresh/30-day cache policy in A. A committed operation is stable across retries;
a refresh needs a new operation ID. Clear profile does not clear portrait, and
choosing a portrait does not attach a profile automatically.

## Verification scope

Tests use the existing disposable SQLite authority fixture, fake R2 and a mocked
outbound HTTP opener. Unexpected outbound calls fail immediately; no test contacts
StashDB. Coverage includes PC normalization/search cases, errors/redaction, profile
CAS/replay/refresh/clear/republish, in-flight edits, image address/auth boundaries,
image limits/encoding and confirmed photo manifests accepted by `setPersonPortrait`.
Local results do not establish native PC, Android device or live provider behavior.

Local verification (2026-10-08): the full server suite `.venv/bin/python -m unittest discover -s tests`
from `server/lakomics-api` ran 2005 tests, OK (2 skipped opt-in performance benchmarks),
including the 14 StashDB tests.
