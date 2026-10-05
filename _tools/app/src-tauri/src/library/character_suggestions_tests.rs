use super::*;
use crate::library::characters::tests::Fixture;

fn fixture() -> Fixture {
    let f = Fixture::new();
    let c = f.library.connection().unwrap();
    c.execute(
        "INSERT INTO character_series(classification_id) VALUES(?1)",
        [&f.series],
    )
    .unwrap();
    for source in ["pixai", "canary"] {
        c.execute(
            "INSERT INTO tagger_character_vocabulary VALUES(?1,'new_character')",
            [source],
        )
        .unwrap();
        for n in 0..7 {
            let id = format!("asset-{n}");
            c.execute(
                "INSERT INTO asset_tagger_coverage VALUES(?1,?2)",
                params![id, source],
            )
            .unwrap();
            c.execute(
                "INSERT INTO asset_tagger_character_scores VALUES(?1,?2,'new_character',?3)",
                params![
                    id,
                    source,
                    if source == "pixai" {
                        0.99 - n as f64 * 0.01
                    } else {
                        0.9
                    }
                ],
            )
            .unwrap();
        }
    }
    drop(c);
    f
}

fn request(f: &Fixture) -> RegisterSuggestion {
    let detail = f
        .library
        .character_suggestion_detail("new_character", Some(&f.series))
        .unwrap();
    RegisterSuggestion {
        tag: "new_character".into(),
        series_id: f.series.clone(),
        display_name: "새 캐릭터".into(),
        preview_token: detail.preview_token,
        reference_ids: detail.reference_ids,
        excluded_asset_ids: vec![],
        include_outside: true,
        link_tag: true,
        group_id: None,
        expected_group_revision: None,
    }
}

#[test]
fn suggestion_threshold_counts_each_image_once_and_marks_one_tagger() {
    let f = fixture();
    let c = f.library.connection().unwrap();
    c.execute(
        "UPDATE asset_tagger_character_scores SET score=0.849 WHERE asset_id='asset-0'",
        [],
    )
    .unwrap();
    c.execute("UPDATE asset_tagger_character_scores SET score=0.85 WHERE asset_id='asset-1' AND source='pixai'", []).unwrap();
    c.execute(
        "UPDATE asset_tagger_character_scores SET score=0.1 WHERE source='canary'",
        [],
    )
    .unwrap();
    drop(c);
    let rows = f.library.character_suggestions(None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (
            rows[0].image_count,
            rows[0].both_count,
            rows[0].pixai_count,
            rows[0].canary_count
        ),
        (6, 0, 6, 0)
    );
    assert!(f.library.character_suggestions(Some(7)).unwrap().is_empty());
    f.library
        .trash_assets(&["asset-2".into(), "asset-3".into()])
        .unwrap();
    assert!(f.library.character_suggestions(None).unwrap().is_empty());
    assert_eq!(f.library.character_suggestions(Some(4)).unwrap().len(), 1);
}

#[test]
fn suggestion_series_uses_descendants_and_largest_count_or_none() {
    let f = fixture();
    let c = f.library.connection().unwrap();
    c.execute(
        "INSERT INTO character_series(classification_id) VALUES(?1)",
        [&f.outside],
    )
    .unwrap();
    drop(c);
    let rows = f.library.character_suggestions(None).unwrap();
    assert_eq!(rows[0].series_id.as_ref(), Some(&f.series));
    assert_eq!((rows[0].inside_count, rows[0].both_count), (6, 7));
    f.library
        .connection()
        .unwrap()
        .execute("DELETE FROM character_series", [])
        .unwrap();
    assert!(f.library.character_suggestions(None).unwrap()[0]
        .series_id
        .is_none());
}

#[test]
fn suggestion_ignoring_is_persistent_and_undo_restores_it() {
    let f = fixture();
    f.library
        .set_character_suggestion_ignored("new_character", true)
        .unwrap();
    f.library
        .set_character_suggestion_ignored("new_character", true)
        .unwrap();
    assert!(f.library.character_suggestions(None).unwrap().is_empty());
    let ignored = f.library.ignored_character_suggestions().unwrap();
    assert_eq!(ignored.len(), 1);
    assert_eq!(ignored[0].tag, "new_character");
    assert!(!ignored[0].ignored_at.is_empty());
    assert!(matches!(
        f.library
            .register_character_suggestion(request_before_ignore(&f)),
        Err(Error::Stale)
    ));
    f.library
        .set_character_suggestion_ignored("new_character", false)
        .unwrap();
    assert_eq!(f.library.character_suggestions(None).unwrap().len(), 1);
    assert!(f
        .library
        .ignored_character_suggestions()
        .unwrap()
        .is_empty());
}

