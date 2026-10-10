//! Publication of the Korean image captions and character names behind the tablet's content search
//! (`PUT /v1/library/captions`). Digest-based like the auto-tag lane: only changed rows are sent, in
//! bounded batches, and a removed row is sent as an explicit deletion. Captions come from the
//! PC-only NL-search cache; no media, classification or auto-tag data is touched.
use super::{error::LibraryError, home_publications::HomeTransport, Library};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

const PATH: &str = "/v1/library/captions";
/// The server accepts 8 MiB per request; stay well below it.
const MAX_BYTES: usize = 6 * 1024 * 1024;
const BATCH_ROWS: usize = 1000;
/// Requests per owner tick. A first full publication (about 9 requests) finishes over three ticks.
const BATCHES_PER_TICK: usize = 4;
/// Re-check eligibility and the cache even without a new import (trashed or removed assets).
const VERIFICATION_INTERVAL: i64 = 6 * 60 * 60;
// Must match library_description.py (the upload contract).
const MAX_CAPTION_CHARS: usize = 4000;
const MAX_NAME_CHARS: usize = 500;
const MAX_TAG_CHARS: usize = 200;
const MAX_TAGS_PER_NAME: usize = 100;

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct State {
    /// Stamp of the cache imported by the last complete caption scan.
    cache_stamp: String,
    /// A scan was started or left unfinished: the next run scans the captions again.
    more: bool,
    next_verification: i64,
    retry_after: i64,
    failures: u32,
}
impl State {
    fn load(db: &Connection, endpoint: &str) -> Result<Self, LibraryError> {
        let raw: Option<String> = db
            .query_row(
                "SELECT state_json FROM caption_publication_state WHERE endpoint=?1",
                [endpoint],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse))
            .unwrap_or_else(|| Ok(Self::default()))
    }
    fn save(&self, db: &Connection, endpoint: &str) -> Result<(), LibraryError> {
        db.execute(
            "INSERT INTO caption_publication_state(endpoint,state_json) VALUES(?1,?2)
            ON CONFLICT(endpoint) DO UPDATE SET state_json=excluded.state_json",
            params![
                endpoint,
                serde_json::to_string(self).map_err(|_| LibraryError::InvalidCloudResponse)?
            ],
        )?;
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Kind {
    Caption,
    Name,
}
impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Caption => "caption",
            Kind::Name => "name",
        }
    }
}
/// One row of a request. `digest` is None for a deletion.
struct Op {
    kind: Kind,
    id: String,
    digest: Option<String>,
    row: Value,
    size: usize,
}
impl Op {
    fn new(kind: Kind, id: &str, digest: Option<String>, row: Value) -> Self {
        let size = row.to_string().len() + 1;
        Self {
            kind,
            id: id.to_owned(),
            digest,
            row,
            size,
        }
    }
}

fn digest(value: &Value) -> Result<String, LibraryError> {
    super::mobile_catalog::hash_json(value)
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}
fn valid_text(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= limit
}

/// Character names with the series folder name and the tagger tags that name search maps to
/// (`library/nl_search.rs` routing). Invalid rows are skipped, never fatal.
fn names(db: &Connection) -> Result<BTreeMap<String, (Value, String)>, LibraryError> {
    let mut tags: HashMap<String, BTreeSet<String>> = HashMap::new();
    for row in db
        .prepare("SELECT target_id,tag FROM character_target_tagger_tags")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
    {
        let (target, tag) = row?;
        let tag = tag.trim().to_owned();
        if valid_text(&tag, MAX_TAG_CHARS) {
            tags.entry(target).or_default().insert(tag);
        }
    }
    let mut rows = BTreeMap::new();
    let mut stmt = db.prepare(
        "SELECT t.id,t.display_name,e.name FROM character_targets t
        LEFT JOIN classification_entries e ON e.id=t.series_classification_id ORDER BY t.id",
    )?;
    let mut query = stmt.query([])?;
    while let Some(row) = query.next()? {
        let id: String = row.get(0)?;
        let display: String = row.get(1)?;
        let series: Option<String> = row.get(2)?;
        let display = display.trim();
        if !valid_id(&id) || !valid_text(display, MAX_NAME_CHARS) {
            eprintln!("[captions] skipping invalid character name {id}");
            continue;
        }
        let series = series
            .map(|name| name.trim().to_owned())
            .filter(|name| valid_text(name, MAX_NAME_CHARS));
        let tags: Vec<&String> = tags
            .get(&id)
            .map(|set| set.iter().take(MAX_TAGS_PER_NAME).collect())
            .unwrap_or_default();
        let value = json!({"targetId":id,"displayName":display,"seriesName":series,"tags":tags});
        let hash = digest(&value)?;
        rows.insert(id, (value, hash));
    }
    Ok(rows)
}

