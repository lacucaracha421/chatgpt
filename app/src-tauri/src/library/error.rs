use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum LibraryError {
    #[error("다른 Lakomics에서 사용 중인 라이브러리입니다.")]
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
    #[error("가져오기 폴더에는 지원되는 메타데이터 JSON이 정확히 하나 있어야 합니다")]
    MetadataImportManifestCount,
    #[error("지원하지 않는 메타데이터 형식 또는 버전입니다")]
    UnsupportedMetadataImport,
    #[error("메타데이터 JSON이 올바르지 않습니다")]
    InvalidMetadataImport,
    #[error("메타데이터 JSON이 너무 큽니다")]
    MetadataImportTooLarge,
    #[error("메타데이터에 안전하지 않은 파일 경로가 있습니다")]
    UnsafeMetadataImportPath,
    #[error("메타데이터 가져오기 폴더를 읽을 수 없습니다")]
    ReadMetadataImport {
        #[source]
        source: std::io::Error,
    },
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
    #[error("지원하지 않는 폴더 아이콘 또는 색상입니다.")]
    InvalidClassificationAppearance,
    #[error("하위 폴더가 있는 폴더는 삭제할 수 없습니다")]
    ClassificationHasChildren,
    #[error("앨범 이름은 비어 있을 수 없습니다")]
    EmptyAlbumName,
    #[error("요청한 앨범을 찾을 수 없습니다")]
    AlbumNotFound,
    #[error("같은 위치에 같은 이름의 앨범이 있습니다")]
    DuplicateAlbumName,
    #[error("앨범을 자기 자신이나 자신의 하위 앨범 아래로 옮길 수 없습니다")]
    AlbumCycle,
    #[error("하위 앨범이 있는 앨범은 삭제할 수 없습니다")]
    AlbumHasChildren,
    #[error("지원하지 않는 앨범 아이콘 또는 색상입니다")]
    InvalidAlbumAppearance,
    #[error("컬렉션 이름은 비어 있을 수 없습니다")]
    EmptyCollectionName,
    #[error("컬렉션 이름은 120자 이하여야 합니다")]
    CollectionNameTooLong,
    #[error("컬렉션 설명은 2,000자 이하여야 합니다")]
    CollectionDescriptionTooLong,
    #[error("요청한 컬렉션을 찾을 수 없습니다")]
    CollectionNotFound,
    #[error("같은 이름의 컬렉션이 있습니다")]
    DuplicateCollectionName,
    #[error("대표 이미지는 컬렉션에 속한 정상 자산이어야 합니다")]
    CollectionCoverNotMember,
    #[error("요청한 자산을 찾을 수 없습니다")]
    AssetNotFound,
    #[error("하나 이상의 자산을 선택해야 합니다")]
    EmptyAssetSelection,
    #[error("내보낼 자산 선택이 올바르지 않습니다")]
    InvalidAssetSelection,
    #[error("자산 드래그를 준비하지 못했습니다")]
    AssetDragFailed {
        #[source]
        source: std::io::Error,
    },
    #[error("자산 페이지 크기는 1에서 200 사이여야 합니다")]
    InvalidAssetPageLimit,
    #[error("일반 폴더와 앨범 범위를 동시에 조회할 수 없습니다")]
    InvalidAssetScope,
    #[error("invalid asset cursor")]
    InvalidAssetCursor,
    #[error("저장된 유사 이미지 해시가 올바르지 않습니다")]
    InvalidPerceptualHash,
    #[error("요청한 유사 이미지 검토를 찾을 수 없습니다")]
    SimilarityReviewNotFound,
    #[error("이미 다른 결정으로 처리 중이거나 완료된 검토입니다")]
    SimilarityReviewConflict,
    #[error("invalid trash timestamp")]
    InvalidTrashTimestamp,
    #[error("수집 시각이 RFC 3339 형식이 아닙니다")]
    InvalidCollectedAt,
    #[error("출처 게시 시각은 RFC 3339 형식이어야 합니다")]
    InvalidSourcePublishedAt,
    #[error("작성자 URL은 http 또는 https 주소여야 합니다")]
    InvalidCreatorUrl,
    #[error("가져오기 배치 ID가 올바른 UUID가 아닙니다")]
    InvalidImportBatchId,
    #[error("구버전 Lakomics 스냅샷을 읽을 수 없습니다: {path}")]
    ReadLegacySnapshot {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("구버전 Lakomics 스냅샷이 올바른 JSON이 아닙니다: {path}")]
    InvalidLegacySnapshot { path: PathBuf },
    #[error("구버전 Lakomics 스냅샷에 중복 파일명이 있습니다: {0}")]
    DuplicateLegacyMetadata(String),
    #[error("구버전 Lakomics 이미지 폴더를 읽을 수 없습니다: {path}")]
    ReadLegacyRoot {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("이전 계획의 대상 라이브러리와 열린 라이브러리가 다릅니다")]
    LegacyLibraryMismatch,
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
    #[error("영상 형식을 지원하지 않거나 파일이 손상됐습니다")]
    UnsupportedVideo,
    #[error("영상 미리보기를 준비하지 못했습니다")]
    VideoPreparationFailed,
    #[error("영상 처리 도구를 실행할 수 없습니다")]
    VideoToolUnavailable,
    #[error("라이브러리 파일을 쓸 수 없습니다: {path}")]
    WriteAsset {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("망가 루트 폴더가 설정되지 않았습니다")]
    MangaRootNotSet,
    #[error("망가 시리즈를 찾을 수 없습니다")]
    MangaSeriesNotFound,
}
