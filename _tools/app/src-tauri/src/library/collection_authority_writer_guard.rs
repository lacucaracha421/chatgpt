//! File-level transition inventory. Each legacy exemption has an owning batch.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

const ALLOWLIST: &[(&str, &str)] = &[
    (
        "library/collection_authority.rs",
        "batch 1: confirmed replica/outbox apply",
    ),
    (
        "library/db.rs",
        "local-only (stays): schema migrations (collection data rewrites predate the authority) and migration fixtures",
    ),
    ("library/statistics.rs", "local-only (stays): activity"),
    (
        "library/av_link/mod.rs",
        "local-only (stays): AV inbox and candidates",
    ),
    (
        "library/backup.rs",
        "local-only (stays): snapshot scrubbing",
    ),
    (
        "library/release_wishlist.rs",
        "local-only (stays): separate wishlist",
    ),
    // Fixture SQL is scanned too. Test files are explicit exemptions, never a
    // global `_tests.rs` escape hatch that could hide a future production writer.
    (
        "library/collection_authority_tests.rs",
        "local-only (stays): authority fixtures",
    ),
    (
        "library/collection_authority_writer_guard.rs",
        "local-only (stays): scanner fixtures",
    ),
    (
        "library/restore_guard.rs",
        "local-only (stays): marker fixture; the guard itself only reads",
    ),
    (
        "cloud/collection_baseline_tests.rs",
        "local-only (stays): baseline fixtures",
    ),
    (
        "cloud/auto_publication.rs",
        "local-only (stays): embedded replay fixtures",
    ),
    (
        "cloud/collections.rs",
        "local-only (stays): embedded publication fixtures",
    ),
    (
        "cloud/collections_av_tests.rs",
        "local-only (stays): AV publication fixtures",
    ),
    (
        "cloud/collections_change_tests.rs",
        "local-only (stays): publication fixtures",
    ),
    (
        "cloud/collections_features_tests.rs",
        "local-only (stays): feature publication fixtures",
    ),
    (
        "cloud/collections_launchbox_tests.rs",
        "local-only (stays): spine publication fixtures",
    ),
    (
        "cloud/hold_tests.rs",
        "local-only (stays): receive-only fixtures",
    ),
    (
        "commands/home.rs",
        "local-only (stays): embedded home fixtures",
    ),
    (
        "commands/home_media.rs",
        "local-only (stays): embedded media fixtures",
    ),
    (
        "library/av_collection_tests.rs",
        "local-only (stays): AV fixtures",
    ),
    (
        "library/av_link/tests.rs",
        "local-only (stays): AV link fixtures",
    ),
    (
        "library/av_portrait_tests.rs",
        "local-only (stays): portrait fixtures",
    ),
    (
        "library/av_stashdb_tests.rs",
        "local-only (stays): profile fixtures",
    ),
    (
        "library/collection_binding_sync_tests.rs",
        "local-only (stays): binding fixtures",
    ),
    (
        "library/collection_release_sync_tests.rs",
        "local-only (stays): release fixtures",
    ),
    (
        "library/collection_updates/tests.rs",
        "local-only (stays): worker fixtures",
    ),
    (
        "library/home_publications_tests.rs",
        "local-only (stays): home fixtures",
    ),
    (
        "library/launchbox_tests.rs",
        "local-only (stays): LaunchBox fixtures",
    ),
    (
        "media_protocol.rs",
        "local-only (stays): embedded media protocol fixtures",
    ),
];

