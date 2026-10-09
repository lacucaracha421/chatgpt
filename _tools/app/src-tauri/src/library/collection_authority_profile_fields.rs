// Included in collection_authority. Field CAS uses storage values and override membership.
const PROFILE_FIELDS: &[&str] = &[
    "displayName",
    "nameJa",
    "birthDate",
    "heightCm",
    "bandIn",
    "waistIn",
    "hipIn",
    "cup",
    "breastType",
    "careerStart",
    "careerEnd",
    "urls",
];
fn store_profile_features_status(db: &Connection, status: &CollectionAuthorityStatus) -> Result<(), LibraryError> {
    db.execute("INSERT INTO notes_state(key,value) VALUES('personProfileFieldsStatus',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value", [json!({"active":status.active,"libraryId":status.library_id,"epoch":status.epoch,"features":status.features}).to_string()])?;
    Ok(())
}
fn cached_profile_features(db: &Connection) -> Result<Vec<String>, LibraryError> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM notes_state WHERE key='personProfileFieldsStatus'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        return Ok(vec![]);
    };
    let status: Value =
        serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
    let state = local(db)?;
    if status["active"] != true
        || state
            .as_ref()
            .is_none_or(|l| status["libraryId"] != l.id.library || status["epoch"] != l.id.epoch)
    {
        return Ok(vec![]);
    }
    Ok(status["features"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default())
}
fn profile_field_value(person: &Value, field: &str) -> Value {
    if field == "displayName" {
        return person.get(field).cloned().unwrap_or(json!(""));
    }
    if field == "nameJa" {
        return person[field].clone();
    }
    person["profile"].get(field).cloned().unwrap_or(Value::Null)
}
fn profile_field_token(person: &Value, field: &str) -> Value {
    json!({"value":profile_field_value(person,field),"overridden":person["profileOverrides"].get(field).is_some()})
}
fn merge_person_profile(person: &mut Value) -> Result<(), LibraryError> {
    let baseline = person
        .get("stashdbProfile")
        .unwrap_or(&person["profile"])
        .clone();
    let overrides = person["profileOverrides"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if baseline.is_null()
        && !overrides
            .keys()
            .any(|k| k != "displayName" && k != "nameJa")
    {
        person["profile"] = Value::Null;
        return Ok(());
    }
    let mut profile = if baseline.is_object() {
        baseline
    } else {
        json!({"source":"stashdb","name":null,"aliases":[],"urls":[]})
    };
    for field in PROFILE_FIELDS
        .iter()
        .filter(|f| **f != "displayName" && **f != "nameJa")
    {
        let value = overrides
            .get(*field)
            .cloned()
            .unwrap_or_else(|| profile[*field].clone());
        profile[*field] = if *field == "urls" && value.is_null() {
            json!([])
        } else {
            value
        };
    }
    person["profile"] = profile;
    Ok(())
}
fn apply_person_profile_fields(person: &mut Value, changes: &Value) -> Result<bool, LibraryError> {
    let before = person["profileOverrides"].clone();
    if !person["profileOverrides"].is_object() {
        person["profileOverrides"] = json!({});
    }
    for (field, value) in changes
        .as_object()
        .ok_or(LibraryError::InvalidCollectionMetadata)?
    {
        if !PROFILE_FIELDS.contains(&field.as_str()) {
            return Err(LibraryError::InvalidCollectionMetadata);
        }
        let name = field == "displayName" || field == "nameJa";
        if name && !person["profileBaseNames"].is_object() {
            person["profileBaseNames"] =
                json!({"displayName":person["displayName"],"nameJa":person["nameJa"]});
        }
        let reset = *value == json!({"reset":true});
        if reset {
            person["profileOverrides"]
                .as_object_mut()
                .unwrap()
                .remove(field);
        } else {
            person["profileOverrides"][field] = value.clone();
        }
        if name {
            let desired = if reset {
                person["profileBaseNames"][field].clone()
            } else {
                value.clone()
            };
            person[field] = if field == "displayName" && desired.is_null() {
                json!("")
            } else {
                desired
            };
        }
    }
    merge_person_profile(person)?;
    Ok(before != person["profileOverrides"])
}
fn validate_profile_fields(changes: &Value) -> Result<(), LibraryError> {
    let fields = changes
        .as_object()
        .filter(|v| !v.is_empty())
        .ok_or(LibraryError::InvalidCollectionMetadata)?;
    for (field, value) in fields {
        if !PROFILE_FIELDS.contains(&field.as_str()) {
            return Err(LibraryError::InvalidCollectionMetadata);
        }
        if value.is_null() || *value == json!({"reset":true}) {
            continue;
        }
        let valid = match field.as_str() {
            "displayName" | "nameJa" | "cup" => value
                .as_str()
                .is_some_and(|s| s.chars().count() <= if field == "cup" { 20 } else { 500 }),
            "birthDate" => value.as_str().is_some_and(|s| {
                let parts: Vec<_> = s.split('-').collect();
                if parts.is_empty()
                    || parts.len() > 3
                    || parts[0].len() != 4
                    || parts.iter().skip(1).any(|p| p.len() != 2)
                    || parts.iter().any(|p| !p.bytes().all(|b| b.is_ascii_digit()))
                {
                    return false;
                }
                let y = parts[0].parse::<i32>().unwrap_or(0);
                if !(1900..=2200).contains(&y) {
                    return false;
                }
                let m = parts
                    .get(1)
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(1);
                let d = parts
                    .get(2)
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(1);
                chrono::NaiveDate::from_ymd_opt(y, m, d).is_some()
            }),
            "breastType" => value
                .as_str()
                .is_some_and(|s| ["NATURAL", "FAKE", "NA"].contains(&s)),
            "urls" => value.as_array().is_some_and(|a| {
                a.len() <= 100
                    && a.iter().all(|u| {
                        u.as_object().is_some_and(|o| o.len() == 2)
                            && u["site"].as_str().is_some_and(|s| s.chars().count() <= 200)
                            && u["url"].as_str().is_some_and(|s| {
                                s.len() <= 2000
                                    && !s.chars().any(|c| c.is_control() || c.is_whitespace())
                                    && url::Url::parse(s).is_ok_and(|u| {
                                        ["http", "https"].contains(&u.scheme())
                                            && u.username().is_empty()
                                            && u.password().is_none()
                                    })
                            })
                    })
            }),
            _ => value.as_i64().is_some_and(|n| {
                if field.starts_with("career") {
                    (1900..=2200).contains(&n)
                } else {
                    (1..=if field == "heightCm" { 300 } else { 200 }).contains(&n)
                }
            }),
        };
        if !valid {
            return Err(LibraryError::InvalidCollectionMetadata);
        }
    }
    Ok(())
}
// Tokens are supplied by the frozen editor snapshot, never reconstructed at save.
fn validate_profile_expected(changes: &Value, expected: &Value) -> Result<(), LibraryError> {
    let tokens = expected.as_object().ok_or(LibraryError::InvalidCollectionMetadata)?;
    let changes = changes.as_object().ok_or(LibraryError::InvalidCollectionMetadata)?;
    if tokens.len() != changes.len() { return Err(LibraryError::InvalidCollectionMetadata); }
    for field in changes.keys() {
        let token = tokens.get(field).and_then(Value::as_object).ok_or(LibraryError::InvalidCollectionMetadata)?;
        if token.len() != 2 || token.get("overridden").and_then(Value::as_bool).is_none() {
            return Err(LibraryError::InvalidCollectionMetadata);
        }
        let value = token.get("value").ok_or(LibraryError::InvalidCollectionMetadata)?;
        let valid = value.is_null() || match field.as_str() {
            "displayName" | "nameJa" | "birthDate" | "cup" | "breastType" => value.as_str().is_some_and(|s| s.chars().count() <= 500),
            "urls" => value.as_array().is_some_and(|urls| urls.len() <= 100 && urls.iter().all(|link| link.as_object().is_some_and(|o| o.len() == 2) && link["site"].as_str().is_some_and(|s| s.chars().count() <= 200) && link["url"].as_str().is_some_and(|s| s.len() <= 2000))),
            _ => value.is_number(),
        };
        if !valid { return Err(LibraryError::InvalidCollectionMetadata); }
    }
    Ok(())
}
fn reproject_profile_person(tx: &Transaction<'_>, person: &str, now: &str) -> Result<(), LibraryError> {
    let state = predicted_person(tx, person)?;
    project_profile_fields(tx, person, &state, now)
}
fn project_profile_fields(
    tx: &Transaction<'_>,
    person: &str,
    state: &Value,
    now: &str,
) -> Result<(), LibraryError> {
    tx.execute(
        "UPDATE collection_people SET display_name=?2,name_ja=?3 WHERE id=?1",
        params![
            person,
            text(state, "displayName")?,
            sql_value(&state["nameJa"])?
        ],
    )?;
    project_person_profile(tx, person, state, now)
}
// One FIFO snapshot per list, indexed by person; no per-name whole-outbox scan.
pub(crate) struct PersonDisplayMetadata {
    active: bool,
    intents: std::collections::HashMap<String, Vec<Value>>,
}
impl PersonDisplayMetadata {
    pub(crate) fn read(db: &Connection) -> Result<Self, LibraryError> {
        let active = local(db)?.is_some();
        let mut intents = std::collections::HashMap::<String, Vec<Value>>::new();
        if active {
            for body in pending_person_intents(db)? {
                if let Some(person) = body["personId"].as_str() {
                    intents.entry(person.to_owned()).or_default().push(body.clone());
                } else if body["commandType"] == "setAvCredits" {
                    if let Some(people) = body["people"].as_array() {
                        for person in people {
                            intents.entry(text(person, "personId")?.to_owned()).or_default().push(body.clone());
                        }
                    }
                }
            }
        }
        Ok(Self { active, intents })
    }
    pub(crate) fn person(&self, db: &Connection, person: &str) -> Result<Value, LibraryError> {
        if self.active {
            if let Ok(state) = predict_person_intents(db, person, self.intents.get(person).map(Vec::as_slice).unwrap_or(&[])) {
                let mut result = json!({});
                for key in ["profile", "stashdbProfile", "profileOverrides", "profileBaseNames"] {
                    if let Some(v) = state.get(key) { result[key] = v.clone(); }
                }
                return Ok(result);
            }
        }
        let name: Option<Option<String>> = db.query_row("SELECT name FROM collection_person_profiles WHERE person_id=?1", [person], |r| r.get(0)).optional()?;
        Ok(name.map_or(json!({}), |name| json!({"profile":{"name":name}})))
    }
}
pub(crate) fn person_display_metadata(db: &Connection, person: &str) -> Result<Value, LibraryError> {
    PersonDisplayMetadata::read(db)?.person(db, person)
}
impl Library {
    pub fn refresh_av_person_profile_state(&self, person: &str) -> Result<Value, LibraryError> {
        safe_id(person)?;
        if !collection_write_status(&*self.connection()?)?.active {
            return self.av_person_profile_state(person);
        }
        let config = self.cloud_sync_config()?;
        let client = self.cloud_client(
            config
                .api_base_url
                .as_deref()
                .ok_or(LibraryError::InvalidCloudSyncConfig)?,
        )?;
        let token = super::credential::read_cloud_api_token_os()?;
        self.refresh_profile_person_with(
            person,
            &|| {
                client
                    .collection_authority_read("/v1/collections/authority/status", &token.expose())
            },
            &|| client.collection_authority_person(person, &token.expose()),
        )
    }
    fn refresh_profile_person_with(
        &self,
        person: &str,
        read_status: &dyn Fn() -> Result<Value, LibraryError>,
        read_person: &dyn Fn() -> Result<Option<Value>, LibraryError>,
    ) -> Result<Value, LibraryError> {
        let before = collection_write_status(&*self.connection()?)?;
        let status: CollectionAuthorityStatus = serde_json::from_value(read_status()?)
            .map_err(|_| LibraryError::InvalidCloudResponse)?;
        if status.active
            && (status.library_id != before.library_id
                || status.epoch != before.epoch
                || status.contract_version != before.contract_version)
        {
            return Err(LibraryError::CollectionAuthorityMismatch);
        }
        let response = if status.active { read_person()? } else { None };
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let after = collection_write_status(&tx)?;
        if after.library_id != before.library_id
            || after.epoch != before.epoch
            || after.active != before.active
        {
            return Err(LibraryError::CollectionAuthorityMismatch);
        }
        store_profile_features_status(&tx, &status)?;
        if let Some(response) = response {
            if response["person"]["personId"] != person {
                return Err(LibraryError::InvalidCloudResponse);
            }
            receive_person(&tx, &response["person"], &chrono::Utc::now().to_rfc3339())?;
            reapply_pending_core_edits(&tx)?;
        }
        tx.commit()?;
        drop(db);
        self.av_person_profile_state(person)
    }
    pub fn av_person_profile_state(&self, person: &str) -> Result<Value, LibraryError> {
        let db = self.connection()?;
        let supported = cached_profile_features(&db)?
            .iter()
            .any(|v| v == "personProfileFields");
        let mut state = if local(&db)?.is_some() {
            predicted_person(&db, person).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        if state.is_object() {
            let pending: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM collection_authority_outbox WHERE state='pending' AND command_type='setPersonProfileFields' AND json_extract(payload,'$.personId')=?1)",[person],|r|r.get(0))?;
            state["profilePending"] = json!(pending);
            state["profileFieldsSupported"] = json!(
                supported
                    && state.get("stashdbProfile").is_some()
                    && state["profileOverrides"].is_object()
            );
            let conflicts = db.prepare("SELECT operation_id,conflict_code FROM collection_authority_outbox WHERE state='blocked' AND command_type='setPersonProfileFields' AND json_extract(payload,'$.personId')=?1 ORDER BY seq")?.query_map([person],|r|Ok(json!({"operationId":r.get::<_,String>(0)?,"code":r.get::<_,Option<String>>(1)?})))?.collect::<Result<Vec<_>,_>>()?;
            state["profileConflicts"] = json!(conflicts);
            let unsupported: bool = db.query_row("SELECT COALESCE((SELECT state='dropped' AND drop_reason='unsupportedCollectionCommand' FROM collection_authority_outbox WHERE command_type='setPersonProfileFields' AND json_extract(payload,'$.personId')=?1 ORDER BY seq DESC LIMIT 1),0)", [person], |r| r.get(0))?;
            if unsupported { state["profileMessage"] = json!("서버가 아직 프로필 편집을 지원하지 않습니다."); }
        }
        Ok(state)
    }
    pub fn set_av_person_profile_fields(
        &self,
        person: &str,
        mut changes: Value,
        expected: Value,
    ) -> Result<Value, LibraryError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let status = collection_write_status(&tx)?;
        if !status.active || !status.features.iter().any(|f| f == "personProfileFields") {
            return Err(LibraryError::CollectionAuthorityOperationUnavailable);
        }
        safe_id(person)?;
        let unknown_source: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM collection_authority_outbox o WHERE o.state='pending' AND o.command_type='setPersonProfile' AND json_extract(o.payload,'$.personId')=?1 AND json_extract(o.payload,'$.stashdbId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM notes_state n WHERE n.key='stashdbProfilePrediction:' || o.operation_id))",[person],|r|r.get(0))?;
        if unknown_source {return Err(LibraryError::CollectionAuthorityOperationUnavailable);}
        let mut state = predicted_person(&tx, person)?;
        if state.get("stashdbProfile").is_none() || !state["profileOverrides"].is_object() || tx.query_row("SELECT EXISTS(SELECT 1 FROM collection_authority_outbox WHERE state='blocked' AND json_extract(payload,'$.personId')=?1)",[person],|r|r.get::<_,bool>(0))? { return Err(LibraryError::CollectionAuthorityOperationUnavailable); }
        for (field, value) in changes
            .as_object_mut()
            .ok_or(LibraryError::InvalidCollectionMetadata)?
        {
            if ["displayName", "nameJa", "cup"].contains(&field.as_str()) {
                if let Some(s) = value.as_str() {
                    let s = s.trim();
                    *value = if s.is_empty() { Value::Null } else { json!(s) };
                }
            }
        }
        validate_profile_fields(&changes)?;
        validate_profile_expected(&changes, &expected)?;
        let stale = changes.as_object().unwrap().keys().any(|field| expected[field] != profile_field_token(&state, field));
        let changed = apply_person_profile_fields(&mut state, &changes)?;
        if changes.get("careerStart").is_some() || changes.get("careerEnd").is_some() {
            if let (Some(a), Some(b)) = (
                state["profile"]["careerStart"].as_i64(),
                state["profile"]["careerEnd"].as_i64(),
            ) {
                if b < a {
                    return Err(LibraryError::InvalidCollectionMetadata);
                }
            }
        }
        if state.to_string().len() > 64 * 1024 {
            return Err(LibraryError::InvalidCollectionMetadata);
        }
        if changed || stale {
            enqueue_collection_command(
                &tx,
                &status,
                "setPersonProfileFields",
                person,
                json!({"personId":person,"changes":changes,"expected":expected}),
            )?;
            project_profile_fields(&tx, person, &state, &chrono::Utc::now().to_rfc3339())?;
        }
        tx.commit()?;
        drop(db);
        self.av_person_profile_state(person)
    }
    pub fn resolve_av_person_profile_conflict(
        &self,
        person: &str,
        operation: &str,
        overwrite: bool,
    ) -> Result<Value, LibraryError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let status = collection_write_status(&tx)?;
        let (raw,detail):(String,String)=tx.query_row("SELECT payload,conflict_detail FROM collection_authority_outbox WHERE operation_id=?1 AND state='blocked' AND command_type='setPersonProfileFields' AND json_extract(payload,'$.personId')=?2",params![operation,person],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let body: Value =
            serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
        let detail: Value =
            serde_json::from_str(&detail).map_err(|_| LibraryError::InvalidCloudResponse)?;
        let current = &detail["current"]["person"];
        if current.is_object() {
            receive_person(&tx, current, &chrono::Utc::now().to_rfc3339())?;
        }
        if overwrite {
            if body["commandType"] != "setPersonProfileFields"
                || detail["code"] != "revisionConflict"
                || !current.is_object()
            {
                return Err(LibraryError::CollectionAuthorityOperationUnavailable);
            }
            let mut expected = json!({});
            for field in body["changes"]
                .as_object()
                .ok_or(LibraryError::InvalidCloudResponse)?
                .keys()
            {
                expected[field] = profile_field_token(current, field);
            }
            // A replacement occupies the same FIFO position with a fresh immutable ID.
            let fresh = uuid::Uuid::new_v4().to_string();
            let mut replacement = body.clone();
            replacement["operationId"] = json!(fresh);
            replacement["expected"] = expected;
            ensure_collection_write_ready(&tx, &status)?;
            tx.execute("UPDATE collection_authority_outbox SET operation_id=?2,payload=?3,state='pending',conflict_code=NULL,conflict_detail=NULL,attempts=0,retry_at=0 WHERE operation_id=?1",params![operation,fresh,replacement.to_string()])?;
        } else {
            tx.execute("UPDATE collection_authority_outbox SET state='dropped',drop_reason='userDiscard' WHERE operation_id=?1",[operation])?;
        }
        reapply_pending_core_edits(&tx)?;
        reproject_profile_person(&tx, person, &chrono::Utc::now().to_rfc3339())?;
        tx.commit()?;
        drop(db);
        self.av_person_profile_state(person)
    }
}
