# AV authority step 3a: people memo, favorite and portrait

Source contract, 2026-10-07. Server and PC only; tablet editing is step 3b.
This change does not deploy, activate authority, or operate on a production library.
It extends [step 2a](collection-authority-av-step2a-20261007.md).

## Commands

Both commands accept ordinary client credentials and use the existing authority
envelope, immutable operation ID, receipt and change-feed transaction. The person
must already exist on the server (activation baseline or `setAvCredits`); an
unknown ID is a definitive `404 personNotFound`.

- `setPerson`: `{personId, changes, expected}`. Both objects have exactly the
  same nonempty subset of `memo` and `favorite`. Memo text is trimmed, blank
  becomes null, and the limit is 2000 characters (`av_contract.MAX_PERSON_MEMO`,
  shared with the PC through `src/collections/avLimits.json` `personMemo`).
  Favorite is a strict boolean. Field CAS as in `setAvDetails`: an already
  satisfied desired state is a receipted no-op; otherwise every touched field
  must equal its expected value or the command is a `409 revisionConflict` whose
  `current.person` carries the full person.
- `setPersonPortrait`: `{personId, portrait, expectedRevision}` with person
  revision CAS. `portrait` is one of:
  - `null` (clear);
  - `{kind:"crop", artworkId, rect:{x,y,w,h}}`, values in 0..1, width and height
    above 0.02 and inside the image. The artwork must be a cover of an AV work that
    credits the person. It need not still be that work's selected cover, so a later
    cover change cannot turn a queued intent into a permanent refusal;
  - `{kind:"image", original:{sha256,sizeBytes,contentType:"image/jpeg"}, width,
    height, attribution:{source:"commons"|"stashdb"|"local", sourceUrl, license,
    author}}`, at most 5 MiB and 1600 px per side. The blob needs the same
    confirmed upload receipt as `addArtwork` originals (`409
    artworkBlobUnconfirmed` otherwise).

  A desired portrait equal to the current selection is a receipted no-op before
  the revision check, so a retried or reconciled intent is idempotent.

People gain an independent `entity_revision` (default 1 for existing rows) and a
stored `portrait_selection`. Rows staged before this change derive their
selection from the staged `portrait_image` and payload attribution, else from the
first credit crop, so re-sending the staged choice is a no-op.

## Projection and compatibility

Contract version remains **1**: both commands and all fields are additive.

- Receipts add `person` (the full person entity).
- AV work entities' `avPeople` add `entityRevision`, `portraitSelection` and the
  existing `portraitImage`. Older PCs ignore unknown person keys.
- Today's readers stay intact. The person payload keeps `memo`, `favorite`,
  `profile` and the `portrait` attribution (`{source:"cover"}` for crops). A crop
  is written to every credit of that person as `portraitCrop`, as the PC
  publication did; an image clears those crops and fills `portraitImage`. Image
  blobs are registered as `collectionPeople` Home cover references, so the
  tablet's `POST /v1/home/covers/{sha256}/media-ticket` keeps working, and a
  cleared image's ticket stops answering.
- `GET /v1/collections/people/{id}` is byte-for-byte unchanged by default (a test
  pins the served payload across activation). `?authority=1` adds
  `personId`, `displayName`, `nameJa`, `entityRevision`, `portraitSelection` and
  `portraitImage` for the PC; the tablet can use it in step 3b.

How caching clients learn about person changes: the baseline keeps its seven
sections and the change feed has no people section, because the shipped PC
rejects unknown sections. Instead an accepted person change republishes every
non-tombstoned work crediting that person (work revision +1, change row with
those works). Clients that cache works therefore receive the new `avPeople`
through the existing feed. Consequence: a work-revision CAS command composed
against the old work revision conflicts. The PC predicts this for its own queued
person commands; a concurrent edit from another device conflicts as any remote
work change does.

## PC

`save_av_person_memo`, `set_av_favorite`, `set_av_portrait_crop`,
`clear_av_portrait`, `use_av_commons_portrait` and `use_av_stashdb_portrait` are
routed when authority is active. Each queues its command in the same local
transaction as the local write and projects optimistically. Expected values and
the person revision start from the confirmed person cache
(`collection_authority_people_cache`) and include preceding FIFO person intents.
Unchanged saves queue nothing. Without a confirmed person row (an old feed
before the reconcile has read that person), person edits answer
`CollectionAuthorityOperationUnavailable` instead of guessing a revision.

Images are re-encoded once to JPEG (quality 88, at most 1600 px per side,
at most 5 MiB) and kept by digest in `collection_authority_portrait_blobs`. The
outbox uploads them through the existing `addArtwork` upload/confirm path before
sending. Remote image selections are downloaded through the Home cover ticket and
accepted only when length and SHA-256 match; until then the previous picture
stays. Download failures do not stop the sync cycle.

Receipts and feed `avPeople` with `entityRevision` update the cache (never to an
older revision) and project memo, favorite and portrait. Crop selections whose
cover arrives later are re-projected after each sync, followed by pending
portrait intents. Old feeds without revisions keep the 2a behaviour (names only).
Conflicts use the existing blocked queue state and status-center count.

Commons preview stays read-only. StashDB "use this photo" only writes the portrait
(the profile it reads is already stored), so it is routed. StashDB search,
refresh, choose, dismiss and clear profile (`av_stashdb.rs`) stay fenced until
step 4. AV link apply stays fenced.

## One-time reconcile (user-approved)

On the first authority observation or AV feed apply for a library/epoch, the PC
captures every local person's memo, favorite and portrait (images are re-encoded
and stored then) into `collection_authority_people_reconcile`, before any server
person values are projected. A `notes_state` marker makes the capture run once.

Each sync then processes up to 50 unprocessed people: read
`/v1/collections/people/{id}?authority=1`, receive it, and queue in one local
transaction, together with the row's `queued=1` checkpoint:

- `setPerson` memo when the PC memo is nonblank and the server memo differs
  (empty server: fill; both nonempty and different: PC wins);
- `setPerson` favorite only when the PC is true and the server is false;
- `setPersonPortrait` when the PC portrait is set and differs. Two images with the
  same attribution are the same picture (byte encodings differ between
  publications), so no upload is repeated.

A PC null, blank or false is never sent, so the reconcile never clears a server
value. A read failure or an older server without person revisions stops the pass
without changes; the next sync resumes. A person the server does not have is
marked `missing` and is retried only after a confirmed row for it arrives. Queued
counts are logged; outcomes appear through the existing outbox health (blocked and
dropped counts).

## Deployment order and verification

Deploy the server before the PC. An updated PC against an older server finds no
person revisions and leaves people untouched; person edits answer
`CollectionAuthorityOperationUnavailable` until the server is updated. Schema
**125** adds the three PC tables.

Runtime, device and production acceptance remain separate verification steps.
