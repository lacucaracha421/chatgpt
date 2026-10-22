use super::auto_tags::CONTENT_RATING_SQL;
use rusqlite::params;

#[cfg(test)]
#[path = "query_navigation_tests.rs"]
mod navigation_tests;
use serde::{Deserialize, Serialize};

use super::{
    error::LibraryError,
    models::{
        AspectRatioFilter, AssetCreatorSummary, AssetCursor, AssetDateBucket,
        AssetDateBucketQuery, AssetPage, AssetQuery, AssetSort, AssetSummary, ImportSource,
        MediaKindFilter, MediaSummary, UtcDateRange, VideoPreparationState,
    },
    Library,
};

#[derive(Serialize, Deserialize)]
#[serde(tag = "sort", rename_all = "snake_case")]
enum CursorPayload {
    Newest {
        collected_at: String,
        id: String,
    },
    Oldest {
        collected_at: String,
        id: String,
    },
    Favorites {
        favorite: bool,
        collected_at: String,
        id: String,
    },
    Random {
        pivot: String,
        bucket: i64,
        content_hash: String,
        id: String,
    },
}

#[derive(Serialize, Deserialize)]
struct BoundCursor {
    #[serde(flatten)]
    payload: CursorPayload,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_ms_min: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_ms_max: Option<u64>,
}

struct AssetRow {
    summary: AssetSummary,
    content_hash: Option<String>,
    random_bucket: Option<i64>,
}

fn media_filter_value(filter: Option<MediaKindFilter>) -> Option<&'static str> {
    filter.map(|value| match value {
        MediaKindFilter::Images => "images",
        MediaKindFilter::Videos => "videos",
    })
}

fn aspect_filter_value(filter: Option<AspectRatioFilter>) -> Option<&'static str> {
    filter.map(|value| match value {
        AspectRatioFilter::Square => "square",
        AspectRatioFilter::Landscape => "landscape",
        AspectRatioFilter::Portrait => "portrait",
    })
}

/// One ascending half-page shared by oldest-first paging, anchor heads/tails,
/// and upward (before-cursor) pagination in a newest-first listing.
/// `?1..?5` scope, `?6`/`?7` exclusive cursor tuple, `?8` inclusive date bound,
/// `?9` collection scope, `?10` limit + 1.
static CHRONO_ASC_HALF_SQL: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) , album_descendants(id) AS (
    SELECT ?5 WHERE ?5 IS NOT NULL
    UNION ALL SELECT child.id FROM albums AS child JOIN album_descendants ON child.parent_id = album_descendants.id
) SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id), asset.source_url,
asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count,
asset.source_published_at, asset.creator_name, asset.creator_handle, asset.creator_url,
asset.import_source, asset.import_batch_id, asset.original_modified_at, {CONTENT_RATING_SQL} AS content_rating FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id
WHERE asset.status = 'normal' AND asset.import_source IS NOT 'favorite_cover' AND (?3 = 0 OR EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id) = 1)
AND (?13 IS NULL OR EXISTS (SELECT 1 FROM asset_artist_scope AS artist_scope WHERE artist_scope.asset_id = asset.id AND artist_scope.scope_ref IN (?13, (SELECT 'artist:' || artist_member.artist_id FROM artist_members AS artist_member WHERE artist_member.creator_key = ?13))))
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?5 IS NULL OR EXISTS (SELECT 1 FROM asset_albums AS album_link WHERE album_link.asset_id = asset.id AND album_link.album_id IN (SELECT id FROM album_descendants)))
AND (?9 IS NULL OR EXISTS (SELECT 1 FROM collection_assets AS collection_link WHERE collection_link.asset_id = asset.id AND collection_link.collection_id = ?9))
AND (?6 IS NULL OR asset.collected_at > ?6 OR (asset.collected_at = ?6 AND asset.id > ?7))
AND (?8 IS NULL OR asset.collected_at >= ?8)
AND (?14 IS NULL OR asset.collected_at >= ?14)
AND (?15 IS NULL OR asset.collected_at < ?15)
AND (
  (?11 IS NULL)
  OR (?11 = 'images' AND asset.media_kind IN ('image', 'gif'))
  OR (?11 = 'videos' AND asset.media_kind = 'video')
)
AND (
  (?12 IS NULL)
  OR (?12 = 'square' AND asset.width * 5 >= asset.height * 4 AND asset.width * 4 <= asset.height * 5)
  OR (?12 = 'landscape' AND asset.width * 4 > asset.height * 5)
  OR (?12 = 'portrait' AND asset.width * 5 < asset.height * 4)
)
ORDER BY asset.collected_at ASC, asset.id ASC LIMIT ?10".replace("{CONTENT_RATING_SQL}", CONTENT_RATING_SQL));

/// The descending mirror of CHRONO_ASC_HALF_SQL: newest-first pages,
/// anchor tails/heads, and upward pagination in an oldest-first listing.
static CHRONO_DESC_HALF_SQL: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) , album_descendants(id) AS (
    SELECT ?5 WHERE ?5 IS NOT NULL
    UNION ALL SELECT child.id FROM albums AS child JOIN album_descendants ON child.parent_id = album_descendants.id
) SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id), asset.source_url,
asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count,
asset.source_published_at, asset.creator_name, asset.creator_handle, asset.creator_url,
asset.import_source, asset.import_batch_id, asset.original_modified_at, {CONTENT_RATING_SQL} AS content_rating FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id
WHERE asset.status = 'normal' AND asset.import_source IS NOT 'favorite_cover' AND (?3 = 0 OR EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id) = 1)
AND (?13 IS NULL OR EXISTS (SELECT 1 FROM asset_artist_scope AS artist_scope WHERE artist_scope.asset_id = asset.id AND artist_scope.scope_ref IN (?13, (SELECT 'artist:' || artist_member.artist_id FROM artist_members AS artist_member WHERE artist_member.creator_key = ?13))))
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?5 IS NULL OR EXISTS (SELECT 1 FROM asset_albums AS album_link WHERE album_link.asset_id = asset.id AND album_link.album_id IN (SELECT id FROM album_descendants)))
AND (?9 IS NULL OR EXISTS (SELECT 1 FROM collection_assets AS collection_link WHERE collection_link.asset_id = asset.id AND collection_link.collection_id = ?9))
AND (?6 IS NULL OR asset.collected_at < ?6 OR (asset.collected_at = ?6 AND asset.id < ?7))
AND (?8 IS NULL OR asset.collected_at < ?8)
AND (?14 IS NULL OR asset.collected_at >= ?14)
AND (?15 IS NULL OR asset.collected_at < ?15)
AND (
  (?11 IS NULL)
  OR (?11 = 'images' AND asset.media_kind IN ('image', 'gif'))
  OR (?11 = 'videos' AND asset.media_kind = 'video')
)
AND (
  (?12 IS NULL)
  OR (?12 = 'square' AND asset.width * 5 >= asset.height * 4 AND asset.width * 4 <= asset.height * 5)
  OR (?12 = 'landscape' AND asset.width * 4 > asset.height * 5)
  OR (?12 = 'portrait' AND asset.width * 5 < asset.height * 4)
)
ORDER BY asset.collected_at DESC, asset.id DESC LIMIT ?10".replace("{CONTENT_RATING_SQL}", CONTENT_RATING_SQL));

