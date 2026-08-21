use std::collections::BTreeMap;

use rusqlite::{params, Transaction};

use super::{error::LibraryError, models::MangaDexCoverCandidate};

pub(crate) fn parse_volume_slot(value: &str) -> Option<(i64, u8)> {
    let (number, edition_index) = match value.split_once('.') {
        None => (value, 0),
        Some((number, "1")) => (number, 1),
        Some((number, "2")) => (number, 2),
        Some((number, "3")) => (number, 3),
        Some(_) => return None,
    };
    if number.is_empty() {
        return None;
    }
    let volume_number = number.parse::<i64>().ok()?;
    (volume_number > 0 && volume_number <= i64::MAX / 10).then_some((volume_number, edition_index))
}

pub(crate) fn materialize_mangadex_volumes(
    transaction: &Transaction<'_>,
    collection_id: &str,
    covers: &[MangaDexCoverCandidate],
    representative: Option<(&str, &str)>,
) -> Result<(), LibraryError> {
    let mut slots = BTreeMap::new();
    for cover in covers
        .iter()
        .filter(|cover| cover.language.as_deref() == Some("ja"))
    {
        let Some(slot) = cover.volume.as_deref().and_then(parse_volume_slot) else {
            continue;
        };
        slots.entry(slot).or_insert(cover);
    }

    let now = chrono::Utc::now().to_rfc3339();
    for ((volume_number, edition_index), cover) in slots {
        let cover_artwork_id = representative
            .filter(|(cover_id, _)| *cover_id == cover.cover_id)
            .map(|(_, artwork_id)| artwork_id);
        transaction.execute(
            "INSERT INTO collection_volumes (
                id, collection_id, volume_number, edition_index, sort_order,
                cover_artwork_id, source_provider, source_cover_id, source_file_name,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'mangadex', ?7, ?8, ?9, ?9)
             ON CONFLICT(collection_id, volume_number, edition_index) DO UPDATE SET
                cover_artwork_id = COALESCE(collection_volumes.cover_artwork_id, excluded.cover_artwork_id),
                source_provider = excluded.source_provider,
                source_cover_id = excluded.source_cover_id,
                source_file_name = excluded.source_file_name,
                updated_at = excluded.updated_at
             WHERE collection_volumes.source_provider IS NULL
                OR collection_volumes.source_provider = 'mangadex'",
            params![
                uuid::Uuid::new_v4().to_string(),
                collection_id,
                volume_number,
                edition_index,
                volume_number * 10 + i64::from(edition_index),
                cover_artwork_id,
                cover.cover_id,
                cover.file_name,
                now,
            ],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{materialize_mangadex_volumes, parse_volume_slot};
    use crate::library::{
        models::{CollectionType, CreateCollection, MangaDexCoverCandidate},
        Library,
    };

    fn candidate(
        cover_id: &str,
        file_name: &str,
        volume: &str,
        language: &str,
    ) -> MangaDexCoverCandidate {
        MangaDexCoverCandidate {
            cover_id: cover_id.into(),
            file_name: file_name.into(),
            volume: Some(volume.into()),
            language: Some(language.into()),
        }
    }

    #[test]
    fn parses_only_supported_volume_slots() {
        assert_eq!(parse_volume_slot("1"), Some((1, 0)));
        assert_eq!(parse_volume_slot("12.1"), Some((12, 1)));
        assert_eq!(parse_volume_slot("12.2"), Some((12, 2)));
        assert_eq!(parse_volume_slot("12.3"), Some((12, 3)));
        assert_eq!(parse_volume_slot("01"), Some((1, 0)));
        for value in ["0", "1.01", "1.4", "1.5", ".1", "special", " 1 "] {
            assert_eq!(parse_volume_slot(value), None, "{value}");
        }
    }

    #[test]
    fn materialization_keeps_first_japanese_cover_per_slot_in_numeric_order() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let work = library
            .create_collection(CreateCollection {
                name: "Work".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        let covers = vec![
            candidate("cover-10", "ten.jpg", "10", "ja"),
            candidate("cover-2", "two.jpg", "2", "ja"),
            candidate("cover-2-later", "two-later.jpg", "2", "ja"),
            candidate("cover-1-2", "one-small.jpg", "1.2", "ja"),
            candidate("cover-ko", "ko.jpg", "1", "ko"),
            candidate("cover-unsupported", "half.jpg", "1.5", "ja"),
        ];
        let mut connection = library.connection().unwrap();
        let transaction = connection.transaction().unwrap();

        materialize_mangadex_volumes(&transaction, &work.id, &covers, None).unwrap();

        let stored = {
            let mut statement = transaction
                .prepare(
                    "SELECT volume_number, edition_index, source_cover_id
                     FROM collection_volumes
                     WHERE collection_id = ?1
                     ORDER BY volume_number, edition_index",
                )
                .unwrap();
            statement
                .query_map([&work.id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, u8>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(
            stored,
            vec![
                (1, 2, "cover-1-2".into()),
                (2, 0, "cover-2".into()),
                (10, 0, "cover-10".into()),
            ]
        );
    }
}
