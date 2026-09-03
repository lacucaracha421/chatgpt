use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::fs;
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use image::ImageFormat;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

use super::error::LibraryError;
use super::models::CollectionCover;
use super::work_artwork::WorkArtworkKind;
use super::{Library, MediaResponse};

const COVERS_DIR: &str = "covers";
const ARTWORKS_DIR: &str = "artworks";
const BACKDROPS_DIR: &str = "backdrops";

/// 레거시 book 루트는 유형별 하위 폴더(games/comics/movies)로 구성되어 있고,
/// DB의 source_path는 폴더 이름만 저장하므로 직속 경로를 먼저 시도한 뒤 하위 폴더를 확인한다.
const LEGACY_SOURCE_SUBDIRS: [&str; 3] = ["games", "comics", "movies"];

fn resolve_collection_dir(root: &str, source_path: &str) -> PathBuf {
    let root_path = Path::new(root);
    let direct = root_path.join(source_path);
    if direct.is_dir() {
        return direct;
    }
    LEGACY_SOURCE_SUBDIRS
        .iter()
        .map(|subdir| root_path.join(subdir).join(source_path))
        .find(|candidate| candidate.is_dir())
        .unwrap_or(direct)
}
const COLLECTION_THUMBNAIL_BOUND: u32 = 360;
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

