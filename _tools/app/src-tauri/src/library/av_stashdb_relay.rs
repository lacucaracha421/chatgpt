// Included in av_stashdb. The direct provider implementation remains a fenced fallback.
use super::av_link::provider::HttpResponse;
use super::collection_authority::{
    collection_authority_active, collection_write_status, enqueue_person_profile,
    enqueue_person_profile_snapshot,
};
use crate::cloud::client::CloudClient;

pub(crate) trait StashdbRelay {
    fn request(
        &self,
        path: &str,
        body: Option<&Value>,
        limit: usize,
    ) -> Result<HttpResponse, AvError>;
}
pub(crate) struct StashdbRelaySession(CloudClient, super::credential::CloudCredential);
impl StashdbRelay for StashdbRelaySession {
    fn request(
        &self,
        path: &str,
        body: Option<&Value>,
        limit: usize,
    ) -> Result<HttpResponse, AvError> {
        Ok(self
            .0
            .stashdb_relay_request(path, body, self.1.expose(), limit)?)
    }
}
#[derive(Serialize)]
pub(crate) struct StashdbStatus {
    pub configured: bool,
    pub routed: bool,
    pub supported: bool,
}
fn unsupported() -> AvError {
    AvError::StashdbRelay(
        "av_stashdb_unsupported",
        "서버가 아직 StashDB 조회를 지원하지 않습니다.",
    )
}
fn missing_identity() -> AvError {
    AvError::StashdbRelay(
        "av_stashdb_identity_required",
        "StashDB 배우를 검색에서 다시 선택해 주세요.",
    )
}
fn relay_response(response: HttpResponse) -> Result<HttpResponse, AvError> {
    if response.status == 200 {
        return Ok(response);
    }
    let code = serde_json::from_slice::<Value>(&response.bytes)
        .ok()
        .and_then(|v| v["detail"]["code"].as_str().map(str::to_owned));
    if response.status == 404 && code.as_deref() != Some("providerNotFound") {
        return Err(unsupported());
    }
    Err(match code.as_deref() {
        Some("providerNotConfigured") => AvError::StashdbRelay(
            "av_stashdb_not_configured",
            "서버에 StashDB 키가 설정되지 않았습니다.",
        ),
        Some("providerBusy" | "providerRateLimited") => AvError::StashdbRelay(
            "av_stashdb_busy",
            "서버에서 StashDB를 조회하고 있습니다. 잠시 후 다시 시도해 주세요.",
        ),
        Some("providerNotFound") => AvError::StashdbRelay(
            "av_stashdb_not_found",
            "StashDB 배우 또는 사진을 찾지 못했습니다. 다시 선택해 주세요.",
        ),
        _ if matches!(response.status, 401 | 403) => {
            AvError::Library(super::error::LibraryError::CloudUnauthorized)
        }
        _ => AvError::StashdbRelay(
            "av_stashdb_unavailable",
            "서버에서 StashDB 정보를 불러오지 못했습니다. 다시 시도해 주세요.",
        ),
    })
}
pub(super) fn relay_json(
    relay: &impl StashdbRelay,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, AvError> {
    let response = relay_response(relay.request(path, body, MAX_JSON)?)?;
    serde_json::from_slice(&response.bytes).map_err(|_| AvError::Invalid)
}
fn relay_status(relay: &impl StashdbRelay) -> Result<StashdbStatus, AvError> {
    let response = relay.request("/v1/providers/status", None, MAX_JSON)?;
    if response.status == 404 {
        return Ok(StashdbStatus {
            configured: false,
            routed: true,
            supported: false,
        });
    }
    let value: Value =
        serde_json::from_slice(&relay_response(response)?.bytes).map_err(|_| AvError::Invalid)?;
    Ok(StashdbStatus {
        configured: value["stashdb"].as_bool().unwrap_or(false),
        routed: true,
        supported: value["stashdb"].is_boolean(),
    })
}
fn require_relay(relay: &impl StashdbRelay, needs_key: bool) -> Result<(), AvError> {
    let status = relay_status(relay)?;
    if !status.supported {
        return Err(unsupported());
    }
    if needs_key && !status.configured {
        return Err(AvError::StashdbRelay(
            "av_stashdb_not_configured",
            "서버에 StashDB 키가 설정되지 않았습니다.",
        ));
    }
    Ok(())
}
fn relay_id(id: &str) -> Result<&str, AvError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(AvError::Invalid);
    }
    Ok(id)
}
/// Accept only the server's relative image endpoint. Credentials never reach a provider URL.
pub(super) fn relay_image_path(path: &str) -> Result<String, AvError> {
    let u = url::Url::parse(&format!("http://relay.invalid{path}")).map_err(|_| AvError::Image)?;
    if !path.starts_with("/v1/providers/stashdb/image?")
        || u.path() != "/v1/providers/stashdb/image"
        || u.fragment().is_some()
    {
        return Err(AvError::Image);
    }
    let pairs: Vec<_> = u.query_pairs().collect();
    if pairs.len() != 2 {
        return Err(AvError::Image);
    }
    let stash = pairs
        .iter()
        .find(|p| p.0 == "stashdbId")
        .ok_or(AvError::Image)?;
    let image = pairs
        .iter()
        .find(|p| p.0 == "imageId")
        .ok_or(AvError::Image)?;
    relay_id(&stash.1)?;
    relay_id(&image.1)?;
    Ok(format!(
        "/v1/providers/stashdb/image?stashdbId={}&imageId={}",
        stash.1, image.1
    ))
}
pub(crate) fn relay_image(relay: &impl StashdbRelay, path: &str) -> Result<Vec<u8>, AvError> {
    // All PC relay consumers, including selected previews, share this lane.
    static LANE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _lane = LANE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let response =
        relay_response(relay.request(&relay_image_path(path)?, None, 15 * 1024 * 1024)?)?;
    let format = image::guess_format(&response.bytes).map_err(|_| AvError::Image)?;
    if !matches!(
        format,
        image::ImageFormat::Jpeg | image::ImageFormat::Png | image::ImageFormat::WebP
    ) {
        return Err(AvError::Image);
    }
    let (w, h) = image::ImageReader::with_format(std::io::Cursor::new(&response.bytes), format)
        .into_dimensions()
        .map_err(|_| AvError::Image)?;
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 24_000_000 {
        return Err(AvError::Image);
    }
    Ok(response.bytes)
}
fn relay_detail(
    relay: &impl StashdbRelay,
    person: &str,
    id: &str,
) -> Result<AvPerformerProfile, AvError> {
    let mut value = relay_json(
        relay,
        &format!("/v1/providers/stashdb/performers/{}", relay_id(id)?),
        None,
    )?;
    if value["stashdbId"] != id {
        return Err(AvError::Invalid);
    }
    value["personId"] = json!(person);
    value["source"] = json!("stashdb");
    value["status"] = json!("matched");
    value["candidates"] = json!([]);
    value["fetchedAt"] = json!(Utc::now().to_rfc3339());
    let p: AvPerformerProfile = serde_json::from_value(value).map_err(|_| AvError::Invalid)?;
    if p.images.iter().any(|i| relay_image_path(&i.url).is_err()) {
        return Err(AvError::Image);
    }
    Ok(p)
}
impl Library {
    pub(crate) fn stashdb_routed(&self) -> Result<bool, AvError> {
        Ok(collection_authority_active(&*self.connection()?)?)
    }
    pub(crate) fn stashdb_relay(&self) -> Result<StashdbRelaySession, AvError> {
        let config = self.cloud_sync_config()?;
        let client = self.cloud_client(
            config
                .api_base_url
                .as_deref()
                .ok_or(super::error::LibraryError::InvalidCloudSyncConfig)?,
        )?;
        let token = super::credential::read_cloud_api_token_os()?;
        Ok(StashdbRelaySession(client, token))
    }
    pub(crate) fn stashdb_status_with(
        &self,
        relay: &impl StashdbRelay,
    ) -> Result<StashdbStatus, AvError> {
        if !self.stashdb_routed()? {
            return Err(AvError::Invalid);
        }
        relay_status(relay)
    }
    pub(crate) fn stashdb_profile_detail_with(
        &self,
        person: &str,
        relay: &impl StashdbRelay,
    ) -> Result<Option<AvPerformerProfile>, AvError> {
        let old = self.get_av_performer_profile(person)?;
        if !self.stashdb_routed()? {
            return Ok(old);
        }
        let Some(id) = old.as_ref().and_then(|p| p.stashdb_id.as_deref()) else {
            return Ok(old);
        };
        require_relay(relay, true)?;
        let detail = relay_detail(relay, person, id)?;
        // Provider photos are transient; confirmed text always remains authoritative.
        let mut old = old.unwrap();
        old.images = detail.images;
        Ok(Some(old))
    }
    pub(crate) fn search_av_performer_profile_relay_with(
        &self,
        person: &str,
        relay: &impl StashdbRelay,
    ) -> Result<AvPerformerProfile, AvError> {
        let term: String = {
            let c = self.connection()?;
            require_person(&c, person)?;
            c.query_row("SELECT COALESCE(NULLIF(trim(name_ja),''),display_name) FROM collection_people WHERE id=?1",[person],|r|r.get(0))?
        };
        if !self.stashdb_routed()? {
            return Err(AvError::Invalid);
        }
        require_relay(relay, true)?;
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("query", &term)
            .finish();
        let value = relay_json(
            relay,
            &format!("/v1/providers/stashdb/search?{query}"),
            None,
        )?;
        let mut profile = empty(
            person,
            if value["items"].as_array().is_some_and(|a| a.is_empty()) {
                "none"
            } else {
                "ambiguous"
            },
        );
        profile.candidates =
            serde_json::from_value(value["items"].clone()).map_err(|_| AvError::Invalid)?;
        if profile.candidates.iter().any(|c| {
            relay_id(&c.stashdb_id).is_err()
                || c.image_url
                    .as_ref()
                    .is_some_and(|u| relay_image_path(u).is_err())
        }) {
            return Err(AvError::Invalid);
        }
        Ok(profile)
    }
    pub(crate) fn queue_av_performer_profile_relay_with(
        &self,
        person: &str,
        id: Option<&str>,
        state: &AvProfileState,
        relay: &impl StashdbRelay,
    ) -> Result<AvPerformerProfile, AvError> {
        let generation = state.begin(self, person);
        let before = collection_write_status(&*self.connection()?)?;
        if !before.active {
            return Err(AvError::Invalid);
        }
        require_relay(relay, id.is_some())?;
        let hint = id
            .map(|id| relay_detail(relay, person, id).map(|p| profile_hint(&p)))
            .transpose()?;
        generation.apply(|| {
            let mut c = self.connection()?;
            let tx = c.transaction()?;
            if !relay_authority_matches(&collection_write_status(&tx)?, &before) {
                return Err(AvError::Stale);
            }
            if let Some(hint) = hint.as_ref() {
                enqueue_person_profile_snapshot(&tx, &before, person, id, Some(hint))?;
            } else {
                enqueue_person_profile(&tx, &before, person, id)?;
            }
            tx.commit()?;
            drop(c);
            let mut old = self
                .get_av_performer_profile(person)?
                .unwrap_or_else(|| empty(person, "none"));
            old.pending = true;
            self.publication_inputs.signal(&[9]);
            Ok(old)
        })
    }
    pub(crate) fn refresh_av_performer_profile_relay_with(
        &self,
        person: &str,
        force: bool,
        state: &AvProfileState,
        relay: &impl StashdbRelay,
    ) -> Result<Option<AvPerformerProfile>, AvError> {
        let old = self.get_av_performer_profile(person)?;
        if !force {
            return Ok(old);
        }
        require_relay(relay, false)?;
        let id = old
            .as_ref()
            .and_then(|p| p.stashdb_id.as_deref())
            .ok_or_else(missing_identity)?;
        self.queue_av_performer_profile_relay_with(person, Some(id), state, relay)
            .map(Some)
    }
    pub(crate) fn dismiss_av_performer_profile_routed(
        &self,
        person: &str,
        state: &AvProfileState,
    ) -> Result<AvPerformerProfile, AvError> {
        let _generation = state.begin(self, person);
        Ok(self
            .get_av_performer_profile(person)?
            .unwrap_or_else(|| empty(person, "none")))
    }
}

// A normal feed cursor advance must not invalidate a photo the user is choosing.
pub(super) fn relay_authority_matches(
    a: &super::collection_authority::CollectionAuthorityStatus,
    b: &super::collection_authority::CollectionAuthorityStatus,
) -> bool {
    a.active
        && b.active
        && a.library_id == b.library_id
        && a.epoch == b.epoch
        && a.contract_version == b.contract_version
}

fn profile_hint(p: &AvPerformerProfile) -> Value {
    json!({"source":"stashdb","name":p.name,"aliases":p.aliases,"birthDate":p.birth_date,"heightCm":p.height_cm,
        "bandIn":p.band_in,"waistIn":p.waist_in,"hipIn":p.hip_in,"cup":p.cup,"breastType":p.breast_type,
        "careerStart":p.career_start,"careerEnd":p.career_end,
        "urls":p.urls.iter().map(|u|json!({"url":u.url,"site":u.site.name})).collect::<Vec<_>>()})
}
