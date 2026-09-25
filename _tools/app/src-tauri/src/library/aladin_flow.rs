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
    release_watch::{event_kind_str, pending_release_changes},
    Library,
};

pub(super) struct BookFlow<'a> {
    library: &'a Library,
    provider: &'static str,
}
impl Library {
    pub fn get_book_connection(
        &self,
        collection_id: &str,
    ) -> Result<Option<AladinConnection>, LibraryError> {
        match self.get_kakao_connection(collection_id)? {
            Some(connection) => Ok(Some(connection)),
            None => self.get_aladin_connection(collection_id),
        }
    }

    pub(super) fn book_flow(&self, provider: &'static str) -> BookFlow<'_> {
        BookFlow {
            library: self,
            provider,
        }
    }
    pub fn search_aladin(
        &self,
        key: &str,
        query: &str,
    ) -> Result<Vec<AladinSeriesCandidate>, LibraryError> {
        self.book_flow("aladin").search_aladin(key, query)
    }
    pub fn apply_aladin(
        &self,
        key: &str,
        request: AladinApplyRequest,
    ) -> Result<AladinSyncResult, LibraryError> {
        self.book_flow("aladin").apply_aladin(key, request)
    }
    pub fn refresh_aladin(
        &self,
        key: &str,
        collection_id: &str,
    ) -> Result<AladinSyncResult, LibraryError> {
        self.book_flow("aladin").refresh_aladin(key, collection_id)
    }
    pub fn get_aladin_connection(
        &self,
        collection_id: &str,
    ) -> Result<Option<AladinConnection>, LibraryError> {
        self.book_flow("aladin")
            .get_aladin_connection(collection_id)
    }
    pub fn search_kakao(
        &self,
        key: &str,
        query: &str,
    ) -> Result<Vec<AladinSeriesCandidate>, LibraryError> {
        self.book_flow("kakao").search_aladin(key, query)
    }
    pub fn apply_kakao(
        &self,
        key: &str,
        request: AladinApplyRequest,
    ) -> Result<AladinSyncResult, LibraryError> {
        self.book_flow("kakao").apply_aladin(key, request)
    }
    pub fn refresh_kakao(
        &self,
        key: &str,
        collection_id: &str,
    ) -> Result<AladinSyncResult, LibraryError> {
        self.book_flow("kakao").refresh_aladin(key, collection_id)
    }
    pub fn get_kakao_connection(
        &self,
        collection_id: &str,
    ) -> Result<Option<AladinConnection>, LibraryError> {
        self.book_flow("kakao").get_aladin_connection(collection_id)
    }
    /// [`Self::apply_kakao`] for a pick the tablet made earlier (`collection_binding_sync.rs`):
    /// the same search and apply, tolerating anchor drift (see
    /// [`BookFlow::apply_requested_items`]).
    pub(crate) fn apply_requested_kakao(
        &self,
        key: &str,
        request: AladinApplyRequest,
    ) -> Result<AladinSyncResult, LibraryError> {
        let flow = self.book_flow("kakao");
        let items = flow.search_items(key, &request.query)?;
        flow.apply_requested_items(request, items)
    }
}

#[derive(Debug, Clone)]
struct GroupedSeries {
    candidate: AladinSeriesCandidate,
    items: Vec<AladinItem>,
}

/// At most this many groups of one search may be bound together.
pub(crate) const MAX_BOUND_GROUPS: usize = 10;

/// One bound group as stored: refresh re-finds it by its anchor item, or by its fingerprint
/// together with an item it already provided.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoundGroup {
    anchor_item_id: String,
    group_fingerprint: String,
    known_item_ids: Vec<String>,
}

/// `provider_config_json` of a Kakao/Aladin binding. Version 1 (one group; its anchor is
/// the binding's `external_id`) is still written for a single group so older builds keep
/// reading it; version 2 lists every group and is written only for several groups.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderConfig {
    query: String,
    groups: Vec<BoundGroup>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    version: u8,
    query: String,
    #[serde(default)]
    group_fingerprint: Option<String>,
    #[serde(default)]
    known_item_ids: Vec<String>,
    #[serde(default)]
    groups: Vec<BoundGroup>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigV1<'a> {
    version: u8,
    query: &'a str,
    group_fingerprint: &'a str,
    known_item_ids: &'a [String],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigV2<'a> {
    version: u8,
    query: &'a str,
    groups: &'a [BoundGroup],
}

impl ProviderConfig {
    fn parse(json: &str, external_id: &str) -> Option<Self> {
        let stored: StoredConfig = serde_json::from_str(json).ok()?;
        let groups = match stored.version {
            1 => vec![BoundGroup {
                anchor_item_id: external_id.to_owned(),
                group_fingerprint: stored.group_fingerprint?,
                known_item_ids: stored.known_item_ids,
            }],
            2 if (1..=MAX_BOUND_GROUPS).contains(&stored.groups.len()) => stored.groups,
            _ => return None,
        };
        Some(Self {
            query: stored.query,
            groups,
        })
    }