/// Filter-only asset count shared by every `list_assets` path (all sorts,
/// both paging directions, anchored windows). It mirrors the scope/filter
/// predicates of the list queries exactly but ignores cursors, date anchors,
/// ordering, and limits, so the gallery can reserve the full scroll range
/// up front instead of growing it on every appended page.
/// `?1` classification scope, `?2` album scope, `?3` favorite flag,
/// `?4` creator key, `?5` direct-only flag, `?6` unclassified flag,
/// `?7` collection scope, `?8` media filter, `?9` aspect filter,
/// `?10`/`?11` collected range bounds.
const ASSET_COUNT_SQL: &str = "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) , album_descendants(id) AS (
    SELECT ?2 WHERE ?2 IS NOT NULL
    UNION ALL SELECT child.id FROM albums AS child JOIN album_descendants ON child.parent_id = album_descendants.id
) SELECT COUNT(*) FROM assets AS asset
WHERE asset.status = 'normal' AND asset.import_source IS NOT 'favorite_cover' AND (?3 = 0 OR EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id) = 1)
AND (?4 IS NULL OR EXISTS (SELECT 1 FROM asset_artist_scope AS artist_scope WHERE artist_scope.asset_id = asset.id AND artist_scope.scope_ref IN (?4, (SELECT 'artist:' || artist_member.artist_id FROM artist_members AS artist_member WHERE artist_member.creator_key = ?4))))
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?5 AND link.classification_id = ?1) OR (NOT ?5 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?6 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?2 IS NULL OR EXISTS (SELECT 1 FROM asset_albums AS album_link WHERE album_link.asset_id = asset.id AND album_link.album_id IN (SELECT id FROM album_descendants)))
AND (?7 IS NULL OR EXISTS (SELECT 1 FROM collection_assets AS collection_link WHERE collection_link.asset_id = asset.id AND collection_link.collection_id = ?7))
AND (
  (?8 IS NULL)
  OR (?8 = 'images' AND asset.media_kind IN ('image', 'gif'))
  OR (?8 = 'videos' AND asset.media_kind = 'video')
)
AND (
  (?9 IS NULL)
  OR (?9 = 'square' AND asset.width * 5 >= asset.height * 4 AND asset.width * 4 <= asset.height * 5)
  OR (?9 = 'landscape' AND asset.width * 4 > asset.height * 5)
  OR (?9 = 'portrait' AND asset.width * 5 < asset.height * 4)
)
AND (?10 IS NULL OR asset.collected_at >= ?10)
AND (?11 IS NULL OR asset.collected_at < ?11)";

fn count_filtered_assets(
    connection: &rusqlite::Connection,
    query: &AssetQuery,
) -> Result<u64, LibraryError> {
    let (range_start, range_end) = collected_range_bounds(query)?;
    let total: i64 = connection.query_row(
        &scoped_asset_sql(connection, ASSET_COUNT_SQL, query, 1, 7)?,
        rusqlite::params![
            query.classification_id.as_deref(),
            query.album_id.as_deref(),
            query.favorite_only,
            query.creator_key.as_deref(),
            query.direct_only,
            query.unclassified_only,
            query.collection_id.as_deref(),
            media_filter_value(query.media_kind),
            aspect_filter_value(query.aspect_ratio),
            range_start,
            range_end,
        ],
        |row| row.get(0),
    )?;
    Ok(u64::try_from(total.max(0)).unwrap_or(0))
}

/// The listing and count statements all start their filters with this clause.
const NORMAL_ASSET_CLAUSE: &str = "WHERE asset.status = 'normal' AND asset.import_source IS NOT 'favorite_cover'";

/// Applies shared query predicates to every list, count, anchor and refresh path.
fn with_asset_filters<'a>(
    sql: std::borrow::Cow<'a, str>,
    query: &AssetQuery,
) -> Result<std::borrow::Cow<'a, str>, LibraryError> {
    let mut conditions = super::auto_tags::filter_conditions(query.auto_tags.as_ref())?;
    if query.duration_ms_min.is_some() || query.duration_ms_max.is_some() {
        // EXISTS also works for the count query, which does not join video_assets.
        // Typed integer bounds can be embedded without changing each sort's bind slots.
        conditions.push_str(" AND asset.media_kind = 'video' AND EXISTS (SELECT 1 FROM video_assets AS duration WHERE duration.asset_id = asset.id AND typeof(duration.duration_ms) = 'integer' AND duration.duration_ms >= 0");
        if let Some(min) = query.duration_ms_min {
            conditions.push_str(&format!(" AND duration.duration_ms >= {min}"));
        }
        if let Some(max) = query.duration_ms_max {
            conditions.push_str(&format!(" AND duration.duration_ms < {max}"));
        }
        conditions.push(')');
    }
    if conditions.is_empty() {
        return Ok(sql);
    }
    debug_assert!(sql.contains(NORMAL_ASSET_CLAUSE));
    Ok(std::borrow::Cow::Owned(sql.replacen(
        NORMAL_ASSET_CLAUSE,
        &format!("{NORMAL_ASSET_CLAUSE}{conditions}"),
        1,
    )))
}

/// Small scopes benefit from primary-key lookups; broad scopes need the existing
/// ordered scan. Probe at most 1,001 links so choosing a plan stays bounded.
/// The 자동 태그 filter is applied here too, so every listing path shares it.
fn scoped_asset_sql<'a>(
    connection: &rusqlite::Connection,
    sql: &'a str,
    query: &AssetQuery,
    classification_parameter: usize,
    collection_parameter: usize,
) -> Result<std::borrow::Cow<'a, str>, LibraryError> {
    with_asset_filters(
        membership_scoped_sql(
            connection,
            sql,
            query,
            classification_parameter,
            collection_parameter,
        )?,
        query,
    )
}

