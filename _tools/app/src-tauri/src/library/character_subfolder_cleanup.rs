//! "하위 폴더를 그룹으로 정리": the direct sub-folders of a registered series become groups.
//!
//! A series whose recognition scope was narrowed by registering team folders as nested
//! series (or that keeps one plain folder per team) is tidied in one run: the nested series
//! are unregistered into the series, each chosen folder becomes a group of the series, each
//! character joins the group whose folder holds most of its images, the images are lifted
//! into the series folder itself and the emptied folders are removed. Images without a
//! character go to the 기타 of the group named after their folder. Files on disk never
//! move; only the classification changes.
//!
//! [`Library::character_subfolder_cleanup_plan`] is read-only. [`Library::apply_character_subfolder_cleanup`]
//! runs everything in ONE immediate transaction: either the whole cleanup is committed or
//! nothing is, so an interrupted run leaves the library exactly as it was and "resuming" is
//! running the (fresh) plan again. Every classification change goes through the same
//! helpers the folder screens use ([`Library::change_asset_classifications_in`],
//! [`Library::delete_classification_in`]), so the classification authority outbox, the
//! recognition queue and the character publication see them as ordinary edits.
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    character_extras::ensure_extras_in,
    character_groups::{save_character_group_in, GroupDraft},
    characters::{has_real_character, DecisionKind, DecisionRequest, Error, Result},
    Library,
};

