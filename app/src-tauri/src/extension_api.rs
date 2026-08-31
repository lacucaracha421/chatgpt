use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;
use tiny_http::{Header, Request, Response, Server};
use uuid::Uuid;

use crate::{
    commands::AppState,
    library::{
        models::{ImportSource, IngestMediaRequest, IngestOutcome},
        Library, MAX_IMAGE_BYTES,
    },
};

pub const API_ADDRESS: &str = "127.0.0.1:32145";
pub const API_BASE_URL: &str = "http://127.0.0.1:32145";
pub const EXTENSION_ID: &str = "nclkmjmmlcdaeomgadndeangccfidfbk";
pub const EXTENSION_ORIGIN: &str = "chrome-extension://nclkmjmmlcdaeomgadndeangccfidfbk";
const MAX_JSON_BYTES: usize = 32 * 1024;
const MAX_REMOTE_VIDEO_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const TOKEN_FILE_NAME: &str = "extension-token.txt";

#[derive(Debug, Error, PartialEq, Eq)]
enum ApiError {
    #[error("request origin is not allowed")]
    ForbiddenOrigin,
    #[error("authorization failed")]
    Unauthorized,
    #[error("request body is too large")]
    BodyTooLarge,
    #[error("request body could not be read")]
    BodyRead,
    #[error("extension token could not be loaded")]
    TokenLoad,
    #[error("no library is open")]
    LibraryNotOpen,
    #[error("route not found")]
    NotFound,
    #[error("library operation failed")]
    Internal,
    #[error("ingestion request is invalid")]
    InvalidRequest,
    #[error("media URL is invalid")]
    InvalidMediaUrl,
    #[error("source URL is invalid")]
    InvalidSourceUrl,
    #[error("classification was not found")]
    ClassificationNotFound,
    #[error("download is too large")]
    DownloadTooLarge,
    #[error("download failed")]
    DownloadFailed,
    #[error("downloaded file is not a supported image")]
    UnsupportedImage,
}

#[derive(Clone, Default)]
pub struct ExtensionRuntime(Arc<RwLock<RuntimeStatus>>);

#[derive(Clone, Default)]
enum RuntimeStatus {
    #[default]
    Starting,
    Ready {
        token: String,
    },
    BindFailed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionConnection {
    pub base_url: &'static str,
    pub token: String,
    pub status: ConnectionStatus,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Ready,
    BindFailed,
}

impl ExtensionRuntime {
    pub fn connection(&self) -> ExtensionConnection {
        let status = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        match status {
            RuntimeStatus::Ready { token } => ExtensionConnection {
                base_url: API_BASE_URL,
                token,
                status: ConnectionStatus::Ready,
            },
            RuntimeStatus::Starting | RuntimeStatus::BindFailed => ExtensionConnection {
                base_url: API_BASE_URL,
                token: String::new(),
                status: ConnectionStatus::BindFailed,
            },
        }
    }

    fn mark_ready(&self, token: String) {
        *self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = RuntimeStatus::Ready { token };
    }

