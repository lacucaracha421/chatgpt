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
/// The server's exclusion cursor bound (JavaScript's exact-integer maximum).
///
/// Mirrored so client-side cursor arithmetic is provably in range: a hostile or corrupt
/// `after` near `i64::MAX` is refused instead of overflowing.
const MAX_CURSOR: i64 = 9_007_199_254_740_991;

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
    /// Assets that *define* this character: every base and learned reference.
    ///
    /// The server refuses a manual exclusion that names one of these, so the set has to
    /// travel with the projection. It is emitted only for `character` nodes and only under
    /// the adopted feature, which is what keeps a legacy snapshot byte-identical.
    #[serde(skip_serializing_if = "Option::is_none")]
    protected_asset_ids: Option<Vec<String>>,
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
    /// Present only once this PC has adopted the manual-exclusion feature.
    ///
    /// All three travel together or not at all, so the server can treat "metadata present"
    /// as "this publisher understands exclusions" and a missing field as a legacy snapshot
    /// instead of an empty one. `exclusion_cursor` is the durable position read from the
    /// same transaction as the nodes and scopes, so a snapshot can never advertise a cursor
    /// behind the memberships it carries.
    #[serde(skip_serializing_if = "Option::is_none")]
    manual_exclusion_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    library_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exclusion_cursor: Option<i64>,
}
#[derive(Serialize, Deserialize)]
pub struct CharacterPublishResult {
    pub revision: String,
    pub nodes: usize,
}

/// One accepted manual exclusion from the server's ordered log.
///
/// `sequence` is the server's ordering and the only clock: it is a dense, monotonic
/// position inside one library's log, never a wall-clock value, so a PC with a skewed
/// clock still applies corrections in the order the server accepted them.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExclusionEntry {
    pub sequence: i64,
    pub operation_id: String,
    pub target_id: String,
    pub asset_id: String,
    pub asset_sha256: String,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExclusionPage {
    pub version: u8,
    pub library_id: String,
    pub after: i64,
    pub next_cursor: i64,
    pub has_more: bool,
    pub items: Vec<ExclusionEntry>,
}

/// Reject a page the caller must not apply.
///
/// The contract is *contiguous* delivery: the page's entries must start exactly at
/// `after + 1` and end at `next_cursor` with no gap. That is what makes a durable
/// cursor sufficient — if a hole were allowed, advancing past it would silently drop a
/// correction forever, and there is no later read that could recover it.
pub(crate) fn validate_exclusion_page(
    page: &ExclusionPage,
    library_id: &str,
    after: i64,
    limit: i64,
) -> Result<(), LibraryError> {
    // The server's own bound, so cursor arithmetic here cannot overflow.
    if !(0..MAX_CURSOR).contains(&after) {
        return Err(LibraryError::CharacterExclusionInvalid);
    }
    if page.version != 1 || page.library_id != library_id || page.after != after {
        return Err(LibraryError::CharacterExclusionInvalid);
    }
    if page.items.len() > 100 || page.items.len() as i64 > limit {
        return Err(LibraryError::CharacterExclusionInvalid);
    }
    let mut expected = after + 1;
    for item in &page.items {
        if item.sequence != expected {
            return Err(LibraryError::CharacterExclusionInvalid);
        }
        if item.operation_id.is_empty() || item.target_id.is_empty() || item.asset_id.is_empty() {
            return Err(LibraryError::CharacterExclusionInvalid);
        }
        // The hash is the same-byte identity this PC validates against locally, so a
        // malformed one can never be applied and must not be adopted into the cursor.
        if item.asset_sha256.len() != 64
            || !item
                .asset_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(LibraryError::CharacterExclusionInvalid);
        }
        if expected >= MAX_CURSOR {
            // Bounded like the server's own cursor clock, so `expected + 1` below can never
            // overflow and a hostile `after` near i64::MAX is refused rather than wrapped.
            return Err(LibraryError::CharacterExclusionInvalid);
        }
        expected += 1;
    }
    let expected_cursor = if page.items.is_empty() {
        after
    } else {
        expected - 1
    };
    // An empty page is a legitimate end-of-log. A non-empty page may or may not have more;
    // what must never happen is an empty page claiming more work, which would spin the loop.
    if page.next_cursor != expected_cursor || (page.has_more && page.items.is_empty()) {
        return Err(LibraryError::CharacterExclusionInvalid);
    }
    Ok(())
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
        protected_asset_ids: None,
    }
}

