# Collections authority 1B batch 2a contract

Server implementation handoff, 2026-10-06. Authority remains inactive unless separately
activated. No deployment, activation, provisioning, Git writes, or production requests
were performed. The legacy replica and personal-edit log retain their inactive paths.

## Commands for the next PC/tablet batches

All commands use `PUT /v1/collections/authority/commands`. Contract version stays 1.
Every top-level key shown is required; additional keys are rejected. Operation IDs are
canonical lowercase UUIDs and identify immutable retry payloads. Library IDs are 32
lowercase hex characters. Use the server's active epoch rather than hardcoding 1.

```json
{
  "libraryId": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "epoch": 1,
  "contractVersion": 1,
  "operationId": "11111111-1111-4111-8111-111111111111",
  "commandType": "createWork",
  "workId": "game-1",
  "type": "game",
  "name": "Example",
  "legacyKind": null,
  "fields": {"status": "playing", "ownedPlatform": "PC"},
  "binding": null
}
```

`fields` accepts the existing metadata fields plus the two optional record fields.
Both accept null. Status identifiers are exact:

| Type | Status values |
|---|---|
| game | `done`, `playing`, `unplayed` |
| manga | `collecting`, `complete` |
| movie | `watched`, `watching`, `unwatched` |
| av | `watched`, `unwatched` |

`ownedPlatform` is a game-only trimmed string, at most 200 characters after trimming;
empty clears it. Creation permits a null platform on other types, so clients can send
a complete fields object. An explicit platform update on other types is refused with
`collectionRecordUnavailable`, including a clear.

```json
{
  "libraryId": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "epoch": 1,
  "contractVersion": 1,
  "operationId": "22222222-2222-4222-8222-222222222222",
  "commandType": "updateWork",
  "workId": "game-1",
  "changes": {"status": "done", "ownedPlatform": "Switch"},
  "expected": {"status": "playing", "ownedPlatform": "PC"},
  "expectedRevision": null
}
```

`expectedRevision` is null or the positive work revision. When null, `expected` must
contain every changed field. Matching revision accepts the changes; otherwise text
fields require matching expected values. `myScore`, `showcase`, `status`, and
`ownedPlatform` rebase automatically. Platform labels are treated as a discrete
personal device choice despite their string representation. In a mixed update, a
conflicting text field rejects the entire transaction. An already-current desired
state is receipted without a change row.

```json
{
  "libraryId": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "epoch": 1,
  "contractVersion": 1,
  "operationId": "33333333-3333-4333-8333-333333333333",
  "commandType": "setOwnershipTracking",
  "workId": "manga-1",
  "editionIndex": 0,
  "count": 2,
  "expectedCount": null,
  "expectedRevision": null
}
```

Manga only; edition is 0–3, count is 0–2000. `expectedCount` is null (untracked)
or 0–2000; zero is tracked, not absent. `expectedRevision` is null or the positive
work revision. Matching work revision or matching edition count accepts the command;
an already-current count can still replace differing per-volume detail. This command
replaces that edition with physical ownership of volumes 1 through count, clears
digital ownership and holdings outside that range, and leaves other editions intact.
Cleared per-volume rows remain with false flags and incremented entity revisions, so
replicas can remove old holdings. `entities.ownership` contains the changed full rows;
`entities.works` carries the revised work and explicit-zero tracking state.

```json
{
  "libraryId": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "epoch": 1,
  "contractVersion": 1,
  "operationId": "44444444-4444-4444-8444-444444444444",
  "commandType": "setReleaseSubscription",
  "workId": "manga-1",
  "enabled": true,
  "expectedEnabled": false,
  "expectedRevision": null
}
```

Manga only. Booleans are strict; revision refers to the work. Matching work revision
or expected enabled state accepts the command; unchanged desired state is a no-op.
Enabling requires a bound Kakao or Aladin identity (`releaseWatchUnavailable`
otherwise). Subscription state is stored in work `derived.releaseWatch` and revisioned
through the work feed, without adding a new feed section. Kakao/Aladin bind/unbind
updates availability; removing the last eligible binding also disables the subscription.
Release events, read acknowledgements, and schedule refresh jobs remain later-batch work.

## Selection and feed additions

```json
{
  "libraryId": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "epoch": 1,
  "contractVersion": 1,
  "operationId": "55555555-5555-4555-8555-555555555555",
  "commandType": "selectArtwork",
  "workId": "game-1",
  "slot": "spine",
  "artworkId": "spine-1",
  "expectedArtworkId": null
}
```

