//! Presentation-only groups never update recognition targets or classifications.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{
    characters::{Error, Result},
    Library,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub series_id: String,
    pub name: String,
    pub revision: i64,
    /// The group's real characters. The group's 기타 is not listed here; see `extras_target_id`.
    pub target_ids: Vec<String>,
    /// The group's 기타 (a target with role `extras`), once it exists.
    pub extras_target_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDraft {
    pub id: Option<String>,
    pub series_id: String,
    pub expected_revision: Option<i64>,
    pub name: String,
    pub target_ids: Vec<String>,
    #[serde(default)]
    pub delete: bool,
}

/// Stores the person's order of one series' groups: `group_ids` must be exactly the series'
/// groups, each once. Positions are 1..n; the group rows' `revision` is left alone, because an
/// order is not an edit (an open group editor stays valid). The character hub and the mobile
/// publication notice the change through the `character_groups` update.
pub(super) fn reorder_character_groups_in(
    connection: &Connection,
    series_id: &str,
    group_ids: &[String],
) -> Result<()> {
    if group_ids.len() > 1000 {
        return Err(Error::Invalid("그룹 순서를 확인해 주세요."));
    }
    let mut stored = connection
        .prepare("SELECT id FROM character_groups WHERE series_id=?1 ORDER BY id")?
        .query_map([series_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut requested = group_ids.to_vec();
    requested.sort();
    if requested.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(Error::Invalid("그룹 순서를 확인해 주세요."));
    }
    stored.sort();
    if requested != stored {
        // A group was added, removed or belongs to another series since the list was read.
        return Err(Error::Stale);
    }
    let mut update = connection.prepare("UPDATE character_groups SET position=?3 WHERE id=?1 AND series_id=?2 AND position IS NOT ?3")?;
    for (index, id) in group_ids.iter().enumerate() {
        update.execute(params![id, series_id, index as i64 + 1])?;
    }
    Ok(())
}

/// A group's 기타 target id, if the group has one.
fn group_extras(connection: &Connection, group_id: &str) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT id FROM character_targets WHERE role='extras' AND extras_group_id=?1",
            [group_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// Whether the group's 기타 currently holds an image.
fn group_extras_has_images(connection: &Connection, group_id: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM character_targets t
            JOIN character_relations r ON r.target_id=t.id
            WHERE t.role='extras' AND t.extras_group_id=?1)",
        [group_id],
        |row| row.get(0),
    )?)
}

pub(super) fn save_character_group_in(
    connection: &Connection,
    draft: GroupDraft,
) -> Result<String> {
    let id = draft
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if draft.id.is_some() {
        let valid: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_groups WHERE id=?1 AND series_id=?2 AND revision=?3)",
            params![id, draft.series_id, draft.expected_revision],
            |row| row.get(0),
        )?;
        if !valid {
            return Err(Error::Stale);
        }
    } else if draft.delete {
        return Err(Error::NotFound);
    }
    let own_extras = if draft.id.is_some() {
        group_extras(connection, &id)?
    } else {
        None
    };
    // The group's own 기타 may be listed by a caller that echoes `Group` members; it is
    // always kept, never counted as a real member, and no other group's 기타 is accepted.
    let target_ids = draft
        .target_ids
        .iter()
        .filter(|target| own_extras.as_deref() != Some(target.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let extras_has_images = draft.id.is_some() && group_extras_has_images(connection, &id)?;
    if draft.delete {
        if extras_has_images {
            return Err(Error::Invalid(
                "기타에 이미지가 있는 그룹은 지울 수 없습니다. 기타를 먼저 비워 주세요.",
            ));
        }
        connection.execute("DELETE FROM character_groups WHERE id=?1", [&id])?;
        return Ok(id);
    }
    if draft.id.is_some() && target_ids.is_empty() {
        if extras_has_images {
            // A group that only keeps its 기타: release the real members, keep the group.
            connection.execute(
                "DELETE FROM character_group_members WHERE group_id=?1
                 AND target_id IN (SELECT id FROM character_targets WHERE role='character')",
                [&id],
            )?;
            connection.execute(
                "UPDATE character_groups SET revision=revision+1 WHERE id=?1",
                [&id],
            )?;
            return Ok(id);
        }
        connection.execute("DELETE FROM character_groups WHERE id=?1", [&id])?;
        return Ok(id);
    }
    if target_ids.is_empty() {
        return Err(Error::Invalid(
            "그룹에 넣을 캐릭터를 하나 이상 선택해 주세요.",
        ));
    }

    let name = draft.name.trim();
    if name.is_empty() || name.chars().count() > 100 || target_ids.len() > 1000 {
        return Err(Error::Invalid("그룹 이름과 캐릭터 목록을 확인해 주세요."));
    }
    let series: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",
        [&draft.series_id],
        |row| row.get(0),
    )?;
    if !series {
        return Err(Error::Invalid("등록된 시리즈를 선택해 주세요."));
    }
    for target in &target_ids {
        let valid: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_targets WHERE id=?1 AND series_classification_id=?2 AND role='character') \
             AND NOT EXISTS(SELECT 1 FROM character_group_members WHERE target_id=?1 AND group_id<>?3)",
            params![target, draft.series_id, id],
            |row| row.get(0),
        )?;
        if !valid {
            return Err(Error::Invalid(
                "같은 시리즈의 다른 그룹에 속하지 않은 캐릭터만 선택할 수 있습니다.",
            ));
        }
    }
    connection.execute(
        "INSERT INTO character_groups(id,series_id,name) VALUES(?1,?2,?3) \
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=revision+1",
        params![id, draft.series_id, name],
    )?;
    // Add first, then remove only deselected members. Temporarily clearing the
    // group would activate the empty-group trigger during an ordinary edit.
    for target in &target_ids {
        connection.execute(
            "INSERT INTO character_group_members(target_id,group_id) VALUES(?1,?2) ON CONFLICT(target_id) DO NOTHING",
            params![target, id],
        )?;
    }
    connection.execute(
        "DELETE FROM character_group_members WHERE group_id=?1 AND target_id NOT IN (SELECT value FROM json_each(?2))
         AND target_id NOT IN (SELECT id FROM character_targets WHERE role='extras')",
        params![id, serde_json::to_string(&target_ids)?],
    )?;
    if own_extras.is_some() {
        super::character_extras::rename_group_extras_in(connection, &id, name)?;
    }
    Ok(id)
}

