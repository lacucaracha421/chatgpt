use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
};

use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::error::LibraryError;

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

            let first = write_item(
                &package_root,
                "item-1",
                "image",
                "one.png",
                b"first image",
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
}