    fn mark_bind_failed(&self) {
        *self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = RuntimeStatus::BindFailed;
    }
}

pub(crate) fn start(app: AppHandle, state: AppState, runtime: ExtensionRuntime) {
    let config_dir = match app.path().app_config_dir() {
        Ok(path) => path,
        Err(_) => {
            runtime.mark_bind_failed();
            return;
        }
    };
    let token = match load_or_create_token(&config_dir) {
        Ok(token) => token,
        Err(_) => {
            runtime.mark_bind_failed();
            return;
        }
    };
    let server = match Server::http(API_ADDRESS) {
        Ok(server) => server,
        Err(_) => {
            runtime.mark_bind_failed();
            return;
        }
    };
    runtime.mark_ready(token.clone());
    let _ = thread::Builder::new()
        .name("lakomics-extension-api".into())
        .spawn(move || serve(app, server, state, token));
}

fn serve(app: AppHandle, server: Server, state: AppState, token: String) {
    // 영상 수집 한 건이 수 분 걸릴 수 있으므로 처리는 병렬이어야 한다.
    // 다만 무제한 스레드 스폰은 로컬 플러드 연결이 인증 검사 선점 전에
    // 스레드·메모리를 태울 수 있게 하므로 고정 워커 풀로 상한을 둔다.
    // 큐가 가득 차면 초과 연결은 버려진다(확장이 재시도). 큐 여유 64로
    // health·분류 같은 짧은 요청이 장기 수집에 막히지 않는다.
    let (sender, receiver) = std::sync::mpsc::sync_channel::<Request>(64);
    let receiver = Arc::new(Mutex::new(receiver));
    for worker in 0..8 {
        let app = app.clone();
        let state = state.clone();
        let token = token.clone();
        let receiver = receiver.clone();
        let _ = thread::Builder::new()
            .name(format!("lakomics-extension-worker-{worker}"))
            .spawn(move || {
                loop {
                    let request = { receiver.lock().unwrap_or_else(std::sync::PoisonError::into_inner).recv() };
                    let Ok(request) = request else { break };
                    handle_request(app.clone(), request, &state, &token);
                }
            });
    }
    for request in server.incoming_requests() {
        if sender.try_send(request).is_err() {
            continue;
        }
    }
}

fn handle_request(app: AppHandle, mut request: Request, state: &AppState, token: &str) {
    let method = request.method().as_str().to_owned();
    let path = request
        .url()
        .split('?')
        .next()
        .unwrap_or(request.url())
        .to_owned();
    let origin = request_header(&request, "Origin");
    let authorization = request_header(&request, "Authorization");
    let extension_id = request_header(&request, "X-Lakomics-Extension-Id");
    let body = if method == "POST" {
        match read_json_limited(request.as_reader()) {
            Ok(body) => body,
            Err(error) => {
                let _ = request.respond(api_error_response(error).into_tiny_http());
                return;
            }
        }
    } else {
        Vec::new()
    };
    let api_request = ApiRequest {
        method,
        path,
        origin,
        authorization,
        extension_id,
        body,
    };
    let library = state.current_library();
    let (response, outcome) = dispatch(api_request, library.as_ref(), token);
    if let Some(outcome) = outcome {
        let _ = app.emit("extension://ingestion", &outcome);
    }
    let _ = request.respond(response.into_tiny_http());
}

fn request_header(request: &Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str().to_owned())
}

#[derive(Debug)]
struct ApiRequest {
    method: String,
    path: String,
    origin: Option<String>,
    authorization: Option<String>,
    extension_id: Option<String>,
    body: Vec<u8>,
}

#[cfg(test)]
impl ApiRequest {
    fn get(path: &str, origin: &str, authorization: Option<&str>) -> Self {
        Self {
            method: "GET".into(),
            path: path.into(),
            origin: Some(origin.into()),
            authorization: authorization.map(str::to_owned),
            extension_id: Some(EXTENSION_ID.into()),
            body: Vec::new(),
        }
    }

    fn options(path: &str, origin: &str) -> Self {
        Self {
            method: "OPTIONS".into(),
            path: path.into(),
            origin: Some(origin.into()),
            authorization: None,
            extension_id: None,
            body: Vec::new(),
        }
    }
}

#[derive(Debug)]
struct ApiResponse {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}

impl ApiResponse {
    fn empty(status: u16) -> Self {
        Self {
            status,
            headers: cors_headers(),
            body: Vec::new(),
        }
    }

    fn json<T: Serialize>(status: u16, value: &T) -> Self {
        let mut headers = cors_headers();
        headers.push(("Content-Type", "application/json; charset=utf-8".into()));
        Self {
            status,
            headers,
            body: serde_json::to_vec(value).expect("API response models serialize"),
        }
    }

    #[cfg(test)]
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(field, _)| field.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn into_tiny_http(self) -> Response<std::io::Cursor<Vec<u8>>> {
        let mut response = Response::from_data(self.body).with_status_code(self.status);
        for (name, value) in self.headers {
            let header = Header::from_bytes(name.as_bytes(), value.as_bytes())
                .expect("static API headers are ASCII");
            response = response.with_header(header);
        }
        response
    }
}