Slots are `work`, `hero`, `backdrop`, `spine`, `back`. Null artwork clears a slot.
The work slot takes `cover` or `volume_cover`; the other slots take their same-named
kind. Cross-work artwork and incompatible kinds are refused. The slot and that
slot's artwork flags/revisions change atomically, with full artwork and work rows in
the same change event. A stale expectation conflicts unless the desired slot already
holds. Artwork feed/baseline rows add `selected` (boolean, or null for original v1
rows using slot fallback) and `order` (integer or null).

Work rows retain `fields.status` and `fields.ownedPlatform`; new work rows initialize
both to null. Tracking uses these work fields:

```json
{
  "derived": {
    "ownedVolumes": [{"editionIndex": 0, "count": 0}],
    "releaseWatch": {"enabled": true, "available": true}
  },
  "selection": {"work": null, "hero": null, "backdrop": null, "spine": "spine-1", "back": null}
}
```

These are fragments of existing full work rows, not new entity sections. Baseline
staging v2 still accepts the current exporter's four selection keys; `back` is
optional and inferred from its selected back artwork when absent. Explicit artwork
flags must agree with slots, including volume covers selected as the work cover.
Inconsistency blocks staging/verification (`artworkSelection`); multiple selected
back artworks are invalid. Existing v1 staging keeps its exact original shape.

`/v1/collections` and detail reads keep current APK shapes: record fields remain
top-level, absent when null; manga tracking uses `ownedVolumes` and `releaseWatch`.

## Personal-edit compatibility and authentication

Personal edits continue to use request `version: 1`; v2/v3 are handshake capabilities,
not request versions. The existing POST shape is unchanged:

```json
{
  "version": 1,
  "libraryId": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "operationId": "66666666-6666-4666-8666-666666666666",
  "collectionId": "manga-1",
  "field": "ownedVolumes",
  "value": {"editionIndex": 0, "count": 0},
  "expected": {"editionIndex": 0, "count": null}
}
```

When active, `status`/`ownedPlatform` map to `updateWork`, `ownedVolumes` to
`setOwnershipTracking`, and boolean `releaseWatch` to `setReleaseSubscription`.
Score/showcase/memo retain their mappings. Authority receipts replay lost responses;
the PC bridge log is not written. Memo/tracking conflicts retain
`collectionPersonalConflict` with the field's original `current` shape. Record,
score, and showcase choices rebase. Missing/deleted/trashed works retain
`collectionNotFound`. All three capabilities (`collectionPersonalEdit`,
`collectionTrackingEdit`, `collectionRecordEdit`) advertise true when active,
independent of the last PC handshake; inactive capability gates stay unchanged.

The two new tracking commands are client commands. Artwork POST `prepare`/`check`
accept client-role, publisher-role, and legacy shared tokens. They retain existing
manifest validation and receipts. Publisher-only commands, staging, verification,
activation, and publication do not gain client access. Other read routes retain
their existing authentication in this batch.

## MangaDex parity and remaining PC work

MangaDex `values` adds `originalTitle` (the PC preview's `japanese_title`):

```json
{
  "year": 2001,
  "author": "Example author",
  "genres": "Fantasy",
  "overview": "Example overview",
  "originalTitle": "原題"
}
```

The existing `applyProviderSnapshot` envelope is unchanged. Blanks fill; values
equal to the previous provider value are replaced, including null clears. Differing
user values survive. Text equality is exact, matching PC commit `9d55123e`; this
applies on reconnect as well as refresh. An unusable/missing previous snapshot
does not confer ownership of nonblank user fields. TMDB/IGDB merge rules are unchanged.

The read-only PC inspection identified these next-batch changes:

- Add the two new command names to the PC outbox allowlist.
- Apply explicit-zero tracking and subscription state from work `derived` fields;
  the current batch-1 replica only applies individual ownership rows.
- Apply the `back` selection slot; batch 1 currently applies four slots.
- Add `originalTitle` to the exporter's MangaDex provider-value projection. Existing
  exports lacking it remain accepted but cannot establish its previous merge value.
- Make exported flags agree with selected slots. The retained PC-generated fixture
  contains a fallback volume cover with `selected: false` while its work slot points
  to it; that state now blocks staging instead of silently producing two selections.

## Verification limits

Added regression coverage in `tests.test_collection_authority` and
`tests.test_collection_authority_verify`; the existing personal-edit and mobile
Collection suites remain in the requested test command. WSL startup failed with
`Wsl/Service/E_ACCESSDENIED`, so no Python unit suite result is claimed. Windows AST
syntax inspection and `git diff --check` are static checks, not runtime acceptance.
Review was inline. No native, tablet, production, or deployment acceptance was run.
