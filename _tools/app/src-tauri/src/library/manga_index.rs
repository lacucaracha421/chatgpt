//! PC Manga index: bookmark projections, library pins and explicit orphan cleanup.
use super::{
    backup, catalog_visibility::append_visibility_predicates, error::LibraryError, manga,
    online_catalog::translated_detail_tag, Library,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MangaIndexIdentity {
    pub kind: String,
    pub namespace: String,
    pub value: String,
    pub label: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MangaIndexEntry {
    #[serde(flatten)]
    pub identity: MangaIndexIdentity,
    pub count: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MangaFrequentIndex {
    pub bookmark_count: u64,
    pub tags: Vec<MangaIndexEntry>,
    pub artists: Vec<MangaIndexEntry>,
    pub tag_limit: usize,
    pub artist_limit: usize,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MangaLocalFolder {
    pub name: String,
    pub relative_path: String,
    pub series_count: usize,
    pub series_ids: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MangaLocalIndex {
    pub folders: Vec<MangaLocalFolder>,
    pub vanished: Vec<MangaLocalFolder>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MangaFolderPurgeResult {
    pub removed_folders: Vec<MangaLocalFolder>,
    pub removed_series_count: usize,
    pub backup_path: String,
}
pub(super) fn validate_identity(identity: &MangaIndexIdentity) -> Result<(), LibraryError> {
    if identity.value.trim().is_empty()
        || identity.label.trim().is_empty()
        || identity.namespace.trim().is_empty()
        || identity.namespace.len() > 32
        || identity.value.len() > 200
        || identity.label.len() > 400
        || identity.value.chars().chain(identity.label.chars()).any(|c| c.is_control())
        || !identity.namespace.chars().all(|c| c.is_ascii_lowercase())
        || !((identity.kind == "artist" && identity.namespace == "artist")
            || (identity.kind == "tag" && identity.namespace != "artist"))
    {
        return Err(LibraryError::InvalidMangaIndexRequest);
    }
    Ok(())
}
impl Library {
    pub fn manga_frequent_index(
        &self,
        tag_limit: Option<usize>,
        artist_limit: Option<usize>,
    ) -> Result<MangaFrequentIndex, LibraryError> {
        let _files = self
            .catalog_file_lock
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let c = self.connection()?;
        let mut result = MangaFrequentIndex {
            bookmark_count: c.query_row(
                "SELECT COUNT(*) FROM online_catalog_bookmarks",
                [],
                |r| r.get::<_, i64>(0),
            )? as u64,
            tags: vec![],
            artists: vec![],
            tag_limit: tag_limit.unwrap_or(8),
            artist_limit: artist_limit.unwrap_or(5),
        };
        let catalog = self.root.join("catalogs/kdata.db");
        if result.bookmark_count == 0 || !catalog.is_file() {
            return Ok(result);
        }
        c.execute(
            "ATTACH DATABASE ?1 AS catalog",
            [catalog.to_string_lossy().as_ref()],
        )?;
        let translations: BTreeMap<String, String> =
            fs::read(self.root.join("catalogs/tag-ko.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
        let mut clauses = vec![
            "bookmark.provider = 'kHentai'".into(),
            "bookmark.work_id = CAST(work.Id AS TEXT)".into(),
            // Language, bookkeeping and "no parody" tags sit on nearly every work and
            // never narrow the catalog (user check 2026-10-01: korean/translated topped the list).
            "tag.Namespace NOT IN ('language', 'temp')".into(),
            "NOT (tag.Namespace = 'parody' AND tag.Value = 'original')".into(),
        ];
        append_visibility_predicates(&c, &mut clauses)?;
        // Enumerate bookmarks first and probe Tags by WorkId; never scan the full catalog.
        let sql = format!(
            "SELECT tag.Namespace, tag.Value, COUNT(DISTINCT work.Id)
            FROM online_catalog_bookmarks AS bookmark
            CROSS JOIN catalog.Works AS work ON work.Id = CAST(bookmark.work_id AS INTEGER)
            CROSS JOIN catalog.Tags AS tag ON tag.WorkId = work.Id
            WHERE {} GROUP BY tag.Namespace, tag.Value
            ORDER BY COUNT(DISTINCT work.Id) DESC, tag.Namespace, tag.Value",
            clauses.join(" AND ")
        );
        let mut statement = c.prepare(&sql)?;
        let rows = statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)? as u64,
            ))
        })?;
        for row in rows {
            let (namespace, value, count) = row?;
            let artist = namespace == "artist";
            let label = if artist {
                value.replace('_', " ")
            } else {
                translated_detail_tag(&translations, &namespace, &value)
                    .unwrap_or_else(|| value.replace('_', " "))
            };
            let entry = MangaIndexEntry {
                identity: MangaIndexIdentity {
                    kind: if artist { "artist" } else { "tag" }.into(),
                    namespace,
                    value,
                    label,
                },
                count,
            };
            if artist {
                result.artists.push(entry);
            } else {
                result.tags.push(entry);
            }
        }
        Ok(result)
    }
    pub fn list_manga_index_pins(&self) -> Result<Vec<MangaIndexIdentity>, LibraryError> {
        let c = self.connection()?;
        let mut q = c.prepare("SELECT kind,namespace,value,label FROM manga_index_pins AS pin WHERE NOT EXISTS (SELECT 1 FROM online_catalog_blocked_tags AS blocked WHERE blocked.namespace=pin.namespace AND blocked.value=pin.value) ORDER BY created_at,kind,namespace,value")?;
        let rows = q.query_map([], |r| {
            Ok(MangaIndexIdentity {
                kind: r.get(0)?,
                namespace: r.get(1)?,
                value: r.get(2)?,
                label: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
    pub fn add_manga_index_pin(&self, identity: MangaIndexIdentity) -> Result<(), LibraryError> {
        validate_identity(&identity)?;
        let mut c = self.connection()?;
        let t = c.transaction()?;
        super::manga_index_sync::enqueue(&t, &identity, true)?;
        t.commit()?;
        Ok(())
    }
    pub fn remove_manga_index_pin(&self, identity: MangaIndexIdentity) -> Result<(), LibraryError> {
        validate_identity(&identity)?;
        let mut c = self.connection()?;
        let t = c.transaction()?;
        super::manga_index_sync::enqueue(&t, &identity, false)?;
        t.commit()?;
        Ok(())
    }
    pub fn manga_local_index(&self) -> Result<MangaLocalIndex, LibraryError> {
        let c = self.connection()?;
        let Some(root) = manga::manga_root(self, &c)? else {
            return Ok(MangaLocalIndex {
                folders: vec![],
                vanished: vec![],
            });
        };
        local_index(self, &c, Path::new(&root))
    }
    pub fn purge_vanished_manga_folders(
        &self,
        paths: Vec<String>,
    ) -> Result<MangaFolderPurgeResult, LibraryError> {
        if paths.is_empty()
            || paths
                .iter()
                .any(|p| first_folder(p).as_deref() != Some(p.as_str()))
        {
            return Err(LibraryError::InvalidMangaIndexRequest);
        }
        let _scan = self
            .manga_scan_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _backup = self
            .backup_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut c = self.connection()?;
        let root = manga::manga_root(self, &c)?.ok_or(LibraryError::MangaRootNotSet)?;
        let root = PathBuf::from(root);
        let root_identity = super::manga_root_guard::require(self, &c, &root, false)?;
        let index = local_index(self, &c, &root)?;
        let selected: BTreeSet<_> = paths.into_iter().collect();
        let removed: Vec<_> = index
            .vanished
            .into_iter()
            .filter(|f| selected.contains(&f.relative_path))
            .collect();
        if removed.len() != selected.len() {
            return Err(LibraryError::InvalidMangaIndexRequest);
        }
        let version = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
        let destination = backup::pre_migration_snapshot_path(&self.root, version);
        // Keep the database lock from snapshot through commit: it backs up precisely the
        // records being removed, without a writer/scan slipping into the gap.
        backup::create_verified_snapshot(&c, &destination)?;
        let tx = c.transaction()?;
        root_identity.verify(&tx)?;
        let count = removed.iter().map(|folder| folder.series_count).sum();
        for folder in &removed {
            if !is_absent(&root.join(&folder.relative_path))? {
                return Err(LibraryError::InvalidMangaIndexRequest);
            }
            for id in &folder.series_ids {
                tx.execute("DELETE FROM manga_series WHERE id=?1", [id])?;
            }
            // Recovery-only records for this selected folder are also local metadata;
            // catalog bookmarks themselves are deliberately retained.
            let mut q = tx.prepare("SELECT manga_id,source_relative_path FROM manga_catalog_recovery_links WHERE source_relative_path IS NOT NULL")?;
            let rows = q
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            drop(q);
            for (id, path) in rows {
                if first_folder(&path).as_deref() == Some(&folder.relative_path) {
                    tx.execute(
                        "DELETE FROM manga_catalog_recovery_links WHERE manga_id=?1",
                        [id],
                    )?;
                }
            }
        }
        // A final probe also catches a folder restored while another selected row was deleted.
        for folder in &removed {
            if !is_absent(&root.join(&folder.relative_path))? {
                return Err(LibraryError::InvalidMangaIndexRequest);
            }
        }
        root_identity.verify_before_purge_commit(&tx)?;
        tx.commit()?;
        Ok(MangaFolderPurgeResult {
            removed_folders: removed,
            removed_series_count: count,
            backup_path: destination.to_string_lossy().into_owned(),
        })
    }
}
fn first_folder(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let parts: Vec<_> = normalized.split('/').collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains(':'))
    {
        return None;
    }
    Some(parts[0].to_owned())
}
fn is_absent(path: &Path) -> Result<bool, LibraryError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(source) => Err(LibraryError::ReadMedia {
            path: path.into(),
            source,
        }),
    }
}
fn local_index(
    library: &Library,
    c: &Connection,
    root: &Path,
) -> Result<MangaLocalIndex, LibraryError> {
    let identity = super::manga_root_guard::require(library, c, root, true)?;
    let mut folders = BTreeMap::<String, MangaLocalFolder>::new();
    for entry in fs::read_dir(root).map_err(|source| LibraryError::ReadMedia {
        path: root.into(),
        source,
    })? {
        let entry = entry.map_err(|source| LibraryError::ReadMedia {
            path: root.into(),
            source,
        })?;
        if entry.path().is_dir() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".lakomics-thumbs" || first_folder(&name).as_deref() != Some(&name) {
                continue;
            }
            folders.insert(
                name.clone(),
                MangaLocalFolder {
                    name: name.clone(),
                    relative_path: name,
                    series_count: 0,
                    series_ids: vec![],
                },
            );
        }
    }
    let mut q = c.prepare("SELECT id,relative_path FROM manga_series")?;
    let rows = q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, path) = row?;
        let Some(first) = first_folder(&path) else {
            continue;
        };
        let folder = folders
            .entry(first.clone())
            .or_insert_with(|| MangaLocalFolder {
                name: first.clone(),
                relative_path: first,
                series_count: 0,
                series_ids: vec![],
            });
        if !folder.series_ids.contains(&id) {
            folder.series_ids.push(id);
            folder.series_count += 1;
        }
    }
    let mut result = MangaLocalIndex {
        folders: vec![],
        vanished: vec![],
    };
    for folder in folders.into_values() {
        if is_absent(&root.join(&folder.relative_path))? {
            result.vanished.push(folder);
        } else {
            result.folders.push(folder);
        }
    }
    identity.verify(c)?;
    Ok(result)
}
#[cfg(test)]
#[path = "manga_index_tests.rs"]
mod tests;
