use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{
    backup::Backup, params_from_iter, types::Value, Connection, OpenFlags, OptionalExtension,
};
use serde::{Deserialize, Serialize};

use super::{
    catalog_provider::{CatalogProvider, CatalogWorkIdentity},
    catalog_query::{compile as compile_catalog_query, parse as parse_catalog_query},
    catalog_visibility::append_visibility_predicates,
    error::LibraryError,
    models::{
        CatalogScope, CatalogSearchPage, CatalogSearchQuery, CatalogSort, CatalogStatus,
        CatalogSuggestion, CatalogTagGroup, CatalogWork, CatalogWorkDetail,
    },
    Library,
};

fn active_work_predicate(sort: CatalogSort) -> &'static str {
    // Almost all imported works are active (97% in the measured catalog).
    // This no-op hint avoids rank-index row lookups and a full latest sort.
    // Views/hot sorts must retain the Expunged-leading rank-index lookup.
    match sort {
        CatalogSort::Latest => "likely(work.Expunged = 0)",
        _ => "work.Expunged = 0",
    }
}

#[cfg(test)]
#[path = "catalog_performance_tests.rs"]
mod performance_tests;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ImportedSuggestion {
    category: String,
    tag: String,
    display: String,
    count: u64,
}

#[derive(Clone, Debug)]
pub(super) struct CatalogLookupCache {
    suggestions: Vec<ImportedSuggestion>,
    translations: BTreeMap<String, String>,
}

impl Library {
    pub fn set_online_catalog_bookmark(
        &self,
        identity: &CatalogWorkIdentity,
        bookmarked: bool,
    ) -> Result<(), LibraryError> {
        identity.validate()?;
        let connection = self.connection()?;
        let provider_tag = identity.provider.as_str();
        let work_id = identity.provider_work_id.as_str();
        if bookmarked {
            connection.execute(
                "INSERT INTO online_catalog_bookmarks (provider, work_id, created_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(provider, work_id) DO NOTHING",
                rusqlite::params![provider_tag, work_id, chrono::Utc::now().to_rfc3339()],
            )?;
        } else {
            connection.execute(
                "DELETE FROM online_catalog_bookmarks
                 WHERE provider = ?1 AND work_id = ?2",
                [provider_tag, work_id],
            )?;
        }
        Ok(())
    }

    pub fn set_catalog_update_settings(
        &self,
        enabled: bool,
        interval_seconds: u64,
    ) -> Result<CatalogStatus, LibraryError> {
        if interval_seconds < 60 || interval_seconds > i64::MAX as u64 {
            return Err(LibraryError::InvalidCatalogUpdateInterval);
        }
        self.connection()?.execute(
            "UPDATE online_catalog_settings
             SET update_enabled = ?1, update_interval_seconds = ?2
             WHERE singleton = 1",
            (enabled, interval_seconds as i64),
        )?;
        self.catalog_status()
    }

