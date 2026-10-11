use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use rusqlite::params;
use sha2::{Digest, Sha256};

use super::*;
use crate::library::{
    character_groups::GroupDraft,
    characters::{DecisionKind, DecisionRequest, TargetDraft},
    classification_authority::{ASSIGNMENT, DELETE},
    models::{ClassificationKind, CreateClassification},
};

const LIBRARY: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

struct Env {
    library: Library,
    temp: tempfile::TempDir,
    series: String,
    /// Folder name -> id.
    folders: BTreeMap<String, String>,
    /// Character name -> id.
    targets: BTreeMap<String, String>,
}

impl Env {
    fn folder(&mut self, name: &str, parent: &str) -> String {
        let id = self
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: name.into(),
                parent_id: Some(parent.into()),
            })
            .unwrap()
            .id;
        self.folders.insert(name.into(), id.clone());
        id
    }

    fn asset(&self, id: &str, folder: &str) {
        let original = format!("assets/{id}.png");
        let thumbnail = format!("thumbnails/{id}.webp");
        fs::write(self.temp.path().join(&original), id.as_bytes()).unwrap();
        fs::write(self.temp.path().join(&thumbnail), id.as_bytes()).unwrap();
        let connection = self.library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,
                  byte_size,width,height,collected_at,status)
                 VALUES(?1,?2,'image',?1,?3,?4,7,1,1,'2026-09-08','normal')",
                params![
                    id,
                    Sha256::digest(id.as_bytes())
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>(),
                    original,
                    thumbnail
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_classifications VALUES(?1,?2)",
                params![id, self.folders[folder]],
            )
            .unwrap();
    }

    fn assets(&self, prefix: &str, count: usize, folder: &str) {
        for n in 1..=count {
            self.asset(&format!("{prefix}-{n}"), folder);
        }
    }

    fn character(&mut self, name: &str, series: &str, assets: &[&str]) -> String {
        let target = self
            .library
            .save_character_target(TargetDraft {
                id: None,
                expected_revision: None,
                series_classification_id: Some(series.into()),
                linked_classification_id: None,
                display_name: name.into(),
                description: String::new(),
                thumbnail_asset_id: None,
                enabled: true,
            })
            .unwrap();
        if !assets.is_empty() {
            let fresh = self.library.get_character_target(&target.id).unwrap();
            self.library
                .record_character_decisions(DecisionRequest {
                    target_id: fresh.id.clone(),
                    expected_fingerprint: fresh.fingerprint,
                    asset_ids: assets.iter().map(|id| id.to_string()).collect(),
                    decision: DecisionKind::Accepted,
                    baseline_fingerprint: None,
                    scan_id: None,
                })
                .unwrap();
        }
        self.targets.insert(name.into(), target.id.clone());
        target.id
    }

    fn count(&self, sql: &str) -> i64 {
        self.library
            .connection()
            .unwrap()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }

    fn registered(&self, folder: &str) -> bool {
        self.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",
                [&self.folders[folder]],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn exists(&self, folder: &str) -> bool {
        self.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM classification_entries WHERE id=?1)",
                [&self.folders[folder]],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// Folder names an asset is classified in.
    fn homes(&self, asset: &str) -> Vec<String> {
        let ids = self
            .library
            .connection()
            .unwrap()
            .prepare(
                "SELECT classification_id FROM asset_classifications WHERE asset_id=?1 ORDER BY 1",
            )
            .unwrap()
            .query_map([asset], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        ids.into_iter()
            .map(|id| {
                self.folders
                    .iter()
                    .find(|(_, folder)| **folder == id)
                    .map(|(name, _)| name.clone())
                    .unwrap_or(id)
            })
            .collect()
    }

    fn members(&self, target_id: &str) -> BTreeSet<String> {
        self.library
            .connection()
            .unwrap()
            .prepare("SELECT asset_id FROM character_relations WHERE target_id=?1")
            .unwrap()
            .query_map([target_id], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap()
    }

    fn outbox(&self, command: &str) -> i64 {
        self.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM classification_authority_outbox WHERE command_type=?1",
                [command],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// (group name, member names, 기타 images) of the series' groups.
    fn groups(&self) -> BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)> {
        let by_id = self
            .targets
            .iter()
            .map(|(name, id)| (id.clone(), name.clone()))
            .collect::<BTreeMap<_, _>>();
        self.library
            .character_groups(&self.series)
            .unwrap()
            .into_iter()
            .map(|group| {
                (
                    group.name,
                    (
                        group
                            .target_ids
                            .iter()
                            .map(|id| by_id[id].clone())
                            .collect(),
                        group
                            .extras_target_id
                            .map(|id| self.members(&id))
                            .unwrap_or_default(),
                    ),
                )
            })
            .collect()
    }

    fn series_extras(&self) -> BTreeSet<String> {
        let id: Option<String> = self
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT id FROM character_targets
                 WHERE role='extras' AND series_classification_id=?1 AND extras_group_id IS NULL",
                [&self.series],
                |row| row.get(0),
            )
            .ok();
        id.map(|id| self.members(&id)).unwrap_or_default()
    }

    fn choice(&self, folder: &str, action: CleanupAction) -> CleanupFolderChoice {
        CleanupFolderChoice {
            folder_id: self.folders[folder].clone(),
            action,
            group_name: None,
        }
    }

    /// The choices the controller makes for the whole fixture.
    fn request(&self, plan: &CleanupPlan) -> CleanupRequest {
        CleanupRequest {
            series_id: self.series.clone(),
            expected_plan_fingerprint: plan.fingerprint.clone(),
            folders: vec![
                self.choice("Alpha", CleanupAction::Group),
                self.choice("Empty", CleanupAction::Group),
                self.choice("Keep", CleanupAction::Keep),
                self.choice("Mark", CleanupAction::Lift),
                self.choice("Plain", CleanupAction::Group),
                CleanupFolderChoice {
                    group_name: Some("Solo team".into()),
                    ..self.choice("Solo", CleanupAction::Group)
                },
            ],
            character_groups: vec![CleanupCharacterChoice {
                target_id: self.targets["Tie"].clone(),
                group_folder_id: Some(self.folders["Plain"].clone()),
            }],
        }
    }

    fn snapshot(&self) -> (Vec<(String, String)>, i64, i64, i64) {
        let links = self
            .library
            .connection()
            .unwrap()
            .prepare("SELECT asset_id,classification_id FROM asset_classifications ORDER BY 1,2")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        (
            links,
            self.count("SELECT COUNT(*) FROM classification_authority_outbox"),
            self.count("SELECT COUNT(*) FROM character_groups"),
            self.count("SELECT COUNT(*) FROM character_targets"),
        )
    }
}

/// Series with six direct sub-folders:
/// Alpha (nested series: Ann, Bob; a plain sub-folder), Mark (nested series: one character),
/// Plain, Solo (images no character holds), Keep and Empty. The classification authority is
/// adopted before anything is created, so every move queues an intent.
fn build() -> Env {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    library
        .adopt_classification_authority_for_test(LIBRARY, 1, 1, 0)
        .unwrap();
    let root = library
        .create_classification(CreateClassification {
            kind: ClassificationKind::Root,
            name: "Root".into(),
            parent_id: None,
        })
        .unwrap()
        .id;
    let mut env = Env {
        library,
        temp,
        series: String::new(),
        folders: BTreeMap::new(),
        targets: BTreeMap::new(),
    };
    let series = env.folder("Series", &root);
    env.series = series.clone();
    for name in ["Alpha", "Mark", "Plain", "Solo", "Keep", "Empty"] {
        env.folder(name, &series);
    }
    let alpha = env.folders["Alpha"].clone();
    env.folder("Alpha Sub", &alpha);

    env.assets("d", 3, "Series");
    env.assets("a", 6, "Alpha");
    env.assets("as", 2, "Alpha Sub");
    env.assets("m", 3, "Mark");
    env.assets("p", 10, "Plain");
    env.assets("s", 4, "Solo");
    env.assets("k", 1, "Keep");

    // Characters of the series.
    env.character("Sia", &series, &["p-1", "p-2", "p-3"]);
    env.character("Tie", &series, &["p-4", "p-5", "s-1", "s-2"]);
    env.character("Weak", &series, &["p-6"]);
    env.character("Direct", &series, &["d-1", "d-2", "d-3", "p-7"]);
    let eve = env.character("Eve", &series, &["p-10"]);
    env.library
        .save_character_group(GroupDraft {
            id: None,
            series_id: series.clone(),
            expected_revision: None,
            name: "Old".into(),
            target_ids: vec![eve],
            delete: false,
        })
        .unwrap();
    // Nested series.
    env.character("Ann", &alpha, &["a-1", "a-2", "a-3", "as-1"]);
    env.character("Bob", &alpha, &["a-4", "a-5"]);
    let mark = env.folders["Mark"].clone();
    env.character("Marc", &mark, &["m-1", "m-2"]);
    env
}

#[test]
fn the_plan_describes_folders_characters_and_proposals_without_writing() {
    let env = build();
    let before = env.snapshot();
    let plan = env
        .library
        .character_subfolder_cleanup_plan(&env.series)
        .unwrap();
    assert_eq!(env.snapshot(), before);
    assert_eq!(plan.series_name, "Series");
    assert_eq!(
        plan.folders
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>(),
        ["Alpha", "Empty", "Keep", "Mark", "Plain", "Solo"]
    );
    let folder = |name: &str| plan.folders.iter().find(|f| f.name == name).unwrap();
    let alpha = folder("Alpha");
    assert_eq!(
        (
            alpha.image_count,
            alpha.images_without_character,
            alpha.folder_count
        ),
        (8, 2, 2)
    );
    assert!(alpha.is_series);
    assert_eq!(alpha.nested_series.len(), 1);
    assert_eq!(alpha.nested_series[0].characters.len(), 2);
    assert_eq!(alpha.proposed_action, CleanupAction::Group);
    assert_eq!(alpha.default_group_name, "Alpha");
    let mark = folder("Mark");
    assert_eq!(mark.proposed_action, CleanupAction::Lift);
    assert_eq!((mark.image_count, mark.images_without_character), (3, 1));
    let plain = folder("Plain");
    assert_eq!((plain.image_count, plain.images_without_character), (10, 2));
    assert_eq!(plain.proposed_action, CleanupAction::Group);
    assert_eq!(folder("Solo").images_without_character, 2);
    assert_eq!(folder("Empty").image_count, 0);

    let character = |name: &str| plan.characters.iter().find(|c| c.name == name).unwrap();
    assert_eq!(plan.characters.len(), 8);
    assert_eq!(
        character("Sia").proposed_group_folder_id.as_deref(),
        Some(env.folders["Plain"].as_str())
    );
    assert!(!character("Sia").weak);
    assert!(character("Weak").weak);
    assert_eq!(
        character("Weak").proposed_group_folder_id.as_deref(),
        Some(env.folders["Plain"].as_str())
    );
    let tie = character("Tie");
    assert!(tie.proposed_group_folder_id.is_none());
    assert_eq!(
        tie.tie
            .clone()
            .unwrap()
            .into_iter()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([env.folders["Plain"].clone(), env.folders["Solo"].clone()])
    );
    // Images directly in the series do not compete (decision C): its one team-folder image decides.
    let direct = character("Direct");
    assert_eq!(
        (
            direct.direct_count,
            direct.proposed_group_folder_id.as_deref(),
            direct.weak
        ),
        (3, Some(env.folders["Plain"].as_str()), true)
    );
    assert!(direct.tie.is_none());
    // Already in a group: it stays there.
    assert_eq!(character("Eve").current_group_name.as_deref(), Some("Old"));
    assert!(character("Eve").proposed_group_folder_id.is_none());
    // Nested characters know where they come from; Marc's folder is lifted, not a group.
    assert_eq!(
        character("Ann").from_folder_id.as_deref(),
        Some(env.folders["Alpha"].as_str())
    );
    assert_eq!(
        character("Ann").proposed_group_folder_id.as_deref(),
        Some(env.folders["Alpha"].as_str())
    );
    assert!(character("Marc").proposed_group_folder_id.is_none());
    assert_eq!(
        plan.series_to_unregister
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["Alpha", "Mark"]
    );
    assert_eq!(
        plan.moving_characters
            .iter()
            .map(|c| c.name.clone())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["Ann".to_owned(), "Bob".to_owned(), "Marc".to_owned()])
    );
    assert!(plan.collisions.is_empty());
    assert_eq!(plan.direct_image_count, 3);
    // Folders that disappear: the 7 below the series.
    assert_eq!(plan.folders_to_remove.len(), 7);
    assert!(plan.folders_to_remove.iter().any(|f| f.name == "Alpha Sub"));
}

