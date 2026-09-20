use super::*;

fn binding(content_hash: &str, bounds: [u32; 4]) -> RegionBinding {
    RegionBinding {
        content_hash: content_hash.into(),
        baseline_fingerprint: BASELINE.into(),
        bounds,
    }
}

/// A valid row in the given state, shaped the way the worker produces that state.
fn row_in_state(asset_id: &str, hash: &str, state: &str) -> ReferenceInspection {
    let mut row = ReferenceInspection {
        asset_id: asset_id.into(),
        content_hash: hash.into(),
        baseline_fingerprint: BASELINE.into(),
        width: 80,
        height: 100,
        boxes: vec![[0, 0, 40, 50], [40, 50, 80, 100]],
        selected_index: None,
        suggested_index: None,
        state: state.into(),
        automatic_index: None,
    };
    match state {
        // An explicit binding resolves to the crop the user named.
        "selected" => row.selected_index = Some(1),
        // The one unambiguous detection: a single box and index 0.
        "single" => {
            row.boxes = vec![[0, 0, 80, 100]];
            row.selected_index = Some(0);
        }
        // The common person the worker inferred, never a user's explicit choice.
        "automatic" => row.automatic_index = Some(1),
        // No detection at all.
        "no_region" => row.boxes = Vec::new(),
        // The worker's own multi-person report, or a binding that no longer matches.
        "needs_region" | "stale_region" => {}
        other => panic!("unsupported state in test: {other}"),
    }
    row
}

fn row(asset_id: &str, hash: &str) -> ReferenceInspection {
    row_in_state(asset_id, hash, "single")
}

fn expected() -> Vec<(String, String)> {
    vec![("asset-0".into(), "hash-0".into())]
}

#[test]
fn missing_automatic_index_deserializes_as_none_for_older_workers() {
    let legacy = serde_json::json!({"assetId":"a","contentHash":"h","baselineFingerprint":BASELINE,
        "width":80,"height":100,"boxes":[[0,0,80,100]],"selectedIndex":0,"suggestedIndex":null,
        "state":"single"});
    let parsed: ReferenceInspection = serde_json::from_value(legacy).unwrap();
    assert_eq!(parsed.automatic_index, None);
    assert_eq!(parsed.selected_index, Some(0));
    let current = serde_json::json!({"assetId":"a","contentHash":"h","baselineFingerprint":BASELINE,
        "width":80,"height":100,"boxes":[[0,0,80,100]],"selectedIndex":null,"suggestedIndex":1,
        "state":"automatic","automaticIndex":1});
    let parsed: ReferenceInspection = serde_json::from_value(current).unwrap();
    assert_eq!(parsed.automatic_index, Some(1));
    assert_eq!(parsed.selected_index, None);
    assert_eq!(parsed.state, "automatic");
}

#[test]
fn automatic_and_manual_crop_indexes_are_bounded_against_the_boxes() {
    let mut automatic = row_in_state("asset-0", "hash-0", "automatic");
    assert!(validate_inspection_rows(&expected(), &[automatic.clone()]).is_ok());
    automatic.automatic_index = Some(2);
    assert!(matches!(
        validate_inspection_rows(&expected(), &[automatic]),
        Err(Error::Stale)
    ));
    for index in [Some(2), Some(usize::MAX)] {
        let mut manual = row("asset-0", "hash-0");
        manual.selected_index = index;
        assert!(matches!(
            validate_inspection_rows(&expected(), &[manual]),
            Err(Error::Stale)
        ));
        let mut suggested = row("asset-0", "hash-0");
        suggested.suggested_index = index;
        assert!(matches!(
            validate_inspection_rows(&expected(), &[suggested]),
            Err(Error::Stale)
        ));
    }
    // A resolved choice may also carry the mirrored suggestion.
    let mut last = row_in_state("asset-0", "hash-0", "selected");
    last.suggested_index = Some(1);
    assert!(validate_inspection_rows(&expected(), &[last]).is_ok());
}

