use super::{models::*, provider::decode_jacket, *};
use crate::library::{
    av_models::{AvError, CoverSurface},
    work_artwork::PreparedWorkArtwork,
    Library,
};
use rusqlite::{params, Transaction};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read},
};

pub(super) fn validate_fields(fields: &Fields) -> Result<(), AvError> {
    for (value, limit) in [
        (&fields.title_ja, 4000),
        (&fields.maker, 240),
        (&fields.label, 240),
        (&fields.series, 240),
    ] {
        if value.as_ref().is_some_and(|v| v.chars().count() > limit) {
            return Err(AvError::Invalid);
        }
    }
    if let Some(date) = fields.release_date.as_ref().filter(|d| !d.is_empty()) {
        let parsed =
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| AvError::Invalid)?;
        if date.len() != 10 || parsed.format("%Y-%m-%d").to_string() != *date {
            return Err(AvError::Invalid);
        }
    }
    if fields.genres.as_ref().is_some_and(|g| {
        g.len() > 100
            || g.iter()
                .any(|v| v.trim().is_empty() || v.chars().count() > 120)
    }) {
        return Err(AvError::Invalid);
    }
    Ok(())
}
fn apply_people(
    tx: &Transaction<'_>,
    collection: &str,
    choices: &[PersonChoice],
    role: &str,
    candidate: &StoredCandidate,
    created: &mut BTreeMap<String, String>,
    now: &str,
) -> Result<(), AvError> {
    let allowed = if role == "performer" {
        candidate
            .movie
            .actresses
            .iter()
            .map(|p| p.name.as_str())
            .collect::<BTreeSet<_>>()
    } else {
        candidate
            .movie
            .directors
            .iter()
            .map(String::as_str)
            .collect()
    };
    crate::library::collection_authority::fence_collection_operation(tx)?;
    let mut seen = BTreeSet::new();
    let mut seen_people = BTreeSet::new();
    let mut order:i64=tx.query_row("SELECT COALESCE(MAX(sort_order)+1,0) FROM collection_person_relations WHERE collection_id=?1 AND role=?2",params![collection,role],|r|r.get(0))?;
    for choice in choices {
        let name = choice.name_ja();
        if !allowed.contains(name) || !seen.insert(name) {
            return Err(AvError::Invalid);
        }
        let mapping = candidate
            .names
            .iter()
            .find(|m| m.name_ja == name)
            .cloned()
            .unwrap_or_else(|| NameMapping::japanese(name));
        let id = match choice {
            PersonChoice::Link { person_id, .. } => {
                if !tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM collection_people WHERE id=?1)",
                    [person_id],
                    |r| r.get::<_, bool>(0),
                )? {
                    return Err(AvError::Invalid);
                }
                // User-confirmed links may fill missing identifiers, never overwrite another identity.
                tx.execute("UPDATE collection_people SET name_ja=COALESCE(name_ja,?2),wikidata_id=COALESCE(wikidata_id,?3),fanza_actress_id=COALESCE(fanza_actress_id,?4),updated_at=?5 WHERE id=?1",params![person_id,name,mapping.wikidata_id,mapping.fanza_actress_id,now])?;
                person_id.clone()
            }
            PersonChoice::New { display_name, .. } => {
                let display_name = display_name.trim();
                if display_name.is_empty() || display_name.chars().count() > 120 {
                    return Err(AvError::Invalid);
                }
                if let Some(id) = created.get(name) {
                    id.clone()
                } else {
                    let id = uuid::Uuid::new_v4().to_string();
                    tx.execute("INSERT INTO collection_people(id,display_name,name_ja,wikidata_id,fanza_actress_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",params![id,display_name,name,mapping.wikidata_id,mapping.fanza_actress_id,now])?;
                    created.insert(name.into(), id.clone());
                    id
                }
            }
        };
        if !seen_people.insert(id.clone()) {
            return Err(AvError::Invalid);
        }
        // Keep pre-existing credits and append only the explicitly selected new links, in UI order.
        let inserted=tx.execute("INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order,credit_name) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(collection_id,person_id,role) DO NOTHING",params![collection,id,role,order,name])?;
        if inserted != 0 {
            order += 1;
        }
    }
    Ok(())
}
impl Library {
    pub fn apply_av_link(&self, id: &str, request: ApplyRequest) -> Result<ApplyResult, AvError> {
        // With the server inbox confirmed, the choice goes through the authority outbox.
        if self.av_link_route()? == super::routed::Route::Server {
            return self.apply_av_link_routed(id, request);
        }
        // Creating AV Collections/people/credits has no authority command yet (1B §4).
        // The inbox item stays `found`, so it can be applied after the follow-up.
        crate::library::collection_authority::fence_collection_operation(&*self.connection()?)?;
        validate_fields(&request.fields)?;
        if request.performers.len() + request.directors.len() > 100
            || request.collection_id.is_some() == request.new_collection_name.is_some()
        {
            return Err(AvError::Invalid);
        }
        let (candidate, code, generation) = {
            let connection = self.connection()?;
            let item = inbox(&connection, id)?;
            if item.status != "found" {
                return Err(AvError::Stale);
            }
            if let Some(target) = &request.collection_id {
                if Some(super::super::av_artwork::cover_set(&connection, target)?.revision)
                    != request.expected_revision
                {
                    return Err(AvError::Stale);
                }
            }
            let generation = connection.query_row(
                "SELECT generation FROM av_link_inbox WHERE id=?1",
                [id],
                |r| r.get::<_, i64>(0),
            )?;
            (
                stored(&connection, id)?,
                item.normalized_code.ok_or(AvError::Invalid)?,
                generation,
            )
        };
        let collection = request
            .collection_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let decisions = [
            (CoverSurface::Front, request.surfaces.front),
            (CoverSurface::Spine, request.surfaces.spine),
            (CoverSurface::Back, request.surfaces.back),
        ];
        let mut prepared: Vec<(CoverSurface, PreparedWorkArtwork)> = Vec::new();
        if decisions
            .iter()
            .any(|(_, d)| *d == SurfaceChoice::Candidate)
        {
            if request.split.x1 > request.split.x2 || request.split.x2 > candidate.width {
                return Err(AvError::Invalid);
            }
            let mut media = self.open_library_media(&candidate.path)?;
            let mut bytes = Vec::new();
            std::io::Read::by_ref(&mut media.file)
                .take(MAX_JACKET_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| AvError::Image)?;
            let (decoded, _) = decode_jacket(&bytes)?;
            if (decoded.width(), decoded.height()) != (candidate.width, candidate.height) {
                return Err(AvError::Image);
            }
            for (surface, choice) in decisions {
                if choice != SurfaceChoice::Candidate {
                    continue;
                }
                let (x, width) = match surface {
                    CoverSurface::Front => (request.split.x2, candidate.width - request.split.x2),
                    CoverSurface::Spine => (request.split.x1, request.split.x2 - request.split.x1),
                    CoverSurface::Back => (0, request.split.x1),
                };
                if width == 0 {
                    return Err(AvError::Invalid);
                }
                let cropped = decoded.crop_imm(x, 0, width, candidate.height);
                let mut output = Cursor::new(Vec::new());
                cropped
                    .write_to(&mut output, image::ImageFormat::Png)
                    .map_err(|_| AvError::Image)?;
                prepared.push((
                    surface,
                    self.prepare_work_artwork(&collection, output.get_ref())?,
                ));
            }
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        crate::library::collection_authority::fence_collection_operation(&tx)?;
        let still_current:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM av_link_inbox i JOIN av_link_candidates c ON c.inbox_id=i.id WHERE i.id=?1 AND i.status='found' AND i.generation=?2 AND c.jacket_path=?3 AND c.snapshot_json=?4)",params![id,generation,candidate.path,candidate.snapshot],|r|r.get(0))?;
        if !still_current {
            return Err(AvError::Stale);
        }
        let now = chrono::Utc::now().to_rfc3339();
        if request.collection_id.is_some() {
            if Some(super::super::av_artwork::cover_set(&tx, &collection)?.revision)
                != request.expected_revision
            {
                return Err(AvError::Stale);
            }
        } else {
            let requested = request.new_collection_name.as_deref().unwrap_or("").trim();
            let name = if requested.is_empty() {
                code.as_str()
            } else {
                requested
            };
            let name = super::super::collection::normalized_name(name.to_owned())?;
            tx.execute("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES(?1,?2,'av',?3,?3)",params![collection,name,now])?;
            tx.execute(
                "INSERT INTO collection_av_details(collection_id,product_code) VALUES(?1,?2)",
                params![collection, code],
            )?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO collection_av_details(collection_id) VALUES(?1)",
            [&collection],
        )?;
        for (surface, choice) in decisions {
            match choice {
                SurfaceChoice::Keep => {}
                SurfaceChoice::Clear => {
                    Self::clear_work_artwork_kind_in_transaction(&tx, &collection, surface.kind())?
                }
                SurfaceChoice::Candidate => {
                    let (_, artwork) = prepared
                        .iter()
                        .find(|(s, _)| *s == surface)
                        .ok_or(AvError::Image)?;
                    let key = format!(
                        "{id}/{generation}/{}/{}-{}",
                        surface.kind().as_str(),
                        request.split.x1,
                        request.split.x2
                    );
                    Self::insert_work_artwork_in_transaction(
                        &tx,
                        &collection,
                        "libredmm",
                        &key,
                        surface.kind(),
                        None,
                        artwork,
                    )?;
                }
            }
        }
        for (column, value) in [
            ("title_ja", &request.fields.title_ja),
            ("release_date", &request.fields.release_date),
            ("maker", &request.fields.maker),
            ("label", &request.fields.label),
            ("series", &request.fields.series),
        ] {
            if let Some(value) = value {
                tx.execute(
                    &format!("UPDATE collection_av_details SET {column}=?2 WHERE collection_id=?1"),
                    params![collection, (!value.trim().is_empty()).then(|| value.trim())],
                )?;
            }
        }
        if let Some(genres) = &request.fields.genres {
            tx.execute(
                "UPDATE collection_av_details SET genres_json=?2 WHERE collection_id=?1",
                params![collection, json(genres)?],
            )?;
        }
        let mut created = BTreeMap::new();
        apply_people(
            &tx,
            &collection,
            &request.performers,
            "performer",
            &candidate,
            &mut created,
            &now,
        )?;
        apply_people(
            &tx,
            &collection,
            &request.directors,
            "director",
            &candidate,
            &mut created,
            &now,
        )?;
        tx.execute(
            "UPDATE collection_av_details SET revision=revision+1 WHERE collection_id=?1",
            [&collection],
        )?;
        tx.execute(
            "UPDATE collections SET updated_at=?2 WHERE id=?1",
            params![collection, now],
        )?;
        tx.execute("UPDATE av_link_inbox SET status='applied',collection_id=?2,generation=generation+1 WHERE id=?1",params![id,collection])?;
        tx.execute("DELETE FROM av_link_candidates WHERE inbox_id=?1", [id])?;
        let covers = super::super::av_artwork::cover_set(&tx, &collection)?;
        tx.commit()?;
        self.publication_inputs.signal(&[9]);
        for (_, artwork) in prepared {
            artwork.commit();
        }
        drop(connection);
        // Keep the committed result independent of a post-commit cleanup failure.
        if self.remove_av_link_file(&candidate.path).is_err() {
            eprintln!("av-link: candidate file cleanup failed after apply");
        }
        Ok(ApplyResult {
            collection_id: collection,
            covers,
        })
    }
}
