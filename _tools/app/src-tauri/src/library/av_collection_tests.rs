use super::*;
use crate::library::models::{CollectionType, CreateCollection};
use std::collections::BTreeSet;
fn setup() -> (tempfile::TempDir, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path()).unwrap();
    let item = library
        .create_collection(CreateCollection {
            name: "AV fixture".into(),
            description: None,
            collection_type: CollectionType::Av,
        })
        .unwrap();
    (dir, library, item.id)
}
fn draft(revision: i64, people: Vec<AvPersonInput>) -> SaveAvDetails {
    SaveAvDetails {
        expected_revision: revision,
        product_code: Some(" TEST-001 ".into()),
        label: None,
        series: None,
        people,
    }
}
fn new_person(name: &str) -> AvPersonInput {
    AvPersonInput {
        person: AvPersonChoice::New {
            display_name: name.into(),
        },
        role: AvPersonRole::Performer,
        credit_name: None,
    }
}
#[test]
fn normalized_people_preserve_same_name_identity_role_and_order() {
    let (_dir, library, id) = setup();
    let first = library
        .save_av_details(&id, draft(0, vec![new_person("동명"), new_person("동명")]))
        .unwrap();
    assert_ne!(first.people[0].id, first.people[1].id);
    assert_eq!(first.product_code.as_deref(), Some("TEST-001"));
    let person = |index: usize, role| AvPersonInput {
        person: AvPersonChoice::Existing {
            id: first.people[index].id.clone(),
        },
        role,
        credit_name: Some("별도 표기".into()),
    };
    let saved = library
        .save_av_details(
            &id,
            draft(
                1,
                vec![
                    person(1, AvPersonRole::Performer),
                    person(0, AvPersonRole::Performer),
                    person(0, AvPersonRole::Director),
                ],
            ),
        )
        .unwrap();
    assert_eq!(saved.people[0].id, first.people[1].id);
    assert_eq!(saved.people[2].role, AvPersonRole::Director);
    assert_eq!(library.search_av_people("동명").unwrap().len(), 2);
    assert!(matches!(
        library.save_av_details(&id, draft(1, vec![])),
        Err(AvError::Stale)
    ));
    assert_eq!(library.get_av_details(&id).unwrap().people.len(), 3);
    library.delete_collection(&id).unwrap();
    assert_eq!(library.search_av_people("동명").unwrap().len(), 2);
}
#[test]
fn invalid_relation_rolls_back_new_people_and_preserves_previous() {
    let (_dir, library, id) = setup();
    let result = library.save_av_details(
        &id,
        draft(
            0,
            vec![
                new_person("discard"),
                AvPersonInput {
                    person: AvPersonChoice::Existing {
                        id: "missing".into(),
                    },
                    role: AvPersonRole::Performer,
                    credit_name: None,
                },
            ],
        ),
    );
    assert!(result.is_err());
    assert!(library.search_av_people("discard").unwrap().is_empty());
    assert_eq!(library.get_av_details(&id).unwrap().revision, 0);
    assert!(library
        .save_av_details(&id, draft(0, vec![new_person("")]))
        .is_err());
    assert!(library
        .save_av_details(&id, draft(0, vec![new_person("person"); 101]))
        .is_err());
}
#[test]
fn duplicate_existing_person_role_is_rejected() {
    let (_dir, library, id) = setup();
    let first = library
        .save_av_details(&id, draft(0, vec![new_person("name")]))
        .unwrap();
    let credit = AvPersonInput {
        person: AvPersonChoice::Existing {
            id: first.people[0].id.clone(),
        },
        role: AvPersonRole::Performer,
        credit_name: None,
    };
    assert!(library
        .save_av_details(&id, draft(1, vec![credit.clone(), credit]))
        .is_err());
    assert_eq!(library.get_av_details(&id).unwrap().revision, 1);
    assert_eq!(
        library.get_collection(&id).unwrap().collection_type,
        CollectionType::Av
    );
}

#[test]
fn non_av_work_rejects_av_metadata_without_mutation() {
    let (_dir, library, id) = setup();
    library
        .connection()
        .unwrap()
        .execute("UPDATE collections SET type='movie' WHERE id=?1", [&id])
        .unwrap();
    assert!(library
        .save_av_details(&id, draft(0, vec![new_person("not-created")]))
        .is_err());
    assert!(library.search_av_people("not-created").unwrap().is_empty());
}

#[test]
fn ordinary_edit_cannot_convert_av_and_orphan_its_relations() {
    let (_dir, library, id) = setup();
    library
        .save_av_details(&id, draft(0, vec![new_person("retained")]))
        .unwrap();
    let summary = library.get_collection(&id).unwrap();
    let mut value = serde_json::to_value(summary).unwrap();
    value["type"] = serde_json::json!("movie");
    let request = serde_json::from_value(value).unwrap();
    assert!(library.update_collection(&id, request).is_err());
    assert_eq!(library.get_av_details(&id).unwrap().people.len(), 1);
}

#[test]
fn home_pick_rotates_without_repeats_and_requires_an_owned_av_work() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path()).unwrap();
    for index in 0..3 {
        let work = library
            .create_collection(CreateCollection {
                name: format!("AV {index}"),
                description: None,
                collection_type: CollectionType::Av,
            })
            .unwrap();
        library
            .save_av_details(
                &work.id,
                SaveAvDetails {
                    expected_revision: 0,
                    product_code: Some(format!("TEST-{index:03}")),
                    label: None,
                    series: None,
                    people: vec![new_person(&format!("배우 {index}"))],
                },
            )
            .unwrap();
    }
    let movie = library
        .create_collection(CreateCollection {
            name: "not owned AV".into(),
            description: None,
            collection_type: CollectionType::Movie,
        })
        .unwrap();
    let connection = library.connection().unwrap();
    connection.execute(
        "INSERT INTO collection_people(id,display_name,created_at,updated_at) VALUES('movie-only','제외','t','t')",
        [],
    ).unwrap();
    connection.execute(
        "INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order) VALUES(?1,'movie-only','performer',0)",
        [&movie.id],
    ).unwrap();
    drop(connection);

    let start = NaiveDate::from_ymd_opt(2026, 9, 27).unwrap();
    let picks = (0..3)
        .map(|offset| {
            library
                .home_av_performer(start + chrono::Duration::days(offset))
                .unwrap()
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        picks
            .iter()
            .map(|pick| &pick.id)
            .collect::<BTreeSet<_>>()
            .len(),
        3
    );
    assert!(picks
        .iter()
        .all(|pick| pick.display_name != "제외" && pick.owned_works == 1));
    assert_eq!(
        library
            .home_av_performer(start + chrono::Duration::days(3))
            .unwrap()
            .unwrap()
            .id,
        picks[0].id,
    );

    // Once a performer has a portrait, the daily pick rotates through portrait holders only.
    let chosen = picks[1].id.clone();
    library.connection().unwrap().execute(
        "INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,source_url,updated_at)
         VALUES(?1,'commons',x'00','image/png',1,1,'p.png','https://example.test/p','t')",
        [&chosen],
    ).unwrap();
    for offset in 0..3 {
        assert_eq!(
            library
                .home_av_performer(start + chrono::Duration::days(offset))
                .unwrap()
                .unwrap()
                .id,
            chosen
        );
    }
}