#[test]
fn automatic_state_and_automatic_index_must_agree() {
    let expected = expected();
    // An inferred common person is usable, so it must name exactly one crop.
    let mut inferred = row_in_state("asset-0", "hash-0", "automatic");
    assert!(validate_inspection_rows(&expected, &[inferred.clone()]).is_ok());
    // The automatic choice may be mirrored as a suggestion for the chooser.
    inferred.suggested_index = Some(0);
    assert!(validate_inspection_rows(&expected, &[inferred.clone()]).is_ok());
    // `automatic` without an index cannot be rendered or counted.
    let mut inferred = inferred;
    inferred.automatic_index = None;
    assert!(matches!(
        validate_inspection_rows(&expected, &[inferred]),
        Err(Error::Stale)
    ));
    // A non-automatic state must not claim an inferred person.
    for state in ["single", "selected"] {
        let mut claimed = row_in_state("asset-0", "hash-0", state);
        claimed.automatic_index = Some(0);
        assert!(
            matches!(
                validate_inspection_rows(&expected, &[claimed]),
                Err(Error::Stale)
            ),
            "{state}"
        );
    }
}

#[test]
fn all_known_inspection_states_are_accepted_and_unknown_ones_are_rejected() {
    let expected = expected();
    // Every protocol state is a normal inspection result. A partly unresolved set is exactly
    // what manual verification exists to fix, so it must never be an error.
    for state in INSPECTION_STATES {
        assert!(
            validate_inspection_rows(&expected, &[row_in_state("asset-0", "hash-0", state)]).is_ok(),
            "{state}"
        );
    }
    // A state outside the protocol cannot be rendered or counted, so it fails closed.
    for state in ["", "unknown", "AUTOMATIC", "Single", "need_region", "single "] {
        assert!(
            matches!(
                validate_inspection_rows(&expected, &[row_in_unchecked_state("asset-0", "hash-0", state)]),
                Err(Error::Stale)
            ),
            "{state}"
        );
    }
}

/// A row in an arbitrary, possibly unsupported state. Negative cases only.
fn row_in_unchecked_state(asset_id: &str, hash: &str, state: &str) -> ReferenceInspection {
    let mut row = row_in_state(asset_id, hash, "needs_region");
    row.state = state.into();
    row
}

#[test]
fn unresolved_states_supply_no_crop_and_never_fabricate_one() {
    let expected = expected();
    for state in ["needs_region", "no_region", "stale_region"] {
        let row = row_in_state("asset-0", "hash-0", state);
        assert_eq!(row.selected_index, None, "{state}");
        assert_eq!(row.automatic_index, None, "{state}");
        // Fabricating a crop for an unresolved image would silently supply a wrong person.
        for index in [Some(0), Some(1)] {
            let mut claimed = row.clone();
            claimed.selected_index = index;
            assert!(
                matches!(validate_inspection_rows(&expected, &[claimed]), Err(Error::Stale)),
                "{state} selectedIndex={index:?}"
            );
            let mut claimed = row.clone();
            claimed.automatic_index = index;
            assert!(
                matches!(validate_inspection_rows(&expected, &[claimed]), Err(Error::Stale)),
                "{state} automaticIndex={index:?}"
            );
        }
    }
}

