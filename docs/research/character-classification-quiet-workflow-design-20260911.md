# Quiet Character Classification Workflow

Date: 2026-09-11
Status: Approved product design; implementation not authorized by this document

## Authority and relationship to current work

This document records the approved simplification of Lakomics character
classification. It preserves the existing character data and recognition engine
while changing what the user operates and when historical analysis may run.

It does not authorize code changes, production-library writes, backfills, Git
writes, deployment, or removal of existing user data. The living backlog remains
the source for implementation status and priority.

The reference-expansion performance contract is recorded separately in
`character-reference-delta-reconsideration-design-20260911.md`. That document
defines how an explicitly requested historical refresh should avoid repeating
unchanged comparison work.

2026-09-13 user clarification: the work center shows the current series/character,
per-request processed/total/remaining and failures, with new-image work separate.
This supersedes the generic-only work-center restriction below. Explicit refresh
now snapshots all eligible unclassified IDs inside the requested series and its
ordinary descendants, even without automatic job history;
reference changes still never start a historical pass. Existing in-flight legacy
cursor requests are not expanded. Refresh discovery and pre-analysis checks exclude
parent/sibling sources; ordinary-parent inference remains a fresh-ingestion rule. See CHAR-AUTO-002/005 for verification.

## Product judgment

Character folders, representative thumbnails, and presentation-only character
groups are successful parts of the product and remain central.

The problem is that internal recognition concepts became user-facing operations.
Collection currently exposes analysis starts, review queues, status filters,
reconsideration work, and detailed evidence. This makes saving an image feel like
operating a classification engine. Long historical reconsideration followed by a
noisy review queue consumes both compute time and user attention.

The new goal is not to clear a review queue. It is to let the user collect images
without waiting for or supervising character analysis.

## User-owned actions

The normal product exposes four deliberate character-management actions:

1. Create a series.
2. Create a character.
3. Arrange characters into presentation groups.
4. Add selected images as character references.

One recovery action remains available when an automatic result is visibly wrong:

- select an image and choose `다른 캐릭터로 변경` or `캐릭터에서 제외`.

Recovery is not a review queue. The user acts only when they notice a wrong result
during ordinary browsing.

## Collection and recognition scope

The user's initial classification choice is authoritative.

### Registered series or its descendant

An image saved directly to a registered series, or to a normal descendant folder
whose nearest registered ancestor is that series, may enter character recognition. Ordinary folders can opt out through `캐릭터 분류에서 제외`: the persisted folder identity excludes its current and future descendants from the unclassified pool, automatic enrollment, historical refresh, and late automatic publication. Whole-series browsing and existing manual memberships remain available. Removing the folder policy restores eligibility without automatically replaying historical assets.
It is compared only with ready characters registered to that nearest series.

Example: an image saved to `던전밥` is compared with ready `던전밥` characters.
Character presentation groups do not change this candidate roster.

### Broad or unrelated classification

Updated by user approval on 2026-09-12: when the saved folder has no registered
series ancestor, compare the image with ready characters in registered series
below that folder. This applies to both top-level and intermediate folders, never
to unrelated branches. Folder names do not affect eligibility.

Enabled series, asset exclusions, manual-only characters, and Originals protection
still govern the roster. Compare all eligible characters together, including
competitors from different descendant series. The existing six-reference support
and competing-person checks still gate automatic acceptance. A confident result
adds character membership without changing the ordinary classification or file;
ambiguous results stay quietly in the saved folder.

Expected scale is at most a few dozen characters. Reuse the existing local worker,
one query extraction per image and cached explicit references (at most 25 per
character); no extra model, network service, or whole-library image scan is added.
An unrelated folder without eligible series descendants creates no character job.

If the user later moves the image into a registered series or one of its ordinary
descendants, that explicit reclassification may enqueue character recognition for
the new nearest series.

### Originals boundary

The existing Originals exclusion remains. Originals are not character-recognition
scope unless the user explicitly converts the relevant structure into a registered
series under a separately approved workflow.

