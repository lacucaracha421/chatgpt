//! Somi metadata uses the ordinary authenticated cloud client, never kone.
use super::*;
use crate::somi::shared::{Changes, Remote, Row};

pub(crate) struct SomiRemote<'a> {
    pub client: &'a CloudClient,
    pub token: &'a str,
}
impl SomiRemote<'_> {
    fn request<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<Option<T>, String> {
        let _permit = if body.is_some() {
            Some(self.client.send_permit().map_err(|_| "보내기 일시 중지")?)
        } else {
            None
        };
        let agent = self.client.agent_with_config(
            ureq::Agent::config_builder()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(SHORT_NETWORK_TIMEOUT))
                .build(),
        );
        let endpoint = self
            .client
            .endpoint(path)
            .map_err(|_| "클라우드 주소 오류")?;
        let auth = bearer(self.token).map_err(|_| "클라우드 인증 오류")?;
        let mut response = match body {
            Some(value) => agent
                .put(endpoint)
                .header("Authorization", auth)
                .content_type("application/json")
                .send(serde_json::to_vec(value).map_err(|_| "소미 요청 오류")?),
            None => agent.get(endpoint).header("Authorization", auth).call(),
        }
        .map_err(|_| "클라우드 연결 실패")?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        if response.status().as_u16() != 200 {
            return Err("소미 동기화 실패".into());
        }
        let bytes =
            read_body_bounded(&mut response, 3 * 1024 * 1024).map_err(|_| "소미 응답 오류")?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "소미 응답 오류".into())
    }
}
impl Remote for SomiRemote<'_> {
    fn push(&self, row: &Row) -> Result<Option<Row>, String> {
        self.request(
            &format!("/v1/somi/{}/{}", row.kind(), row.post_id),
            Some(&row.body()),
        )
    }
    fn pull(&self, since: i64) -> Result<Option<Changes>, String> {
        self.request(&format!("/v1/somi/state?since={since}"), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn somi_cloud_404_is_local_only_and_uses_ordinary_auth() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
        let worker = std::thread::spawn(move || {
            let request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert_eq!(request.url(), "/v1/somi/state?since=0");
            assert!(request
                .headers()
                .iter()
                .any(|h| h.field.equiv("Authorization")
                    && h.value.as_str() == "Bearer ordinary-client"));
            request.respond(tiny_http::Response::empty(404)).unwrap();
        });
        assert!(SomiRemote {
            client: &client,
            token: "ordinary-client"
        }
        .pull(0)
        .unwrap()
        .is_none());
        worker.join().unwrap();
    }
    #[test]
    fn somi_cloud_push_sends_only_contract_fields_and_decodes_winner() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
        let winner = serde_json::json!({"postId":"abcdefghijklmnopqrstuv","kind":"bookmark","revision":1,"changedAt":100,"bookmarked":true,"title":"Title","writerHandle":"writer","writerName":"Writer","coverKey":"","postSeconds":123});
        let row: Row = serde_json::from_value(winner.clone()).unwrap();
        let worker = std::thread::spawn(move || {
            let mut request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert_eq!(request.method(), &tiny_http::Method::Put);
            assert_eq!(request.url(), "/v1/somi/bookmarks/abcdefghijklmnopqrstuv");
            let body: serde_json::Value = serde_json::from_reader(request.as_reader()).unwrap();
            let mut expected = winner.clone();
            for key in ["postId", "kind", "revision"] {
                expected.as_object_mut().unwrap().remove(key);
            }
            assert_eq!(body, expected);
            request
                .respond(tiny_http::Response::from_string(winner.to_string()))
                .unwrap();
        });
        assert_eq!(
            SomiRemote {
                client: &client,
                token: "ordinary-client"
            }
            .push(&row)
            .unwrap(),
            Some(row)
        );
        worker.join().unwrap();
    }
}
