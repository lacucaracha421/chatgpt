//! 카탈로그 원격 전송원 (k-hentai 도달 경로의 유일한 교체 지점).
//!
//! Phase 1(CATALOG-001)에서 PC는 두 가지 전송 중 하나를 고른다.
//! - `WebView2CatalogSource`: 기존 동작. PC가 k-hentai.org에 직접 닿아야 한다.
//! - `VpsCatalogSource`: 같은 응답을 일본 VPS가 대신 받아 돌려준다. PC는 VPS에만
//!   닿으면 된다(한국에서도 안정). URL은 클라이언트가 임의로 지정할 수 없고
//!   작업 id/페이지 커서 숫자뿐이라 임의 프록시가 될 수 없다.
//!
//! 두 구현 모두 k-hentai 원본과 동일한 본문(갱신 JSON 배열 / 갤러리 HTML)을
//! 돌려야 하므로 파싱·저장 경로는 완전히 공유된다.

use crate::library::{error::LibraryError, models::CatalogLanguage};
use std::{io::Read, sync::LazyLock, time::Duration};

/// k-hentai 응답 본문의 상한. 갱신 페이지 JSON과 갤러리 HTML 모두에 적용한다.
const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;

/// 갤러리 한 건을 원격에서 그대로 가져오는 능력. 페이지 resolver가 이 트레이트만
/// 본다. 본문은 k-hentai 원본과 동일한 HTML이어야 한다(파서 공유).
pub(crate) trait CatalogSource {
    /// `work_id`는 k-hentai 게시글 id(=VCK Works.Id)뿐이다.
    fn fetch_gallery(&self, work_id: u64) -> Result<String, LibraryError>;
}

/// 본문 길이 상한을 공유하는 reader. 두 구현 모두 이 함수로 응답을 읽는다.
pub(crate) fn read_bounded_body(
    response: &mut ureq::http::Response<ureq::Body>,
) -> Result<String, LibraryError> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| LibraryError::CatalogTransportUnavailable)?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(LibraryError::InvalidCatalogTransportResponse);
    }
    String::from_utf8(bytes).map_err(|_| LibraryError::InvalidCatalogTransportResponse)
}

/// 일시적 전송 실패(네트워크·5xx·timeout)만 제한적으로 재시도한다. 4xx 같은
/// 영구 오류는 즉시 돌려 PC가 사용자 메시지로 표시하게 둔다. 상한 3회, 지수
/// backoff. VPS 자체가 일본 네트워크에서 재시도하므로 PC 측 재시도는 마지막 보루다.
pub(crate) async fn retry_transient<F>(mut fetch: F) -> Result<String, LibraryError>
where
    F: FnMut() -> Result<String, LibraryError>,
{
    const ATTEMPTS: usize = 3;
    let mut last_error: Option<LibraryError> = None;
    for attempt in 0..ATTEMPTS {
        match fetch() {
            Ok(body) => return Ok(body),
            Err(LibraryError::CatalogTransportRejected(status)) if status < 500 => {
                return Err(LibraryError::CatalogTransportRejected(status));
            }
            Err(error @ LibraryError::CatalogJapaneseTransportRequired) => return Err(error),
            Err(error) => {
                last_error = Some(error);
            }
        }
        if attempt + 1 < ATTEMPTS {
            let wait = std::time::Duration::from_millis(750 * (1 << attempt));
            tauri::async_runtime::spawn_blocking(move || std::thread::sleep(wait))
                .await
                .map_err(|_| LibraryError::CatalogTransportUnavailable)?;
        }
    }
    Err(last_error.unwrap_or(LibraryError::CatalogTransportUnavailable))
}

/// 전송 실패를 err로, 상태 코드 오류를 정규화한다. 404만 특수: 갤러리가
/// 없다는 것은 원격에 없음이며(WorkNotFound), 폐쇄된 갤러리 재시도가 무의미하다.
pub(crate) fn source_transport_error(error: ureq::Error) -> LibraryError {
    match error {
        ureq::Error::StatusCode(status) => {
            if status == 404 {
                LibraryError::OnlineCatalogWorkNotFound
            } else {
                LibraryError::CatalogTransportRejected(status)
            }
        }
        _ => LibraryError::CatalogTransportUnavailable,
    }
}

/// 일본 VPS를 통한 동일 본문 전송. PC는 k-hentai에 닿을 필요가 없다.
pub(crate) struct VpsCatalogSource {
    base_url: url::Url,
    agent: ureq::Agent,
}

const VPS_TIMEOUT: Duration = Duration::from_secs(60);

