//! Verification-only staging v2. Presentation values come from the ordinary replica;
//! ancillary authority rows and cursors are read through that same SQLite transaction.
use super::*;
use rusqlite::{OptionalExtension, Transaction};
use serde_json::{json, Value};

const FIELDS: &[&str] = &[
    "description",
    "coverAssetId",
    "year",
    "originalTitle",
    "runtimeMinutes",
    "author",
    "director",
    "developer",
    "publisher",
    "platforms",
    "productionCompany",
    "releaseDate",
    "externalScore",
    "myScore",
    "genres",
    "overview",
    "status",
    "ownedPlatform",
];

impl Library {
    /// Offline extraction: SQLite only opens the copied database. Source image
    /// files are read in place; derived previews are written only to the snapshot.
    /// The caller must close the app before copying (a nonempty WAL is refused).
    pub fn export_collection_baseline(
        source: &std::path::Path,
        snapshot_dir: &std::path::Path,
        endpoint: &str,
        revision: &str,
    ) -> Result<(Value, Value), Box<dyn std::error::Error>> {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        fn hash(path: &std::path::Path) -> Result<Vec<u8>, std::io::Error> {
            let mut file = std::fs::File::open(path)?;
            let mut digest = Sha256::new();
            let mut buffer = [0u8; 65536];
            loop {
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                digest.update(&buffer[..count]);
            }
            Ok(digest.finalize().to_vec())
        }
        fn no_wal(root: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
            match std::fs::metadata(root.join("library.sqlite-wal")) {
                Ok(m) if m.len() != 0 => {
                    Err("Nonempty library.sqlite-wal; close the app first".into())
                }
                Ok(_) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.into()),
            }
        }
        let root = source.canonicalize()?;
        // Resolve the existing parent before creating anything (including symlinks).
        let parent = snapshot_dir
            .parent()
            .ok_or("Snapshot directory needs a parent")?
            .canonicalize()?;
        let destination = parent.join(
            snapshot_dir
                .file_name()
                .ok_or("Invalid snapshot directory")?,
        );
        if destination.starts_with(&root) || destination.exists() {
            return Err("Snapshot must be a new directory outside the source library".into());
        }
        if endpoint.is_empty() || revision.is_empty() {
            return Err("Endpoint and revision are required".into());
        }
        no_wal(&root)?;
        let source_db = root.join("library.sqlite");
        let before = hash(&source_db)?;
        std::fs::create_dir(&destination)?;
        let destination = destination.canonicalize()?;
        let copied = destination.join("library.sqlite");
        std::fs::copy(&source_db, &copied)?;
        no_wal(&root)?;
        if hash(&copied)? != before || hash(&source_db)? != before {
            return Err("Source database changed while copying; close the app and retry".into());
        }
        let result = cache::with_export_cache(&destination, || -> Result<_, LibraryError> {
            let mut db = rusqlite::Connection::open_with_flags(
                &copied,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let tx = db.transaction()?;
            let library_id = crate::library::library_id_on(&tx)?;
            let adopted: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM mobile_collection_personal_edit_sync WHERE endpoint=?1 AND library_id=?2)",
                rusqlite::params![endpoint, library_id], |r| r.get(0))?;
            let feature = adopted.then(|| PersonalEditFeature {
                endpoint: endpoint.into(),
                library_id,
                edit_version: 3,
            });
            let features = ReplicaFeatures {
                av: true,
                work_record: true,
                cover_focus: true,
                people: true,
                portrait_image: true,
                av_credit_name: true,
            };
            let snapshot = snapshot_from_transaction(
                &root,
                &tx,
                Some(revision.into()),
                feature.as_ref(),
                features,
                &|_| {},
            )?;
            let baseline = from_snapshot(&tx, &snapshot, endpoint, revision)?;
            let replica = serde_json::to_value(&snapshot.replica)
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            tx.commit()?;
            Ok((baseline, replica))
        });
        no_wal(&root)?;
        if hash(&source_db)? != before {
            return Err("Source database changed during export".into());
        }
        Ok(result?)
    }

    pub(crate) fn collection_authority_baseline(
        &self,
        endpoint: &str,
        revision: &str,
        feature: Option<&PersonalEditFeature>,
        features: ReplicaFeatures,
        progress: Reporter<'_>,
    ) -> Result<Value, LibraryError> {
        let root = self
            .root()
            .canonicalize()
            .map_err(|_| LibraryError::InvalidWorkArtwork)?;
        let mut db = rusqlite::Connection::open_with_flags(
            root.join("library.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        let tx = db.transaction()?;
        let snapshot = snapshot_from_transaction(
            &root,
            &tx,
            Some(revision.into()),
            feature,
            features,
            progress,
        )?;
        let baseline = from_snapshot(&tx, &snapshot, endpoint, revision)?;
        tx.commit()?;
        Ok(baseline)
    }
}

fn state(tx: &Transaction<'_>, prefix: &str, endpoint: &str) -> Result<Value, LibraryError> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT value FROM notes_state WHERE key=?1",
            [format!("{prefix}:{endpoint}")],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| LibraryError::InvalidCloudResponse))
        .transpose()
        .map(|v| v.unwrap_or_else(|| json!({})))
}

