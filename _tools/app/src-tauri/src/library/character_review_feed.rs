//! Mobile character-candidate review: export and publish the PC's candidate feed.
//!
//! The feed lists `(targetId, assetId)` pairs the user can judge on mobile. It carries the
//! same pairs as the desktop 확인 list, merged from PC-local sources:
//!
//! * `s36`: pending S36 shadow candidates (`automatic` / `recommended`) of every series, the
//!   desktop 인식 추천 list.
//! * `tagger`: the pending 태그 추천 pairs of the tag projection (`character_tagger_pending`),
//!   minus those the taggers judged correct by agreement, exactly as `character_confirm_counts`
//!   counts them. A server that predates this source refuses a whole feed naming it, so the
//!   publication asks the server first (`itemSources`) and leaves these pairs out otherwise.
//! * `doubtful`: existing automatic acceptances S36 does not support, plus the tag projection's
//!   vetoes (desktop 다시 확인; an older server accepts both).
//!
//! Saved B36 scan recommendations (`b36_recommended_pairs`) are deliberately not listed: the
//! desktop 확인 list does not contain them (only the much smaller tagger projection), and on a
//! real library they number in the thousands, which crowded out the cap and inflated the
//! mobile total. The server still accepts a `b36` source for older feeds.
//!
//! Only committed cloud assets are listed (a synced upload or a server-confirmed asset
//! lifecycle); the server drops anything it cannot show anyway. Each item's `basis` is the
//! pair's latest local decision sequence, which lets the receive pass tell a stale mobile
//! judgment from a current one.
//!
//! Publication runs on the `characters` lane after the navigation snapshot and carries that
//! snapshot's review cursor as `decisionCursor`, plus the skipped decisions acknowledged since
//! the previous feed. It is rebuilt at most every five minutes, sooner (debounced) when the
//! decisions, the S36 cache, characters or the broad-folder scope change;
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

/// The source that marks a 태그 추천 pair; the only one an older server does not know.
pub(crate) const TAGGER_SOURCE: &str = "tagger";

fn source_rank(source: &str) -> usize {
    match source {
        "s36" => 0,
        "b36" => 1,
        "doubtful" => 2,
        _ => 3,
    }
}

impl FeedContent {
    /// The feed an older server can take: no 태그 추천 pairs (and no character only they named).
    pub(crate) fn without_tag_recommendations(&mut self) {
        self.items.retain_mut(|item| {
            item.sources.retain(|source| *source != TAGGER_SOURCE);
            !item.sources.is_empty()
        });
        let named = self
            .items
            .iter()
            .map(|item| item.target_id.as_str())
            .collect::<BTreeSet<_>>();
        self.targets.retain(|id, _| named.contains(id.as_str()));
    }

