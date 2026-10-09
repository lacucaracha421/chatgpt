# Manual performer profile editing — server contract

Source contract, 2026-10-09. Implements AV-AUTHORITY-001 item 6, step 1.
Contract version remains **1**. This source change does not deploy, access a
provider, modify production data, or implement a PC/tablet editor.

## Storage and reads

`collection_authority_people.payload` adds:

- `stashdbProfile`: the normalized provider profile, or null after clear. The
  distinction between an absent key and an explicitly null value matters: an old
  person without this key uses its existing `profile` as the provider baseline.
- `profileOverrides`: a sparse object containing manual values. A present key
  with null means an explicitly cleared manual value; absence means follow the
  baseline. The object also stores name overrides (`displayName`, `nameJa`).
- `profileBaseNames`: the original server display/Japanese names, captured on the
  first manual name change, for restoring both names on reset.
  This is not a new provider identity or a guessed StashDB binding.

`stashdbId` retains the step 4 attach/refresh identity. `profile` remains the
**effective merged profile**, with precisely the existing reader shape:

```text
{source, name, aliases, birthDate, heightCm, bandIn, waistIn, hipIn,
 cup, breastType, careerStart, careerEnd, urls:[{site:<string>, url}]}
```

The provider's `name` and `aliases` remain provider metadata. The editable names
are the person's top-level `displayName` and `nameJa`, not `profile.name`.
Overrides replace only their individual effective fields. The provider object is
never edited by a manual command. Explicit null links become `profile.urls:[]`
for existing readers, while `profileOverrides.urls:null` preserves the intent.
With no provider profile but some profile-field overrides, `profile` has the
usual keys with null/empty defaults. Its legacy `source` discriminator stays
`stashdb`; clients must use `profileOverrides` to identify manual provenance.
With no provider and no profile-field overrides, `profile` is null (name-only
edits do not manufacture a profile).

Both name baselines are the person's server names immediately before the first
manual name change, captured together in `profileBaseNames`. Reset restores the
captured name for that field. StashDB `name` is provider metadata only; attach,
refresh and clear never change either person name or the captured baselines.
Profile-field edits do not capture name baselines. A manual command changes a name
only when that name is in `changes`, so editing height never incidentally renames
an old person. Explicitly clearing the display name stores a null override but exposes
an empty string in the effective identity and credit copies, preserving their
existing non-null string contract. Clearing Japanese name exposes null.

Lazy migration needs no SQL migration, backfill, or catalog replacement. Reading
an old person exposes `stashdbProfile` derived from `profile` and an empty override
object without writing the row. A changed manual/refresh command materializes the
additive fields. A no-op does not perform a migration or advance revisions.

Plain `GET /v1/collections/people/{id}` excludes `stashdbId`, `stashdbProfile`,
`profileOverrides`, and `profileBaseNames`; its existing keys/profile shape remain
unchanged, including staged persons whose payload has no top-level names.
`?authority=1`, full-person receipts (including memo/portrait receipts), conflict
`current.person`, and work `avPeople` expose the provider baseline and overrides.
The authority projection also carries `profileBaseNames` once stored. Old clients
continue reading `profile` and the existing identity/credit fields without changes.

## Ordinary-client command

Use the existing `PUT /v1/collections/authority/commands` envelope and durable,
immutable operation ID:

```json
{
  "libraryId": "<active library ID>",
  "epoch": 1,
  "contractVersion": 1,
  "operationId": "<UUID>",
  "commandType": "setPersonProfileFields",
  "personId": "<existing person ID>",
  "changes": {
    "displayName": "한국 이름",
    "heightCm": 160,
    "cup": null
  },
  "expected": {
    "displayName": {"value": "Previous name", "overridden": false},
    "heightCm": {"value": 156, "overridden": false},
    "cup": {"value": "E", "overridden": false}
  }
}
```

Allowed keys are `displayName`, `nameJa`, `birthDate`, `heightCm`, `bandIn`,
`waistIn`, `hipIn`, `cup`, `breastType`, `careerStart`, `careerEnd`, and `urls`.
No provider-supplied aliases, `profile.name`, source discriminator, portrait,
memo, favourite, or StashDB identity can be written by this command. The person
must already exist; otherwise return `404 personNotFound`.

