// Included in collection_authority: person revisions are independent of work CAS.
const PERSON_MEMO_LIMIT: usize = 2000;
const PORTRAIT_BYTE_LIMIT: usize = 5 * 1024 * 1024;

fn portrait_digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn store_portrait_image(tx: &Transaction<'_>, bytes: &[u8], attribution: Value) -> Result<Value, LibraryError> {
    use std::io::Cursor;
    let format = image::guess_format(bytes).map_err(|_| LibraryError::InvalidWorkArtwork)?;
    let (w, h) = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions().map_err(|_| LibraryError::InvalidWorkArtwork)?;
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 32_000_000 || bytes.len() > 16 * 1024 * 1024 {
        return Err(LibraryError::InvalidWorkArtwork);
    }
    let decoded = image::load_from_memory_with_format(bytes, format).map_err(|_| LibraryError::InvalidWorkArtwork)?;
    let resized = if w > 1600 || h > 1600 { decoded.resize(1600, 1600, image::imageops::FilterType::Lanczos3) } else { decoded };
    let rgb = resized.to_rgb8();
    let mut encoded = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 88)
        .encode_image(&rgb).map_err(|_| LibraryError::InvalidWorkArtwork)?;
    if encoded.len() > PORTRAIT_BYTE_LIMIT { return Err(LibraryError::InvalidWorkArtwork); }
    let sha = portrait_digest(&encoded);
    tx.execute("INSERT OR IGNORE INTO collection_authority_portrait_blobs(sha256,bytes) VALUES(?1,?2)", params![sha,encoded])?;
    Ok(json!({"kind":"image","original":{"sha256":sha,"sizeBytes":encoded.len(),"contentType":"image/jpeg"},
        "width":rgb.width(),"height":rgb.height(),"attribution":attribution}))
}

fn local_person_portrait(tx: &Transaction<'_>, person: &str) -> Result<Value, LibraryError> {
    let row: Option<(String, Option<String>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<Vec<u8>>, Option<String>, Option<String>, Option<String>)> =
        tx.query_row("SELECT kind,artwork_id,x,y,w,h,image_bytes,source_url,license,author FROM collection_person_portraits WHERE person_id=?1", [person],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?))).optional()?;
    let Some((kind,art,x,y,w,h,bytes,source_url,license,author)) = row else { return Ok(Value::Null); };
    if kind == "crop" { return Ok(json!({"kind":"crop","artworkId":art,"rect":{"x":x,"y":y,"w":w,"h":h}})); }
    store_portrait_image(tx, bytes.as_deref().ok_or(LibraryError::InvalidWorkArtwork)?,
        json!({"source":kind,"sourceUrl":source_url,"license":license,"author":author}))
}

fn capture_people_reconcile(tx: &Transaction<'_>) -> Result<(), LibraryError> {
    let Some(l) = local(tx)? else { return Ok(()); };
    let marker = format!("avPeopleReconcileCaptured:{}:{}", l.id.library, l.id.epoch);
    if tx.query_row("SELECT EXISTS(SELECT 1 FROM notes_state WHERE key=?1)", [&marker], |r| r.get::<_,bool>(0))? { return Ok(()); }
    let people = tx.prepare("SELECT p.id,p.memo,EXISTS(SELECT 1 FROM av_favorite_performers f WHERE f.person_id=p.id) FROM collection_people p ORDER BY p.id")?
        .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,bool>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
    for (person,memo,favorite) in people {
        let portrait = local_person_portrait(tx, &person)?;
        tx.execute("INSERT OR IGNORE INTO collection_authority_people_reconcile(library_id,epoch,person_id,local_payload) VALUES(?1,?2,?3,?4)",
            params![l.id.library,l.id.epoch,person,json!({"memo":memo,"favorite":favorite,"portraitSelection":portrait}).to_string()])?;
    }
    tx.execute("INSERT INTO notes_state(key,value) VALUES(?1,'1')", [marker])?;
    Ok(())
}

fn confirmed_person(db: &Connection, person: &str) -> Result<Option<Value>, LibraryError> {
    let l = local(db)?.ok_or(LibraryError::CollectionAuthorityNotAdopted)?;
    let raw: Option<String> = db.query_row("SELECT payload FROM collection_authority_people_cache WHERE library_id=?1 AND epoch=?2 AND person_id=?3",
        params![l.id.library,l.id.epoch,person], |r| r.get(0)).optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| LibraryError::InvalidCloudResponse)).transpose()
}

