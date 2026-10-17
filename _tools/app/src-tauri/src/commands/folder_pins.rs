//! PC bridge for the shared folder pins: the cloud credential stays native.
use super::{background_task_error, current_required, AppState, CommandError};
use crate::cloud::client::folder_pins::{FolderPins, PinCommand};
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
pub async fn folder_pins(state: State<'_, AppState>) -> Result<FolderPins, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (client, token) = client(&library)?;
        client.folder_pins(token.expose())
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[tauri::command]
pub async fn change_folder_pins(
    commands: Vec<PinCommand>,
    state: State<'_, AppState>,
) -> Result<FolderPins, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (client, token) = client(&library)?;
        client.change_folder_pins(&commands, token.expose())
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}
