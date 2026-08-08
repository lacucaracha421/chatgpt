use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum LibraryError {
    #[error("라이브러리가 다른 창에서 열려 있습니다")]
    LibraryInUse,
    #[error("라이브러리 잠금 파일을 열 수 없습니다: {path}")]
    LibraryLock {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("SQLite 백업을 만들 수 없습니다: {path}")]
    Backup {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("SQLite 백업을 검증할 수 없습니다")]
    InvalidBackup,
    #[error("메타데이터 백업 복원에 실패했습니다. 복구 데이터베이스가 보존되었습니다")]
    RestoreFailed { recovery_path: PathBuf },
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
    #[error("trash retention must be between 1 and 3650 days, or disabled")]
    InvalidTrashRetention,
    #[error("managed file deletion is supported only on Windows")]
    UnsupportedManagedFileDeletion,
    #[error("분류 이름은 비어 있을 수 없습니다")]
    EmptyClassificationName,
    #[error("요청한 분류 항목을 찾을 수 없습니다.")]
    ClassificationNotFound,
    #[error("같은 위치에 같은 이름의 분류 항목이 있습니다")]
    DuplicateClassificationName,
    #[error("최상위 분류는 부모를 가질 수 없고 작품은 최상위 분류 아래에 있어야 합니다")]
    InvalidClassificationParent,
    #[error("분류 항목을 자신의 하위 항목으로 옮길 수 없습니다")]
    ClassificationCycle,
    #[error("하위 항목이나 자산이 연결된 분류 항목은 삭제할 수 없습니다")]
    ClassificationNotEmpty,
    #[error("요청한 자산을 찾을 수 없습니다")]
    AssetNotFound,
    #[error("자산 페이지 크기는 1에서 200 사이여야 합니다")]
    InvalidAssetPageLimit,
    #[error("invalid asset cursor")]
    InvalidAssetCursor,
    #[error("invalid trash timestamp")]
    InvalidTrashTimestamp,
    #[error("요청한 미디어 파일을 찾을 수 없습니다")]
    MediaNotFound,
    #[error("미디어 경로가 라이브러리 폴더 밖을 가리킵니다")]
    UnsafeMediaPath,
    #[error("미디어 파일을 읽을 수 없습니다: {path}")]
    ReadMedia {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("원본 파일을 읽을 수 없습니다: {path}")]
    ReadSource {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("이미지 형식을 지원하지 않거나 파일이 손상됐습니다")]
    UnsupportedImage,
    #[error("라이브러리 파일을 쓸 수 없습니다: {path}")]
    WriteAsset {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}
