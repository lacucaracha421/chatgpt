//! PC card bridge: client credentials stay native, art stays local when available.
use super::{background_task_error, current_required, AppState, CommandError};
use crate::library::{credential, error::LibraryError, Library, MediaVariant};
use serde_json::Value;
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
pub async fn card_state(state: State<'_, AppState>) -> Result<Value, CommandError> {
    let library = current_required(state)?;
    // A new or opened pack changes what needs a cutout; let the background job look soon.
    crate::card_cutouts::wake();
    tauri::async_runtime::spawn_blocking(move || {
        let (client, token) = client(&library)?;
        client.card_state(&token.expose())
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}
#[tauri::command]
pub async fn card_open_pack(
    pack_id: String,
    operation_id: String,
    state: State<'_, AppState>,
) -> Result<Value, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (client, token) = client(&library)?;
        client.card_open_pack(&pack_id, &operation_id, &token.expose())
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}
#[tauri::command]
pub async fn card_keep_pack(
    pack_id: String,
    operation_id: String,
    slots: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<Value, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (client, token) = client(&library)?;
        client.card_keep_pack(&pack_id, &operation_id, &slots, &token.expose())
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}
#[tauri::command]
pub async fn card_pack(pack_id: String, state: State<'_, AppState>) -> Result<Value, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (client, token) = client(&library)?;
        client.card_pack(&pack_id, &token.expose())
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}
#[tauri::command]
pub async fn card_album(
    after: Option<String>,
    limit: Option<u16>,
    state: State<'_, AppState>,
) -> Result<Value, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (client, token) = client(&library)?;
        client.card_album(after.as_deref(), limit.unwrap_or(50), &token.expose())
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}
#[tauri::command]
pub async fn card_art_url(
    asset_id: String,
    cutout: Option<bool>,
    local_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !crate::cloud::client::cards::valid_id(&asset_id) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let cutout = cutout.unwrap_or(false);
        if cutout {
            // This PC's own cutout copy first: no ticket, no download.
            if let Some(url) = crate::card_cutouts::local_url(&asset_id) {
                return Ok(url);
            }
        } else {
            match library.resolve_media(&asset_id, MediaVariant::Asset) {
                Ok(_) => return Ok(format!("http://lakomics.localhost/preview/{asset_id}/1280")),
                Err(LibraryError::MediaNotFound) | Err(LibraryError::AssetNotFound) => {}
                Err(error) => return Err(error),
            }
        }
        // Background warm-up asks for local art only and must never reach the network.
        if local_only.unwrap_or(false) {
            return Err(LibraryError::MediaNotFound);
        }
        let (client, token) = client(&library)?;
        client.card_ticket(&asset_id, cutout, &token.expose())
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}
