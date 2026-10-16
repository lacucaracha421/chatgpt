use std::{path::Path, time::Duration};

use rusqlite::Connection;

use super::{backup, error::LibraryError};

pub(crate) const SCHEMA_VERSION: i64 = 134;

#[cfg(test)]
#[path = "db_character_folder_perf_migration_tests.rs"]
mod character_folder_perf_migration_tests;

#[cfg(test)]
#[path = "db_character_claude_migration_tests.rs"]
mod character_claude_migration_tests;

/// Test helper: undoes migrations 0103 through 0132 so older-version fixtures can be rebuilt.
/// Tests that simulate an older library run this before lowering `user_version`; extend it
/// whenever a later migration adds objects.
#[cfg(test)]
pub(crate) const UNDO_AFTER_102: &str = "
    ALTER TABLE character_claude_opinions DROP COLUMN cache_write_tokens;
    ALTER TABLE character_claude_opinions DROP COLUMN cache_read_tokens;
    DROP TABLE character_claude_settings;
    DROP TABLE character_claude_opinions;
    DROP INDEX tagger_scores_suggestion_threshold;
    DROP INDEX character_target_tagger_tags_by_tag;
    DROP INDEX character_targets_by_linked_classification;
    DROP TABLE asset_image_text;
    ALTER TABLE character_groups DROP COLUMN position;
    DROP TRIGGER character_extras_insert_valid;
    DROP TRIGGER character_extras_update_valid;
    DROP TRIGGER character_extras_no_reference;
    DROP TRIGGER character_extras_no_learned_reference;
    DROP TRIGGER character_extras_no_tagger_tag;
    DROP TRIGGER character_extras_member_guard;
    DROP TRIGGER character_extras_leave_on_accept;
    DROP TRIGGER character_extras_group_deleted;
    DROP TRIGGER character_group_remove_empty;
    CREATE TRIGGER character_group_remove_empty
    AFTER DELETE ON character_group_members
    BEGIN
        DELETE FROM character_groups
        WHERE id = OLD.group_id
          AND NOT EXISTS (SELECT 1 FROM character_group_members WHERE group_id = OLD.group_id);
    END;
    DROP TRIGGER character_group_series_changed;
    CREATE TRIGGER character_group_series_changed AFTER UPDATE OF series_classification_id ON character_targets
    WHEN OLD.series_classification_id IS NOT NEW.series_classification_id BEGIN
     UPDATE character_groups SET revision=revision+1 WHERE id IN (SELECT group_id FROM character_group_members WHERE target_id=NEW.id);
     DELETE FROM character_group_members WHERE target_id=NEW.id;
    END;
    DROP INDEX character_extras_one_per_series;
    DROP INDEX character_extras_one_per_group;
    ALTER TABLE character_targets DROP COLUMN extras_group_id;
    ALTER TABLE character_targets DROP COLUMN role;
    DROP TABLE caption_publication_state;
    DROP TABLE caption_publication_digests;
    DROP TABLE collection_authority_people_reconcile;
    DROP TABLE collection_authority_portrait_blobs;
    DROP TABLE collection_authority_people_cache;
    DROP TABLE character_target_tagger_tag_exclusions;
    DROP TABLE collection_authority_trash;
    DROP TABLE collection_authority_materialization;
    DROP TABLE collection_authority_outbox;
    DROP TABLE collection_authority_revisions;
    DROP TABLE collection_authority_sync;
    DROP TABLE auto_tag_publication_state;
    DROP TABLE auto_tag_publication_digests;
    DROP TABLE manga_index_pin_outbox;
    DROP TABLE manga_index_pin_revisions;
    DROP TABLE manga_index_pin_sync;
    DROP TABLE manga_index_pins;
    DROP TRIGGER mobile_collection_pc_records_insert; DROP TRIGGER mobile_collection_pc_records_update; DROP TRIGGER mobile_collection_pc_records_delete;
    DROP TRIGGER mobile_collection_volume_cover_focus_insert; DROP TRIGGER mobile_collection_volume_cover_focus_update; DROP TRIGGER mobile_collection_volume_cover_focus_delete;
    DROP TRIGGER mobile_collection_people_insert; DROP TRIGGER mobile_collection_people_update; DROP TRIGGER mobile_collection_people_delete;
    DROP TRIGGER mobile_collection_person_profiles_insert; DROP TRIGGER mobile_collection_person_profiles_update; DROP TRIGGER mobile_collection_person_profiles_delete;
    DROP TRIGGER mobile_collection_person_portraits_insert; DROP TRIGGER mobile_collection_person_portraits_update; DROP TRIGGER mobile_collection_person_portraits_delete;
    DROP TRIGGER mobile_av_favorite_performers_insert; DROP TRIGGER mobile_av_favorite_performers_update; DROP TRIGGER mobile_av_favorite_performers_delete;
    DROP TABLE collection_volume_cover_focus;
    DROP TABLE collection_pc_records;
    ALTER TABLE release_watch_items DROP COLUMN tracked_platforms_json;
    DROP TABLE av_favorite_performers;
    DROP TABLE video_playback_progress;
    DROP TABLE manga_reading_progress;
    DROP TABLE collection_volume_ranges;
    DROP VIEW asset_artist_scope;
    DROP TABLE artist_excluded_classifications;
    CREATE VIEW asset_artist_scope AS
    SELECT asset.id AS asset_id,
     CASE
      WHEN assignment.artist_id IS NOT NULL THEN 'artist:' || assignment.artist_id
      WHEN COALESCE(asset.creator_handle, asset.creator_url) IS NULL THEN
       CASE WHEN asset.source_url IS NULL OR trim(asset.source_url) = '' THEN 'unknown:none' ELSE 'unknown:source' END
      WHEN member.artist_id IS NOT NULL THEN 'artist:' || member.artist_id
      ELSE COALESCE(asset.creator_handle, asset.creator_url)
     END AS scope_ref
    FROM assets AS asset
    LEFT JOIN asset_artist_assignments AS assignment ON assignment.asset_id = asset.id
    LEFT JOIN artist_members AS member ON member.creator_key = COALESCE(asset.creator_handle, asset.creator_url);
    DROP TABLE artist_style_dismissals;
    ALTER TABLE artists DROP COLUMN reposter;
    DROP VIEW asset_likes;
    ALTER TABLE library_settings DROP COLUMN likes_album_id;
    DROP TABLE home_publication_state;
    DROP TABLE collection_person_profiles;
    DROP TABLE collection_person_portraits;
    ALTER TABLE collection_people DROP COLUMN memo;
    DROP TABLE character_suggestion_ignored_tags;
    DROP VIEW character_tagger_pending;
    ALTER TABLE character_learned_references DROP COLUMN provenance;
    DROP TRIGGER character_tagger_manual_decision;
    DROP TRIGGER mobile_tagger_candidate_insert;
    DROP TRIGGER mobile_tagger_candidate_delete;
    DROP TRIGGER mobile_tagger_candidate_update;
    DROP TABLE character_tagger_candidates;
    DROP TABLE character_target_tagger_tags;
    DROP TABLE asset_tagger_character_scores;
    DROP TABLE tagger_character_vocabulary;
    DROP TABLE asset_tagger_coverage;
    DROP TRIGGER character_folder_order_insert;
    DROP TRIGGER character_folder_order_series_changed;
    DROP TABLE character_folder_order;
    DROP TABLE av_link_candidates; DROP TABLE av_link_inbox;
    DROP TABLE av_link_poll_cursor; DROP TABLE av_link_name_cache;
    DROP INDEX collection_people_ja; DROP INDEX collection_people_wikidata;
    DROP INDEX collection_people_fanza;
    ALTER TABLE collection_av_details DROP COLUMN title_ja;
    ALTER TABLE collection_av_details DROP COLUMN release_date;
    ALTER TABLE collection_av_details DROP COLUMN maker;
    ALTER TABLE collection_av_details DROP COLUMN genres_json;
    ALTER TABLE collection_people DROP COLUMN name_ja;
    ALTER TABLE collection_people DROP COLUMN wikidata_id;
    ALTER TABLE collection_people DROP COLUMN fanza_actress_id;";