fn predicted_person(db: &Connection, person: &str) -> Result<Value, LibraryError> {
    let mut value = confirmed_person(db, person)?;
    let rows = db.prepare("SELECT payload FROM collection_authority_outbox WHERE state='pending' ORDER BY seq")?
        .query_map([], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    for raw in rows {
        let body: Value = serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if body["commandType"] == "setAvCredits" && value.is_none() {
            if let Some(p) = body["people"].as_array().and_then(|ps| ps.iter().find(|p| p["personId"] == person)) {
                value = Some(json!({"personId":person,"displayName":p["displayName"],"nameJa":p["nameJa"],"memo":null,"favorite":false,"portraitSelection":null,"entityRevision":1}));
            }
        }
        if body["personId"] != person { continue; }
        let state = value.as_mut().ok_or(LibraryError::CollectionAuthorityOperationUnavailable)?;
        let mut changed = false;
        if body["commandType"] == "setPerson" {
            for (field,v) in body["changes"].as_object().ok_or(LibraryError::InvalidCloudResponse)? {
                changed |= state[field] != *v;
                state[field] = v.clone();
            }
        } else if body["commandType"] == "setPersonPortrait" {
            changed = state["portraitSelection"] != body["portrait"];
            state["portraitSelection"] = body["portrait"].clone();
        }
        if changed { state["entityRevision"] = json!(integer(state,"entityRevision")? + 1); }
    }
    value.ok_or(LibraryError::CollectionAuthorityOperationUnavailable)
}

fn project_person_fields(tx: &Transaction<'_>, person: &str, fields: &Value, now: &str) -> Result<(), LibraryError> {
    if let Some(memo) = fields.get("memo") {
        tx.execute("UPDATE collection_people SET memo=?2,updated_at=?3 WHERE id=?1", params![person,sql_value(memo)?,now])?;
    }
    if let Some(favorite) = fields.get("favorite") {
        if favorite.as_bool().ok_or(LibraryError::InvalidCloudResponse)? {
            tx.execute("INSERT OR IGNORE INTO av_favorite_performers(person_id,created_at) VALUES(?1,?2)", params![person,now])?;
        } else { tx.execute("DELETE FROM av_favorite_performers WHERE person_id=?1", [person])?; }
    }
    Ok(())
}

fn project_person_portrait(tx: &Transaction<'_>, person: &str, choice: &Value, now: &str) -> Result<(), LibraryError> {
    if choice.is_null() {
        tx.execute("DELETE FROM collection_person_portraits WHERE person_id=?1", [person])?;
    } else if choice["kind"] == "crop" {
        // A baseline's artwork page may not have arrived yet. Selections replays this.
        if !tx.query_row("SELECT EXISTS(SELECT 1 FROM collection_work_artworks WHERE id=?1)", [text(choice,"artworkId")?], |r| r.get::<_,bool>(0))? { return Ok(()); }
        tx.execute("DELETE FROM collection_person_portraits WHERE person_id=?1", [person])?;
        let r = &choice["rect"];
        tx.execute("INSERT INTO collection_person_portraits(person_id,kind,artwork_id,x,y,w,h,updated_at) VALUES(?1,'crop',?2,?3,?4,?5,?6,?7)",
            params![person,text(choice,"artworkId")?,sql_value(&r["x"])?,sql_value(&r["y"])?,sql_value(&r["w"])?,sql_value(&r["h"])?,now])?;
    } else if choice["kind"] == "image" {
        let bytes: Option<Vec<u8>> = tx.query_row("SELECT bytes FROM collection_authority_portrait_blobs WHERE sha256=?1", [text(&choice["original"],"sha256")?], |r| r.get(0)).optional()?;
        // Keep the existing picture until the confirmed bytes have arrived.
        let Some(bytes) = bytes else { return Ok(()); };
        let a = &choice["attribution"];
        let kind = if a["source"] == "stashdb" { "stashdb" } else { "commons" };
        tx.execute("DELETE FROM collection_person_portraits WHERE person_id=?1", [person])?;
        tx.execute("INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,source_url,license,author,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'authority portrait',?7,?8,?9,?10)",
            params![person,kind,bytes,text(&choice["original"],"contentType")?,integer(choice,"width")?,integer(choice,"height")?,a["sourceUrl"].as_str().unwrap_or(""),a["license"].as_str().unwrap_or(""),a["author"].as_str().unwrap_or(""),now])?;
    } else { return Err(LibraryError::InvalidCloudResponse); }
    Ok(())
}

fn receive_person(tx: &Transaction<'_>, person: &Value, now: &str) -> Result<(), LibraryError> {
    let l = local(tx)?.ok_or(LibraryError::CollectionAuthorityNotAdopted)?;
    let id = safe_id(text(person,"personId")?)?;
    let rev = integer(person,"entityRevision")?;
    if rev < 1 { return Err(LibraryError::InvalidCloudResponse); }
    let previous = confirmed_person(tx, id)?;
    if previous.as_ref().is_some_and(|v| v["entityRevision"].as_i64().is_some_and(|r| r > rev)) { return Ok(()); }
    tx.execute("INSERT INTO collection_authority_people_cache(library_id,epoch,person_id,revision,payload) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(library_id,epoch,person_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",
        params![l.id.library,l.id.epoch,id,rev,person.to_string()])?;
    tx.execute("INSERT INTO collection_people(id,display_name,name_ja,created_at,updated_at) VALUES(?1,?2,?3,?4,?4) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,name_ja=excluded.name_ja",
        params![id,text(person,"displayName")?,sql_value(&person["nameJa"])?,now])?;
    project_person_fields(tx,id,person,now)?;
    project_person_portrait(tx,id,&person["portraitSelection"],now)?;
    Ok(())
}

pub(crate) fn enqueue_person_changes(tx: &Transaction<'_>, status: &CollectionAuthorityStatus, person: &str, changes: Value) -> Result<(), LibraryError> {
    if !status.active { return Ok(()); }
    safe_id(person)?;
    let state = predicted_person(tx,person)?;
    let mut desired = json!({});
    let mut expected = json!({});
    for (field,value) in changes.as_object().ok_or(LibraryError::InvalidCollectionMetadata)? {
        if field == "memo" {
            if !value.is_null() && value.as_str().is_none_or(|s| s.chars().count() > PERSON_MEMO_LIMIT) { return Err(LibraryError::InvalidCollectionMetadata); }
        } else if field != "favorite" || !value.is_boolean() { return Err(LibraryError::InvalidCollectionMetadata); }
        if state[field] != *value { desired[field] = value.clone(); expected[field] = state[field].clone(); }
    }
    if !desired.as_object().unwrap().is_empty() {
        enqueue_collection_command(tx,status,"setPerson",person,json!({"personId":person,"changes":desired,"expected":expected}))?;
        project_person_fields(tx,person,&changes,&chrono::Utc::now().to_rfc3339())?;
    }
    Ok(())
}

pub(crate) fn enqueue_person_portrait(tx: &Transaction<'_>, status: &CollectionAuthorityStatus, person: &str, portrait: Value) -> Result<(), LibraryError> {
    if !status.active { return Ok(()); }
    let state = predicted_person(tx,person)?;
    if state["portraitSelection"] != portrait {
        enqueue_collection_command(tx,status,"setPersonPortrait",person,json!({"personId":person,"portrait":portrait,"expectedRevision":integer(&state,"entityRevision")?}))?;
    }
    project_person_portrait(tx,person,&portrait,&chrono::Utc::now().to_rfc3339())?;
    Ok(())
}

pub(crate) fn enqueue_stored_person_portrait(tx: &Transaction<'_>, status: &CollectionAuthorityStatus, person: &str) -> Result<(), LibraryError> {
    if status.active { enqueue_person_portrait(tx,status,person,local_person_portrait(tx,person)?)?; }
    Ok(())
}

impl Library {
    fn reconcile_av_people_with(&self, status: &CollectionAuthorityStatus, read: &dyn Fn(&str) -> Result<Value, LibraryError>) -> Result<usize, LibraryError> {
        let id = status.identity(&*self.connection()?)?.ok_or(LibraryError::CollectionAuthorityNotAdopted)?;
        ensure_collection_write_ready(&*self.connection()?,status)?;
        let people = self.connection()?.prepare("SELECT person_id,local_payload FROM collection_authority_people_reconcile WHERE library_id=?1 AND epoch=?2 AND queued=0 ORDER BY person_id LIMIT 50")?
            .query_map(params![id.library,id.epoch], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
        let mut count = 0;
        for (person,raw) in people {
            let response = read(&person)?;
            // Unpublished local people wait for a later setAvCredits; never invent names or clear data.
            if response["detail"]["code"] == "personNotFound" { continue; }
            let server = &response["person"];
            let mut db = self.connection()?;
            let tx = db.transaction()?;
            ensure_collection_write_ready(&tx,status)?;
            if tx.query_row("SELECT queued FROM collection_authority_people_reconcile WHERE library_id=?1 AND epoch=?2 AND person_id=?3", params![id.library,id.epoch,person], |r| r.get::<_,bool>(0))? { continue; }
            let pc: Value = serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
            receive_person(&tx,server,&chrono::Utc::now().to_rfc3339())?;
            let mut changes = json!({});
            // The approved exception is PC-wins for differing nonempty memo/portrait.
            if let Some(memo) = pc["memo"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
                if server["memo"] != memo { changes["memo"] = json!(memo); }
            }
            if pc["favorite"] == true && server["favorite"] != true { changes["favorite"] = json!(true); }
            let before: i64 = tx.query_row("SELECT COUNT(*) FROM collection_authority_outbox", [], |r| r.get(0))?;
            enqueue_person_changes(&tx,status,&person,changes)?;
            if !pc["portraitSelection"].is_null() && pc["portraitSelection"] != server["portraitSelection"] {
                enqueue_person_portrait(&tx,status,&person,pc["portraitSelection"].clone())?;
            }
            reapply_pending_core_edits(&tx)?;
            tx.execute("UPDATE collection_authority_people_reconcile SET queued=1 WHERE library_id=?1 AND epoch=?2 AND person_id=?3", params![id.library,id.epoch,person])?;
            let after: i64 = tx.query_row("SELECT COUNT(*) FROM collection_authority_outbox", [], |r| r.get(0))?;
            count += (after-before) as usize;
            tx.commit()?;
        }
        if count > 0 { eprintln!("AV people reconcile: queued {count} commands; receipt/conflict counts remain in the status center"); }
        Ok(count)
    }

    fn materialize_person_portraits_with(&self, status: &CollectionAuthorityStatus, download: &dyn Fn(&crate::cloud::collections::ArtworkBlob) -> Result<Vec<u8>, LibraryError>) -> Result<usize, LibraryError> {
        let id = status.identity(&*self.connection()?)?.ok_or(LibraryError::CollectionAuthorityNotAdopted)?;
        let rows = self.connection()?.prepare("SELECT payload FROM collection_authority_people_cache WHERE library_id=?1 AND epoch=?2 AND json_extract(payload,'$.portraitSelection.kind')='image' AND NOT EXISTS(SELECT 1 FROM collection_authority_portrait_blobs b WHERE b.sha256=json_extract(payload,'$.portraitSelection.original.sha256')) LIMIT 8")?
            .query_map(params![id.library,id.epoch], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        let mut count = 0;
        for raw in rows {
            let person: Value = serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
            let blob: crate::cloud::collections::ArtworkBlob = serde_json::from_value(person["portraitSelection"]["original"].clone()).map_err(|_| LibraryError::InvalidCloudResponse)?;
            if blob.size_bytes > PORTRAIT_BYTE_LIMIT as u64 { return Err(LibraryError::InvalidCloudResponse); }
            let bytes = download(&blob)?;
            if bytes.len() as u64 != blob.size_bytes || portrait_digest(&bytes) != blob.sha256 { return Err(LibraryError::InvalidCloudResponse); }
            let mut db = self.connection()?;
            let tx = db.transaction()?;
            ensure_collection_write_ready(&tx,status)?;
            tx.execute("INSERT OR IGNORE INTO collection_authority_portrait_blobs(sha256,bytes) VALUES(?1,?2)",params![blob.sha256,bytes])?;
            if let Some(current) = confirmed_person(&tx,text(&person,"personId")?)? {
                project_person_portrait(&tx,text(&person,"personId")?,&current["portraitSelection"],&chrono::Utc::now().to_rfc3339())?;
            }
            reapply_pending_core_edits(&tx)?;
            tx.commit()?;
            count += 1;
        }
        Ok(count)
    }
}
