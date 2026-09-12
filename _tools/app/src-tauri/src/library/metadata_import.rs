use std::{
    collections::{BTreeMap, HashSet},
    fs, io,
    path::{Component, Path, PathBuf},
};

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use url::Url;

use super::error::LibraryError;

pub const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_METADATA_ITEMS: usize = 100_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataImportPlan {
    pub metadata_file: String,
    pub classification_paths: Vec<Vec<String>>,
    pub items: Vec<MetadataImportItem>,
    pub skipped: Vec<MetadataImportSkipped>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataImportItem {
    pub file_name: String,
    pub source_path: PathBuf,
    pub classification_path: Vec<String>,
    pub source_url: String,
    pub collected_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataImportSkipped {
    pub file_name: String,
    pub reason: MetadataImportSkipReason,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MetadataImportSkipReason {
    MissingFile,
    InvalidSourceUrl,
    InvalidCollectedAt,
}

#[derive(Deserialize)]
struct ManifestHeader {
    format: String,
    version: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct V3Manifest {
    tag_layout: V3TagLayout,
    items: Vec<V3Item>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct V3TagLayout {
    primary_slots: Vec<Option<V3PrimarySlot>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct V3PrimarySlot {
    name: String,
    secondary_slots: Vec<Option<V3SecondarySlot>>,
}

#[derive(Deserialize)]
struct V3SecondarySlot {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct V3Item {
    filename: String,
    tag_path: String,
    tweet_url: String,
    saved_at: String,
}

pub fn inspect(folder: &Path) -> Result<MetadataImportPlan, LibraryError> {
    let manifest_path = find_manifest(folder)?;
    let metadata = fs::metadata(&manifest_path)
        .map_err(|source| LibraryError::ReadMetadataImport { source })?;
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(LibraryError::MetadataImportTooLarge);
    }
    let contents = fs::read_to_string(&manifest_path)
        .map_err(|source| LibraryError::ReadMetadataImport { source })?;
    let header: ManifestHeader =
        serde_json::from_str(&contents).map_err(|_| LibraryError::InvalidMetadataImport)?;
    if header.format != "lakomics-x-metadata" || header.version != 3 {
        return Err(LibraryError::UnsupportedMetadataImport);
    }
    let manifest: V3Manifest =
        serde_json::from_str(&contents).map_err(|_| LibraryError::InvalidMetadataImport)?;
    if manifest.items.len() > MAX_METADATA_ITEMS {
        return Err(LibraryError::MetadataImportTooLarge);
    }

    let canonical_folder =
        fs::canonicalize(folder).map_err(|source| LibraryError::ReadMetadataImport { source })?;
    let mut paths = BTreeMap::<String, Vec<String>>::new();
    for primary in manifest.tag_layout.primary_slots.into_iter().flatten() {
        let primary_name = nonempty_name(&primary.name)?;
        insert_path(&mut paths, vec![primary_name.clone()]);
        for secondary in primary.secondary_slots.into_iter().flatten() {
            insert_path(
                &mut paths,
                vec![primary_name.clone(), nonempty_name(&secondary.name)?],
            );
        }
    }

    let mut seen_files = HashSet::new();
    let mut items = Vec::new();
    let mut skipped = Vec::new();
    for item in manifest.items {
        validate_file_name(&item.filename)?;
        if !seen_files.insert(item.filename.to_lowercase()) {
            return Err(LibraryError::UnsafeMetadataImportPath);
        }
        let classification_path = parse_tag_path(&item.tag_path)?;
        insert_path(&mut paths, classification_path.clone());

        let source_path = folder.join(&item.filename);
        let canonical_source = match fs::canonicalize(&source_path) {
            Ok(path)
                if path.starts_with(&canonical_folder)
                    && path.parent() == Some(canonical_folder.as_path()) =>
            {
                path
            }
            Ok(_) => return Err(LibraryError::UnsafeMetadataImportPath),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                skipped.push(MetadataImportSkipped {
                    file_name: item.filename,
                    reason: MetadataImportSkipReason::MissingFile,
                });
                continue;
            }
            Err(source) => return Err(LibraryError::ReadMetadataImport { source }),
        };
        if !canonical_source.is_file() {
            skipped.push(MetadataImportSkipped {
                file_name: item.filename,
                reason: MetadataImportSkipReason::MissingFile,
            });
            continue;
        }
        if !valid_source_url(&item.tweet_url) {
            skipped.push(MetadataImportSkipped {
                file_name: item.filename,
                reason: MetadataImportSkipReason::InvalidSourceUrl,
            });
            continue;
        }
        if DateTime::parse_from_rfc3339(&item.saved_at).is_err() {
            skipped.push(MetadataImportSkipped {
                file_name: item.filename,
                reason: MetadataImportSkipReason::InvalidCollectedAt,
            });
            continue;
        }
        items.push(MetadataImportItem {
            file_name: item.filename,
            source_path: canonical_source,
            classification_path,
            source_url: item.tweet_url,
            collected_at: item.saved_at,
        });
    }

    let mut classification_paths: Vec<_> = paths.into_values().collect();
    classification_paths.sort_by(|left, right| {
        left.len().cmp(&right.len()).then_with(|| {
            left.join("\0")
                .to_lowercase()
                .cmp(&right.join("\0").to_lowercase())
        })
    });
    let metadata_file = manifest_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(LibraryError::InvalidMetadataImport)?
        .to_owned();
    Ok(MetadataImportPlan {
        metadata_file,
        classification_paths,
        items,
        skipped,
    })
}

fn find_manifest(folder: &Path) -> Result<PathBuf, LibraryError> {
    let entries =
        fs::read_dir(folder).map_err(|source| LibraryError::ReadMetadataImport { source })?;
    let mut matches = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| LibraryError::ReadMetadataImport { source })?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let lower = name.to_lowercase();
        if lower.starts_with("lakomics-x-metadata") && lower.ends_with(".json") {
            matches.push(entry.path());
        }
    }
    if matches.len() != 1 {
        return Err(LibraryError::MetadataImportManifestCount);
    }
    Ok(matches.remove(0))
}

fn validate_file_name(filename: &str) -> Result<(), LibraryError> {
    let mut components = Path::new(filename).components();
    if filename.is_empty()
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(LibraryError::UnsafeMetadataImportPath);
    }
    Ok(())
}

fn nonempty_name(name: &str) -> Result<String, LibraryError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(LibraryError::InvalidMetadataImport);
    }
    Ok(name.to_owned())
}