const INITIAL_SCHEMA: &str = include_str!("../../migrations/0001_initial.sql");
const VAULT_SAFETY_SCHEMA: &str = include_str!("../../migrations/0002_vault_safety.sql");
const SIMILARITY_REVIEW_SCHEMA: &str = include_str!("../../migrations/0003_similarity_review.sql");
const VIDEO_MEDIA_SCHEMA: &str = include_str!("../../migrations/0004_video_media.sql");
const MANGA_SCHEMA: &str = include_str!("../../migrations/0005_manga.sql");
const MANGA_MODIFIED_SCHEMA: &str = include_str!("../../migrations/0006_manga_modified.sql");
const CLASSIFICATION_APPEARANCE_SCHEMA: &str =
    include_str!("../../migrations/0007_classification_appearance.sql");
const ASSET_ALBUMS_SCHEMA: &str = include_str!("../../migrations/0008_asset_albums.sql");
const ASSET_SOURCE_PROVENANCE_SCHEMA: &str =
    include_str!("../../migrations/0009_asset_source_provenance.sql");
const COLLECTIONS_SCHEMA: &str = include_str!("../../migrations/0010_collections.sql");
const COLLECTIONS_TYPED_SCHEMA: &str =
    include_str!("../../migrations/0011_collections_typed_metadata.sql");
const COLLECTION_SOURCE_SCHEMA: &str = include_str!("../../migrations/0012_collection_source.sql");
const COLLECTION_EXTERNAL_BINDINGS_SCHEMA: &str =
    include_str!("../../migrations/0013_collection_external_bindings.sql");
