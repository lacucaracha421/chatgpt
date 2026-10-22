# S2-A: interactive TMDB / IGDB relay

Chosen design: authenticated lookups plus explicit image fetch into the existing R2
work-artwork store. No jobs, executors, automatic imports, or authority mutations.
The PC/tablet chooses the work/images and submits existing Collections authority
commands. Provider artwork remains separate from Assets. This slice is not deployed.

## Routes and authentication

All routes use the existing tablet read guard: client or publisher Bearer token,
including the legacy client-compatible shared token. Search returns the first TMDB
page or at most 20 IGDB results; there is no pagination in this slice.

| Method / path | Inputs / response |
| --- | --- |
| GET `/v1/providers/status` | `{"tmdb":true,"igdb":false}`; configured status only, no upstream request |
| GET `/v1/providers/tmdb/search` | `query`, required `kind=movie\|tv`, optional `year`; `{"items":[...]}` |
| GET `/v1/providers/tmdb/{kind}/{id}` | Positive numeric ID; detail below |
| GET `/v1/providers/igdb/search` | `query`; `{"items":[...]}` |
| GET `/v1/providers/igdb/{id}` | Positive numeric ID; detail below |
| POST `/v1/providers/artwork` | `{"provider":"tmdb","path":"/poster.jpg","size":"original"}`; receipt below |

TMDB search item keys are exactly `id`, `externalId`, `kind`, `name`,
`originalTitle`, `releaseDate`, `year`, `path`, `previewUrl`.
IGDB search item keys are exactly `id`, `externalId`, `name`, `year`, `developer`,
`publisher`, `platforms`, `releaseDate`, `genres`, `overview`, `path`, `previewUrl`.
Optional values are JSON null. TMDB movie `externalId` is `"42"`; TV is `"tv:42"`.
IGDB `externalId` is `"99"`. Both TMDB kinds create a work of type `movie`.

## Detail contract

Detail is `{binding,metadata,artwork}`. Binding is exactly
`{provider,externalId,config:null,snapshot,values,details}`. TMDB metadata is
`{name,year,originalTitle,runtimeMinutes,director,productionCompany,releaseDate,
externalScore,genres,overview}`. IGDB metadata is
`{name,year,developer,publisher,platforms,releaseDate,genres,overview}`.
Artwork candidates are `{kind,path,previewUrl,width,height}`.

Provider contracts:

- TMDB `snapshot` matches the PC normalized snapshot: `id`, `title`,
  `original_title`, `overview`, `release_date`, `runtime_minutes`, `genres` (array),
  `directors` (array), `production_companies` (array), `external_score` (0–100 integer
  when votes exist), `poster_path`, `backdrop_path`, `posters`, `backdrops`.
  Each image reference is `{filePath,width,height}`. Movies additionally have
  `film={cast,releases,related}`; cast is `{name,character}`; release is
  `{country,releaseType,date,certification}`; related is null or
  `{collectionName,parts:[{movieId,title,releaseDate,posterPath}]}`.
- TV adds `media_type:"tv"` and `series={status,lastAirDate,cast,seasons}` instead of
  `film`. Season keys: `id`, `seasonNumber`, `name`, `overview`, `airDate`, `posterPath`,
  `posterArtworkId:null`, `episodes`. Episode keys: `id`, `episodeNumber`, `name`,
  `overview`, `airDate`, `runtimeMinutes`. All seasons/episodes are fetched; failures
  do not return a partial series. Season poster candidates additionally include
  `seasonId` and `seasonNumber`.
- TMDB `values` contains exactly `originalTitle`, `director`, `productionCompany`,
  `releaseDate`, `runtimeMinutes`, `genres`, `overview`, `externalScore`.
  It is the PC `provider_values` projection of `snapshot`.
- TMDB `details` is the authority display projection: `{series,film}` with the
  unused block null. Film related parts omit `posterPath`. Series omits
  `lastAirDate`; seasons omit `overview`/`posterPath`; episodes omit `overview`.
