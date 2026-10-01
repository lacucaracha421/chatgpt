use super::*;

#[test]
fn launchbox_spines_keep_the_existing_publication_payload_contract() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let mut connection = library.connection().unwrap();
    connection.execute_batch("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('game','Game','game','2026','2026');
        INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES('spine','game','launchbox','123/spine.png','spine','work-artwork/missing.png','image/png',8,64,1,'2026','2026');").unwrap();
    let launchbox = snapshot_from_connection(temp.path(), &mut connection, None, &|_| {}).unwrap();
    let launchbox = serde_json::to_value(&launchbox.replica).unwrap();
    connection.execute("UPDATE collection_work_artworks SET provider='local-manual',provider_image_id='user-choice' WHERE id='spine'",[]).unwrap();
    let manual = snapshot_from_connection(temp.path(), &mut connection, None, &|_| {}).unwrap();
    assert_eq!(launchbox, serde_json::to_value(&manual.replica).unwrap());
    let artwork = &launchbox["collections"][0]["artworks"][0];
    assert_eq!(artwork["kind"], "spine");
    assert_eq!(artwork["selected"], true);
    assert_eq!(artwork.as_object().unwrap().len(), 5);
    assert!(artwork.get("provider").is_none());
}
