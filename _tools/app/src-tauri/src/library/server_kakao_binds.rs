//! Capability-gated Kakao intents. Unresolved intent bodies survive response loss and
//! feature withdrawal in notes_state; only a deliberate different selection replaces one.
use serde::Serialize;
use serde_json::{json, Value};
use super::{collection_authority::server_kakao_bind_advertised, error::LibraryError,
    models::{AladinApplyRequest, AladinSeriesCandidate, AladinSyncResult}, Library};

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum KakaoOperationResult {
    Local(AladinSyncResult),
    Server { outcome: String, message: Option<String> },
}

pub(super) fn same_selection(left: &Value, right: &Value) -> bool {
    fn selection(config: &Value) -> Option<(String, Vec<String>)> {
        let query = config["query"].as_str()?.to_owned();
        let mut groups = if let Some(groups) = config["groups"].as_array() {
            groups.iter().map(|g| g["groupFingerprint"].as_str().map(str::to_owned)).collect::<Option<Vec<_>>>()?
        } else { vec![config["groupFingerprint"].as_str()?.to_owned()] };
        groups.sort(); groups.dedup();
        Some((query, groups))
    }
    selection(left).is_some() && selection(left) == selection(right)
}

impl Library {
    pub fn server_kakao_binds_enabled(&self) -> Result<bool, LibraryError> {
        server_kakao_bind_advertised(&*self.connection()?)
    }

    pub fn has_server_kakao_intent(&self, work: &str) -> Result<bool, LibraryError> {
        self.has_server_bind_intent(work, "kakao")
    }

    pub fn search_server_kakao(&self, query: &str) -> Result<Vec<AladinSeriesCandidate>, LibraryError> {
        let (client, token) = self.authority_client()?.ok_or(LibraryError::CloudRequestUnavailable)?;
        let mut url = url::Url::parse("https://placeholder/v1/collections/bindings/search/kakao")
            .map_err(|_| LibraryError::InvalidCloudResponse)?;
        url.query_pairs_mut().append_pair("query", query);
        let value = client.collection_authority_read(&format!("{}?{}", url.path(), url.query().unwrap_or_default()), token.expose())?;
        if value["version"] != 1 || value["provider"] != "kakao" { return Err(LibraryError::InvalidCloudResponse); }
        serde_json::from_value(value["items"].clone()).map_err(|_| LibraryError::InvalidCloudResponse)
    }

    pub fn apply_server_kakao(&self, request: AladinApplyRequest) -> Result<KakaoOperationResult, LibraryError> {
        let (client, token) = self.authority_client()?.ok_or(LibraryError::CloudRequestUnavailable)?;
        self.apply_server_kakao_with(request, &|body| client.collection_intent_post(
            "/v1/collections/bindings/requests", body, token.expose()), &|| self.pull_bind_authority())
    }

    pub fn apply_kakao_routed(&self, request: AladinApplyRequest) -> Result<KakaoOperationResult, LibraryError> {
        self.apply_kakao_routed_with(request, &|request| self.apply_server_kakao(request), &|request| {
            let key = super::credential::read_kakao_key()?;
            self.apply_kakao(&key, request)
        })
    }

    fn apply_kakao_routed_with(&self, request: AladinApplyRequest,
        server: &dyn Fn(AladinApplyRequest) -> Result<KakaoOperationResult, LibraryError>,
        local: &dyn Fn(AladinApplyRequest) -> Result<AladinSyncResult, LibraryError>) -> Result<KakaoOperationResult, LibraryError> {
        if self.server_kakao_binds_enabled()? || self.has_server_kakao_intent(&request.collection_id)? {
            server(request)
        } else { local(request).map(KakaoOperationResult::Local) }
    }

    fn apply_server_kakao_with(&self, request: AladinApplyRequest,
        post: &dyn Fn(&Value) -> Result<Value, LibraryError>,
        pull: &dyn Fn() -> Result<(), LibraryError>) -> Result<KakaoOperationResult, LibraryError> {
        if request.groups.is_empty() || request.groups.len() > 10 || request.query.trim().chars().count() < 2 {
            return Err(LibraryError::InvalidAladinResponse);
        }
        let choice = json!({"query":request.query,"groups":request.groups,"title":request.query});
        let result = self.apply_server_bind_intent_with(&request.collection_id, "kakao", choice,
            &|left, right| left == right, post, pull)?;
        Ok(KakaoOperationResult::Server {outcome:result.outcome, message:result.message})
    }

    pub fn refresh_server_kakao(&self, work: &str) -> Result<KakaoOperationResult, LibraryError> {
        let (client, token) = self.authority_client()?.ok_or(LibraryError::CloudRequestUnavailable)?;
        let reply = client.collection_intent_post("/v1/collections/release-checks/run",
            &json!({"provider":"kakao","workId":work}), token.expose())?;
        refresh_reply(&reply, work, &|| self.pull_bind_authority())
    }
}