    fn to_json(&self) -> Result<String, LibraryError> {
        let json = match self.groups.as_slice() {
            [group] => serde_json::to_string(&ConfigV1 {
                version: 1,
                query: &self.query,
                group_fingerprint: &group.group_fingerprint,
                known_item_ids: &group.known_item_ids,
            }),
            groups => serde_json::to_string(&ConfigV2 {
                version: 2,
                query: &self.query,
                groups,
            }),
        };
        json.map_err(|_| LibraryError::InvalidAladinResponse)
    }
}

/// The groups of a stored binding as (anchor item id, fingerprint), for the tablet-request
/// applier's "already applied" check. `None` when the config is unreadable.
pub(super) fn bound_group_keys(
    config_json: Option<&str>,
    external_id: &str,
) -> Option<Vec<(String, String)>> {
    let config = ProviderConfig::parse(config_json?, external_id)?;
    Some(
        config
            .groups
            .into_iter()
            .map(|group| (group.anchor_item_id, group.group_fingerprint))
            .collect(),
    )
}

/// One group of the search being bound, with the anchor and known items stored for it.
struct PickedGroup {
    anchor_item_id: String,
    known_item_ids: Vec<String>,
    series: GroupedSeries,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StoredAladinSource {
    pub(super) provider_item_id: String,
    pub(super) title: String,
    pub(super) author: Option<String>,
    pub(super) publisher: Option<String>,
    pub(super) isbn13: Option<String>,
    pub(super) publication_date: Option<String>,
    pub(super) item_url: Option<String>,
    pub(super) provider_data_json: String,
}

#[derive(Debug)]
pub(super) struct AladinReconcileOutcome {
    pub(super) sync_result: AladinSyncResult,
    pub(super) release_event_count: u64,
}

fn valid_selection(request: &AladinApplyRequest) -> bool {
    let count = request.groups.len();
    (1..=MAX_BOUND_GROUPS).contains(&count)
        && request.groups.iter().enumerate().all(|(index, group)| {
            request.groups[..index]
                .iter()
                .all(|earlier| earlier.group_fingerprint != group.group_fingerprint)
        })
}

impl BookFlow<'_> {
    fn search_items(&self, key: &str, query: &str) -> Result<Vec<AladinItem>, LibraryError> {
        match self.provider {
            "kakao" => super::kakao_books::search(key, query),
            _ => aladin::search(key, query),
        }
    }
    pub fn search_aladin(
        &self,
        ttb_key: &str,
        query: &str,
    ) -> Result<Vec<AladinSeriesCandidate>, LibraryError> {
        Ok(group_items(self.search_items(ttb_key, query)?))
    }

    pub fn apply_aladin(
        &self,
        ttb_key: &str,
        request: AladinApplyRequest,
    ) -> Result<AladinSyncResult, LibraryError> {
        if !valid_selection(&request) {
            return Err(LibraryError::AmbiguousAladinBinding);
        }
        let items = self.search_items(ttb_key, &request.query)?;
        self.apply_aladin_items(request, items)
    }

    pub fn refresh_aladin(
        &self,
        ttb_key: &str,
        collection_id: &str,
    ) -> Result<AladinSyncResult, LibraryError> {
        let config = self.aladin_binding_config(collection_id)?;
        let items = self.search_items(ttb_key, &config.query)?;
        self.refresh_aladin_items(collection_id, config, items)
    }

    fn refresh_aladin_items(
        &self,
        collection_id: &str,
        config: ProviderConfig,
        items: Vec<AladinItem>,
    ) -> Result<AladinSyncResult, LibraryError> {
        let checked_at = chrono::Utc::now().to_rfc3339();
        Ok(self
            .refresh_aladin_items_with_config_at(collection_id, config, items, &checked_at)?
            .sync_result)
    }

    pub(super) fn refresh_aladin_items_at(
        &self,
        collection_id: &str,
        items: Vec<AladinItem>,
        checked_at: &str,
    ) -> Result<AladinReconcileOutcome, LibraryError> {
        let config = self.aladin_binding_config(collection_id)?;
        self.refresh_aladin_items_with_config_at(collection_id, config, items, checked_at)
    }

    /// Re-finds every bound group in a fresh search: the one group holding its anchor item,
    /// or the one with its fingerprint holding an item it provided before. Any bound group
    /// found zero or several times refuses the refresh. Two bound groups the search now
    /// returns as one group are kept once (the provider merged them itself).
    fn refresh_aladin_items_with_config_at(
        &self,
        collection_id: &str,
        config: ProviderConfig,
        items: Vec<AladinItem>,
        checked_at: &str,
    ) -> Result<AladinReconcileOutcome, LibraryError> {
        let groups = grouped_items(items);
        let mut picked: Vec<PickedGroup> = Vec::new();
        for bound in config.groups {
            let mut matches = groups.iter().filter(|group| {
                group
                    .items
                    .iter()
                    .any(|item| item.item_id == bound.anchor_item_id)
                    || (group.candidate.group_fingerprint == bound.group_fingerprint
                        && group
                            .items
                            .iter()
                            .any(|item| bound.known_item_ids.contains(&item.item_id)))
            });
            let (Some(series), None) = (matches.next(), matches.next()) else {
                return Err(LibraryError::AmbiguousAladinBinding);
            };
            match picked.iter_mut().find(|pick| {
                pick.series.candidate.group_fingerprint == series.candidate.group_fingerprint
            }) {
                Some(pick) => pick.known_item_ids.extend(bound.known_item_ids),
                None => picked.push(PickedGroup {
                    anchor_item_id: bound.anchor_item_id,
                    known_item_ids: bound.known_item_ids,
                    series: series.clone(),
                }),
            }
        }
        self.reconcile_aladin_at(collection_id, &config.query, picked, checked_at)
    }

