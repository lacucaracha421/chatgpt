//! File-level transition inventory. Each legacy exemption has an owning batch.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

const ALLOWLIST: &[(&str, &str)] = &[
    (
        "library/collection_authority.rs",
        "batch 1: confirmed replica/outbox apply",
    ),
    (
        "library/collection.rs",
        "batch 2: CRUD, cover, showcase, membership; batch 6: startup normalization",
    ),
    (
        "library/collection_pc.rs",
        "batch 2: records; batch 3: focus fence",
    ),
    (
        "library/collection_source.rs",
        "batch 3: source artwork; local-only (stays): source paths",
    ),
    (
        "library/work_artwork.rs",
        "batch 3: artwork; local-only (stays): thumbnails",
    ),
    (
        "library/collection_volume.rs",
        "batch 3: volumes and local import",
    ),
    (
        "library/collection_volume_range.rs",
        "batch 3: volume ranges",
    ),
    (
        "library/collection_tracking.rs",
        "batch 4: ownership/tracking/acknowledgement",
    ),
    (
        "library/release_watch.rs",
        "batch 4: subscriptions and release events",
    ),
    ("library/mangadex_flow.rs", "batch 4: provider merge"),
    ("library/tmdb_flow.rs", "batch 4: provider fence"),
    ("library/igdb_flow.rs", "batch 4: provider fence"),
    (
        "library/aladin_flow.rs",
        "batch 4: book providers and releases",
    ),
    (
        "library/external_binding.rs",
        "batch 4: shared binding helper",
    ),
    (
        "library/collection_updates.rs",
        "batch 4: provider workers; local-only (stays): checkpoints",
    ),
    (
        "library/collection_personal_edits.rs",
        "batch 4: inbound personal replay",
    ),
    (
        "library/collection_binding_sync.rs",
        "batch 4: inbound binding replay",
    ),
    (
        "library/collection_release_sync.rs",
        "batch 4: inbound acknowledgements",
    ),
    (
        "library/launchbox.rs",
        "batch 3: artwork; batch 4: provider fence",
    ),
    (
        "library/av_collection.rs",
        "batch 5: AV details and credits",
    ),
    ("library/av_artwork.rs", "batch 5: AV artwork fence"),
    ("library/av_link/apply.rs", "batch 5: AV link apply fence"),
    ("library/av_detail.rs", "batch 5: people memo fence"),
    ("library/av_portrait.rs", "batch 5: portrait fence"),
    ("library/av_stashdb.rs", "batch 5: profile fence"),
    ("library/home_data.rs", "batch 5: favorites"),
    (
        "library/book_migration.rs",
        "batch 4: import fence; batch 6: startup migration",
    ),
    (
        "library/legacy_package_migration.rs",
        "batch 4: import fence",
    ),
    ("library/mod.rs", "batch 6: startup normalization"),
    (
        "library/db.rs",
        "batch 6: schema upgrades; local-only (stays): migration fixtures",
    ),
    ("library/similarity.rs", "batch 6: membership replacement"),
    (
        "library/asset_authority.rs",
        "batch 6: cross-domain cascades",
    ),
    ("library/trash.rs", "batch 6: asset cascades"),
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
        let found = writers(&std::fs::read_to_string(&file).unwrap(), &tables);
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
