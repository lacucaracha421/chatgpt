use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use super::models::{AspectRatioFilter, AssetQuery, AutoTagFilter, MediaKindFilter};

const CAPACITY: usize = 8;

/// Only count predicates belong here; navigation and ordering do not affect the total.
#[derive(Debug, PartialEq, Eq)]
struct FilterKey {
    classification_id: Option<String>,
    album_id: Option<String>,
    collection_id: Option<String>,
    creator_key: Option<String>,
    direct_only: bool,
    favorite_only: bool,
    unclassified_only: bool,
    media_kind: Option<MediaKindFilter>,
    aspect_ratio: Option<AspectRatioFilter>,
    duration_ms_min: Option<u64>,
    duration_ms_max: Option<u64>,
    collected_range: Option<(String, String)>,
    auto_tags: Option<AutoTagFilter>,
}

impl From<&AssetQuery> for FilterKey {
    fn from(query: &AssetQuery) -> Self {
        Self {
            classification_id: query.classification_id.clone(),
            album_id: query.album_id.clone(),
            collection_id: query.collection_id.clone(),
            creator_key: query.creator_key.clone(),
            direct_only: query.direct_only,
            favorite_only: query.favorite_only,
            unclassified_only: query.unclassified_only,
            media_kind: query.media_kind,
            aspect_ratio: query.aspect_ratio,
            duration_ms_min: query.duration_ms_min,
            duration_ms_max: query.duration_ms_max,
            collected_range: query
                .collected_range
                .as_ref()
                .map(|range| (range.start_utc.clone(), range.end_utc.clone())),
            auto_tags: query.auto_tags.clone(),
        }
    }
}

#[derive(Debug, Default)]
pub(super) struct AssetCountCache {
    generation: AtomicU64,
    entries: Mutex<VecDeque<(u64, FilterKey, u64)>>,
}

impl AssetCountCache {
    pub(super) fn changed_table(&self, table: &str) {
        // asset_likes and asset_artist_scope are views; track their base tables too.
        if matches!(
            table,
            "assets"
                | "asset_likes"
                | "asset_classifications"
                | "asset_albums"
                | "collection_assets"
                | "classification_entries"
                | "albums"
                | "library_settings"
                | "artist_excluded_classifications"
                | "video_assets"
                | "artist_members"
                | "asset_artist_assignments"
                | "asset_auto_tags"
                | "asset_auto_tag_edits"
                | "auto_tag_vocabulary"
        ) {
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
    }

    // Callers hold database_lock throughout lookup, count and insertion, so no writer
    // can change the generation between these steps (including through Library clones).
    pub(super) fn get(&self, query: &AssetQuery) -> Option<u64> {
        let generation = self.generation.load(Ordering::Relaxed);
        let key = FilterKey::from(query);
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .find(|(stored_generation, stored_key, _)| {
                *stored_generation == generation && *stored_key == key
            })
            .map(|(_, _, total)| *total)
    }

    pub(super) fn insert(&self, query: &AssetQuery, total: u64) {
        let generation = self.generation.load(Ordering::Relaxed);
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries.retain(|(stored_generation, _, _)| *stored_generation == generation);
        if entries.len() == CAPACITY {
            entries.pop_front();
        }
        entries.push_back((generation, FilterKey::from(query), total));
    }
}
