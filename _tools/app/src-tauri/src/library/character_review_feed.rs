//! Mobile character-candidate review: export and publish the PC's candidate feed.
//!
//! The feed lists `(targetId, assetId)` pairs the user can judge on mobile, merged from
//! three PC-local sources:
//!
//! * `s36`: pending S36 shadow candidates (`automatic` / `recommended`), the same list as the
//!   desktop S36 review screen. For a series switched to S36, `automatic` verdicts are not
//!   offered (user decision 2): S36 already accepts those itself.
//! * `b36`: saved B36 recommendations for each character's current fingerprint.
//! * `doubtful`: existing automatic acceptances S36 does not support.
//!
//! Only committed cloud assets are listed (a synced upload or a server-confirmed asset
//! lifecycle); the server drops anything it cannot show anyway. Each item's `basis` is the
//! pair's latest local decision sequence, which lets the receive pass tell a stale mobile
//! judgment from a current one.
//!
//! Publication runs on the `characters` lane after the navigation snapshot and carries that
//! snapshot's review cursor as `decisionCursor`, plus the skipped decisions acknowledged since
//! the previous feed. It is rebuilt at most every five minutes, sooner (debounced) when the
//! decisions, the S36 cache, saved B36 predictions, characters or the S36 series choice change;
//! an unchanged body is not sent again. All of it is durable (`mobile_character_review_feed_state`).
use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::characters::Error as CharacterError;
use super::{error::LibraryError, Library};
use crate::cloud::client::CloudClient;
use crate::library::credential;

pub(crate) const MAX_ITEMS: usize = 5_000;
pub(crate) const MAX_TARGETS: usize = 1_000;
const MAX_SKIPPED: usize = 1_000;
const MAX_REFERENCES: usize = 4;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedTarget {
    pub name: String,
    pub series_id: String,
    pub fingerprint: String,
    pub reference_asset_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedItem {
    pub asset_id: String,
    pub target_id: String,
    pub sources: Vec<&'static str>,
    pub verdict: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub knn3: Option<f64>,
    pub basis: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct FeedSkipped {
    pub sequence: i64,
    pub reason: String,
}

/// The exported candidates, before the publication envelope.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FeedContent {
    pub policy_version: String,
    pub targets: BTreeMap<String, FeedTarget>,
    pub items: Vec<FeedItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedBody<'a> {
    version: u8,
    library_id: &'a str,
    base_revision: Option<&'a str>,
    decision_cursor: i64,
    policy_version: &'a str,
    generated_at: &'a str,
    skipped: &'a [FeedSkipped],
    targets: &'a BTreeMap<String, FeedTarget>,
    items: &'a [FeedItem],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FeedOutcome {
    /// The review channel or manual exclusions are not adopted for this endpoint.
    NotReady,
    NotDue,
    /// Rebuilt, but identical to what the server already has: nothing was sent.
    Unchanged,
    Published {
        revision: String,
    },
    /// The server has no feed route, or refused adoption for now (`characterReviewUnsupported`).
    Unsupported,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".:_+-".contains(&b))
}

