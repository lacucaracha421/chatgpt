use std::{cmp::Ordering, collections::BTreeMap};

use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    aladin::{self, AladinItem},
    collection::require_collection,
    error::LibraryError,
    models::{
        AladinApplyRequest, AladinConnection, AladinSeriesCandidate, AladinSyncResult,
        AladinVolumeCandidate, ExternalBindingInput,
    },
    Library,
};

const PROVIDER: &str = "aladin";

#[derive(Debug, Clone)]
struct GroupedSeries {
    candidate: AladinSeriesCandidate,
    items: Vec<AladinItem>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfig {
    version: u8,
    query: String,
    group_fingerprint: String,
    known_item_ids: Vec<String>,
}

impl Library {
    pub fn search_aladin(
        &self,
        ttb_key: &str,
        query: &str,
    ) -> Result<Vec<AladinSeriesCandidate>, LibraryError> {
        Ok(group_items(aladin::search(ttb_key, query)?))
    }

    pub fn apply_aladin(
        &self,
        ttb_key: &str,
        request: AladinApplyRequest,
    ) -> Result<AladinSyncResult, LibraryError> {
        let items = aladin::search(ttb_key, &request.query)?;
        self.apply_aladin_items(request, items, Vec::new())
    }

    pub fn refresh_aladin(
        &self,
        ttb_key: &str,
        collection_id: &str,
    ) -> Result<AladinSyncResult, LibraryError> {
        let (anchor_item_id, config) = self.aladin_binding_config(collection_id)?;
        let items = aladin::search(ttb_key, &config.query)?;
        self.refresh_aladin_items(collection_id, anchor_item_id, config, items)
    }

    fn refresh_aladin_items(
        &self,
        collection_id: &str,
        anchor_item_id: String,
        config: ProviderConfig,
        items: Vec<AladinItem>,
    ) -> Result<AladinSyncResult, LibraryError> {
        let groups = grouped_items(items);
        let mut matches = groups.iter().filter(|group| {
            group
                .items
                .iter()
                .any(|item| item.item_id == anchor_item_id)
                || (group.candidate.group_fingerprint == config.group_fingerprint
                    && group.items.iter().any(|item| {
                        config
                            .known_item_ids
                            .iter()
                            .any(|known| known == &item.item_id)
                    }))
        });
        let selected = matches.next().cloned();
        if selected.is_none() || matches.next().is_some() {
            return Err(LibraryError::AmbiguousAladinBinding);
        }
        let selected = selected.unwrap();
        self.reconcile_aladin(
            AladinApplyRequest {
                collection_id: collection_id.to_owned(),
                query: config.query,
                anchor_item_id,
                group_fingerprint: selected.candidate.group_fingerprint.clone(),
            },
            selected,
            config.known_item_ids,
        )
    }

