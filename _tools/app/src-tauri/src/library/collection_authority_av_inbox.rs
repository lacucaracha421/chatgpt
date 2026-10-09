// Included in collection_authority.rs (AV inbox step 2).
//
// The server AV inbox apply is not a new authority command: it is the ordinary immutable
// sequence createWork -> addArtwork/selectArtwork -> setAvDetails -> setAvCredits, composed
// here in ONE local transaction so a crash can never leave half a sequence queued. Expected
// revisions and values come from confirmed state plus the commands queued before them.

pub(crate) const AV_INBOX_OPERATION_PREFIX: &str = "avInbox:op:";

/// Reverse index operation -> inbox item. Also marks server-prepared artwork, which has
/// no local file to upload.
pub(crate) fn av_inbox_operation_key(operation: &str) -> String {
    format!("{AV_INBOX_OPERATION_PREFIX}{operation}")
}

/// A refused command cancels the rest of its apply sequence: later commands were composed
/// against its effect and must not reach the server.
fn drop_av_inbox_dependents(
    tx: &Transaction<'_>,
    operation: &str,
    seq: i64,
    now: &str,
) -> Result<(), LibraryError> {
    let inbox: Option<String> = tx
        .query_row(
            "SELECT value FROM notes_state WHERE key=?1",
            [av_inbox_operation_key(operation)],
            |r| r.get(0),
        )
        .optional()?;
    let Some(inbox) = inbox else {
        return Ok(());
    };
    tx.execute(
        "UPDATE collection_authority_outbox SET state='dropped',drop_reason='dependencyDropped',updated_at=?3 WHERE state='pending' AND seq>?2 AND operation_id IN (SELECT substr(key,?4) FROM notes_state WHERE key LIKE 'avInbox:op:%' AND value=?1)",
        params![inbox, seq, now, AV_INBOX_OPERATION_PREFIX.len() as i64 + 1],
    )?;
    Ok(())
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AvInboxSurfacePlan {
    /// `front`, `spine` or `back`.
    pub surface: String,
    /// `candidate` (server-prepared artwork) or `clear`. Keep is simply absent.
    pub action: String,
    pub artwork_id: Option<String>,
    /// One item of the server's `POST /{id}/artwork` answer.
    pub manifest: Option<Value>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AvInboxCreditPlan {
    pub role: String,
    pub name_ja: String,
    pub person_id: String,
    /// `Some` creates the person (Korean display name); `None` links an existing one.
    pub display_name: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AvInboxPlan {
    pub work_id: String,
    pub is_new: bool,
    pub name: String,
    /// Selected `setAvDetails` values keyed by authority field (productCode included
    /// when the work must carry the code for the acknowledgement to succeed).
    pub fields: Value,
    pub surfaces: Vec<AvInboxSurfacePlan>,
    pub credits: Vec<AvInboxCreditPlan>,
}

fn artwork_target(surface: &str) -> Result<(&'static str, &'static str), LibraryError> {
    match surface {
        "front" => Ok(("work", "cover")),
        "spine" => Ok(("spine", "spine")),
        "back" => Ok(("back", "back")),
        _ => Err(LibraryError::InvalidWorkArtwork),
    }
}

/// Queue the whole sequence atomically; returns the operation ids in delivery order.
pub(crate) fn enqueue_av_inbox_apply(
    tx: &Transaction<'_>,
    inbox_id: &str,
    plan: &AvInboxPlan,
) -> Result<Vec<String>, LibraryError> {
    let status = collection_write_status(tx)?;
    if !status.active {
        return Err(LibraryError::CollectionAuthorityNotAdopted);
    }
    let work = safe_id(&plan.work_id)?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut operations: Vec<String> = Vec::new();
    let mut remember = |operation: String| -> Result<(), LibraryError> {
        tx.execute(
            "INSERT OR REPLACE INTO notes_state(key,value) VALUES(?1,?2)",
            params![av_inbox_operation_key(&operation), inbox_id],
        )?;
        operations.push(operation);
        Ok(())
    };

    // 1. The work itself. A new work is local-first like every optimistic create.
    if plan.is_new {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1)",
            [work],
            |r| r.get(0),
        )?;
        if exists {
            return Err(LibraryError::InvalidCollectionMetadata);
        }
        let name = super::collection::normalized_name(plan.name.clone())?;
        tx.execute(
            "INSERT INTO collections(id,name,type,created_at,updated_at) VALUES(?1,?2,'av',?3,?3)",
            params![work, name, now],
        )
        .map_err(super::collection::map_duplicate_name)?;
        tx.execute(
            "INSERT OR IGNORE INTO collection_av_details(collection_id) VALUES(?1)",
            [work],
        )?;
        remember(enqueue_collection_command(
            tx,
            &status,
            "createWork",
            work,
            json!({"workId":work,"type":"av","name":name,"legacyKind":null,"fields":{},"binding":null}),
        )?)?;
    } else {
        let valid: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1 AND type='av')",
            [work],
            |r| r.get(0),
        )?;
        if !valid {
            return Err(LibraryError::CollectionNotFound);
        }
    }

    // 2. Artwork, front/spine/back in that order. Keep queues nothing.
    for surface in ["front", "spine", "back"] {
        let Some(item) = plan.surfaces.iter().find(|s| s.surface == surface) else {
            continue;
        };
        let (slot, kind) = artwork_target(surface)?;
        let current = predicted_artwork_slot(tx, work, slot)?;
        match item.action.as_str() {
            "candidate" => {
                let art = safe_id(
                    item.artwork_id
                        .as_deref()
                        .ok_or(LibraryError::InvalidWorkArtwork)?,
                )?;
                let manifest = item
                    .manifest
                    .as_ref()
                    .and_then(Value::as_object)
                    .ok_or(LibraryError::InvalidWorkArtwork)?;
                if manifest.get("kind").and_then(Value::as_str) != Some(kind) {
                    return Err(LibraryError::InvalidWorkArtwork);
                }
                // The same candidate crop applied before is already a confirmed artwork:
                // select it instead of adding a duplicate under another id.
                let reuse: Option<String> = match manifest.get("providerImageId").and_then(Value::as_str) {
                    Some(image) => tx
                        .query_row(
                            "SELECT id FROM collection_work_artworks WHERE collection_id=?1 AND provider='libredmm' AND provider_image_id=?2 AND kind=?3 ORDER BY id LIMIT 1",
                            params![work, image, kind],
                            |r| r.get(0),
                        )
                        .optional()?,
                    None => None,
                };
                let chosen = match reuse {
                    Some(existing) => existing,
                    None => {
                        let mut body = manifest.clone();
                        body.remove("surface");
                        body.insert("workId".into(), json!(work));
                        body.insert("artworkId".into(), json!(art));
                        remember(enqueue_collection_command(
                            tx,
                            &status,
                            "addArtwork",
                            art,
                            Value::Object(body),
                        )?)?;
                        art.to_owned()
                    }
                };
                if current.as_deref() != Some(chosen.as_str()) {
                    remember(enqueue_collection_command(
                        tx,
                        &status,
                        "selectArtwork",
                        work,
                        json!({"workId":work,"slot":slot,"artworkId":chosen,"expectedArtworkId":current}),
                    )?)?;
                    // A reused local row can be selected right away; a new one is projected
                    // when its receipt arrives, so the old picture stays until then.
                    if tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM collection_work_artworks WHERE id=?1)",
                        [&chosen],
                        |r| r.get::<_, bool>(0),
                    )? {
                        project_selection(tx, work, slot, Some(&chosen))?;
                    }
                }
            }
            "clear" => {
                if current.is_some() {
                    remember(enqueue_collection_command(
                        tx,
                        &status,
                        "selectArtwork",
                        work,
                        json!({"workId":work,"slot":slot,"artworkId":null,"expectedArtworkId":current}),
                    )?)?;
                    project_selection(tx, work, slot, None)?;
                }
            }
            _ => return Err(LibraryError::InvalidWorkArtwork),
        }
    }

    // 3. Details: field compare-and-set against confirmed state plus earlier intents.
    let present = predicted_av_details(tx, work)?;
    let mut changes = json!({});
    let mut expected = json!({});
    for (field, value) in plan
        .fields
        .as_object()
        .ok_or(LibraryError::InvalidCollectionMetadata)?
    {
        if av_comparable(&present[field]) != av_comparable(value) {
            changes[field] = value.clone();
            expected[field] = present[field].clone();
        }
    }
    if !changes.as_object().unwrap().is_empty() {
        validate_av_changes(&changes)?;
        validate_av_changes(&expected)?;
        remember(enqueue_collection_command(
            tx,
            &status,
            "setAvDetails",
            work,
            json!({"workId":work,"changes":changes,"expected":expected}),
        )?)?;
        project_av_details(tx, work, &changes)?;
    }

    // 4. Credits: the complete desired list; existing credits are kept as they are.
    let mut credits: Vec<Value> = editable_av(tx, work)?["credits"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut people: Vec<Value> = Vec::new();
    let mut added = false;
    for choice in &plan.credits {
        if !matches!(choice.role.as_str(), "performer" | "director") {
            return Err(LibraryError::InvalidCollectionMetadata);
        }
        let person = safe_id(&choice.person_id)?;
        if credits
            .iter()
            .any(|c| c["personId"] == person && c["role"] == choice.role.as_str())
        {
            continue;
        }
        let limit = super::av_models::av_limit("personName");
        if let Some(display) = choice.display_name.as_deref() {
            let display = display.trim();
            if display.is_empty()
                || display.chars().count() > limit
                || choice.name_ja.chars().count() > limit
            {
                return Err(LibraryError::InvalidCollectionMetadata);
            }
            if !people.iter().any(|p| p["personId"] == person) {
                people
                    .push(json!({"personId":person,"displayName":display,"nameJa":choice.name_ja}));
            }
        } else if !av_person_known(tx, person)? && !people.iter().any(|p| p["personId"] == person) {
            let (display, name_ja): (String, Option<String>) = tx
                .query_row(
                    "SELECT display_name,name_ja FROM collection_people WHERE id=?1",
                    [person],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .ok_or(LibraryError::InvalidCollectionMetadata)?;
            if display.trim().is_empty()
                || display.chars().count() > limit
                || name_ja.as_ref().is_some_and(|s| s.chars().count() > limit)
            {
                return Err(LibraryError::InvalidCollectionMetadata);
            }
            people.push(json!({"personId":person,"displayName":display,"nameJa":name_ja}));
        }
        let order = credits
            .iter()
            .filter(|c| c["role"] == choice.role.as_str())
            .filter_map(|c| c["order"].as_i64())
            .max()
            .map_or(0, |n| n + 1);
        credits.push(
            json!({"personId":person,"role":choice.role,"order":order,"creditName":choice.name_ja}),
        );
        added = true;
    }
    if added {
        let credits = credit_values(&json!(credits));
        let revision = predicted_collection_revision(tx, "works", &json!([work]).to_string())?;
        let body =
            json!({"workId":work,"credits":credits,"people":people,"expectedRevision":revision});
        remember(enqueue_collection_command(
            tx,
            &status,
            "setAvCredits",
            work,
            body.clone(),
        )?)?;
        project_av_credits(tx, &body, &now)?;
    }
    if !plan.is_new && !operations.is_empty() {
        tx.execute(
            "UPDATE collections SET updated_at=?2 WHERE id=?1",
            params![work, now],
        )?;
    }
    Ok(operations)
}
