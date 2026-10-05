//! Unregistered tagger characters. Evidence never becomes a character decision here.
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    characters::{thumbnail_revisions, Error, Result, Target, TargetDraft},
    Library,
};

const LIST_SQL: &str = include_str!("character_suggestions_list.sql");

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub tag: String,
    pub image_count: usize,
    pub both_count: usize,
    pub pixai_count: usize,
    pub canary_count: usize,
    pub sample_asset_ids: Vec<String>,
    /// Current thumbnail revisions of the samples, by Asset id (absent without a thumbnail),
    /// for cacheable thumbnail URLs.
    pub sample_thumbnail_revisions: BTreeMap<String, String>,
    pub series_id: Option<String>,
    pub series_name: Option<String>,
    pub inside_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionImage {
    pub asset_id: String,
    pub asset_hash: String,
    pub pixai_score: f64,
    pub canary_score: f64,
    pub inside_series: bool,
    pub solo: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionDetail {
    pub images: Vec<SuggestionImage>,
    pub preview_token: String,
    pub reference_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredTag {
    pub tag: String,
    pub ignored_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterSuggestion {
    pub tag: String,
    pub series_id: String,
    pub display_name: String,
    pub preview_token: String,
    pub reference_ids: Vec<String>,
    #[serde(default)]
    pub excluded_asset_ids: Vec<String>,
    #[serde(default = "yes")]
    pub include_outside: bool,
    #[serde(default = "yes")]
    pub link_tag: bool,
    pub group_id: Option<String>,
    pub expected_group_revision: Option<i64>,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSuggestion {
    pub tag: String,
    pub target_id: String,
    pub expected_fingerprint: String,
    pub preview_token: String,
    #[serde(default = "yes")]
    pub link_tag: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionResult {
    pub target: Target,
    pub queued_count: usize,
}

fn list_in(c: &Connection, minimum: usize) -> Result<Vec<Suggestion>> {
    let mut statement = c.prepare(LIST_SQL)?;
    let rows = statement.query_map([i64::try_from(minimum.max(1)).unwrap_or(i64::MAX)], |r| {
        Ok((
            Suggestion {
                tag: r.get(0)?,
                image_count: r.get::<_, i64>(1)? as usize,
                both_count: r.get::<_, i64>(2)? as usize,
                pixai_count: r.get::<_, i64>(3)? as usize,
                canary_count: r.get::<_, i64>(4)? as usize,
                sample_asset_ids: Vec::new(),
                sample_thumbnail_revisions: BTreeMap::new(),
                series_id: r.get(6)?,
                series_name: r.get(7)?,
                inside_count: r.get::<_, i64>(8)? as usize,
            },
            r.get::<_, String>(5)?,
        ))
    })?;
    let mut suggestions = rows
        .map(|row| {
            let (mut suggestion, samples) = row?;
            suggestion.sample_asset_ids = serde_json::from_str(&samples)?;
            Ok(suggestion)
        })
        .collect::<Result<Vec<_>>>()?;
    // One read for every sample of every suggestion.
    let revisions = thumbnail_revisions(
        c,
        suggestions
            .iter()
            .flat_map(|suggestion| suggestion.sample_asset_ids.iter().map(String::as_str)),
    )?;
    for suggestion in &mut suggestions {
        suggestion.sample_thumbnail_revisions = suggestion
            .sample_asset_ids
            .iter()
            .filter_map(|id| Some((id.clone(), revisions.get(id)?.clone())))
            .collect();
    }
    Ok(suggestions)
}

fn ensure_available(c: &Connection, tag: &str) -> Result<()> {
    let available: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM tagger_character_vocabulary WHERE tag=?1)
         AND NOT EXISTS(SELECT 1 FROM character_target_tagger_tags WHERE tag=?1)
         AND NOT EXISTS(SELECT 1 FROM character_suggestion_ignored_tags WHERE tag=?1)",
        [tag],
        |r| r.get(0),
    )?;
    if !available {
        return Err(Error::Stale);
    }
    Ok(())
}

fn detail_in(c: &Connection, tag: &str, series: Option<&str>) -> Result<SuggestionDetail> {
    ensure_available(c, tag)?;
    let solo_filter = super::auto_tags::filter_conditions(Some(&super::models::AutoTagFilter {
        include: vec!["solo".into()],
        exclude: vec![],
    }))?;
    let mut statement = c.prepare(&format!(
        "WITH RECURSIVE scope(id) AS (
          SELECT id FROM classification_entries WHERE id=?2
          UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id
        )
        SELECT a.id,a.content_hash,
          MAX(CASE WHEN s.source='pixai' THEN s.score ELSE 0 END),
          MAX(CASE WHEN s.source='canary' THEN s.score ELSE 0 END),
          EXISTS(SELECT 1 FROM asset_classifications ac JOIN scope ON scope.id=ac.classification_id WHERE ac.asset_id=a.id),
          EXISTS(SELECT 1 FROM assets asset WHERE asset.id=a.id {solo_filter}) AS solo
        FROM asset_tagger_character_scores s
        JOIN assets a ON a.id=s.asset_id AND a.status='normal' AND a.media_kind='image'
        WHERE s.tag=?1 GROUP BY a.id
        HAVING MAX(s.score)>=0.85 ORDER BY solo DESC,MAX(s.score) DESC,a.id"
    ))?;
    let images = statement
        .query_map(params![tag, series], |r| {
            Ok(SuggestionImage {
                asset_id: r.get(0)?,
                asset_hash: r.get(1)?,
                pixai_score: r.get(2)?,
                canary_score: r.get(3)?,
                inside_series: r.get(4)?,
                solo: r.get(5)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if images.is_empty() {
        return Err(Error::Stale);
    }
    let preview_token = Sha256::digest(serde_json::to_vec(&(tag, series, &images))?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let reference_ids = images
        .iter()
        .filter(|i| i.inside_series)
        .take(5)
        .map(|i| i.asset_id.clone())
        .collect();
    Ok(SuggestionDetail {
        images,
        preview_token,
        reference_ids,
    })
}

fn queue_in(
    c: &Connection,
    target: &Target,
    images: &[SuggestionImage],
    excluded: &BTreeSet<&str>,
) -> Result<usize> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut inserted = Vec::new();
    let mut statement = c.prepare(
        "INSERT INTO character_tagger_candidates(target_id,asset_id,asset_hash,reason,pixai_score,canary_score,created_at)
         SELECT ?1,?2,?3,'recommendation',?4,?5,?6
         WHERE NOT EXISTS(SELECT 1 FROM character_references WHERE target_id=?1 AND asset_id=?2)
         AND NOT EXISTS(SELECT 1 FROM character_learned_references WHERE target_id=?1 AND asset_id=?2)
         AND COALESCE((SELECT decision FROM character_decisions WHERE target_id=?1 AND source_asset_id=?2 ORDER BY sequence DESC LIMIT 1),'') NOT IN ('accepted','rejected')
         ON CONFLICT(target_id,asset_id) DO NOTHING"
    )?;
    for image in images {
        if excluded.contains(image.asset_id.as_str()) {
            continue;
        }
        if statement.execute(params![
            target.id,
            image.asset_id,
            image.asset_hash,
            image.pixai_score,
            image.canary_score,
            now
        ])? > 0
        {
            inserted.push(&image.asset_id);
        }
    }
    for id in &inserted {
        c.execute(
            "DELETE FROM character_review_completions WHERE asset_id=?1",
            [id],
        )?;
        super::character_autotag::refresh_character_review_state(c, id)?;
    }
    Ok(inserted.len())
}

impl Library {
    pub fn character_suggestions(&self, minimum: Option<usize>) -> Result<Vec<Suggestion>> {
        let c = self.connection()?;
        list_in(&c, minimum.unwrap_or(5))
    }

    pub fn character_suggestion_detail(
        &self,
        tag: &str,
        series: Option<&str>,
    ) -> Result<SuggestionDetail> {
        let c = self.connection()?;
        detail_in(&c, tag, series)
    }

    pub fn ignored_character_suggestions(&self) -> Result<Vec<IgnoredTag>> {
        let c = self.connection()?;
        let mut statement = c.prepare("SELECT tag,ignored_at FROM character_suggestion_ignored_tags ORDER BY ignored_at DESC,tag")?;
        let rows = statement
            .query_map([], |r| {
                Ok(IgnoredTag {
                    tag: r.get(0)?,
                    ignored_at: r.get(1)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn set_character_suggestion_ignored(&self, tag: &str, ignored: bool) -> Result<()> {
        let c = self.connection()?;
        if ignored {
            let known: bool = c.query_row(
                "SELECT EXISTS(SELECT 1 FROM tagger_character_vocabulary WHERE tag=?1)",
                [tag],
                |r| r.get(0),
            )?;
            if !known {
                return Err(Error::Invalid("캐릭터 태그를 찾을 수 없습니다."));
            }
            c.execute(
                "INSERT OR IGNORE INTO character_suggestion_ignored_tags VALUES(?1,?2)",
                params![tag, chrono::Utc::now().to_rfc3339()],
            )?;
        } else {
            c.execute(
                "DELETE FROM character_suggestion_ignored_tags WHERE tag=?1",
                [tag],
            )?;
        }
        Ok(())
    }

    pub fn register_character_suggestion(
        &self,
        request: RegisterSuggestion,
    ) -> Result<SuggestionResult> {
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let detail = detail_in(&tx, &request.tag, Some(&request.series_id))?;
        if detail.preview_token != request.preview_token {
            return Err(Error::Stale);
        }
        let references = request
            .reference_ids
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        let mut excluded = request
            .excluded_asset_ids
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if references.len() != request.reference_ids.len()
            || references.len() > 8
            || !references.is_disjoint(&excluded)
            || references.iter().any(|id| {
                !detail
                    .images
                    .iter()
                    .any(|i| i.asset_id == *id && i.inside_series)
            })
            || excluded
                .iter()
                .any(|id| !detail.images.iter().any(|i| i.asset_id == *id))
        {
            return Err(Error::Invalid(
                "참조는 시리즈 폴더 안에서 중복 없이 최대 8장까지 선택해 주세요.",
            ));
        }
        if !request.include_outside {
            excluded.extend(
                detail
                    .images
                    .iter()
                    .filter(|i| !i.inside_series)
                    .map(|i| i.asset_id.as_str()),
            );
        }
        let saved = self.save_character_target_selection_in(
            &tx,
            TargetDraft {
                id: None,
                expected_revision: None,
                series_classification_id: Some(request.series_id.clone()),
                linked_classification_id: None,
                display_name: request.display_name,
                description: String::new(),
                thumbnail_asset_id: request.reference_ids.first().cloned(),
                enabled: true,
            },
            false,
            references.len() < 5,
        )?;
        let target = self.replace_character_references_selection_in(
            &tx,
            &saved.id,
            saved.revision,
            &request.reference_ids,
            false,
        )?;
        if let Some(group_id) = request.group_id {
            let (name, revision): (String, i64) = tx.query_row(
                "SELECT name,revision FROM character_groups WHERE id=?1 AND series_id=?2",
                params![group_id, request.series_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if Some(revision) != request.expected_group_revision {
                return Err(Error::Stale);
            }
            let mut ids = tx
                .prepare("SELECT target_id FROM character_group_members WHERE group_id=?1")?
                .query_map([&group_id], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            ids.push(target.id.clone());
            super::character_groups::save_character_group_in(
                &tx,
                super::character_groups::GroupDraft {
                    id: Some(group_id),
                    series_id: request.series_id,
                    expected_revision: Some(revision),
                    name,
                    target_ids: ids,
                    delete: false,
                },
            )?;
        }
        if request.link_tag {
            tx.execute(
                "INSERT INTO character_target_tagger_tags VALUES(?1,?2)",
                params![target.id, request.tag],
            )?;
        }
        let queued_count = queue_in(&tx, &target, &detail.images, &excluded)?;
        // A new target needs fresh inference even for already-completed series jobs.
        // Keep enrollment atomic with registration and use the normal scope/pause rules.
        if target.ready && !target.manual_only {
            let ids = tx.prepare(
                "WITH RECURSIVE scope(id) AS (
                   SELECT ?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id
                 ) SELECT DISTINCT a.id FROM assets a
                 JOIN asset_classifications ac ON ac.asset_id=a.id JOIN scope s ON s.id=ac.classification_id
                 WHERE a.status='normal' AND a.media_kind='image'
                 AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=?2 AND r.asset_id=a.id)
                 AND NOT EXISTS(SELECT 1 FROM character_learned_references r WHERE r.target_id=?2 AND r.asset_id=a.id)"
            )?.query_map(params![target.series_classification_id, target.id], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for id in ids {
                super::character_autotag::enqueue(
                    &tx,
                    &id,
                    super::character_autotag::Cause::Reconsideration,
                )?;
            }
        }
        tx.commit()?;
        Ok(SuggestionResult {
            target,
            queued_count,
        })
    }

    pub fn merge_character_suggestion(&self, request: MergeSuggestion) -> Result<SuggestionResult> {
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let target = self.read_character_target(&tx, &request.target_id)?;
        if target.fingerprint != request.expected_fingerprint {
            return Err(Error::Stale);
        }
        let series = target
            .series_classification_id
            .as_deref()
            .ok_or(Error::Invalid("시리즈에 연결된 캐릭터를 선택해 주세요."))?;
        let detail = detail_in(&tx, &request.tag, Some(series))?;
        if detail.preview_token != request.preview_token {
            return Err(Error::Stale);
        }
        if request.link_tag {
            tx.execute(
                "INSERT INTO character_target_tagger_tags VALUES(?1,?2)",
                params![target.id, request.tag],
            )?;
        }
        let queued_count = queue_in(&tx, &target, &detail.images, &BTreeSet::new())?;
        tx.commit()?;
        Ok(SuggestionResult {
            target,
            queued_count,
        })
    }
}

#[cfg(test)]
#[path = "character_suggestions_tests.rs"]
mod tests;
