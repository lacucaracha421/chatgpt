//! In-memory change generations behind the character screens' refresh and cache decisions.
//!
//! Every writer goes through [`super::Library::connection`], whose update hook reports each
//! changed table here. Three things are derived from that:
//! - the definition generation (targets, references, series, groups, folder exclusions and
//!   order): the UI re-reads the character hub only when it moves, never on per-image
//!   analysis progress, which writes none of these tables;
//! - per-series activity of the automatic analysis, so only the analysed series' gallery
//!   and counts refresh;
//! - the input generation of the 새 캐릭터 suggestion list, which keys its cache.
//!
//! SQLite does not report `WITHOUT ROWID` tables to the update hook; their writers call
//! [`CharacterChanges::suggestion_inputs_changed`] explicitly (tagger import, tagger tag
//! links, ignored suggestions).
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

/// Rowid tables whose rows define the character hub (`list_character_targets`, series,
/// groups, folder exclusions).
const DEFINITION_TABLES: &[&str] = &[
    "character_targets",
    "character_references",
    "character_learned_references",
    "character_reference_regions",
    "character_series",
    "character_groups",
    "character_group_members",
    "character_folder_exclusions",
    "character_folder_order",
];

/// Rowid tables read by the suggestion list (`character_suggestions_list.sql`, sample
/// thumbnails). `character_targets` deletions cascade to the tagger tag links.
const SUGGESTION_INPUT_TABLES: &[&str] = &[
    "assets",
    "asset_classifications",
    "classification_entries",
    "character_series",
    "character_targets",
];

#[derive(Debug, Default)]
pub(crate) struct CharacterChanges {
    definitions: AtomicU64,
    suggestion_inputs: AtomicU64,
    series_activity: Mutex<BTreeMap<String, u64>>,
    /// Single flight and cache of the suggestion list: (input generation, minimum, rows).
    pub(super) suggestions:
        Mutex<Option<(u64, usize, Vec<super::character_suggestions::Suggestion>)>>,
}

impl CharacterChanges {
    pub(crate) fn changed_table(&self, table: &str) {
        if DEFINITION_TABLES.contains(&table) {
            self.definitions.fetch_add(1, Ordering::AcqRel);
        }
        if SUGGESTION_INPUT_TABLES.contains(&table) {
            self.suggestion_inputs_changed();
        }
    }

    pub(crate) fn suggestion_inputs_changed(&self) {
        self.suggestion_inputs.fetch_add(1, Ordering::AcqRel);
    }

    /// The whole database was replaced (snapshot restore): nothing read before is current.
    pub(crate) fn database_replaced(&self) {
        self.definitions.fetch_add(1, Ordering::AcqRel);
        self.suggestion_inputs_changed();
        let mut activity = self
            .series_activity
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for revision in activity.values_mut() {
            *revision += 1;
        }
    }

    pub(crate) fn definition_revision(&self) -> u64 {
        self.definitions.load(Ordering::Acquire)
    }

    pub(crate) fn suggestion_generation(&self) -> u64 {
        self.suggestion_inputs.load(Ordering::Acquire)
    }

    /// One automatic analysis result touched these series (gallery views, member counts).
    pub(crate) fn series_analysed<'a>(&self, series: impl IntoIterator<Item = &'a str>) {
        let series = series.into_iter().collect::<BTreeSet<_>>();
        if series.is_empty() {
            return;
        }
        let mut activity = self
            .series_activity
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for id in series {
            *activity.entry(id.to_owned()).or_default() += 1;
        }
    }

    pub(crate) fn series_revisions(&self) -> BTreeMap<String, u64> {
        self.series_activity
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::CharacterChanges;

    #[test]
    fn analysis_progress_tables_do_not_move_definitions_or_suggestion_inputs() {
        let changes = CharacterChanges::default();
        for table in [
            "character_autotag_control",
            "character_autotag_jobs",
            "character_decisions",
            "character_autotag_predictions",
        ] {
            changes.changed_table(table);
        }
        assert_eq!(changes.definition_revision(), 0);
        assert_eq!(changes.suggestion_generation(), 0);
        changes.changed_table("character_group_members");
        assert_eq!(changes.definition_revision(), 1);
        assert_eq!(changes.suggestion_generation(), 0);
        changes.changed_table("asset_classifications");
        assert_eq!(changes.suggestion_generation(), 1);
    }

    #[test]
    fn series_activity_counts_each_series_once_per_result() {
        let changes = CharacterChanges::default();
        changes.series_analysed(["a", "a", "b"]);
        changes.series_analysed(["a"]);
        let revisions = changes.series_revisions();
        assert_eq!(revisions.get("a"), Some(&2));
        assert_eq!(revisions.get("b"), Some(&1));
        changes.database_replaced();
        assert_eq!(changes.series_revisions().get("b"), Some(&2));
    }
}
