use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;

use super::error::LibraryError;
use super::models::CollectionCover;
use super::{Library, MediaResponse};

const COVERS_DIR: &str = "covers";
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "tiff", "jfif", "gif"];

pub(crate) fn collection_source_root(
    connection: &rusqlite::Connection,
) -> Result<Option<String>, LibraryError> {
    let value = connection
        .query_row(
            "SELECT collection_source_root FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    Ok(value)
}

pub(crate) fn set_collection_source_root(
    connection: &rusqlite::Connection,
    path: Option<&str>,
) -> Result<(), LibraryError> {
    connection.execute(
        "UPDATE library_settings SET collection_source_root = ?1 WHERE singleton = 1",
        [path],
    )?;
    if let Some(root) = path {
        let root_path = PathBuf::from(root);
        fs::create_dir_all(&root_path).map_err(|source| LibraryError::CreateDirectory {
            path: root_path.clone(),
            source,
        })?;
    }
    Ok(())
}

fn vol_regex() -> regex::Regex {
    regex::Regex::new(r"vol_([0-9.]+)_").unwrap()
}

fn classify_shelf(file_name: &str, regex: &regex::Regex) -> (u8, String) {
    let lower = file_name.to_lowercase();
    if let Some(caps) = regex.captures(&lower) {
        let ver = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let shelf = if ver.contains('.') {
            let decimal = ver.split('.').next_back().unwrap_or("");
            match decimal {
                "1" => 2,
                "2" => 3,
                _ => 4,
            }
        } else {
            1
        };
        let label = if ver.is_empty() {
            String::new()
        } else {
            format!("vol.{ver}")
        };
        (shelf, label)
    } else {
        (4, String::new())
    }
}

fn natural_compare(a: &str, b: &str) -> Ordering {
    let a_lower = a.to_lowercase();
    let b_lower = b.to_lowercase();
    let mut a_chars = a_lower.chars().peekable();
    let mut b_chars = b_lower.chars().peekable();
    loop {
        match (a_chars.peek(), b_chars.peek()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(&ac), Some(&bc)) => {
                if ac.is_ascii_digit() && bc.is_ascii_digit() {
                    let a_num: String = a_chars
                        .by_ref()
                        .take_while(|c| c.is_ascii_digit())
                        .collect();
                    let b_num: String = b_chars
                        .by_ref()
                        .take_while(|c| c.is_ascii_digit())
                        .collect();
                    let a_val: u64 = a_num.parse().unwrap_or(0);
                    let b_val: u64 = b_num.parse().unwrap_or(0);
                    match a_val.cmp(&b_val) {
                        Ordering::Equal => continue,
                        ord => return ord,
                    }
                } else {
                    match ac.cmp(&bc) {
                        Ordering::Equal => {
                            a_chars.next();
                            b_chars.next();
                        }
                        ord => return ord,
                    }
                }
            }
        }
    }
}

fn info_cover(collection_dir: &Path) -> Result<Option<PathBuf>, LibraryError> {
    let info_path = collection_dir.join("info.txt");
    if !info_path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&info_path).map_err(|source| LibraryError::ReadMedia {
        path: info_path,
        source,
    })?;
    let Some(relative) = raw.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case("Cover")
            .then(|| value.trim())
    }) else {
        return Ok(None);
    };
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty() || relative.is_absolute() {
        return Ok(None);
    }
    let candidate = collection_dir.join(relative);
    let canonical_collection =
        fs::canonicalize(collection_dir).map_err(|source| LibraryError::ReadMedia {
            path: collection_dir.to_path_buf(),
            source,
        })?;
    let canonical_candidate = match fs::canonicalize(&candidate) {
        Ok(path) => path,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(LibraryError::ReadMedia {
                path: candidate,
                source,
            });
        }
    };
    Ok((canonical_candidate.is_file()
        && canonical_candidate.starts_with(canonical_collection)
        && is_supported_image(&canonical_candidate))
    .then_some(canonical_candidate))
}

fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            IMAGE_EXTENSIONS
                .iter()
                .any(|supported| extension.eq_ignore_ascii_case(supported))
        })
}

fn naturally_sorted_images(directory: &Path) -> Result<Vec<PathBuf>, LibraryError> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut images = fs::read_dir(directory)
        .map_err(|source| LibraryError::ReadMedia {
            path: directory.to_path_buf(),
            source,
        })?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_supported_image(path))
        .collect::<Vec<_>>();
    images.sort_by(|a, b| {
        natural_compare(
            &a.file_name().unwrap_or_default().to_string_lossy(),
            &b.file_name().unwrap_or_default().to_string_lossy(),
        )
    });
    Ok(images)
}