const COLLECTION_WORK_ARTWORKS_SCHEMA: &str =
    include_str!("../../migrations/0014_collection_work_artworks.sql");
const COLLECTION_VOLUMES_SCHEMA: &str =
    include_str!("../../migrations/0015_collection_volumes.sql");
const ALADIN_VOLUME_SOURCES_SCHEMA: &str =
    include_str!("../../migrations/0016_aladin_volume_sources.sql");
const ALADIN_RELEASE_WATCH_SCHEMA: &str =
    include_str!("../../migrations/0017_aladin_release_watch.sql");
const ONLINE_CATALOG_SCHEMA: &str = include_str!("../../migrations/0018_online_catalog.sql");
const ONLINE_CATALOG_BOOKMARKS_SCHEMA: &str =
    include_str!("../../migrations/0019_online_catalog_bookmarks.sql");
const LEGACY_PACKAGE_IMPORTS_SCHEMA: &str =
    include_str!("../../migrations/0020_legacy_package_imports.sql");
const COLLECTION_LEGACY_KIND_SCHEMA: &str =
    include_str!("../../migrations/0021_collection_legacy_kind.sql");
const COLLECTION_FOUNDATION_SCHEMA: &str =
    include_str!("../../migrations/0022_collection_foundation.sql");
const GAME_PROVIDER_DETAIL_SCHEMA: &str =
    include_str!("../../migrations/0023_game_provider_detail.sql");
const MOVIE_PROVIDER_DETAIL_SCHEMA: &str =
    include_str!("../../migrations/0024_movie_provider_detail.sql");
const PDQ_SIMILARITY_SCHEMA: &str = include_str!("../../migrations/0025_pdq_similarity.sql");
const COLLECTED_AT_UTC_SCHEMA: &str = include_str!("../../migrations/0026_collected_at_utc.sql");

const REVISIT_SCHEMA: &str = include_str!("../../migrations/0027_revisit.sql");
const CLOUD_SYNC_QUEUE_SCHEMA: &str = include_str!("../../migrations/0028_cloud_sync_queue.sql");
const CLOUD_CAPTURE_IMPORTS_SCHEMA: &str =
    include_str!("../../migrations/0029_cloud_capture_imports.sql");
const CLOUD_BACKFILL_QUEUE_SCHEMA: &str =
    include_str!("../../migrations/0030_cloud_backfill_queue.sql");
const CLOUD_BACKFILL_CONTROL_SCHEMA: &str =
    include_str!("../../migrations/0031_cloud_backfill_control.sql");
const MANGA_CATALOG_RECOVERY_SCHEMA: &str =
    include_str!("../../migrations/0032_manga_catalog_recovery.sql");
const MANGA_CATALOG_RECOVERY_SOURCE_PATH_SCHEMA: &str =
    include_str!("../../migrations/0033_manga_catalog_recovery_source_path.sql");
const ONLINE_CATALOG_VISIBILITY_SCHEMA: &str =
    include_str!("../../migrations/0034_online_catalog_visibility.sql");
const ONLINE_CATALOG_GROUPS_SCHEMA: &str =
    include_str!("../../migrations/0035_online_catalog_groups.sql");

const ONLINE_CATALOG_COUNTS_SCHEMA: &str =
    include_str!("../../migrations/0036_online_catalog_counts.sql");

pub fn open_database(path: &Path) -> Result<Connection, LibraryError> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    Ok(connection)
}

pub fn initialize_database(path: &Path) -> Result<Connection, LibraryError> {
    initialize_database_with_dev_policy(
        path,
        // A debug build, but *not* a test harness. The guard exists to stop a running
        // development application from migrating a library nobody meant it to touch;
        // a test binary is not that, and the suite deliberately opens libraries built at
        // historical schema versions (which is how migrations are tested at all). Test
        // builds therefore take the release path, and the policy itself is still covered
        // directly by `dev_guard`'s tests through the explicit entry point below.
        cfg!(debug_assertions) && !cfg!(test),
        std::env::var(super::dev_guard::ALLOW_ENV).ok().as_deref(),
    )
}