/// Groups of one series, or of all series when `series_id` is None, with their members, in
/// the person's order (placed groups by position, then unplaced ones by name): two statements
/// whatever the group count.
pub(super) fn groups_in(connection: &Connection, series_id: Option<&str>) -> Result<Vec<Group>> {
    let mut groups = connection
        .prepare_cached(
            "SELECT id,series_id,name,revision FROM character_groups
             WHERE ?1 IS NULL OR series_id=?1 ORDER BY series_id,position IS NULL,position,name,id",
        )?
        .query_map([series_id], |row| {
            Ok(Group {
                id: row.get(0)?,
                series_id: row.get(1)?,
                name: row.get(2)?,
                revision: row.get(3)?,
                target_ids: Vec::new(),
                extras_target_id: None,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut members = std::collections::BTreeMap::<String, Vec<String>>::new();
    let mut extras = std::collections::BTreeMap::<String, String>::new();
    for row in connection
        .prepare_cached(
            "SELECT m.group_id,m.target_id,t.role FROM character_group_members m
             JOIN character_groups g ON g.id=m.group_id
             JOIN character_targets t ON t.id=m.target_id
             WHERE ?1 IS NULL OR g.series_id=?1 ORDER BY m.group_id,m.target_id",
        )?
        .query_map([series_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
    {
        let (group, target, role) = row?;
        if role == "extras" {
            extras.insert(group, target);
        } else {
            members.entry(group).or_default().push(target);
        }
    }
    for group in &mut groups {
        group.target_ids = members.remove(&group.id).unwrap_or_default();
        group.extras_target_id = extras.remove(&group.id);
    }
    Ok(groups)
}

impl Library {
    pub fn character_groups(&self, series_id: &str) -> Result<Vec<Group>> {
        groups_in(&*self.connection()?, Some(series_id))
    }

    /// Every series' groups in one read (by series, then the person's order), for the character hub.
    pub fn all_character_groups(&self) -> Result<Vec<Group>> {
        groups_in(&*self.connection()?, None)
    }

    /// Puts the groups of one series in the given order (all of them, once each).
    pub fn reorder_character_groups(&self, series_id: &str, group_ids: &[String]) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        reorder_character_groups_in(&transaction, series_id, group_ids)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn save_character_group(&self, draft: GroupDraft) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        save_character_group_in(&transaction, draft)?;
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::characters::tests::Fixture;

    fn save(f: &Fixture, group: Option<&Group>, ids: Vec<String>) -> Result<()> {
        f.library.save_character_group(GroupDraft {
            id: group.map(|g| g.id.clone()),
            series_id: f.series.clone(),
            expected_revision: group.map(|g| g.revision),
            name: "Group".into(),
            target_ids: ids,
            delete: false,
        })
    }

    #[test]
    fn all_groups_read_every_series_in_two_statements() {
        let f = Fixture::new();
        let a = f.ready("A");
        let b = f.ready("B");
        let d = f.ready("D");
        let other = f.ready_in_series("C", &f.child);
        for (series, name, targets) in [
            (&f.series, "Duo", vec![a.id.clone(), b.id.clone()]),
            (&f.series, "Alpha", vec![d.id.clone()]),
            (&f.child, "Solo", vec![other.id.clone()]),
        ] {
            save_character_group_in(
                &f.library.connection().unwrap(),
                GroupDraft {
                    id: None,
                    series_id: series.clone(),
                    expected_revision: None,
                    name: name.into(),
                    target_ids: targets,
                    delete: false,
                },
            )
            .unwrap();
        }
        crate::library::PREPARED_SELECTS.with(|count| count.set(0));
        let all = f.library.all_character_groups().unwrap();
        assert!(crate::library::PREPARED_SELECTS.with(|count| count.get()) <= 4);
        let mut per_series = Vec::new();
        for series in [&f.child, &f.series] {
            per_series.extend(f.library.character_groups(series).unwrap());
        }
        per_series
            .sort_by(|x, y| (&x.series_id, &x.name, &x.id).cmp(&(&y.series_id, &y.name, &y.id)));
        let shape = |groups: &[Group]| {
            groups
                .iter()
                .map(|g| (g.series_id.clone(), g.name.clone(), g.target_ids.clone()))
                .collect::<Vec<_>>()
        };
        assert_eq!(shape(&all), shape(&per_series));
        let mut duo = vec![a.id.clone(), b.id.clone()];
        duo.sort();
        assert!(shape(&all).contains(&(f.series.clone(), "Duo".into(), duo)));
        assert!(shape(&all).contains(&(f.series.clone(), "Alpha".into(), vec![d.id.clone()])));
        assert_eq!(all.len(), 3);
    }

    fn group_in(f: &Fixture, series: &str, name: &str, target: &str) -> String {
        save_character_group_in(
            &f.library.connection().unwrap(),
            GroupDraft {
                id: None,
                series_id: series.into(),
                expected_revision: None,
                name: name.into(),
                target_ids: vec![target.into()],
                delete: false,
            },
        )
        .unwrap()
    }

    fn names(groups: &[Group]) -> Vec<String> {
        groups.iter().map(|g| g.name.clone()).collect()
    }

    fn group_ids(library: &Library, series: &str) -> Vec<String> {
        library
            .character_groups(series)
            .unwrap()
            .iter()
            .map(|g| g.id.clone())
            .collect()
    }

    fn generation(f: &Fixture) -> i64 {
        f.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT generation FROM mobile_publication_state WHERE kind='characters'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[test]
    fn reorder_character_groups_stores_validates_and_lists_the_order_everywhere() {
        let f = Fixture::new();
        let mut ids: Vec<String> = ["A", "B", "C"].iter().map(|n| f.ready(n).id).collect();
        ids.push(f.ready_in_series("D", &f.child).id);
        let alpha = group_in(&f, &f.series, "Alpha", &ids[0]);
        let beta = group_in(&f, &f.series, "Beta", &ids[1]);
        let gamma = group_in(&f, &f.series, "Gamma", &ids[2]);
        let other = group_in(&f, &f.child, "Other", &ids[3]);
        // Nobody reordered yet: name order, as before.
        assert_eq!(
            names(&f.library.character_groups(&f.series).unwrap()),
            ["Alpha", "Beta", "Gamma"]
        );
        let revisions: Vec<i64> = f
            .library
            .character_groups(&f.series)
            .unwrap()
            .iter()
            .map(|g| g.revision)
            .collect();

        let before = generation(&f);
        f.library
            .reorder_character_groups(&f.series, &[gamma.clone(), alpha.clone(), beta.clone()])
            .unwrap();
        assert!(
            generation(&f) > before,
            "the mobile publication must become dirty"
        );
        let ordered = f.library.character_groups(&f.series).unwrap();
        assert_eq!(names(&ordered), ["Gamma", "Alpha", "Beta"]);
        // An order is not an edit: revisions (and so an open editor) stay valid.
        assert_eq!(
            ordered.iter().map(|g| g.revision).collect::<Vec<_>>(),
            [revisions[2], revisions[0], revisions[1]]
        );
        // The hub's single read lists the same order, series by series.
        let all = f.library.all_character_groups().unwrap();
        let in_series = |series: &str| {
            all.iter()
                .filter(|g| g.series_id == series)
                .map(|g| g.id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            in_series(&f.series),
            [gamma.clone(), alpha.clone(), beta.clone()]
        );
        assert_eq!(in_series(&f.child), [other.clone()]);

        // Saving the same order again changes nothing (no spurious publication).
        let settled = generation(&f);
        f.library
            .reorder_character_groups(&f.series, &[gamma.clone(), alpha.clone(), beta.clone()])
            .unwrap();
        assert_eq!(generation(&f), settled);

        // A group created later in an ordered series goes last; renaming keeps the place.
        let late = f.ready("E");
        let newest = group_in(&f, &f.series, "Aaa late", &late.id);
        assert_eq!(
            names(&f.library.character_groups(&f.series).unwrap()),
            ["Gamma", "Alpha", "Beta", "Aaa late"]
        );
        let alpha_group = f.library.character_groups(&f.series).unwrap().remove(1);
        save(&f, Some(&alpha_group), alpha_group.target_ids.clone()).unwrap();
        assert_eq!(
            names(&f.library.character_groups(&f.series).unwrap()),
            ["Gamma", "Group", "Beta", "Aaa late"]
        );

        // Refused: a list that lacks a group, repeats one, names another series' group, an
        // unknown group, or is empty. Nothing changes.
        let current = group_ids(&f.library, &f.series);
        assert_eq!(current.len(), 4);
        for bad in [
            vec![gamma.clone(), alpha.clone(), beta.clone()],
            vec![
                gamma.clone(),
                gamma.clone(),
                alpha.clone(),
                beta.clone(),
                newest.clone(),
            ],
            vec![gamma.clone(), alpha.clone(), beta.clone(), other.clone()],
            vec![gamma.clone(), alpha.clone(), beta.clone(), "missing".into()],
            vec![],
        ] {
            assert!(
                f.library.reorder_character_groups(&f.series, &bad).is_err(),
                "{bad:?}"
            );
        }
        assert!(f
            .library
            .reorder_character_groups(&f.child, &[alpha.clone()])
            .is_err());
        assert_eq!(group_ids(&f.library, &f.series), current);
        assert_eq!(group_ids(&f.library, &f.child), [other.clone()]);
        // A series without groups accepts only the empty list.
        f.library.reorder_character_groups(&f.outside, &[]).unwrap();
        assert!(f
            .library
            .reorder_character_groups(&f.outside, &[beta.clone()])
            .is_err());

        // The order survives a restart.
        let path = f.temp.path().to_path_buf();
        drop(f.library);
        let reopened = Library::open(&path).unwrap();
        assert_eq!(
            names(&reopened.character_groups(&f.series).unwrap()),
            ["Gamma", "Group", "Beta", "Aaa late"]
        );
    }

    #[test]
    fn reorder_character_groups_is_published_as_group_node_ids_after_the_folder_order() {
        let f = Fixture::new();
        let a = f.ready("A");
        let b = f.ready("B");
        let first = group_in(&f, &f.series, "Alpha", &a.id);
        let second = group_in(&f, &f.series, "Beta", &b.id);
        let snapshot = |library: &Library| {
            let mut connection = library.connection().unwrap();
            serde_json::to_value(
                crate::cloud::characters::snapshot_from_connection(&mut connection, None, &|_| {})
                    .unwrap(),
            )
            .unwrap()
        };
        let strings = |value: &serde_json::Value| {
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        let group_nodes = |value: &serde_json::Value| {
            value["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|n| n["kind"] == "group")
                .map(|n| n["id"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        f.library
            .save_mobile_navigation_order(vec!["folder-1".into(), f.series.clone()])
            .unwrap();
        let before = snapshot(&f.library);
        assert_eq!(
            group_nodes(&before),
            [format!("group:{first}"), format!("group:{second}")]
        );
        assert_eq!(
            strings(&before["navigationOrder"]),
            [
                "folder-1".to_string(),
                f.series.clone(),
                format!("group:{first}"),
                format!("group:{second}")
            ]
        );

        f.library
            .reorder_character_groups(&f.series, &[second.clone(), first.clone()])
            .unwrap();
        let after = snapshot(&f.library);
        assert_eq!(
            group_nodes(&after),
            [format!("group:{second}"), format!("group:{first}")]
        );
        assert_eq!(
            strings(&after["navigationOrder"]),
            [
                "folder-1".to_string(),
                f.series.clone(),
                format!("group:{second}"),
                format!("group:{first}")
            ]
        );
        // The server keys a revision on the content: the order must change it.
        assert_ne!(before["navigationOrder"], after["navigationOrder"]);
        // No groups, no group entries: the PC's own order is published as it is.
        for group in [&first, &second] {
            let revision = f
                .library
                .character_groups(&f.series)
                .unwrap()
                .iter()
                .find(|g| &g.id == group)
                .unwrap()
                .revision;
            f.library
                .save_character_group(GroupDraft {
                    id: Some(group.clone()),
                    series_id: f.series.clone(),
                    expected_revision: Some(revision),
                    name: "x".into(),
                    target_ids: vec![],
                    delete: false,
                })
                .unwrap();
        }
        assert_eq!(
            strings(&snapshot(&f.library)["navigationOrder"]),
            ["folder-1".to_string(), f.series.clone()]
        );
    }

    #[test]
    fn empty_character_groups_edit_replaces_members_without_deleting_group() {
        let f = Fixture::new();
        let a = f.ready("A");
        let b = f.ready("B");
        save(&f, None, vec![a.id.clone()]).unwrap();
        let original = f.library.character_groups(&f.series).unwrap().remove(0);
        save(&f, Some(&original), vec![b.id.clone()]).unwrap();
        let replaced = f.library.character_groups(&f.series).unwrap().remove(0);
        assert_eq!(replaced.id, original.id);
        assert_eq!(replaced.revision, original.revision + 1);
        assert_eq!(replaced.target_ids, vec![b.id.clone()]);
        assert!(save(&f, Some(&original), vec![]).is_err());
        save(&f, Some(&replaced), vec![]).unwrap();
        assert!(f.library.character_groups(&f.series).unwrap().is_empty());
        assert!(save(&f, None, vec![]).is_err());
        for target in [&a, &b] {
            assert_eq!(
                f.library
                    .get_character_target(&target.id)
                    .unwrap()
                    .fingerprint,
                target.fingerprint
            );
        }
        assert_eq!(
            f.library
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM character_autotag_jobs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn empty_character_groups_cascade_removes_only_last_members_group() {
        let f = Fixture::new();
        let a = f.ready("A");
        let b = f.ready("B");
        save(&f, None, vec![a.id.clone(), b.id.clone()]).unwrap();
        let c = f.library.connection().unwrap();
        c.execute("DELETE FROM character_targets WHERE id=?1", [&a.id])
            .unwrap();
        drop(c);
        assert_eq!(f.library.character_groups(&f.series).unwrap().len(), 1);
        let c = f.library.connection().unwrap();
        c.execute("DELETE FROM character_targets WHERE id=?1", [&b.id])
            .unwrap();
        drop(c);
        assert!(f.library.character_groups(&f.series).unwrap().is_empty());
        let c = f.library.connection().unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            7
        );
        assert!(!c
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }

    #[test]
    fn empty_character_groups_migration_cleans_existing_empty_groups_only() {
        let (temp, c) = crate::library::characters::tests::historical_character_library(71);
        c.execute_batch(
            "INSERT INTO character_groups(id,series_id,name) VALUES
             ('populated','series','Group'),('empty','series','Empty');
             INSERT INTO character_group_members(target_id,group_id) VALUES('target','populated');"
        ).unwrap();
        let references_before: Vec<(u32, String, String)> = c
            .prepare("SELECT slot,asset_id,asset_hash FROM character_references WHERE target_id='target' ORDER BY slot")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        drop(c);
        let reopened = Library::open(temp.path()).unwrap();
        let groups = reopened.character_groups("series").unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, "populated");
        assert_eq!(groups[0].name, "Group");
        assert_eq!(groups[0].revision, 1);
        assert_eq!(groups[0].target_ids, vec!["target"]);
        let target = reopened.get_character_target("target").unwrap();
        assert_eq!(target.series_classification_id.as_deref(), Some("series"));
        assert_eq!(target.linked_classification_id.as_deref(), Some("character"));
        assert_eq!(target.display_name, "Pilot");
        assert_eq!(target.revision, 3);
        assert!(target.ready);
        assert!(!target.manual_only);
        assert_eq!(target.references.len(), references_before.len());
        assert!(target.references.iter().all(|reference| reference.region.is_none()));
        assert!(target.learned_references.is_empty());
        assert_eq!(
            target.usable_references().map(|r| (r.slot, r.asset_id.clone().unwrap(), r.asset_hash.clone())).collect::<Vec<_>>(),
            references_before
        );
        let c = reopened.connection().unwrap();
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            super::super::db::SCHEMA_VERSION
        );
        assert_eq!(c.query_row("SELECT COUNT(*) FROM assets", [], |row| row.get::<_, i64>(0)).unwrap(), 5);
        assert!(!c.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM character_autotag_jobs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        c.execute(
            "DELETE FROM character_group_members WHERE target_id=?1",
            [&target.id],
        )
        .unwrap();
        drop(c);
        assert!(reopened.character_groups("series").unwrap().is_empty());
    }
}