    pub fn get_aladin_connection(
        &self,
        collection_id: &str,
    ) -> Result<Option<AladinConnection>, LibraryError> {
        let connection = self.connection()?;
        require_collection(&connection, collection_id)?;
        let binding = connection
            .query_row(
                "SELECT external_id, provider_config_json, last_synced_at
                 FROM collection_external_bindings
                 WHERE collection_id = ?1 AND provider = ?2",
                params![collection_id, PROVIDER],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        binding
            .map(|(anchor_item_id, config_json, last_synced_at)| {
                let config: ProviderConfig = serde_json::from_str(
                    config_json
                        .as_deref()
                        .ok_or(LibraryError::AmbiguousAladinBinding)?,
                )
                .map_err(|_| LibraryError::AmbiguousAladinBinding)?;
                Ok(AladinConnection {
                    anchor_item_id,
                    query: config.query,
                    last_synced_at,
                })
            })
            .transpose()
    }

    fn aladin_binding_config(
        &self,
        collection_id: &str,
    ) -> Result<(String, ProviderConfig), LibraryError> {
        let connection = self.connection()?;
        require_collection(&connection, collection_id)?;
        let (anchor, config): (String, Option<String>) = connection
            .query_row(
                "SELECT external_id, provider_config_json
                 FROM collection_external_bindings
                 WHERE collection_id = ?1 AND provider = ?2",
                params![collection_id, PROVIDER],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or(LibraryError::AmbiguousAladinBinding)?;
        let config = serde_json::from_str(
            config
                .as_deref()
                .ok_or(LibraryError::AmbiguousAladinBinding)?,
        )
        .map_err(|_| LibraryError::AmbiguousAladinBinding)?;
        Ok((anchor, config))
    }

    fn apply_aladin_items(
        &self,
        request: AladinApplyRequest,
        items: Vec<AladinItem>,
        known_item_ids: Vec<String>,
    ) -> Result<AladinSyncResult, LibraryError> {
        let groups = grouped_items(items);
        let mut matches = groups.into_iter().filter(|group| {
            group.candidate.anchor_item_id == request.anchor_item_id
                && group.candidate.group_fingerprint == request.group_fingerprint
        });
        let selected = matches.next();
        if selected.is_none() || matches.next().is_some() {
            return Err(LibraryError::AmbiguousAladinBinding);
        }
        self.reconcile_aladin(request, selected.unwrap(), known_item_ids)
    }

    fn reconcile_aladin(
        &self,
        request: AladinApplyRequest,
        selected: GroupedSeries,
        mut known_item_ids: Vec<String>,
    ) -> Result<AladinSyncResult, LibraryError> {
        for item in &selected.items {
            if !known_item_ids.contains(&item.item_id) {
                known_item_ids.push(item.item_id.clone());
            }
        }
        known_item_ids.sort();
        let config = ProviderConfig {
            version: 1,
            query: request.query.trim().to_owned(),
            group_fingerprint: request.group_fingerprint,
            known_item_ids,
        };
        let config_json =
            serde_json::to_string(&config).map_err(|_| LibraryError::InvalidAladinResponse)?;
        let snapshot_json = serde_json::to_string(&selected.candidate)
            .map_err(|_| LibraryError::InvalidAladinResponse)?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        require_collection(&transaction, &request.collection_id)?;
        let mut result = AladinSyncResult {
            added: 0,
            updated: 0,
            unchanged: 0,
            ignored: selected.candidate.ignored_count,
        };
        for item in &selected.items {
            reconcile_source(
                &transaction,
                &request.collection_id,
                item,
                &now,
                &mut result,
            )?;
        }
        super::external_binding::upsert_external_binding(
            &transaction,
            &request.collection_id,
            ExternalBindingInput {
                provider: PROVIDER.into(),
                external_id: request.anchor_item_id,
                provider_config_json: Some(config_json),
                provider_data_json: Some(snapshot_json),
                last_synced_at: Some(now.clone()),
            },
            &now,
        )?;
        transaction.commit()?;
        Ok(result)
    }
}

fn reconcile_source(
    transaction: &Transaction<'_>,
    collection_id: &str,
    item: &AladinItem,
    now: &str,
    result: &mut AladinSyncResult,
) -> Result<(), LibraryError> {
    type StoredSource = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    );
    let existing: Option<StoredSource> = transaction
        .query_row(
            "SELECT provider_item_id, title, author, publisher, isbn13,
                    publication_date, item_url, provider_data_json
             FROM collection_volume_sources
             WHERE collection_id = ?1 AND volume_number = ?2 AND provider = ?3",
            params![collection_id, item.volume_number, PROVIDER],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .optional()?;
    let current = (
        item.item_id.clone(),
        item.title.trim().to_owned(),
        item.author.clone(),
        item.publisher.clone(),
        item.isbn13.clone(),
        item.publication_date.clone(),
        item.item_url.clone(),
        item.snapshot_json.clone(),
    );
    match existing {
        None => result.added += 1,
        Some(stored) if stored == current => result.unchanged += 1,
        Some(_) => result.updated += 1,
    }

    transaction
        .execute(
            "INSERT INTO collection_volume_sources (
                collection_id, volume_number, provider, provider_item_id, title,
                author, publisher, isbn13, publication_date, item_url,
                provider_data_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
             ON CONFLICT(collection_id, volume_number, provider) DO UPDATE SET
                provider_item_id = excluded.provider_item_id,
                title = excluded.title,
                author = excluded.author,
                publisher = excluded.publisher,
                isbn13 = excluded.isbn13,
                publication_date = excluded.publication_date,
                item_url = excluded.item_url,
                provider_data_json = excluded.provider_data_json,
                updated_at = excluded.updated_at",
            params![
                collection_id,
                item.volume_number,
                PROVIDER,
                current.0,
                current.1,
                current.2,
                current.3,
                current.4,
                current.5,
                current.6,
                current.7,
                now,
            ],
        )
        .map_err(map_source_write_error)?;
    transaction.execute(
        "INSERT INTO collection_volumes (
            id, collection_id, volume_number, edition_index, sort_order,
            cover_artwork_id, source_provider, source_cover_id, source_file_name,
            created_at, updated_at
         ) VALUES (?1, ?2, ?3, 0, ?3, NULL, NULL, NULL, NULL, ?4, ?4)
         ON CONFLICT(collection_id, volume_number, edition_index) DO NOTHING",
        params![
            uuid::Uuid::new_v4().to_string(),
            collection_id,
            item.volume_number,
            now
        ],
    )?;
    Ok(())
}

fn map_source_write_error(error: rusqlite::Error) -> LibraryError {
    if matches!(
        error,
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::ConstraintViolation,
                ..
            },
            _
        )
    ) {
        LibraryError::DuplicateAladinProviderItem
    } else {
        LibraryError::Database(error)
    }
}

