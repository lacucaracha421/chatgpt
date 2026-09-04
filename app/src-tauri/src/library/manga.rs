use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::OptionalExtension;

use super::error::LibraryError;
use super::models::{
    MangaCatalogRecoveryApplyResult, MangaCatalogRecoveryItem, MangaCatalogRecoveryPreview,
    MangaCatalogRecoverySelection, MangaCatalogRecoveryStatus, MangaRecoveryCandidate,
    MangaRecoveryConfidence, MangaSeries,
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

    repair_legacy_recovery_source_paths(library)?;

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

pub(crate) fn repair_legacy_recovery_source_paths(library: &Library) -> Result<(), LibraryError> {
    let unresolved_links: i64 = {
        let connection = library.connection()?;
        connection.query_row(
            "SELECT COUNT(*) FROM manga_catalog_recovery_links WHERE source_relative_path IS NULL",
            [],
            |row| row.get(0),
        )?
    };
    let catalog_path = library.root().join("catalogs/kdata.db");
    if unresolved_links == 0 || !catalog_path.exists() {
        return Ok(());
    }

    let preview = preview_catalog_recovery(library)?;
    let relative_paths = {
        let connection = library.connection()?;
        let mut statement = connection.prepare("SELECT id, relative_path FROM manga_series")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<std::collections::BTreeMap<_, _>, _>>()?
    };

    let links = {
        let connection = library.connection()?;
        let mut statement = connection.prepare(
            "SELECT manga_id, work_id, match_method FROM manga_catalog_recovery_links
             WHERE source_relative_path IS NULL ORDER BY created_at, manga_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let mut claimed = std::collections::BTreeSet::new();
    let mut resolved = Vec::new();
    for (link_manga_id, work_id_raw, method) in links {
        let Ok(work_id) = work_id_raw.parse::<u64>() else {
            continue;
        };
        let matches = preview
            .items
            .iter()
            .filter(|item| {
                let matches_method = match method.as_str() {
                    "exact_active" => {
                        item.status == MangaCatalogRecoveryStatus::ExactActive
                            && item.work_id == Some(work_id)
                    }
                    "historical_lineage" => {
                        item.status == MangaCatalogRecoveryStatus::Historical
                            && item.suggested_work_id == Some(work_id)
                    }
                    "candidate_review" => {
                        item.status == MangaCatalogRecoveryStatus::Fallback
                            && item
                                .candidates
                                .iter()
                                .any(|candidate| candidate.work_id == work_id)
                    }
                    _ => false,
                };
                matches_method && relative_paths.contains_key(&item.manga_id)
            })
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            continue;
        }
        let current_manga_id = matches[0].manga_id.clone();
        if !claimed.insert(current_manga_id.clone()) {
            continue;
        }
        let relative_path = relative_paths[&current_manga_id].clone();
        resolved.push((link_manga_id, current_manga_id, relative_path));
    }

    if resolved.is_empty() {
        return Ok(());
    }
    let mut connection = library.connection()?;
    let transaction = connection.transaction()?;
    for (link_manga_id, current_manga_id, relative_path) in resolved {
        let updated = transaction.execute(
            "UPDATE manga_catalog_recovery_links SET source_relative_path = ?1
             WHERE manga_id = ?2 AND source_relative_path IS NULL",
            rusqlite::params![relative_path, link_manga_id],
        )?;
        if updated > 0 {
            transaction.execute("DELETE FROM manga_series WHERE id = ?1", [current_manga_id])?;
        }
    }
    transaction.commit()?;
    Ok(())
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
    let recovered = {
        let connection = library.connection()?;
        let recovered: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM manga_catalog_recovery_links WHERE source_relative_path = ?1)",
            [relative_path],
            |row| row.get(0),
        )?;
        if recovered {
            connection.execute(
                "DELETE FROM manga_series WHERE relative_path = ?1",
                [relative_path],
            )?;
        }
        recovered
    };
    if recovered {
        return Ok(false);
    }

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
                       WHERE bookmark.provider = ?1 AND bookmark.work_id = CAST(w.Id AS TEXT)),
                m.relative_path, w.CurrentGid, w.FirstGid, w.ParentGid
         FROM manga_series AS m
         LEFT JOIN catalog.Works AS w ON w.Id = CAST(m.gallery_id AS INTEGER)
         ORDER BY m.title COLLATE NOCASE, m.id",
    )?;
    struct RecoveryRow {
        item: MangaCatalogRecoveryItem,
        relative_path: String,
        lineage: (Option<i64>, Option<i64>, Option<i64>),
    }
    let rows = statement.query_map([provider], |row| {
        let work_id = row.get::<_, Option<i64>>(5)?;
        let expunged = row.get::<_, Option<i64>>(9)?.unwrap_or_default() != 0;
        let status = match (work_id, expunged) {
            (Some(_), false) => MangaCatalogRecoveryStatus::ExactActive,
            (Some(_), true) => MangaCatalogRecoveryStatus::Historical,
            (None, _) => MangaCatalogRecoveryStatus::Fallback,
        };
        Ok(RecoveryRow {
            item: MangaCatalogRecoveryItem {
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
                suggested_work_id: None,
                suggestion_reason: None,
                suggestion_title: None,
                candidates: Vec::new(),
            },
            relative_path: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
            lineage: (
                row.get::<_, Option<i64>>(12)?,
                row.get::<_, Option<i64>>(13)?,
                row.get::<_, Option<i64>>(14)?,
            ),
        })
    })?;
    let mut rows = rows.collect::<Result<Vec<_>, _>>()?;
    for row in &mut rows {
        match row.item.status {
            MangaCatalogRecoveryStatus::Historical => {
                if let Some((target, reason, title)) =
                    resolve_lineage_suggestion(&connection, row.item.work_id, row.lineage)?
                {
                    row.item.suggested_work_id = Some(target);
                    row.item.suggestion_reason = Some(reason.to_string());
                    row.item.suggestion_title = Some(title);
                }
            }
            MangaCatalogRecoveryStatus::Fallback => {
                row.item.candidates = rank_recovery_candidates(
                    &connection,
                    &row.item.title,
                    &row.item.author,
                    row.item.gallery_id.as_deref(),
                    &row.relative_path,
                    row.item.page_count,
                )?;
            }
            MangaCatalogRecoveryStatus::ExactActive => {}
        }
    }
    let items = rows.into_iter().map(|row| row.item).collect::<Vec<_>>();
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

