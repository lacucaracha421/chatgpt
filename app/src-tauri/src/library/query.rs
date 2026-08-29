use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{
    error::LibraryError,
    models::{
        AspectRatioFilter, AssetCreatorSummary, AssetCursor, AssetDateBucket, AssetPage,
        AssetQuery, AssetSort, AssetSummary, ImportSource, MediaKindFilter, MediaSummary,
        VideoPreparationState,
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
const CHRONO_ASC_HALF_SQL: &str = "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) , album_descendants(id) AS (
    SELECT ?5 WHERE ?5 IS NOT NULL
    UNION ALL SELECT child.id FROM albums AS child JOIN album_descendants ON child.parent_id = album_descendants.id
) SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, asset.favorite, asset.source_url,
asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count,
asset.source_published_at, asset.creator_name, asset.creator_handle, asset.creator_url,
asset.import_source, asset.import_batch_id, asset.original_modified_at
FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id
WHERE asset.status = 'normal' AND (?3 = 0 OR asset.favorite = 1)
AND (?13 IS NULL OR COALESCE(asset.creator_handle, asset.creator_url) = ?13)
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?5 IS NULL OR EXISTS (SELECT 1 FROM asset_albums AS album_link WHERE album_link.asset_id = asset.id AND album_link.album_id IN (SELECT id FROM album_descendants)))
AND (?9 IS NULL OR EXISTS (SELECT 1 FROM collection_assets AS collection_link WHERE collection_link.asset_id = asset.id AND collection_link.collection_id = ?9))
AND (?6 IS NULL OR asset.collected_at > ?6 OR (asset.collected_at = ?6 AND asset.id > ?7))
AND (?8 IS NULL OR asset.collected_at >= ?8)
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
ORDER BY asset.collected_at ASC, asset.id ASC LIMIT ?10";

/// The descending mirror of CHRONO_ASC_HALF_SQL: newest-first pages,
/// anchor tails/heads, and upward pagination in an oldest-first listing.
const CHRONO_DESC_HALF_SQL: &str = "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) , album_descendants(id) AS (
    SELECT ?5 WHERE ?5 IS NOT NULL
    UNION ALL SELECT child.id FROM albums AS child JOIN album_descendants ON child.parent_id = album_descendants.id
) SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, asset.favorite, asset.source_url,
asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count,
asset.source_published_at, asset.creator_name, asset.creator_handle, asset.creator_url,
asset.import_source, asset.import_batch_id, asset.original_modified_at
FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id
WHERE asset.status = 'normal' AND (?3 = 0 OR asset.favorite = 1)
AND (?13 IS NULL OR COALESCE(asset.creator_handle, asset.creator_url) = ?13)
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?5 IS NULL OR EXISTS (SELECT 1 FROM asset_albums AS album_link WHERE album_link.asset_id = asset.id AND album_link.album_id IN (SELECT id FROM album_descendants)))
AND (?9 IS NULL OR EXISTS (SELECT 1 FROM collection_assets AS collection_link WHERE collection_link.asset_id = asset.id AND collection_link.collection_id = ?9))
AND (?6 IS NULL OR asset.collected_at < ?6 OR (asset.collected_at = ?6 AND asset.id < ?7))
AND (?8 IS NULL OR asset.collected_at < ?8)
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
ORDER BY asset.collected_at DESC, asset.id DESC LIMIT ?10";
impl Library {
    pub(crate) fn list_normal_x_source_urls(&self) -> Result<Vec<String>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT DISTINCT source_url FROM assets\n             WHERE status = 'normal'\n               AND source_url IS NOT NULL\n               AND (source_url LIKE 'https://x.com/%' OR source_url LIKE 'https://twitter.com/%')\n             ORDER BY source_url ASC",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut urls = Vec::new();
        for row in rows {
            urls.push(row?);
        }
        Ok(urls)
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
        let mut statement = connection.prepare(match query.sort {
            AssetSort::Newest => CHRONO_DESC_HALF_SQL,
            AssetSort::Oldest => CHRONO_ASC_HALF_SQL,
            AssetSort::Favorites => FAVORITES_SQL,
            AssetSort::Random => RANDOM_SQL,
        })?;
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
            encode_cursor(query.sort, asset, random_pivot)
        });
        Ok(AssetPage {
            items: items.into_iter().map(|asset| asset.summary).collect(),
            next_cursor,
            previous_cursor: None,
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
            AssetSort::Oldest => (CHRONO_DESC_HALF_SQL, CHRONO_ASC_HALF_SQL),
            _ => (CHRONO_ASC_HALF_SQL, CHRONO_DESC_HALF_SQL),
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
                query.sort,
                &chrono_row(items.first().expect("more-up implies a first item")),
                "",
            )
        });
        let next_cursor = (has_more_down && !tail.is_empty())
            .then(|| encode_cursor(query.sort, &tail.last().expect("tail keeps its last item"), ""));
        Ok(AssetPage {
            items,
            next_cursor,
            previous_cursor,
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
            AssetSort::Oldest => CHRONO_DESC_HALF_SQL,
            _ => CHRONO_ASC_HALF_SQL,
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
                query.sort,
                &chrono_row(items.first().expect("more-up implies a first item")),
                "",
            )
        });
        Ok(AssetPage {
            items,
            next_cursor: None,
            previous_cursor,
        })
    }

    pub fn list_asset_date_buckets(&self, query: AssetQuery) -> Result<Vec<AssetDateBucket>, LibraryError> {
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
        let media_kind = media_filter_value(query.media_kind);
        let aspect_ratio = aspect_filter_value(query.aspect_ratio);
        let mut statement = connection.prepare(DATE_BUCKETS_SQL)?;
        let mut rows = statement.query(params![
            query.classification_id.as_deref(),
            query.direct_only,
            query.favorite_only,
            query.unclassified_only,
            query.album_id.as_deref(),
            query.collection_id.as_deref(),
            media_kind,
            aspect_ratio,
            query.creator_key.as_deref(),
        ])?;
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
                cover_asset_ids: [
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, Option<String>>(12)?,
                    row.get::<_, Option<String>>(13)?,
                ]
                    .into_iter()
                    .flatten()
                    .collect(),
            });
        }
        Ok(creators)
    }
}