- IGDB `snapshot` is the original games endpoint object, as stored by the PC:
  `id`, `name`, optional `summary`, `first_release_date`, `genres:[{name}]`,
  `platforms:[{name}]`, `release_dates:[{date,platform:{name}}]`,
  `involved_companies:[{developer,publisher,company:{name}}]`,
  `cover`, `artworks`, `screenshots`; image objects use `{image_id,width,height}`.
  Provider-supplied IDs on expanded objects are retained. Absent fields stay absent.
- IGDB `values` has exactly `developer`, `publisher`, `releaseDate`, `platforms`,
  `genres`, `overview`; `details` is null. Its metadata has these fields plus
  `name`/`year`. Metadata matches PC import normalization (earliest valid release,
  unique release-platform/declared-platform union). Values match the PC baseline
  projection of raw JSON, which prefers declared platforms. Therefore metadata
  and values may differ; do not replace values with metadata.

Metadata uses authority camelCase; joined lists use ` · `. TMDB uses ko-KR,
PC-style en-US fallback, earliest valid release, two directors/companies for movies,
full creators for TV, and optional related-film enrichment.

Copy `binding` into `createWork.binding`; use `metadata.name` as the command name
and metadata without `name` as `fields`. For existing works, submit `bindProvider`
with its identity/config and expected binding revision, then `applyProviderSnapshot`
with `snapshot`, `values`, `details`, and the current `baseSnapshotDigest`.
Do not copy the entire binding object into either command.

## Artwork receipt

```json
{
  "provider": "tmdb", "providerImageId": "/poster.jpg",
  "original": {"sha256": "<64 lowercase hex>", "sizeBytes": 12345, "contentType": "image/jpeg"},
  "width": 500, "height": 750
}
```

For IGDB, `path`/`providerImageId` is the image ID (e.g. `co_99`), not a URL.
Copy all receipt fields into `addArtwork`; supply your own `workId`, `artworkId`,
`kind`, `language:null`, `thumbnail:null`, and the usual authority envelope.
Then send `selectArtwork` with the intended slot and expected current artwork ID.
Candidate kinds are `poster`, `backdrop`, `season_poster` (TMDB) and `cover`,
`artwork`, `screenshot` (IGDB); map game `artwork` to `hero` if selecting the hero
slot. TMDB posters can use the existing `work` selection slot. The receipt's digest
is the blob identifier; there is no additional blob ID. Dimensions are measured
from the downloaded bytes, outside the `original` manifest. No thumbnail is created.

Only `image.tmdb.org` / `images.igdb.com`; all redirects refused, declared/streamed
bytes <=16 MiB, image MIME/format/dimensions verified with existing Pillow.
`work-artwork/mobile/<sha256>` and a matching HEAD produce the existing
`mobile_collection_artwork` receipt. Identical content reuses the object/receipt.

TMDB sizes: `original,w92,w154,w185,w342,w500,w780,w300,w1280`.
IGDB sizes: `original,cover_small,cover_big,thumb,screenshot_med,screenshot_big,
screenshot_huge,720p,1080p`. Size defaults to `original`.
Previews load directly from those public provider hosts (TMDB w185, IGDB thumb);
there is no preview proxy and no API key in preview URLs.

## Credentials and limits

Environment variables: `LAKOMICS_TMDB_API_KEY`, `LAKOMICS_IGDB_CLIENT_ID`,
`LAKOMICS_IGDB_CLIENT_SECRET`. TMDB accepts a v3 key or a JWT-shaped read token
(Bearer). Twitch client-credentials tokens are cached only in memory, expire with
a 60-second safety margin, and renew once on an IGDB 401. Keys/tokens are never
returned or logged; outbound urllib transport does not log URLs or headers.