fn refresh_reply(reply: &Value, work: &str, pull: &dyn Fn() -> Result<(), LibraryError>) -> Result<KakaoOperationResult, LibraryError> {
    if reply["detail"]["code"].is_string() {
        return Ok(KakaoOperationResult::Server {outcome:"failed".into(),message:reply["detail"]["message"].as_str().map(str::to_owned)});
    }
    if reply["version"] != 1 || reply["provider"] != "kakao" || reply["workId"] != work {
        return Err(LibraryError::InvalidCloudResponse);
    }
    if reply["queued"] == true { return Ok(KakaoOperationResult::Server {outcome:"pending".into(),message:None}); }
    if reply["queued"] == false && reply["reason"] == "notDue" {
        // notDue says only that the daily window has not elapsed, never that this
        // particular refresh completed. Pull the existing confirmed projection.
        pull()?;
        return Ok(KakaoOperationResult::Server {outcome:"notDue".into(),message:None});
    }
    Err(LibraryError::InvalidCloudResponse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::collection_authority::tests::{fixture, adopt, work};
    use super::super::models::AladinGroupSelection;
    fn request() -> AladinApplyRequest { AladinApplyRequest {collection_id:"w".into(),query:"Series".into(),groups:vec![AladinGroupSelection{anchor_item_id:"anchor".into(),group_fingerprint:"fingerprint".into()}]} }
    #[test]
    fn lost_reply_replays_id_and_feature_withdrawal_never_allows_local_apply() {
        let (_temp, library, status) = fixture(); adopt(&library,&status,json!({"works":[work("w",1)]}));
        assert!(!library.server_kakao_binds_enabled().unwrap());
        let captured = std::cell::RefCell::new(Value::Null);
        assert!(library.apply_server_kakao_with(request(), &|body| { *captured.borrow_mut()=body.clone(); Err(LibraryError::CloudRequestUnavailable) }, &|| panic!("no confirmation")).is_err());
        assert!(library.has_server_kakao_intent("w").unwrap());
        let first = captured.borrow().clone();
        let result = library.apply_server_kakao_with(request(), &|body| {assert_eq!(body,&first); Ok(json!({"version":1,"request":{"operationId":body["operationId"],"collectionId":"w","provider":"kakao","executor":"server","state":"applied"}}))}, &|| Ok(())).unwrap();
        assert!(matches!(result,KakaoOperationResult::Server{outcome,..} if outcome=="applied"));
        assert!(!library.has_server_kakao_intent("w").unwrap());
    }
    #[test]
    fn completion_requires_pull_and_keeps_id_when_pull_fails() {
        let (_temp, library, status) = fixture(); adopt(&library,&status,json!({"works":[work("w",1)]}));
        assert!(library.apply_server_kakao_with(request(), &|body| Ok(json!({"version":1,"request":{"operationId":body["operationId"],"collectionId":"w","provider":"kakao","executor":"server","state":"applied"}})), &|| Err(LibraryError::CloudRequestUnavailable)).is_err());
        assert!(library.has_server_kakao_intent("w").unwrap());
    }
    #[test]
    fn refresh_queued_is_not_confirmed_and_not_due_pulls_existing_projection() {
        let base=json!({"version":1,"provider":"kakao","workId":"w","queued":true,"status":{"checked":99}});
        assert!(matches!(refresh_reply(&base,"w",&|| panic!("queued" )).unwrap(),KakaoOperationResult::Server{outcome,..} if outcome=="pending"));
        let mut done=base; done["queued"]=json!(false); done["reason"]=json!("notDue");
        assert!(refresh_reply(&done,"w",&|| Err(LibraryError::CloudRequestUnavailable)).is_err());
        assert!(matches!(refresh_reply(&done,"w",&|| Ok(())).unwrap(),KakaoOperationResult::Server{outcome,..} if outcome=="notDue"));
    }
    #[test]
    fn same_anchor_changed_groups_are_user_intent_and_history_is_not() {
        let a=json!({"query":"Series","groups":[{"anchorItemId":"a","groupFingerprint":"one","knownItemIds":["a"]}]});
        let mut b=a.clone(); b["groups"][0]["groupFingerprint"]=json!("two"); assert!(!same_selection(&a,&b));
        b=a.clone(); b["groups"][0]["knownItemIds"]=json!(["a","b"]); assert!(same_selection(&a,&b));
    }
    #[test]
    fn advertised_apply_never_fetches_locally_or_falls_back_after_unknown_outcome() {
        let (_temp, library, status) = fixture(); adopt(&library,&status,json!({"works":[work("w",1)]}));
        let id=library.library_id().unwrap();
        library.connection().unwrap().execute("INSERT INTO notes_state(key,value) VALUES('personProfileFieldsStatus',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [json!({"active":true,"libraryId":id,"epoch":1,"features":["serverKakaoBinds"]}).to_string()]).unwrap();
        assert!(library.server_kakao_binds_enabled().unwrap());
        let server=std::cell::Cell::new(0);
        assert!(library.apply_kakao_routed_with(request(), &|_| {server.set(server.get()+1); Err(LibraryError::CloudRequestUnavailable)}, &|_| panic!("local provider fetch forbidden")).is_err());
        assert_eq!(server.get(),1);
    }
    #[test]
    fn without_advertisement_apply_uses_the_unchanged_local_path() {
        let (_temp, library, status) = fixture(); adopt(&library,&status,json!({"works":[work("w",1)]}));
        let result=library.apply_kakao_routed_with(request(), &|_| panic!("unadvertised server route"), &|received| {
            assert_eq!(received,request()); Ok(AladinSyncResult{added:2,updated:0,unchanged:1,ignored:0})
        }).unwrap();
        assert!(matches!(result,KakaoOperationResult::Local(AladinSyncResult{added:2,..})));
        assert!(!library.has_server_kakao_intent("w").unwrap());
    }
}