/// The migration entry point with the development policy supplied explicitly.
///
/// Production passes the build's own debug flag and the real environment; tests pass both,
/// so the guard's behaviour is exercised without depending on how the test binary was
/// built. A watcher rebuilding a debug binary and reopening a real library is precisely
/// the case this refuses.
pub(crate) fn initialize_database_with_dev_policy(
    path: &Path,
    dev_build: bool,
    environment_value: Option<&str>,
) -> Result<Connection, LibraryError> {
    // Inspect existing schema read-only before WAL pragmas, snapshots, or migrations.
    if path.exists() {
        let existing =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let version: i64 = existing.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(LibraryError::UnsupportedSchema(version));
        }
        let root = path.parent().ok_or(LibraryError::InvalidCloudResponse)?;
        if super::dev_guard::dev_migration_decision(
            dev_build,
            version,
            SCHEMA_VERSION,
            super::dev_guard::is_declared_dev_library(root),
            super::dev_guard::environment_opt_in(environment_value),
        ) == super::dev_guard::DevMigrationDecision::Blocked
        {
            return Err(LibraryError::DevelopmentMigrationBlocked {
                root: root.display().to_string(),
                existing_version: version,
                schema_version: SCHEMA_VERSION,
            });
        }
    }
    let mut connection = open_database(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;

    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    match version {
        SCHEMA_VERSION => {}
        version if (0..SCHEMA_VERSION).contains(&version) => {
            // Refuse before touching anything: the pre-migration snapshot is *writing* to
            // the library, and the snapshot alone does not make rewriting someone's
            // production library an acceptable default.
            let root = path
                .parent()
                .expect("database paths have a parent directory");
            if super::dev_guard::dev_migration_decision(
                dev_build,
                version,
                SCHEMA_VERSION,
                super::dev_guard::is_declared_dev_library(root),
                super::dev_guard::environment_opt_in(environment_value),
            ) == super::dev_guard::DevMigrationDecision::Blocked
            {
                return Err(LibraryError::DevelopmentMigrationBlocked {
                    root: root.display().to_string(),
                    existing_version: version,
                    schema_version: SCHEMA_VERSION,
                });
            }
            if version > 0 {
                let snapshot = backup::pre_migration_snapshot_path(root, version);
                backup::create_verified_snapshot(&connection, &snapshot)?;
                backup::prune_pre_migration_backups(root, &snapshot);
            }
            migrate_to_latest(&mut connection, version)?;
        }
        other => return Err(LibraryError::UnsupportedSchema(other)),
    }
    Ok(connection)
}

