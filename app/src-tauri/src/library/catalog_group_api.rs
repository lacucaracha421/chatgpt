//! Grouped navigation streams a usable page before its exact count.
use super::{
    catalog_counts::{self, CountContext},
    catalog_group_identity,
    catalog_group_query::{self, GroupQueryPlan},
    catalog_provider::CatalogProvider,
    catalog_visibility::append_visibility_predicates,
    error::LibraryError,
    models::*,
    online_catalog::load_catalog_works,
    Library,
};
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use std::time::{Duration, Instant};

const PREPARATION_WAIT: Duration = Duration::from_secs(30);
fn provider_supported(provider: CatalogProvider) -> Result<(), LibraryError> {
    if provider != CatalogProvider::KHentai {
        return Err(LibraryError::UnsupportedCatalogProvider);
    }
    Ok(())
}

fn same_count_context(original: &CountContext, current: &CountContext, reveal: bool) -> bool {
    original.source_revision == current.source_revision
        && original.generation == current.generation
        && (reveal || original.policy_identity == current.policy_identity)
}

fn count_event(result: Result<Option<u64>, LibraryError>) -> CatalogGroupedSearchEvent {
    match result {
        Ok(Some(total_count)) => CatalogGroupedSearchEvent::Count { total_count },
        Ok(None) => CatalogGroupedSearchEvent::CountError {
            message: "정확한 그룹 수가 아직 준비되지 않았습니다. 다시 조회해 주세요.".into(),
        },
        Err(error) => CatalogGroupedSearchEvent::CountError {
            message: error.to_string(),
        },
    }
}

/// Both databases are pinned by the caller's read transaction before planning.
/// A missing prepared scalar is returned to the caller for a fresh lookup after
/// dropping this transaction. General COUNT always uses this original snapshot.
fn stream_snapshot(
    connection: &Connection,
    query: &CatalogSearchQuery,
    emit: &mut impl FnMut(CatalogGroupedSearchEvent) -> Result<(), LibraryError>,
) -> Result<bool, LibraryError> {
    let plan = GroupQueryPlan::new(connection, query, chrono::Utc::now().timestamp())?;
    let selected = catalog_group_query::select_page(connection, &plan)?;
    let ids = selected
        .iter()
        .map(|row| row.representative_id)
        .collect::<Vec<_>>();
    let hydrated = load_catalog_works(connection, &ids)?;
    let works = selected
        .into_iter()
        .zip(hydrated)
        .map(|(row, work)| CatalogGroupedWork {
            work,
            group_id: row.group_id,
            version_count: row.version_count,
            has_bookmarked_version: row.has_bookmarked_version,
        })
        .collect();
    emit(CatalogGroupedSearchEvent::Page {
        page: CatalogGroupedPage {
            works,
            page: query.page,
            page_size: query.page_size.clamp(1, 100),
        },
    })?;
    // This call deliberately follows delivery, including the expensive route.
    let count = catalog_group_query::count_groups(connection, &plan);
    if matches!(count, Ok(None)) {
        return Ok(false);
    }
    emit(count_event(count))?;
    Ok(true)
}