fn membership_scoped_sql<'a>(
    connection: &rusqlite::Connection,
    sql: &'a str,
    query: &AssetQuery,
    classification_parameter: usize,
    collection_parameter: usize,
) -> Result<std::borrow::Cow<'a, str>, LibraryError> {
    let (scope, links, column, hierarchy) = if let Some(id) = query.classification_id.as_deref() {
        (id, "asset_classifications", "classification_id", (!query.direct_only).then_some("classification_entries"))
    } else if let Some(id) = query.album_id.as_deref() {
        (id, "asset_albums", "album_id", Some("albums"))
    } else if let Some(id) = query.collection_id.as_deref() {
        (id, "collection_assets", "collection_id", None)
    } else {
        return Ok(std::borrow::Cow::Borrowed(sql));
    };
    let probe = if let Some(table) = hierarchy {
        format!("WITH RECURSIVE scopes(id) AS (SELECT ?1 UNION ALL SELECT child.id FROM {table} AS child JOIN scopes ON child.parent_id = scopes.id) SELECT COUNT(*) FROM (SELECT asset_id FROM {links} WHERE {column} IN (SELECT id FROM scopes) LIMIT 1001)")
    } else {
        format!("SELECT COUNT(*) FROM (SELECT asset_id FROM {links} WHERE {column} = ?1 LIMIT 1001)")
    };
    let count: i64 = connection.query_row(&probe, [scope], |row| row.get(0))?;
    if count > 1000 {
        return Ok(std::borrow::Cow::Borrowed(sql));
    }
    let condition = if query.classification_id.is_some() {
        if query.direct_only {
            format!("classification_id = ?{classification_parameter}")
        } else {
            "classification_id IN (SELECT id FROM descendants)".to_owned()
        }
    } else if query.album_id.is_some() {
        "album_id IN (SELECT id FROM album_descendants)".to_owned()
    } else {
        format!("collection_id = ?{collection_parameter}")
    };
    // DISTINCT avoids duplicate assets linked to multiple descendants. CROSS JOIN
    // keeps SQLite from reverting to a library-wide status scan for small scopes.
    Ok(std::borrow::Cow::Owned(sql.replacen(
        "FROM assets AS asset",
        &format!("FROM (SELECT DISTINCT asset_id FROM {links} WHERE {condition}) AS membership CROSS JOIN assets AS asset ON asset.id = membership.asset_id"),
        1,
    )))
}

