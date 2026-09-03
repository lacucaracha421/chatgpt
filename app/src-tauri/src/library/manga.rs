use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::OptionalExtension;

use super::error::LibraryError;
use super::models::{
    MangaCatalogRecoveryApplyResult, MangaCatalogRecoveryItem, MangaCatalogRecoveryPreview,
    MangaCatalogRecoveryStatus, MangaSeries,
};
use super::Library;

const THUMB_DIR: &str = ".lakomics-thumbs";

pub(crate) fn manga_root(
    connection: &rusqlite::Connection,
) -> Result<Option<String>, LibraryError> {
    let value = connection
        .query_row(
            "SELECT manga_root FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    Ok(value)
}

pub(crate) fn set_manga_root(
    connection: &rusqlite::Connection,
    path: Option<&str>,
) -> Result<(), LibraryError> {
    connection.execute(
        "UPDATE library_settings SET manga_root = ?1 WHERE singleton = 1",
        [path],
    )?;
    if let Some(root) = path {
        let series_dir = PathBuf::from(root);
        fs::create_dir_all(&series_dir).map_err(|source| LibraryError::CreateDirectory {
            path: series_dir.clone(),
            source,
        })?;
    }
    Ok(())
}

pub(crate) fn scan(library: &Library) -> Result<u64, LibraryError> {
    scan_with_thumbnail(library, create_thumbnail)
}

fn scan_with_thumbnail<F>(library: &Library, mut thumbnail: F) -> Result<u64, LibraryError>
where
    F: FnMut(&Path, &Path) -> Result<(), LibraryError>,
{
    let _scan_guard = library
        .manga_scan_lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = {
        let connection = library.connection()?;
        manga_root(&connection)?
    }
    .ok_or(LibraryError::MangaRootNotSet)?;
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(LibraryError::MangaRootNotSet);
    }
    let thumb_dir = root_path.join(THUMB_DIR);
    fs::create_dir_all(&thumb_dir).map_err(|source| LibraryError::CreateDirectory {
        path: thumb_dir.clone(),
        source,
    })?;

    let mut changed: u64 = 0;
    let entries = fs::read_dir(&root_path).map_err(|source| LibraryError::ReadMedia {
        path: root_path.clone(),
        source,
    })?;
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let folder_name = entry.file_name().to_string_lossy().into_owned();
        if folder_name == THUMB_DIR {
            continue;
        }
        if scan_series_folder(
            library,
            &root_path,
            &folder_name,
            &thumb_dir,
            &mut thumbnail,
        )? {
            changed += 1;
        }
    }
    // Missing folders are retained as soft-orphaned metadata. A root can move or disappear,
    // and the index may be the only surviving record needed for catalog recovery.
    // Explicit cleanup belongs to a separate user action instead of scan-time deletion.
    Ok(changed)
}

