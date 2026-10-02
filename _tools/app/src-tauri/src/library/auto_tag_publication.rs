//! Small, incremental PC display-tag projection. No replication commits or backfills.
use super::{auto_tags, error::LibraryError, home_publications::HomeTransport, Library};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

const PATH: &str = "/v1/library/auto-tags";
const MAX_BYTES: usize = 1024 * 1024;
const ASSET_BATCH: usize = 100;
// Must match library_search.MAX_TAGS_PER_ASSET (the upload contract).
const MAX_TAGS_PER_ASSET: usize = 1000;
const VOCABULARY_BATCH: usize = 500;

// The inspector and the publisher read the same labels and hidden-tag source.
#[derive(Deserialize)]
struct Dictionary {
    groups: HashMap<String, HashMap<String, String>>,
    hidden: HashSet<String>,
}
static DICTIONARY: LazyLock<Dictionary> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../src/autotags/dictionaryData.json"))
        .expect("checked-in auto tag dictionary")
});

fn displayed(tag: &str, category: &str) -> bool {
    !matches!(category, "meta" | "rating" | "artist") && !DICTIONARY.hidden.contains(tag)
}
fn label(tag: &str, category: &str) -> String {
    if category == "character" {
        let mut base = tag;
        while base.ends_with(')') {
            let Some(index) = base.rfind("_(") else { break };
            if index == 0
                || base[index + 2..base.len() - 1].is_empty()
                || base[index + 2..base.len() - 1].contains(['(', ')'])
            {
                break;
            }
            base = &base[..index];
        }
        return base
            .replace('_', " ")
            .split_whitespace()
            .map(|word| {
                let mut chars = word.chars();
                chars
                    .next()
                    .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" ");
    }
    ["etc", "scene", "sex", "pose", "wear", "body"]
        .into_iter()
        .find_map(|key| DICTIONARY.groups.get(key).and_then(|group| group.get(tag)))
        .cloned()
        .unwrap_or_else(|| tag.replace('_', " ").trim().to_owned())
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct State {
    vocabulary_cursor: String,
    asset_cursor: String,
    vocabulary_done: bool,
    retry_after: i64,
    failures: u32,
}
impl State {
    fn load(db: &Connection, endpoint: &str) -> Result<Self, LibraryError> {
        let raw: Option<String> = db
            .query_row(
                "SELECT state_json FROM auto_tag_publication_state WHERE endpoint=?1",
                [endpoint],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse))
            .unwrap_or_else(|| Ok(Self::default()))
    }
    fn save(&self, db: &Connection, endpoint: &str) -> Result<(), LibraryError> {
        db.execute(
            "INSERT INTO auto_tag_publication_state(endpoint,state_json) VALUES(?1,?2)
            ON CONFLICT(endpoint) DO UPDATE SET state_json=excluded.state_json",
            params![
                endpoint,
                serde_json::to_string(self).map_err(|_| LibraryError::InvalidCloudResponse)?
            ],
        )?;
        Ok(())
    }
}

fn digest(value: &Value) -> Result<String, LibraryError> {
    super::mobile_catalog::hash_json(value)
}
fn changed(
    db: &Connection,
    endpoint: &str,
    kind: &str,
    id: &str,
    digest: &str,
) -> Result<bool, LibraryError> {
    let old: Option<String> = db
        .query_row(
            "SELECT digest FROM auto_tag_publication_digests
        WHERE endpoint=?1 AND kind=?2 AND id=?3",
            params![endpoint, kind, id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(old.as_deref() != Some(digest))
}

fn asset_value(db: &Connection, id: &str, creator: Option<&str>) -> Result<Value, LibraryError> {
    let valid_text = |value: &str, limit: usize| {
        !value.trim().is_empty()
            && value.chars().count() <= limit
            && !value.chars().any(|c| c < '\u{20}' || c == '\u{7f}')
    };
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
        || creator.is_some_and(|key| !valid_text(key, 1024))
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    let normal: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1 AND status='normal')",
        [id],
        |r| r.get(0),
    )?;
    let mut tags = if normal {
        let effective = auto_tags::asset_tags(db, id)?;
        let mut tags = effective
            .tags
            .into_iter()
            .filter(|tag| {
                displayed(&tag.tag, &tag.category)
                    && !(tag.category == "character"
                        && tag.source == auto_tags::AutoTagSource::Model
                        && (effective.has_confirmed_character
                            || tag.score.unwrap_or(0.0) < auto_tags::CHARACTER_MIN_SCORE))
            })
            .collect::<Vec<_>>();
        tags.sort_by(|a, b| {
            (a.source != auto_tags::AutoTagSource::Added)
                .cmp(&(b.source != auto_tags::AutoTagSource::Added))
                .then_with(|| {
                    b.score
                        .unwrap_or(f64::NEG_INFINITY)
                        .total_cmp(&a.score.unwrap_or(f64::NEG_INFINITY))
                })
                .then_with(|| a.tag.cmp(&b.tag))
        });
        tags.truncate(MAX_TAGS_PER_ASSET);
        if tags.iter().any(|tag| !valid_text(&tag.tag, 200)) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        tags.into_iter().map(|tag| tag.tag).collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    // Content identity and payload ordering do not depend on score order.
    tags.sort();
    Ok(json!({"assetId":id,"creatorKey":creator,"tags":tags}))
}

fn validate_reply(reply: &Value, body: &Value) -> Result<(), LibraryError> {
    if reply["version"] != 1
        || reply["revision"].as_i64().is_none_or(|n| n < 0)
        || reply["changed"].as_bool().is_none()
        || reply["assets"].as_u64() != Some(body["assets"].as_array().unwrap().len() as u64)
        || reply["vocabulary"].as_u64() != Some(body["vocabulary"].as_array().unwrap().len() as u64)
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(())
}

impl Library {
    pub(crate) fn run_due_auto_tag_publication(&self, endpoint: &str) -> Result<(), LibraryError> {
        // This lane walks the local tag index; lightweight mode holds background work.
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
        self.run_auto_tags_with(
            &crate::cloud::client::CloudClient::new(endpoint)?,
            token.expose(),
            endpoint,
            Utc::now().timestamp(),
            false,
        )
    }

    fn run_auto_tags_with(
        &self,
        client: &dyn HomeTransport,
        token: &str,
        endpoint: &str,
        now: i64,
        light: bool,
    ) -> Result<(), LibraryError> {
        if light {
            return Ok(());
        }
        let endpoint = crate::cloud::status_watch::endpoint_key(endpoint);
        let mut state = State::load(&*self.connection()?, &endpoint)?;
        if state.retry_after > now {
            return Ok(());
        }
        // Persist before network I/O so a crash cannot spin on a failing endpoint.
        state.retry_after = now + 60;
        state.save(&*self.connection()?, &endpoint)?;
        let result = (|| {
            // At most three scan pages per owner tick, plus any newly introduced vocabulary.
            // Cursors survive restart/failure.
            for _ in 0..3 {
                let kind = if state.vocabulary_done {
                    "asset"
                } else {
                    "vocabulary"
                };
                let mut body = json!({"version":1,"vocabulary":[],"assets":[]});
                let mut receipts = Vec::new();
                let mut next = if state.vocabulary_done {
                    state.asset_cursor.clone()
                } else {
                    state.vocabulary_cursor.clone()
                };
                let mut reached_end;
                {
                    let mut db = self.connection()?;
                    let tx = db.transaction()?;
                    let candidates: Vec<(String, Option<String>)> = if kind == "vocabulary" {
                        let mut query = tx.prepare(
                            "SELECT tag, category FROM (
                            SELECT tag,category FROM auto_tag_vocabulary
                            UNION ALL SELECT tag,'general' FROM asset_auto_tag_edits
                            WHERE tag NOT IN (SELECT tag FROM auto_tag_vocabulary) GROUP BY tag
                            ) WHERE tag>?1 ORDER BY tag LIMIT ?2",
                        )?;
                        let rows = query.query_map(
                            params![state.vocabulary_cursor, VOCABULARY_BATCH as i64],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )?;
                        rows.collect::<Result<_, _>>()?
                    } else {
                        let mut query = tx.prepare("SELECT id,creator_key FROM (
                            SELECT id,CASE WHEN status='normal' THEN COALESCE(creator_handle,creator_url) END AS creator_key FROM assets
                            UNION ALL SELECT id,NULL FROM auto_tag_publication_digests
                            WHERE endpoint=?1 AND kind='asset' AND id NOT IN (SELECT id FROM assets)
                            ) WHERE id>?2 ORDER BY id LIMIT ?3")?;
                        let rows = query.query_map(
                            params![endpoint, state.asset_cursor, ASSET_BATCH as i64],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )?;
                        rows.collect::<Result<_, _>>()?
                    };
                    reached_end = candidates.len()
                        < if kind == "vocabulary" {
                            VOCABULARY_BATCH
                        } else {
                            ASSET_BATCH
                        };
                    for (id, extra) in candidates {
                        let value = if kind == "vocabulary" {
                            let category = extra.as_deref().unwrap_or("general");
                            json!({"id":id,"label":label(&id,category),"category":category})
                        } else {
                            match asset_value(&tx, &id, extra.as_deref()) {
                                Ok(value) => value,
                                Err(error) => {
                                    eprintln!("[auto-tags] skipping invalid asset {id}: {error}");
                                    next = id;
                                    continue;
                                }
                            }
                        };
                        let hash = digest(&value)?;
                        if changed(&tx, &endpoint, kind, &id, &hash)? {
                            let field = if kind == "vocabulary" {
                                "vocabulary"
                            } else {
                                "assets"
                            };
                            body[field].as_array_mut().unwrap().push(value);
                            if serde_json::to_vec(&body)
                                .map_err(|_| LibraryError::InvalidCloudResponse)?
                                .len()
                                > MAX_BYTES
                            {
                                body[field].as_array_mut().unwrap().pop();
                                if receipts.is_empty() && kind == "asset" {
                                    eprintln!("[auto-tags] skipping oversized asset {id}");
                                    next = id;
                                    continue;
                                }
                                reached_end = false;
                                if receipts.is_empty() {
                                    return Err(LibraryError::InvalidCloudResponse);
                                }
                                break;
                            }
                            receipts.push((id.clone(), hash));
                        }
                        next = id;
                    }
                    tx.commit()?;
                }
                if kind == "asset" && !receipts.is_empty() {
                    let mut vocabulary = Vec::new();
                    {
                        let db = self.connection()?;
                        let mut seen = HashSet::new();
                        for asset in body["assets"].as_array().unwrap() {
                            for tag in asset["tags"].as_array().unwrap() {
                                let id = tag.as_str().ok_or(LibraryError::InvalidCloudResponse)?;
                                if !seen.insert(id) {
                                    continue;
                                }
                                let category: String = db
                                    .query_row(
                                        "SELECT category FROM auto_tag_vocabulary WHERE tag=?1",
                                        [id],
                                        |r| r.get(0),
                                    )
                                    .optional()?
                                    .unwrap_or_else(|| "general".to_owned());
                                let value = json!({"id":id,"label":label(id,&category),"category":category});
                                let hash = digest(&value)?;
                                if changed(&db, &endpoint, "vocabulary", id, &hash)? {
                                    vocabulary.push((id.to_owned(), hash, value));
                                }
                            }
                        }
                    }
                    for chunk in vocabulary.chunks(VOCABULARY_BATCH) {
                        let body = json!({"version":1,"assets":[],"vocabulary":chunk.iter().map(|row|row.2.clone()).collect::<Vec<_>>()});
                        let reply = client.publish(PATH, Some(&body), token)?;
                        validate_reply(&reply, &body)?;
                        let mut db = self.connection()?;
                        let tx = db.transaction()?;
                        for (id, hash, _) in chunk {
                            tx.execute("INSERT INTO auto_tag_publication_digests VALUES(?1,'vocabulary',?2,?3)
                                ON CONFLICT(endpoint,kind,id) DO UPDATE SET digest=excluded.digest",params![endpoint,id,hash])?;
                        }
                        tx.commit()?;
                    }
                }
                if !receipts.is_empty() {
                    let reply = client.publish(PATH, Some(&body), token)?;
                    validate_reply(&reply, &body)?;
                }
                let mut db = self.connection()?;
                let tx = db.transaction()?;
                for (id, hash) in receipts {
                    tx.execute(
                        "INSERT INTO auto_tag_publication_digests VALUES(?1,?2,?3,?4)
                        ON CONFLICT(endpoint,kind,id) DO UPDATE SET digest=excluded.digest",
                        params![endpoint, kind, id, hash],
                    )?;
                }
                if kind == "vocabulary" {
                    state.vocabulary_cursor = next;
                    if reached_end {
                        state.vocabulary_done = true
                    }
                } else {
                    state.asset_cursor = next;
                    if reached_end {
                        state.asset_cursor.clear();
                        state.vocabulary_cursor.clear();
                        state.vocabulary_done = false;
                    }
                }
                state.failures = 0;
                state.retry_after = if kind == "asset" && reached_end {
                    now + 60
                } else {
                    0
                };
                state.save(&tx, &endpoint)?;
                tx.commit()?;
                if kind == "asset" && reached_end {
                    break;
                }
            }
            Ok(())
        })();
        if result.is_err() {
            // Reload: a previous page in this tick may have committed successfully.
            state = State::load(&*self.connection()?, &endpoint)?;
            state.failures = state.failures.saturating_add(1);
            state.retry_after =
                now + (60 * (1_i64 << state.failures.saturating_sub(1).min(6))).min(3600);
            state.save(&*self.connection()?, &endpoint)?;
        }
        result
    }
}

#[cfg(test)]
#[path = "auto_tag_publication_tests.rs"]
mod tests;
