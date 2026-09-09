use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use super::{Library, characters::{Error, Result}, models::SetAssetClassification};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionPreview {
 pub target_id: String, pub name: String, pub series_id: String, pub destination_id: Option<String>,
 pub asset_count: usize, pub shared_count: usize, pub unavailable_count: usize, pub token: String,
 #[serde(skip)] asset_ids: Vec<String>,
}
impl Library {
 fn character_conversion_in(&self, connection: &Connection, target_id: &str) -> Result<ConversionPreview> {
  let target = self.read_character_target(connection,target_id)?;
  let series = target.series_classification_id.as_deref().ok_or(Error::Invalid("시리즈를 먼저 연결해 주세요."))?;
  let destination: Option<String> = connection.query_row("SELECT id FROM classification_entries WHERE parent_id=?1 AND name=?2 COLLATE NOCASE",params![series,target.display_name],|r|r.get(0)).optional()?;
  if let Some(id) = &destination {
   let special: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1) OR EXISTS(SELECT 1 FROM character_targets WHERE linked_classification_id=?1 AND id<>?2)",params![id,target_id],|r|r.get(0))?;
   if special { return Err(Error::Invalid("같은 이름의 폴더가 다른 시리즈나 캐릭터에 연결되어 있습니다. 먼저 폴더 이름을 변경해 주세요.")); }
  }
  let ids = connection.prepare("SELECT asset_id FROM character_relations WHERE target_id=?1 UNION SELECT asset_id FROM character_references WHERE target_id=?1 AND asset_id IS NOT NULL ORDER BY asset_id")?.query_map([target_id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
  let mut shared = 0;
  let mut unavailable = target.references.iter().filter(|r|r.asset_id.is_none()).count();
  let mut snapshot = Vec::new();
  for id in &ids {
   let (status, hash): (String,String) = connection.query_row("SELECT status,content_hash FROM assets WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?)))?;
   if status != "normal" { unavailable += 1; }
   let others: String = connection.query_row("SELECT COALESCE(group_concat(target_id), '') FROM (SELECT target_id FROM character_relations WHERE asset_id=?1 AND target_id<>?2 ORDER BY target_id)",params![id,target_id],|r|r.get(0))?;
   if !others.is_empty() { shared += 1; }
   let classification: String = connection.query_row("SELECT COALESCE(group_concat(classification_id), '') FROM (SELECT classification_id FROM asset_classifications WHERE asset_id=?1 ORDER BY classification_id)",[id],|r|r.get(0))?;
   snapshot.push((id.clone(),status,hash,others,classification));
  }
  let token = Sha256::digest(serde_json::to_vec(&(target.fingerprint,&destination,&snapshot,&target.learned_references))?).iter().map(|byte|format!("{byte:02x}")).collect();
  Ok(ConversionPreview { target_id:target_id.into(),name:target.display_name,series_id:series.into(),destination_id:destination,asset_count:ids.len(),shared_count:shared,unavailable_count:unavailable,token,asset_ids:ids })
 }
 pub fn character_conversion_preview(&self, target_id: &str) -> Result<ConversionPreview> { let connection=self.connection()?; self.character_conversion_in(&connection,target_id) }
 pub fn convert_character_to_folder(&self, target_id: &str, token: &str, confirmation: &str) -> Result<String> {
  let mut connection=self.connection()?;
  let tx=connection.transaction()?;
  let preview=self.character_conversion_in(&tx,target_id)?;
  if preview.token!=token { return Err(Error::Stale); }
  if confirmation!=preview.name { return Err(Error::Invalid("캐릭터 이름을 정확히 입력해 주세요.")); }
  let destination=if let Some(id)=preview.destination_id {id} else {
   let id=uuid::Uuid::new_v4().to_string();
   tx.execute("INSERT INTO classification_entries(id,kind,name,parent_id,created_at) VALUES(?1,'tag',?2,?3,?4)",params![id,preview.name,preview.series_id,chrono::Utc::now().to_rfc3339()])?;
   id
  };
  if !preview.asset_ids.is_empty() { Self::set_asset_classification_in(&tx,&SetAssetClassification {asset_ids:preview.asset_ids,classification_id:Some(destination.clone())})?; }
  // Only this character's history/relations are removed, after all assets have a folder.
  tx.execute("DELETE FROM character_decisions WHERE target_id=?1",[target_id])?;
  tx.execute("DELETE FROM character_targets WHERE id=?1",[target_id])?;
  tx.execute("INSERT INTO character_autotag_reconsideration(series_id) VALUES(?1) ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL",[&preview.series_id])?;
  tx.commit()?;
  Ok(destination)
 }
}