impl Library {
    pub(crate) fn list_normal_x_source_urls(&self) -> Result<Vec<String>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT DISTINCT source_url FROM assets\n             WHERE status = 'normal' AND import_source IS NOT 'favorite_cover'\n               AND source_url IS NOT NULL\n               AND (source_url LIKE 'https://x.com/%' OR source_url LIKE 'https://twitter.com/%')\n             ORDER BY source_url ASC",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut urls = Vec::new();
        for row in rows {
            urls.push(row?);
        }
        Ok(urls)
    }

    /// Refresh only retained rows, using the same membership predicates as paging.
    /// This never scans forward from page one to rediscover a user's viewport.
    pub fn refresh_assets(&self, query: AssetQuery, asset_ids: Vec<String>) -> Result<Vec<AssetSummary>, LibraryError> {
        if asset_ids.len() > 500 { return Err(LibraryError::InvalidAssetPageLimit); }
        let (start, end) = collected_range_bounds(&query)?;
        let connection = self.connection()?;
        let select = "SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id), asset.source_url, asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count, asset.source_published_at, asset.creator_name, asset.creator_handle, asset.creator_url, asset.import_source, asset.import_batch_id, asset.original_modified_at, {CONTENT_RATING_SQL} AS content_rating FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id";
        let sql = with_asset_filters(ASSET_COUNT_SQL.into(), &query)?
            .replace("SELECT COUNT(*) FROM assets AS asset", &select.replace("{CONTENT_RATING_SQL}", CONTENT_RATING_SQL))
            + " AND asset.id IN (SELECT value FROM json_each(?12))";
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params![query.classification_id, query.album_id,
            query.favorite_only, query.creator_key, query.direct_only, query.unclassified_only,
            query.collection_id, media_filter_value(query.media_kind), aspect_filter_value(query.aspect_ratio),
            start, end, serde_json::to_string(&asset_ids).expect("string IDs serialize")],
            |row| Ok(asset_row(row, false)?.summary))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_assets(&self, query: AssetQuery) -> Result<AssetPage, LibraryError> {
        if !(1..=200).contains(&query.limit) {
            return Err(LibraryError::InvalidAssetPageLimit);
        }
        if [
            query.classification_id.is_some(),
            query.album_id.is_some(),
            query.collection_id.is_some(),
        ]
        .into_iter()
        .filter(|present| *present)
        .count()
            > 1
        {
            return Err(LibraryError::InvalidAssetScope);
        }

        let connection = self.connection()?;
        if let Some(classification_id) = query.classification_id.as_deref() {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM classification_entries WHERE id = ?1)",
                [classification_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(LibraryError::ClassificationNotFound);
            }
        }
        if let Some(album_id) = query.album_id.as_deref() {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
                [album_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(LibraryError::AlbumNotFound);
            }
        }
        if let Some(collection_id) = query.collection_id.as_deref() {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE id = ?1)",
                [collection_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(LibraryError::CollectionNotFound);
            }
        }
        let (range_start, range_end) = collected_range_bounds(&query)?;
        if query.after.is_some() && (query.before.is_some() || query.around_date.is_some()) {
            return Err(LibraryError::InvalidAssetCursor);
        }
        match query.sort {
            AssetSort::Newest | AssetSort::Oldest => {}
            AssetSort::Favorites | AssetSort::Random => {
                if query.before.is_some() || query.around_date.is_some() {
                    return Err(LibraryError::InvalidAssetCursor);
                }
            }
        }
        if let Some(date) = query.around_date.as_deref() {
            return self.anchor_asset_page(&connection, &query, date);
        }
        if let Some(cursor) = query.before.as_ref() {
            return self.asset_page_before(&connection, &query, cursor);
        }
        let cursor = decode_cursor(&query)?;
        let media_kind = media_filter_value(query.media_kind);
        let aspect_ratio = aspect_filter_value(query.aspect_ratio);
        let random_pivot = query.random_pivot.as_deref().unwrap_or("");
        let sql = match query.sort {
            AssetSort::Newest => CHRONO_DESC_HALF_SQL.as_str(),
            AssetSort::Oldest => CHRONO_ASC_HALF_SQL.as_str(),
            AssetSort::Favorites => FAVORITES_SQL.as_str(),
            AssetSort::Random => RANDOM_SQL.as_str(),
        };
        let collection_parameter = match query.sort {
            AssetSort::Favorites => 10,
            AssetSort::Random => 11,
            _ => 9,
        };
        let sql = scoped_asset_sql(&connection, sql, &query, 1, collection_parameter)?;
        let mut statement = connection.prepare(&sql)?;
        let mut rows = match query.sort {
            AssetSort::Newest => {
                let (collected_at, id) = collected_at_and_id(&cursor);
                statement.query(params![
                    query.classification_id.as_deref(),
                    query.direct_only,
                    query.favorite_only,
                    query.unclassified_only,
                    query.album_id.as_deref(),
                    collected_at,
                    id,
                    None::<String>,
                    query.collection_id.as_deref(),
                    i64::from(query.limit) + 1,
                    media_kind,
                    aspect_ratio,
                    query.creator_key.as_deref(),
                    range_start,
                    range_end,
                ])?
            }
            AssetSort::Oldest => {
                let (collected_at, id) = collected_at_and_id(&cursor);
                statement.query(params![
                    query.classification_id.as_deref(),
                    query.direct_only,
                    query.favorite_only,
                    query.unclassified_only,
                    query.album_id.as_deref(),
                    collected_at,
                    id,
                    None::<String>,
                    query.collection_id.as_deref(),
                    i64::from(query.limit) + 1,
                    media_kind,
                    aspect_ratio,
                    query.creator_key.as_deref(),
                    range_start,
                    range_end,
                ])?
            }
            AssetSort::Favorites => {
                let (favorite, collected_at, id) = favorite_keys(&cursor);
                statement.query(params![
                    query.classification_id.as_deref(),
                    query.direct_only,
                    query.favorite_only,
                    query.unclassified_only,
                    query.album_id.as_deref(),
                    favorite,
                    collected_at,
                    id,
                    i64::from(query.limit) + 1,
                    query.collection_id.as_deref(),
                    media_kind,
                    aspect_ratio,
                    query.creator_key.as_deref(),
                    range_start,
                    range_end,
                ])?
            }
            AssetSort::Random => {
                let (bucket, content_hash, id) = random_keys(&cursor);
                statement.query(params![
                    query.classification_id.as_deref(),
                    query.direct_only,
                    query.favorite_only,
                    query.unclassified_only,
                    query.album_id.as_deref(),
                    random_pivot,
                    bucket,
                    content_hash,
                    id,
                    i64::from(query.limit) + 1,
                    query.collection_id.as_deref(),
                    media_kind,
                    aspect_ratio,
                    query.creator_key.as_deref(),
                    range_start,
                    range_end,
                ])?
            }
        };
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            items.push(asset_row(row, query.sort == AssetSort::Random)?);
        }

        let has_more = items.len() > query.limit as usize;
        items.truncate(query.limit as usize);
        let next_cursor = has_more.then(|| {
            let asset = items
                .last()
                .expect("a page with another item has a returned item");
            encode_cursor(&query, asset)
        });
        Ok(AssetPage {
            items: items.into_iter().map(|asset| asset.summary).collect(),
            next_cursor,
            previous_cursor: None,
            total_count: count_filtered_assets(&connection, &query)?,
        })
    }

    /// Loads one window centered on a date: the half page adjacent above the
    /// boundary plus the half page starting at it, in display order, with
    /// cursors for continuing both upward and downward.
    fn anchor_asset_page(
        &self,
        connection: &rusqlite::Connection,
        query: &AssetQuery,
        date: &str,
    ) -> Result<AssetPage, LibraryError> {
        let bound = anchor_bound(query.sort, date)?;
        let half = (query.limit as usize).max(2) / 2;
        let fetch = i64::try_from(half + 1).map_err(|_| LibraryError::InvalidAssetPageLimit)?;
        // Head half: the page adjacent above the boundary (fetched toward the
        // boundary, then reversed into display order). Tail half: the page
        // starting at the boundary in display order.
        let (head_sql, tail_sql) = match query.sort {
            AssetSort::Oldest => (CHRONO_DESC_HALF_SQL.as_str(), CHRONO_ASC_HALF_SQL.as_str()),
            _ => (CHRONO_ASC_HALF_SQL.as_str(), CHRONO_DESC_HALF_SQL.as_str()),
        };
        let mut head =
            run_chronological_page(connection, head_sql, query, None, Some(&bound), fetch)?;
        let has_more_up = head.len() > half;
        head.truncate(half);
        head.reverse();
        let mut tail =
            run_chronological_page(connection, tail_sql, query, None, Some(&bound), fetch)?;
        let has_more_down = tail.len() > half;
        tail.truncate(half);
        let mut items: Vec<AssetSummary> = head.into_iter().map(|row| row.summary).collect();
        items.extend(tail.iter().map(|row| row.summary.clone()));
        let previous_cursor = has_more_up.then(|| {
            encode_cursor(
                query,
                &chrono_row(items.first().expect("more-up implies a first item")),
            )
        });
        let next_cursor = (has_more_down && !tail.is_empty())
            .then(|| encode_cursor(query, &tail.last().expect("tail keeps its last item")));
        Ok(AssetPage {
            items,
            next_cursor,
            previous_cursor,
            total_count: count_filtered_assets(connection, query)?,
        })
    }

    /// Loads the page immediately preceding `cursor` in display order.
    fn asset_page_before(
        &self,
        connection: &rusqlite::Connection,
        query: &AssetQuery,
        cursor: &AssetCursor,
    ) -> Result<AssetPage, LibraryError> {
        let payload = decode_side_cursor(query, cursor)?;
        let (collected_at, id) = match &payload {
            CursorPayload::Newest { collected_at, id }
            | CursorPayload::Oldest { collected_at, id } => {
                (collected_at.as_str(), id.as_str())
            }
            _ => return Err(LibraryError::InvalidAssetCursor),
        };
        let limit_plus = i64::from(query.limit) + 1;
        let sql = match query.sort {
            AssetSort::Oldest => CHRONO_DESC_HALF_SQL.as_str(),
            _ => CHRONO_ASC_HALF_SQL.as_str(),
        };
        let mut rows = run_chronological_page(
            connection,
            sql,
            query,
            Some((collected_at, id)),
            None,
            limit_plus,
        )?;
        let has_more_up = rows.len() > query.limit as usize;
        rows.truncate(query.limit as usize);
        rows.reverse();
        let items: Vec<AssetSummary> = rows.into_iter().map(|row| row.summary).collect();
        let previous_cursor = has_more_up.then(|| {
            encode_cursor(
                query,
                &chrono_row(items.first().expect("more-up implies a first item")),
            )
        });
        Ok(AssetPage {
            items,
            next_cursor: None,
            previous_cursor,
            total_count: count_filtered_assets(connection, query)?,
        })
    }

    pub fn list_asset_date_buckets(&self, query: AssetDateBucketQuery) -> Result<Vec<AssetDateBucket>, LibraryError> {
        let start = chrono::DateTime::parse_from_rfc3339(&query.start_utc)
            .map_err(|_| LibraryError::InvalidAssetDateRange)?;
        let end = chrono::DateTime::parse_from_rfc3339(&query.end_utc)
            .map_err(|_| LibraryError::InvalidAssetDateRange)?;
        if start >= end || !(-840..=840).contains(&query.offset_minutes) {
            return Err(LibraryError::InvalidAssetDateRange);
        }
        // Home supplies exact midnights so a DST change never moves an image to a neighbor day.
        let ranges = if let Some(days) = &query.local_days {
            if days.is_empty() || days.len() > 31 {
                return Err(LibraryError::InvalidAssetDateRange);
            }
            let mut previous_end = start;
            let mut previous_date = None;
            let mut normalized = Vec::with_capacity(days.len());
            for day in days {
                let date = chrono::NaiveDate::parse_from_str(&day.local_date, "%Y-%m-%d")
                    .map_err(|_| LibraryError::InvalidAssetDateRange)?;
                let day_start = chrono::DateTime::parse_from_rfc3339(&day.start_utc)
                    .map_err(|_| LibraryError::InvalidAssetDateRange)?;
                let day_end = chrono::DateTime::parse_from_rfc3339(&day.end_utc)
                    .map_err(|_| LibraryError::InvalidAssetDateRange)?;
                if day_start != previous_end
                    || day_start >= day_end
                    || day_end > end
                    || previous_date.is_some_and(|previous: chrono::NaiveDate| {
                        previous.succ_opt() != Some(date)
                    })
                {
                    return Err(LibraryError::InvalidAssetDateRange);
                }
                previous_end = day_end;
                previous_date = Some(date);
                // Use the same UTC text form as collected_at for indexed comparisons.
                normalized.push(UtcDateRange {
                    local_date: day.local_date.clone(),
                    start_utc: day_start.with_timezone(&chrono::Utc)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    end_utc: day_end.with_timezone(&chrono::Utc)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                });
            }
            if previous_end != end {
                return Err(LibraryError::InvalidAssetDateRange);
            }
            Some(serde_json::to_string(&normalized).expect("local day strings serialize"))
        } else {
            None
        };
        let connection = self.connection()?;
        let mut statement = connection.prepare(if ranges.is_some() { LOCAL_DATE_BUCKETS_SQL } else { DATE_BUCKETS_SQL })?;
        let start = start.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let end = end.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut rows = statement.query(params![start, end, query.offset_minutes, query.images_only, ranges])?;
        let mut buckets = Vec::new();
        while let Some(row) = rows.next()? {
            let date: String = row.get(0)?;
            let count: i64 = row.get(1)?;
            buckets.push(AssetDateBucket { date, count: count as u64 });
        }
        Ok(buckets)
    }

    pub fn list_asset_creators(&self, query: AssetQuery) -> Result<Vec<AssetCreatorSummary>, LibraryError> {
        if [
            query.classification_id.is_some(),
            query.album_id.is_some(),
            query.collection_id.is_some(),
            query.creator_key.is_some(),
        ]
        .into_iter()
        .filter(|present| *present)
        .count()
            > 1
        {
            return Err(LibraryError::InvalidAssetScope);
        }

        let connection = self.connection()?;
        let media_kind = media_filter_value(query.media_kind);
        let aspect_ratio = aspect_filter_value(query.aspect_ratio);
        let mut statement = connection.prepare(CREATORS_SQL)?;
        let mut rows = statement.query(params![
            query.classification_id.as_deref(),
            query.direct_only,
            query.favorite_only,
            query.unclassified_only,
            query.album_id.as_deref(),
            media_kind,
            aspect_ratio,
            query.collection_id.as_deref(),
        ])?;
        let mut creators = Vec::new();
        while let Some(row) = rows.next()? {
            creators.push(AssetCreatorSummary {
                key: row.get(0)?,
                creator_name: row.get(1)?,
                creator_handle: row.get(2)?,
                creator_url: row.get(3)?,
                asset_count: row.get::<_, i64>(4)? as u64,
                last_collected_at: row.get(5)?,
                last_opened_at: row.get(6)?,
                recommendation_score: row.get(7)?,
                cover_asset_ids: [
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, Option<String>>(12)?,
                    row.get::<_, Option<String>>(13)?,
                    row.get::<_, Option<String>>(14)?,
                    row.get::<_, Option<String>>(15)?,
                ]
                    .into_iter()
                    .flatten()
                    .collect(),
            });
        }
        Ok(creators)
    }
}