fn source_rank(source: &str) -> usize {
    match source {
        "s36" => 0,
        "b36" => 1,
        _ => 2,
    }
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn character_error(error: CharacterError) -> LibraryError {
    match error {
        CharacterError::Library(error) => error,
        CharacterError::Db(error) => LibraryError::Database(error),
        _ => LibraryError::InvalidCloudResponse,
    }
}

impl Library {
    /// Build the candidate feed from the S36 shadow lists and saved B36 recommendations.
    ///
    /// `s36_series` is the per-series S36 switch; `None` (automation not configured in this
    /// session) conservatively leaves out every S36 `automatic` verdict, since any of them
    /// might belong to a series S36 already classifies.
    pub(crate) fn character_review_feed_content(
        &self,
        s36_series: Option<&BTreeSet<String>>,
    ) -> Result<FeedContent, LibraryError> {
        let candidates = self.shadow_review_items(None).map_err(character_error)?;
        let doubtful = self
            .shadow_review_items(Some("doubtful"))
            .map_err(character_error)?;
        let b36 = self.b36_recommended_pairs().map_err(character_error)?;
        let connection = self.connection()?;

        struct Target {
            series_id: String,
            feed: FeedTarget,
        }
        let mut targets: HashMap<String, Option<Target>> = HashMap::new();
        let mut target = |id: &str| -> Result<Option<String>, LibraryError> {
            if !targets.contains_key(id) {
                let info = match self.read_character_target(&connection, id) {
                    Ok(target) => target
                        .series_classification_id
                        .clone()
                        .filter(|series| target.enabled && valid_id(series) && valid_id(&target.id))
                        .map(|series_id| Target {
                            series_id: series_id.clone(),
                            feed: FeedTarget {
                                name: target.display_name.chars().take(2000).collect(),
                                series_id,
                                fingerprint: target.fingerprint.clone(),
                                reference_asset_ids: target
                                    .usable_references()
                                    .filter_map(|r| r.asset_id.clone())
                                    .filter(|id| valid_id(id))
                                    .collect::<BTreeSet<_>>()
                                    .into_iter()
                                    .take(MAX_REFERENCES)
                                    .collect(),
                            },
                        })
                        .filter(|t| !t.feed.name.trim().is_empty()),
                    Err(CharacterError::NotFound) => None,
                    Err(error) => return Err(character_error(error)),
                };
                targets.insert(id.to_string(), info);
            }
            Ok(targets[id].as_ref().map(|t| t.series_id.clone()))
        };

        // Merge per (targetId, assetId), keeping the first-seen (review) order.
        let mut order: Vec<(String, String)> = Vec::new();
        let mut merged: HashMap<(String, String), (Vec<&'static str>, String, Option<f64>)> =
            HashMap::new();
        let mut add = |target_id: &str,
                       asset_id: &str,
                       source: &'static str,
                       verdict: &str,
                       knn3: Option<f64>| {
            let key = (target_id.to_string(), asset_id.to_string());
            let entry = merged.entry(key.clone()).or_insert_with(|| {
                order.push(key);
                (Vec::new(), verdict.to_string(), None)
            });
            if !entry.0.contains(&source) {
                entry.0.push(source);
            }
            if entry.2.is_none() {
                entry.2 = knn3.filter(|v| v.is_finite());
            }
        };
        for item in &candidates.items {
            let Some(series) = target(&item.target_id)? else {
                continue;
            };
            if item.verdict == "automatic"
                && s36_series.is_none_or(|switched| switched.contains(&series))
            {
                continue;
            }
            add(
                &item.target_id,
                &item.asset_id,
                "s36",
                &item.verdict,
                item.knn3,
            );
        }
        for (target_id, asset_id) in &b36 {
            if target(target_id)?.is_none() {
                continue;
            }
            add(target_id, asset_id, "b36", "recommended", None);
        }
        for item in &doubtful.items {
            if target(&item.target_id)?.is_none() {
                continue;
            }
            add(
                &item.target_id,
                &item.asset_id,
                "doubtful",
                &item.verdict,
                item.knn3,
            );
        }

        let mut committed = connection.prepare(
            "SELECT EXISTS(SELECT 1 FROM cloud_sync_queue WHERE entity_type='asset' AND entity_id=?1
                           AND operation='upsert' AND status='synced')
                 OR EXISTS(SELECT 1 FROM asset_authority_state WHERE asset_id=?1 AND lifecycle='normal')",
        )?;
        let mut basis = connection.prepare(
            "SELECT MAX(sequence) FROM character_decisions WHERE target_id=?1 AND source_asset_id=?2",
        )?;
        let mut content = FeedContent {
            policy_version: candidates
                .policy_version
                .or(doubtful.policy_version)
                .filter(|v| valid_token(v))
                .unwrap_or_else(|| "none".into()),
            targets: BTreeMap::new(),
            items: Vec::new(),
        };
        for (target_id, asset_id) in order {
            if content.items.len() >= MAX_ITEMS {
                break;
            }
            if !valid_id(&asset_id) || !committed.query_row([&asset_id], |r| r.get::<_, bool>(0))? {
                continue;
            }
            if !content.targets.contains_key(&target_id) {
                if content.targets.len() >= MAX_TARGETS {
                    continue;
                }
                let Some(Some(info)) = targets.get(&target_id) else {
                    continue;
                };
                content.targets.insert(target_id.clone(), info.feed.clone());
            }
            let (mut sources, verdict, knn3) = merged
                .remove(&(target_id.clone(), asset_id.clone()))
                .ok_or(LibraryError::InvalidCloudResponse)?;
            sources.sort_by_key(|s| source_rank(s));
            let latest: Option<i64> =
                basis.query_row(params![target_id, asset_id], |r| r.get(0))?;
            content.items.push(FeedItem {
                asset_id,
                target_id,
                sources,
                verdict: if verdict.len() <= 32
                    && verdict.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                    && !verdict.is_empty()
                {
                    verdict
                } else {
                    "recommended".into()
                },
                knn3,
                basis: latest.unwrap_or(0).to_string(),
            });
        }
        // Reference ids are only useful when the server can show them.
        for feed in content.targets.values_mut() {
            let mut kept = Vec::new();
            for id in std::mem::take(&mut feed.reference_asset_ids) {
                if committed.query_row([&id], |r| r.get::<_, bool>(0))? {
                    kept.push(id);
                }
            }
            feed.reference_asset_ids = kept;
        }
        Ok(content)
    }

    /// Cheap fingerprint of everything the feed depends on (see the migration 0092 notes).
    fn character_review_feed_input(
        &self,
        acknowledged: i64,
        s36_series: Option<&BTreeSet<String>>,
    ) -> Result<String, LibraryError> {
        let scored = super::character_shadow_review::shadow_cache_scored_marker(self.root())
            .map_err(character_error)?;
        let connection = self.connection()?;
        let (decisions, predictions, targets): (Option<i64>, Option<i64>, Option<String>) = connection
            .query_row(
                "SELECT (SELECT MAX(sequence) FROM character_decisions),
                        (SELECT MAX(rowid) FROM character_autotag_predictions),
                        (SELECT MAX(updated_at) || ':' || COUNT(*) || ':' || SUM(revision) FROM character_targets)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
        let input = serde_json::json!([
            decisions,
            scored,
            predictions,
            targets,
            acknowledged,
            s36_series
        ]);
        Ok(hex(input.to_string()))
    }

    /// Publish the candidate feed for this endpoint when due, with the OS credentials.
    pub(crate) fn publish_due_character_review_feed(
        &self,
        endpoint: &str,
    ) -> Result<FeedOutcome, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(FeedOutcome::NotReady);
        }
        if self.character_review_adoption(endpoint)?.is_none() {
            return Ok(FeedOutcome::NotReady);
        }
        let publisher = match credential::read_cloud_publisher_token_os() {
            Ok(token) => token,
            Err(LibraryError::CloudCredentialNotConfigured) => return Ok(FeedOutcome::NotReady),
            Err(error) => return Err(error),
        };
        let token = credential::read_cloud_api_token_os()?;
        let client = CloudClient::new(endpoint)?;
        let s36 = self.character_s36_series();
        self.publish_due_character_review_feed_with(
            &client,
            publisher.expose(),
            token.expose(),
            endpoint,
            s36.as_ref(),
        )
    }

    /// The feed publication with an injected transport and credentials.
    ///
    /// Adoption: the first accepted PUT enables the capability on the server. A server that
    /// lacks the route (`404`) or is not ready to adopt (`characterReviewUnsupported`, e.g. no
    /// manual-exclusion publication yet) is retried after five minutes and never fails the
    /// character lane. A stale base (`characterReviewFeedChanged`) re-reads the server
    /// revision and retries once.
    pub(crate) fn publish_due_character_review_feed_with(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        api_token: &str,
        endpoint: &str,
        s36_series: Option<&BTreeSet<String>>,
    ) -> Result<FeedOutcome, LibraryError> {
        let library_id = self.library_id()?;
        if self.character_exclusion_adoption(endpoint)?.is_none() {
            return Ok(FeedOutcome::NotReady);
        }
        let acknowledged: Option<i64> = self
            .connection()?
            .query_row(
                "SELECT acknowledged_cursor FROM mobile_character_review_sync
                 WHERE endpoint=?1 AND library_id=?2",
                params![endpoint, library_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(acknowledged) = acknowledged else {
            return Ok(FeedOutcome::NotReady);
        };
        let input = self.character_review_feed_input(acknowledged, s36_series)?;
        let due = {
            let db = self.connection()?;
            db.execute(
                "INSERT OR IGNORE INTO mobile_character_review_feed_state(endpoint,library_id,input_digest,first_dirty,last_dirty)
                 VALUES(?1,?2,?3,unixepoch(),unixepoch())",
                params![endpoint, library_id, input],
            )?;
            db.execute(
                "UPDATE mobile_character_review_feed_state SET input_digest=?3,
                 first_dirty=CASE WHEN input_digest IS published_input_digest THEN unixepoch() ELSE first_dirty END,
                 last_dirty=unixepoch()
                 WHERE endpoint=?1 AND library_id=?2 AND input_digest IS NOT ?3",
                params![endpoint, library_id, input],
            )?;
            let due: bool = db.query_row(
                "SELECT retry_after<=unixepoch() AND (
                    published_input_digest IS NULL
                    OR (input_digest IS NOT published_input_digest
                        AND (last_dirty<=unixepoch()-30 OR first_dirty<=unixepoch()-300))
                    OR built_at<=unixepoch()-300)
                 FROM mobile_character_review_feed_state WHERE endpoint=?1 AND library_id=?2",
                params![endpoint, library_id],
                |r| r.get(0),
            )?;
            if due {
                db.execute(
                    "UPDATE mobile_character_review_feed_state SET retry_after=unixepoch()+60
                     WHERE endpoint=?1 AND library_id=?2",
                    params![endpoint, library_id],
                )?;
            }
            due
        };
        if !due {
            return Ok(FeedOutcome::NotDue);
        }
        let (adopted, body_digest, base, published_cursor): (
            bool,
            Option<String>,
            Option<String>,
            i64,
        ) = self.connection()?.query_row(
            "SELECT adopted, body_digest, published_revision, published_cursor
                 FROM mobile_character_review_feed_state WHERE endpoint=?1 AND library_id=?2",
            params![endpoint, library_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        let content = self.character_review_feed_content(s36_series)?;
        // The skipped decisions acknowledged since the previous feed, bounded like the server.
        let mut cursor = acknowledged.max(published_cursor);
        let mut skipped = self
            .connection()?
            .prepare(
                "SELECT sequence, substr(outcome, 9) FROM mobile_character_review_receipts
                 WHERE endpoint=?1 AND library_id=?2 AND outcome LIKE 'skipped:%'
                   AND sequence>?3 AND sequence<=?4 ORDER BY sequence LIMIT ?5",
            )?
            .query_map(
                params![
                    endpoint,
                    library_id,
                    published_cursor,
                    cursor,
                    (MAX_SKIPPED + 1) as i64
                ],
                |r| {
                    Ok(FeedSkipped {
                        sequence: r.get(0)?,
                        reason: r.get(1)?,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        if skipped.len() > MAX_SKIPPED {
            skipped.truncate(MAX_SKIPPED);
            cursor = skipped[MAX_SKIPPED - 1].sequence;
        }
        let digest = hex(serde_json::to_vec(&FeedBody {
            version: 1,
            library_id: &library_id,
            base_revision: None,
            decision_cursor: cursor,
            policy_version: &content.policy_version,
            generated_at: "",
            skipped: &skipped,
            targets: &content.targets,
            items: &content.items,
        })
        .map_err(|_| LibraryError::InvalidCloudResponse)?);
        if adopted && body_digest.as_deref() == Some(digest.as_str()) {
            self.connection()?.execute(
                "UPDATE mobile_character_review_feed_state SET published_input_digest=?3,
                 built_at=unixepoch(), retry_after=0, first_dirty=0
                 WHERE endpoint=?1 AND library_id=?2",
                params![endpoint, library_id, input],
            )?;
            return Ok(FeedOutcome::Unchanged);
        }
        let generated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let body = |base: Option<&str>| {
            serde_json::to_vec(&FeedBody {
                version: 1,
                library_id: &library_id,
                base_revision: base,
                decision_cursor: cursor,
                policy_version: &content.policy_version,
                generated_at: &generated_at,
                skipped: &skipped,
                targets: &content.targets,
                items: &content.items,
            })
            .map_err(|_| LibraryError::InvalidCloudResponse)
        };
        let unsupported = || -> Result<FeedOutcome, LibraryError> {
            self.connection()?.execute(
                "UPDATE mobile_character_review_feed_state SET retry_after=unixepoch()+300
                 WHERE endpoint=?1 AND library_id=?2",
                params![endpoint, library_id],
            )?;
            Ok(FeedOutcome::Unsupported)
        };
        let result = match client
            .publish_character_review_feed(publisher_token, &body(base.as_deref())?)
        {
            Err(LibraryError::CharacterPublicationConflict) => {
                // Another publisher (or a lost response) moved the feed: retry once on the
                // server's current revision.
                let current = client.character_review_feed_revision(api_token)?;
                client.publish_character_review_feed(publisher_token, &body(current.as_deref())?)
            }
            result => result,
        };
        let published = match result {
            Ok(Some(published)) => published,
            Ok(None) | Err(LibraryError::CharacterReviewUnsupported) => return unsupported(),
            Err(error) => return Err(error),
        };
        self.connection()?.execute(
            "UPDATE mobile_character_review_feed_state SET adopted=1, published_revision=?3,
             published_cursor=MAX(published_cursor, ?4), body_digest=?5, published_input_digest=?6,
             built_at=unixepoch(), retry_after=0, first_dirty=0
             WHERE endpoint=?1 AND library_id=?2",
            params![
                endpoint,
                library_id,
                published.revision,
                cursor,
                digest,
                input
            ],
        )?;
        Ok(FeedOutcome::Published {
            revision: published.revision,
        })
    }
}

#[cfg(test)]
#[path = "character_review_feed_tests.rs"]
mod tests;