## Per-image comparison behavior

Character recognition compares the incoming query image with explicit reference
sets, not with every asset displayed in a character folder.

For each ready character in the applicable series, one reference list contains up
to 25 explicitly selected images. The former anchor/learned split remains only in
legacy storage and API compatibility; it does not change a reference's weight or
require the original five slots to remain populated.

Ordinary character-folder membership does not make an image a reference. Automatic
acceptance also does not silently turn the accepted image into a reference.

Five valid references mean that a character is eligible to participate in comparison;
they do not mean that automatic acceptance is possible. Under the current support
rule, automatic acceptance needs agreement from at least six references, so the UI
must not label the five-reference state as `자동 분류 준비 완료`. Reference management
shows one valid-reference count without exposing scheduler states or promising a
particular accuracy. With fewer than five valid references, the target and its
manual memberships remain intact; comparison waits for enough valid references.

Trash and other unavailable references do not participate in comparison or appear
in the active editor list. Their stored links survive an ordinary settings save,
so restoring eligibility makes them available again. The 25-reference storage cap
includes retained unavailable links. Explicit removal deletes the reference link
and records an exclusion without deleting character membership. Reference edits
advance the edit revision to reject an older editor's overlapping save.

The query image is loaded once and compared with the reference bundle for each
ready character in the series. The existing conservative automatic decision and
competing-character checks remain. A group does not affect classification,
references, comparisons, or reconsideration.

## Automatic outcomes

### Confident result

A result that satisfies the conservative automatic threshold and has no conflicting
candidate for the same detected person receives a character relation. The original
asset and ordinary series classification remain intact. The relation makes the
asset appear in the character folder; it is not a physical file move.

### Ambiguous or unsupported result

An uncertain result stays in its existing series or descendant folder. It does not
create a badge, count, inbox, or obligation to review. Durable diagnostic evidence
may remain internally for safe reuse and troubleshooting, but normal UI does not
present it as unfinished user work.

### Multiple characters

One physical image may appear in several character folders when distinct detected
people confidently match different characters. Removing or changing one character
relation preserves the asset and all other character relations.

### Processing failure

A recognition failure leaves the image in its ordinary classification. Bounded
automatic retries may continue internally. The user is not asked to operate a job
queue. A persistent system failure may be shown as a concise application error with
a recovery action, but individual unmatched or ambiguous images are not errors.

## Character folder

The character folder is primarily an image-browsing surface. It shows:

- character name and representative thumbnail;
- the character's image collection;
- reference selection and management;
- presentation-group placement through character management; and
- correction actions for selected images.

It does not show a review badge or require the user to clear pending work. Confirmed
images are already visible here, so a separate `확정` review tab is unnecessary.

Selecting an incorrectly placed image offers:

- `다른 캐릭터로 변경`; and
- `캐릭터에서 제외`.

These actions are authoritative manual decisions. They do not remove the source
asset, ordinary classification, or unrelated character memberships.

## Reference creation from an existing character folder

Existing character folders contain a high-quality candidate pool because the user
has already inspected most of their contents. The application should reduce the
work of choosing references without treating every member as trusted training data.

1. Use human-confirmed character relations as the preferred candidate pool.
2. Exclude known rejections, shared multi-character images where an isolated
   identity is not reliable, invalid media, duplicate content, and existing
   references.
3. Rank for visual diversity rather than returning twenty near-duplicate images.
   Useful variation includes face angle, expression, outfit, crop, source, and art
   style when those signals are available.
4. Present up to twenty suggested references in one compact selection surface.
5. The user removes wrong or poor candidates and confirms the batch once.
6. Only the confirmed batch joins the same reference list.

The application must not claim that twenty references guarantee accuracy. Reference
quality and diversity matter, and automatic-acceptance behavior requires measured
validation on the resulting set.

## Converting a curated normal folder into a character

Some existing collections are already organized as normal folders before a
CharacterTarget exists. Conversion treats that organization as an explicit user
assertion rather than asking AI to revalidate every image.