// These files no longer have blanket writer exemptions. Only the named remaining
// legacy functions and their existing embedded fixtures are exempt; a new writer
// elsewhere in either file must fail the ordinary SQL scan.
const REMAINING_FUNCTIONS: &[(&str, &str, &str)] = &[
    (
        "library/book_migration.rs",
        "backfill_legacy_collection_kinds",
        "local-only (stays): legacy startup backfill, skipped while the authority is active",
    ),
    (
        "library/collection_updates.rs",
        "run_collection_updates_with_cover_downloader",
        "local-only (stays): worker cooldown/status",
    ),
    (
        "library/collection.rs",
        "normalize_showcase_orders",
        "local-only (stays): legacy startup normalization, skipped while the authority is active",
    ),
    (
        "library/collection_pc.rs",
        "write_record_status",
        "batch 2: guarded core-record optimistic helper; inbound replay fenced",
    ),
    (
        "library/collection_pc.rs",
        "write_record_platform",
        "batch 2: guarded core-record optimistic helper; inbound replay fenced",
    ),
];
const ROUTED_FUNCTIONS: &[(&str, &str)] = &[
    ("library/collection.rs", "connect_fetched_igdb_game"),
    ("library/tmdb_flow.rs", "apply_fetched_tmdb_title"),
    ("library/tmdb_flow.rs", "refresh_fetched_tmdb_title"),
    ("library/tmdb_flow.rs", "replace_fetched_tmdb_movie_artwork"),
    ("library/igdb_flow.rs", "apply_fetched_igdb_game"),
    ("library/igdb_flow.rs", "refresh_fetched_igdb_game"),
    ("library/igdb_flow.rs", "replace_fetched_igdb_game_artwork"),
    ("library/collection_tracking.rs", "set_owned_volume_count"),
    ("library/collection_tracking.rs", "set_volume_ownership"),
    (
        "library/collection_tracking.rs",
        "acknowledge_release_events",
    ),
    ("library/release_watch.rs", "set_release_watch_enabled"),
    ("library/release_watch.rs", "take_unread_release_changes"),
    ("library/mangadex_flow.rs", "apply_fetched_mangadex_checked"),
    ("library/mangadex_flow.rs", "refresh_fetched_mangadex"),
    ("library/aladin_flow.rs", "reconcile_aladin_at"),
    (
        "library/external_binding.rs",
        "upsert_collection_external_binding",
    ),
    (
        "library/collection_updates.rs",
        "reconcile_mangadex_volumes",
    ),
    ("library/similarity.rs", "resolve_replace_existing"),
    ("library/collection.rs", "create_collection"),
    ("library/collection.rs", "update_collection"),
    ("library/collection.rs", "delete_collection"),
    ("library/collection.rs", "set_collection_cover"),
    ("library/collection.rs", "set_collection_showcase"),
    ("library/collection.rs", "set_collection_showcase_order"),
    ("library/collection.rs", "patch_asset_collections"),
    ("library/collection_pc.rs", "save_collection_work_record"),
    (
        "library/work_artwork.rs",
        "insert_work_artwork_in_transaction",
    ),
    (
        "library/work_artwork.rs",
        "select_work_artwork_kind_in_transaction",
    ),
    (
        "library/work_artwork.rs",
        "clear_work_artwork_kind_in_transaction",
    ),
    (
        "library/work_artwork.rs",
        "insert_volume_work_artwork_in_transaction",
    ),
    ("library/collection_source.rs", "import_local_artwork_files"),
    (
        "library/collection_volume.rs",
        "materialize_mangadex_volumes",
    ),
    ("library/collection_volume.rs", "set_local_volume"),
    ("library/collection_volume.rs", "attach_volume_artwork"),
    (
        "library/collection_volume.rs",
        "sync_mangadex_volume_covers_with",
    ),
    (
        "library/collection_volume_range.rs",
        "set_collection_volume_range",
    ),
    ("library/aladin_flow.rs", "reconcile_source"),
    ("library/av_artwork.rs", "apply_av_artwork"),
];

const FENCED_FUNCTIONS: &[(&str, &str)] = &[
    ("library/mangadex_flow.rs", "refresh_provider_fields"),
    ("library/external_binding.rs", "upsert_external_binding"),
    ("library/collection_tracking.rs", "write_owned_volume_count"),
    (
        "library/collection_tracking.rs",
        "acknowledge_release_events_in",
    ),
    ("library/release_watch.rs", "write_release_watch"),
    ("library/collection_personal_edits.rs", "write_field"),
    ("library/book_migration.rs", "upsert_collection"),
    (
        "library/legacy_package_migration.rs",
        "execute_legacy_package_migration",
    ),
    ("library/tmdb_flow.rs", "insert_season_artwork"),
    ("library/tmdb_flow.rs", "apply_artwork_decision"),
    ("library/tmdb_flow.rs", "update_provider_metadata"),
    ("library/igdb_flow.rs", "apply_artwork_decision"),
    ("library/igdb_flow.rs", "demote_unselected_screenshots"),
    ("library/launchbox.rs", "store_spine"),
    ("library/launchbox.rs", "fill_launchbox_platforms"),
    ("library/collection_pc.rs", "store_cover_focus"),
    // Batch 5: AV details, people, portraits, profiles and favorites have no
    // authority command yet. AV inbox/candidates/name cache/poll state stay local.
    ("library/av_collection.rs", "save_av_details"),
    ("library/av_link/apply.rs", "apply_people"),
    ("library/av_link/apply.rs", "apply_av_link"),
    ("library/av_detail.rs", "save_av_person_memo"),
    ("library/av_portrait.rs", "set_av_portrait_crop"),
    ("library/av_portrait.rs", "clear_av_portrait"),
    ("library/av_portrait.rs", "use_av_commons_portrait"),
    ("library/av_portrait.rs", "use_av_stashdb_portrait"),
    ("library/av_stashdb.rs", "save"),
    ("library/av_stashdb.rs", "clear_av_performer_profile"),
    ("library/home_data.rs", "set_av_favorite"),
];