#[derive(Serialize)]
struct ClassificationsResponse {
    entries: Vec<crate::library::models::ClassificationEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedXMediaResponse {
    keys: Vec<String>,
}

#[derive(Serialize)]
struct ErrorResponse {
    code: &'static str,
    message: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct XIngestionRequest {
    source: String,
    media_url: String,
    source_url: String,
    classification_id: String,
    // 확장이 트윗의 <time datetime>에서 추출한 게시 시각(RFC 3339). 구버전 확장에는 없다.
    #[serde(default)]
    published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct XIngestionResponse {
    status: IngestionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    review_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum IngestionStatus {
    Added,
    DuplicateTagged,
    DuplicateUnchanged,
    ExactDuplicate,
    ReviewPending,
}

trait ImageDownloader: Send + Sync {
    fn download(
        &self,
        media_url: &url::Url,
        destination: &Path,
        maximum_bytes: u64,
    ) -> Result<(), ApiError>;
}

struct UreqImageDownloader {
    agent: ureq::Agent,
}

impl UreqImageDownloader {
    fn new() -> Self {
        // 타임아웃 없이 대기하면 X CDN이 응답을 멈추는 순간
        // 이 API 서버 스레드가 영구 정지한다. 죽은 연결은 빨리 포기한다.
        let config = ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(300)))
            .build();
        Self {
            agent: config.into(),
        }
    }
}

impl ImageDownloader for UreqImageDownloader {
    fn download(
        &self,
        media_url: &url::Url,
        destination: &Path,
        maximum_bytes: u64,
    ) -> Result<(), ApiError> {
        let mut response = self
            .agent
            .get(media_url.as_str())
            .call()
            .map_err(|_| ApiError::DownloadFailed)?;
        if !response.status().is_success() {
            return Err(ApiError::DownloadFailed);
        }
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .map_err(|_| ApiError::DownloadFailed)?;
        let mut reader = response
            .body_mut()
            .with_config()
            .limit(maximum_bytes + 1)
            .reader();
        let copied = io::copy(&mut reader, &mut output).map_err(|_| ApiError::DownloadFailed)?;
        if copied > maximum_bytes {
            return Err(ApiError::DownloadTooLarge);
        }
        output.flush().map_err(|_| ApiError::DownloadFailed)
    }
}

fn dispatch(request: ApiRequest, library: Option<&Library>, token: &str) -> (ApiResponse, Option<IngestOutcome>) {
    let error_to_pair = |error: ApiError| (api_error_response(error), None);
    if request.method == "OPTIONS" {
        if request.origin.as_deref() != Some(EXTENSION_ORIGIN) {
            return error_to_pair(ApiError::ForbiddenOrigin);
        }
        let mut response = ApiResponse::empty(204);
        response
            .headers
            .push(("Access-Control-Allow-Methods", "GET, POST, OPTIONS".into()));
        response.headers.push((
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, X-Lakomics-Extension-Id".into(),
        ));
        return (response, None);
    }

    if let Err(error) = authorize(
        request.origin.as_deref(),
        request.authorization.as_deref(),
        request.extension_id.as_deref(),
        token,
    ) {
        return error_to_pair(error);
    }

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v1/classifications") => {
            let Some(library) = library else {
                return error_to_pair(ApiError::LibraryNotOpen);
            };
            match library.list_classifications() {
                Ok(entries) => (ApiResponse::json(200, &ClassificationsResponse { entries }), None),
                Err(_) => error_to_pair(ApiError::Internal),
            }
        }
        ("GET", "/v1/saved-x-media") => {
            let Some(library) = library else {
                return error_to_pair(ApiError::LibraryNotOpen);
            };
            match library.saved_x_media_keys() {
                Ok(keys) => (ApiResponse::json(200, &SavedXMediaResponse { keys }), None),
                Err(_) => error_to_pair(ApiError::Internal),
            }
        }
        ("POST", "/v1/ingestions") => {
            let Some(library) = library else {
                return error_to_pair(ApiError::LibraryNotOpen);
            };
            let request = match serde_json::from_slice::<XIngestionRequest>(&request.body) {
                Ok(request) => request,
                Err(_) => return error_to_pair(ApiError::InvalidRequest),
            };
            match ingest_x_image(library, request, &UreqImageDownloader::new()) {
                Ok((response, outcome)) => (ApiResponse::json(200, &response), Some(outcome)),
                Err(error) => error_to_pair(error),
            }
        }
        _ => error_to_pair(ApiError::NotFound),
    }
}