pub(crate) fn snapshot_from_connection(
    connection: &mut Connection,
    base_revision: Option<String>,
    progress: Reporter<'_>,
) -> Result<Snapshot, LibraryError> {
    snapshot_from_connection_with_feature(connection, base_revision, None, progress)
}

/// The adopted manual-exclusion identity a publication is composed under.
///
/// Carried as a descriptor rather than a resolved cursor so the cursor is read by the
/// snapshot transaction itself; see [`snapshot_from_connection_with_feature`].
#[derive(Debug, Clone)]
pub(crate) struct Feature {
    pub(crate) endpoint: String,
    pub(crate) library_id: String,
}

/// Build one publication snapshot.
///
/// When `feature` is `Some`, the durable exclusion cursor is read **inside this function's
/// own transaction**, alongside the nodes and scopes it qualifies. That is load-bearing: the
/// server rejects a publication whose `exclusionCursor` falls outside
/// `[appliedCursor, lastSequence]`, and a cursor read under a *different* snapshot could
/// describe a set of exclusions the shipped memberships do not reflect. One transaction means
/// the memberships and the acknowledged position are the same instant.
///
/// A feature-aware snapshot with no adoption row is an internal inconsistency, not a state to
/// paper over, so it fails rather than publishing a legacy-shaped body.
pub(crate) fn snapshot_from_connection_with_feature(
    connection: &mut Connection,
    base_revision: Option<String>,
    feature: Option<Feature>,
    progress: Reporter<'_>,
) -> Result<Snapshot, LibraryError> {
    let tx = connection.transaction()?;
    let (manual_exclusion_version, library_id, exclusion_cursor) = match feature.as_ref() {
        Some(feature) => {
            let cursor: Option<i64> = tx
                .query_row(
                    "SELECT received_cursor FROM mobile_character_exclusion_sync WHERE endpoint=?1 AND library_id=?2",
                    params![&feature.endpoint, &feature.library_id],
                    |row| row.get(0),
                )
                .optional()?;
            let cursor = cursor.ok_or(LibraryError::CharacterExclusionCursorRejected)?;
            (Some(1), Some(feature.library_id.clone()), Some(cursor))
        }
        None => (None, None, None),
    };
    let order: String = tx.query_row(
        "SELECT navigation_order FROM mobile_publication_state WHERE kind='characters'",
        [],
        |r| r.get(0),
    )?;
    let navigation_order =
        serde_json::from_str(&order).map_err(|_| LibraryError::InvalidCloudResponse)?;
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
        for mut n in targets {
            // Only emitted under the adopted feature, so a legacy snapshot stays exactly the
            // shape older servers and the shared fixture already expect. The protected set is
            // the union of base and learned references, in a stable order so the snapshot
            // revision does not churn on row ordering alone.
            if feature.is_some() {
                let protected = tx
                    .prepare("SELECT asset_id FROM character_references WHERE target_id=?1 AND asset_id IS NOT NULL UNION SELECT asset_id FROM character_learned_references WHERE target_id=?1 ORDER BY 1")?
                    .query_map([&n.source_id], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                n.protected_asset_ids = Some(protected);
            }
            nodes.push(n);
        }
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
        manual_exclusion_version,
        library_id,
        exclusion_cursor,
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
        c.execute(
            "UPDATE character_series SET hero_asset_id='a' WHERE classification_id='s'",
            [],
        )
        .unwrap();
        c.execute("INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,created_at) VALUES('c','a','a','a','rejected','fixture','[]','2026')",[]).unwrap();
        c.execute(
            "INSERT INTO character_series_asset_exclusions VALUES('s','u','2026')",
            [],
        )
        .unwrap();
        let result = snapshot_from_connection(&mut c, None, &|_| {}).unwrap();
        assert_eq!(
            result
                .nodes
                .iter()
                .find(|n| n.id == "series:s")
                .unwrap()
                .hero_asset_id
                .as_deref(),
            Some("a")
        );
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

    #[test]
    fn legacy_snapshot_omits_every_exclusion_field_and_keeps_the_old_shape() {
        let (_temp, library) = fixture();
        let mut c = library.connection().unwrap();
        let legacy = snapshot_from_connection(&mut c, None, &|_| {}).unwrap();
        let value = serde_json::to_value(&legacy).unwrap();
        // Absent, not null: the server decides "legacy publisher" by field absence.
        assert!(value.get("manualExclusionVersion").is_none());
        assert!(value.get("libraryId").is_none());
        assert!(value.get("exclusionCursor").is_none());
        for node in value["nodes"].as_array().unwrap() {
            assert!(
                node.get("protectedAssetIds").is_none(),
                "{node:?} must not carry a protected set without the feature"
            );
        }
    }

    #[test]
    fn adopted_feature_carries_identity_cursor_and_protected_references() {
        let (_temp, library) = fixture();
        let library_id = library.library_id().unwrap();
        library
            .adopt_character_exclusion_library("https://sync.example.test", &library_id)
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE mobile_character_exclusion_sync SET received_cursor=7",
                [],
            )
            .unwrap();
        let mut c = library.connection().unwrap();
        let snapshot = snapshot_from_connection_with_feature(
            &mut c,
            None,
            Some(Feature {
                endpoint: "https://sync.example.test".into(),
                library_id: library_id.clone(),
            }),
            &|_| {},
        )
        .unwrap();
        let value = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(value["manualExclusionVersion"], 1);
        assert_eq!(value["libraryId"], library_id);
        assert_eq!(value["exclusionCursor"], 7);
        let character = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == "character:c")
            .unwrap();
        assert_eq!(character["protectedAssetIds"], serde_json::json!(["x"]));
        let other = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == "character:d")
            .unwrap();
        assert_eq!(
            other["protectedAssetIds"],
            serde_json::json!([] as [String; 0])
        );
        for node in value["nodes"].as_array().unwrap() {
            if node["kind"] != "character" {
                assert!(node.get("protectedAssetIds").is_none(), "{node:?}");
            }
        }
    }

    /// The advertised cursor must be the one stored when the memberships were read.
    ///
    /// The server accepts only a cursor within `[appliedCursor, lastSequence]`, so a cursor
    /// captured in an earlier transaction could acknowledge exclusions the shipped memberships
    /// do not reflect. This pins that the helper reads it inside the same transaction.
    #[test]
    fn snapshot_cursor_is_read_in_the_same_transaction_as_members() {
        let (_temp, library) = fixture();
        let library_id = library.library_id().unwrap();
        let endpoint = "https://sync.example.test";
        library
            .adopt_character_exclusion_library(endpoint, &library_id)
            .unwrap();
        let feature = || Feature {
            endpoint: endpoint.to_string(),
            library_id: library_id.clone(),
        };

        // A cursor captured before the snapshot must not be what the snapshot reports: the
        // helper reads its own, so advancing the stored value is visible immediately.
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE mobile_character_exclusion_sync SET received_cursor=3",
                [],
            )
            .unwrap();
        let first = {
            let mut c = library.connection().unwrap();
            snapshot_from_connection_with_feature(&mut c, None, Some(feature()), &|_| {}).unwrap()
        };
        assert_eq!(serde_json::to_value(&first).unwrap()["exclusionCursor"], 3);

        // A concurrent receive advances the durable cursor between two publications. The next
        // snapshot reports the new value, proving the read is transactional rather than cached
        // from the caller's earlier observation.
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE mobile_character_exclusion_sync SET received_cursor=9",
                [],
            )
            .unwrap();
        let second = {
            let mut c = library.connection().unwrap();
            snapshot_from_connection_with_feature(&mut c, None, Some(feature()), &|_| {}).unwrap()
        };
        assert_eq!(serde_json::to_value(&second).unwrap()["exclusionCursor"], 9);

        // An adopted endpoint whose row has been removed is an internal inconsistency, and
        // the snapshot fails rather than publishing a legacy-shaped body for a bound library.
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM mobile_character_exclusion_sync", [])
            .unwrap();
        let mut c = library.connection().unwrap();
        let error =
            match snapshot_from_connection_with_feature(&mut c, None, Some(feature()), &|_| {}) {
                Ok(_) => panic!("an adopted feature without an adoption row must fail"),
                Err(error) => error,
            };
        assert!(matches!(
            error,
            LibraryError::CharacterExclusionCursorRejected
        ));
    }
}

