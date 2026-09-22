//! Optional additions never replace native arbitration or existing judgments.
use super::{
    character_autotag::Prediction,
    character_scan::{
        automatic_evidence_regions, competitor_allows_automatic, same_person,
        AUTOMATIC_COMPETITOR_MARGIN, AUTOMATIC_MAX_SIXTH_DISTANCE, AUTOMATIC_REFERENCE_SUPPORT,
    },
    character_worker::BASELINE,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub(super) const RECALL_POLICY: &str = "recall-tp-minus-2fp-v1";

fn recall_gate(gate: &Value) -> Option<bool> {
    let enabled = gate["enabled"].as_bool()?;
    let positive = gate["positive"].as_u64()?;
    let negative = gate["negative"].as_u64()?;
    let recovered = gate["recovered"].as_u64()?;
    let errors = gate["false_positive"].as_u64()?;
    if !enabled {
        return Some(false);
    }
    let threshold = gate["threshold"].as_f64()?;
    Some(
        positive >= 1
            && negative >= 2
            && recovered <= positive
            && errors <= negative
            && errors <= (negative / 10).max(1)
            && recovered > errors.checked_mul(2)?
            && threshold.is_finite()
            && (0.5..=1.0).contains(&threshold),
    )
}

/// Derive missing query PDQ in memory; retain the stored identity for DB fences.
/// Existing low-quality fingerprints must not bypass the quality guard.
pub(super) fn query_identity(
    stored: &Value,
    source: &super::character_sources::Source,
) -> super::characters::Result<Option<Value>> {
    let identity = if stored["pdq"].is_null() {
        let result =
            super::similarity::perceptual_hash_from_file(std::fs::File::open(source.path())?)?;
        let pdq: String = result
            .fingerprint
            .to_stored_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        json!({"pdq": pdq, "quality": result.fingerprint.quality})
    } else {
        stored.clone()
    };
    let usable = identity["pdq"].as_str().is_some_and(|pdq| {
        pdq.len() == 128
            && pdq
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) && identity["quality"]
        .as_u64()
        .is_some_and(|quality| quality >= 50);
    Ok(usable.then_some(identity))
}

pub(super) fn policy() -> Value {
    let baseline: Value =
        serde_json::from_str(include_str!("../../../character-runtime/baseline.json"))
            .expect("bundled baseline");
    json!({"logic_version":2,"recommendation_threshold":baseline["threshold"],
        "automatic_support":AUTOMATIC_REFERENCE_SUPPORT,"automatic_max_distance":AUTOMATIC_MAX_SIXTH_DISTANCE,
        "automatic_competitor_margin":AUTOMATIC_COMPETITOR_MARGIN,"baseline_fingerprint":BASELINE})
}

pub(super) fn bounds(value: &Value) -> Option<[f64; 4]> {
    let a = value.as_array()?;
    if a.len() != 4 {
        return None;
    }
    let b = [
        a[0].as_f64()?,
        a[1].as_f64()?,
        a[2].as_f64()?,
        a[3].as_f64()?,
    ];
    (b.iter().all(|x| x.is_finite()) && b[2] > b[0] && b[3] > b[1]).then_some(b)
}

pub(super) fn native_selection<'a>(
    predictions: &'a [Prediction],
    prior: &BTreeMap<String, String>,
    references: &BTreeSet<String>,
) -> (Vec<&'a Prediction>, Vec<[f64; 4]>) {
    let candidates = predictions
        .iter()
        .filter(|p| {
            !prior
                .get(&p.target_id)
                .is_some_and(|d| matches!(d.as_str(), "rejected" | "cleared"))
        })
        .collect::<Vec<_>>();
    let boxes = predictions
        .first()
        .and_then(|p| p.result.evidence.as_ref())
        .and_then(|e| e["queryBoxes"].as_array());
    let known = !references.is_empty() || prior.values().any(|d| d == "accepted");
    let mut accepted = Vec::new();
    let mut covered = Vec::new();
    for p in &candidates {
        if references.contains(&p.target_id)
            || p.result.error.is_some()
            || !matches!(p.result.state.as_str(), "recommended" | "unmatched")
        {
            continue;
        }
        let Some(regions) = automatic_evidence_regions(p.result.evidence.as_ref()) else {
            continue;
        };
        let unique = regions
            .iter()
            .filter(|region| {
                candidates
                    .iter()
                    .filter(|other| other.target_id != p.target_id)
                    .all(|other| {
                        other.result.error.is_none()
                            && matches!(other.result.state.as_str(), "recommended" | "unmatched")
                            && competitor_allows_automatic(region, other.result.evidence.as_ref())
                                == Some(true)
                    })
            })
            .map(|region| region.bounds)
            .collect::<Vec<_>>();
        if unique.is_empty() {
            continue;
        }
        if let Some(decision) = prior.get(&p.target_id) {
            if decision == "accepted" {
                covered.extend(unique);
            }
            continue;
        }
        if known && boxes.is_some_and(|boxes| boxes.len() == 1) {
            continue;
        }
        covered.extend(unique);
        accepted.push(*p);
    }
    (accepted, covered)
}

/// Validate the full optional response before accepting any of its regions.
/// Returning None discards only augmentation; the caller retains native results.
pub(super) fn additions(
    response: &Value,
    predictions: &[Prediction],
    native: &BTreeSet<String>,
    prior: &BTreeMap<String, String>,
    references: &BTreeSet<String>,
) -> Option<BTreeMap<String, Vec<[f64; 4]>>> {
    if response["type"] != "augmentation_result"
        || response["state"] != "ready"
        || response["policyId"] != RECALL_POLICY
        || !is_hash(&response["modelId"])
    {
        return None;
    }
    let first = predictions.first()?;
    if response["assetId"] != first.result.asset_id
        || response["contentHash"] != first.result.content_hash
    {
        return None;
    }
    let boxes = response["queryBoxes"].as_array()?;
    if boxes.is_empty() || boxes.len() > 8 {
        return None;
    }
    let boxes = boxes.iter().map(bounds).collect::<Option<Vec<_>>>()?;
    let roster = predictions
        .iter()
        .map(|p| p.target_id.as_str())
        .collect::<BTreeSet<_>>();
    let gates = response["gates"].as_object()?;
    if gates.keys().map(String::as_str).collect::<BTreeSet<_>>() != roster {
        return None;
    }
    let regions = response["headDecision"]["regions"].as_array()?;
    let unavailable = response["headDecision"]["unavailable_heads"].as_object()?;
    if regions.len() != boxes.len() || unavailable.keys().any(|id| !roster.contains(id.as_str())) {
        return None;
    }
    let mut matches = Vec::new();
    for (i, region) in regions.iter().enumerate() {
        if region["index"].as_u64()? != i as u64 {
            return None;
        }
        let ids = region["candidates"]
            .as_array()?
            .iter()
            .map(Value::as_str)
            .collect::<Option<BTreeSet<_>>>()?;
        if ids.len() != region["candidates"].as_array()?.len()
            || ids
                .iter()
                .any(|id| !roster.contains(id) || unavailable.contains_key(*id))
        {
            return None;
        }
        if (ids.len() == 1) != (region["state"] == "accepted_shadow") {
            return None;
        }
        matches.push(ids);
    }
    let threshold = policy()["recommendation_threshold"].as_f64()?;
    let mut by_target = BTreeMap::new();
    for p in predictions {
        if p.result.error.is_some()
            || !matches!(p.result.state.as_str(), "recommended" | "unmatched")
        {
            return None;
        }
        let e = p.result.evidence.as_ref()?;
        if e["wholeFallback"] != false
            || e["queryBoxes"] != response["queryBoxes"]
            || e["baselineFingerprint"] != BASELINE
        {
            return None;
        }
        let hashes = e["referenceHashes"].as_array()?;
        if !(5..=25).contains(&hashes.len())
            || hashes
                .iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>()
                .len()
                != hashes.len()
        {
            return None;
        }
        let rows = e["evidence"].as_array()?;
        if rows.len() != boxes.len() {
            return None;
        }
        let mut supported = Vec::new();
        for row in rows {
            let distances = row["referenceDistances"]
                .as_array()?
                .iter()
                .map(Value::as_f64)
                .collect::<Option<Vec<_>>>()?;
            if distances.len() != hashes.len() || distances.iter().any(|d| !d.is_finite()) {
                return None;
            }
            let expected = distances
                .iter()
                .enumerate()
                .filter(|(_, d)| **d <= threshold)
                .map(|(i, _)| json!(i))
                .collect::<Vec<_>>();
            if row["matchedReferences"] != json!(expected) {
                return None;
            }
            supported.push(expected.len() >= 2);
        }
        if e["passed"] != json!(supported.iter().any(|s| *s)) {
            return None;
        }
        by_target.insert(p.target_id.as_str(), e);
    }
    let known = !references.is_empty() || prior.values().any(|d| d == "accepted");
    let mut added: BTreeMap<String, Vec<[f64; 4]>> = BTreeMap::new();
    for (i, ids) in matches.iter().enumerate() {
        if ids.len() != 1 {
            continue;
        }
        let id = *ids.first()?;
        if native.contains(id)
            || prior.contains_key(id)
            || references.contains(id)
            || (known && boxes.len() == 1)
        {
            continue;
        }
        if !recall_gate(&gates[id])? {
            continue;
        }
        let competing_head = matches.iter().enumerate().any(|(j, peers)| {
            j != i && same_person(&boxes[i], &boxes[j]) && peers.iter().any(|other| *other != id)
        });
        let strong_native = native.iter().any(|other| {
            other != id
                && by_target.get(other.as_str()).is_some_and(|e| {
                    automatic_evidence_regions(Some(e)).is_some_and(|regions| {
                        regions
                            .iter()
                            .any(|region| same_person(&boxes[i], &region.bounds))
                    })
                })
        });
        if !competing_head && !strong_native {
            added.entry(id.into()).or_default().push(boxes[i]);
        }
    }
    Some(added)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{character_sources::Source, characters::tests::Fixture};
    use sha2::{Digest, Sha256};

    #[test]
    fn recall_receipts_enforce_counts_budget_utility_and_threshold() {
        let good = json!({"enabled":true,"positive":4,"negative":2,
            "recovered":4,"false_positive":1,"threshold":0.6});
        assert_eq!(recall_gate(&good), Some(true));
        for (key, value) in [
            ("enabled", json!(false)),
            ("positive", json!(0)),
            ("negative", json!(1)),
            ("recovered", json!(5)),
            ("recovered", json!(2)),
            ("false_positive", json!(2)),
            ("false_positive", json!(u64::MAX)),
            ("threshold", json!(0.49)),
            ("threshold", json!(1.01)),
            ("threshold", Value::Null),
            ("recovered", json!(-1)),
            ("negative", json!(2.5)),
        ] {
            let mut bad = good.clone();
            bad[key] = value;
            assert_ne!(recall_gate(&bad), Some(true), "{key}: {bad}");
        }
        assert_eq!(
            recall_gate(&json!({"enabled":true,"positive":1,"negative":2,
            "recovered":1,"false_positive":0,"threshold":0.5})),
            Some(true)
        );
        assert_eq!(
            recall_gate(&json!({"enabled":true,"positive":5,"negative":20,
            "recovered":5,"false_positive":2,"threshold":1.0})),
            Some(true)
        );
        assert_ne!(
            recall_gate(&json!({"enabled":true,"positive":2,"negative":2,
            "additional_tp":2,"additional_fp":0})),
            Some(true)
        );
    }

    #[test]
    fn augmentation_query_pdq_is_in_memory_and_preserves_stored_quality_guard() {
        let f = Fixture::new();
        let path = f.temp.path().join("assets/asset-5.png");
        let image = image::RgbImage::from_fn(128, 128, |x, y| {
            image::Rgb([
                (x * 17 + y * 31) as u8,
                (x * 43 + y * 7) as u8,
                (x * 11 + y * 53) as u8,
            ])
        });
        image.save(&path).unwrap();
        let hash: String = Sha256::digest(std::fs::read(&path).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        f.library.connection().unwrap().execute(
            "UPDATE assets SET content_hash=?1,perceptual_hash=NULL,perceptual_hash_quality=NULL WHERE id='asset-5'",
            [&hash],
        ).unwrap();
        let source = Source::capture(&f.library, "assets/asset-5.png", &hash).unwrap();
        let stored = crate::library::character_training::query_identity(
            &f.library.connection().unwrap(),
            "asset-5",
        )
        .unwrap();
        let derived = query_identity(&stored, &source).unwrap().unwrap();
        assert_eq!(derived["pdq"].as_str().unwrap().len(), 128);
        assert!(derived["quality"].as_u64().unwrap() >= 50);
        assert!(stored["pdq"].is_null());
        assert_eq!(
            crate::library::character_training::query_identity(
                &f.library.connection().unwrap(),
                "asset-5",
            )
            .unwrap(),
            stored
        );
        source.verify(&f.library).unwrap();
        source.check_identity(&f.library).unwrap();
        let existing = json!({"pdq":"ab".repeat(64),"quality":90});
        assert_eq!(query_identity(&existing, &source).unwrap(), Some(existing));
        assert!(
            query_identity(&json!({"pdq":"ab".repeat(64),"quality":49}), &source)
                .unwrap()
                .is_none()
        );
        assert!(
            query_identity(&json!({"pdq":"invalid","quality":90}), &source)
                .unwrap()
                .is_none()
        );
        let invalid_hash: String = Sha256::digest(b"asset-4")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let invalid = Source::capture(&f.library, "assets/asset-4.png", &invalid_hash).unwrap();
        assert!(query_identity(&stored, &invalid).is_err());
    }
}

pub(super) fn is_hash(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