Obtain the TMDB key/read token in account API settings ([official guide](https://developer.themoviedb.org/docs/authentication-application)).
Register a Twitch application and obtain its client ID/secret ([IGDB instructions](https://api-docs.igdb.com/#account-creation)).
The user/operator sets the three variables in a protected systemd drop-in under
`/etc/systemd/system/lakomics-api.service.d/`, following the existing Kakao key pattern:

```ini
[Service]
Environment="LAKOMICS_TMDB_API_KEY=<key-or-read-token>"
Environment="LAKOMICS_IGDB_CLIENT_ID=<client-id>"
Environment="LAKOMICS_IGDB_CLIENT_SECRET=<client-secret>"
```

After the separately authorized service reload/restart, check authenticated status.
This task does not change service configuration or provision credentials.

Missing lookup keys return 503 `{detail:{code:"providerNotConfigured",message:"..."}}`.
Public image fetch needs no provider key. Errors carry sanitized Korean messages.
One active lookup per provider and one image fetch per process; concurrent calls
return 429 `providerBusy`. Upstream requests are paced at 100 ms (TMDB) / 250 ms
(IGDB), with a 25-second lookup/download budget, <=5-second socket timeout and
2 MiB JSON cap (aggregate TMDB input and normalized output). Storage uses existing bounded R2
timeouts. Artwork request JSON is capped at 2 KiB. No background retry or jobs.

## Open items / verification

- Client integration and deployment/key configuration are separate tasks.
- Existing authority roles are unchanged: client tokens can create with an initial
  binding, add/select artwork, and update work metadata; `bindProvider` and
  `applyProviderSnapshot` require publisher auth. Tablet refresh/rebinding needs
  a separately scoped authority policy decision; this relay does not grant it.
- Client commands remain limited to 64 KiB (publisher 8 MiB); complete large TV
  snapshots can exceed the tablet command limit. Names remain capped at 120
  characters when creating a work. Clients must handle these existing limits;
  never submit a silently truncated snapshot.
- Season poster receipts do not automatically update `posterArtworkId`. Linking
  those references requires a later valid provider-detail command after addArtwork.
- Mock tests include real authority create/addArtwork commands on a disposable DB.
  Windows Python 3.14 syntax compilation succeeded. The requested unittest command
  could not load tests because `botocore` is absent; FastAPI is absent too. No
  dependencies were installed. Run `python -m unittest tests.test_work_providers`
  from `server/lakomics-api` in the controller's existing WSL environment.
  Live providers, R2, native clients and production remain unverified.

## S3 — authenticated image proxy and server-built apply (2026-10-07)

This section supersedes the earlier relay-only tablet refresh/rebinding limitation.
Source implementation only; no deployment or production writes were performed.

All provider routes use the existing `require_client` authentication (client or
publisher). Errors use `{"detail":{"code":"...","message":"Korean message"}}`;
authority rejections retain the existing command route's exact status/code and
additional conflict fields.

### Image previews

`GET /v1/providers/image?provider=tmdb|igdb&path=<encoded provider path/id>&size=<size>`
returns image bytes with the upstream image MIME and
`Cache-Control: private, max-age=86400`. Exactly these three query parameters are
accepted; duplicate parameters are rejected. Allowed sizes:

| Provider | Image proxy sizes | Fixed upstream host |
| --- | --- | --- |
| TMDB | `w185`, `w342`, `w780` | `image.tmdb.org` |
| IGDB | `t_cover_big`, `t_screenshot_med`, `t_720p` | `images.igdb.com` |

IGDB proxy sizes map to the existing size validator by removing `t_`. URLs,
host overrides, traversal and other sizes are rejected. Downloads use the existing
no-redirect/no-environment-proxy transport, 25-second deadline, at most 5-second
socket timeout, allowed image MIME set and 16 MiB size cap. Preview downloads do
not store artwork or require provider API keys.

Search/detail `previewUrl` fields now contain relative API paths, for example:

```text
/v1/providers/image?provider=tmdb&path=%2Fposter.jpg&size=w185
/v1/providers/image?provider=igdb&path=co_99&size=t_cover_big
```

TMDB defaults to `w185`; IGDB covers use `t_cover_big`, other candidates use
`t_screenshot_med`. The tablet must resolve these against its configured API base
and supply its authorization header when fetching image bytes. It must not fetch
provider-host images directly.

### Apply request and response

`POST /v1/providers/apply` accepts only:

```json
{
  "commandId": "<canonical UUID v4>",
  "libraryId": "<authority library id>",
  "epoch": 1,
  "operation": "create|connect|refresh",
  "provider": "tmdb|igdb",
  "externalId": "42",
  "workId": "<canonical UUID>",
  "type": "movie|game"
}
```

`workId` is required for every operation: client-generated for create, existing
for connect/refresh. `type` is required only for create (`tmdb` -> `movie`, `igdb`
-> `game`) and must be omitted for connect/refresh, including null. TMDB TV uses
`tv:42` with work type `movie`; other IDs are positive numeric strings. Extra
fields, client-supplied snapshots and malformed identities are rejected with
422 `providerApplyInvalid`. Request JSON is limited to 2 KiB.

| Operation | Authority commands / returned receipt order |
| --- | --- |
| create | `createWork` with provider name, metadata, initial binding and snapshot |
| connect | `bindProvider`, then `applyProviderSnapshot` |
| refresh | `applyProviderSnapshot` for the work's existing binding |

The server performs a fresh provider detail lookup, builds and validates ordinary
authority commands, then executes the existing `apply_command` path. Connect's
commands are atomic: rejection of either rolls back both, including receipts and
feed changes. Provider merge rules remain unchanged; user titles, personal fields,
artwork selections and explicit metadata edits survive. In particular, IGDB's
existing fill-only merge can retain displayed metadata while updating the snapshot.
Provider HTTP runs outside the write transaction; binding/snapshot CAS prevents
stale lookup application. Refresh requires a live binding and matching request
`externalId`, otherwise 409 `providerBindingRequired` / `providerBindingMismatch`.
Stale library/epoch uses 409 `authorityLibraryMismatch`, as the commands route does.

Success is exactly `{"receipts":[<ordinary authority command receipt>, ...]}`.
Each entry has the same JSON as one accepted command on
`PUT /v1/collections/authority/commands`, including `operationId`, `commandType`,
`entities`, `authorityCursor`, and `changeSequence`. Derived command IDs are
UUIDv5 with `commandId` as namespace and the command type as name. An internal
UUIDv5(`commandId`, `providerApply`) receipt freezes the entire response and request
fingerprint in the existing authority receipt store without advancing the feed.
Completed identical retries replay those receipts without provider HTTP or a
second mutation, even if the provider subsequently changes or keys are removed.
Reusing the same key with a different request returns 409 `operationConflict`.
The existing receipt retention window (180 days) also applies to this replay.
The tablet must retain the original `commandId` and body for transport retries;
a new intentional lookup/apply uses a new UUID v4.

The public commands route's publisher restriction on `bindProvider` and
`applyProviderSnapshot` is unchanged. No client snapshot permission is added.

### Artwork and verification handoff

Artwork remains `POST /v1/providers/artwork` -> blob receipt -> client outbox
`addArtwork` -> `selectArtwork`. Its existing IGDB sizes remain **unprefixed**
(`cover_big`, `screenshot_med`, `720p`, `original`, etc.); only the image proxy uses
`t_` sizes. Apply neither downloads nor selects artwork automatically.

Mock tests cover image bytes/cache/hosts/sizes, invalid paths/redirects/MIME/size,
relative previews, client authentication, TMDB movie/TV and IGDB create, connect,
refresh, preservation of personal fields, repeated request replay, key reuse,
stale identity, missing/mismatched binding, lookup CAS, identity-taken rejections,
atomic rollback and unchanged publisher-only commands.

Windows AST syntax checks and diff whitespace review are the local evidence.
The unittest suite was written but not run: the task environment lacks the
server dependencies and cannot run WSL. Controller verification command, from
`server/lakomics-api`: `python -m unittest tests.test_work_providers
tests.test_collection_authority`. Live providers, R2, tablet image authentication,
native behavior and production deployment remain unverified.
