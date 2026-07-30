use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum LibraryError {
    #[error("라이브러리 폴더를 만들 수 없습니다: {path}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("SQLite 작업이 실패했습니다")]
    Database(#[from] rusqlite::Error),
    #[error("지원하지 않는 라이브러리 스키마 버전입니다: {0}")]
    UnsupportedSchema(i64),
}
