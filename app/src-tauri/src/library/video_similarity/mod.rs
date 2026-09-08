//! Explicit, bounded video comparison. Ingestion and image review are unchanged.
mod fingerprint;
mod models;
mod review;
mod scan;

pub use models::*;
pub(super) use scan::ScanState;

use super::error::LibraryError;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("정상 영상 2~100개를 선택해 주세요.")]
    InvalidSelection,
    #[error("이미 영상 분석이 실행 중입니다.")]
    Busy,
    #[error("영상 분석 또는 검토를 찾을 수 없습니다.")]
    NotFound,
    #[error("영상이 변경되었습니다. 다시 확인해 주세요.")]
    Stale,
    #[error("이미 다른 선택이 저장되었습니다.")]
    Conflict,
    #[error("영상 분석을 완료하지 못했습니다.")]
    Processing,
    #[error("영상 분석 저장소 작업에 실패했습니다.")]
    Database(#[from] rusqlite::Error),
    #[error("영상 자산을 읽을 수 없습니다.")]
    Library(#[from] LibraryError),
}
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests;