impl Library {
    pub(crate) fn saved_x_media_keys(
        &self,
    ) -> Result<Vec<String>, crate::library::error::LibraryError> {
        let mut keys = BTreeSet::new();
        for source_url in self.list_normal_x_source_urls()? {
            if let Some(key) = x_photo_key(&source_url) {
                keys.insert(key);
            }
        }
        Ok(keys.into_iter().collect())
    }
}

fn x_photo_key(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https" || !matches!(url.host_str(), Some("x.com" | "twitter.com")) {
        return None;
    }
    let mut segments = url.path_segments()?;
    let _handle = segments.next()?;
    if segments.next()? != "status" {
        return None;
    }
    let tweet_id = segments.next()?;
    if tweet_id.is_empty() || !tweet_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if segments.next()? != "photo" {
        return None;
    }
    let photo_index = segments.next()?;
    let parsed_index = photo_index.parse::<u32>().ok()?;
    if parsed_index == 0 {
        return None;
    }
    Some(format!("{tweet_id}:{parsed_index}"))
}

fn ingest_x_image(
    library: &Library,
    request: XIngestionRequest,
    downloader: &dyn ImageDownloader,
) -> Result<(XIngestionResponse, IngestOutcome), ApiError> {
    if request.source != "x" || request.classification_id.trim().is_empty() {
        return Err(ApiError::InvalidRequest);
    }
    let classification_exists = library
        .list_classifications()
        .map_err(|_| ApiError::Internal)?
        .iter()
        .any(|entry| entry.id == request.classification_id);
    if !classification_exists {
        return Err(ApiError::ClassificationNotFound);
    }

    let media_url = validate_url(&request.media_url, &["pbs.twimg.com", "video.twimg.com"])
        .map_err(|_| ApiError::InvalidMediaUrl)?;
    let source_url = validate_url(&request.source_url, &["x.com", "twitter.com"])
        .map_err(|_| ApiError::InvalidSourceUrl)?;
    let (creator_handle, creator_url) = x_creator(&source_url)
        .map(|handle| {
            (
                Some(handle.to_owned()),
                Some(format!("https://x.com/{handle}")),
            )
        })
        .unwrap_or((None, None));

    let staging_directory = library.root().join("assets").join(".staging");
    fs::create_dir_all(&staging_directory).map_err(|_| ApiError::DownloadFailed)?;
    let (temporary_extension, maximum_bytes) = match media_url.host_str() {
        Some("pbs.twimg.com") => ("png", MAX_IMAGE_BYTES),
        Some("video.twimg.com") if media_url.path().to_ascii_lowercase().ends_with(".mp4") => {
            ("mp4", MAX_REMOTE_VIDEO_BYTES)
        }
        _ => return Err(ApiError::InvalidMediaUrl),
    };
    let temporary_path = staging_directory.join(format!(
        "remote-{}.{}",
        Uuid::new_v4(),
        temporary_extension
    ));
    let temporary = TemporaryDownload::new(temporary_path);
    downloader.download(&media_url, temporary.path(), maximum_bytes)?;

    // 게시 시각은 형식이 틀려도 수집 자체는 막지 않는다. 해석 불가면 빈 값으로 둔다.
    let source_published_at = request
        .published_at
        .filter(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok());
    let outcome = library
        .ingest_media(IngestMediaRequest {
            source_path: temporary.path().to_path_buf(),
            classification_id: Some(request.classification_id.clone()),
            source_url: Some(request.source_url),
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at,
            creator_name: None,
            creator_handle,
            creator_url,
            import_source: ImportSource::BrowserExtension,
            import_batch_id: Uuid::new_v4().to_string(),
        })
        .map_err(map_ingestion_error)?;
    let response = finish_ingestion(library, &request.classification_id, &outcome)?;
    Ok((response, outcome))
}

fn x_creator(url: &url::Url) -> Option<&str> {
    if !matches!(url.host_str(), Some("x.com" | "twitter.com")) {
        return None;
    }
    let mut segments = url.path_segments()?;
    let handle = segments.next()?;
    let status = segments.next()?;
    if handle.is_empty() || handle.eq_ignore_ascii_case("i") || status != "status" {
        return None;
    }
    Some(handle)
}

fn validate_url(value: &str, allowed_hosts: &[&str]) -> Result<url::Url, ()> {
    let parsed = url::Url::parse(value).map_err(|_| ())?;
    if parsed.scheme() != "https"
        || !parsed
            .host_str()
            .is_some_and(|host| allowed_hosts.contains(&host))
    {
        return Err(());
    }
    Ok(parsed)
}

