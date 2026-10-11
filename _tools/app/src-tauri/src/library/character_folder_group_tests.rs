use super::*;
use crate::library::{
    character_hub::Series,
    characters::{tests::Fixture, DecisionRequest, TargetDraft},
    models::{ClassificationKind, CreateClassification},
};
use rusqlite::params;

fn fixture() -> Fixture {
    let f = Fixture::new();
    f.library
        .save_character_series(Series {
            classification_id: f.series.clone(),
            hero_asset_id: None,
            auto_classify: true,
        })
        .unwrap();
    // A real character without a linked folder: the source remains a plain folder.
    let target = f
        .library
        .save_character_target(TargetDraft {
            id: None,
            expected_revision: None,
            series_classification_id: Some(f.series.clone()),
            linked_classification_id: None,
            display_name: "주인공".into(),
            description: String::new(),
            thumbnail_asset_id: None,
            enabled: true,
        })
        .unwrap();
    f.library
        .record_character_decisions(DecisionRequest {
            target_id: target.id,
            expected_fingerprint: target.fingerprint,
            asset_ids: vec!["asset-0".into(), "asset-1".into()],
            decision: DecisionKind::Accepted,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    f
}

/// Compare every persisted table, including decisions, queues and authority outboxes.
fn state(f: &Fixture) -> Vec<(String, Vec<String>)> {
    let connection = f.library.connection().unwrap();
    let tables = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).unwrap().query_map([], |row| row.get::<_, String>(0)).unwrap()
        .collect::<std::result::Result<Vec<_>, _>>().unwrap();
    tables
        .into_iter()
        .map(|table| {
            let sql = format!("SELECT * FROM \"{}\"", table.replace('"', "\"\""));
            let mut statement = connection.prepare(&sql).unwrap();
            let columns = statement.column_count();
            let mut rows = statement
                .query_map([], |row| {
                    let values = (0..columns)
                        .map(|index| row.get::<_, rusqlite::types::Value>(index))
                        .collect::<std::result::Result<Vec<_>, _>>()?;
                    Ok(format!("{values:?}"))
                })
                .unwrap()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap();
            rows.sort();
            (table, rows)
        })
        .collect()
}

fn count(f: &Fixture, sql: &str, id: &str) -> i64 {
    f.library
        .connection()
        .unwrap()
        .query_row(sql, [id], |row| row.get(0))
        .unwrap()
}

#[test]
fn character_folder_group_creates_extras_moves_five_and_preserves_characters() {
    let f = fixture();
    let before = state(&f);
    let preview = f.library.character_folder_group_preview(&f.child).unwrap();
    assert_eq!(state(&f), before, "preview must be read-only");
    assert_eq!(preview.series_id.as_deref(), Some(f.series.as_str()));
    assert_eq!(preview.character_asset_count, 2);
    assert_eq!(preview.unassigned_asset_count, 3);
    assert_eq!(preview.other_asset_count, 0);
    assert!(preview.group_id.is_none());
    assert!(preview.refusal.is_none());
    let result = f
        .library
        .tidy_character_folder_into_group(&f.child, &preview.token)
        .unwrap();
    assert_eq!(
        count(
            &f,
            "SELECT COUNT(*) FROM classification_entries WHERE id=?1",
            &f.child
        ),
        0
    );
    assert_eq!(count(&f, "SELECT COUNT(*) FROM asset_classifications WHERE classification_id=?1 AND asset_id IN ('asset-0','asset-1','asset-2','asset-3','asset-4')", &f.series), 5);
    assert_eq!(count(&f, "SELECT COUNT(*) FROM character_relations r JOIN character_targets t ON t.id=r.target_id WHERE t.extras_group_id=?1", &result.group_id), 3);
    assert_eq!(count(&f, "SELECT COUNT(*) FROM character_relations r JOIN character_targets t ON t.id=r.target_id WHERE t.series_classification_id=?1 AND t.role='character'", &f.series), 2);
    assert_eq!(count(&f, "SELECT COUNT(*) FROM character_decisions d JOIN character_targets t ON t.id=d.target_id WHERE t.series_classification_id=?1 AND t.role='character'", &f.series), 2);
    assert_eq!(count(&f, "SELECT COUNT(*) FROM character_targets WHERE extras_group_id=?1 AND role='extras' AND manual_only=1", &result.group_id), 1);
}

#[test]
fn character_folder_group_reuses_exact_trimmed_group_name() {
    let f = fixture();
    let created = f
        .library
        .create_character_extras_group(&f.series, " Character or theme ")
        .unwrap();
    let preview = f.library.character_folder_group_preview(&f.child).unwrap();
    assert_eq!(preview.group_id.as_deref(), Some(created.group.id.as_str()));
    let result = f
        .library
        .tidy_character_folder_into_group(&f.child, &preview.token)
        .unwrap();
    assert_eq!(result.group_id, created.group.id);
    assert_eq!(
        count(
            &f,
            "SELECT COUNT(*) FROM character_groups WHERE series_id=?1",
            &f.series
        ),
        1
    );
}

#[test]
fn character_folder_group_refusals_write_nothing() {
    for case in [
        "children",
        "multiple",
        "series-excluded",
        "folder-excluded",
        "inherited-exclusion",
        "empty",
        "unregistered",
        "registered",
        "linked",
        "originals",
    ] {
        let f = fixture();
        let connection = f.library.connection().unwrap();
        match case {
            "children" => {
                // Through the held connection: a Library call here would wait on it.
                connection
                    .execute(
                        "INSERT INTO classification_entries(id,kind,name,parent_id,created_at)
                         VALUES('child-of-child','tag','하위 폴더',?1,'now')",
                        [&f.child],
                    )
                    .unwrap();
            }
            "multiple" => {
                connection
                    .execute(
                        "INSERT INTO asset_classifications VALUES('asset-2',?1)",
                        [&f.outside],
                    )
                    .unwrap();
            }
            "series-excluded" => {
                connection.execute("INSERT INTO character_series_asset_exclusions(series_id,asset_id,created_at) VALUES(?1,'asset-2','now')", [&f.series]).unwrap();
            }
            "folder-excluded" => {
                connection
                    .execute(
                        "INSERT INTO character_folder_exclusions VALUES(?1)",
                        [&f.child],
                    )
                    .unwrap();
            }
            "inherited-exclusion" => {
                let parent: String = connection
                    .query_row(
                        "SELECT parent_id FROM classification_entries WHERE id=?1",
                        [&f.series],
                        |row| row.get(0),
                    )
                    .unwrap();
                connection
                    .execute(
                        "INSERT INTO character_folder_exclusions VALUES(?1)",
                        [parent],
                    )
                    .unwrap();
            }
            "empty" => {
                connection
                    .execute(
                        "DELETE FROM asset_classifications WHERE classification_id=?1",
                        [&f.child],
                    )
                    .unwrap();
            }
            "unregistered" => {
                connection
                    .execute(
                        "DELETE FROM character_series WHERE classification_id=?1",
                        [&f.series],
                    )
                    .unwrap();
            }
            "registered" => {
                connection
                    .execute(
                        "INSERT INTO character_series(classification_id) VALUES(?1)",
                        [&f.child],
                    )
                    .unwrap();
            }
            "linked" => {
                connection.execute("UPDATE character_targets SET linked_classification_id=?1 WHERE role='character'", [&f.child]).unwrap();
            }
            "originals" => {
                connection.execute("UPDATE classification_entries SET parent_id='lakomics-originals' WHERE id=?1", [&f.series]).unwrap();
            }
            _ => unreachable!(),
        }
        drop(connection);
        let before = state(&f);
        let preview = f.library.character_folder_group_preview(&f.child).unwrap();
        assert!(preview.refusal.is_some(), "{case}");
        assert!(
            f.library
                .tidy_character_folder_into_group(&f.child, &preview.token)
                .is_err(),
            "{case}"
        );
        assert_eq!(state(&f), before, "{case}");
    }
}

#[test]
fn character_folder_group_stale_changes_are_refused_without_writes() {
    for sql in [
        "UPDATE classification_entries SET name='Changed' WHERE id=?1",
        "UPDATE assets SET status='trash' WHERE id='asset-2' AND ?1 IS NOT NULL",
        "DELETE FROM asset_classifications WHERE asset_id='asset-2' AND classification_id=?1",
        "UPDATE character_targets SET revision=revision+1 WHERE role='character' AND ?1 IS NOT NULL",
        "INSERT INTO character_groups(id,series_id,name) SELECT 'new',parent_id,name FROM classification_entries WHERE id=?1",
        "INSERT INTO character_folder_exclusions VALUES(?1)",
    ] {
        let f = fixture();
        let preview = f.library.character_folder_group_preview(&f.child).unwrap();
        f.library.connection().unwrap().execute(sql, [&f.child]).unwrap();
        let before = state(&f);
        assert!(matches!(f.library.tidy_character_folder_into_group(&f.child, &preview.token), Err(Error::Stale)), "{sql}");
        assert_eq!(state(&f), before);
    }
}

#[test]
fn character_folder_group_other_assets_follow_delete_to_immediate_parent() {
    let f = fixture();
    let parent = f
        .library
        .create_classification(CreateClassification {
            kind: ClassificationKind::Tag,
            name: "중간 폴더".into(),
            parent_id: Some(f.series.clone()),
        })
        .unwrap()
        .id;
    let connection = f.library.connection().unwrap();
    connection
        .execute(
            "UPDATE classification_entries SET parent_id=?2 WHERE id=?1",
            params![f.child, parent],
        )
        .unwrap();
    connection
        .execute("UPDATE assets SET status='trash' WHERE id='asset-4'", [])
        .unwrap();
    connection
        .execute(
            "UPDATE assets SET media_kind='video' WHERE id='asset-2'",
            [],
        )
        .unwrap();
    connection
        .execute("UPDATE assets SET media_kind='gif' WHERE id='asset-3'", [])
        .unwrap();
    drop(connection);
    let preview = f.library.character_folder_group_preview(&f.child).unwrap();
    assert_eq!(preview.series_id.as_deref(), Some(f.series.as_str()));
    assert_eq!(preview.other_asset_count, 1);
    assert_eq!(preview.unassigned_asset_count, 2);
    f.library
        .tidy_character_folder_into_group(&f.child, &preview.token)
        .unwrap();
    assert_eq!(count(&f, "SELECT COUNT(*) FROM asset_classifications WHERE asset_id='asset-4' AND classification_id=?1", &parent), 1);
    assert_eq!(
        count(
            &f,
            "SELECT COUNT(*) FROM character_relations WHERE asset_id='asset-4' AND ?1 IS NOT NULL",
            &parent
        ),
        0
    );
}

#[test]
fn character_folder_group_failure_after_moves_rolls_back_the_whole_transaction() {
    let f = fixture();
    f.library
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER refuse_folder_delete BEFORE DELETE ON classification_entries
         BEGIN SELECT RAISE(ABORT,'fixture delete failure'); END;",
        )
        .unwrap();
    let preview = f.library.character_folder_group_preview(&f.child).unwrap();
    let before = state(&f);
    assert!(f
        .library
        .tidy_character_folder_into_group(&f.child, &preview.token)
        .is_err());
    assert_eq!(state(&f), before);
}

