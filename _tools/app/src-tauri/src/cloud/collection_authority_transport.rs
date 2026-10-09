//! Bounded Collections authority transport; no staging or activation endpoints.
use super::*;
use serde_json::Value;

pub(crate) enum CollectionDelivery {
    Accepted(Value),
    Conflict(Value),
    Dropped(Value),
    Retry,
}

/// `POST /v1/collections/release-checks/run`. `Unavailable`: the server has no such check
/// (switch off, older server, no Kakao key, authority inactive) and the PC checks itself.
pub(crate) enum ReleaseCheckRun {
    Started(Value),
    Unavailable,
    RateLimited(Option<u64>),
}

fn definitive_refusal(status: u16, value: Option<Value>) -> Value {
    value.as_ref().map(|v| &v["detail"])
        .filter(|v| v["code"].is_string()).cloned().unwrap_or_else(|| {
            serde_json::json!({"code": if status == 413 { "collectionCommandTooLarge" } else { "invalidCollectionCommand" }})
        })
}

impl CloudClient {
    /// `GET /v1/collections/release-checks/status`; `None` while the server has the checks off.
    pub(crate) fn release_checks_status(&self, token: &str) -> Result<Option<Value>, LibraryError> {
        let mut response = self
            .coded_agent()?
            .get(self.endpoint("/v1/collections/release-checks/status")?)
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        match response.status().as_u16() {
            200 => read_json_bounded(&mut response, 256 * 1024).map(Some),
            404 => Ok(None),
            401 | 403 => Err(LibraryError::CloudUnauthorized),
            _ => Err(LibraryError::CloudRequestUnavailable),
        }
    }

