//! Bounded, live training snapshot for the optional additive character heads.
//!
//! Read-only. Composes one immutable JSON description of the supervision the
//! current library state actually supports, plus the source identity of every
//! image it names, so an offline fit never re-opens the library or guesses at
//! freshness.
//!
//! # What counts as truth
//!
//! The latest decision row per `(target, source_asset)` owns the pair, across
//! all origins and all decision kinds. Only after that latest row is chosen does
//! filtering happen:
//!
//! * `origin='manual'` with `accepted`/`rejected`, still matching current asset
//!   content, is a label.
//! * `cleared` is neither positive nor negative; it withdraws the pair.
//! * `origin='automatic'` is never truth, even as the latest row. A later
//!   automatic row therefore *removes* a pair rather than relabelling it, which
//!   is why the snapshot identity must not use the library-wide decision
//!   sequence.
//! * A pair with no row is unknown, and unknown is never a negative.
//!
//! A labelled source must also pass the live eligibility check
//! (`candidate_image_mode(.., automatic=true)`): an in-series still image with no
//! excluded folder, no series-asset exclusion, and no originals-role scope.
//!
//! # Fences
//!
//! [`TrainingSnapshot::id`] covers the relevant manual decision watermark, each
//! selected source's content hash *and* relative path plus its fingerprint,
//! every target's usable references including manual regions, the roster and
//! series flags, and the scope/exclusion policy. Query-specific state
//! (`Context::hash`, `Context::scope`) is excluded so a roster-identical call
//! reuses an already fitted model. Recomputing inside a later transaction
//! therefore differs whenever a label, reference, region, source byte, or scope
//! decision changed; the optional branch then drops its addition and the native
//! result stands.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    character_autotag::Context,
    characters::{Error, Result, Target},
    Library,
};

/// Snapshot schema version. Bump when the JSON shape changes incompatibly.
const VERSION: u32 = 1;
/// Maximum assets in one snapshot: selected labels plus every reference.
const MAX_SOURCES: usize = 256;
/// Maximum selected labelled sources, across all targets.
const MAX_LABELLED_SOURCES: usize = 128;
/// Maximum targets in one snapshot.
const MAX_TARGETS: usize = 8;
/// Minimum usable PDQ quality; below this a fingerprint is not a grouping key.
const MINIMUM_QUALITY: i64 = 50;
/// Stored PDQ is two 32-byte planes: whole image and cropped.
const PDQ_BYTES: usize = 64;
/// Hex length of the stored fingerprint.
const PDQ_HEX: usize = PDQ_BYTES * 2;

#[derive(Debug)]
pub(super) struct TrainingSnapshot {
    /// SHA256 over the canonical snapshot JSON. Any relevant change moves it.
    pub id: String,
    pub value: Value,
    /// Asset id -> (content hash, library-relative path) for every named asset,
    /// references included. The caller captures and re-verifies these bytes;
    /// this module never touches the filesystem.
    pub sources: BTreeMap<String, (String, String)>,
}

/// One supervision source with its grouping fingerprint.
#[derive(Clone, Debug, PartialEq, Eq)]
struct AssetRow {
    asset_id: String,
    content_hash: String,
    relative_path: String,
    pdq: String,
    quality: i64,
}

/// Per-asset label maps keyed by target id: accepted flags, then sequences.
type Labels = BTreeMap<String, bool>;
type Sequences = BTreeMap<String, i64>;

struct AssetLabels {
    labels: Labels,
    sequences: Sequences,
}