fn preferred_path_file_name(preferred_path: Option<&Path>) -> Option<String> {
    preferred_path
        .and_then(|path| path.file_name())
        .map(|name| name.to_string_lossy().into_owned())
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

fn source_metadata_stamp(path: &Path) -> u128 {
    let Ok(metadata) = fs::metadata(path) else {
        return 0;
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    modified ^ ((metadata.len() as u128) << 64)
}

fn collection_artwork_source_signature(collection_dir: &Path, collection_type: &str) -> u128 {
    let secondary = if collection_type == "game" {
        ARTWORKS_DIR
    } else {
        BACKDROPS_DIR
    };
    [
        collection_dir.to_path_buf(),
        collection_dir.join("info.txt"),
        collection_dir.join(COVERS_DIR),
        collection_dir.join(secondary),
    ]
    .into_iter()
    .fold(0u128, |signature, path| {
        signature.rotate_left(23) ^ source_metadata_stamp(&path)
    })
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
        let covers_dir = resolve_collection_dir(&root, &source_path).join(COVERS_DIR);
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

    /// 뷰어를 열 때 로컬 소스 폴더의 아트를 작품 아트웍으로 등록한다.
    /// 첫 조회 때 한 번 import하고 이후에는 이미 등록된 아트웍을 재사용한다.
    /// IGDB·TMDB처럼 프로바이더가 아트웍을 관리하는 컬렉션은 건드리지 않는다.
    /// 반환값은 이번 호출에서 새로 등록한 아트웍 수다.
    pub fn import_local_collection_artworks(
        &self,
        collection_id: &str,
    ) -> Result<u64, LibraryError> {
        let (collection_type, source_path) = {
            let connection = self.connection()?;
            connection
                .query_row(
                    "SELECT type, source_path FROM collections WHERE id = ?1",
                    [collection_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()?
                .ok_or(LibraryError::CollectionNotFound)?
        };
        if !matches!(collection_type.as_str(), "game" | "movie") {
            return Ok(0);
        }
        let Some(source_path) = source_path else {
            return Ok(0);
        };
        let root = {
            let connection = self.connection()?;
            collection_source_root(&connection)?.ok_or(LibraryError::CollectionSourceRootNotSet)?
        };
        let collection_dir = resolve_collection_dir(&root, &source_path);
        let provider_managed: bool = self.connection()?.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM collection_work_artworks
                WHERE collection_id = ?1 AND provider != 'local'
            )",
            [collection_id],
            |row| row.get(0),
        )?;
        if provider_managed {
            return Ok(0);
        }

        let source_signature =
            collection_artwork_source_signature(&collection_dir, &collection_type);
        {
            let cache = self
                .collection_artwork_scan_cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if cache
                .get(collection_id)
                .is_some_and(|cached| *cached == source_signature)
            {
                return Ok(0);
            }
        }

        let mut imported = 0u64;
        let preferred_cover = info_cover(&collection_dir)?;
        // covers가 비면 루트의 thumbnail.*을 표지 대용으로 쓴다.
        let cover_directory = if naturally_sorted_images(&collection_dir.join(COVERS_DIR))?
            .is_empty()
        {
            collection_dir.clone()
        } else {
            collection_dir.join(COVERS_DIR)
        };
        imported += self.import_local_artwork_files(
            collection_id,
            &cover_directory,
            WorkArtworkKind::Cover,
            if cover_directory == collection_dir {
                "root"
            } else {
                "covers"
            },
            preferred_cover.as_deref(),
        )?;
        let (secondary_dir, secondary_kind) = if collection_type == "game" {
            (ARTWORKS_DIR, WorkArtworkKind::Hero)
        } else {
            (BACKDROPS_DIR, WorkArtworkKind::Backdrop)
        };
        imported += self.import_local_artwork_files(
            collection_id,
            &collection_dir.join(secondary_dir),
            secondary_kind,
            secondary_dir,
            None,
        )?;
        self.collection_artwork_scan_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(collection_id.to_owned(), source_signature);
        Ok(imported)
    }

    /// 한 디렉터리의 이미지를 지정한 종류의 작품 아트웍으로 등록한다.
    /// 이미 등록된 파일과 판독할 수 없는 파일은 건너뛴다.
    fn import_local_artwork_files(
        &self,
        collection_id: &str,
        directory: &Path,
        kind: WorkArtworkKind,
        directory_label: &str,
        preferred_path: Option<&Path>,
    ) -> Result<u64, LibraryError> {
        let images = naturally_sorted_images(directory)?
            .into_iter()
            // 루트 대체 import는 thumbnail.*만 대상으로 한다. info.txt 등
            // 이미지가 아닌 파일은 naturally_sorted_images가 이미 걸러낸다.
            .filter(|path| {
                directory_label != "root"
                    || path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.to_lowercase().starts_with("thumbnail."))
            })
            .collect::<Vec<_>>();
        if images.is_empty() {
            return Ok(0);
        }
        let existing: BTreeSet<String> = {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT provider_image_id FROM collection_work_artworks
                 WHERE collection_id = ?1 AND provider = 'local'",
            )?;
            let rows = statement
                .query_map([collection_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows.into_iter().collect()
        };
        let preferred_file_name = preferred_path_file_name(preferred_path);
        let mut imported = 0u64;
        let mut first_artwork_id: Option<String> = None;
        let mut preferred_artwork_id: Option<String> = None;
        for path in &images {
            let file_name = path.file_name().unwrap_or_default().to_string_lossy();
            let provider_image_id = format!("{directory_label}/{file_name}");
            if existing.contains(&provider_image_id) {
                continue;
            }
            let bytes = match fs::read(path) {
                Ok(bytes) => bytes,
                Err(source) => {
                    return Err(LibraryError::ReadMedia {
                        path: path.clone(),
                        source,
                    })
                }
            };
            // 지원하지 않는 형식이나 크기 초과 파일은 나머지 import를 막지 않는다.
            let Ok(prepared) = self.prepare_work_artwork(collection_id, &bytes) else {
                continue;
            };
            let artwork_id = {
                let mut connection = self.connection()?;
                let transaction = connection.transaction()?;
                let artwork_id = Library::insert_work_artwork_in_transaction(
                    &transaction,
                    collection_id,
                    "local",
                    &provider_image_id,
                    kind,
                    None,
                    &prepared,
                )?;
                transaction.commit()?;
                artwork_id
            };
            prepared.commit();
            imported += 1;
            if first_artwork_id.is_none() {
                first_artwork_id = Some(artwork_id.clone());
            }
            if preferred_artwork_id.is_none()
                && preferred_file_name
                    .as_deref()
                    .is_some_and(|name| name == file_name)
            {
                preferred_artwork_id = Some(artwork_id);
            }
        }
        if imported > 0 {
            let has_selected: bool = {
                let connection = self.connection()?;
                connection.query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM collection_work_artworks
                        WHERE collection_id = ?1 AND kind = ?2 AND selected = 1
                    )",
                    rusqlite::params![collection_id, kind.as_str()],
                    |row| row.get(0),
                )?
            };
            if !has_selected {
                let mut connection = self.connection()?;
                let transaction = connection.transaction()?;
                Library::select_work_artwork_kind_in_transaction(
                    &transaction,
                    collection_id,
                    preferred_artwork_id
                        .as_deref()
                        .or(first_artwork_id.as_deref())
                        .ok_or(LibraryError::InvalidWorkArtwork)?,
                    kind,
                )?;
                transaction.commit()?;
            }
        }
        Ok(imported)
    }

    pub fn collection_cover_media(
        &self,
        collection_id: &str,
        file_name: &str,
    ) -> Result<MediaResponse, LibraryError> {
        let (source_root, file_path) =
            self.collection_source_image_path(collection_id, Some(file_name))?;
        self.open_manga_media(&source_root, file_path)
    }

    pub fn collection_cover_thumbnail_media(
        &self,
        collection_id: &str,
        file_name: &str,
    ) -> Result<MediaResponse, LibraryError> {
        let (source_root, file_path) =
            self.collection_source_image_path(collection_id, Some(file_name))?;
        self.collection_thumbnail_media(collection_id, &source_root, file_path)
    }

    pub fn collection_source_preview_media(
        &self,
        collection_id: &str,
    ) -> Result<MediaResponse, LibraryError> {
        let (source_root, preview) = self.collection_source_image_path(collection_id, None)?;
        self.open_manga_media(&source_root, preview)
    }

    pub fn collection_source_thumbnail_media(
        &self,
        collection_id: &str,
    ) -> Result<MediaResponse, LibraryError> {
        let (source_root, preview) = self.collection_source_image_path(collection_id, None)?;
        self.collection_thumbnail_media(collection_id, &source_root, preview)
    }

    fn collection_source_image_path(
        &self,
        collection_id: &str,
        file_name: Option<&str>,
    ) -> Result<(PathBuf, PathBuf), LibraryError> {
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
        let source_root = PathBuf::from(&root);
        let collection_dir = resolve_collection_dir(&root, &source_path);
        let image_path = match file_name {
            Some(file_name) => collection_dir.join(COVERS_DIR).join(file_name),
            None => source_preview_path(&collection_dir)?,
        };
        Ok((source_root, image_path))
    }

    fn collection_thumbnail_media(
        &self,
        collection_id: &str,
        source_root: &Path,
        source_path: PathBuf,
    ) -> Result<MediaResponse, LibraryError> {
        let source = self.open_manga_media(source_root, source_path.clone())?;
        let source_modified_nanos = source
            .file
            .metadata()
            .and_then(|metadata| metadata.modified())
            .map_err(|source| LibraryError::ReadMedia {
                path: source_path.clone(),
                source,
            })?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let canonical_root =
            fs::canonicalize(source_root).map_err(|source| LibraryError::ReadMedia {
                path: source_root.to_path_buf(),
                source,
            })?;
        let canonical_source =
            fs::canonicalize(&source_path).map_err(|source| LibraryError::ReadMedia {
                path: source_path.clone(),
                source,
            })?;
        // 하위 폴더(games/comics/movies)에서 해석된 소스는 루트 기준 상대 경로 계산이
        // 실패할 수 있으므로 소스가 있는 폴더 기준으로도 시도한다. 캐시 키에는
        // 컬렉션 ID가 함께 들어가므로 상대 경로 기준이 달라져도 충돌하지 않는다.
        // (open_manga_media에서 루트 하위 경로 검증은 이미 끝난 상태다.)
        let source_relative_path = canonical_source
            .strip_prefix(&canonical_root)
            .ok()
            .or_else(|| {
                canonical_source
                    .parent()
                    .and_then(|dir| canonical_source.strip_prefix(dir).ok())
            })
            .ok_or(LibraryError::UnsafeMediaPath)?;
        let thumbnail_relative_path = collection_thumbnail_relative_path(
            collection_id,
            source_relative_path,
            source.length,
            source_modified_nanos,
        );
        let thumbnail_path = self.root().join(&thumbnail_relative_path);
        if thumbnail_path.exists() {
            return self.open_library_media(&thumbnail_relative_path);
        }

        let image = image::ImageReader::new(BufReader::new(source.file))
            .with_guessed_format()
            .map_err(|_| LibraryError::UnsupportedImage)?
            .decode()
            .map_err(|_| LibraryError::UnsupportedImage)?;
        let temporary_path = thumbnail_path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        if let Err(error) = write_collection_thumbnail(&image, &temporary_path) {
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }
        if let Err(source) = fs::rename(&temporary_path, &thumbnail_path) {
            let _ = fs::remove_file(&temporary_path);
            if !thumbnail_path.exists() {
                return Err(LibraryError::WriteCollectionThumbnail {
                    path: thumbnail_path,
                    source,
                });
            }
        }
        self.open_library_media(&thumbnail_relative_path)
    }
}