The conversion flow is:

1. From the normal folder, choose `캐릭터로 만들기`.
2. Confirm the owning series, character name, representative image, included scope,
   and asset count.
3. Link all included images to the character as confirmed memberships in one
   transactional operation. Do not run recognition over them.
4. Generate the diverse reference-candidate selection from those images.
5. Let the user confirm the reference batch once.
6. After every intended asset and relationship is preserved, remove the redundant
   normal classification shell when it is safe and empty.

The conversion does not copy source files or create duplicate assets. Other
character memberships and decision history remain intact. A nonempty child folder,
excluded media, changed asset set, or conflicting same-name destination prevents
silent cleanup and receives one concise safety explanation. A safe existing
same-name normal folder may be merged according to the already accepted conversion
policy.

The default assumption is that all included images belong to the new character.
The user corrects the small number of exceptions later with `캐릭터에서 제외` or
`다른 캐릭터로 변경`.

## Reference changes and historical assets

Settings → General → `캐릭터 자동 분류` exposes the library's persisted whole-engine
pause flag. Enabling resumes new and already queued images; it does not create a
historical refresh. Disabling takes effect after the current image completes.
The existing historical-refresh pause control remains separate: neither switch
changes the other's saved flag. Merely opening Settings must not enable automation.

Schema v69 repairs early development v68 libraries missing the admission sequence
table and historical-refresh cursor. Startup takes a verified pre-migration DB
snapshot, then fills only missing schema inside the migration transaction. Existing
admission numbers, refresh progress, classifications, references, and pause flags
are preserved; the repair does not enqueue historical work. Applied migrations must
not be extended in place: schema additions require a new forward migration.

Adding or confirming references immediately affects newly enqueued images. It does
not automatically start a historical pass.

Removing or trashing a reference also applies to future comparisons without a
historical pass. Reference-set identity and prepared-input checks invalidate stale
work. An explicitly requested historical refresh may reuse a strict append-only
delta; reference removal/replacement falls back to comparison of the current valid
set, reusing available image-feature caches rather than reusing invalid votes.

The normal reference action therefore completes when the new reference set is
saved. The UI does not block on historical analysis or imply that thousands of old
images must now be processed.

An optional, infrequent action is available under character management:

- `과거 미분류 이미지 갱신`

Only this explicit action may start historical reconsideration for reference growth.
It targets unresolved historical assets in the applicable series and runs below
new ingestion and interactive work. It does not reconsider manual accepted results
or silently audit existing automatic memberships.

The pass follows the delta contract in
`character-reference-delta-reconsideration-design-20260911.md`: batch reference
changes, compare new reference evidence only where valid old evidence exists, use
bounded cursors, retain source and context safety checks, and measure fallbacks.

## Normal UI removals

The following concepts leave the everyday character experience:

- review-pending dots, counts, and badges;
- the routine character review inbox;
- `검토 대기` and `확정` tabs;
- filters for recommended, unmatched, pending, multiple, rejected, and error states;
- ordinary `분류 시작`, cancel, and full reanalysis controls;
- automatic, legacy, manual, and reconsideration provenance;
- per-target distance, matched-reference counts, and evidence details;
- controls that separately toggle series automation and routine per-character
  participation.

Durable evidence, decision history, diagnostics, retry state, and safety metadata
remain in the backend where required. A diagnostic or recovery surface may expose
them outside the normal collection flow, but it must not recreate a second review
inbox or ask the user to understand scheduler internals.

## Minimal screen responsibilities

### Series surface

- create and edit the series;
- create a character;
- create and edit presentation groups;
- browse characters and ordinary series assets.

### Character surface

- browse the character collection;
- choose the representative image;
- confirm or manage a reference batch;
- correct selected image memberships;
- access the infrequent historical unresolved refresh.

### Normal folder surface

- keep ordinary collection actions;
- offer series registration where appropriate;
- place `캐릭터로 만들기` under a concise conversion or management action rather
  than making migration controls permanently prominent.