fn migrate_to_latest(connection: &mut Connection, version: i64) -> Result<(), LibraryError> {
    connection.pragma_update(None, "foreign_keys", "OFF")?;
    let migration = (|| {
        let transaction = connection.transaction()?;
        if version == 0 {
            transaction.execute_batch(INITIAL_SCHEMA)?;
        }
        if version <= 1 {
            transaction.execute_batch(VAULT_SAFETY_SCHEMA)?;
        }
        if version <= 2 {
            transaction.execute_batch(SIMILARITY_REVIEW_SCHEMA)?;
        }
        if version <= 3 {
            transaction.execute_batch(VIDEO_MEDIA_SCHEMA)?;
        }
        if version <= 4 {
            transaction.execute_batch(MANGA_SCHEMA)?;
        }
        if version <= 5 {
            transaction.execute_batch(MANGA_MODIFIED_SCHEMA)?;
        }
        if version <= 6 {
            transaction.execute_batch(CLASSIFICATION_APPEARANCE_SCHEMA)?;
        }
        if version <= 7 {
            transaction.execute_batch(ASSET_ALBUMS_SCHEMA)?;
        }
        if version <= 8 {
            transaction.execute_batch(ASSET_SOURCE_PROVENANCE_SCHEMA)?;
        }
        if version <= 9 {
            transaction.execute_batch(COLLECTIONS_SCHEMA)?;
        }
        if version <= 10 {
            transaction.execute_batch(COLLECTIONS_TYPED_SCHEMA)?;
        }
        if version <= 11 {
            transaction.execute_batch(COLLECTION_SOURCE_SCHEMA)?;
        }
        if version <= 12 {
            transaction.execute_batch(COLLECTION_EXTERNAL_BINDINGS_SCHEMA)?;
        }
        if version <= 13 {
            transaction.execute_batch(COLLECTION_WORK_ARTWORKS_SCHEMA)?;
        }
        if version <= 14 {
            transaction.execute_batch(COLLECTION_VOLUMES_SCHEMA)?;
        }
        if version <= 15 {
            transaction.execute_batch(ALADIN_VOLUME_SOURCES_SCHEMA)?;
        }
        if version <= 16 {
            transaction.execute_batch(ALADIN_RELEASE_WATCH_SCHEMA)?;
        }
        if version <= 17 {
            transaction.execute_batch(ONLINE_CATALOG_SCHEMA)?;
        }
        if version <= 18 {
            transaction.execute_batch(ONLINE_CATALOG_BOOKMARKS_SCHEMA)?;
        }
        if version <= 19 {
            transaction.execute_batch(LEGACY_PACKAGE_IMPORTS_SCHEMA)?;
        }
        if version <= 20 {
            transaction.execute_batch(COLLECTION_LEGACY_KIND_SCHEMA)?;
        }
        if version <= 21 {
            transaction.execute_batch(COLLECTION_FOUNDATION_SCHEMA)?;
        }
        if version <= 22 {
            transaction.execute_batch(GAME_PROVIDER_DETAIL_SCHEMA)?;
        }
        if version <= 23 {
            transaction.execute_batch(MOVIE_PROVIDER_DETAIL_SCHEMA)?;
        }
        if version <= 24 {
            transaction.execute_batch(PDQ_SIMILARITY_SCHEMA)?;
        }
        if version <= 25 {
            transaction.execute_batch(COLLECTED_AT_UTC_SCHEMA)?;
        }
        if version <= 26 {
            transaction.execute_batch(REVISIT_SCHEMA)?;
        }
        if version <= 27 {
            transaction.execute_batch(CLOUD_SYNC_QUEUE_SCHEMA)?;
        }
        if version <= 28 {
            transaction.execute_batch(CLOUD_CAPTURE_IMPORTS_SCHEMA)?;
        }
        if version <= 29 {
            transaction.execute_batch(CLOUD_BACKFILL_QUEUE_SCHEMA)?;
        }
        if version <= 30 {
            transaction.execute_batch(CLOUD_BACKFILL_CONTROL_SCHEMA)?;
        }
        if version <= 31 {
            transaction.execute_batch(MANGA_CATALOG_RECOVERY_SCHEMA)?;
        }
        if version <= 32 {
            transaction.execute_batch(MANGA_CATALOG_RECOVERY_SOURCE_PATH_SCHEMA)?;
        }
        if version <= 33 {
            transaction.execute_batch(ONLINE_CATALOG_VISIBILITY_SCHEMA)?;
        }
        if version <= 34 {
            transaction.execute_batch(ONLINE_CATALOG_GROUPS_SCHEMA)?;
        }
        if version <= 35 {
            transaction.execute_batch(ONLINE_CATALOG_COUNTS_SCHEMA)?;
        }
        if version <= 36 {
            transaction.execute_batch(include_str!("../../migrations/0037_catalog_review.sql"))?;
        }
        if version <= 37 {
            transaction.execute_batch(include_str!("../../migrations/0038_cloud_settings.sql"))?;
        }
        if version <= 38 {
            transaction.execute_batch(include_str!(
                "../../migrations/0039_cloud_metadata_status.sql"
            ))?;
        }
        if version <= 39 {
            transaction.execute_batch(include_str!(
                "../../migrations/0040_book_release_providers.sql"
            ))?;
        }
        if version <= 40 {
            transaction.execute_batch(include_str!(
                "../../migrations/0041_collection_ownership.sql"
            ))?;
        }
        if version <= 41 {
            transaction.execute_batch(include_str!("../../migrations/0042_statistics.sql"))?;
        }
        if version <= 42 {
            transaction.execute_batch(include_str!("../../migrations/0043_notes.sql"))?;
        }
        if version <= 43 {
            transaction.execute_batch(include_str!("../../migrations/0044_characters.sql"))?;
        }
        if version <= 44 {
            transaction
                .execute_batch(include_str!("../../migrations/0045_video_similarity.sql"))?;
        }
        if version <= 45 {
            transaction.execute_batch(include_str!("../../migrations/0046_collection_av.sql"))?;
        }
        if version <= 46 {
            transaction.execute_batch(include_str!(
                "../../migrations/0047_similarity_orientation.sql"
            ))?;
        }
        if version <= 47 {
            transaction.execute_batch(include_str!("../../migrations/0048_character_hub.sql"))?;
        }
        if version <= 48 {
            transaction.execute_batch(include_str!("../../migrations/0049_capture_poll.sql"))?;
        }
        if version <= 49 {
            transaction
                .execute_batch(include_str!("../../migrations/0050_character_autotag.sql"))?;
        }
        if version <= 50 {
            transaction.execute_batch(include_str!(
                "../../migrations/0051_character_autotag_runtime.sql"
            ))?;
        }
        if version <= 51 {
            transaction.execute_batch(include_str!(
                "../../migrations/0052_character_reference_exclusions.sql"
            ))?;
        }
        if version <= 52 {
            transaction
                .execute_batch(include_str!("../../migrations/0053_character_groups.sql"))?;
        }
        if version <= 53 {
            transaction.execute_batch(include_str!(
                "../../migrations/0054_character_reconsideration.sql"
            ))?;
        }
        if version <= 54 {
            transaction.execute_batch(include_str!(
                "../../migrations/0055_explicit_character_learning.sql"
            ))?;
        }
        if version <= 55 {
            transaction.execute_batch(include_str!(
                "../../migrations/0056_explicit_character_learning_triggers.sql"
            ))?;
        }
        if version <= 56 {
            transaction.execute_batch(include_str!(
                "../../migrations/0057_character_series_suggestions.sql"
            ))?;
        }
        if version <= 57 {
            transaction.execute_batch(include_str!(
                "../../migrations/0058_character_workflow_ux.sql"
            ))?;
        }
        if version <= 58 {
            transaction
                .execute_batch(include_str!("../../migrations/0059_manual_characters.sql"))?;
        }
        if version <= 59 {
            transaction.execute_batch(include_str!(
                "../../migrations/0060_character_correctness.sql"
            ))?;
        }
        if version <= 60 {
            transaction.execute_batch(include_str!(
                "../../migrations/0061_character_correctness_forward_repair.sql"
            ))?;
        }
        if version <= 61 {
            transaction.execute_batch(include_str!(
                "../../migrations/0062_character_browse_performance.sql"
            ))?;
        }
        if version <= 62 {
            transaction.execute_batch(include_str!(
                "../../migrations/0063_character_review_performance.sql"
            ))?;
        }
        if version <= 63 {
            transaction.execute_batch(include_str!(
                "../../migrations/0064_character_review_completion.sql"
            ))?;
        }
        if version <= 64 {
            transaction.execute_batch(include_str!(
                "../../migrations/0065_character_superseded_review_state.sql"
            ))?;
        }
        if version <= 65 {
            transaction.execute_batch(include_str!(
                "../../migrations/0066_quiet_character_workflow.sql"
            ))?;
        }
        if version <= 66 {
            transaction.execute_batch(include_str!(
                "../../migrations/0067_character_reference_refresh_pause.sql"
            ))?;
        }
        if version <= 67 {
            transaction.execute_batch(include_str!(
                "../../migrations/0068_character_reference_refresh_cursor.sql"
            ))?;
        }
        if version <= 68 {
            transaction.execute_batch(include_str!(
                "../../migrations/0069_character_reference_refresh_cursor_repair.sql"
            ))?;
            // Early development v68 databases only added discovery_complete.
            // SQLite has no ADD COLUMN IF NOT EXISTS; preserve complete v68 cursors.
            let has_cursor: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('character_reference_refreshes') WHERE name='through_job_sequence')",
                [], |row| row.get(0),
            )?;
            if !has_cursor {
                transaction.execute_batch(
                    "ALTER TABLE character_reference_refreshes
                     ADD COLUMN through_job_sequence INTEGER NOT NULL DEFAULT 0 CHECK(through_job_sequence >= 0);
                     UPDATE character_reference_refreshes
                     SET through_job_sequence=(SELECT COALESCE(MAX(sequence),0) FROM character_autotag_admissions)
                     WHERE state IN ('pending','running') AND discovery_complete=0;"
                )?;
            }
        }
        if version <= 69 {
            transaction.execute_batch(include_str!(
                "../../migrations/0070_asset_membership_lookup.sql"
            ))?;
        }
        if version <= 70 {
            transaction.execute_batch(include_str!(
                "../../migrations/0071_character_folder_exclusions.sql"
            ))?;
        }
        if version <= 71 {
            transaction.execute_batch(include_str!(
                "../../migrations/0072_empty_character_groups.sql"
            ))?;
        }
        if version <= 72 {
            transaction.execute_batch(include_str!(
                "../../migrations/0073_collection_daily_updates.sql"
            ))?;
        }
        if version <= 73 {
            transaction
                .execute_batch(include_str!("../../migrations/0074_mobile_publication.sql"))?;
        }
        if version <= 74 {
            transaction.execute_batch(include_str!(
                "../../migrations/0075_mobile_catalog_visibility.sql"
            ))?;
        }
        if version <= 75 {
            transaction.execute_batch(include_str!(
                "../../migrations/0076_cloud_metadata_publication.sql"
            ))?;
        }
        if version <= 76 {
            transaction.execute_batch(include_str!("../../migrations/0077_private_vault.sql"))?;
        }
        if version <= 77 {
            transaction.execute_batch(include_str!(
                "../../migrations/0078_character_reference_regions.sql"
            ))?;
        }
        if version <= 78 {
            transaction
                .execute_batch(include_str!("../../migrations/0079_library_identity.sql"))?;
            validate_library_identity(&transaction)?;
        }
        if version <= 79 {
            transaction.execute_batch(include_str!(
                "../../migrations/0080_bookmark_reconciliation.sql"
            ))?;
        }
        if version <= 80 {
            transaction.execute_batch(include_str!("../../migrations/0081_bookmark_outbox.sql"))?;
        }
        if version <= 81 {
            transaction.execute_batch(include_str!("../../migrations/0082_album_authority.sql"))?;
        }
        if version <= 82 {
            transaction.execute_batch(include_str!(
                "../../migrations/0083_classification_authority.sql"
            ))?;
        }
        if version <= 83 {
            transaction.execute_batch(include_str!(
                "../../migrations/0084_classification_authority_outbox.sql"
            ))?;
        }
        if version <= 84 {
            transaction.execute_batch(include_str!(
                "../../migrations/0085_classification_legacy_trigger_retirement.sql"
            ))?;
        }
        if version <= 85 {
            transaction.execute_batch(include_str!(
                "../../migrations/0086_classification_preapplied_deletes.sql"
            ))?;
        }
        if version <= 86 {
            transaction.execute_batch(include_str!(
                "../../migrations/0087_cloud_activity_reason.sql"
            ))?;
        }
        if version <= 87 {
            transaction.execute_batch(include_str!("../../migrations/0088_asset_authority.sql"))?;
        }
        if version <= 88 {
            transaction.execute_batch(include_str!(
                "../../migrations/0089_mobile_character_exclusions.sql"
            ))?;
        }
        if version <= 89 {
            transaction.execute_batch(include_str!(
                "../../migrations/0090_historical_similarity.sql"
            ))?;
        }
        if version <= 90 {
            transaction.execute_batch(include_str!(
                "../../migrations/0091_mobile_collection_personal_edits.sql"
            ))?;
        }
        if version <= 91 {
            transaction.execute_batch(include_str!(
                "../../migrations/0092_mobile_character_review.sql"
            ))?;
        }
        if version <= 92 {
            transaction.execute_batch(include_str!(
                "../../migrations/0093_trash_purge_pending.sql"
            ))?;
        }
        if version <= 93 {
            transaction.execute_batch(include_str!(
                "../../migrations/0094_mobile_similarity_review.sql"
            ))?;
        }
        if version <= 94 {
            transaction.execute_batch(include_str!(
                "../../migrations/0095_authority_intent_drops.sql"
            ))?;
        }
        if version <= 95 {
            transaction
                .execute_batch(include_str!("../../migrations/0096_notes_base_payload.sql"))?;
        }
        if version <= 96 {
            transaction.execute_batch(include_str!(
                "../../migrations/0097_catalog_duplicate_sync.sql"
            ))?;
        }
        if version <= 97 {
            transaction
                .execute_batch(include_str!("../../migrations/0098_release_calendar.sql"))?;
        }
        if version <= 98 {
            transaction.execute_batch(include_str!(
                "../../migrations/0099_character_exclusion_skip_reason.sql"
            ))?;
        }
        if version <= 99 {
            transaction.execute_batch(include_str!("../../migrations/0100_artists.sql"))?;
        }
        if version <= 100 {
            transaction.execute_batch(include_str!(
                "../../migrations/0101_character_broad_folder_scope.sql"
            ))?;
        }
        if version <= 101 {
            transaction.execute_batch(include_str!("../../migrations/0102_auto_tags.sql"))?;
        }
        if version <= 102 {
            transaction.execute_batch(include_str!(
                "../../migrations/0103_character_folder_order.sql"
            ))?;
        }
        if version <= 103 {
            transaction.execute_batch(include_str!("../../migrations/0104_av_link.sql"))?;
        }
        if version <= 104 {
            transaction.execute_batch(include_str!("../../migrations/0105_tagger_review.sql"))?;
        }
        if version <= 105 {
            transaction.execute_batch(include_str!("../../migrations/0106_character_suggestions.sql"))?;
        }
        if version <= 106 {
            transaction.execute_batch(include_str!("../../migrations/0107_av_portraits.sql"))?;
        }
        if version <= 107 {
            transaction.execute_batch(include_str!("../../migrations/0108_release_calendar_anime.sql"))?;
        }
        if version <= 108 {
            transaction.execute_batch(include_str!("../../migrations/0109_home_publications.sql"))?;
        }
        if version <= 109 {
            transaction.execute_batch(include_str!("../../migrations/0110_artist_style.sql"))?;
        }
        if version <= 110 {
            transaction.execute_batch(include_str!(
                "../../migrations/0111_artist_exclusions.sql"
            ))?;
        }
        if version <= 111 {
            transaction.execute_batch(include_str!("../../migrations/0112_av_performer_profiles.sql"))?;
        }
        if version <= 112 {
            transaction.execute_batch(include_str!(
                "../../migrations/0113_collection_volume_range.sql"
            ))?;
        }
        if version <= 113 {
            transaction.execute_batch(include_str!(
                "../../migrations/0114_home_continue_favorites.sql"
            ))?;
        }
        if version <= 114 {
            transaction.execute_batch(include_str!(
                "../../migrations/0115_release_watch_port_platforms.sql"
            ))?;
        }
        if version <= 115 {
            transaction.execute_batch(include_str!("../../migrations/0116_collection_pc_records.sql"))?;
        }
        if version <= 116 {
            transaction.execute_batch(include_str!(
                "../../migrations/0117_collection_publication_triggers.sql"
            ))?;
        }
        if version <= 117 {
            transaction.execute_batch(include_str!("../../migrations/0118_manga_index_pins.sql"))?;
        }
        if version <= 118 {
            transaction.execute_batch(include_str!("../../migrations/0119_manga_index_pin_sync.sql"))?;
        }
        if version <= 119 {
            transaction.execute_batch(include_str!("../../migrations/0120_auto_tag_publication.sql"))?;
        }
        if version <= 120 {
            transaction.execute_batch(include_str!("../../migrations/0121_likes_album.sql"))?;
        }
        if version <= 121 {
            transaction.execute_batch(include_str!("../../migrations/0122_collection_authority.sql"))?;
        }
        if version <= 122 {
            transaction.execute_batch(include_str!("../../migrations/0123_character_tagger_tag_exclusions.sql"))?;
        }
        if version <= 123 {
            transaction.execute_batch(include_str!("../../migrations/0124_av_authority_limits.sql"))?;
        }
        if version <= 124 {
            transaction.execute_batch(include_str!("../../migrations/0125_av_people_authority.sql"))?;
        }
        if version <= 125 {
            transaction.execute_batch(include_str!("../../migrations/0126_caption_publication.sql"))?;
        }
        if version <= 126 {
            transaction.execute_batch(include_str!("../../migrations/0127_character_extras.sql"))?;
        }
        if version <= 127 {
            transaction.execute_batch(include_str!(
                "../../migrations/0128_character_group_position.sql"
            ))?;
        }
        if version <= 128 {
            transaction
                .execute_batch(include_str!("../../migrations/0129_asset_image_text.sql"))?;
        }
        if version <= 129 {
            transaction.execute_batch(include_str!("../../migrations/0130_character_folder_perf.sql"))?;
        }
        if version <= 130 {
            transaction.execute_batch(include_str!("../../migrations/0131_character_claude.sql"))?;
        }
        if version <= 131 {
            transaction.execute_batch(include_str!("../../migrations/0132_character_claude_cache_tokens.sql"))?;
        }
        if version < 133 {
            transaction.execute_batch(include_str!("../../migrations/0133_character_reference_reinforcement.sql"))?;
        }
        if version < 134 {
            transaction.execute_batch(include_str!("../../migrations/0134_classification_containers.sql"))?;
        }
        // Validate before commit so a failed migration leaves the old DB intact.
        if transaction
            .prepare("PRAGMA foreign_key_check")?
            .exists([])?
        {
            return Err(LibraryError::Database(rusqlite::Error::InvalidQuery));
        }
        transaction.commit()?;
        Ok::<(), LibraryError>(())
    })();
    connection.pragma_update(None, "foreign_keys", "ON")?;
    migration?;

    Ok(())
}