    pub fn get_aladin_connection(
        &self,
        collection_id: &str,
    ) -> Result<Option<AladinConnection>, LibraryError> {
        let connection = self.library.connection()?;
        require_collection(&connection, collection_id)?;
        let binding = connection
            .query_row(
                "SELECT external_id, provider_config_json, last_synced_at
                 FROM collection_external_bindings
                 WHERE collection_id = ?1 AND provider = ?2",
                params![collection_id, self.provider],
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
                let config = config_json
                    .as_deref()
                    .and_then(|json| ProviderConfig::parse(json, &anchor_item_id))
                    .ok_or(LibraryError::AmbiguousAladinBinding)?;
                Ok(AladinConnection {
                    provider: self.provider.to_owned(),
                    anchor_item_id,
                    query: config.query,
                    last_synced_at,
                })
            })
            .transpose()
    }

    fn aladin_binding_config(&self, collection_id: &str) -> Result<ProviderConfig, LibraryError> {
        let connection = self.library.connection()?;
        require_collection(&connection, collection_id)?;
        let (anchor, config): (String, Option<String>) = connection
            .query_row(
                "SELECT external_id, provider_config_json
                 FROM collection_external_bindings
                 WHERE collection_id = ?1 AND provider = ?2",
                params![collection_id, self.provider],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or(LibraryError::AmbiguousAladinBinding)?;
        config
            .as_deref()
            .and_then(|json| ProviderConfig::parse(json, &anchor))
            .ok_or(LibraryError::AmbiguousAladinBinding)
    }

    /// Binds exactly the picked groups: each must be in `items` with its anchor and
    /// fingerprint.
    fn apply_aladin_items(
        &self,
        request: AladinApplyRequest,
        items: Vec<AladinItem>,
    ) -> Result<AladinSyncResult, LibraryError> {
        if !valid_selection(&request) {
            return Err(LibraryError::AmbiguousAladinBinding);
        }
        let groups = grouped_items(items);
        let mut picked = Vec::with_capacity(request.groups.len());
        for selection in &request.groups {
            let mut matches = groups.iter().filter(|group| {
                group.candidate.anchor_item_id == selection.anchor_item_id
                    && group.candidate.group_fingerprint == selection.group_fingerprint
            });
            let (Some(series), None) = (matches.next(), matches.next()) else {
                return Err(LibraryError::AmbiguousAladinBinding);
            };
            picked.push(PickedGroup {
                anchor_item_id: selection.anchor_item_id.clone(),
                known_item_ids: Vec::new(),
                series: series.clone(),
            });
        }
        let checked_at = chrono::Utc::now().to_rfc3339();
        Ok(self
            .reconcile_aladin_at(&request.collection_id, &request.query, picked, &checked_at)?
            .sync_result)
    }

    /// The PC apply, except that a picked group whose anchor no longer matches the fresh
    /// search (the tablet's pick may be applied days later) binds the one group with the
    /// picked fingerprint, anchored at that group's current anchor. Each group is resolved
    /// on its own. The PC UI keeps the strict [`Self::apply_aladin_items`].
    pub(super) fn apply_requested_items(
        &self,
        mut request: AladinApplyRequest,
        items: Vec<AladinItem>,
    ) -> Result<AladinSyncResult, LibraryError> {
        let groups = grouped_items(items);
        for selection in &mut request.groups {
            let exact = groups.iter().any(|group| {
                group.candidate.anchor_item_id == selection.anchor_item_id
                    && group.candidate.group_fingerprint == selection.group_fingerprint
            });
            if !exact {
                let mut drifted = groups.iter().filter(|group| {
                    group.candidate.group_fingerprint == selection.group_fingerprint
                });
                match (drifted.next(), drifted.next()) {
                    (Some(group), None) => {
                        selection.anchor_item_id = group.candidate.anchor_item_id.clone()
                    }
                    _ => return Err(LibraryError::AmbiguousAladinBinding),
                }
            }
        }
        let items = groups.into_iter().flat_map(|group| group.items).collect();
        self.apply_aladin_items(request, items)
    }

    /// Writes the merged volumes of the picked groups and the binding. Groups are ordered
    /// by their lowest volume (then fingerprint); the first one's anchor is the binding's
    /// `external_id`. A volume number provided by several groups keeps the item
    /// [`compare_duplicate_preference`] prefers; the others count as ignored.
    fn reconcile_aladin_at(
        &self,
        collection_id: &str,
        query: &str,
        mut picked: Vec<PickedGroup>,
        checked_at: &str,
    ) -> Result<AladinReconcileOutcome, LibraryError> {
        if picked.is_empty() {
            return Err(LibraryError::AmbiguousAladinBinding);
        }
        picked.sort_by(|left, right| {
            let lowest = |pick: &PickedGroup| pick.series.items.first().map(|i| i.volume_number);
            lowest(left).cmp(&lowest(right)).then_with(|| {
                left.series
                    .candidate
                    .group_fingerprint
                    .cmp(&right.series.candidate.group_fingerprint)
            })
        });
        let config = ProviderConfig {
            query: query.trim().to_owned(),
            groups: picked
                .iter()
                .map(|pick| {
                    let mut known_item_ids = pick.known_item_ids.clone();
                    known_item_ids.extend(pick.series.items.iter().map(|i| i.item_id.clone()));
                    known_item_ids.sort();
                    known_item_ids.dedup();
                    BoundGroup {
                        anchor_item_id: pick.anchor_item_id.clone(),
                        group_fingerprint: pick.series.candidate.group_fingerprint.clone(),
                        known_item_ids,
                    }
                })
                .collect(),
        };
        let config_json = config.to_json()?;
        let snapshot_json = match picked.as_slice() {
            [pick] => serde_json::to_string(&pick.series.candidate),
            picks => serde_json::to_string(&serde_json::json!({
                "groups": picks.iter().map(|pick| &pick.series.candidate).collect::<Vec<_>>()
            })),
        }
        .map_err(|_| LibraryError::InvalidAladinResponse)?;
        let mut all_items: Vec<&AladinItem> =
            picked.iter().flat_map(|pick| &pick.series.items).collect();
        all_items.sort_by(|left, right| compare_duplicate_preference(left, right));
        let mut merged: BTreeMap<i64, &AladinItem> = BTreeMap::new();
        for item in &all_items {
            merged.entry(item.volume_number).or_insert(item);
        }
        let ignored = picked
            .iter()
            .map(|pick| pick.series.candidate.ignored_count)
            .sum::<u64>()
            + (all_items.len() - merged.len()) as u64;
        let anchor_item_id = picked[0].anchor_item_id.clone();

        let mut connection = self.library.connection()?;
        let transaction = connection.transaction()?;
        require_collection(&transaction, collection_id)?;
        let subscription_last_checked_at = transaction
            .query_row(
                "SELECT last_checked_at
                 FROM release_watch_subscriptions
                 WHERE collection_id = ?1 AND provider = ?2",
                params![collection_id, self.provider],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?;
        let mut result = AladinSyncResult {
            added: 0,
            updated: 0,
            unchanged: 0,
            ignored,
        };
        let mut release_event_count = 0;
        let tracks_ownership = self.provider != "kakao" || transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM collection_ownership_tracking WHERE collection_id=?1)",
                [collection_id], |row| row.get::<_, bool>(0),
            )?;
        for item in merged.values() {
            let existing = reconcile_source(
                self.provider,
                &transaction,
                collection_id,
                item,
                checked_at,
                &mut result,
            )?;
            if let Some(previous_checked_at) = subscription_last_checked_at.as_ref().filter(|_| tracks_ownership) {
                for change in pending_release_changes(
                    existing.as_ref(),
                    item,
                    previous_checked_at.as_deref(),
                    checked_at,
                ) {
                    transaction.execute(
                        "INSERT INTO release_watch_events (
                            id, collection_id, event_kind, volume_number,
                            previous_value, current_value, detected_at, read_at, provider
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)",
                        params![
                            uuid::Uuid::new_v4().to_string(),
                            collection_id,
                            event_kind_str(change.kind),
                            change.volume_number,
                            change.previous_value,
                            change.current_value,
                            checked_at,
                            self.provider,
                        ],
                    )?;
                    release_event_count += 1;
                }
            }
        }
        super::external_binding::upsert_external_binding(
            &transaction,
            collection_id,
            ExternalBindingInput {
                provider: self.provider.into(),
                external_id: anchor_item_id,
                provider_config_json: Some(config_json),
                provider_data_json: Some(snapshot_json),
                last_synced_at: Some(checked_at.to_owned()),
            },
            checked_at,
        )?;
        if subscription_last_checked_at.is_some() {
            transaction.execute(
                "UPDATE release_watch_subscriptions SET last_checked_at = ?1
                 WHERE collection_id = ?2 AND provider = ?3",
                params![checked_at, collection_id, self.provider],
            )?;
        }
        if self.provider == "kakao" {
            transaction.execute(
                "INSERT INTO release_watch_subscriptions (collection_id, provider, last_checked_at)
                 SELECT collection_id, 'kakao', ?2 FROM release_watch_subscriptions
                 WHERE collection_id = ?1 AND provider = 'aladin'
                 ON CONFLICT(collection_id, provider) DO NOTHING",
                params![collection_id, checked_at],
            )?;
            transaction.execute("DELETE FROM release_watch_subscriptions WHERE collection_id = ?1 AND provider = 'aladin'", [collection_id])?;
        }
        transaction.commit()?;
        Ok(AladinReconcileOutcome {
            sync_result: result,
            release_event_count,
        })
    }
}

