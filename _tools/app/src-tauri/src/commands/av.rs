use super::{current_required, AppState, CommandError};
use crate::library::{av_models::*, av_portrait::AvPortraitState};
use tauri::State;

impl From<AvError> for CommandError {
    fn from(error: AvError) -> Self {
        match error {
            AvError::Library(error) => error.into(),
            AvError::StashdbRelay(code,message) | AvError::Inbox(code,message) => Self { code:code.into(), message:message.into() },
            AvError::Stale => Self { code:"av_stale",message:"정보가 변경되었습니다. 다시 불러온 뒤 저장해 주세요.".into() },
            AvError::Image => Self { code:"av_image",message:"이미지를 다시 선택해 주세요. JPEG·PNG·WebP, 32 MiB·1600만 화소 이내를 지원합니다.".into() },
            _ => Self { code:"av_invalid",message:"AV 정보를 저장하지 못했습니다. 입력과 인물 연결을 확인해 주세요.".into() },
        }
    }
}
#[tauri::command]
pub async fn get_av_details(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<AvDetails, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.get_av_details(&collection_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn save_av_details(
    collection_id: String,
    input: SaveAvDetails,
    state: State<'_, AppState>,
) -> Result<AvDetails, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.save_av_details(&collection_id, input))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn search_av_people(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<AvPerson>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.search_av_people(&query))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn preview_av_artwork(
    path: String,
    surface: CoverSurface,
    state: State<'_, AppState>,
) -> Result<LocalArtworkPreview, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.preview_av_artwork(&path, surface))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn apply_av_artwork(
    collection_id: String,
    input: ApplyAvArtwork,
    state: State<'_, AppState>,
) -> Result<AvCoverSet, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.apply_av_artwork(&collection_id, input))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn get_av_cover_set(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<AvCoverSet, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.get_av_cover_set(&collection_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_av_related(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<AvRelated, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.get_av_related(&collection_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_av_performer(
    person_id: String,
    state: State<'_, AppState>,
) -> Result<AvPerformerPage, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.get_av_performer(&person_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_av_portrait_sources(
    person_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<AvPortraitSource>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.list_av_portrait_sources(&person_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn save_av_person_memo(
    person_id: String,
    memo: Option<String>,
    state: State<'_, AppState>,
) -> Result<AvPerformerPage, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.save_av_person_memo(&person_id, memo))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn set_av_portrait_crop(
    person_id: String,
    artwork_id: String,
    rect: AvPortraitRect,
    state: State<'_, AppState>,
    portraits: State<'_, AvPortraitState>,
) -> Result<AvPortrait, CommandError> {
    let library = current_required(state)?;
    let portraits = portraits.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = library.set_av_portrait_crop(&person_id, &artwork_id, rect)?;
        portraits.discard(&library, &person_id);
        Ok::<_, AvError>(result)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}
#[tauri::command]
pub async fn preview_av_commons_portrait(
    person_id: String,
    state: State<'_, AppState>,
    portraits: State<'_, AvPortraitState>,
) -> Result<Option<AvCommonsPreview>, CommandError> {
    let library = current_required(state)?;
    let portraits = portraits.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        library.preview_av_commons_portrait_with(
            &person_id,
            &portraits,
            &crate::library::av_link::provider::NetworkClient::new(),
        )
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}
#[tauri::command]
pub async fn use_av_commons_portrait(
    person_id: String,
    state: State<'_, AppState>,
    portraits: State<'_, AvPortraitState>,
) -> Result<AvPortrait, CommandError> {
    let library = current_required(state)?;
    let portraits = portraits.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        library.use_av_commons_portrait(&person_id, &portraits)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}
#[tauri::command]
pub async fn clear_av_portrait(
    person_id: String,
    state: State<'_, AppState>,
    portraits: State<'_, AvPortraitState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    let portraits = portraits.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        library.clear_av_portrait(&person_id)?;
        portraits.discard(&library, &person_id);
        Ok::<_, AvError>(())
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn get_av_performer_profile(
    person_id: String,
    state: State<'_, AppState>,
) -> Result<Option<crate::library::av_stashdb::AvPerformerProfile>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.get_av_performer_profile(&person_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn refresh_av_performer_profile(
    person_id: String,
    force: bool,
    state: State<'_, AppState>,
    profiles: State<'_, crate::library::av_stashdb::AvProfileState>,
) -> Result<Option<crate::library::av_stashdb::AvPerformerProfile>, CommandError> {
    let library = current_required(state)?;
    let profiles = profiles.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if library.stashdb_routed()? {
            return library.refresh_av_performer_profile_relay_with(
                &person_id,
                force,
                &profiles,
                &library.stashdb_relay()?,
            );
        }
        let key = crate::library::credential::read_stashdb_key_os()?;
        let http = crate::library::av_link::provider::NetworkClient::new();
        library.refresh_av_performer_profile_with(
            &person_id,
            force,
            &profiles,
            &http,
            key.as_ref().map(|k| k.api_key.as_str()),
        )
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn choose_av_performer_profile(
    person_id: String,
    stashdb_id: String,
    state: State<'_, AppState>,
    profiles: State<'_, crate::library::av_stashdb::AvProfileState>,
) -> Result<crate::library::av_stashdb::AvPerformerProfile, CommandError> {
    let library = current_required(state)?;
    let profiles = profiles.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if library.stashdb_routed()? {
            return library.queue_av_performer_profile_relay_with(
                &person_id,
                Some(&stashdb_id),
                &profiles,
                &library.stashdb_relay()?,
            );
        }
        let key = crate::library::credential::read_stashdb_key_os()?;
        let http = crate::library::av_link::provider::NetworkClient::new();
        library.choose_av_performer_profile_with(
            &person_id,
            &stashdb_id,
            &profiles,
            &http,
            key.as_ref().map(|k| k.api_key.as_str()),
        )
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn search_av_performer_profile(
    person_id: String,
    state: State<'_, AppState>,
) -> Result<crate::library::av_stashdb::AvPerformerProfile, CommandError> {
    let library = current_required(state)?;

    tauri::async_runtime::spawn_blocking(move || {
        if library.stashdb_routed()? {
            return library
                .search_av_performer_profile_relay_with(&person_id, &library.stashdb_relay()?);
        }
        let key = crate::library::credential::read_stashdb_key_os()?;
        let http = crate::library::av_link::provider::NetworkClient::new();
        library.search_av_performer_profile_with(
            &person_id,
            &http,
            key.as_ref().map(|k| k.api_key.as_str()),
        )
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn dismiss_av_performer_profile(
    person_id: String,
    state: State<'_, AppState>,
    profiles: State<'_, crate::library::av_stashdb::AvProfileState>,
) -> Result<crate::library::av_stashdb::AvPerformerProfile, CommandError> {
    let library = current_required(state)?;
    let profiles = profiles.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if library.stashdb_routed()? {
            return library.dismiss_av_performer_profile_routed(&person_id, &profiles);
        }
        library.dismiss_av_performer_profile(&person_id, &profiles)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn clear_av_performer_profile(
    person_id: String,
    state: State<'_, AppState>,
    profiles: State<'_, crate::library::av_stashdb::AvProfileState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    let profiles = profiles.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if library.stashdb_routed()? {
            library.queue_av_performer_profile_relay_with(
                &person_id,
                None,
                &profiles,
                &library.stashdb_relay()?,
            )?;
            return Ok(());
        }
        library.clear_av_performer_profile(&person_id, &profiles)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn preview_av_stashdb_portrait(
    person_id: String,
    image_id: String,
    state: State<'_, AppState>,
    portraits: State<'_, AvPortraitState>,
) -> Result<AvStashdbPreview, CommandError> {
    let library = current_required(state)?;
    let portraits = portraits.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if library.stashdb_routed()? {
            return library.preview_av_stashdb_portrait_relay_with(
                &person_id,
                &image_id,
                &portraits,
                &library.stashdb_relay()?,
            );
        }
        if crate::library::credential::read_stashdb_key_os()?.is_none() {
            return Err(AvError::Invalid);
        }
        library.preview_av_stashdb_portrait_with(
            &person_id,
            &image_id,
            &portraits,
            &crate::library::av_link::provider::NetworkClient::new(),
        )
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}
#[tauri::command]
pub async fn use_av_stashdb_portrait(
    person_id: String,
    state: State<'_, AppState>,
    portraits: State<'_, AvPortraitState>,
) -> Result<AvPortrait, CommandError> {
    let library = current_required(state)?;
    let portraits = portraits.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if library.stashdb_routed()? {
            return library.use_av_stashdb_portrait_relay_with(
                &person_id,
                &portraits,
                &library.stashdb_relay()?,
            );
        }
        library.use_av_stashdb_portrait(&person_id, &portraits)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn get_av_stashdb_status(
    state: State<'_, AppState>,
) -> Result<crate::library::av_stashdb::StashdbStatus, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        if library.stashdb_routed()? {
            return library.stashdb_status_with(&library.stashdb_relay()?);
        }
        Ok(crate::library::av_stashdb::StashdbStatus {
            configured: crate::library::credential::stashdb_credential_status()?.configured,
            routed: false,
            supported: true,
        })
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}
#[tauri::command]
pub async fn get_av_stashdb_profile_detail(
    person_id: String,
    state: State<'_, AppState>,
) -> Result<Option<crate::library::av_stashdb::AvPerformerProfile>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        if library.stashdb_routed()? {
            return library.stashdb_profile_detail_with(&person_id, &library.stashdb_relay()?);
        }
        library.get_av_performer_profile(&person_id)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}
#[tauri::command]
pub async fn preview_av_stashdb_image(
    url: String,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !library.stashdb_routed()? {
            return Err(AvError::Invalid);
        }
        let bytes = crate::library::av_stashdb::relay_image(&library.stashdb_relay()?, &url)?;
        let mime = match image::guess_format(&bytes).map_err(|_| AvError::Image)? {
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::WebP => "image/webp",
            _ => return Err(AvError::Image),
        };
        Ok(crate::library::av_portrait::data_url(mime, &bytes))
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}