#[test]
fn state_fixes_the_crop_shape_of_each_row() {
    let expected = expected();
    // A resolved state must name the crop it resolves to.
    for state in ["selected", "single"] {
        let mut missing = row_in_state("asset-0", "hash-0", state);
        missing.selected_index = None;
        assert!(
            matches!(validate_inspection_rows(&expected, &[missing]), Err(Error::Stale)),
            "{state} without selectedIndex"
        );
    }
    // `single` is one unambiguous detection, so several boxes cannot be reported.
    let multi = vec![[0, 0, 10, 10], [10, 10, 20, 20]];
    let mut many = row_in_state("asset-0", "hash-0", "single");
    many.boxes = multi.clone();
    assert!(matches!(validate_inspection_rows(&expected, &[many]), Err(Error::Stale)));
    // ...nor a non-zero index, which would mean the worker guessed among several people.
    let mut offset = row_in_state("asset-0", "hash-0", "single");
    offset.boxes = multi;
    offset.selected_index = Some(1);
    assert!(matches!(validate_inspection_rows(&expected, &[offset]), Err(Error::Stale)));
    // `automatic` is the worker's inference, never a user's explicit choice.
    let mut both = row_in_state("asset-0", "hash-0", "automatic");
    both.selected_index = Some(0);
    assert!(matches!(validate_inspection_rows(&expected, &[both]), Err(Error::Stale)));
    // `automatic` must name the person it inferred.
    let mut unnamed = row_in_state("asset-0", "hash-0", "automatic");
    unnamed.automatic_index = None;
    assert!(matches!(validate_inspection_rows(&expected, &[unnamed]), Err(Error::Stale)));
}

#[test]
fn worker_rows_must_describe_the_requested_image_and_detector() {
    let expected = expected();
    let mut mismatched = row("asset-1", "hash-0");
    assert!(matches!(
        validate_inspection_rows(&expected, &[mismatched.clone()]),
        Err(Error::Stale)
    ));
    mismatched.asset_id = "asset-0".into();
    assert!(validate_inspection_rows(&expected, &[mismatched.clone()]).is_ok());
    mismatched.content_hash = "hash-1".into();
    assert!(matches!(
        validate_inspection_rows(&expected, &[mismatched.clone()]),
        Err(Error::Stale)
    ));
    mismatched.content_hash = "hash-0".into();
    mismatched.baseline_fingerprint = "other".into();
    assert!(matches!(
        validate_inspection_rows(&expected, &[mismatched]),
        Err(Error::Stale)
    ));
    assert!(matches!(
        validate_inspection_rows(&expected, &[]),
        Err(Error::Stale)
    ));
    assert!(matches!(
        validate_inspection_rows(
            &expected,
            &[row("asset-0", "hash-0"), row("asset-0", "hash-0")]
        ),
        Err(Error::Stale)
    ));
}

#[test]
fn degenerate_empty_or_oversized_boxes_are_rejected() {
    let expected = expected();
    for boxes in [
        vec![[0, 0, 0, 10]],
        vec![[0, 0, 10, 10], [10, 10, 5, 20]],
        vec![[0, 0, 81, 10]],
        vec![[0, 0, 10, 101]],
    ] {
        let mut invalid = row("asset-0", "hash-0");
        invalid.boxes = boxes.clone();
        assert!(
            matches!(
                validate_inspection_rows(&expected, &[invalid]),
                Err(Error::Stale)
            ),
            "{boxes:?}"
        );
    }
    // Zero detections is the `no_region` shape; a `single` report must have exactly one box.
    let mut empty = row_in_state("asset-0", "hash-0", "no_region");
    assert!(validate_inspection_rows(&expected, &[empty.clone()]).is_ok());
    empty.state = "single".into();
    empty.selected_index = Some(0);
    assert!(matches!(
        validate_inspection_rows(&expected, &[empty]),
        Err(Error::Stale)
    ));
    // More boxes than the worker can report in one image.
    let mut crowded = row("asset-0", "hash-0");
    crowded.boxes = vec![[0, 0, 1, 1]; 9];
    assert!(matches!(
        validate_inspection_rows(&expected, &[crowded]),
        Err(Error::Stale)
    ));
    for size in [(0, 100), (80, 0)] {
        let mut dimensionless = row("asset-0", "hash-0");
        dimensionless.width = size.0;
        dimensionless.height = size.1;
        assert!(matches!(
            validate_inspection_rows(&expected, &[dimensionless]),
            Err(Error::Stale)
        ));
    }
}