#[test]
fn character_folder_group_chunks_more_than_two_hundred_unassigned_assets() {
    let f = fixture();
    let connection = f.library.connection().unwrap();
    for i in 0..401 {
        let id = format!("extra-{i}");
        let hash = Sha256::digest(id.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        connection.execute(
            "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
             VALUES(?1,?2,'image',?1,?1,'thumbnails/' || ?1 || '.webp',7,1,1,'now','normal')", params![id, hash],
        ).unwrap();
        connection
            .execute(
                "INSERT INTO asset_classifications VALUES(?1,?2)",
                params![id, f.child],
            )
            .unwrap();
    }
    drop(connection);
    let preview = f.library.character_folder_group_preview(&f.child).unwrap();
    assert_eq!(preview.unassigned_asset_count, 404);
    let result = f
        .library
        .tidy_character_folder_into_group(&f.child, &preview.token)
        .unwrap();
    assert_eq!(count(&f, "SELECT COUNT(*) FROM character_relations r JOIN character_targets t ON t.id=r.target_id WHERE t.extras_group_id=?1", &result.group_id), 404);
}

#[test]
fn character_folder_group_counts_a_reference_image_as_having_its_character() {
    // A reference is not a relation, but the 기타 guard refuses it like one.
    let f = fixture();
    {
        let c = f.library.connection().unwrap();
        c.execute(
            "INSERT INTO character_references(target_id,slot,asset_id,asset_hash)
             SELECT id,0,'asset-2','reference-hash' FROM character_targets
             WHERE series_classification_id=?1 AND role='character' AND display_name='주인공'",
            [&f.series],
        )
        .unwrap();
    }
    let preview = f.library.character_folder_group_preview(&f.child).unwrap();
    assert_eq!(preview.character_asset_count, 3);
    assert_eq!(preview.unassigned_asset_count, 2);
    assert!(preview.refusal.is_none());
    let result = f
        .library
        .tidy_character_folder_into_group(&f.child, &preview.token)
        .unwrap();
    assert_eq!(count(&f, "SELECT COUNT(*) FROM character_relations r JOIN character_targets t ON t.id=r.target_id WHERE t.extras_group_id=?1", &result.group_id), 2);
}