impl Library {
    fn wait_existing_catalog_preparation(&self) -> Result<(), LibraryError> {
        let deadline = Instant::now() + PREPARATION_WAIT;
        loop {
            let (running, error) = self.catalog_preparation_status();
            if !running {
                return if error.is_some() {
                    Err(LibraryError::InvalidOnlineCatalog)
                } else {
                    Ok(())
                };
            }
            if Instant::now() >= deadline {
                return Err(LibraryError::InvalidOnlineCatalog);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    pub fn search_catalog_groups(
        &self,
        query: CatalogSearchQuery,
        mut emit: impl FnMut(CatalogGroupedSearchEvent) -> Result<(), LibraryError>,
    ) -> Result<(), LibraryError> {
        provider_supported(query.provider)?;
        if !self.root.join("catalogs/kdata.db").is_file() {
            return Err(LibraryError::OnlineCatalogNotInstalled);
        }
        // One membership retry, waiting on eager preparation only. No reader or
        // normal DB mutex survives the wait; search never starts preparation.
        let mut waited = false;
        let original = loop {
            let mut reader = self.catalog_read_connection()?;
            let snapshot = reader.transaction()?;
            if let Some(context) = catalog_counts::read_context(&snapshot)? {
                if stream_snapshot(&snapshot, &query, &mut emit)? {
                    return Ok(());
                }
                break context;
            }
            drop(snapshot);
            drop(reader);
            if waited {
                return Err(LibraryError::InvalidOnlineCatalog);
            }
            self.wait_existing_catalog_preparation()?;
            waited = true;
        };
        // The first page is already usable. Any pending/count failure thereafter
        // must be an event, not an invocation error that discards that page.
        let count = (|| {
            self.wait_existing_catalog_preparation()?;
            let mut reader = self.catalog_read_connection()?;
            let snapshot = reader.transaction()?;
            let current = catalog_counts::read_context(&snapshot)?;
            if !current
                .as_ref()
                .is_some_and(|c| same_count_context(&original, c, query.reveal_blocked))
            {
                return Ok(None);
            }
            catalog_counts::lookup(&snapshot, query.language, query.reveal_blocked)
        })();
        emit(count_event(count))
    }

    pub fn get_catalog_group_editions(
        &self,
        query: CatalogGroupEditionsQuery,
    ) -> Result<CatalogGroupEditionsPage, LibraryError> {
        provider_supported(query.provider)?;
        let mut waited = false;
        loop {
            let mut reader = self.catalog_read_connection()?;
            let snapshot = reader.transaction()?;
            if catalog_counts::read_context(&snapshot)?.is_some() {
                return editions(&snapshot, &query);
            }
            drop(snapshot);
            drop(reader);
            if waited {
                return Err(LibraryError::InvalidOnlineCatalog);
            }
            self.wait_existing_catalog_preparation()?;
            waited = true;
        }
    }

    pub fn set_catalog_group_representative(
        &self,
        query: CatalogGroupRepresentativeQuery,
    ) -> Result<(), LibraryError> {
        provider_supported(query.provider)?;
        if let Some(id) = &query.selected_provider_work_id {
            if !id
                .parse::<i64>()
                .ok()
                .is_some_and(|n| n > 0 && n.to_string() == *id)
            {
                return Err(LibraryError::InvalidOnlineCatalog);
            }
        }
        let _file_guard = self
            .catalog_file_lock
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut writer = self.connection()?;
        super::catalog_preparation::attach_catalog_readonly(&writer, &self.root)?;
        let snapshot = writer.transaction()?;
        if catalog_counts::read_context(&snapshot)?.is_none() {
            return Err(LibraryError::InvalidOnlineCatalog);
        }
        let (group_id, anchor) = resolve_group(&snapshot, &query.group_id)?;
        if let Some(id) = &query.selected_provider_work_id {
            let member: bool = snapshot.query_row(
                "SELECT EXISTS(SELECT 1 FROM online_catalog_group_members
                WHERE provider='kHentai' AND group_id=?1 AND work_id=?2)",
                params![group_id, id],
                |r| r.get(0),
            )?;
            if !member {
                return Err(LibraryError::OnlineCatalogWorkNotFound);
            }
        }
        catalog_group_identity::set_preference(
            &snapshot,
            "kHentai",
            &anchor,
            query.selected_provider_work_id.as_deref(),
        )?;
        snapshot.commit()?;
        Ok(())
    }
}

/// Historical handles resolve through their durable anchor after a merge/split.
fn resolve_group(connection: &Connection, handle: &str) -> Result<(String, String), LibraryError> {
    connection.query_row("SELECT member.group_id,handle.anchor_work_id FROM online_catalog_group_handles handle
        JOIN online_catalog_group_members member ON member.provider=handle.provider AND member.work_id=handle.anchor_work_id
        WHERE handle.provider='kHentai' AND handle.group_id=?1", [handle], |r|Ok((r.get(0)?,r.get(1)?)))
        .optional()?.ok_or(LibraryError::OnlineCatalogWorkNotFound)
}

fn editions(
    connection: &Connection,
    query: &CatalogGroupEditionsQuery,
) -> Result<CatalogGroupEditionsPage, LibraryError> {
    let (group_id, _) = resolve_group(connection, &query.group_id)?;
    let mut clauses = vec![
        "work.Expunged=0".into(),
        "member.provider='kHentai'".into(),
        "member.group_id=?".into(),
    ];
    let mut values = vec![Value::Text(group_id.clone())];
    if let Some(language) = query.language {
        clauses.push("EXISTS(SELECT 1 FROM catalog.Tags t WHERE t.WorkId=work.Id AND t.Namespace='language' AND t.Value=?)".into());
        values.push(language.as_tag().to_owned().into());
    }
    if !query.reveal_blocked {
        append_visibility_predicates(connection, &mut clauses)?;
    }
    let eligible = format!("FROM online_catalog_group_members member JOIN catalog.Works work ON work.Id=member.catalog_work_id WHERE {}",clauses.join(" AND "));
    let total_count = connection.query_row(
        &format!("SELECT COUNT(*) {eligible}"),
        params_from_iter(values.iter()),
        |r| r.get::<_, i64>(0),
    )? as u64;
    // Check visibility against all eligible editions, not just this page. Never
    // disclose the ID of a hidden or language-excluded saved selection.
    let selected: Option<String> = connection.query_row("SELECT p.selected_work_id FROM online_catalog_group_preferences p
        JOIN online_catalog_group_members anchor ON anchor.provider=p.provider AND anchor.work_id=p.anchor_work_id
        WHERE anchor.provider='kHentai' AND anchor.group_id=?1 ORDER BY p.edit_revision DESC LIMIT 1",[&group_id],|r|r.get(0)).optional()?.flatten();
    let selected_provider_work_id = if let Some(selected) = selected {
        let mut selected_values = values.clone();
        selected_values.push(selected.clone().into());
        let visible: bool = connection.query_row(
            &format!("SELECT EXISTS(SELECT 1 {eligible} AND member.work_id=?)"),
            params_from_iter(selected_values.iter()),
            |r| r.get(0),
        )?;
        visible.then_some(selected)
    } else {
        None
    };
    let page_size = query.page_size.clamp(1, 100);
    values.push(i64::from(page_size).into());
    values.push(
        (u64::from(query.page) * u64::from(page_size))
            .min(i64::MAX as u64)
            .try_into()
            .map(Value::Integer)
            .unwrap(),
    );
    let ids = connection
        .prepare(&format!(
            "SELECT work.Id {eligible} ORDER BY work.Posted DESC,work.Id DESC LIMIT ? OFFSET ?"
        ))?
        .query_map(params_from_iter(values.iter()), |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CatalogGroupEditionsPage {
        group_id,
        works: load_catalog_works(connection, &ids)?,
        total_count,
        page: query.page,
        page_size,
        selected_provider_work_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    fn fixture() -> (tempfile::TempDir, Library) {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        std::fs::create_dir(root.path().join("catalogs")).unwrap();
        let catalog = Connection::open(root.path().join("catalogs/kdata.db")).unwrap();
        catalog
            .execute_batch(
                "PRAGMA journal_mode=WAL;
            CREATE TABLE CrawlState(Key TEXT PRIMARY KEY,Value TEXT);
            CREATE TABLE Works(Id INTEGER PRIMARY KEY,Token TEXT,ParentGid INTEGER,ParentKey TEXT,
                FirstGid INTEGER,FirstKey TEXT,CurrentGid INTEGER,CurrentKey TEXT,Thumb TEXT,
                Title TEXT,TitleJpn TEXT,FileCount INTEGER,Category INTEGER,Uploader TEXT,
                Expunged INTEGER DEFAULT 0,Posted INTEGER,Views INTEGER);
            CREATE TABLE Tags(WorkId INTEGER,Namespace TEXT,Value TEXT,
                PRIMARY KEY(WorkId,Namespace,Value)) WITHOUT ROWID;
            CREATE INDEX IdxTagsLookup ON Tags(Namespace,Value);
            CREATE INDEX IdxWorksPosted ON Works(Posted DESC);
            CREATE INDEX IdxWorksRank ON Works(Expunged,Views DESC,Posted);
            INSERT INTO Works(Id,Token,Title,FileCount,Category,Posted,Views) VALUES
                (1,'one','alpha',20,1,1000,90),(2,'two','beta',200,2,2000,10),
                (3,'three','alpha beta',120,1,1500,50);
            UPDATE Works SET ParentGid=1,ParentKey='one' WHERE Id=2;
            INSERT INTO Tags VALUES (1,'language','korean'),(2,'language','japanese'),
                (3,'language','korean');",
            )
            .unwrap();
        (root, library)
    }

    #[test]
    fn catalog_group_api_page_precedes_count_and_avoids_global_mutex() {
        let (_root, library) = fixture();
        library.prepare_online_catalog_counts().unwrap();
        let guard = library.connection().unwrap();
        let mut events = Vec::new();
        library
            .search_catalog_groups(query("alpha"), |event| {
                events.push(event);
                Ok(())
            })
            .unwrap();
        assert!(
            matches!(&events[0], CatalogGroupedSearchEvent::Page { page } if page.works.len()==2)
        );
        assert!(matches!(
            events[1],
            CatalogGroupedSearchEvent::Count { total_count: 2 }
        ));
        drop(guard);
    }

    fn group(library: &Library, id: i64) -> String {
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT group_id FROM online_catalog_group_members WHERE catalog_work_id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
    }
    fn editions_query(group_id: String) -> CatalogGroupEditionsQuery {
        CatalogGroupEditionsQuery {
            provider: CatalogProvider::KHentai,
            group_id,
            language: None,
            reveal_blocked: false,
            page: 0,
            page_size: 40,
        }
    }
    fn choose(library: &Library, group_id: &str, selected: Option<&str>) {
        library
            .set_catalog_group_representative(CatalogGroupRepresentativeQuery {
                provider: CatalogProvider::KHentai,
                group_id: group_id.into(),
                selected_provider_work_id: selected.map(str::to_owned),
            })
            .unwrap();
    }
    #[test]
    fn catalog_group_api_prepared_missing_keeps_page_and_reports_count_error() {
        let (_root, library) = fixture();
        library.prepare_online_catalog_counts().unwrap();
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM online_catalog_prepared_counts", [])
            .unwrap();
        let mut events = Vec::new();
        library
            .search_catalog_groups(query(""), |event| {
                events.push(event);
                Ok(())
            })
            .unwrap();
        assert!(matches!(&events[0],CatalogGroupedSearchEvent::Page {page} if page.works.len()==2));
        assert!(matches!(
            &events[1],
            CatalogGroupedSearchEvent::CountError { .. }
        ));
        assert!(
            !library.catalog_preparation_status().0,
            "search must not start preparation"
        );
    }
    #[test]
    fn catalog_group_api_count_failure_happens_after_page_delivery() {
        let (_root, library) = fixture();
        library.prepare_online_catalog_counts().unwrap();
        let mut connection = library.connection().unwrap();
        super::super::catalog_preparation::attach_catalog_readonly(&connection, &library.root)
            .unwrap();
        let snapshot = connection.transaction().unwrap();
        let mut events = Vec::new();
        stream_snapshot(&snapshot, &query("alpha"), &mut |event| {
            if matches!(event, CatalogGroupedSearchEvent::Page { .. }) {
                // Injection after hydration: the exact counter must observe the
                // missing membership table, proving it has not run before delivery.
                snapshot
                    .execute("DROP TABLE online_catalog_group_members", [])
                    .unwrap();
            }
            events.push(event);
            Ok(())
        })
        .unwrap();
        assert!(matches!(&events[0],CatalogGroupedSearchEvent::Page {page} if page.works.len()==2));
        assert!(matches!(
            &events[1],
            CatalogGroupedSearchEvent::CountError { .. }
        ));
    }
    #[test]
    fn catalog_group_api_pending_releases_reader_before_preparation_and_fresh_lookup() {
        let (_root, library) = fixture();
        library.prepare_online_catalog_counts().unwrap();
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM online_catalog_prepared_counts", [])
            .unwrap();
        let mut events = Vec::new();
        library
            .search_catalog_groups(query(""), |event| {
                if matches!(event, CatalogGroupedSearchEvent::Page { .. }) {
                    assert!(library.request_catalog_preparation());
                }
                events.push(event);
                Ok(())
            })
            .unwrap();
        assert!(matches!(&events[0], CatalogGroupedSearchEvent::Page { .. }));
        assert!(matches!(
            &events[1],
            CatalogGroupedSearchEvent::Count { total_count: 2 }
        ));
    }
    #[test]
    fn catalog_group_api_pending_rejects_changed_policy_but_reveal_ignores_policy() {
        let (_root, library) = fixture();
        library.prepare_online_catalog_counts().unwrap();
        for reveal in [false, true] {
            library.connection().unwrap().execute_batch("DELETE FROM online_catalog_hidden_categories; DELETE FROM online_catalog_prepared_counts;").unwrap();
            let mut q = query("");
            q.reveal_blocked = reveal;
            let mut events = Vec::new();
            library
                .search_catalog_groups(q, |event| {
                    if matches!(event, CatalogGroupedSearchEvent::Page { .. }) {
                        library
                            .connection()
                            .unwrap()
                            .execute(
                                "INSERT INTO online_catalog_hidden_categories VALUES(1,'now')",
                                [],
                            )
                            .unwrap();
                        library.request_catalog_preparation();
                    }
                    events.push(event);
                    Ok(())
                })
                .unwrap();
            if reveal {
                assert!(matches!(
                    events[1],
                    CatalogGroupedSearchEvent::Count { total_count: 2 }
                ));
            } else {
                assert!(matches!(
                    events[1],
                    CatalogGroupedSearchEvent::CountError { .. }
                ));
            }
        }
    }
    #[test]
    fn catalog_group_api_context_rejects_source_generation_and_saved_policy_changes() {
        let original = CountContext {
            source_revision: "source-a".into(),
            generation: 2,
            policy_identity: "policy-a".into(),
        };
        let mut current = original.clone();
        current.source_revision = "source-b".into();
        assert!(!same_count_context(&original, &current, true));
        current = original.clone();
        current.generation += 1;
        assert!(!same_count_context(&original, &current, true));
        current = original.clone();
        current.policy_identity = "policy-b".into();
        assert!(!same_count_context(&original, &current, false));
        assert!(same_count_context(&original, &current, true));
    }
    #[test]
    fn catalog_group_api_bookmark_count_and_hot_use_original_snapshot() {
        let (root, library) = fixture();
        library.prepare_online_catalog_counts().unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO online_catalog_bookmarks VALUES('kHentai','1','now')",
                [],
            )
            .unwrap();
        let mut q = query("alpha");
        q.scope = CatalogScope::Bookmarked;
        q.sort = CatalogSort::HotDay;
        let mut events = Vec::new();
        library
            .search_catalog_groups(q, |event| {
                if matches!(event, CatalogGroupedSearchEvent::Page { .. }) {
                    library
                        .connection()
                        .unwrap()
                        .execute("DELETE FROM online_catalog_bookmarks", [])
                        .unwrap();
                    let catalog = Connection::open(root.path().join("catalogs/kdata.db")).unwrap();
                    catalog
                        .execute("UPDATE Works SET Posted=2000000000 WHERE Id=3", [])
                        .unwrap();
                }
                events.push(event);
                Ok(())
            })
            .unwrap();
        assert!(
            matches!(&events[0],CatalogGroupedSearchEvent::Page {page} if page.works.len()==1 && page.works[0].has_bookmarked_version)
        );
        assert!(matches!(
            events[1],
            CatalogGroupedSearchEvent::Count { total_count: 1 }
        ));
    }
    #[test]
    fn catalog_group_api_lazy_editions_manual_visibility_and_provider_validation() {
        let (_root, library) = fixture();
        library.prepare_online_catalog_counts().unwrap();
        let id = group(&library, 1);
        choose(&library, &id, Some("2"));
        let mut q = editions_query(id.clone());
        let result = library.get_catalog_group_editions(q.clone()).unwrap();
        assert_eq!(result.total_count, 2);
        assert_eq!(result.selected_provider_work_id.as_deref(), Some("2"));
        q.language = Some(CatalogLanguage::Korean);
        let result = library.get_catalog_group_editions(q.clone()).unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.selected_provider_work_id, None);
        q.language = None;
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO online_catalog_hidden_categories VALUES(2,'now')",
                [],
            )
            .unwrap();
        let result = library.get_catalog_group_editions(q.clone()).unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.selected_provider_work_id, None);
        q.reveal_blocked = true;
        assert_eq!(
            library
                .get_catalog_group_editions(q.clone())
                .unwrap()
                .selected_provider_work_id
                .as_deref(),
            Some("2")
        );
        choose(&library, &id, None);
        assert_eq!(
            library
                .get_catalog_group_editions(q.clone())
                .unwrap()
                .selected_provider_work_id,
            None
        );
        for selected in ["03", "3", "0", "-1", " 1"] {
            assert!(library
                .set_catalog_group_representative(CatalogGroupRepresentativeQuery {
                    provider: CatalogProvider::KHentai,
                    group_id: id.clone(),
                    selected_provider_work_id: Some(selected.into())
                })
                .is_err());
        }
        q.provider = CatalogProvider::Heliotrope;
        assert!(matches!(
            library.get_catalog_group_editions(q),
            Err(LibraryError::UnsupportedCatalogProvider)
        ));
        let mut q = query("");
        q.provider = CatalogProvider::Heliotrope;
        assert!(matches!(
            library.search_catalog_groups(q, |_| Ok(())),
            Err(LibraryError::UnsupportedCatalogProvider)
        ));
        assert!(matches!(
            library.set_catalog_group_representative(CatalogGroupRepresentativeQuery {
                provider: CatalogProvider::Heliotrope,
                group_id: id,
                selected_provider_work_id: None
            }),
            Err(LibraryError::UnsupportedCatalogProvider)
        ));
    }
    #[test]
    fn catalog_group_api_editions_bound_pagination_alias_and_preference_persistence() {
        let (root, library) = fixture();
        library.prepare_online_catalog_counts().unwrap();
        let historical = group(&library, 3);
        let primary = group(&library, 1);
        choose(&library, &historical, Some("3"));
        let catalog = Connection::open(root.path().join("catalogs/kdata.db")).unwrap();
        catalog
            .execute_batch("UPDATE Works SET ParentGid=2,ParentKey='two' WHERE Id=3;")
            .unwrap();
        for id in 4..=104 {
            catalog.execute("INSERT INTO Works(Id,Token,Title,FileCount,Category,Posted,Views,ParentGid,ParentKey) VALUES(?1,'t','edition',1,1,?1,1,?2,?3)",params![id,id-1,if id==4 {"three"} else {"t"}]).unwrap();
        }
        super::super::catalog_revision::mark_catalog_changed(&catalog).unwrap();
        library.prepare_online_catalog_counts().unwrap();
        let current = group(&library, 1);
        let alias = if current == historical {
            primary
        } else {
            historical
        };
        let mut q = editions_query(alias);
        q.page_size = 1000;
        let page = library.get_catalog_group_editions(q.clone()).unwrap();
        assert_eq!(page.group_id, current);
        assert_eq!(page.total_count, 104);
        assert_eq!(page.works.len(), 100);
        assert_eq!(page.page_size, 100);
        assert_eq!(page.selected_provider_work_id.as_deref(), Some("3"));
        q.page = 1;
        let second = library.get_catalog_group_editions(q.clone()).unwrap();
        assert_eq!(second.works.len(), 4);
        assert_eq!(second.total_count, 104);
        choose(&library, &q.group_id, None);
        drop(library);
        let reopened = Library::open(root.path()).unwrap();
        assert_eq!(
            reopened
                .get_catalog_group_editions(q)
                .unwrap()
                .selected_provider_work_id,
            None
        );
    }
    #[test]
    fn catalog_group_api_wire_contract_is_flat_and_camel_case() {
        let value =
            serde_json::to_value(CatalogGroupedSearchEvent::Count { total_count: 2 }).unwrap();
        assert_eq!(value, serde_json::json!({"type":"count","totalCount":2}));
        let query: CatalogGroupEditionsQuery =
            serde_json::from_value(serde_json::json!({"provider":"kHentai","groupId":"id"}))
                .unwrap();
        assert_eq!(query.page, 0);
        assert_eq!(query.page_size, 40);
    }
    fn query(text: &str) -> CatalogSearchQuery {
        CatalogSearchQuery {
            provider: super::super::catalog_provider::CatalogProvider::KHentai,
            language: None,
            reveal_blocked: false,
            text: text.into(),
            sort: CatalogSort::Latest,
            scope: CatalogScope::All,
            page: 0,
            page_size: 40,
        }
    }
}
