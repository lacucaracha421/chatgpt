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
        other_characters: Vec::new(),
        taken_boxes: Vec::new(),
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
    for index in [Some(2)] {
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

/// Two characters of one series. 모모카 owns `asset-5` through a manual acceptance; 미도리
/// has no references yet. `asset-5` is 100x80 so a person box can be smaller than the frame.
fn shared_image_fixture() -> (
    crate::library::characters::tests::Fixture,
    Target,
    Target,
    String,
) {
    use crate::library::characters::{tests::Fixture, DecisionKind, DecisionRequest};
    let f = Fixture::new();
    let connection = f.library.connection().unwrap();
    connection
        .execute(
            "UPDATE assets SET width=100,height=80 WHERE id='asset-5'",
            [],
        )
        .unwrap();
    let hash: String = connection
        .query_row(
            "SELECT content_hash FROM assets WHERE id='asset-5'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    drop(connection);
    let momoka = f.ready("모모카");
    f.library
        .record_character_decisions(DecisionRequest {
            target_id: momoka.id.clone(),
            expected_fingerprint: momoka.fingerprint.clone(),
            asset_ids: vec!["asset-5".into()],
            decision: DecisionKind::Accepted,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    let momoka = f.library.get_character_target(&momoka.id).unwrap();
    let midori = f.target("미도리");
    (f, momoka, midori, hash)
}

fn shared_settings(
    target: &Target,
    reference_ids: &[&str],
    regions: RegionBindings,
) -> crate::library::characters::CharacterSettingsDraft {
    crate::library::characters::CharacterSettingsDraft {
        target: crate::library::characters::TargetDraft {
            id: Some(target.id.clone()),
            expected_revision: Some(target.revision),
            series_classification_id: target.series_classification_id.clone(),
            linked_classification_id: target.linked_classification_id.clone(),
            display_name: target.display_name.clone(),
            description: String::new(),
            thumbnail_asset_id: None,
            enabled: target.enabled,
        },
        reference_ids: reference_ids.iter().map(|id| id.to_string()).collect(),
        reference_regions: regions,
    }
}

const SHARED_HINT: &str =
    "다른 캐릭터(모모카)에 등록된 이미지입니다. 인물 영역을 지정하면 레퍼런스로 쓸 수 있습니다.";

#[test]
fn another_characters_image_is_refused_as_a_whole_image_reference_with_the_named_hint() {
    let (f, momoka, midori, hash) = shared_image_fixture();
    let error = f
        .library
        .save_character_settings(
            shared_settings(&midori, &["asset-5"], RegionBindings::new()),
            true,
        )
        .unwrap_err();
    assert_eq!(error.to_string(), format!("1번째 레퍼런스: {SHARED_HINT}"));
    // A box covering the whole frame is the whole image, whatever it is called.
    let whole = RegionBindings::from([("asset-5".to_string(), binding(&hash, [0, 0, 100, 80]))]);
    let error = f
        .library
        .save_character_settings(shared_settings(&midori, &["asset-5"], whole), true)
        .unwrap_err();
    assert_eq!(error.to_string(), format!("1번째 레퍼런스: {SHARED_HINT}"));
    // Nothing of the refused saves remains, and the owner is untouched.
    assert!(read_regions(&f.library.connection().unwrap(), &midori.id)
        .unwrap()
        .is_empty());
    assert!(f
        .library
        .get_character_target(&midori.id)
        .unwrap()
        .references
        .is_empty());
    assert_eq!(
        f.library
            .get_character_target(&momoka.id)
            .unwrap()
            .fingerprint,
        momoka.fingerprint
    );
    // Learning from a multi-character image needs the same person region.
    let midori = f.library.get_character_target(&midori.id).unwrap();
    f.library
        .record_character_decisions(crate::library::characters::DecisionRequest {
            target_id: midori.id.clone(),
            expected_fingerprint: midori.fingerprint.clone(),
            asset_ids: vec!["asset-5".into()],
            decision: crate::library::characters::DecisionKind::Accepted,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    let midori = f.library.get_character_target(&midori.id).unwrap();
    let error = f
        .library
        .add_character_learned_references(&midori.id, midori.revision, &["asset-5".into()])
        .unwrap_err();
    assert_eq!(error.to_string(), SHARED_HINT);
}

#[test]
fn region_scoped_reference_on_another_characters_image_supplies_only_the_region() {
    let (f, momoka, midori, hash) = shared_image_fixture();
    let momoka_regions_before = read_regions(&f.library.connection().unwrap(), &momoka.id).unwrap();
    let person = binding(&hash, [10, 10, 50, 70]);
    let saved = f
        .library
        .save_character_settings(
            shared_settings(
                &midori,
                &["asset-5"],
                RegionBindings::from([("asset-5".to_string(), person.clone())]),
            ),
            true,
        )
        .unwrap();
    // B36 and training read references with their region; the crop is the evidence.
    let usable = saved.usable_references().collect::<Vec<_>>();
    assert_eq!(usable.len(), 1);
    assert_eq!(usable[0].asset_id.as_deref(), Some("asset-5"));
    assert_eq!(usable[0].region.as_ref(), Some(&person));
    // S36 resolves the same reference through the same region, keyed by this target only.
    let pending = crate::library::character_shadow::Pending {
        asset_id: "asset-6".into(),
        content_hash: "unused".into(),
        relative_path: "assets/asset-6.png".into(),
        outcomes: [
            (midori.id.clone(), "none".to_string()),
            (momoka.id.clone(), "none".to_string()),
        ]
        .into(),
        native_at: "2026-10-05T00:00:00Z".into(),
    };
    let (snapshot, _) =
        crate::library::character_shadow::snapshot(&f.library.connection().unwrap(), &pending)
            .unwrap();
    let regions = snapshot["regions"].as_array().unwrap();
    assert_eq!(regions.len(), 1, "{regions:?}");
    assert_eq!(regions[0]["target_id"], json!(midori.id));
    assert_eq!(regions[0]["asset_hash"], json!(hash));
    assert_eq!(regions[0]["bounds"], json!([10, 10, 50, 70]));
    // The owner keeps its own membership, references and (absent) regions.
    let momoka_after = f.library.get_character_target(&momoka.id).unwrap();
    assert_eq!(momoka_after.fingerprint, momoka.fingerprint);
    assert_eq!(momoka_after.revision, momoka.revision);
    assert_eq!(
        read_regions(&f.library.connection().unwrap(), &momoka.id).unwrap(),
        momoka_regions_before
    );
    assert!(f
        .library
        .character_relations_for_asset("asset-5")
        .unwrap()
        .contains(&momoka.id));
    // A later save without a new override keeps the stored person and still passes.
    let kept = f
        .library
        .save_character_settings(
            shared_settings(&saved, &["asset-5"], RegionBindings::new()),
            true,
        )
        .unwrap();
    assert_eq!(kept.references[0].region.as_ref(), Some(&person));
    // Removing the reference prunes only this target's region.
    let cleared = f
        .library
        .save_character_settings(shared_settings(&kept, &[], RegionBindings::new()), true)
        .unwrap();
    assert!(cleared.usable_references().next().is_none());
    assert!(read_regions(&f.library.connection().unwrap(), &midori.id)
        .unwrap()
        .is_empty());
    assert_eq!(
        f.library
            .get_character_target(&momoka.id)
            .unwrap()
            .fingerprint,
        momoka.fingerprint
    );
}

#[test]
fn inspection_asks_for_a_person_on_images_shared_with_another_character() {
    let mut detected = row_in_state("asset-0", "hash-0", "single");
    detected.boxes = vec![[10, 10, 60, 90]];
    require_choice_for_shared(&mut detected, vec!["모모카".into()]);
    assert_eq!(detected.state, "needs_region");
    assert_eq!(
        (detected.selected_index, detected.suggested_index),
        (None, Some(0))
    );
    assert_eq!(detected.other_characters, vec!["모모카".to_string()]);
    let mut inferred = row_in_state("asset-0", "hash-0", "automatic");
    require_choice_for_shared(&mut inferred, vec!["모모카".into()]);
    assert_eq!(inferred.state, "needs_region");
    assert_eq!(
        (inferred.automatic_index, inferred.suggested_index),
        (None, Some(1))
    );
    // An explicit person, or an image nobody else owns, is left as the worker reported it.
    let mut chosen = row_in_state("asset-0", "hash-0", "selected");
    require_choice_for_shared(&mut chosen, vec!["모모카".into()]);
    assert_eq!(
        (chosen.state.as_str(), chosen.selected_index),
        ("selected", Some(1))
    );
    let mut own = row_in_state("asset-0", "hash-0", "single");
    require_choice_for_shared(&mut own, Vec::new());
    assert_eq!(own.state, "single");
    assert!(serde_json::to_value(&own)
        .unwrap()
        .get("otherCharacters")
        .is_none());
}

/// 다이아린 · 자오 case: a character already holds images another character owns (saved
/// before the shared-image rule, so without a person). Choosing a person for each of them
/// and saving makes them usable references; one unresolved image still blocks the save.
#[test]
fn choosing_a_person_on_every_shared_reference_makes_the_save_pass() {
    let (f, _momoka, midori, _hash) = shared_image_fixture();
    let connection = f.library.connection().unwrap();
    connection
        .execute("UPDATE assets SET width=100,height=80 WHERE id IN ('asset-0','asset-1','asset-5')", [])
        .unwrap();
    let hash_of = |id: &str| -> String {
        connection
            .query_row("SELECT content_hash FROM assets WHERE id=?1", [id], |r| r.get(0))
            .unwrap()
    };
    let (h0, h1) = (hash_of("asset-0"), hash_of("asset-1"));
    drop(connection);
    // The lenient path predates the rule: these references carry no person.
    let legacy = f
        .library
        .replace_character_references_selection(
            &midori.id,
            midori.revision,
            &["asset-0".to_string(), "asset-1".to_string()],
            false,
        )
        .unwrap();
    // Only one person chosen: the other shared image still has none.
    let error = f
        .library
        .save_character_settings(
            shared_settings(
                &legacy,
                &["asset-0", "asset-1"],
                RegionBindings::from([("asset-0".to_string(), binding(&h0, [50, 10, 90, 70]))]),
            ),
            true,
        )
        .unwrap_err();
    assert!(error.to_string().starts_with("2번째 레퍼런스: 다른 캐릭터(모모카)에 등록된 이미지입니다."));
    let legacy = f.library.get_character_target(&midori.id).unwrap();
    // A person chosen on both: both are saved and counted as usable.
    let saved = f
        .library
        .save_character_settings(
            shared_settings(
                &legacy,
                &["asset-0", "asset-1"],
                RegionBindings::from([
                    ("asset-0".to_string(), binding(&h0, [50, 10, 90, 70])),
                    ("asset-1".to_string(), binding(&h1, [50, 10, 90, 70])),
                ]),
            ),
            true,
        )
        .unwrap();
    assert_eq!(saved.usable_references().count(), 2);
}

/// The 다이아린 · 자오 shape (asset 6729c4fa): a 1482x2048 frame whose detection list ends
/// with the whole frame, which the worker suggested.
fn whole_frame_row(others: &[&str]) -> (ReferenceInspection, Vec<String>) {
    let mut row = row_in_state("asset-0", "hash-0", "needs_region");
    row.width = 1482;
    row.height = 2048;
    row.boxes = vec![[1014, 55, 1470, 972], [0, 0, 1482, 2048]];
    row.suggested_index = Some(1);
    (row, others.iter().map(|name| name.to_string()).collect())
}

#[test]
fn a_shared_image_never_offers_or_suggests_the_whole_frame() {
    let (mut row, others) = whole_frame_row(&["자오"]);
    require_choice_for_shared(&mut row, others);
    assert_eq!(row.state, "needs_region", "the person must still choose");
    assert_eq!(row.boxes, vec![[1014, 55, 1470, 972]]);
    assert_eq!((row.suggested_index, row.selected_index, row.automatic_index), (None, None, None));
    assert_eq!(row.other_characters, vec!["자오".to_string()]);
    // The save rule and the inspection agree on what the whole frame is, in both orientations.
    assert!(is_whole_frame([0, 0, 1482, 2048], 1482, 2048));
    assert!(is_whole_frame([0, 0, 2048, 1482], 1482, 2048));
    assert!(!is_whole_frame([0, 0, 1482, 2047], 1482, 2048));
}

#[test]
fn removing_whole_frame_boxes_keeps_every_index_on_its_own_box() {
    let mut row = row_in_state("asset-0", "hash-0", "needs_region");
    row.boxes = vec![[0, 0, 80, 100], [0, 0, 40, 50], [40, 50, 80, 100]];
    row.suggested_index = Some(2);
    require_choice_for_shared(&mut row, vec!["모모카".into()]);
    assert_eq!(row.boxes, vec![[0, 0, 40, 50], [40, 50, 80, 100]]);
    assert_eq!(row.suggested_index, Some(1));
    // A draft that chose the whole frame is no choice for a shared image.
    let mut drafted = row_in_state("asset-0", "hash-0", "selected");
    drafted.boxes = vec![[0, 0, 40, 50], [0, 0, 80, 100]];
    drafted.selected_index = Some(1);
    require_choice_for_shared(&mut drafted, vec!["모모카".into()]);
    assert_eq!((drafted.state.as_str(), drafted.selected_index), ("needs_region", None));
    assert_eq!(drafted.boxes, vec![[0, 0, 40, 50]]);
    // A person the user chose among real boxes keeps pointing at the same box.
    let mut chosen = row_in_state("asset-0", "hash-0", "selected");
    chosen.boxes = vec![[0, 0, 80, 100], [0, 0, 40, 50], [40, 50, 80, 100]];
    chosen.selected_index = Some(2);
    require_choice_for_shared(&mut chosen, vec!["모모카".into()]);
    assert_eq!((chosen.state.as_str(), chosen.selected_index), ("selected", Some(1)));
    // Nothing but the whole frame leaves no person to choose.
    let mut only = row_in_state("asset-0", "hash-0", "single");
    only.boxes = vec![[0, 0, 80, 100]];
    require_choice_for_shared(&mut only, vec!["모모카".into()]);
    assert_eq!((only.state.as_str(), only.boxes.len(), only.suggested_index), ("no_region", 0, None));
}

#[test]
fn an_unshared_image_keeps_its_boxes_but_is_not_told_to_use_the_whole_frame() {
    let (mut row, others) = whole_frame_row(&[]);
    require_choice_for_shared(&mut row, others);
    assert_eq!(row.boxes.len(), 2, "whole-frame use stays legal for an image nobody else owns");
    assert_eq!(row.suggested_index, None);
}

#[test]
fn the_slot_of_the_reference_still_missing_a_person_is_named_and_a_real_person_passes() {
    let (f, _momoka, midori, hash) = shared_image_fixture();
    let connection = f.library.connection().unwrap();
    connection.execute("UPDATE assets SET width=100,height=80 WHERE id='asset-0'", []).unwrap();
    let h0: String = connection
        .query_row("SELECT content_hash FROM assets WHERE id='asset-0'", [], |r| r.get(0))
        .unwrap();
    drop(connection);
    let ids = ["asset-5", "asset-0"];
    // The first reference has its person; the second only the whole frame.
    let whole = RegionBindings::from([
        ("asset-5".to_string(), binding(&hash, [10, 10, 50, 70])),
        ("asset-0".to_string(), binding(&h0, [0, 0, 100, 80])),
    ]);
    let error = f.library.save_character_settings(shared_settings(&midori, &ids, whole), true).unwrap_err();
    assert_eq!(error.to_string(), format!("2번째 레퍼런스: {SHARED_HINT}"));
    assert!(read_regions(&f.library.connection().unwrap(), &midori.id).unwrap().is_empty(), "the refused save is rolled back");
    let person = RegionBindings::from([
        ("asset-5".to_string(), binding(&hash, [10, 10, 50, 70])),
        ("asset-0".to_string(), binding(&h0, [50, 10, 90, 70])),
    ]);
    let saved = f.library.save_character_settings(shared_settings(&midori, &ids, person), true).unwrap();
    assert_eq!(saved.usable_references().count(), 2);
}

/// A recommendation the review showed for one character on one image (what a person looking
/// at the single view accepted), stored the way the automatic scan stores it.
fn recommend(f: &crate::library::characters::tests::Fixture, target: &Target, asset: &str, evidence: Value) {
    let connection = f.library.connection().unwrap();
    let hash: String = connection
        .query_row("SELECT content_hash FROM assets WHERE id=?1", [asset], |r| r.get(0))
        .unwrap();
    let id = format!("evidence-{}-{asset}", target.id);
    connection
        .execute(
            "INSERT OR IGNORE INTO character_autotag_evidence(id,asset_id,generation,source_generation,content_hash,context_hash,runtime_fingerprint,scope_json,unresolved_regions,created_at)
             VALUES(?1,?2,1,1,?3,'c','r','{}','[]','2026')",
            params![id, asset, hash],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO character_autotag_predictions(evidence_id,target_id,series_id,target_fingerprint,result_json) VALUES(?1,?2,?3,?4,?5)",
            params![
                id,
                target.id,
                f.series,
                target.fingerprint,
                json!({"assetId":asset,"contentHash":hash,"state":"recommended","evidence":evidence}).to_string()
            ],
        )
        .unwrap();
}

fn two_people(best: usize) -> Value {
    json!({"passed":true,"wholeFallback":false,"bestQueryCrop":best,"distance":0.1,
        "queryBoxes":[[10,10,50,70],[50,10,90,70]]})
}

fn choose(f: &crate::library::characters::tests::Fixture, target: &Target, hash: &str, bounds: [u32; 4]) -> Result<()> {
    crate::library::character_hub::validate_character_selection_with_region(
        &f.library.connection().unwrap(),
        &f.series,
        Some(&target.id),
        "asset-5",
        Some(&binding(hash, bounds)),
    )
}

fn clear_recommendations(f: &crate::library::characters::tests::Fixture) {
    let connection = f.library.connection().unwrap();
    connection.execute("DELETE FROM character_autotag_predictions", []).unwrap();
    connection.execute("DELETE FROM character_autotag_evidence", []).unwrap();
}

#[test]
fn a_person_another_character_is_registered_on_cannot_be_chosen_but_the_others_can() {
    let (f, momoka, midori, hash) = shared_image_fixture();
    // No box is known for 모모카 on this image: today's behaviour, any person is allowed.
    assert!(known_people_of_others(
        &f.library.connection().unwrap(),
        Some(&midori.id),
        "asset-5"
    )
    .unwrap()
    .is_empty());
    assert!(choose(&f, &midori, &hash, [10, 10, 50, 70]).is_ok());
    assert!(choose(&f, &midori, &hash, [50, 10, 90, 70]).is_ok());
    // The review showed 모모카 her first person and she was accepted.
    recommend(&f, &momoka, "asset-5", two_people(0));
    let people = known_people_of_others(
        &f.library.connection().unwrap(),
        Some(&midori.id),
        "asset-5",
    )
    .unwrap();
    assert_eq!(
        people,
        vec![KnownPerson {
            character: "모모카".into(),
            target_id: momoka.id.clone(),
            source: "accepted".into(),
            bounds: [10.0, 10.0, 50.0, 70.0]
        }]
    );
    // The owner herself is never blocked by her own person.
    assert!(known_people_of_others(
        &f.library.connection().unwrap(),
        Some(&momoka.id),
        "asset-5"
    )
    .unwrap()
    .is_empty());
    // The same person, or one that overlaps it enough, is refused with the owner name.
    for bounds in [[10, 10, 50, 70], [12, 10, 50, 70]] {
        let error = choose(&f, &midori, &hash, bounds).unwrap_err();
        assert_eq!(
            error.to_string(),
            "이 인물은 모모카로 등록돼 있어요. 다른 인물을 골라 주세요."
        );
    }
    // The other person, and a box that only touches the first one, pass.
    assert!(choose(&f, &midori, &hash, [50, 10, 90, 70]).is_ok());
    assert!(choose(&f, &midori, &hash, [40, 10, 90, 70]).is_ok());
    // A settings save names the slot and keeps nothing of the refused choice.
    let error = f
        .library
        .save_character_settings(
            shared_settings(
                &midori,
                &["asset-5"],
                RegionBindings::from([("asset-5".to_string(), binding(&hash, [10, 10, 50, 70]))]),
            ),
            true,
        )
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "1번째 레퍼런스: 이 인물은 모모카로 등록돼 있어요. 다른 인물을 골라 주세요."
    );
    assert!(read_regions(&f.library.connection().unwrap(), &midori.id)
        .unwrap()
        .is_empty());
    f.library
        .save_character_settings(
            shared_settings(
                &midori,
                &["asset-5"],
                RegionBindings::from([("asset-5".to_string(), binding(&hash, [50, 10, 90, 70]))]),
            ),
            true,
        )
        .unwrap();
}

#[test]
fn a_membership_only_acceptance_or_an_unpassed_recommendation_registers_no_person() {
    let (f, momoka, midori, hash) = shared_image_fixture();
    // A recommendation that did not pass, and one over the whole image, name nobody.
    let mut unpassed = two_people(0);
    unpassed["passed"] = json!(false);
    recommend(&f, &momoka, "asset-5", unpassed);
    assert!(choose(&f, &midori, &hash, [10, 10, 50, 70]).is_ok());
    clear_recommendations(&f);
    recommend(
        &f,
        &momoka,
        "asset-5",
        json!({"passed":true,"wholeFallback":true,"bestQueryCrop":0,"queryBoxes":[[0,0,100,80]]}),
    );
    assert!(choose(&f, &midori, &hash, [10, 10, 50, 70]).is_ok());
    // 맞음 · 위치 틀림 states that the shown box was wrong: it records nothing about a person.
    clear_recommendations(&f);
    recommend(&f, &momoka, "asset-5", two_people(0));
    assert!(choose(&f, &midori, &hash, [10, 10, 50, 70]).is_err());
    let momoka = f.library.get_character_target(&momoka.id).unwrap();
    f.library
        .record_character_decisions(crate::library::characters::DecisionRequest {
            target_id: momoka.id.clone(),
            expected_fingerprint: momoka.fingerprint.clone(),
            asset_ids: vec!["asset-5".into()],
            decision: crate::library::characters::DecisionKind::AcceptedWrongRegion,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    assert!(known_people_of_others(&f.library.connection().unwrap(), Some(&midori.id), "asset-5")
        .unwrap()
        .is_empty());
    assert!(choose(&f, &midori, &hash, [10, 10, 50, 70]).is_ok());
}

#[test]
fn a_recorded_decision_crop_an_s36_crop_index_and_an_own_reference_region_each_name_a_person() {
    let (f, momoka, midori, hash) = shared_image_fixture();
    let set_snapshot = |snapshot: Value| {
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE character_decisions SET reference_snapshot=?1 WHERE target_id=?2 AND source_asset_id='asset-5'",
                params![snapshot.to_string(), momoka.id],
            )
            .unwrap();
    };
    let people = || {
        known_people_of_others(
            &f.library.connection().unwrap(),
            Some(&midori.id),
            "asset-5",
        )
        .unwrap()
    };
    // A B36 acceptance stores the crop it was made on.
    set_snapshot(json!({"prediction": two_people(1), "references": []}));
    assert_eq!(people()[0].bounds, [50.0, 10.0, 90.0, 70.0]);
    // An S36 acceptance stores only the index; the image detector boxes resolve it lazily.
    set_snapshot(json!({"prediction":{"engine":"s36","queryCrop":0},"references":[]}));
    assert!(people().is_empty(), "no detector boxes known yet");
    recommend(&f, &midori, "asset-5", two_people(1));
    assert_eq!(people()[0].bounds, [10.0, 10.0, 50.0, 70.0]);
    // The character own reference region on the image is its person too (not whole frame).
    f.library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO character_reference_regions(target_id,asset_id,asset_hash,baseline_fingerprint,bounds_json) VALUES(?1,'asset-5',?2,?3,?4)",
            params![momoka.id, hash, BASELINE, "[50,10,90,70]"],
        )
        .unwrap();
    let people = people();
    assert_eq!(
        people,
        vec![
            KnownPerson {
                character: "모모카".into(),
                target_id: momoka.id.clone(),
                source: "reference".into(),
                bounds: [50.0, 10.0, 90.0, 70.0]
            },
            KnownPerson {
                character: "모모카".into(),
                target_id: momoka.id.clone(),
                source: "accepted".into(),
                bounds: [10.0, 10.0, 50.0, 70.0]
            },
        ]
    );
    let mut row = row_in_state("asset-5", &hash, "needs_region");
    row.boxes = vec![[50, 10, 90, 70], [10, 10, 50, 70]];
    mark_taken_boxes(&mut row, &people);
    let serialized = serde_json::to_value(&row).unwrap();
    assert_eq!(
        serialized["takenBoxes"],
        json!([
            {"index": 0, "character": "모모카", "targetId": momoka.id, "source": "reference"},
            {"index": 1, "character": "모모카", "targetId": momoka.id, "source": "accepted"},
        ])
    );
}

#[test]
fn the_inspection_marks_a_taken_box_and_never_suggests_or_keeps_it_chosen() {
    let people = [KnownPerson {
        character: "자오".into(),
        target_id: "zhao".into(),
        source: "accepted".into(),
        bounds: [10.0, 10.0, 50.0, 70.0],
    }];
    let mut row = row_in_state("asset-0", "hash-0", "needs_region");
    row.boxes = vec![[10, 10, 50, 70], [50, 10, 90, 70]];
    row.suggested_index = Some(0);
    mark_taken_boxes(&mut row, &people);
    assert_eq!(
        row.taken_boxes,
        vec![TakenBox {
            index: 0,
            character: "자오".into(),
            target_id: "zhao".into(),
            source: "accepted".into()
        }]
    );
    assert_eq!(
        (row.suggested_index, row.state.as_str()),
        (None, "needs_region")
    );
    // A chosen person that turns out to be taken is no choice any more.
    let mut chosen = row_in_state("asset-0", "hash-0", "selected");
    chosen.boxes = vec![[11, 10, 50, 70], [50, 10, 90, 70]];
    chosen.selected_index = Some(0);
    mark_taken_boxes(&mut chosen, &people);
    assert_eq!(
        (chosen.selected_index, chosen.state.as_str()),
        (None, "needs_region")
    );
    // Someone else person is left alone.
    let mut other = row_in_state("asset-0", "hash-0", "selected");
    other.boxes = vec![[10, 10, 50, 70], [50, 10, 90, 70]];
    other.selected_index = Some(1);
    mark_taken_boxes(&mut other, &people);
    assert_eq!(
        (other.selected_index, other.state.as_str()),
        (Some(1), "selected")
    );
    assert_eq!(
        serde_json::to_value(&other).unwrap()["takenBoxes"][0]["character"],
        json!("자오")
    );
    let mut none = row_in_state("asset-0", "hash-0", "single");
    mark_taken_boxes(&mut none, &[]);
    assert!(serde_json::to_value(&none)
        .unwrap()
        .get("takenBoxes")
        .is_none());
}

#[test]
fn the_particle_after_a_character_name_follows_its_last_syllable() {
    assert_eq!(with_ro("자오"), "자오로");
    assert_eq!(with_ro("다이아린"), "다이아린으로");
    assert_eq!(with_ro("모모카"), "모모카로");
    assert_eq!(with_ro("아델"), "아델로");
    assert_eq!(with_ro("Zoe"), "Zoe로");
}
