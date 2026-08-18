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
            let decimal = ver.split('.').last().unwrap_or("");
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
        let root = collection_source_root(&connection)?
            .ok_or(LibraryError::CollectionSourceRootNotSet)?;
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
        let root = collection_source_root(&connection)?
            .ok_or(LibraryError::CollectionSourceRootNotSet)?;
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
