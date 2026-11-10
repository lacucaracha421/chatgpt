//! Rebuildable lineage membership; all canonical metadata remains in catalog.
use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use super::{
    catalog_group_identity::reconcile_handles,
    catalog_lineage::{analyze, LineageLink, LineageWork},
    error::LibraryError,
};

const PROVIDER: &str = "kHentai";
pub(super) const ALGORITHM: &str = "strong-lineage-v1+review-v1";

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

pub(super) fn rebuild(connection: &Connection, revision: &str) -> Result<(), LibraryError> {
    RebuildInput::read(connection)?.publish(connection, revision)
}

pub(super) struct RebuildInput {
    rows: Vec<(LineageWork, bool, i64)>,
    plan: super::catalog_lineage::LineagePlan,
    base: Vec<Vec<String>>,
}

impl RebuildInput {
    pub(super) fn read(connection: &Connection) -> Result<Self, LibraryError> {
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
        let base = plan
            .components
            .iter()
            .map(|group| group.iter().map(i64::to_string).collect())
            .collect();
        Ok(Self { rows, plan, base })
    }

    pub(super) fn publish(
        &self,
        connection: &Connection,
        revision: &str,
    ) -> Result<(), LibraryError> {
        let components = super::catalog_review::apply_decisions(connection, self.base.clone())?;
        let rows = &self.rows;
        let plan = &self.plan;
        let handles = reconcile_handles(connection, PROVIDER, &components)?;
        connection.execute(
            "DELETE FROM online_catalog_group_diagnostics WHERE provider=?1",
            [PROVIDER],
        )?;
        // Write only changed member rows, both in a private workspace and in the
        // synchronous recovery/preparation path.
        type MemberRow = (i64, String, bool, i64, bool);
        let mut existing: HashMap<String, MemberRow> = HashMap::new();
        {
            let mut read = connection.prepare(
            "SELECT work_id,catalog_work_id,group_id,thumbnail_valid,completeness,lineage_terminal
             FROM online_catalog_group_members WHERE provider=?1",
        )?;
            let mut found = read.query([PROVIDER])?;
            while let Some(row) = found.next()? {
                existing.insert(
                    row.get(0)?,
                    (
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ),
                );
            }
        }
        let mut desired: Vec<(String, MemberRow)> = Vec::with_capacity(rows.len());
        for (work, thumb, completeness) in rows {
            let work_id = work.id.to_string();
            let group = handles.member_groups[&work_id].clone();
            let terminal = plan.terminal_ids.contains(&work.id);
            desired.push((work_id, (work.id, group, *thumb, *completeness, terminal)));
        }
        let wanted: std::collections::HashSet<&str> = desired
            .iter()
            .map(|(work_id, _)| work_id.as_str())
            .collect();
        let mut delete = connection
            .prepare("DELETE FROM online_catalog_group_members WHERE provider=?1 AND work_id=?2")?;
        for work_id in existing.keys().filter(|id| !wanted.contains(id.as_str())) {
            delete.execute(params![PROVIDER, work_id])?;
        }
        let mut upsert = connection.prepare(
        "INSERT INTO online_catalog_group_members(provider,work_id,catalog_work_id,group_id,thumbnail_valid,completeness,lineage_terminal)
         VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(provider,work_id) DO UPDATE SET catalog_work_id=excluded.catalog_work_id,
         group_id=excluded.group_id,thumbnail_valid=excluded.thumbnail_valid,
         completeness=excluded.completeness,lineage_terminal=excluded.lineage_terminal",
    )?;
        for (work_id, row) in &desired {
            if existing.get(work_id) == Some(row) {
                continue;
            }
            upsert.execute(params![
                PROVIDER, work_id, row.0, row.1, row.2, row.3, row.4
            ])?;
        }
        let mut diagnostic = connection.prepare(
        "INSERT INTO online_catalog_group_diagnostics(provider,work_id,reason) VALUES(?1,?2,?3)",
    )?;
        for item in &plan.diagnostics {
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
}

// Only these catalog-owned tables participate in a decision publication. Copying
// them into a private SQLite workspace keeps the existing decision/handle rules in
// one place, including their constraints. No unrelated library data is copied.
const DECISION_TABLES: &[(&str, &str)] = &[
    ("online_catalog_group_handles", "sequence"),
    ("online_catalog_group_members", "provider,work_id"),
    ("online_catalog_group_state", "provider"),
    (
        "online_catalog_group_diagnostics",
        "provider,work_id,reason",
    ),
    (
        "online_catalog_review_decisions",
        "left_anchor,right_anchor",
    ),
    ("catalog_duplicate_pairs", "left_work_id,right_work_id"),
];

type SqlRow = Vec<rusqlite::types::Value>;
struct TablePatch {
    delete_sql: String,
    deleted: Vec<SqlRow>,
    upsert_sql: String,
    changed: Vec<SqlRow>,
}

fn sql_rows(c: &Connection, sql: &str) -> Result<Vec<SqlRow>, LibraryError> {
    let mut statement = c.prepare(sql)?;
    let columns = statement.column_count();
    let rows = statement
        .query_map([], |row| {
            (0..columns)
                .map(|i| row.get(i))
                .collect::<rusqlite::Result<SqlRow>>()
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

struct DecisionSnapshot {
    workspace: Connection,
    data_version: i64,
    source_revision: String,
    decision_inputs: Vec<Vec<SqlRow>>,
}

// Handles are append-only; membership/diagnostic changes advance group_state.
// Compare the bounded decision tables in full, including evidence and report
// bookkeeping, so an unrelated library save need not force a locked rebuild.
fn decision_inputs(c: &Connection) -> Result<Vec<Vec<SqlRow>>, LibraryError> {
    [
        "SELECT * FROM online_catalog_review_decisions ORDER BY left_anchor,right_anchor",
        "SELECT * FROM catalog_duplicate_pairs ORDER BY left_work_id,right_work_id",
        "SELECT * FROM online_catalog_group_state ORDER BY provider",
        "SELECT seq FROM sqlite_sequence WHERE name='online_catalog_group_handles'",
    ]
    .into_iter()
    .map(|sql| sql_rows(c, sql))
    .collect()
}

fn source_revision(c: &Connection) -> Result<String, LibraryError> {
    Ok(c.query_row("SELECT COALESCE((SELECT Value FROM catalog.CrawlState WHERE Key='lakomics.catalog.contentRevision'),'legacy')", [], |r| r.get(0))?)
}

impl DecisionSnapshot {
    fn read(root: &std::path::Path) -> Result<Self, LibraryError> {
        let workspace = Connection::open_in_memory()?;
        workspace.pragma_update(None, "temp_store", "MEMORY")?;
        let mut uri = url::Url::from_file_path(root.join("library.sqlite"))
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        uri.set_query(Some("mode=ro"));
        workspace.execute("ATTACH ?1 AS inputs", [uri.as_str()])?;
        workspace.busy_timeout(std::time::Duration::from_secs(5))?;
        super::catalog_preparation::attach_catalog_readonly(&workspace, root)?;
        // Observe before starting the snapshot: a racing commit can only cause a
        // conservative fallback, never make stale inputs look current.
        let data_version = workspace.query_row("PRAGMA inputs.data_version", [], |r| r.get(0))?;
        let tx = workspace.unchecked_transaction()?;
        let source_revision = source_revision(&tx)?;
        for &(table, _) in DECISION_TABLES {
            let schema: String = tx.query_row(
                "SELECT sql FROM inputs.sqlite_master WHERE type='table' AND name=?1",
                [table],
                |r| r.get(0),
            )?;
            tx.execute_batch(&schema)?;
            tx.execute_batch(&format!("INSERT INTO main.{table} SELECT * FROM inputs.{table}; CREATE TEMP TABLE before_{table} AS SELECT * FROM main.{table};"))?;
            let indexes = tx.prepare("SELECT sql FROM inputs.sqlite_master WHERE type='index' AND tbl_name=?1 AND sql IS NOT NULL")?
                .query_map([table], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            for index in indexes {
                tx.execute_batch(&index)?;
            }
        }
        // AUTOINCREMENT identities must also survive a dormant/deleted anchor.
        tx.execute_batch("DELETE FROM main.sqlite_sequence WHERE name='online_catalog_group_handles';
            INSERT INTO main.sqlite_sequence(name,seq) SELECT name,seq FROM inputs.sqlite_sequence WHERE name='online_catalog_group_handles'")?;
        let decision_inputs = decision_inputs(&tx)?;
        tx.commit()?;
        Ok(Self {
            workspace,
            data_version,
            source_revision,
            decision_inputs,
        })
    }

    fn current(&self, writer: &Connection) -> Result<bool, LibraryError> {
        let version: i64 = self
            .workspace
            .query_row("PRAGMA inputs.data_version", [], |r| r.get(0))?;
        Ok(source_revision(writer)? == self.source_revision
            && (version == self.data_version || decision_inputs(writer)? == self.decision_inputs))
    }

    fn changes(&self) -> Result<Vec<TablePatch>, LibraryError> {
        let c = &self.workspace;
        let mut patches = Vec::new();
        for &(table, keys) in DECISION_TABLES {
            let columns = c
                .prepare(&format!("PRAGMA main.table_info({table})"))?
                .query_map([], |r| r.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            let changed = sql_rows(
                c,
                &format!("SELECT * FROM main.{table} EXCEPT SELECT * FROM temp.before_{table}"),
            )?;
            let deleted = sql_rows(
                c,
                &format!(
                    "SELECT {keys} FROM temp.before_{table} EXCEPT SELECT {keys} FROM main.{table}"
                ),
            )?;
            if changed.is_empty() && deleted.is_empty() {
                continue;
            }
            let key_columns = keys.split(',').collect::<Vec<_>>();
            let predicate = key_columns
                .iter()
                .enumerate()
                .map(|(i, key)| format!("{key}=?{}", i + 1))
                .collect::<Vec<_>>()
                .join(" AND ");
            let placeholders = (1..=columns.len())
                .map(|i| format!("?{i}"))
                .collect::<Vec<_>>()
                .join(",");
            let updates = columns
                .iter()
                .filter(|col| !key_columns.contains(&col.as_str()))
                .map(|col| format!("{col}=excluded.{col}"))
                .collect::<Vec<_>>()
                .join(",");
            let conflict = if updates.is_empty() {
                "DO NOTHING".into()
            } else {
                format!("DO UPDATE SET {updates}")
            };
            patches.push(TablePatch {
                delete_sql: format!("DELETE FROM {table} WHERE {predicate}"),
                deleted,
                upsert_sql: format!(
                    "INSERT INTO {table}({}) VALUES({placeholders}) ON CONFLICT({keys}) {conflict}",
                    columns.join(",")
                ),
                changed,
            });
        }
        Ok(patches)
    }
}

/// Compute the complete decision and its membership changes without the global
/// lock. Publish only a delta, atomically with the decision itself. Any library
/// commit triggers revalidation of decisions, pair ownership/reports and membership
/// generation; catalog content has a separate revision fence. Changed inputs use
/// the old transactional path, so stale decisions can never be published.
pub(super) fn write_decision<T>(
    library: &super::Library,
    operation: impl Fn(&Connection) -> Result<T, LibraryError>,
) -> Result<(T, std::time::Duration), LibraryError> {
    let _file_guard = library
        .catalog_file_lock
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let snapshot = DecisionSnapshot::read(library.root())?;
    let result = {
        let tx = snapshot.workspace.unchecked_transaction()?;
        let result = operation(&tx)?;
        tx.commit()?;
        result
    };
    let patches = snapshot.changes()?;
    // connection() takes database_lock and installs the change hooks, so publication
    // lanes and caches see these writes as they did before.
    let mut writer = library.connection()?;
    let held = std::time::Instant::now();
    super::catalog_preparation::attach_catalog_readonly(&writer, library.root())?;
    let tx = writer.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let result = if snapshot.current(&tx)? {
        for patch in patches {
            let mut delete = tx.prepare(&patch.delete_sql)?;
            for row in patch.deleted {
                delete.execute(rusqlite::params_from_iter(row))?;
            }
            let mut upsert = tx.prepare(&patch.upsert_sql)?;
            for row in patch.changed {
                upsert.execute(rusqlite::params_from_iter(row))?;
            }
        }
        result
    } else {
        operation(&tx)?
    };
    tx.commit()?;
    drop(writer);
    Ok((result, held.elapsed()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decision_fixture() -> (tempfile::TempDir, super::super::Library) {
        let root = tempfile::tempdir().unwrap();
        let library = super::super::Library::open(root.path()).unwrap();
        std::fs::create_dir(root.path().join("catalogs")).unwrap();
        let catalog = Connection::open(root.path().join("catalogs/kdata.db")).unwrap();
        catalog.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE CrawlState(Key TEXT PRIMARY KEY,Value TEXT);
            INSERT INTO CrawlState VALUES('lakomics.catalog.contentRevision','fixture');
            CREATE TABLE Works(Id INTEGER PRIMARY KEY,Token TEXT,ParentGid INTEGER,ParentKey TEXT,
                FirstGid INTEGER,FirstKey TEXT,CurrentGid INTEGER,CurrentKey TEXT,Thumb TEXT,
                Title TEXT,FileCount INTEGER,Category INTEGER,Uploader TEXT);
            INSERT INTO Works(Id,Token,Title,FileCount) VALUES(1,'one','title',20),(2,'two','title',20),(3,'three','title',20);").unwrap();
        let c = library.connection().unwrap();
        super::super::catalog_preparation::attach_catalog_readonly(&c, root.path()).unwrap();
        ensure_membership(&c).unwrap();
        drop(c);
        (root, library)
    }

    fn confirm(c: &Connection, a: &str, b: &str) -> Result<(), LibraryError> {
        c.execute(
            "INSERT INTO online_catalog_review_decisions VALUES(?1,?2,'confirm','{}','fixture')",
            params![a, b],
        )?;
        let revision = ensure_membership(c)?;
        rebuild(c, &revision)
    }

    #[test]
    fn catalog_groups_decision_computes_unlocked_and_publishes_atomically() {
        let (_root, library) = decision_fixture();
        let calls = std::cell::Cell::new(0);
        write_decision(&library, |c| {
            calls.set(calls.get() + 1);
            assert!(library.database_lock.try_lock().is_ok());
            confirm(c, "1", "2")?;
            let visible = Connection::open(library.root().join("library.sqlite"))?;
            assert_eq!(
                visible.query_row(
                    "SELECT COUNT(*) FROM online_catalog_review_decisions",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            let writer = library.connection()?;
            super::super::catalog_group_identity::set_preference(&writer, PROVIDER, "3", None)?;
            Ok(())
        })
        .unwrap();
        assert_eq!(calls.get(), 1);
        let c = library.connection().unwrap();
        assert_eq!(
            c.query_row(
                "SELECT COUNT(DISTINCT group_id) FROM online_catalog_group_members",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM online_catalog_review_decisions",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn catalog_groups_racing_decision_recomputes_instead_of_publishing_stale_membership() {
        let (_root, library) = decision_fixture();
        let calls = std::cell::Cell::new(0);
        write_decision(&library, |c| {
            calls.set(calls.get()+1);
            confirm(c, "1", "2")?;
            if calls.get() == 1 {
                let writer = library.connection()?;
                writer.execute("INSERT INTO online_catalog_review_decisions VALUES('2','3','confirm','{}','concurrent')", [])?;
            }
            Ok(())
        }).unwrap();
        assert_eq!(calls.get(), 2);
        let c = library.connection().unwrap();
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM online_catalog_review_decisions",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(DISTINCT group_id) FROM online_catalog_group_members",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn catalog_groups_changed_catalog_recomputes_before_publication() {
        let (_root, library) = decision_fixture();
        let calls = std::cell::Cell::new(0);
        write_decision(&library, |c| {
            calls.set(calls.get() + 1);
            confirm(c, "1", "2")?;
            if calls.get() == 1 {
                let catalog = Connection::open(library.root().join("catalogs/kdata.db"))?;
                catalog.execute_batch(
                    "BEGIN; UPDATE Works SET FileCount=0 WHERE Id=1;
                    UPDATE CrawlState SET Value='new-content'; COMMIT;",
                )?;
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(calls.get(), 2);
        let c = library.connection().unwrap();
        assert_eq!(
            c.query_row(
                "SELECT completeness FROM online_catalog_group_members WHERE work_id='1'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            c.query_row(
                "SELECT source_revision FROM online_catalog_group_state",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            format!("{ALGORITHM}:new-content")
        );
    }

    #[test]
    fn catalog_groups_failed_decision_leaves_no_partial_publication() {
        let (_root, library) = decision_fixture();
        let result = write_decision(&library, |c| {
            confirm(c, "1", "2")?;
            Err::<(), _>(LibraryError::InvalidOnlineCatalog)
        });
        assert!(matches!(result, Err(LibraryError::InvalidOnlineCatalog)));
        let c = library.connection().unwrap();
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM online_catalog_review_decisions",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(DISTINCT group_id) FROM online_catalog_group_members",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            3
        );
    }

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
        connection
            .execute_batch(include_str!("../../migrations/0037_catalog_review.sql"))
            .unwrap();
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