fn group_items(items: Vec<AladinItem>) -> Vec<AladinSeriesCandidate> {
    grouped_items(items)
        .into_iter()
        .map(|group| group.candidate)
        .collect()
}

fn grouped_items(items: Vec<AladinItem>) -> Vec<GroupedSeries> {
    let mut groups: BTreeMap<String, Vec<AladinItem>> = BTreeMap::new();
    for item in items {
        groups.entry(group_key(&item)).or_default().push(item);
    }
    groups
        .into_values()
        .map(|mut items| {
            let item_count = items.len() as u64;
            items.sort_by(compare_duplicate_preference);
            let title = items[0].base_title.trim().to_owned();
            let author = items[0].author.clone();
            let publisher = items[0].publisher.clone();
            let fingerprint = fingerprint(&title, author.as_deref(), publisher.as_deref());
            let mut by_volume = BTreeMap::new();
            for item in items {
                by_volume.entry(item.volume_number).or_insert(item);
            }
            let selected_items: Vec<_> = by_volume.into_values().collect();
            let ignored_count = item_count.saturating_sub(selected_items.len() as u64);
            let anchor_item_id = selected_items
                .iter()
                .map(|item| item.item_id.as_str())
                .min()
                .unwrap_or_default()
                .to_owned();
            let volumes = selected_items
                .iter()
                .map(|item| AladinVolumeCandidate {
                    volume_number: item.volume_number,
                    provider_item_id: item.item_id.clone(),
                    title: item.title.clone(),
                    publication_date: item.publication_date.clone(),
                    isbn13: item.isbn13.clone(),
                })
                .collect();
            GroupedSeries {
                candidate: AladinSeriesCandidate {
                    anchor_item_id,
                    group_fingerprint: fingerprint,
                    title,
                    author,
                    publisher,
                    volumes,
                    ignored_count,
                },
                items: selected_items,
            }
        })
        .collect()
}

fn compare_duplicate_preference(left: &AladinItem, right: &AladinItem) -> Ordering {
    left.volume_number
        .cmp(&right.volume_number)
        .then_with(|| right.isbn13.is_some().cmp(&left.isbn13.is_some()))
        .then_with(|| right.publication_date.cmp(&left.publication_date))
        .then_with(|| left.item_id.cmp(&right.item_id))
}

fn group_key(item: &AladinItem) -> String {
    [
        normalize(&item.base_title),
        normalize(item.author.as_deref().unwrap_or_default()),
        normalize(item.publisher.as_deref().unwrap_or_default()),
    ]
    .join("\0")
}

