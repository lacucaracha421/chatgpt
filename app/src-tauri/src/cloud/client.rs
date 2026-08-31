use std::{fs::File, io::Read, time::Duration};

use super::models::{
    AcknowledgeCaptureRequest, ClassificationSnapshotPublish, PreparedAssetUpload,
    PresignUploadRequest, PresignUploadResponse, RegisterAssetRequest,
    RemoteCaptureDownloadTicket, RemoteCapturePage, RemoteCapturePayload,
};
use crate::library::error::LibraryError;

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const SHORT_NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_BODY_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub(crate) struct CloudClient {
    agent: ureq::Agent,
    base_url: url::Url,
}

impl CloudClient {
    pub(crate) fn new(base_url: &str) -> Result<Self, LibraryError> {
        let parsed =
            url::Url::parse(base_url.trim()).map_err(|_| LibraryError::InvalidCloudSyncConfig)?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(LibraryError::InvalidCloudSyncConfig);
        }
        Ok(Self {
            agent: ureq::Agent::config_builder()
                .timeout_connect(Some(SHORT_NETWORK_TIMEOUT))
                .timeout_send_request(Some(SHORT_NETWORK_TIMEOUT))
                .timeout_send_body(Some(UPLOAD_BODY_TIMEOUT))
                .timeout_recv_response(Some(SHORT_NETWORK_TIMEOUT))
                .timeout_recv_body(Some(SHORT_NETWORK_TIMEOUT))
                .build()
                .into(),
            base_url: parsed,
        })
    }

    pub(crate) fn upload_asset(
        &self,
        asset: &PreparedAssetUpload,
        source: File,
        token: &str,
    ) -> Result<(), LibraryError> {
        let token = token.trim();
        if token.is_empty() {
            return Err(LibraryError::InvalidCloudCredentialValue);
        }
        let authorization = format!("Bearer {token}");
        let presign_body = serde_json::to_vec(&PresignUploadRequest {
            object_key: &asset.object_key,
            content_type: &asset.content_type,
        })
        .map_err(|_| LibraryError::InvalidCloudResponse)?;
        let mut response = self
            .agent
            .post(self.endpoint("/v1/uploads/presign")?)
            .header("Authorization", &authorization)
            .content_type("application/json")
            .send(&presign_body)
            .map_err(map_presign_error)?;
        let presign: PresignUploadResponse = read_json(&mut response)?;
        validate_presign(&presign, &asset.object_key)?;

        let mut request = self.agent.put(&presign.upload_url);
        for (name, value) in &presign.required_headers {
            let name = ureq::http::header::HeaderName::try_from(name.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            let value = ureq::http::header::HeaderValue::try_from(value.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            request = request.header(name, value);
        }
        request.send(source).map_err(map_upload_error)?;

        // Server contract: this is an idempotent upsert by asset id. Reusing the same
        // object key from a different asset id returns 409 and must not be retried.
        let registration_body = serde_json::to_vec(&RegisterAssetRequest {
            id: &asset.queue.entity_id,
            kind: &asset.kind,
            object_key: &presign.object_key,
            thumbnail_key: None,
            content_type: Some(&asset.content_type),
            size_bytes: Some(asset.size_bytes),
            sha256: Some(&asset.sha256),
        })
        .map_err(|_| LibraryError::InvalidCloudResponse)?;
        self.agent
            .post(self.endpoint("/v1/assets")?)
            .header("Authorization", authorization)
            .content_type("application/json")
            .send(&registration_body)
            .map_err(map_registration_error)?;
        Ok(())
    }
    /// 캡처 수신함의 pending capture 목록을 조회한다.
    pub(crate) fn list_pending_captures(
        &self,
        token: &str,
    ) -> Result<Vec<RemoteCapturePayload>, LibraryError> {
        let authorization = bearer(token)?;
        let mut response = self
            .agent
            .get(self.endpoint("/v1/captures/pending")?)
            .header("Authorization", authorization)
            .call()
            .map_err(map_capture_list_error)?;
        let page: RemoteCapturePage = read_json(&mut response)?;
        Ok(page.captures)
    }

    /// 캡처 미디어 다운로드 URL 발급을 요청한다.
    pub(crate) fn capture_download_ticket(
        &self,
        capture_id: &str,
        token: &str,
    ) -> Result<RemoteCaptureDownloadTicket, LibraryError> {
        let authorization = bearer(token)?;
        let mut response = self
            .agent
            .get(self.endpoint(&format!("/v1/captures/{capture_id}/download"))?)
            .header("Authorization", authorization)
            .call()
            .map_err(map_capture_ticket_error)?;
        let ticket: RemoteCaptureDownloadTicket = read_json(&mut response)?;
        validate_download_ticket(&ticket)?;
        Ok(ticket)
    }

    /// 캡처 미디어를 staging 경로에 크기 경계를 두고 내려받는다.
    pub(crate) fn download_capture_media(
        &self,
        ticket: &RemoteCaptureDownloadTicket,
        destination: &std::path::Path,
        maximum_bytes: u64,
    ) -> Result<u64, LibraryError> {
        let download_url =
            url::Url::parse(&ticket.download_url).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if !matches!(download_url.scheme(), "http" | "https") {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let mut request = self.agent.get(download_url.as_str());
        for (name, value) in &ticket.required_headers {
            let name = ureq::http::header::HeaderName::try_from(name.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            let value = ureq::http::header::HeaderValue::try_from(value.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            request = request.header(name, value);
        }
        let mut response = request.call().map_err(map_capture_download_error)?;
        if !response.status().is_success() {
            return Err(LibraryError::CloudCaptureDownloadRejected(
                response.status().as_u16(),
            ));
        }
        let mut destination_file = File::create(destination).map_err(|_| LibraryError::CloudCaptureStagingFailed)?;
        let mut reader = response.body_mut().as_reader().take(maximum_bytes.saturating_add(1));
        let copied = std::io::copy(&mut reader, &mut destination_file)
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        if copied > maximum_bytes {
            return Err(LibraryError::CloudCaptureTooLarge);
        }
        Ok(copied)
    }

    /// 로컬 수집이 확정된 캡처를 imported로 표시한다.
    pub(crate) fn acknowledge_capture_imported(
        &self,
        capture_id: &str,
        token: &str,
        imported_at: &str,
    ) -> Result<(), LibraryError> {
        let authorization = bearer(token)?;
        let body = serde_json::to_vec(&AcknowledgeCaptureRequest {
            imported_at: imported_at.to_string(),
        })
        .map_err(|_| LibraryError::InvalidCloudResponse)?;
        self.agent
            .post(self.endpoint(&format!("/v1/captures/{capture_id}/acknowledge"))?)
            .header("Authorization", authorization)
            .content_type("application/json")
            .send(&body)
            .map_err(map_capture_ack_error)?;
        Ok(())
    }


    /// 분류 스냅샷을 VPS에 게시한다. PC 라이브러리가 분류의 원본이며 VPS는
    /// 모바일 확장용 최소 스냅샷만 저장한다.
    pub(crate) fn publish_classification_snapshot(
        &self,
        token: &str,
        snapshot: &ClassificationSnapshotPublish,
    ) -> Result<(), LibraryError> {
        let authorization = bearer(token)?;
        let body =
            serde_json::to_vec(snapshot).map_err(|_| LibraryError::InvalidCloudResponse)?;
        self.agent
            .put(self.endpoint("/v1/classifications")?)
            .header("Authorization", authorization)
            .content_type("application/json")
            .send(&body)
            .map_err(|error| match error {
                ureq::Error::StatusCode(status) => {
                    LibraryError::CloudClassificationsPublishRejected(status)
                }
                ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
                _ => LibraryError::CloudRequestUnavailable,
            })?;
        Ok(())
    }

    fn endpoint(&self, path: &str) -> Result<String, LibraryError> {
        self.base_url
            .join(path)
            .map(|url| url.to_string())
            .map_err(|_| LibraryError::InvalidCloudSyncConfig)
    }
}

fn validate_presign(
    response: &PresignUploadResponse,
    requested_object_key: &str,
) -> Result<(), LibraryError> {
    let upload_url =
        url::Url::parse(&response.upload_url).map_err(|_| LibraryError::InvalidCloudResponse)?;
    if response.method != "PUT"
        || response.object_key != requested_object_key
        || response.expires_in == 0
        || !matches!(upload_url.scheme(), "http" | "https")
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(())
}

fn read_json<T: serde::de::DeserializeOwned>(
    response: &mut ureq::http::Response<ureq::Body>,
) -> Result<T, LibraryError> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| LibraryError::CloudRequestUnavailable)?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(LibraryError::InvalidCloudResponse);
    }
    serde_json::from_slice(&bytes).map_err(|_| LibraryError::InvalidCloudResponse)
}

fn map_presign_error(error: ureq::Error) -> LibraryError {
    map_api_error(error, LibraryError::CloudPresignRejected)
}

fn map_registration_error(error: ureq::Error) -> LibraryError {
    if matches!(error, ureq::Error::StatusCode(409)) {
        return LibraryError::CloudObjectKeyConflict;
    }
    map_api_error(error, LibraryError::CloudAssetRegistrationRejected)
}

fn map_api_error(error: ureq::Error, rejected: fn(u16) -> LibraryError) -> LibraryError {
    match error {
        ureq::Error::StatusCode(401 | 403) => LibraryError::CloudUnauthorized,
        ureq::Error::StatusCode(status) => rejected(status),
        ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
        _ => LibraryError::CloudRequestUnavailable,
    }
}

fn map_upload_error(error: ureq::Error) -> LibraryError {
    match error {
        ureq::Error::StatusCode(status) => LibraryError::CloudUploadRejected(status),
        ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
        _ => LibraryError::CloudRequestUnavailable,
    }
}

fn bearer(token: &str) -> Result<String, LibraryError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(LibraryError::CloudCredentialNotConfigured);
    }
    Ok(format!("Bearer {token}"))
}

fn validate_download_ticket(ticket: &RemoteCaptureDownloadTicket) -> Result<(), LibraryError> {
    if ticket.method != "GET" {
        return Err(LibraryError::InvalidCloudResponse);
    }
    url::Url::parse(&ticket.download_url)
        .and_then(|url| {
            if matches!(url.scheme(), "http" | "https") {
                Ok(())
            } else {
                Err(url::ParseError::RelativeUrlWithoutBase)
            }
        })
        .map_err(|_| LibraryError::InvalidCloudResponse)
}

fn map_capture_list_error(error: ureq::Error) -> LibraryError {
    map_api_error(error, LibraryError::CloudCaptureListRejected)
}

fn map_capture_ticket_error(error: ureq::Error) -> LibraryError {
    map_api_error(error, LibraryError::CloudCaptureTicketRejected)
}

fn map_capture_download_error(error: ureq::Error) -> LibraryError {
    match error {
        ureq::Error::StatusCode(status) => LibraryError::CloudCaptureDownloadRejected(status),
        ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
        _ => LibraryError::CloudRequestUnavailable,
    }
}

fn map_capture_ack_error(error: ureq::Error) -> LibraryError {
    map_api_error(error, LibraryError::CloudCaptureAcknowledgementRejected)
}