fn decode_bound_cursor(query: &AssetQuery, cursor: &AssetCursor) -> Result<CursorPayload, LibraryError> {
    let bound = serde_json::from_str::<BoundCursor>(&cursor.token)
        .map_err(|_| LibraryError::InvalidAssetCursor)?;
    if bound.duration_ms_min != query.duration_ms_min || bound.duration_ms_max != query.duration_ms_max {
        return Err(LibraryError::InvalidAssetCursor);
    }
    Ok(bound.payload)
}

fn decode_cursor(query: &AssetQuery) -> Result<Option<CursorPayload>, LibraryError> {
    let Some(cursor) = query.after.as_ref() else {
        return Ok(None);
    };
    let payload = decode_bound_cursor(query, cursor)?;
    let expected = match (&query.sort, &payload) {
        (AssetSort::Newest, CursorPayload::Newest { .. })
        | (AssetSort::Oldest, CursorPayload::Oldest { .. })
        | (AssetSort::Favorites, CursorPayload::Favorites { .. }) => true,
        (AssetSort::Random, CursorPayload::Random { pivot, .. }) => {
            pivot == query.random_pivot.as_deref().unwrap_or("")
        }
        _ => false,
    };
    if expected {
        Ok(Some(payload))
    } else {
        Err(LibraryError::InvalidAssetCursor)
    }
}

