use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
};

use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    aladin::{is_edition_note, is_series_note, AladinItem, SearchOutcome, UNNUMBERED_VOLUME},
    collection::require_collection,
    collection_binding_sync::CommitCheck,
    collection_volume_range::load_transaction,
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
        self.get_kakao_connection(collection_id)
    }

    pub(super) fn book_flow(&self) -> BookFlow<'_> {
        BookFlow {
            library: self,
            provider: "kakao",
        }
    }
    pub fn search_kakao(
        &self,
        key: &str,
        query: &str,
    ) -> Result<Vec<AladinSeriesCandidate>, LibraryError> {
        self.book_flow().search_aladin(key, query)
    }
    pub fn apply_kakao(
        &self,
        key: &str,
        request: AladinApplyRequest,
    ) -> Result<AladinSyncResult, LibraryError> {
        self.book_flow().apply_aladin(key, request)
    }
    pub fn refresh_kakao(
        &self,
        key: &str,
        collection_id: &str,
    ) -> Result<AladinSyncResult, LibraryError> {
        self.book_flow().refresh_aladin(key, collection_id)
    }
    pub fn get_kakao_connection(
        &self,
        collection_id: &str,
    ) -> Result<Option<AladinConnection>, LibraryError> {
        self.book_flow().get_aladin_connection(collection_id)
    }
    /// [`Self::apply_kakao`] for a pick the tablet made earlier (`collection_binding_sync.rs`):
    /// the same search and apply, tolerating anchor drift (see
    /// [`BookFlow::apply_requested_items`]).
    /// `check` runs inside the transaction that writes the binding, after the search.
    pub(crate) fn apply_requested_kakao(
        &self,
        key: &str,
        request: AladinApplyRequest,
        check: CommitCheck<'_>,
    ) -> Result<AladinSyncResult, LibraryError> {
        let flow = self.book_flow();
        let items = flow.search_items(key, &request.query)?.items;
        flow.apply_requested_items(request, items, Some(check))
    }
}

#[derive(Debug, Clone)]
struct GroupedSeries {
    candidate: AladinSeriesCandidate,
    /// One product per volume, as bound.
    items: Vec<AladinItem>,
    /// Every product of the group, duplicates of a volume included: a stored binding is
    /// re-found by any of its item ids.
    member_ids: Vec<String>,
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

/// Anchor identity wins over metadata. Without it, prefer a unique known-item group;
/// narrow split known items by fingerprint. Picks without history use fingerprint alone.
fn refind_group<'a>(
    anchor: &str,
    fingerprint: &str,
    known_ids: &[String],
    groups: impl IntoIterator<Item = (&'a str, &'a [String])>,
) -> Option<usize> {
    let groups: Vec<_> = groups.into_iter().collect();
    let unique = |indices: Vec<usize>| match indices.as_slice() {
        [index] => Some(*index),
        _ => None,
    };
    let anchors: Vec<_> = groups.iter().enumerate()
        .filter(|(_, (_, ids))| ids.iter().any(|id| id == anchor))
        .map(|(index, _)| index).collect();
    if !anchors.is_empty() {
        return unique(anchors);
    }
    let known: Vec<_> = groups.iter().enumerate()
        .filter(|(_, (_, ids))| ids.iter().any(|id| known_ids.contains(id)))
        .map(|(index, _)| index).collect();
    if known.len() == 1 {
        return unique(known);
    }
    unique(groups.iter().enumerate()
        .filter(|(index, (key, _))| *key == fingerprint
            && (known_ids.is_empty() || known.contains(index)))
        .map(|(index, _)| index).collect())
}