/// Stable identity invariant: 32 lowercase hexadecimal characters, nothing else.
pub(crate) fn is_valid_library_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Narrow pre-commit check for migration 0079: exactly one singleton settings row
/// carrying one valid identity. Deliberately not a general schema validator.
fn validate_library_identity(connection: &Connection) -> Result<(), LibraryError> {
    let valid: i64 = connection.query_row(
        "SELECT COUNT(*) FROM library_settings
         WHERE singleton = 1
           AND library_id IS NOT NULL
           AND length(library_id) = 32
           AND library_id NOT GLOB '*[^0-9a-f]*'",
        [],
        |row| row.get(0),
    )?;
    let total: i64 = connection.query_row("SELECT COUNT(*) FROM library_settings", [], |row| {
        row.get(0)
    })?;
    if valid != 1 || total != 1 {
        return Err(LibraryError::Database(rusqlite::Error::InvalidQuery));
    }
    Ok(())
}

/// Only the temporary copy of an already verified restore snapshot reaches here.
/// The original selected backup and current pre-restore snapshot stay untouched.
pub(super) fn prepare_snapshot_for_restore(path: &Path) -> Result<(), LibraryError> {
    let mut connection = open_database(path)?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if !(1..=SCHEMA_VERSION).contains(&version) {
        return Err(LibraryError::UnsupportedSchema(version));
    }
    if version < SCHEMA_VERSION {
        migrate_to_latest(&mut connection, version)?;
    }
    if connection.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(LibraryError::Database(rusqlite::Error::InvalidQuery));
    }
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(())
}

#[cfg(test)]
#[path = "library_identity_tests.rs"]
mod library_identity_tests;

#[cfg(test)]
#[path = "release_calendar_migration_tests.rs"]
mod release_calendar_migration_tests;

#[cfg(test)]
#[path = "db_tests.rs"]
pub(super) mod tests;

#[cfg(test)]
#[path = "db_dev_guard_enforcement_tests.rs"]
mod dev_guard_enforcement_tests;

#[cfg(test)]
#[path = "db_collection_pc_migration_tests.rs"]
mod collection_pc_migration_tests;

#[cfg(test)]
#[path = "db_collection_publication_migration_tests.rs"]
mod collection_publication_migration_tests;

#[cfg(test)]
#[path = "db_manga_index_migration_tests.rs"]
mod manga_index_migration_tests;

#[cfg(test)]
#[path = "db_container_migration_tests.rs"]
mod container_migration_tests;