fn scan_series_folder<F>(
    library: &Library,
    root: &Path,
    relative_path: &str,
    thumb_dir: &Path,
    thumbnail: &mut F,
) -> Result<bool, LibraryError>
where
    F: FnMut(&Path, &Path) -> Result<(), LibraryError>,
{
    let folder = root.join(relative_path);
    let (title, author, gallery_id) = parse_series_metadata(&folder, relative_path);
    let page_files = list_page_files(&folder)?;
    let page_count = page_files.len();
    if page_count == 0 {
        return Ok(false); // 빈 폴더는 스킵
    }
    let modified_at = fs::metadata(&folder)
        .and_then(|metadata| metadata.modified())
        .map_err(|source| LibraryError::ReadMedia {
            path: folder.clone(),
            source,
        })?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| {
            chrono::DateTime::from_timestamp(duration.as_secs() as i64, duration.subsec_nanos())
                .expect("folder mtime is representable as RFC3339")
                .to_rfc3339()
        })
        .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());

    let existing: Option<(String, i64, String, String)> = {
        let connection = library.connection()?;
        connection
            .query_row(
                "SELECT id, page_count, thumbnail_relative_path, modified_at FROM manga_series WHERE relative_path = ?1",
                [relative_path],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
    };
    let unchanged = existing.as_ref().is_some_and(|(_, count, thumb, stored)| {
        *count as usize == page_count
            && fs::exists(thumb_dir.join(thumb)).unwrap_or(false)
            && *stored == modified_at
    });
    if unchanged {
        return Ok(false);
    }

    let series_id = match existing {
        Some((id, _, _, _)) => id,
        None => uuid::Uuid::new_v4().to_string(),
    };

    let thumb_name = format!("{series_id}.webp");
    let thumb_path = thumb_dir.join(&thumb_name);
    if !thumb_path.exists() {
        // 썸네일 생성은 색인과 독립적이다. 첫 페이지가 지원하지 않는 형식이면(AVIF 등)
        // 이후 페이지를 순서대로 시도하고, 그래도 실패하면 썸네일 없이 시리즈를 색인한다.
        // UnsupportedImage만 격리한다. DB·파일시스템·쓰기 오류는 그대로 전파해 스캔을 중단시킨다.
        for page in &page_files {
            match thumbnail(&folder.join(page), &thumb_path) {
                Ok(()) => break,
                Err(LibraryError::UnsupportedImage) => continue,
                Err(error) => return Err(error),
            }
        }
    }

    let connection = library.connection()?;
    connection.execute(
        "INSERT INTO manga_series (id, relative_path, title, author, gallery_id, page_count, thumbnail_relative_path, scanned_at, modified_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(relative_path) DO UPDATE SET
           title = excluded.title,
           author = excluded.author,
           gallery_id = excluded.gallery_id,
           page_count = excluded.page_count,
           thumbnail_relative_path = excluded.thumbnail_relative_path,
           scanned_at = excluded.scanned_at,
           modified_at = excluded.modified_at",
        rusqlite::params![
            series_id,
            relative_path,
            title,
            author,
            gallery_id,
            page_count as i64,
            thumb_name,
            chrono::Utc::now().to_rfc3339(),
            modified_at,
        ],
    )?;
    Ok(true)
}

fn parse_series_metadata(folder: &Path, folder_name: &str) -> (String, String, Option<String>) {
    let info = fs::read_to_string(folder.join("info.txt")).unwrap_or_default();
    let mut title = String::new();
    let mut author = String::new();
    let mut gallery_id: Option<String> = None;
    for line in info.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().to_string();
        match key.trim() {
            "제목" => title = value,
            "작가" => author = value,
            "갤러리 넘버" => gallery_id = Some(value),
            _ => {}
        }
    }
    if title.is_empty() {
        title = folder_name
            .split(" _ ")
            .next()
            .unwrap_or(folder_name)
            .to_string();
    }
    if author.is_empty() {
        author = folder_name
            .split(']')
            .next()
            .and_then(|part| part.strip_prefix('['))
            .map(|part| part.trim().to_string())
            .unwrap_or_default();
    }
    (title, author, gallery_id)
}

pub(crate) fn list_page_files(folder: &Path) -> Result<Vec<String>, LibraryError> {
    let mut pages: Vec<(u32, String)> = Vec::new();
    let Ok(entries) = fs::read_dir(folder) else {
        return Ok(Vec::new());
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.split_once('.') else {
            continue;
        };
        let Ok(number) = stem.0.parse::<u32>() else {
            continue;
        };
        let ext = stem.1.to_ascii_lowercase();
        if matches!(
            ext.as_str(),
            "webp" | "avif" | "jpg" | "jpeg" | "png" | "gif"
        ) {
            pages.push((number, name));
        }
    }
    pages.sort_by_key(|(number, _)| *number);
    Ok(pages.into_iter().map(|(_, name)| name).collect())
}

fn create_thumbnail(source: &Path, target: &Path) -> Result<(), LibraryError> {
    let file = fs::File::open(source).map_err(|source_err| LibraryError::ReadMedia {
        path: source.to_path_buf(),
        source: source_err,
    })?;
    let reader = image::ImageReader::new(std::io::BufReader::new(file))
        .with_guessed_format()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let image = reader
        .decode()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let out = fs::File::create(target).map_err(|source_err| LibraryError::WriteAsset {
        path: target.to_path_buf(),
        source: source_err,
    })?;
    image
        .thumbnail(400, 400)
        .write_to(&mut std::io::BufWriter::new(out), image::ImageFormat::WebP)
        .map_err(|_| LibraryError::UnsupportedImage)
}