/// Captions to publish: cached texts of normal image/GIF Assets of this library.
fn captions(
    db: &Connection,
    cached: Vec<(String, String)>,
) -> Result<BTreeMap<String, (String, String)>, LibraryError> {
    let eligible = db
        .prepare("SELECT id FROM assets WHERE status='normal' AND media_kind IN ('image','gif')")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    let mut rows = BTreeMap::new();
    for (id, text) in cached {
        let text = text.trim();
        if !eligible.contains(&id) || !valid_id(&id) || !valid_text(text, MAX_CAPTION_CHARS) {
            continue;
        }
        let hash = digest(&json!({"assetId":id,"text":text}))?;
        rows.insert(id, (text.to_owned(), hash));
    }
    Ok(rows)
}

fn stored(
    db: &Connection,
    endpoint: &str,
) -> Result<HashMap<(Kind, String), String>, LibraryError> {
    let mut map = HashMap::new();
    for row in db
        .prepare("SELECT kind,id,digest FROM caption_publication_digests WHERE endpoint=?1")?
        .query_map([endpoint], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
    {
        let (kind, id, hash) = row?;
        let kind = if kind == "name" {
            Kind::Name
        } else {
            Kind::Caption
        };
        map.insert((kind, id), hash);
    }
    Ok(map)
}

/// Changed rows plus explicit deletions of stored rows that no longer exist.
fn diff(
    kind: Kind,
    desired: impl Iterator<Item = (String, String, Value)>,
    stored: &HashMap<(Kind, String), String>,
) -> Vec<Op> {
    let mut ops = Vec::new();
    let mut live = HashSet::new();
    for (id, hash, row) in desired {
        if stored.get(&(kind, id.clone())) != Some(&hash) {
            ops.push(Op::new(kind, &id, Some(hash), row));
        }
        live.insert(id);
    }
    let mut gone: Vec<&String> = stored
        .keys()
        .filter(|(k, id)| *k == kind && !live.contains(id))
        .map(|(_, id)| id)
        .collect();
    gone.sort();
    for id in gone {
        let row = match kind {
            Kind::Caption => json!({"assetId":id,"text":null}),
            Kind::Name => json!({"targetId":id,"deleted":true}),
        };
        ops.push(Op::new(kind, id, None, row));
    }
    ops
}

/// Split into requests of at most `BATCH_ROWS` rows and `MAX_BYTES` of JSON.
fn requests(ops: Vec<Op>) -> Vec<Vec<Op>> {
    let mut result: Vec<Vec<Op>> = Vec::new();
    let mut size = 0;
    for op in ops {
        let full = result
            .last()
            .is_none_or(|batch| batch.len() >= BATCH_ROWS || size + op.size > MAX_BYTES);
        if full {
            result.push(Vec::new());
            size = 256;
        }
        size += op.size;
        result.last_mut().unwrap().push(op);
    }
    result
}

fn validate_reply(reply: &Value, captions: usize, names: usize) -> Result<(), LibraryError> {
    if reply["version"] != 1
        || reply["revision"].as_i64().is_none_or(|n| n < 0)
        || reply["changed"].as_bool().is_none()
        || reply["captions"].as_u64() != Some(captions as u64)
        || reply["names"].as_u64() != Some(names as u64)
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(())
}

impl Library {
    /// Dispatcher hint only (the lane still checks itself): a new cache import, an unfinished scan or
    /// the periodic verification is waiting. Character-name changes ride the ten-minute safety
    /// dispatch of the shared lane.
    pub(crate) fn caption_publication_due_on(
        &self,
        db: &Connection,
        endpoint: &str,
        now: i64,
    ) -> Result<bool, LibraryError> {
        let endpoint = crate::cloud::status_watch::endpoint_key(endpoint);
        let state = State::load(db, &endpoint)?;
        Ok(state.retry_after <= now
            && (state.more
                || state.cache_stamp != self.nl_search_cache_stamp()
                || (state.next_verification != 0 && state.next_verification <= now)))
    }

    pub(crate) fn run_due_caption_publication(&self, endpoint: &str) -> Result<(), LibraryError> {
        self.ensure_send_to(endpoint)?;
        // The lane reads the whole cache and the character tables; lightweight mode holds it.
        if crate::workload::is_lightweight() {
            return Ok(());
        }
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(());
        }
        let token = match super::credential::read_cloud_publisher_token_os() {
            Ok(token) => token,
            Err(LibraryError::CloudCredentialNotConfigured) => return Ok(()),
            Err(error) => return Err(error),
        };
        self.run_captions_with(
            &self.cloud_client(endpoint)?,
            token.expose(),
            endpoint,
            Utc::now().timestamp(),
        )
    }

    fn run_captions_with(
        &self,
        client: &dyn HomeTransport,
        token: &str,
        endpoint: &str,
        now: i64,
    ) -> Result<(), LibraryError> {
        let endpoint = crate::cloud::status_watch::endpoint_key(endpoint);
        let mut state = State::load(&*self.connection()?, &endpoint)?;
        if state.retry_after > now {
            return Ok(());
        }
        let stamp = self.nl_search_cache_stamp();
        let scan = state.more || state.cache_stamp != stamp || state.next_verification <= now;
        // Persist before network I/O so a crash cannot spin on a failing endpoint; `more` stays set
        // until a scan has been sent completely.
        state.retry_after = now + 60;
        if scan {
            state.more = true;
        }
        state.save(&*self.connection()?, &endpoint)?;
        let result = (|| {
            // Never hold the library connection while reading the cache (it takes the index lock).
            let cached = if scan {
                self.nl_search_cached_captions()?
            } else {
                None
            };
            let (stored, name_rows, caption_rows) = {
                let db = self.connection()?;
                let caption_rows = match cached {
                    Some(cached) => Some(captions(&db, cached)?),
                    None => None,
                };
                (stored(&db, &endpoint)?, names(&db)?, caption_rows)
            };
            let mut queue = requests(diff(
                Kind::Name,
                name_rows
                    .into_iter()
                    .map(|(id, (row, hash))| (id, hash, row)),
                &stored,
            ));
            if let Some(rows) = caption_rows {
                queue.extend(requests(diff(
                    Kind::Caption,
                    rows.into_iter().map(|(id, (text, hash))| {
                        let row = json!({"assetId":id,"text":text});
                        (id, hash, row)
                    }),
                    &stored,
                )));
            }
            let remaining = queue.len().saturating_sub(BATCHES_PER_TICK);
            for batch in queue.into_iter().take(BATCHES_PER_TICK) {
                let rows = |kind| {
                    batch
                        .iter()
                        .filter(move |op| op.kind == kind)
                        .map(|op| op.row.clone())
                        .collect::<Vec<_>>()
                };
                let body =
                    json!({"version":1,"captions":rows(Kind::Caption),"names":rows(Kind::Name)});
                let reply = client.publish(PATH, Some(&body), token)?;
                validate_reply(
                    &reply,
                    body["captions"].as_array().map_or(0, Vec::len),
                    body["names"].as_array().map_or(0, Vec::len),
                )?;
                let mut db = self.connection()?;
                let tx = db.transaction()?;
                for op in &batch {
                    match &op.digest {
                        Some(hash) => tx.execute(
                            "INSERT INTO caption_publication_digests VALUES(?1,?2,?3,?4)
                            ON CONFLICT(endpoint,kind,id) DO UPDATE SET digest=excluded.digest",
                            params![endpoint, op.kind.as_str(), op.id, hash],
                        )?,
                        None => tx.execute(
                            "DELETE FROM caption_publication_digests WHERE endpoint=?1 AND kind=?2 AND id=?3",
                            params![endpoint, op.kind.as_str(), op.id],
                        )?,
                    };
                }
                tx.commit()?;
            }
            Ok(remaining)
        })();
        match result {
            Ok(remaining) => {
                let db = self.connection()?;
                state = State::load(&db, &endpoint)?;
                state.failures = 0;
                state.retry_after = 0;
                if scan {
                    state.more = remaining > 0;
                    if remaining == 0 {
                        state.cache_stamp = stamp;
                        state.next_verification = now + VERIFICATION_INTERVAL;
                    }
                } else if remaining > 0 {
                    state.more = true;
                }
                state.save(&db, &endpoint)?;
                Ok(())
            }
            Err(error) => {
                // Reload: an earlier request of this tick may have been acknowledged.
                let db = self.connection()?;
                state = State::load(&db, &endpoint)?;
                state.failures = state.failures.saturating_add(1);
                state.retry_after =
                    now + (60 * (1_i64 << state.failures.saturating_sub(1).min(6))).min(3600);
                state.save(&db, &endpoint)?;
                Err(error)
            }
        }
    }
}

#[cfg(test)]
#[path = "caption_publication_tests.rs"]
mod tests;