fn decode_side_cursor(
    query: &AssetQuery,
    cursor: &AssetCursor,
) -> Result<CursorPayload, LibraryError> {
    let payload = decode_bound_cursor(query, cursor)?;
    let expected = matches!(
        (&query.sort, &payload),
        (AssetSort::Newest, CursorPayload::Newest { .. })
            | (AssetSort::Oldest, CursorPayload::Oldest { .. })
    );
    if expected {
        Ok(payload)
    } else {
        Err(LibraryError::InvalidAssetCursor)
    }
}

/// The display-order boundary just before `date`: everything at or after the
/// bound belongs to the tail half of an anchor window.
fn anchor_bound(sort: AssetSort, date: &str) -> Result<String, LibraryError> {
    let day =
        chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| LibraryError::InvalidAssetCursor)?;
    Ok(match sort {
        AssetSort::Oldest => day.format("%Y-%m-%d").to_string(),
        _ => (day + chrono::Duration::days(1)).format("%Y-%m-%d").to_string(),
    })
}

fn chrono_row(summary: &AssetSummary) -> AssetRow {
    AssetRow {
        summary: summary.clone(),
        content_hash: None,
        random_bucket: None,
    }
}

fn run_chronological_page(
    connection: &rusqlite::Connection,
    sql: &str,
    query: &AssetQuery,
    cursor: Option<(&str, &str)>,
    bound: Option<&str>,
    limit_plus: i64,
) -> Result<Vec<AssetRow>, LibraryError> {
    let (collected_at, id) = cursor.map_or((None, None), |(at, asset_id)| (Some(at), Some(asset_id)));
    let media_kind = media_filter_value(query.media_kind);
    let aspect_ratio = aspect_filter_value(query.aspect_ratio);
    let (range_start, range_end) = collected_range_bounds(query)?;
    let sql = scoped_asset_sql(connection, sql, query, 1, 9)?;
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(params![
        query.classification_id.as_deref(),
        query.direct_only,
        query.favorite_only,
        query.unclassified_only,
        query.album_id.as_deref(),
        collected_at,
        id,
        bound,
        query.collection_id.as_deref(),
        limit_plus,
        media_kind,
        aspect_ratio,
        query.creator_key.as_deref(),
        range_start,
        range_end,
    ])?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        items.push(asset_row(row, false)?);
    }
    Ok(items)
}

fn collected_range_bounds(query: &AssetQuery) -> Result<(Option<&str>, Option<&str>), LibraryError> {
    let Some(range) = query.collected_range.as_ref() else {
        return Ok((None, None));
    };
    let start = chrono::DateTime::parse_from_rfc3339(&range.start_utc)
        .map_err(|_| LibraryError::InvalidAssetDateRange)?;
    let end = chrono::DateTime::parse_from_rfc3339(&range.end_utc)
        .map_err(|_| LibraryError::InvalidAssetDateRange)?;
    if start >= end {
        return Err(LibraryError::InvalidAssetDateRange);
    }
    Ok((Some(&range.start_utc), Some(&range.end_utc)))
}

fn collected_at_and_id(cursor: &Option<CursorPayload>) -> (Option<&str>, Option<&str>) {
    match cursor {
        Some(CursorPayload::Newest { collected_at, id })
        | Some(CursorPayload::Oldest { collected_at, id }) => (Some(collected_at), Some(id)),
        None => (None, None),
        _ => unreachable!("cursor sort was validated"),
    }
}

fn favorite_keys(cursor: &Option<CursorPayload>) -> (Option<bool>, Option<&str>, Option<&str>) {
    match cursor {
        Some(CursorPayload::Favorites {
            favorite,
            collected_at,
            id,
        }) => (Some(*favorite), Some(collected_at), Some(id)),
        None => (None, None, None),
        _ => unreachable!("cursor sort was validated"),
    }
}

fn random_keys(cursor: &Option<CursorPayload>) -> (Option<i64>, Option<&str>, Option<&str>) {
    match cursor {
        Some(CursorPayload::Random {
            bucket,
            content_hash,
            id,
            ..
        }) => (Some(*bucket), Some(content_hash), Some(id)),
        None => (None, None, None),
        _ => unreachable!("cursor sort was validated"),
    }
}

fn asset_row(row: &rusqlite::Row<'_>, random: bool) -> rusqlite::Result<AssetRow> {
    Ok(AssetRow {
        summary: asset_summary_from_row(row)?,
        content_hash: random.then(|| row.get(22)).transpose()?,
        random_bucket: random.then(|| row.get(23)).transpose()?,
    })
}

