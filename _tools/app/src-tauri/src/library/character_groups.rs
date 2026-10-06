//! Presentation-only groups never update recognition targets or classifications.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{
    characters::{Error, Result},
    Library,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub series_id: String,
    pub name: String,
    pub revision: i64,
    pub target_ids: Vec<String>,
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
    if draft.delete || (draft.id.is_some() && draft.target_ids.is_empty()) {
        connection.execute("DELETE FROM character_groups WHERE id=?1", [&id])?;
        return Ok(id);
    }
    if draft.target_ids.is_empty() {
        return Err(Error::Invalid(
            "그룹에 넣을 캐릭터를 하나 이상 선택해 주세요.",
        ));
    }

    let name = draft.name.trim();
    if name.is_empty() || name.chars().count() > 100 || draft.target_ids.len() > 1000 {
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
    for target in &draft.target_ids {
        let valid: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_targets WHERE id=?1 AND series_classification_id=?2) \
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
    for target in &draft.target_ids {
        connection.execute(
            "INSERT INTO character_group_members(target_id,group_id) VALUES(?1,?2) ON CONFLICT(target_id) DO NOTHING",
            params![target, id],
        )?;
    }
    connection.execute(
        "DELETE FROM character_group_members WHERE group_id=?1 AND target_id NOT IN (SELECT value FROM json_each(?2))",
        params![id, serde_json::to_string(&draft.target_ids)?],
    )?;
    Ok(id)
}

/// Groups of one series, or of all series when `series_id` is None, with their members:
/// two statements whatever the group count.
fn groups_in(connection: &Connection, series_id: Option<&str>) -> Result<Vec<Group>> {
    let mut groups = connection
        .prepare_cached(
            "SELECT id,series_id,name,revision FROM character_groups
             WHERE ?1 IS NULL OR series_id=?1 ORDER BY series_id,name,id",
        )?
        .query_map([series_id], |row| {
            Ok(Group {
                id: row.get(0)?,
                series_id: row.get(1)?,
                name: row.get(2)?,
                revision: row.get(3)?,
                target_ids: Vec::new(),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut members = std::collections::BTreeMap::<String, Vec<String>>::new();
    for row in connection
        .prepare_cached(
            "SELECT m.group_id,m.target_id FROM character_group_members m
             JOIN character_groups g ON g.id=m.group_id
             WHERE ?1 IS NULL OR g.series_id=?1 ORDER BY m.group_id,m.target_id",
        )?
        .query_map([series_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
    {
        let (group, target) = row?;
        members.entry(group).or_default().push(target);
    }
    for group in &mut groups {
        group.target_ids = members.remove(&group.id).unwrap_or_default();
    }
    Ok(groups)
}

impl Library {
    pub fn character_groups(&self, series_id: &str) -> Result<Vec<Group>> {
        groups_in(&*self.connection()?, Some(series_id))
    }

    /// Every series' groups in one read (by series, then name), for the character hub.
    pub fn all_character_groups(&self) -> Result<Vec<Group>> {
        groups_in(&*self.connection()?, None)
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
