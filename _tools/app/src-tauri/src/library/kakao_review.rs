use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use super::{
    collection::require_collection, error::LibraryError, models::ExternalBindingInput, Library,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KakaoReview {
    pub collection_id: String,
    pub query: String,
    pub query_source: &'static str,
    pub bound: bool,
    pub volumes: Vec<i64>,
    pub highest_owned_volume: i64,
    pub owned_count: i64,
    pub partial_dismissed: bool,
    pub group_fingerprints: Vec<String>,
    pub min_volume: Option<i64>,
    pub max_volume: Option<i64>,
    pub hide_connection_prompt: bool,
    pub dismissal_supported: bool,
}

pub(crate) fn default_query(name: &str, snapshot: &Value) -> (String, &'static str) {
    if name
        .chars()
        .any(|c| matches!(c as u32, 0x1100..=0x11ff | 0x3130..=0x318f | 0xac00..=0xd7af))
    {
        return (name.to_owned(), "name");
    }
    if let Some(title) = snapshot
        .pointer("/detail/data/attributes/altTitles")
        .and_then(Value::as_array)
        .and_then(|titles| {
            titles
                .iter()
                .filter_map(|t| t["ko"].as_str())
                .map(str::trim)
                .find(|t| !t.is_empty())
        })
    {
        return (title.to_owned(), "mangadex");
    }
    (name.to_owned(), "none")
}

pub(crate) fn bound_volumes(db: &Connection, id: &str) -> Result<Vec<i64>, LibraryError> {
    let snapshot: Option<String> = db.query_row("SELECT provider_data_json FROM collection_external_bindings WHERE collection_id=?1 AND provider='kakao'", [id], |r| r.get(0)).optional()?.flatten();
    let (_, snapshot) = pending_binding(
        db,
        id,
        Value::Null,
        snapshot
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or(Value::Null),
    )?;
    // Both clients CAS against the binding snapshot, never local source rows.
    Ok(snapshot_volumes(&snapshot))
}

// Follow the authority's immutable FIFO intents without changing confirmed rows.
fn pending_binding(
    db: &Connection,
    id: &str,
    mut config: Value,
    mut snapshot: Value,
) -> Result<(Value, Value), LibraryError> {
    if super::collection_authority::collection_authority_active(db)? {
        let rows = db.prepare("SELECT payload FROM collection_authority_outbox WHERE state IN ('pending','blocked') AND json_extract(payload,'$.workId')=?1 ORDER BY seq")?
            .query_map([id], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        for raw in rows {
            let body: Value =
                serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
            if body["commandType"] == "setKakaoPartialDismissed" {
                if body["dismissed"] == true {
                    if !config.is_object() { config = json!({}); }
                    config["reviewDismissedVolumes"] = body["expectedVolumes"].clone();
                } else if let Some(object) = config.as_object_mut() {
                    object.remove("reviewDismissedVolumes");
                }
                continue;
            }
            if body["provider"] != "kakao" {
                continue;
            }
            match body["commandType"].as_str() {
                Some("bindProvider") => config = body["config"].clone(),
                Some("applyProviderSnapshot") => {
                    snapshot = body["snapshot"].clone();
                    if config["reviewDismissedVolumes"] != json!(snapshot_volumes(&snapshot)) {
                        if let Some(object) = config.as_object_mut() {
                            object.remove("reviewDismissedVolumes");
                        }
                    }
                }
                Some("unbindProvider") => {
                    config = Value::Null;
                    snapshot = Value::Null;
                }
                _ => {}
            }
        }
    }
    Ok((config, snapshot))
}

pub(crate) fn snapshot_volumes(snapshot: &Value) -> Vec<i64> {
    let groups = snapshot["groups"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![snapshot.clone()]);
    let mut numbers: Vec<_> = groups
        .iter()
        .flat_map(|g| g["volumes"].as_array().into_iter().flatten())
        .filter_map(|v| v["volumeNumber"].as_i64())
        .filter(|n| *n > 0)
        .collect();
    numbers.sort_unstable();
    numbers.dedup();
    numbers
}

pub(crate) fn is_partial(volumes: &[i64], highest_owned: i64) -> bool {
    let highest = volumes
        .iter()
        .copied()
        .max()
        .unwrap_or(0)
        .max(highest_owned);
    (volumes.len() as i64) < highest
}

pub(crate) fn dismissed_for_volumes(
    db: &Connection,
    id: &str,
    volumes: &[i64],
) -> Result<bool, LibraryError> {
    let raw: Option<String> = db.query_row("SELECT provider_config_json FROM collection_external_bindings WHERE collection_id=?1 AND provider='kakao'", [id], |r| r.get(0)).optional()?.flatten();
    let config = raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null);
    let (config, _) = pending_binding(db, id, config, Value::Null)?;
    Ok(config["reviewDismissedVolumes"] == json!(volumes))
}

pub(crate) fn load(db: &Connection, id: &str) -> Result<KakaoReview, LibraryError> {
    let name: String = db.query_row("SELECT name FROM collections WHERE id=?1", [id], |r| {
        r.get(0)
    })?;
    let binding: Option<(Option<String>,)> = db.query_row("SELECT provider_config_json FROM collection_external_bindings WHERE collection_id=?1 AND provider='kakao'", [id], |r| Ok((r.get(0)?,))).optional()?;
    let config: Value = binding
        .as_ref()
        .and_then(|(raw,)| raw.as_deref())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null);
    let (config, _) = pending_binding(db, id, config, Value::Null)?;
    let bound = super::collection_authority::provider_binding_state(db, id, "kakao")?.is_some();
    let snapshot: Option<String> = db.query_row("SELECT provider_data_json FROM collection_external_bindings WHERE collection_id=?1 AND provider='mangadex'", [id], |r| r.get(0)).optional()?.flatten();
    let snapshot = snapshot
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let volumes = bound_volumes(db, id)?;
    let (highest_owned_volume, owned_count) = db.query_row("SELECT COALESCE(MAX(volume_number),0),COUNT(DISTINCT volume_number) FROM collection_volume_ownership WHERE collection_id=?1 AND (physical=1 OR digital=1)", [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let range = super::collection_volume_range::load(db, id)?;
    let mut review = compute_review(id, &name, &config, &snapshot, bound, volumes,
        highest_owned_volume, owned_count,
        &json!({"minVolume":range.min_volume,"maxVolume":range.max_volume,"hideConnectionPrompt":range.hide_connection_prompt}));
    review.dismissal_supported = !super::collection_authority::collection_authority_active(db)?
        || super::collection_authority::collection_write_status(db)?.features.iter().any(|f| f == "kakaoReview");
    Ok(review)
}

fn compute_review(id: &str, name: &str, config: &Value, snapshot: &Value, bound: bool,
    volumes: Vec<i64>, highest_owned_volume: i64, owned_count: i64, range: &Value) -> KakaoReview {
    let (default, source) = default_query(name, snapshot);
    let group_fingerprints = config["groups"]
        .as_array()
        .map(|groups| {
            groups
                .iter()
                .filter_map(|g| g["groupFingerprint"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_else(|| {
            config["groupFingerprint"]
                .as_str()
                .map(|s| vec![s.to_owned()])
                .unwrap_or_default()
        });
    KakaoReview {
        collection_id: id.to_owned(),
        query: config["query"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&default)
            .chars().take(2000).collect(),
        query_source: source,
        bound,
        partial_dismissed: bound
            && config["reviewDismissedVolumes"] == json!(volumes)
            && is_partial(&volumes, highest_owned_volume),
        volumes,
        highest_owned_volume,
        owned_count,
        group_fingerprints,
        min_volume: range["minVolume"].as_i64(),
        max_volume: range["maxVolume"].as_i64(),
        hide_connection_prompt: range["hideConnectionPrompt"].as_bool().unwrap_or(false),
        dismissal_supported: true,
    }
}

impl Library {
    pub fn list_kakao_reviews(&self) -> Result<Vec<KakaoReview>, LibraryError> {
        let db = self.connection()?;
        let ids = db
            .prepare("SELECT id FROM collections WHERE type='manga' ORDER BY name,id")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter().map(|id| load(&db, id)).collect()
    }

    pub fn set_kakao_partial_dismissed(
        &self,
        id: &str,
        dismissed: bool,
    ) -> Result<(), LibraryError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        require_collection(&tx, id)?;
        let status = super::collection_authority::collection_write_status(&tx)?;
        if status.active && !status.features.iter().any(|f| f == "kakaoReview") {
            return Err(LibraryError::CollectionAuthorityOperationUnavailable);
        }
        let mut input = tx.query_row("SELECT external_id,provider_config_json,provider_data_json,last_synced_at FROM collection_external_bindings WHERE collection_id=?1 AND provider='kakao'", [id], |r| Ok(ExternalBindingInput {
            provider: "kakao".into(), external_id: r.get(0)?, provider_config_json: r.get(1)?, provider_data_json: r.get(2)?, last_synced_at: r.get(3)?,
        }))?;
        let config: Value = input
            .provider_config_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .filter(Value::is_object)
            .ok_or(LibraryError::InvalidExternalBinding)?;
        let (mut config, snapshot) = pending_binding(
            &tx,
            id,
            config,
            input
                .provider_data_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(Value::Null),
        )?;
        input.provider_data_json = (!snapshot.is_null()).then(|| snapshot.to_string());
        if !config.is_object() {
            return Err(LibraryError::InvalidExternalBinding);
        }
        if dismissed {
            config["reviewDismissedVolumes"] = json!(bound_volumes(&tx, id)?);
        } else {
            if let Some(object) = config.as_object_mut() { object.remove("reviewDismissedVolumes"); }
        }
        input.provider_config_json = Some(config.to_string());
        if status.active {
            super::collection_authority::enqueue_collection_command(
                &tx,
                &status,
                "setKakaoPartialDismissed",
                &json!([id, "kakao"]).to_string(),
                json!({"workId":id,"dismissed":dismissed,"expectedVolumes":bound_volumes(&tx,id)?}),
            )?;
        } else {
            super::external_binding::upsert_external_binding(
                &tx,
                id,
                input,
                &chrono::Utc::now().to_rfc3339(),
            )?;
        }
        super::collection_personal_edits::bump_collections_generation(&tx)?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kakao_review_shared_computation_fixture() {
        let cases: Value = serde_json::from_str(include_str!("fixtures/kakao_review.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let bindings = &case["bindings"];
            let review = compute_review("work", case["name"].as_str().unwrap(), &bindings["kakao"]["config"],
                &bindings["mangadex"]["snapshot"], bindings.get("kakao").is_some(),
                snapshot_volumes(&bindings["kakao"]["snapshot"]), case["highestOwnedVolume"].as_i64().unwrap(),
                case["ownedCount"].as_i64().unwrap(), &case["range"]);
            let actual = serde_json::to_value(review).unwrap();
            for (key, expected) in case["expected"].as_object().unwrap() {
                assert_eq!(&actual[key], expected, "{}: {key}", case["name"]);
            }
        }
    }
    #[test]
    fn kakao_review_query_is_clipped() {
        let review = compute_review("work", "Title", &json!({"query":"가".repeat(2001)}),
            &Value::Null, true, vec![], 0, 0, &Value::Null);
        assert_eq!(review.query.chars().count(), 2000);
    }
    #[test]
    fn kakao_review_partial_includes_owned_tail_and_internal_gaps() {
        assert!(!is_partial(&[1, 2, 3], 2));
        assert!(is_partial(&[1, 3], 0));
        assert!(is_partial(&[1, 2], 4));
        assert!(!is_partial(&[], 0));
    }
    #[test]
    fn kakao_review_query_uses_stored_korean_alt_title() {
        let snapshot = json!({"detail":{"data":{"attributes":{"altTitles":[{"en":"Other"},{"ko":"던전밥"}]}}}});
        assert_eq!(
            default_query("Dungeon Meshi", &snapshot),
            ("던전밥".into(), "mangadex")
        );
        assert_eq!(
            default_query("던전밥 완전판", &snapshot),
            ("던전밥 완전판".into(), "name")
        );
        assert_eq!(
            default_query("English", &Value::Null),
            ("English".into(), "none")
        );
    }
}
