//! Existing-work MangaDex binds use the durable server lane when advertised.
use serde::Serialize;
use serde_json::{json, Value};

use super::{collection_authority::server_mangadex_bind_advertised, error::LibraryError,
    models::{CollectionSummary, MangaDexApplyRequest, MangaDexApplyTarget, MangaDexSearchResult},
    server_bind_intents::ServerBindResult, Library};

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum MangaDexOperationResult {
    Local(CollectionSummary),
    Server {
        #[serde(flatten)]
        result: ServerBindResult,
        #[serde(skip_serializing_if = "Option::is_none")]
        collection: Option<CollectionSummary>,
    },
}

fn same_choice(left: &Value, right: &Value) -> bool {
    left["mangaId"].as_str().is_some() && left["mangaId"] == right["mangaId"]
}

impl Library {
    pub fn server_mangadex_binds_enabled(&self) -> Result<bool, LibraryError> {
        server_mangadex_bind_advertised(&*self.connection()?)
    }

    pub fn search_mangadex_routed(&self, query: &str, work: Option<&str>) -> Result<Vec<MangaDexSearchResult>, LibraryError> {
        if let Some(work) = work {
            if self.server_mangadex_binds_enabled()? || self.has_server_bind_intent(work, "mangadex")? {
                let (client, token) = self.authority_client()?.ok_or(LibraryError::CloudRequestUnavailable)?;
                let mut url = url::Url::parse("https://placeholder/v1/collections/bindings/search/mangadex")
                    .map_err(|_| LibraryError::InvalidCloudResponse)?;
                url.query_pairs_mut().append_pair("query", query);
                let value = client.collection_authority_read(&format!("{}?{}", url.path(), url.query().unwrap_or_default()), token.expose())?;
                if value["version"] != 1 || value["provider"] != "mangadex" { return Err(LibraryError::InvalidCloudResponse); }
                return serde_json::from_value(value["items"].clone()).map_err(|_| LibraryError::InvalidCloudResponse);
            }
        }
        self.search_mangadex(query)
    }

    pub fn apply_mangadex_routed(&self, request: MangaDexApplyRequest) -> Result<MangaDexOperationResult, LibraryError> {
        self.apply_mangadex_routed_with(request, &|request| self.apply_server_mangadex(request),
            &|request| self.apply_mangadex(request))
    }

    fn apply_mangadex_routed_with(&self, request: MangaDexApplyRequest,
        server: &dyn Fn(MangaDexApplyRequest) -> Result<MangaDexOperationResult, LibraryError>,
        local: &dyn Fn(MangaDexApplyRequest) -> Result<CollectionSummary, LibraryError>) -> Result<MangaDexOperationResult, LibraryError> {
        if let MangaDexApplyTarget::Existing { collection_id } = &request.target {
            if self.server_mangadex_binds_enabled()? || self.has_server_bind_intent(collection_id, "mangadex")? {
                return server(request);
            }
        }
        local(request).map(MangaDexOperationResult::Local)
    }

    fn apply_server_mangadex(&self, request: MangaDexApplyRequest) -> Result<MangaDexOperationResult, LibraryError> {
        let (client, token) = self.authority_client()?.ok_or(LibraryError::CloudRequestUnavailable)?;
        self.apply_server_mangadex_ready_with(request,
            &|| client.collection_authority_read("/v1/collections/bindings/status", token.expose()),
            &|body| client.collection_intent_post("/v1/collections/bindings/requests", body, token.expose()),
            &|| self.pull_bind_authority())
    }