    pub(crate) fn record_catalog_update_attempt(&self, at: &str) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "UPDATE online_catalog_settings
             SET last_attempt_at = ?1, last_error = NULL WHERE singleton = 1",
            [at],
        )?;
        Ok(())
    }

    pub(crate) fn record_catalog_update_success(
        &self,
        at: &str,
        added: u64,
    ) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "UPDATE online_catalog_settings
             SET last_success_at = ?1, last_added = ?2, last_error = NULL WHERE singleton = 1",
            rusqlite::params![at, added.min(i64::MAX as u64) as i64],
        )?;
        Ok(())
    }

    pub(crate) fn record_catalog_update_error(&self, error: &str) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "UPDATE online_catalog_settings SET last_error = ?1 WHERE singleton = 1",
            [error],
        )?;
        Ok(())
    }

    pub fn import_vck_catalog(&self, vck_root: &Path) -> Result<CatalogStatus, LibraryError> {
        let source_db_path = vck_root.join("data/kdata.db");
        let suggestions_path = vck_root.join("data/suggestion-cache.json");
        let tag_path = find_tag_translation(vck_root)?;
        let catalogs = self.root.join("catalogs");
        create_dir_all(&catalogs)?;

        let imported_db_path = catalogs.join("kdata.db.importing");
        let imported_suggestions_path = catalogs.join("suggestions.json.importing");
        let imported_tags_path = catalogs.join("tag-ko.json.importing");
        for stale in [
            &imported_db_path,
            &imported_suggestions_path,
            &imported_tags_path,
        ] {
            let _ = fs::remove_file(stale);
        }

        let source =
            Connection::open_with_flags(&source_db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut destination = Connection::open(&imported_db_path)?;
        Backup::new(&source, &mut destination)?.run_to_completion(
            256,
            Duration::from_millis(10),
            None,
        )?;
        drop(destination);
        drop(source);

        let imported = Connection::open_with_flags(
            &imported_db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let integrity: String =
            imported.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok"
            || ["Works", "Tags", "CrawlState"]
                .iter()
                .any(|table| !has_table(&imported, table))
        {
            return Err(LibraryError::InvalidOnlineCatalog);
        }
        let work_count = imported
            .query_row("SELECT COUNT(*) FROM Works", [], |row| row.get::<_, i64>(0))?
            as u64;
        if work_count == 0 {
            return Err(LibraryError::InvalidOnlineCatalog);
        }
        drop(imported);

        let suggestions = read(&suggestions_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(suggestions_from_database(&imported_db_path)?);
        let tag_source = read_to_string(&tag_path)?;
        let tags = parse_tag_translations(&tag_source)?;

        write(
            &imported_suggestions_path,
            &serde_json::to_vec(&suggestions).map_err(|_| LibraryError::InvalidOnlineCatalog)?,
        )?;
        write(
            &imported_tags_path,
            &serde_json::to_vec(&tags).map_err(|_| LibraryError::InvalidOnlineCatalog)?,
        )?;
        replace_catalog_files(&[
            (
                imported_suggestions_path.as_path(),
                catalogs.join("suggestions.json").as_path(),
            ),
            (
                imported_tags_path.as_path(),
                catalogs.join("tag-ko.json").as_path(),
            ),
            (
                imported_db_path.as_path(),
                catalogs.join("kdata.db").as_path(),
            ),
        ])?;
        *self
            .catalog_lookup_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;

        self.connection()?.execute(
            "UPDATE online_catalog_settings SET installed_at = ?1 WHERE singleton = 1",
            [chrono::Utc::now().to_rfc3339()],
        )?;
        self.catalog_status()
    }

    pub fn catalog_status(&self) -> Result<CatalogStatus, LibraryError> {
        let catalog_path = self.root.join("catalogs/kdata.db");
        let streams = super::catalog_checkpoint::statuses(&catalog_path)?;
        let work_count = if catalog_path.exists() {
            Connection::open_with_flags(&catalog_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?
                .query_row("SELECT COUNT(*) FROM Works", [], |row| row.get::<_, i64>(0))?
                as u64
        } else {
            0
        };
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT update_enabled, update_interval_seconds, last_attempt_at,
                    last_success_at, last_added, last_error
             FROM online_catalog_settings WHERE singleton = 1",
                [],
                |row| {
                    Ok(CatalogStatus {
                        installed: catalog_path.exists(),
                        work_count,
                        update_enabled: row.get(0)?,
                        update_interval_seconds: row.get::<_, i64>(1)? as u64,
                        last_attempt_at: row.get(2)?,
                        last_success_at: row.get(3)?,
                        last_added: row.get::<_, i64>(4)? as u64,
                        last_error: row.get(5)?,
                        streams: streams.clone(),
                    })
                },
            )
            .map_err(Into::into)
    }

    pub(crate) fn rebuild_catalog_suggestions(&self) -> Result<(), LibraryError> {
        let catalogs = self.root.join("catalogs");
        let suggestions = suggestions_from_database(&catalogs.join("kdata.db"))?;
        let importing = catalogs.join("suggestions.json.importing");
        write(
            &importing,
            &serde_json::to_vec(&suggestions).map_err(|_| LibraryError::InvalidOnlineCatalog)?,
        )?;
        replace_file(&importing, &catalogs.join("suggestions.json"))?;
        *self
            .catalog_lookup_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        Ok(())
    }

    pub fn search_online_catalog(
        &self,
        query: CatalogSearchQuery,
    ) -> Result<CatalogSearchPage, LibraryError> {
        if query.provider != CatalogProvider::KHentai {
            return Err(LibraryError::UnsupportedCatalogProvider);
        }
        let catalog_path = self.root.join("catalogs/kdata.db");
        if !catalog_path.exists() {
            return Err(LibraryError::OnlineCatalogNotInstalled);
        }
        let connection = self.connection()?;
        connection.execute(
            "ATTACH DATABASE ?1 AS catalog",
            [catalog_path.to_string_lossy().as_ref()],
        )?;
        let bookmark_exists = format!(
            "EXISTS (SELECT 1 FROM online_catalog_bookmarks AS bookmark
             WHERE bookmark.provider = '{}'
               AND bookmark.work_id = CAST(work.Id AS TEXT))",
            query.provider.as_str()
        );
        let mut clauses = vec![active_work_predicate(query.sort).to_owned()];
        if query.scope == CatalogScope::Bookmarked {
            clauses.push(bookmark_exists.clone());
        }
        let mut values = Vec::<Value>::new();
        if let Some(language) = query.language {
            clauses.push(
                "EXISTS (SELECT 1 FROM catalog.Tags AS policy_tag
                         WHERE policy_tag.WorkId = work.Id
                           AND policy_tag.Namespace = 'language'
                           AND policy_tag.Value = ?)"
                    .into(),
            );
            values.push(language.as_tag().to_owned().into());
        }
        if !query.reveal_blocked {
            append_visibility_predicates(&connection, &mut clauses)?;
        }
        if let Some(expression) = parse_catalog_query(&query.text)? {
            let compiled = compile_catalog_query(&expression);
            clauses.push(compiled.sql);
            values.extend(compiled.params);
        }

        let order = match query.sort {
            CatalogSort::Latest => "work.Posted DESC, work.Id DESC",
            CatalogSort::Views => "work.Views DESC, work.Posted DESC, work.Id DESC",
            CatalogSort::HotDay | CatalogSort::HotWeek | CatalogSort::HotMonth => {
                let now = chrono::Utc::now().timestamp();
                let latest_posted = connection.query_row(
                    "SELECT MAX(Posted) FROM catalog.Works WHERE Expunged = 0",
                    [],
                    |row| row.get::<_, Option<i64>>(0),
                )?;
                let reference = latest_posted.map_or(now, |posted| posted.min(now));
                let seconds = match query.sort {
                    CatalogSort::HotDay => 86_400,
                    CatalogSort::HotWeek => 604_800,
                    CatalogSort::HotMonth => 2_592_000,
                    _ => unreachable!(),
                };
                clauses.push("work.Posted >= ?".into());
                values.push((reference - seconds).into());
                "work.Views DESC, work.Posted DESC, work.Id DESC"
            }
        };
        let where_sql = clauses.join(" AND ");
        let total_count = connection.query_row(
            &format!("SELECT COUNT(*) FROM catalog.Works AS work WHERE {where_sql}"),
            params_from_iter(values.iter()),
            |row| row.get::<_, i64>(0),
        )? as u64;
        let page_size = query.page_size.clamp(1, 100);
        let offset = u64::from(query.page) * u64::from(page_size);
        let mut page_values = values;
        page_values.push(i64::from(page_size).into());
        page_values.push((offset.min(i64::MAX as u64) as i64).into());
        let sql = format!(
            "SELECT work.Id, work.Title, work.TitleJpn, work.FileCount, work.Views,
                    work.Posted, work.Thumb, {bookmark_exists}
             FROM catalog.Works AS work
             WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(page_values.iter()), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, bool>(7)?,
            ))
        })?;
        let rows = rows.collect::<Result<Vec<_>, _>>()?;
        let work_ids = rows.iter().map(|row| row.0).collect::<Vec<_>>();
        let (summary_tags, _) = bulk_summary_tags(&connection, &work_ids)?;
        let mut works = Vec::with_capacity(rows.len());
        for (id, title, title_jpn, file_count, views, posted, thumbnail_url, bookmarked) in rows {
            let work_id = id as u64;
            let tags = summary_tags.get(&id);
            works.push(CatalogWork {
                identity: CatalogWorkIdentity::khentai(work_id),
                title,
                title_jpn,
                artists: tags.map(|tags| tags.artists.clone()).unwrap_or_default(),
                series: tags.map(|tags| tags.series.clone()).unwrap_or_default(),
                thumbnail_url: validated_thumbnail_url(thumbnail_url)
                    .map(|_| format!("http://lakomics.localhost/remote-catalog-thumbnail/{}/{work_id}", query.provider.as_str())),
                bookmarked,
                file_count: file_count as u32,
                views: views as u64,
                posted: super::catalog_provider::normalize_legacy_timestamp(posted),
            });
        }
        Ok(CatalogSearchPage {
            works,
            total_count,
            page: query.page,
            page_size,
        })
    }

    pub fn suggest_online_catalog(
        &self,
        text: &str,
        limit: u32,
    ) -> Result<Vec<CatalogSuggestion>, LibraryError> {
        let needle = text.trim().to_lowercase();
        let lookup = self.catalog_lookup()?;
        Ok(lookup
            .suggestions
            .iter()
            .filter_map(|suggestion| {
                let translation = lookup.translations.get(&suggestion.display);
                let matches = needle.is_empty()
                    || suggestion.display.to_lowercase().contains(&needle)
                    || suggestion.tag.to_lowercase().contains(&needle)
                    || translation.is_some_and(|value| value.to_lowercase().contains(&needle));
                matches.then(|| CatalogSuggestion {
                    value: suggestion.display.clone(),
                    label: translation
                        .cloned()
                        .unwrap_or_else(|| suggestion.display.clone()),
                    count: suggestion.count,
                })
            })
            .take(limit.min(20) as usize)
            .collect())
    }

    pub fn online_catalog_work_detail(
        &self,
        identity: &CatalogWorkIdentity,
    ) -> Result<CatalogWorkDetail, LibraryError> {
        let work_id = identity.khentai_numeric_id()?;
        let catalog_path = self.root.join("catalogs/kdata.db");
        if !catalog_path.exists() {
            return Err(LibraryError::OnlineCatalogNotInstalled);
        }
        let connection = self.connection()?;
        connection.execute(
            "ATTACH DATABASE ?1 AS catalog",
            [catalog_path.to_string_lossy().as_ref()],
        )?;
        let detail_provider = super::catalog_provider::LEGACY_VCK_PROVIDER;
        let row = connection
            .query_row(
                &format!(
                    "SELECT work.Id, work.Title, work.TitleJpn, work.Thumb, work.Uploader,
                            work.Category, work.Posted, work.Updated, work.FileCount,
                            work.FileSize, work.Rating, work.Views,
                            EXISTS (
                                SELECT 1 FROM online_catalog_bookmarks AS bookmark
                                WHERE bookmark.provider = '{detail_provider}'
                                  AND bookmark.work_id = CAST(work.Id AS TEXT)
                            )
                     FROM catalog.Works AS work
                     WHERE work.Id = ?1 AND work.Expunged = 0"
                ),
                [work_id as i64],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, Option<i64>>(9)?,
                        row.get::<_, Option<i64>>(10)?,
                        row.get::<_, i64>(11)?,
                        row.get::<_, bool>(12)?,
                    ))
                },
            )
            .optional()?
            .ok_or(LibraryError::OnlineCatalogWorkNotFound)?;
        let mut grouped_tags = BTreeMap::<String, Vec<String>>::new();
        let mut statement = connection.prepare(
            "SELECT Namespace, Value FROM catalog.Tags
             WHERE WorkId = ?1 ORDER BY Namespace, Value",
        )?;
        for tag in statement.query_map([row.0], |tag| {
            Ok((tag.get::<_, String>(0)?, tag.get::<_, String>(1)?))
        })? {
            let (namespace, value) = tag?;
            grouped_tags.entry(namespace).or_default().push(value);
        }

        Ok(CatalogWorkDetail {
            identity: CatalogWorkIdentity::khentai(row.0 as u64),
            title: row.1,
            title_jpn: row.2,
            thumbnail_url: validated_thumbnail_url(row.3)
                .map(|_| format!("http://lakomics.localhost/remote-catalog-thumbnail/{}/{}", identity.provider.as_str(), row.0 as u64)),
            uploader: row.4,
            category: row.5,
            posted: super::catalog_provider::normalize_optional_legacy_timestamp(row.6),
            updated: super::catalog_provider::normalize_optional_legacy_timestamp(row.7),
            file_count: row.8.max(0) as u32,
            file_size: row.9.map(|value| value.max(0) as u64),
            rating: row.10,
            views: row.11.max(0) as u64,
            bookmarked: row.12,
            tag_groups: grouped_tags
                .into_iter()
                .map(|(namespace, values)| CatalogTagGroup { namespace, values })
                .collect(),
        })
    }

    /// 카탈로그 표지 원본 URL을 조회해 디스크 캐시 프록시로 내려준다.
    /// URL은 카탈로그 DB에 저장된 ehgt.org 값만 신뢰한다.
    pub(crate) fn online_catalog_thumbnail(
        &self,
        identity: &CatalogWorkIdentity,
    ) -> Result<super::remote_media::RemoteMedia, LibraryError> {
        let work_id = identity.khentai_numeric_id()?;
        let catalog_path = self.root.join("catalogs/kdata.db");
        if !catalog_path.exists() {
            return Err(LibraryError::OnlineCatalogNotInstalled);
        }
        let connection = self.connection()?;
        connection.execute(
            "ATTACH DATABASE ?1 AS catalog",
            [catalog_path.to_string_lossy().as_ref()],
        )?;
        let thumb: Option<String> = connection
            .query_row(
                "SELECT Thumb FROM catalog.Works WHERE Id = ?1 AND Expunged = 0",
                [work_id as i64],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(LibraryError::MediaNotFound)?;
        let url = validated_thumbnail_url(thumb).ok_or(LibraryError::MediaNotFound)?;
        super::remote_media::load_catalog_thumbnail(&self.root, identity, &url)
    }

    fn catalog_lookup(&self) -> Result<CatalogLookupCache, LibraryError> {
        let mut cache = self
            .catalog_lookup_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cache) = cache.as_ref() {
            return Ok(cache.clone());
        }
        let catalogs = self.root.join("catalogs");
        if !catalogs.join("kdata.db").exists() {
            return Err(LibraryError::OnlineCatalogNotInstalled);
        }
        let loaded = CatalogLookupCache {
            suggestions: read(&catalogs.join("suggestions.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or(suggestions_from_database(&catalogs.join("kdata.db"))?),
            translations: serde_json::from_slice(&read(&catalogs.join("tag-ko.json"))?)
                .map_err(|_| LibraryError::InvalidOnlineCatalog)?,
        };
        *cache = Some(loaded.clone());
        Ok(loaded)
    }
}

#[derive(Default)]
struct SummaryTags {
    artists: Vec<String>,
    series: Vec<String>,
}

fn bulk_summary_tags(
    connection: &Connection,
    work_ids: &[i64],
) -> Result<(BTreeMap<i64, SummaryTags>, usize), LibraryError> {
    if work_ids.is_empty() {
        return Ok((BTreeMap::new(), 0));
    }
    let placeholders = std::iter::repeat_n("?", work_ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT WorkId, Namespace, Value FROM catalog.Tags
         WHERE WorkId IN ({placeholders}) AND Namespace IN ('artist', 'series')
         ORDER BY WorkId, Namespace, Value"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(work_ids.iter()), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut by_work = BTreeMap::<i64, SummaryTags>::new();
    for row in rows {
        let (work_id, namespace, value) = row?;
        let tags = by_work.entry(work_id).or_default();
        if namespace == "artist" {
            tags.artists.push(value);
        } else {
            tags.series.push(value);
        }
    }
    Ok((by_work, 1))
}

fn validated_thumbnail_url(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let parsed = url::Url::parse(&raw).ok()?;
    let host = parsed.host_str()?;
    (parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && (host == "ehgt.org" || host.ends_with(".ehgt.org")))
    .then_some(raw)
}

fn suggestions_from_database(path: &Path) -> Result<Vec<ImportedSuggestion>, LibraryError> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut statement = connection.prepare(
        "SELECT Namespace, Value, COUNT(*) AS Uses
         FROM Tags GROUP BY Namespace, Value
         ORDER BY Uses DESC, Namespace, Value",
    )?;
    let rows = statement.query_map([], |row| {
        let category = row.get::<_, String>(0)?;
        let tag = row.get::<_, String>(1)?;
        let count = row.get::<_, i64>(2)?.max(0) as u64;
        Ok(ImportedSuggestion {
            display: format!("{category}:{tag}"),
            category,
            tag,
            count,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn has_table(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )
        .unwrap_or(false)
}

fn find_tag_translation(vck_root: &Path) -> Result<PathBuf, LibraryError> {
    let assets = vck_root.join("resources/app/violet-web/packages/frontend/dist/assets");
    let entries = fs::read_dir(&assets).map_err(|source| LibraryError::OnlineCatalogImport {
        path: assets.clone(),
        source,
    })?;
    let mut matches = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("tag-ko-") && name.ends_with(".js"))
        });
    let found = matches.next().ok_or(LibraryError::InvalidOnlineCatalog)?;
    if matches.next().is_some() {
        return Err(LibraryError::InvalidOnlineCatalog);
    }
    Ok(found)
}

fn parse_tag_translations(source: &str) -> Result<BTreeMap<String, String>, LibraryError> {
    let object = source
        .strip_prefix("const a=")
        .and_then(|value| value.split_once(";export").map(|(object, _)| object))
        .ok_or(LibraryError::InvalidOnlineCatalog)?;
    if let Ok(tags) = serde_json::from_str(object) {
        return Ok(tags);
    }
    let normalized = normalize_javascript_strings(object)?;
    serde_json::from_str(&normalized).map_err(|_| LibraryError::InvalidOnlineCatalog)
}

fn normalize_javascript_strings(object: &str) -> Result<String, LibraryError> {
    let mut chars = object.chars().peekable();
    let mut normalized = String::with_capacity(object.len());
    while let Some(character) = chars.next() {
        match character {
            '"' => {
                normalized.push(character);
                let mut closed = false;
                while let Some(character) = chars.next() {
                    normalized.push(character);
                    if character == '\\' {
                        normalized.push(chars.next().ok_or(LibraryError::InvalidOnlineCatalog)?);
                    } else if character == '"' {
                        closed = true;
                        break;
                    }
                }
                if !closed {
                    return Err(LibraryError::InvalidOnlineCatalog);
                }
            }
            '\'' => {
                let mut value = String::new();
                let mut closed = false;
                while let Some(character) = chars.next() {
                    match character {
                        '\'' => {
                            closed = true;
                            break;
                        }
                        '\\' => {
                            let escaped = chars.next().ok_or(LibraryError::InvalidOnlineCatalog)?;
                            match escaped {
                                'b' => value.push('\u{0008}'),
                                'f' => value.push('\u{000c}'),
                                'n' => value.push('\n'),
                                'r' => value.push('\r'),
                                't' => value.push('\t'),
                                'u' | 'x' => {
                                    let length = if escaped == 'u' { 4 } else { 2 };
                                    let digits = chars.by_ref().take(length).collect::<String>();
                                    if digits.len() != length {
                                        return Err(LibraryError::InvalidOnlineCatalog);
                                    }
                                    let code = u32::from_str_radix(&digits, 16)
                                        .map_err(|_| LibraryError::InvalidOnlineCatalog)?;
                                    value.push(
                                        char::from_u32(code)
                                            .ok_or(LibraryError::InvalidOnlineCatalog)?,
                                    );
                                }
                                other => value.push(other),
                            }
                        }
                        other => value.push(other),
                    }
                }
                if !closed {
                    return Err(LibraryError::InvalidOnlineCatalog);
                }
                normalized.push_str(
                    &serde_json::to_string(&value)
                        .map_err(|_| LibraryError::InvalidOnlineCatalog)?,
                );
            }
            other => normalized.push(other),
        }
    }
    Ok(normalized)
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), LibraryError> {
    replace_catalog_files(&[(source, destination)])
}

fn replace_catalog_files(files: &[(&Path, &Path)]) -> Result<(), LibraryError> {
    let previous = files
        .iter()
        .map(|(_, destination)| destination.with_extension("previous"))
        .collect::<Vec<_>>();
    for path in &previous {
        let _ = fs::remove_file(path);
    }
    for (index, (_, destination)) in files.iter().enumerate() {
        if destination.exists() {
            if let Err(error) = rename(destination, &previous[index]) {
                for restore in 0..index {
                    if previous[restore].exists() {
                        let _ = fs::rename(&previous[restore], files[restore].1);
                    }
                }
                return Err(error);
            }
        }
    }
    for (index, (source, destination)) in files.iter().enumerate() {
        if let Err(error) = rename(source, destination) {
            for installed in 0..index {
                let _ = fs::remove_file(files[installed].1);
            }
            for (restore, path) in previous.iter().enumerate() {
                if path.exists() {
                    let _ = fs::rename(path, files[restore].1);
                }
            }
            return Err(error);
        }
    }
    for path in previous {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn create_dir_all(path: &Path) -> Result<(), LibraryError> {
    fs::create_dir_all(path).map_err(|source| LibraryError::OnlineCatalogImport {
        path: path.into(),
        source,
    })
}

fn read(path: &Path) -> Result<Vec<u8>, LibraryError> {
    fs::read(path).map_err(|source| LibraryError::OnlineCatalogImport {
        path: path.into(),
        source,
    })
}

fn read_to_string(path: &Path) -> Result<String, LibraryError> {
    fs::read_to_string(path).map_err(|source| LibraryError::OnlineCatalogImport {
        path: path.into(),
        source,
    })
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), LibraryError> {
    fs::write(path, bytes).map_err(|source| LibraryError::OnlineCatalogImport {
        path: path.into(),
        source,
    })
}

fn rename(source_path: &Path, destination: &Path) -> Result<(), LibraryError> {
    fs::rename(source_path, destination).map_err(|source| LibraryError::OnlineCatalogImport {
        path: destination.into(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use rusqlite::Connection;

    use super::super::{
        catalog_provider::{CatalogProvider, CatalogWorkIdentity},
        error::LibraryError,
        models::{CatalogBlockedTag, CatalogScope, CatalogSearchQuery, CatalogSort},
        Library,
    };

    pub(super) const SCHEMA: &str = r#"
        CREATE TABLE Works (
            Id INTEGER PRIMARY KEY,
            Title TEXT NOT NULL DEFAULT '',
            TitleJpn TEXT,
            Category INTEGER,
            Uploader TEXT,
            Posted INTEGER,
            Updated INTEGER,
            FileCount INTEGER NOT NULL DEFAULT 0,
            FileSize INTEGER,
            Rating INTEGER,
            Views INTEGER NOT NULL DEFAULT 0,
            Thumb TEXT,
            Expunged INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE Tags (
            WorkId INTEGER NOT NULL,
            Namespace TEXT NOT NULL,
            Value TEXT NOT NULL,
            PRIMARY KEY (WorkId, Namespace, Value)
        ) WITHOUT ROWID;
        CREATE TABLE CrawlState (Key TEXT PRIMARY KEY, Value TEXT);
    "#;

    fn write_vck_fixture(root: &Path, work_count: u32, tag_json: &str) {
        let data = root.join("data");
        let assets = root.join("resources/app/violet-web/packages/frontend/dist/assets");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&assets).unwrap();
        let connection = Connection::open(data.join("kdata.db")).unwrap();
        connection.execute_batch(SCHEMA).unwrap();
        for id in 1..=work_count {
            connection
                .execute(
                    "INSERT INTO Works (Id, Title, Posted, FileCount, Views) VALUES (?1, ?2, 1, 10, 20)",
                    (id, format!("Work {id}")),
                )
                .unwrap();
        }
        drop(connection);
        fs::write(
            data.join("suggestion-cache.json"),
            r#"[{"category":"character","tag":"teitoku","display":"character:teitoku","count":2}]"#,
        )
        .unwrap();
        fs::write(
            assets.join("tag-ko-test.js"),
            format!("const a={tag_json};export{{a as default}};"),
        )
        .unwrap();
    }

    #[test]
    fn import_copies_and_validates_a_vck_catalog() {
        let library_root = tempfile::tempdir().unwrap();
        let vck_root = tempfile::tempdir().unwrap();
        write_vck_fixture(vck_root.path(), 2, r#"{"character:teitoku":"제독"}"#);
        let source_db = vck_root.path().join("data/kdata.db");
        let original_source_bytes = fs::read(&source_db).unwrap();
        let library = Library::open(library_root.path()).unwrap();

        let status = library.import_vck_catalog(vck_root.path()).unwrap();

        assert!(status.installed);
        assert_eq!(status.work_count, 2);
        assert!(library.root().join("catalogs/kdata.db").exists());
        assert_eq!(fs::read(source_db).unwrap(), original_source_bytes);
    }

    #[test]
    fn import_rebuilds_suggestions_when_the_vck_cache_is_missing() {
        let library_root = tempfile::tempdir().unwrap();
        let vck_root = tempfile::tempdir().unwrap();
        write_vck_fixture(vck_root.path(), 1, r#"{"character:teitoku":"제독"}"#);
        let data = vck_root.path().join("data");
        Connection::open(data.join("kdata.db"))
            .unwrap()
            .execute(
                "INSERT INTO Tags (WorkId, Namespace, Value) VALUES (1, 'character', 'teitoku')",
                [],
            )
            .unwrap();
        fs::remove_file(data.join("suggestion-cache.json")).unwrap();
        let library = Library::open(library_root.path()).unwrap();

        library.import_vck_catalog(vck_root.path()).unwrap();

        let suggestions = library.suggest_online_catalog("제독", 10).unwrap();
        assert_eq!(suggestions[0].value, "character:teitoku");
    }

    #[test]
    fn catalog_file_replacement_rolls_every_destination_back_on_failure() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        let first_import = root.path().join("first.importing");
        let missing_import = root.path().join("missing.importing");
        fs::write(&first, b"old-first").unwrap();
        fs::write(&second, b"old-second").unwrap();
        fs::write(&first_import, b"new-first").unwrap();

        assert!(super::replace_catalog_files(&[
            (first_import.as_path(), first.as_path()),
            (missing_import.as_path(), second.as_path()),
        ])
        .is_err());

        assert_eq!(fs::read(first).unwrap(), b"old-first");
        assert_eq!(fs::read(second).unwrap(), b"old-second");
    }

    #[test]
    fn import_rejections_preserve_the_installed_catalog() {
        for invalid in [
            "broken_db",
            "missing_tags",
            "zero_works",
            "invalid_tag_json",
        ] {
            let library_root = tempfile::tempdir().unwrap();
            let vck_root = tempfile::tempdir().unwrap();
            write_vck_fixture(vck_root.path(), 1, r#"{"character:teitoku":"제독"}"#);
            let library = Library::open(library_root.path()).unwrap();
            let catalogs = library.root().join("catalogs");
            fs::create_dir_all(&catalogs).unwrap();
            fs::write(catalogs.join("kdata.db"), b"installed catalog").unwrap();

            match invalid {
                "broken_db" => fs::write(vck_root.path().join("data/kdata.db"), b"broken").unwrap(),
                "missing_tags" => {
                    let db = Connection::open(vck_root.path().join("data/kdata.db")).unwrap();
                    db.execute("DROP TABLE Tags", []).unwrap();
                }
                "zero_works" => {
                    let db = Connection::open(vck_root.path().join("data/kdata.db")).unwrap();
                    db.execute("DELETE FROM Works", []).unwrap();
                }
                "invalid_tag_json" => fs::write(
                    vck_root.path().join(
                        "resources/app/violet-web/packages/frontend/dist/assets/tag-ko-test.js",
                    ),
                    "const a=invalid;export{a as default};",
                )
                .unwrap(),
                _ => unreachable!(),
            }

            assert!(
                library.import_vck_catalog(vck_root.path()).is_err(),
                "{invalid}"
            );
            assert_eq!(
                fs::read(catalogs.join("kdata.db")).unwrap(),
                b"installed catalog"
            );
        }
    }

    fn searchable_library() -> (tempfile::TempDir, Library) {
        let library_root = tempfile::tempdir().unwrap();
        let vck_root = tempfile::tempdir().unwrap();
        write_vck_fixture(vck_root.path(), 3, r#"{"character:teitoku":"제독"}"#);
        let now = chrono::Utc::now().timestamp();
        let db = Connection::open(vck_root.path().join("data/kdata.db")).unwrap();
        for (id, title, posted, views) in [
            (1, "제독의 하루", now - 7_200, 5),
            (2, "함대 일지", now - 172_800, 100),
            (3, "오래된 제독", now - 864_000, 200),
        ] {
            db.execute(
                "UPDATE Works SET Title = ?2, TitleJpn = ?2, Posted = ?3, Views = ?4 WHERE Id = ?1",
                (id, title, posted, views),
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO Tags (WorkId, Namespace, Value) VALUES (3, 'character', 'teitoku')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO Tags (WorkId, Namespace, Value) VALUES (3, 'language', 'korean')",
            [],
        )
        .unwrap();
        db.execute_batch(
            "INSERT INTO Tags (WorkId, Namespace, Value) VALUES (1, 'artist', 'alpha artist');
             INSERT INTO Tags (WorkId, Namespace, Value) VALUES (2, 'series', 'fleet log');
             INSERT INTO Tags (WorkId, Namespace, Value) VALUES (3, 'artist', 'circle artist');
             INSERT INTO Tags (WorkId, Namespace, Value) VALUES (3, 'series', 'fleet saga');",
        )
        .unwrap();
        db.execute(
            "UPDATE Works
             SET Category = 2, Uploader = 'tester', Updated = ?2,
                 FileSize = 12345, Rating = 457,
                 Thumb = 'https://ehgt.org/w/00/003/work.webp'
             WHERE Id = ?1",
            (3, now - 800_000),
        )
        .unwrap();
        drop(db);
        let library = Library::open(library_root.path()).unwrap();
        library.import_vck_catalog(vck_root.path()).unwrap();
        (library_root, library)
    }

    pub(super) fn query(
        text: &str,
        sort: CatalogSort,
        page: u32,
        page_size: u32,
    ) -> CatalogSearchQuery {
        CatalogSearchQuery {
            provider: CatalogProvider::KHentai,
            language: None,
            reveal_blocked: false,
            text: text.into(),
            sort,
            scope: CatalogScope::All,
            page,
            page_size,
        }
    }

    pub(super) fn khentai(work_id: u64) -> CatalogWorkIdentity {
        CatalogWorkIdentity::khentai(work_id)
    }

    #[test]
    fn legacy_search_query_defaults_to_the_khentai_provider() {
        let query: CatalogSearchQuery = serde_json::from_value(serde_json::json!({
            "text": "제독",
            "sort": "latest",
            "scope": "all",
            "page": 0,
            "pageSize": 10
        }))
        .unwrap();

        assert_eq!(query.provider, CatalogProvider::KHentai);
        assert_eq!(query.language, None);
        assert!(!query.reveal_blocked);
    }

    #[test]
    fn visibility_policy_combines_hidden_categories_and_exact_blocked_tags() {
        let (_root, library) = searchable_library();
        let catalog = Connection::open(library.root().join("catalogs/kdata.db")).unwrap();
        catalog
            .execute_batch(
                "UPDATE Works SET Category = 1 WHERE Id IN (1, 2);
                 UPDATE Works SET Category = 2 WHERE Id = 3;",
            )
            .unwrap();
        drop(catalog);
        library.set_catalog_category_hidden(2, true).unwrap();
        library
            .set_catalog_tag_blocked(
                CatalogBlockedTag {
                    namespace: "group".into(),
                    value: "alpha artist".into(),
                },
                true,
            )
            .unwrap();
        library
            .set_catalog_tag_blocked(
                CatalogBlockedTag {
                    namespace: "series".into(),
                    value: "fleet log".into(),
                },
                true,
            )
            .unwrap();

        let filtered = library
            .search_online_catalog(query("", CatalogSort::Latest, 0, 10))
            .unwrap();
        assert_eq!(filtered.total_count, 1);
        assert_eq!(filtered.works[0].identity, khentai(1));

        let mut revealed = query("", CatalogSort::Latest, 0, 10);
        revealed.reveal_blocked = true;
        let revealed = library.search_online_catalog(revealed).unwrap();
        assert_eq!(revealed.total_count, 3);
        assert_eq!(revealed.works.len(), 3);
    }

    #[test]
    fn empty_visibility_policy_preserves_existing_search_results() {
        let (_root, library) = searchable_library();

        let page = library
            .search_online_catalog(query("", CatalogSort::Latest, 0, 10))
            .unwrap();

        assert_eq!(page.total_count, 3);
        assert_eq!(page.works.len(), 3);
    }

    #[test]
    fn boolean_or_and_not_cannot_escape_visibility_policy() {
        let (_root, library) = searchable_library();
        library.set_catalog_category_hidden(2, true).unwrap();
        library
            .set_catalog_tag_blocked(
                CatalogBlockedTag {
                    namespace: "character".into(),
                    value: "teitoku".into(),
                },
                true,
            )
            .unwrap();

        let page = library
            .search_online_catalog(query("id:3 OR NOT id:1", CatalogSort::Latest, 0, 10))
            .unwrap();

        assert_eq!(page.total_count, 1);
        assert_eq!(page.works[0].identity, khentai(2));
    }

    #[test]
    fn visibility_policy_count_and_pages_use_the_same_sql_predicate() {
        let library_root = tempfile::tempdir().unwrap();
        let vck_root = tempfile::tempdir().unwrap();
        write_vck_fixture(vck_root.path(), 6, r#"{}"#);
        let source = Connection::open(vck_root.path().join("data/kdata.db")).unwrap();
        source
            .execute(
                "UPDATE Works SET Category = CASE WHEN Id % 2 = 0 THEN 2 ELSE 1 END",
                [],
            )
            .unwrap();
        drop(source);
        let library = Library::open(library_root.path()).unwrap();
        library.import_vck_catalog(vck_root.path()).unwrap();
        library.set_catalog_category_hidden(2, true).unwrap();

        let first = library
            .search_online_catalog(query("", CatalogSort::Latest, 0, 2))
            .unwrap();
        let second = library
            .search_online_catalog(query("", CatalogSort::Latest, 1, 2))
            .unwrap();

        assert_eq!((first.total_count, first.works.len()), (3, 2));
        assert_eq!((second.total_count, second.works.len()), (3, 1));
        assert!(first.works.iter().chain(&second.works).all(|work| work
            .identity
            .provider_work_id
            .parse::<u64>()
            .unwrap()
            % 2
            == 1));
    }

    #[test]
    fn reveal_blocked_bypasses_only_visibility_predicates() {
        let (_root, library) = searchable_library();
        let catalog = Connection::open(library.root().join("catalogs/kdata.db")).unwrap();
        catalog
            .execute_batch(
                "UPDATE Works SET Category = Id;
                 UPDATE Works SET Expunged = 1 WHERE Id = 1;",
            )
            .unwrap();
        drop(catalog);
        for category in 1..=3 {
            library.set_catalog_category_hidden(category, true).unwrap();
        }
        library
            .set_online_catalog_bookmark(&khentai(2), true)
            .unwrap();
        library
            .set_online_catalog_bookmark(&khentai(3), true)
            .unwrap();

        let mut revealed = query("id:1 OR id:3", CatalogSort::Latest, 0, 10);
        revealed.reveal_blocked = true;
        assert_eq!(
            library.search_online_catalog(revealed).unwrap().works[0].identity,
            khentai(3)
        );

        let mut language = query("", CatalogSort::Latest, 0, 10);
        language.reveal_blocked = true;
        language.language = Some(super::super::models::CatalogLanguage::Korean);
        assert_eq!(
            library.search_online_catalog(language).unwrap().total_count,
            1
        );

        let mut bookmarked = query("", CatalogSort::Latest, 0, 10);
        bookmarked.reveal_blocked = true;
        bookmarked.scope = CatalogScope::Bookmarked;
        assert_eq!(
            library
                .search_online_catalog(bookmarked)
                .unwrap()
                .total_count,
            2
        );

        let mut unsupported = query("", CatalogSort::Latest, 0, 10);
        unsupported.reveal_blocked = true;
        unsupported.provider = CatalogProvider::Heliotrope;
        assert!(matches!(
            library.search_online_catalog(unsupported),
            Err(LibraryError::UnsupportedCatalogProvider)
        ));
    }

    #[test]
    fn advanced_query_executes_boolean_typed_and_negative_predicates() {
        let (_root, library) = searchable_library();

        let boolean = library
            .search_online_catalog(query("제독 OR id:2", CatalogSort::Latest, 0, 10))
            .unwrap();
        assert_eq!(
            boolean
                .works
                .iter()
                .map(|work| work.identity.provider_work_id.as_str())
                .collect::<Vec<_>>(),
            ["1", "2", "3"]
        );

        let negative = library
            .search_online_catalog(query("-character:teitoku", CatalogSort::Latest, 0, 10))
            .unwrap();
        assert_eq!(negative.total_count, 2);
        let missing_metadata = library
            .search_online_catalog(query("-uploader:tester", CatalogSort::Latest, 0, 10))
            .unwrap();
        assert_eq!(missing_metadata.total_count, 2);

        let typed = library
            .search_online_catalog(query(
                "category:manga uploader:tester pages>=10",
                CatalogSort::Latest,
                0,
                10,
            ))
            .unwrap();
        assert_eq!(typed.works[0].identity, khentai(3));
    }

    #[test]
    fn language_and_expunged_policies_remain_outside_the_user_expression() {
        let (_root, library) = searchable_library();
        let catalog_path = library.root().join("catalogs/kdata.db");
        let catalog = Connection::open(catalog_path).unwrap();
        catalog
            .execute("UPDATE Works SET Expunged = 1 WHERE Id = 2", [])
            .unwrap();
        drop(catalog);
        let mut scoped = query("id:2 OR id:3", CatalogSort::Latest, 0, 10);
        scoped.language = Some(super::super::models::CatalogLanguage::Korean);

        let page = library.search_online_catalog(scoped).unwrap();

        assert_eq!(page.total_count, 1);
        assert_eq!(page.works[0].identity, khentai(3));
    }

    #[test]
    fn bulk_summary_hydration_is_zero_or_one_query_for_a_bounded_page() {
        let library_root = tempfile::tempdir().unwrap();
        let vck_root = tempfile::tempdir().unwrap();
        write_vck_fixture(vck_root.path(), 100, r#"{}"#);
        let source = Connection::open(vck_root.path().join("data/kdata.db")).unwrap();
        for id in 1..=100 {
            source
                .execute(
                    "INSERT INTO Tags (WorkId, Namespace, Value) VALUES (?1, 'artist', ?2)",
                    (id, format!("artist-{id}")),
                )
                .unwrap();
            source
                .execute(
                    "INSERT INTO Tags (WorkId, Namespace, Value) VALUES (?1, 'series', ?2)",
                    (id, format!("series-{id}")),
                )
                .unwrap();
        }
        drop(source);
        let library = Library::open(library_root.path()).unwrap();
        library.import_vck_catalog(vck_root.path()).unwrap();
        let started = std::time::Instant::now();
        let page = library
            .search_online_catalog(query("", CatalogSort::Latest, 0, 100))
            .unwrap();
        let elapsed = started.elapsed();
        assert_eq!(page.works.len(), 100);
        for work in &page.works {
            let id = &work.identity.provider_work_id;
            assert_eq!(work.artists, [format!("artist-{id}")]);
            assert_eq!(work.series, [format!("series-{id}")]);
        }

        let connection = library.connection().unwrap();
        connection
            .execute(
                "ATTACH DATABASE ?1 AS catalog",
                [library.root().join("catalogs/kdata.db").to_string_lossy().as_ref()],
            )
            .unwrap();
        let ids = (1_i64..=100).collect::<Vec<_>>();
        assert_eq!(super::bulk_summary_tags(&connection, &[]).unwrap().1, 0);
        let (hydrated, query_count) = super::bulk_summary_tags(&connection, &ids).unwrap();
        assert_eq!(query_count, 1);
        assert_eq!(hydrated.len(), 100);
        eprintln!(
            "CATALOG-004 fixture query: 100 results with bulk hydration in {:.2?}",
            elapsed
        );
    }

    #[test]
    fn search_and_detail_expose_provider_qualified_identities() {
        let (_root, library) = searchable_library();
        let page = library
            .search_online_catalog(query("제독", CatalogSort::Latest, 0, 10))
            .unwrap();

        assert_eq!(page.works[0].identity.provider, CatalogProvider::KHentai);
        assert_eq!(page.works[0].identity.provider_work_id, "1");
        let detail = library
            .online_catalog_work_detail(&page.works[0].identity)
            .unwrap();
        assert_eq!(detail.identity, page.works[0].identity);
    }

    #[test]
    fn unsupported_provider_is_rejected_before_catalog_lookup() {
        let (_root, library) = searchable_library();
        let mut query = query("", CatalogSort::Latest, 0, 10);
        query.provider = CatalogProvider::Heliotrope;

        assert!(matches!(
            library.search_online_catalog(query),
            Err(LibraryError::UnsupportedCatalogProvider)
        ));
    }

    #[test]
    fn bookmarks_isolate_the_same_work_id_by_provider() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        let khentai = CatalogWorkIdentity::new(CatalogProvider::KHentai, "42").unwrap();
        let heliotrope = CatalogWorkIdentity::new(CatalogProvider::Heliotrope, "42").unwrap();

        library.set_online_catalog_bookmark(&khentai, true).unwrap();
        library.set_online_catalog_bookmark(&heliotrope, true).unwrap();
        library.set_online_catalog_bookmark(&khentai, false).unwrap();

        let connection = library.connection().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM online_catalog_bookmarks WHERE work_id = '42'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT provider FROM online_catalog_bookmarks WHERE work_id = '42'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "heliotrope"
        );
    }

    #[test]
    fn search_filters_bookmarks_before_counting_and_paging() {
        let (_root, library) = searchable_library();
        library.set_online_catalog_bookmark(&khentai(3), true).unwrap();

        let page = library
            .search_online_catalog(CatalogSearchQuery {
                provider: CatalogProvider::KHentai,
                language: None,
                reveal_blocked: false,
                text: String::new(),
                sort: CatalogSort::Latest,
                scope: CatalogScope::Bookmarked,
                page: 0,
                page_size: 1,
            })
            .unwrap();

        assert_eq!(page.total_count, 1);
        assert_eq!(page.works[0].identity, khentai(3));
        assert!(page.works[0].bookmarked);
        assert_eq!(
            page.works[0].thumbnail_url.as_deref(),
            Some("http://lakomics.localhost/remote-catalog-thumbnail/kHentai/3")
        );
    }

    #[test]
    fn thumbnail_validation_rejects_untrusted_urls() {
        assert_eq!(
            super::validated_thumbnail_url(Some("http://ehgt.org/work.webp".into())),
            None
        );
        assert_eq!(
            super::validated_thumbnail_url(Some("https://user@ehgt.org/work.webp".into())),
            None
        );
        assert_eq!(
            super::validated_thumbnail_url(Some("https://evil.example/work.webp".into())),
            None
        );
        assert_eq!(
            super::validated_thumbnail_url(Some("https://a.ehgt.org/work.webp".into())),
            Some("https://a.ehgt.org/work.webp".into())
        );
    }

    #[test]
    fn detail_returns_optional_metadata_and_grouped_tags() {
        let (_root, library) = searchable_library();
        library.set_online_catalog_bookmark(&khentai(3), true).unwrap();

        let detail = library.online_catalog_work_detail(&khentai(3)).unwrap();

        assert_eq!(detail.identity, khentai(3));
        assert_eq!(detail.uploader.as_deref(), Some("tester"));
        assert_eq!(detail.file_size, Some(12345));
        assert_eq!(detail.rating, Some(457));
        assert!(detail.bookmarked);
        assert_eq!(
            detail.thumbnail_url.as_deref(),
            Some("http://lakomics.localhost/remote-catalog-thumbnail/kHentai/3")
        );
        assert!(detail
            .tag_groups
            .iter()
            .any(|group| { group.namespace == "character" && group.values == ["teitoku"] }));
        assert!(detail
            .tag_groups
            .iter()
            .any(|group| { group.namespace == "language" && group.values == ["korean"] }));
    }

    #[test]
    fn detail_normalizes_legacy_millisecond_timestamps_without_reimport() {
        let (_root, library) = searchable_library();
        let catalog = Connection::open(library.root().join("catalogs/kdata.db")).unwrap();
        let posted = 1_700_000_000_i64;
        let updated = 1_700_100_000_i64;
        catalog
            .execute(
                "UPDATE Works SET Posted = ?1, Updated = ?2 WHERE Id = 3",
                (posted * 1_000, updated * 1_000),
            )
            .unwrap();
        drop(catalog);

        let detail = library.online_catalog_work_detail(&khentai(3)).unwrap();
        assert_eq!(detail.posted, Some(posted));
        assert_eq!(detail.updated, Some(updated));
    }

    #[test]
    fn search_supports_titles_tags_pagination_and_all_sorts() {
        let (_root, library) = searchable_library();

        let title = library
            .search_online_catalog(query("제독", CatalogSort::Latest, 0, 10))
            .unwrap();
        assert_eq!(
            title.works.iter().map(|work| work.identity.provider_work_id.as_str()).collect::<Vec<_>>(),
            ["1", "3"]
        );
        let tag = library
            .search_online_catalog(query("character:teitoku", CatalogSort::Latest, 0, 10))
            .unwrap();
        assert_eq!(tag.works[0].identity, khentai(3));

        let page = library
            .search_online_catalog(query("", CatalogSort::Latest, 1, 1))
            .unwrap();
        assert_eq!((page.total_count, page.works[0].identity.clone()), (3, khentai(2)));
        assert!(page.works[0].artists.is_empty());
        assert_eq!(page.works[0].series, ["fleet log"]);
        for (sort, expected) in [
            (CatalogSort::Latest, 1),
            (CatalogSort::Views, 3),
            (CatalogSort::HotDay, 1),
            (CatalogSort::HotWeek, 2),
            (CatalogSort::HotMonth, 3),
        ] {
            assert_eq!(
                library
                    .search_online_catalog(query("", sort, 0, 10))
                    .unwrap()
                    .works[0]
                    .identity,
                khentai(expected),
            );
        }
    }

    #[test]
    fn hot_day_uses_the_catalogs_latest_timestamp_when_updates_are_stale() {
        let (_root, library) = searchable_library();
        let catalog = Connection::open(library.root().join("catalogs/kdata.db")).unwrap();
        let now = chrono::Utc::now().timestamp();
        catalog
            .execute("UPDATE Works SET Posted = ?1 WHERE Id = 1", [now - 352_800])
            .unwrap();
        catalog
            .execute("UPDATE Works SET Posted = ?1 WHERE Id = 2", [now - 432_000])
            .unwrap();
        catalog
            .execute("UPDATE Works SET Posted = ?1 WHERE Id = 3", [now - 864_000])
            .unwrap();
        drop(catalog);

        let page = library
            .search_online_catalog(query("", CatalogSort::HotDay, 0, 10))
            .unwrap();

        assert_eq!(page.total_count, 2);
        assert_eq!(
            page.works.iter().map(|work| work.identity.provider_work_id.as_str()).collect::<Vec<_>>(),
            ["2", "1"]
        );
    }

    #[test]
    fn bookmarks_are_idempotent_and_survive_catalog_reimport() {
        let library_root = tempfile::tempdir().unwrap();
        let vck_root = tempfile::tempdir().unwrap();
        write_vck_fixture(vck_root.path(), 3, r#"{"character:teitoku":"제독"}"#);
        let library = Library::open(library_root.path()).unwrap();
        library.import_vck_catalog(vck_root.path()).unwrap();

        library.set_online_catalog_bookmark(&khentai(3), true).unwrap();
        library.set_online_catalog_bookmark(&khentai(3), true).unwrap();
        library.import_vck_catalog(vck_root.path()).unwrap();
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM online_catalog_bookmarks
                     WHERE provider = 'kHentai' AND work_id = '3'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
        );

        library.set_online_catalog_bookmark(&khentai(3), false).unwrap();
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM online_catalog_bookmarks
                     WHERE provider = 'kHentai' AND work_id = '3'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
        );
    }

    #[test]
    fn search_suggestions_match_korean_translations() {
        let (_root, library) = searchable_library();

        let suggestions = library.suggest_online_catalog("제독", 10).unwrap();

        assert_eq!(suggestions[0].value, "character:teitoku");
        assert_eq!(suggestions[0].label, "제독");
    }

    #[test]
    fn suggestions_fall_back_to_the_database_when_the_cache_disappears() {
        let (_root, library) = searchable_library();
        fs::remove_file(library.root().join("catalogs/suggestions.json")).unwrap();
        *library
            .catalog_lookup_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;

        let suggestions = library.suggest_online_catalog("제독", 10).unwrap();

        assert_eq!(suggestions[0].value, "character:teitoku");
    }

    #[test]
    fn parses_single_quoted_values_in_vck_tag_javascript() {
        let tags = super::parse_tag_translations(
            r#"const a={"character:john mactavish":'존 "소프" 맥태비시'};export{a as default};"#,
        )
        .unwrap();

        assert_eq!(tags["character:john mactavish"], "존 \"소프\" 맥태비시");
    }
}