    /// Wake the server's release checker for `provider` now.
    pub(crate) fn release_checks_run(
        &self,
        provider: &str,
        token: &str,
    ) -> Result<ReleaseCheckRun, LibraryError> {
        let _permit = self.send_permit()?;
        let mut response = self
            .coded_agent()?
            .post(self.endpoint("/v1/collections/release-checks/run")?)
            .header("Authorization", bearer(token)?)
            .send_json(&serde_json::json!({ "provider": provider }))
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        match response.status().as_u16() {
            200 => read_json_bounded(&mut response, 256 * 1024).map(ReleaseCheckRun::Started),
            404 | 409 | 503 => Ok(ReleaseCheckRun::Unavailable),
            429 => {
                let header = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.trim().parse::<u64>().ok());
                let body: Option<Value> = read_json_bounded(&mut response, 64 * 1024).ok();
                let detail = body.as_ref().and_then(|v| v["detail"]["retryAfter"].as_u64());
                Ok(ReleaseCheckRun::RateLimited(header.or(detail)))
            }
            401 | 403 => Err(LibraryError::CloudUnauthorized),
            _ => Err(LibraryError::CloudRequestUnavailable),
        }
    }

    pub(crate) fn collection_authority_read(
        &self,
        path: &str,
        token: &str,
    ) -> Result<Value, LibraryError> {
        let mut response = self
            .coded_agent()?
            .get(self.endpoint(path)?)
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        match response.status().as_u16() {
            200 => read_json_bounded(&mut response, 4 * 1024 * 1024),
            401 | 403 => Err(LibraryError::CloudUnauthorized),
            // Return the coded read refusal so reconciliation can restart a baseline.
            409 => read_json_bounded(&mut response, 64 * 1024),
            _ => Err(LibraryError::CloudRequestUnavailable),
        }
    }

    pub(crate) fn collection_authority_send(
        &self,
        payload: &Value,
        token: &str,
    ) -> Result<CollectionDelivery, LibraryError> {
        let _permit = self.send_permit()?;
        let mut response = self
            .coded_agent()?
            .put(self.endpoint("/v1/collections/authority/commands")?)
            .header("Authorization", bearer(token)?)
            .send_json(payload)
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        let status = response.status().as_u16();
        if matches!(status, 401 | 403) {
            return Err(LibraryError::CloudUnauthorized);
        }
        if status == 200 {
            return Ok(CollectionDelivery::Accepted(read_json_bounded(
                &mut response,
                4 * 1024 * 1024,
            )?));
        }
        // A proxy may reject the body before the API can return coded JSON.
        // These structural refusals are definitive even without that envelope.
        if matches!(status, 413 | 422) {
            let value: Option<Value> = read_json_bounded(&mut response, 64 * 1024).ok();
            return Ok(CollectionDelivery::Dropped(definitive_refusal(
                status, value,
            )));
        }
        if matches!(status, 404 | 409) {
            let value: Value = read_json_bounded(&mut response, 64 * 1024)?;
            let code = value["detail"]["code"]
                .as_str()
                .ok_or(LibraryError::InvalidCloudResponse)?;
            return Ok(
                if matches!(code, "workDeleted" | "assetTombstoned" | "workNotFound") {
                    CollectionDelivery::Dropped(value["detail"].clone())
                } else {
                    CollectionDelivery::Conflict(value["detail"].clone())
                },
            );
        }
        Ok(CollectionDelivery::Retry)
    }

    pub(crate) fn download_collection_artwork(
        &self,
        work: &str,
        artwork: &str,
        sha: &str,
        size: u64,
        mime: &str,
        destination: &std::path::Path,
        token: &str,
    ) -> Result<(), LibraryError> {
        // Reuse the legacy ticket route, which already reads the authority projection
        // when active, and the bounded restore downloader. Never send auth to blob URLs.
        let ticket = self.asset_request(
            &format!("/v1/collections/{work}/artworks/{artwork}/media-ticket"),
            Some(&serde_json::json!({"variant":"original"})),
            token,
        )?;
        if ticket["sha256"] != sha || ticket["size_bytes"] != size || ticket["content_type"] != mime
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        self.download_restore_media(
            &RestoreMediaTicket {
                asset_id: artwork.into(),
                variant: "original".into(),
                url: Some(
                    ticket["url"]
                        .as_str()
                        .ok_or(LibraryError::InvalidCloudResponse)?
                        .into(),
                ),
                size_bytes: Some(size),
                error: None,
            },
            destination,
        )?;
        Ok(())
    }

    /// A confirmed authority person, or `None` while the server has not published it.
    pub(crate) fn collection_authority_person(
        &self,
        person: &str,
        token: &str,
    ) -> Result<Option<Value>, LibraryError> {
        let mut response = self
            .coded_agent()?
            .get(self.endpoint(&format!("/v1/collections/people/{person}?authority=1"))?)
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        match response.status().as_u16() {
            200 => read_json_bounded(&mut response, 256 * 1024).map(Some),
            404 => Ok(None),
            401 | 403 => Err(LibraryError::CloudUnauthorized),
            _ => Err(LibraryError::CloudRequestUnavailable),
        }
    }

    pub(crate) fn download_person_portrait(
        &self,
        blob: &crate::cloud::collections::ArtworkBlob,
        token: &str,
    ) -> Result<Vec<u8>, LibraryError> {
        if blob.size_bytes > 5 * 1024 * 1024 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let ticket = self.asset_request(
            &format!("/v1/home/covers/{}/media-ticket", blob.sha256),
            Some(&serde_json::json!({})),
            token,
        )?;
        if ticket["sha256"] != blob.sha256
            || ticket["size_bytes"] != blob.size_bytes
            || ticket["content_type"] != blob.content_type
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let url = url::Url::parse(
            ticket["url"]
                .as_str()
                .ok_or(LibraryError::InvalidCloudResponse)?,
        )
        .map_err(|_| LibraryError::InvalidCloudResponse)?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(LibraryError::InvalidCloudResponse);
        }
        // Blob hosts never receive the API credential. The library checks length/hash.
        let mut response = self
            .agent
            .get(url.as_str())
            .call()
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(blob.size_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn av_inbox_requests_reject_other_routes_and_mismatched_bodies() {
        let client = CloudClient::new("https://fixture.invalid/").unwrap();
        let empty = serde_json::json!({});
        for (method, path, body) in [
            ("GET", "/v1/providers/status", None),
            ("GET", "/v1/captures/pending", None),
            ("POST", "/v1/av-inbox/x/retry", None),
            ("GET", "/v1/av-inbox/x", Some(&empty)),
            ("PUT", "/v1/av-inbox/x", None),
            ("POST", "/v1/av-lookups-other", Some(&empty)),
        ] {
            assert!(
                matches!(
                    client.av_inbox_request(method, path, body, "token", 16),
                    Err(LibraryError::InvalidCloudResponse)
                ),
                "{method} {path}"
            );
        }
    }

    #[test]
    fn collection_authority_av_inbox_hold_fences_every_post_before_transport() {
        let temp = tempfile::tempdir().unwrap();
        let library = crate::library::Library::open(temp.path().join("library")).unwrap();
        library.use_machine_settings(temp.path().join("machine.json"));
        let endpoint = "http://127.0.0.1";
        library.set_cloud_sync_hold(endpoint, true).unwrap();
        let client = CloudClient::with_gate(endpoint, library.sync_gate(endpoint).unwrap()).unwrap();
        for path in [
            "/v1/av-lookups",
            "/v1/av-inbox/id/artwork",
            "/v1/av-inbox/id/dismiss",
            "/v1/av-inbox/id/retry",
            "/v1/av-inbox/id/fix-code",
            "/v1/av-inbox/id/applied",
        ] {
            // Empty credentials would fail if transport construction were reached.
            assert!(
                matches!(
                    client.av_inbox_request("POST", path, Some(&serde_json::json!({})), "", 16),
                    Err(LibraryError::CloudSyncHeld)
                ),
                "{path}"
            );
        }
        // Reads follow ordinary authority reads and pass the send hold.
        assert!(matches!(
            client.av_inbox_request("GET", "/v1/av-inbox", None, "", 16),
            Err(LibraryError::CloudCredentialNotConfigured)
        ));
    }

    #[test]
    fn collection_authority_structural_refusals_keep_codes_and_handle_proxy_bodies() {
        for status in [413, 422] {
            assert_eq!(
                definitive_refusal(
                    status,
                    Some(serde_json::json!({"detail":{"code":"invalidCollectionCommand"}}))
                )["code"],
                "invalidCollectionCommand"
            );
            assert_eq!(
                definitive_refusal(status, None)["code"],
                if status == 413 {
                    "collectionCommandTooLarge"
                } else {
                    "invalidCollectionCommand"
                }
            );
            assert!(definitive_refusal(
                status,
                Some(serde_json::json!({"detail":"Unprocessable entity"}))
            )["code"]
                .is_string());
        }
    }
}

