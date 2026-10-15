//! Publisher-token card cutout routes (CARD-GACHA-001 slice 4). The PC lists the art that
//! still needs a cutout, then uploads each result through a signed, exact-length PUT.
use super::{
    bearer, map_registration_error, map_upload_error, read_json_bounded, CloudClient,
    UPLOAD_BODY_TIMEOUT,
};
use crate::library::error::LibraryError;
use serde_json::{json, Value};

/// The model id the server accepts (`PrepareBody.model`); it is also part of the local cache key.
pub(crate) const MODEL_ID: &str = "toonout-1";
pub(crate) const MAX_CUTOUT_BYTES: u64 = 2 * 1024 * 1024;
const CANDIDATE_LIMIT: usize = 512 * 1024;
const MAX_CANDIDATES: usize = 2000;
const REPLY_LIMIT: usize = 16 * 1024;

pub(crate) fn valid_id(id: &str) -> bool {
    super::cards::valid_id(id)
}

/// One finished cutout, exactly as it will be (or was) uploaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UploadSpec {
    pub asset_id: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub content_type: String,
}

pub(crate) fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn prepare_body(spec: &UploadSpec) -> Result<Value, LibraryError> {
    if !valid_id(&spec.asset_id)
        || !valid_digest(&spec.sha256)
        || spec.size_bytes == 0
        || spec.size_bytes > MAX_CUTOUT_BYTES
        || !matches!(spec.content_type.as_str(), "image/webp" | "image/png")
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(json!({
        "assetId": spec.asset_id, "sha256": spec.sha256, "sizeBytes": spec.size_bytes,
        "contentType": spec.content_type, "model": MODEL_ID,
    }))
}

/// Asset ids in the order the server wants them (soonest need first); malformed or repeated
/// ids are dropped and the list is capped, so a bad reply cannot flood the queue.
pub(crate) fn parse_candidates(value: &Value) -> Result<Vec<String>, LibraryError> {
    let ids = value
        .get("assetIds")
        .and_then(Value::as_array)
        .ok_or(LibraryError::InvalidCloudResponse)?;
    let mut seen = std::collections::HashSet::new();
    Ok(ids
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| valid_id(id) && seen.insert(*id))
        .take(MAX_CANDIDATES)
        .map(str::to_owned)
        .collect())
}

/// Signed storage URLs are https. The in-memory test transport has no TLS, so tests alone may
/// use plain http to one reserved documentation address.
fn secure_scheme(url: &url::Url) -> bool {
    url.scheme() == "https"
        || (cfg!(test) && url.scheme() == "http" && url.host_str() == Some("203.0.113.7"))
}

/// What the server answered to `prepare`: nothing to upload, or the signed PUT to perform.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Prepared {
    Ready,
    Upload { url: String },
}

pub(crate) fn parse_prepared(value: &Value, spec: &UploadSpec) -> Result<Prepared, LibraryError> {
    let invalid = || LibraryError::InvalidCloudResponse;
    if value.get("assetId").and_then(Value::as_str) != Some(spec.asset_id.as_str()) {
        return Err(invalid());
    }
    let upload = value.get("upload").filter(|upload| !upload.is_null());
    match (value.get("state").and_then(Value::as_str), upload) {
        (Some("ready"), None) => Ok(Prepared::Ready),
        (Some("uploading"), Some(upload)) => {
            let url = upload
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            let parsed = url::Url::parse(url).map_err(|_| invalid())?;
            if upload.get("method").and_then(Value::as_str) != Some("PUT")
                || !secure_scheme(&parsed)
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.fragment().is_some()
            {
                return Err(invalid());
            }
            // The signature covers the content type and length; anything else is not ours.
            let headers = upload
                .get("requiredHeaders")
                .and_then(Value::as_object)
                .ok_or_else(invalid)?;
            for (name, value) in headers {
                let expected = match name.to_ascii_lowercase().as_str() {
                    "content-type" => spec.content_type.clone(),
                    "content-length" => spec.size_bytes.to_string(),
                    _ => return Err(invalid()),
                };
                if value.as_str() != Some(expected.as_str()) {
                    return Err(invalid());
                }
            }
            Ok(Prepared::Upload {
                url: url.to_owned(),
            })
        }
        _ => Err(invalid()),
    }
}

