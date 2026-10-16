//! Client-token card routes. Responses and route parameters are bounded here.
use super::{bearer, map_registration_error, read_json_bounded, CloudClient};
use crate::library::error::LibraryError;
use serde_json::{json, Value};

pub(crate) const STATE_LIMIT: usize = 64 * 1024;
pub(crate) const DRAW_LIMIT: usize = 64 * 1024;
pub(crate) const ALBUM_LIMIT: usize = 512 * 1024;

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub(crate) fn open_body(pack: &str, operation: &str) -> Result<Value, LibraryError> {
    if !valid_pack(pack) || uuid::Uuid::parse_str(operation).is_err() {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(json!({"operationId": operation}))
}
fn valid_pack(pack: &str) -> bool {
    pack.len() == 10
        && matches!(pack.as_bytes()[0], b'd' | b'b')
        && pack.as_bytes()[1] == b'-'
        && pack.as_bytes()[2..].iter().all(u8::is_ascii_digit)
}
pub(crate) fn keep_body(pack: &str, operation: &str, slots: &[u8]) -> Result<Value, LibraryError> {
    let mut seen = [false; 5];
    for &slot in slots {
        match seen.get_mut(slot as usize) {
            Some(flag) if !*flag => *flag = true,
            _ => return Err(LibraryError::InvalidCloudResponse),
        }
    }
    if !valid_pack(pack) || uuid::Uuid::parse_str(operation).is_err() {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(json!({"operationId": operation, "slots": slots}))
}
/// Keeps only well-formed warm-up and keep hints. They are optional data for the client, so a
/// malformed entry is dropped instead of failing the whole state read.
pub(crate) fn sanitize_state(value: &mut Value) {
    const MAX_PACKS: usize = 8;
    const MAX_IDS: usize = 16;
    let ids = |entry: &Value, key: &str| -> Vec<Value> {
        entry
            .get(key)
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter(|id| id.as_str().is_some_and(valid_id))
                    .take(MAX_IDS)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    };
    let prefetch: Vec<Value> = value
        .get("prefetch")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|entry| {
                    entry
                        .get("packId")
                        .and_then(Value::as_str)
                        .is_some_and(valid_pack)
                })
                .take(MAX_PACKS)
                .map(|entry| {
                    json!({
                        "packId": entry["packId"],
                        "assetIds": ids(entry, "assetIds"),
                        "cutoutAssetIds": ids(entry, "cutoutAssetIds"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let pending: Vec<Value> = value
        .get("pendingKeep")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|entry| {
                    entry
                        .get("packId")
                        .and_then(Value::as_str)
                        .is_some_and(valid_pack)
                        && ["openedAt", "expiresAt"].iter().all(|key| {
                            entry
                                .get(*key)
                                .and_then(Value::as_str)
                                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                                .is_some()
                        })
                })
                .take(MAX_PACKS)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    value["prefetch"] = Value::Array(prefetch);
    value["pendingKeep"] = Value::Array(pending);
}
pub(crate) fn album_path(after: Option<&str>, limit: u16) -> Result<String, LibraryError> {
    if !(1..=200).contains(&limit)
        || after.is_some_and(|s| {
            s.is_empty()
                || s.len() > 512
                || !s
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'='))
        })
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    let mut path = format!("/v1/cards/album?limit={limit}");
    if let Some(after) = after {
        path.push_str("&after=");
        path.push_str(after);
    }
    Ok(path)
}

pub(crate) fn validate_cards(value: Value, draw: bool) -> Result<Value, LibraryError> {
    let cards = value
        .get("cards")
        .and_then(Value::as_array)
        .ok_or(LibraryError::InvalidCloudResponse)?;
    if (draw && cards.len() != 5) || cards.len() > 200 {
        return Err(LibraryError::InvalidCloudResponse);
    }
    for card in cards {
        for key in ["characterId", "artAssetId"] {
            if !card.get(key).and_then(Value::as_str).is_some_and(valid_id) {
                return Err(LibraryError::InvalidCloudResponse);
            }
        }
        if !matches!(
            card.get("tier").and_then(Value::as_str),
            Some("n" | "r" | "sr" | "ssr" | "ur" | "lr")
        ) || !card
            .get("count")
            .and_then(Value::as_u64)
            .is_some_and(|n| n > 0)
            || !card
                .get("level")
                .and_then(Value::as_u64)
                .is_some_and(|n| (1..=5).contains(&n))
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
    }
    if draw
        && (value
            .get("alreadyOpened")
            .and_then(Value::as_bool)
            .is_none()
            || value.get("packId").and_then(Value::as_str).is_none())
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    if !draw
        && (value.get("version").and_then(Value::as_u64) != Some(1)
            || value
                .get("nextCursor")
                .is_none_or(|v| !v.is_null() && !v.as_str().is_some_and(|s| s.len() <= 512)))
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(value)
}

impl CloudClient {
    fn card_get(&self, path: &str, token: &str, limit: usize) -> Result<Value, LibraryError> {
        let mut response = self
            .agent
            .get(self.endpoint(path)?)
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(map_registration_error)?;
        read_json_bounded(&mut response, limit)
    }
    fn card_post(
        &self,
        path: &str,
        body: Value,
        token: &str,
        limit: usize,
        mutating: bool,
    ) -> Result<Value, LibraryError> {
        // Download tickets only read; a sync hold must not block showing art.
        let _send = if mutating {
            Some(self.send_permit()?)
        } else {
            None
        };
        let bytes = serde_json::to_vec(&body).map_err(|_| LibraryError::InvalidCloudResponse)?;
        let mut response = self
            .agent
            .post(self.endpoint(path)?)
            .header("Authorization", bearer(token)?)
            .content_type("application/json")
            .send(&bytes)
            .map_err(map_registration_error)?;
        read_json_bounded(&mut response, limit)
    }
    pub(crate) fn card_state(&self, token: &str) -> Result<Value, LibraryError> {
        let mut value = self.card_get("/v1/cards/state", token, STATE_LIMIT)?;
        if value.get("version").and_then(Value::as_u64) != Some(1)
            || !value
                .get("unopened")
                .and_then(Value::as_array)
                .is_some_and(|p| p.len() <= 3)
            || value
                .get("nextResetAt")
                .and_then(Value::as_str)
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .is_none()
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        sanitize_state(&mut value);
        Ok(value)
    }
    /// Decides which opened cards enter the album; only those slots are sent.
    pub(crate) fn card_keep_pack(
        &self,
        pack: &str,
        operation: &str,
        slots: &[u8],
        token: &str,
    ) -> Result<Value, LibraryError> {
        let body = keep_body(pack, operation, slots)?;
        let value = validate_cards(
            self.card_post(
                &format!("/v1/cards/packs/{pack}/keep"),
                body,
                token,
                DRAW_LIMIT,
                true,
            )?,
            true,
        )?;
        if value["packId"] != pack {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(value)
    }
    /// An opened pack's stored cards with their kept flags; used to finish a pending keep.
    pub(crate) fn card_pack(&self, pack: &str, token: &str) -> Result<Value, LibraryError> {
        if !valid_pack(pack) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let value = validate_cards(
            self.card_get(&format!("/v1/cards/packs/{pack}"), token, DRAW_LIMIT)?,
            true,
        )?;
        if value["packId"] != pack {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(value)
    }
    pub(crate) fn card_open_pack(
        &self,
        pack: &str,
        operation: &str,
        token: &str,
    ) -> Result<Value, LibraryError> {
        let body = open_body(pack, operation)?;
        let value = validate_cards(
            self.card_post(
                &format!("/v1/cards/packs/{pack}/open"),
                body,
                token,
                DRAW_LIMIT,
                true,
            )?,
            true,
        )?;
        if value["packId"] != pack {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(value)
    }
    pub(crate) fn card_album(
        &self,
        after: Option<&str>,
        limit: u16,
        trashed: bool,
        token: &str,
    ) -> Result<Value, LibraryError> {
        let path = album_path(after, limit)? + if trashed { "&trashed=true" } else { "" };
        validate_cards(self.card_get(&path, token, ALBUM_LIMIT)?, false)
    }
    pub(crate) fn card_set_trashed(
        &self,
        character: &str,
        tier: &str,
        trashed: bool,
        token: &str,
    ) -> Result<Value, LibraryError> {
        if !valid_id(character) || !matches!(tier, "n" | "r" | "sr" | "ssr" | "ur" | "lr") {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let action = if trashed { "trash" } else { "restore" };
        self.card_post(
            &format!("/v1/cards/album/{character}/{tier}/{action}"),
            json!({}),
            token,
            STATE_LIMIT,
            true,
        )
    }
    pub(crate) fn card_ticket(
        &self,
        asset: &str,
        cutout: bool,
        token: &str,
    ) -> Result<String, LibraryError> {
        if !valid_id(asset) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let path = if cutout {
            format!("/v1/cards/cutouts/{asset}/ticket")
        } else {
            format!("/v1/library/assets/{asset}/media-ticket")
        };
        let value = self.card_post(
            &path,
            if cutout {
                json!({})
            } else {
                json!({"variant":"original"})
            },
            token,
            16 * 1024,
            false,
        )?;
        let url = value
            .get("url")
            .and_then(Value::as_str)
            .ok_or(LibraryError::InvalidCloudResponse)?;
        let parsed = url::Url::parse(url).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if parsed.scheme() != "https"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(url.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn card_parameters_are_bounded() {
        let operation = uuid::Uuid::new_v4().to_string();
        assert!(open_body("d-20261015", &operation).is_ok());
        for pack in ["", "../state", "d-2026x015", "x-20261015"] {
            assert!(open_body(pack, &operation).is_err());
        }
        assert!(open_body("b-20261015", "retry").is_err());
        assert!(album_path(Some("cursor&limit=999"), 50).is_err());
        assert!(album_path(Some(&"a".repeat(513)), 50).is_err());
        assert!(album_path(None, 0).is_err());
        assert!(album_path(None, 201).is_err());
        assert_eq!(
            album_path(Some("YQ"), 200).unwrap(),
            "/v1/cards/album?limit=200&after=YQ"
        );
    }
    #[test]
    fn keep_parameters_are_bounded_and_state_hints_are_sanitized() {
        let operation = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            keep_body("d-20261015", &operation, &[0, 3]).unwrap()["slots"],
            json!([0, 3])
        );
        assert!(keep_body("d-20261015", &operation, &[]).is_ok());
        for slots in [&[5u8][..], &[1, 1][..], &[0, 1, 2, 3, 4, 0][..]] {
            assert!(keep_body("d-20261015", &operation, slots).is_err());
        }
        assert!(keep_body("../x", &operation, &[0]).is_err());
        assert!(keep_body("d-20261015", "retry", &[0]).is_err());
        let mut state = json!({"version":1,
            "prefetch":[
                {"packId":"d-20261015","assetIds":["a1","bad id","a2"],"cutoutAssetIds":"no","tier":"lr"},
                {"packId":"../x","assetIds":["a3"]}],
            "pendingKeep":[
                {"packId":"b-20261015","openedAt":"2026-10-15T01:00:00+00:00","expiresAt":"2026-10-22T01:00:00+00:00"},
                {"packId":"d-20261014","openedAt":"soon","expiresAt":"later"}]});
        sanitize_state(&mut state);
        assert_eq!(
            state["prefetch"],
            json!([{"packId":"d-20261015","assetIds":["a1","a2"],"cutoutAssetIds":[]}])
        );
        assert_eq!(state["pendingKeep"].as_array().unwrap().len(), 1);
        let mut bare = json!({"version":1});
        sanitize_state(&mut bare);
        assert_eq!(bare["prefetch"], json!([]));
        assert_eq!(bare["pendingKeep"], json!([]));
    }
    #[test]
    fn card_transport_parses_server_cards_and_bounds_bodies() {
        let card = json!({"characterId":"c1","artAssetId":"a1","tier":"lr","count":2,"level":2});
        let draw = json!({"packId":"d-20261015","alreadyOpened":true,"cards":vec![card.clone();5]});
        let (client, requests) = CloudClient::home_test_client(vec![
            draw,
            json!({"version":1,"cards":[card],"nextCursor":null}),
            json!({"padding":"x".repeat(STATE_LIMIT)}),
            json!({"packId":"d-20261015","alreadyOpened":true,"alreadyKept":false,"cards":vec![card.clone();5]}),
            json!({"packId":"d-20261015","alreadyOpened":true,"cards":vec![card.clone();5]}),
        ]);
        assert_eq!(
            client
                .card_open_pack(
                    "d-20261015",
                    &uuid::Uuid::new_v4().to_string(),
                    "client-secret"
                )
                .unwrap()["alreadyOpened"],
            true
        );
        assert!(client.card_album(None, 50, false, "client-secret").is_ok());
        assert!(client.card_state("client-secret").is_err());
        let operation = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            client
                .card_keep_pack("d-20261015", &operation, &[0, 1], "client-secret")
                .unwrap()["alreadyKept"],
            false
        );
        assert!(client.card_pack("d-20261015", "client-secret").is_ok());
        assert!(client.card_pack("../state", "client-secret").is_err());
        let bytes = requests.lock().unwrap();
        let request = String::from_utf8_lossy(&bytes[0]);
        assert!(request.contains("/v1/cards/packs/d-20261015/open"));
        let seen = |needle: &str| {
            bytes
                .iter()
                .any(|chunk| String::from_utf8_lossy(chunk).contains(needle))
        };
        assert!(seen("POST /v1/cards/packs/d-20261015/keep"));
        assert!(seen("\"slots\":[0,1]"));
        assert!(seen("GET /v1/cards/packs/d-20261015 "));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer client-secret"));
        assert!(validate_cards(json!({"cards":[]}), true).is_err());
        assert!(validate_cards(
            json!({"version":1,"cards":vec![json!({});201],"nextCursor":null}),
            false
        )
        .is_err());
    }
    #[test]
    fn card_trash_transport_lists_and_mutates_the_selected_card() {
        let (client, requests) = CloudClient::home_test_client(vec![
            json!({"version":1,"cards":[],"nextCursor":null}),
            json!({"revision":2,"trashed":true}),
            json!({"revision":3,"trashed":false}),
        ]);
        assert!(client.card_album(None, 50, true, "client-secret").is_ok());
        assert_eq!(
            client
                .card_set_trashed("c1", "sr", true, "client-secret")
                .unwrap()["trashed"],
            true
        );
        assert_eq!(
            client
                .card_set_trashed("c1", "sr", false, "client-secret")
                .unwrap()["trashed"],
            false
        );
        let bytes = requests.lock().unwrap();
        let request = |i: usize| String::from_utf8_lossy(&bytes[i]).into_owned();
        assert!(request(0).contains("GET /v1/cards/album?limit=50&trashed=true "));
        assert!(request(1).contains("POST /v1/cards/album/c1/sr/trash "));
        assert!(request(2).contains("POST /v1/cards/album/c1/sr/restore "));
        for i in 0..3 {
            assert!(request(i)
                .to_lowercase()
                .contains("authorization: bearer client-secret"));
        }
    }
}
