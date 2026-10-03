//! Received product codes stay local candidates until an explicit, revision-checked apply.
mod apply;
pub(crate) mod models;
pub(crate) mod provider;
#[cfg(test)]
mod tests;

use crate::library::{av_models::AvError, error::LibraryError, Library};
use models::*;
use provider::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    fs,
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
static WORKER: Mutex<()> = Mutex::new(());
static TICK_RUNNING: AtomicBool = AtomicBool::new(false);
static TICK_WORKER: crate::cloud::auto_publication::Worker =
    crate::cloud::auto_publication::Worker::new();
static WORK_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static TICK_SCHEDULE: Mutex<TickSchedule> = Mutex::new(TickSchedule {
    root: None,
    restricted: false,
    generation: 0,
    due: None,
});

pub(crate) fn note_work() {
    WORK_GENERATION.fetch_add(1, Ordering::Release);
}

struct TickSchedule {
    root: Option<std::path::PathBuf>,
    restricted: bool,
    generation: u64,
    due: Option<std::time::Instant>,
}
impl TickSchedule {
    fn ready(
        &mut self,
        root: &std::path::Path,
        restricted: bool,
        generation: u64,
        now: std::time::Instant,
    ) -> bool {
        if self.root.as_deref() == Some(root)
            && self.restricted == restricted
            && self.generation == generation
            && self.due.is_some_and(|due| now < due)
        {
            return false;
        }
        self.root = Some(root.to_owned());
        self.restricted = restricted;
        self.generation = generation;
        true
    }
}
const READY_TIMEOUT: i64 = 600;