pub(crate) fn preview_catalog_recovery(
    library: &Library,
) -> Result<MangaCatalogRecoveryPreview, LibraryError> {
    let catalog_path = library.root().join("catalogs/kdata.db");
    if !catalog_path.exists() {
        return Err(LibraryError::OnlineCatalogNotInstalled);
    }
    let connection = library.connection()?;
    connection.execute(
        "ATTACH DATABASE ?1 AS catalog",
        [catalog_path.to_string_lossy().as_ref()],
    )?;
    let provider = super::catalog_provider::LEGACY_VCK_PROVIDER;
    let mut statement = connection.prepare(
        "SELECT m.id, m.title, m.author, m.gallery_id, m.page_count,
                w.Id, w.Title, w.TitleJpn, w.FileCount, w.Expunged,
                EXISTS(SELECT 1 FROM online_catalog_bookmarks AS bookmark
                       WHERE bookmark.provider = ?1 AND bookmark.work_id = CAST(w.Id AS TEXT))
         FROM manga_series AS m
         LEFT JOIN catalog.Works AS w ON w.Id = CAST(m.gallery_id AS INTEGER)
         ORDER BY m.title COLLATE NOCASE, m.id",
    )?;
    let rows = statement.query_map([provider], |row| {
        let work_id = row.get::<_, Option<i64>>(5)?;
        let expunged = row.get::<_, Option<i64>>(9)?.unwrap_or_default() != 0;
        let status = match (work_id, expunged) {
            (Some(_), false) => MangaCatalogRecoveryStatus::ExactActive,
            (Some(_), true) => MangaCatalogRecoveryStatus::Historical,
            (None, _) => MangaCatalogRecoveryStatus::Fallback,
        };
        Ok(MangaCatalogRecoveryItem {
            manga_id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            gallery_id: row.get(3)?,
            page_count: row.get::<_, i64>(4)?.max(0) as u64,
            status,
            work_id: work_id.and_then(|value| u64::try_from(value).ok()),
            catalog_title: row.get(6)?,
            catalog_title_jpn: row.get(7)?,
            catalog_file_count: row
                .get::<_, Option<i64>>(8)?
                .map(|value| value.max(0) as u64),
            bookmarked: row.get::<_, i64>(10)? != 0,
        })
    })?;
    let items = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(MangaCatalogRecoveryPreview {
        total_count: items.len() as u64,
        exact_active_count: items
            .iter()
            .filter(|item| item.status == MangaCatalogRecoveryStatus::ExactActive)
            .count() as u64,
        historical_count: items
            .iter()
            .filter(|item| item.status == MangaCatalogRecoveryStatus::Historical)
            .count() as u64,
        fallback_count: items
            .iter()
            .filter(|item| item.status == MangaCatalogRecoveryStatus::Fallback)
            .count() as u64,
        already_bookmarked_count: items.iter().filter(|item| item.bookmarked).count() as u64,
        items,
    })
}

pub(crate) fn apply_exact_catalog_recovery(
    library: &Library,
) -> Result<MangaCatalogRecoveryApplyResult, LibraryError> {
    let catalog_path = library.root().join("catalogs/kdata.db");
    if !catalog_path.exists() {
        return Err(LibraryError::OnlineCatalogNotInstalled);
    }
    let mut connection = library.connection()?;
    connection.execute(
        "ATTACH DATABASE ?1 AS catalog",
        [catalog_path.to_string_lossy().as_ref()],
    )?;
    let candidates = {
        let mut statement = connection.prepare(
            "SELECT m.id, w.Id FROM manga_series AS m
             JOIN catalog.Works AS w ON w.Id = CAST(m.gallery_id AS INTEGER)
             WHERE w.Expunged = 0 ORDER BY m.id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let provider = super::catalog_provider::LEGACY_VCK_PROVIDER;
    let now = chrono::Utc::now().to_rfc3339();
    let transaction = connection.transaction()?;
    let mut created_bookmarks = 0u64;
    let mut existing_bookmarks = 0u64;
    for (manga_id, work_id) in &candidates {
        let work_id = work_id.to_string();
        let already_bookmarked: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM online_catalog_bookmarks WHERE provider = ?1 AND work_id = ?2)",
            rusqlite::params![provider, work_id], |row| row.get(0),
        )?;
        let inserted = if already_bookmarked {
            existing_bookmarks += 1;
            false
        } else {
            transaction.execute(
                "INSERT INTO online_catalog_bookmarks (provider, work_id, created_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(provider, work_id) DO NOTHING",
                rusqlite::params![provider, work_id, now],
            )? > 0
        };
        if inserted {
            created_bookmarks += 1;
        }
        transaction.execute(
            "INSERT INTO manga_catalog_recovery_links
                (manga_id, provider, work_id, match_method, bookmark_created, created_at)
             VALUES (?1, ?2, ?3, 'exact_active', ?4, ?5)
             ON CONFLICT(manga_id) DO NOTHING",
            rusqlite::params![manga_id, provider, work_id, i64::from(inserted), now],
        )?;
    }
    transaction.commit()?;
    Ok(MangaCatalogRecoveryApplyResult {
        matched_count: candidates.len() as u64,
        created_bookmarks,
        existing_bookmarks,
    })
}

