//! Bounded Collections authority transport; no staging or activation endpoints.
use super::*;
use serde_json::Value;

pub(crate) enum CollectionDelivery {
    Accepted(Value),
    Conflict(Value),
    Dropped(Value),
    Retry,
}

fn definitive_refusal(status: u16, value: Option<Value>) -> Value {
    value.as_ref().map(|v| &v["detail"])
        .filter(|v| v["code"].is_string()).cloned().unwrap_or_else(|| {
            serde_json::json!({"code": if status == 413 { "collectionCommandTooLarge" } else { "invalidCollectionCommand" }})
        })
}

impl CloudClient {
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
