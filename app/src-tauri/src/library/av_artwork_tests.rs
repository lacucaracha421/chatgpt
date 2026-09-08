use super::*;
use crate::library::models::{CollectionType,CreateCollection};
fn setup()->(tempfile::TempDir,Library,String,String) {
    let dir=tempfile::tempdir().unwrap(); let library=Library::open(&dir.path().join("library")).unwrap();
    let id=library.create_collection(CreateCollection{name:"AV artwork".into(),description:None,collection_type:CollectionType::Av}).unwrap().id;
    let path=dir.path().join("front.png"); image::RgbImage::from_pixel(12,18,image::Rgb([200,20,40])).save(&path).unwrap();
    (dir,library,id,path.to_string_lossy().into())
}
fn request(revision:String,front:ArtworkDecision,back:ArtworkDecision)->ApplyAvArtwork {ApplyAvArtwork{expected_revision:revision,front,spine:ArtworkDecision::Keep,back}}
#[test]
fn preview_is_readonly_and_same_bytes_can_fill_distinct_roles_idempotently() {
    let (_dir,library,id,path)=setup(); let preview=library.preview_av_artwork(&path,CoverSurface::Front).unwrap();
    assert_eq!(library.list_collection_work_artworks(&id).unwrap().len(),0);
    let decision=ArtworkDecision::Local{path,sha256:preview.sha256};
    let first=library.apply_av_artwork(&id,request(library.get_av_cover_set(&id).unwrap().revision,decision.clone(),decision.clone())).unwrap();
    assert_ne!(first.front_id,first.back_id);
    let second=library.apply_av_artwork(&id,request(first.revision,decision.clone(),decision)).unwrap();
    assert_eq!(first.front_id,second.front_id); assert_eq!(library.list_collection_work_artworks(&id).unwrap().len(),2);
    let cleared=library.apply_av_artwork(&id,request(second.revision,ArtworkDecision::Keep,ArtworkDecision::Clear)).unwrap();
    assert_eq!(cleared.front_id,first.front_id); assert!(cleared.back_id.is_none());
    assert_eq!(library.list_collection_work_artworks(&id).unwrap().len(),2);
}
#[test]
fn changed_or_invalid_second_image_keeps_old_selection_and_drops_prepared_files() {
    let (_dir,library,id,path)=setup(); let preview=library.preview_av_artwork(&path,CoverSurface::Front).unwrap();
    let revision=library.get_av_cover_set(&id).unwrap().revision;
    let result=library.apply_av_artwork(&id,request(revision.clone(),ArtworkDecision::Local{path:path.clone(),sha256:preview.sha256},ArtworkDecision::Local{path,sha256:"wrong".into()}));
    assert!(result.is_err()); assert_eq!(library.get_av_cover_set(&id).unwrap().revision,revision);
    assert!(library.list_collection_work_artworks(&id).unwrap().is_empty());
    let folder=library.root().join("work-artwork").join(&id);
    assert_eq!(std::fs::read_dir(folder).unwrap().count(),0);
}

#[test]
fn stale_artwork_request_does_not_clear_a_new_selection_and_delete_cleans_owned_files() {
    let (_dir,library,id,path)=setup(); let initial=library.get_av_cover_set(&id).unwrap();
    let preview=library.preview_av_artwork(&path,CoverSurface::Front).unwrap();
    let saved=library.apply_av_artwork(&id,request(initial.revision.clone(),ArtworkDecision::Local{path,sha256:preview.sha256},ArtworkDecision::Keep)).unwrap();
    assert!(matches!(library.apply_av_artwork(&id,request(initial.revision,ArtworkDecision::Clear,ArtworkDecision::Keep)),Err(AvError::Stale)));
    assert_eq!(library.get_av_cover_set(&id).unwrap().front_id,saved.front_id);
    let artwork_id=saved.front_id.unwrap(); assert!(library.resolve_work_artwork(&artwork_id).is_ok());
    library.delete_collection(&id).unwrap(); assert!(library.resolve_work_artwork(&artwork_id).is_err());
    assert!(!library.root().join("work-artwork").join(&id).exists());
}