impl CloudClient {
    /// Provider reads share the API origin and credentials. Never follow redirects.
    pub(crate) fn stashdb_relay_request(
        &self,
        path: &str,
        body: Option<&Value>,
        token: &str,
        limit: usize,
    ) -> Result<crate::library::av_link::provider::HttpResponse, LibraryError> {
        if path != "/v1/providers/status" && !path.starts_with("/v1/providers/stashdb/") {
            return Err(LibraryError::InvalidCloudResponse);
        }
        // Writes honour the receive-only hold like every other authority send.
        let _permit = body.map(|_| self.send_permit()).transpose()?;
        let agent = self.coded_agent()?;
        let endpoint = self.endpoint(path)?;
        let mut response = if let Some(body) = body {
            agent
                .post(endpoint)
                .header("Authorization", bearer(token)?)
                .send_json(body)
        } else {
            agent
                .get(endpoint)
                .header("Authorization", bearer(token)?)
                .call()
        }
        .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        if bytes.len() > limit {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(crate::library::av_link::provider::HttpResponse {
            status,
            bytes,
            content_type,
        })
    }
}

impl CloudClient {
    /// Server AV inbox reads and actions plus the intake route used to migrate old local
    /// items. Same API origin and credentials as every other authority route; never follows
    /// redirects, and the path allowlist keeps provider traffic out of this helper.
    pub(crate) fn av_inbox_request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        token: &str,
        limit: usize,
    ) -> Result<crate::library::av_link::provider::HttpResponse, LibraryError> {
        let allowed = path == "/v1/av-inbox"
            || path.starts_with("/v1/av-inbox/")
            || path.starts_with("/v1/av-inbox?")
            || path == "/v1/av-lookups";
        if !allowed || !matches!(method, "GET" | "POST") || (method == "POST") != body.is_some() {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let _permit = body.map(|_| self.send_permit()).transpose()?;
        let agent = self.coded_agent()?;
        let endpoint = self.endpoint(path)?;
        let mut response = if let Some(body) = body {
            agent
                .post(endpoint)
                .header("Authorization", bearer(token)?)
                .send_json(body)
        } else {
            agent
                .get(endpoint)
                .header("Authorization", bearer(token)?)
                .call()
        }
        .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        if bytes.len() > limit {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(crate::library::av_link::provider::HttpResponse {
            status,
            bytes,
            content_type,
        })
    }
}
