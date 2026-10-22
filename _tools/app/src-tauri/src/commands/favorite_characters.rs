//! PC bridge for the favourite characters: the cloud credential stays native.
use super::{background_task_error, current_required, AppState, CommandError};
use crate::cloud::client::favorite_characters::{FavoriteCharacters, FavoriteCommand};
use crate::library::{credential, error::LibraryError, Library};
use tauri::State;

fn client(
    library: &Library,
) -> Result<
    (
        crate::cloud::client::CloudClient,
        credential::CloudCredential,
    ),
    LibraryError,
> {
    let config = library.cloud_sync_config()?;
    if !config.enabled {
        return Err(LibraryError::InvalidCloudSyncConfig);
    }
    let endpoint = config
        .api_base_url
        .ok_or(LibraryError::InvalidCloudSyncConfig)?;
    Ok((
        library.cloud_client(&endpoint)?,
        credential::read_cloud_api_token_os()?,
    ))
}

#[tauri::command]
pub async fn favorite_characters(
    state: State<'_, AppState>,
) -> Result<FavoriteCharacters, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (client, token) = client(&library)?;
        let document = client.favorite_characters(token.expose())?;
        mark_manual_covers(&library, &document)?;
        Ok::<_, LibraryError>(document)
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[tauri::command]
pub async fn change_favorite_characters(
    commands: Vec<FavoriteCommand>,
    state: State<'_, AppState>,
) -> Result<FavoriteCharacters, CommandError> {
    let library = current_required(state)?;
    let linking = commands
        .iter()
        .any(|command| matches!(command, FavoriteCommand::Link { .. }));
    tauri::async_runtime::spawn_blocking(move || {
        let (client, token) = client(&library)?;
        let document = client.change_favorite_characters(&commands, token.expose())?;
        mark_manual_covers(&library, &document)?;
        Ok::<_, LibraryError>(document)
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(|error| {
        if linking && matches!(error, LibraryError::CloudObjectKeyConflict) {
            CommandError {
                code: "favoriteCharacterExists",
                message: "이미 추가된 캐릭터입니다. 다른 캐릭터를 선택하세요.".into(),
            }
        } else {
            CommandError::from(error)
        }
    })
}

/// Idempotent local read projection upgrade for covers imported before favorite_cover.
/// Ordinary character selections never enter this path. Bytes and asset ids stay intact.
fn mark_manual_covers(
    library: &Library,
    document: &FavoriteCharacters,
) -> Result<(), LibraryError> {
    let mut database = library.connection()?;
    let transaction = database.transaction()?;
    for entry in &document.entries {
        if entry.character_id.starts_with("manual-") {
            if let Some(id) = &entry.cover_asset_id {
                transaction.execute(
                    "UPDATE assets SET import_source='favorite_cover' WHERE id=?1 AND import_source='direct'",
                    [id],
                )?;
            }
        }
    }
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{
        models::{AssetDateBucketQuery, AssetQuery, AssetSort},
        MediaVariant,
    };

    #[test]
    fn favorite_cover_visibility_preserves_linked_asset_and_media() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        {
            let db = library.connection().unwrap();
            for (id, source) in [
                ("legacy-cover", "direct"),
                ("new-cover", "favorite_cover"),
                ("normal-cover", "direct"),
            ] {
                image::RgbImage::new(10, 10)
                    .save(temp.path().join(format!("{id}.png")))
                    .unwrap();
                db.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,import_source) VALUES(?1,?1,'image',?1,?1 || '.png',?1 || '.png',1,10,10,'2026-01-01T00:00:00Z',?2)", rusqlite::params![id, source]).unwrap();
            }
        }
        let document = serde_json::from_value(serde_json::json!({
            "version":1,"revision":1,"entries":[
                {"characterId":"manual-old","name":"Manual","coverAssetId":"legacy-cover","coverY":50,"profile":{},"workIds":[],"extraWorks":[]},
                {"characterId":"normal-character","coverAssetId":"normal-cover","coverY":50,"profile":{},"workIds":[],"extraWorks":[]}
            ]
        })).unwrap();
        mark_manual_covers(&library, &document).unwrap();
        mark_manual_covers(&library, &document).unwrap();
        for sort in [
            AssetSort::Newest,
            AssetSort::Oldest,
            AssetSort::Favorites,
            AssetSort::Random,
        ] {
            for unclassified_only in [false, true] {
                let page = library
                    .list_assets(AssetQuery {
                        sort,
                        unclassified_only,
                        limit: 20,
                        ..Default::default()
                    })
                    .unwrap();
                assert_eq!(page.total_count, 1);
                assert_eq!(
                    page.items
                        .iter()
                        .map(|item| item.id.as_str())
                        .collect::<Vec<_>>(),
                    vec!["normal-cover"]
                );
            }
        }
        let statistics = library.get_library_statistics().unwrap();
        assert_eq!((statistics.assets, statistics.unclassified), (1, 1));
        let buckets = library
            .list_asset_date_buckets(AssetDateBucketQuery {
                start_utc: "2025-12-31T00:00:00Z".into(),
                end_utc: "2026-01-02T00:00:00Z".into(),
                offset_minutes: 0,
                images_only: false,
                local_days: None,
            })
            .unwrap();
        assert_eq!(buckets.iter().map(|bucket| bucket.count).sum::<u64>(), 1);
        for id in ["legacy-cover", "new-cover"] {
            assert!(library.resolve_media(id, MediaVariant::Thumbnail).is_ok());
        }
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM assets WHERE status='normal'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            3
        );
        assert_eq!(
            db.query_row(
                "SELECT import_source FROM assets WHERE id='normal-cover'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "direct"
        );
    }
}
