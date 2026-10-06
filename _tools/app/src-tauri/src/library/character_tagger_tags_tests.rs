use super::*;
use crate::library::characters::tests::Fixture;

#[test]
fn tagger_unlink_rolls_back_when_persisting_the_exclusion_fails() {
    let f = Fixture::new();
    let target = f.ready("A");
    let c = f.library.connection().unwrap();
    explicitly_link(&c, &target.id, "wrong").unwrap();
    candidate(&c, &target.id, "asset-5", "recommendation");
    c.execute_batch("CREATE TRIGGER fail_exclusion BEFORE INSERT ON character_target_tagger_tag_exclusions BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    drop(c);
    assert!(f.library.unlink_character_tagger_tag(&target.id, "wrong", 1).is_err());
    let links = f.library.character_tagger_tags(&target.id).unwrap();
    assert_eq!(links.linked[0].tag, "wrong");
    assert_eq!(links.linked[0].pending_recommendations, 1);
    assert!(links.excluded.is_empty());
}

#[test]
fn tagger_unlink_keeps_single_model_evidence_from_another_link() {
    let f = Fixture::new();
    let target = f.ready("A");
    let c = f.library.connection().unwrap();
    explicitly_link(&c, &target.id, "wrong").unwrap();
    explicitly_link(&c, &target.id, "right").unwrap();
    evidence(&c, "asset-5", "pixai", "wrong");
    evidence(&c, "asset-5", "canary", "right");
    candidate(&c, &target.id, "asset-5", "recommendation");
    drop(c);
    assert_eq!(f.library.character_tagger_tags(&target.id).unwrap().linked.iter().find(|t| t.tag == "wrong").unwrap().pending_recommendations, 0);
    f.library.unlink_character_tagger_tag(&target.id, "wrong", 0).unwrap();
    assert_eq!(f.library.connection().unwrap().query_row("SELECT COUNT(*) FROM character_tagger_candidates", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}

fn evidence(c: &Connection, asset: &str, source: &str, tag: &str) {
    c.execute(
        "INSERT OR IGNORE INTO tagger_character_vocabulary VALUES(?1,?2)",
        params![source, tag],
    )
    .unwrap();
    c.execute(
        "INSERT OR IGNORE INTO asset_tagger_coverage VALUES(?1,?2)",
        params![asset, source],
    )
    .unwrap();
    c.execute(
        "INSERT INTO asset_tagger_character_scores VALUES(?1,?2,?3,0.9)",
        params![asset, source, tag],
    )
    .unwrap();
}

fn candidate(c: &Connection, target: &str, asset: &str, reason: &str) {
    c.execute("INSERT INTO character_tagger_candidates SELECT ?1,id,content_hash,?3,0.9,0.9,'now' FROM assets WHERE id=?2", params![target, asset, reason]).unwrap();
}

#[test]
fn tagger_unlink_preserves_other_tag_evidence_and_targets_and_relinks() {
    let f = Fixture::new();
    let target = f.ready("A");
    let other = f.ready("B");
    let c = f.library.connection().unwrap();
    for (id, tag) in [
        (&target.id, "wrong"),
        (&target.id, "right"),
        (&other.id, "wrong"),
    ] {
        explicitly_link(&c, id, tag).unwrap();
    }
    for source in ["pixai", "canary"] {
        evidence(&c, "asset-5", source, "wrong");
        evidence(&c, "asset-6", source, "wrong");
        evidence(&c, "asset-6", source, "right");
    }
    candidate(&c, &target.id, "asset-5", "recommendation");
    candidate(&c, &target.id, "asset-6", "recommendation");
    candidate(&c, &target.id, "asset-4", "veto");
    candidate(&c, &other.id, "asset-5", "recommendation");
    let before: i64 = c
        .query_row(
            "SELECT generation FROM mobile_publication_state WHERE kind='characters'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    drop(c);
    let links = f.library.character_tagger_tags(&target.id).unwrap();
    assert_eq!(
        links
            .linked
            .iter()
            .find(|t| t.tag == "wrong")
            .unwrap()
            .pending_recommendations,
        1
    );
    assert!(matches!(
        f.library
            .unlink_character_tagger_tag(&target.id, "wrong", 0),
        Err(Error::Stale)
    ));
    assert_eq!(
        f.library
            .character_tagger_tags(&target.id)
            .unwrap()
            .linked
            .len(),
        2
    );
    f.library
        .unlink_character_tagger_tag(&target.id, "wrong", 1)
        .unwrap();
    let links = f.library.character_tagger_tags(&target.id).unwrap();
    assert_eq!(links.linked[0].tag, "right");
    assert_eq!(links.excluded, ["wrong"]);
    let c = f.library.connection().unwrap();
    let remaining = c.prepare("SELECT asset_id,reason FROM character_tagger_candidates WHERE target_id=?1 ORDER BY asset_id").unwrap()
        .query_map([&target.id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).unwrap()
        .collect::<std::result::Result<Vec<_>, _>>().unwrap();
    assert_eq!(
        remaining,
        [
            ("asset-4".into(), "veto".into()),
            ("asset-6".into(), "recommendation".into())
        ]
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM character_tagger_candidates WHERE target_id=?1",
            [&other.id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert!(
        c.query_row(
            "SELECT generation FROM mobile_publication_state WHERE kind='characters'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap()
            > before
    );
    drop(c);
    f.library
        .relink_character_tagger_tag(&target.id, "wrong")
        .unwrap();
    let links = f.library.character_tagger_tags(&target.id).unwrap();
    assert_eq!(links.linked.len(), 2);
    assert!(links.excluded.is_empty());
    assert!(matches!(
        f.library.relink_character_tagger_tag(&target.id, "unknown"),
        Err(Error::Stale)
    ));
}

#[test]
fn tagger_last_unlink_removes_recommendations_even_after_raw_evidence_replacement_and_cascades() {
    let f = Fixture::new();
    let target = f.ready("A");
    let c = f.library.connection().unwrap();
    explicitly_link(&c, &target.id, "wrong").unwrap();
    candidate(&c, &target.id, "asset-5", "recommendation");
    // A reference-hidden candidate is cleaned too, but is not in the confirmation count.
    candidate(&c, &target.id, "asset-0", "recommendation");
    drop(c);
    assert_eq!(
        f.library.character_tagger_tags(&target.id).unwrap().linked[0].pending_recommendations,
        1
    );
    f.library
        .unlink_character_tagger_tag(&target.id, "wrong", 1)
        .unwrap();
    let c = f.library.connection().unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM character_tagger_candidates",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    c.execute("DELETE FROM character_targets WHERE id=?1", [&target.id])
        .unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM character_target_tagger_tag_exclusions",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(c);
    assert!(matches!(
        f.library.character_tagger_tags(&target.id),
        Err(Error::NotFound)
    ));
}
