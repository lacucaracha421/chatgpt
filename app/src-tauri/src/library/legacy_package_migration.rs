use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
};

use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    book_migration::{scan_book_import, BookImportPlan},
    error::LibraryError,
    legacy_migration::creator_from_source_url,
    models::{
        ClassificationKind, CreateClassification, ImportSource, IngestMediaRequest, IngestOutcome,
        SimilarityDecision, SimilarityDecisionRequest,
    },
    Library,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPackagePaths {
    pub library_root: PathBuf,
    pub package_root: PathBuf,
    pub metadata_snapshot: PathBuf,
    pub book_root: PathBuf,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LegacyPackageMediaKind {
    Image,
    Video,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPackageFolder {
    pub source_folder_id: String,
    pub path: Vec<String>,
    pub display_order: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPackageItem {
    pub source_item_id: String,
    pub source_path: PathBuf,
    pub source_sha256: String,
    pub byte_length: u64,
    pub media_kind: LegacyPackageMediaKind,
    pub original_name: String,
    pub classification_paths: Vec<Vec<String>>,
    pub custom_title: Option<String>,
    pub source_url: Option<String>,
    pub collected_at: String,
    pub favorite: bool,
    pub raw_metadata_json: String,
    #[serde(skip)]
    manifest_sha256: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPackageSource {
    pub paths: LegacyPackagePaths,
    pub library_id: String,
    pub synthetic_root_id: String,
    pub folders: Vec<LegacyPackageFolder>,
    pub items: Vec<LegacyPackageItem>,
    pub image_count: usize,
    pub video_count: usize,
    pub favorite_count: usize,
    pub source_url_count: usize,
    pub custom_title_count: usize,
    pub total_bytes: u64,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPackageTargetBaseline {
    pub schema_version: i64,
    pub normal_assets: u64,
    pub collections: u64,
    pub classifications: u64,
    pub mappings: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPackagePreview {
    pub new_assets: usize,
    pub exact_target_duplicates: usize,
    pub source_duplicates: usize,
    pub already_mapped: usize,
    pub mappings_to_create: usize,
    pub folders_to_create: usize,
    pub folders_reused: usize,
    pub collections_to_create: usize,
    pub collections_existing: usize,
    pub collection_errors: usize,
    pub estimated_copy_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPackageMigrationPlan {
    pub source: LegacyPackageSource,
    pub books: BookImportPlan,
    pub target_before: LegacyPackageTargetBaseline,
    pub preview: LegacyPackagePreview,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPackageMigrationProgress {
    pub processed: usize,
    pub total: usize,
    pub current_item: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPackageMigrationFailure {
    pub source_item_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPackageMigrationReport {
    pub planned: usize,
    pub added: usize,
    pub exact_target_reused: usize,
    pub source_duplicates_reused: usize,
    pub already_mapped: usize,
    pub review_kept_both: usize,
    pub mappings_created: usize,
    pub classification_links_added: usize,
    pub folders_created: usize,
    pub folders_reused: usize,
    pub failed: usize,
    pub failures: Vec<LegacyPackageMigrationFailure>,
    pub book_collections: LegacyPackageBookCollections,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPackageBookCollections {
    pub created: usize,
    pub skipped: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryManifestWire {
    schema_version: u32,
    library_id: String,
    normal_folders: Vec<FolderWire>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderWire {
    folder_id: String,
    parent_folder_id: Option<String>,
    name: String,
    #[serde(default)]
    display_order: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemManifestWire {
    byte_length: u64,
    current_file_name: String,
    #[serde(default)]
    folder_ids: Vec<String>,
    item_id: String,
    lifecycle: String,
    media_kind: String,
    original_file_name: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataSnapshotWire {
    item_count: usize,
    items: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataItemWire {
    item_id: String,
    relative_path: String,
    modified_at: String,
    source_id: Option<String>,
    custom_title: Option<String>,
    #[serde(default)]
    is_liked: bool,
}

pub fn inspect_legacy_package_source(
    paths: &LegacyPackagePaths,
) -> Result<LegacyPackageSource, LibraryError> {
    let package_root = canonical_directory(&paths.package_root)?;
    let book_root = canonical_directory(&paths.book_root)?;
    let library_root = canonical_directory(&paths.library_root)?;
    let metadata_snapshot = canonical_file(&paths.metadata_snapshot)?;
    let library_path = canonical_file(&package_root.join("library.json"))?;
    ensure_contained(
        &library_path,
        &package_root,
        "library manifest escapes package",
    )?;

    let library_bytes = read_bytes(&library_path)?;
    let library: LibraryManifestWire = serde_json::from_slice(&library_bytes)
        .map_err(|_| invalid("library.json is not valid package JSON"))?;
    if library.schema_version != 1 || library.library_id.trim().is_empty() {
        return Err(invalid("unsupported package schema or empty library ID"));
    }
    let (synthetic_root_id, folder_paths, folders) = folder_index(library.normal_folders)?;

    let snapshot_bytes = read_bytes(&metadata_snapshot)?;
    let snapshot: MetadataSnapshotWire = serde_json::from_slice(&snapshot_bytes)
        .map_err(|_| invalid("metadata snapshot is not valid JSON"))?;
    if snapshot.item_count != snapshot.items.len() {
        return Err(invalid("metadata itemCount does not match items"));
    }
    let mut metadata = BTreeMap::<String, (MetadataItemWire, String)>::new();
    for value in snapshot.items {
        let item: MetadataItemWire = serde_json::from_value(value.clone())
            .map_err(|_| invalid("metadata item is incomplete"))?;
        if item.item_id.trim().is_empty()
            || metadata
                .insert(
                    item.item_id.clone(),
                    (
                        item,
                        serde_json::to_string(&value)
                            .map_err(|_| invalid("metadata item cannot be serialized"))?,
                    ),
                )
                .is_some()
        {
            return Err(invalid("metadata contains a duplicate or empty item ID"));
        }
    }

    let mut manifest_paths = Vec::new();
    collect_manifest_paths(&package_root.join("objects"), &mut manifest_paths)?;
    manifest_paths.sort();
    let mut seen_items = BTreeSet::new();
    let mut seen_payloads = BTreeSet::new();
    let mut items = Vec::new();
    for manifest_path in manifest_paths {
        let manifest_path = canonical_file(&manifest_path)?;
        ensure_contained(
            &manifest_path,
            &package_root,
            "item manifest escapes package",
        )?;
        let manifest_bytes = read_bytes(&manifest_path)?;
        let manifest: ItemManifestWire = serde_json::from_slice(&manifest_bytes)
            .map_err(|_| invalid("item manifest is not valid JSON"))?;
        if manifest.lifecycle != "active" {
            return Err(invalid("only active package items are supported"));
        }
        if manifest.item_id.trim().is_empty() || !seen_items.insert(manifest.item_id.clone()) {
            return Err(invalid("package contains a duplicate or empty item ID"));
        }
        validate_file_name(&manifest.current_file_name)?;
        let item_dir = manifest_path
            .parent()
            .ok_or_else(|| invalid("item manifest has no parent"))?;
        let payload = canonical_file(&item_dir.join("payload").join(&manifest.current_file_name))?;
        ensure_contained(&payload, &package_root, "payload escapes package")?;
        let payload_relative = relative_key(&package_root, &payload)?;
        if !seen_payloads.insert(payload_relative.clone()) {
            return Err(invalid("package contains a duplicate payload path"));
        }
        let (payload_sha256, payload_length) = hash_file(&payload)?;
        let source_sha256 = manifest.sha256.to_ascii_lowercase();
        if source_sha256.len() != 64
            || !source_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || payload_sha256 != source_sha256
        {
            return Err(invalid("payload SHA-256 does not match its manifest"));
        }
        if payload_length != manifest.byte_length {
            return Err(invalid("payload byte length does not match its manifest"));
        }
        let (metadata_item, raw_metadata_json) = metadata
            .remove(&manifest.item_id)
            .ok_or_else(|| invalid("package item is missing from metadata snapshot"))?;
        let snapshot_payload = contained_relative_file(
            &package_root,
            &metadata_item.relative_path,
            "metadata payload escapes package",
        )?;
        if snapshot_payload != payload {
            return Err(invalid("metadata relative path does not match payload"));
        }
        let mut classification_paths = Vec::new();
        for folder_id in manifest.folder_ids {
            if folder_id == synthetic_root_id {
                continue;
            }
            let path = folder_paths
                .get(&folder_id)
                .ok_or_else(|| invalid("item references an unknown folder ID"))?;
            classification_paths.push(path.clone());
        }
        classification_paths.sort();
        classification_paths.dedup();
        let media_kind = match manifest.media_kind.as_str() {
            "image" => LegacyPackageMediaKind::Image,
            "video" => LegacyPackageMediaKind::Video,
            _ => return Err(invalid("unsupported package media kind")),
        };
        let original_name = manifest.original_file_name.trim();
        if original_name.is_empty() {
            return Err(invalid("item original filename is empty"));
        }
        let manifest_sha256 = sha256_bytes(&manifest_bytes);
        items.push(LegacyPackageItem {
            source_item_id: manifest.item_id,
            source_path: payload,
            source_sha256,
            byte_length: payload_length,
            media_kind,
            original_name: original_name.to_owned(),
            classification_paths,
            custom_title: normalized(metadata_item.custom_title),
            source_url: normalized(metadata_item.source_id),
            collected_at: normalized_timestamp(&metadata_item.modified_at)?,
            favorite: metadata_item.is_liked,
            raw_metadata_json,
            manifest_sha256,
        });
    }
    if !metadata.is_empty() {
        return Err(invalid(
            "metadata snapshot contains items absent from package",
        ));
    }
    items.sort_by(|left, right| left.source_item_id.cmp(&right.source_item_id));
    let image_count = items
        .iter()
        .filter(|item| item.media_kind == LegacyPackageMediaKind::Image)
        .count();
    let video_count = items.len() - image_count;
    let favorite_count = items.iter().filter(|item| item.favorite).count();
    let source_url_count = items
        .iter()
        .filter(|item| item.source_url.is_some())
        .count();
    let custom_title_count = items
        .iter()
        .filter(|item| item.custom_title.is_some())
        .count();
    let total_bytes = items
        .iter()
        .fold(0_u64, |total, item| total.saturating_add(item.byte_length));
    let fingerprint = fingerprint(
        &library_bytes,
        &snapshot_bytes,
        &library.library_id,
        &folders,
        &items,
    );
    Ok(LegacyPackageSource {
        paths: LegacyPackagePaths {
            library_root,
            package_root,
            metadata_snapshot,
            book_root,
        },
        library_id: library.library_id,
        synthetic_root_id,
        folders,
        items,
        image_count,
        video_count,
        favorite_count,
        source_url_count,
        custom_title_count,
        total_bytes,
        fingerprint,
    })
}

pub fn inspect_legacy_package_migration(
    paths: &LegacyPackagePaths,
) -> Result<LegacyPackageMigrationPlan, LibraryError> {
    let mut source = inspect_legacy_package_source(paths)?;
    let books = scan_book_import(&source.paths.book_root)?;
    let book_fingerprint = fingerprint_books(&source.paths.book_root, &books)?;
    source.fingerprint = sha256_join(&[source.fingerprint.as_bytes(), book_fingerprint.as_bytes()]);

    let database_path = source.paths.library_root.join("library.sqlite");
    let connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let schema_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if !(19..=super::db::SCHEMA_VERSION).contains(&schema_version) {
        return Err(LibraryError::UnsupportedSchema(schema_version));
    }
    let table_count = |table: &str| -> Result<u64, LibraryError> {
        Ok(
            connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get::<_, i64>(0)
            })? as u64,
        )
    };
    let mappings_table = has_table(&connection, "legacy_package_asset_mappings")?;
    let target_before = LegacyPackageTargetBaseline {
        schema_version,
        normal_assets: connection.query_row(
            "SELECT COUNT(*) FROM assets WHERE status = 'normal'",
            [],
            |row| row.get::<_, i64>(0),
        )? as u64,
        collections: table_count("collections")?,
        classifications: table_count("classification_entries")?,
        mappings: if mappings_table {
            table_count("legacy_package_asset_mappings")?
        } else {
            0
        },
    };

    let mut target_hashes = BTreeSet::new();
    {
        let mut statement = connection.prepare("SELECT content_hash FROM assets")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        for row in rows {
            target_hashes.insert(row?);
        }
    }
    let target_paths = target_classification_paths(&connection)?;
    let folders_reused = source
        .folders
        .iter()
        .filter(|folder| target_paths.contains(&path_key(&folder.path)))
        .count();

    let mut target_collection_names = BTreeSet::new();
    {
        let mut statement = connection.prepare("SELECT name FROM collections")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        for row in rows {
            target_collection_names.insert(row?.to_lowercase());
        }
    }
    let collections_existing = books
        .entries
        .iter()
        .filter(|entry| target_collection_names.contains(&entry.name.to_lowercase()))
        .count();
    let already_mapped = if mappings_table {
        connection.query_row(
            "SELECT COUNT(*) FROM legacy_package_asset_mappings
             WHERE source_library_id = ?1",
            [&source.library_id],
            |row| row.get::<_, i64>(0),
        )? as usize
    } else {
        0
    };

    let mut unique_source_hashes = BTreeMap::<String, u64>::new();
    for item in &source.items {
        unique_source_hashes
            .entry(item.source_sha256.clone())
            .or_insert(item.byte_length);
    }
    let new_assets = unique_source_hashes
        .keys()
        .filter(|hash| !target_hashes.contains(*hash))
        .count();
    let exact_target_duplicates = source
        .items
        .iter()
        .filter(|item| target_hashes.contains(&item.source_sha256))
        .count();
    let estimated_copy_bytes = unique_source_hashes
        .iter()
        .filter(|(hash, _)| !target_hashes.contains(*hash))
        .fold(0_u64, |total, (_, length)| total.saturating_add(*length));
    let preview = LegacyPackagePreview {
        new_assets,
        exact_target_duplicates,
        source_duplicates: source
            .items
            .len()
            .saturating_sub(unique_source_hashes.len()),
        already_mapped,
        mappings_to_create: source.items.len().saturating_sub(already_mapped),
        folders_to_create: source.folders.len().saturating_sub(folders_reused),
        folders_reused,
        collections_to_create: books.entries.len().saturating_sub(collections_existing),
        collections_existing,
        collection_errors: books.skipped.len(),
        estimated_copy_bytes,
    };
    Ok(LegacyPackageMigrationPlan {
        source,
        books,
        target_before,
        preview,
    })
}

impl Library {
    pub fn execute_legacy_package_migration(
        &self,
        plan: &LegacyPackageMigrationPlan,
        mut progress: impl FnMut(LegacyPackageMigrationProgress),
    ) -> Result<LegacyPackageMigrationReport, LibraryError> {
        if canonical_directory(self.root())? != plan.source.paths.library_root {
            return Err(LibraryError::LegacyLibraryMismatch);
        }
        let current_source = inspect_legacy_package_source(&plan.source.paths)?;
        let current_books = scan_book_import(&current_source.paths.book_root)?;
        let current_fingerprint = sha256_join(&[
            current_source.fingerprint.as_bytes(),
            fingerprint_books(&current_source.paths.book_root, &current_books)?.as_bytes(),
        ]);
        if current_fingerprint != plan.source.fingerprint {
            return Err(invalid("source changed after the migration preview"));
        }

        let mut entries = self.list_classifications()?;
        let mut path_ids = BTreeMap::new();
        let mut folders_created = 0;
        let mut folders_reused = 0;
        for folder in &plan.source.folders {
            let parent_id = if folder.path.len() > 1 {
                Some(
                    path_ids
                        .get(&path_key(&folder.path[..folder.path.len() - 1]))
                        .cloned()
                        .ok_or_else(|| invalid("source folder parent was not planned"))?,
                )
            } else {
                None
            };
            let name = folder
                .path
                .last()
                .ok_or_else(|| invalid("source folder path is empty"))?;
            let existing = entries.iter().find(|entry| {
                entry.parent_id == parent_id && entry.name.eq_ignore_ascii_case(name)
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
            path_ids.insert(path_key(&folder.path), id);
        }

        let initial_hashes = self.legacy_package_target_hashes()?;
        let book_report = self.apply_book_import_plan(&current_books)?;
        let import_batch_id = uuid::Uuid::new_v4().to_string();
        let mut report = LegacyPackageMigrationReport {
            planned: plan.source.items.len(),
            added: 0,
            exact_target_reused: 0,
            source_duplicates_reused: 0,
            already_mapped: 0,
            review_kept_both: 0,
            mappings_created: 0,
            classification_links_added: 0,
            folders_created,
            folders_reused,
            failed: 0,
            failures: Vec::new(),
            book_collections: LegacyPackageBookCollections {
                created: book_report.created as usize,
                skipped: book_report.skipped as usize,
            },
        };
        for (index, item) in plan.source.items.iter().enumerate() {
            match self.migrate_legacy_package_item(
                &plan.source.library_id,
                item,
                &path_ids,
                &initial_hashes,
                &import_batch_id,
            ) {
                Ok(outcome) => {
                    match outcome.disposition {
                        ItemDisposition::Added => report.added += 1,
                        ItemDisposition::ExactTargetReused => report.exact_target_reused += 1,
                        ItemDisposition::SourceDuplicateReused => {
                            report.source_duplicates_reused += 1
                        }
                        ItemDisposition::AlreadyMapped => report.already_mapped += 1,
                    }
                    report.review_kept_both += outcome.review_kept_both;
                    report.mappings_created += outcome.mapping_created;
                    report.classification_links_added += outcome.classification_links_added;
                }
                Err(error) => {
                    report.failed += 1;
                    report.failures.push(LegacyPackageMigrationFailure {
                        source_item_id: item.source_item_id.clone(),
                        message: error.to_string(),
                    });
                }
            }
            progress(LegacyPackageMigrationProgress {
                processed: index + 1,
                total: plan.source.items.len(),
                current_item: item.source_item_id.clone(),
            });
        }
        Ok(report)
    }

    fn legacy_package_target_hashes(&self) -> Result<BTreeSet<String>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT content_hash FROM assets")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<Result<BTreeSet<_>, _>>()?)
    }

    fn migrate_legacy_package_item(
        &self,
        source_library_id: &str,
        item: &LegacyPackageItem,
        path_ids: &BTreeMap<String, String>,
        initial_hashes: &BTreeSet<String>,
        import_batch_id: &str,
    ) -> Result<ItemMigrationOutcome, LibraryError> {
        let mapping = self
            .connection()?
            .query_row(
                "SELECT asset_id, source_sha256
                 FROM legacy_package_asset_mappings
                 WHERE source_library_id = ?1 AND source_item_id = ?2",
                params![source_library_id, item.source_item_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((asset_id, mapped_hash)) = mapping {
            if mapped_hash != item.source_sha256 {
                return Err(invalid("an existing source mapping has a different hash"));
            }
            let (asset_hash, status) = self.asset_hash_and_status(&asset_id)?;
            if asset_hash != item.source_sha256 {
                return Err(invalid("a mapped target asset has a different hash"));
            }
            let review_kept_both = self.ensure_migration_asset_normal(&asset_id, &status)?;
            let classification_links_added = self.merge_legacy_package_metadata(
                source_library_id,
                item,
                &asset_id,
                path_ids,
                false,
                true,
            )?;
            return Ok(ItemMigrationOutcome {
                disposition: ItemDisposition::AlreadyMapped,
                review_kept_both,
                mapping_created: 0,
                classification_links_added,
            });
        }

        let existing = self
            .connection()?
            .query_row(
                "SELECT id, status FROM assets WHERE content_hash = ?1",
                [&item.source_sha256],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let (asset_id, added, review_kept_both) = if let Some((asset_id, status)) = existing {
            let review_kept_both = self.ensure_migration_asset_normal(&asset_id, &status)?;
            (asset_id, false, review_kept_both)
        } else {
            let (creator_handle, creator_url) = creator_from_source_url(item.source_url.as_deref());
            match self.ingest_media(IngestMediaRequest {
                source_path: item.source_path.clone(),
                classification_id: None,
                source_url: item.source_url.clone(),
                collected_at: Some(item.collected_at.clone()),
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle,
                creator_url,
                import_source: ImportSource::LegacyLakomics,
                import_batch_id: import_batch_id.to_owned(),
            })? {
                IngestOutcome::Added { asset } => (asset.id, true, 0),
                IngestOutcome::ExactDuplicate {
                    existing_asset_id, ..
                } => (existing_asset_id, false, 0),
                IngestOutcome::ReviewPending { review_id } => {
                    let candidate_id = self.connection()?.query_row(
                        "SELECT candidate_asset_id FROM similarity_reviews WHERE id = ?1",
                        [&review_id],
                        |row| row.get::<_, String>(0),
                    )?;
                    self.decide_similarity_review(SimilarityDecisionRequest {
                        review_id,
                        decision: SimilarityDecision::KeepBoth,
                    })?;
                    (candidate_id, true, 1)
                }
            }
        };
        let disposition = if added {
            ItemDisposition::Added
        } else if initial_hashes.contains(&item.source_sha256) {
            ItemDisposition::ExactTargetReused
        } else {
            ItemDisposition::SourceDuplicateReused
        };
        let classification_links_added = self.merge_legacy_package_metadata(
            source_library_id,
            item,
            &asset_id,
            path_ids,
            added,
            false,
        )?;
        Ok(ItemMigrationOutcome {
            disposition,
            review_kept_both,
            mapping_created: 1,
            classification_links_added,
        })
    }

    fn asset_hash_and_status(&self, asset_id: &str) -> Result<(String, String), LibraryError> {
        self.connection()?
            .query_row(
                "SELECT content_hash, status FROM assets WHERE id = ?1",
                [asset_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| invalid("a mapped target asset is missing"))
    }

    fn ensure_migration_asset_normal(
        &self,
        asset_id: &str,
        status: &str,
    ) -> Result<usize, LibraryError> {
        match status {
            "normal" => Ok(0),
            "trash" => {
                self.restore_asset(asset_id)?;
                Ok(0)
            }
            "review" => {
                let review_id = self
                    .connection()?
                    .query_row(
                        "SELECT id FROM similarity_reviews
                         WHERE candidate_asset_id = ?1 AND status = 'open'",
                        [asset_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .ok_or_else(|| invalid("a review asset has no open similarity review"))?;
                self.decide_similarity_review(SimilarityDecisionRequest {
                    review_id,
                    decision: SimilarityDecision::KeepBoth,
                })?;
                Ok(1)
            }
            _ => Err(invalid("a target asset has an unknown status")),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn merge_legacy_package_metadata(
        &self,
        source_library_id: &str,
        item: &LegacyPackageItem,
        asset_id: &str,
        path_ids: &BTreeMap<String, String>,
        replace_original_name: bool,
        mapping_exists: bool,
    ) -> Result<usize, LibraryError> {
        let mut classification_ids = BTreeSet::new();
        for path in &item.classification_paths {
            classification_ids.insert(
                path_ids
                    .get(&path_key(path))
                    .cloned()
                    .ok_or_else(|| invalid("an item classification was not planned"))?,
            );
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        if item.favorite {
            transaction.execute(
                "UPDATE assets SET favorite = 1 WHERE id = ?1 AND favorite = 0",
                [asset_id],
            )?;
        }
        if let Some(title) = item.custom_title.as_deref() {
            transaction.execute(
                "UPDATE assets SET title = ?2
                 WHERE id = ?1 AND (title IS NULL OR trim(title) = '')",
                params![asset_id, title],
            )?;
        }
        if let Some(source_url) = item.source_url.as_deref() {
            let (creator_handle, creator_url) = creator_from_source_url(Some(source_url));
            transaction.execute(
                "UPDATE assets
                 SET source_url = ?2,
                     creator_handle = COALESCE(creator_handle, ?3),
                     creator_url = COALESCE(creator_url, ?4)
                 WHERE id = ?1 AND (source_url IS NULL OR trim(source_url) = '')",
                params![asset_id, source_url, creator_handle, creator_url],
            )?;
        }
        let current_collected_at: String = transaction.query_row(
            "SELECT collected_at FROM assets WHERE id = ?1",
            [asset_id],
            |row| row.get(0),
        )?;
        if timestamp_is_earlier(&item.collected_at, &current_collected_at) {
            transaction.execute(
                "UPDATE assets SET collected_at = ?2 WHERE id = ?1",
                params![asset_id, item.collected_at],
            )?;
        }
        if replace_original_name {
            transaction.execute(
                "UPDATE assets SET original_name = ?2 WHERE id = ?1",
                params![asset_id, item.original_name],
            )?;
        }
        let mut classification_links_added = 0;
        for classification_id in classification_ids {
            classification_links_added += transaction.execute(
                "INSERT OR IGNORE INTO asset_classifications (asset_id, classification_id)
                 VALUES (?1, ?2)",
                params![asset_id, classification_id],
            )?;
        }
        if !mapping_exists {
            transaction.execute(
                "INSERT INTO legacy_package_asset_mappings (
                    source_library_id, source_item_id, asset_id, source_sha256,
                    raw_metadata_json, imported_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    source_library_id,
                    item.source_item_id,
                    asset_id,
                    item.source_sha256,
                    item.raw_metadata_json,
                    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                ],
            )?;
        }
        transaction.commit()?;
        Ok(classification_links_added)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ItemDisposition {
    Added,
    ExactTargetReused,
    SourceDuplicateReused,
    AlreadyMapped,
}

struct ItemMigrationOutcome {
    disposition: ItemDisposition,
    review_kept_both: usize,
    mapping_created: usize,
    classification_links_added: usize,
}

fn timestamp_is_earlier(candidate: &str, current: &str) -> bool {
    match (
        DateTime::parse_from_rfc3339(candidate),
        DateTime::parse_from_rfc3339(current),
    ) {
        (Ok(candidate), Ok(current)) => candidate < current,
        _ => false,
    }
}

fn fingerprint_books(root: &Path, plan: &BookImportPlan) -> Result<String, LibraryError> {
    let mut hasher = Sha256::new();
    for entry in &plan.entries {
        let folder = contained_relative_directory(root, &entry.relative_path)?;
        let info = canonical_file(&folder.join("info.txt"))?;
        ensure_contained(&info, root, "book info.txt escapes book root")?;
        let bytes = read_bytes(&info)?;
        fingerprint_field(&mut hasher, entry.relative_path.as_bytes());
        fingerprint_field(&mut hasher, entry.name.as_bytes());
        fingerprint_field(&mut hasher, sha256_bytes(&bytes).as_bytes());
    }
    for skipped in &plan.skipped {
        fingerprint_field(&mut hasher, skipped.folder.as_bytes());
        fingerprint_field(&mut hasher, skipped.message.as_bytes());
    }
    Ok(hex(hasher.finalize().as_slice()))
}

fn contained_relative_directory(root: &Path, relative: &str) -> Result<PathBuf, LibraryError> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(invalid("book folder path is unsafe"));
    }
    let canonical = canonical_directory(&root.join(path))?;
    ensure_contained(&canonical, root, "book folder escapes book root")?;
    Ok(canonical)
}

fn has_table(connection: &Connection, table: &str) -> Result<bool, LibraryError> {
    Ok(connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
         )",
        [table],
        |row| row.get(0),
    )?)
}

fn target_classification_paths(connection: &Connection) -> Result<BTreeSet<String>, LibraryError> {
    let mut entries = BTreeMap::<String, (String, Option<String>)>::new();
    let mut statement =
        connection.prepare("SELECT id, name, parent_id FROM classification_entries")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    for row in rows {
        let (id, name, parent_id) = row?;
        entries.insert(id, (name, parent_id));
    }
    let mut paths = BTreeSet::new();
    for id in entries.keys() {
        let mut current = Some(id.as_str());
        let mut seen = BTreeSet::new();
        let mut names = Vec::new();
        while let Some(entry_id) = current {
            if !seen.insert(entry_id.to_owned()) {
                return Err(invalid("target classification hierarchy contains a cycle"));
            }
            let (name, parent_id) = entries
                .get(entry_id)
                .ok_or_else(|| invalid("target classification parent is missing"))?;
            names.push(name.clone());
            current = parent_id.as_deref();
        }
        names.reverse();
        paths.insert(path_key(&names));
    }
    Ok(paths)
}

fn path_key(path: &[String]) -> String {
    path.join("\0").to_lowercase()
}

fn sha256_join(fields: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for field in fields {
        fingerprint_field(&mut hasher, field);
    }
    hex(hasher.finalize().as_slice())
}

fn folder_index(
    folders: Vec<FolderWire>,
) -> Result<
    (
        String,
        BTreeMap<String, Vec<String>>,
        Vec<LegacyPackageFolder>,
    ),
    LibraryError,
> {
    let mut by_id = BTreeMap::new();
    for folder in folders {
        if folder.folder_id.trim().is_empty()
            || folder.name.trim().is_empty()
            || by_id.insert(folder.folder_id.clone(), folder).is_some()
        {
            return Err(invalid("folder IDs and names must be unique and nonempty"));
        }
    }
    let roots: Vec<_> = by_id
        .values()
        .filter(|folder| folder.parent_folder_id.is_none())
        .collect();
    if roots.len() != 1 {
        return Err(invalid("package must contain exactly one synthetic root"));
    }
    let synthetic_root_id = roots[0].folder_id.clone();
    let mut paths = BTreeMap::new();
    for id in by_id.keys() {
        let mut seen = BTreeSet::new();
        let mut names = Vec::new();
        let mut current = id.as_str();
        loop {
            if !seen.insert(current.to_owned()) {
                return Err(invalid("folder hierarchy contains a cycle"));
            }
            let folder = by_id
                .get(current)
                .ok_or_else(|| invalid("folder parent does not exist"))?;
            if folder.folder_id == synthetic_root_id {
                break;
            }
            names.push(folder.name.trim().to_owned());
            current = folder
                .parent_folder_id
                .as_deref()
                .ok_or_else(|| invalid("folder does not descend from synthetic root"))?;
        }
        names.reverse();
        paths.insert(id.clone(), names);
    }
    let mut output: Vec<_> = by_id
        .values()
        .filter(|folder| folder.folder_id != synthetic_root_id)
        .map(|folder| LegacyPackageFolder {
            source_folder_id: folder.folder_id.clone(),
            path: paths.get(&folder.folder_id).cloned().unwrap_or_default(),
            display_order: folder.display_order,
        })
        .collect();
    output.sort_by(|left, right| {
        left.path
            .len()
            .cmp(&right.path.len())
            .then_with(|| left.display_order.cmp(&right.display_order))
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.source_folder_id.cmp(&right.source_folder_id))
    });
    Ok((synthetic_root_id, paths, output))
}

fn collect_manifest_paths(root: &Path, output: &mut Vec<PathBuf>) -> Result<(), LibraryError> {
    let entries = fs::read_dir(root).map_err(|source| LibraryError::ReadLegacyPackage {
        path: root.to_path_buf(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| LibraryError::ReadLegacyPackage {
            path: root.to_path_buf(),
            source,
        })?;
        let file_type = entry
            .file_type()
            .map_err(|source| LibraryError::ReadLegacyPackage {
                path: entry.path(),
                source,
            })?;
        if file_type.is_symlink() {
            return Err(invalid("package object tree contains a symlink"));
        }
        if file_type.is_dir() {
            collect_manifest_paths(&entry.path(), output)?;
        } else if file_type.is_file()
            && entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("manifest.json")
            && entry
                .path()
                .parent()
                .and_then(Path::extension)
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("item"))
        {
            output.push(entry.path());
        }
    }
    Ok(())
}

fn canonical_directory(path: &Path) -> Result<PathBuf, LibraryError> {
    let canonical = fs::canonicalize(path).map_err(|source| LibraryError::ReadLegacyPackage {
        path: path.to_path_buf(),
        source,
    })?;
    if !canonical.is_dir() {
        return Err(invalid("required package path is not a directory"));
    }
    Ok(canonical)
}

fn canonical_file(path: &Path) -> Result<PathBuf, LibraryError> {
    let canonical = fs::canonicalize(path).map_err(|source| LibraryError::ReadLegacyPackage {
        path: path.to_path_buf(),
        source,
    })?;
    if !canonical.is_file() {
        return Err(invalid("required package path is not a file"));
    }
    Ok(canonical)
}

fn contained_relative_file(
    root: &Path,
    relative: &str,
    message: &str,
) -> Result<PathBuf, LibraryError> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(invalid(message));
    }
    let canonical = canonical_file(&root.join(path))?;
    ensure_contained(&canonical, root, message)?;
    Ok(canonical)
}

fn ensure_contained(path: &Path, root: &Path, message: &str) -> Result<(), LibraryError> {
    if path.starts_with(root) {
        Ok(())
    } else {
        Err(invalid(message))
    }
}

fn validate_file_name(value: &str) -> Result<(), LibraryError> {
    let mut components = Path::new(value).components();
    if value.is_empty()
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(invalid("payload filename is unsafe"));
    }
    Ok(())
}

fn relative_key(root: &Path, path: &Path) -> Result<String, LibraryError> {
    path.strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| invalid("package path is not contained"))
}

fn read_bytes(path: &Path) -> Result<Vec<u8>, LibraryError> {
    fs::read(path).map_err(|source| LibraryError::ReadLegacyPackage {
        path: path.to_path_buf(),
        source,
    })
}

fn hash_file(path: &Path) -> Result<(String, u64), LibraryError> {
    let mut file = File::open(path).map_err(|source| LibraryError::ReadLegacyPackage {
        path: path.to_path_buf(),
        source,
    })?;
    let mut hasher = Sha256::new();
    let mut length = 0_u64;
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|source| LibraryError::ReadLegacyPackage {
                path: path.to_path_buf(),
                source,
            })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        length = length.saturating_add(read as u64);
    }
    Ok((hex(hasher.finalize().as_slice()), length))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex(Sha256::digest(bytes).as_slice())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn normalized(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

fn normalized_timestamp(value: &str) -> Result<String, LibraryError> {
    if let Ok(value) = DateTime::parse_from_rfc3339(value) {
        return Ok(value
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true));
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(value) = NaiveDateTime::parse_from_str(value, format) {
            return Ok(value.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true));
        }
    }
    Err(invalid("metadata collection date is invalid"))
}

fn fingerprint(
    library_bytes: &[u8],
    snapshot_bytes: &[u8],
    library_id: &str,
    folders: &[LegacyPackageFolder],
    items: &[LegacyPackageItem],
) -> String {
    let mut hasher = Sha256::new();
    fingerprint_field(&mut hasher, sha256_bytes(library_bytes).as_bytes());
    fingerprint_field(&mut hasher, sha256_bytes(snapshot_bytes).as_bytes());
    fingerprint_field(&mut hasher, library_id.as_bytes());
    for folder in folders {
        fingerprint_field(&mut hasher, folder.source_folder_id.as_bytes());
        fingerprint_field(&mut hasher, folder.path.join("\0").as_bytes());
        fingerprint_field(&mut hasher, folder.display_order.to_string().as_bytes());
    }
    for item in items {
        fingerprint_field(&mut hasher, item.source_item_id.as_bytes());
        fingerprint_field(&mut hasher, item.source_sha256.as_bytes());
        fingerprint_field(&mut hasher, item.byte_length.to_string().as_bytes());
        fingerprint_field(&mut hasher, item.manifest_sha256.as_bytes());
    }
    hex(hasher.finalize().as_slice())
}

fn fingerprint_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn invalid(message: impl Into<String>) -> LibraryError {
    LibraryError::InvalidLegacyPackage(message.into())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use image::{DynamicImage, ImageFormat};
    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::*;

    struct Fixture {
        _temp: tempfile::TempDir,
        paths: LegacyPackagePaths,
        first_manifest: PathBuf,
        first_payload: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let package_root = temp.path().join("Legacy.library");
            let book_root = temp.path().join("book");
            let library_root = temp.path().join("target");
            fs::create_dir_all(&package_root).unwrap();
            fs::create_dir_all(&book_root).unwrap();
            fs::create_dir_all(&library_root).unwrap();
            fs::write(
                package_root.join("library.json"),
                serde_json::to_vec_pretty(&json!({
                    "schemaVersion": 1,
                    "libraryId": "legacy-library",
                    "normalFolders": [
                        {"folderId": "root", "name": "저장소", "displayOrder": 0},
                        {"folderId": "games", "parentFolderId": "root", "name": "게임", "displayOrder": 0},
                        {"folderId": "blue", "parentFolderId": "games", "name": "블아", "displayOrder": 0}
                    ]
                }))
                .unwrap(),
            )
            .unwrap();

            let first_bytes = tiny_png();
            let first = write_item(
                &package_root,
                "item-1",
                "image",
                "one.png",
                &first_bytes,
                &["blue"],
            );
            write_item(
                &package_root,
                "item-2",
                "video",
                "two.mp4",
                b"second video",
                &["games"],
            );
            let metadata_snapshot = temp.path().join("storage_metadata_latest.json");
            fs::write(
                &metadata_snapshot,
                serde_json::to_vec_pretty(&json!({
                    "version": 1,
                    "itemCount": 2,
                    "items": [
                        {
                            "itemId": "item-1",
                            "relativePath": "objects/it/item-1.item/payload/one.png",
                            "modifiedAt": "2026-03-15T17:13:30",
                            "tags": ["s:블아"],
                            "sourceId": "https://x.com/user/status/1",
                            "customTitle": "제목",
                            "isLiked": true
                        },
                        {
                            "itemId": "item-2",
                            "relativePath": "objects/it/item-2.item/payload/two.mp4",
                            "modifiedAt": "2026-03-16T10:00:00Z",
                            "tags": [],
                            "sourceId": null,
                            "customTitle": null,
                            "isLiked": false
                        }
                    ]
                }))
                .unwrap(),
            )
            .unwrap();
            Self {
                paths: LegacyPackagePaths {
                    library_root,
                    package_root,
                    metadata_snapshot,
                    book_root,
                },
                first_manifest: first.0,
                first_payload: first.1,
                _temp: temp,
            }
        }
    }

    fn write_item(
        package_root: &std::path::Path,
        item_id: &str,
        media_kind: &str,
        file_name: &str,
        bytes: &[u8],
        folder_ids: &[&str],
    ) -> (PathBuf, PathBuf) {
        let item_dir = package_root
            .join("objects/it")
            .join(format!("{item_id}.item"));
        let payload_dir = item_dir.join("payload");
        fs::create_dir_all(&payload_dir).unwrap();
        let payload = payload_dir.join(file_name);
        fs::write(&payload, bytes).unwrap();
        let hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let manifest = item_dir.join("manifest.json");
        fs::write(
            &manifest,
            serde_json::to_vec_pretty(&json!({
                "byteLength": bytes.len(),
                "currentFileName": file_name,
                "folderIds": folder_ids,
                "itemId": item_id,
                "lifecycle": "active",
                "mediaKind": media_kind,
                "originalFileName": file_name,
                "sha256": hash
            }))
            .unwrap(),
        )
        .unwrap();
        (manifest, payload)
    }

    fn tiny_png() -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        DynamicImage::new_rgb8(8, 8)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    #[test]
    fn parses_and_fingerprints_a_complete_object_package() {
        let fixture = Fixture::new();

        let source = inspect_legacy_package_source(&fixture.paths).unwrap();

        assert_eq!(source.library_id, "legacy-library");
        assert_eq!(source.items.len(), 2);
        assert_eq!((source.image_count, source.video_count), (1, 1));
        assert_eq!(source.folders.len(), 2);
        assert_eq!(source.items[0].classification_paths, [vec!["게임", "블아"]]);
        assert_eq!(source.items[0].custom_title.as_deref(), Some("제목"));
        assert_eq!(
            source.items[0].source_url.as_deref(),
            Some("https://x.com/user/status/1")
        );
        assert!(source.items[0].favorite);
        assert_eq!(source.fingerprint.len(), 64);
    }

    #[test]
    fn rejects_payload_hash_and_length_mismatches() {
        for mutation in ["hash", "length"] {
            let fixture = Fixture::new();
            let mut manifest: serde_json::Value =
                serde_json::from_slice(&fs::read(&fixture.first_manifest).unwrap()).unwrap();
            if mutation == "hash" {
                manifest["sha256"] = json!("0".repeat(64));
            } else {
                manifest["byteLength"] = json!(999);
            }
            fs::write(
                &fixture.first_manifest,
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();

            assert!(
                inspect_legacy_package_source(&fixture.paths).is_err(),
                "{mutation}"
            );
        }
    }

    #[test]
    fn rejects_missing_or_duplicate_snapshot_items() {
        for mutation in ["missing", "duplicate"] {
            let fixture = Fixture::new();
            let mut snapshot: serde_json::Value =
                serde_json::from_slice(&fs::read(&fixture.paths.metadata_snapshot).unwrap())
                    .unwrap();
            if mutation == "missing" {
                snapshot["items"].as_array_mut().unwrap().pop();
            } else {
                let duplicate = snapshot["items"][0].clone();
                snapshot["items"].as_array_mut().unwrap().push(duplicate);
            }
            fs::write(
                &fixture.paths.metadata_snapshot,
                serde_json::to_vec(&snapshot).unwrap(),
            )
            .unwrap();

            assert!(
                inspect_legacy_package_source(&fixture.paths).is_err(),
                "{mutation}"
            );
        }
    }

    #[test]
    fn rejects_missing_folders_and_folder_cycles() {
        for mutation in ["missing", "cycle"] {
            let fixture = Fixture::new();
            if mutation == "missing" {
                let mut manifest: serde_json::Value =
                    serde_json::from_slice(&fs::read(&fixture.first_manifest).unwrap()).unwrap();
                manifest["folderIds"] = json!(["absent"]);
                fs::write(
                    &fixture.first_manifest,
                    serde_json::to_vec(&manifest).unwrap(),
                )
                .unwrap();
            } else {
                let path = fixture.paths.package_root.join("library.json");
                let mut library: serde_json::Value =
                    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                library["normalFolders"][0]["parentFolderId"] = json!("blue");
                fs::write(path, serde_json::to_vec(&library).unwrap()).unwrap();
            }

            assert!(
                inspect_legacy_package_source(&fixture.paths).is_err(),
                "{mutation}"
            );
        }
    }

    #[test]
    fn rejects_payload_paths_outside_the_package() {
        let fixture = Fixture::new();
        let outside = fixture
            .paths
            .package_root
            .parent()
            .unwrap()
            .join("outside.png");
        fs::write(&outside, b"outside").unwrap();
        fs::remove_file(&fixture.first_payload).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, &fixture.first_payload).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &fixture.first_payload).unwrap();

        assert!(inspect_legacy_package_source(&fixture.paths).is_err());
    }

    #[test]
    fn a_source_mutation_changes_the_fingerprint() {
        let fixture = Fixture::new();
        let before = inspect_legacy_package_source(&fixture.paths)
            .unwrap()
            .fingerprint;
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&fixture.first_manifest).unwrap()).unwrap();
        manifest["originalFileName"] = json!("renamed.png");
        fs::write(
            &fixture.first_manifest,
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let after = inspect_legacy_package_source(&fixture.paths)
            .unwrap()
            .fingerprint;
        assert_ne!(before, after);
    }

    #[test]
    fn dry_run_preview_is_read_only() {
        let fixture = Fixture::new();
        for (folder, title) in [("Blue Archive", "Blue Archive"), ("Naruto", "나루토")] {
            let path = fixture.paths.book_root.join(folder);
            fs::create_dir(&path).unwrap();
            fs::write(
                path.join("info.txt"),
                format!("Title: {title}\nType: manga\n"),
            )
            .unwrap();
        }
        let source = inspect_legacy_package_source(&fixture.paths).unwrap();
        let first_hash = source.items[0].source_sha256.clone();
        let library = crate::library::Library::open(&fixture.paths.library_root).unwrap();
        library
            .create_classification(crate::library::models::CreateClassification {
                kind: crate::library::models::ClassificationKind::Root,
                name: "게임".into(),
                parent_id: None,
            })
            .unwrap();
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at,
                    favorite, status
                 ) VALUES (
                    'existing-asset', ?1, 'image', 'existing.png',
                    'assets/existing.png', 'thumbnails/existing.webp',
                    1, 1, 1, '2026-08-22T00:00:00Z', 0, 'normal'
                 )",
                [first_hash],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, showcase,
                    created_at, updated_at
                 ) VALUES (
                    'existing-collection', 'blue archive', NULL, 'manga', NULL, 0,
                    '2026-08-22T00:00:00Z', '2026-08-22T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        drop(connection);
        drop(library);
        let database = fixture.paths.library_root.join("library.sqlite");
        let before_database = fs::read(&database).unwrap();
        let backup_count = fs::read_dir(fixture.paths.library_root.join("backups"))
            .map(|entries| entries.count())
            .unwrap_or(0);

        let plan = inspect_legacy_package_migration(&fixture.paths).unwrap();

        assert_eq!(plan.preview.new_assets, 1);
        assert_eq!(plan.preview.exact_target_duplicates, 1);
        assert_eq!(plan.preview.folders_reused, 1);
        assert_eq!(plan.preview.folders_to_create, 1);
        assert_eq!(plan.preview.collections_existing, 1);
        assert_eq!(plan.preview.collections_to_create, 1);
        assert_eq!(plan.target_before.normal_assets, 1);
        assert_eq!(fs::read(&database).unwrap(), before_database);
        assert_eq!(
            fs::read_dir(fixture.paths.library_root.join("backups"))
                .map(|entries| entries.count())
                .unwrap_or(0),
            backup_count
        );
    }

    #[test]
    fn execution_is_additive_and_idempotent() {
        let fixture = Fixture::new();
        for (folder, title) in [("Blue Archive", "Blue Archive"), ("Naruto", "나루토")] {
            let path = fixture.paths.book_root.join(folder);
            fs::create_dir(&path).unwrap();
            fs::write(
                path.join("info.txt"),
                format!("Title: {title}\nType: manga\n"),
            )
            .unwrap();
        }
        let source = inspect_legacy_package_source(&fixture.paths).unwrap();
        let video_hash = source.items[1].source_sha256.clone();
        let library = crate::library::Library::open(&fixture.paths.library_root).unwrap();
        let existing_folder = library
            .create_classification(crate::library::models::CreateClassification {
                kind: crate::library::models::ClassificationKind::Root,
                name: "기존 분류".into(),
                parent_id: None,
            })
            .unwrap();
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, title, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, source_url,
                    collected_at, favorite, status
                 ) VALUES (
                    'existing-video', ?1, 'video', '기존 제목', 'existing.mp4',
                    'assets/existing.mp4', NULL, 12, 1, 1, 'https://keep.example',
                    '2026-08-22T00:00:00Z', 0, 'normal'
                 )",
                [video_hash],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_classifications (asset_id, classification_id)
                 VALUES ('existing-video', ?1)",
                [&existing_folder.id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, showcase,
                    created_at, updated_at
                 ) VALUES (
                    'existing-collection', 'blue archive', '보존', 'manga', NULL, 0,
                    '2026-08-22T00:00:00Z', '2026-08-22T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        drop(connection);
        let plan = inspect_legacy_package_migration(&fixture.paths).unwrap();
        let mut progress = Vec::new();

        let first = library
            .execute_legacy_package_migration(&plan, |value| progress.push(value))
            .unwrap();

        assert_eq!(first.added, 1);
        assert_eq!(first.exact_target_reused, 1);
        assert_eq!(first.mappings_created, 2);
        assert_eq!(first.failed, 0);
        assert_eq!(first.book_collections.created, 1);
        assert_eq!(first.book_collections.skipped, 1);
        assert_eq!(progress.len(), 2);
        let connection = library.connection().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM assets", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM legacy_package_asset_mappings",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );
        let imported: (String, String, i64) = connection
            .query_row(
                "SELECT title, source_url, favorite
                 FROM assets WHERE content_hash = ?1",
                [&source.items[0].source_sha256],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            imported,
            ("제목".into(), "https://x.com/user/status/1".into(), 1)
        );
        let existing: (String, String, String) = connection
            .query_row(
                "SELECT title, source_url, collected_at FROM assets WHERE id = 'existing-video'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(existing.0, "기존 제목");
        assert_eq!(existing.1, "https://keep.example");
        assert!(existing.2.starts_with("2026-03-16T10:00:00"));
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*)
                     FROM asset_classifications
                     WHERE asset_id = 'existing-video'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );
        drop(connection);

        let second = library
            .execute_legacy_package_migration(&plan, |_| {})
            .unwrap();
        assert_eq!(second.added, 0);
        assert_eq!(second.already_mapped, 2);
        assert_eq!(second.mappings_created, 0);
        assert_eq!(second.failed, 0);
        assert_eq!(second.book_collections.created, 0);
        assert_eq!(second.book_collections.skipped, 2);
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT description FROM collections WHERE id = 'existing-collection'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "보존"
        );
        assert_eq!(
            inspect_legacy_package_migration(&fixture.paths)
                .unwrap()
                .source
                .fingerprint,
            plan.source.fingerprint
        );
    }
}