fn parse_tag_path(value: &str) -> Result<Vec<String>, LibraryError> {
    let segments: Result<Vec<_>, _> = value.split('>').map(nonempty_name).collect();
    let segments = segments?;
    if segments.is_empty() {
        return Err(LibraryError::InvalidMetadataImport);
    }
    Ok(segments)
}

fn insert_path(paths: &mut BTreeMap<String, Vec<String>>, path: Vec<String>) {
    let key = path.join("\0").to_lowercase();
    paths.entry(key).or_insert(path);
}

fn valid_source_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && matches!(
            url.host_str().map(str::to_ascii_lowercase).as_deref(),
            Some("x.com" | "www.x.com" | "twitter.com" | "www.twitter.com")
        )
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    fn write_manifest(folder: &Path, body: &str) {
        fs::write(folder.join("lakomics-x-metadata.json"), body).unwrap();
    }

    #[test]
    fn inspects_v3_manifest_and_includes_unused_layout_paths() {
        let folder = tempdir().unwrap();
        fs::write(folder.path().join("one.jpg"), b"image").unwrap();
        write_manifest(
            folder.path(),
            r#"{
              "format":"lakomics-x-metadata","version":3,
              "tagLayout":{"primarySlots":[
                {"name":"게임","secondarySlots":[{"name":"리버스"},{"name":"런던"}]},
                {"name":"밈","secondarySlots":[]}
              ]},
              "items":[
                {"filename":"one.jpg","tagPath":"게임 > 리버스","tweetUrl":"https://x.com/a/status/1","savedAt":"2026-08-13T12:34:56Z"},
                {"filename":"missing.jpg","tagPath":"새 루트 > 새 태그","tweetUrl":"https://twitter.com/a/status/2","savedAt":"2026-08-13T12:35:56+00:00"}
              ]
            }"#,
        );

        let plan = inspect(folder.path()).unwrap();

        assert_eq!(plan.metadata_file, "lakomics-x-metadata.json");
        assert_eq!(
            plan.classification_paths,
            vec![
                vec![String::from("게임")],
                vec![String::from("밈")],
                vec![String::from("게임"), String::from("런던")],
                vec![String::from("게임"), String::from("리버스")],
                vec![String::from("새 루트"), String::from("새 태그")],
            ]
        );
        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].source_url, "https://x.com/a/status/1");
        assert_eq!(
            plan.skipped,
            vec![MetadataImportSkipped {
                file_name: "missing.jpg".into(),
                reason: MetadataImportSkipReason::MissingFile,
            }]
        );
    }

    #[test]
    fn rejects_unsafe_and_duplicate_filenames() {
        for filenames in [
            ["../one.jpg", "two.jpg"],
            ["sub/one.jpg", "two.jpg"],
            ["ONE.jpg", "one.jpg"],
        ] {
            let folder = tempdir().unwrap();
            write_manifest(
                folder.path(),
                &format!(
                    r#"{{"format":"lakomics-x-metadata","version":3,"tagLayout":{{"primarySlots":[]}},"items":[{{"filename":"{}","tagPath":"A","tweetUrl":"https://x.com/a/status/1","savedAt":"2026-08-13T12:34:56Z"}},{{"filename":"{}","tagPath":"A","tweetUrl":"https://x.com/a/status/2","savedAt":"2026-08-13T12:34:56Z"}}]}}"#,
                    filenames[0], filenames[1]
                ),
            );
            assert!(matches!(
                inspect(folder.path()),
                Err(LibraryError::UnsafeMetadataImportPath)
            ));
        }
    }

    #[test]
    fn skips_invalid_url_and_time_but_rejects_empty_path() {
        let folder = tempdir().unwrap();
        for name in ["url.jpg", "time.jpg", "empty.jpg"] {
            fs::write(folder.path().join(name), b"image").unwrap();
        }
        write_manifest(
            folder.path(),
            r#"{"format":"lakomics-x-metadata","version":3,"tagLayout":{"primarySlots":[]},"items":[
              {"filename":"url.jpg","tagPath":"A","tweetUrl":"https://example.com/1","savedAt":"2026-08-13T12:34:56Z"},
              {"filename":"time.jpg","tagPath":"A","tweetUrl":"https://x.com/a/status/2","savedAt":"not-a-time"},
              {"filename":"empty.jpg","tagPath":"A > ","tweetUrl":"https://x.com/a/status/3","savedAt":"2026-08-13T12:34:56Z"}
            ]}"#,
        );
        assert!(matches!(
            inspect(folder.path()),
            Err(LibraryError::InvalidMetadataImport)
        ));
    }

    #[test]
    fn requires_exactly_one_supported_manifest() {
        let empty = tempdir().unwrap();
        assert!(matches!(
            inspect(empty.path()),
            Err(LibraryError::MetadataImportManifestCount)
        ));

        let unsupported = tempdir().unwrap();
        write_manifest(
            unsupported.path(),
            r#"{"format":"lakomics-x-metadata","version":2}"#,
        );
        assert!(matches!(
            inspect(unsupported.path()),
            Err(LibraryError::UnsupportedMetadataImport)
        ));

        let multiple = tempdir().unwrap();
        write_manifest(
            multiple.path(),
            r#"{"format":"lakomics-x-metadata","version":3,"tagLayout":{"primarySlots":[]},"items":[]}"#,
        );
        fs::write(multiple.path().join("lakomics-x-metadata-copy.json"), "{}").unwrap();
        assert!(matches!(
            inspect(multiple.path()),
            Err(LibraryError::MetadataImportManifestCount)
        ));
    }

    #[test]
    fn rejects_manifest_byte_and_item_limits() {
        let oversized = tempdir().unwrap();
        let file = fs::File::create(oversized.path().join("lakomics-x-metadata.json")).unwrap();
        file.set_len(MAX_METADATA_BYTES + 1).unwrap();
        assert!(matches!(
            inspect(oversized.path()),
            Err(LibraryError::MetadataImportTooLarge)
        ));

        let too_many = tempdir().unwrap();
        let items = (0..=MAX_METADATA_ITEMS)
            .map(|index| {
                serde_json::json!({
                    "filename": format!("{index}.jpg"),
                    "tagPath": "A",
                    "tweetUrl": "x",
                    "savedAt": "x"
                })
            })
            .collect::<Vec<_>>();
        write_manifest(
            too_many.path(),
            &serde_json::json!({
                "format": "lakomics-x-metadata",
                "version": 3,
                "tagLayout": { "primarySlots": [] },
                "items": items
            })
            .to_string(),
        );
        assert!(matches!(
            inspect(too_many.path()),
            Err(LibraryError::MetadataImportTooLarge)
        ));
    }

    #[test]
    #[ignore = "requires LAKOMICS_METADATA_IMPORT_FIXTURE"]
    fn inspects_a_real_extension_export_folder() {
        let folder = std::env::var_os("LAKOMICS_METADATA_IMPORT_FIXTURE").unwrap();
        let plan = inspect(Path::new(&folder)).unwrap();
        assert_eq!(plan.items.len(), 121);
        assert_eq!(plan.skipped.len(), 6);
        assert!(plan
            .classification_paths
            .iter()
            .any(|path| path == &["리버스"]));
        assert!(plan
            .classification_paths
            .iter()
            .any(|path| path == &["기타", "밈"]));
        assert!(plan.items.iter().all(|item| item.source_path.is_file()));
    }
}