pub(crate) fn asset_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AssetSummary> {
    let byte_size =
        u64::try_from(row.get::<_, i64>(5)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let media_kind: String = row.get(11)?;
    let media = match media_kind.as_str() {
        "image" => MediaSummary::Image,
        "gif" => MediaSummary::Gif,
        "video" => MediaSummary::Video {
            duration_ms: u64::try_from(row.get::<_, i64>(12)?)
                .map_err(|_| rusqlite::Error::InvalidQuery)?,
            preparation_state: preparation_state(&row.get::<_, String>(13)?)?,
            scrub_frame_count: u32::try_from(row.get::<_, i64>(14)?)
                .map_err(|_| rusqlite::Error::InvalidQuery)?,
        },
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(AssetSummary {
        content_rating: row.get("content_rating")?,
        id: row.get(0)?,
        title: row.get(1)?,
        original_name: row.get(2)?,
        relative_path: row.get(3)?,
        thumbnail_relative_path: row.get(4)?,
        byte_size,
        width: row.get(6)?,
        height: row.get(7)?,
        collected_at: row.get(8)?,
        favorite: row.get(9)?,
        source_url: row.get(10)?,
        source_published_at: row.get(15)?,
        creator_name: row.get(16)?,
        creator_handle: row.get(17)?,
        creator_url: row.get(18)?,
        import_source: row
            .get::<_, Option<String>>(19)?
            .as_deref()
            .and_then(ImportSource::parse),
        import_batch_id: row.get(20)?,
        original_modified_at: row.get(21)?,
        media,
    })
}

pub(crate) fn asset_summaries_by_ids(
    connection: &rusqlite::Connection,
    asset_ids: &[String],
) -> Result<Vec<AssetSummary>, LibraryError> {
    if asset_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", asset_ids.len()).collect::<Vec<_>>().join(",");
    let sql = format!("SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id), asset.source_url, asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count, asset.source_published_at, asset.creator_name, asset.creator_handle, asset.creator_url, asset.import_source, asset.import_batch_id, asset.original_modified_at, {CONTENT_RATING_SQL} AS content_rating FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id=asset.id WHERE asset.status='normal' AND asset.import_source IS NOT 'favorite_cover' AND asset.id IN ({placeholders})");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(asset_ids.iter()), asset_summary_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let mut by_id = rows
        .into_iter()
        .map(|asset| (asset.id.clone(), asset))
        .collect::<std::collections::BTreeMap<_, _>>();
    asset_ids
        .iter()
        .map(|id| by_id.remove(id).ok_or(LibraryError::AssetNotFound))
        .collect()
}

fn preparation_state(value: &str) -> rusqlite::Result<VideoPreparationState> {
    match value {
        "pending" => Ok(VideoPreparationState::Pending),
        "processing" => Ok(VideoPreparationState::Processing),
        "ready" => Ok(VideoPreparationState::Ready),
        "failed" => Ok(VideoPreparationState::Failed),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn encode_cursor(query: &AssetQuery, asset: &AssetRow) -> AssetCursor {
    let payload = match query.sort {
        AssetSort::Newest => CursorPayload::Newest {
            collected_at: asset.summary.collected_at.clone(),
            id: asset.summary.id.clone(),
        },
        AssetSort::Oldest => CursorPayload::Oldest {
            collected_at: asset.summary.collected_at.clone(),
            id: asset.summary.id.clone(),
        },
        AssetSort::Favorites => CursorPayload::Favorites {
            favorite: asset.summary.favorite,
            collected_at: asset.summary.collected_at.clone(),
            id: asset.summary.id.clone(),
        },
        AssetSort::Random => CursorPayload::Random {
            pivot: query.random_pivot.as_deref().unwrap_or("").into(),
            bucket: asset.random_bucket.expect("random rows include a bucket"),
            content_hash: asset
                .content_hash
                .clone()
                .expect("random rows include a content hash"),
            id: asset.summary.id.clone(),
        },
    };
    AssetCursor {
        token: serde_json::to_string(&BoundCursor {
            payload,
            duration_ms_min: query.duration_ms_min,
            duration_ms_max: query.duration_ms_max,
        })
        .expect("cursor payload serializes"),
    }
}

static FAVORITES_SQL: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) , album_descendants(id) AS (
    SELECT ?5 WHERE ?5 IS NOT NULL
    UNION ALL SELECT child.id FROM albums AS child JOIN album_descendants ON child.parent_id = album_descendants.id
) SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id), asset.source_url,
asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count,
asset.source_published_at, asset.creator_name, asset.creator_handle, asset.creator_url,
asset.import_source, asset.import_batch_id, asset.original_modified_at, {CONTENT_RATING_SQL} AS content_rating FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id
WHERE asset.status = 'normal' AND asset.import_source IS NOT 'favorite_cover' AND (?3 = 0 OR EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id) = 1)
AND (?13 IS NULL OR EXISTS (SELECT 1 FROM asset_artist_scope AS artist_scope WHERE artist_scope.asset_id = asset.id AND artist_scope.scope_ref IN (?13, (SELECT 'artist:' || artist_member.artist_id FROM artist_members AS artist_member WHERE artist_member.creator_key = ?13))))
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?5 IS NULL OR EXISTS (SELECT 1 FROM asset_albums AS album_link WHERE album_link.asset_id = asset.id AND album_link.album_id IN (SELECT id FROM album_descendants)))
AND (?10 IS NULL OR EXISTS (SELECT 1 FROM collection_assets AS collection_link WHERE collection_link.asset_id = asset.id AND collection_link.collection_id = ?10))
AND (?6 IS NULL OR EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id) < ?6 OR (EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id) = ?6 AND (asset.collected_at < ?7 OR (asset.collected_at = ?7 AND asset.id < ?8))))
AND (?14 IS NULL OR asset.collected_at >= ?14)
AND (?15 IS NULL OR asset.collected_at < ?15)
AND (
  (?11 IS NULL)
  OR (?11 = 'images' AND asset.media_kind IN ('image', 'gif'))
  OR (?11 = 'videos' AND asset.media_kind = 'video')
)
AND (
  (?12 IS NULL)
  OR (?12 = 'square' AND asset.width * 5 >= asset.height * 4 AND asset.width * 4 <= asset.height * 5)
  OR (?12 = 'landscape' AND asset.width * 4 > asset.height * 5)
  OR (?12 = 'portrait' AND asset.width * 5 < asset.height * 4)
)
ORDER BY EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id) DESC, asset.collected_at DESC, asset.id DESC LIMIT ?9".replace("{CONTENT_RATING_SQL}", CONTENT_RATING_SQL));

static RANDOM_SQL: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) , album_descendants(id) AS (
    SELECT ?5 WHERE ?5 IS NOT NULL
    UNION ALL SELECT child.id FROM albums AS child JOIN album_descendants ON child.parent_id = album_descendants.id
) SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id), asset.source_url,
asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count,
asset.source_published_at, asset.creator_name, asset.creator_handle, asset.creator_url,
asset.import_source, asset.import_batch_id, asset.original_modified_at,
asset.content_hash, CASE WHEN asset.content_hash >= ?6 THEN 0 ELSE 1 END, {CONTENT_RATING_SQL} AS content_rating FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id
WHERE asset.status = 'normal' AND asset.import_source IS NOT 'favorite_cover' AND (?3 = 0 OR EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id) = 1)
AND (?14 IS NULL OR EXISTS (SELECT 1 FROM asset_artist_scope AS artist_scope WHERE artist_scope.asset_id = asset.id AND artist_scope.scope_ref IN (?14, (SELECT 'artist:' || artist_member.artist_id FROM artist_members AS artist_member WHERE artist_member.creator_key = ?14))))
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?5 IS NULL OR EXISTS (SELECT 1 FROM asset_albums AS album_link WHERE album_link.asset_id = asset.id AND album_link.album_id IN (SELECT id FROM album_descendants)))
AND (?11 IS NULL OR EXISTS (SELECT 1 FROM collection_assets AS collection_link WHERE collection_link.asset_id = asset.id AND collection_link.collection_id = ?11))
AND (?7 IS NULL OR CASE WHEN asset.content_hash >= ?6 THEN 0 ELSE 1 END > ?7 OR (CASE WHEN asset.content_hash >= ?6 THEN 0 ELSE 1 END = ?7 AND (asset.content_hash > ?8 OR (asset.content_hash = ?8 AND asset.id > ?9))))
AND (?15 IS NULL OR asset.collected_at >= ?15)
AND (?16 IS NULL OR asset.collected_at < ?16)
AND (
  (?12 IS NULL)
  OR (?12 = 'images' AND asset.media_kind IN ('image', 'gif'))
  OR (?12 = 'videos' AND asset.media_kind = 'video')
)
AND (
  (?13 IS NULL)
  OR (?13 = 'square' AND asset.width * 5 >= asset.height * 4 AND asset.width * 4 <= asset.height * 5)
  OR (?13 = 'landscape' AND asset.width * 4 > asset.height * 5)
  OR (?13 = 'portrait' AND asset.width * 5 < asset.height * 4)
)
ORDER BY CASE WHEN asset.content_hash >= ?6 THEN 0 ELSE 1 END ASC, asset.content_hash ASC, asset.id ASC LIMIT ?10".replace("{CONTENT_RATING_SQL}", CONTENT_RATING_SQL));