fn finish_ingestion(
    _library: &Library,
    _classification_id: &str,
    outcome: &IngestOutcome,
) -> Result<XIngestionResponse, ApiError> {
    match outcome {
        IngestOutcome::Added { asset } => Ok(XIngestionResponse {
            status: IngestionStatus::Added,
            asset_id: Some(asset.id.clone()),
            review_id: None,
        }),
        IngestOutcome::ReviewPending { review_id } => Ok(XIngestionResponse {
            status: IngestionStatus::ReviewPending,
            asset_id: None,
            review_id: Some(review_id.clone()),
        }),
        IngestOutcome::ExactDuplicate {
            existing_asset_id,
            classification_changed,
            ..
        } => {
            let status = if *classification_changed {
                IngestionStatus::DuplicateTagged
            } else {
                IngestionStatus::DuplicateUnchanged
            };
            Ok(XIngestionResponse {
                status,
                asset_id: Some(existing_asset_id.clone()),
                review_id: None,
            })
        }
    }
}

fn map_ingestion_error(error: crate::library::error::LibraryError) -> ApiError {
    match error {
        crate::library::error::LibraryError::ClassificationNotFound => {
            ApiError::ClassificationNotFound
        }
        crate::library::error::LibraryError::UnsupportedImage => ApiError::UnsupportedImage,
        _ => ApiError::Internal,
    }
}

struct TemporaryDownload {
    path: PathBuf,
}

impl TemporaryDownload {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryDownload {
    fn drop(&mut self) {
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => {}
        }
    }
}

fn cors_headers() -> Vec<(&'static str, String)> {
    vec![
        ("Access-Control-Allow-Origin", EXTENSION_ORIGIN.into()),
        ("Vary", "Origin".into()),
    ]
}

fn api_error_response(error: ApiError) -> ApiResponse {
    let (status, code, message) = match error {
        ApiError::ForbiddenOrigin => (403, "forbidden_origin", "Request origin is not allowed."),
        ApiError::Unauthorized => (401, "unauthorized", "Extension connection key is invalid."),
        ApiError::BodyTooLarge => (413, "body_too_large", "Request body is too large."),
        ApiError::BodyRead => (400, "invalid_body", "Request body could not be read."),
        ApiError::TokenLoad => (500, "token_unavailable", "Extension key is unavailable."),
        ApiError::LibraryNotOpen => (409, "library_not_open", "Open a Lakomics library first."),
        ApiError::NotFound => (404, "not_found", "Route not found."),
        ApiError::Internal => (
            500,
            "internal_error",
            "Lakomics could not complete the request.",
        ),
        ApiError::InvalidRequest => (400, "invalid_request", "Ingestion request is invalid."),
        ApiError::InvalidMediaUrl => (400, "invalid_media_url", "X media URL is invalid."),
        ApiError::InvalidSourceUrl => (400, "invalid_source_url", "X source URL is invalid."),
        ApiError::ClassificationNotFound => (
            404,
            "classification_not_found",
            "Refresh classifications and select one again.",
        ),
        ApiError::DownloadTooLarge => (413, "download_too_large", "Image is too large."),
        ApiError::DownloadFailed => (502, "download_failed", "Image download failed."),
        ApiError::UnsupportedImage => (
            422,
            "unsupported_image",
            "Downloaded file is not a supported image.",
        ),
    };
    ApiResponse::json(status, &ErrorResponse { code, message })
}

fn load_or_create_token(config_dir: &Path) -> Result<String, ApiError> {
    fs::create_dir_all(config_dir).map_err(|_| ApiError::TokenLoad)?;
    let path = config_dir.join(TOKEN_FILE_NAME);
    let token = match OpenOptions::new().create_new(true).write(true).open(&path) {
        Ok(mut file) => {
            let token = Uuid::new_v4().simple().to_string();
            file.write_all(token.as_bytes())
                .and_then(|_| file.flush())
                .map_err(|_| ApiError::TokenLoad)?;
            token
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            fs::read_to_string(&path).map_err(|_| ApiError::TokenLoad)?
        }
        Err(_) => return Err(ApiError::TokenLoad),
    };
    if token.len() != 32
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(ApiError::TokenLoad);
    }
    Ok(token)
}

