use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{
    error::LibraryError,
    models::{
        ClassificationKind, CreateClassification, ImportSource, IngestMediaRequest, IngestOutcome,
    },
    Library,
};

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "jfif", "png", "gif", "webp"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationPaths {
    pub library_root: PathBuf,
    pub legacy_root: PathBuf,
    pub primary_snapshot: PathBuf,
    pub fallback_snapshot: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationImage {
    pub source_path: PathBuf,
    pub classification_path: Vec<String>,
    pub source_url: Option<String>,
    pub custom_title: Option<String>,
    pub collected_at: Option<String>,
    pub import_batch_id: String,
    pub metadata_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationPlan {
    pub paths: LegacyMigrationPaths,
    pub images: Vec<LegacyMigrationImage>,
    pub classification_paths: Vec<Vec<String>>,
    pub metadata_matched: usize,
    pub unclassified: usize,
    pub total_bytes: u64,
    pub tree_nodes: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationProgress {
    pub processed: usize,
    pub total: usize,
    pub current_file: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationReport {
    pub planned: usize,
    pub added: usize,
    pub exact_duplicates: usize,
    pub review_pending: usize,
    pub failed: usize,
    pub metadata_matched: usize,
    pub unclassified: usize,
    pub folders_created: usize,
    pub folders_reused: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySnapshot {
    #[serde(default)]
    items: Vec<LegacyItem>,
    content_preferences: Option<LegacyContentPreferences>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyItem {
    relative_path: String,
    #[serde(default)]
    tags: Vec<String>,
    source_id: Option<String>,
    custom_title: Option<String>,
    modified_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LegacyContentPreferences {
    storage_tag_tree: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTreeNode {
    name: String,
    #[serde(default)]
    auto_tags: Vec<String>,
    #[serde(default)]
    children: Vec<LegacyTreeNode>,
}

struct TagPathIndex {
    by_tag: BTreeMap<String, Vec<Vec<String>>>,
    tree_paths: Vec<Vec<String>>,
    order: BTreeMap<String, usize>,
}

pub fn inspect_legacy_migration(
    paths: LegacyMigrationPaths,
) -> Result<LegacyMigrationPlan, LibraryError> {
    let primary = read_snapshot(&paths.primary_snapshot)?;
    let fallback = read_snapshot(&paths.fallback_snapshot)?;
    let primary_items = index_items(primary.items, "primary")?;
    let fallback_items = index_items(fallback.items, "fallback")?;
    let tag_paths = build_tag_paths(primary.content_preferences, &paths.primary_snapshot)?;
    let batch_id = uuid::Uuid::new_v4().to_string();
    let mut warnings = Vec::new();
    let mut metadata_matched = 0;
    let mut unclassified = 0;
    let mut used_paths = BTreeSet::new();
    let mut images = direct_images(&paths.legacy_root)?;
    images.sort_by_key(|path| file_key(path));
    let total_bytes = images.iter().try_fold(0_u64, |total, path| {
        fs::metadata(path)
            .map(|metadata| total.saturating_add(metadata.len()))
            .map_err(|source| LibraryError::ReadLegacyRoot {
                path: paths.legacy_root.clone(),
                source,
            })
    })?;
    let tree_nodes = tag_paths.tree_paths.len();

    let images = images
        .into_iter()
        .map(|source_path| {
            let key = file_key(&source_path);
            let (metadata, metadata_source) = if let Some(item) = primary_items.get(&key) {
                (Some(item), Some("primary".to_owned()))
            } else if let Some(item) = fallback_items.get(&key) {
                (Some(item), Some("fallback".to_owned()))
            } else {
                (None, None)
            };
            if metadata.is_some() {
                metadata_matched += 1;
            }
            let classification_path = metadata
                .map(|item| deepest_path(&item.tags, &tag_paths, &source_path, &mut warnings))
                .unwrap_or_default();
            if classification_path.is_empty() {
                unclassified += 1;
            } else {
                for depth in 1..=classification_path.len() {
                    used_paths.insert(path_key(&classification_path[..depth]));
                }
            }
            LegacyMigrationImage {
                source_path,
                classification_path,
                source_url: metadata.and_then(|item| normalized(item.source_id.clone())),
                custom_title: metadata.and_then(|item| normalized(item.custom_title.clone())),
                collected_at: metadata
                    .and_then(|item| normalize_legacy_timestamp(item.modified_at.as_deref())),
                import_batch_id: batch_id.clone(),
                metadata_source,
            }
        })
        .collect();

    let classification_paths = tag_paths
        .tree_paths
        .into_iter()
        .filter(|path| used_paths.contains(&path_key(path)))
        .collect();

    Ok(LegacyMigrationPlan {
        paths,
        images,
        classification_paths,
        metadata_matched,
        unclassified,
        total_bytes,
        tree_nodes,
        warnings,
    })
}

impl Library {
    pub fn execute_legacy_migration(
        &self,
        plan: &LegacyMigrationPlan,
        mut progress: impl FnMut(LegacyMigrationProgress),
    ) -> Result<LegacyMigrationReport, LibraryError> {
        if self.root() != plan.paths.library_root {
            return Err(LibraryError::LegacyLibraryMismatch);
        }
        let mut entries = self.list_classifications()?;
        let mut path_ids = BTreeMap::new();
        let mut folders_created = 0;
        let mut folders_reused = 0;
        for path in &plan.classification_paths {
            let parent_id = if path.len() > 1 {
                path_ids.get(&path_key(&path[..path.len() - 1])).cloned()
            } else {
                None
            };
            let name = path.last().expect("classification paths are not empty");
            let existing = entries.iter().find(|entry| {
                entry.parent_id == parent_id && entry.name.to_lowercase() == name.to_lowercase()
            });
            let id = if let Some(existing) = existing {
                folders_reused += 1;
                existing.id.clone()
            } else {
                let created = self.create_classification(CreateClassification {
                    kind: if parent_id.is_none() {
                        ClassificationKind::Root
                    } else {
                        ClassificationKind::Tag
                    },
                    name: name.clone(),
                    parent_id,
                })?;
                folders_created += 1;
                let id = created.id.clone();
                entries.push(created);
                id
            };
            path_ids.insert(path_key(path), id);
        }

        let mut report = LegacyMigrationReport {
            planned: plan.images.len(),
            added: 0,
            exact_duplicates: 0,
            review_pending: 0,
            failed: 0,
            metadata_matched: plan.metadata_matched,
            unclassified: plan.unclassified,
            folders_created,
            folders_reused,
            warnings: plan.warnings.clone(),
        };
        for (index, image) in plan.images.iter().enumerate() {
            let (creator_handle, creator_url) =
                creator_from_source_url(image.source_url.as_deref());
            let classification_id = if image.classification_path.is_empty() {
                None
            } else {
                path_ids.get(&path_key(&image.classification_path)).cloned()
            };
            let outcome = self.ingest_media(IngestMediaRequest {
                source_path: image.source_path.clone(),
                classification_id,
                source_url: image.source_url.clone(),
                collected_at: image.collected_at.clone(),
                replace_duplicate_metadata: true,
                source_published_at: None,
                creator_name: None,
                creator_handle,
                creator_url,
                import_source: ImportSource::LegacyLakomics,
                import_batch_id: image.import_batch_id.clone(),
            });
            match outcome {
                Ok(IngestOutcome::Added { asset }) => {
                    report.added += 1;
                    self.apply_legacy_title(&asset.id, image.custom_title.as_deref())?;
                }
                Ok(IngestOutcome::ExactDuplicate {
                    existing_asset_id, ..
                }) => {
                    report.exact_duplicates += 1;
                    self.apply_legacy_title(&existing_asset_id, image.custom_title.as_deref())?;
                }
                Ok(IngestOutcome::ReviewPending { .. }) => report.review_pending += 1,
                Err(error) => {
                    report.failed += 1;
                    report
                        .warnings
                        .push(format!("{}: {error}", image.source_path.display()));
                }
            }
            progress(LegacyMigrationProgress {
                processed: index + 1,
                total: plan.images.len(),
                current_file: image
                    .source_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_owned(),
            });
        }
        Ok(report)
    }

    fn apply_legacy_title(&self, asset_id: &str, title: Option<&str>) -> Result<(), LibraryError> {
        let Some(title) = title else {
            return Ok(());
        };
        self.connection()?.execute(
            "UPDATE assets SET title = ?2 WHERE id = ?1 AND title IS NOT ?2",
            rusqlite::params![asset_id, title],
        )?;
        Ok(())
    }
}

fn read_snapshot(path: &Path) -> Result<LegacySnapshot, LibraryError> {
    let bytes = fs::read(path).map_err(|source| LibraryError::ReadLegacySnapshot {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_slice(&bytes).map_err(|_| LibraryError::InvalidLegacySnapshot {
        path: path.to_path_buf(),
    })
}

fn index_items(
    items: Vec<LegacyItem>,
    snapshot_name: &str,
) -> Result<BTreeMap<String, LegacyItem>, LibraryError> {
    let mut indexed = BTreeMap::new();
    for item in items {
        let key = Path::new(&item.relative_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&item.relative_path)
            .to_lowercase();
        if indexed.insert(key.clone(), item).is_some() {
            return Err(LibraryError::DuplicateLegacyMetadata(format!(
                "{snapshot_name}:{key}"
            )));
        }
    }
    Ok(indexed)
}

fn build_tag_paths(
    preferences: Option<LegacyContentPreferences>,
    snapshot_path: &Path,
) -> Result<TagPathIndex, LibraryError> {
    let Some(tree_json) = preferences.and_then(|value| value.storage_tag_tree) else {
        return Ok(TagPathIndex {
            by_tag: BTreeMap::new(),
            tree_paths: Vec::new(),
            order: BTreeMap::new(),
        });
    };
    let roots: Vec<LegacyTreeNode> =
        serde_json::from_str(&tree_json).map_err(|_| LibraryError::InvalidLegacySnapshot {
            path: snapshot_path.to_path_buf(),
        })?;
    let mut index = TagPathIndex {
        by_tag: BTreeMap::new(),
        tree_paths: Vec::new(),
        order: BTreeMap::new(),
    };
    for root in roots {
        visit_tree(root, &[], &mut index);
    }
    Ok(index)
}

fn visit_tree(node: LegacyTreeNode, parent: &[String], index: &mut TagPathIndex) {
    let mut path = parent.to_vec();
    path.push(node.name);
    index.order.insert(path_key(&path), index.tree_paths.len());
    index.tree_paths.push(path.clone());
    for tag in node.auto_tags {
        index.by_tag.entry(tag).or_default().push(path.clone());
    }
    for child in node.children {
        visit_tree(child, &path, index);
    }
}

fn deepest_path(
    tags: &[String],
    index: &TagPathIndex,
    source_path: &Path,
    warnings: &mut Vec<String>,
) -> Vec<String> {
    let mut candidates: Vec<&Vec<String>> = tags
        .iter()
        .filter_map(|tag| index.by_tag.get(tag))
        .flatten()
        .collect();
    let maximum = candidates.iter().map(|path| path.len()).max().unwrap_or(0);
    candidates.retain(|path| path.len() == maximum);
    candidates.sort_by_key(|path| {
        index
            .order
            .get(&path_key(path))
            .copied()
            .unwrap_or(usize::MAX)
    });
    candidates.dedup_by(|left, right| path_key(left) == path_key(right));
    if candidates.len() > 1 {
        warnings.push(format!(
            "동일 깊이 분류가 여러 개라 트리의 첫 경로를 사용했습니다: {}",
            source_path.display()
        ));
    }
    candidates
        .first()
        .map(|path| (*path).clone())
        .unwrap_or_default()
}

fn direct_images(root: &Path) -> Result<Vec<PathBuf>, LibraryError> {
    let entries = fs::read_dir(root).map_err(|source| LibraryError::ReadLegacyRoot {
        path: root.to_path_buf(),
        source,
    })?;
    let mut images = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| LibraryError::ReadLegacyRoot {
            path: root.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        if entry
            .file_type()
            .map_err(|source| LibraryError::ReadLegacyRoot {
                path: root.to_path_buf(),
                source,
            })?
            .is_file()
            && is_supported_image(&path)
        {
            images.push(path);
        }
    }
    Ok(images)
}

fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| IMAGE_EXTENSIONS.contains(&value.to_ascii_lowercase().as_str()))
}

fn file_key(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_lowercase()
}

fn path_key(path: &[String]) -> String {
    path.iter()
        .map(|part| part.to_lowercase())
        .collect::<Vec<_>>()
        .join("\0")
}

fn normalized(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

fn normalize_legacy_timestamp(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if chrono::DateTime::parse_from_rfc3339(value).is_ok() {
        return Some(value.to_owned());
    }
    let naive = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    use chrono::TimeZone as _;
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .map(|timestamp| timestamp.to_rfc3339())
}

pub(super) fn creator_from_source_url(
    source_url: Option<&str>,
) -> (Option<String>, Option<String>) {
    let Some(url) = source_url.and_then(|value| url::Url::parse(value).ok()) else {
        return (None, None);
    };
    if !matches!(
        url.host_str(),
        Some("x.com" | "www.x.com" | "twitter.com" | "www.twitter.com")
    ) {
        return (None, None);
    }
    let segments = url.path_segments().map(Iterator::collect::<Vec<_>>);
    let Some([handle, "status", ..]) = segments.as_deref() else {
        return (None, None);
    };
    if handle.eq_ignore_ascii_case("i") {
        return (None, None);
    }
    let handle = (*handle).to_owned();
    let profile_url = format!("https://x.com/{handle}");
    (Some(handle), Some(profile_url))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use image::{DynamicImage, ImageFormat};
    use serde_json::json;

    use super::{creator_from_source_url, inspect_legacy_migration, LegacyMigrationPaths};
    use crate::library::{
        models::{AssetQuery, AssetSort},
        Library,
    };

    #[test]
    fn combines_snapshots_and_reconstructs_the_deepest_classification_paths() {
        let temp = tempfile::tempdir().unwrap();
        let legacy_root = temp.path().join("legacy");
        fs::create_dir(&legacy_root).unwrap();
        for name in ["alpha.jpg", "beta.png", "orphan.webp", "portrait.jfif"] {
            fs::write(legacy_root.join(name), b"fixture").unwrap();
        }
        fs::create_dir(legacy_root.join("assets")).unwrap();
        fs::write(legacy_root.join("assets/ignored.png"), b"fixture").unwrap();

        let tree = json!([{
            "id": "games", "name": "게임", "autoTags": ["g:게임"], "children": [{
                "id": "reverse", "name": "리버스", "autoTags": ["s:리버스"], "children": [{
                    "id": "laplace", "name": "라플라스", "autoTags": ["c:라플라스"], "children": []
                }]
            }]
        }]);
        let primary = temp.path().join("metadata_latest.json");
        fs::write(&primary, serde_json::to_vec(&json!({
            "items": [
                { "relativePath": "alpha.jpg", "tags": ["c:라플라스"], "sourceId": "https://example.test/alpha", "customTitle": "Alpha", "modifiedAt": "2026-01-01T00:00:00Z" },
                { "relativePath": "portrait.jfif", "tags": ["g:게임"], "sourceId": null, "customTitle": null, "modifiedAt": "2026-01-02T00:00:00Z" }
            ],
            "contentPreferences": { "storage_tag_tree": tree.to_string() }
        })).unwrap()).unwrap();
        let fallback = temp.path().join("storage_metadata_latest.json");
        fs::write(&fallback, serde_json::to_vec(&json!({
            "items": [
                { "relativePath": "beta.png", "tags": ["s:리버스"], "sourceId": null, "customTitle": null, "modifiedAt": "2026-01-03T00:00:00Z" }
            ]
        })).unwrap()).unwrap();

        let plan = inspect_legacy_migration(LegacyMigrationPaths {
            library_root: temp.path().join("library"),
            legacy_root,
            primary_snapshot: primary,
            fallback_snapshot: fallback,
        })
        .unwrap();

        assert_eq!(plan.images.len(), 4);
        assert_eq!(plan.metadata_matched, 3);
        assert_eq!(plan.unclassified, 1);
        assert_eq!(
            plan.classification_paths,
            vec![
                vec![String::from("게임")],
                vec![String::from("게임"), String::from("리버스")],
                vec![
                    String::from("게임"),
                    String::from("리버스"),
                    String::from("라플라스")
                ],
            ]
        );
        assert_eq!(
            plan.images[0].import_batch_id,
            plan.images[1].import_batch_id
        );
        assert!(plan
            .images
            .iter()
            .any(|image| image.source_path.ends_with("portrait.jfif")));
    }

    #[test]
    fn execution_is_idempotent_for_assets_folders_and_custom_titles() {
        let temp = tempfile::tempdir().unwrap();
        let legacy_root = temp.path().join("legacy");
        fs::create_dir(&legacy_root).unwrap();
        DynamicImage::new_rgb8(8, 8)
            .save_with_format(legacy_root.join("alpha.png"), ImageFormat::Png)
            .unwrap();
        let tree = json!([{
            "id": "games", "name": "게임", "autoTags": ["g:게임"], "children": []
        }]);
        let primary = temp.path().join("metadata_latest.json");
        fs::write(&primary, serde_json::to_vec(&json!({
            "items": [{ "relativePath": "alpha.png", "tags": ["g:게임"], "sourceId": "https://example.test/alpha", "customTitle": "Alpha title", "modifiedAt": "2026-01-01T00:00:00Z" }],
            "contentPreferences": { "storage_tag_tree": tree.to_string() }
        })).unwrap()).unwrap();
        let fallback = temp.path().join("storage_metadata_latest.json");
        fs::write(&fallback, br#"{"items":[]}"#).unwrap();
        let library_root = temp.path().join("library");
        let plan = inspect_legacy_migration(LegacyMigrationPaths {
            library_root: library_root.clone(),
            legacy_root,
            primary_snapshot: primary,
            fallback_snapshot: fallback,
        })
        .unwrap();
        let library = Library::open(&library_root).unwrap();

        let first = library.execute_legacy_migration(&plan, |_| {}).unwrap();
        let second = library.execute_legacy_migration(&plan, |_| {}).unwrap();

        assert_eq!(
            (first.added, first.exact_duplicates, first.folders_created),
            (1, 0, 1)
        );
        assert_eq!(
            (
                second.added,
                second.exact_duplicates,
                second.folders_created
            ),
            (0, 1, 0)
        );
        assert_eq!(library.list_classifications().unwrap().len(), 1);
        let assets = library
            .list_assets(AssetQuery {
                classification_id: None,
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(assets.items.len(), 1);
        assert_eq!(assets.items[0].title.as_deref(), Some("Alpha title"));
    }

    #[test]
    fn execution_derives_creator_from_an_unambiguous_x_post_url() {
        let temp = tempfile::tempdir().unwrap();
        let legacy_root = temp.path().join("legacy");
        fs::create_dir(&legacy_root).unwrap();
        DynamicImage::new_rgb8(8, 8)
            .save_with_format(legacy_root.join("alpha.png"), ImageFormat::Png)
            .unwrap();
        let primary = temp.path().join("metadata_latest.json");
        fs::write(
            &primary,
            serde_json::to_vec(&json!({
                "items": [{
                    "relativePath": "alpha.png",
                    "tags": [],
                    "sourceId": "https://x.com/Example_Artist/status/123456789",
                    "customTitle": null,
                    "modifiedAt": "2026-01-01T00:00:00Z"
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let fallback = temp.path().join("storage_metadata_latest.json");
        fs::write(&fallback, br#"{"items":[]}"#).unwrap();
        let library_root = temp.path().join("library");
        let plan = inspect_legacy_migration(LegacyMigrationPaths {
            library_root: library_root.clone(),
            legacy_root,
            primary_snapshot: primary,
            fallback_snapshot: fallback,
        })
        .unwrap();
        let library = Library::open(&library_root).unwrap();

        library.execute_legacy_migration(&plan, |_| {}).unwrap();

        let assets = library
            .list_assets(AssetQuery {
                classification_id: None,
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            assets.items[0].creator_handle.as_deref(),
            Some("Example_Artist")
        );
        assert_eq!(
            assets.items[0].creator_url.as_deref(),
            Some("https://x.com/Example_Artist")
        );
    }

    #[test]
    fn generic_x_status_url_does_not_invent_a_creator() {
        assert_eq!(
            creator_from_source_url(Some("https://x.com/i/status/123456789")),
            (None, None)
        );
    }
}
