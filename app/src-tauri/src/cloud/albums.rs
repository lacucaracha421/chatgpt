//! Read-only album metadata sent alongside the existing mobile metadata snapshots.
use super::client::CloudClient;
use crate::library::{error::LibraryError, Library};
use serde_json::{json, Value};
use std::collections::BTreeMap;

impl Library {
    pub(super) fn album_replica_snapshot(&self) -> Result<Value, LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let published_at = chrono::Utc::now().to_rfc3339();
        let mut query = transaction.prepare("SELECT id,name,parent_id FROM albums ORDER BY id")?;
        let albums = query
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_,String>(0)?, "name": r.get::<_,String>(1)?,
                    "parent_id": r.get::<_,Option<String>>(2)?
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut media = BTreeMap::<String, Value>::new();
        let mut query = transaction.prepare("SELECT a.id,a.collected_at,COALESCE(a.width,0),COALESCE(a.height,0),COALESCE(v.duration_ms,0),link.album_id
            FROM asset_albums link JOIN assets a ON a.id=link.asset_id
            LEFT JOIN video_assets v ON v.asset_id=a.id
            WHERE a.status='normal' ORDER BY a.id,link.album_id")?;
        let rows = query.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        for row in rows {
            let (id, date, width, height, duration, album) = row?;
            let timestamp = chrono::DateTime::parse_from_rfc3339(&date)
                .map_err(|_| LibraryError::InvalidCloudResponse)?
                .timestamp_millis()
                .max(0);
            let item = media.entry(id.clone()).or_insert_with(|| {
                json!({
                    "id":id,"date":timestamp,"width":width.max(0),"height":height.max(0),
                    "duration":duration.max(0),"albums":[]
                })
            });
            item["albums"]
                .as_array_mut()
                .expect("constructed as array")
                .push(json!(album));
        }
        Ok(
            json!({"published_at":published_at,"albums":albums,"media":media.into_values().collect::<Vec<_>>()}),
        )
    }

    pub(super) fn publish_album_replica_with(
        &self,
        client: &CloudClient,
        token: &str,
    ) -> Result<(), LibraryError> {
        client.publish_album_replica(token, &self.album_replica_snapshot()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::models::{AssetAlbumPatch, CreateAlbum};
    #[test]
    fn album_snapshot_tracks_membership_removal_and_hides_trashed_assets() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let a = library
            .create_album(CreateAlbum {
                name: "Upload".into(),
                parent_id: None,
            })
            .unwrap();
        let b = library
            .create_album(CreateAlbum {
                name: "Temp".into(),
                parent_id: None,
            })
            .unwrap();
        library.connection().unwrap().execute("INSERT INTO assets (id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES ('asset','hash','image','a.png','assets/a.png','thumbnails/a.webp',1,10,20,'2026-09-07T00:00:00Z')",[]).unwrap();
        library
            .patch_asset_albums(AssetAlbumPatch {
                asset_ids: vec!["asset".into()],
                add_album_ids: vec![a.id.clone(), b.id.clone()],
                remove_album_ids: vec![],
            })
            .unwrap();
        let first = library.album_replica_snapshot().unwrap();
        assert_eq!(first["media"].as_array().unwrap().len(), 1);
        assert_eq!(first["media"][0]["albums"].as_array().unwrap().len(), 2);
        library
            .patch_asset_albums(AssetAlbumPatch {
                asset_ids: vec!["asset".into()],
                add_album_ids: vec![],
                remove_album_ids: vec![b.id],
            })
            .unwrap();
        assert_eq!(
            library.album_replica_snapshot().unwrap()["media"][0]["albums"],
            json!([a.id])
        );
        library.connection().unwrap().execute("UPDATE assets SET status='trash',trashed_at='2026-09-07T01:00:00Z' WHERE id='asset'",[]).unwrap();
        assert!(library.album_replica_snapshot().unwrap()["media"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}