fn collection_thumbnail_relative_path(
    collection_id: &str,
    source_relative_path: &Path,
    source_length: u64,
    source_modified_nanos: u128,
) -> String {
    let normalized = source_relative_path.to_string_lossy().replace('\\', "/");
    let identity = format!("{normalized}\0{source_length}\0{source_modified_nanos}");
    let hash = Sha256::digest(identity.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("collection-thumbnails/{collection_id}/{hash}.webp")
}

fn write_collection_thumbnail(
    image: &image::DynamicImage,
    path: &Path,
) -> Result<(), LibraryError> {
    let directory = path
        .parent()
        .expect("generated Collection thumbnail paths have a parent");
    fs::create_dir_all(directory).map_err(|source| LibraryError::WriteCollectionThumbnail {
        path: directory.to_path_buf(),
        source,
    })?;
    let file = fs::File::create(path).map_err(|source| LibraryError::WriteCollectionThumbnail {
        path: path.to_path_buf(),
        source,
    })?;
    image
        .thumbnail(COLLECTION_THUMBNAIL_BOUND, COLLECTION_THUMBNAIL_BOUND)
        .write_to(&mut BufWriter::new(file), ImageFormat::WebP)
        .map_err(|source| LibraryError::WriteCollectionThumbnail {
            path: path.to_path_buf(),
            source: std::io::Error::other(source),
        })
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::time::{Duration, SystemTime};

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

    fn write_png(path: &Path, width: u32, height: u32) -> Vec<u8> {
        image::DynamicImage::new_rgb8(width, height)
            .save(path)
            .unwrap();
        fs::read(path).unwrap()
    }

    #[test]
    fn collection_thumbnail_bounds_and_reuses_source_preview() {
        let (_temp, library, collection_dir) = source_library();
        write_png(&collection_dir.join("chosen.png"), 1200, 800);
        fs::write(collection_dir.join("info.txt"), "Cover: chosen.png\n").unwrap();

        let media = library
            .collection_source_thumbnail_media(COLLECTION_ID)
            .unwrap();
        assert_eq!(media.mime, "image/webp");
        let first = read_media(media);
        let decoded =
            image::load_from_memory_with_format(&first, image::ImageFormat::WebP).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (360, 240));

        let cache_dir = library
            .root()
            .join("collection-thumbnails")
            .join(COLLECTION_ID);
        let cache_files = fs::read_dir(&cache_dir)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(cache_files.len(), 1);
        let cache_path = cache_files[0].path();
        let first_modified = fs::metadata(&cache_path).unwrap().modified().unwrap();

        let second = read_media(
            library
                .collection_source_thumbnail_media(COLLECTION_ID)
                .unwrap(),
        );
        assert_eq!(second, first);
        assert_eq!(
            fs::metadata(cache_path).unwrap().modified().unwrap(),
            first_modified
        );
    }

    #[test]
    fn collection_source_resolves_legacy_subfolder_layout() {
        // 레거시 book 루트는 games/comics/movies 하위에 소스 폴더를 둔다.
        let (temp, library, collection_dir) = source_library();
        fs::remove_dir_all(&collection_dir).unwrap();
        let source_root = temp.path().join("source");
        let game_dir = source_root.join("games").join("series");
        fs::create_dir_all(&game_dir).unwrap();
        write_png(&game_dir.join("thumbnail.webp"), 1200, 800);

        let media = library
            .collection_source_thumbnail_media(COLLECTION_ID)
            .unwrap();
        assert_eq!(media.mime, "image/webp");

        fs::create_dir_all(game_dir.join(COVERS_DIR)).unwrap();
        let cover = write_png(&game_dir.join(COVERS_DIR).join("poster.png"), 800, 1200);
        let covers = library.list_collection_covers(COLLECTION_ID).unwrap();
        assert_eq!(covers.len(), 1);
        assert_eq!(covers[0].file_name, "poster.png");
        let media = library
            .collection_cover_media(COLLECTION_ID, "poster.png")
            .unwrap();
        assert_eq!(read_media(media), cover);
    }

    #[test]
    fn import_local_artworks_registers_source_images_once() {
        let (_temp, library, collection_dir) = source_library();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections SET type = 'game' WHERE id = ?1",
                [COLLECTION_ID],
            )
            .unwrap();
        write_png(
            &collection_dir.join(COVERS_DIR).join("poster_a.png"),
            800,
            1200,
        );
        write_png(
            &collection_dir.join(COVERS_DIR).join("poster_b.png"),
            800,
            1200,
        );
        fs::write(collection_dir.join("info.txt"), "Cover: poster_b.png\n").unwrap();
        fs::create_dir_all(collection_dir.join(ARTWORKS_DIR)).unwrap();
        write_png(
            &collection_dir.join(ARTWORKS_DIR).join("header_steam_1.png"),
            920,
            430,
        );
        fs::write(
            collection_dir.join(COVERS_DIR).join("broken.png"),
            b"not an image",
        )
        .unwrap();

        let imported = library
            .import_local_collection_artworks(COLLECTION_ID)
            .unwrap();
        assert_eq!(imported, 3);

        let rows: Vec<(String, String, i64)> = library
            .connection()
            .unwrap()
            .prepare(
                "SELECT provider_image_id, kind, selected FROM collection_work_artworks
                 WHERE collection_id = ?1 ORDER BY provider_image_id",
            )
            .unwrap()
            .query_map([COLLECTION_ID], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("artworks/header_steam_1.png".into(), "hero".into(), 1),
                ("covers/poster_a.png".into(), "cover".into(), 0),
                // info.txt의 Cover 파일을 표지로 선택한다.
                ("covers/poster_b.png".into(), "cover".into(), 1),
            ]
        );

        let again = library
            .import_local_collection_artworks(COLLECTION_ID)
            .unwrap();
        assert_eq!(again, 0);

        write_png(
            &collection_dir.join(COVERS_DIR).join("poster_c.png"),
            800,
            1200,
        );
        let after_source_change = library
            .import_local_collection_artworks(COLLECTION_ID)
            .unwrap();
        assert_eq!(after_source_change, 1);
    }

    #[test]
    fn import_local_artworks_skips_provider_managed_collections() {
        let (_temp, library, collection_dir) = source_library();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections SET type = 'game' WHERE id = ?1",
                [COLLECTION_ID],
            )
            .unwrap();
        write_png(
            &collection_dir.join(COVERS_DIR).join("poster.png"),
            800,
            1200,
        );
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, language, selected, created_at, updated_at
                 ) VALUES (
                    'art-igdb', ?1, 'igdb', 'cover-igdb', 'cover',
                    'work-artwork/x/igdb.png', 'image/png', 100, 150, NULL, 1,
                    '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z'
                 )",
                [COLLECTION_ID],
            )
            .unwrap();

        let imported = library
            .import_local_collection_artworks(COLLECTION_ID)
            .unwrap();

        assert_eq!(imported, 0);
        let count: i64 = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM collection_work_artworks WHERE collection_id = ?1",
                [COLLECTION_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn collection_thumbnail_isolates_covers_and_preserves_original_media() {
        let (_temp, library, collection_dir) = source_library();
        let covers_dir = collection_dir.join(COVERS_DIR);
        let first_path = covers_dir.join("vol_1_cover.png");
        let second_path = covers_dir.join("vol_2_cover.png");
        let first_original = write_png(&first_path, 800, 1200);
        write_png(&second_path, 900, 600);

        let first = read_media(
            library
                .collection_cover_thumbnail_media(COLLECTION_ID, "vol_1_cover.png")
                .unwrap(),
        );
        let second = read_media(
            library
                .collection_cover_thumbnail_media(COLLECTION_ID, "vol_2_cover.png")
                .unwrap(),
        );

        assert_ne!(first, second);
        let cache_dir = library
            .root()
            .join("collection-thumbnails")
            .join(COLLECTION_ID);
        assert_eq!(fs::read_dir(cache_dir).unwrap().count(), 2);
        assert_eq!(
            read_media(
                library
                    .collection_cover_media(COLLECTION_ID, "vol_1_cover.png")
                    .unwrap(),
            ),
            first_original,
        );
    }

    #[test]
    fn collection_thumbnail_refreshes_when_source_changes() {
        let (_temp, library, collection_dir) = source_library();
        let source_path = collection_dir.join("chosen.png");
        write_png(&source_path, 1200, 800);
        fs::write(collection_dir.join("info.txt"), "Cover: chosen.png\n").unwrap();
        read_media(
            library
                .collection_source_thumbnail_media(COLLECTION_ID)
                .unwrap(),
        );

        write_png(&source_path, 800, 1200);
        fs::File::options()
            .write(true)
            .open(&source_path)
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_secs(1))
            .unwrap();

        let refreshed = read_media(
            library
                .collection_source_thumbnail_media(COLLECTION_ID)
                .unwrap(),
        );
        let decoded =
            image::load_from_memory_with_format(&refreshed, image::ImageFormat::WebP).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (240, 360));
        assert_eq!(
            fs::read_dir(
                library
                    .root()
                    .join("collection-thumbnails")
                    .join(COLLECTION_ID)
            )
            .unwrap()
            .count(),
            2,
        );
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