    fn apply_server_mangadex_ready_with(&self, request: MangaDexApplyRequest,
        status: &dyn Fn() -> Result<Value, LibraryError>,
        post: &dyn Fn(&Value) -> Result<Value, LibraryError>,
        pull: &dyn Fn() -> Result<(), LibraryError>) -> Result<MangaDexOperationResult, LibraryError> {
        let MangaDexApplyTarget::Existing { collection_id } = &request.target else {
            return Err(LibraryError::InvalidMangaDexIdentity);
        };
        let manga_id = uuid::Uuid::parse_str(&request.manga_id)
            .map_err(|_| LibraryError::InvalidMangaDexIdentity)?.to_string();
        let replay = self.server_bind_intent_choice(collection_id, "mangadex")?
            .is_some_and(|old| same_choice(&old, &json!({"mangaId":manga_id})));
        if !replay {
            let status = status()?;
            if status["version"] != 1 { return Err(LibraryError::InvalidCloudResponse); }
            if status["mangadexApply"] != true {
                return Ok(MangaDexOperationResult::Server {
                    result: ServerBindResult {outcome:"failed".into(), message:Some("서버 연결을 준비 중입니다. 잠시 후 다시 시도해 주세요.".into())},
                    collection:None,
                });
            }
        }
        // Replay must precede readiness, including when mangadexApply is withdrawn.
        // An unresolved same-choice body goes straight to POST even while OFF.
        // Only a fresh choice requires the optional bindings-status capability.
        self.apply_server_mangadex_with(request, post, pull)
    }

