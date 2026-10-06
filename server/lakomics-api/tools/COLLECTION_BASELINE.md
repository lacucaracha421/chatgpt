# Offline Collections baseline dry run

These tools do not contact a server, start the desktop application, load tokens,
activate authority, or upload blobs. Run them on an explicitly authorized library
copy or a disposable fixture. Close the application that owns the input before
exporting. A nonempty `library.sqlite-wal` is refused; the tool never checkpoints
or opens the source database through SQLite.

## Windows export (PowerShell)

Replace the fixture path and endpoint with the intended input and its configured
endpoint. The endpoint is used only to select local sync cursors; it receives no
requests. `--snapshot-dir` must not exist, its parent must exist, and it must be
outside the input library. Each run requires a new directory. Use the latest known
publication revision if available; a placeholder is enough for structural checks.

```powershell
Set-Location V:\chatgpt\_tools\app\src-tauri
$env:CARGO_BUILD_JOBS = '2'
cargo run --bin collection_baseline_export -- --library V:\fixtures\collection-library --snapshot-dir V:\scratch\collection-baseline-001 --endpoint https://fixture.test --revision 0000000000000000000000000000000000000000000000000000000000000000
```

The tool copies only `library.sqlite`, opens the copy read-only, and calls the same
snapshot and `cloud/collection_baseline.rs` conversion used by the PC verify route.
It returns `baseline.json` (the exact staged-body shape) and `legacy.json` (the
ordinary replica body from that same transaction). It checks database hashes and
WAL size before/after extraction. It does not instantiate `Library::open`, run
migrations, receive edits, bind requests or release reads, or publish the legacy
replica. The input must already have the current schema.

Image files are read from the input library, not copied wholesale. Existing source
preview thumbnails are reused; missing ones are generated inside the snapshot
directory with the same thumbnail generator. Offline extraction hashes images
without writing persistent descriptors into the source. Portrait manifests are
computed from the copied DB. Blob manifests are retained, but uploads/confirmations
are skipped. Close the app and keep image files stable while exporting: DB hash
checks do not freeze every image in the library.

All currently supported replica features are enabled (AV, work records, cover
focus, people, portrait images), matching the current server. An existing endpoint
personal-edit adoption row enables version-3 tracking in the snapshot; absent
adoption retains the normal no-handshake export behavior. No remote feature
negotiation or draining takes place, so export is equivalent to the PC's export
at the copied state, not to the preceding online synchronization steps.

## WSL validation and comparison

Use the existing API virtual environment; no installation is needed.

```powershell
wsl -d Ubuntu-26.04 -- bash -lc 'cd /mnt/v/chatgpt/server/lakomics-api && ~/venvs/lakomics-api/bin/python tools/collection_baseline_dry_run.py /mnt/v/scratch/collection-baseline-001/baseline.json'
```

Default mode creates an empty in-memory server database. It runs the real parser
per row, reports every malformed row it finds, then collects independent
relationship rejections using `validate_staging`. Problems are grouped by kind,
with counts and up to five sample IDs/indices. One parser rejection per malformed
row is reported; fix those and rerun to expose additional bad fields within that
row. Dependent checks on rejected rows can report missing references. The final
`verification` calls the actual `verify_staging` function on the original body,
including its projection/comparison and TEMP-table write guard.

An empty server normally yields `blocked`: it has no publication revision, drain
barriers, Asset rows or upload receipts. Its unknown works and unconfirmed blobs
are expected environmental gaps, not proof the exporter lost data.

For useful offline list/detail/people comparison against the companion replica:

```powershell
wsl -d Ubuntu-26.04 -- bash -lc 'cd /mnt/v/chatgpt/server/lakomics-api && ~/venvs/lakomics-api/bin/python tools/collection_baseline_dry_run.py /mnt/v/scratch/collection-baseline-001/baseline.json --simulate-publication /mnt/v/scratch/collection-baseline-001/legacy.json'
```

This explicitly seeds only the disposable in-memory DB with the companion legacy
replica. It assumes matching cursors/revision, no pending binding requests,
confirmed blob manifests and visible referenced Assets. The mode is labeled
`simulatedPublication`. A `lossless` verdict therefore establishes local projection
parity under those assumptions, not production readiness or permission to deploy
or activate. Exit status is 0 only for zero diagnostic problems and `lossless`;
otherwise it is 1. No real server database is accepted as an argument.

## Memberships

The baseline reads `collection_assets` for every exported work, independently of
artwork/volume rows. WorkArtwork and Volume are not Assets and do not imply
Collection-to-Asset membership. The export regression fixture includes one
membership and checks that it survives. A reported count of zero can be correct
when no eligible work has rows in `collection_assets`; gacha/unsupported works
are excluded by the ordinary replica rules. This task did not inspect the real
library, so the production zero cannot be confirmed from these tests alone.

## Tests

```powershell
wsl -d Ubuntu-26.04 -- bash -lc 'cd /mnt/v/chatgpt/server/lakomics-api && ~/venvs/lakomics-api/bin/python -m unittest discover -s tests'
```

Rust checks, from `_tools/app/src-tauri` with `CARGO_BUILD_JOBS=2` (one filter per
call): `cargo check --lib`, `cargo check --bin collection_baseline_export`,
`cargo test --lib collection_baseline`, `cargo test --lib collection_authority`,
and `cargo test --lib launchbox`. The export core test verifies Steam, memberships,
unchanged source database bytes, redirected caches, parity with ordinary export,
and WAL/destination refusal.
