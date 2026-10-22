# AV authority step 2a: details and credits

Source contract, 2026-10-07. Server and PC only; tablet editing is step 2b.
This change does not deploy, activate authority, or operate on a production library.

## Commands

Both commands accept ordinary client credentials and use the existing authority
envelope, immutable operation ID, receipt and change-feed transaction.

- `setAvDetails`: `{workId, changes, expected}`. Both objects have exactly the
  same nonempty subset of `productCode`, `titleJa`, `maker`, `label`, `series`,
  `genres`, `releaseDate`. Text is trimmed and blank text becomes null. Each
  touched field compares against its expected value; unrelated fields survive.
  Like `updateWork`, an already satisfied desired state is receipted without a
  revision bump. Accepted changes live in `details.av` and bump the work revision.
- `setAvCredits`: `{workId, credits, people, expectedRevision}`. Credits replace
  the complete list and compare the work entity revision. This follows existing
  whole-entity CAS and the PC's confirmed revision cache; it adds no independent
  credits revision. Each credit is `{personId, role, order, creditName}`. Roles
  are performer/director. Person/role and role/order pairs must be unique.
  Array order is canonicalized by role, order and person ID. An already satisfied
  list is a receipted no-op. New people are `{personId, displayName, nameJa}`;
  each must be referenced by a credit. Existing person payloads are never
  overwritten, including when another client has already created the same ID.
  New payloads have null memo/profile/portrait and false favorite.

The limits are shared by server read models and commands in `av_contract.py`.
The PC uses `src/collections/avLimits.json` from both Rust and its editor. Server
tests compare the PC definition to the server definition. Product codes are 64
characters, Japanese titles 2000, maker/label/series and person/credit names 500;
genres allow 64 entries of 100 characters. Credits allow 64 entries, with order
0..63 and the existing 1..128-character alphanumeric/underscore/hyphen ID format.
Dates must be real calendar dates in `YYYY-MM-DD`. PC queue insertion enforces
the existing 64 KiB client envelope limit without truncating data.

## Projection and compatibility

Contract version remains **1**, as with earlier additive commands. Existing PC
and tablet identity checks require that exact version. The baseline's seven
ordered sections remain unchanged because the shipped PC rejects a changed
section layout. AV work entities add `avPeople` alongside `avCredits`; receipts,
changes and work baseline pages include the referenced people's identities and
stored payloads. New credits retain `creditName` in storage and all projections.
Older fields, including name, Japanese name and portrait crops/images, remain.

The PC consumes person names from `avPeople` when present and falls back to
credit names only for old feeds. Explicit null `creditName` clears the alias;
an old feed omitting the field preserves the existing local alias. Names are
upserted without clearing person-local memo, portrait, profile or favorite rows.
Server person identity columns preserve staged names after the last credit is
removed, without rewriting that person's existing payload.

Inactive replica publication advertises the additive `avCreditName` feature.
The PC includes aliases only when the server advertises it, preserving older
servers' strict replica bodies. Baseline staging accepts old credits without the
new field and exports aliases when available.

## PC save and remaining fences

The existing editor exposes product code, label, series and credits; its layout
and other edit controls are unchanged. Authority-backed saves queue changed
detail keys and changed credits in the same local transaction. Expected detail
values start from confirmed state and include preceding FIFO detail intents.
Credit revisions account for preceding work/detail/credit/artwork-selection
changes. Confirmed revision caches are never made optimistic. Pending overlays
are replayed after feed/receipt application and survive reopening the library.
Conflicts use the existing blocked queue state and status-center count.

Schema **124** widens label/series, person display names and per-work credit names
to 500. Its transaction copies the three affected tables, preserves all child
references and publication triggers, and checks foreign keys before committing.
Existing product codes retain their old storage bound; new saves use 64.
Received AV changes advance the local edit token so a stale open editor cannot
silently overwrite them. Inactive saves continue through the local transaction.

AV link apply, person memo/favorite/portrait changes and StashDB stay fenced.
Tablet UI and Android sources are unchanged. Server deployment must precede use
of these commands by an updated PC. Runtime, device and production acceptance,
and server unittest execution in the existing WSL environment, remain separate
verification steps; syntax compilation does not establish server acceptance.