#[test]
fn inspection_ids_require_one_to_twenty_five_distinct_images() {
    assert!(matches!(
        validate_inspection_ids(&[]),
        Err(Error::Invalid(_))
    ));
    let many = (0..26)
        .map(|index| format!("asset-{index}"))
        .collect::<Vec<_>>();
    assert!(matches!(
        validate_inspection_ids(&many),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        validate_inspection_ids(&["asset-0".into(), "asset-0".into()]),
        Err(Error::Invalid(_))
    ));
    assert!(validate_inspection_ids(&many[..25]).is_ok());
    assert!(validate_inspection_ids(&["asset-0".into()]).is_ok());
}

#[test]
fn draft_overrides_replace_only_the_requested_images() {
    let requested = vec!["asset-0".to_string(), "asset-1".to_string()];
    let mut stored = RegionBindings::new();
    stored.insert("asset-0".into(), binding("hash-0", [0, 0, 40, 50]));
    stored.insert("asset-1".into(), binding("hash-1", [0, 0, 40, 50]));
    assert_eq!(
        merged_regions(&requested, stored.clone(), None).unwrap(),
        stored
    );
    let mut overrides = RegionBindings::new();
    overrides.insert("asset-0".into(), binding("hash-0", [40, 50, 80, 100]));
    let merged = merged_regions(&requested, stored.clone(), Some(&overrides)).unwrap();
    assert_eq!(merged["asset-0"].bounds, [40, 50, 80, 100]);
    assert_eq!(merged["asset-1"], stored["asset-1"]);
    assert!(merged_regions(&requested, stored.clone(), Some(&RegionBindings::new())).is_ok());

    let mut unexpected = RegionBindings::new();
    unexpected.insert("asset-2".into(), binding("hash-2", [0, 0, 1, 1]));
    assert!(matches!(
        merged_regions(&requested, stored.clone(), Some(&unexpected)),
        Err(Error::Invalid(_))
    ));
    // An override inside a narrower request still leaves every other stored choice alone.
    let narrower = merged_regions(&["asset-0".into()], stored.clone(), Some(&overrides)).unwrap();
    assert_eq!(narrower["asset-0"].bounds, [40, 50, 80, 100]);
    assert_eq!(narrower["asset-1"], stored["asset-1"]);
}

/// A binding may be carried for the worker to judge. Inspection passes a stale draft binding
/// through instead of rejecting the whole request, and rejects only an out-of-scope image.
#[test]
fn inspection_passes_stale_bindings_to_the_worker_and_only_checks_scope() {
    let requested = vec!["asset-0".to_string(), "asset-1".to_string()];
    let mut stored = RegionBindings::new();
    stored.insert("asset-0".into(), binding("hash-0", [0, 0, 40, 50]));

    // A saved choice whose content hash no longer matches the image, and one whose baseline
    // is from another detector. Both belong to the request, so both reach the worker.
    for stale in [
        binding("rotated-content-hash", [0, 0, 40, 50]),
        RegionBinding { content_hash: "hash-0".into(), baseline_fingerprint: "old".into(), bounds: [0, 0, 40, 50] },
        binding("hash-0", [999, 999, 1000, 1000]),
    ] {
        let mut overrides = RegionBindings::new();
        overrides.insert("asset-0".into(), stale.clone());
        let merged = merged_regions(&requested, stored.clone(), Some(&overrides)).unwrap();
        assert_eq!(
            merged["asset-0"], stale,
            "a stale binding is handed over unchanged, never rewritten"
        );
    }
    // The request itself never grows: an image outside it is still refused.
    let mut outside = RegionBindings::new();
    outside.insert("asset-2".into(), binding("hash-2", [0, 0, 1, 1]));
    assert!(matches!(
        merged_regions(&requested, stored.clone(), Some(&outside)),
        Err(Error::Invalid(_))
    ));
    // Stored selections that the request does not name stay untouched.
    let merged = merged_regions(&requested, stored.clone(), None).unwrap();
    assert_eq!(merged, stored);
}