pub(crate) fn list_series(
    connection: &rusqlite::Connection,
) -> Result<Vec<MangaSeries>, LibraryError> {
    let mut statement = connection.prepare(
        "SELECT id, title, author, gallery_id, page_count
         FROM manga_series ORDER BY modified_at DESC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(MangaSeries {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            gallery_id: row.get(3)?,
            page_count: row.get::<_, i64>(4)? as u64,
        })
    })?;
    let mut series = Vec::new();
    for row in rows {
        series.push(row?);
    }
    Ok(series)
}

#[cfg(test)]
mod tests {
    use std::{fs, sync::mpsc, thread, time::Duration};

    use rusqlite::Connection;

    use super::{list_page_files, parse_series_metadata, scan_with_thumbnail};
    use crate::library::{Library, LibraryError};

    #[test]
    fn list_page_files_sorts_two_and_three_digit_names() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["02.webp", "001.webp", "10.avif", "1.webp", "3.webp"] {
            fs::write(temp.path().join(name), b"x").unwrap();
        }
        let pages = list_page_files(temp.path()).unwrap();
        assert_eq!(
            pages,
            vec!["001.webp", "1.webp", "02.webp", "3.webp", "10.avif"]
        );
    }

    #[test]
    fn parse_series_metadata_prefers_info_txt() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("info.txt"),
            "갤러리 넘버: 4038596\n제목: Batsu Kano\n작가: amatani haruka\n",
        )
        .unwrap();
        let (title, author, gallery) = parse_series_metadata(temp.path(), "[other] fallback (1)");
        assert_eq!(title, "Batsu Kano");
        assert_eq!(author, "amatani haruka");
        assert_eq!(gallery.as_deref(), Some("4038596"));
    }

    #[test]
    fn parse_series_metadata_falls_back_to_folder_name() {
        let temp = tempfile::tempdir().unwrap();
        let (title, author, gallery) =
            parse_series_metadata(temp.path(), "[unknown] Some Title _ 한국어 (12345)");
        assert_eq!(title, "[unknown] Some Title");
        assert_eq!(author, "unknown");
        assert_eq!(gallery, None);
    }

    #[test]
    fn slow_thumbnail_generation_does_not_block_database_reads() {
        let temp = tempfile::tempdir().unwrap();
        let manga_root = temp.path().join("manga");
        let series = manga_root.join("series-a");
        fs::create_dir_all(&series).unwrap();
        fs::write(series.join("1.webp"), b"page").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        library
            .set_manga_root(Some(manga_root.to_string_lossy().as_ref()))
            .unwrap();

        let (thumbnail_started_tx, thumbnail_started_rx) = mpsc::channel();
        let (release_thumbnail_tx, release_thumbnail_rx) = mpsc::channel();
        let scan_library = library.clone();
        let scan = thread::spawn(move || {
            scan_with_thumbnail(&scan_library, |_, target| {
                thumbnail_started_tx.send(()).unwrap();
                release_thumbnail_rx.recv().unwrap();
                fs::write(target, b"thumbnail").unwrap();
                Ok(())
            })
        });
        thumbnail_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let (read_finished_tx, read_finished_rx) = mpsc::channel();
        let read_library = library.clone();
        let read = thread::spawn(move || {
            read_finished_tx.send(read_library.manga_root()).unwrap();
        });
        let read_finished = read_finished_rx
            .recv_timeout(Duration::from_millis(250))
            .is_ok();

        release_thumbnail_tx.send(()).unwrap();
        scan.join().unwrap().unwrap();
        read.join().unwrap();
        assert!(
            read_finished,
            "database reads waited for thumbnail generation"
        );
    }

    #[test]
    fn concurrent_scans_do_not_run_thumbnail_generation_together() {
        let temp = tempfile::tempdir().unwrap();
        let manga_root = temp.path().join("manga");
        let series = manga_root.join("series-a");
        fs::create_dir_all(&series).unwrap();
        fs::write(series.join("1.webp"), b"page").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        library
            .set_manga_root(Some(manga_root.to_string_lossy().as_ref()))
            .unwrap();

        let (first_started_tx, first_started_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let first_library = library.clone();
        let first = thread::spawn(move || {
            scan_with_thumbnail(&first_library, |_, target| {
                first_started_tx.send(()).unwrap();
                release_first_rx.recv().unwrap();
                fs::write(target, b"thumbnail").unwrap();
                Ok(())
            })
        });
        first_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let (second_finished_tx, second_finished_rx) = mpsc::channel();
        let second_library = library.clone();
        let second = thread::spawn(move || {
            let result = scan_with_thumbnail(&second_library, |_, target| {
                fs::write(target, b"thumbnail").unwrap();
                Ok(())
            });
            second_finished_tx.send(result).unwrap();
        });
        let overlapped = second_finished_rx
            .recv_timeout(Duration::from_millis(250))
            .is_ok();

        release_first_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        second.join().unwrap();
        assert!(!overlapped, "concurrent manga scans overlapped");
    }

    #[test]
    fn unsupported_first_page_does_not_block_later_series() {
        let temp = tempfile::tempdir().unwrap();
        let manga_root = temp.path().join("manga");
        // 열거 순서에서 실패 폴더가 먼저 와도 뒤 폴더가 색인돼야 한다.
        let failing = manga_root.join("a-unsupported");
        fs::create_dir_all(&failing).unwrap();
        fs::write(failing.join("1.avif"), b"avif").unwrap();
        fs::write(failing.join("2.webp"), b"page").unwrap();
        let good = manga_root.join("b-decodable");
        fs::create_dir_all(&good).unwrap();
        fs::write(good.join("1.webp"), b"page").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        library
            .set_manga_root(Some(manga_root.to_string_lossy().as_ref()))
            .unwrap();

        let result = scan_with_thumbnail(&library, |source, target| {
            if source.extension().is_some_and(|ext| ext == "avif") {
                Err(LibraryError::UnsupportedImage)
            } else {
                fs::write(target, b"thumbnail").unwrap();
                Ok(())
            }
        })
        .unwrap();

        assert_eq!(result, 2, "both series should be indexed");
        let connection = library.connection().unwrap();
        let indexed: String = connection
            .query_row(
                "SELECT relative_path FROM manga_series WHERE relative_path = 'b-decodable'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indexed, "b-decodable");
    }

    #[test]
    fn series_without_thumbnailable_pages_stays_indexed() {
        let temp = tempfile::tempdir().unwrap();
        let manga_root = temp.path().join("manga");
        let failing = manga_root.join("unsupported-only");
        fs::create_dir_all(&failing).unwrap();
        fs::write(failing.join("1.avif"), b"avif").unwrap();
        fs::write(failing.join("2.avif"), b"avif").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        library
            .set_manga_root(Some(manga_root.to_string_lossy().as_ref()))
            .unwrap();

        let changed = scan_with_thumbnail(&library, |_, _| {
            Err(LibraryError::UnsupportedImage)
        })
        .unwrap();

        assert_eq!(changed, 1, "the series itself must stay indexed");
        let connection = library.connection().unwrap();
        let (relative_path, thumb_relative): (String, String) = connection
            .query_row(
                "SELECT relative_path, thumbnail_relative_path FROM manga_series",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(relative_path, "unsupported-only");
        assert!(thumb_relative.ends_with(".webp"));
        assert!(!manga_root.join(".lakomics-thumbs").join(&thumb_relative).exists());
    }

    #[test]
    fn unexpected_thumbnail_errors_still_propagate() {
        let temp = tempfile::tempdir().unwrap();
        let manga_root = temp.path().join("manga");
        let series = manga_root.join("series-a");
        fs::create_dir_all(&series).unwrap();
        fs::write(series.join("1.webp"), b"page").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        library
            .set_manga_root(Some(manga_root.to_string_lossy().as_ref()))
            .unwrap();

        let result = scan_with_thumbnail(&library, |_, _| {
            Err(LibraryError::WriteAsset {
                path: std::path::PathBuf::from("thumb.webp"),
                source: std::io::Error::other("disk full"),
            })
        });

        assert!(matches!(result, Err(LibraryError::WriteAsset { .. })));
        let connection = library.connection().unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM manga_series", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "scan must abort instead of half-indexing on unexpected errors");
    }

    #[test]
    fn scan_preserves_series_whose_source_folder_disappeared() {
        let temp = tempfile::tempdir().unwrap();
        let manga_root = temp.path().join("manga");
        let series = manga_root.join("series-a");
        fs::create_dir_all(&series).unwrap();
        fs::write(series.join("1.webp"), b"page").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        library
            .set_manga_root(Some(manga_root.to_string_lossy().as_ref()))
            .unwrap();

        scan_with_thumbnail(&library, |_, target| {
            fs::write(target, b"thumbnail").unwrap();
            Ok(())
        })
        .unwrap();
        fs::remove_dir_all(&series).unwrap();

        let changed = scan_with_thumbnail(&library, |_, target| {
            fs::write(target, b"thumbnail").unwrap();
            Ok(())
        })
        .unwrap();

        assert_eq!(changed, 0);
        let count: i64 = library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM manga_series", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "missing source folders must not erase recovery metadata");
    }

    fn write_recovery_catalog(library: &Library) {
        let catalogs = library.root().join("catalogs");
        fs::create_dir_all(&catalogs).unwrap();
        let catalog = Connection::open(catalogs.join("kdata.db")).unwrap();
        catalog
            .execute_batch(
                r#"                CREATE TABLE Works (
                    Id INTEGER PRIMARY KEY,
                    Title TEXT NOT NULL DEFAULT '',
                    TitleJpn TEXT,
                    FileCount INTEGER NOT NULL DEFAULT 0,
                    Expunged INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO Works (Id, Title, TitleJpn, FileCount, Expunged) VALUES
                    (10, 'Active A', 'Active A JP', 20, 0),
                    (11, 'Historical', NULL, 21, 1),
                    (12, 'Active B', NULL, 22, 0);
                "#,
            )
            .unwrap();
    }

    fn insert_recovery_manga(library: &Library, id: &str, gallery_id: &str, page_count: i64) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO manga_series
                    (id, relative_path, title, author, gallery_id, page_count,
                     thumbnail_relative_path, scanned_at, modified_at)
                 VALUES (?1, ?2, ?3, 'artist', ?4, ?5, 'thumb.webp', 'now', 'now')",
                rusqlite::params![id, format!("path-{id}"), format!("Title {id}"), gallery_id, page_count],
            )
            .unwrap();
    }

    #[test]
    fn catalog_recovery_preview_and_apply_are_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        write_recovery_catalog(&library);
        insert_recovery_manga(&library, "m-active-a", "10", 20);
        insert_recovery_manga(&library, "m-historical", "11", 21);
        insert_recovery_manga(&library, "m-active-b", "12", 22);
        insert_recovery_manga(&library, "m-fallback", "999", 23);
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO online_catalog_bookmarks (provider, work_id, created_at)
                 VALUES ('kHentai', '12', 'before-recovery')",
                [],
            )
            .unwrap();

        let preview = library.preview_manga_catalog_recovery().unwrap();
        assert_eq!(preview.total_count, 4);
        assert_eq!(preview.exact_active_count, 2);
        assert_eq!(preview.historical_count, 1);
        assert_eq!(preview.fallback_count, 1);
        assert_eq!(preview.already_bookmarked_count, 1);

        let first = library.apply_manga_catalog_recovery().unwrap();
        assert_eq!(first.matched_count, 2);
        assert_eq!(first.created_bookmarks, 1);
        assert_eq!(first.existing_bookmarks, 1);

        let second = library.apply_manga_catalog_recovery().unwrap();
        assert_eq!(second.matched_count, 2);
        assert_eq!(second.created_bookmarks, 0);
        assert_eq!(second.existing_bookmarks, 2);

        let connection = library.connection().unwrap();
        let bookmark_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM online_catalog_bookmarks", [], |row| row.get(0))
            .unwrap();
        let link_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM manga_catalog_recovery_links", [], |row| row.get(0))
            .unwrap();
        let created_by_recovery: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(bookmark_created), 0) FROM manga_catalog_recovery_links",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(bookmark_count, 2);
        assert_eq!(link_count, 2);
        assert_eq!(created_by_recovery, 1);
    }

}
