use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{
    error::LibraryError,
    models::{
        AssetCursor, AssetPage, AssetQuery, AssetSort, AssetSummary, MediaSummary,
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

impl Library {
    pub fn list_assets(&self, query: AssetQuery) -> Result<AssetPage, LibraryError> {
        if !(1..=200).contains(&query.limit) {
            return Err(LibraryError::InvalidAssetPageLimit);
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
        let cursor = decode_cursor(&query)?;
        let random_pivot = query.random_pivot.as_deref().unwrap_or("");
        let mut statement = connection.prepare(match query.sort {
            AssetSort::Newest => NEWEST_SQL,
            AssetSort::Oldest => OLDEST_SQL,
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
                    collected_at,
                    id,
                    i64::from(query.limit) + 1,
                ])?
            }
            AssetSort::Oldest => {
                let (collected_at, id) = collected_at_and_id(&cursor);
                statement.query(params![
                    query.classification_id.as_deref(),
                    query.direct_only,
                    query.favorite_only,
                    query.unclassified_only,
                    collected_at,
                    id,
                    i64::from(query.limit) + 1,
                ])?
            }
            AssetSort::Favorites => {
                let (favorite, collected_at, id) = favorite_keys(&cursor);
                statement.query(params![
                    query.classification_id.as_deref(),
                    query.direct_only,
                    query.favorite_only,
                    query.unclassified_only,
                    favorite,
                    collected_at,
                    id,
                    i64::from(query.limit) + 1,
                ])?
            }
            AssetSort::Random => {
                let (bucket, content_hash, id) = random_keys(&cursor);
                statement.query(params![
                    query.classification_id.as_deref(),
                    query.direct_only,
                    query.favorite_only,
                    query.unclassified_only,
                    random_pivot,
                    bucket,
                    content_hash,
                    id,
                    i64::from(query.limit) + 1,
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
        })
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
        content_hash: random.then(|| row.get(15)).transpose()?,
        random_bucket: random.then(|| row.get(16)).transpose()?,
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

const NEWEST_SQL: &str = "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, asset.favorite, asset.source_url,
asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count
FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id
WHERE asset.status = 'normal' AND (?3 = 0 OR asset.favorite = 1)
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?5 IS NULL OR asset.collected_at < ?5 OR (asset.collected_at = ?5 AND asset.id < ?6))
ORDER BY asset.collected_at DESC, asset.id DESC LIMIT ?7";

const OLDEST_SQL: &str = "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, asset.favorite, asset.source_url,
asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count
FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id
WHERE asset.status = 'normal' AND (?3 = 0 OR asset.favorite = 1)
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?5 IS NULL OR asset.collected_at > ?5 OR (asset.collected_at = ?5 AND asset.id > ?6))
ORDER BY asset.collected_at ASC, asset.id ASC LIMIT ?7";

const FAVORITES_SQL: &str = "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, asset.favorite, asset.source_url,
asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count
FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id
WHERE asset.status = 'normal' AND (?3 = 0 OR asset.favorite = 1)
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?5 IS NULL OR asset.favorite < ?5 OR (asset.favorite = ?5 AND (asset.collected_at < ?6 OR (asset.collected_at = ?6 AND asset.id < ?7))))
ORDER BY asset.favorite DESC, asset.collected_at DESC, asset.id DESC LIMIT ?8";

const RANDOM_SQL: &str = "WITH RECURSIVE descendants(id) AS (
    SELECT ?1 WHERE ?1 IS NOT NULL
    UNION ALL SELECT entry.id FROM classification_entries AS entry JOIN descendants ON entry.parent_id = descendants.id
) SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, asset.favorite, asset.source_url,
asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count,
asset.content_hash, CASE WHEN asset.content_hash >= ?5 THEN 0 ELSE 1 END
FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id
WHERE asset.status = 'normal' AND (?3 = 0 OR asset.favorite = 1)
AND (?1 IS NULL OR EXISTS (SELECT 1 FROM asset_classifications AS link WHERE link.asset_id = asset.id AND ((?2 AND link.classification_id = ?1) OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants)))))
AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM asset_classifications AS unsorted_link WHERE unsorted_link.asset_id = asset.id))
AND (?6 IS NULL OR CASE WHEN asset.content_hash >= ?5 THEN 0 ELSE 1 END > ?6 OR (CASE WHEN asset.content_hash >= ?5 THEN 0 ELSE 1 END = ?6 AND (asset.content_hash > ?7 OR (asset.content_hash = ?7 AND asset.id > ?8))))
ORDER BY CASE WHEN asset.content_hash >= ?5 THEN 0 ELSE 1 END ASC, asset.content_hash ASC, asset.id ASC LIMIT ?9";

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use crate::library::{
        error::LibraryError,
        models::{
            AssetClassificationPatch, AssetCursor, AssetQuery, AssetSort, ClassificationKind,
            CreateClassification, MediaSummary, VideoPreparationState,
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
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
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
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
            })
            .unwrap();
        let direct = library
            .list_assets(AssetQuery {
                classification_id: Some(root.id),
                direct_only: true,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
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
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
            })
            .unwrap();

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "asset-1");
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
                direct_only: false,
                favorite_only: false,
                unclassified_only: true,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 1,
            })
            .unwrap();
        let second = library
            .list_assets(AssetQuery {
                classification_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: true,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: first.next_cursor.clone(),
                limit: 1,
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
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 2,
            })
            .unwrap();
        let second = library
            .list_assets(AssetQuery {
                classification_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: first.next_cursor.clone(),
                limit: 2,
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

    #[test]
    fn page_limit_must_be_between_one_and_two_hundred() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        for limit in [0, 201] {
            let error = library
                .list_assets(AssetQuery {
                    classification_id: None,
                    direct_only: false,
                    favorite_only: false,
                    unclassified_only: false,
                    sort: AssetSort::Newest,
                    random_pivot: None,
                    after: None,
                    limit,
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
                    direct_only,
                    favorite_only: false,
                    unclassified_only: false,
                    sort: AssetSort::Newest,
                    random_pivot: None,
                    after: None,
                    limit: 20,
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
            direct_only: false,
            favorite_only: false,
            unclassified_only: false,
            sort,
            random_pivot: random_pivot.map(str::to_owned),
            after: None,
            limit: 2,
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
}