    pub(crate) fn has_tag_recommendations(&self) -> bool {
        self.items
            .iter()
            .any(|item| item.sources.contains(&TAGGER_SOURCE))
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
    /// Build the candidate feed from the S36 shadow lists and the tag projection: every pending
    /// pair the desktop 확인 list shows as 인식 추천, 태그 추천 or 다시 확인, each pair once.
    pub(crate) fn character_review_feed_content(&self) -> Result<FeedContent, LibraryError> {
        let candidates = self.shadow_review_items(None).map_err(character_error)?;
        let doubtful = self
            .shadow_review_items(Some("doubtful"))
            .map_err(character_error)?;
        let tags = self.confirm_tag_pairs().map_err(character_error)?;
        // Every target the feed may name, read before taking the lock below so their
        // reference file checks run without it.
        let wanted = candidates
            .items
            .iter()
            .filter(|item| !item.folded)
            .map(|item| item.target_id.clone())
            .chain(doubtful.items.iter().map(|item| item.target_id.clone()))
            .chain(tags.iter().map(|(target_id, _, _)| target_id.clone()))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let mut read = self
            .character_targets_unlocked(&wanted)
            .map_err(character_error)?
            .into_iter()
            .map(|target| (target.id.clone(), target))
            .collect::<HashMap<_, _>>();
        let connection = self.connection()?;

        struct Target {
            series_id: String,
            feed: FeedTarget,
        }
        let mut targets: HashMap<String, Option<Target>> = HashMap::new();
        let mut target = |id: &str| -> Result<Option<String>, LibraryError> {
            if !targets.contains_key(id) {
                let info = match read.remove(id).ok_or(CharacterError::NotFound) {
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
        for item in candidates.items.iter().filter(|item| !item.folded) {
            if target(&item.target_id)?.is_none() {
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
        // 태그 추천 follows 인식 추천, 다시 확인 (S36's doubtful list, then the tag vetoes) comes last,
        // like the desktop list's kinds.
        for (target_id, asset_id, reason) in &tags {
            if reason == "veto" || target(target_id)?.is_none() {
                continue;
            }
            add(target_id, asset_id, TAGGER_SOURCE, "recommended", None);
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
        for (target_id, asset_id, reason) in &tags {
            if reason != "veto" || target(target_id)?.is_none() {
                continue;
            }
            add(target_id, asset_id, "doubtful", "veto", None);
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
    fn character_review_feed_input(&self, acknowledged: i64) -> Result<String, LibraryError> {
        self.publication_inputs.character_sources(self);
        let key = serde_json::json!([acknowledged]).to_string();
        self.publication_inputs.cached_input(1, key, || {
            self.build_character_review_feed_input(acknowledged)
        })
    }

    fn build_character_review_feed_input(&self, acknowledged: i64) -> Result<String, LibraryError> {
        let scored = super::character_shadow_review::shadow_cache_scored_marker(self.root())
            .map_err(character_error)?;
        let connection = self.connection()?;
        let (decisions, targets, broad, tagger): (
            Option<i64>,
            Option<String>,
            Option<bool>,
            String,
        ) = connection.query_row(
            "SELECT (SELECT MAX(sequence) FROM character_decisions),
                    (SELECT MAX(updated_at) || ':' || COUNT(*) || ':' || SUM(revision) FROM character_targets),
                    (SELECT broad_folder_scope FROM character_autotag_control WHERE singleton=1),
                    (SELECT COUNT(*) FROM character_target_tagger_tags) || ':' ||
                    (SELECT COUNT(*) FROM asset_tagger_coverage) || ':' ||
                    (SELECT COUNT(*) || ':' || COALESCE(MAX(created_at), '') FROM character_tagger_candidates)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        // The broad-folder setting hides or shows candidates, and so do the taggers' readings
        // (a pair they agree on needs no person) and their saved 태그 추천, so all are part of the input.
        let input = serde_json::json!([decisions, scored, targets, acknowledged, broad, tagger]);
        Ok(hex(input.to_string()))
    }

    /// Publish the candidate feed for this endpoint when due, with the OS credentials.
    pub(crate) fn publish_due_character_review_feed(
        &self,
        endpoint: &str,
    ) -> Result<FeedOutcome, LibraryError> {
        self.ensure_send_to(endpoint)?;
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
        let client = self.cloud_client(endpoint)?;
        self.publish_due_character_review_feed_with(
            &client,
            publisher.expose(),
            token.expose(),
            endpoint,
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
    ) -> Result<FeedOutcome, LibraryError> {
        self.ensure_send_to(client.base())?;
        client.ensure_send()?;
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
        let input = self.character_review_feed_input(acknowledged)?;
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
                    OR built_at<=unixepoch()-1800)
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
        let mut content = self.character_review_feed_content()?;
        // An older server refuses a whole feed that names 태그 추천: ask before sending it.
        if content.has_tag_recommendations()
            && !client.character_review_accepts_tag_recommendations(api_token)?
        {
            content.without_tag_recommendations();
        }
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