pub(crate) fn missing_catalog_recovery_gallery_ids(
    library: &Library,
) -> Result<Vec<u64>, LibraryError> {
    let catalog_path = library.root().join("catalogs/kdata.db");
    if !catalog_path.exists() {
        return Err(LibraryError::OnlineCatalogNotInstalled);
    }
    let connection = library.connection()?;
    connection.execute(
        "ATTACH DATABASE ?1 AS catalog",
        [catalog_path.to_string_lossy().as_ref()],
    )?;
    let mut statement = connection.prepare(
        "SELECT DISTINCT gallery_id FROM manga_series
         WHERE gallery_id IS NOT NULL AND trim(gallery_id) <> ''
         ORDER BY gallery_id",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut ids = Vec::new();
    for row in rows {
        let raw = row?;
        let Ok(id) = raw.trim().parse::<u64>() else {
            continue;
        };
        let Ok(sql_id) = i64::try_from(id) else {
            continue;
        };
        if id == 0 {
            continue;
        }
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM catalog.Works WHERE Id = ?1)",
            [sql_id],
            |row| row.get(0),
        )?;
        if !exists {
            ids.push(id);
        }
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

fn active_work_title(
    connection: &rusqlite::Connection,
    work_id: i64,
) -> Result<Option<String>, LibraryError> {
    connection
        .query_row(
            "SELECT Title FROM catalog.Works WHERE Id = ?1 AND Expunged = 0",
            [work_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(LibraryError::from)
}

/// 삭제/만료된 작품을 카탈로그 계보 필드로 현행 작품에 연결한다.
/// CurrentGid -> FirstGid -> ParentGid 순서로 확인하며, 각 후보는 반드시
/// 현행(`Expunged = 0`) 작품이어야 하고 자기 자신으로 돌아오면 안 된다.
/// 계보로 연결되지 않으면 `Ok(None)`이며 해당 항목은 계속 검토 전용이다.
fn resolve_lineage_suggestion(
    connection: &rusqlite::Connection,
    work_id: Option<u64>,
    lineage: (Option<i64>, Option<i64>, Option<i64>),
) -> Result<Option<(u64, &'static str, String)>, LibraryError> {
    let Some(original) = work_id else {
        return Ok(None);
    };
    for (candidate, reason) in [
        (lineage.0, "현행판"),
        (lineage.1, "초판"),
        (lineage.2, "상위 작품"),
    ] {
        let Some(candidate) = candidate else {
            continue;
        };
        if candidate <= 0 {
            continue;
        }
        let Ok(target) = u64::try_from(candidate) else {
            continue;
        };
        if target == original {
            continue;
        }
        if let Some(title) = active_work_title(connection, candidate)? {
            return Ok(Some((target, reason, title)));
        }
    }
    Ok(None)
}

fn normalize_recovery_text(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn split_author_tokens(author: &str) -> Vec<String> {
    author
        .split([',', '/', '、', '&', '＆', '+', ';', '|'])
        .map(|token| normalize_recovery_text(token))
        .filter(|token| !token.is_empty())
        .collect()
}

fn title_supports(local_title: &str, catalog_title: &str, catalog_title_jpn: &str) -> bool {
    let local = normalize_recovery_text(local_title).replace(' ', "");
    if local.len() < 2 {
        return false;
    }
    for candidate in [catalog_title, catalog_title_jpn] {
        let normalized = normalize_recovery_text(candidate).replace(' ', "");
        if normalized.len() >= 2 && (normalized.contains(&local) || local.contains(&normalized)) {
            return true;
        }
    }
    false
}

fn digit_sequences(value: &str) -> Vec<i64> {
    let mut sequences = Vec::new();
    let mut current = String::new();
    for character in value.chars() {
        if character.is_ascii_digit() {
            current.push(character);
        } else if !current.is_empty() {
            if let Ok(number) = current.parse::<i64>() {
                sequences.push(number);
            }
            current.clear();
        }
    }
    if !current.is_empty() {
        if let Ok(number) = current.parse::<i64>() {
            sequences.push(number);
        }
    }
    sequences.sort_unstable();
    sequences.dedup();
    sequences
}

struct CandidateWork {
    id: i64,
    title: String,
    title_jpn: Option<String>,
    file_count: i64,
    artists: Vec<String>,
}

/// Fallback 항목의 후보를 순위 매겨 최대 3개 반환한다.
/// - 숫자 ID 일치는 결정적이므로 항상 제안(confidence `suggested`)
/// - 작가+페이지+제목 3신호는 제안, 2신호는 검토용
/// - 제목 유사도 단독(또는 단일 신호)은 후보에서 제외한다
fn rank_recovery_candidates(
    connection: &rusqlite::Connection,
    title: &str,
    author: &str,
    gallery_id: Option<&str>,
    relative_path: &str,
    page_count: u64,
) -> Result<Vec<MangaRecoveryCandidate>, LibraryError> {
    let mut candidates: Vec<MangaRecoveryCandidate> = Vec::new();
    let mut seen: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();

    let mut numeric_hits = Vec::new();
    for source in [gallery_id.unwrap_or_default(), title, relative_path] {
        numeric_hits.extend(digit_sequences(source));
    }
    numeric_hits.sort_unstable();
    numeric_hits.dedup();
    for number in numeric_hits {
        if number <= 0 {
            continue;
        }
        let hit: Option<(i64, String, Option<String>, Option<i64>)> = connection
            .query_row(
                "SELECT Id, Title, TitleJpn, FileCount FROM catalog.Works
                 WHERE Id = ?1 AND Expunged = 0",
                [number],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((id, work_title, work_title_jpn, file_count)) = hit {
            if seen.insert(id) {
                let artists = catalog_artists(connection, &[id])?;
                candidates.push(MangaRecoveryCandidate {
                    work_id: id as u64,
                    title: work_title,
                    title_jpn: work_title_jpn,
                    artist: artists.get(&id).and_then(|values| values.first()).cloned(),
                    file_count: file_count.and_then(|value| u64::try_from(value.max(0)).ok()),
                    reasons: vec!["ID 숫자 일치".to_string()],
                    confidence: MangaRecoveryConfidence::Suggested,
                });
            }
        }
    }

    let author_tokens = split_author_tokens(author);
    let pool: Vec<CandidateWork> = if page_count > 0 {
        let low = page_count.saturating_sub(2) as i64;
        let high = page_count.saturating_add(2) as i64;
        let mut statement = connection.prepare(
            "SELECT Id, Title, TitleJpn, FileCount FROM catalog.Works
             WHERE Expunged = 0 AND FileCount BETWEEN ?1 AND ?2 ORDER BY Id LIMIT 2000",
        )?;
        let rows = statement.query_map([low, high], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        let mut works = Vec::new();
        for row in rows {
            let (id, work_title, work_title_jpn, file_count) = row?;
            works.push(CandidateWork {
                id,
                title: work_title,
                title_jpn: work_title_jpn,
                file_count,
                artists: Vec::new(),
            });
        }
        works
    } else if author_tokens.is_empty() {
        Vec::new()
    } else {
        let placeholders = author_tokens
            .iter()
            .map(|_| "?".to_string())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT DISTINCT w.Id, w.Title, w.TitleJpn, w.FileCount
             FROM catalog.Works AS w
             JOIN catalog.Tags AS t ON t.WorkId = w.Id
             WHERE w.Expunged = 0 AND t.Namespace = 'artist'
               AND lower(t.Value) IN ({placeholders}) ORDER BY w.Id LIMIT 500"
        );
        let mut statement = connection.prepare(&sql)?;
        let rows =
            statement.query_map(rusqlite::params_from_iter(author_tokens.iter()), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?;
        let mut works = Vec::new();
        for row in rows {
            let (id, work_title, work_title_jpn, file_count) = row?;
            works.push(CandidateWork {
                id,
                title: work_title,
                title_jpn: work_title_jpn,
                file_count,
                artists: Vec::new(),
            });
        }
        works
    };
    if !pool.is_empty() {
        let ids = pool.iter().map(|work| work.id).collect::<Vec<_>>();
        let artists = catalog_artists(connection, &ids)?;
        let mut scored: Vec<(usize, MangaRecoveryCandidate)> = Vec::new();
        for mut work in pool {
            if !seen.insert(work.id) {
                continue;
            }
            work.artists = artists.get(&work.id).cloned().unwrap_or_default();
            let artist_hit = !author_tokens.is_empty()
                && work.artists.iter().any(|artist| {
                    let normalized = normalize_recovery_text(artist);
                    author_tokens.iter().any(|token| {
                        normalized == *token
                            || normalized.contains(token.as_str())
                            || token.contains(normalized.as_str())
                    })
                });
            let page_hit =
                page_count > 0 && (work.file_count.max(0) as u64).abs_diff(page_count) <= 2;
            let title_hit = title_supports(
                title,
                &work.title,
                work.title_jpn.as_deref().unwrap_or_default(),
            );
            let mut reasons = Vec::new();
            if artist_hit {
                reasons.push("작가 일치".to_string());
            }
            if page_hit {
                reasons.push("페이지 수 일치".to_string());
            }
            if title_hit {
                reasons.push("제목 유사".to_string());
            }
            let signals = reasons.len();
            let confidence = if signals >= 3 {
                Some(MangaRecoveryConfidence::Suggested)
            } else if signals == 2 {
                Some(MangaRecoveryConfidence::Review)
            } else {
                None
            };
            if let Some(confidence) = confidence {
                scored.push((
                    signals,
                    MangaRecoveryCandidate {
                        work_id: work.id as u64,
                        artist: work.artists.first().cloned(),
                        title: work.title,
                        title_jpn: work.title_jpn,
                        file_count: u64::try_from(work.file_count.max(0)).ok(),
                        reasons,
                        confidence,
                    },
                ));
            }
        }
        scored.sort_by(|left, right| {
            let confidence_rank = |confidence: MangaRecoveryConfidence| match confidence {
                MangaRecoveryConfidence::Suggested => 0,
                MangaRecoveryConfidence::Review => 1,
            };
            confidence_rank(left.1.confidence)
                .cmp(&confidence_rank(right.1.confidence))
                .then(right.0.cmp(&left.0))
                .then(left.1.work_id.cmp(&right.1.work_id))
        });
        for (_, candidate) in scored {
            candidates.push(candidate);
            if candidates.len() >= 3 {
                break;
            }
        }
    }
    candidates.truncate(3);
    Ok(candidates)
}

fn catalog_artists(
    connection: &rusqlite::Connection,
    work_ids: &[i64],
) -> Result<std::collections::BTreeMap<i64, Vec<String>>, LibraryError> {
    let mut map: std::collections::BTreeMap<i64, Vec<String>> = std::collections::BTreeMap::new();
    if work_ids.is_empty() {
        return Ok(map);
    }
    let placeholders = work_ids
        .iter()
        .map(|_| "?".to_string())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT WorkId, Value FROM catalog.Tags
         WHERE Namespace = 'artist' AND WorkId IN ({placeholders}) ORDER BY WorkId, Value"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(work_ids.iter()), |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (work_id, artist) = row?;
        map.entry(work_id).or_default().push(artist);
    }
    Ok(map)
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
            "SELECT m.id, m.relative_path, w.Id FROM manga_series AS m
             JOIN catalog.Works AS w ON w.Id = CAST(m.gallery_id AS INTEGER)
             WHERE w.Expunged = 0 ORDER BY m.id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let provider = super::catalog_provider::LEGACY_VCK_PROVIDER;
    let now = chrono::Utc::now().to_rfc3339();
    let transaction = connection.transaction()?;
    let mut created_bookmarks = 0u64;
    let mut existing_bookmarks = 0u64;
    for (manga_id, source_relative_path, work_id) in &candidates {
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
                (manga_id, provider, work_id, match_method, bookmark_created, created_at, source_relative_path)
             VALUES (?1, ?2, ?3, 'exact_active', ?4, ?5, ?6)
             ON CONFLICT(manga_id) DO NOTHING",
            rusqlite::params![manga_id, provider, work_id, i64::from(inserted), now, source_relative_path],
        )?;
        transaction.execute("DELETE FROM manga_series WHERE id = ?1", [manga_id])?;
    }
    transaction.commit()?;
    Ok(MangaCatalogRecoveryApplyResult {
        matched_count: candidates.len() as u64,
        created_bookmarks,
        existing_bookmarks,
    })
}

/// 검토된 historical/fallback 항목을 사용자가 명시적으로 선택한 작품에 연결한다.
///
/// 각 선택은 미리보기 기준으로 재검증한다: 해당 manga가 historical이면서 제안된
/// 작품과 일치하거나, fallback이면서 후보 목록에 포함된 작품이어야 하며, 작품은
/// 반드시 현행(`Expunged = 0`)이어야 한다. 검증을 통과하지 못한 선택은 무시된다.
/// 트랜잭션·멱등이며 매핑을 `manga_catalog_recovery_links`에 기록한다.
pub(crate) fn apply_selected_catalog_recovery(
    library: &Library,
    selections: &[MangaCatalogRecoverySelection],
) -> Result<MangaCatalogRecoveryApplyResult, LibraryError> {
    if selections.is_empty() {
        return Ok(MangaCatalogRecoveryApplyResult {
            matched_count: 0,
            created_bookmarks: 0,
            existing_bookmarks: 0,
        });
    }
    let preview = preview_catalog_recovery(library)?;
    let items = preview
        .items
        .iter()
        .map(|item| (item.manga_id.as_str(), item))
        .collect::<std::collections::BTreeMap<_, _>>();
    let provider = super::catalog_provider::LEGACY_VCK_PROVIDER;
    let now = chrono::Utc::now().to_rfc3339();
    let catalog_path = library.root().join("catalogs/kdata.db");
    let mut connection = library.connection()?;
    connection.execute(
        "ATTACH DATABASE ?1 AS catalog",
        [catalog_path.to_string_lossy().as_ref()],
    )?;
    let transaction = connection.transaction()?;
    let mut matched_count = 0u64;
    let mut created_bookmarks = 0u64;
    let mut existing_bookmarks = 0u64;
    for selection in selections {
        let Some(item) = items.get(selection.manga_id.as_str()) else {
            continue;
        };
        let (method, allowed) = match item.status {
            MangaCatalogRecoveryStatus::Historical => (
                "historical_lineage",
                item.suggested_work_id == Some(selection.work_id),
            ),
            MangaCatalogRecoveryStatus::Fallback => (
                "candidate_review",
                item.candidates
                    .iter()
                    .any(|candidate| candidate.work_id == selection.work_id),
            ),
            MangaCatalogRecoveryStatus::ExactActive => ("exact_active", false),
        };
        if !allowed {
            continue;
        }
        let source_relative_path: Option<String> = transaction
            .query_row(
                "SELECT relative_path FROM manga_series WHERE id = ?1",
                [&selection.manga_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(source_relative_path) = source_relative_path else {
            continue;
        };
        let work_id = selection.work_id.to_string();
        let catalog_active: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM catalog.Works WHERE Id = ?1 AND Expunged = 0)",
            [selection.work_id as i64],
            |row| row.get(0),
        )?;
        if !catalog_active {
            continue;
        }
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
                (manga_id, provider, work_id, match_method, bookmark_created, created_at, source_relative_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(manga_id) DO NOTHING",
            rusqlite::params![
                selection.manga_id,
                provider,
                work_id,
                method,
                i64::from(inserted),
                now,
                source_relative_path
            ],
        )?;
        transaction.execute(
            "DELETE FROM manga_series WHERE id = ?1",
            [&selection.manga_id],
        )?;
        matched_count += 1;
    }
    transaction.commit()?;
    Ok(MangaCatalogRecoveryApplyResult {
        matched_count,
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

        let changed =
            scan_with_thumbnail(&library, |_, _| Err(LibraryError::UnsupportedImage)).unwrap();

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
        assert!(!manga_root
            .join(".lakomics-thumbs")
            .join(&thumb_relative)
            .exists());
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
        assert_eq!(
            count, 0,
            "scan must abort instead of half-indexing on unexpected errors"
        );
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
        assert_eq!(
            count, 1,
            "missing source folders must not erase recovery metadata"
        );
    }

    #[test]
    fn scan_never_reindexes_a_recovered_source_path() {
        let temp = tempfile::tempdir().unwrap();
        let manga_root = temp.path().join("manga");
        let series = manga_root.join("series-a");
        fs::create_dir_all(&series).unwrap();
        fs::write(series.join("1.webp"), b"page").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        library
            .set_manga_root(Some(manga_root.to_string_lossy().as_ref()))
            .unwrap();
        library.connection().unwrap().execute(
            "INSERT INTO manga_catalog_recovery_links
             (manga_id, provider, work_id, match_method, bookmark_created, created_at, source_relative_path)
             VALUES ('old-id', 'kHentai', '10', 'exact_active', 1, 'now', 'series-a')",
            [],
        ).unwrap();

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
        assert_eq!(count, 0);
    }

    #[test]
    fn scan_repairs_legacy_recovery_links_before_reindexing() {
        let temp = tempfile::tempdir().unwrap();
        let manga_root = temp.path().join("manga");
        let series = manga_root.join("series-a");
        fs::create_dir_all(&series).unwrap();
        fs::write(series.join("1.webp"), b"page").unwrap();
        fs::write(
            series.join("info.txt"),
            "갤러리 넘버: 10\n제목: Active A\n작가: artist\n",
        )
        .unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        library
            .set_manga_root(Some(manga_root.to_string_lossy().as_ref()))
            .unwrap();
        write_recovery_catalog(&library);
        scan_with_thumbnail(&library, |_, target| {
            fs::write(target, b"thumbnail").unwrap();
            Ok(())
        })
        .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO manga_catalog_recovery_links
             (manga_id, provider, work_id, match_method, bookmark_created, created_at)
             VALUES ('pre-path-audit', 'kHentai', '10', 'exact_active', 1, 'now')",
                [],
            )
            .unwrap();

        let changed = scan_with_thumbnail(&library, |_, target| {
            fs::write(target, b"thumbnail").unwrap();
            Ok(())
        })
        .unwrap();

        assert_eq!(changed, 0);
        let connection = library.connection().unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM manga_series", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let source_relative_path: String = connection.query_row(
            "SELECT source_relative_path FROM manga_catalog_recovery_links WHERE manga_id = 'pre-path-audit'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(source_relative_path, "series-a");
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
                    Expunged INTEGER NOT NULL DEFAULT 0,
                    ParentGid INTEGER, CurrentGid INTEGER, FirstGid INTEGER
                );
                CREATE TABLE Tags (
                    WorkId INTEGER NOT NULL, Namespace TEXT NOT NULL, Value TEXT NOT NULL,
                    PRIMARY KEY (WorkId, Namespace, Value)
                ) WITHOUT ROWID;
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
                rusqlite::params![
                    id,
                    format!("path-{id}"),
                    format!("Title {id}"),
                    gallery_id,
                    page_count
                ],
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
        assert_eq!(second.matched_count, 0);
        assert_eq!(second.created_bookmarks, 0);
        assert_eq!(second.existing_bookmarks, 0);

        let connection = library.connection().unwrap();
        let bookmark_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM online_catalog_bookmarks", [], |row| {
                row.get(0)
            })
            .unwrap();
        let link_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manga_catalog_recovery_links",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let created_by_recovery: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(bookmark_created), 0) FROM manga_catalog_recovery_links",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let local_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM manga_series", [], |row| row.get(0))
            .unwrap();
        assert_eq!(bookmark_count, 2);
        assert_eq!(link_count, 2);
        assert_eq!(created_by_recovery, 1);
        assert_eq!(local_count, 2);
        let mut source_statement = connection.prepare(
            "SELECT source_relative_path FROM manga_catalog_recovery_links ORDER BY source_relative_path"
        ).unwrap();
        let source_paths = source_statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(source_paths, vec!["path-m-active-a", "path-m-active-b"]);
    }

    #[test]
    fn remote_recovery_ids_include_only_numeric_ids_missing_from_local_catalog() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        write_recovery_catalog(&library);
        insert_recovery_manga(&library, "m-known", "10", 20);
        insert_recovery_manga(&library, "m-missing", "999", 20);
        insert_recovery_manga(&library, "m-custom", "self-translation", 20);
        assert_eq!(
            library
                .missing_manga_catalog_recovery_gallery_ids()
                .unwrap(),
            vec![999]
        );
    }

    fn write_lineage_catalog(library: &Library) {
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
                    Expunged INTEGER NOT NULL DEFAULT 0,
                    ParentGid INTEGER, CurrentGid INTEGER, FirstGid INTEGER
                );
                CREATE TABLE Tags (
                    WorkId INTEGER NOT NULL, Namespace TEXT NOT NULL, Value TEXT NOT NULL,
                    PRIMARY KEY (WorkId, Namespace, Value)
                ) WITHOUT ROWID;
                -- 101: expunged, current edition 102 / 103: expunged without lineage
                -- 104: expunged pointing at another expunged work (no active target)
                INSERT INTO Works (Id, Title, FileCount, Expunged, CurrentGid) VALUES
                    (101, 'Old Edition', 20, 1, 102),
                    (102, 'New Edition', 20, 0, NULL),
                    (103, 'Lost Edition', 20, 1, NULL),
                    (104, 'Moved Twice', 20, 1, 105),
                    (105, 'Also Gone', 20, 1, NULL);
                -- 201: fallback candidate pool (artist + pages + title)
                INSERT INTO Works (Id, Title, TitleJpn, FileCount, Expunged) VALUES
                    (201, 'Starlight Academy', '스타라이트 아카데미', 30, 0),
                    (202, 'Starlight Academy Extra', NULL, 31, 0),
                    (203, 'Unrelated Title', NULL, 30, 0);
                INSERT INTO Tags (WorkId, Namespace, Value) VALUES
                    (201, 'artist', 'hana'),
                    (202, 'artist', 'hana'),
                    (203, 'artist', 'someone-else');
                "#,
            )
            .unwrap();
    }

    #[test]
    fn historical_lineage_suggests_the_current_edition() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        write_lineage_catalog(&library);
        insert_recovery_manga(&library, "m-old", "101", 20);
        insert_recovery_manga(&library, "m-lost", "103", 20);
        insert_recovery_manga(&library, "m-moved", "104", 20);

        let preview = library.preview_manga_catalog_recovery().unwrap();
        assert_eq!(preview.historical_count, 3);
        let by_id = preview
            .items
            .iter()
            .map(|item| (item.manga_id.as_str(), item))
            .collect::<std::collections::BTreeMap<_, _>>();

        let old = by_id["m-old"];
        assert_eq!(old.suggested_work_id, Some(102));
        assert_eq!(old.suggestion_reason.as_deref(), Some("현행판"));
        assert_eq!(old.suggestion_title.as_deref(), Some("New Edition"));

        // 계보가 없거나 현행 작품으로 이어지지 않으면 제안이 없고 검토 전용으로 남는다.
        assert_eq!(by_id["m-lost"].suggested_work_id, None);
        assert_eq!(by_id["m-moved"].suggested_work_id, None);
        assert!(by_id["m-moved"].candidates.is_empty());
    }

    #[test]
    fn historical_selection_apply_is_explicit_idempotent_and_recorded() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        write_lineage_catalog(&library);
        insert_recovery_manga(&library, "m-old", "101", 20);

        let selection = vec![crate::library::models::MangaCatalogRecoverySelection {
            manga_id: "m-old".to_string(),
            work_id: 102,
        }];
        let first = library
            .apply_manga_catalog_recovery_selection(&selection)
            .unwrap();
        assert_eq!(first.matched_count, 1);
        assert_eq!(first.created_bookmarks, 1);

        let second = library
            .apply_manga_catalog_recovery_selection(&selection)
            .unwrap();
        assert_eq!(second.matched_count, 0);
        assert_eq!(second.created_bookmarks, 0);
        assert_eq!(second.existing_bookmarks, 0);

        let connection = library.connection().unwrap();
        let (method, bookmark_created, work_id): (String, i64, String) = connection
            .query_row(
                "SELECT match_method, bookmark_created, work_id
                 FROM manga_catalog_recovery_links WHERE manga_id = 'm-old'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(method, "historical_lineage");
        assert_eq!(bookmark_created, 1);
        assert_eq!(work_id, "102");
        let source_relative_path: String = connection.query_row(
            "SELECT source_relative_path FROM manga_catalog_recovery_links WHERE manga_id = 'm-old'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(source_relative_path, "path-m-old");
    }

    #[test]
    fn historical_selection_rejects_unreviewed_or_inactive_targets() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        write_lineage_catalog(&library);
        insert_recovery_manga(&library, "m-lost", "103", 20);

        // 제안되지 않은 작품·존재하지 않는 manga·삭제된 작품은 모두 무시된다.
        let result = library
            .apply_manga_catalog_recovery_selection(&[
                crate::library::models::MangaCatalogRecoverySelection {
                    manga_id: "m-lost".to_string(),
                    work_id: 102,
                },
                crate::library::models::MangaCatalogRecoverySelection {
                    manga_id: "m-missing".to_string(),
                    work_id: 102,
                },
                crate::library::models::MangaCatalogRecoverySelection {
                    manga_id: "m-lost".to_string(),
                    work_id: 101,
                },
            ])
            .unwrap();
        assert_eq!(result.matched_count, 0);
        assert_eq!(result.created_bookmarks, 0);
        let bookmarks: i64 = library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM online_catalog_bookmarks", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(bookmarks, 0);
    }

    #[test]
    fn fallback_candidates_rank_artist_pages_and_title() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        write_lineage_catalog(&library);
        // 작가+페이지+제목 3신호: 제안. 작가는 info 형식이 아니라 폴더명에서 오므로 직접 넣는다.
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO manga_series
                    (id, relative_path, title, author, gallery_id, page_count,
                     thumbnail_relative_path, scanned_at, modified_at)
                 VALUES ('m-cand', 'path-cand', 'Starlight Academy', 'hana', NULL, 30,
                         'thumb.webp', 'now', 'now')",
                [],
            )
            .unwrap();
        // 제목만 유사(작가·페이지 불일치): 후보에서 제외된다.
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO manga_series
                    (id, relative_path, title, author, gallery_id, page_count,
                     thumbnail_relative_path, scanned_at, modified_at)
                 VALUES ('m-title-only', 'path-title', 'Starlight Academy', 'stranger', NULL, 99,
                         'thumb.webp', 'now', 'now')",
                [],
            )
            .unwrap();

        let preview = library.preview_manga_catalog_recovery().unwrap();
        assert_eq!(preview.fallback_count, 2);
        let by_id = preview
            .items
            .iter()
            .map(|item| (item.manga_id.as_str(), item))
            .collect::<std::collections::BTreeMap<_, _>>();

        let ranked = &by_id["m-cand"].candidates;
        assert!(!ranked.is_empty());
        assert_eq!(ranked[0].work_id, 201);
        assert_eq!(
            ranked[0].confidence,
            crate::library::models::MangaRecoveryConfidence::Suggested
        );
        assert!(ranked[0]
            .reasons
            .iter()
            .any(|reason| reason.contains("작가")));
        assert!(ranked.len() <= 3);
        // 페이지 신호 단일(작가·제목 불일치) 작품은 후보에서 제외된다.
        assert!(ranked.iter().all(|candidate| candidate.work_id != 203));

        assert!(by_id["m-title-only"].candidates.is_empty());
    }

    #[test]
    fn fallback_selection_apply_records_the_chosen_mapping() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        write_lineage_catalog(&library);
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO manga_series
                    (id, relative_path, title, author, gallery_id, page_count,
                     thumbnail_relative_path, scanned_at, modified_at)
                 VALUES ('m-cand', 'path-cand', 'Starlight Academy', 'hana', NULL, 30,
                         'thumb.webp', 'now', 'now')",
                [],
            )
            .unwrap();

        let result = library
            .apply_manga_catalog_recovery_selection(&[
                crate::library::models::MangaCatalogRecoverySelection {
                    manga_id: "m-cand".to_string(),
                    work_id: 201,
                },
            ])
            .unwrap();
        assert_eq!(result.matched_count, 1);
        assert_eq!(result.created_bookmarks, 1);

        // 재실행해도 북마크·링크가 중복되지 않는다.
        let again = library
            .apply_manga_catalog_recovery_selection(&[
                crate::library::models::MangaCatalogRecoverySelection {
                    manga_id: "m-cand".to_string(),
                    work_id: 201,
                },
            ])
            .unwrap();
        assert_eq!(again.matched_count, 0);
        assert_eq!(again.created_bookmarks, 0);

        let connection = library.connection().unwrap();
        let (method, work_id): (String, String) = connection
            .query_row(
                "SELECT match_method, work_id FROM manga_catalog_recovery_links
                 WHERE manga_id = 'm-cand'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(method, "candidate_review");
        assert_eq!(work_id, "201");
        let source_relative_path: String = connection.query_row(
            "SELECT source_relative_path FROM manga_catalog_recovery_links WHERE manga_id = 'm-cand'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(source_relative_path, "path-cand");
        let local_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manga_series WHERE id = 'm-cand'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(local_count, 0);
    }

    #[test]
    fn numeric_id_in_title_recovers_a_missing_gallery_id() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        write_lineage_catalog(&library);
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO manga_series
                    (id, relative_path, title, author, gallery_id, page_count,
                     thumbnail_relative_path, scanned_at, modified_at)
                 VALUES ('m-num', 'path-num', 'Series #202 memo', 'unknown', 'no-id', 31,
                         'thumb.webp', 'now', 'now')",
                [],
            )
            .unwrap();

        let preview = library.preview_manga_catalog_recovery().unwrap();
        let item = preview
            .items
            .iter()
            .find(|item| item.manga_id == "m-num")
            .unwrap();
        assert_eq!(
            item.status,
            crate::library::models::MangaCatalogRecoveryStatus::Fallback
        );
        assert!(item
            .candidates
            .iter()
            .any(|candidate| candidate.work_id == 202
                && candidate.confidence
                    == crate::library::models::MangaRecoveryConfidence::Suggested));
    }
}