// Functions in these two files use a standalone closing brace at their declaration
// indentation. Bound exemptions to that brace, never to the next function or EOF.
fn function_range(source: &str, name: &str) -> std::ops::Range<usize> {
    let declaration = regex::Regex::new(&format!(
        r"(?m)^(    )?(?:pub(?:\([^)]*\))? )?fn {}(?:<[^>]+>)?\(",
        regex::escape(name)
    ))
    .unwrap();
    let matched = declaration
        .captures(source)
        .unwrap_or_else(|| panic!("missing writer {name}"));
    let start = matched.get(0).unwrap().start();
    let indent = matched.get(1).map_or("", |m| m.as_str());
    let closing = format!("\n{indent}}}");
    let end = source[start..].find(&closing).unwrap() + start + closing.len();
    start..end
}

fn remaining_source(file: &str, source: &str) -> String {
    if ![
        "library/collection_binding_sync.rs",
        "library/collection_release_sync.rs",
    ]
    .contains(&file)
        && !ROUTED_FUNCTIONS
            .iter()
            .chain(FENCED_FUNCTIONS)
            .any(|(f, _)| *f == file)
    {
        return source.to_owned();
    }
    let mut remaining = source.to_owned();
    let mut ranges = Vec::new();
    for (f, name) in ROUTED_FUNCTIONS.iter().filter(|(f, _)| *f == file) {
        let range = function_range(source, name);
        let body = &source[range.clone()];
        assert!(
            body.contains("collection_write_status("),
            "{f}::{name} lost adoption fence"
        );
        assert!(
            body.contains("queue_provider_operation(")
                || body.contains("queue_tmdb_metadata(")
                || body.contains("enqueue_work_changes(")
                || body.contains("enqueue_collection_command(")
                || body.contains("enqueue_artwork(")
                || body.contains("enqueue_artwork_selection(")
                || body.contains("enqueue_volume_changes(")
                || body.contains("import_authority_artwork_files(")
                || body.contains("enqueue_provider_snapshot(")
                || body.contains("enqueue_release_event(")
                || body.contains("enqueue_release_ack("),
            "{f}::{name} lost transactional outbox"
        );
        ranges.push(range);
    }
    for (_, name) in FENCED_FUNCTIONS.iter().filter(|(f, _)| *f == file) {
        let range = function_range(source, name);
        assert!(
            source[range.clone()].contains("fence_collection_operation("),
            "{file}::{name} lost activation fence"
        );
        ranges.push(range);
    }
    for (_, name, reason) in REMAINING_FUNCTIONS.iter().filter(|(f, _, _)| *f == file) {
        assert!(reason.starts_with("batch ") || reason.starts_with("local-only (stays)"));
        ranges.push(function_range(source, name));
    }
    // Explicit local-only embedded fixtures in the two formerly exempt files.
    for marker in [
        "#[cfg(test)]\nmod tests {",
        "#[cfg(test)]\r\nmod tests {",
        "#[cfg(test)]\npub(crate) mod tests {",
        "#[cfg(test)]\r\npub(crate) mod tests {",
    ] {
        if let Some(start) = source.find(marker) {
            let end = source[start..].find("\n}").unwrap() + start + 2;
            ranges.push(start..end);
        }
    }
    ranges.sort_by_key(|r| std::cmp::Reverse(r.start));
    for range in ranges {
        remaining.replace_range(range, "");
    }
    remaining
}

fn walk(path: &Path, files: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(path).unwrap() {
        let p = entry.unwrap().path();
        if p.is_dir() {
            walk(&p, files);
        } else if p.extension().is_some_and(|s| s == "rs") {
            files.push(p);
        }
    }
}