#[test]
fn apply_groups_lifts_fills_extras_and_removes_the_emptied_folders() {
    let env = build();
    let plan = env
        .library
        .character_subfolder_cleanup_plan(&env.series)
        .unwrap();
    let request = env.request(&plan);
    let hashes_before = env.count("SELECT COUNT(DISTINCT content_hash) FROM assets");
    let paths_before = env
        .library
        .connection()
        .unwrap()
        .prepare("SELECT id,relative_path,content_hash FROM assets ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    let ann_before = env.members(&env.targets["Ann"]);
    let assignments_before = env.outbox(ASSIGNMENT);

    let result = env
        .library
        .apply_character_subfolder_cleanup(request.clone())
        .unwrap();
    assert!(result.changed && !result.already_applied);
    assert_eq!(
        result
            .series_unregistered
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["Alpha", "Mark"]
    );
    assert_eq!(result.characters_moved, 3);
    assert_eq!(result.characters_grouped, 6);
    // 8 + 3 + 10 + 4 images left their team folders.
    assert_eq!(result.images_lifted, 25);
    assert_eq!(result.series_extras_count, 1);
    assert_eq!(
        result
            .groups_skipped
            .iter()
            .map(|g| g.name.as_str())
            .collect::<Vec<_>>(),
        ["Empty"]
    );
    assert_eq!(result.groups_created.len(), 3);
    assert!(result.folders_kept.is_empty());
    assert_eq!(result.folders_removed.len(), 6);

    // Nested series are gone from the registry; the series itself stays.
    assert!(!env.registered("Alpha") && !env.registered("Mark"));
    assert!(env.registered("Series"));
    // Groups: the old one is untouched, three new ones.
    let groups = env.groups();
    let names = |list: &[&str]| list.iter().map(|n| n.to_string()).collect::<BTreeSet<_>>();
    assert_eq!(groups.len(), 4);
    assert_eq!(groups["Old"], (names(&["Eve"]), BTreeSet::new()));
    assert_eq!(
        groups["Alpha"],
        (names(&["Ann", "Bob"]), names(&["a-6", "as-2"]))
    );
    assert_eq!(
        groups["Plain"],
        (
            names(&["Direct", "Sia", "Tie", "Weak"]),
            names(&["p-8", "p-9"])
        )
    );
    // A group with only a 기타, under the name the person gave.
    assert_eq!(
        groups["Solo team"],
        (BTreeSet::new(), names(&["s-3", "s-4"]))
    );
    // The one-character series: its character joins the series without a group, and its
    // image without a character goes to the series' own 기타.
    assert!(!groups.values().any(|(members, _)| members.contains("Marc")));
    assert_eq!(env.series_extras(), names(&["m-3"]));
    let marc = env
        .library
        .get_character_target(&env.targets["Marc"])
        .unwrap();
    assert_eq!(
        marc.series_classification_id.as_deref(),
        Some(env.series.as_str())
    );
    // Mostly directly in the series, yet grouped by its team-folder image.
    assert!(groups
        .values()
        .any(|(members, _)| members.contains("Direct")));

    // Every lifted image is classified in the series only; the kept folder is untouched.
    for id in [
        "a-1", "a-6", "as-1", "as-2", "m-1", "m-3", "p-1", "p-9", "s-4",
    ] {
        assert_eq!(env.homes(id), ["Series"], "{id}");
    }
    assert_eq!(env.homes("k-1"), ["Keep"]);
    assert_eq!(env.homes("d-1"), ["Series"]);
    assert!(env.exists("Keep") && env.exists("Series"));
    for gone in ["Alpha", "Alpha Sub", "Mark", "Plain", "Solo", "Empty"] {
        assert!(!env.exists(gone), "{gone}");
    }
    // The classification authority saw one assignment per lifted image and every delete.
    assert_eq!(env.outbox(ASSIGNMENT) - assignments_before, 25);
    assert_eq!(env.outbox(DELETE), 6);
    let wrong_target: i64 = env.count(&format!(
        "SELECT COUNT(*) FROM classification_authority_outbox
         WHERE command_type='{ASSIGNMENT}'
           AND json_extract(payload,'$.classificationId') IS NOT '{}'",
        env.series
    ));
    assert_eq!(wrong_target, 0);
    // Recognition owes the lifted images a fresh look.
    assert!(env.count("SELECT COUNT(*) FROM character_autotag_jobs") > 0);
    // Characters keep their images; files and their identity never change.
    assert_eq!(env.members(&env.targets["Ann"]), ann_before);
    assert_eq!(
        env.count("SELECT COUNT(DISTINCT content_hash) FROM assets"),
        hashes_before
    );
    let paths_after = env
        .library
        .connection()
        .unwrap()
        .prepare("SELECT id,relative_path,content_hash FROM assets ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(paths_after, paths_before);
    for (id, path, _) in &paths_after {
        assert_eq!(fs::read(env.temp.path().join(path)).unwrap(), id.as_bytes());
    }
    // Images in a 기타 were not given a character by this.
    assert_eq!(
        env.count("SELECT COUNT(*) FROM character_decisions WHERE decision='rejected'"),
        0
    );

    // Running the same request again changes nothing (the folders are gone).
    let snapshot = env.snapshot();
    let again = env
        .library
        .apply_character_subfolder_cleanup(request)
        .unwrap();
    assert!(again.already_applied && !again.changed);
    assert_eq!(env.snapshot(), snapshot);

    // A fresh plan lists only what is left; keeping it is a no-op as well.
    let fresh = env
        .library
        .character_subfolder_cleanup_plan(&env.series)
        .unwrap();
    assert_eq!(
        fresh
            .folders
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>(),
        ["Keep"]
    );
    assert!(fresh.series_to_unregister.is_empty());
    let noop = env
        .library
        .apply_character_subfolder_cleanup(CleanupRequest {
            series_id: env.series.clone(),
            expected_plan_fingerprint: fresh.fingerprint,
            folders: vec![env.choice("Keep", CleanupAction::Keep)],
            character_groups: vec![],
        })
        .unwrap();
    assert!(!noop.changed);
    assert_eq!(env.snapshot(), snapshot);
}

#[test]
fn a_changed_plan_or_an_unresolved_tie_or_a_name_collision_is_refused_without_writing() {
    let env = build();
    let plan = env
        .library
        .character_subfolder_cleanup_plan(&env.series)
        .unwrap();
    let before = env.snapshot();

    // A tie without a choice.
    let mut request = env.request(&plan);
    request.character_groups.clear();
    let error = env
        .library
        .apply_character_subfolder_cleanup(request)
        .unwrap_err()
        .to_string();
    assert!(error.contains("Tie"), "{error}");
    assert_eq!(env.snapshot(), before);
    assert!(env.registered("Alpha"));

    // A group name that exists already (the old group), whatever the case.
    let mut request = env.request(&plan);
    request.folders[4].group_name = Some("old".into());
    let error = env
        .library
        .apply_character_subfolder_cleanup(request)
        .unwrap_err()
        .to_string();
    assert!(error.contains("Old"), "{error}");
    assert_eq!(env.snapshot(), before);

    // A character sent to a folder that is not a group.
    let mut request = env.request(&plan);
    request.character_groups[0].group_folder_id = Some(env.folders["Keep"].clone());
    assert!(env
        .library
        .apply_character_subfolder_cleanup(request)
        .is_err());
    assert_eq!(env.snapshot(), before);

    // A folder the series does not directly contain.
    let mut request = env.request(&plan);
    request.folders[0].folder_id = env.folders["Alpha Sub"].clone();
    assert!(env
        .library
        .apply_character_subfolder_cleanup(request)
        .is_err());
    assert_eq!(env.snapshot(), before);

    // The plan changed after it was read (an image arrived in a team folder).
    let request = env.request(&plan);
    env.asset("late-1", "Plain");
    let error = env
        .library
        .apply_character_subfolder_cleanup(request)
        .unwrap_err()
        .to_string();
    assert!(error.contains("미리보기"), "{error}");
    assert_eq!(env.homes("p-1"), ["Plain"]);
    assert!(env.registered("Alpha") && env.exists("Plain"));
    assert_eq!(env.count("SELECT COUNT(*) FROM character_groups"), 1);
}

#[test]
fn a_failure_midway_rolls_everything_back_and_a_retry_completes() {
    let env = build();
    let plan = env
        .library
        .character_subfolder_cleanup_plan(&env.series)
        .unwrap();
    let before = env.snapshot();
    // The last step (removing the emptied folders) fails once.
    env.library
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER cleanup_test_fail BEFORE DELETE ON classification_entries
             WHEN OLD.name='Solo' BEGIN SELECT RAISE(ABORT,'boom'); END;",
        )
        .unwrap();
    let request = env.request(&plan);
    assert!(env
        .library
        .apply_character_subfolder_cleanup(request.clone())
        .is_err());
    assert_eq!(env.snapshot(), before);
    assert!(env.registered("Alpha") && env.registered("Mark"));
    assert_eq!(env.homes("p-1"), ["Plain"]);
    assert_eq!(env.groups().keys().cloned().collect::<Vec<_>>(), ["Old"]);

    env.library
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER cleanup_test_fail;")
        .unwrap();
    let result = env
        .library
        .apply_character_subfolder_cleanup(request)
        .unwrap();
    assert!(result.changed);
    assert_eq!(result.images_lifted, 25);
    assert_eq!(env.groups().len(), 4);
}

#[test]
fn excluded_folders_are_proposed_as_keep_and_cannot_be_grouped() {
    let env = build();
    env.library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO character_folder_exclusions(classification_id) VALUES(?1)",
            [&env.folders["Solo"]],
        )
        .unwrap();
    let plan = env
        .library
        .character_subfolder_cleanup_plan(&env.series)
        .unwrap();
    let solo = plan.folders.iter().find(|f| f.name == "Solo").unwrap();
    assert_eq!(solo.proposed_action, CleanupAction::Keep);
    assert!(solo.keep_reason.is_some());
    let error = env
        .library
        .apply_character_subfolder_cleanup(env.request(&plan))
        .unwrap_err()
        .to_string();
    assert!(error.contains("Solo"), "{error}");
}

