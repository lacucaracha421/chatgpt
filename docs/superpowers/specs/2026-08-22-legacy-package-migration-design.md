# Legacy Lakomics Package Migration Design

## Goal

Safely and idempotently migrate the legacy Lakomics package at
`C:\lakomics\Lakomics.library`, its matching metadata snapshot, and the 545
book collections under `C:\lakomics\book` into the current Lakomics library.
The migration preserves every source asset, user-visible folder membership,
custom title, favorite flag, source URL, and collection date while leaving the
source trees unchanged.

## Confirmed Source and Target

- Package root: `C:\lakomics\Lakomics.library`
- Package manifest: `C:\lakomics\Lakomics.library\library.json`
- Metadata snapshot:
  `C:\Users\Laku.LAKU\AppData\Roaming\com.lakomics\Lakomics\storage_metadata_backups\storage_metadata_latest.json`
- Book root: `C:\lakomics\book`
- Target library: `C:\Users\Laku.LAKU\Desktop\test_asset`
- Package inventory: 7,420 active assets, comprising 7,095 images and 325
  videos
- Metadata inventory: 7,420 unique item IDs and 7,420 existing relative paths
- User metadata: 8 favorites, 3,420 source URLs, and 2,270 custom titles
- Folder inventory: 62 source nodes, including one synthetic `저장소` root
- Book inventory: 545 directories with a readable `info.txt`
- Initial target baseline: 3 normal assets and 31 collections

The source package is an object package, not the flat directory accepted by
the existing `legacy_lakomics_migrate` command. Each source asset lives below
`objects/<shard>/<item-id>.item/payload/`, and its package manifest records the
content hash and exact folder IDs. A dedicated importer is therefore required.

## Recommended Architecture

Add a deep `legacy_package_migration` module with two public operations:

```rust
inspect_legacy_package_migration(paths) -> LegacyPackageMigrationPlan
execute_legacy_package_migration(plan, progress) -> LegacyPackageMigrationReport
```

The inspection operation owns all source parsing, path containment checks,
inventory validation, target preview queries, and source fingerprinting. The
execution operation owns target folder creation/reuse, normal ingestion,
trusted-source similarity resolution, metadata merging, source-item mapping,
book collection import, progress, backup association, and final reporting.
Callers do not need to know the package layout.

A new `legacy_package_migrate` CLI is the only adapter. It accepts explicit
paths and exactly one of `--dry-run` or `--execute`. No application UI or new
dependency is needed for this one-time operation.

## Source Validation and Fingerprint

Inspection must reject the source before any target mutation unless all of the
following are true:

1. `library.json` has the supported package schema and a non-empty library ID.
2. Folder IDs are unique, parent references exist, and the hierarchy is
   acyclic.
3. The synthetic package root is unique. Its children become target root
   classifications; the synthetic node itself is not created.
4. Every active item directory has one valid manifest and one contained payload
   path.
5. Every item ID, payload relative path, and manifest relative path is unique.
6. Every manifest folder ID exists in `library.json`.
7. Payload byte length and SHA-256 match the item manifest.
8. Every package item has exactly one metadata-snapshot item with the same item
   ID, and every snapshot relative path resolves to the manifest payload.
9. Exactly 7,420 assets are planned for the confirmed real source. Tests use
   smaller fixtures and do not hard-code the personal inventory count.
10. The book root contains exactly 545 readable `info.txt` entries for the
    confirmed real source.

The plan records a deterministic source fingerprint derived from the sorted
library manifest hash, metadata snapshot hash, item IDs, payload paths, payload
sizes, payload SHA-256 values, folder definitions, and book `info.txt` hashes.
Execution recomputes this fingerprint after migration. A mismatch makes the
report unsuccessful even if target writes completed.

Symlinks and canonical paths that escape either approved source root are
rejected. Source files are opened read-only. No source path is created,
renamed, deleted, or rewritten.

## Folder Mapping

The source `저장소` node is a package container rather than a user-facing
classification and is omitted. Its direct children are created or reused as
target `root` classifications. Every deeper child is created or reused as a
`tag`. Reuse requires an exact case-insensitive sibling name match under the
already mapped parent.

An asset may contain multiple folder IDs. All mapped folder memberships are
added. Existing target memberships are retained for an exact duplicate. A
source item assigned only to the synthetic root is imported as unclassified.
Folder creation is shallowest-first and deterministic by source display order,
then name and ID.

## Asset Import and Merge Rules

