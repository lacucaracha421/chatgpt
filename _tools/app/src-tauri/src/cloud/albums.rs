//! Read-only album metadata sent alongside the existing mobile metadata snapshots.
//!
//! The snapshot is also the staging representation an Album-authority cutover
//! validates, so it carries every canonical Album field the server needs: identity,
//! name, parent, appearance and Asset<->Album memberships. `snapshotVersion` states
//! the contract explicitly, because the server must not infer "authority-ready" from
//! the presence of a field.
//!
//! Display data and canonical membership are deliberately separate fields:
//!
//! * `media` is the display replica — normal-visible Assets only, with presentation
//!   metadata such as dates and dimensions;
//! * `memberships` is canonical Album state — every `asset_albums` relation,
//!   regardless of Asset display status.
//!
//! A trashed Asset keeps its Album relations in the local database, so deriving
//! canonical membership from `media` would silently drop them at activation and break
//! the contract that restoring an Asset returns its Albums.
use super::client::CloudClient;
use crate::library::{error::LibraryError, Library};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// The snapshot contract version this build publishes.
///
/// 1: identity/name/parent only.
/// 2: adds `icon_key`/`color_key`.
/// 3: adds the canonical `memberships` collection, which is what the server requires
///    before it will treat a snapshot as the authority baseline.
const SNAPSHOT_VERSION: i64 = 3;

impl Library {
    pub(super) fn album_replica_snapshot(&self) -> Result<Value, LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let published_at = chrono::Utc::now().to_rfc3339();
        let mut query = transaction
            .prepare("SELECT id,name,parent_id,icon_key,color_key FROM albums ORDER BY id")?;
        let albums = query
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_,String>(0)?, "name": r.get::<_,String>(1)?,
                    "parent_id": r.get::<_,Option<String>>(2)?,
                    "icon_key": r.get::<_,Option<String>>(3)?,
                    "color_key": r.get::<_,Option<String>>(4)?
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        // Canonical membership intentionally has no `status` predicate. The relation
        // survives trash, and permanent deletion removes it through normal database
        // ownership, so this query reflects exactly the local truth.
        let mut query = transaction
            .prepare("SELECT album_id,asset_id FROM asset_albums ORDER BY album_id,asset_id")?;
        let memberships = query
            .query_map([], |r| {
                Ok(json!({
                    "albumId": r.get::<_,String>(0)?, "assetId": r.get::<_,String>(1)?
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        // Display replica: normal-visible Assets only, with presentation metadata.
        // This stays separate from canonical membership above, so enriching the
        // authoritative set does not change what the legacy display route returns.
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
            json!({"snapshotVersion":SNAPSHOT_VERSION,"published_at":published_at,"albums":albums,"memberships":memberships,"media":media.into_values().collect::<Vec<_>>()}),
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

    /// The snapshot is the staging representation an authority cutover validates, so the
    /// version that makes it authority-ready and every canonical Album field must
    /// actually be on the wire.
    #[test]
    fn album_snapshot_declares_its_version_and_canonical_appearance() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let album = library
            .create_album(CreateAlbum {
                name: "Styled".into(),
                parent_id: None,
            })
            .unwrap();
        library
            .update_album_appearance(&album.id, Some("folder"), Some("blue"))
            .unwrap();

        let snapshot = library.album_replica_snapshot().unwrap();

        assert_eq!(snapshot["snapshotVersion"], json!(3));
        let albums = snapshot["albums"].as_array().unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0]["id"], json!(album.id));
        assert_eq!(albums[0]["icon_key"], json!("folder"));
        assert_eq!(albums[0]["color_key"], json!("blue"));
        // Asset presentation metadata stays in `media`, outside canonical Album state.
        assert!(snapshot["albums"][0].get("width").is_none());
        // Canonical membership is its own field, present even when empty, so the server
        // can tell "no relations" from "this publisher has no canonical membership".
        assert_eq!(snapshot["memberships"], json!([]));
    }

    /// Trash must not remove Album membership from the authority baseline.
    ///
    /// `trash_assets` only changes Asset status, and the product contract is that
    /// restoring an Asset returns its Albums. The display array correctly hides a
    /// trashed Asset, so canonical membership must be built from `asset_albums`
    /// instead — otherwise activation would silently drop those relations.
    #[test]
    fn canonical_membership_survives_trash_while_display_media_hides_it() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let album = library
            .create_album(CreateAlbum {
                name: "Kept".into(),
                parent_id: None,
            })
            .unwrap();
        library.connection().unwrap().execute("INSERT INTO assets (id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES ('asset','hash','image','a.png','assets/a.png','thumbnails/a.webp',1,10,20,'2026-09-07T00:00:00Z')",[]).unwrap();
        library
            .patch_asset_albums(AssetAlbumPatch {
                asset_ids: vec!["asset".into()],
                add_album_ids: vec![album.id.clone()],
                remove_album_ids: vec![],
            })
            .unwrap();

        let before = library.album_replica_snapshot().unwrap();
        assert_eq!(
            before["memberships"],
            json!([{"albumId": album.id, "assetId": "asset"}])
        );
        assert_eq!(before["media"].as_array().unwrap().len(), 1);

        library.trash_assets(&["asset".into()]).unwrap();

        let after = library.album_replica_snapshot().unwrap();
        // The display array still hides the trashed Asset...
        assert!(after["media"].as_array().unwrap().is_empty());
        // ...while canonical membership retains the relation for a later restore.
        assert_eq!(
            after["memberships"],
            json!([{"albumId": album.id, "assetId": "asset"}])
        );

        library.restore_assets(&["asset".into()]).unwrap();
        let restored = library.album_replica_snapshot().unwrap();
        assert_eq!(restored["media"].as_array().unwrap().len(), 1);
        assert_eq!(
            restored["memberships"],
            json!([{"albumId": album.id, "assetId": "asset"}])
        );
    }

    /// Permanent deletion removes the local relation, so a later snapshot drops it.
    #[test]
    fn permanent_deletion_removes_canonical_membership_from_a_later_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let album = library
            .create_album(CreateAlbum {
                name: "Dropped".into(),
                parent_id: None,
            })
            .unwrap();
        library.connection().unwrap().execute("INSERT INTO assets (id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES ('asset','hash','image','a.png','assets/a.png','thumbnails/a.webp',1,10,20,'2026-09-07T00:00:00Z')",[]).unwrap();
        library
            .patch_asset_albums(AssetAlbumPatch {
                asset_ids: vec!["asset".into()],
                add_album_ids: vec![album.id.clone()],
                remove_album_ids: vec![],
            })
            .unwrap();
        assert_eq!(
            library.album_replica_snapshot().unwrap()["memberships"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        // Emptying the trash purges the managed files and the Asset row, and the
        // relation goes with it through normal ownership.
        library.trash_assets(&["asset".into()]).unwrap();
        library.empty_trash().unwrap();

        assert_eq!(
            library.album_replica_snapshot().unwrap()["memberships"],
            json!([])
        );
    }
}