fn reconcile_source(
    provider: &str,
    transaction: &Transaction<'_>,
    collection_id: &str,
    item: &AladinItem,
    now: &str,
    result: &mut AladinSyncResult,
) -> Result<Option<StoredAladinSource>, LibraryError> {
    let existing: Option<StoredAladinSource> = transaction
        .query_row(
            "SELECT provider_item_id, title, author, publisher, isbn13,
                    publication_date, item_url, provider_data_json
             FROM collection_volume_sources
             WHERE collection_id = ?1 AND volume_number = ?2 AND provider = ?3",
            params![collection_id, item.volume_number, provider],
            |row| {
                Ok(StoredAladinSource {
                    provider_item_id: row.get(0)?,
                    title: row.get(1)?,
                    author: row.get(2)?,
                    publisher: row.get(3)?,
                    isbn13: row.get(4)?,
                    publication_date: row.get(5)?,
                    item_url: row.get(6)?,
                    provider_data_json: row.get(7)?,
                })
            },
        )
        .optional()?;
    let current = StoredAladinSource {
        provider_item_id: item.item_id.clone(),
        title: item.title.trim().to_owned(),
        author: item.author.clone(),
        publisher: item.publisher.clone(),
        isbn13: item.isbn13.clone(),
        publication_date: item.publication_date.clone(),
        item_url: item.item_url.clone(),
        provider_data_json: item.snapshot_json.clone(),
    };
    match existing.as_ref() {
        None => result.added += 1,
        Some(stored) if stored == &current => result.unchanged += 1,
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
                provider,
                current.provider_item_id,
                current.title,
                current.author,
                current.publisher,
                current.isbn13,
                current.publication_date,
                current.item_url,
                current.provider_data_json,
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
    Ok(existing)
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

pub(super) fn group_items(items: Vec<AladinItem>) -> Vec<AladinSeriesCandidate> {
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
    use super::{group_items, BoundGroup, ProviderConfig};
    use crate::library::{
        aladin::AladinItem,
        error::LibraryError,
        models::{
            AladinApplyRequest, AladinGroupSelection, CollectionType, CreateCollection,
            ExternalBindingInput, ReleaseWatchEventKind,
        },
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
            groups: vec![AladinGroupSelection {
                anchor_item_id: candidate.anchor_item_id,
                group_fingerprint: candidate.group_fingerprint,
            }],
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
            .book_flow("aladin")
            .apply_aladin_items(request(&work_id, &items), items.clone())
            .unwrap();
        assert_eq!((first.added, first.updated, first.unchanged), (2, 0, 0));
        let second = library
            .book_flow("aladin")
            .apply_aladin_items(request(&work_id, &items), items.clone())
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

        let result = library.book_flow("aladin").apply_aladin_items(
            request(&target_id, &items),
            items,
        );
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
            .book_flow("aladin")
            .apply_aladin_items(request(&work_id, &initial), initial.clone())
            .unwrap();
        let candidate = group_items(initial.clone()).remove(0);
        let config = ProviderConfig {
            query: "던전밥".into(),
            groups: vec![BoundGroup {
                anchor_item_id: "missing-anchor".into(),
                group_fingerprint: candidate.group_fingerprint.clone(),
                known_item_ids: vec!["item-1".into(), "item-2".into()],
            }],
        };
        library
            .book_flow("aladin")
            .refresh_aladin_items(&work_id, config, vec![initial[0].clone()])
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
        let error = library.book_flow("aladin").refresh_aladin_items(
            &work_id,
            ProviderConfig {
                query: "던전밥".into(),
                groups: vec![BoundGroup {
                    anchor_item_id: "missing-anchor".into(),
                    group_fingerprint: candidate.group_fingerprint,
                    known_item_ids: vec!["item-1".into()],
                }],
            },
            unrelated,
        );
        assert!(matches!(error, Err(LibraryError::AmbiguousAladinBinding)));
    }

    #[test]
    fn watched_refresh_records_release_changes_once() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let work_id = create_work(&library, "던전밥");
        let initial = vec![item(
            "item-1",
            "던전밥",
            1,
            "A출판",
            Some("9781"),
            Some("2026-08-21"),
        )];
        library
            .book_flow("aladin")
            .apply_aladin_items(request(&work_id, &initial), initial)
            .unwrap();
        library.set_release_watch_enabled(&work_id, true).unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE release_watch_subscriptions
                 SET last_checked_at = '2026-08-20T00:00:00Z'
                 WHERE collection_id = ?1",
                [&work_id],
            )
            .unwrap();
        let refreshed = vec![
            item(
                "item-1",
                "던전밥",
                1,
                "A출판",
                Some("9781"),
                Some("2026-08-20"),
            ),
            item(
                "item-2",
                "던전밥",
                2,
                "A출판",
                Some("9782"),
                Some("2026-09-01"),
            ),
        ];

        let first = library
            .book_flow("aladin")
            .refresh_aladin_items_at(&work_id, refreshed.clone(), "2026-08-22T00:00:00Z")
            .unwrap();
        assert_eq!(first.release_event_count, 3);
        assert_eq!(
            library
                .take_unread_release_changes(&work_id)
                .unwrap()
                .iter()
                .map(|event| event.kind)
                .collect::<Vec<_>>(),
            vec![
                ReleaseWatchEventKind::ReleaseDateChanged,
                ReleaseWatchEventKind::ReleaseStatusChanged,
                ReleaseWatchEventKind::NewVolume,
            ]
        );

        let second = library
            .book_flow("aladin")
            .refresh_aladin_items_at(&work_id, refreshed, "2026-08-22T00:00:00Z")
            .unwrap();
        assert_eq!(second.release_event_count, 0);
        assert!(library
            .take_unread_release_changes(&work_id)
            .unwrap()
            .is_empty());
        assert_eq!(
            library
                .get_release_watch_status(&work_id)
                .unwrap()
                .last_checked_at
                .as_deref(),
            Some("2026-08-22T00:00:00Z")
        );
    }

    #[test]
    fn unwatched_aladin_reconciliation_creates_no_release_events() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let work_id = create_work(&library, "던전밥");
        let initial = vec![item("item-1", "던전밥", 1, "A출판", Some("9781"), None)];
        library
            .book_flow("aladin")
            .apply_aladin_items(request(&work_id, &initial), initial)
            .unwrap();
        library
            .book_flow("aladin")
            .refresh_aladin_items_at(
                &work_id,
                vec![
                    item("item-1", "던전밥", 1, "A출판", Some("9781"), None),
                    item("item-2", "던전밥", 2, "A출판", Some("9782"), None),
                ],
                "2026-08-22T00:00:00Z",
            )
            .unwrap();

        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM release_watch_events", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn release_watch_state_rolls_back_with_source_reconciliation() {
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
                 ) VALUES (?1, 2, 'aladin', 'shared-item', '기존 2권', '{}', 't', 't')",
                [&owner_id],
            )
            .unwrap();
        let initial = vec![item(
            "item-1",
            "던전밥",
            1,
            "A출판",
            Some("9781"),
            Some("2026-08-21"),
        )];
        library
            .book_flow("aladin")
            .apply_aladin_items(request(&target_id, &initial), initial)
            .unwrap();
        library.set_release_watch_enabled(&target_id, true).unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE release_watch_subscriptions
                 SET last_checked_at = '2026-08-20T00:00:00Z'
                 WHERE collection_id = ?1",
                [&target_id],
            )
            .unwrap();

        let result = library.book_flow("aladin").refresh_aladin_items_at(
            &target_id,
            vec![
                item(
                    "item-1",
                    "던전밥",
                    1,
                    "A출판",
                    Some("9781"),
                    Some("2026-08-20"),
                ),
                item("shared-item", "던전밥", 2, "A출판", Some("9782"), None),
            ],
            "2026-08-22T00:00:00Z",
        );
        assert!(matches!(
            result,
            Err(LibraryError::DuplicateAladinProviderItem)
        ));
        let connection = library.connection().unwrap();
        let state: (Option<String>, i64, Option<String>) = connection
            .query_row(
                "SELECT
                    (SELECT publication_date FROM collection_volume_sources
                     WHERE collection_id = ?1 AND volume_number = 1 AND provider = 'aladin'),
                    (SELECT COUNT(*) FROM release_watch_events WHERE collection_id = ?1),
                    (SELECT last_checked_at FROM release_watch_subscriptions
                     WHERE collection_id = ?1 AND provider = 'aladin')",
                [&target_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            state,
            (
                Some("2026-08-21".into()),
                0,
                Some("2026-08-20T00:00:00Z".into())
            )
        );
    }
    #[test]
    fn kakao_connection_preserves_aladin_sources_volume_ids_and_transfers_watch() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "사용자 작품명");
        let old = vec![item(
            "aladin-1",
            "스틸 볼 런",
            1,
            "문학동네",
            Some("9788954677530"),
            Some("2020-01-01"),
        )];
        library
            .book_flow("aladin")
            .apply_aladin_items(request(&id, &old), old)
            .unwrap();
        library.set_release_watch_enabled(&id, true).unwrap();
        let before: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT id FROM collection_volumes WHERE collection_id = ?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        let newer = vec![item(
            "isbn13:9788954677530",
            "스틸 볼 런",
            1,
            "문학동네",
            Some("9788954677530"),
            Some("2021-01-01"),
        )];
        library
            .book_flow("kakao")
            .apply_aladin_items(request(&id, &newer), newer.clone())
            .unwrap();
        assert!(library.get_aladin_connection(&id).unwrap().is_some());
        assert!(library.get_kakao_connection(&id).unwrap().is_some());
        let after: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT id FROM collection_volumes WHERE collection_id = ?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(before, after);
        let sources: i64 = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM collection_volume_sources WHERE collection_id = ?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sources, 2);
        let provider: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT provider FROM release_watch_subscriptions WHERE collection_id = ?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(provider, "kakao");
        assert!(library.take_unread_release_changes(&id).unwrap().is_empty());
        library.set_owned_volume_count(&id, 0, 1).unwrap();
        let mut refreshed = newer;
        refreshed.push(item(
            "isbn13:new-2",
            "스틸 볼 런",
            2,
            "문학동네",
            Some("new-2"),
            Some("2026-10-01"),
        ));
        library
            .book_flow("kakao")
            .refresh_aladin_items_at(&id, refreshed, "2026-09-06T00:00:00Z")
            .unwrap();
        let events = library.take_unread_release_changes(&id).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].volume_number, 2);
        assert_eq!(events[0].kind, ReleaseWatchEventKind::NewVolume);
        library.set_release_watch_enabled(&id, false).unwrap();
        assert!(!library.get_release_watch_status(&id).unwrap().enabled);
    }
    #[test]
    fn kakao_refreshes_all_but_notifies_only_explicit_count_and_subscription() {
        for (entered, enabled, expected) in [(false,false,0), (false,true,0), (true,false,0), (true,true,1)] {
            let temp = tempfile::tempdir().unwrap();
            let library = Library::open(temp.path()).unwrap();
            let id = create_work(&library, "던전밥");
            let initial = vec![item("isbn:one", "던전밥", 1, "A출판", Some("9781"), Some("2020-01-01"))];
            library.book_flow("kakao").apply_aladin_items(request(&id, &initial), initial.clone()).unwrap();
            if enabled { library.set_release_watch_enabled(&id, true).unwrap(); }
            if entered { library.set_owned_volume_count(&id, 0, 0).unwrap(); }
            let mut updated = initial;
            updated.push(item("isbn:two", "던전밥", 2, "A출판", Some("9782"), Some("2099-10-01")));
            let result = library.book_flow("kakao").refresh_aladin_items_at(&id, updated.clone(), "2026-09-13T00:00:00Z").unwrap();
            assert_eq!(result.sync_result.added, 1);
            let inbox = library.list_release_inbox().unwrap();
            assert_eq!(inbox.len(), expected, "entered={entered}, enabled={enabled}");
            if expected > 0 { assert_eq!(inbox[0].provider, "kakao"); assert_eq!(inbox[0].event.current_value.as_deref(), Some("2099-10-01")); }
            library.book_flow("kakao").refresh_aladin_items_at(&id, updated, "2026-09-14T00:00:00Z").unwrap();
            assert_eq!(library.list_release_inbox().unwrap().len(), expected);
        }
    }


    /// A real split (user report 2026-09-26, "찍히지 않습니다"): the library's binding holds only
    /// vol. 7 (S코믹스, two vol-7 products); vols 1-6 are a separate Kakao group. The
    /// production library only shows the bound group, so the other group's differing field
    /// is assumed here to be the publisher (S코믹스 is an imprint of 소미미디어).
    fn ghost(id: &str, volume: i64, publisher: &str, isbn13: Option<&str>, date: &str) -> AladinItem {
        AladinItem {
            item_id: id.into(),
            title: format!("찍히지 않습니다 {volume}"),
            author: Some("코노시마 루카".into()),
            publisher: Some(publisher.into()),
            isbn13: isbn13.map(Into::into),
            publication_date: Some(date.into()),
            item_url: None,
            volume_number: volume,
            base_title: "찍히지 않습니다".into(),
            snapshot_json: format!(r#"{{"itemId":"{id}"}}"#),
        }
    }

    fn ghost_items() -> Vec<AladinItem> {
        let mut items: Vec<_> = (1..=6)
            .map(|n| ghost(&format!("isbn13:97911384900{n}0"), n, "소미미디어", Some(&format!("97911384900{n}0")), &format!("2025-0{n}-10")))
            .collect();
        items.push(ghost("isbn13:9791138491150", 7, "S코믹스", Some("9791138491150"), "2026-07-22"));
        items.push(ghost("isbn13:9791138491167", 7, "S코믹스", Some("9791138491167"), "2026-07-22"));
        items
    }

    fn select_all(collection_id: &str, items: &[AladinItem]) -> AladinApplyRequest {
        AladinApplyRequest {
            collection_id: collection_id.into(),
            query: "찍히지 않습니다".into(),
            groups: group_items(items.to_vec())
                .into_iter()
                .map(|group| AladinGroupSelection {
                    anchor_item_id: group.anchor_item_id,
                    group_fingerprint: group.group_fingerprint,
                })
                .collect(),
        }
    }

    fn kakao_sources(library: &Library, id: &str) -> Vec<(i64, String)> {
        library
            .connection()
            .unwrap()
            .prepare("SELECT volume_number, provider_item_id FROM collection_volume_sources WHERE collection_id = ?1 AND provider = 'kakao' ORDER BY volume_number")
            .unwrap()
            .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn kakao_binding(library: &Library, id: &str) -> (String, serde_json::Value) {
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT external_id, provider_config_json FROM collection_external_bindings WHERE collection_id = ?1 AND provider = 'kakao'",
                [id],
                |row| Ok((row.get::<_, String>(0)?, serde_json::from_str(&row.get::<_, String>(1)?).unwrap())),
            )
            .unwrap()
    }

    #[test]
    fn several_groups_bind_together_and_merge_volumes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "찍히지 않습니다");
        let items = ghost_items();
        assert_eq!(group_items(items.clone()).len(), 2);
        let result = library
            .book_flow("kakao")
            .apply_aladin_items(select_all(&id, &items), items.clone())
            .unwrap();
        assert_eq!((result.added, result.ignored), (7, 1));
        let sources = kakao_sources(&library, &id);
        assert_eq!(sources.iter().map(|s| s.0).collect::<Vec<_>>(), (1..=7).collect::<Vec<_>>());
        assert_eq!(sources[6].1, "isbn13:9791138491150");
        let (external, config) = kakao_binding(&library, &id);
        // The group holding the lowest volume comes first and anchors the binding.
        assert_eq!(external, "isbn13:9791138490010");
        assert_eq!(config["version"], 2);
        assert_eq!(config["groups"].as_array().unwrap().len(), 2);
        assert_eq!(config["groups"][1]["anchorItemId"], "isbn13:9791138491150");
        assert_eq!(config["groups"][1]["knownItemIds"], serde_json::json!(["isbn13:9791138491150"]));
        assert_eq!(library.get_kakao_connection(&id).unwrap().unwrap().anchor_item_id, external);

        // A missing group, a repeated fingerprint or an empty pick is refused.
        let mut partial = select_all(&id, &items);
        partial.groups[1].anchor_item_id = "gone".into();
        assert!(matches!(library.book_flow("kakao").apply_aladin_items(partial, items.clone()), Err(LibraryError::AmbiguousAladinBinding)));
        let mut repeated = select_all(&id, &items);
        repeated.groups[1] = repeated.groups[0].clone();
        assert!(matches!(library.book_flow("kakao").apply_aladin_items(repeated, items.clone()), Err(LibraryError::AmbiguousAladinBinding)));
        let mut empty = select_all(&id, &items);
        empty.groups.clear();
        assert!(matches!(library.book_flow("kakao").apply_aladin_items(empty, items), Err(LibraryError::AmbiguousAladinBinding)));
    }

    #[test]
    fn a_volume_in_several_groups_keeps_the_preferred_item() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "찍히지 않습니다");
        let mut items = ghost_items();
        // The old imprint also lists vol. 7, without an ISBN: the S코믹스 item with one wins.
        items.push(ghost("url:old-7", 7, "소미미디어", None, "2026-07-30"));
        let result = library
            .book_flow("kakao")
            .apply_aladin_items(select_all(&id, &items), items)
            .unwrap();
        assert_eq!((result.added, result.ignored), (7, 2));
        assert_eq!(kakao_sources(&library, &id)[6].1, "isbn13:9791138491150");
    }

    #[test]
    fn refresh_refinds_every_group_including_anchor_drift() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "찍히지 않습니다");
        let items = ghost_items();
        library
            .book_flow("kakao")
            .apply_aladin_items(select_all(&id, &items), items.clone())
            .unwrap();
        library.set_release_watch_enabled(&id, true).unwrap();
        library.set_owned_volume_count(&id, 0, 7).unwrap();
        // Vol. 1 (the first group's anchor) left the search; vol. 8 appeared in the second.
        let mut refreshed: Vec<_> = items.into_iter().skip(1).collect();
        refreshed.push(ghost("isbn13:9791138491174", 8, "S코믹스", Some("9791138491174"), "2026-11-20"));
        let outcome = library
            .book_flow("kakao")
            .refresh_aladin_items_at(&id, refreshed.clone(), "2026-09-26T00:00:00Z")
            .unwrap();
        assert_eq!(outcome.sync_result.added, 1);
        assert_eq!(kakao_sources(&library, &id).len(), 8);
        // Release watch sees the merged volume set: only vol. 8 is new.
        let events = library.take_unread_release_changes(&id).unwrap();
        assert_eq!(events.iter().map(|e| (e.volume_number, e.kind)).collect::<Vec<_>>(), vec![(8, ReleaseWatchEventKind::NewVolume)]);
        let (external, config) = kakao_binding(&library, &id);
        assert_eq!(external, "isbn13:9791138490010");
        assert_eq!(config["groups"][1]["knownItemIds"].as_array().unwrap().len(), 2);

        // A group that vanished from the search refuses the refresh.
        let only_first: Vec<_> = refreshed.into_iter().filter(|item| item.volume_number < 7).collect();
        assert!(matches!(
            library.book_flow("kakao").refresh_aladin_items_at(&id, only_first, "2026-09-27T00:00:00Z"),
            Err(LibraryError::AmbiguousAladinBinding)
        ));
    }

    #[test]
    fn a_legacy_single_group_config_still_refreshes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "찍히지 않습니다");
        let items = ghost_items();
        let second = group_items(items.clone())
            .into_iter()
            .find(|group| group.publisher.as_deref() == Some("S코믹스"))
            .unwrap();
        // The exact shape stored in the production library before multi-group bindings.
        library
            .upsert_collection_external_binding(
                &id,
                ExternalBindingInput {
                    provider: "kakao".into(),
                    external_id: "isbn13:9791138491150".into(),
                    provider_config_json: Some(format!(
                        r#"{{"version":1,"query":"찍히지 않습니다","groupFingerprint":"{}","knownItemIds":["isbn13:9791138491150"]}}"#,
                        second.group_fingerprint
                    )),
                    provider_data_json: Some("{}".into()),
                    last_synced_at: None,
                },
            )
            .unwrap();
        library
            .book_flow("kakao")
            .refresh_aladin_items_at(&id, items, "2026-09-26T00:00:00Z")
            .unwrap();
        assert_eq!(kakao_sources(&library, &id), vec![(7, "isbn13:9791138491150".to_owned())]);
        let (external, config) = kakao_binding(&library, &id);
        assert_eq!(external, "isbn13:9791138491150");
        assert_eq!(config["version"], 1);
        assert_eq!(config["groupFingerprint"], serde_json::json!(second.group_fingerprint));
    }
}