#[test]
fn a_folder_a_character_is_linked_to_stays_and_is_reported() {
    let mut env = build();
    let plain = env.folders["Plain"].clone();
    let linked = env.folder("Linked", &plain);
    env.asset("l-1", "Linked");
    let series = env.series.clone();
    let linky = env
        .library
        .save_character_target(TargetDraft {
            id: None,
            expected_revision: None,
            series_classification_id: Some(series),
            linked_classification_id: Some(linked),
            display_name: "Linky".into(),
            description: String::new(),
            thumbnail_asset_id: None,
            enabled: true,
        })
        .unwrap();
    let plan = env
        .library
        .character_subfolder_cleanup_plan(&env.series)
        .unwrap();
    let mut request = env.request(&plan);
    request.character_groups.push(CleanupCharacterChoice {
        target_id: linky.id,
        group_folder_id: None,
    });
    let result = env
        .library
        .apply_character_subfolder_cleanup(request)
        .unwrap();
    assert!(result.changed);
    // The linked folder and its parent stay; their image was lifted anyway.
    assert!(env.exists("Linked") && env.exists("Plain"));
    assert_eq!(env.homes("l-1"), ["Series"]);
    assert_eq!(
        result
            .folders_kept
            .iter()
            .map(|f| f.name.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["Linked", "Plain"])
    );
}