fn json<T: serde::Serialize>(value: &T) -> Result<String, AvError> {
    serde_json::to_string(value).map_err(|_| AvError::Invalid)
}
fn from_json<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, AvError> {
    serde_json::from_str(value).map_err(|_| AvError::Invalid)
}
fn matched_collection(
    connection: &Connection,
    code: Option<&str>,
) -> Result<Option<String>, AvError> {
    let Some(code) = code else { return Ok(None) };
    let mut statement=connection.prepare("SELECT d.collection_id,d.product_code FROM collection_av_details d JOIN collections c ON c.id=d.collection_id WHERE c.type='av' AND d.product_code IS NOT NULL ORDER BY c.id")?;
    let matches = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|(_, raw)| normalize_code(raw).as_deref() == Some(code))
        .map(|(id, _)| id)
        .collect::<Vec<_>>();
    // Duplicate local product codes require the user to select a destination.
    Ok((matches.len() == 1).then(|| matches[0].clone()))
}
fn inbox(connection: &Connection, id: &str) -> Result<InboxItem, AvError> {
    let mut item=connection.query_row("SELECT id,request_id,product_code,normalized_code,source_url,received_at,status,attempts,last_error,fetched_at,collection_id FROM av_link_inbox WHERE id=?1",[id],|r|Ok(InboxItem{
        id:r.get(0)?,request_id:r.get(1)?,product_code:r.get(2)?,normalized_code:r.get(3)?,source_url:r.get(4)?,received_at:r.get(5)?,status:r.get(6)?,attempts:r.get(7)?,last_error:r.get(8)?,fetched_at:r.get(9)?,collection_id:r.get(10)?,collection_name:None,
    })).optional()?.ok_or(AvError::Invalid)?;
    if item.status != "applied" {
        item.collection_id = matched_collection(connection, item.normalized_code.as_deref())?;
    }
    if let Some(id) = &item.collection_id {
        item.collection_name = connection
            .query_row("SELECT name FROM collections WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?;
    }
    Ok(item)
}
struct StoredCandidate {
    movie: Movie,
    snapshot: String,
    path: String,
    width: u32,
    height: u32,
    split: Split,
    names: Vec<NameMapping>,
}
fn stored(connection: &Connection, id: &str) -> Result<StoredCandidate, AvError> {
    let (snapshot,path,width,height,x1,x2,names):(String,String,u32,u32,u32,u32,String)=connection.query_row("SELECT snapshot_json,jacket_path,jacket_width,jacket_height,split_x1,split_x2,names_json FROM av_link_candidates WHERE inbox_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?.ok_or(AvError::Invalid)?;
    Ok(StoredCandidate {
        movie: from_json(&snapshot)?,
        snapshot,
        path,
        width,
        height,
        split: Split { x1, x2 },
        names: from_json(&names)?,
    })
}
fn person_match(
    connection: &Connection,
    mapping: NameMapping,
    collection: Option<&str>,
    role: &str,
) -> Result<PersonMatch, AvError> {
    let mut found = None;
    for (field, value) in [
        ("fanza_actress_id", mapping.fanza_actress_id.as_deref()),
        ("wikidata_id", mapping.wikidata_id.as_deref()),
        ("name_ja", Some(mapping.name_ja.as_str())),
        ("display_name", mapping.name_ko.as_deref()),
    ] {
        let Some(value) = value else { continue };
        let predicate = if field == "name_ja" {
            "name_ja=?1 OR (name_ja IS NULL AND display_name=?1)".to_owned()
        } else {
            format!("{field}=?1")
        };
        let matches=connection.prepare(&format!("SELECT id,display_name FROM collection_people WHERE {predicate} ORDER BY id LIMIT 2"))?.query_map([value],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
        if matches.len() > 1 {
            break;
        }
        if let Some((id, name)) = matches.into_iter().next() {
            found = Some((id, name, field.to_owned()));
            break;
        }
    }
    let linked = if let (Some((id, _, _)), Some(collection)) = (&found, collection) {
        connection.query_row("SELECT EXISTS(SELECT 1 FROM collection_person_relations WHERE collection_id=?1 AND person_id=?2 AND role=?3)",params![collection,id,role],|r|r.get(0))?
    } else {
        false
    };
    let (person_id, display_name, match_by) = found
        .map(|(i, n, b)| (Some(i), Some(n), Some(b)))
        .unwrap_or_default();
    Ok(PersonMatch {
        mapping,
        person_id,
        display_name,
        match_by,
        already_linked: linked,
    })
}
fn current_collection(connection: &Connection, id: &str) -> Result<CurrentCollection, AvError> {
    super::av_collection::require_av(connection, id)?;
    let (name,product_code,title_ja,release_date,maker,label,series,genres):(String,Option<String>,Option<String>,Option<String>,Option<String>,Option<String>,Option<String>,Option<String>)=connection.query_row("SELECT c.name,d.product_code,d.title_ja,d.release_date,d.maker,d.label,d.series,d.genres_json FROM collections c LEFT JOIN collection_av_details d ON d.collection_id=c.id WHERE c.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)))?;
    let people = super::av_collection::details(connection, id)?.people;
    Ok(CurrentCollection {
        collection_id: id.into(),
        name,
        product_code,
        fields: Fields {
            title_ja,
            release_date,
            maker,
            label,
            series,
            genres: genres.map(|g| from_json(&g)).transpose()?,
        },
        covers: super::av_artwork::cover_set(connection, id)?,
        people,
    })
}
impl Library {
    pub fn list_av_link_inbox(&self) -> Result<Vec<InboxItem>, AvError> {
        let connection = self.connection()?;
        let ids=connection.prepare("SELECT id FROM av_link_inbox WHERE status NOT IN ('dismissed','applied') ORDER BY received_at,id")?.query_map([],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        ids.iter().map(|id| inbox(&connection, id)).collect()
    }
    pub fn av_link_pending_count(&self) -> Result<i64, AvError> {
        Ok(self.connection()?.query_row(
            "SELECT count(*) FROM av_link_inbox WHERE status NOT IN ('dismissed','applied')",
            [],
            |r| r.get(0),
        )?)
    }
    pub fn get_av_link_candidate(
        &self,
        id: &str,
        collection_id: Option<&str>,
    ) -> Result<Candidate, AvError> {
        let connection = self.connection()?;
        let item = inbox(&connection, id)?;
        if item.status != "found" {
            return Err(AvError::Invalid);
        }
        let candidate = stored(&connection, id)?;
        let target = collection_id.or(item.collection_id.as_deref());
        let current = target
            .map(|id| current_collection(&connection, id))
            .transpose()?;
        let mapping = |name: &str| {
            candidate
                .names
                .iter()
                .find(|m| m.name_ja == name)
                .cloned()
                .unwrap_or_else(|| NameMapping::japanese(name))
        };
        let performers = candidate
            .movie
            .actresses
            .iter()
            .map(|p| person_match(&connection, mapping(&p.name), target, "performer"))
            .collect::<Result<_, _>>()?;
        let directors = candidate
            .movie
            .directors
            .iter()
            .map(|p| person_match(&connection, mapping(p), target, "director"))
            .collect::<Result<_, _>>()?;
        Ok(Candidate {
            fields: movie_fields(&candidate.movie)?,
            metadata: candidate.movie,
            jacket_url: format!("http://lakomics.localhost/av-link-jacket/{id}"),
            jacket_width: candidate.width,
            jacket_height: candidate.height,
            default_split: DefaultSplit {
                split: candidate.split,
                ..default_split(candidate.width, candidate.height)
            },
            inbox: item,
            current,
            performers,
            directors,
        })
    }
    pub fn retry_av_link(&self, id: &str) -> Result<(), AvError> {
        self.reset_av_link(id, None, false)
    }
    pub fn fix_av_link_code(&self, id: &str, code: &str) -> Result<(), AvError> {
        let normalized = normalize_code(code).ok_or(AvError::Invalid)?;
        self.reset_av_link(id, Some(normalized), false)
    }
    pub fn dismiss_av_link(&self, id: &str) -> Result<(), AvError> {
        self.reset_av_link(id, None, true)
    }
    fn reset_av_link(&self, id: &str, code: Option<String>, dismiss: bool) -> Result<(), AvError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let item = inbox(&tx, id)?;
        if matches!(item.status.as_str(), "applied" | "dismissed")
            || (!dismiss && code.is_none() && item.normalized_code.is_none())
        {
            return Err(AvError::Invalid);
        }
        let path: Option<String> = tx
            .query_row(
                "SELECT jacket_path FROM av_link_candidates WHERE inbox_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        tx.execute("DELETE FROM av_link_candidates WHERE inbox_id=?1", [id])?;
        tx.execute("UPDATE av_link_inbox SET normalized_code=COALESCE(?2,normalized_code),status=?3,attempts=0,last_error=NULL,fetched_at=NULL,started_at=NULL,next_attempt_at=0,generation=generation+1 WHERE id=?1",params![id,code,if dismiss{"dismissed"}else{"queued"}])?;
        tx.commit()?;
        drop(connection);
        if let Some(path) = path {
            self.remove_av_link_file(&path)?;
        }
        Ok(())
    }
    fn remove_av_link_file(&self, path: &str) -> Result<(), AvError> {
        let relative = std::path::Path::new(path);
        if relative.parent() != Some(std::path::Path::new("av-link-candidates"))
            || relative.file_name().is_none()
        {
            return Err(AvError::Image);
        }
        match fs::remove_file(self.root().join(relative)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(AvError::Image),
        }
    }
    pub(crate) fn av_link_jacket(&self, id: &str) -> Result<(Vec<u8>, &'static str), AvError> {
        uuid::Uuid::parse_str(id).map_err(|_| AvError::Invalid)?;
        let connection = self.connection()?;
        if inbox(&connection, id)?.status != "found" {
            return Err(AvError::Invalid);
        }
        let candidate = stored(&connection, id)?;
        // Resolve through the same canonical library containment check as WorkArtwork.
        let mut media = self.open_library_media(&candidate.path)?;
        if media.length > MAX_JACKET_BYTES as u64 {
            return Err(AvError::Image);
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut media.file)
            .take(MAX_JACKET_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| AvError::Image)?;
        if bytes.len() > MAX_JACKET_BYTES {
            return Err(AvError::Image);
        }
        Ok((bytes, media.mime))
    }

    pub(crate) fn ingest_av_link_page(
        &self,
        endpoint: &str,
        after: i64,
        page: FeedPage,
    ) -> Result<(), AvError> {
        if page.items.len() > 100 || page.next_after < after {
            return Err(AvError::Invalid);
        }
        let mut previous = after;
        for item in &page.items {
            if item.sequence <= previous
                || item.sequence > page.next_after
                || uuid::Uuid::parse_str(&item.request_id).is_err()
                || item.product_code.trim().is_empty()
                || item.product_code.chars().count() > 40
                || chrono::DateTime::parse_from_rfc3339(&item.received_at).is_err()
            {
                return Err(AvError::Invalid);
            }
            previous = item.sequence;
        }
        if page.next_after != previous || (page.has_more && page.items.is_empty()) {
            return Err(AvError::Invalid);
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        for item in page.items {
            let normalized = normalize_code(&item.product_code);
            let collection = matched_collection(&tx, normalized.as_deref())?;
            tx.execute("INSERT INTO av_link_inbox(id,request_id,product_code,normalized_code,source_url,received_at,status,last_error,collection_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(request_id) DO NOTHING",params![uuid::Uuid::new_v4().to_string(),item.request_id,item.product_code,normalized,item.source_url,item.received_at,if normalized.is_some(){"queued"}else{"error"},if normalized.is_none(){Some("품번을 확인해 주세요")}else{None},collection])?;
        }
        tx.execute("INSERT INTO av_link_poll_cursor(endpoint,after_sequence) VALUES(?1,?2) ON CONFLICT(endpoint) DO UPDATE SET after_sequence=MAX(after_sequence,excluded.after_sequence)",params![endpoint,page.next_after])?;
        tx.commit()?;
        Ok(())
    }
    fn poll_av_links(&self, http: &dyn HttpClient, restricted: bool) -> Result<(), AvError> {
        let config = self.cloud_sync_config()?;
        let Some(endpoint) = config.api_base_url.filter(|s| !s.trim().is_empty()) else {
            return Ok(());
        };
        let client = self.cloud_client(&endpoint)?;
        let endpoint = client.capture_endpoint();
        let now = chrono::Utc::now().timestamp();
        let Some(after) = self.claim_av_link_poll(endpoint, now, restricted)? else {
            return Ok(());
        };
        let broker = crate::library::credential_broker::broker();
        // The feed is publisher-only on the server (the PC's publisher credential).
        let token =
            broker.credential(crate::library::credential::CredentialTarget::CloudPublisher)?;
        let result = self.receive_av_link_feed_with(http, &client, token.expose(), after);
        if let Err(AvError::Library(error)) = &result {
            broker.invalidate_on_auth_rejection(
                crate::library::credential::CredentialTarget::CloudPublisher,
                error,
            );
        }
        result
    }
    fn claim_av_link_poll(
        &self,
        endpoint: &str,
        now: i64,
        restricted: bool,
    ) -> Result<Option<i64>, AvError> {
        let connection = self.connection()?;
        Self::claim_av_link_poll_on(&connection, endpoint, now, restricted)
    }
    fn claim_av_link_poll_on(
        connection: &Connection,
        endpoint: &str,
        now: i64,
        restricted: bool,
    ) -> Result<Option<i64>, AvError> {
        let spacing = if restricted { 60 } else { 15 };
        let last: Option<i64> = connection
            .query_row(
                "SELECT last_poll_at FROM av_link_poll_cursor WHERE endpoint=?1",
                [endpoint],
                |r| r.get(0),
            )
            .optional()?;
        if last.is_some_and(|last| last != 0 && last > now - spacing) {
            return Ok(None);
        }
        connection.execute(
            "INSERT OR IGNORE INTO av_link_poll_cursor(endpoint) VALUES(?1)",
            [endpoint],
        )?;
        if connection.execute("UPDATE av_link_poll_cursor SET last_poll_at=?2 WHERE endpoint=?1 AND (last_poll_at=0 OR last_poll_at<=?3)", params![endpoint,now,now-spacing])? == 0 { return Ok(None); }
        Ok(Some(connection.query_row(
            "SELECT after_sequence FROM av_link_poll_cursor WHERE endpoint=?1",
            [endpoint],
            |r| r.get(0),
        )?))
    }
    fn receive_av_link_feed_with(
        &self,
        http: &dyn HttpClient,
        client: &crate::cloud::client::CloudClient,
        token: &str,
        after: i64,
    ) -> Result<(), AvError> {
        let response = http.get(&client.av_lookup_url(after)?, Some(token), MAX_JSON_BYTES)?;
        if matches!(response.status, 401 | 403) {
            return Err(LibraryError::CloudUnauthorized.into());
        }
        if response.status != 200 {
            return Err(LibraryError::InvalidCloudResponse.into());
        }
        let page: FeedPage =
            serde_json::from_slice(&response.bytes).map_err(|_| AvError::Invalid)?;
        self.ingest_av_link_page(client.capture_endpoint(), after, page)
    }
    fn enrich_names(
        &self,
        http: &dyn HttpClient,
        movie: &Movie,
        now: i64,
    ) -> Result<Vec<NameMapping>, AvError> {
        let names = movie
            .actresses
            .iter()
            .map(|p| p.name.clone())
            .chain(movie.directors.iter().cloned())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let mut result = Vec::new();
        let mut missing = Vec::new();
        {
            let connection = self.connection()?;
            for name in names {
                let cache:Option<String>=connection.query_row("SELECT mapping_json FROM av_link_name_cache WHERE name_ja=?1 AND fetched_at>?2",params![name,now-30*86400],|r|r.get(0)).optional()?;
                if let Some(mapping) = cache.and_then(|v| from_json(&v).ok()) {
                    result.push(mapping);
                } else {
                    missing.push(name);
                }
            }
        }
        for batch in missing.chunks(20) {
            let fetched = (|| {
                let response = http.get(&wikidata_url(batch)?, None, MAX_JSON_BYTES)?;
                if response.status != 200 {
                    return Err(AvError::Invalid);
                }
                parse_names(&response.bytes, batch)
            })();
            match fetched {
                Ok(mappings) => {
                    let connection = self.connection()?;
                    for mapping in mappings {
                        connection.execute("INSERT INTO av_link_name_cache(name_ja,mapping_json,fetched_at) VALUES(?1,?2,?3) ON CONFLICT(name_ja) DO UPDATE SET mapping_json=excluded.mapping_json,fetched_at=excluded.fetched_at",params![mapping.name_ja,json(&mapping)?,now])?;
                        result.push(mapping);
                    }
                    connection.execute("DELETE FROM av_link_name_cache WHERE name_ja IN (SELECT name_ja FROM av_link_name_cache ORDER BY fetched_at DESC LIMIT -1 OFFSET 2000)",[])?;
                }
                Err(_) => result.extend(batch.iter().map(|n| NameMapping::japanese(n))),
            }
        }
        Ok(result)
    }
    pub(crate) fn fetch_next_av_link_with(
        &self,
        http: &dyn HttpClient,
        now: i64,
    ) -> Result<bool, AvError> {
        let job = {
            let connection = self.connection()?;
            // Leases recover an interrupted request after a crash; generation invalidates late responses.
            let row:Option<(String,String,i64,i64,Option<i64>)>=connection.query_row("SELECT id,normalized_code,generation,attempts,started_at FROM av_link_inbox WHERE normalized_code IS NOT NULL AND (status='queued' OR status='fetching') AND next_attempt_at<=?1 ORDER BY received_at,id LIMIT 1",[now],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
            let Some((id, code, generation, attempts, started)) = row else {
                return Ok(false);
            };
            connection.execute("UPDATE av_link_inbox SET status='fetching',attempts=attempts+1,started_at=COALESCE(started_at,?2),next_attempt_at=?2+120 WHERE id=?1",params![id,now])?;
            (id, code, generation, attempts + 1, started.unwrap_or(now))
        };
        let (id, code, generation, attempts, started) = job;
        if attempts > 1 && now - started >= READY_TIMEOUT {
            self.finish_av_link_error(
                &id,
                generation,
                "error",
                Some("LibreDMM이 아직 준비 중이에요"),
            )?;
            return Ok(true);
        }
        let fetched = (|| {
            let response = http.get(
                &format!("https://www.libredmm.com/movies/{code}.json"),
                None,
                MAX_JSON_BYTES,
            )?;
            match response.status {
                202 => {
                    let delay = (5_i64.saturating_mul(1_i64 << attempts.min(4))).min(60);
                    self.connection()?.execute("UPDATE av_link_inbox SET next_attempt_at=?3 WHERE id=?1 AND generation=?2 AND status='fetching'",params![id,generation,(now+delay).min(started+READY_TIMEOUT)])?;
                    return Ok(());
                }
                404 => {
                    self.finish_av_link_error(&id, generation, "not_found", None)?;
                    return Ok(());
                }
                200 => {}
                _ => return Err(AvError::Library(LibraryError::CloudRequestUnavailable)),
            }
            let movie = parse_movie(&response.bytes, &code)?;
            let url = jacket_url(&movie.cover_image_url)?;
            let cover = http.get(url.as_str(), None, MAX_JACKET_BYTES)?;
            if cover.status != 200 {
                return Err(AvError::Image);
            }
            if cover.content_type.as_deref().is_some_and(|mime| {
                !matches!(
                    mime.split(';').next().unwrap_or("").trim(),
                    "image/jpeg" | "image/png" | "image/webp"
                )
            }) {
                return Err(AvError::Image);
            }
            let (decoded, format) = decode_jacket(&cover.bytes)?;
            let width = decoded.width();
            let height = decoded.height();
            drop(decoded);
            let names = self.enrich_names(http, &movie, now).unwrap_or_else(|_| {
                movie
                    .actresses
                    .iter()
                    .map(|p| NameMapping::japanese(&p.name))
                    .chain(movie.directors.iter().map(|p| NameMapping::japanese(p)))
                    .collect()
            });
            let split = default_split(width, height);
            let extension = match format {
                image::ImageFormat::Jpeg => "jpg",
                image::ImageFormat::Png => "png",
                _ => "webp",
            };
            let folder = self.root().join("av-link-candidates");
            fs::create_dir_all(&folder).map_err(|_| AvError::Image)?;
            let relative = format!("av-link-candidates/{}.{extension}", uuid::Uuid::new_v4());
            let mut temporary =
                tempfile::NamedTempFile::new_in(&folder).map_err(|_| AvError::Image)?;
            temporary
                .write_all(&cover.bytes)
                .map_err(|_| AvError::Image)?;
            temporary.as_file().sync_all().map_err(|_| AvError::Image)?;
            let path = temporary.into_temp_path();
            path.persist(self.root().join(&relative))
                .map_err(|_| AvError::Image)?;
            // The file is ready before SQLite references it. A stale/discarded job removes its own file.
            let saved = (|| {
                let mut connection = self.connection()?;
                let tx = connection.transaction()?;
                if tx.execute("UPDATE av_link_inbox SET status='found',last_error=NULL,fetched_at=?3,collection_id=?4 WHERE id=?1 AND generation=?2 AND status='fetching'",params![id,generation,chrono::Utc::now().to_rfc3339(),matched_collection(&tx,Some(&code))?])?==0{return Ok(false)}
                tx.execute("INSERT INTO av_link_candidates(inbox_id,snapshot_json,jacket_path,jacket_width,jacket_height,split_x1,split_x2,names_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![id,String::from_utf8(response.bytes).map_err(|_|AvError::Invalid)?,relative,width,height,split.split.x1,split.split.x2,json(&names)?])?;
                tx.commit()?;
                Ok::<bool, AvError>(true)
            })();
            if !matches!(saved, Ok(true)) {
                let _ = self.remove_av_link_file(&relative);
            }
            saved?;
            Ok(())
        })();
        if let Err(error) = fetched {
            let message = if matches!(error, AvError::Image) {
                "재킷 이미지를 가져오지 못했어요"
            } else {
                "후보를 가져오지 못했어요 · 다시 시도해 주세요"
            };
            self.finish_av_link_error(&id, generation, "error", Some(message))?;
        }
        Ok(true)
    }
    fn next_av_link_tick(&self, restricted: bool) -> Result<std::time::Duration, AvError> {
        let now = chrono::Utc::now().timestamp();
        let delay = self
            .next_av_link_due_at(restricted)?
            .map(|due| due.saturating_sub(now).clamp(1, 60) as u64)
            .unwrap_or(60);
        Ok(std::time::Duration::from_secs(delay))
    }

    fn next_av_link_due_at(&self, restricted: bool) -> Result<Option<i64>, AvError> {
        let c = self.connection()?;
        let pending: Option<i64> = c.query_row(
            "SELECT MIN(next_attempt_at) FROM av_link_inbox WHERE normalized_code IS NOT NULL AND status IN ('queued','fetching')",
            [], |r| r.get(0),
        )?;
        let endpoint: Option<String> = c.query_row(
            "SELECT cloud_api_base_url FROM library_settings WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        let spacing = if restricted { 60 } else { 15 };
        let poll = endpoint
            .filter(|e| !e.trim().is_empty())
            .and_then(|e| url::Url::parse(e.trim()).ok())
            .filter(|url| {
                matches!(url.scheme(), "http" | "https")
                    && url.username().is_empty()
                    && url.password().is_none()
            })
            .map(|endpoint| -> Result<i64, AvError> {
                let last: Option<i64> = c
                    .query_row(
                        "SELECT last_poll_at FROM av_link_poll_cursor WHERE endpoint=?1",
                        [endpoint.as_str()],
                        |r| r.get(0),
                    )
                    .optional()?;
                Ok(last.unwrap_or(0) + spacing)
            })
            .transpose()?;
        Ok([pending, poll].into_iter().flatten().min())
    }

    fn finish_av_link_error(
        &self,
        id: &str,
        generation: i64,
        status: &str,
        message: Option<&str>,
    ) -> Result<(), AvError> {
        self.connection()?.execute("UPDATE av_link_inbox SET status=?3,last_error=?4 WHERE id=?1 AND generation=?2 AND status='fetching'",params![id,generation,status,message])?;
        Ok(())
    }
}

/// Called by the existing native one-second scheduler; the worker never holds a UI/DB lock over HTTP.
pub(crate) fn tick(library: Library, restricted: bool) {
    if TICK_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    if !TICK_SCHEDULE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .ready(
            library.root(),
            restricted,
            WORK_GENERATION.load(Ordering::Acquire),
            std::time::Instant::now(),
        )
    {
        TICK_RUNNING.store(false, Ordering::Release);
        return;
    }
    // An empty local queue without a configured feed never starts a worker. A future
    // retry stays asleep too; table writes and mode/endpoint changes invalidate ready().
    if let Ok(deadline) = library.next_av_link_due_at(restricted) {
        let now = chrono::Utc::now().timestamp();
        if deadline.is_none_or(|due| due > now) {
            let delay = deadline
                .map(|due| due.saturating_sub(now).clamp(1, 60) as u64)
                .unwrap_or(60);
            TICK_SCHEDULE
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .due = Some(std::time::Instant::now() + std::time::Duration::from_secs(delay));
            TICK_RUNNING.store(false, Ordering::Release);
            return;
        }
    }
    let spawned = TICK_WORKER.submit("av-link", move || {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                TICK_RUNNING.store(false, Ordering::Release);
            }
        }
        let _reset = Reset;
        let Ok(_worker) = WORKER.try_lock() else {
            return;
        };
        let http = NetworkClient::new();
        let _ = library.poll_av_links(&http, restricted);
        let _ = library.fetch_next_av_link_with(&http, chrono::Utc::now().timestamp());
        let delay = library
            .next_av_link_tick(restricted)
            .unwrap_or(std::time::Duration::from_secs(1));
        TICK_SCHEDULE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .due = Some(std::time::Instant::now() + delay);
    });
    if !matches!(spawned, Ok(true)) {
        TICK_RUNNING.store(false, Ordering::Release);
    }
}