/// Images per decision batch (the decision writer accepts 1~200).
const DECISION_CHUNK: usize = 200;
const STALE_PLAN: &str =
    "정리 미리보기를 만든 뒤 폴더나 캐릭터가 바뀌었습니다. 미리보기를 다시 열어 확인해 주세요.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CleanupAction {
    /// The folder becomes a group of the series; its images are lifted into the series.
    Group,
    /// The folder is a one-character nested series (or similar): the series is unregistered
    /// and the images are lifted, but no group is made. Images without a character go to the
    /// series' own 기타.
    Lift,
    /// The folder stays exactly as it is, images included.
    Keep,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupNestedSeries {
    pub series_id: String,
    pub name: String,
    /// 1 for a series that is a direct sub-folder, deeper for series inside a folder.
    pub depth: usize,
    pub characters: Vec<CleanupCharacterRef>,
    pub group_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCharacterRef {
    pub target_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFolder {
    pub folder_id: String,
    pub name: String,
    /// Normal images in the folder and everything below it.
    pub image_count: usize,
    /// Of those, images no character of the series (or of a nested series that moves in) holds.
    pub images_without_character: usize,
    /// Folders that disappear with it: itself and every folder below it.
    pub folder_count: usize,
    /// The folder itself is a registered series.
    pub is_series: bool,
    /// Registered series at or below the folder (they are unregistered unless the folder is kept).
    pub nested_series: Vec<CleanupNestedSeries>,
    /// `group` (default), `lift` (a one-character nested series: no group) or `keep`.
    pub proposed_action: CleanupAction,
    /// Why `keep` is proposed, in Korean (an excluded or protected folder).
    pub keep_reason: Option<String>,
    /// The group's name unless the person gives another.
    pub default_group_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFolderCount {
    pub folder_id: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCharacter {
    pub target_id: String,
    pub name: String,
    /// The series the character lives in now (a nested series moves into the series).
    pub series_id: String,
    /// The direct sub-folder whose nested series holds the character, if any.
    pub from_folder_id: Option<String>,
    pub current_group_id: Option<String>,
    pub current_group_name: Option<String>,
    /// Images of the character inside the series tree (counted per folder, so an image linked to two folders counts twice).
    pub image_count: usize,
    /// Images per direct sub-folder (folders with none are left out).
    pub folder_counts: Vec<CleanupFolderCount>,
    /// Images directly in the series folder.
    pub direct_count: usize,
    /// The folder whose group the character joins by the rule; null = no group. A character
    /// already in a group keeps it unless a choice says otherwise.
    pub proposed_group_folder_id: Option<String>,
    /// Folders with the same top count: no default, a choice is required (null is a valid choice).
    pub tie: Option<Vec<String>>,
    /// The proposal rests on a single image.
    pub weak: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupSeriesRef {
    pub series_id: String,
    pub name: String,
    pub folder_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFolderRef {
    pub folder_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPlan {
    pub series_id: String,
    pub series_name: String,
    /// Opaque; apply refuses a plan whose folders, images, characters or groups changed.
    pub fingerprint: String,
    pub folders: Vec<CleanupFolder>,
    /// Characters of the series and of the nested series that move in, with their proposals.
    pub characters: Vec<CleanupCharacter>,
    /// Nested series that will be unregistered (with the proposed actions), deepest first.
    pub series_to_unregister: Vec<CleanupSeriesRef>,
    /// Characters that change series (they move into the series).
    pub moving_characters: Vec<CleanupCharacterRef>,
    /// Folders that will be removed once their images are lifted.
    pub folders_to_remove: Vec<CleanupFolderRef>,
    /// Normal images that move into the series folder.
    pub images_to_lift: usize,
    /// Images directly in the series folder now; they stay where they are.
    pub direct_image_count: usize,
    /// Names that already exist (Korean, ready to show). Apply refuses while any is left;
    /// a different `groupName` resolves a group-name collision.
    pub collisions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFolderChoice {
    pub folder_id: String,
    pub action: CleanupAction,
    /// The group's name; defaults to the folder's name.
    #[serde(default)]
    pub group_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCharacterChoice {
    pub target_id: String,
    /// The folder whose group the character joins; null = in no group.
    pub group_folder_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRequest {
    pub series_id: String,
    pub expected_plan_fingerprint: String,
    /// A sub-folder that is not listed is kept as it is.
    #[serde(default)]
    pub folders: Vec<CleanupFolderChoice>,
    /// A character without an entry takes the plan's proposal (a tie must have an entry).
    #[serde(default)]
    pub character_groups: Vec<CleanupCharacterChoice>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupGroupResult {
    pub folder_id: String,
    pub group_id: String,
    pub name: String,
    pub member_count: usize,
    /// Images put into the group's 기타.
    pub extras_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupKeptFolder {
    pub folder_id: String,
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub series_id: String,
    /// False when the choices left nothing to do (nothing was written).
    pub changed: bool,
    /// True when the folders to clean were already gone (the same run was committed before);
    /// nothing was written now.
    pub already_applied: bool,
    pub groups_created: Vec<CleanupGroupResult>,
    /// Folders that were chosen as groups but had neither a member nor a 기타 image.
    pub groups_skipped: Vec<CleanupFolderRef>,
    pub characters_grouped: usize,
    pub series_unregistered: Vec<CleanupFolderRef>,
    pub characters_moved: usize,
    pub images_lifted: usize,
    pub folders_removed: Vec<CleanupFolderRef>,
    /// Folders that could not be removed because something still sits in them.
    pub folders_kept: Vec<CleanupKeptFolder>,
    /// Images put into the series' own 기타 (from `lift` folders).
    pub series_extras_count: usize,
}

// ---------------------------------------------------------------------------------------
// Analysis: everything the plan and the apply step need, read once.
// ---------------------------------------------------------------------------------------

struct Top {
    id: String,
    name: String,
    /// The folder and everything below it, parents before children.
    folders: Vec<String>,
    /// Every asset linked in the tree (any status): these are lifted.
    assets: BTreeSet<String>,
    /// The normal ones.
    normal: BTreeSet<String>,
    excluded: bool,
    protected: bool,
}

struct Nested {
    id: String,
    name: String,
    top: usize,
    depth: usize,
}

struct Char {
    id: String,
    name: String,
    series_id: String,
    /// Index into `Analysis::nested` for a nested series' character.
    nested: Option<usize>,
    group: Option<(String, String)>,
    /// Accepted images plus reference images (what "has a character" means).
    relation: BTreeSet<String>,
}

struct Analysis {
    series_id: String,
    series_name: String,
    tops: Vec<Top>,
    nested: Vec<Nested>,
    chars: Vec<Char>,
    /// Groups of the series and of the nested series: id, series, name, revision.
    groups: Vec<(String, String, String, i64)>,
    /// Normal images linked to the series folder itself.
    direct: BTreeSet<String>,
    /// Name of every folder of the tree.
    folder_names: BTreeMap<String, String>,
    /// Folders a character is linked to (they are never removed).
    linked_folders: BTreeSet<String>,
}

fn sorted_key(name: &str) -> (String, String) {
    (name.to_lowercase(), name.to_owned())
}

fn analyze(connection: &Connection, series_id: &str) -> Result<Analysis> {
    let series_name: String = connection
        .query_row(
            "SELECT e.name FROM classification_entries e
             JOIN character_series s ON s.classification_id=e.id WHERE e.id=?1",
            [series_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(Error::Invalid("등록된 시리즈를 선택해 주세요."))?;
    if super::classification::classification_in_role_scope(connection, series_id, "originals")? {
        return Err(Error::Invalid(
            "오리지널 보관 영역은 하위 폴더를 정리할 수 없습니다.",
        ));
    }
    const SUBTREE: &str = "WITH RECURSIVE sub(id) AS (
        SELECT id FROM classification_entries WHERE id=?1
        UNION ALL SELECT c.id FROM classification_entries c JOIN sub ON c.parent_id=sub.id)";
    let entries = connection
        .prepare(&format!(
            "{SUBTREE} SELECT e.id,e.name,e.parent_id FROM classification_entries e JOIN sub ON sub.id=e.id"
        ))?
        .query_map([series_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let name_of = entries
        .iter()
        .map(|e| (e.0.clone(), e.1.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut children = BTreeMap::<String, Vec<String>>::new();
    let mut parent_of = BTreeMap::<String, String>::new();
    for (id, _, parent) in &entries {
        if let Some(parent) = parent {
            children.entry(parent.clone()).or_default().push(id.clone());
            parent_of.insert(id.clone(), parent.clone());
        }
    }
    let mut top_ids = children.get(series_id).cloned().unwrap_or_default();
    top_ids.sort_by_key(|id| sorted_key(&name_of[id]));
    let mut top_of = BTreeMap::<String, usize>::new();
    let mut tops = Vec::new();
    for (index, id) in top_ids.iter().enumerate() {
        let mut folders = vec![id.clone()];
        let mut cursor = 0;
        while cursor < folders.len() {
            let mut below = children.get(&folders[cursor]).cloned().unwrap_or_default();
            below.sort_by_key(|id| sorted_key(&name_of[id]));
            folders.extend(below);
            cursor += 1;
        }
        for folder in &folders {
            top_of.insert(folder.clone(), index);
        }
        tops.push(Top {
            id: id.clone(),
            name: name_of[id].clone(),
            folders,
            assets: BTreeSet::new(),
            normal: BTreeSet::new(),
            excluded: false,
            protected: false,
        });
    }

    // Links of the whole tree.
    let mut direct = BTreeSet::new();
    for row in connection
        .prepare(&format!(
            "{SUBTREE} SELECT ac.asset_id,ac.classification_id,a.status
             FROM asset_classifications ac JOIN sub ON sub.id=ac.classification_id
             JOIN assets a ON a.id=ac.asset_id"
        ))?
        .query_map([series_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
    {
        let (asset, folder, status) = row?;
        if folder == series_id {
            if status == "normal" {
                direct.insert(asset);
            }
        } else if let Some(&top) = top_of.get(&folder) {
            tops[top].assets.insert(asset.clone());
            if status == "normal" {
                tops[top].normal.insert(asset);
            }
        }
    }

    // Excluded and protected folders.
    for id in connection
        .prepare(&format!(
            "{SUBTREE} SELECT x.id FROM character_excluded_folders x JOIN sub ON sub.id=x.id"
        ))?
        .query_map([series_id], |row| row.get::<_, String>(0))?
    {
        if let Some(&top) = top_of.get(&id?) {
            tops[top].excluded = true;
        }
    }
    for id in connection
        .prepare(&format!(
            "{SUBTREE} SELECT r.classification_id FROM classification_roles r JOIN sub ON sub.id=r.classification_id"
        ))?
        .query_map([series_id], |row| row.get::<_, String>(0))?
    {
        if let Some(&top) = top_of.get(&id?) {
            tops[top].protected = true;
        }
    }
    let linked_folders = connection
        .prepare(&format!(
            "{SUBTREE} SELECT t.linked_classification_id FROM character_targets t
             JOIN sub ON sub.id=t.linked_classification_id"
        ))?
        .query_map([series_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;

    // Nested registered series.
    let mut nested = Vec::new();
    for id in connection
        .prepare(&format!(
            "{SUBTREE} SELECT s.classification_id FROM character_series s JOIN sub ON sub.id=s.classification_id
             WHERE s.classification_id<>?1"
        ))?
        .query_map([series_id], |row| row.get::<_, String>(0))?
    {
        let id = id?;
        let Some(&top) = top_of.get(&id) else {
            continue;
        };
        let mut depth = 0;
        let mut cursor = id.clone();
        while cursor != series_id {
            depth += 1;
            cursor = parent_of
                .get(&cursor)
                .cloned()
                .unwrap_or_else(|| series_id.to_owned());
        }
        nested.push(Nested {
            name: name_of[&id].clone(),
            id,
            top,
            depth,
        });
    }
    nested.sort_by_key(|n| (n.top, n.depth, sorted_key(&n.name)));

    // Characters of the series and of the nested series, their groups and images.
    let mut series_ids = vec![series_id.to_owned()];
    series_ids.extend(nested.iter().map(|n| n.id.clone()));
    let series_json = serde_json::to_string(&series_ids)?;
    let mut chars = connection
        .prepare(
            "SELECT t.id,t.display_name,t.series_classification_id FROM character_targets t
             WHERE t.role='character'
               AND t.series_classification_id IN (SELECT value FROM json_each(?1))
             ORDER BY t.id",
        )?
        .query_map([&series_json], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(id, name, series)| Char {
            nested: nested.iter().position(|n| n.id == series),
            id,
            name,
            series_id: series,
            group: None,
            relation: BTreeSet::new(),
        })
        .collect::<Vec<_>>();
    let index_of = chars
        .iter()
        .enumerate()
        .map(|(index, c)| (c.id.clone(), index))
        .collect::<BTreeMap<_, _>>();
    let groups = connection
        .prepare(
            "SELECT id,series_id,name,revision FROM character_groups
             WHERE series_id IN (SELECT value FROM json_each(?1)) ORDER BY id",
        )?
        .query_map([&series_json], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for row in connection
        .prepare(
            "SELECT m.target_id,g.id,g.name FROM character_group_members m
             JOIN character_groups g ON g.id=m.group_id
             WHERE g.series_id IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([&series_json], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
    {
        let (target, group, name) = row?;
        if let Some(&index) = index_of.get(&target) {
            chars[index].group = Some((group, name));
        }
    }
    let target_json = serde_json::to_string(&index_of.keys().collect::<Vec<_>>())?;
    for sql in [
        "SELECT target_id,asset_id FROM character_relations
         WHERE target_id IN (SELECT value FROM json_each(?1))",
        "SELECT target_id,asset_id FROM character_references
         WHERE asset_id IS NOT NULL AND target_id IN (SELECT value FROM json_each(?1))",
        "SELECT target_id,asset_id FROM character_learned_references
         WHERE asset_id IS NOT NULL AND target_id IN (SELECT value FROM json_each(?1))",
    ] {
        for row in connection.prepare(sql)?.query_map([&target_json], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (target, asset) = row?;
            if let Some(&index) = index_of.get(&target) {
                chars[index].relation.insert(asset);
            }
        }
    }
    Ok(Analysis {
        series_id: series_id.to_owned(),
        series_name,
        tops,
        nested,
        chars,
        groups,
        direct,
        folder_names: name_of,
        linked_folders,
    })
}

// ---------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------

/// What the folder is proposed to become.
fn default_action(a: &Analysis, top: usize) -> (CleanupAction, Option<String>) {
    let t = &a.tops[top];
    if t.excluded {
        return (
            CleanupAction::Keep,
            Some("캐릭터 분류에서 제외된 폴더라 그대로 둡니다.".into()),
        );
    }
    if t.protected {
        return (
            CleanupAction::Keep,
            Some("보호된 폴더라 그대로 둡니다.".into()),
        );
    }
    if let Some(root) = a
        .nested
        .iter()
        .find(|n| n.top == top && n.id == a.tops[top].id)
    {
        let characters = a.chars.iter().filter(|c| c.series_id == root.id).count();
        let groups = a.groups.iter().filter(|g| g.1 == root.id).count();
        let deeper = a.nested.iter().any(|n| n.top == top && n.id != root.id);
        if characters == 1 && groups == 0 && !deeper {
            return (CleanupAction::Lift, None);
        }
    }
    (CleanupAction::Group, None)
}

fn default_actions(a: &Analysis) -> Vec<CleanupAction> {
    (0..a.tops.len())
        .map(|top| default_action(a, top).0)
        .collect()
}

/// Whether the character takes part (it lives in the series or in a nested series that moves in).
fn considered(a: &Analysis, actions: &[CleanupAction], c: &Char) -> bool {
    match c.nested {
        None => true,
        Some(nested) => actions[a.nested[nested].top] != CleanupAction::Keep,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Choice {
    NoGroup,
    Folder { top: usize, weak: bool },
    Tie(Vec<usize>),
}

/// Per-folder image counts of one character (every direct sub-folder) and the direct count.
fn counts_for(a: &Analysis, c: &Char) -> (Vec<(usize, usize)>, usize) {
    let counts = (0..a.tops.len())
        .map(|top| (top, a.tops[top].normal.intersection(&c.relation).count()))
        .filter(|(_, count)| *count > 0)
        .collect::<Vec<_>>();
    let direct = a.direct.intersection(&c.relation).count();
    (counts, direct)
}

fn choose(counts: &[(usize, usize)], actions: &[CleanupAction], direct: usize) -> Choice {
    let candidates = counts
        .iter()
        .filter(|(top, _)| actions[*top] == CleanupAction::Group)
        .collect::<Vec<_>>();
    let best = candidates
        .iter()
        .map(|(_, count)| *count)
        .max()
        .unwrap_or(0);
    if best == 0 || direct > best {
        return Choice::NoGroup;
    }
    let top = candidates
        .iter()
        .filter(|(_, count)| *count == best)
        .map(|(top, _)| *top)
        .collect::<Vec<_>>();
    if top.len() > 1 || direct == best {
        return Choice::Tie(top);
    }
    Choice::Folder {
        top: top[0],
        weak: best == 1,
    }
}

fn fingerprint(a: &Analysis) -> String {
    let mut hash = Sha256::new();
    let mut line = |text: String| {
        hash.update(text.as_bytes());
        hash.update(b"\n");
    };
    line(format!("cleanup-v1 {} {}", a.series_id, a.series_name));
    for top in &a.tops {
        line(format!(
            "top {} {} excluded={} protected={}",
            top.id, top.name, top.excluded, top.protected
        ));
        line(format!("folders {}", top.folders.join(",")));
        line(format!(
            "assets {}",
            top.assets.iter().cloned().collect::<Vec<_>>().join(",")
        ));
    }
    line(format!(
        "direct {}",
        a.direct.iter().cloned().collect::<Vec<_>>().join(",")
    ));
    for n in &a.nested {
        line(format!("nested {} {} {} {}", n.id, n.name, n.top, n.depth));
    }
    for c in &a.chars {
        line(format!(
            "char {} {} {} {:?}",
            c.id,
            c.name,
            c.series_id,
            c.group.as_ref().map(|g| g.0.clone())
        ));
    }
    for g in &a.groups {
        line(format!("group {} {} {} {}", g.0, g.1, g.2, g.3));
    }
    line(format!(
        "linked {}",
        a.linked_folders
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join(",")
    ));
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The group each character joins, from explicit choices first and the rule otherwise.
/// `Err` lists the characters whose tie still needs a choice.
struct Assignments {
    /// Character index -> top index (None = leave without a group / remove from its group).
    assigned: BTreeMap<usize, Option<usize>>,
    unresolved: Vec<usize>,
}

fn assignments(
    a: &Analysis,
    actions: &[CleanupAction],
    explicit: &BTreeMap<String, Option<usize>>,
) -> Assignments {
    let mut assigned = BTreeMap::new();
    let mut unresolved = Vec::new();
    for (index, c) in a.chars.iter().enumerate() {
        if !considered(a, actions, c) {
            continue;
        }
        if let Some(choice) = explicit.get(&c.id) {
            assigned.insert(index, *choice);
            continue;
        }
        if c.group.is_some() {
            // A character already in a group keeps it unless a choice says otherwise.
            continue;
        }
        let (counts, direct) = counts_for(a, c);
        match choose(&counts, actions, direct) {
            Choice::NoGroup => {}
            Choice::Folder { top, .. } => {
                assigned.insert(index, Some(top));
            }
            Choice::Tie(_) => unresolved.push(index),
        }
    }
    Assignments {
        assigned,
        unresolved,
    }
}

/// Nested series that are unregistered for these actions, deepest first (so every step moves
/// into the series itself in the end).
fn series_to_unregister<'a>(a: &'a Analysis, actions: &[CleanupAction]) -> Vec<&'a Nested> {
    let mut list = a
        .nested
        .iter()
        .filter(|n| actions[n.top] != CleanupAction::Keep)
        .collect::<Vec<_>>();
    list.sort_by(|x, y| {
        y.depth
            .cmp(&x.depth)
            .then_with(|| x.top.cmp(&y.top))
            .then_with(|| sorted_key(&x.name).cmp(&sorted_key(&y.name)))
    });
    list
}

fn group_name_of(a: &Analysis, top: usize, names: &BTreeMap<usize, String>) -> String {
    names
        .get(&top)
        .cloned()
        .unwrap_or_else(|| a.tops[top].name.trim().to_owned())
}

/// Names that would clash after the cleanup (case-insensitive, like the unregister rule).
fn collisions(
    a: &Analysis,
    actions: &[CleanupAction],
    names: &BTreeMap<usize, String>,
    new_groups: &BTreeSet<usize>,
) -> Vec<String> {
    let mut found = BTreeSet::new();
    let mut seen = BTreeMap::<String, usize>::new();
    for c in a.chars.iter().filter(|c| considered(a, actions, c)) {
        *seen.entry(c.name.trim().to_lowercase()).or_default() += 1;
    }
    for c in a.chars.iter().filter(|c| considered(a, actions, c)) {
        if seen[&c.name.trim().to_lowercase()] > 1 {
            found.insert(format!("캐릭터 {}", c.name));
        }
    }
    let moving = series_to_unregister(a, actions)
        .into_iter()
        .map(|n| n.id.clone())
        .collect::<BTreeSet<_>>();
    let mut group_names = BTreeMap::<String, usize>::new();
    let mut shown = BTreeMap::<String, String>::new();
    for g in &a.groups {
        if g.1 == a.series_id || moving.contains(&g.1) {
            *group_names.entry(g.2.trim().to_lowercase()).or_default() += 1;
            shown
                .entry(g.2.trim().to_lowercase())
                .or_insert_with(|| g.2.clone());
        }
    }
    for top in new_groups {
        let name = group_name_of(a, *top, names);
        *group_names.entry(name.to_lowercase()).or_default() += 1;
        shown.entry(name.to_lowercase()).or_insert(name);
    }
    for (key, count) in group_names {
        if count > 1 {
            found.insert(format!("그룹 {}", shown[&key]));
        }
    }
    found.into_iter().collect()
}

/// Folders that would get a group: a member or an image without a character.
fn planned_groups(
    actions: &[CleanupAction],
    assigned: &Assignments,
    characterless: &BTreeMap<usize, usize>,
) -> BTreeSet<usize> {
    let mut set = BTreeSet::new();
    for top in assigned.assigned.values().flatten() {
        set.insert(*top);
    }
    for (top, count) in characterless {
        if actions[*top] == CleanupAction::Group && *count > 0 {
            set.insert(*top);
        }
    }
    set
}

/// Normal images of each folder tree that no considered character holds.
fn characterless_counts(a: &Analysis, actions: &[CleanupAction]) -> BTreeMap<usize, usize> {
    let held = a
        .chars
        .iter()
        .filter(|c| considered(a, actions, c))
        .flat_map(|c| c.relation.iter())
        .collect::<BTreeSet<_>>();
    (0..a.tops.len())
        .map(|top| {
            (
                top,
                a.tops[top]
                    .normal
                    .iter()
                    .filter(|asset| !held.contains(asset))
                    .count(),
            )
        })
        .collect()
}

fn build_plan(a: &Analysis) -> CleanupPlan {
    let actions = default_actions(a);
    let characterless = characterless_counts(a, &actions);
    let unregister = series_to_unregister(a, &actions);
    let folders = (0..a.tops.len())
        .map(|top| {
            let t = &a.tops[top];
            let (proposed, keep_reason) = default_action(a, top);
            CleanupFolder {
                folder_id: t.id.clone(),
                name: t.name.clone(),
                image_count: t.normal.len(),
                images_without_character: characterless[&top],
                folder_count: t.folders.len(),
                is_series: a.nested.iter().any(|n| n.id == t.id),
                nested_series: a
                    .nested
                    .iter()
                    .filter(|n| n.top == top)
                    .map(|n| CleanupNestedSeries {
                        series_id: n.id.clone(),
                        name: n.name.clone(),
                        depth: n.depth,
                        characters: a
                            .chars
                            .iter()
                            .filter(|c| c.series_id == n.id)
                            .map(|c| CleanupCharacterRef {
                                target_id: c.id.clone(),
                                name: c.name.clone(),
                            })
                            .collect(),
                        group_count: a.groups.iter().filter(|g| g.1 == n.id).count(),
                    })
                    .collect(),
                proposed_action: proposed,
                keep_reason,
                default_group_name: t.name.trim().to_owned(),
            }
        })
        .collect::<Vec<_>>();
    let characters = a
        .chars
        .iter()
        .filter(|c| considered(a, &actions, c))
        .map(|c| {
            let (counts, direct) = counts_for(a, c);
            let (proposed, tie, weak) = if c.group.is_some() {
                (None, None, false)
            } else {
                match choose(&counts, &actions, direct) {
                    Choice::NoGroup => (None, None, false),
                    Choice::Folder { top, weak } => (Some(a.tops[top].id.clone()), None, weak),
                    Choice::Tie(tops) => (
                        None,
                        Some(tops.into_iter().map(|t| a.tops[t].id.clone()).collect()),
                        false,
                    ),
                }
            };
            CleanupCharacter {
                target_id: c.id.clone(),
                name: c.name.clone(),
                series_id: c.series_id.clone(),
                from_folder_id: c.nested.map(|n| a.tops[a.nested[n].top].id.clone()),
                current_group_id: c.group.as_ref().map(|g| g.0.clone()),
                current_group_name: c.group.as_ref().map(|g| g.1.clone()),
                image_count: counts.iter().map(|(_, count)| count).sum::<usize>() + direct,
                folder_counts: counts
                    .iter()
                    .map(|(top, count)| CleanupFolderCount {
                        folder_id: a.tops[*top].id.clone(),
                        count: *count,
                    })
                    .collect(),
                direct_count: direct,
                proposed_group_folder_id: proposed,
                tie,
                weak,
            }
        })
        .collect::<Vec<_>>();
    let assigned = assignments(a, &actions, &BTreeMap::new());
    let new_groups = planned_groups(&actions, &assigned, &characterless)
        .into_iter()
        .filter(|top| actions[*top] == CleanupAction::Group)
        .collect::<BTreeSet<_>>();
    let acted = |top: usize| actions[top] != CleanupAction::Keep;
    CleanupPlan {
        series_id: a.series_id.clone(),
        series_name: a.series_name.clone(),
        fingerprint: fingerprint(a),
        collisions: collisions(a, &actions, &BTreeMap::new(), &new_groups),
        series_to_unregister: unregister
            .iter()
            .map(|n| CleanupSeriesRef {
                series_id: n.id.clone(),
                name: n.name.clone(),
                folder_id: a.tops[n.top].id.clone(),
            })
            .collect(),
        moving_characters: a
            .chars
            .iter()
            .filter(|c| c.nested.is_some() && considered(a, &actions, c))
            .map(|c| CleanupCharacterRef {
                target_id: c.id.clone(),
                name: c.name.clone(),
            })
            .collect(),
        folders_to_remove: (0..a.tops.len())
            .filter(|top| acted(*top))
            .flat_map(|top| a.tops[top].folders.iter().map(move |id| (top, id.clone())))
            .map(|(_, id)| CleanupFolderRef {
                name: a.folder_names[&id].clone(),
                folder_id: id,
            })
            .collect(),
        images_to_lift: (0..a.tops.len())
            .filter(|top| acted(*top))
            .flat_map(|top| a.tops[top].normal.iter())
            .collect::<BTreeSet<_>>()
            .len(),
        direct_image_count: a.direct.len(),
        folders,
        characters,
    }
}

// ---------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------

fn korean_list(names: &[String]) -> String {
    names.join(", ")
}

/// Put images into a 기타 as 맞음, in batches. The decision writer re-checks everything the
/// 기타 screens check (an image with a character is refused, so callers filter first).
impl Library {
    fn put_in_extras(
        &self,
        tx: &Connection,
        extras_id: &str,
        asset_ids: &[String],
        decision: DecisionKind,
    ) -> Result<()> {
        for chunk in asset_ids.chunks(DECISION_CHUNK) {
            let current = self.read_character_target(tx, extras_id)?;
            self.write_character_decisions(
                tx,
                DecisionRequest {
                    target_id: extras_id.to_owned(),
                    expected_fingerprint: current.fingerprint,
                    asset_ids: chunk.to_vec(),
                    decision,
                    baseline_fingerprint: None,
                    scan_id: None,
                },
            )?;
        }
        Ok(())
    }

    /// What "하위 폴더를 그룹으로 정리" would do for this series. Writes nothing.
    pub fn character_subfolder_cleanup_plan(&self, series_id: &str) -> Result<CleanupPlan> {
        let connection = self.connection()?;
        Ok(build_plan(&analyze(&connection, series_id)?))
    }

    /// Run the cleanup in one transaction. See the module documentation; any refusal or
    /// failure changes nothing.
    pub fn apply_character_subfolder_cleanup(
        &self,
        request: CleanupRequest,
    ) -> Result<CleanupResult> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (result, moved) = self.apply_cleanup_in(&tx, &request)?;
        if result.changed {
            tx.commit()?;
        } else {
            tx.rollback()?;
        }
        drop(connection);
        self.cancel_scans_of(&moved);
        Ok(result)
    }

    fn apply_cleanup_in(
        &self,
        tx: &Connection,
        request: &CleanupRequest,
    ) -> Result<(CleanupResult, Vec<String>)> {
        let a = analyze(tx, &request.series_id)?;
        // A lost answer after a committed run: every folder it was told to clean is gone.
        let wanted = request
            .folders
            .iter()
            .filter(|choice| choice.action != CleanupAction::Keep)
            .collect::<Vec<_>>();
        if !wanted.is_empty()
            && wanted
                .iter()
                .all(|choice| !a.folder_names.contains_key(&choice.folder_id))
        {
            return Ok((
                CleanupResult {
                    series_id: a.series_id,
                    already_applied: true,
                    ..CleanupResult::default()
                },
                Vec::new(),
            ));
        }
        if request.expected_plan_fingerprint != fingerprint(&a) {
            return Err(Error::Invalid(STALE_PLAN));
        }
        let series = a.series_id.clone();
        let top_index = a
            .tops
            .iter()
            .enumerate()
            .map(|(index, t)| (t.id.clone(), index))
            .collect::<BTreeMap<_, _>>();

        // The choices. A sub-folder that is not listed stays as it is.
        let mut actions = vec![CleanupAction::Keep; a.tops.len()];
        let mut names = BTreeMap::<usize, String>::new();
        let mut listed = BTreeSet::new();
        for choice in &request.folders {
            let Some(&top) = top_index.get(&choice.folder_id) else {
                return Err(Error::Invalid(
                    "선택한 폴더가 이 시리즈의 바로 아래 폴더가 아닙니다.",
                ));
            };
            if !listed.insert(top) {
                return Err(Error::Invalid("같은 폴더를 두 번 선택했습니다."));
            }
            if choice.action != CleanupAction::Keep
                && (a.tops[top].excluded || a.tops[top].protected)
            {
                return Err(Error::InvalidMessage(format!(
                    "「{}」은(는) 제외되었거나 보호된 폴더라 정리할 수 없습니다. 그대로 두기를 선택해 주세요.",
                    a.tops[top].name
                )));
            }
            actions[top] = choice.action;
            if choice.action == CleanupAction::Group {
                if let Some(name) = choice.group_name.as_deref() {
                    let name = name.trim();
                    if name.is_empty() || name.chars().count() > 100 {
                        return Err(Error::Invalid("그룹 이름을 확인해 주세요."));
                    }
                    names.insert(top, name.to_owned());
                }
            }
        }
        if actions.iter().all(|action| *action == CleanupAction::Keep) {
            return Ok((
                CleanupResult {
                    series_id: series,
                    changed: false,
                    ..CleanupResult::default()
                },
                Vec::new(),
            ));
        }

        let mut explicit = BTreeMap::<String, Option<usize>>::new();
        for choice in &request.character_groups {
            let Some(c) = a
                .chars
                .iter()
                .find(|c| c.id == choice.target_id && considered(&a, &actions, c))
            else {
                return Err(Error::Invalid("정리 대상이 아닌 캐릭터가 선택되었습니다."));
            };
            let top = match &choice.group_folder_id {
                None => None,
                Some(folder) => match top_index.get(folder) {
                    Some(&top) if actions[top] == CleanupAction::Group => Some(top),
                    _ => {
                        return Err(Error::InvalidMessage(format!(
                            "「{}」의 그룹은 정리 대상 폴더가 아니라 고를 수 없습니다.",
                            c.name
                        )))
                    }
                },
            };
            if explicit.insert(c.id.clone(), top).is_some() {
                return Err(Error::Invalid("같은 캐릭터를 두 번 선택했습니다."));
            }
        }
        let assigned = assignments(&a, &actions, &explicit);
        if !assigned.unresolved.is_empty() {
            let who = assigned
                .unresolved
                .iter()
                .map(|index| a.chars[*index].name.clone())
                .collect::<Vec<_>>();
            return Err(Error::InvalidMessage(format!(
                "그룹을 정하지 않은 캐릭터가 있습니다(폴더별 이미지 수가 같습니다): {}.",
                korean_list(&who)
            )));
        }
        let characterless = characterless_counts(&a, &actions);
        let planned = planned_groups(&actions, &assigned, &characterless)
            .into_iter()
            .filter(|top| actions[*top] == CleanupAction::Group)
            .collect::<BTreeSet<_>>();
        let clashes = collisions(&a, &actions, &names, &planned);
        if !clashes.is_empty() {
            return Err(Error::InvalidMessage(format!(
                "같은 이름이 이미 있어 정리할 수 없습니다: {}. 그룹 이름을 바꾸거나 이름을 구분한 뒤 다시 시도해 주세요.",
                korean_list(&clashes)
            )));
        }

        let mut result = CleanupResult {
            series_id: series.clone(),
            changed: true,
            ..CleanupResult::default()
        };

        // 1. Unregister the nested series (deepest first): characters, groups and 기타 move in.
        let mut moved_targets = Vec::new();
        for nested in series_to_unregister(&a, &actions) {
            let (done, moving) = Self::unregister_in(tx, &nested.id)?;
            result.characters_moved += done.moved_character_count;
            moved_targets.extend(moving);
            result.series_unregistered.push(CleanupFolderRef {
                folder_id: a.tops[nested.top].id.clone(),
                name: nested.name.clone(),
            });
        }

        // The images that will fill a 기타, decided now that every character is in the series:
        // normal pictures no character holds and no 기타 of the series has yet (an image in the
        // series' own 기타 moves on into the group's 기타).
        let eligible = |asset: &str| -> Result<bool> {
            Ok(tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM assets a WHERE a.id=?1 AND a.status='normal'
                   AND a.media_kind IN ('image','gif','video')
                   AND NOT EXISTS(SELECT 1 FROM character_series_asset_exclusions x
                                  WHERE x.series_id=?2 AND x.asset_id=a.id))",
                params![asset, series],
                |row| row.get(0),
            )?)
        };
        let in_group_extras = |asset: &str| -> Result<bool> {
            Ok(tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM character_targets t
                   JOIN character_relations r ON r.target_id=t.id
                   WHERE t.role='extras' AND t.series_classification_id=?1
                     AND t.extras_group_id IS NOT NULL AND r.asset_id=?2)",
                params![series, asset],
                |row| row.get(0),
            )?)
        };
        let mut extras_for = BTreeMap::<usize, Vec<String>>::new();
        let mut placed = BTreeSet::<String>::new();
        for top in 0..a.tops.len() {
            if actions[top] == CleanupAction::Keep {
                continue;
            }
            for asset in &a.tops[top].normal {
                if placed.contains(asset)
                    || !eligible(asset)?
                    || has_real_character(tx, &series, asset)?
                    || in_group_extras(asset)?
                {
                    continue;
                }
                placed.insert(asset.clone());
                extras_for.entry(top).or_default().push(asset.clone());
            }
        }

        // 2. Groups: one per chosen folder that has a member or an image for its 기타.
        let mut group_of = BTreeMap::<usize, String>::new();
        for top in 0..a.tops.len() {
            if actions[top] != CleanupAction::Group {
                continue;
            }
            let members = assigned
                .assigned
                .iter()
                .filter(|(_, target)| **target == Some(top))
                .map(|(index, _)| a.chars[*index].id.clone())
                .collect::<Vec<_>>();
            let extras = extras_for.get(&top).map_or(0, Vec::len);
            if members.is_empty() && extras == 0 {
                result.groups_skipped.push(CleanupFolderRef {
                    folder_id: a.tops[top].id.clone(),
                    name: a.tops[top].name.clone(),
                });
                continue;
            }
            for member in &members {
                let old: Option<String> = tx
                    .query_row(
                        "SELECT group_id FROM character_group_members WHERE target_id=?1",
                        [member],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(old) = old {
                    tx.execute(
                        "UPDATE character_groups SET revision=revision+1 WHERE id=?1",
                        [&old],
                    )?;
                    tx.execute(
                        "DELETE FROM character_group_members WHERE target_id=?1",
                        [member],
                    )?;
                }
            }
            let name = group_name_of(&a, top, &names);
            let group_id = if members.is_empty() {
                let id = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO character_groups(id,series_id,name) VALUES(?1,?2,?3)",
                    params![id, series, name],
                )?;
                id
            } else {
                save_character_group_in(
                    tx,
                    GroupDraft {
                        id: None,
                        series_id: series.clone(),
                        expected_revision: None,
                        name: name.clone(),
                        target_ids: members.clone(),
                        delete: false,
                    },
                )?
            };
            if extras > 0 {
                ensure_extras_in(tx, &series, Some(&group_id))?;
            }
            result.characters_grouped += members.len();
            result.groups_created.push(CleanupGroupResult {
                folder_id: a.tops[top].id.clone(),
                group_id: group_id.clone(),
                name,
                member_count: members.len(),
                extras_count: extras,
            });
            group_of.insert(top, group_id);
        }
        // A character an explicit choice takes out of its group (null) leaves it.
        for (index, target) in &assigned.assigned {
            if target.is_none() {
                let had: Option<String> = tx
                    .query_row(
                        "SELECT group_id FROM character_group_members WHERE target_id=?1",
                        [&a.chars[*index].id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(old) = had {
                    tx.execute(
                        "UPDATE character_groups SET revision=revision+1 WHERE id=?1",
                        [&old],
                    )?;
                    tx.execute(
                        "DELETE FROM character_group_members WHERE target_id=?1",
                        [&a.chars[*index].id],
                    )?;
                }
            }
        }

        // 3. Lift every image of the chosen folder trees into the series itself.
        let acted = (0..a.tops.len())
            .filter(|top| actions[*top] != CleanupAction::Keep)
            .collect::<Vec<_>>();
        let lifted = acted
            .iter()
            .flat_map(|top| a.tops[*top].assets.iter().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let leaving = acted
            .iter()
            .flat_map(|top| a.tops[*top].folders.iter().cloned())
            .collect::<Vec<_>>();
        if !lifted.is_empty() {
            result.images_lifted = Self::change_asset_classifications_in(
                tx,
                &lifted,
                std::slice::from_ref(&series),
                &leaving,
            )?;
        }

        // 4. 기타: the images without a character go to the 기타 of the group named after
        // their folder (or the series' own for a lifted folder).
        let series_extras: Option<String> = tx
            .query_row(
                "SELECT id FROM character_targets
                 WHERE role='extras' AND series_classification_id=?1 AND extras_group_id IS NULL",
                [&series],
                |row| row.get(0),
            )
            .optional()?;
        for (top, assets) in &extras_for {
            let (extras_id, group_level) = match actions[*top] {
                CleanupAction::Group => {
                    let Some(group) = group_of.get(top) else {
                        continue;
                    };
                    (ensure_extras_in(tx, &series, Some(group))?, true)
                }
                _ => (ensure_extras_in(tx, &series, None)?, false),
            };
            if group_level {
                if let Some(series_extras) = &series_extras {
                    let leaving_series = assets
                        .iter()
                        .filter(|asset| {
                            tx.query_row(
                                "SELECT EXISTS(SELECT 1 FROM character_relations WHERE target_id=?1 AND asset_id=?2)",
                                params![series_extras, asset],
                                |row| row.get::<_, bool>(0),
                            )
                            .unwrap_or(false)
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    if !leaving_series.is_empty() {
                        self.put_in_extras(
                            tx,
                            series_extras,
                            &leaving_series,
                            DecisionKind::Cleared,
                        )?;
                    }
                }
            }
            let fresh = assets
                .iter()
                .filter(|asset| {
                    !tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM character_relations WHERE target_id=?1 AND asset_id=?2)",
                        params![extras_id, asset],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap_or(false)
                })
                .cloned()
                .collect::<Vec<_>>();
            if !fresh.is_empty() {
                self.put_in_extras(tx, &extras_id, &fresh, DecisionKind::Accepted)?;
            }
            if group_level {
                if let Some(entry) = result
                    .groups_created
                    .iter_mut()
                    .find(|g| g.folder_id == a.tops[*top].id)
                {
                    entry.extras_count = assets.len();
                }
            } else {
                result.series_extras_count += assets.len();
            }
        }

        // 5. Remove the emptied folders, children first. A folder that still holds an image,
        // a child, a character link or a role stays.
        for top in &acted {
            for folder in a.tops[*top].folders.iter().rev() {
                let name = a.folder_names[folder].clone();
                let reason: Option<&str> = if a.linked_folders.contains(folder) {
                    Some("캐릭터에 연결된 폴더라 남겼습니다.")
                } else if tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM asset_classifications WHERE classification_id=?1)
                       OR EXISTS(SELECT 1 FROM classification_entries WHERE parent_id=?1)
                       OR EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)
                       OR EXISTS(SELECT 1 FROM classification_roles WHERE classification_id=?1)",
                    [folder],
                    |row| row.get::<_, bool>(0),
                )? {
                    Some("아직 이미지나 하위 폴더가 남아 있어 남겼습니다.")
                } else {
                    None
                };
                match reason {
                    None => {
                        Self::delete_classification_in(tx, folder)?;
                        result.folders_removed.push(CleanupFolderRef {
                            folder_id: folder.clone(),
                            name,
                        });
                    }
                    Some(reason) => {
                        result.folders_kept.push(CleanupKeptFolder {
                            folder_id: folder.clone(),
                            name,
                            reason: reason.to_owned(),
                        });
                    }
                }
            }
        }
        Ok((result, moved_targets))
    }
}

#[cfg(test)]
#[path = "character_subfolder_cleanup_tests.rs"]
mod tests;