For reset, use `changes:{"heightCm":{"reset":true}}` and the usual expectation
for height. Only the exact reset object is allowed; reset deletes the override,
then resolves profile fields against the current provider baseline, or the
empty/default state without a provider. Name fields instead restore their captured
server names from `profileBaseNames`. Setting null and resetting are different operations.

### Field CAS

`changes` and `expected` have the same nonempty subset of allowed fields. Every
expected token has **exactly** `value` and a strict boolean `overridden`:

- `value` is the current effective top-level name or the effective `profile`
  field. Missing/null profiles yield null field values. Cleared links use the
  effective empty array, and cleared display names use the effective empty string.
- `overridden` is key membership in `profileOverrides`, including keys whose
  stored value is null. Do not infer membership from a truthy value.

Expected values are exact snapshots, not normalized user inputs. Legacy profile
floats/text remain usable as expectation values even when new writes have stricter
limits. Expected values retain type/shape checks; boolean numeric values are
rejected. Numeric int/float equality follows the existing JSON numeric semantics.

First compute the desired sparse override object. If it already equals the stored
object, accept a receipted no-op **before** CAS, even with stale expected tokens.
Examples: re-setting an existing override, or resetting a field that already
follows its baseline. Setting the current effective value for the first time **is a
change**, because it acquires manual ownership. Changing null links to an empty
array override is also a change, even though both display identically.

Otherwise **every touched field** must match both expected effective value and
expected override membership, including touched fields already satisfied in a
mixed command. A mismatch returns `409 revisionConflict` with the full current
person. Unrelated memo, portrait, or profile-field edits do not conflict. A source
refresh hidden behind an existing override does not conflict with that field;
profile-field reset deliberately follows the latest source, while name reset
restores the captured server name. A reset after another device has
acquired manual ownership conflicts even if the displayed value stayed equal.

The entire command, names, work copies, revisions, projections, feed row and
receipt share the existing transaction. Reusing an accepted operation ID returns
its original full-person receipt; a different normalized payload at that ID returns
`409 operationConflict`. Failed commands write no accepted receipt.

### Write validation

New manual values use the StashDB normalizer's limits, rejecting invalid values
instead of silently discarding them:

| Field | Accepted values |
| --- | --- |
| Names | String up to `av_contract.MAX_PERSON_NAME` (500), trimmed; blank becomes explicit null |
| Birth date | Valid year, year-month, or calendar date, using `av_stashdb.valid_date` (year-only 1900–2200) |
| Height | Integer 1–300 cm |
| Band, waist, hip | Integer 1–200 **inches**, the existing storage unit |
| Cup | String up to 20 characters, trimmed; blank becomes explicit null |
| Breast type | `NATURAL`, `FAKE`, `NA` |
| Career years | Integers 1900–2200; a manual edit/reset touching career years must leave end at or after start when both exist |
| Links | At most 100 exact `{site,url}` objects; site at most 200 characters; safe HTTP(S) URL at most 2000, no embedded credentials or control characters |

Every field accepts explicit null. Links also accept an empty array. Invalid
fields/values/shapes return `422 invalidCollectionCommand`. Total stored person
size, including source, overrides and effective copies, stays bounded to 64 KiB;
an oversized manual payload returns `413 collectionPayloadTooLarge`. The ordinary
command request body limit also remains in force. An oversized provider refresh
keeps the step 4 `413 providerResponseTooLarge` response.

## Names, publication and receipts

Renaming updates names in the payload where those keys already exist, the person
row's `display_name`/`name_ja`, `av_person_identity`, and every stored matching
work's `avCredits.name`/`nameJa`, including trash/tombstones and multiple roles.
`creditName` is the per-work credited name and is **never changed**. A later
`setAvCredits` for an existing person uses its authoritative names, ignoring stale
supplied client names. Person IDs, work titles, roles, order and portrait selection
are unchanged.

Every changed manual command advances person `entity_revision` by one, and
republishes each non-tombstoned crediting work once (work revision +1). Live work
read projections and feed `avPeople` therefore contain the edited values and
source markers. There is still no people feed section; the seven existing
sections are preserved. A person with no surviving credits still receives a
revision change and full-person receipt without inventing a work publication.

Receipts keep `changed`, `changeSequence`, `authorityCursor`, `entities`,
`updatedAt` and full `person` including `profileOverrides` and `stashdbProfile`.
No-ops have `changed:false`, no change sequence, and unchanged revisions/cursor.
A client's work-revision intent may conflict after a person edit republishes it.