impl VpsCatalogSource {
    pub(crate) fn new(base_url: &str) -> Result<Self, LibraryError> {
        let parsed = url::Url::parse(base_url.trim())
            .map_err(|_| LibraryError::InvalidCatalogTransportPath)?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
        {
            return Err(LibraryError::InvalidCatalogTransportPath);
        }
        Ok(Self {
            agent: ureq::Agent::config_builder()
                .https_only(parsed.scheme() != "http")
                .max_redirects(0)
                .timeout_global(Some(VPS_TIMEOUT))
                .build()
                .into(),
            base_url: parsed,
        })
    }

    fn get(&self, path: &str, token: &str) -> Result<String, LibraryError> {
        self.get_with_language(path, token, None)
    }

    fn get_with_language(
        &self,
        path: &str,
        token: &str,
        language: Option<CatalogLanguage>,
    ) -> Result<String, LibraryError> {
        if token.trim().is_empty() {
            return Err(LibraryError::CloudCredentialNotConfigured);
        }
        let url = self
            .base_url
            .join(path.trim_start_matches('/'))
            .map_err(|_| LibraryError::InvalidCatalogTransportPath)?;
        let mut response = self
            .agent
            .get(url.as_str())
            .header("Authorization", format!("Bearer {}", token.trim()))
            .header(
                "User-Agent",
                format!("Lakomics/{}", env!("CARGO_PKG_VERSION")),
            )
            .call()
            .map_err(source_transport_error)?;
        match response.status().as_u16() {
            200 => {
                if language == Some(CatalogLanguage::Japanese)
                    && response
                        .headers()
                        .get("X-Lakomics-Catalog-Language")
                        .and_then(|value| value.to_str().ok())
                        != Some("japanese")
                {
                    return Err(LibraryError::CatalogJapaneseTransportRequired);
                }
                read_bounded_body(&mut response)
            }
            404 => Err(LibraryError::OnlineCatalogWorkNotFound),
            status => Err(LibraryError::CatalogTransportRejected(status)),
        }
    }

    /// 테스트와 토큰 주입 경로를 위한 갤러리 조회. `work_id`는 u64라서 경로
    /// 구획에 임의 문자열이 들어갈 수 없다.
    pub(crate) fn fetch_gallery_bearer(
        &self,
        work_id: u64,
        token: &str,
    ) -> Result<String, LibraryError> {
        self.get(&format!("/v1/catalog/gallery/{work_id}"), token)
    }

    /// VPS 카탈로그 API의 검색 페이지 경로. VPS 계약은 `/v1/catalog/search-page`
    /// + 숫자 `cursor` 뿐이고, k-hentai 업스트림 경로(`/ajax/search?...`)는 VPS가
    /// 내부적으로 번역한다. PC는 업스트림 URL을 몰라도 된다.
    pub(crate) fn search_page_path(cursor: Option<u64>) -> String {
        match cursor {
            Some(cursor) => format!("/v1/catalog/search-page?cursor={cursor}"),
            None => "/v1/catalog/search-page".to_owned(),
        }
    }

    /// 검색 페이지를 VPS API 경로로 조회. `cursor`는 u64라 경로 구획에 임의
    /// 문자열이 들어갈 수 없다(갤러리와 같은 SSRF 차단 원칙).
    pub(crate) fn fetch_search_page_bearer(
        &self,
        cursor: Option<u64>,
        token: &str,
    ) -> Result<String, LibraryError> {
        self.get(&Self::search_page_path(cursor), token)
    }

    pub(crate) fn fetch_search_page_for_language_bearer(
        &self,
        cursor: Option<u64>,
        language: CatalogLanguage,
        token: &str,
    ) -> Result<String, LibraryError> {
        if cursor.is_some_and(|cursor| cursor == 0 || cursor > i64::MAX as u64) {
            return Err(LibraryError::InvalidCatalogTransportPath);
        }
        let path = match language {
            CatalogLanguage::Korean => Self::search_page_path(cursor),
            CatalogLanguage::Japanese => {
                let mut path = "/v1/catalog/search-page?language=japanese".to_owned();
                if let Some(cursor) = cursor {
                    path.push_str(&format!("&cursor={cursor}"));
                }
                path
            }
        };
        self.get_with_language(&path, token, Some(language))
    }
}

impl CatalogSource for VpsCatalogSource {
    fn fetch_gallery(&self, work_id: u64) -> Result<String, LibraryError> {
        // 작업 id만 받는다. 클라이언트가 URL을 넘길 여지가 없다(SSRF 차단).
        let token = crate::library::credential::read_cloud_api_token_os()?;
        self.fetch_gallery_bearer(work_id, &token)
    }
}

/// 갤러리 resolver가 쓰는 공용 agent 설정(https-only, 리다이렉트 차단).
pub(crate) fn gallery_agent() -> &'static ureq::Agent {
    static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
        ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(30)))
            .build()
            .into()
    });
    &AGENT
}
