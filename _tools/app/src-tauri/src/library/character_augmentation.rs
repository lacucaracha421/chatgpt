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
        by_target.insert(p.target_id.as_str(), (e, supported));
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
        let gate = &gates[id];
        if gate["enabled"] != true
            || gate["positive"].as_u64()? < 2
            || gate["negative"].as_u64()? < 2
            || gate["additional_tp"].as_u64()? < 2
            || gate["additional_fp"].as_u64()? != 0
        {
            continue;
        }
        if !by_target[id].1[i] {
            continue;
        }
        let competing_head = matches.iter().enumerate().any(|(j, peers)| {
            j != i && same_person(&boxes[i], &boxes[j]) && peers.iter().any(|other| *other != id)
        });
        let strong_native = native.iter().any(|other| {
            other != id
                && by_target.get(other.as_str()).is_some_and(|(e, _)| {
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

pub(super) fn is_hash(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
