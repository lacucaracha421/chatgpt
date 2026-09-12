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

impl Library {
    pub fn character_groups(&self, series_id: &str) -> Result<Vec<Group>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,name,revision FROM character_groups WHERE series_id=?1 ORDER BY name,id",
        )?;
        let groups = statement
            .query_map([series_id], |row| {
                Ok(Group {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    revision: row.get(2)?,
                    target_ids: Vec::new(),
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        groups
            .into_iter()
            .map(|mut group| {
                group.target_ids = connection
                    .prepare(
                        "SELECT target_id FROM character_group_members WHERE group_id=?1 ORDER BY target_id",
                    )?
                    .query_map([&group.id], |row| row.get(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(group)
            })
            .collect()
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
        let f = Fixture::new();
        let target = f.ready("A");
        save(&f, None, vec![target.id.clone()]).unwrap();
        let c = f.library.connection().unwrap();
        c.execute_batch("DROP TRIGGER character_group_remove_empty; PRAGMA user_version=71;")
            .unwrap();
        c.execute(
            "INSERT INTO character_groups(id,series_id,name) VALUES('empty',?1,'Empty')",
            [&f.series],
        )
        .unwrap();
        drop(c);
        drop(f.library);
        let reopened = Library::open(f.temp.path()).unwrap();
        assert_eq!(reopened.character_groups(&f.series).unwrap().len(), 1);
        assert_eq!(
            reopened
                .get_character_target(&target.id)
                .unwrap()
                .fingerprint,
            target.fingerprint
        );
        let c = reopened.connection().unwrap();
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            72
        );
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
        assert!(reopened.character_groups(&f.series).unwrap().is_empty());
    }
}