impl Library {
    /// Build the bounded training snapshot for the targets of one inference
    /// context. Read-only; the caller owns source capture and caching.
    pub(super) fn character_training_snapshot(
        &self,
        connection: &Connection,
        context: &Context,
    ) -> Result<TrainingSnapshot> {
        if context.targets.is_empty() {
            return Err(Error::Invalid("훈련 스냅샷에 캐릭터가 없습니다."));
        }
        if context.targets.len() > MAX_TARGETS {
            return Err(Error::Invalid("훈련 스냅샷 캐릭터 수가 너무 많습니다."));
        }
        let mut target_ids = context
            .targets
            .iter()
            .map(|target| target.id.clone())
            .collect::<Vec<_>>();
        target_ids.sort();
        target_ids.dedup();
        if target_ids.len() != context.targets.len() {
            return Err(Error::Invalid("훈련 스냅샷 캐릭터가 중복되었습니다."));
        }

        // Re-read from this connection: the snapshot must describe stored state,
        // not whatever the caller's copy of the targets happened to hold.
        let mut targets = Vec::with_capacity(target_ids.len());
        for id in &target_ids {
            targets.push(self.read_character_target(connection, id)?);
        }

        let mut rows: BTreeMap<String, (AssetRow, Option<AssetLabels>)> = BTreeMap::new();
        let mut references = Vec::with_capacity(targets.len());
        for target in &targets {
            let (value, added) = self.reference_rows(connection, target)?;
            for row in added {
                rows.insert(row.asset_id.clone(), (row, None));
            }
            references.push(value);
        }
        if rows.len() > MAX_SOURCES {
            return Err(Error::Invalid("기준 이미지가 스냅샷 한도를 넘었습니다."));
        }

        // Select a bounded source set; fill all its current labels below.
        // Labels are capped across all targets, not per target, so the whole
        // snapshot stays bounded as the roster grows.
        for target in &targets {
            let series = target
                .series_classification_id
                .as_deref()
                .ok_or(Error::Invalid("시리즈 폴더를 다시 연결해 주세요."))?;
            let mut remaining = MAX_LABELLED_SOURCES
                .saturating_sub(rows.values().filter(|(_, labels)| labels.is_some()).count());
            if remaining == 0 {
                break;
            }
            let mut statement = connection.prepare(
                "WITH latest AS (
                     SELECT source_asset_id,asset_id,asset_hash,decision,origin,sequence,
                            ROW_NUMBER() OVER (
                                PARTITION BY source_asset_id ORDER BY sequence DESC
                            ) AS rank
                     FROM character_decisions WHERE target_id=?1
                 )
                 SELECT l.source_asset_id,l.decision,l.sequence
                 FROM latest l
                 JOIN assets a ON a.id=l.source_asset_id
                 WHERE l.rank=1 AND l.origin='manual' AND l.decision IN ('accepted','rejected')
                   AND l.asset_id IS NOT NULL AND l.asset_hash=a.content_hash
                 ORDER BY l.sequence DESC,l.source_asset_id LIMIT ?2",
            )?;
            let candidates = statement
                .query_map(params![target.id, MAX_LABELLED_SOURCES as i64], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for (asset_id, decision, sequence) in candidates {
                if remaining == 0 {
                    break;
                }
                // The source must be eligible for this target exactly as the
                // live predicate would judge it: an in-series still image, not
                // in an excluded folder, not series-excluded, not originals.
                let Ok((content_hash, _)) =
                    super::character_hub::candidate_image_mode(connection, series, &asset_id, true)
                else {
                    continue;
                };
                let Some(row) = asset_row(connection, &asset_id, &content_hash)? else {
                    continue;
                };
                if rows.len() >= MAX_SOURCES && !rows.contains_key(&asset_id) {
                    continue;
                }
                let entry = rows.entry(asset_id.clone()).or_insert_with(|| (row, None));
                let labels = entry.1.get_or_insert_with(|| AssetLabels {
                    labels: Labels::new(),
                    sequences: Sequences::new(),
                });
                if labels.labels.is_empty() {
                    remaining -= 1;
                }
                labels
                    .labels
                    .insert(target.id.clone(), decision == "accepted");
                labels.sequences.insert(target.id.clone(), sequence);
            }
        }

        // A selection cap must not hide a rival label on a source we retained.
        for (asset_id, (row, labels)) in &mut rows {
            let mut current = AssetLabels {
                labels: Labels::new(),
                sequences: Sequences::new(),
            };
            for target in &targets {
                let Some(series) = target.series_classification_id.as_deref() else {
                    continue;
                };
                if super::character_hub::candidate_image_mode(connection, series, asset_id, true)
                    .is_err()
                {
                    continue;
                }
                let latest: Option<(String,String,String,i64)> = connection.query_row(
                    "SELECT decision,origin,asset_hash,sequence FROM character_decisions WHERE target_id=?1 AND source_asset_id=?2 ORDER BY sequence DESC LIMIT 1",
                    params![target.id,asset_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
                if let Some((decision, origin, hash, sequence)) = latest {
                    if origin == "manual"
                        && hash == row.content_hash
                        && matches!(decision.as_str(), "accepted" | "rejected")
                    {
                        current
                            .labels
                            .insert(target.id.clone(), decision == "accepted");
                        current.sequences.insert(target.id.clone(), sequence);
                    }
                }
            }
            *labels = Some(current);
        }
        let mut assets = Vec::with_capacity(rows.len());
        let mut sources = BTreeMap::new();
        for (asset_id, (row, labels)) in rows {
            assets.push(json!({
                "id": row.asset_id,
                "hash": row.content_hash,
                "path": row.relative_path,
                "pdq": row.pdq,
                "quality": row.quality,
                "labels": labels.as_ref().map(|labels| json!(labels.labels)).unwrap_or_else(|| json!({})),
                "labelSequences": labels.as_ref().map(|labels| json!(labels.sequences)).unwrap_or_else(|| json!({})),
            }));
            sources.insert(asset_id, (row.content_hash, row.relative_path));
        }

        let value = json!({
            "version": VERSION,
            "runtime": context.runtime,
            "manualSequence": manual_sequence(connection, &target_ids)?,
            "targets": references,
            "assets": assets,
            "roster": roster_value(connection, &targets)?,
        });
        let id = digest(&value)?;
        Ok(TrainingSnapshot { id, value, sources })
    }

    /// One target's usable references plus manual regions, and the asset rows
    /// they contribute.
    ///
    /// Seeds come from `character_references`; supporting examples come from
    /// `character_learned_references` and are *not* automatic truth. Both must
    /// be `ready` and carry a usable two-plane PDQ fingerprint, because the
    /// offline fitter groups near-duplicates and an unverifiable reference would
    /// leak into a calibration or test group. A missing fingerprint fails.
    fn reference_rows(
        &self,
        connection: &Connection,
        target: &Target,
    ) -> Result<(Value, Vec<AssetRow>)> {
        let seeds = target
            .references
            .iter()
            .filter(|reference| reference.status == "ready")
            .map(|reference| reference.asset_hash.clone())
            .collect::<BTreeSet<_>>();
        let mut references = Vec::new();
        let mut rows = Vec::new();
        for reference in target.usable_references() {
            let asset_id = reference
                .asset_id
                .clone()
                .ok_or(Error::Invalid("사용 가능한 기준 이미지에 자산이 없습니다."))?;
            // A reference whose bytes moved, whose fingerprint was cleared, or
            // which fell below the quality floor fails the whole snapshot: the
            // fitter cannot group it, and guessing would leak it into a group.
            let Some(row) = asset_row(connection, &asset_id, &reference.asset_hash)? else {
                return Err(Error::Stale);
            };
            references.push(json!({
                "assetId": asset_id,
                "hash": reference.asset_hash,
                "region": reference.region,
                "role": if seeds.contains(&reference.asset_hash) { "seed" } else { "support" },
            }));
            rows.push(row);
        }
        Ok((json!({"id": target.id, "references": references}), rows))
    }
}

/// Read one asset's current stored identity and fingerprint.
///
/// Returns `None` when the asset is absent, not a normal still image, no longer
/// has the expected content, or lacks a usable two-plane fingerprint at or above
/// the quality floor. Every caller treats `None` as unusable supervision.
fn asset_row(
    connection: &Connection,
    asset_id: &str,
    content_hash: &str,
) -> Result<Option<AssetRow>> {
    let found: Option<(String, Option<Vec<u8>>, i64)> = connection
        .query_row(
            "SELECT relative_path,perceptual_hash,COALESCE(perceptual_hash_quality,-1)
             FROM assets
             WHERE id=?1 AND status='normal' AND media_kind='image' AND content_hash=?2",
            params![asset_id, content_hash],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((relative_path, bytes, quality)) = found else {
        return Ok(None);
    };
    if quality < MINIMUM_QUALITY {
        return Ok(None);
    }
    let Some(bytes) = bytes.filter(|bytes| bytes.len() == PDQ_BYTES) else {
        return Ok(None);
    };
    let pdq = to_hex(&bytes);
    debug_assert_eq!(pdq.len(), PDQ_HEX);
    Ok(Some(AssetRow {
        asset_id: asset_id.into(),
        content_hash: content_hash.into(),
        relative_path,
        pdq,
        quality,
    }))
}

/// Current stored PDQ for one asset, for duplicate and exposure blocking.
///
/// Returns `null` fields when the asset has no usable 64-byte fingerprint, so a
/// caller can tell "absent" from "unreadable" without a second query.
pub(super) fn query_identity(connection: &Connection, asset_id: &str) -> Result<Value> {
    let found: Option<(Option<Vec<u8>>, i64)> = connection
        .query_row(
            "SELECT perceptual_hash,COALESCE(perceptual_hash_quality,-1) FROM assets
             WHERE id=?1 AND status='normal' AND media_kind='image'",
            [asset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((bytes, quality)) = found else {
        return Ok(json!({"pdq": Value::Null, "quality": Value::Null}));
    };
    match bytes.filter(|bytes| bytes.len() == PDQ_BYTES) {
        Some(bytes) => {
            let pdq = to_hex(&bytes);
            debug_assert_eq!(pdq.len(), PDQ_HEX);
            Ok(json!({"pdq": pdq, "quality": quality}))
        }
        None => Ok(json!({"pdq": Value::Null, "quality": Value::Null})),
    }
}

/// Roster, series flags, and scope/exclusion policy the snapshot depends on.
fn roster_value(connection: &Connection, targets: &[Target]) -> Result<Value> {
    let mut series_ids = targets
        .iter()
        .filter_map(|target| target.series_classification_id.clone())
        .collect::<BTreeSet<_>>();
    series_ids.extend(
        targets
            .iter()
            .filter_map(|target| target.linked_classification_id.clone()),
    );
    let mut series = Vec::with_capacity(series_ids.len());
    for id in &series_ids {
        let flags: Option<(i64, Option<i64>)> = connection
            .query_row(
                "SELECT auto_classify,(SELECT 1 FROM character_excluded_folders WHERE id=?1)
                 FROM character_series WHERE classification_id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let roles: i64 = connection.query_row(
            "SELECT COUNT(*) FROM classification_roles WHERE classification_id=?1",
            [id],
            |row| row.get(0),
        )?;
        series.push(json!({
            "id": id,
            "registered": flags.is_some(),
            "autoClassify": flags.as_ref().is_some_and(|flags| flags.0 != 0),
            "excluded": flags.and_then(|flags| flags.1).is_some(),
            "hasRole": roles > 0,
        }));
    }
    let mut groups = Vec::with_capacity(targets.len());
    for target in targets {
        let group: Option<(String, i64)> = connection
            .query_row(
                "SELECT m.group_id,g.revision FROM character_group_members m
                 JOIN character_groups g ON g.id=m.group_id WHERE m.target_id=?1",
                [&target.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        groups.push(json!({
            "id": target.id,
            "group": group.as_ref().map(|group| group.0.clone()),
            "groupRevision": group.map(|group| group.1),
            // An explicit series opt-out and the originals role both withdraw
            // scope for the live predicate, so they belong in the fence.
            "manualOnly": target.manual_only,
            "enabled": target.enabled,
        }));
    }
    Ok(json!({
        "series": series,
        "groups": groups,
        "folderExclusions": folder_exclusions(connection)?,
    }))
}

/// Every excluded folder id, sorted. The set is small and fully describes the
/// folder policy `resolve_character_scope` and the live predicate consult.
fn folder_exclusions(connection: &Connection) -> Result<Vec<String>> {
    Ok(connection
        .prepare("SELECT id FROM character_excluded_folders ORDER BY id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

/// The watermark of relevant *manual* decisions.
///
/// Automatic inserts also advance `character_decisions.sequence`, so a
/// library-wide watermark would invalidate every snapshot whenever unrelated
/// inference ran. Only the relevant target ids participate. Automatic rows that
/// replace a label drop that source from the selected set anyway.
fn manual_sequence(connection: &Connection, target_ids: &[String]) -> Result<i64> {
    let ids = serde_json::to_string(target_ids)?;
    Ok(connection.query_row(
        "SELECT COALESCE(MAX(sequence),0) FROM character_decisions
         WHERE origin='manual' AND target_id IN (SELECT value FROM json_each(?1))",
        [ids],
        |row| row.get(0),
    )?)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// SHA256 over the canonical snapshot JSON.
///
/// `serde_json` maps serialize in key order, and every map here is a
/// `BTreeMap` or an object literal with sorted keys, so the value tree is
/// already canonical and needs no separate re-serialization pass.
fn digest(value: &Value) -> Result<String> {
    Ok(Sha256::digest(serde_json::to_vec(value)?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::characters::{tests::Fixture, DecisionKind, DecisionRequest};

    /// Stamp a real two-plane PDQ on every fixture asset. Values are distinct
    /// per asset id so two assets never share a fingerprint by accident.
    fn stamp_pdq(f: &Fixture) {
        let connection = f.library.connection().unwrap();
        connection
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",
                [&f.series],
            )
            .unwrap();
        for index in 0..7 {
            let id = format!("asset-{index}");
            let mut bytes = vec![index as u8; PDQ_BYTES];
            bytes[32] = index as u8 ^ 0x5a;
            connection
                .execute(
                    "UPDATE assets SET perceptual_hash=?2,perceptual_hash_quality=90 WHERE id=?1",
                    params![id, bytes],
                )
                .unwrap();
        }
    }

    fn context(f: &Fixture, target: &Target) -> Context {
        Context {
            hash: "context-hash".into(),
            runtime: "a".repeat(64),
            scope: json!({"classificationIds": [f.series.clone()]}),
            targets: vec![target.clone()],
        }
    }

    fn decide(f: &Fixture, target: &Target, asset_ids: &[&str], decision: DecisionKind) -> u64 {
        let current = f.library.get_character_target(&target.id).unwrap();
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: current.fingerprint,
                asset_ids: asset_ids.iter().map(|id| (*id).to_string()).collect(),
                decision,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap()
    }

    /// A decision written with `origin='automatic'`, matching the insert shape
    /// the native finalizer uses. The public path always writes manual rows.
    fn decide_automatic(f: &Fixture, target: &Target, asset_id: &str, decision: &str) {
        let (hash, fingerprint): (String, String) = {
            let connection = f.library.connection().unwrap();
            let hash = connection
                .query_row(
                    "SELECT content_hash FROM assets WHERE id=?1",
                    [asset_id],
                    |row| row.get(0),
                )
                .unwrap();
            let fingerprint = target.fingerprint.clone();
            (hash, fingerprint)
        };
        f.library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO character_decisions
                 (target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,
                  baseline_fingerprint,reference_snapshot,origin,created_at)
                 VALUES(?1,?2,?2,?3,?4,?5,NULL,'[]','automatic','2026-09-21T00:00:00Z')",
                params![target.id, asset_id, hash, decision, fingerprint],
            )
            .unwrap();
    }

    fn asset_ids(snapshot: &TrainingSnapshot) -> Vec<String> {
        snapshot.value["assets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap().to_string())
            .collect()
    }

    fn labels(snapshot: &TrainingSnapshot, asset_id: &str) -> Value {
        snapshot.value["assets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == json!(asset_id))
            .map(|row| row["labels"].clone())
            .unwrap_or(Value::Null)
    }

    #[test]
    fn manual_labels_are_exported_with_hash_path_and_sequences() {
        let f = Fixture::new();
        stamp_pdq(&f);
        let target = f.ready("A");
        decide(&f, &target, &["asset-6"], DecisionKind::Accepted);

        let connection = f.library.connection().unwrap();
        let snapshot = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();

        assert_eq!(snapshot.value["version"], json!(1));
        assert_eq!(snapshot.value["runtime"], json!("a".repeat(64)));
        // Every asset row carries its fingerprint, path and quality.
        for row in snapshot.value["assets"].as_array().unwrap() {
            let id = row["id"].as_str().unwrap();
            assert_eq!(row["path"], json!(format!("assets/{id}.png")));
            assert_eq!(row["pdq"].as_str().unwrap().len(), PDQ_HEX);
            assert_eq!(row["quality"], json!(90));
            assert!(row["hash"].as_str().unwrap().len() == 64);
            assert!(snapshot.sources.contains_key(id));
        }
        assert_eq!(labels(&snapshot, "asset-6")[&target.id], json!(true));
        assert_eq!(snapshot.value["manualSequence"].as_i64().unwrap() > 0, true);
        let sequences = &snapshot.value["assets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == json!("asset-6"))
            .unwrap()["labelSequences"];
        assert!(sequences[&target.id].as_i64().unwrap() > 0);
    }

    #[test]
    fn references_are_assets_with_unknown_supporting_labels() {
        let f = Fixture::new();
        stamp_pdq(&f);
        let target = f.ready("A");
        // asset-5 becomes a supporting example; asset-6 becomes a labelled source.
        decide(&f, &target, &["asset-5"], DecisionKind::Accepted);
        let target = f
            .library
            .add_character_learned_references(&target.id, target.revision, &["asset-5".into()])
            .unwrap();
        decide(&f, &target, &["asset-6"], DecisionKind::Rejected);

        let connection = f.library.connection().unwrap();
        let snapshot = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();

        // Five seeds, one supporting reference, one labelled query source: all
        // seven fixture assets are named, references included.
        assert_eq!(asset_ids(&snapshot).len(), 7);
        for id in [
            "asset-0", "asset-1", "asset-2", "asset-3", "asset-4", "asset-5",
        ] {
            assert!(
                asset_ids(&snapshot).contains(&id.to_string()),
                "{id} missing"
            );
            // Unknown memberships are absent keys, never inferred negatives.
            assert!(labels(&snapshot, id).is_object());
        }
        assert_eq!(labels(&snapshot, "asset-6")[&target.id], json!(false));
        // The seeds still have their reference rows.
        let references = snapshot.value["targets"][0]["references"]
            .as_array()
            .unwrap();
        assert_eq!(references.len(), 6);
        let roles = references
            .iter()
            .map(|row| {
                (
                    row["assetId"].as_str().unwrap().to_string(),
                    row["role"].as_str().unwrap().to_string(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(roles["asset-0"], "seed");
        assert_eq!(roles["asset-5"], "support");
        for row in references {
            assert!(snapshot
                .sources
                .contains_key(row["assetId"].as_str().unwrap()));
        }
    }

    #[test]
    fn cleared_and_automatic_latest_rows_are_never_negatives() {
        let f = Fixture::new();
        stamp_pdq(&f);
        let target = f.ready("A");
        let connection = f.library.connection().unwrap();
        let empty = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();
        // Nothing is labelled yet, so no fixture asset carries a label map.
        assert!(empty.value["assets"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["labels"] == json!({})));
        drop(connection);

        decide(&f, &target, &["asset-6"], DecisionKind::Rejected);
        let connection = f.library.connection().unwrap();
        let rejected = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();
        assert_eq!(labels(&rejected, "asset-6")[&target.id], json!(false));
        drop(connection);

        // Clearing withdraws the pair entirely: not positive, not negative.
        decide(&f, &target, &["asset-6"], DecisionKind::Cleared);
        let connection = f.library.connection().unwrap();
        let cleared = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();
        assert!(labels(&cleared, "asset-6").is_null());
        drop(connection);

        // A later automatic accept must not invent a positive either.
        decide_automatic(&f, &target, "asset-6", "accepted");
        let connection = f.library.connection().unwrap();
        let automatic = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();
        assert!(labels(&automatic, "asset-6").is_null());
    }

    #[test]
    fn changed_content_drops_a_stale_label() {
        let f = Fixture::new();
        stamp_pdq(&f);
        let target = f.ready("A");
        decide(&f, &target, &["asset-6"], DecisionKind::Accepted);
        let replacement = Sha256::digest(b"replacement")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET content_hash=?1 WHERE id='asset-6'",
                params![replacement],
            )
            .unwrap();
        let connection = f.library.connection().unwrap();
        let snapshot = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();
        assert!(labels(&snapshot, "asset-6").is_null());
    }

    #[test]
    fn out_of_scope_sources_are_not_supervised() {
        let f = Fixture::new();
        stamp_pdq(&f);
        let target = f.ready("A");
        decide(&f, &target, &["asset-6"], DecisionKind::Accepted);
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",
                [&f.outside],
            )
            .unwrap();
        let connection = f.library.connection().unwrap();
        let snapshot = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();
        assert!(
            labels(&snapshot, "asset-6").is_null(),
            "an out-of-scope source is not supervision"
        );
    }

    #[test]
    fn regions_labels_and_scope_changes_move_the_snapshot_id() {
        let f = Fixture::new();
        stamp_pdq(&f);
        let target = f.ready("A");
        decide(&f, &target, &["asset-6"], DecisionKind::Rejected);
        let connection = f.library.connection().unwrap();
        let baseline = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();
        // The same context and roster must reproduce the same identity so an
        // already fitted model can be reused.
        assert_eq!(
            baseline.id,
            f.library
                .character_training_snapshot(&connection, &context(&f, &target))
                .unwrap()
                .id
        );
        drop(connection);

        // A new manual label changes the identity.
        decide(&f, &target, &["asset-5"], DecisionKind::Accepted);
        let connection = f.library.connection().unwrap();
        let labelled = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();
        assert_ne!(labelled.id, baseline.id);
        drop(connection);

        // A manual region changes the identity even when labels are identical.
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
        f.library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO character_reference_regions
                 (target_id,asset_id,asset_hash,baseline_fingerprint,bounds_json)
                 VALUES(?1,'asset-0',?2,?3,'[1,2,30,40]')",
                params![target.id, hash, crate::library::character_worker::BASELINE],
            )
            .unwrap();
        let connection = f.library.connection().unwrap();
        let regioned = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();
        assert_ne!(regioned.id, labelled.id);
        drop(connection);

        // A folder-scope exclusion changes the identity.
        f.library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO character_folder_exclusions(classification_id) VALUES(?1)",
                [&f.outside],
            )
            .unwrap();
        let connection = f.library.connection().unwrap();
        let scoped = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();
        assert_ne!(scoped.id, regioned.id);
    }

    #[test]
    fn automatic_only_activity_does_not_invalidate_a_snapshot() {
        let f = Fixture::new();
        stamp_pdq(&f);
        let target = f.ready("A");
        decide(&f, &target, &["asset-6"], DecisionKind::Accepted);
        let connection = f.library.connection().unwrap();
        let before = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();
        drop(connection);

        // An automatic acceptance advances the library-wide decision sequence
        // but must not move the manual fence.
        decide_automatic(&f, &target, "asset-5", "accepted");
        let connection = f.library.connection().unwrap();
        let after = f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .unwrap();
        assert_eq!(before.id, after.id);
        assert!(labels(&after, "asset-5").is_null());
    }

    #[test]
    fn unverifiable_reference_fingerprints_fail_closed() {
        let f = Fixture::new();
        stamp_pdq(&f);
        let target = f.ready("A");
        let connection = f.library.connection().unwrap();
        assert!(f
            .library
            .character_training_snapshot(&connection, &context(&f, &target))
            .is_ok());
        drop(connection);

        // A reference without a usable two-plane fingerprint is refused rather
        // than silently leaking an unverifiable near-reference group.
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET perceptual_hash=NULL WHERE id='asset-0'",
                [],
            )
            .unwrap();
        let connection = f.library.connection().unwrap();
        assert!(matches!(
            f.library
                .character_training_snapshot(&connection, &context(&f, &target)),
            Err(Error::Stale)
        ));
    }

    #[test]
    fn target_and_source_budgets_are_enforced() {
        let f = Fixture::new();
        stamp_pdq(&f);
        let target = f.ready("A");
        let connection = f.library.connection().unwrap();
        let mut too_many = context(&f, &target);
        too_many.targets = (0..=MAX_TARGETS).map(|_| target.clone()).collect();
        assert!(matches!(
            f.library
                .character_training_snapshot(&connection, &too_many),
            Err(Error::Invalid(_))
        ));
        let mut duplicated = context(&f, &target);
        duplicated.targets.push(target.clone());
        assert!(matches!(
            f.library
                .character_training_snapshot(&connection, &duplicated),
            Err(Error::Invalid(_))
        ));
        let mut empty = context(&f, &target);
        empty.targets.clear();
        assert!(matches!(
            f.library.character_training_snapshot(&connection, &empty),
            Err(Error::Invalid(_))
        ));
        // The agreed bounds: 128 labelled sources inside a 256-asset snapshot.
        assert_eq!(MAX_LABELLED_SOURCES, 128);
        assert_eq!(MAX_SOURCES, 256);
        assert!(MAX_LABELLED_SOURCES < MAX_SOURCES);
    }

    #[test]
    fn query_identity_reports_only_usable_stored_fingerprints() {
        let f = Fixture::new();
        stamp_pdq(&f);
        let connection = f.library.connection().unwrap();
        let identity = query_identity(&connection, "asset-0").unwrap();
        assert_eq!(identity["pdq"].as_str().unwrap().len(), PDQ_HEX);
        assert_eq!(identity["quality"], json!(90));
        assert_ne!(
            query_identity(&connection, "asset-1").unwrap()["pdq"],
            identity["pdq"]
        );
        assert_eq!(
            query_identity(&connection, "missing").unwrap(),
            json!({"pdq": Value::Null, "quality": Value::Null})
        );
    }
}