// Extract ordinary/raw Rust strings, excluding comments. Joining adjacent SQL
// fragments catches queries split across literals; raw SQL identifiers remain.
fn strings(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut i = 0;
    let mut output = String::new();
    while i < bytes.len() {
        // A quote character such as b'"' is not the start of a Rust string.
        if bytes[i] == b'\'' {
            if i + 2 < bytes.len() && bytes[i + 2] == b'\'' {
                i += 3;
                continue;
            }
            if i + 3 < bytes.len() && bytes[i + 1] == b'\\' && bytes[i + 3] == b'\'' {
                i += 4;
                continue;
            }
        }
        if bytes[i..].starts_with(b"//") {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if bytes[i..].starts_with(b"/*") {
            i += 2;
            let mut depth = 1;
            while i < bytes.len() && depth > 0 {
                if bytes[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if bytes[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if bytes[i] == b'r' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] == b'#' {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'"' {
                let hashes = j - i - 1;
                let end = format!("\"{}", "#".repeat(hashes));
                let start = j + 1;
                if let Some(n) = source[start..].find(&end) {
                    output.push_str(&source[start..start + n]);
                    output.push(' ');
                    i = start + n + end.len();
                    continue;
                }
            }
        }
        if bytes[i] == b'"' {
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'"' {
                    i += 1;
                    break;
                }
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 1;
                    match bytes[i] {
                        b'n' | b'r' | b't' => output.push(' '),
                        b'\n' => {}
                        c => output.push(c as char),
                    };
                    i += 1;
                } else {
                    let c = source[i..].chars().next().unwrap();
                    output.push(c);
                    i += c.len_utf8();
                }
            }
            output.push(' ');
            continue;
        }
        i += 1;
    }
    output
}
fn writers(source: &str, tables: &BTreeSet<String>) -> BTreeSet<String> {
    let sql = strings(source);
    let re=regex::Regex::new(r#"(?i)\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:main\.)?[`"\[]?([a-z_][a-z_0-9]*)"#).unwrap();
    re.captures_iter(&sql)
        .map(|c| c[1].to_ascii_lowercase())
        .filter(|t| tables.contains(t))
        .collect()
}

#[test]
fn collection_authority_writer_guard_scans_schema_tables_and_requires_annotated_allowlist() {
    let (_temp, l, _) = fixture();
    let db = l.connection().unwrap();
    // Derive from the actual migrated schema, including worker/local Collection
    // tables and AV relations; no SQL migration is itself scanned as a writer.
    let mut tables:BTreeSet<String>=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name='collections' OR name LIKE 'collection_%' OR name IN ('external_bindings','work_artworks','release_watch_subscriptions','release_watch_events','av_favorite_performers'))").unwrap().query_map([],|r|r.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
    tables.insert("external_bindings".into());
    tables.insert("work_artworks".into());
    drop(db);
    let allow: BTreeMap<_, _> = ALLOWLIST.iter().copied().collect();
    assert_eq!(allow.len(), ALLOWLIST.len());
    for reason in allow.values() {
        assert!(reason.starts_with("batch ") || reason.starts_with("local-only (stays)"));
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    walk(&root, &mut files);
    let mut unexpected = Vec::new();
    for file in files {
        let relative = file
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let source = std::fs::read_to_string(&file).unwrap();
        let found = writers(&remaining_source(&relative, &source), &tables);
        if !found.is_empty() && !allow.contains_key(relative.as_str()) {
            unexpected.push(format!(
                "{relative}: {}",
                found.into_iter().collect::<Vec<_>>().join(", ")
            ));
        }
    }
    assert!(
        unexpected.is_empty(),
        "Collection writers need explicit batch/local-only annotations:\n{}",
        unexpected.join("\n")
    );
}

#[test]
fn collection_authority_writer_guard_covers_sql_forms_split_literals_and_ignores_comments() {
    let tables = ["collections", "collection_assets", "collection_people"]
        .map(String::from)
        .into_iter()
        .collect();
    for sql in [
        r#""INSERT OR IGNORE INTO collections VALUES(?)""#,
        r###"r#"REPLACE INTO collection_assets VALUES(?)"#"###,
        r#""UPDATE\ncollection_people SET display_name=?""#,
        r#""DELETE FROM " "collections WHERE id=?""#,
        r#""UPDATE main.\"collections\" SET name=?""#,
    ] {
        assert_eq!(writers(sql, &tables).len(), 1, "{sql}");
    }
    assert!(writers(
        "// INSERT INTO collections\n/* UPDATE collections */ \"SELECT * FROM collections\"",
        &tables
    )
    .is_empty());
}

#[test]
fn collection_authority_writer_guard_rejects_new_writers_in_routed_files() {
    let tables = ["collections".to_owned()].into_iter().collect();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for file in [
        "library/collection.rs",
        "library/collection_pc.rs",
        "library/work_artwork.rs",
        "library/collection_source.rs",
        "library/collection_volume.rs",
        "library/collection_volume_range.rs",
        "library/launchbox.rs",
        "library/mangadex_flow.rs",
        "library/tmdb_flow.rs",
        "library/igdb_flow.rs",
        "library/aladin_flow.rs",
        "library/external_binding.rs",
        "library/collection_tracking.rs",
        "library/release_watch.rs",
        "library/collection_updates.rs",
        "library/collection_personal_edits.rs",
        "library/collection_binding_sync.rs",
        "library/collection_release_sync.rs",
        "library/book_migration.rs",
        "library/legacy_package_migration.rs",
        "library/av_collection.rs",
        "library/av_artwork.rs",
        "library/av_link/apply.rs",
        "library/av_detail.rs",
        "library/av_portrait.rs",
        "library/av_stashdb.rs",
        "library/home_data.rs",
    ] {
        let mut source = std::fs::read_to_string(root.join(file)).unwrap();
        source.push_str("\nfn unreviewed_writer() { db.execute(\"UPDATE collections SET name='lost'\", []); }\n");
        assert_eq!(writers(&remaining_source(file, &source), &tables).len(), 1);
    }
}