## Data preservation and compatibility

- Preserve CharacterTarget identities, character relations, manual decisions,
  learned-reference exclusions, groups, durable jobs, evidence, and history.
- Do not delete or rewrite existing user decisions as part of the UI simplification.
- Preserve source files and ordinary classifications unless the user performs the
  explicit safe folder-conversion cleanup.
- Keep Windows and Linux path, media, source-identity, and credential behavior.
- Do not modify the frozen legacy `extension/`; any collector-facing change follows
  the active `extension-list/` contract and requires separate scope review.

## Acceptance requirements

### Scope and collection

- Saving one image directly to `던전밥` compares it only with ready `던전밥`
  characters.
- Saving the same image to a descendant of `던전밥` uses `던전밥` as the nearest
  registered series.
- Saving to an ordinary parent folder compares only its eligible descendant
  characters, with cross-series competition checks and no automatic folder move.
- Saving to an unrelated folder without registered descendants, or Originals,
  creates no character job, prediction, relation, move, review item, or notification.
- Moving an asset later from a broad category into `던전밥` enqueues it exactly once
  against the current `던전밥` roster.

### Decisions and membership

- A confident single-character result appears in the correct character folder
  without changing the source file.
- Distinct people may create several character memberships for one asset.
- An ambiguous or unsupported result remains quietly in its ordinary classification.
- Changing or removing one membership preserves every other membership and the
  source asset.
- A manual correction cannot be overwritten by stale automatic evidence.

### References and historical work

- Character-folder assets are not compared as references unless the user confirms
  them as anchors or learned references.
- Suggested reference batches exclude known bad candidates and prefer diversity;
  confirmation is one batch operation.
- Adding references changes future classification without creating historical jobs.
- Only `과거 미분류 이미지 갱신` starts the bounded historical path.
- The historical path yields to new ingestion, survives restart and pause, preserves
  manual decisions, and matches a safe full recomputation on the same evidence.
- Performance claims include before-and-after measurements with identical inputs and
  separate fixture, production-library, Linux-native, and Windows-native evidence.

### Folder conversion

- Converting a curated normal folder creates memberships without inference.
- Files, unrelated memberships, and included asset counts remain unchanged.
- A changed or unsafe folder snapshot prevents partial cleanup.
- Suggested references are presented only after character creation succeeds.

### UI

- The normal series and character flows contain no review inbox, pending badge,
  scheduler provenance, or analysis-start requirement.
- Failure and ambiguity do not masquerade as user tasks.
- Narrow and wide desktop layouts retain browsing position and do not shift the
  gallery when selection actions appear.
- Native Windows and Linux acceptance is reported separately from browser rendering
  and isolated tests.

## Delivery slices

This design is one product contract but should not be implemented as an unreviewed
big-bang rewrite.

1. Keep explicit series scope narrow; the 2026-09-12 policy also permits inference
   among eligible descendants of an ordinary parent folder. Later explicit moves
   enqueue once for the new scope without sweeping old assets.
2. Remove normal review obligations and simplify series, character, and status UI
   without deleting backend evidence or decisions.
3. Consolidate normal-folder conversion and diverse batch reference selection around
   existing safe membership and reference APIs.
4. Stop implicit historical reconsideration after reference growth and add the
   explicit bounded delta refresh described by the companion design.

Each slice requires its own inspection of current working-tree changes and focused
Windows/Linux-compatible verification. No slice authorizes production-library
migration or cleanup.

## Explicit non-goals

- Replacing the recognition model or changing its detector and distance thresholds.
- Treating every character-folder asset as a learned reference.
- Automatically learning from automatic decisions.
- Automatically sweeping historical assets after reference changes.
- Guessing among series outside the saved folder's descendants or changing the
  ordinary classification after an automatic character decision.
- Removing backend evidence merely because normal UI no longer exposes it.
- Redesigning Mobile, Works, Collection, or the collector beyond the character
  classification boundary required by this workflow.
