//! Read-only media for the PC Home. Personal asset preference is `favorite`;
//! assets have no star rating, so this query never invents one.
use chrono::NaiveDate;
use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use super::{background_task_error, current_required, AppState, CommandError};
use crate::library::error::LibraryError;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomePlaying {
    collection_id: String,
    owned_platform: Option<String>,
    my_score: Option<f64>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeDailyAsset {
    id: String,
    collected_at: String,
    favorite: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeMedia {
    playing: Vec<HomePlaying>,
    daily_asset: Option<HomeDailyAsset>,
}

// Fixed hash rather than process-seeded randomness: identical local dates and
// candidates choose the same image across restarts and Windows/Linux.
fn daily_rank(date: &str, id: &str) -> u64 {
    date.bytes()
        .chain(id.bytes())
        .fold(0xcbf29ce484222325, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        })
}

fn read_media(c: &Connection, date: &str) -> Result<HomeMedia, LibraryError> {
    let playing = c
        .prepare(
            "SELECT c.id,p.owned_platform,c.my_score FROM collections c
         JOIN collection_pc_records p ON p.collection_id=c.id
         WHERE c.type IN ('game','movie') AND p.status IN ('playing','watching')
         ORDER BY c.updated_at DESC,c.id",
        )?
        .query_map([], |row| {
            Ok(HomePlaying {
                collection_id: row.get(0)?,
                owned_platform: row.get(1)?,
                my_score: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut statement = c.prepare(
        "SELECT id,collected_at,width*1.0/height FROM assets
         WHERE status='normal' AND media_kind='image' AND favorite=1
           AND width>0 AND height>0 AND width<=height*2.0",
    )?;
    let mut rows = statement.query([])?;
    let mut pick: Option<((bool, u64, String), HomeDailyAsset)> = None;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let ratio: f64 = row.get(2)?;
        let rank = (ratio > 1.1, daily_rank(date, &id), id.clone());
        if pick.as_ref().is_none_or(|(best, _)| rank < *best) {
            pick = Some((
                rank,
                HomeDailyAsset {
                    id,
                    collected_at: row.get(1)?,
                    favorite: true,
                },
            ));
        }
    }
    Ok(HomeMedia {
        playing,
        daily_asset: pick.map(|(_, asset)| asset),
    })
}

#[tauri::command]
pub async fn get_home_media(
    local_date: String,
    state: State<'_, AppState>,
) -> Result<HomeMedia, CommandError> {
    NaiveDate::parse_from_str(&local_date, "%Y-%m-%d").map_err(|_| CommandError {
        code: "invalid_home_range",
        message: "홈 날짜가 올바르지 않습니다.".into(),
    })?;
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = library.connection()?;
        read_media(&connection, &local_date).map_err(CommandError::from)
    })
    .await
    .map_err(|_| background_task_error())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE assets(id TEXT,collected_at TEXT,width INT,height INT,status TEXT,media_kind TEXT,favorite INT);
            CREATE TABLE collections(id TEXT,type TEXT,my_score REAL,updated_at TEXT);
            CREATE TABLE collection_pc_records(collection_id TEXT,status TEXT,owned_platform TEXT);
            INSERT INTO assets VALUES
            ('portrait','2023-07-18',800,1200,'normal','image',1),
            ('square','2024-01-02',1100,1000,'normal','image',1),
            ('landscape','2024-01-03',1800,1000,'normal','image',1),
            ('wide','2024-01-04',2100,1000,'normal','image',1),
            ('trash','2024-01-05',800,1200,'trashed','image',1),
            ('video','2024-01-06',800,1200,'normal','video',1),
            ('ordinary','2024-01-07',800,1200,'normal','image',0),
            ('unknown','2024-01-08',800,0,'normal','image',1);").unwrap();
        c
    }

    #[test]
    fn home_media_daily_pick_is_stable_prefers_portraits_and_excludes_ineligible_assets() {
        let c = fixture();
        c.execute_batch("PRAGMA query_only=ON").unwrap();
        let first = read_media(&c, "2026-10-04").unwrap();
        assert_eq!(first, read_media(&c, "2026-10-04").unwrap());
        let mut seen = std::collections::HashSet::new();
        for day in 1..=31 {
            let asset = read_media(&c, &format!("2026-10-{day:02}"))
                .unwrap()
                .daily_asset
                .unwrap();
            assert!(["portrait", "square"].contains(&asset.id.as_str()));
            seen.insert(asset.id);
        }
        assert_eq!(seen.len(), 2);
    }

    #[test]
    fn home_media_falls_back_to_landscape_then_empty_without_writes() {
        let c = fixture();
        c.execute("DELETE FROM assets WHERE id IN ('portrait','square')", [])
            .unwrap();
        assert_eq!(
            read_media(&c, "2026-10-04")
                .unwrap()
                .daily_asset
                .unwrap()
                .id,
            "landscape"
        );
        c.execute("DELETE FROM assets WHERE id='landscape'", [])
            .unwrap();
        assert!(read_media(&c, "2026-10-04").unwrap().daily_asset.is_none());
    }

    #[test]
    fn home_media_only_lists_in_progress_games_and_films_with_personal_values() {
        let c = fixture();
        c.execute_batch("INSERT INTO collections VALUES ('game','game',4.5,'2'),('film','movie',3,'1'),('done','game',5,'3'),('book','manga',5,'4');
            INSERT INTO collection_pc_records VALUES ('game','playing','PS5'),('film','watching',NULL),('done','completed',NULL),('book','playing',NULL);
            PRAGMA query_only=ON;").unwrap();
        let media = read_media(&c, "2026-10-04").unwrap();
        assert_eq!(media.playing.len(), 2);
        assert_eq!(media.playing[0].collection_id, "game");
        assert_eq!(media.playing[0].owned_platform.as_deref(), Some("PS5"));
        assert_eq!(media.playing[0].my_score, Some(4.5));
        assert_eq!(media.playing[1].collection_id, "film");
    }
}