/// A collapsed binding may hold several old picks. Resolve each pick using the same
/// anchor-first rule as refresh, then require coverage of every currently bound group.
pub(super) fn requested_groups_already_bound(
    config_json: Option<&str>,
    external_id: &str,
    request: &AladinApplyRequest,
) -> bool {
    let Some(config) = config_json.and_then(|json| ProviderConfig::parse(json, external_id)) else {
        return false;
    };
    let members: Vec<Vec<String>> = config.groups.iter().map(|group| {
        let mut ids = group.known_item_ids.clone();
        ids.push(group.anchor_item_id.clone());
        ids
    }).collect();
    let mut found = BTreeSet::new();
    for pick in &request.groups {
        let Some(index) = refind_group(&pick.anchor_item_id, &pick.group_fingerprint, &[],
            config.groups.iter().zip(&members)
                .map(|(group, ids)| (group.group_fingerprint.as_str(), ids.as_slice()))) else {
            return false;
        };
        found.insert(index);
    }
    !found.is_empty() && found.len() == config.groups.len()
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
    fn search_items(&self, key: &str, query: &str) -> Result<SearchOutcome, LibraryError> {
        super::kakao_books::search(key, query)
    }
    pub fn search_aladin(
        &self,
        ttb_key: &str,
        query: &str,
    ) -> Result<Vec<AladinSeriesCandidate>, LibraryError> {
        let outcome = self.search_items(ttb_key, query)?;
        let mut groups = group_items(outcome.items);
        for group in &mut groups {
            group.unparsed_count = outcome.unparsed_count;
        }
        Ok(groups)
    }

    pub fn apply_aladin(
        &self,
        ttb_key: &str,
        request: AladinApplyRequest,
    ) -> Result<AladinSyncResult, LibraryError> {
        if !valid_selection(&request) {
            return Err(LibraryError::AmbiguousAladinBinding);
        }
        super::collection_authority::collection_write_status(&*self.library.connection()?)?;
        let items = self.search_items(ttb_key, &request.query)?.items;
        self.apply_aladin_items(request, items)
    }

    pub fn refresh_aladin(
        &self,
        ttb_key: &str,
        collection_id: &str,
    ) -> Result<AladinSyncResult, LibraryError> {
        super::collection_authority::collection_write_status(&*self.library.connection()?)?;
        let config = self.aladin_binding_config(collection_id)?;
        let items = self.search_items(ttb_key, &config.query)?.items;
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

    /// Re-finds each bound group by anchor first, then known items and fingerprint.
    /// Metadata edits may split groups; two old groups may also collapse into one.
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
            let index = refind_group(&bound.anchor_item_id, &bound.group_fingerprint,
                &bound.known_item_ids, groups.iter().map(|group|
                    (group.candidate.group_fingerprint.as_str(), group.member_ids.as_slice())))
                .ok_or(LibraryError::AmbiguousAladinBinding)?;
            let series = &groups[index];
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
        self.reconcile_aladin_at(collection_id, &config.query, picked, checked_at, false, None)
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
        self.apply_aladin_items_checked(request, items, None)
    }

    fn apply_aladin_items_checked(
        &self,
        request: AladinApplyRequest,
        items: Vec<AladinItem>,
        check: Option<CommitCheck<'_>>,
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
            .reconcile_aladin_at(
                &request.collection_id,
                &request.query,
                picked,
                &checked_at,
                true,
                check,
            )?
            .sync_result)
    }

    /// Resolve delayed tablet picks by anchor first, then fingerprint if the anchor left.
    /// Collapse picks that now resolve to the same group. PC apply remains strict.
    pub(super) fn apply_requested_items(
        &self,
        request: AladinApplyRequest,
        items: Vec<AladinItem>,
        check: Option<CommitCheck<'_>>,
    ) -> Result<AladinSyncResult, LibraryError> {
        if !valid_selection(&request) {
            return Err(LibraryError::AmbiguousAladinBinding);
        }
        let groups = grouped_items(items);
        let mut picked: Vec<PickedGroup> = Vec::new();
        for selection in &request.groups {
            let index = refind_group(&selection.anchor_item_id, &selection.group_fingerprint,
                &[], groups.iter().map(|group|
                    (group.candidate.group_fingerprint.as_str(), group.member_ids.as_slice())))
                .ok_or(LibraryError::AmbiguousAladinBinding)?;
            let series = &groups[index];
            if let Some(pick) = picked.iter_mut().find(|pick|
                pick.series.candidate.group_fingerprint == series.candidate.group_fingerprint) {
                pick.known_item_ids.push(selection.anchor_item_id.clone());
            } else {
                picked.push(PickedGroup {
                    anchor_item_id: series.candidate.anchor_item_id.clone(),
                    known_item_ids: vec![selection.anchor_item_id.clone()],
                    series: series.clone(),
                });
            }
        }
        Ok(self.reconcile_aladin_at(&request.collection_id, &request.query, picked,
            &chrono::Utc::now().to_rfc3339(), true, check)?.sync_result)
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
        quiet_bind: bool,
        check: Option<CommitCheck<'_>>,
    ) -> Result<AladinReconcileOutcome, LibraryError> {
        if picked.is_empty() {
            return Err(LibraryError::AmbiguousAladinBinding);
        }
        picked.sort_by(|left, right| {
            let lowest = |pick: &PickedGroup| pick.series.items.first().map(|i| i.volume_number.max(1));
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
        let mut config_json = config.to_json()?;
        // The search-wide excluded count is not part of the stored group.
        let stored_candidates: Vec<AladinSeriesCandidate> = picked
            .iter()
            .map(|pick| AladinSeriesCandidate {
                unparsed_count: 0,
                ..pick.series.candidate.clone()
            })
            .collect();
        let snapshot_json = match stored_candidates.as_slice() {
            [candidate] => serde_json::to_string(candidate),
            candidates => serde_json::to_string(&serde_json::json!({ "groups": candidates })),
        }
        .map_err(|_| LibraryError::InvalidAladinResponse)?;
        let mut all_items: Vec<&AladinItem> =
            picked.iter().flat_map(|pick| &pick.series.items).collect();
        all_items.sort_by(|left, right| compare_duplicate_preference(left, right));
        let mut merged: BTreeMap<i64, AladinItem> = BTreeMap::new();
        for item in &all_items {
            // Keep the unnumbered sentinel through final preference sorting, then map to 1.
            merged.entry(item.volume_number.max(1)).or_insert_with(|| {
                let mut item = (**item).clone();
                item.volume_number = item.volume_number.max(1);
                item
            });
        }
        let ignored = picked
            .iter()
            .map(|pick| pick.series.candidate.ignored_count)
            .sum::<u64>()
            + (all_items.len() - merged.len()) as u64;
        let anchor_item_id = picked[0].anchor_item_id.clone();

        let mut connection = self.library.connection()?;
        let transaction = connection.transaction()?;
        let authority = super::collection_authority::collection_write_status(&transaction)?;
        require_collection(&transaction, collection_id)?;
        if let Some(check) = check {
            check(&transaction)?;
        }
        let volumes: Vec<i64> = merged.keys().copied().collect();
        if super::kakao_review::dismissed_for_volumes(&transaction, collection_id, &volumes)? {
            let mut next: serde_json::Value = serde_json::from_str(&config_json).map_err(|_| LibraryError::InvalidAladinResponse)?;
            next["reviewDismissedVolumes"] = serde_json::json!(volumes);
            config_json = next.to_string();
        }
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
        let tracks_ownership = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_ownership_tracking WHERE collection_id=?1)",
            [collection_id],
            |row| row.get::<_, bool>(0),
        )?;
        let volume_range = load_transaction(&transaction, collection_id)?;
        // A subscription row (even with a check timestamp) is not provider history.
        // Bind/rebind is always quiet; a migrated binding first records its sources.
        let baseline_established = !quiet_bind && transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_volume_sources WHERE collection_id=?1 AND provider=?2)",
            params![collection_id, self.provider],
            |row| row.get::<_, bool>(0),
        )?;
        for item in merged.values() {
            // Check before reconciliation inserts the provider's edition-0 slot.
            // Other editions and providers also establish that this number is known.
            let volume_exists = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM collection_volumes WHERE collection_id=?1 AND volume_number=?2)",
                params![collection_id, item.volume_number],
                |row| row.get::<_, bool>(0),
            )?;
            let existing = reconcile_source(
                self.provider,
                &transaction,
                collection_id,
                item,
                checked_at,
                &mut result,
            )?;
            if let Some(previous_checked_at) = subscription_last_checked_at
                .as_ref()
                .filter(|_| tracks_ownership && baseline_established)
            {
                for change in pending_release_changes(
                    existing.as_ref(),
                    item,
                    previous_checked_at.as_deref(),
                    checked_at,
                ) {
                    if event_kind_str(change.kind) == "new_volume" && volume_exists {
                        continue;
                    }
                    if !volume_range.contains(change.volume_number) {
                        continue;
                    }
                    if authority.active {
                        super::collection_authority::enqueue_release_event(
                            &transaction,
                            &authority,
                            collection_id,
                            self.provider,
                            event_kind_str(change.kind),
                            change.volume_number,
                            change.previous_value.as_deref(),
                            change.current_value.as_deref(),
                            checked_at,
                        )?;
                    } else {
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
                    }
                    release_event_count += 1;
                }
            }
        }
        let binding_input = ExternalBindingInput {
            provider: self.provider.into(),
            external_id: anchor_item_id,
            provider_config_json: Some(config_json),
            provider_data_json: Some(snapshot_json),
            last_synced_at: Some(checked_at.to_owned()),
        };
        if authority.active {
            super::collection_authority::enqueue_provider_snapshot(
                &transaction,
                &authority,
                collection_id,
                &binding_input,
            )?;
        } else {
            super::external_binding::upsert_external_binding(
                &transaction,
                collection_id,
                binding_input,
                checked_at,
            )?;
        }
        if subscription_last_checked_at.is_some() {
            transaction.execute(
                "UPDATE release_watch_subscriptions SET last_checked_at = ?1
                 WHERE collection_id = ?2 AND provider = ?3",
                params![checked_at, collection_id, self.provider],
            )?;
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
    let authority = super::collection_authority::collection_write_status(transaction)?;
    let before = if authority.active {
        super::collection_authority::volume_source_state(
            transaction,
            collection_id,
            item.volume_number,
            provider,
        )?
    } else {
        serde_json::Value::Null
    };
    let volume_before = super::collection_authority::volume_slot_state(
        transaction,
        collection_id,
        item.volume_number,
        0,
    )?;
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
    if authority.active {
        let after = super::collection_authority::volume_source_state(
            transaction,
            collection_id,
            item.volume_number,
            provider,
        )?;
        super::collection_authority::enqueue_volume_source_changes(
            transaction,
            &authority,
            &before,
            after,
        )?;
        let volume_after = super::collection_authority::volume_slot_state(
            transaction,
            collection_id,
            item.volume_number,
            0,
        )?;
        super::collection_authority::enqueue_volume_changes(
            transaction,
            &authority,
            &volume_before,
            volume_after,
        )?;
    }
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

/// Groups the products of one search into series. Two products are one series when their
/// titles match ignoring spacing, punctuation, case and a trailing parenthesised alt title,
/// their publishers match after dropping obvious imprint suffixes, and their authors match
/// (an empty author joins the one named author that shares title and publisher). Mirrored
/// by `collection_bindings.py group_kakao`; change both together.
///
/// Products without a volume number count as volume 1 of their series (a series with no
/// numbered product is a one-volume series) and never replace a numbered volume 1.
fn grouped_items(items: Vec<AladinItem>) -> Vec<GroupedSeries> {
    let keys = group_keys(&items);
    let mut groups: BTreeMap<String, Vec<AladinItem>> = BTreeMap::new();
    for (item, key) in items.into_iter().zip(keys) {
        groups.entry(key).or_default().push(item);
    }
    groups
        .into_values()
        .map(|mut items| {
            let item_count = items.len() as u64;
            let member_ids: Vec<String> = items.iter().map(|item| item.item_id.clone()).collect();
            items.sort_by(compare_duplicate_preference);
            let title = items[0].base_title.trim().to_owned();
            let author = items
                .iter()
                .find_map(|item| item.author.clone().filter(|author| !author.trim().is_empty()));
            let publisher = items[0].publisher.clone();
            let fingerprint = fingerprint(&title, author.as_deref(), publisher.as_deref());
            let mut by_volume = BTreeMap::new();
            for item in items {
                by_volume.entry(item.volume_number.max(1)).or_insert(item);
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
                    volume_number: item.volume_number.max(1),
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
                    unparsed_count: 0,
                },
                items: selected_items,
                member_ids,
            }
        })
        .collect()
}