#[test]
fn av_daily_backup_restore_recovers_metadata_people_order_and_all_cover_roles() {
    use crate::library::av_models::{
        AvPersonChoice, AvPersonInput, AvPersonRole, SaveAvDetails,
    };
    use chrono::TimeZone;

    let (_dir, library, id, path) = setup();
    let person = |name: &str| AvPersonInput {
        person: AvPersonChoice::New { display_name: name.into() },
        role: AvPersonRole::Performer,
        credit_name: Some(format!("credit {name}")),
    };
    let original_details = library.save_av_details(&id, SaveAvDetails {
        expected_revision: 0,
        product_code: Some("BEFORE-001".into()),
        label: Some("Original label".into()),
        series: Some("Original series".into()),
        people: vec![person("first"), person("second")],
    }).unwrap();
    let preview = library.preview_av_artwork(&path, CoverSurface::Front).unwrap();
    let image = ArtworkDecision::Local { path: path.clone(), sha256: preview.sha256 };
    let original_covers = library.apply_av_artwork(&id, ApplyAvArtwork {
        expected_revision: library.get_av_cover_set(&id).unwrap().revision,
        front: image.clone(), spine: image.clone(), back: image,
    }).unwrap();
    let owned_files: Vec<_> = [
        original_covers.front_id.as_ref().unwrap(),
        original_covers.spine_id.as_ref().unwrap(),
        original_covers.back_id.as_ref().unwrap(),
    ].into_iter().map(|artwork_id| {
        let relative: String = library.connection().unwrap().query_row(
            "SELECT relative_path FROM collection_work_artworks WHERE id=?1",
            [artwork_id], |row| row.get(0),
        ).unwrap();
        let owned_path = library.root().join(relative);
        let bytes = std::fs::read(&owned_path).unwrap();
        (artwork_id.clone(), owned_path, bytes)
    }).collect();
    let backup = library.ensure_daily_backup(
        chrono::Utc.with_ymd_and_hms(2026, 9, 8, 12, 0, 0).unwrap(),
    ).unwrap().unwrap();

    let mut changed_people: Vec<_> = original_details.people.iter().rev().map(|credit| {
        AvPersonInput {
            person: AvPersonChoice::Existing { id: credit.id.clone() },
            role: credit.role.clone(), credit_name: Some("changed credit".into()),
        }
    }).collect();
    changed_people.push(person("after backup"));
    let changed_details = library.save_av_details(&id, SaveAvDetails {
        expected_revision: original_details.revision,
        product_code: Some("AFTER-002".into()), label: None, series: None,
        people: changed_people,
    }).unwrap();
    assert_eq!(changed_details.people[0].id, original_details.people[1].id);
    image::RgbImage::from_pixel(12, 18, image::Rgb([10, 220, 80])).save(&path).unwrap();
    let changed_preview = library.preview_av_artwork(&path, CoverSurface::Front).unwrap();
    let replacement = ArtworkDecision::Local { path, sha256: changed_preview.sha256 };
    let changed_covers = library.apply_av_artwork(&id, ApplyAvArtwork {
        expected_revision: library.get_av_cover_set(&id).unwrap().revision,
        front: replacement.clone(), spine: replacement, back: ArtworkDecision::Clear,
    }).unwrap();
    assert_ne!(changed_covers.front_id, original_covers.front_id);
    assert_ne!(changed_covers.spine_id, original_covers.spine_id);
    assert!(changed_covers.back_id.is_none());

    library.restore_backup(&backup.id).unwrap();

    assert_eq!(serde_json::to_value(library.get_av_details(&id).unwrap()).unwrap(),
        serde_json::to_value(original_details).unwrap());
    assert_eq!(serde_json::to_value(library.get_av_cover_set(&id).unwrap()).unwrap(),
        serde_json::to_value(original_covers).unwrap());
    assert!(library.search_av_people("after backup").unwrap().is_empty());
    for (artwork_id, owned_path, original_bytes) in owned_files {
        assert_eq!(std::fs::read(owned_path).unwrap(), original_bytes);
        assert!(library.resolve_work_artwork(&artwork_id).is_ok());
    }
}
