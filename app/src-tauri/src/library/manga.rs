use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::OptionalExtension;

use super::error::LibraryError;
use super::models::MangaSeries;
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
    let mut seen_paths: Vec<String> = Vec::new();
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
        seen_paths.push(folder_name.clone());
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
    // 삭제된 폴더 정리: DB에 있지만 이번 스캔에서 못 본 시리즈는 제거
    let connection = library.connection()?;
    let mut statement = connection.prepare("SELECT relative_path FROM manga_series")?;
    let db_paths: Vec<String> = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    for db_path in db_paths {
        if !seen_paths.contains(&db_path) {
            connection.execute(
                "DELETE FROM manga_series WHERE relative_path = ?1",
                [&db_path],
            )?;
        }
    }
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
    let first_page = &page_files[0];
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
        thumbnail(&folder.join(first_page), &thumb_path)?;
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

    use super::{list_page_files, parse_series_metadata, scan_with_thumbnail};
    use crate::library::Library;

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
}
