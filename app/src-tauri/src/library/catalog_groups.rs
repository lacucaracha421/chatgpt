//! Rebuildable lineage membership; all canonical metadata remains in catalog.
use rusqlite::{params, Connection, OptionalExtension};

use super::{
    catalog_group_identity::reconcile_handles,
    catalog_lineage::{analyze, LineageLink, LineageWork},
    error::LibraryError,
};

const PROVIDER: &str = "kHentai";
const ALGORITHM: &str = "strong-lineage-v1";

pub(super) fn ensure_membership(connection: &Connection) -> Result<String, LibraryError> {
    let source: String = connection.query_row(
        "SELECT COALESCE((SELECT Value FROM catalog.CrawlState WHERE Key='lakomics.catalog.contentRevision'),'legacy')",
        [], |row| row.get(0),
    )?;
    let revision = format!("{ALGORITHM}:{source}");
    let previous: Option<String> = connection
        .query_row(
            "SELECT source_revision FROM online_catalog_group_state WHERE provider=?1",
            [PROVIDER],
            |row| row.get(0),
        )
        .optional()?;
    if previous.as_ref() == Some(&revision) {
        return Ok(revision);
    }
    rebuild(connection, &revision)?;
    Ok(revision)
}

fn rebuild(connection: &Connection, revision: &str) -> Result<(), LibraryError> {
    // Caller owns a short read/write transaction. Catalog reads, publication,
    // COUNT and page share its snapshot; no network work occurs inside it.
    let mut statement = connection.prepare(
        "SELECT Id,Token,ParentGid,ParentKey,FirstGid,FirstKey,CurrentGid,CurrentKey,
                Thumb,Title,FileCount,Category,Uploader FROM catalog.Works ORDER BY Id",
    )?;
    let rows = statement
        .query_map([], |row| {
            let link = |index| -> rusqlite::Result<Option<LineageLink>> {
                let raw = row.get::<_, rusqlite::types::Value>(index)?;
                let key = row
                    .get::<_, Option<String>>(index + 1)
                    .unwrap_or(Some(String::new()));
                if raw == rusqlite::types::Value::Null && key.is_none() {
                    return Ok(None);
                }
                let target = match raw {
                    rusqlite::types::Value::Integer(id) => id,
                    _ => 0,
                };
                Ok(Some(LineageLink { target, key }))
            };
            let thumb: Option<String> = row.get(8)?;
            let title: String = row.get(9)?;
            let pages: i64 = row.get(10)?;
            let category: Option<i64> = row.get(11)?;
            let uploader: Option<String> = row.get(12)?;
            let completeness = i64::from(!title.trim().is_empty())
                + i64::from(pages > 0)
                + i64::from(category.is_some_and(|value| (1..=11).contains(&value)))
                + i64::from(uploader.is_some_and(|value| !value.trim().is_empty()));
            Ok((
                LineageWork {
                    id: row.get(0)?,
                    token: row.get(1)?,
                    parent: link(2)?,
                    first: link(4)?,
                    current: link(6)?,
                },
                super::online_catalog::validated_thumbnail_url(thumb).is_some(),
                completeness,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let works = rows.iter().map(|row| row.0.clone()).collect::<Vec<_>>();
    let plan = analyze(&works);
    let components = plan
        .components
        .iter()
        .map(|group| group.iter().map(i64::to_string).collect())
        .collect::<Vec<_>>();
    let handles = reconcile_handles(connection, PROVIDER, &components)?;
    connection.execute(
        "DELETE FROM online_catalog_group_members WHERE provider=?1",
        [PROVIDER],
    )?;
    connection.execute(
        "DELETE FROM online_catalog_group_diagnostics WHERE provider=?1",
        [PROVIDER],
    )?;
    let mut insert = connection.prepare(
        "INSERT INTO online_catalog_group_members(provider,work_id,catalog_work_id,group_id,thumbnail_valid,completeness,lineage_terminal)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
    )?;
    for (work, thumb, completeness) in rows {
        let work_id = work.id.to_string();
        insert.execute(params![
            PROVIDER,
            work_id,
            work.id,
            handles.member_groups[&work_id],
            thumb,
            completeness,
            plan.terminal_ids.contains(&work.id)
        ])?;
    }
    let mut diagnostic = connection.prepare(
        "INSERT INTO online_catalog_group_diagnostics(provider,work_id,reason) VALUES(?1,?2,?3)",
    )?;
    for item in plan.diagnostics {
        diagnostic.execute(params![PROVIDER, item.work_id.to_string(), item.reason])?;
    }
    connection.execute(
        "INSERT INTO online_catalog_group_state(provider,source_revision,generation,built_at,last_error)
         VALUES(?1,?2,1,?3,NULL) ON CONFLICT(provider) DO UPDATE SET
         source_revision=excluded.source_revision,generation=generation+1,built_at=excluded.built_at,last_error=NULL",
        params![PROVIDER, revision, chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "read-only real catalog materializer/query gate; set LAKOMICS_CATALOG_BENCH_ROOT"]
    fn catalog_groups_real_materializer_and_query_gate() {
        let root = std::path::PathBuf::from(std::env::var("LAKOMICS_CATALOG_BENCH_ROOT").unwrap());
        let connection = Connection::open_in_memory().unwrap();
        for (schema, path) in [
            ("catalog", "catalogs/kdata.db"),
            ("saved", "library.sqlite"),
        ] {
            let mut uri = url::Url::from_file_path(root.join(path)).unwrap();
            uri.set_query(Some("mode=ro"));
            connection
                .execute(&format!("ATTACH ?1 AS {schema}"), [uri.as_str()])
                .unwrap();
        }
        connection
            .execute_batch(include_str!(
                "../../migrations/0035_online_catalog_groups.sql"
            ))
            .unwrap();
        for table in [
            "online_catalog_bookmarks",
            "online_catalog_hidden_categories",
            "online_catalog_blocked_tags",
        ] {
            let sql: String = connection
                .query_row(
                    "SELECT sql FROM saved.sqlite_master WHERE name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            connection.execute_batch(&sql).unwrap();
            connection
                .execute(
                    &format!("INSERT INTO {table} SELECT * FROM saved.{table}"),
                    [],
                )
                .unwrap();
        }
        let tx = connection.unchecked_transaction().unwrap();
        let start = std::time::Instant::now();
        ensure_membership(&tx).unwrap();
        eprintln!("materialize_ms={}", start.elapsed().as_secs_f64() * 1000.0);
        let start = std::time::Instant::now();
        ensure_membership(&tx).unwrap();
        eprintln!("unchanged_ms={}", start.elapsed().as_secs_f64() * 1000.0);
        for reveal in [false, true] {
            for text in ["", "love", "id:4169932", "female:glasses"] {
                let query = super::super::models::CatalogSearchQuery {
                    provider: super::super::catalog_provider::CatalogProvider::KHentai,
                    language: None,
                    reveal_blocked: reveal,
                    text: text.into(),
                    sort: super::super::models::CatalogSort::Latest,
                    scope: super::super::models::CatalogScope::All,
                    page: 0,
                    page_size: 48,
                };
                for run in 0..4 {
                    eprintln!(
                        "{}",
                        serde_json::json!({"query":text,"reveal":reveal,"run":run})
                    );
                    let (rows, total) =
                        super::super::catalog_group_query::select_groups(&tx, &query).unwrap();
                    assert!(total >= rows.len() as u64);
                    assert_eq!(
                        rows.iter()
                            .map(|row| &row.group_id)
                            .collect::<std::collections::BTreeSet<_>>()
                            .len(),
                        rows.len()
                    );
                }
            }
        }
        tx.rollback().unwrap();
    }

    #[test]
    fn catalog_groups_rebuild_only_changed_revision_and_preserve_handles() {
        let root = tempfile::tempdir().unwrap();
        let library = super::super::Library::open(root.path()).unwrap();
        let connection = library.connection().unwrap();
        connection.execute_batch("ATTACH ':memory:' AS catalog;
            CREATE TABLE catalog.CrawlState(Key TEXT PRIMARY KEY,Value TEXT);
            CREATE TABLE catalog.Works(Id INTEGER PRIMARY KEY,Token TEXT,ParentGid INTEGER,ParentKey TEXT,
                FirstGid INTEGER,FirstKey TEXT,CurrentGid INTEGER,CurrentKey TEXT,Thumb TEXT,
                Title TEXT,FileCount INTEGER,Category INTEGER,Uploader TEXT);
            INSERT INTO catalog.Works(Id,Token,Title,FileCount) VALUES(1,'one','title',20),(2,'two','title',20);
            UPDATE catalog.Works SET ParentGid=1,ParentKey='one' WHERE Id=2;").unwrap();
        let tx = connection.unchecked_transaction().unwrap();
        let first = ensure_membership(&tx).unwrap();
        let handle: String = tx
            .query_row(
                "SELECT group_id FROM online_catalog_group_members WHERE catalog_work_id=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ensure_membership(&tx).unwrap(), first);
        assert_eq!(
            tx.query_row(
                "SELECT generation FROM online_catalog_group_state",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        for (index, corrupt) in [
            "FirstKey='orphan'",
            "ParentGid='malformed'",
            "CurrentKey='orphan'",
        ]
        .iter()
        .enumerate()
        {
            tx.execute_batch(&format!("UPDATE catalog.Works SET {corrupt} WHERE Id=2"))
                .unwrap();
            tx.execute("INSERT INTO catalog.CrawlState VALUES('lakomics.catalog.contentRevision',?1) ON CONFLICT(Key) DO UPDATE SET Value=excluded.Value",[format!("bad-{index}")]).unwrap();
            ensure_membership(&tx).unwrap();
            assert_eq!(
                tx.query_row(
                    "SELECT COUNT(DISTINCT group_id) FROM online_catalog_group_members",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                2
            );
            tx.execute_batch("UPDATE catalog.Works SET ParentGid=1,ParentKey='one',FirstKey=NULL,CurrentKey=NULL WHERE Id=2").unwrap();
        }
        tx.execute_batch(
            "UPDATE catalog.Works SET ParentKey='bad'; UPDATE catalog.CrawlState SET Value='next'",
        )
        .unwrap();
        assert_ne!(ensure_membership(&tx).unwrap(), first);
        assert_eq!(
            tx.query_row(
                "SELECT COUNT(DISTINCT group_id) FROM online_catalog_group_members",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            tx.query_row(
                "SELECT group_id FROM online_catalog_group_members WHERE catalog_work_id=1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            handle
        );
        tx.commit().unwrap();
    }
}