impl CloudClient {
    /// `GET /v1/cards/cutout-candidates` (publisher): art that needs a cutout, soonest first.
    pub(crate) fn card_cutout_candidates(&self, token: &str) -> Result<Vec<String>, LibraryError> {
        let mut response = self
            .agent
            .get(self.endpoint("/v1/cards/cutout-candidates")?)
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(map_registration_error)?;
        parse_candidates(&read_json_bounded::<Value>(&mut response, CANDIDATE_LIMIT)?)
    }

    /// prepare, then the signed PUT when the server asks for it, then complete.
    /// Idempotent: a retry after any step repeats only what is still missing.
    pub(crate) fn upload_card_cutout(
        &self,
        spec: &UploadSpec,
        bytes: &[u8],
        token: &str,
    ) -> Result<(), LibraryError> {
        let _send = self.send_permit()?;
        if bytes.len() as u64 != spec.size_bytes {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let body = serde_json::to_vec(&prepare_body(spec)?)
            .map_err(|_| LibraryError::InvalidCloudResponse)?;
        let mut response = self
            .agent
            .post(self.endpoint("/v1/cards/cutouts/prepare")?)
            .header("Authorization", bearer(token)?)
            .content_type("application/json")
            .send(&body)
            .map_err(map_registration_error)?;
        let reply = read_json_bounded::<Value>(&mut response, REPLY_LIMIT)?;
        let Prepared::Upload { url } = parse_prepared(&reply, spec)? else {
            return Ok(());
        };
        // Signed storage requests never carry the API token, cookies or redirects. ureq sets
        // Content-Length from the body, and Content-Type is the one signed header we add.
        let storage = self.agent_with_config(
            ureq::Agent::config_builder()
                .max_redirects(0)
                .timeout_global(Some(UPLOAD_BODY_TIMEOUT))
                .build(),
        );
        let put = storage
            .put(&url)
            .content_type(&spec.content_type)
            .send(bytes)
            .map_err(map_upload_error)?;
        if !put.status().is_success() {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let mut response = self
            .agent
            .post(self.endpoint(&format!("/v1/cards/cutouts/{}/complete", spec.asset_id))?)
            .header("Authorization", bearer(token)?)
            .send_empty()
            .map_err(map_registration_error)?;
        let done = read_json_bounded::<Value>(&mut response, REPLY_LIMIT)?;
        if done.get("state").and_then(Value::as_str) != Some("ready") {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> UploadSpec {
        UploadSpec {
            asset_id: "art-1".into(),
            sha256: "a".repeat(64),
            size_bytes: 5,
            content_type: "image/webp".into(),
        }
    }

    #[test]
    fn candidates_keep_the_servers_order_and_drop_bad_ids() {
        let ids =
            parse_candidates(&json!({"assetIds":["b","a","bad id","b","../x",7,"c"]})).unwrap();
        assert_eq!(ids, ["b", "a", "c"]);
        assert!(parse_candidates(&json!({})).is_err());
        assert!(parse_candidates(&json!({"assetIds":"a"})).is_err());
        let many: Vec<String> = (0..MAX_CANDIDATES + 10).map(|i| format!("a{i}")).collect();
        assert_eq!(
            parse_candidates(&json!({"assetIds":many})).unwrap().len(),
            MAX_CANDIDATES
        );
    }

    #[test]
    fn prepare_body_is_exact_and_bounded() {
        let body = prepare_body(&spec()).unwrap();
        assert_eq!(body["model"], "toonout-1");
        assert_eq!(body["sizeBytes"], 5);
        for bad in [
            UploadSpec {
                sha256: "A".repeat(64),
                ..spec()
            },
            UploadSpec {
                sha256: "a".repeat(63),
                ..spec()
            },
            UploadSpec {
                size_bytes: 0,
                ..spec()
            },
            UploadSpec {
                size_bytes: MAX_CUTOUT_BYTES + 1,
                ..spec()
            },
            UploadSpec {
                content_type: "image/jpeg".into(),
                ..spec()
            },
            UploadSpec {
                asset_id: "../x".into(),
                ..spec()
            },
        ] {
            assert!(prepare_body(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn prepared_reply_accepts_only_the_signed_put_of_this_cutout() {
        let upload = |url: &str, headers: Value| {
            json!({"assetId":"art-1","state":"uploading","upload":{
                "method":"PUT","url":url,"expiresIn":300,"requiredHeaders":headers}})
        };
        let good = upload(
            "https://r2.test/put",
            json!({"Content-Type":"image/webp","Content-Length":"5"}),
        );
        assert_eq!(
            parse_prepared(&good, &spec()).unwrap(),
            Prepared::Upload {
                url: "https://r2.test/put".into()
            }
        );
        assert_eq!(
            parse_prepared(
                &json!({"assetId":"art-1","state":"ready","upload":null}),
                &spec()
            )
            .unwrap(),
            Prepared::Ready
        );
        for bad in [
            upload("http://r2.test/put", json!({})),
            upload("https://user:pw@r2.test/put", json!({})),
            upload("https://r2.test/put", json!({"Content-Type":"image/png"})),
            upload("https://r2.test/put", json!({"Content-Length":"6"})),
            upload("https://r2.test/put", json!({"X-Other":"1"})),
            json!({"assetId":"other","state":"ready","upload":null}),
            json!({"assetId":"art-1","state":"uploading","upload":null}),
            json!({"assetId":"art-1","state":"ready","upload":{"method":"PUT","url":"https://r2.test/p","requiredHeaders":{}}}),
        ] {
            assert!(parse_prepared(&bad, &spec()).is_err(), "{bad}");
        }
    }

    #[test]
    fn upload_flow_prepares_puts_the_exact_bytes_and_completes() {
        // A literal address (the in-memory transport still resolves names) and no TLS.
        let (client, requests) = CloudClient::home_test_client(vec![
            json!({"assetId":"art-1","state":"uploading","upload":{
                "method":"PUT","url":"http://203.0.113.7/put","expiresIn":300,
                "requiredHeaders":{"Content-Type":"image/webp","Content-Length":"5"}}}),
            json!({}),
            json!({"assetId":"art-1","state":"ready"}),
        ]);
        client
            .upload_card_cutout(&spec(), b"hello", "publisher-secret")
            .unwrap();
        let seen = requests.lock().unwrap();
        let text: Vec<String> = seen
            .iter()
            .map(|r| String::from_utf8_lossy(r).to_string())
            .collect();
        assert_eq!(text.len(), 3);
        assert!(text[0].starts_with("POST /v1/cards/cutouts/prepare"));
        assert!(text[0]
            .to_lowercase()
            .contains("authorization: bearer publisher-secret"));
        assert!(text[0].contains("\"model\":\"toonout-1\""));
        assert!(text[1].starts_with("PUT /put"));
        assert!(text[1].to_lowercase().contains("content-type: image/webp"));
        assert!(text[1].to_lowercase().contains("content-length: 5"));
        assert!(text[1].ends_with("hello"));
        assert!(
            !text[1].to_lowercase().contains("authorization"),
            "storage never sees the API token"
        );
        assert!(text[2].starts_with("POST /v1/cards/cutouts/art-1/complete"));
    }

    #[test]
    fn a_ready_cutout_needs_no_upload_and_a_wrong_length_never_leaves() {
        let (client, requests) = CloudClient::home_test_client(vec![
            json!({"assetId":"art-1","state":"ready","upload":null}),
        ]);
        client.upload_card_cutout(&spec(), b"hello", "t").unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
        let (client, requests) = CloudClient::home_test_client(vec![]);
        assert!(client.upload_card_cutout(&spec(), b"hi", "t").is_err());
        assert!(requests.lock().unwrap().is_empty());
    }

    #[test]
    fn candidates_are_read_with_the_publisher_token() {
        let (client, requests) = CloudClient::home_test_client(vec![json!({"assetIds":["a","b"]})]);
        assert_eq!(
            client.card_cutout_candidates("publisher-secret").unwrap(),
            ["a", "b"]
        );
        let seen = requests.lock().unwrap();
        let request = String::from_utf8_lossy(&seen[0]).to_lowercase();
        assert!(request.starts_with("get /v1/cards/cutout-candidates"));
        assert!(request.contains("authorization: bearer publisher-secret"));
    }
}