/// Read-only plan dump of a COPY of a library, for the person to read before running the
/// cleanup. Nothing is written: the file is opened read-only with `query_only`, and no
/// migration runs.
///
/// ```text
/// LAKOMICS_CLEANUP_PLAN_DB=<copy of library.sqlite> LAKOMICS_CLEANUP_PLAN_SERIES=<series name> \
///   bash scripts/cargo-test.sh -- -- library::character_subfolder_cleanup::tests::cleanup_plan_dump --ignored --nocapture
/// ```
fn plan_dump_json(path: &str, name: &str) -> String {
    let connection = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .unwrap();
    connection.execute_batch("PRAGMA query_only=ON;").unwrap();
    let series = connection
        .prepare(
            "SELECT e.id FROM character_series s JOIN classification_entries e ON e.id=s.classification_id
             WHERE e.name=?1 COLLATE NOCASE ORDER BY e.id",
        )
        .unwrap()
        .query_map([name], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(series.len(), 1, "series named {name:?}: {series:?}");
    let analysis = analyze(&connection, &series[0]).unwrap();
    let plan = build_plan(&analysis);
    serde_json::to_string_pretty(&serde_json::json!({
        "plan": plan,
        "folderNames": analysis.folder_names,
    }))
    .unwrap()
}

#[test]
#[ignore = "read-only plan dump of a library copy; set LAKOMICS_CLEANUP_PLAN_DB and LAKOMICS_CLEANUP_PLAN_SERIES"]
fn cleanup_plan_dump_for_a_library_copy() {
    let path = std::env::var("LAKOMICS_CLEANUP_PLAN_DB").expect("LAKOMICS_CLEANUP_PLAN_DB");
    let name = std::env::var("LAKOMICS_CLEANUP_PLAN_SERIES").expect("LAKOMICS_CLEANUP_PLAN_SERIES");
    println!("{}", plan_dump_json(&path, &name));
}

#[test]
fn the_plan_dump_reads_a_copy_and_writes_nothing() {
    let env = build();
    let copy = env.temp.path().join("copy.sqlite");
    env.library
        .connection()
        .unwrap()
        .execute("VACUUM INTO ?1", [copy.to_str().unwrap()])
        .unwrap();
    let before = fs::read(&copy).unwrap();
    let json: serde_json::Value =
        serde_json::from_str(&plan_dump_json(copy.to_str().unwrap(), "series")).unwrap();
    assert_eq!(fs::read(&copy).unwrap(), before);
    assert_eq!(json["plan"]["folders"].as_array().unwrap().len(), 6);
    assert_eq!(json["plan"]["characters"].as_array().unwrap().len(), 8);
    assert_eq!(json["folderNames"][&env.folders["Plain"]], "Plain");
}