impl Library {
    pub(crate) fn push_cloud_characters(
        &self,
        progress: Reporter<'_>,
    ) -> Result<CharacterPublishResult, LibraryError> {
        report(progress, "connecting", 0, None, "items");
        let config = self.cloud_sync_config()?;
        let endpoint = config
            .api_base_url
            .as_deref()
            .ok_or(LibraryError::InvalidCloudSyncConfig)?
            .to_string();
        let client = CloudClient::new(&endpoint)?;
        let token = credential::read_cloud_api_token_os()?;
        let token = token.expose();

        // The exclusion log is a publisher read, and it must run *before* the revision and
        // snapshot are read. Recording a correction changes local character decisions, so a
        // publication that skipped this step would ship memberships computed before the
        // correction existed while advertising a position the server has not been told about.
        let adopted = self.character_exclusion_adoption(&endpoint)?;
        let local_library_id = self.library_id()?;
        // A PC with no publisher credential cannot read or bind the log, so the feature is
        // simply unavailable to it; the legacy path stays open only while nothing is adopted.
        let publisher_token = match credential::read_cloud_publisher_token_os() {
            Ok(token) => Some(token),
            Err(LibraryError::CloudCredentialNotConfigured) => None,
            Err(error) => return Err(error),
        };
        let feature = match (&adopted, publisher_token.as_ref()) {
            (Some((library_id, _)), Some(_)) => {
                if *library_id != local_library_id {
                    // The endpoint is bound to another identity, so this library must not
                    // publish through it.
                    return Err(LibraryError::CharacterExclusionCursorRejected);
                }
                // Pull first. The persisted cursor is advanced in the apply transaction, so
                // the snapshot below re-reads it inside its own transaction and cannot
                // advertise a position the shipped memberships do not reflect.
                self.receive_character_exclusions(&endpoint)?;
                Some(Feature {
                    endpoint: endpoint.clone(),
                    library_id: library_id.clone(),
                })
            }
            (Some(_), None) => return Err(LibraryError::CloudCredentialNotConfigured),
            (None, None) => None,
            (None, Some(publisher)) => {
                // Never adopted: the log route itself is the bootstrap. The route answers an
                // empty page even with nothing stored, so a successful read proves support
                // without needing any capability flag the server could not honestly set
                // before receiving a feature-aware snapshot.
                let probe =
                    client.character_exclusions(publisher.expose(), &local_library_id, 0, 1)?;
                match probe {
                    // Route absent: an older server, and this PC has nothing to lose.
                    None => None,
                    Some(_) => {
                        self.adopt_character_exclusion_library(&endpoint, &local_library_id)?;
                        self.receive_character_exclusions(&endpoint)?;
                        Some(Feature {
                            endpoint: endpoint.clone(),
                            library_id: local_library_id.clone(),
                        })
                    }
                }
            }
        };
        let revision = client.character_revision(&token)?;
        // The snapshot is read over a read-only connection, deliberately: publishing must
        // never mutate the library.
        let mut connection = Connection::open_with_flags(
            self.root().join("library.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let snapshot =
            snapshot_from_connection_with_feature(&mut connection, revision, feature, progress)?;
        let body = serde_json::to_vec(&snapshot).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if body.len() > MAX_BYTES {
            return Err(LibraryError::CharacterPublicationTooLarge);
        }
        report(
            progress,
            "publishing",
            0,
            Some(snapshot.nodes.len() as u64),
            "items",
        );
        // A feature-aware snapshot is a publisher operation. A legacy snapshot keeps the
        // shared credential, which is the only authorization an older server understands.
        if snapshot.manual_exclusion_version.is_some() {
            let publisher = credential::read_cloud_publisher_token_os()?;
            let publisher = publisher.expose();
            client.publish_characters(&publisher, &body)
        } else {
            client.publish_characters(&token, &body)
        }
    }
}