fn authorize(
    origin: Option<&str>,
    authorization: Option<&str>,
    extension_id: Option<&str>,
    token: &str,
) -> Result<(), ApiError> {
    if extension_id != Some(EXTENSION_ID) || origin.is_some_and(|value| value != EXTENSION_ORIGIN) {
        return Err(ApiError::ForbiddenOrigin);
    }
    let supplied = authorization
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized)?;
    if supplied != token {
        return Err(ApiError::Unauthorized);
    }
    Ok(())
}

fn read_json_limited<R: Read>(reader: R) -> Result<Vec<u8>, ApiError> {
    let mut limited = reader.take((MAX_JSON_BYTES + 1) as u64);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|_| ApiError::BodyRead)?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err(ApiError::BodyTooLarge);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn creator_handle_is_derived_only_from_account_status_urls() {
        let account = url::Url::parse("https://x.com/example/status/123").unwrap();
        let system = url::Url::parse("https://x.com/i/status/123").unwrap();
        let profile = url::Url::parse("https://x.com/example").unwrap();
        let unknown = url::Url::parse("https://example.com/example/status/123").unwrap();

        assert_eq!(x_creator(&account), Some("example"));
        assert_eq!(x_creator(&system), None);
        assert_eq!(x_creator(&profile), None);
        assert_eq!(x_creator(&unknown), None);
    }
    use crate::library::{
        models::{ClassificationKind, CreateClassification, IngestOutcome},
        Library,
    };

    #[test]
    fn creates_and_reuses_one_install_token() {
        let root = tempfile::tempdir().unwrap();
        let first = load_or_create_token(root.path()).unwrap();
        let second = load_or_create_token(root.path()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 32);
        assert!(first
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }

    #[test]
    fn requires_exact_origin_and_bearer_token() {
        assert!(authorize(
            Some(EXTENSION_ORIGIN),
            Some("Bearer abc"),
            Some(EXTENSION_ID),
            "abc"
        )
        .is_ok());
        assert!(authorize(None, Some("Bearer abc"), Some(EXTENSION_ID), "abc").is_ok());
        assert_eq!(
            authorize(
                Some("https://x.com"),
                Some("Bearer abc"),
                Some(EXTENSION_ID),
                "abc"
            ),
            Err(ApiError::ForbiddenOrigin)
        );
        assert_eq!(
            authorize(None, Some("Bearer abc"), None, "abc"),
            Err(ApiError::ForbiddenOrigin)
        );
        assert_eq!(
            authorize(
                Some(EXTENSION_ORIGIN),
                Some("Bearer wrong"),
                Some(EXTENSION_ID),
                "abc"
            ),
            Err(ApiError::Unauthorized)
        );
    }

    #[test]
    fn rejects_oversized_json_body() {
        let bytes = vec![b'x'; MAX_JSON_BYTES + 1];
        assert_eq!(
            read_json_limited(bytes.as_slice()).unwrap_err(),
            ApiError::BodyTooLarge
        );
    }

    #[test]
    fn classification_route_requires_auth_and_returns_existing_contract() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Character".into(),
                parent_id: None,
            })
            .unwrap();

        let unauthorized = dispatch(
            ApiRequest::get("/v1/classifications", EXTENSION_ORIGIN, None),
            Some(&library),
            "secret",
        );
        let (unauthorized, _) = unauthorized;
        assert_eq!(unauthorized.status, 401);

        let response = dispatch(
            ApiRequest::get(
                "/v1/classifications",
                EXTENSION_ORIGIN,
                Some("Bearer secret"),
            ),
            Some(&library),
            "secret",
        );
        let (response, outcome) = response;
        assert!(outcome.is_none());
        assert_eq!(response.status, 200);
        assert_eq!(
            response.header("Access-Control-Allow-Origin"),
            Some(EXTENSION_ORIGIN)
        );
        let json: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(json["entries"][0]["name"], "Character");
        assert!(json["entries"][0].get("parentId").is_some());
    }

    #[test]
    fn saved_x_media_route_returns_only_normal_photo_keys() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        let classification = create_root(&library, "Saved");
        let downloader = RecordingDownloader::new(png_bytes());
        let mut first = x_request(&classification.id);
        first.source_url = "https://x.com/example/status/123/photo/2".into();
        ingest_x_image(&library, first, &downloader).unwrap();

        let response = dispatch(
            ApiRequest::get(
                "/v1/saved-x-media",
                EXTENSION_ORIGIN,
                Some("Bearer secret"),
            ),
            Some(&library),
            "secret",
        );
        let (response, outcome) = response;
        assert!(outcome.is_none());
        assert_eq!(response.status, 200);
        let json: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(json["keys"], serde_json::json!(["123:2"]));
    }

    #[test]
    fn x_photo_key_rejects_ambiguous_post_and_video_urls() {
        assert_eq!(x_photo_key("https://x.com/u/status/123/photo/3").as_deref(), Some("123:3"));
        assert_eq!(x_photo_key("https://twitter.com/u/status/123/photo/1").as_deref(), Some("123:1"));
        assert_eq!(x_photo_key("https://x.com/u/status/123"), None);
        assert_eq!(x_photo_key("https://x.com/u/status/123/video/1"), None);
        assert_eq!(x_photo_key("https://example.com/u/status/123/photo/1"), None);
    }

    #[test]
    fn preflight_uses_fixed_cors_contract() {
        let response = dispatch(
            ApiRequest::options("/v1/classifications", EXTENSION_ORIGIN),
            None,
            "secret",
        );
        let (response, _) = response;
        assert_eq!(response.status, 204);
        assert_eq!(
            response.header("Access-Control-Allow-Origin"),
            Some(EXTENSION_ORIGIN)
        );
        assert_eq!(
            response.header("Access-Control-Allow-Methods"),
            Some("GET, POST, OPTIONS")
        );
        assert_eq!(
            response.header("Access-Control-Allow-Headers"),
            Some("Authorization, Content-Type, X-Lakomics-Extension-Id")
        );
    }

    #[test]
    fn route_errors_have_stable_status_and_json_codes() {
        let no_library = dispatch(
            ApiRequest::get(
                "/v1/classifications",
                EXTENSION_ORIGIN,
                Some("Bearer secret"),
            ),
            None,
            "secret",
        );
        let (no_library, _) = no_library;
        assert_eq!(no_library.status, 409);
        assert_eq!(json_code(&no_library), "library_not_open");

        let forbidden = dispatch(
            ApiRequest::get(
                "/v1/classifications",
                "https://x.com",
                Some("Bearer secret"),
            ),
            None,
            "secret",
        );
        let (forbidden, _) = forbidden;
        assert_eq!(forbidden.status, 403);
        assert_eq!(json_code(&forbidden), "forbidden_origin");

        let missing = dispatch(
            ApiRequest::get("/v1/missing", EXTENSION_ORIGIN, Some("Bearer secret")),
            None,
            "secret",
        );
        let (missing, _) = missing;
        assert_eq!(missing.status, 404);
        assert_eq!(json_code(&missing), "not_found");
    }

    #[test]
    fn ingestion_validates_classification_and_urls_before_downloading() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        let downloader = RecordingDownloader::new(png_bytes());

        let error = ingest_x_image(&library, x_request("missing"), &downloader).unwrap_err();
        assert_eq!(error, ApiError::ClassificationNotFound);
        assert_eq!(downloader.calls(), 0);

        let classification = create_root(&library, "Character");
        let mut invalid_host = x_request(&classification.id);
        invalid_host.media_url = "https://pbs.twimg.com.evil/media/ABC?format=png&name=orig".into();
        let error = ingest_x_image(&library, invalid_host, &downloader).unwrap_err();
        assert_eq!(error, ApiError::InvalidMediaUrl);
        assert_eq!(downloader.calls(), 0);
    }

    #[test]
    fn ingestion_records_the_extension_publish_timestamp() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        let classification = create_root(&library, "Timestamped");
        let downloader = RecordingDownloader::new(png_bytes());

        let mut request = x_request(&classification.id);
        request.published_at = Some("2026-08-01T10:20:30.000Z".into());
        let (response, _) = ingest_x_image(&library, request, &downloader).unwrap();
        assert_eq!(response.status, IngestionStatus::Added);
        let asset_id = response.asset_id.unwrap();
        assert_eq!(
            library.get_asset(&asset_id).unwrap().source_published_at.as_deref(),
            Some("2026-08-01T10:20:30.000Z")
        );

        // 게시 시각이 깨진 페이로드는 기록을 포기하고 수집은 진행한다.
        let mut broken = x_request(&classification.id);
        broken.published_at = Some("not-a-time".into());
        let (response, _) = ingest_x_image(&library, broken, &downloader).unwrap();
        assert_eq!(response.status, IngestionStatus::DuplicateUnchanged);
        let asset_id = response.asset_id.unwrap();
        assert_eq!(
            library.get_asset(&asset_id).unwrap().source_published_at.as_deref(),
            Some("2026-08-01T10:20:30.000Z")
        );
    }

    #[test]
    fn ingestion_moves_exact_duplicates_without_copying_again() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        let first_classification = create_root(&library, "First");
        let second_classification = create_root(&library, "Second");
        let downloader = RecordingDownloader::new(png_bytes());

        let added =
            ingest_x_image(&library, x_request(&first_classification.id), &downloader).unwrap();
        let added = added.0;
        assert_eq!(added.status, IngestionStatus::Added);
        let asset_id = added.asset_id.unwrap();
        assert_eq!(
            library.get_asset(&asset_id).unwrap().source_url.as_deref(),
            Some("https://x.com/example/status/123/photo/1")
        );

        let tagged =
            ingest_x_image(&library, x_request(&second_classification.id), &downloader).unwrap();
        let tagged = tagged.0;
        assert_eq!(tagged.status, IngestionStatus::DuplicateTagged);
        assert_eq!(tagged.asset_id.as_deref(), Some(asset_id.as_str()));

        let unchanged =
            ingest_x_image(&library, x_request(&second_classification.id), &downloader).unwrap();
        let unchanged = unchanged.0;
        assert_eq!(unchanged.status, IngestionStatus::DuplicateUnchanged);
        let ids: Vec<_> = library
            .get_asset_classifications(&asset_id)
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect();
        assert_eq!(ids, vec![second_classification.id]);
    }

    #[test]
    fn failed_image_ingestion_removes_remote_staging_file() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        let classification = create_root(&library, "Broken");
        let downloader = RecordingDownloader::new(b"not an image".to_vec());

        let error =
            ingest_x_image(&library, x_request(&classification.id), &downloader).unwrap_err();
        assert_eq!(error, ApiError::UnsupportedImage);
        let staging = library.root().join("assets").join(".staging");
        assert_eq!(fs::read_dir(staging).unwrap().count(), 0);
    }

    #[test]
    fn review_pending_outcome_preserves_the_review_id() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        let classification = create_root(&library, "Review");
        let response = finish_ingestion(
            &library,
            &classification.id,
            &IngestOutcome::ReviewPending {
                review_id: "review-1".into(),
            },
        )
        .unwrap();
        assert_eq!(response.status, IngestionStatus::ReviewPending);
        assert_eq!(response.review_id.as_deref(), Some("review-1"));
    }

    struct RecordingDownloader {
        bytes: Vec<u8>,
        calls: AtomicUsize,
    }

    impl RecordingDownloader {
        fn new(bytes: Vec<u8>) -> Self {
            Self {
                bytes,
                calls: AtomicUsize::new(0),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl ImageDownloader for RecordingDownloader {
        fn download(
            &self,
            _media_url: &url::Url,
            destination: &Path,
            _maximum_bytes: u64,
        ) -> Result<(), ApiError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            fs::write(destination, &self.bytes).map_err(|_| ApiError::DownloadFailed)
        }
    }

    fn create_root(library: &Library, name: &str) -> crate::library::models::ClassificationEntry {
        library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: name.into(),
                parent_id: None,
            })
            .unwrap()
    }

    fn x_request(classification_id: &str) -> XIngestionRequest {
        XIngestionRequest {
            source: "x".into(),
            media_url: "https://pbs.twimg.com/media/ABC?format=png&name=orig".into(),
            source_url: "https://x.com/example/status/123/photo/1".into(),
            classification_id: classification_id.into(),
            published_at: None,
        }
    }

    fn png_bytes() -> Vec<u8> {
        let image = image::RgbImage::from_pixel(4, 4, image::Rgb([32, 64, 96]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    fn json_code(response: &ApiResponse) -> String {
        let json: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
        json["code"].as_str().unwrap().to_owned()
    }
}
