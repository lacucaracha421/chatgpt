use std::cmp::Ordering;

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use super::{
    av_models::{AvError, AvPortrait},
    error::LibraryError,
    models::thumbnail_revision,
    Library,
};

#[derive(Debug, thiserror::Error)]
pub(crate) enum HomeDataError {
    #[error("망가 읽기 위치가 올바르지 않습니다.")]
    InvalidMangaProgress,
    #[error("영상 재생 위치가 올바르지 않습니다.")]
    InvalidVideoProgress,
    #[error("대상을 찾을 수 없습니다.")]
    TargetNotFound,
    #[error("AV 배우를 찾을 수 없습니다.")]
    InvalidAvPerformer,
    #[error(transparent)]
    Library(#[from] LibraryError),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Av(#[from] AvError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MangaReadingProgress {
    pub series_id: String,
    pub last_page: u64,
    pub page_count: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPlaybackProgress {
    pub asset_id: String,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContinueItemKind {
    Manga,
    Online,
    Video,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueItem {
    pub kind: ContinueItemKind,
    pub id: String,
    pub provider: Option<String>,
    pub title: Option<String>,
    pub thumbnail_revision: Option<String>,
    pub position: u64,
    pub total: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvFavorite {
    pub id: String,
    pub display_name: String,
    pub original_name: Option<String>,
    pub portrait: Option<AvPortrait>,
    pub owned_work_count: i64,
    pub recent_owned_count: i64,
    pub created_at: String,
}

impl Library {
    pub(crate) fn save_manga_reading_progress(
        &self,
        series_id: &str,
        last_page: u64,
        page_count: u64,
    ) -> Result<(), HomeDataError> {
        if series_id.trim().is_empty()
            || last_page == 0
            || page_count == 0
            || last_page > page_count
            || last_page > i64::MAX as u64
            || page_count > i64::MAX as u64
        {
            return Err(HomeDataError::InvalidMangaProgress);
        }
        let connection = self.connection()?;
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM manga_series WHERE id=?1)",
            [series_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(HomeDataError::TargetNotFound);
        }
        connection.execute(
            "INSERT INTO manga_reading_progress(series_id,last_page,page_count,updated_at)
             VALUES(?1,?2,?3,?4)
             ON CONFLICT(series_id) DO UPDATE SET
               last_page=excluded.last_page,
               page_count=excluded.page_count,
               updated_at=excluded.updated_at",
            params![
                series_id,
                last_page as i64,
                page_count as i64,
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub(crate) fn get_manga_reading_progress(
        &self,
        series_id: &str,
    ) -> Result<Option<MangaReadingProgress>, HomeDataError> {
        Ok(self
            .connection()?
            .query_row(
                "SELECT series_id,last_page,page_count,updated_at
                 FROM manga_reading_progress WHERE series_id=?1",
                [series_id],
                manga_progress,
            )
            .optional()?)
    }

    pub(crate) fn clear_manga_reading_progress(
        &self,
        series_id: &str,
    ) -> Result<(), HomeDataError> {
        self.connection()?.execute(
            "DELETE FROM manga_reading_progress WHERE series_id=?1",
            [series_id],
        )?;
        Ok(())
    }

    pub(crate) fn save_video_playback_progress(
        &self,
        asset_id: &str,
        position_ms: u64,
        duration_ms: u64,
    ) -> Result<(), HomeDataError> {
        if asset_id.trim().is_empty()
            || duration_ms == 0
            || position_ms > i64::MAX as u64
            || duration_ms > i64::MAX as u64
        {
            return Err(HomeDataError::InvalidVideoProgress);
        }
        // Opening a video or a short seek near its start must not create or disturb resume state.
        if position_ms < 5_000 {
            return Ok(());
        }
        let connection = self.connection()?;
        let target_is_video: bool = connection.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM assets a JOIN video_assets v ON v.asset_id=a.id
               WHERE a.id=?1 AND a.media_kind='video'
             )",
            [asset_id],
            |row| row.get(0),
        )?;
        if !target_is_video {
            return Err(HomeDataError::TargetNotFound);
        }
        let remaining_ms = duration_ms.saturating_sub(position_ms);
        let at_ninety_five_percent = u128::from(position_ms) * 100 >= u128::from(duration_ms) * 95;
        if position_ms >= duration_ms || at_ninety_five_percent || remaining_ms <= 30_000 {
            connection.execute(
                "DELETE FROM video_playback_progress WHERE asset_id=?1",
                [asset_id],
            )?;
            return Ok(());
        }
        connection.execute(
            "INSERT INTO video_playback_progress(asset_id,position_ms,duration_ms,updated_at)
             VALUES(?1,?2,?3,?4)
             ON CONFLICT(asset_id) DO UPDATE SET
               position_ms=excluded.position_ms,
               duration_ms=excluded.duration_ms,
               updated_at=excluded.updated_at",
            params![
                asset_id,
                position_ms as i64,
                duration_ms as i64,
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub(crate) fn get_video_playback_progress(
        &self,
        asset_id: &str,
    ) -> Result<Option<VideoPlaybackProgress>, HomeDataError> {
        Ok(self
            .connection()?
            .query_row(
                "SELECT asset_id,position_ms,duration_ms,updated_at
                 FROM video_playback_progress WHERE asset_id=?1",
                [asset_id],
                video_progress,
            )
            .optional()?)
    }

    pub(crate) fn clear_video_playback_progress(
        &self,
        asset_id: &str,
    ) -> Result<(), HomeDataError> {
        self.connection()?.execute(
            "DELETE FROM video_playback_progress WHERE asset_id=?1",
            [asset_id],
        )?;
        Ok(())
    }

    pub(crate) fn list_continue_items(
        &self,
        limit: u32,
    ) -> Result<Vec<ContinueItem>, HomeDataError> {
        let mut items = Vec::new();
        let remote_progress = {
            let connection = self.connection()?;
            let mut manga = connection.prepare(
                "SELECT p.series_id,m.title,p.last_page,p.page_count,p.updated_at
                 FROM manga_reading_progress p
                 JOIN manga_series m ON m.id=p.series_id
                 WHERE p.last_page<p.page_count",
            )?;
            items.extend(
                manga
                    .query_map([], |row| {
                        Ok(ContinueItem {
                            kind: ContinueItemKind::Manga,
                            id: row.get(0)?,
                            provider: None,
                            title: Some(row.get(1)?),
                            thumbnail_revision: None,
                            position: nonnegative(row.get(2)?),
                            total: nonnegative(row.get(3)?),
                            updated_at: row.get(4)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?,
            );

            let mut videos = connection.prepare(
                "SELECT p.asset_id,COALESCE(NULLIF(TRIM(a.title),''),a.original_name),
                        a.thumbnail_relative_path,p.position_ms,p.duration_ms,p.updated_at
                 FROM video_playback_progress p
                 JOIN assets a ON a.id=p.asset_id AND a.media_kind='video' AND a.status='normal'
                 JOIN video_assets v ON v.asset_id=a.id",
            )?;
            items.extend(
                videos
                    .query_map([], |row| {
                        let thumbnail_path = row.get::<_, Option<String>>(2)?;
                        Ok(ContinueItem {
                            kind: ContinueItemKind::Video,
                            id: row.get(0)?,
                            provider: None,
                            title: Some(row.get(1)?),
                            thumbnail_revision: thumbnail_path.as_deref().map(thumbnail_revision),
                            position: nonnegative(row.get(3)?),
                            total: nonnegative(row.get(4)?),
                            updated_at: row.get(5)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?,
            );

            let mut remote = connection.prepare(
                "SELECT provider,work_id,last_page,page_count,last_read_at
                 FROM remote_reading_progress WHERE last_page<page_count",
            )?;
            let rows = remote
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        nonnegative(row.get(2)?),
                        nonnegative(row.get(3)?),
                        row.get::<_, String>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        self.append_existing_online_items(&mut items, remote_progress)?;
        items.sort_by(|left, right| {
            timestamp_cmp(&right.updated_at, &left.updated_at)
                .then_with(|| kind_rank(left.kind).cmp(&kind_rank(right.kind)))
                .then_with(|| left.id.cmp(&right.id))
        });
        items.truncate(limit.clamp(1, 100) as usize);
        Ok(items)
    }

    fn append_existing_online_items(
        &self,
        items: &mut Vec<ContinueItem>,
        progress: Vec<(String, String, u64, u64, String)>,
    ) -> Result<(), HomeDataError> {
        let _file_guard = self
            .catalog_file_lock
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let catalog_path = self.root().join("catalogs/kdata.db");
        if !catalog_path.exists() {
            for (provider, id, position, total, updated_at) in progress {
                if super::catalog_provider::CatalogProvider::from_tag(&provider).is_some() {
                    items.push(ContinueItem {
                        kind: ContinueItemKind::Online,
                        id,
                        provider: Some(provider),
                        title: None,
                        thumbnail_revision: None,
                        position,
                        total,
                        updated_at,
                    });
                }
            }
            return Ok(());
        }
        let catalog = Connection::open_with_flags(
            catalog_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let mut work = catalog.prepare("SELECT Title FROM Works WHERE Id=?1 AND Expunged=0")?;
        for (provider, id, position, total, updated_at) in progress {
            let title = if provider == super::catalog_provider::LEGACY_VCK_PROVIDER {
                let Some(work_id) = id.parse::<i64>().ok().filter(|id| *id > 0) else {
                    continue;
                };
                let Some(title) = work
                    .query_row([work_id], |row| row.get::<_, String>(0))
                    .optional()?
                else {
                    // The installed kHentai catalog authoritatively says this target is gone.
                    continue;
                };
                Some(title)
            } else if provider == super::catalog_provider::HELIOTROPE_PROVIDER {
                // Heliotrope progress is valid, but its metadata is not installed in the PC
                // catalog. Provider + work id remain enough for the UI to resolve it later.
                None
            } else {
                continue;
            };
            items.push(ContinueItem {
                kind: ContinueItemKind::Online,
                id,
                provider: Some(provider),
                title,
                thumbnail_revision: None,
                position,
                total,
                updated_at,
            });
        }
        Ok(())
    }

    pub(crate) fn set_av_favorite(
        &self,
        person_id: &str,
        favorite: bool,
    ) -> Result<(), HomeDataError> {
        let connection = self.connection()?;
        if favorite {
            let performer: bool = connection.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM collection_person_relations r
                   JOIN collections c ON c.id=r.collection_id AND c.type='av'
                   WHERE r.person_id=?1 AND r.role='performer'
                 )",
                [person_id],
                |row| row.get(0),
            )?;
            if !performer {
                return Err(HomeDataError::InvalidAvPerformer);
            }
            connection.execute(
                "INSERT INTO av_favorite_performers(person_id,created_at) VALUES(?1,?2)
                 ON CONFLICT(person_id) DO NOTHING",
                params![person_id, Utc::now().to_rfc3339()],
            )?;
        } else {
            connection.execute(
                "DELETE FROM av_favorite_performers WHERE person_id=?1",
                [person_id],
            )?;
        }
        Ok(())
    }

    pub(crate) fn list_av_favorites(&self) -> Result<Vec<AvFavorite>, HomeDataError> {
        self.list_av_favorites_since(Utc::now() - Duration::days(30))
    }

    fn list_av_favorites_since(
        &self,
        recent_cutoff: DateTime<Utc>,
    ) -> Result<Vec<AvFavorite>, HomeDataError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT f.person_id,p.display_name,NULLIF(TRIM(p.name_ja),''),
                    COUNT(DISTINCT c.id),
                    COUNT(DISTINCT CASE WHEN julianday(c.created_at)>=julianday(?1) THEN c.id END),
                    f.created_at
             FROM av_favorite_performers f
             JOIN collection_people p ON p.id=f.person_id
             LEFT JOIN collection_person_relations r ON r.person_id=p.id AND r.role='performer'
             LEFT JOIN collections c ON c.id=r.collection_id AND c.type='av'
             GROUP BY f.person_id,p.display_name,p.name_ja,f.created_at
             ORDER BY f.created_at DESC,f.person_id",
        )?;
        let mut favorites = statement
            .query_map([recent_cutoff.to_rfc3339()], |row| {
                Ok(AvFavorite {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    original_name: row.get(2)?,
                    portrait: None,
                    owned_work_count: row.get(3)?,
                    recent_owned_count: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for favorite in &mut favorites {
            favorite.original_name = favorite
                .original_name
                .take()
                .filter(|name| name != &favorite.display_name);
            favorite.portrait = super::av_portrait::portrait(&connection, &favorite.id)?;
        }
        Ok(favorites)
    }
}

fn manga_progress(row: &rusqlite::Row<'_>) -> rusqlite::Result<MangaReadingProgress> {
    Ok(MangaReadingProgress {
        series_id: row.get(0)?,
        last_page: nonnegative(row.get(1)?),
        page_count: nonnegative(row.get(2)?),
        updated_at: row.get(3)?,
    })
}

fn video_progress(row: &rusqlite::Row<'_>) -> rusqlite::Result<VideoPlaybackProgress> {
    Ok(VideoPlaybackProgress {
        asset_id: row.get(0)?,
        position_ms: nonnegative(row.get(1)?),
        duration_ms: nonnegative(row.get(2)?),
        updated_at: row.get(3)?,
    })
}

fn nonnegative(value: i64) -> u64 {
    value.max(0) as u64
}

fn timestamp_cmp(left: &str, right: &str) -> Ordering {
    match (
        DateTime::parse_from_rfc3339(left),
        DateTime::parse_from_rfc3339(right),
    ) {
        (Ok(left), Ok(right)) => left.cmp(&right),
        _ => left.cmp(right),
    }
}

fn kind_rank(kind: ContinueItemKind) -> u8 {
    match kind {
        ContinueItemKind::Manga => 0,
        ContinueItemKind::Online => 1,
        ContinueItemKind::Video => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn library() -> (tempfile::TempDir, Library) {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        (root, library)
    }

    fn insert_manga(library: &Library, id: &str, title: &str, pages: i64) {
        library.connection().unwrap().execute(
            "INSERT INTO manga_series(id,relative_path,title,author,page_count,thumbnail_relative_path,scanned_at)
             VALUES(?1,?1,?2,'Author',?3,?1||'.webp','now')",
            params![id, title, pages],
        ).unwrap();
    }

    fn insert_video(library: &Library, id: &str, title: &str) {
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets(id,content_hash,media_kind,title,original_name,relative_path,
                                thumbnail_relative_path,byte_size,width,height,collected_at,status)
             VALUES(?1,?1,'video',?2,?1||'.mp4',?1||'.mp4',?1||'.webp',1,1,1,'now','normal')",
                params![id, title],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO video_assets(asset_id,duration_ms,container,video_codec,audio_codec,
                                      preparation_state,playback_kind,poster_relative_path,
                                      scrub_relative_dir,scrub_frame_count,preparation_version)
             VALUES(?1,120000,'mp4','h264','aac','ready','original',?1||'.webp',?1,1,1)",
                [id],
            )
            .unwrap();
    }

    #[test]
    fn manga_progress_validates_ranges_and_clears() {
        let (_root, library) = library();
        insert_manga(&library, "manga-1", "Manga", 10);

        for (last, total) in [(0, 10), (11, 10), (1, 0)] {
            assert!(matches!(
                library.save_manga_reading_progress("manga-1", last, total),
                Err(HomeDataError::InvalidMangaProgress)
            ));
        }
        library
            .save_manga_reading_progress("manga-1", 4, 10)
            .unwrap();
        let progress = library
            .get_manga_reading_progress("manga-1")
            .unwrap()
            .unwrap();
        assert_eq!((progress.last_page, progress.page_count), (4, 10));
        library.clear_manga_reading_progress("manga-1").unwrap();
        assert!(library
            .get_manga_reading_progress("manga-1")
            .unwrap()
            .is_none());
    }

    #[test]
    fn video_progress_ignores_the_start_and_deletes_near_completion() {
        let (_root, library) = library();
        insert_video(&library, "video-1", "Video");
        library
            .save_video_playback_progress("video-1", 4_999, 120_000)
            .unwrap();
        assert!(library
            .get_video_playback_progress("video-1")
            .unwrap()
            .is_none());

        library
            .save_video_playback_progress("video-1", 40_000, 120_000)
            .unwrap();
        assert_eq!(
            library
                .get_video_playback_progress("video-1")
                .unwrap()
                .unwrap()
                .position_ms,
            40_000
        );
        library
            .save_video_playback_progress("video-1", 114_000, 120_000)
            .unwrap();
        assert!(library
            .get_video_playback_progress("video-1")
            .unwrap()
            .is_none());

        library
            .save_video_playback_progress("video-1", 40_000, 120_000)
            .unwrap();
        library
            .save_video_playback_progress("video-1", 70_000, 100_000)
            .unwrap();
        assert!(library
            .get_video_playback_progress("video-1")
            .unwrap()
            .is_none());
    }

    #[test]
    fn continue_items_merge_unfinished_existing_targets_newest_first() {
        let (root, library) = library();
        insert_manga(&library, "manga-open", "Local", 10);
        insert_manga(&library, "manga-finished", "Done", 2);
        insert_video(&library, "video-open", "Video");
        library
            .save_manga_reading_progress("manga-open", 3, 10)
            .unwrap();
        library
            .save_manga_reading_progress("manga-finished", 2, 2)
            .unwrap();
        library
            .save_video_playback_progress("video-open", 40_000, 120_000)
            .unwrap();
        let connection = library.connection().unwrap();
        connection.execute(
            "UPDATE manga_reading_progress SET updated_at='2026-09-29T00:00:00Z' WHERE series_id='manga-open'",
            [],
        ).unwrap();
        connection.execute(
            "UPDATE video_playback_progress SET updated_at='2026-09-29T02:00:00Z' WHERE asset_id='video-open'",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO remote_reading_progress(provider,work_id,last_page,page_count,last_read_at)
             VALUES('kHentai','42',2,8,'2026-09-29T01:00:00Z'),
                   ('kHentai','404',2,8,'2026-09-29T03:00:00Z'),
                   ('heliotrope','42',2,8,'2026-09-29T04:00:00Z')",
            [],
        ).unwrap();
        drop(connection);
        fs::create_dir_all(root.path().join("catalogs")).unwrap();
        let catalog = Connection::open(root.path().join("catalogs/kdata.db")).unwrap();
        catalog.execute_batch(
            "CREATE TABLE Works(Id INTEGER PRIMARY KEY,Title TEXT NOT NULL,Expunged INTEGER NOT NULL);
             INSERT INTO Works VALUES(42,'Online',0);",
        ).unwrap();

        let items = library.list_continue_items(10).unwrap();
        assert_eq!(
            items
                .iter()
                .map(|item| (item.kind, item.id.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (ContinueItemKind::Online, "42"),
                (ContinueItemKind::Video, "video-open"),
                (ContinueItemKind::Online, "42"),
                (ContinueItemKind::Manga, "manga-open"),
            ]
        );
        assert_eq!(items[0].provider.as_deref(), Some("heliotrope"));
        assert_eq!(items[0].title, None);
        assert_eq!(items[2].provider.as_deref(), Some("kHentai"));
        assert_eq!(items[2].title.as_deref(), Some("Online"));
        assert!(items[1].thumbnail_revision.is_some());
        assert_eq!(library.list_continue_items(2).unwrap().len(), 2);
        assert_eq!(library.list_continue_items(0).unwrap().len(), 1);
    }

    #[test]
    fn favorites_include_portrait_counts_and_creation_order() {
        let (_root, library) = library();
        let connection = library.connection().unwrap();
        connection.execute_batch(
            "INSERT INTO collection_people(id,display_name,name_ja,created_at,updated_at) VALUES
               ('p1','Display','Original','t','t'),('p2','Same','Same','t','t');
             INSERT INTO collections(id,name,type,created_at,updated_at) VALUES
               ('old','Old','av','2026-07-01T00:00:00Z','t'),
               ('new','New','av','2026-09-20T00:00:00Z','t'),
               ('new2','New 2','av','2026-09-21T00:00:00Z','t');
             INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order) VALUES
               ('old','p1','performer',0),('new','p1','performer',0),('new2','p2','performer',0);
             INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,source_url,updated_at)
               VALUES('p1','commons',X'01','image/png',1,1,'portrait.png','https://commons.wikimedia.org/p','t');",
        ).unwrap();
        drop(connection);
        library.set_av_favorite("p1", true).unwrap();
        library.set_av_favorite("p2", true).unwrap();
        let connection = library.connection().unwrap();
        connection.execute("UPDATE av_favorite_performers SET created_at='2026-09-01T00:00:00Z' WHERE person_id='p1'", []).unwrap();
        connection.execute("UPDATE av_favorite_performers SET created_at='2026-09-02T00:00:00Z' WHERE person_id='p2'", []).unwrap();
        drop(connection);

        let favorites = library
            .list_av_favorites_since("2026-09-01T00:00:00Z".parse().unwrap())
            .unwrap();
        assert_eq!(
            favorites
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["p2", "p1"]
        );
        assert_eq!(favorites[1].original_name.as_deref(), Some("Original"));
        assert_eq!(
            (
                favorites[1].owned_work_count,
                favorites[1].recent_owned_count
            ),
            (2, 1)
        );
        assert!(favorites[1].portrait.is_some());
        assert_eq!(favorites[0].original_name, None);

        let connection = library.connection().unwrap();
        connection
            .execute("DELETE FROM collections WHERE id IN ('old','new')", [])
            .unwrap();
        drop(connection);
        let empty_favorite = library
            .list_av_favorites_since("2026-09-01T00:00:00Z".parse().unwrap())
            .unwrap()
            .into_iter()
            .find(|item| item.id == "p1")
            .unwrap();
        assert_eq!(
            (
                empty_favorite.owned_work_count,
                empty_favorite.recent_owned_count
            ),
            (0, 0)
        );

        library.set_av_favorite("p1", false).unwrap();
        assert_eq!(
            library
                .list_av_favorites()
                .unwrap()
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["p2"]
        );
    }
}
