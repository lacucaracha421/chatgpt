//! 기타 (extras): one unnamed bucket per character group and per series.
//!
//! A 기타 is stored like a manual character, so membership, counts, publication and
//! "빼기" use the paths every character uses. It is never a recognition target and never a
//! learning source (see migration 0127 and the `role='character'` filters of every query
//! that enumerates a series' characters). Images enter it by a person's hand, and leave it
//! when they join a real character of the same series (trigger `character_extras_leave_on_accept`).
//! The screens show just "기타"; the stored name ("<group> 기타") is internal and is only seen
//! by an older tablet that lists it as a character.
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::{
    character_groups::Group,
    characters::{DecisionKind, DecisionRequest, Error, Result, Target, MAX_REFERENCES},
    Library,
};

/// Names the automatic tags must read on this many images of a 기타 before one is suggested.
const SUGGESTION_MIN_IMAGES: usize = 5;
/// "Read" means the tag scored at least this on either automatic tagger (the same bar as the
/// tag suggestions and the assignment hints); `both_count` reports how many both read (확실).
const SUGGESTION_SCORE: f64 = 0.85;
/// References the promotion chooses by itself: five that start recognition and some extra
/// learned ones. A person may send an explicit list instead.
const PROMOTION_REFERENCE_LIMIT: usize = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtrasEntry {
    pub target_id: String,
    pub series_id: String,
    /// The group this 기타 belongs to; null for the series' own 기타.
    pub group_id: Option<String>,
    /// The internal name; screens show "기타".
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtrasSuggestion {
    /// The automatic tag (its readable name is the screen's job, as in tag suggestions).
    pub tag: String,
    pub image_count: usize,
    /// Images both automatic taggers read (확실).
    pub both_count: usize,
    pub pixai_count: usize,
    pub canary_count: usize,
    /// The 기타 images read under this tag, strongest reading first.
    pub asset_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteExtrasRequest {
    /// The 기타 the images come from.
    pub target_id: String,
    pub expected_fingerprint: String,
    pub display_name: String,
    /// The images that move to the new character (1~200, all currently in the 기타).
    pub asset_ids: Vec<String>,
    /// Representative image; defaults to the first normal image of `asset_ids`.
    #[serde(default)]
    pub thumbnail_asset_id: Option<String>,
    /// References chosen by a person (at most 25, among `asset_ids`). Without it the
    /// references are chosen here, single-person images first.
    #[serde(default)]
    pub reference_asset_ids: Option<Vec<String>>,
    /// The automatic tag these images were read under; it is linked to the new character.
    #[serde(default)]
    pub tag: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteExtrasResult {
    pub target: Target,
    pub moved_count: usize,
    pub reference_count: usize,
    /// True when the new character starts recognition (at least five references); false
    /// when it starts as a manual character.
    pub recognition: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtrasGroupResult {
    pub group: Group,
    pub extras: Target,
}

/// The stored name of a 기타 that no other character of the series already uses.
pub(super) fn unique_extras_name(
    connection: &Connection,
    series_id: &str,
    base: &str,
    except: Option<&str>,
) -> Result<String> {
    for n in 1..1000 {
        let name = if n == 1 {
            format!("{base} 기타")
        } else {
            format!("{base} 기타 {n}")
        };
        let taken: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_targets
              WHERE series_classification_id=?1 AND display_name=?2 AND id IS NOT ?3)",
            params![series_id, name, except],
            |row| row.get(0),
        )?;
        if !taken {
            return Ok(name);
        }
    }
    Err(Error::Invalid("기타 이름을 정할 수 없습니다."))
}

/// The series' own 기타 (`group_id` None) or a group's 기타, created on first use.
pub(super) fn ensure_extras_in(
    connection: &Connection,
    series_id: &str,
    group_id: Option<&str>,
) -> Result<String> {
    let registered: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",
        [series_id],
        |row| row.get(0),
    )?;
    if !registered {
        return Err(Error::Invalid("등록된 시리즈를 선택해 주세요."));
    }
    if super::classification::classification_in_role_scope(connection, series_id, "originals")? {
        return Err(Error::Invalid(
            "오리지널 보관 영역에서는 기타를 만들 수 없습니다.",
        ));
    }
    let base: String = match group_id {
        Some(group) => connection
            .query_row(
                "SELECT name FROM character_groups WHERE id=?1 AND series_id=?2",
                params![group, series_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(Error::Stale)?,
        None => connection.query_row(
            "SELECT name FROM classification_entries WHERE id=?1",
            [series_id],
            |row| row.get(0),
        )?,
    };
    let existing: Option<String> = connection
        .query_row(
            "SELECT id FROM character_targets
             WHERE role='extras' AND series_classification_id=?1 AND extras_group_id IS ?2",
            params![series_id, group_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let name = unique_extras_name(connection, series_id, base.trim(), None)?;
    connection.execute(
        "INSERT INTO character_targets
         (id,series_classification_id,display_name,enabled,manual_only,role,extras_group_id,created_at,updated_at)
         VALUES(?1,?2,?3,1,1,'extras',?4,?5,?5)",
        params![id, series_id, name, group_id, now],
    )?;
    connection.execute(
        "INSERT INTO character_manual_targets(target_id,created_at) VALUES(?1,?2)",
        params![id, now],
    )?;
    if let Some(group) = group_id {
        connection.execute(
            "INSERT INTO character_group_members(target_id,group_id) VALUES(?1,?2)",
            params![id, group],
        )?;
    }
    Ok(id)
}

/// A renamed group renames its 기타's stored name ("<group> 기타") unless that name is taken.
pub(super) fn rename_group_extras_in(
    connection: &Connection,
    group_id: &str,
    group_name: &str,
) -> Result<()> {
    let row: Option<(String, String, String)> = connection
        .query_row(
            "SELECT id,series_classification_id,display_name FROM character_targets
             WHERE role='extras' AND extras_group_id=?1 AND series_classification_id IS NOT NULL",
            [group_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((id, series, current)) = row else {
        return Ok(());
    };
    let name = unique_extras_name(connection, &series, group_name.trim(), Some(&id))?;
    if name != current {
        connection.execute(
            "UPDATE character_targets SET display_name=?2,revision=revision+1,updated_at=?3 WHERE id=?1",
            params![id, name, chrono::Utc::now().to_rfc3339()],
        )?;
    }
    Ok(())
}

/// Whether the file of an image can be opened (a reference needs its original).
fn original_available(library: &Library, connection: &Connection, asset_id: &str) -> bool {
    connection
        .query_row(
            "SELECT relative_path FROM assets WHERE id=?1",
            [asset_id],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|path| library.library_media_path(&path).ok())
        .and_then(|path| std::fs::metadata(path).ok())
        .is_some_and(|metadata| metadata.is_file())
}

impl Library {
    /// Every 기타 that exists: the series' own and the groups'. Missing ones are created by
    /// [`Self::ensure_character_extras`] when a screen first needs them.
    pub fn character_extras(&self) -> Result<Vec<ExtrasEntry>> {
        let connection = self.connection()?;
        let rows = connection
            .prepare(
                "SELECT t.id,t.series_classification_id,t.extras_group_id,t.display_name
                 FROM character_targets t
                 WHERE t.role='extras' AND t.series_classification_id IS NOT NULL
                 ORDER BY t.series_classification_id,t.extras_group_id IS NOT NULL,t.display_name,t.id",
            )?
            .query_map([], |row| {
                Ok(ExtrasEntry {
                    target_id: row.get(0)?,
                    series_id: row.get(1)?,
                    group_id: row.get(2)?,
                    name: row.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The 기타 of a series (`group_id` None) or of one of its groups, created if missing.
    pub fn ensure_character_extras(
        &self,
        series_id: &str,
        group_id: Option<&str>,
    ) -> Result<Target> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = ensure_extras_in(&tx, series_id, group_id)?;
        let target = self.read_character_target(&tx, &id)?;
        tx.commit()?;
        Ok(target)
    }

    /// A group that has only a 기타 (no real member yet), created in one transaction.
    pub fn create_character_extras_group(
        &self,
        series_id: &str,
        name: &str,
    ) -> Result<ExtrasGroupResult> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 100 {
            return Err(Error::Invalid("그룹 이름을 확인해 주세요."));
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let registered: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",
            [series_id],
            |row| row.get(0),
        )?;
        if !registered {
            return Err(Error::Invalid("등록된 시리즈를 선택해 주세요."));
        }
        let group_id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO character_groups(id,series_id,name) VALUES(?1,?2,?3)",
            params![group_id, series_id, name],
        )?;
        let extras_id = ensure_extras_in(&tx, series_id, Some(&group_id))?;
        let extras = self.read_character_target(&tx, &extras_id)?;
        let group = super::character_groups::groups_in(&tx, Some(series_id))?
            .into_iter()
            .find(|group| group.id == group_id)
            .ok_or(Error::NotFound)?;
        tx.commit()?;
        Ok(ExtrasGroupResult { group, extras })
    }

    /// Names the automatic tags read on at least five images of this 기타: each is a
    /// suggestion to make a character of those images. Tags already linked to a character
    /// or dismissed in the tag suggestions are not offered again.
    pub fn character_extras_suggestions(&self, target_id: &str) -> Result<Vec<ExtrasSuggestion>> {
        let connection = self.connection()?;
        let target = self.read_character_target(&connection, target_id)?;
        if !target.is_extras() {
            return Err(Error::Invalid("기타를 선택해 주세요."));
        }
        let mut by_tag = BTreeMap::<String, Vec<(String, f64, f64)>>::new();
        let mut statement = connection.prepare(
            "SELECT s.tag,s.asset_id,
                    MAX(CASE WHEN s.source='pixai' THEN s.score ELSE 0 END),
                    MAX(CASE WHEN s.source='canary' THEN s.score ELSE 0 END)
             FROM character_relations r
             JOIN assets a ON a.id=r.asset_id AND a.status='normal' AND a.media_kind='image'
             JOIN asset_tagger_character_scores s ON s.asset_id=r.asset_id
             WHERE r.target_id=?1 AND s.score>=?2
               AND NOT EXISTS(SELECT 1 FROM character_target_tagger_tags t WHERE t.tag=s.tag)
               AND NOT EXISTS(SELECT 1 FROM character_suggestion_ignored_tags i WHERE i.tag=s.tag)
             GROUP BY s.tag,s.asset_id",
        )?;
        let rows = statement.query_map(params![target_id, SUGGESTION_SCORE], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
            ))
        })?;
        for row in rows {
            let (tag, asset, pixai, canary) = row?;
            by_tag.entry(tag).or_default().push((asset, pixai, canary));
        }
        let mut suggestions = by_tag
            .into_iter()
            .filter(|(_, images)| images.len() >= SUGGESTION_MIN_IMAGES)
            .map(|(tag, mut images)| {
                images.sort_by(|a, b| {
                    b.1.max(b.2)
                        .total_cmp(&a.1.max(a.2))
                        .then_with(|| a.0.cmp(&b.0))
                });
                ExtrasSuggestion {
                    image_count: images.len(),
                    both_count: images
                        .iter()
                        .filter(|i| i.1 >= SUGGESTION_SCORE && i.2 >= SUGGESTION_SCORE)
                        .count(),
                    pixai_count: images.iter().filter(|i| i.1 >= SUGGESTION_SCORE).count(),
                    canary_count: images.iter().filter(|i| i.2 >= SUGGESTION_SCORE).count(),
                    asset_ids: images.into_iter().map(|i| i.0).collect(),
                    tag,
                }
            })
            .collect::<Vec<_>>();
        suggestions.sort_by(|a, b| {
            b.image_count
                .cmp(&a.image_count)
                .then_with(|| a.tag.cmp(&b.tag))
        });
        Ok(suggestions)
    }

    /// "캐릭터로": one transaction that makes a character of the chosen 기타 images.
    ///
    /// The new character lives in the 기타's group (or in no group for the series' 기타),
    /// gets "맞음" for the images, and the 기타 gets "빼기" (never "아님"). References are
    /// chosen with the usual selection (single-person images first, spread apart), or are the
    /// person's list. With five or more references the character starts recognition,
    /// otherwise it starts as a manual character. No historical comparison is queued; the
    /// screen offers "과거 미분류 이미지 갱신" afterwards. Any failure changes nothing.
    pub fn promote_character_extras(
        &self,
        request: PromoteExtrasRequest,
    ) -> Result<PromoteExtrasResult> {
        let name = request.display_name.trim();
        if name.is_empty() {
            return Err(Error::Invalid("캐릭터 이름을 입력해 주세요."));
        }
        let mut ordered = Vec::<String>::new();
        let mut chosen = BTreeSet::<String>::new();
        for id in &request.asset_ids {
            if chosen.insert(id.clone()) {
                ordered.push(id.clone());
            }
        }
        if ordered.is_empty() || ordered.len() > 200 {
            return Err(Error::Invalid(
                "기타에서 옮길 이미지를 1~200장 선택해 주세요.",
            ));
        }
        if let Some(references) = &request.reference_asset_ids {
            let unique = references.iter().collect::<BTreeSet<_>>();
            if references.len() > MAX_REFERENCES
                || unique.len() != references.len()
                || references.iter().any(|id| !chosen.contains(id))
            {
                return Err(Error::Invalid(
                    "레퍼런스는 옮길 이미지 안에서 중복 없이 최대 25장까지 고를 수 있습니다.",
                ));
            }
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let extras = self.read_character_target(&tx, &request.target_id)?;
        if !extras.is_extras() {
            return Err(Error::Invalid("기타를 선택해 주세요."));
        }
        if extras.fingerprint != request.expected_fingerprint {
            return Err(Error::Stale);
        }
        let series = extras
            .series_classification_id
            .clone()
            .ok_or(Error::Invalid("시리즈 폴더를 다시 연결해 주세요."))?;
        let duplicate: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_targets
              WHERE series_classification_id=?1 AND display_name=?2 COLLATE NOCASE)",
            params![series, name],
            |row| row.get(0),
        )?;
        if duplicate {
            return Err(Error::Invalid(
                "이 시리즈에 같은 이름의 캐릭터가 이미 있습니다. 다른 이름을 입력해 주세요.",
            ));
        }
        let members = tx
            .prepare(
                "SELECT r.asset_id FROM character_relations r
                 JOIN assets a ON a.id=r.asset_id AND a.status='normal'
                 WHERE r.target_id=?1",
            )?
            .query_map([&extras.id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<BTreeSet<_>, _>>()?;
        if !chosen.is_subset(&members) {
            return Err(Error::Invalid(
                "기타에 들어 있는 이미지만 캐릭터로 옮길 수 있습니다. 목록을 새로 고쳐 주세요.",
            ));
        }
        let thumbnail = match &request.thumbnail_asset_id {
            Some(id) => {
                if !chosen.contains(id) {
                    return Err(Error::Invalid(
                        "대표 이미지는 옮길 이미지 중에서 골라 주세요.",
                    ));
                }
                super::character_hub::validate_art(&tx, id)?;
                id.clone()
            }
            None => {
                let mut first = None;
                for id in &ordered {
                    if super::character_hub::validate_art(&tx, id).is_ok() {
                        first = Some(id.clone());
                        break;
                    }
                }
                first.ok_or(Error::Invalid(
                    "대표 이미지로 쓸 수 있는 정상 이미지가 없습니다.",
                ))?
            }
        };

        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO character_targets
             (id,series_classification_id,display_name,enabled,manual_only,thumbnail_asset_id,created_at,updated_at)
             VALUES(?1,?2,?3,1,1,?4,?5,?5)",
            params![id, series, name, thumbnail, now],
        )?;
        tx.execute(
            "INSERT INTO character_manual_targets(target_id,created_at) VALUES(?1,?2)",
            params![id, now],
        )?;
        if let Some(group) = &extras.extras_group_id {
            tx.execute(
                "INSERT INTO character_group_members(target_id,group_id) VALUES(?1,?2)",
                params![id, group],
            )?;
            tx.execute(
                "UPDATE character_groups SET revision=revision+1 WHERE id=?1",
                [group],
            )?;
        }
        // 빼기 for the 기타, then 맞음 for the new character: a removal and a confirmation,
        // never a rejection.
        for chunk in ordered.chunks(200) {
            let current = self.read_character_target(&tx, &extras.id)?;
            self.write_character_decisions(
                &tx,
                DecisionRequest {
                    target_id: extras.id.clone(),
                    expected_fingerprint: current.fingerprint,
                    asset_ids: chunk.to_vec(),
                    decision: DecisionKind::Cleared,
                    baseline_fingerprint: None,
                    scan_id: None,
                },
            )?;
        }
        for chunk in ordered.chunks(200) {
            let current = self.read_character_target(&tx, &id)?;
            self.write_character_decisions(
                &tx,
                DecisionRequest {
                    target_id: id.clone(),
                    expected_fingerprint: current.fingerprint,
                    asset_ids: chunk.to_vec(),
                    decision: DecisionKind::Accepted,
                    baseline_fingerprint: None,
                    scan_id: None,
                },
            )?;
        }

        // References: the person's list (checked strictly), or the usual diverse selection
        // among images whose original exists and that no other character claims.
        let (references, strict) = match request.reference_asset_ids {
            Some(list) => (list, true),
            None => {
                let created = self.read_character_target(&tx, &id)?;
                let candidates =
                    self.reference_candidates_in(&tx, &created, PROMOTION_REFERENCE_LIMIT, false)?;
                let mut picked = Vec::new();
                for asset in candidates.suggested_asset_ids {
                    if original_available(self, &tx, &asset)
                        && super::character_hub::other_character_names(&tx, Some(&id), &asset)?
                            .is_empty()
                    {
                        picked.push(asset);
                    }
                }
                (picked, false)
            }
        };
        if !references.is_empty() {
            let created = self.read_character_target(&tx, &id)?;
            self.replace_character_references_selection_in(
                &tx,
                &id,
                created.revision,
                &references,
                strict,
            )?;
        }

        let linked_tag = match &request.tag {
            Some(tag) => {
                let available: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM tagger_character_vocabulary WHERE tag=?1)
                     AND NOT EXISTS(SELECT 1 FROM character_target_tagger_tags WHERE tag=?1)
                     AND NOT EXISTS(SELECT 1 FROM character_suggestion_ignored_tags WHERE tag=?1)",
                    [tag],
                    |row| row.get(0),
                )?;
                if !available {
                    return Err(Error::Stale);
                }
                super::character_tagger_tags::explicitly_link(&tx, &id, tag)?;
                true
            }
            None => false,
        };
        let target = self.read_character_target(&tx, &id)?;
        tx.commit()?;
        if linked_tag {
            // Tagger tag links are a WITHOUT ROWID table the update hook does not report.
            self.character_changes.suggestion_inputs_changed();
        }
        Ok(PromoteExtrasResult {
            moved_count: ordered.len(),
            reference_count: target.usable_references().count(),
            recognition: target.ready && !target.manual_only,
            target,
        })
    }
}

#[cfg(test)]
#[path = "character_extras_tests.rs"]
mod tests;
