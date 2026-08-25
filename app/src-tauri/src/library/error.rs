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
    #[error("온라인 카탈로그가 설치되지 않았습니다")]
    OnlineCatalogNotInstalled,
    #[error("온라인 카탈로그 작품을 찾을 수 없습니다")]
    OnlineCatalogWorkNotFound,
    #[error("온라인 카탈로그 데이터가 올바르지 않습니다")]
    InvalidOnlineCatalog,
    #[error("온라인 카탈로그 요청 경로가 올바르지 않습니다")]
    InvalidCatalogTransportPath,
    #[error("온라인 카탈로그 서버가 요청을 거부했습니다: HTTP {0}")]
    CatalogTransportRejected(u16),
    #[error("온라인 카탈로그 응답을 처리할 수 없습니다")]
    InvalidCatalogTransportResponse,
    #[error("온라인 카탈로그 요청 시간이 초과됐습니다")]
    CatalogTransportTimedOut,
    #[error("온라인 카탈로그의 다른 요청이 처리 중입니다")]
    CatalogTransportBusy,
    #[error("온라인 카탈로그에 연결할 수 없습니다")]
    CatalogTransportUnavailable,
    #[error("온라인 카탈로그 갱신 간격은 60초 이상이어야 합니다")]
    InvalidCatalogUpdateInterval,
    #[error("온라인 작품의 이미지 목록이 올바르지 않습니다")]
    InvalidRemoteGallery,
    #[error("온라인 작품의 이미지 목록을 가져올 수 없습니다")]
    RemoteGalleryUnavailable,
    #[error("온라인 작품의 읽기 위치가 올바르지 않습니다")]
    InvalidRemoteReadingProgress,
    #[error("온라인 카탈로그 파일 작업에 실패했습니다: {path}")]
    OnlineCatalogImport {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
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
    #[error("외부 제공자와 ID는 비어 있을 수 없습니다")]
    InvalidExternalBinding,
    #[error("같은 이름의 컬렉션이 있습니다")]
    DuplicateCollectionName,
    #[error("대표 이미지는 컬렉션에 속한 정상 자산이어야 합니다")]
    CollectionCoverNotMember,
    #[error("지원하지 않는 컬렉션 유형입니다")]
    InvalidCollectionType,
    #[error("출시·출간·개봉일은 YYYY-MM-DD 형식이어야 합니다")]
    InvalidCollectionReleaseDate,
    #[error("개인 별점은 0점에서 5점 사이의 0.5점 단위여야 합니다")]
    InvalidPersonalRating,
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
    #[error("분류, 앨범, 컬렉션 범위는 한 번에 하나만 조회할 수 있습니다")]
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
    #[error("구버전 Lakomics 패키지를 읽을 수 없습니다: {path}")]
    ReadLegacyPackage {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("구버전 Lakomics 패키지가 올바르지 않습니다: {0}")]
    InvalidLegacyPackage(String),
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
    #[error("Work 표지 이미지가 올바르지 않습니다")]
    InvalidWorkArtwork,
    #[error("Work 표지 파일을 쓸 수 없습니다: {path}")]
    WriteWorkArtwork {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("MangaDex 검색어는 두 글자 이상이어야 합니다")]
    InvalidMangaDexQuery,
    #[error("MangaDex 식별자가 올바르지 않습니다")]
    InvalidMangaDexIdentity,
    #[error("MangaDex에 연결할 수 없습니다")]
    MangaDexUnavailable,
    #[error("MangaDex 요청 시간이 초과됐습니다")]
    MangaDexTimedOut,
    #[error("MangaDex 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요")]
    MangaDexRateLimited,
    #[error("MangaDex 작품을 찾을 수 없습니다")]
    MangaDexNotFound,
    #[error("MangaDex 응답을 처리할 수 없습니다")]
    InvalidMangaDexResponse,
    #[error("이 MangaDex 작품은 이미 다른 Work에 연결되어 있습니다")]
    DuplicateProviderBinding,
    #[error("알라딘 검색어는 두 글자 이상이어야 합니다")]
    InvalidAladinQuery,
    #[error("알라딘 TTB 키가 올바르지 않습니다")]
    InvalidAladinCredential,
    #[error("알라딘 TTB 키가 설정되지 않았습니다")]
    AladinCredentialNotConfigured,
    #[error("알라딘 TTB 키는 비어 있을 수 없습니다")]
    InvalidAladinCredentialValue,
    #[error("이 운영체제에서는 보안 자격 증명 저장소를 사용할 수 없습니다")]
    CredentialStoreUnavailable,
    #[error("보안 자격 증명 저장소 작업에 실패했습니다")]
    CredentialStoreFailed,
    #[error("IGDB Client ID 또는 Client Secret이 올바르지 않습니다")]
    InvalidIgdbCredential,
    #[error("IGDB 자격 증명이 설정되지 않았습니다")]
    IgdbCredentialNotConfigured,
    #[error("IGDB 자격 증명 값은 비어 있을 수 없습니다")]
    InvalidIgdbCredentialValue,
    #[error("IGDB 요청이 올바르지 않습니다")]
    IgdbInvalidRequest,
    #[error("IGDB 인증이 거부됐습니다")]
    IgdbUnauthorized,
    #[error("IGDB 작품을 찾을 수 없습니다")]
    IgdbNotFound,
    #[error("IGDB 요청 한도를 초과했습니다")]
    IgdbRateLimited,
    #[error("IGDB에 연결할 수 없습니다")]
    IgdbUnavailable,
    #[error("IGDB 응답을 처리할 수 없습니다")]
    IgdbInvalidResponse,
    #[error("IGDB 이미지 식별자가 올바르지 않습니다")]
    IgdbInvalidImageId,
    #[error("알라딘에 연결할 수 없습니다")]
    AladinUnavailable,
    #[error("알라딘 요청 시간이 초과됐습니다")]
    AladinTimedOut,
    #[error("알라딘 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요")]
    AladinRateLimited,
    #[error("알라딘 응답을 처리할 수 없습니다")]
    InvalidAladinResponse,
    #[error("기존 알라딘 연결과 같은 시리즈를 확실하게 찾을 수 없습니다")]
    AmbiguousAladinBinding,
    #[error("만화 컬렉션을 알라딘에 연결한 뒤 신간 알림을 켤 수 있습니다")]
    ReleaseWatchRequiresAladinBinding,
    #[error("이 알라딘 상품은 이미 다른 Work에 연결되어 있습니다")]
    DuplicateAladinProviderItem,
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
    #[error("컬렉션 소스 루트가 설정되지 않았습니다")]
    CollectionSourceRootNotSet,
    #[error("컬렉션에 소스 경로가 설정되지 않았습니다")]
    CollectionSourcePathNotSet,
    #[error("망가 시리즈를 찾을 수 없습니다")]
    MangaSeriesNotFound,
}