fn request_before_ignore(f: &Fixture) -> RegisterSuggestion {
    RegisterSuggestion {
        tag: "new_character".into(),
        series_id: f.series.clone(),
        display_name: "Ignored".into(),
        preview_token: "old".into(),
        reference_ids: vec![],
        excluded_asset_ids: vec![],
        include_outside: true,
        link_tag: true,
        group_id: None,
        expected_group_revision: None,
    }
}

#[test]
fn suggestion_registration_preselects_inside_and_queues_rest_without_decisions() {
    let f = fixture();
    let draft = request(&f);
    assert_eq!(draft.reference_ids, f.refs);
    let result = f.library.register_character_suggestion(draft).unwrap();
    assert!(result.target.ready);
    assert_eq!(result.queued_count, 2);
    assert!(f.library.character_suggestions(None).unwrap().is_empty());
    let c = f.library.connection().unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM character_decisions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM character_relations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM character_tagger_pending WHERE reason='recommendation'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    drop(c);
    assert_eq!(f.library.tagger_review_items().unwrap().len(), 2);
}

#[test]
fn suggestion_registration_rejects_outside_references_and_rolls_back() {
    let f = fixture();
    let mut draft = request(&f);
    draft.reference_ids = vec!["asset-6".into()];
    assert!(f.library.register_character_suggestion(draft).is_err());
    assert!(f.library.list_character_targets().unwrap().is_empty());
    let mut draft = request(&f);
    draft.group_id = Some("missing".into());
    assert!(f.library.register_character_suggestion(draft).is_err());
    assert!(f.library.list_character_targets().unwrap().is_empty());
    assert!(f.library.tagger_review_items().unwrap().is_empty());
}

#[test]
fn suggestion_registration_allows_manual_selection_exclusion_and_unlinked_tag() {
    let f = fixture();
    let mut draft = request(&f);
    draft.reference_ids.truncate(2);
    draft.include_outside = false;
    draft.excluded_asset_ids = vec!["asset-5".into()];
    draft.link_tag = false;
    let result = f.library.register_character_suggestion(draft).unwrap();
    assert!(result.target.manual_only);
    assert_eq!(result.queued_count, 3);
    assert_eq!(f.library.character_suggestions(None).unwrap().len(), 1);
}

#[test]
fn suggestion_registration_checks_changed_evidence_and_missing_reference_file() {
    let f = fixture();
    let draft = request(&f);
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE asset_tagger_character_scores SET score=0.5 WHERE asset_id='asset-5'",
            [],
        )
        .unwrap();
    assert!(matches!(
        f.library.register_character_suggestion(draft),
        Err(Error::Stale)
    ));
    let draft = request(&f);
    std::fs::remove_file(f.temp.path().join("assets/asset-0.png")).unwrap();
    assert!(f.library.register_character_suggestion(draft).is_err());
    assert!(f.library.list_character_targets().unwrap().is_empty());
}

