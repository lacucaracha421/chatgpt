use std::collections::BTreeSet;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{
    characters::{Error, Result, Target},
    image_fingerprint::hamming_distance,
    models::AssetSummary,
    query::asset_summaries_by_ids,
    Library,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceConfirmationMode {
    Initialize,
    AddLearned,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceCandidateSet {
    pub target_id: String,
    pub target_revision: i64,
    pub reference_set_hash: String,
    pub confirmation_mode: ReferenceConfirmationMode,
    pub minimum_selection: usize,
    pub items: Vec<AssetSummary>,
    pub suggested_asset_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmReferenceBatch {
    pub target_id: String,
    pub expected_revision: i64,
    pub expected_reference_set_hash: String,
    pub confirmation_mode: ReferenceConfirmationMode,
    pub asset_ids: Vec<String>,
}

#[derive(Clone, Debug)]
struct Candidate {
    asset_id: String,
    content_hash: String,
    fingerprint: Option<[u8; 32]>,
    quality: i64,
    sequence: i64,
}

pub(super) fn reference_set_hash(target: &Target) -> Result<String> {
    let references = target
        .usable_references()
        .map(|reference| json!([reference.asset_id, reference.asset_hash]))
        .collect::<Vec<_>>();
    Ok(Sha256::digest(serde_json::to_vec(
        &json!({"references": references}),
    )?)
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect())
}

fn quality_cmp(left: &Candidate, right: &Candidate) -> std::cmp::Ordering {
    right
        .quality
        .cmp(&left.quality)
        .then_with(|| right.sequence.cmp(&left.sequence))
        .then_with(|| left.asset_id.cmp(&right.asset_id))
}

fn minimum_distance(candidate: &Candidate, selected: &[Candidate]) -> u32 {
    let Some(hash) = candidate.fingerprint.as_ref() else {
        return 0;
    };
    selected
        .iter()
        .filter_map(|item| item.fingerprint.as_ref())
        .map(|other| hamming_distance(hash, other))
        .min()
        .unwrap_or(256)
}

fn select_diverse_candidates(mut eligible: Vec<Candidate>, limit: usize) -> Vec<Candidate> {
    eligible.sort_by(quality_cmp);
    let mut seen_hashes = BTreeSet::new();
    eligible.retain(|candidate| seen_hashes.insert(candidate.content_hash.clone()));

    let mut fingerprinted = eligible
        .iter()
        .filter(|candidate| candidate.fingerprint.is_some())
        .cloned()
        .collect::<Vec<_>>();
    let fallback = eligible
        .into_iter()
        .filter(|candidate| candidate.fingerprint.is_none())
        .collect::<Vec<_>>();
    let mut selected = Vec::new();
    if !fingerprinted.is_empty() && limit > 0 {
        selected.push(fingerprinted.remove(0));
    }
    while selected.len() < limit && !fingerprinted.is_empty() {
        let mut best = 0usize;
        for index in 1..fingerprinted.len() {
            let candidate_distance = minimum_distance(&fingerprinted[index], &selected);
            let best_distance = minimum_distance(&fingerprinted[best], &selected);
            if candidate_distance > best_distance
                || (candidate_distance == best_distance
                    && quality_cmp(&fingerprinted[index], &fingerprinted[best]).is_lt())
            {
                best = index;
            }
        }
        selected.push(fingerprinted.remove(best));
    }
    for candidate in fallback {
        if selected.len() == limit {
            break;
        }
        selected.push(candidate);
    }
    selected
}

impl Library {
    pub fn reference_candidates(
        &self,
        target_id: &str,
        limit: usize,
    ) -> Result<ReferenceCandidateSet> {
        if !(1..=20).contains(&limit) {
            return Err(Error::Invalid("레퍼런스 추천 개수는 1~20장입니다."));
        }
        let connection = self.connection()?;
        let target = self.read_character_target(&connection, target_id)?;
        let series = target
            .series_classification_id
            .as_deref()
            .ok_or(Error::Invalid("시리즈 폴더를 다시 연결해 주세요."))?;
        let mut statement = connection.prepare(
            "WITH RECURSIVE scope(id) AS (
                SELECT id FROM classification_entries WHERE id=?2
                UNION ALL SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id
             )
             SELECT r.asset_id,a.content_hash,a.perceptual_hash,COALESCE(a.perceptual_hash_quality,-1),d.sequence
             FROM character_relations r
             JOIN character_decisions d ON d.sequence=r.sequence AND d.origin='manual'
             JOIN assets a ON a.id=r.asset_id AND a.status='normal' AND a.media_kind='image'
             WHERE r.target_id=?1
               AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope))
               AND NOT EXISTS(SELECT 1 FROM character_relations other WHERE other.asset_id=a.id AND other.target_id<>?1)
               AND NOT EXISTS(SELECT 1 FROM character_references base WHERE base.target_id=?1 AND base.asset_id=a.id)
               AND NOT EXISTS(SELECT 1 FROM character_learned_references learned WHERE learned.target_id=?1 AND learned.asset_id=a.id)
               AND NOT EXISTS(SELECT 1 FROM character_reference_exclusions excluded WHERE excluded.target_id=?1 AND excluded.asset_id=a.id)
               AND NOT EXISTS(SELECT 1 FROM character_references base_hash WHERE base_hash.target_id=?1 AND base_hash.asset_hash=a.content_hash)
               AND NOT EXISTS(SELECT 1 FROM character_learned_references learned_hash WHERE learned_hash.target_id=?1 AND learned_hash.asset_hash=a.content_hash)
               AND NOT EXISTS(SELECT 1 FROM character_series_asset_exclusions excluded WHERE excluded.series_id=?2 AND excluded.asset_id=a.id)
             ORDER BY d.sequence DESC,r.asset_id LIMIT 400"
        )?;
        let eligible = statement
            .query_map(params![target_id, series], |row| {
                let bytes: Option<Vec<u8>> = row.get(2)?;
                let fingerprint = bytes.and_then(|bytes| <[u8; 32]>::try_from(bytes).ok());
                Ok(Candidate {
                    asset_id: row.get(0)?,
                    content_hash: row.get(1)?,
                    fingerprint,
                    quality: row.get(3)?,
                    sequence: row.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let remaining = limit.min(super::characters::MAX_REFERENCES.saturating_sub(
            target.references.len() + target.learned_references.len(),
        ));
        let selected = select_diverse_candidates(eligible, remaining);
        let suggested_asset_ids = selected
            .iter()
            .map(|candidate| candidate.asset_id.clone())
            .collect::<Vec<_>>();
        let items = asset_summaries_by_ids(&connection, &suggested_asset_ids)?;
        let confirmation_mode = if target.manual_only {
            ReferenceConfirmationMode::Initialize
        } else {
            ReferenceConfirmationMode::AddLearned
        };
        Ok(ReferenceCandidateSet {
            target_id: target.id.clone(),
            target_revision: target.revision,
            reference_set_hash: reference_set_hash(&target)?,
            confirmation_mode,
            minimum_selection: if confirmation_mode == ReferenceConfirmationMode::Initialize {
                5usize.saturating_sub(
                    target.usable_references().count(),
                )
            } else {
                1
            },
            items,
            suggested_asset_ids,
        })
    }

    pub fn confirm_reference_batch(&self, request: ConfirmReferenceBatch) -> Result<Target> {
        let unique = request.asset_ids.iter().collect::<BTreeSet<_>>();
        if unique.len() != request.asset_ids.len() {
            return Err(Error::Invalid(
                "같은 이미지를 레퍼런스로 중복 선택할 수 없습니다.",
            ));
        }
        match request.confirmation_mode {
            ReferenceConfirmationMode::Initialize if request.asset_ids.len() > 20 => {
                return Err(Error::Invalid(
                    "한 번에 추천 레퍼런스는 최대 20장까지 적용할 수 있습니다.",
                ));
            }
            ReferenceConfirmationMode::AddLearned
                if request.asset_ids.is_empty() || request.asset_ids.len() > 20 =>
            {
                return Err(Error::Invalid("추가 레퍼런스는 1~20장을 선택해 주세요."));
            }
            _ => {}
        }

        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let target = self.read_character_target(&transaction, &request.target_id)?;
        if target.revision != request.expected_revision
            || reference_set_hash(&target)? != request.expected_reference_set_hash
        {
            return Err(Error::Stale);
        }
        let series = target
            .series_classification_id
            .as_deref()
            .ok_or(Error::Invalid("시리즈 폴더를 다시 연결해 주세요."))?;
        let mut selected_hashes = target
            .references
            .iter()
            .map(|reference| reference.asset_hash.clone())
            .chain(
                target
                    .learned_references
                    .iter()
                    .map(|reference| reference.asset_hash.clone()),
            )
            .collect::<BTreeSet<_>>();
        for asset_id in &request.asset_ids {
            super::character_hub::validate_character_selection(
                &transaction,
                series,
                Some(&target.id),
                asset_id,
            )?;
            let manual_relation: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM character_relations r
                 JOIN character_decisions d ON d.sequence=r.sequence
                 WHERE r.target_id=?1 AND r.asset_id=?2
                   AND d.origin='manual' AND d.decision='accepted')",
                params![target.id, asset_id],
                |row| row.get(0),
            )?;
            if !manual_relation {
                return Err(Error::Invalid(
                    "직접 확인한 캐릭터 이미지만 레퍼런스로 사용할 수 있습니다.",
                ));
            }
            let already_reference: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM character_references WHERE target_id=?1 AND asset_id=?2)
                  OR EXISTS(SELECT 1 FROM character_learned_references WHERE target_id=?1 AND asset_id=?2)
                  OR EXISTS(SELECT 1 FROM character_reference_exclusions WHERE target_id=?1 AND asset_id=?2)",
                params![target.id, asset_id], |row| row.get(0),
            )?;
            if already_reference {
                return Err(Error::Invalid(
                    "이미 사용했거나 제외한 이미지는 다시 추천 레퍼런스로 적용할 수 없습니다.",
                ));
            }
            let (hash, _) = super::characters::scoped_image(&transaction, series, asset_id)?;
            if !selected_hashes.insert(hash) {
                return Err(Error::Invalid(
                    "내용이 같은 이미지를 레퍼런스로 중복 선택할 수 없습니다.",
                ));
            }
        }

        let result = match request.confirmation_mode {
            ReferenceConfirmationMode::Initialize => {
                if !target.manual_only {
                    return Err(Error::Invalid(
                        "이미 자동 분류 레퍼런스가 초기화된 캐릭터입니다.",
                    ));
                }
                let mut anchors = target
                    .usable_references()
                    .filter_map(|reference| reference.asset_id.clone())
                    .collect::<Vec<_>>();
                let needed = 5usize.saturating_sub(anchors.len());
                if request.asset_ids.len() < needed {
                    return Err(Error::Invalid(
                        "자동 분류를 시작하려면 기준 레퍼런스 5장을 채워 주세요.",
                    ));
                }
                anchors.extend(request.asset_ids.iter().take(needed).cloned());
                let after_anchors = self.replace_character_references_selection_in(
                    &transaction,
                    &target.id,
                    target.revision,
                    &anchors,
                    true,
                )?;
                let additions = &request.asset_ids[needed..];
                if additions.is_empty() {
                    after_anchors
                } else {
                    self.add_character_learned_references_in(
                        &transaction,
                        &target.id,
                        after_anchors.revision,
                        additions,
                    )?
                }
            }
            ReferenceConfirmationMode::AddLearned => {
                if target.manual_only {
                    return Err(Error::Invalid("레퍼런스 설정이 바뀌었습니다. 다시 열어 주세요."));
                }
                self.add_character_learned_references_in(
                    &transaction,
                    &target.id,
                    target.revision,
                    &request.asset_ids,
                )?
            }
        };
        transaction.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::characters::{tests::Fixture, FolderRegistration};
    use rusqlite::params;

    fn converted_fixture() -> (Fixture, Target) {
        let f = Fixture::new();
        let snapshot = f
            .library
            .character_folder_asset_snapshot(f.child.clone(), false)
            .unwrap();
        let result = f
            .library
            .register_character_folder(FolderRegistration {
                folder_id: f.child.clone(),
                series_id: f.series.clone(),
                recursive: false,
                cleanup_folder: false,
                expected_count: snapshot.count,
                expected_asset_fingerprint: snapshot.fingerprint,
                target_id: None,
                expected_fingerprint: None,
                display_name: "Converted".into(),
                reference_ids: vec![],
                thumbnail_id: None,
            })
            .unwrap();
        (f, result.target)
    }

    #[test]
    fn converted_folder_candidates_prefer_visual_spread() {
        let (f, target) = converted_fixture();
        let c = f.library.connection().unwrap();
        for (id, bytes, quality) in [
            ("asset-0", vec![0_u8; 32], 100_i64),
            (
                "asset-1",
                {
                    let mut v = vec![0_u8; 32];
                    v[31] = 1;
                    v
                },
                90,
            ),
            ("asset-2", vec![255_u8; 32], 80),
        ] {
            c.execute(
                "UPDATE assets SET perceptual_hash=?2,perceptual_hash_quality=?3 WHERE id=?1",
                params![id, bytes, quality],
            )
            .unwrap();
        }
        drop(c);
        let page = f.library.reference_candidates(&target.id, 3).unwrap();
        assert_eq!(
            page.confirmation_mode,
            ReferenceConfirmationMode::Initialize
        );
        assert_eq!(page.minimum_selection, 5);
        assert_eq!(page.suggested_asset_ids, ["asset-0", "asset-2", "asset-1"]);
    }

    #[test]
    fn initialize_confirmation_promotes_manual_target_without_scheduling_history() {
        let (f, target) = converted_fixture();
        let page = f.library.reference_candidates(&target.id, 20).unwrap();
        assert_eq!(page.suggested_asset_ids.len(), 5);
        let confirmed = f
            .library
            .confirm_reference_batch(ConfirmReferenceBatch {
                target_id: target.id.clone(),
                expected_revision: page.target_revision,
                expected_reference_set_hash: page.reference_set_hash,
                confirmation_mode: ReferenceConfirmationMode::Initialize,
                asset_ids: page.suggested_asset_ids,
            })
            .unwrap();
        assert!(!confirmed.manual_only);
        assert!(confirmed.ready);
        assert_eq!(confirmed.references.len(), 5);
        assert!(confirmed.learned_references.is_empty());
        let scheduled: i64 = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM character_autotag_reconsideration",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(scheduled, 0);
    }

    #[test]
    fn confirmation_rejects_stale_reference_set_even_when_target_revision_matches() {
        let (f, target) = converted_fixture();
        let page = f.library.reference_candidates(&target.id, 20).unwrap();
        let hash: String = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT content_hash FROM assets WHERE id='asset-0'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        f.library.connection().unwrap().execute(
            "INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at) VALUES(?1,'asset-0',?2,'now')",
            params![target.id, hash],
        ).unwrap();
        let error = f
            .library
            .confirm_reference_batch(ConfirmReferenceBatch {
                target_id: target.id,
                expected_revision: page.target_revision,
                expected_reference_set_hash: page.reference_set_hash,
                confirmation_mode: ReferenceConfirmationMode::Initialize,
                asset_ids: page.suggested_asset_ids,
            })
            .unwrap_err();
        assert!(matches!(error, Error::Stale));
    }

    #[test]
    fn candidates_require_current_manual_single_character_membership() {
        use crate::library::characters::{DecisionKind, DecisionRequest, TargetDraft};
        let (f, target) = converted_fixture();
        let other = f
            .library
            .save_character_target(TargetDraft {
                id: None,
                expected_revision: None,
                series_classification_id: Some(f.series.clone()),
                linked_classification_id: None,
                display_name: "Other".into(),
                description: String::new(),
                thumbnail_asset_id: None,
                enabled: true,
            })
            .unwrap();
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: other.id,
                expected_fingerprint: other.fingerprint,
                asset_ids: vec!["asset-0".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        f.library.connection().unwrap().execute(
            "INSERT INTO character_reference_exclusions(target_id,asset_id,created_at) VALUES(?1,'asset-1','now')",
            [&target.id],
        ).unwrap();
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec!["asset-2".into()],
                decision: DecisionKind::Rejected,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        f.library.connection().unwrap().execute(
            "UPDATE character_decisions SET origin='automatic' WHERE sequence=(SELECT sequence FROM character_relations WHERE target_id=?1 AND asset_id='asset-3')",
            [&target.id],
        ).unwrap();
        let page = f.library.reference_candidates(&target.id, 20).unwrap();
        assert_eq!(page.suggested_asset_ids, ["asset-4"]);
    }

    #[test]
    fn initialize_confirmation_preserves_underfilled_existing_anchors() {
        use crate::library::characters::{
            CharacterSettingsDraft, DecisionKind, DecisionRequest, TargetDraft,
        };
        let f = Fixture::new();
        let target = f
            .library
            .save_character_settings(
                CharacterSettingsDraft {
                    target: TargetDraft {
                        id: None,
                        expected_revision: None,
                        series_classification_id: Some(f.series.clone()),
                        linked_classification_id: None,
                        display_name: "Partial".into(),
                        description: String::new(),
                        thumbnail_asset_id: None,
                        enabled: true,
                    },
                    reference_ids: vec!["asset-0".into(), "asset-1".into()],
                },
                false,
            )
            .unwrap();
        assert!(target.manual_only);
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec!["asset-2".into(), "asset-3".into(), "asset-4".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        let page = f.library.reference_candidates(&target.id, 20).unwrap();
        assert_eq!(page.minimum_selection, 3);
        let confirmed = f
            .library
            .confirm_reference_batch(ConfirmReferenceBatch {
                target_id: target.id,
                expected_revision: page.target_revision,
                expected_reference_set_hash: page.reference_set_hash,
                confirmation_mode: page.confirmation_mode,
                asset_ids: page.suggested_asset_ids,
            })
            .unwrap();
        assert!(!confirmed.manual_only);
        assert_eq!(confirmed.references.len(), 5);
        assert_eq!(confirmed.references[0].asset_id.as_deref(), Some("asset-0"));
        assert_eq!(confirmed.references[1].asset_id.as_deref(), Some("asset-1"));
    }

    #[test]
    fn add_learned_confirmation_preserves_existing_anchors() {
        use crate::library::characters::{DecisionKind, DecisionRequest};
        let f = Fixture::new();
        let target = f.ready("Ready");
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        let before_anchor_ids = target
            .references
            .iter()
            .map(|item| item.asset_id.clone())
            .collect::<Vec<_>>();
        let page = f.library.reference_candidates(&target.id, 20).unwrap();
        assert_eq!(
            page.confirmation_mode,
            ReferenceConfirmationMode::AddLearned
        );
        assert_eq!(page.suggested_asset_ids, ["asset-5"]);
        let confirmed = f
            .library
            .confirm_reference_batch(ConfirmReferenceBatch {
                target_id: target.id.clone(),
                expected_revision: page.target_revision,
                expected_reference_set_hash: page.reference_set_hash,
                confirmation_mode: page.confirmation_mode,
                asset_ids: page.suggested_asset_ids,
            })
            .unwrap();
        assert_eq!(
            confirmed
                .references
                .iter()
                .map(|item| item.asset_id.clone())
                .collect::<Vec<_>>(),
            before_anchor_ids
        );
        assert_eq!(confirmed.learned_references.len(), 1);
        assert_eq!(
            confirmed.learned_references[0].asset_id.as_deref(),
            Some("asset-5")
        );
    }

    #[test]
    fn reference_set_hash_fences_learned_reference_changes_without_target_revision() {
        let (f, target) = converted_fixture();
        let before = reference_set_hash(&target).unwrap();
        let hash: String = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT content_hash FROM assets WHERE id='asset-0'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        f.library.connection().unwrap().execute(
            "INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at) VALUES(?1,'asset-0',?2,'now')",
            params![target.id, hash],
        ).unwrap();
        let after_target = f.library.get_character_target(&target.id).unwrap();
        assert_eq!(after_target.revision, target.revision);
        assert_ne!(reference_set_hash(&after_target).unwrap(), before);
    }
}