The existing ingestion path remains responsible for safe managed-file copies,
format probing, content hashing, thumbnails, video registration, and exact hash
deduplication.

For every source item:

- Images, GIFs, and all supported videos are ingested.
- Similar-looking but byte-distinct source images are automatically resolved
  as `keep_both`. The source package is a trusted user-owned library, and the
  requirement is to retain every distinct source asset.
- Exact SHA-256 duplicates map to the existing target asset and never create a
  second managed file.
- Folder memberships are merged additively.
- `favorite` is merged with logical OR.
- A source custom title fills a blank target title but never overwrites a
  non-blank target title.
- A source URL fills a blank target URL but never overwrites a non-blank target
  URL.
- `collected_at` becomes the earliest valid target/source collection date.
- Creator fields derived from a source URL fill blank target fields only.
- The source item ID, source library ID, target asset ID, source SHA-256, and
  raw source metadata are stored in a migration mapping table.

The mapping table has a unique `(source_library_id, source_item_id)` key and a
foreign key to the target asset. Multiple source item IDs may map to one target
asset when source items are byte-identical. This preserves provenance and makes
reruns deterministic without redundant assets.

Execution is resumable. A successful mapped item is verified and skipped on a
rerun. An incomplete item is retried. Per-item failures are recorded and do not
delete successful imports; a nonzero CLI exit status advertises a partial run.

## Book Collection Import

The package migration reuses the existing `info.txt` parser and collection
creation rules. All 545 source collection names must be represented in the
target after execution.

- A case-insensitive existing target name is reported as `existing` and left
  unchanged.
- A missing name is created from `info.txt`.
- Existing collections are never overwritten merely because the source has the
  same name.
- The configured collection source root is set to `C:\lakomics\book` only
  during execution.
- Invalid entries are reported as failures; the confirmed real source must
  finish with all 545 names represented and zero invalid entries.

## Dry Run

`--dry-run` is strictly read-only. It does not open the mutable `Library`, run
schema migrations, create a lock, create a backup, or write a report. It reads
the target SQLite database in read-only mode and prints JSON containing:

- validated source counts and fingerprint;
- image/video/favorite/source-URL/custom-title counts;
- folder create/reuse counts;
- new asset, exact duplicate, source duplicate, and already-mapped counts;
- collection create/existing/error counts;
- estimated bytes that must be copied;
- validation warnings and failures;
- the target baseline.

## Execution Safety and Reporting

`--execute` performs these gates in order:

1. Run the same complete inspection used by dry-run.
2. Recheck that the target path is the inspected target.
3. Open the target library and naturally reject another active process through
   the existing library lease.
4. Apply the mapping-table schema migration if needed.
5. Create and verify a `pre_migration` SQLite backup before importing assets or
   collections.
6. Execute asset and folder migration with progress output.
7. Import or recognize every book collection.
8. Recompute the source fingerprint.
9. Query the target and audit every source-item mapping, represented collection
   name, favorite, metadata field, and folder membership.
10. Write a detailed JSON report below the target `backups` directory.

The report includes the backup ID, before/after target baselines, source
fingerprints, all planned and realized counts, added/duplicate/mapped/retried
asset counts, similarity keep-both count, metadata merge counts, folder
create/reuse counts, collection create/existing counts, preparation-pending
video count, warnings, failures, and final audit results.

The CLI exits `0` only when every source item is mapped to a normal target
asset, every source collection name is represented, the source fingerprint is
unchanged, and no failure remains. It exits `2` for a completed partial report
and `1` for preflight or infrastructure failure.

## Idempotency and Completion Proof

After a successful execution, a second dry run and a second execute audit must
show:

- zero new source items;
- zero new source folders;
- zero new source collection names;
- all 7,420 source item IDs mapped to normal assets;
- all 545 source collection names represented;
- no duplicate target content hashes introduced;
- source fingerprint identical to the first dry run;
- metadata/favorite/folder membership audit with zero mismatches.

Full frontend and Rust test suites, formatting, static checks, and a debug build
must pass before the migration implementation is committed and pushed.

## Rejected Alternatives

### Flatten the package into a temporary directory

This duplicates large media, creates filename collisions, and must reconstruct
folder membership that is already explicit in the manifests. It adds failure
surface without improving safety.

### Use ordinary folder ingestion

This loses package folder IDs, multiple memberships, favorites, source URLs,
custom titles, collection dates, and durable source identity.

### Copy the package into the target library verbatim

The current library has a different managed-file and SQLite model. Direct
copying would produce unreachable files and invalid database references.
