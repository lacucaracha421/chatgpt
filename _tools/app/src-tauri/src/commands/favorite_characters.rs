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
        client.favorite_characters(token.expose())
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
    tauri::async_runtime::spawn_blocking(move || {
        let (client, token) = client(&library)?;
        client.change_favorite_characters(&commands, token.expose())
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}