fn rows(tx: &Transaction<'_>, sql: &str, id: &str) -> Result<Vec<Value>, LibraryError> {
    let raw = tx
        .prepare(sql)?
        .query_map([id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    raw.into_iter()
        .map(|s| serde_json::from_str(&s).map_err(|_| LibraryError::InvalidCloudResponse))
        .collect()
}

pub(super) fn from_snapshot(
    tx: &Transaction<'_>,
    snapshot: &Snapshot,
    endpoint: &str,
    revision: &str,
) -> Result<Value, LibraryError> {
    let replica =
        serde_json::to_value(&snapshot.replica).map_err(|_| LibraryError::InvalidCloudResponse)?;
    let library_id = crate::library::library_id_on(tx)?;
    let cursor: i64 = tx.query_row(
        "SELECT received_cursor FROM mobile_collection_personal_edit_sync WHERE endpoint=?1 AND library_id=?2",
        rusqlite::params![endpoint, library_id], |r| r.get(0)).optional()?.unwrap_or(0);
    let binding_state = state(tx, "collectionBindingSync", endpoint)?;
    let release_state = state(tx, "collectionReleaseSync", endpoint)?;
    let mut works = Vec::new();
    let mut artworks = Vec::new();
    let mut volumes = Vec::new();
    let mut bindings = Vec::new();
    let mut sources = Vec::new();
    let mut ownership = Vec::new();
    let mut memberships = Vec::new();
    let mut portraits = BTreeMap::new();
    for work in replica["collections"]
        .as_array()
        .ok_or(LibraryError::InvalidCloudResponse)?
    {
        let id = work["id"]
            .as_str()
            .ok_or(LibraryError::InvalidCloudResponse)?;
        let legacy: Option<String> = tx.query_row(
            "SELECT legacy_kind FROM collections WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        let fields: serde_json::Map<String, Value> = FIELDS
            .iter()
            .map(|key| ((*key).into(), work[*key].clone()))
            .collect();
        let mut av = work["av"].clone();
        let credits = av
            .as_object_mut()
            .and_then(|v| v.remove("people"))
            .unwrap_or_else(|| json!([]));
        let mut staged_credits = Vec::new();
        for person in credits
            .as_array()
            .ok_or(LibraryError::InvalidCloudResponse)?
        {
            let person_id = person["id"]
                .as_str()
                .ok_or(LibraryError::InvalidCloudResponse)?;
            if let Some(hash) = person["portraitImage"]["sha256"].as_str() {
                // The portrait manifest retains its published dimensions. Its hash is
                // backed by the same ordinary-publication upload as artwork originals.
                snapshot
                    .files
                    .get(hash)
                    .ok_or(LibraryError::InvalidCloudResponse)?;
                portraits.insert(person_id.to_owned(), person["portraitImage"].clone());
            }
            let mut credit = json!({"personId":person["id"], "name":person["name"], "nameJa":person["nameJa"],
                "role":person["role"], "order":person["order"], "portraitCrop":person["portraitCrop"]});
            if let Some(name) = person.get("creditName") { credit["creditName"] = name.clone(); }
            staged_credits.push(credit);
        }
        let art = work["artworks"]
            .as_array()
            .ok_or(LibraryError::InvalidCloudResponse)?;
        let spine = art
            .iter()
            .find(|a| a["kind"] == "spine" && a["selected"] == true)
            .map(|a| a["id"].clone());
        works.push(json!({"workId":id, "type":work["type"], "legacyKind":legacy, "name":work["name"],
            "fields":fields, "showcase":work["showcase"], "showcaseOrder":work["showcaseOrder"],
            "selection":{"work":work["selectedWorkArtworkId"], "hero":work["selectedHeroArtworkId"],
                "backdrop":work["selectedBackdropArtworkId"], "spine":spine},
            "details":{"series":work["series"], "film":work["film"], "av":av}, "avCredits":staged_credits,
            "derived":{"unreadReleaseCount":work["unreadReleaseCount"], "releaseWatch":work["releaseWatch"],
                "ownedVolumes":work["ownedVolumes"], "releaseSchedule":work["releaseSchedule"]},
            "createdAt":work["createdAt"], "updatedAt":work["updatedAt"]}));
        // The selection slots are what the screens show (the published selected ids, which
        // may be a fallback volume cover). Export the slot kinds' flags from those slots so
        // flags and slots always agree; other kinds keep their stored flag.
        let slot_flag = |a: &Value| -> Value {
            let id = &a["id"];
            match a["kind"].as_str() {
                Some("cover" | "volume_cover") => json!(*id == work["selectedWorkArtworkId"]),
                Some("hero") => json!(*id == work["selectedHeroArtworkId"]),
                Some("backdrop") => json!(*id == work["selectedBackdropArtworkId"]),
                _ => a["selected"].clone(),
            }
        };
        for (order, a) in art.iter().enumerate() {
            let aid = a["id"].as_str().ok_or(LibraryError::InvalidCloudResponse)?;
            let metadata = rows(tx, "SELECT json_object('provider',provider,'providerImageId',provider_image_id,'width',width,'height',height,'language',language,'createdAt',created_at) FROM collection_work_artworks WHERE id=?1", aid)?.pop().unwrap_or_else(|| json!({"createdAt":work["createdAt"]}));
            artworks.push(json!({"artworkId":aid,"workId":id,"kind":a["kind"],"selected":slot_flag(a),"order":order,
                "provider":metadata["provider"],"providerImageId":metadata["providerImageId"],
                "width":metadata["width"],"height":metadata["height"],"language":metadata["language"],
                "createdAt":metadata["createdAt"],"original":a["original"],"thumbnail":a["thumbnail"]}));
        }
        for (order, v) in work["volumes"]
            .as_array()
            .ok_or(LibraryError::InvalidCloudResponse)?
            .iter()
            .enumerate()
        {
            let vid = v["id"].as_str().ok_or(LibraryError::InvalidCloudResponse)?;
            let metadata = rows(tx, "SELECT json_object('sortOrder',sort_order,'sourceProvider',source_provider,'sourceCoverId',source_cover_id) FROM collection_volumes WHERE id=?1", vid)?.pop().unwrap_or_else(|| json!({"sortOrder":order}));
            volumes.push(json!({"volumeId":vid,"workId":id,"volumeNumber":v["volumeNumber"],"editionIndex":v["editionIndex"],
                "sortOrder":metadata["sortOrder"],"order":order,"displayLabel":v["displayLabel"],"coverArtworkId":v["coverArtworkId"],
                "sourceProvider":metadata["sourceProvider"],"sourceCoverId":metadata["sourceCoverId"],"coverFocusX":v["coverFocusX"],
                "published":{"releaseStatus":v["releaseStatus"],"localReleaseDate":v["localReleaseDate"],"isbn13":v["isbn13"]}}));
        }
        for mut b in rows(tx, "SELECT json_object('workId',collection_id,'provider',provider,'externalId',external_id,'config',json(provider_config_json),'snapshot',json(provider_data_json),'lastSyncedAt',last_synced_at) FROM collection_external_bindings WHERE collection_id=?1 ORDER BY provider", id)? {
            b["values"] = provider_values(b["provider"].as_str().unwrap_or_default(), &b["snapshot"])?;
            bindings.push(b);
        }
        sources.extend(rows(tx, "SELECT json_object('workId',collection_id,'volumeNumber',volume_number,'provider',provider,'providerItemId',provider_item_id,'title',title,'author',author,'publisher',publisher,'isbn13',isbn13,'publicationDate',publication_date,'itemUrl',item_url,'data',json(provider_data_json)) FROM collection_volume_sources WHERE collection_id=?1 ORDER BY volume_number,provider", id)?);
        ownership.extend(rows(tx, "SELECT json_object('workId',collection_id,'volumeNumber',volume_number,'editionIndex',edition_index,'physical',json(CASE physical WHEN 1 THEN 'true' ELSE 'false' END),'digital',json(CASE digital WHEN 1 THEN 'true' ELSE 'false' END)) FROM collection_volume_ownership WHERE collection_id=?1 ORDER BY volume_number,edition_index", id)?);
        memberships.extend(rows(tx, "SELECT json_object('workId',collection_id,'assetId',asset_id,'addedAt',added_at) FROM collection_assets WHERE collection_id=?1 ORDER BY asset_id", id)?);
    }
    let people: Vec<_> = replica["people"].as_array().into_iter().flatten().map(|p| json!({
        "personId":p["id"],"memo":p["memo"],"favorite":p["favorite"],"profile":p["profile"],"portrait":p["portrait"],
        "portraitImage":p["id"].as_str().and_then(|id| portraits.get(id))
    })).collect();
    Ok(
        json!({"stagingVersion":2,"libraryId":library_id,"personalEditCursor":cursor,"legacyRevision":revision,
        "bindingRequestSequence":binding_state["cursor"].as_i64().unwrap_or(0),
        "releaseReadCursor":release_state["readCursor"].as_i64().unwrap_or(0),"releaseGeneration":release_state["generation"].as_i64().unwrap_or(0),
        "works":works,"bindings":bindings,"artworks":artworks,"volumes":volumes,"volumeSources":sources,
        "ownership":ownership,"memberships":memberships,"people":people}),
    )
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}
fn list(value: &Value, objects: bool) -> Option<String> {
    text(value).or_else(|| {
        let names: Vec<_> = value
            .as_array()?
            .iter()
            .filter_map(|v| text(v).or_else(|| objects.then(|| text(&v["name"])).flatten()))
            .collect();
        (!names.is_empty()).then(|| names.join(" · "))
    })
}
// These are the PC provider snapshot projections, not the user's merged work fields.
pub(crate) fn provider_values(provider: &str, v: &Value) -> Result<Value, LibraryError> {
    if v.is_null() {
        return Ok(Value::Null);
    }
    Ok(match provider {
        "tmdb" => json!({"originalTitle":text(&v["original_title"]),
            "director":list(&v["directors"],false).or_else(|| text(&v["director"])),
            "productionCompany":list(&v["production_companies"],false).or_else(|| text(&v["production_company"])),
            "releaseDate":text(&v["release_date"]),"runtimeMinutes":v["runtime_minutes"].as_i64().filter(|n| *n>0),
            "genres":list(&v["genres"],false),"overview":text(&v["overview"]),"externalScore":v["external_score"].as_i64()}),
        "igdb" => {
            let companies = |role: &str| {
                let names: Vec<_> = v["involved_companies"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|c| c[role] == true)
                    .filter_map(|c| text(&c["company"]["name"]))
                    .collect();
                (!names.is_empty()).then(|| names.join(" · "))
            };
            let releases: Vec<_> = v["release_dates"]
                .as_array()
                .into_iter()
                .flatten()
                .collect();
            let timestamp = v["first_release_date"]
                .as_i64()
                .into_iter()
                .chain(releases.iter().filter_map(|r| r["date"].as_i64()))
                .min();
            let date = timestamp
                .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
                .map(|d| d.format("%Y-%m-%d").to_string());
            let platforms: Vec<_> = releases
                .iter()
                .filter_map(|r| text(&r["platform"]["name"]))
                .collect();
            json!({"developer":text(&v["developer"]).or_else(|| companies("developer")),
                "publisher":text(&v["publisher"]).or_else(|| companies("publisher")),
                "releaseDate":text(&v["release_date"]).or(date),
                "platforms":list(&v["platforms"],true).or_else(|| (!platforms.is_empty()).then(|| platforms.join(" · "))),
                "genres":list(&v["genres"],true),"overview":text(&v["overview"]).or_else(|| text(&v["summary"]))})
        }
        "mangadex" => {
            let p = crate::library::mangadex::parse_work_preview(
                &v["detail"].to_string(),
                &v["covers"].to_string(),
            )?;
            json!({"year":p.year,"author":p.author,"genres":p.genres,"overview":p.overview,"originalTitle":p.japanese_title})
        }
        // Bindings with no work-field merge still retain their complete raw snapshot.
        _ => json!({}),
    })
}