/// An unnumbered product ranks as volume 1, after any numbered product of that volume.
fn compare_duplicate_preference(left: &AladinItem, right: &AladinItem) -> Ordering {
    let effective = |item: &AladinItem| item.volume_number.max(1);
    let unnumbered = |item: &AladinItem| item.volume_number == UNNUMBERED_VOLUME;
    effective(left)
        .cmp(&effective(right))
        .then_with(|| unnumbered(left).cmp(&unnumbered(right)))
        .then_with(|| right.isbn13.is_some().cmp(&left.isbn13.is_some()))
        .then_with(|| right.publication_date.cmp(&left.publication_date))
        .then_with(|| left.item_id.cmp(&right.item_id))
}

/// One group key per item (same order as `items`).
fn group_keys(items: &[AladinItem]) -> Vec<String> {
    let parts: Vec<(String, String, String)> = items
        .iter()
        .map(|item| {
            (
                title_key(&item.base_title),
                alphanumeric_key(item.author.as_deref().unwrap_or_default()),
                publisher_key(item.publisher.as_deref().unwrap_or_default()),
            )
        })
        .collect();
    let mut authors: BTreeMap<(&str, &str), BTreeSet<&str>> = BTreeMap::new();
    for (title, author, publisher) in &parts {
        if !author.is_empty() {
            authors
                .entry((title.as_str(), publisher.as_str()))
                .or_default()
                .insert(author.as_str());
        }
    }
    parts
        .iter()
        .map(|(title, author, publisher)| {
            let author = match authors.get(&(title.as_str(), publisher.as_str())) {
                Some(named) if author.is_empty() && named.len() == 1 => {
                    named.iter().next().copied().unwrap_or_default()
                }
                _ => author.as_str(),
            };
            [title.as_str(), author, publisher.as_str()].join("\0")
        })
        .collect()
}

/// Letters and digits only, lowercased: spacing, middots, `!`, `?`, `~` and quotes do not
/// tell two spellings of one title apart.
fn alphanumeric_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The start and inner text of a trailing `(...)` / `[...]` note, when text precedes it.
fn trailing_note(text: &str) -> Option<(usize, &str)> {
    let opener = match text.chars().next_back()? {
        ')' => '(',
        ']' => '[',
        _ => return None,
    };
    let open = text.rfind(opener)?;
    (!text[..open].trim().is_empty()).then(|| (open, &text[open + 1..text.len() - 1]))
}