#[test]
fn saved_region_ids_are_limited_to_the_selected_references() {
    let allowed = vec!["asset-0".to_string(), "asset-1".to_string()];
    let mut regions = RegionBindings::new();
    regions.insert("asset-1".into(), binding("hash-1", [0, 0, 10, 10]));
    assert!(validate_region_ids(&allowed, &regions).is_ok());
    assert!(validate_region_ids(&allowed, &RegionBindings::new()).is_ok());
    regions.insert("asset-2".into(), binding("hash-2", [0, 0, 10, 10]));
    assert!(matches!(
        validate_region_ids(&allowed, &regions),
        Err(Error::Invalid(_))
    ));
    let many = (0..26)
        .map(|index| (format!("asset-{index}"), binding("hash", [0, 0, 1, 1])))
        .collect::<RegionBindings>();
    assert!(matches!(
        validate_region_ids(&many.keys().cloned().collect::<Vec<_>>(), &many),
        Err(Error::Invalid(_))
    ));
}

/// A saved manual choice must survive a later settings save that carries no new override,
/// and a partial override must never clear the choices it does not name.
#[test]
fn stored_manual_regions_survive_settings_saves_that_do_not_override_them() {
    use crate::library::characters::{
        tests::Fixture, CharacterSettingsDraft, TargetDraft,
    };
    fn draft(target: &Target) -> TargetDraft {
        TargetDraft {
            id: Some(target.id.clone()),
            expected_revision: Some(target.revision),
            series_classification_id: target.series_classification_id.clone(),
            linked_classification_id: target.linked_classification_id.clone(),
            display_name: target.display_name.clone(),
            description: String::new(),
            thumbnail_asset_id: None,
            enabled: target.enabled,
        }
    }

    let f = Fixture::new();
    let target = f.ready("Persisted");
    let asset_id = f.refs[0].clone();
    let content_hash: String = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT content_hash FROM assets WHERE id=?1",
            [&asset_id],
            |row| row.get(0),
        )
        .unwrap();
    let chosen = binding(&content_hash, [0, 0, 1, 1]);
    let mut manual = RegionBindings::new();
    manual.insert(asset_id.clone(), chosen.clone());
    let saved = f
        .library
        .save_character_settings(
            CharacterSettingsDraft {
                reference_regions: manual,
                target: draft(&target),
                reference_ids: f.refs.clone(),
            },
            false,
        )
        .unwrap();
    let stored = |target: &Target| {
        target
            .usable_references()
            .find(|reference| reference.asset_id.as_deref() == Some(asset_id.as_str()))
            .and_then(|reference| reference.region.clone())
    };
    assert_eq!(stored(&saved), Some(chosen.clone()));

    // A save that carries no override at all must keep the stored manual choice.
    let kept = f
        .library
        .save_character_settings(
            CharacterSettingsDraft {
                reference_regions: RegionBindings::new(),
                target: draft(&saved),
                reference_ids: f.refs.clone(),
            },
            false,
        )
        .unwrap();
    assert_eq!(stored(&kept), Some(chosen.clone()));
    assert_eq!(
        read_regions(&f.library.connection().unwrap(), &kept.id).unwrap()[&asset_id],
        chosen,
        "an empty draft map must not clear a stored manual region"
    );

    // A partial draft override names the image it replaces and is merged in memory only.
    let mut other = RegionBindings::new();
    other.insert(
        f.refs[1].clone(),
        binding(
            &f.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT content_hash FROM assets WHERE id=?1",
                    [&f.refs[1]],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            [0, 0, 1, 1],
        ),
    );
    let merged =
        merged_regions(&f.refs, read_regions(&f.library.connection().unwrap(), &kept.id).unwrap(), Some(&other))
            .unwrap();
    assert_eq!(merged[&asset_id], chosen, "an unnamed stored choice is preserved");
    assert_eq!(merged[&f.refs[1]], other[&f.refs[1]]);
    assert_eq!(
        read_regions(&f.library.connection().unwrap(), &kept.id).unwrap().len(),
        1,
        "inspection overrides are never persisted"
    );
}
