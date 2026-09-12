use tauri::State;
use super::{current_required, AppState, CommandError};
use crate::library::av_models::*;

impl From<AvError> for CommandError {
    fn from(error: AvError) -> Self {
        match error {
            AvError::Library(error) => error.into(),
            AvError::Stale => Self { code:"av_stale",message:"정보가 변경되었습니다. 다시 불러온 뒤 저장해 주세요.".into() },
            AvError::Image => Self { code:"av_image",message:"이미지를 다시 선택해 주세요. JPEG·PNG·WebP, 32 MiB·1600만 화소 이내를 지원합니다.".into() },
            _ => Self { code:"av_invalid",message:"AV 정보를 저장하지 못했습니다. 입력과 인물 연결을 확인해 주세요.".into() },
        }
    }
}
#[tauri::command]
pub async fn get_av_details(collection_id:String,state:State<'_,AppState>) -> Result<AvDetails,CommandError> {
    let library=current_required(state)?;
    tauri::async_runtime::spawn_blocking(move||library.get_av_details(&collection_id)).await.map_err(|_|super::background_task_error())?.map_err(Into::into)
}
#[tauri::command]
pub async fn save_av_details(collection_id:String,input:SaveAvDetails,state:State<'_,AppState>) -> Result<AvDetails,CommandError> {
    let library=current_required(state)?;
    tauri::async_runtime::spawn_blocking(move||library.save_av_details(&collection_id,input)).await.map_err(|_|super::background_task_error())?.map_err(Into::into)
}
#[tauri::command]
pub async fn search_av_people(query:String,state:State<'_,AppState>) -> Result<Vec<AvPerson>,CommandError> {
    let library=current_required(state)?;
    tauri::async_runtime::spawn_blocking(move||library.search_av_people(&query)).await.map_err(|_|super::background_task_error())?.map_err(Into::into)
}
#[tauri::command]
pub async fn preview_av_artwork(path:String,surface:CoverSurface,state:State<'_,AppState>) -> Result<LocalArtworkPreview,CommandError> {
    let library=current_required(state)?;
    tauri::async_runtime::spawn_blocking(move||library.preview_av_artwork(&path,surface)).await.map_err(|_|super::background_task_error())?.map_err(Into::into)
}
#[tauri::command]
pub async fn apply_av_artwork(collection_id:String,input:ApplyAvArtwork,state:State<'_,AppState>) -> Result<AvCoverSet,CommandError> {
    let library=current_required(state)?;
    tauri::async_runtime::spawn_blocking(move||library.apply_av_artwork(&collection_id,input)).await.map_err(|_|super::background_task_error())?.map_err(Into::into)
}
#[tauri::command]
pub async fn get_av_cover_set(collection_id:String,state:State<'_,AppState>) -> Result<AvCoverSet,CommandError> {
    let library=current_required(state)?;
    tauri::async_runtime::spawn_blocking(move||library.get_av_cover_set(&collection_id)).await.map_err(|_|super::background_task_error())?.map_err(Into::into)
}