## StashDB attach, refresh and clear

`setPersonProfile {personId,stashdbId,expectedRevision}` still fetches normalized
provider data on the server, with the step 4 preflight/replay/provider boundaries.
It replaces only the provider baseline/identity, then recomputes the effective
profile. It never changes either name, captures name baselines, or clears
`profileOverrides`. Clearing StashDB
sets the provider baseline and identity to null and retains all manual values.
It does not clear memo, favourite or portrait.

No-op comparison uses the **provider baseline and ID**, not the effective profile:
a source change hidden behind a manual override is still a real change so clients
can show the updated source next to 직접 입력. Identical source and ID is a
receipted no-op before revision CAS. Otherwise the existing person-revision CAS
protects concurrent manual/memo/portrait edits during provider I/O.

## Deployment order and clients

`GET /v1/collections/authority/status` adds `features:["personProfileFields"]`
to both active and inactive responses. This advertises server support for
`setPersonProfileFields`; it does not activate Collections authority. Enable the
editor only when the status is active with a supported authority identity, the
`features` array includes `personProfileFields`, and the person has source/override
metadata. An absent array or feature means unsupported. Contract version stays 1;
clients must ignore unknown feature names.

Existing PC and tablet status parsers tolerate this additive key: PC's
`CollectionAuthorityStatus` in
`_tools/app/src-tauri/src/library/collection_authority.rs` uses Serde deserialization
without `deny_unknown_fields`; tablet's `authorityIdentity` in
`_tools/app/mobile-client/collectionCommandOutbox.ts` validates only the known
identity fields. Both already read this status route. This compatibility was
checked in source; the existing clients discard the feature and future editors
must retain it explicitly.

1. Separately authorize and deploy this server change together; preserve the
   existing server database backup. No backfill, new dependency or production
   write is part of this source task. Verify the new command/read metadata before
   enabling editors. Existing PC/tablet reads remain compatible.
2. **PC, step 2:** extend the confirmed person cache, replica projection and durable
   outbox to retain source/overrides/base names. Edit through
   `setPersonProfileFields`, never local-only writes under active authority. Use
   confirmed field tokens plus preceding FIFO optimistic intents, and keep expected
   values independent of displayed cm/inch formatting. Send only touched fields;
   unchanged form fields must not acquire manual ownership accidentally. Apply
   full receipts/feed people without replacing newer confirmed revisions. Account
   for crediting work revision bumps just as for memo/portrait commands.
3. **Tablet, step 3:** use the same contract, persisted source markers, reset and
   conflict handling. Match the PC screen decisions with touch/portrait differences
   only. Never convert stored B/W/H to cm on write without returning them to the
   existing integer inches contract. Refresh/clear still uses `setPersonProfile`.

Both editors must show 직접 입력 by override **membership**, even for explicit
empty values; offer per-field reset and show the current StashDB value for profile
fields or the captured server baseline for names alongside it. Keep previous
content until new data is ready and preserve offline reads and
queued edits. An old server or person cache without source metadata must disable
these writes with an explicit unsupported state; do not guess expectations or
fall back to local edits. Unknown response keys alone are not evidence that the
new command is deployed: gate the editor against the status feature above and
handle `unsupportedCollectionCommand` without losing the user's draft.

Remaining PC/tablet choices: inline versus grouped edit surface, blank-name
presentation, placement of the source/reset affordance, converting the existing
cm/inch display into integer-inch input, and conflict resolution/draft retention.

## Verification scope

Direct disposable SQLite tests exercise production command parsing/application,
receipts, projections and public-person read helper without TestClient threads or
provider I/O. Coverage includes override refresh/reset/clear, explicit null/empty,
CAS/no-op/replay, field and aggregate limits, old shapes/floats, name preservation
through StashDB attach/refresh/clear, captured name resets and propagation,
multiple roles/trash/tombstones/future credits, and persons without credits.
Registered status endpoint tests cover active/inactive capability advertisement,
authentication and read-only behavior with inline transaction scheduling. Existing
API tests also cover the additive inactive status response. PC/tablet parser
compatibility is checked by source inspection.

Verified 2026-10-09: the full server suite (`.venv/bin/python -m unittest discover -s tests` in
`server/lakomics-api`) ran 2060 tests, OK (2 skipped opt-in performance benchmarks).