fn source_preview_path(collection_dir: &Path) -> Result<PathBuf, LibraryError> {
    if let Some(cover) = info_cover(collection_dir)? {
        return Ok(cover);
    }
    let root_images = naturally_sorted_images(collection_dir)?;
    if let Some(thumbnail) = root_images.iter().find(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("thumbnail.webp"))
    }) {
        return Ok(thumbnail.clone());
    }
    if let Some(thumbnail) = root_images.iter().find(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.to_lowercase().starts_with("thumbnail."))
    }) {
        return Ok(thumbnail.clone());
    }
    if let Some(image) = root_images.into_iter().next() {
        return Ok(image);
    }
    naturally_sorted_images(&collection_dir.join(COVERS_DIR))?
        .into_iter()
        .next()
        .ok_or(LibraryError::MediaNotFound)
}

impl Library {
    pub fn collection_source_root(&self) -> Result<Option<String>, LibraryError> {
        let connection = self.connection()?;
        collection_source_root(&connection)
    }

    pub fn set_collection_source_root(&self, path: Option<&str>) -> Result<(), LibraryError> {
        let connection = self.connection()?;
        set_collection_source_root(&connection, path)
    }

    pub fn list_collection_covers(
        &self,
        collection_id: &str,
    ) -> Result<Vec<CollectionCover>, LibraryError> {
        let connection = self.connection()?;
        let root =
            collection_source_root(&connection)?.ok_or(LibraryError::CollectionSourceRootNotSet)?;
        let source_path: Option<String> = connection
            .query_row(
                "SELECT source_path FROM collections WHERE id = ?1",
                [collection_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(LibraryError::CollectionNotFound)?;
        let source_path = source_path.ok_or(LibraryError::CollectionSourcePathNotSet)?;
        let covers_dir = Path::new(&root).join(&source_path).join(COVERS_DIR);
        if !covers_dir.is_dir() {
            return Ok(Vec::new());
        }
        let regex = vol_regex();
        let mut covers: Vec<CollectionCover> = fs::read_dir(&covers_dir)
            .map_err(|source| LibraryError::ReadMedia {
                path: covers_dir.clone(),
                source,
            })?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|ft| ft.is_file()).unwrap_or(false))
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                IMAGE_EXTENSIONS
                    .iter()
                    .any(|ext| name.ends_with(&format!(".{ext}")))
            })
            .map(|entry| {
                let file_name = entry.file_name().to_string_lossy().into_owned();
                let (shelf, volume_label) = classify_shelf(&file_name, &regex);
                CollectionCover {
                    file_name,
                    shelf,
                    volume_label,
                }
            })
            .collect();
        covers.sort_by(|a, b| {
            let shelf_cmp = a.shelf.cmp(&b.shelf);
            if shelf_cmp != Ordering::Equal {
                return shelf_cmp;
            }
            natural_compare(&a.file_name, &b.file_name)
        });
        Ok(covers)
    }

    pub fn collection_cover_media(
        &self,
        collection_id: &str,
        file_name: &str,
    ) -> Result<MediaResponse, LibraryError> {
        let connection = self.connection()?;
        let root =
            collection_source_root(&connection)?.ok_or(LibraryError::CollectionSourceRootNotSet)?;
        let source_path: Option<String> = connection
            .query_row(
                "SELECT source_path FROM collections WHERE id = ?1",
                [collection_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(LibraryError::CollectionNotFound)?;
        let source_path = source_path.ok_or(LibraryError::CollectionSourcePathNotSet)?;
        let source_root = Path::new(&root);
        let file_path = source_root
            .join(&source_path)
            .join(COVERS_DIR)
            .join(file_name);
        self.open_manga_media(source_root, file_path)
    }

    pub fn collection_source_preview_media(
        &self,
        collection_id: &str,
    ) -> Result<MediaResponse, LibraryError> {
        let connection = self.connection()?;
        let root =
            collection_source_root(&connection)?.ok_or(LibraryError::CollectionSourceRootNotSet)?;
        let source_path: Option<String> = connection
            .query_row(
                "SELECT source_path FROM collections WHERE id = ?1",
                [collection_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(LibraryError::CollectionNotFound)?;
        let source_path = source_path.ok_or(LibraryError::CollectionSourcePathNotSet)?;
        let source_root = Path::new(&root);
        let collection_dir = source_root.join(source_path);
        let preview = source_preview_path(&collection_dir)?;
        self.open_manga_media(source_root, preview)
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    const COLLECTION_ID: &str = "00000000-0000-4000-8000-000000000101";

    fn source_library() -> (tempfile::TempDir, Library, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let source_root = temp.path().join("source");
        let collection_dir = source_root.join("series");
        fs::create_dir_all(collection_dir.join(COVERS_DIR)).unwrap();
        library
            .set_collection_source_root(Some(source_root.to_string_lossy().as_ref()))
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO collections (id, name, created_at, updated_at, source_path)
                 VALUES (?1, 'Series', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', 'series')",
                [COLLECTION_ID],
            )
            .unwrap();
        (temp, library, collection_dir)
    }

    fn read_media(mut media: MediaResponse) -> Vec<u8> {
        let mut bytes = Vec::new();
        media.file.read_to_end(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn source_preview_uses_the_relative_info_cover_override() {
        let (_temp, library, collection_dir) = source_library();
        fs::write(collection_dir.join("chosen.png"), b"chosen").unwrap();
        fs::write(collection_dir.join("thumbnail.webp"), b"thumbnail").unwrap();
        fs::write(
            collection_dir.join(COVERS_DIR).join("vol_1_cover.png"),
            b"volume",
        )
        .unwrap();
        fs::write(
            collection_dir.join("info.txt"),
            "Title: Series\nCover: chosen.png\n",
        )
        .unwrap();

        let media = library
            .collection_source_preview_media(COLLECTION_ID)
            .unwrap();

        assert_eq!(read_media(media), b"chosen");
    }

    #[test]
    fn source_preview_uses_the_legacy_fallback_order() {
        let (_temp, library, collection_dir) = source_library();
        let webp_thumbnail = collection_dir.join("thumbnail.webp");
        let png_thumbnail = collection_dir.join("thumbnail.png");
        let root_image = collection_dir.join("poster.png");
        let volume = collection_dir.join(COVERS_DIR).join("vol_2_cover.png");
        fs::write(&webp_thumbnail, b"webp-thumbnail").unwrap();
        fs::write(&png_thumbnail, b"png-thumbnail").unwrap();
        fs::write(&root_image, b"root-image").unwrap();
        fs::write(&volume, b"volume").unwrap();

        assert_eq!(
            read_media(
                library
                    .collection_source_preview_media(COLLECTION_ID)
                    .unwrap()
            ),
            b"webp-thumbnail"
        );
        fs::remove_file(webp_thumbnail).unwrap();
        assert_eq!(
            read_media(
                library
                    .collection_source_preview_media(COLLECTION_ID)
                    .unwrap()
            ),
            b"png-thumbnail"
        );
        fs::remove_file(png_thumbnail).unwrap();
        assert_eq!(
            read_media(
                library
                    .collection_source_preview_media(COLLECTION_ID)
                    .unwrap()
            ),
            b"root-image"
        );
        fs::remove_file(root_image).unwrap();
        assert_eq!(
            read_media(
                library
                    .collection_source_preview_media(COLLECTION_ID)
                    .unwrap()
            ),
            b"volume"
        );
    }

    #[test]
    fn source_preview_ignores_an_info_cover_outside_the_collection_folder() {
        let (_temp, library, collection_dir) = source_library();
        fs::write(
            collection_dir.parent().unwrap().join("outside.png"),
            b"outside",
        )
        .unwrap();
        fs::write(collection_dir.join("thumbnail.webp"), b"safe-thumbnail").unwrap();
        fs::write(collection_dir.join("info.txt"), "Cover: ../outside.png\n").unwrap();

        let media = library
            .collection_source_preview_media(COLLECTION_ID)
            .unwrap();

        assert_eq!(read_media(media), b"safe-thumbnail");
    }

    #[test]
    fn source_preview_ignores_an_info_cover_with_an_unsupported_extension() {
        let (_temp, library, collection_dir) = source_library();
        fs::write(collection_dir.join("notes.txt"), b"not-an-image").unwrap();
        fs::write(collection_dir.join("thumbnail.webp"), b"safe-thumbnail").unwrap();
        fs::write(collection_dir.join("info.txt"), "Cover: notes.txt\n").unwrap();

        let media = library
            .collection_source_preview_media(COLLECTION_ID)
            .unwrap();

        assert_eq!(read_media(media), b"safe-thumbnail");
    }

    #[test]
    fn classifies_integer_volume_to_shelf_1() {
        let regex = vol_regex();
        let (shelf, label) = classify_shelf("vol_1_001.webp", &regex);
        assert_eq!(shelf, 1);
        assert_eq!(label, "vol.1");
    }

    #[test]
    fn classifies_decimal_1_to_shelf_2() {
        let regex = vol_regex();
        let (shelf, label) = classify_shelf("vol_1.1_001.webp", &regex);
        assert_eq!(shelf, 2);
        assert_eq!(label, "vol.1.1");
    }

    #[test]
    fn classifies_decimal_2_to_shelf_3() {
        let regex = vol_regex();
        let (shelf, label) = classify_shelf("vol_1.2_001.webp", &regex);
        assert_eq!(shelf, 3);
        assert_eq!(label, "vol.1.2");
    }

    #[test]
    fn classifies_no_version_to_shelf_4() {
        let regex = vol_regex();
        let (shelf, label) = classify_shelf("thumbnail.webp", &regex);
        assert_eq!(shelf, 4);
        assert_eq!(label, "");
    }

    #[test]
    fn natural_compare_sorts_numbers_correctly() {
        let mut items = vec!["vol_10_", "vol_2_", "vol_1_"];
        items.sort_by(|a, b| natural_compare(a, b));
        assert_eq!(items, vec!["vol_1_", "vol_2_", "vol_10_"]);
    }
}