fn decode_cursor(query: &AssetQuery) -> Result<Option<CursorPayload>, LibraryError> {
    let Some(cursor) = query.after.as_ref() else {
        return Ok(None);
    };
    let payload = serde_json::from_str::<CursorPayload>(&cursor.token)
        .map_err(|_| LibraryError::InvalidAssetCursor)?;
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
    let payload = serde_json::from_str::<CursorPayload>(&cursor.token)
        .map_err(|_| LibraryError::InvalidAssetCursor)?;
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
    let mut statement = connection.prepare(sql)?;
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
    ])?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        items.push(asset_row(row, false)?);
    }
    Ok(items)
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

fn preparation_state(value: &str) -> rusqlite::Result<VideoPreparationState> {
    match value {
        "pending" => Ok(VideoPreparationState::Pending),
        "processing" => Ok(VideoPreparationState::Processing),
        "ready" => Ok(VideoPreparationState::Ready),
        "failed" => Ok(VideoPreparationState::Failed),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn encode_cursor(sort: AssetSort, asset: &AssetRow, random_pivot: &str) -> AssetCursor {
    let payload = match sort {
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
            pivot: random_pivot.into(),
            bucket: asset.random_bucket.expect("random rows include a bucket"),
            content_hash: asset
                .content_hash
                .clone()
                .expect("random rows include a content hash"),
            id: asset.summary.id.clone(),
        },
    };
    AssetCursor {
        token: serde_json::to_string(&payload).expect("cursor payload serializes"),
    }
}

const FAVORITES_SQL: &str = "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) , album_descendants(id) AS (
    SELECT ?5 WHERE ?5 IS NOT NULL
    UNION ALL SELECT child.id FROM albums AS child JOIN album_descendants ON child.parent_id = album_descendants.id
) SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, asset.favorite, asset.source_url,
asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count,
asset.source_published_at, asset.creator_name, asset.creator_handle, asset.creator_url,
asset.import_source, asset.import_batch_id, asset.original_modified_at
FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id
WHERE asset.status = 'normal' AND (?3 = 0 OR asset.favorite = 1)
AND (?13 IS NULL OR COALESCE(asset.creator_handle, asset.creator_url) = ?13)
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?5 IS NULL OR EXISTS (SELECT 1 FROM asset_albums AS album_link WHERE album_link.asset_id = asset.id AND album_link.album_id IN (SELECT id FROM album_descendants)))
AND (?10 IS NULL OR EXISTS (SELECT 1 FROM collection_assets AS collection_link WHERE collection_link.asset_id = asset.id AND collection_link.collection_id = ?10))
AND (?6 IS NULL OR asset.favorite < ?6 OR (asset.favorite = ?6 AND (asset.collected_at < ?7 OR (asset.collected_at = ?7 AND asset.id < ?8))))
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
ORDER BY asset.favorite DESC, asset.collected_at DESC, asset.id DESC LIMIT ?9";

const RANDOM_SQL: &str = "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) , album_descendants(id) AS (
    SELECT ?5 WHERE ?5 IS NOT NULL
    UNION ALL SELECT child.id FROM albums AS child JOIN album_descendants ON child.parent_id = album_descendants.id
) SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, asset.favorite, asset.source_url,
asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count,
asset.source_published_at, asset.creator_name, asset.creator_handle, asset.creator_url,
asset.import_source, asset.import_batch_id, asset.original_modified_at,
asset.content_hash, CASE WHEN asset.content_hash >= ?6 THEN 0 ELSE 1 END
FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id
WHERE asset.status = 'normal' AND (?3 = 0 OR asset.favorite = 1)
AND (?14 IS NULL OR COALESCE(asset.creator_handle, asset.creator_url) = ?14)
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?5 IS NULL OR EXISTS (SELECT 1 FROM asset_albums AS album_link WHERE album_link.asset_id = asset.id AND album_link.album_id IN (SELECT id FROM album_descendants)))
AND (?11 IS NULL OR EXISTS (SELECT 1 FROM collection_assets AS collection_link WHERE collection_link.asset_id = asset.id AND collection_link.collection_id = ?11))
AND (?7 IS NULL OR CASE WHEN asset.content_hash >= ?6 THEN 0 ELSE 1 END > ?7 OR (CASE WHEN asset.content_hash >= ?6 THEN 0 ELSE 1 END = ?7 AND (asset.content_hash > ?8 OR (asset.content_hash = ?8 AND asset.id > ?9))))
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
ORDER BY CASE WHEN asset.content_hash >= ?6 THEN 0 ELSE 1 END ASC, asset.content_hash ASC, asset.id ASC LIMIT ?10";