#[test]
fn suggestion_merge_links_without_overwriting_existing_references_or_decisions() {
    let f = fixture();
    let target = f.ready("Existing");
    let detail = f
        .library
        .character_suggestion_detail("new_character", Some(&f.series))
        .unwrap();
    let result = f
        .library
        .merge_character_suggestion(MergeSuggestion {
            tag: "new_character".into(),
            target_id: target.id.clone(),
            expected_fingerprint: target.fingerprint.clone(),
            preview_token: detail.preview_token,
            link_tag: true,
        })
        .unwrap();
    assert_eq!(result.queued_count, 2);
    assert_eq!(result.target.fingerprint, target.fingerprint);
    assert!(f.library.character_suggestions(None).unwrap().is_empty());
    assert_eq!(
        f.library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM character_decisions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn suggestion_merge_rejects_stale_target_and_preserves_manual_decisions() {
    let f = fixture();
    let target = f.target("Existing");
    let detail = f
        .library
        .character_suggestion_detail("new_character", Some(&f.series))
        .unwrap();
    let make = |fingerprint: String| MergeSuggestion {
        tag: "new_character".into(),
        target_id: target.id.clone(),
        expected_fingerprint: fingerprint,
        preview_token: detail.preview_token.clone(),
        link_tag: true,
    };
    assert!(matches!(
        f.library.merge_character_suggestion(make("stale".into())),
        Err(Error::Stale)
    ));
    f.library
        .record_character_decisions(super::super::characters::DecisionRequest {
            target_id: target.id.clone(),
            expected_fingerprint: target.fingerprint.clone(),
            asset_ids: vec!["asset-5".into()],
            decision: super::super::characters::DecisionKind::Rejected,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    let current = f.library.get_character_target(&target.id).unwrap();
    let result = f
        .library
        .merge_character_suggestion(make(current.fingerprint))
        .unwrap();
    assert_eq!(result.queued_count, 6);
    assert_eq!(
        f.library
            .connection()
            .unwrap()
            .query_row("SELECT decision FROM character_decisions", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "rejected"
    );
}

#[test]
fn suggestion_solo_preselection_respects_effective_tags_and_score_order() {
    let f = fixture();
    let before = request(&f);
    let c = f.library.connection().unwrap();
    c.execute(
        "INSERT INTO auto_tag_vocabulary VALUES('solo','general')",
        [],
    )
    .unwrap();
    for id in ["asset-0", "asset-4", "asset-6"] {
        c.execute("INSERT INTO asset_auto_tags VALUES(?1,'solo',0.9)", [id])
            .unwrap();
    }
    c.execute(
        "INSERT INTO asset_auto_tag_edits VALUES('asset-0','solo','removed','now')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO asset_auto_tag_edits VALUES('asset-5','solo','added','now')",
        [],
    )
    .unwrap();
    let detail = detail_in(&c, "new_character", Some(&f.series)).unwrap();
    assert_eq!(
        detail.reference_ids,
        ["asset-4", "asset-5", "asset-0", "asset-1", "asset-2"]
    );
    assert_eq!(
        detail
            .images
            .iter()
            .filter(|i| i.solo)
            .map(|i| i.asset_id.as_str())
            .collect::<Vec<_>>(),
        ["asset-4", "asset-5", "asset-6"]
    );
    assert_ne!(detail.preview_token, before.preview_token);
    drop(c);
    assert!(matches!(
        f.library.register_character_suggestion(before),
        Err(Error::Stale)
    ));
}

#[test]
fn suggestion_registration_enqueues_series_with_current_target_and_skips_manual_only() {
    for manual in [false, true] {
        let f = fixture();
        let mut draft = request(&f);
        if manual {
            draft.reference_ids.truncate(2);
        }
        let result = f.library.register_character_suggestion(draft).unwrap();
        let c = f.library.connection().unwrap();
        let jobs = c.prepare("SELECT asset_id FROM character_autotag_jobs WHERE state='pending' ORDER BY asset_id").unwrap()
            .query_map([], |r| r.get::<_, String>(0)).unwrap().collect::<std::result::Result<Vec<_>, _>>().unwrap();
        assert_eq!(
            jobs,
            if manual {
                vec![]
            } else {
                vec!["asset-5".to_string()]
            }
        );
        if !manual {
            drop(c);
            let job = f.library.claim_character_autotag().unwrap().unwrap();
            let context = f
                .library
                .character_autotag_context(&f.library.connection().unwrap(), &job, &"a".repeat(64))
                .unwrap();
            assert!(context.targets.iter().any(|t| t.id == result.target.id));
        }
    }
}

#[test]
fn suggestion_samples_carry_their_thumbnail_revisions() {
    let f = fixture();
    let rows = f.library.character_suggestions(None).unwrap();
    let row = &rows[0];
    assert_eq!(row.sample_asset_ids.len(), 4);
    assert_eq!(row.sample_thumbnail_revisions.len(), 4);
    for id in &row.sample_asset_ids {
        assert_eq!(
            row.sample_thumbnail_revisions.get(id),
            Some(&crate::library::models::thumbnail_revision(&format!(
                "thumbnails/{id}.webp"
            )))
        );
    }
    let json = serde_json::to_value(row).unwrap();
    assert!(json["sampleThumbnailRevisions"].is_object());
}