const CREATORS_SQL: &str = "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) , album_descendants(id) AS (
    SELECT ?5 WHERE ?5 IS NOT NULL
    UNION ALL SELECT child.id FROM albums AS child JOIN album_descendants ON child.parent_id = album_descendants.id
), scoped AS MATERIALIZED (
    SELECT asset.id, asset.creator_name, asset.creator_handle, asset.creator_url, asset.collected_at
    FROM assets AS asset
    WHERE asset.status = 'normal' AND asset.import_source IS NOT 'favorite_cover' AND (?3 = 0 OR EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id) = 1)
    AND COALESCE(asset.creator_handle, asset.creator_url) IS NOT NULL
    AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
    AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
    AND (?5 IS NULL OR EXISTS (SELECT 1 FROM asset_albums AS album_link WHERE album_link.asset_id = asset.id AND album_link.album_id IN (SELECT id FROM album_descendants)))
    AND (?8 IS NULL OR EXISTS (SELECT 1 FROM collection_assets AS collection_link WHERE collection_link.asset_id = asset.id AND collection_link.collection_id = ?8))
    AND (
      (?6 IS NULL)
      OR (?6 = 'images' AND asset.media_kind IN ('image', 'gif'))
      OR (?6 = 'videos' AND asset.media_kind = 'video')
    )
    AND (
      (?7 IS NULL)
      OR (?7 = 'square' AND asset.width * 5 >= asset.height * 4 AND asset.width * 4 <= asset.height * 5)
      OR (?7 = 'landscape' AND asset.width * 4 > asset.height * 5)
      OR (?7 = 'portrait' AND asset.width * 5 < asset.height * 4)
    )
), keyed AS (
    SELECT id, creator_name, creator_handle, creator_url, collected_at,
           COALESCE(creator_handle, creator_url) AS key,
           ROW_NUMBER() OVER (PARTITION BY COALESCE(creator_handle, creator_url) ORDER BY collected_at DESC, id DESC) AS rn
    FROM scoped
), covers AS (
    SELECT key,
           MAX(CASE WHEN rn = 1 THEN id END) AS cover_0,
           MAX(CASE WHEN rn = 2 THEN id END) AS cover_1,
           MAX(CASE WHEN rn = 3 THEN id END) AS cover_2,
           MAX(CASE WHEN rn = 4 THEN id END) AS cover_3,
           MAX(CASE WHEN rn = 5 THEN id END) AS cover_4,
           MAX(CASE WHEN rn = 6 THEN id END) AS cover_5,
           MAX(CASE WHEN rn = 7 THEN id END) AS cover_6,
           MAX(CASE WHEN rn = 8 THEN id END) AS cover_7
    FROM keyed
    GROUP BY key
), grouped AS (
    SELECT key,
           MAX(creator_name) AS creator_name,
           MAX(creator_handle) AS creator_handle,
           MAX(creator_url) AS creator_url,
           COUNT(*) AS asset_count,
           MAX(collected_at) AS last_collected_at
    FROM keyed
    GROUP BY key
), recent_activity AS (
    SELECT keyed.key, MAX(activity.last_opened_at) AS last_opened_at,
           MAX(CASE WHEN activity.last_opened_at IS NULL THEN 10 ELSE 0 END) AS unseen_bonus
    FROM keyed LEFT JOIN asset_activity AS activity ON activity.asset_id = keyed.id
    WHERE keyed.rn <= 5 GROUP BY keyed.key
)
SELECT g.key, g.creator_name, g.creator_handle, g.creator_url, g.asset_count, g.last_collected_at,
       recent_activity.last_opened_at,
       (g.asset_count * 4 + CAST((julianday('now') - julianday(g.last_collected_at)) AS INTEGER)
        + COALESCE(recent_activity.unseen_bonus, 0)) AS recommendation_score,
       covers.cover_0, covers.cover_1, covers.cover_2, covers.cover_3, covers.cover_4, covers.cover_5, covers.cover_6, covers.cover_7
FROM grouped AS g
LEFT JOIN covers ON covers.key = g.key
LEFT JOIN recent_activity ON recent_activity.key = g.key
ORDER BY g.asset_count DESC, g.key ASC";
const DATE_BUCKETS_SQL: &str = "SELECT date(asset.collected_at, printf('%+d minutes', ?3)) AS date, COUNT(*) AS count
FROM assets AS asset
WHERE asset.status = 'normal' AND asset.import_source IS NOT 'favorite_cover'
AND asset.collected_at >= ?1
AND asset.collected_at < ?2
AND (?4 = 0 OR asset.media_kind IN ('image','gif'))
AND ?5 IS NULL
GROUP BY date ORDER BY date DESC";

// The existing (status, collected_at, id) index bounds each local day; only the requested window is read.
const LOCAL_DATE_BUCKETS_SQL: &str = "SELECT json_extract(day.value, '$.localDate') AS date, COUNT(*) AS count
FROM json_each(?5) AS day
JOIN assets AS asset ON asset.status = 'normal' AND asset.import_source IS NOT 'favorite_cover'
AND asset.collected_at >= json_extract(day.value, '$.startUtc')
AND asset.collected_at < json_extract(day.value, '$.endUtc')
WHERE asset.collected_at >= ?1 AND asset.collected_at < ?2
AND (?4 = 0 OR asset.media_kind IN ('image','gif'))
AND ?3 IS NOT NULL
GROUP BY date ORDER BY date DESC";

#[cfg(test)]
#[path = "query_tests.rs"]
mod tests;