fn fingerprint(title: &str, author: Option<&str>, publisher: Option<&str>) -> String {
    let input = [
        normalize(title),
        normalize(author.unwrap_or_default()),
        normalize(publisher.unwrap_or_default()),
    ]
    .join("\0");
    Sha256::digest(input.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::{group_items, ProviderConfig};
    use crate::library::{
        aladin::AladinItem,
        error::LibraryError,
        models::{AladinApplyRequest, CollectionType, CreateCollection, ExternalBindingInput},
        Library,
    };

    fn item(
        id: &str,
        base_title: &str,
        volume_number: i64,
        publisher: &str,
        isbn13: Option<&str>,
        publication_date: Option<&str>,
    ) -> AladinItem {
        AladinItem {
            item_id: id.into(),
            title: format!("{base_title} {volume_number}권"),
            author: Some("작가".into()),
            publisher: Some(publisher.into()),
            isbn13: isbn13.map(Into::into),
            publication_date: publication_date.map(Into::into),
            item_url: None,
            volume_number,
            base_title: base_title.into(),
            snapshot_json: format!(r#"{{"itemId":"{id}"}}"#),
        }
    }

    #[test]
    fn groups_series_without_fuzzy_merging() {
        let groups = group_items(vec![
            item("b-10", "던전밥", 10, "A출판", None, Some("2024-01-01")),
            item(
                "b-2",
                "던전밥",
                2,
                "A출판",
                Some("9782"),
                Some("2023-01-01"),
            ),
            item(
                "a-2",
                "던전밥",
                2,
                "A출판",
                Some("9781"),
                Some("2024-01-01"),
            ),
            item("other-1", "던전밥", 1, "B출판", Some("9791"), None),
        ]);

        assert_eq!(groups.len(), 2);
        let first = groups
            .iter()
            .find(|group| group.publisher.as_deref() == Some("A출판"))
            .unwrap();
        assert_eq!(
            first
                .volumes
                .iter()
                .map(|volume| volume.volume_number)
                .collect::<Vec<_>>(),
            vec![2, 10]
        );
        assert_eq!(first.volumes[0].provider_item_id, "a-2");
        assert_eq!(first.ignored_count, 1);
        assert_eq!(first.anchor_item_id, "a-2");
        assert_eq!(first.group_fingerprint.len(), 64);
    }

    fn create_work(library: &Library, name: &str) -> String {
        library
            .create_collection(CreateCollection {
                name: name.into(),
                description: Some("사용자 설명".into()),
                collection_type: CollectionType::Manga,
            })
            .unwrap()
            .id
    }

    fn request(collection_id: &str, items: &[AladinItem]) -> AladinApplyRequest {
        let candidate = group_items(items.to_vec()).remove(0);
        AladinApplyRequest {
            collection_id: collection_id.into(),
            query: "던전밥".into(),
            anchor_item_id: candidate.anchor_item_id,
            group_fingerprint: candidate.group_fingerprint,
        }
    }

    #[test]
    fn applies_releases_without_overwriting_work_or_covers() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let work_id = create_work(&library, "사용자 제목");
        library
            .upsert_collection_external_binding(
                &work_id,
                ExternalBindingInput {
                    provider: "mangadex".into(),
                    external_id: "manga-id".into(),
                    provider_config_json: None,
                    provider_data_json: Some("{\"title\":\"snapshot\"}".into()),
                    last_synced_at: None,
                },
            )
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute_batch(&format!(
                "UPDATE collections SET author = '사용자 작가', overview = '사용자 소개' WHERE id = '{id}';
                 INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, language, selected, created_at, updated_at
                 ) VALUES
                    ('hero', '{id}', 'mangadex', 'hero-cover', 'cover', 'hero.jpg',
                     'image/jpeg', 100, 150, 'ja', 1, 't', 't'),
                    ('base-cover', '{id}', 'mangadex', 'base-cover', 'volume_cover', 'base.jpg',
                     'image/jpeg', 100, 150, 'ja', 0, 't', 't'),
                    ('alt-cover', '{id}', 'mangadex', 'alt-cover', 'volume_cover', 'alt.jpg',
                     'image/jpeg', 100, 150, 'ja', 0, 't', 't');
                 INSERT INTO collection_volumes (
                    id, collection_id, volume_number, edition_index, sort_order,
                    cover_artwork_id, source_provider, source_cover_id, source_file_name,
                    created_at, updated_at
                 ) VALUES
                    ('volume-1', '{id}', 1, 0, 1, 'base-cover', 'mangadex', 'base-cover', 'base.jpg', 't', 't'),
                    ('volume-1-1', '{id}', 1, 1, 11, 'alt-cover', 'mangadex', 'alt-cover', 'alt.jpg', 't', 't');",
                id = work_id,
            ))
            .unwrap();
        let items = vec![
            item(
                "item-1",
                "던전밥",
                1,
                "A출판",
                Some("9781"),
                Some("2024-01-01"),
            ),
            item(
                "item-2",
                "던전밥",
                2,
                "A출판",
                Some("9782"),
                Some("2024-02-01"),
            ),
        ];

        let first = library
            .apply_aladin_items(request(&work_id, &items), items.clone(), Vec::new())
            .unwrap();
        assert_eq!((first.added, first.updated, first.unchanged), (2, 0, 0));
        let second = library
            .apply_aladin_items(request(&work_id, &items), items.clone(), Vec::new())
            .unwrap();
        assert_eq!((second.added, second.updated, second.unchanged), (0, 0, 2));

        let connection = library.connection().unwrap();
        let collection: (String, Option<String>, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT name, author, overview,
                        (SELECT id FROM collection_work_artworks
                         WHERE collection_id = collections.id AND selected = 1)
                 FROM collections WHERE id = ?1",
                [&work_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            collection,
            (
                "사용자 제목".into(),
                Some("사용자 작가".into()),
                Some("사용자 소개".into()),
                Some("hero".into())
            )
        );
        let bindings: Vec<String> = connection
            .prepare("SELECT provider FROM collection_external_bindings WHERE collection_id = ?1 ORDER BY provider")
            .unwrap()
            .query_map([&work_id], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(bindings, vec!["aladin", "mangadex"]);
        type VolumeRow = (i64, u8, Option<String>, Option<String>, Option<String>);
        let volumes: Vec<VolumeRow> = connection
            .prepare(
                "SELECT volume_number, edition_index, cover_artwork_id, source_provider, source_cover_id
                 FROM collection_volumes WHERE collection_id = ?1 ORDER BY volume_number, edition_index",
            )
            .unwrap()
            .query_map([&work_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            volumes,
            vec![
                (
                    1,
                    0,
                    Some("base-cover".into()),
                    Some("mangadex".into()),
                    Some("base-cover".into())
                ),
                (
                    1,
                    1,
                    Some("alt-cover".into()),
                    Some("mangadex".into()),
                    Some("alt-cover".into())
                ),
                (2, 0, None, None, None),
            ]
        );
    }

    #[test]
    fn transaction_rolls_back_when_a_provider_item_belongs_to_another_work() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let owner_id = create_work(&library, "기존 Work");
        let target_id = create_work(&library, "대상 Work");
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO collection_volume_sources (
                collection_id, volume_number, provider, provider_item_id, title,
                provider_data_json, created_at, updated_at
             ) VALUES (?1, 1, 'aladin', 'shared-item', '기존 1권', '{}', 't', 't')",
                [&owner_id],
            )
            .unwrap();
        let items = vec![item(
            "shared-item",
            "던전밥",
            1,
            "A출판",
            Some("9781"),
            None,
        )];

        let result = library.apply_aladin_items(request(&target_id, &items), items, Vec::new());
        assert!(matches!(
            result,
            Err(LibraryError::DuplicateAladinProviderItem)
        ));
        let connection = library.connection().unwrap();
        let counts: (i64, i64, i64) = connection.query_row(
            "SELECT
                (SELECT COUNT(*) FROM collection_external_bindings WHERE collection_id = ?1 AND provider = 'aladin'),
                (SELECT COUNT(*) FROM collection_volume_sources WHERE collection_id = ?1),
                (SELECT COUNT(*) FROM collection_volumes WHERE collection_id = ?1)",
            [&target_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(counts, (0, 0, 0));
    }

    #[test]
    fn refresh_requires_provider_identity_and_keeps_omitted_volumes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let work_id = create_work(&library, "Work");
        let initial = vec![
            item("item-1", "던전밥", 1, "A출판", Some("9781"), None),
            item("item-2", "던전밥", 2, "A출판", Some("9782"), None),
        ];
        library
            .apply_aladin_items(request(&work_id, &initial), initial.clone(), Vec::new())
            .unwrap();
        let candidate = group_items(initial.clone()).remove(0);
        let config = ProviderConfig {
            version: 1,
            query: "던전밥".into(),
            group_fingerprint: candidate.group_fingerprint.clone(),
            known_item_ids: vec!["item-1".into(), "item-2".into()],
        };
        library
            .refresh_aladin_items(
                &work_id,
                "missing-anchor".into(),
                config,
                vec![initial[0].clone()],
            )
            .unwrap();
        let source_count: i64 = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM collection_volume_sources WHERE collection_id = ?1",
                [&work_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(source_count, 2);

        let unrelated = vec![item("other", "다른책", 1, "B출판", None, None)];
        let error = library.refresh_aladin_items(
            &work_id,
            "missing-anchor".into(),
            ProviderConfig {
                version: 1,
                query: "던전밥".into(),
                group_fingerprint: candidate.group_fingerprint,
                known_item_ids: vec!["item-1".into()],
            },
            unrelated,
        );
        assert!(matches!(error, Err(LibraryError::AmbiguousAladinBinding)));
    }
}
