//! Presentation-only groups never update recognition targets or classifications.
use rusqlite::params;
use serde::{Deserialize, Serialize};
use super::{Library, characters::{Error, Result}};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group { pub id: String, pub name: String, pub revision: i64, pub target_ids: Vec<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDraft { pub id: Option<String>, pub series_id: String, pub expected_revision: Option<i64>, pub name: String, pub target_ids: Vec<String>, #[serde(default)] pub delete: bool }
impl Library {
    pub fn character_groups(&self, series_id: &str) -> Result<Vec<Group>> {
        let connection = self.connection()?;
        let mut stmt = connection.prepare("SELECT id,name,revision FROM character_groups WHERE series_id=?1 ORDER BY name,id")?;
        let groups = stmt.query_map([series_id], |r| Ok(Group { id:r.get(0)?, name:r.get(1)?, revision:r.get(2)?, target_ids:Vec::new() }))?.collect::<std::result::Result<Vec<_>,_>>()?;
        groups.into_iter().map(|mut group| {
            group.target_ids = connection.prepare("SELECT target_id FROM character_group_members WHERE group_id=?1 ORDER BY target_id")?.query_map([&group.id], |r| r.get(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            Ok(group)
        }).collect()
    }
    pub fn save_character_group(&self, draft: GroupDraft) -> Result<()> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let id = draft.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if draft.id.is_some() {
            let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM character_groups WHERE id=?1 AND series_id=?2 AND revision=?3)",params![id,draft.series_id,draft.expected_revision],|r|r.get(0))?;
            if !valid { return Err(Error::Stale); }
        } else if draft.delete { return Err(Error::NotFound); }
        if draft.delete { tx.execute("DELETE FROM character_groups WHERE id=?1",[&id])?; }
        else {
            let name = draft.name.trim();
            if name.is_empty() || name.chars().count()>100 || draft.target_ids.len()>1000 { return Err(Error::Invalid("그룹 이름과 캐릭터 목록을 확인해 주세요.")); }
            let series: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",[&draft.series_id],|r|r.get(0))?;
            if !series { return Err(Error::Invalid("등록된 시리즈를 선택해 주세요.")); }
            for target in &draft.target_ids {
                let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM character_targets WHERE id=?1 AND series_classification_id=?2) AND NOT EXISTS(SELECT 1 FROM character_group_members WHERE target_id=?1 AND group_id<>?3)",params![target,draft.series_id,id],|r|r.get(0))?;
                if !valid { return Err(Error::Invalid("같은 시리즈의 다른 그룹에 속하지 않은 캐릭터만 선택할 수 있습니다.")); }
            }
            tx.execute("INSERT INTO character_groups(id,series_id,name) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=revision+1",params![id,draft.series_id,name])?;
            tx.execute("DELETE FROM character_group_members WHERE group_id=?1",[&id])?;
            for target in &draft.target_ids { tx.execute("INSERT INTO character_group_members(target_id,group_id) VALUES(?1,?2)",params![target,id])?; }
        }
        tx.commit()?;
        Ok(())
    }
}
