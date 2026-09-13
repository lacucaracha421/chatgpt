//! Explicit read publication using the PC's canonical gallery scopes in one WAL snapshot.
use super::{
    client::CloudClient,
    publication::{report, Reporter},
};
use crate::library::character_hub::{
    GROUP_GALLERY_SCOPE, SERIES_GALLERY_SCOPE, TARGET_GALLERY_SQL,
};
use crate::library::{credential, error::LibraryError, Library};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const MAX_ASSETS: usize = 250_000;
const MAX_MEMBERS: usize = 1_000_000;
pub(crate) const MAX_BYTES: usize = 24 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Node {
    id: String,
    kind: &'static str,
    source_id: String,
    series_id: String,
    parent_id: Option<String>,
    name: String,
    description: String,
    thumbnail_asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hero_asset_id: Option<String>,
    manual_only: bool,
    excluded: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    node_id: String,
    filter: &'static str,
    asset_ids: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    version: u8,
    base_revision: Option<String>,
    navigation_order: Vec<String>,
    nodes: Vec<Node>,
    scopes: Vec<Scope>,
}
#[derive(Serialize, Deserialize)]
pub struct CharacterPublishResult {
    pub revision: String,
    pub nodes: usize,
}

fn node(
    kind: &'static str,
    source: String,
    series: &str,
    parent: Option<String>,
    name: String,
    thumbnail: Option<String>,
) -> Node {
    Node {
        id: format!("{kind}:{source}"),
        kind,
        source_id: source,
        series_id: series.into(),
        parent_id: parent,
        name,
        description: String::new(),
        thumbnail_asset_id: thumbnail,
        hero_asset_id: None,
        manual_only: false,
        excluded: false,
    }
}