fn title_key(title: &str) -> String {
    let mut text = title.trim();
    // Conservatively remove only Latin/kana aliases without digits or series markers.
    // Korean/unknown notes, parts, side stories, seasons and edition names stay distinct.
    while let Some((open, _)) = trailing_note(text).filter(|(_, inner)| is_alt_title_note(inner)) {
        text = text[..open].trim_end();
    }
    alphanumeric_key(text)
}

fn is_alt_title_note(note: &str) -> bool {
    if is_edition_note(note) || is_series_note(note) {
        return false;
    }
    let letter = |c: char| c.is_ascii_alphabetic()
        || matches!(c, '\u{00c0}'..='\u{024f}' | '\u{3041}'..='\u{3096}' | '\u{30a1}'..='\u{30fa}' | 'ー');
    note.chars().any(letter) && note.chars().all(|c| letter(c)
        || c.is_whitespace() || matches!(c, '-' | '.' | ',' | ':' | ';' | '!' | '?' | '\'' | '"' | '·' | '&'))
}

fn publisher_key(publisher: &str) -> String {
    let mut text = publisher.trim();
    for prefix in ["(주)", "㈜", "주식회사"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.trim_start();
        }
    }
    while let Some((open, _)) = trailing_note(text) {
        text = text[..open].trim_end();
    }
    // "학산문화사/DCW": an ASCII imprint code after a slash.
    if let Some(slash) = text.rfind('/') {
        let tail = &text[slash + 1..];
        if !text[..slash].trim().is_empty()
            && !tail.trim().is_empty()
            && tail.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ')
        {
            text = text[..slash].trim_end();
        }
    }
    let key = alphanumeric_key(text);
    match key.strip_suffix("미디어") {
        Some(rest) if rest.chars().count() >= 2 => rest.to_owned(),
        _ => key,
    }
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
            .book_flow()
            .apply_aladin_items(request(&work_id, &items), items.clone())
            .unwrap();
        assert_eq!((first.added, first.updated, first.unchanged), (2, 0, 0));
        let second = library
            .book_flow()
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
        assert_eq!(bindings, vec!["kakao", "mangadex"]);
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
             ) VALUES (?1, 1, 'kakao', 'shared-item', '기존 1권', '{}', 't', 't')",
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

        let result = library.book_flow().apply_aladin_items(
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
                (SELECT COUNT(*) FROM collection_external_bindings WHERE collection_id = ?1 AND provider = 'kakao'),
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
            .book_flow()
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
            .book_flow()
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
        let error = library.book_flow().refresh_aladin_items(
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
    fn kakao_first_check_is_quiet_and_existing_numbers_never_notify() {
        for (owned, found) in [
            (13, vec![1, 2, 3, 4, 5, 6]),
            (15, vec![1, 2, 4, 5, 7, 8, 9, 12, 13, 14]),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let library = Library::open(temp.path()).unwrap();
            let id = create_work(&library, "Series");
            let products = |numbers: Vec<i64>| numbers.into_iter().map(|n|
                item(&format!("item-{n}"), "Series", n, "A", None, None)
            ).collect::<Vec<_>>();
            let initial = products(found);
            let candidate = group_items(initial.clone()).remove(0);
            store_kakao_binding(&library, &id, &candidate.anchor_item_id,
                serde_json::json!({"version": 1, "query": "Series",
                    "groupFingerprint": candidate.group_fingerprint}).to_string());
            library.set_owned_volume_count(&id, 0, owned).unwrap();
            library.set_release_watch_enabled(&id, true).unwrap();
            {
                let connection = library.connection().unwrap();
                for n in 1..=owned {
                    connection.execute("INSERT INTO collection_volumes(id,collection_id,volume_number,edition_index,sort_order,created_at,updated_at) VALUES(?1,?2,?3,0,?3,'t','t')",
                        rusqlite::params![format!("slot-{n}"), id, n]).unwrap();
                }
                // A historical subscription timestamp must not manufacture a baseline.
                connection.execute("UPDATE release_watch_subscriptions SET last_checked_at='2026-10-06T00:00:00Z' WHERE collection_id=?1", [&id]).unwrap();
            }
            let first = library.book_flow().refresh_aladin_items_at(&id, initial, "2026-10-09T00:00:00Z").unwrap();
            assert_eq!(first.release_event_count, 0);
            assert!(library.list_unread_release_changes().unwrap().is_empty());
            let later = products((1..=i64::from(owned) + 1).collect());
            let next = library.book_flow().refresh_aladin_items_at(&id, later.clone(), "2026-10-10T00:00:00Z").unwrap();
            assert_eq!(next.release_event_count, 1);
            let events = library.list_unread_release_changes().unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].volume_number, i64::from(owned) + 1);
            assert_eq!(events[0].kind, ReleaseWatchEventKind::NewVolume);
            assert_eq!(library.book_flow().refresh_aladin_items_at(&id, later, "2026-10-11T00:00:00Z").unwrap().release_event_count, 0);
        }
    }

    #[test]
    fn kakao_rebind_is_quiet_then_genuine_new_volume_notifies() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "Series");
        let products = |publisher: &str, count: i64| (1..=count).map(|n|
            item(&format!("{publisher}-{n}"), "Series", n, publisher, None, None)
        ).collect::<Vec<_>>();
        let initial = products("A", 1);
        library.book_flow().apply_aladin_items(request(&id, &initial), initial).unwrap();
        library.set_owned_volume_count(&id, 0, 1).unwrap();
        library.set_release_watch_enabled(&id, true).unwrap();
        let rebound = products("B", 2);
        library.book_flow().apply_aladin_items(request(&id, &rebound), rebound).unwrap();
        assert!(library.list_unread_release_changes().unwrap().is_empty());
        // A slot in another edition also makes this number already known.
        library.connection().unwrap().execute("INSERT INTO collection_volumes(id,collection_id,volume_number,edition_index,sort_order,created_at,updated_at) VALUES('edition-slot',?1,3,1,3,'t','t')", [&id]).unwrap();
        let later = products("B", 4);
        assert_eq!(library.book_flow().refresh_aladin_items_at(&id, later, "2026-10-10T00:00:00Z").unwrap().release_event_count, 1);
        let events = library.list_unread_release_changes().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].volume_number, 4);
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
            .book_flow()
            .apply_aladin_items(request(&work_id, &initial), initial)
            .unwrap();
        library.set_owned_volume_count(&work_id, 0, 0).unwrap();
        library.set_release_watch_enabled(&work_id, true).unwrap();
        library
            .set_collection_volume_range(&work_id, Some(1), Some(1), false)
            .unwrap();
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
            .book_flow()
            .refresh_aladin_items_at(&work_id, refreshed.clone(), "2026-08-22T00:00:00Z")
            .unwrap();
        assert_eq!(first.release_event_count, 2);
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
            ]
        );

        let second = library
            .book_flow()
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
    fn unwatched_kakao_reconciliation_creates_no_release_events() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let work_id = create_work(&library, "던전밥");
        let initial = vec![item("item-1", "던전밥", 1, "A출판", Some("9781"), None)];
        library
            .book_flow()
            .apply_aladin_items(request(&work_id, &initial), initial)
            .unwrap();
        library
            .book_flow()
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
                 ) VALUES (?1, 2, 'kakao', 'shared-item', '기존 2권', '{}', 't', 't')",
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
            .book_flow()
            .apply_aladin_items(request(&target_id, &initial), initial)
            .unwrap();
        library.set_owned_volume_count(&target_id, 0, 0).unwrap();
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

        let result = library.book_flow().refresh_aladin_items_at(
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
                     WHERE collection_id = ?1 AND volume_number = 1 AND provider = 'kakao'),
                    (SELECT COUNT(*) FROM release_watch_events WHERE collection_id = ?1),
                    (SELECT last_checked_at FROM release_watch_subscriptions
                     WHERE collection_id = ?1 AND provider = 'kakao')",
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
    fn kakao_review_dismissal_survives_refresh_and_undo_but_clears_on_volume_change() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "던전밥");
        let items = vec![item("one", "던전밥", 1, "A출판", None, None), item("three", "던전밥", 3, "A출판", None, None)];
        let flow = library.book_flow();
        flow.apply_aladin_items(request(&id, &items), items.clone()).unwrap();
        library.set_kakao_partial_dismissed(&id, true).unwrap();
        assert!(library.list_kakao_reviews().unwrap()[0].partial_dismissed);
        drop(library);
        let library = Library::open(temp.path()).unwrap();
        let flow = library.book_flow();
        flow.refresh_aladin_items_at(&id, items.clone(), "2026-10-09T00:00:00Z").unwrap();
        assert!(library.list_kakao_reviews().unwrap()[0].partial_dismissed);
        library.set_kakao_partial_dismissed(&id, false).unwrap();
        assert!(!library.list_kakao_reviews().unwrap()[0].partial_dismissed);
        library.set_kakao_partial_dismissed(&id, true).unwrap();
        let mut expanded = items;
        expanded.push(item("two", "던전밥", 2, "A출판", None, None));
        flow.refresh_aladin_items_at(&id, expanded, "2026-10-10T00:00:00Z").unwrap();
        let review = &library.list_kakao_reviews().unwrap()[0];
        assert_eq!(review.volumes, vec![1, 2, 3]);
        assert!(!review.partial_dismissed);
        let raw = library.list_collection_external_bindings(&id).unwrap()[0].provider_config_json.clone().unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&raw).unwrap().get("reviewDismissedVolumes").is_none());
    }
    #[test]
    fn kakao_refreshes_all_but_notifies_only_explicit_count_and_subscription() {
        for (entered, enabled, expected) in [(false,false,0), (false,true,0), (true,false,0), (true,true,1)] {
            let temp = tempfile::tempdir().unwrap();
            let library = Library::open(temp.path()).unwrap();
            let id = create_work(&library, "던전밥");
            let initial = vec![item("isbn:one", "던전밥", 1, "A출판", Some("9781"), Some("2020-01-01"))];
            library.book_flow().apply_aladin_items(request(&id, &initial), initial.clone()).unwrap();
            if enabled { library.set_release_watch_enabled(&id, true).unwrap(); }
            if entered { library.set_owned_volume_count(&id, 0, 0).unwrap(); }
            let mut updated = initial;
            updated.push(item("isbn:two", "던전밥", 2, "A출판", Some("9782"), Some("2099-10-01")));
            let result = library.book_flow().refresh_aladin_items_at(&id, updated.clone(), "2026-09-13T00:00:00Z").unwrap();
            assert_eq!(result.sync_result.added, 1);
            let inbox = library.list_release_inbox().unwrap();
            assert_eq!(inbox.len(), expected, "entered={entered}, enabled={enabled}");
            if expected > 0 { assert_eq!(inbox[0].provider, "kakao"); assert_eq!(inbox[0].event.current_value.as_deref(), Some("2099-10-01")); }
            library.book_flow().refresh_aladin_items_at(&id, updated, "2026-09-14T00:00:00Z").unwrap();
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
            .book_flow()
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
        assert!(matches!(library.book_flow().apply_aladin_items(partial, items.clone()), Err(LibraryError::AmbiguousAladinBinding)));
        let mut repeated = select_all(&id, &items);
        repeated.groups[1] = repeated.groups[0].clone();
        assert!(matches!(library.book_flow().apply_aladin_items(repeated, items.clone()), Err(LibraryError::AmbiguousAladinBinding)));
        let mut empty = select_all(&id, &items);
        empty.groups.clear();
        assert!(matches!(library.book_flow().apply_aladin_items(empty, items), Err(LibraryError::AmbiguousAladinBinding)));
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
            .book_flow()
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
            .book_flow()
            .apply_aladin_items(select_all(&id, &items), items.clone())
            .unwrap();
        library.set_release_watch_enabled(&id, true).unwrap();
        library.set_owned_volume_count(&id, 0, 7).unwrap();
        // Vol. 1 (the first group's anchor) left the search; vol. 8 appeared in the second.
        let mut refreshed: Vec<_> = items.into_iter().skip(1).collect();
        refreshed.push(ghost("isbn13:9791138491174", 8, "S코믹스", Some("9791138491174"), "2026-11-20"));
        let outcome = library
            .book_flow()
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
            library.book_flow().refresh_aladin_items_at(&id, only_first, "2026-09-27T00:00:00Z"),
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
            .book_flow()
            .refresh_aladin_items_at(&id, items, "2026-09-26T00:00:00Z")
            .unwrap();
        assert_eq!(kakao_sources(&library, &id), vec![(7, "isbn13:9791138491150".to_owned())]);
        let (external, config) = kakao_binding(&library, &id);
        assert_eq!(external, "isbn13:9791138491150");
        assert_eq!(config["version"], 1);
        assert_eq!(config["groupFingerprint"], serde_json::json!(second.group_fingerprint));
    }

    /// A product as the Kakao/Aladin parsers produce it from a raw title.
    fn product(
        id: &str,
        title: &str,
        author: Option<&str>,
        publisher: &str,
        isbn13: Option<&str>,
        publication_date: Option<&str>,
    ) -> AladinItem {
        let (volume_number, base_title) = crate::library::aladin::classify_product(title)
            .into_volume()
            .unwrap_or_else(|| panic!("{title} is not a usable product"));
        AladinItem {
            item_id: id.into(),
            title: title.into(),
            author: author.map(Into::into),
            publisher: Some(publisher.into()),
            isbn13: isbn13.map(Into::into),
            publication_date: publication_date.map(Into::into),
            item_url: None,
            volume_number,
            base_title,
            snapshot_json: format!(r#"{{"itemId":"{id}"}}"#),
        }
    }

    fn volume_numbers(group: &crate::library::models::AladinSeriesCandidate) -> Vec<i64> {
        group.volumes.iter().map(|volume| volume.volume_number).collect()
    }

    #[test]
    fn one_series_is_not_split_by_spacing_middots_or_alt_titles() {
        for (first, second) in [
            ("마법 소녀를 1", "마법소녀를 2"),
            ("봇치·더·록! 1", "봇치 더 록! 2"),
            ("봇치 더 록! 1", "봇치 더 록 2"),
            ("위치 워치(Witch Watch) 1", "위치 워치 2"),
            ("위치 워치 [Witch Watch] 1", "위치워치(ウィッチウォッチ) 2"),
            ("Re:ZERO 1", "re zero 2"),
        ] {
            let groups = group_items(vec![
                product("a", first, Some("작가"), "출판", None, None),
                product("b", second, Some("작가"), "출판", None, None),
            ]);
            assert_eq!(groups.len(), 1, "{first} / {second}");
            assert_eq!(volume_numbers(&groups[0]), [1, 2], "{first} / {second}");
        }
        // Different words stay different series, and an edition note is not an alt title.
        let groups = group_items(vec![
            product("a", "소드 아트 온라인 1", Some("작가"), "출판", None, None),
            product("b", "소드 아트 온라인 프로그레시브 1", Some("작가"), "출판", None, None),
            product("c", "도로로 (애장판) 1", Some("작가"), "출판", None, None),
            product("d", "도로로 1", Some("작가"), "출판", None, None),
        ]);
        assert_eq!(groups.len(), 4);
    }

    #[test]
    fn an_empty_author_joins_the_one_series_with_the_same_title_and_publisher() {
        let groups = group_items(vec![
            product("a", "던전밥 1", Some("쿠이 료코"), "소미미디어", None, None),
            product("b", "던전밥 2", None, "소미미디어", None, None),
            product("c", "던전밥 3", Some(""), "소미미디어", None, None),
        ]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].author.as_deref(), Some("쿠이 료코"));
        assert_eq!(volume_numbers(&groups[0]), [1, 2, 3]);

        // Two named authors: the author-less product cannot choose, so it stays apart.
        let groups = group_items(vec![
            product("a", "던전밥 1", Some("작가 A"), "소미미디어", None, None),
            product("b", "던전밥 1", Some("작가 B"), "소미미디어", None, None),
            product("c", "던전밥 2", None, "소미미디어", None, None),
        ]);
        assert_eq!(groups.len(), 3);

        // The same title under another publisher is another series.
        let groups = group_items(vec![
            product("a", "던전밥 1", Some("쿠이 료코"), "소미미디어", None, None),
            product("b", "던전밥 2", None, "다른출판사", None, None),
        ]);
        assert_eq!(groups.len(), 2);
    }

    #[test]
    fn obvious_publisher_variants_merge_but_imprints_stay_apart() {
        for (first, second) in [
            ("에이템포", "에이템포미디어"),
            ("학산문화사", "학산문화사/DCW"),
            ("서울문화사", "(주)서울문화사"),
            ("대원씨아이", "대원씨아이(서울문화사)"),
            ("Dai Won", "dai won"),
        ] {
            let groups = group_items(vec![
                product("a", "던전밥 1", Some("작가"), first, None, None),
                product("b", "던전밥 2", Some("작가"), second, None, None),
            ]);
            assert_eq!(groups.len(), 1, "{first} / {second}");
        }
        for (first, second) in [("소미미디어", "S코믹스"), ("A출판", "B출판"), ("미디어", "미디어팩토리")] {
            let groups = group_items(vec![
                product("a", "던전밥 1", Some("작가"), first, None, None),
                product("b", "던전밥 2", Some("작가"), second, None, None),
            ]);
            assert_eq!(groups.len(), 2, "{first} / {second}");
        }
    }

    #[test]
    fn unnumbered_products_become_volume_one_without_replacing_a_numbered_one() {
        // A one-shot is a one-volume series.
        let groups = group_items(vec![product("one", "별의 아이", Some("작가"), "출판", None, None)]);
        assert_eq!(groups.len(), 1);
        assert_eq!(volume_numbers(&groups[0]), [1]);
        assert_eq!(groups[0].title, "별의 아이");

        // An unnumbered product with the series title is its volume 1 when none is numbered...
        let groups = group_items(vec![
            product("v1", "마법소녀를 (애장판)", Some("작가"), "출판", None, None),
            product("v2", "마법소녀를 2", Some("작가"), "출판", None, None),
        ]);
        assert_eq!(groups.len(), 1);
        assert_eq!(volume_numbers(&groups[0]), [1, 2]);
        assert_eq!(groups[0].volumes[0].provider_item_id, "v1");
        assert_eq!(groups[0].ignored_count, 0);

        // ...and loses to a numbered volume 1, whatever its ISBN or date.
        let groups = group_items(vec![
            product("plain", "마법소녀를 (일반판)", Some("작가"), "출판", Some("9781"), Some("2030-01-01")),
            product("numbered", "마법소녀를 1", Some("작가"), "출판", None, None),
        ]);
        assert_eq!(groups.len(), 1);
        assert_eq!(volume_numbers(&groups[0]), [1]);
        assert_eq!(groups[0].volumes[0].provider_item_id, "numbered");
        assert_eq!(groups[0].ignored_count, 1);

        // An unnumbered product with a different title is not folded into the series.
        let groups = group_items(vec![
            product("v1", "마법소녀를 1", Some("작가"), "출판", None, None),
            product("book", "마법소녀를 공식 팬 이야기", Some("작가"), "출판", None, None),
        ]);
        assert_eq!(groups.len(), 2);
    }

    /// The groups the server's `group_kakao` is tested against too
    /// (`server/lakomics-api/tests/test_collection_bindings.py`).
    #[test]
    fn groups_match_the_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/kakao_grouping.json")).unwrap();
        let items = fixture["products"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                let text = |key: &str| p[key].as_str();
                product(
                    text("id").unwrap(),
                    text("title").unwrap(),
                    text("author"),
                    text("publisher").unwrap(),
                    text("isbn13"),
                    text("date"),
                )
            })
            .collect();
        let groups = group_items(items);
        let actual: Vec<serde_json::Value> = groups
            .iter()
            .map(|group| {
                serde_json::json!({
                    "title": group.title,
                    "author": group.author,
                    "publisher": group.publisher,
                    "fingerprint": group.group_fingerprint,
                    "volumes": group.volumes.iter()
                        .map(|volume| serde_json::json!([volume.volume_number, volume.provider_item_id]))
                        .collect::<Vec<_>>(),
                    "ignored": group.ignored_count,
                })
            })
            .collect();
        assert_eq!(serde_json::Value::Array(actual), fixture["groups"]);
    }

    #[test]
    fn the_fingerprint_of_an_unchanged_group_is_the_old_one() {
        let groups = group_items(vec![
            product("a", "던전밥 2", Some("쿠이  료코"), "소미미디어", None, None),
            product("b", "던전밥 1", Some("쿠이 료코"), "소미미디어", None, None),
        ]);
        assert_eq!(groups.len(), 1);
        assert_eq!(
            groups[0].group_fingerprint,
            super::fingerprint("던전밥", Some("쿠이 료코"), Some("소미미디어"))
        );
    }

    fn store_kakao_binding(library: &Library, id: &str, external_id: &str, config: String) {
        library
            .upsert_collection_external_binding(
                id,
                ExternalBindingInput {
                    provider: "kakao".into(),
                    external_id: external_id.into(),
                    provider_config_json: Some(config),
                    provider_data_json: Some("{}".into()),
                    last_synced_at: None,
                },
            )
            .unwrap();
    }

    #[test]
    fn two_bound_groups_that_now_merge_still_refresh_as_one() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "마법소녀를");
        // Stored under the old grouping: spacing and an imprint suffix made two groups.
        let old_first = super::fingerprint("마법 소녀를", Some("작가"), Some("에이템포"));
        let old_second = super::fingerprint("마법소녀를", Some("작가"), Some("에이템포미디어"));
        store_kakao_binding(
            &library,
            &id,
            "a-1",
            serde_json::json!({"version": 2, "query": "마법소녀를", "groups": [
                {"anchorItemId": "a-1", "groupFingerprint": old_first, "knownItemIds": ["a-1", "a-2"]},
                {"anchorItemId": "b-3", "groupFingerprint": old_second, "knownItemIds": ["b-3"]},
            ]})
            .to_string(),
        );
        let items = vec![
            product("a-1", "마법 소녀를 1", Some("작가"), "에이템포", Some("9781"), None),
            product("a-2", "마법 소녀를 2", Some("작가"), "에이템포", Some("9782"), None),
            product("b-3", "마법소녀를 3", Some("작가"), "에이템포미디어", Some("9783"), None),
        ];
        let merged = group_items(items.clone());
        assert_eq!(merged.len(), 1);
        assert_ne!(merged[0].group_fingerprint, old_second);

        library
            .book_flow()
            .refresh_aladin_items_at(&id, items, "2026-10-09T00:00:00Z")
            .unwrap();

        assert_eq!(kakao_sources(&library, &id).len(), 3);
        let (external, config) = kakao_binding(&library, &id);
        assert_eq!(external, "a-1");
        assert_eq!(config["version"], 1);
        assert_eq!(config["groupFingerprint"], serde_json::json!(merged[0].group_fingerprint));
        assert_eq!(config["knownItemIds"], serde_json::json!(["a-1", "a-2", "b-3"]));
    }

    #[test]
    fn a_stored_group_is_found_by_its_anchor_even_when_its_fingerprint_changed() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "봇치 더 록!");
        let old = super::fingerprint("봇치더록!", Some("하마지 아키"), Some("학산문화사"));
        store_kakao_binding(
            &library,
            &id,
            "x-1",
            serde_json::json!({"version": 1, "query": "봇치", "groupFingerprint": old,
                "knownItemIds": []})
            .to_string(),
        );
        let items = vec![
            product("x-3", "봇치·더·록! 3", Some("하마지 아키"), "학산문화사/DCW", None, None),
            product("x-1", "봇치 더 록! 1", Some("하마지 아키"), "학산문화사", None, None),
            product("x-2", "봇치 더 록! 2", None, "학산문화사", None, None),
        ];
        let groups = group_items(items.clone());
        assert_eq!(groups.len(), 1);

        library
            .book_flow()
            .refresh_aladin_items_at(&id, items, "2026-10-09T00:00:00Z")
            .unwrap();

        let (external, config) = kakao_binding(&library, &id);
        assert_eq!(external, "x-1");
        assert_eq!(config["groupFingerprint"], serde_json::json!(groups[0].group_fingerprint));
        assert_eq!(
            config["knownItemIds"],
            serde_json::json!(["x-1", "x-2", "x-3"])
        );
    }

    #[test]
    fn a_stored_group_is_found_by_an_earlier_item_when_its_anchor_left_the_search() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "던전밥");
        store_kakao_binding(
            &library,
            &id,
            "gone",
            serde_json::json!({"version": 1, "query": "던전밥",
                "groupFingerprint": "0".repeat(64), "knownItemIds": ["gone", "item-2"]})
            .to_string(),
        );
        let items = vec![
            product("item-2", "던전밥 2", Some("작가"), "출판", None, None),
            product("item-3", "던전밥 3", Some("작가"), "출판", None, None),
        ];
        library
            .book_flow()
            .refresh_aladin_items_at(&id, items, "2026-10-09T00:00:00Z")
            .unwrap();
        assert_eq!(kakao_sources(&library, &id).len(), 2);

        // Nothing it ever held: still refused.
        let unrelated = vec![product("other", "다른책 1", Some("작가"), "출판", None, None)];
        assert!(matches!(
            library
                .book_flow()
                .refresh_aladin_items_at(&id, unrelated, "2026-10-10T00:00:00Z"),
            Err(LibraryError::AmbiguousAladinBinding)
        ));
    }

    #[test]
    fn series_notes_do_not_merge_or_swap_sources_on_refresh() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "Series");
        let first = product("part-1", "Series (1부) 1", Some("작가"), "출판", None, None);
        let second = product("part-2", "Series (2부) 1", Some("작가"), "출판", Some("9782"), Some("2030-01-01"));
        library.book_flow().apply_aladin_items(request(&id, &[first.clone()]), vec![first.clone()]).unwrap();
        library.book_flow().refresh_aladin_items_at(&id, vec![first, second], "2026-10-09T00:00:00Z").unwrap();
        assert_eq!(kakao_sources(&library, &id)[0].1, "part-1");
        for note in ["1부", "2부", "part one", "외전", "시즌", "번외", "단편", "리부트", "신장판", "unknown 한글"] {
            let groups = group_items(vec![
                product("plain", "Series 1", Some("작가"), "출판", None, None),
                product("note", &format!("Series ({note}) 1"), Some("작가"), "출판", None, None),
            ]);
            assert_eq!(groups.len(), 2, "{note}");
        }
    }

    #[test]
    fn numbered_volume_one_wins_across_groups_on_apply_and_refresh() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "Series");
        let items = vec![
            product("plain", "Series", Some("작가"), "A출판", Some("9781"), Some("2030-01-01")),
            product("numbered", "Series 1", Some("작가"), "B출판", None, None),
        ];
        let result = library.book_flow().apply_aladin_items(select_all(&id, &items), items.clone()).unwrap();
        assert_eq!((result.added, result.ignored), (1, 1));
        assert_eq!(kakao_sources(&library, &id)[0].1, "numbered");
        library.book_flow().refresh_aladin_items_at(&id, items, "2026-10-09T00:00:00Z").unwrap();
        assert_eq!(kakao_sources(&library, &id)[0].1, "numbered");
    }

    #[test]
    fn refresh_prefers_anchor_when_known_products_split_and_narrows_without_anchor() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "Series");
        let initial = vec![
            product("anchor", "Series 1", Some("A"), "출판", None, None),
            product("known", "Series 2", None, "출판", None, None),
        ];
        let old_fingerprint = group_items(initial.clone())[0].group_fingerprint.clone();
        library.book_flow().apply_aladin_items(request(&id, &initial), initial).unwrap();
        for author in [Some("B"), None] {
            let split = vec![
                product("anchor", "Series 1", Some("A"), "출판", None, None),
                product("known", "Series 2", author, "출판", None, None),
                product("other", "Series 3", Some("B"), "출판", None, None),
            ];
            library.book_flow().refresh_aladin_items_at(&id, split, "2026-10-09T00:00:00Z").unwrap();
        }
        let config = ProviderConfig { query: "Series".into(), groups: vec![BoundGroup {
            anchor_item_id: "gone".into(), group_fingerprint: old_fingerprint,
            known_item_ids: vec!["known-a".into(), "known-b".into()],
        }] };
        let split = vec![
            product("known-a", "Series 2", Some("A"), "출판", None, None),
            product("known-b", "Series 3", Some("B"), "출판", None, None),
        ];
        library.book_flow().refresh_aladin_items_with_config_at(&id, config, split, "2026-10-09T00:00:00Z").unwrap();
        assert!(kakao_sources(&library, &id).iter().any(|source| source.1 == "known-a"));
        assert!(!kakao_sources(&library, &id).iter().any(|source| source.1 == "known-b"));
    }

    #[test]
    fn collection_binding_delayed_picks_survive_metadata_changes_and_group_collapse() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = create_work(&library, "Series");
        let old = vec![
            product("z-1", "Series 1", Some("작가"), "에이템포", None, None),
            product("z-2", "Series 2", Some("작가"), "다른출판", None, None),
        ];
        let request = select_all(&id, &old);
        let fresh = vec![
            product("a-1", "Series 1", Some("작가"), "에이템포미디어", Some("9781"), None),
            product("z-1", "Series 1", Some("작가"), "에이템포", None, None),
            product("z-2", "Series 2", Some("작가"), "에이템포미디어", None, None),
        ];
        assert_eq!(group_items(fresh.clone()).len(), 1);
        library.book_flow().apply_requested_items(request.clone(), fresh, None).unwrap();
        let (external, config) = kakao_binding(&library, &id);
        assert_eq!(external, "a-1");
        assert_eq!(config["version"], 1);
        assert!(super::requested_groups_already_bound(Some(&config.to_string()), &external, &request));
        let mut unrelated = request.clone();
        unrelated.groups[0].anchor_item_id = "missing".into();
        assert!(!super::requested_groups_already_bound(Some(&config.to_string()), &external, &unrelated));
        // Anchor identity overrides a fingerprint that happens to identify another group.
        let groups = vec![
            product("z-1", "Series 1", Some("Changed"), "출판", None, None),
            product("other", "Series 1", Some("작가"), "에이템포", None, None),
        ];
        let temp2 = tempfile::tempdir().unwrap();
        let library = Library::open(temp2.path()).unwrap();
        let id2 = create_work(&library, "Second");
        let mut single = request;
        single.collection_id = id2.clone();
        single.groups.retain(|group| group.anchor_item_id == "z-1");
        library.book_flow().apply_requested_items(single, groups, None).unwrap();
        assert_eq!(kakao_sources(&library, &id2)[0].1, "z-1");
    }
}