    fn apply_server_mangadex_with(&self, request: MangaDexApplyRequest,
        post: &dyn Fn(&Value) -> Result<Value, LibraryError>,
        pull: &dyn Fn() -> Result<(), LibraryError>) -> Result<MangaDexOperationResult, LibraryError> {
        let MangaDexApplyTarget::Existing { collection_id } = request.target else {
            return Err(LibraryError::InvalidMangaDexIdentity);
        };
        let manga_id = uuid::Uuid::parse_str(&request.manga_id)
            .map_err(|_| LibraryError::InvalidMangaDexIdentity)?.to_string();
        let work_name;
        let title = match request.title.as_deref().map(str::trim).filter(|title| !title.is_empty()) {
            Some(title) => title,
            None => {
                work_name = self.get_collection(&collection_id)?.name;
                work_name.trim()
            }
        };
        if title.is_empty() { return Err(LibraryError::InvalidCollectionMetadata); }
        let title: String = title.chars().take(500).collect();
        let result = self.apply_server_bind_intent_with(&collection_id, "mangadex", json!({"mangaId":manga_id,"title":title}),
            &same_choice, post, pull)?;
        let collection = if result.outcome == "applied" { Some(self.get_collection(&collection_id)?) } else { None };
        Ok(MangaDexOperationResult::Server {result, collection})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::collection_authority::tests::{fixture, adopt, work};
    use std::cell::RefCell;

    const MANGA: &str = "11111111-1111-4111-8111-111111111111";
    fn request() -> MangaDexApplyRequest {
        MangaDexApplyRequest {target:MangaDexApplyTarget::Existing {collection_id:"w".into()}, manga_id:MANGA.into(),title:Some("Selected title".into())}
    }
    fn reply(body: &Value, state: &str) -> Value {
        json!({"version":1,"request":{"operationId":body["operationId"],"collectionId":body["collectionId"],"provider":"mangadex","executor":"server","state":state}})
    }
    fn advertise(library: &Library) {
        let id = library.library_id().unwrap();
        library.connection().unwrap().execute("INSERT INTO notes_state(key,value) VALUES('personProfileFieldsStatus',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [json!({"active":true,"libraryId":id,"epoch":1,"features":["serverMangaDexBinds"]}).to_string()]).unwrap();
    }

    #[test]
    fn posted_body_matches_server_shape_and_title_limits() {
        let (_temp, library, status) = fixture();
        adopt(&library, &status, json!({"works":[work("w",1)]}));
        let work_name = library.get_collection("w").unwrap().name;
        for (hint, expected_title) in [
            (Some("  Selected title  ".into()), "Selected title".to_owned()),
            (None, work_name.clone()),
            (Some(" \t ".into()), work_name),
            (Some("가".repeat(501)), "가".repeat(500)),
        ] {
            let mut selected = request();
            selected.title = hint;
            library.apply_server_mangadex_with(selected, &|body| {
                let operation_id = body["operationId"].as_str().unwrap();
                assert_eq!(operation_id.len(), 36);
                assert!(uuid::Uuid::parse_str(operation_id).is_ok());
                let title = body["choice"]["title"].as_str().unwrap();
                assert!((1..=500).contains(&title.chars().count()));
                assert_eq!(body, &json!({
                    "version":1,"operationId":operation_id,"collectionId":"w",
                    "provider":"mangadex","choice":{"mangaId":MANGA,"title":expected_title},
                    "expected":{"externalId":null}
                }));
                assert!(uuid::Uuid::parse_str(body["choice"]["mangaId"].as_str().unwrap()).is_ok());
                // A terminal reply clears the intent so each hint makes a fresh body.
                Ok(reply(body, "failed"))
            }, &|| panic!("failed request must not pull")).unwrap();
        }
    }

    #[test]
    fn response_loss_restart_and_withdrawal_replay_the_complete_body() {
        let (temp, library, status) = fixture();
        adopt(&library, &status, json!({"works":[work("w",1)]}));
        let captured = RefCell::new(Value::Null);
        assert!(library.apply_server_mangadex_with(request(), &|body| {
            *captured.borrow_mut()=body.clone(); Err(LibraryError::CloudRequestUnavailable)
        }, &|| panic!("unknown outcome")).is_err());
        let body = captured.into_inner();
        assert_eq!(body["expected"], json!({"externalId":null}));
        drop(library);
        let library = Library::open(temp.path()).unwrap();
        assert!(!library.server_mangadex_binds_enabled().unwrap());
        let mut retry_request = request();
        retry_request.title = Some("Changed display hint".into());
        let result = library.apply_mangadex_routed_with(retry_request, &|request| {
            library.apply_server_mangadex_ready_with(request, &|| panic!("replay before readiness"),
                &|retry| {assert_eq!(retry, &body); Ok(reply(retry,"applied"))}, &|| Ok(()))
        }, &|_| panic!("no local fetch after unknown outcome")).unwrap();
        assert!(matches!(result, MangaDexOperationResult::Server {result,collection:Some(collection)} if result.outcome=="applied" && collection.id=="w"));
        assert!(!library.has_server_bind_intent("w","mangadex").unwrap());
    }

    #[test]
    fn applied_requires_successful_pull_and_valid_correlated_reply() {
        let (_temp, library, status) = fixture();
        adopt(&library, &status, json!({"works":[work("w",1)]}));
        for field in ["operationId","collectionId","provider","executor","state"] {
            assert!(library.apply_server_mangadex_with(request(), &|body| {
                let mut value=reply(body,"applied"); value["request"][field]=json!("wrong"); Ok(value)
            }, &|| panic!("invalid reply must not pull")).is_err());
            assert!(library.has_server_bind_intent("w","mangadex").unwrap());
        }
        assert!(library.apply_server_mangadex_with(request(), &|body| Ok(reply(body,"applied")),
            &|| Err(LibraryError::CloudRequestUnavailable)).is_err());
        assert!(library.has_server_bind_intent("w","mangadex").unwrap());
    }

    #[test]
    fn pending_retains_intent_and_coded_refusal_clears_it_without_local_fallback() {
        let (_temp, library, status) = fixture();
        adopt(&library, &status, json!({"works":[work("w",1)]}));
        let result = library.apply_server_mangadex_with(request(), &|body| Ok(reply(body,"pending")), &|| panic!("pending")).unwrap();
        assert!(matches!(result,MangaDexOperationResult::Server {result,collection:None} if result.outcome=="pending"));
        assert!(library.has_server_bind_intent("w","mangadex").unwrap());
        let result = library.apply_server_mangadex_ready_with(request(), &|| panic!("replay before readiness"),
            &|_| Ok(json!({"detail":{"code":"mangadexApplyUnavailable","message":"unavailable"}})), &|| panic!("refused")).unwrap();
        assert!(matches!(result,MangaDexOperationResult::Server {result,..} if result.outcome=="failed"));
        assert!(!library.has_server_bind_intent("w","mangadex").unwrap());
    }

    #[test]
    fn fresh_choice_requires_mangadex_status_and_different_uuid_gets_a_new_id() {
        let (_temp, library, status) = fixture();
        adopt(&library, &status, json!({"works":[work("w",1)]}));
        let result = library.apply_server_mangadex_ready_with(request(), &|| Ok(json!({"version":1,"kakaoApply":true})),
            &|_| panic!("missing capability"), &|| panic!("unavailable")).unwrap();
        assert!(matches!(result,MangaDexOperationResult::Server {result,..} if result.outcome=="failed"));
        assert!(!library.has_server_bind_intent("w","mangadex").unwrap());
        let first = RefCell::new(Value::Null);
        library.apply_server_mangadex_ready_with(request(), &|| Ok(json!({"version":1,"mangadexApply":true})),
            &|body| {*first.borrow_mut()=body.clone(); Ok(reply(body,"pending"))}, &|| panic!("pending")).unwrap();
        let mut other=request(); other.manga_id="22222222-2222-4222-8222-222222222222".into();
        library.apply_server_mangadex_ready_with(other, &|| Ok(json!({"version":1,"mangadexApply":true})),
            &|body| {assert_ne!(body["operationId"],first.borrow()["operationId"]); Ok(reply(body,"pending"))}, &|| panic!("pending")).unwrap();
        assert!(same_choice(&json!({"mangaId":MANGA,"title":"old"}), &json!({"mangaId":MANGA,"title":"new","coverUrl":"hint"})));
    }

    #[test]
    fn intent_keys_isolate_endpoint_work_and_provider_and_preserve_kakao_keys() {
        use crate::cloud::models::CloudSyncConfig;
        let (_temp, library, status) = fixture();
        adopt(&library, &status, json!({"works":[work("w",1)]}));
        let kakao = library.server_bind_intent_key("w","kakao").unwrap();
        assert_eq!(kakao,"serverKakaoIntent::w");
        library.apply_server_mangadex_with(request(), &|body| Ok(reply(body,"pending")), &|| panic!("pending")).unwrap();
        assert!(!library.has_server_kakao_intent("w").unwrap());
        assert!(!library.has_server_bind_intent("other","mangadex").unwrap());
        let original = library.server_bind_intent_key("w","mangadex").unwrap();
        library.set_cloud_sync_config(CloudSyncConfig {enabled:false,api_base_url:Some("https://fixture.invalid".into())}).unwrap();
        assert_ne!(original,library.server_bind_intent_key("w","mangadex").unwrap());
        assert!(!library.has_server_bind_intent("w","mangadex").unwrap());
    }

    #[test]
    fn advertisement_never_falls_back_but_new_work_and_unadvertised_apply_stay_local() {
        let (_temp, library, status) = fixture();
        adopt(&library, &status, json!({"works":[work("w",1)]}));
        let local = |_: MangaDexApplyRequest| library.get_collection("w");
        assert!(matches!(library.apply_mangadex_routed_with(request(), &|_| panic!("not advertised"), &local).unwrap(), MangaDexOperationResult::Local(_)));
        advertise(&library);
        assert!(library.server_mangadex_binds_enabled().unwrap());
        assert!(library.apply_mangadex_routed_with(request(), &|_| Err(LibraryError::CloudRequestUnavailable), &|_| panic!("no fallback")).is_err());
        let new = MangaDexApplyRequest {target:MangaDexApplyTarget::New {name:"New".into()},manga_id:MANGA.into(),title:Some("Selected title".into())};
        assert!(matches!(library.apply_mangadex_routed_with(new, &|_| panic!("new work stays local"), &local).unwrap(), MangaDexOperationResult::Local(_)));
        assert!(!library.server_kakao_binds_enabled().unwrap());
    }
}