const CREATORS_SQL: &str = "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) , album_descendants(id) AS (
    SELECT ?5 WHERE ?5 IS NOT NULL
    UNION ALL SELECT child.id FROM albums AS child JOIN album_descendants ON child.parent_id = album_descendants.id
), scoped AS MATERIALIZED (
    SELECT asset.id, asset.creator_name, asset.creator_handle, asset.creator_url, asset.collected_at
    FROM assets AS asset
    WHERE asset.status = 'normal' AND (?3 = 0 OR asset.favorite = 1)
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
           ROW_NUMBER() OVER (PARTITION BY COALESCE(creator_handle, creator_url) ORDER BY collected_at DESC) AS rn
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
)
SELECT g.key, g.creator_name, g.creator_handle, g.creator_url, g.asset_count, g.last_collected_at,
       covers.cover_0, covers.cover_1, covers.cover_2, covers.cover_3, covers.cover_4, covers.cover_5, covers.cover_6, covers.cover_7
FROM grouped AS g LEFT JOIN covers ON covers.key = g.key
ORDER BY g.asset_count DESC, g.key ASC";
const DATE_BUCKETS_SQL: &str = "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) , album_descendants(id) AS (
    SELECT ?5 WHERE ?5 IS NOT NULL
    UNION ALL SELECT child.id FROM albums AS child JOIN album_descendants ON child.parent_id = album_descendants.id
) SELECT substr(asset.collected_at, 1, 10) AS date, COUNT(*) AS count
FROM assets AS asset
WHERE asset.status = 'normal' AND (?3 = 0 OR asset.favorite = 1)
AND (?9 IS NULL OR COALESCE(asset.creator_handle, asset.creator_url) = ?9)
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?5 IS NULL OR EXISTS (SELECT 1 FROM asset_albums AS album_link WHERE album_link.asset_id = asset.id AND album_link.album_id IN (SELECT id FROM album_descendants)))
AND (?6 IS NULL OR EXISTS (SELECT 1 FROM collection_assets AS collection_link WHERE collection_link.asset_id = asset.id AND collection_link.collection_id = ?6))
AND (
  (?7 IS NULL)
  OR (?7 = 'images' AND asset.media_kind IN ('image', 'gif'))
  OR (?7 = 'videos' AND asset.media_kind = 'video')
)
AND (
  (?8 IS NULL)
  OR (?8 = 'square' AND asset.width * 5 >= asset.height * 4 AND asset.width * 4 <= asset.height * 5)
  OR (?8 = 'landscape' AND asset.width * 4 > asset.height * 5)
  OR (?8 = 'portrait' AND asset.width * 5 < asset.height * 4)
)
GROUP BY date ORDER BY date DESC";

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use crate::library::{
        error::LibraryError,
        models::{
            AssetAlbumPatch, AssetClassificationPatch, AssetCollectionPatch, AssetCursor, AssetPage,
            AspectRatioFilter, AssetQuery, AssetSort, ClassificationKind, CollectionType,
            CreateAlbum, CreateClassification, CreateCollection, ImportSource, MediaKindFilter,
            MediaSummary, VideoPreparationState,
        },
        Library,
    };

    #[test]
    fn list_assets_returns_tagged_image_gif_and_video_summaries() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let connection = library.connection().unwrap();
        for (id, hash, media_kind, thumbnail, collected_at) in [
            (
                "image-1",
                "hash-image",
                "image",
                Some("thumbnails/image.webp"),
                "2026-08-09T00:00:00Z",
            ),
            (
                "gif-1",
                "hash-gif",
                "gif",
                Some("thumbnails/gif.webp"),
                "2026-08-09T00:00:01Z",
            ),
            (
                "video-1",
                "hash-video",
                "video",
                None,
                "2026-08-09T00:00:02Z",
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO assets (
                        id, content_hash, media_kind, original_name, relative_path,
                        thumbnail_relative_path, byte_size, width, height, collected_at
                     ) VALUES (?1, ?2, ?3, ?1, ?4, ?5, 1, 1920, 1080, ?6)",
                    params![
                        id,
                        hash,
                        media_kind,
                        format!("assets/{id}"),
                        thumbnail,
                        collected_at
                    ],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO video_assets (
                    asset_id, duration_ms, container, video_codec, audio_codec,
                    preparation_state, scrub_frame_count
                 ) VALUES ('video-1', 12345, 'webm', 'vp9', 'opus', 'pending', 0)",
                [],
            )
            .unwrap();
        drop(connection);

        let page = library
            .list_assets(AssetQuery {
                classification_id: None,
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(
            page.items[0].media,
            MediaSummary::Video {
                duration_ms: 12_345,
                preparation_state: VideoPreparationState::Pending,
                scrub_frame_count: 0,
            }
        );
        assert_eq!(page.items[1].media, MediaSummary::Gif);
        assert_eq!(page.items[2].media, MediaSummary::Image);
    }

    #[test]
    fn media_and_aspect_filters_apply_before_pagination() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_filter_asset(&library, "image-square", "image", 1000, 1000, "2026-08-08T00:00:00Z");
        insert_filter_asset(&library, "gif-portrait", "gif", 600, 1000, "2026-08-07T00:00:00Z");
        insert_filter_asset(&library, "video-landscape", "video", 1600, 900, "2026-08-06T00:00:00Z");
        insert_filter_asset(&library, "ratio-4x5", "image", 800, 1000, "2026-08-05T00:00:00Z");
        insert_filter_asset(&library, "ratio-1x1", "gif", 1000, 1000, "2026-08-04T00:00:00Z");
        insert_filter_asset(&library, "ratio-5x4", "image", 1250, 1000, "2026-08-03T00:00:00Z");
        insert_filter_asset(&library, "ratio-wide", "image", 1251, 1000, "2026-08-02T00:00:00Z");
        insert_filter_asset(&library, "ratio-tall", "image", 799, 1000, "2026-08-01T00:00:00Z");

        let list = |media_kind, aspect_ratio, limit, after| {
            library
                .list_assets(AssetQuery {
                    media_kind,
                    aspect_ratio,
                    limit,
                    after,
                    sort: AssetSort::Newest,
                    ..Default::default()
                })
                .unwrap()
        };
        let sorted_ids = |page: AssetPage| {
            let mut ids: Vec<_> = page.items.into_iter().map(|asset| asset.id).collect();
            ids.sort();
            ids
        };

        assert_eq!(
            sorted_ids(list(Some(MediaKindFilter::Images), None, 20, None)),
            vec!["gif-portrait", "image-square", "ratio-1x1", "ratio-4x5", "ratio-5x4", "ratio-tall", "ratio-wide"],
        );
        assert_eq!(
            sorted_ids(list(Some(MediaKindFilter::Videos), None, 20, None)),
            vec!["video-landscape"],
        );
        assert_eq!(
            sorted_ids(list(None, Some(AspectRatioFilter::Square), 20, None)),
            vec!["image-square", "ratio-1x1", "ratio-4x5", "ratio-5x4"],
        );
        assert_eq!(
            sorted_ids(list(None, Some(AspectRatioFilter::Landscape), 20, None)),
            vec!["ratio-wide", "video-landscape"],
        );
        assert_eq!(
            sorted_ids(list(None, Some(AspectRatioFilter::Portrait), 20, None)),
            vec!["gif-portrait", "ratio-tall"],
        );

        let first = list(
            Some(MediaKindFilter::Images),
            Some(AspectRatioFilter::Portrait),
            1,
            None,
        );
        assert_eq!(first.items[0].id, "gif-portrait");
        let second = list(
            Some(MediaKindFilter::Images),
            Some(AspectRatioFilter::Portrait),
            1,
            first.next_cursor,
        );
        assert_eq!(second.items[0].id, "ratio-tall");

        let buckets = library
            .list_asset_date_buckets(AssetQuery {
                media_kind: Some(MediaKindFilter::Images),
                aspect_ratio: Some(AspectRatioFilter::Portrait),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(buckets.iter().map(|bucket| bucket.count).sum::<u64>(), 2);
    }

    #[test]
    fn asset_source_provenance_round_trips_through_queries() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at,
                    source_published_at, creator_name, creator_handle, creator_url,
                    import_source, import_batch_id, original_modified_at
                 ) VALUES (
                    'asset-1', 'hash-1', 'image', 'one.png', 'assets/one.png',
                    'thumbnails/one.webp', 1, 1, 1, '2026-08-12T00:00:00Z',
                    '2026-08-01T10:20:30Z', 'Example Artist', 'example',
                    'https://x.com/example', 'metadata_import',
                    '31d1f90c-214b-41e2-9d84-f9d964bb5bc3', '2026-07-31T09:00:00Z'
                 )",
                [],
            )
            .unwrap();
        drop(connection);

        let asset = library.get_asset("asset-1").unwrap();
        assert_eq!(
            asset.source_published_at.as_deref(),
            Some("2026-08-01T10:20:30Z")
        );
        assert_eq!(asset.creator_name.as_deref(), Some("Example Artist"));
        assert_eq!(asset.creator_handle.as_deref(), Some("example"));
        assert_eq!(asset.creator_url.as_deref(), Some("https://x.com/example"));
        assert_eq!(asset.import_source, Some(ImportSource::MetadataImport));
        assert_eq!(
            asset.import_batch_id.as_deref(),
            Some("31d1f90c-214b-41e2-9d84-f9d964bb5bc3")
        );
        assert_eq!(
            asset.original_modified_at.as_deref(),
            Some("2026-07-31T09:00:00Z")
        );
    }

    #[test]
    fn descendant_assets_are_included_unless_direct_only_is_requested() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = classification(&library, ClassificationKind::Root, "게임", None);
        let work = classification(
            &library,
            ClassificationKind::Work,
            "블루 아카이브",
            Some(root.id.clone()),
        );
        let tag = classification(&library, ClassificationKind::Tag, "아로나", Some(work.id));
        insert_asset(&library, "asset-1", "2026-07-30T00:00:00Z");
        library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-1".into()],
                add_classification_ids: vec![tag.id],
                remove_classification_ids: vec![],
            })
            .unwrap();

        let descendants = library
            .list_assets(AssetQuery {
                classification_id: Some(root.id.clone()),
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
                ..Default::default()
            })
            .unwrap();
        let direct = library
            .list_assets(AssetQuery {
                classification_id: Some(root.id),
                album_id: None,
                collection_id: None,
                direct_only: true,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(
            descendants
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["asset-1"]
        );
        assert!(direct.items.is_empty());
    }

    #[test]
    fn descendant_links_do_not_duplicate_an_asset() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = classification(&library, ClassificationKind::Root, "게임", None);
        let work = classification(
            &library,
            ClassificationKind::Work,
            "블루 아카이브",
            Some(root.id.clone()),
        );
        let tag = classification(
            &library,
            ClassificationKind::Tag,
            "아로나",
            Some(work.id.clone()),
        );
        insert_asset(&library, "asset-1", "2026-07-30T00:00:00Z");
        library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-1".into()],
                add_classification_ids: vec![work.id, tag.id],
                remove_classification_ids: vec![],
            })
            .unwrap();

        let page = library
            .list_assets(AssetQuery {
                classification_id: Some(root.id),
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "asset-1");
    }

    #[test]
    fn parent_album_query_includes_descendants_once_and_hides_trash() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();
        let first_child = library
            .create_album(CreateAlbum {
                name: "게임".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();
        let second_child = library
            .create_album(CreateAlbum {
                name: "만화".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();
        insert_asset(&library, "asset-1", "2026-08-12T00:00:00Z");
        library
            .patch_asset_albums(AssetAlbumPatch {
                asset_ids: vec!["asset-1".into()],
                add_album_ids: vec![first_child.id, second_child.id],
                remove_album_ids: Vec::new(),
            })
            .unwrap();
        let query = AssetQuery {
            classification_id: None,
            album_id: Some(root.id),
            collection_id: None,
            direct_only: false,
            favorite_only: false,
            unclassified_only: false,
            sort: AssetSort::Newest,
            random_pivot: None,
            after: None,
            limit: 20,
            ..Default::default()
        };

        assert_eq!(library.list_assets(query.clone()).unwrap().items.len(), 1);
        library.trash_assets(&["asset-1".into()]).unwrap();
        assert!(library.list_assets(query.clone()).unwrap().items.is_empty());
        library.restore_asset("asset-1").unwrap();
        assert_eq!(library.list_assets(query).unwrap().items.len(), 1);
    }

    #[test]
    fn collection_query_returns_only_normal_members_and_restores_membership() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Reference".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        insert_asset(&library, "member", "2026-08-12T00:00:00Z");
        insert_asset(&library, "other", "2026-08-11T00:00:00Z");
        library
            .patch_asset_collections(AssetCollectionPatch {
                asset_ids: vec!["member".into()],
                add_collection_ids: vec![collection.id.clone()],
                remove_collection_ids: Vec::new(),
            })
            .unwrap();
        let query = AssetQuery {
            classification_id: None,
            album_id: None,
            collection_id: Some(collection.id),
            direct_only: false,
            favorite_only: false,
            unclassified_only: false,
            sort: AssetSort::Newest,
            random_pivot: None,
            after: None,
            limit: 20,
            ..Default::default()
        };

        assert_eq!(
            library
                .list_assets(query.clone())
                .unwrap()
                .items
                .into_iter()
                .map(|asset| asset.id)
                .collect::<Vec<_>>(),
            vec!["member"]
        );
        library.trash_assets(&["member".into()]).unwrap();
        assert!(library.list_assets(query.clone()).unwrap().items.is_empty());
        assert_eq!(
            library
                .get_collection(query.collection_id.as_deref().unwrap())
                .unwrap()
                .asset_count,
            0
        );
        library.restore_asset("member").unwrap();
        assert_eq!(library.list_assets(query).unwrap().items.len(), 1);
    }

    #[test]
    fn rejects_collection_combined_with_another_location_scope() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Reference".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        let album = library
            .create_album(CreateAlbum {
                name: "Covers".into(),
                parent_id: None,
            })
            .unwrap();

        let error = library
            .list_assets(AssetQuery {
                classification_id: None,
                album_id: Some(album.id),
                collection_id: Some(collection.id),
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
                ..Default::default()
            })
            .unwrap_err();

        assert!(matches!(error, LibraryError::InvalidAssetScope));
    }

    #[test]
    fn rejects_simultaneous_folder_and_album_scopes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let folder = classification(&library, ClassificationKind::Root, "게임", None);
        let album = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();

        let error = library
            .list_assets(AssetQuery {
                classification_id: Some(folder.id),
                album_id: Some(album.id),
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
                ..Default::default()
            })
            .unwrap_err();

        assert!(matches!(error, LibraryError::InvalidAssetScope));
    }

    #[test]
    fn unclassified_query_returns_only_assets_without_classification_links() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = classification(&library, ClassificationKind::Root, "게임", None);
        insert_asset(&library, "unclassified", "2026-07-31T00:00:00Z");
        insert_asset(&library, "unclassified-older", "2026-07-29T00:00:00Z");
        insert_asset(&library, "classified", "2026-07-30T00:00:00Z");
        library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["classified".into()],
                add_classification_ids: vec![root.id],
                remove_classification_ids: vec![],
            })
            .unwrap();

        let first = library
            .list_assets(AssetQuery {
                classification_id: None,
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: true,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 1,
                ..Default::default()
            })
            .unwrap();
        let second = library
            .list_assets(AssetQuery {
                classification_id: None,
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: true,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: first.next_cursor.clone(),
                limit: 1,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(
            first
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["unclassified"]
        );
        assert_eq!(
            second
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["unclassified-older"]
        );
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn keyset_pages_follow_collected_at_and_id_without_overlap() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "asset-a", "2026-07-30T00:00:00Z");
        insert_asset(&library, "asset-b", "2026-07-31T00:00:00Z");
        insert_asset(&library, "asset-c", "2026-07-30T00:00:00Z");

        let first = library
            .list_assets(AssetQuery {
                classification_id: None,
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 2,
                ..Default::default()
            })
            .unwrap();
        let second = library
            .list_assets(AssetQuery {
                classification_id: None,
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: first.next_cursor.clone(),
                limit: 2,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(
            first
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["asset-b", "asset-c"]
        );
        assert_eq!(
            second
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["asset-a"]
        );
        assert!(second.next_cursor.is_none());
    }

    fn chrono_query(sort: AssetSort) -> AssetQuery {
        AssetQuery {
            classification_id: None,
            album_id: None,
            collection_id: None,
            direct_only: false,
            favorite_only: false,
            unclassified_only: false,
            sort,
            random_pivot: None,
            after: None,
            limit: 100,
            ..Default::default()
        }
    }

    fn ids(page: &AssetPage) -> Vec<&str> {
        page.items.iter().map(|asset| asset.id.as_str()).collect()
    }

    #[test]
    fn anchor_query_loads_assets_on_both_sides_of_the_target_date() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "n1", "2026-08-01T09:00:00Z");
        insert_asset(&library, "o1", "2026-07-31T13:00:00Z");
        insert_asset(&library, "o2", "2026-07-31T12:00:00Z");
        insert_asset(&library, "o3", "2026-07-31T11:00:00Z");
        insert_asset(&library, "p1", "2026-07-30T15:00:00Z");
        insert_asset(&library, "p2", "2026-07-30T10:00:00Z");
        insert_asset(&library, "q1", "2026-07-29T08:00:00Z");

        let mut query = chrono_query(AssetSort::Newest);
        query.limit = 6;
        query.around_date = Some("2026-07-31".into());
        let window = library.list_assets(query.clone()).unwrap();

        // Half window is 3: head keeps [n1] (fewer newer assets exist), tail
        // starts at the boundary with the three newest 07-31 assets.
        assert_eq!(ids(&window), ["n1", "o1", "o2", "o3"]);
        assert!(window.previous_cursor.is_none());
        assert!(window.next_cursor.is_some());
    }

    #[test]
    fn anchor_window_paginates_in_both_directions_without_gaps_or_overlap() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for day in 26..=31 {
            for slot in 0..4i32 {
                insert_asset(
                    &library,
                    &format!("a{day}-{slot}"),
                    &format!("2026-07-{day:02}T{slot:02}:00:00Z"),
                );
            }
        }
        // 24 assets from 07-26 to 07-31. Display order (newest first) is the
        // exact reverse of insertion order.

        let mut query = chrono_query(AssetSort::Newest);
        query.limit = 8;
        query.around_date = Some("2026-07-29".into());
        let anchor = library.list_assets(query.clone()).unwrap();
        assert_eq!(anchor.items.len(), 8);
        assert!(anchor.previous_cursor.is_some());
        assert!(anchor.next_cursor.is_some());

        // Walk upward to the very top.
        let mut upward = Vec::new();
        let mut cursor = anchor.previous_cursor.clone();
        while let Some(token) = cursor {
            query.after = None;
            query.before = Some(token);
            query.around_date = None;
            let page = library.list_assets(query.clone()).unwrap();
            let reached_top = page.previous_cursor.is_none();
            upward.extend(page.items.iter().map(|asset| asset.id.clone()));
            cursor = page.previous_cursor;
            if reached_top {
                break;
            }
        }

        // Walk downward to the very bottom.
        let mut downward = Vec::new();
        let mut cursor = anchor.next_cursor.clone();
        while let Some(token) = cursor {
            query.before = None;
            query.after = Some(token);
            let page = library.list_assets(query.clone()).unwrap();
            downward.extend(page.items.iter().map(|asset| asset.id.clone()));
            cursor = page.next_cursor;
        }

        let expected: Vec<String> = library
            .list_assets(chrono_query(AssetSort::Newest))
            .unwrap()
            .items
            .into_iter()
            .map(|asset| asset.id)
            .collect();
        let mut combined = upward;
        combined.extend(anchor.items.iter().map(|asset| asset.id.clone()));
        combined.extend(downward);
        assert_eq!(combined, expected);
    }

    #[test]
    fn anchor_window_works_for_oldest_sort_and_keeps_display_order() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "old", "2026-07-28T09:00:00Z");
        insert_asset(&library, "d1", "2026-07-29T10:00:00Z");
        insert_asset(&library, "d2", "2026-07-29T11:00:00Z");
        insert_asset(&library, "d3", "2026-07-29T12:00:00Z");
        insert_asset(&library, "new1", "2026-07-30T09:00:00Z");
        insert_asset(&library, "new2", "2026-07-30T10:00:00Z");

        let mut query = chrono_query(AssetSort::Oldest);
        query.limit = 6;
        query.around_date = Some("2026-07-30".into());
        let window = library.list_assets(query.clone()).unwrap();

        // Oldest display order is ascending; the boundary sits at day start,
        // so the head keeps the three newest pre-day assets and the tail the
        // two assets of 07-30.
        assert_eq!(ids(&window), ["d1", "d2", "d3", "new1", "new2"]);
        assert!(window.previous_cursor.is_some());
        assert!(window.next_cursor.is_none());

        query.before = window.previous_cursor.clone();
        query.around_date = None;
        let head = library.list_assets(query).unwrap();
        assert_eq!(ids(&head), ["old"]);
        assert!(head.previous_cursor.is_none());
    }

    #[test]
    fn identical_timestamps_keep_stable_order_across_anchor_pages() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "u1", "2026-07-31T11:00:00Z");
        insert_asset(&library, "u2", "2026-07-31T12:00:00Z");
        insert_asset(&library, "u3", "2026-07-31T13:00:00Z");
        insert_asset(&library, "top", "2026-07-31T09:00:00Z");
        insert_asset(&library, "t1", "2026-07-30T00:00:00Z");
        insert_asset(&library, "t2", "2026-07-30T00:00:00Z");
        insert_asset(&library, "t3", "2026-07-30T00:00:00Z");
        insert_asset(&library, "bottom", "2026-07-29T09:00:00Z");

        let mut query = chrono_query(AssetSort::Newest);
        query.limit = 4;
        query.around_date = Some("2026-07-30".into());
        let window = library.list_assets(query.clone()).unwrap();

        // Newest-first display: u3,u2,u1,top | t3,t2,t1,bottom. The window
        // keeps the two assets adjacent above the 07-31/07-30 boundary and
        // the first two below it, with cursors for both directions.
        assert_eq!(ids(&window), ["u1", "top", "t3", "t2"]);
        assert!(window.previous_cursor.is_some());
        assert!(window.next_cursor.is_some());

        query.before = window.previous_cursor.clone();
        query.around_date = None;
        let head = library.list_assets(query.clone()).unwrap();
        assert_eq!(ids(&head), ["u3", "u2"]);
        assert!(head.previous_cursor.is_none());

        query.after = window.next_cursor;
        query.before = None;
        let tail = library.list_assets(query).unwrap();
        assert_eq!(ids(&tail), ["t1", "bottom"]);
        assert!(tail.next_cursor.is_none());

        // Oldest sort mirrors the behavior with the boundary at day start.
        let mut query = chrono_query(AssetSort::Oldest);
        query.limit = 4;
        query.around_date = Some("2026-07-31".into());
        let oldest_window = library.list_assets(query.clone()).unwrap();
        // Head keeps the two assets adjacent below 07-31 (reversed), tail the
        // two oldest 07-31 assets.
        assert_eq!(ids(&oldest_window), ["t2", "t3", "top", "u1"]);
        assert!(oldest_window.previous_cursor.is_some());
        assert!(oldest_window.next_cursor.is_some());
        query.before = oldest_window.previous_cursor;
        query.around_date = None;
        let oldest_head = library.list_assets(query).unwrap();
        assert_eq!(ids(&oldest_head), ["bottom", "t1"]);
    }

    #[test]
    fn scope_filters_apply_to_anchor_and_before_pagination() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = classification(&library, ClassificationKind::Root, "게임", None);
        let work = classification(
            &library,
            ClassificationKind::Work,
            "블루 아카이브",
            Some(root.id.clone()),
        );
        let timestamps = [
            ("in-top", "2026-08-01T11:00:00Z"),
            ("in-newest", "2026-08-01T10:00:00Z"),
            ("in-newer", "2026-08-01T09:00:00Z"),
            ("in-day", "2026-07-30T00:00:00Z"),
            ("in-older", "2026-07-29T00:00:00Z"),
            ("out-day", "2026-07-30T12:00:00Z"),
        ];
        for (id, collected_at) in timestamps {
            insert_asset(&library, id, collected_at);
        }
        library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec![
                    "in-top".into(),
                    "in-newest".into(),
                    "in-newer".into(),
                    "in-day".into(),
                    "in-older".into(),
                ],
                add_classification_ids: vec![work.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();

        let mut query = chrono_query(AssetSort::Newest);
        query.limit = 4;
        query.classification_id = Some(work.id.clone());
        query.around_date = Some("2026-07-30".into());
        // Half window is 2 and the untagged asset stays out of both halves.
        let window = library.list_assets(query.clone()).unwrap();
        assert_eq!(ids(&window), ["in-newest", "in-newer", "in-day", "in-older"]);
        assert!(window.previous_cursor.is_some());
        assert!(window.next_cursor.is_none());

        query.before = window.previous_cursor;
        query.around_date = None;
        let head = library.list_assets(query).unwrap();
        assert_eq!(ids(&head), ["in-top"]);
    }

    #[test]
    fn anchor_rejects_invalid_dates_and_non_chronological_sorts() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let mut query = chrono_query(AssetSort::Newest);
        query.around_date = Some("not-a-date".into());
        assert!(matches!(
            library.list_assets(query.clone()),
            Err(LibraryError::InvalidAssetCursor)
        ));

        query.sort = AssetSort::Favorites;
        query.around_date = Some("2026-07-30".into());
        assert!(matches!(
            library.list_assets(query.clone()),
            Err(LibraryError::InvalidAssetCursor)
        ));

        query.sort = AssetSort::Random;
        query.random_pivot = Some(hash('a'));
        assert!(matches!(
            library.list_assets(query),
            Err(LibraryError::InvalidAssetCursor)
        ));
    }

    #[test]
    fn page_limit_must_be_between_one_and_two_hundred() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        for limit in [0, 201] {
            let error = library
                .list_assets(AssetQuery {
                    classification_id: None,
                    album_id: None,
                    collection_id: None,
                    direct_only: false,
                    favorite_only: false,
                    unclassified_only: false,
                    sort: AssetSort::Newest,
                    random_pivot: None,
                    after: None,
                    limit,
                    ..Default::default()
                })
                .unwrap_err();

            assert!(matches!(error, LibraryError::InvalidAssetPageLimit));
        }
    }

    #[test]
    fn querying_a_missing_classification_returns_the_established_error() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        for direct_only in [false, true] {
            let error = library
                .list_assets(AssetQuery {
                    classification_id: Some("missing-classification".into()),
                    album_id: None,
                    collection_id: None,
                    direct_only,
                    favorite_only: false,
                    unclassified_only: false,
                    sort: AssetSort::Newest,
                    random_pivot: None,
                    after: None,
                    limit: 20,
                    ..Default::default()
                })
                .unwrap_err();

            assert!(matches!(error, LibraryError::ClassificationNotFound));
        }
    }

    #[test]
    fn stable_sorts_page_without_overlap() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset_with_fields(&library, "a", &hash('1'), "2026-07-30T00:00:00Z", false);
        insert_asset_with_fields(&library, "b", &hash('4'), "2026-07-30T00:00:00Z", true);
        insert_asset_with_fields(&library, "c", &hash('8'), "2026-07-31T00:00:00Z", false);
        insert_asset_with_fields(&library, "d", &hash('c'), "2026-07-31T00:00:00Z", true);

        assert_eq!(
            two_pages(&library, AssetSort::Newest, None),
            ["d", "c", "b", "a"]
        );
        assert_eq!(
            two_pages(&library, AssetSort::Oldest, None),
            ["a", "b", "c", "d"]
        );
        assert_eq!(
            two_pages(&library, AssetSort::Favorites, None),
            ["d", "b", "c", "a"]
        );
    }

    #[test]
    fn random_sort_uses_a_stable_pivot_and_validates_cursors() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for (id, hex) in [("a", '1'), ("b", '4'), ("c", '8'), ("d", 'c')] {
            insert_asset_with_fields(&library, id, &hash(hex), "2026-07-30T00:00:00Z", false);
        }

        let first = two_pages(&library, AssetSort::Random, Some("8"));
        let second = two_pages(&library, AssetSort::Random, Some("8"));
        assert_eq!(
            first, second,
            "the same pivot must return the same complete order"
        );
        assert_eq!(first.len(), 4);
        for id in ["a", "b", "c", "d"] {
            assert_eq!(first.iter().filter(|current| current == &id).count(), 1);
        }

        let malformed = library
            .list_assets(AssetQuery {
                after: Some(AssetCursor {
                    token: "not-json".into(),
                }),
                ..query(AssetSort::Newest, None)
            })
            .unwrap_err();
        assert!(matches!(malformed, LibraryError::InvalidAssetCursor));

        let newest = library.list_assets(query(AssetSort::Newest, None)).unwrap();
        let wrong_sort = library
            .list_assets(AssetQuery {
                after: newest.next_cursor,
                ..query(AssetSort::Oldest, None)
            })
            .unwrap_err();
        assert!(matches!(wrong_sort, LibraryError::InvalidAssetCursor));
    }

    fn two_pages(library: &Library, sort: AssetSort, random_pivot: Option<&str>) -> Vec<String> {
        let first = library.list_assets(query(sort, random_pivot)).unwrap();
        let second = library
            .list_assets(AssetQuery {
                after: first.next_cursor.clone(),
                ..query(sort, random_pivot)
            })
            .unwrap();
        first
            .items
            .into_iter()
            .chain(second.items)
            .map(|asset| asset.id)
            .collect()
    }

    fn query(sort: AssetSort, random_pivot: Option<&str>) -> AssetQuery {
        AssetQuery {
            classification_id: None,
            album_id: None,
            collection_id: None,
            direct_only: false,
            favorite_only: false,
            unclassified_only: false,
            sort,
            random_pivot: random_pivot.map(str::to_owned),
            after: None,
            limit: 2,
            ..Default::default()
        }
    }

    fn hash(hex: char) -> String {
        std::iter::repeat_n(hex, 64).collect()
    }

    fn classification(
        library: &Library,
        kind: ClassificationKind,
        name: &str,
        parent_id: Option<String>,
    ) -> crate::library::models::ClassificationEntry {
        library
            .create_classification(CreateClassification {
                kind,
                name: name.into(),
                parent_id,
            })
            .unwrap()
    }

    fn insert_asset(library: &Library, id: &str, collected_at: &str) {
        insert_asset_with_fields(library, id, &format!("hash-{id}"), collected_at, false);
    }

    fn insert_asset_with_fields(
        library: &Library,
        id: &str,
        content_hash: &str,
        collected_at: &str,
        favorite: bool,
    ) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at, favorite
                 ) VALUES (?1, ?2, 'image', ?3, ?4, ?5, 1, 400, 200, ?6, ?7)",
                params![
                    id,
                    content_hash,
                    format!("{id}.png"),
                    format!("assets/{id}.png"),
                    format!("thumbnails/{id}.webp"),
                    collected_at,
                    favorite,
                ],
            )
            .unwrap();
    }

    fn insert_filter_asset(
        library: &Library,
        id: &str,
        media_kind: &str,
        width: i64,
        height: i64,
        collected_at: &str,
    ) {
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at, favorite
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, 0)",
                params![
                    id,
                    format!("hash-{id}"),
                    media_kind,
                    format!("{id}.bin"),
                    format!("assets/{id}.bin"),
                    format!("thumbnails/{id}.webp"),
                    width,
                    height,
                    collected_at,
                ],
            )
            .unwrap();
        if media_kind == "video" {
            connection
                .execute(
                    "INSERT INTO video_assets (
                        asset_id, duration_ms, container, video_codec, audio_codec,
                        preparation_state, scrub_frame_count
                     ) VALUES (?1, 1000, 'mp4', 'h264', 'aac', 'pending', 0)",
                    [id],
                )
                .unwrap();
        }
    }
}
