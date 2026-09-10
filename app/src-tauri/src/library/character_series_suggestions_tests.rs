use super::*;
use crate::library::characters::tests::Fixture;
use serde_json::json;

fn root_id(f: &Fixture) -> String {
    f.library.connection().unwrap().query_row(
        "SELECT parent_id FROM classification_entries WHERE id=?1",
        [&f.series], |row| row.get::<_, String>(0),
    ).unwrap()
}

fn move_directly_to_root(f: &Fixture, asset_id: &str, root: &str) {
    let connection = f.library.connection().unwrap();
    connection.execute("DELETE FROM asset_classifications WHERE asset_id=?1", [asset_id]).unwrap();
    connection.execute("INSERT INTO asset_classifications(asset_id,classification_id) VALUES(?1,?2)",
        params![asset_id, root]).unwrap();
}

fn publish_recommendation(f: &Fixture, target: &super::super::characters::Target, asset_id: &str) {
    f.library.connection().unwrap().execute(
        "DELETE FROM character_autotag_reconsideration WHERE series_id=?1",
        [target.series_classification_id.as_deref().unwrap()],
    ).unwrap();
    character_autotag::enqueue(&f.library.connection().unwrap(), asset_id, Cause::ManualScanEnrollment).unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    let runtime = "a".repeat(64);
    let context = f.library.character_autotag_context(&f.library.connection().unwrap(), &job, &runtime).unwrap();
    assert!(context.targets.iter().any(|item| item.id == target.id));
    let prediction = super::super::character_autotag::Prediction {
        target_id: target.id.clone(),
        result: ScanResult { asset_id: asset_id.into(), content_hash: job.content_hash.clone(), state: "recommended".into(),
            evidence: Some(json!({"passed":true,"distance":0.12,"wholeFallback":false,"bestQueryCrop":0,"queryBoxes":[[0,0,10,10]],"evidence":[{"matchedReferences":[0,1,2],"referenceDistances":[0.1,0.11,0.12,0.3,0.4]}]})), error: None },
    };
    let mut connection = f.library.connection().unwrap();
    let transaction = connection.transaction().unwrap();
    f.library.publish_character_autotag(&transaction, &job, &context, &[prediction],
        super::super::character_autotag::ReviewState::Unresolved, &json!([[0,0,10,10]])).unwrap();
    transaction.commit().unwrap();
}

#[test]
fn discovery_queues_only_direct_root_images_without_current_results() {
    let f = Fixture::new();
    f.ready("A");
    let root = root_id(&f);
    move_directly_to_root(&f, "asset-5", &root);

    let page = f.library.character_series_suggestions(&root, 100).unwrap();
    assert_eq!(page.unscanned_count, 1);
    assert_eq!(page.pending_count, 0);
    assert!(page.items.is_empty());

    assert_eq!(f.library.queue_character_series_discovery(&root).unwrap(), 1);
    let page = f.library.character_series_suggestions(&root, 100).unwrap();
    assert_eq!(page.unscanned_count, 0);
    assert_eq!(page.pending_count, 1);
    assert_eq!(f.library.queue_character_series_discovery(&root).unwrap(), 0);
}

#[test]
fn recommendation_can_be_dismissed_without_moving_the_asset() {
    let f = Fixture::new();
    let target = f.ready("A");
    let root = root_id(&f);
    move_directly_to_root(&f, "asset-5", &root);
    publish_recommendation(&f, &target, "asset-5");
    let page = f.library.character_series_suggestions(&root, 100).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].series_id, f.series);
    assert_eq!(page.items[0].target_name, "A");
    assert_eq!(page.items[0].matched_references, 3);

    f.library.dismiss_character_series_suggestion(&root, "asset-5", &f.series).unwrap();
    assert!(f.library.character_series_suggestions(&root, 100).unwrap().items.is_empty());
    let current: String = f.library.connection().unwrap().query_row(
        "SELECT classification_id FROM asset_classifications WHERE asset_id='asset-5'", [], |row| row.get(0),
    ).unwrap();
    assert_eq!(current, root);
}

#[test]
fn accepting_a_series_suggestion_moves_only_the_series_classification() {
    let f = Fixture::new();
    let target = f.ready("A");
    let root = root_id(&f);
    move_directly_to_root(&f, "asset-5", &root);
    publish_recommendation(&f, &target, "asset-5");

    f.library.accept_character_series_suggestion(&root, "asset-5", &f.series).unwrap();
    let connection = f.library.connection().unwrap();
    let current: String = connection.query_row(
        "SELECT classification_id FROM asset_classifications WHERE asset_id='asset-5'", [], |row| row.get(0),
    ).unwrap();
    assert_eq!(current, f.series);
    let accepted: i64 = connection.query_row(
        "SELECT COUNT(*) FROM character_relations WHERE asset_id='asset-5'", [], |row| row.get(0),
    ).unwrap();
    assert_eq!(accepted, 0, "series acceptance must not silently approve a character");
}
