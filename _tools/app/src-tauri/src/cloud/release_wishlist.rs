//! Wishlist transport: client intents and publisher handover use distinct credentials.
use super::{bearer, read_json_bounded, CloudClient};
use crate::library::error::LibraryError;
use serde_json::Value;

pub(crate) enum WishlistReply {
    Accepted(Value),
    Rejected(u16, String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn server_release_wishlist_http_uses_publisher_seed_and_client_intent_auth_and_exact_bodies() {
        let seed = json!({"version":1,"operationId":"11111111-1111-4111-8111-111111111111","expectedRevision":0,
            "expectedDigest":null,"libraryId":"fixture","endpoint":"https://fixture.test/","intentCursor":0,"items":[],"dates":[],"events":[]});
        let intent = json!({"version":1,"operationId":"22222222-2222-4222-8222-222222222222","itemId":"igdb:1","action":"add"});
        let (client, requests) =
            CloudClient::home_test_client(vec![json!({"version":1}), json!({"version":1})]);
        assert!(matches!(
            client
                .wishlist_send(true, &seed, "publisher-fixture")
                .unwrap(),
            WishlistReply::Accepted(_)
        ));
        assert!(matches!(
            client
                .wishlist_send(false, &intent, "client-fixture")
                .unwrap(),
            WishlistReply::Accepted(_)
        ));
        let requests = requests.lock().unwrap();
        let first = String::from_utf8(requests[0].clone()).unwrap();
        let second = String::from_utf8(requests[1].clone()).unwrap();
        assert!(first.starts_with("PUT /v1/home/upcoming/wishlist/handover "));
        assert!(first
            .to_ascii_lowercase()
            .contains("authorization: bearer publisher-fixture"));
        assert!(second.starts_with("POST /v1/home/upcoming/wishlist "));
        assert!(second
            .to_ascii_lowercase()
            .contains("authorization: bearer client-fixture"));
        assert_eq!(
            serde_json::from_str::<Value>(first.split_once("\r\n\r\n").unwrap().1).unwrap(),
            seed
        );
        assert_eq!(
            serde_json::from_str::<Value>(second.split_once("\r\n\r\n").unwrap().1).unwrap(),
            intent
        );
    }
}

impl CloudClient {
    pub(crate) fn wishlist_send(
        &self,
        seed: bool,
        body: &Value,
        token: &str,
    ) -> Result<WishlistReply, LibraryError> {
        let _permit = self.send_permit()?;
        let path = if seed {
            "/v1/home/upcoming/wishlist/handover"
        } else {
            "/v1/home/upcoming/wishlist"
        };
        let request = if seed {
            self.coded_agent()?.put(self.endpoint(path)?)
        } else {
            self.coded_agent()?.post(self.endpoint(path)?)
        };
        let mut response = request
            .header("Authorization", bearer(token)?)
            .send_json(body)
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        let status = response.status().as_u16();
        let reply = read_json_bounded(&mut response, 64 * 1024)?;
        if status == 200 {
            Ok(WishlistReply::Accepted(reply))
        } else if status == 401 || status == 403 {
            Err(LibraryError::CloudUnauthorized)
        } else {
            Ok(WishlistReply::Rejected(
                status,
                reply["detail"]["code"]
                    .as_str()
                    .unwrap_or("wishlistRequestFailed")
                    .to_owned(),
            ))
        }
    }
}