pub(crate) fn snapshot_from_connection(
    connection: &mut Connection,
    base_revision: Option<String>,
    progress: Reporter<'_>,
) -> Result<Snapshot, LibraryError> {
    let tx = connection.transaction()?;
    let order: String = tx.query_row("SELECT navigation_order FROM mobile_publication_state WHERE kind='characters'",[],|r|r.get(0))?;
    let navigation_order = serde_json::from_str(&order).map_err(|_|LibraryError::InvalidCloudResponse)?;
    let mut nodes = Vec::new();
    let series = tx.prepare("SELECT s.classification_id,c.name,(SELECT id FROM assets WHERE id=s.hero_asset_id AND status='normal') FROM character_series s JOIN classification_entries c ON c.id=s.classification_id ORDER BY c.name COLLATE NOCASE,c.id")?
        .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?)))?
        .collect::<Result<Vec<_>,_>>()?;
    for (id, name, hero) in series {
        let parent = format!("series:{id}");
        let mut series_node = node("series", id.clone(), &id, None, name, hero.clone());
        series_node.hero_asset_id = hero;
        nodes.push(series_node);
        let groups = tx
            .prepare("SELECT id,name FROM character_groups WHERE series_id=?1 ORDER BY name,id")?
            .query_map([&id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (group, name) in groups {
            nodes.push(node("group", group, &id, Some(parent.clone()), name, None));
        }
        let targets = tx.prepare("SELECT t.id,t.display_name,t.description,t.manual_only,(SELECT id FROM assets WHERE id=t.thumbnail_asset_id AND status='normal'),gm.group_id FROM character_targets t LEFT JOIN character_group_members gm ON gm.target_id=t.id WHERE t.series_classification_id=?1 ORDER BY t.display_name COLLATE NOCASE,t.id")?
            .query_map([&id], |r| {
                let mut n = node("character",r.get(0)?,&id,Some(r.get::<_,Option<String>>(5)?.map(|g|format!("group:{g}")).unwrap_or(parent.clone())),r.get(1)?,r.get(4)?);
                n.description=r.get(2)?; n.manual_only=r.get(3)?; Ok(n)
            })?.collect::<Result<Vec<_>,_>>()?;
        nodes.extend(targets);
        let folders = tx.prepare("SELECT c.id,c.name,EXISTS(SELECT 1 FROM character_excluded_folders e WHERE e.id=c.id) FROM classification_entries c WHERE c.parent_id=?1 AND NOT EXISTS(SELECT 1 FROM character_series s WHERE s.classification_id=c.id) AND NOT EXISTS(SELECT 1 FROM character_targets t WHERE t.linked_classification_id=c.id) ORDER BY c.name COLLATE NOCASE,c.id")?
            .query_map([&id],|r| { let mut n=node("folder",r.get(0)?,&id,Some(parent.clone()),r.get(1)?,None);n.excluded=r.get(2)?;Ok(n) })?.collect::<Result<Vec<_>,_>>()?;
        nodes.extend(folders);
        if nodes.len() > 10_000 {
            return Err(LibraryError::InvalidCloudResponse);
        }
    }
    let mut scopes = Vec::new();
    let mut members = 0;
    let total_nodes = nodes.len();
    for (i, n) in nodes.iter_mut().enumerate() {
        report(
            progress,
            "preparing",
            i as u64,
            Some(total_nodes as u64),
            "items",
        );
        let filters: &[&'static str] = if n.kind == "series" {
            &["all", "unclassified", "needs_review"]
        } else {
            &["all"]
        };
        for filter in filters {
            let ids = match n.kind {
                "character" => tx
                    .prepare(TARGET_GALLERY_SQL)?
                    .query_map(
                        params![
                            n.series_id,
                            n.source_id,
                            Option::<String>::None,
                            Option::<String>::None,
                            (MAX_ASSETS + 1) as i64
                        ],
                        |r| r.get(0),
                    )?
                    .collect::<Result<Vec<String>, _>>()?,
                "group" => tx
                    .prepare(&format!(
                        "{GROUP_GALLERY_SCOPE} ORDER BY a.collected_at DESC,a.id DESC LIMIT ?3"
                    ))?
                    .query_map(
                        params![n.series_id, n.source_id, (MAX_ASSETS + 1) as i64],
                        |r| r.get(0),
                    )?
                    .collect::<Result<Vec<String>, _>>()?,
                _ => tx
                    .prepare(&format!(
                        "{SERIES_GALLERY_SCOPE} ORDER BY a.collected_at DESC,a.id DESC LIMIT ?5"
                    ))?
                    .query_map(
                        params![
                            if n.kind == "folder" {
                                &n.source_id
                            } else {
                                &n.series_id
                            },
                            Option::<String>::None,
                            false,
                            filter,
                            (MAX_ASSETS + 1) as i64
                        ],
                        |r| r.get(0),
                    )?
                    .collect::<Result<Vec<String>, _>>()?,
            };
            members += ids.len();
            if ids.len() > MAX_ASSETS || members > MAX_MEMBERS {
                return Err(LibraryError::InvalidCloudResponse);
            }
            if n.thumbnail_asset_id.is_none() && *filter == "all" {
                // Choose only a real normal thumbnail, retaining gallery order.
                let json =
                    serde_json::to_string(&ids).map_err(|_| LibraryError::InvalidCloudResponse)?;
                n.thumbnail_asset_id=tx.query_row("SELECT a.id FROM json_each(?1) j JOIN assets a ON a.id=j.value WHERE a.thumbnail_relative_path IS NOT NULL ORDER BY j.key LIMIT 1",[json],|r|r.get(0)).optional()?;
            }
            scopes.push(Scope {
                node_id: n.id.clone(),
                filter,
                asset_ids: ids,
            });
        }
    }
    Ok(Snapshot {
        version: 1,
        base_revision,
        nodes,
        navigation_order,
        scopes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::character_hub::{BrowseQuery, SeriesGalleryFilter};

    fn fixture() -> (tempfile::TempDir, Library) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let c = library.connection().unwrap();
        c.execute_batch("INSERT INTO classification_entries(id,kind,name,parent_id,created_at) VALUES ('r','root','Root',NULL,'2026'),('s','tag','Series','r','2026'),('e','tag','Excluded','s','2026'),('f','tag','Folder','s','2026');
            INSERT INTO character_series(classification_id,auto_classify) VALUES('s',0);
            INSERT INTO character_targets(id,series_classification_id,display_name,enabled,manual_only,created_at,updated_at) VALUES('c','s','C',1,0,'2026','2026'),('d','s','D',1,1,'2026','2026');
            INSERT INTO character_groups(id,series_id,name) VALUES('g','s','Group');
            INSERT INTO character_group_members VALUES('c','g'),('d','g');
            INSERT INTO character_folder_exclusions VALUES('e');").unwrap();
        for (id, folder, status) in [
            ("a", "s", "normal"),
            ("b", "r", "normal"),
            ("x", "s", "normal"),
            ("u", "f", "normal"),
            ("z", "e", "normal"),
            ("t", "s", "trash"),
        ] {
            c.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status) VALUES(?1,?1,'image',?1,?2,?2,1,1,1,'2026-09-13T00:00:00Z',?3)",params![id,format!("assets/{id}.png"),status]).unwrap();
            c.execute(
                "INSERT INTO asset_classifications VALUES(?1,?2)",
                params![id, folder],
            )
            .unwrap();
        }
        for (target, id) in [("c", "a"), ("c", "b"), ("d", "a"), ("d", "t")] {
            c.execute("INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,created_at) VALUES(?1,?2,?2,?2,'accepted','fixture','[]','2026')",params![target,id]).unwrap();
        }
        c.execute("INSERT INTO character_references VALUES('c',0,'x','x')", [])
            .unwrap();
        drop(c);
        (temp, library)
    }

    #[test]
    fn character_publication_matches_shared_fixture_and_pc_queries() {
        let (_temp, library) = fixture();
        let mut connection = Connection::open_with_flags(
            library.root().join("library.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let result = snapshot_from_connection(&mut connection, None, &|_| {}).unwrap();
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../tests/fixtures/mobile-character-projection.json"
        ))
        .unwrap();
        assert_eq!(serde_json::to_value(&result).unwrap(), expected);
        for scope in result
            .scopes
            .iter()
            .filter(|s| !s.node_id.starts_with("folder:"))
        {
            let n = result.nodes.iter().find(|n| n.id == scope.node_id).unwrap();
            let mut ids = Vec::new();
            let mut after = None;
            loop {
                let page = library
                    .browse_character_assets(BrowseQuery {
                        series_id: n.series_id.clone(),
                        target_id: (n.kind == "character").then(|| n.source_id.clone()),
                        group_id: (n.kind == "group").then(|| n.source_id.clone()),
                        reference_target_id: None,
                        after,
                        limit: 1,
                        all: false,
                        series_filter: Some(match scope.filter {
                            "unclassified" => SeriesGalleryFilter::Unclassified,
                            "needs_review" => SeriesGalleryFilter::NeedsReview,
                            _ => SeriesGalleryFilter::All,
                        }),
                    })
                    .unwrap();
                assert_eq!(page.total_count as usize, scope.asset_ids.len());
                ids.extend(page.items.into_iter().map(|a| a.id));
                after = page.next_cursor;
                if after.is_none() {
                    break;
                }
            }
            assert_eq!(ids, scope.asset_ids, "{} {}", scope.node_id, scope.filter);
        }
        let pending: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM character_reference_refreshes",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            pending, 0,
            "publication must never schedule historical analysis"
        );
    }

    #[test]
    fn character_publication_replaces_stale_memberships_after_decision_and_exclusion() {
        let (_temp, library) = fixture();
        let mut c = library.connection().unwrap();
        c.execute("UPDATE character_series SET hero_asset_id='a' WHERE classification_id='s'", []).unwrap();
        c.execute("INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,created_at) VALUES('c','a','a','a','rejected','fixture','[]','2026')",[]).unwrap();
        c.execute(
            "INSERT INTO character_series_asset_exclusions VALUES('s','u','2026')",
            [],
        )
        .unwrap();
        let result = snapshot_from_connection(&mut c, None, &|_| {}).unwrap();
        assert_eq!(result.nodes.iter().find(|n| n.id == "series:s").unwrap().hero_asset_id.as_deref(), Some("a"));
        let ids = |node: &str, filter: &str| {
            result
                .scopes
                .iter()
                .find(|s| s.node_id == node && s.filter == filter)
                .unwrap()
                .asset_ids
                .clone()
        };
        assert_eq!(ids("character:c", "all"), ["x", "b"]);
        assert_eq!(
            ids("group:g", "all"),
            ["x", "b", "a"],
            "other character keeps shared asset"
        );
        assert!(ids("series:s", "unclassified").is_empty());
        assert_eq!(
            ids("folder:f", "all"),
            ["u"],
            "classification exclusion keeps ordinary folder viewing"
        );
    }
}

impl Library {
    pub(crate) fn push_cloud_characters(
        &self,
        progress: Reporter<'_>,
    ) -> Result<CharacterPublishResult, LibraryError> {
        report(progress, "connecting", 0, None, "items");
        let config = self.cloud_sync_config()?;
        let client = CloudClient::new(
            config
                .api_base_url
                .as_deref()
                .ok_or(LibraryError::InvalidCloudSyncConfig)?,
        )?;
        let token = credential::read_cloud_api_token_os()?;
        let revision = client.character_revision(&token)?;
        let mut connection = Connection::open_with_flags(
            self.root().join("library.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let snapshot = snapshot_from_connection(&mut connection, revision, progress)?;
        let body = serde_json::to_vec(&snapshot).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if body.len() > MAX_BYTES {
            return Err(LibraryError::InvalidCloudResponse);
        }
        report(
            progress,
            "publishing",
            0,
            Some(snapshot.nodes.len() as u64),
            "items",
        );
        client.publish_characters(&token, &body)
    }
}
