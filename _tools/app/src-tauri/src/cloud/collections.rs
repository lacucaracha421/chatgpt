//! Explicit, one-way publication of committed Collection presentation data.
//! No provider calls, lazy imports or writes to the library. Source previews stage in TEMP.
#[path = "collection_cache.rs"]
mod cache;
use super::publication::{report, Reporter};
use super::client::CloudClient;
use crate::library::{
    collection::{collection_from_row, COLLECTION_SUMMARY_SQL},
    collection_source::{collection_source_root, resolve_collection_dir, source_preview_path, source_volume_images, write_collection_thumbnail},
    credential,
    error::LibraryError,
    models::{CollectionSummary, CollectionVolume},
    Library,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
};

const MAX_COLLECTIONS: usize = 10_000;
const MAX_ARTWORKS: usize = 10_000;
const MAX_VOLUMES: usize = 5_000;
const MAX_FILES: usize = 20_000;
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024 * 1024;
pub(crate) const MAX_METADATA_BYTES: usize = 12 * 1024 * 1024;
const MAX_ORIGINAL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtworkBlob {
    pub sha256: String,
    pub size_bytes: u64,
    pub content_type: String,
    pub object_key: String,
}
#[derive(Debug, Serialize)]
pub(crate) struct ReplicaArtwork {
    id: String,
    kind: String,
    selected: bool,
    thumbnail: Option<ArtworkBlob>,
    original: Option<ArtworkBlob>,
}
#[derive(Debug, Serialize)]
pub(crate) struct ReplicaCollection {
    #[serde(flatten)]
    summary: CollectionSummary,
    volumes: Vec<CollectionVolume>,
    series: Option<serde_json::Value>,
    artworks: Vec<ReplicaArtwork>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionReplica {
    version: u8,
    pub base_revision: Option<String>,
    collections: Vec<ReplicaCollection>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCollectionsPublishResult {
    collections: usize,
    artworks: usize,
    uploaded: usize,
    revision: String,
}
struct LocalBlob {
    descriptor: ArtworkBlob,
    path: PathBuf,
    limit: u64,
}
struct Snapshot {
    replica: CollectionReplica,
    files: BTreeMap<String, LocalBlob>,
}

impl Library {
    pub(crate) fn push_cloud_collections(
        &self,
        progress: Reporter<'_>,
    ) -> Result<CloudCollectionsPublishResult, LibraryError> {
        report(progress, "connecting", 0, None, "items");
        let config = self.cloud_sync_config()?;
        let client = CloudClient::new(
            config
                .api_base_url
                .as_deref()
                .ok_or(LibraryError::InvalidCloudSyncConfig)?,
        )?;
        let token = credential::read_cloud_api_token_os()?;
        // Capture the remote generation before doing expensive local work. A competing
        // publisher must result in a conflict, never silently overwrite its snapshot.
        let base_revision = client.collections_revision(&token)?;
        let snapshot = self.cloud_collections_snapshot(base_revision, progress)?;
        publish_snapshot(&client, &token, snapshot, progress)
    }

    fn cloud_collections_snapshot(
        &self,
        base_revision: Option<String>,
        progress: Reporter<'_>,
    ) -> Result<Snapshot, LibraryError> {
        let root = self
            .root()
            .canonicalize()
            .map_err(|_| LibraryError::InvalidWorkArtwork)?;
        // Independent WAL reader: image preparation must not hold the library mutex.
        let mut connection = rusqlite::Connection::open_with_flags(
            self.root().join("library.sqlite"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        snapshot_from_connection(&root, &mut connection, base_revision, progress)
    }
}

fn publish_snapshot(client: &CloudClient, token: &str, snapshot: Snapshot, progress: Reporter<'_>) -> Result<CloudCollectionsPublishResult, LibraryError> {
        let metadata = serde_json::to_vec(&snapshot.replica)
            .map_err(|_| LibraryError::InvalidCloudResponse)?;
        if metadata.len() > MAX_METADATA_BYTES {
            return Err(LibraryError::InvalidCloudResponse);
        }
        // Bound simultaneous file buffers/PUTs, while retaining the all-artwork-before-
        // metadata barrier. Completed immutable objects are reused after interruption.
        let descriptors:Vec<_>=snapshot.files.values().map(|file|&file.descriptor).collect();
        let missing=client.missing_collection_artworks(&descriptors,token)?;
        let files: Vec<_> = snapshot.files.values().filter(|file|missing.contains(&file.descriptor.sha256)).collect();
        let stopped = std::sync::atomic::AtomicBool::new(false);
        let completed = std::sync::Mutex::new(0u64);
        let total = files.len() as u64;
        report(progress, "uploading", 0, Some(total), "files");
        let uploaded = std::thread::scope(|scope| {
            let workers: Vec<_> = files.chunks(files.len().div_ceil(4).max(1)).map(|chunk| {
                let stopped = &stopped;
                let completed = &completed;
                scope.spawn(move || {
                    let mut uploaded = 0usize;
                    for local in chunk {
                        if stopped.load(std::sync::atomic::Ordering::Relaxed) { break; }
                        match upload_local_blob(client, token, local) {
                            Ok(true) => uploaded += 1,
                            Ok(false) => {},
                            Err(error) => { stopped.store(true, std::sync::atomic::Ordering::Relaxed); return Err(error); }
                        }
                        let mut count = completed.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                        *count += 1;
                        report(progress, "uploading", *count, Some(total), "files");
                    }
                    Ok(uploaded)
                })
            }).collect();
            workers.into_iter().map(|worker| worker.join().unwrap_or(Err(LibraryError::InvalidCloudResponse))).collect::<Result<Vec<_>, _>>()
        })?.into_iter().sum();
        report(progress, "publishing", 0, None, "items");
        let revision = client.publish_collections(&metadata, &token)?;
        Ok(CloudCollectionsPublishResult {
            collections: snapshot.replica.collections.len(),
            artworks: snapshot
                .replica
                .collections
                .iter()
                .map(|c| c.artworks.len())
                .sum(),
            uploaded,
            revision,
        })
}

fn upload_local_blob(client: &CloudClient, token: &str, local: &LocalBlob) -> Result<bool, LibraryError> {
    if local.path.canonicalize().map_err(|_| LibraryError::InvalidWorkArtwork)? != local.path {
        return Err(LibraryError::InvalidWorkArtwork);
    }
    let bytes = read_existing_image(&local.path, local.limit)?.ok_or(LibraryError::InvalidWorkArtwork)?;
    if blob_for(&bytes)? != local.descriptor { return Err(LibraryError::InvalidWorkArtwork); }
    client.upload_collection_artwork(&local.descriptor, &bytes, token)
}

fn snapshot_from_connection(root: &Path, connection: &mut rusqlite::Connection, base_revision: Option<String>, progress: Reporter<'_>) -> Result<Snapshot, LibraryError> {
        let transaction = connection.transaction()?;
        let source_root = collection_source_root(&transaction, root)?;
        let mut files = BTreeMap::new();
        let mut total_bytes = 0;
        let mut collections = Vec::new();
        let mut metadata_bytes = 128usize;
        // AV is local Collection data; the current Mobile replica supports three types.
        // Filter before collecting any artwork paths, while retaining the complete supported snapshot.
        let sql = format!("{COLLECTION_SUMMARY_SQL} WHERE (collection.legacy_kind IS NULL OR collection.legacy_kind <> 'gacha') AND collection.type IN ('game','manga','movie') ORDER BY collection.updated_at DESC, collection.id DESC LIMIT {}", MAX_COLLECTIONS + 1);
        let summaries = transaction
            .prepare(&sql)?
            .query_map([], collection_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        if summaries.len() > MAX_COLLECTIONS {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let total = summaries.len() as u64;
        report(progress, "preparing", 0, Some(total), "items");
        for mut summary in summaries {
            let source_path = summary.source_path.take();
            let mut volumes = committed_volumes(&transaction, &summary.id)?;
            let mut statement = transaction.prepare("SELECT id, kind, selected, relative_path FROM collection_work_artworks WHERE collection_id = ?1 ORDER BY CASE kind WHEN 'cover' THEN 0 WHEN 'hero' THEN 1 ELSE 2 END, selected DESC, created_at, id LIMIT 10001")?;
            let rows = statement
                .query_map([&summary.id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, bool>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            if rows.len() > MAX_ARTWORKS {
                return Err(LibraryError::InvalidCloudResponse);
            }
            let mut artworks = Vec::new();
            for (id, kind, selected, relative_path) in rows {
                let original = add_blob(
                    &root,
                    &relative_path,
                    MAX_ORIGINAL_BYTES,
                    &mut files,
                    &mut total_bytes,
                )?;
                let thumbnail = add_blob(
                    &root,
                    &format!("work-artwork-thumbnails/{}/{id}.webp", summary.id),
                    MAX_THUMBNAIL_BYTES,
                    &mut files,
                    &mut total_bytes,
                )?;
                artworks.push(ReplicaArtwork {
                    id,
                    kind,
                    selected,
                    original,
                    thumbnail,
                });
            }
            if let (Some(configured), Some(source)) = (source_root.as_deref(), source_path.as_deref()) {
                supplement_source_covers(root, configured, source, &mut summary, &mut volumes, &mut artworks, &mut files, &mut total_bytes)?;
            }
            let series = committed_series(&transaction, &summary.id)?;
            let collection = ReplicaCollection {
                series,
                summary,
                volumes,
                artworks,
            };
            metadata_bytes += serde_json::to_vec(&collection)
                .map_err(|_| LibraryError::InvalidCloudResponse)?
                .len()
                + 1;
            if metadata_bytes > MAX_METADATA_BYTES {
                return Err(LibraryError::InvalidCloudResponse);
            }
            collections.push(collection);
            report(progress, "preparing", collections.len() as u64, Some(total), "items");
        }
        // Keep the single committed SQLite view during extraction, release it before HTTP.
        transaction.commit()?;
        // The read transaction already fixes the committed metadata snapshot. An
        // unrelated PC write after it starts must not invalidate this publication.
        // Artwork bytes are independently hash-checked again immediately before upload.
        Ok(Snapshot {
            replica: CollectionReplica {
                version: 1,
                base_revision,
                collections,
            },
            files,
        })
}

fn available_artwork(artworks: &[ReplicaArtwork], id: Option<&str>) -> bool {
    id.is_some_and(|id| artworks.iter().any(|a| a.id == id && (a.thumbnail.is_some() || a.original.is_some())))
}

#[allow(clippy::too_many_arguments)]
fn supplement_source_covers(root: &Path, configured: &str, source: &str,
    summary: &mut CollectionSummary, volumes: &mut Vec<CollectionVolume>, artworks: &mut Vec<ReplicaArtwork>,
    files: &mut BTreeMap<String, LocalBlob>, total: &mut u64) -> Result<(), LibraryError> {
    let directory = resolve_collection_dir(configured, source);
    if !directory.is_dir() { return Ok(()); }
    let directory = directory.canonicalize().map_err(|_| LibraryError::InvalidWorkArtwork)?;
    if !directory.starts_with(root) { return Err(LibraryError::InvalidWorkArtwork); }
    if summary.cover_asset_id.is_none() && !available_artwork(artworks, summary.selected_work_artwork_id.as_deref()) {
        match source_preview_path(&directory) {
            Ok(path) => { summary.selected_work_artwork_id = Some(source_artwork(root, &path, &summary.id, artworks, files, total)?); }
            Err(LibraryError::MediaNotFound) => {},
            Err(error) => return Err(error),
        }
    }
    if !matches!(summary.collection_type, crate::library::models::CollectionType::Manga) { return Ok(()); }
    for (number, edition, path) in source_volume_images(&directory)? {
        let existing = volumes.iter().position(|v| v.volume_number == number && v.edition_index == edition);
        if existing.is_some_and(|i| available_artwork(artworks, volumes[i].cover_artwork_id.as_deref())) { continue; }
        let artwork_id = source_artwork(root, &path, &summary.id, artworks, files, total)?;
        if let Some(index) = existing { volumes[index].cover_artwork_id = Some(artwork_id); }
        else {
            if volumes.len() >= MAX_VOLUMES { return Err(LibraryError::InvalidCloudResponse); }
            volumes.push(CollectionVolume { id: source_id(&format!("volume/{}/{number}/{edition}", summary.id)),
                volume_number: number, edition_index: edition, display_label: if edition == 0 {format!("{number}권")} else {format!("{number}.{edition}권")},
                cover_artwork_id: Some(artwork_id), local_release_date: None, isbn13: None, release_status: None });
        }
    }
    Ok(())
}

fn source_id(identity: &str) -> String {
    format!("source-{}", Sha256::digest(identity.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>())
}

fn source_artwork(root: &Path, path: &Path, collection: &str,
    artworks: &mut Vec<ReplicaArtwork>, files: &mut BTreeMap<String, LocalBlob>, total: &mut u64) -> Result<String, LibraryError> {
    let path = path.canonicalize().map_err(|_| LibraryError::InvalidWorkArtwork)?;
    let relative = path.strip_prefix(root).map_err(|_| LibraryError::InvalidWorkArtwork)?.to_str().ok_or(LibraryError::InvalidWorkArtwork)?.replace('\\', "/");
    let id = source_id(&format!("artwork/{collection}/{relative}"));
    if artworks.iter().any(|a| a.id == id) { return Ok(id); }
    if artworks.len() >= MAX_ARTWORKS { return Err(LibraryError::InvalidCloudResponse); }
    let original = add_blob(root, &relative, MAX_ORIGINAL_BYTES, files, total)?.ok_or(LibraryError::InvalidWorkArtwork)?;
    let thumbnail_name = format!(".cache/mobile-collections/thumbnails/{}.webp", original.sha256);
    let thumbnail_path = root.join(&thumbnail_name);
    let _thumbnail_write=cache::THUMBNAIL_WRITE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !thumbnail_path.exists() {
        let bytes = read_existing_image(&path, MAX_ORIGINAL_BYTES)?.ok_or(LibraryError::InvalidWorkArtwork)?;
        if blob_for(&bytes)? != original { return Err(LibraryError::InvalidWorkArtwork); }
        let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().map_err(|_| LibraryError::InvalidWorkArtwork)?;
        let mut limits = image::Limits::default(); limits.max_alloc = Some(128 * 1024 * 1024);
        limits.max_image_width = Some(16384); limits.max_image_height = Some(16384); reader.limits(limits);
        let image = reader.decode().map_err(|_| LibraryError::InvalidWorkArtwork)?;
        write_collection_thumbnail(&image, &thumbnail_path)?;
    }
    let thumbnail = add_blob(root, &thumbnail_name, MAX_THUMBNAIL_BYTES, files, total)?;
    artworks.push(ReplicaArtwork {id: id.clone(), kind: "cover".into(), selected: false, original: Some(original), thumbnail});
    Ok(id)
}

fn committed_volumes(
    connection: &rusqlite::Connection,
    collection_id: &str,
) -> Result<Vec<CollectionVolume>, LibraryError> {
    let mut statement = connection.prepare("SELECT volume.id, volume.volume_number, volume.edition_index, volume.cover_artwork_id, source.publication_date, source.isbn13
        FROM collection_volumes AS volume LEFT JOIN collection_volume_sources AS source
        ON source.collection_id = volume.collection_id AND source.volume_number = volume.volume_number
        AND source.provider = (SELECT candidate.provider FROM collection_volume_sources AS candidate WHERE candidate.collection_id = volume.collection_id AND candidate.volume_number = volume.volume_number AND candidate.provider IN ('kakao', 'aladin') ORDER BY CASE candidate.provider WHEN 'kakao' THEN 0 ELSE 1 END LIMIT 1)
        WHERE volume.collection_id = ?1 ORDER BY volume.edition_index, volume.sort_order, volume.volume_number, volume.id LIMIT 5001")?;
    let today = chrono::Utc::now().date_naive();
    let volumes = statement
        .query_map([collection_id], |row| {
            let volume_number: i64 = row.get(1)?;
            let edition_index: u8 = row.get(2)?;
            let local_release_date: Option<String> = row.get(4)?;
            let release_status = local_release_date
                .as_deref()
                .and_then(|date| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
                .map(|date| if date > today { "upcoming" } else { "released" }.to_owned());
            Ok(CollectionVolume {
                id: row.get(0)?,
                volume_number,
                edition_index,
                display_label: if edition_index == 0 {
                    volume_number.to_string()
                } else {
                    format!("{volume_number}.{edition_index}")
                },
                cover_artwork_id: row.get(3)?,
                local_release_date,
                isbn13: row.get(5)?,
                release_status,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if volumes.len() > MAX_VOLUMES {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(volumes)
}

fn add_blob(
    root: &Path,
    relative: &str,
    limit: u64,
    files: &mut BTreeMap<String, LocalBlob>,
    total: &mut u64,
) -> Result<Option<ArtworkBlob>, LibraryError> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(LibraryError::InvalidWorkArtwork);
    }
    let path = match root.join(relative).canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(LibraryError::InvalidWorkArtwork),
    };
    if !path.starts_with(root) {
        return Err(LibraryError::InvalidWorkArtwork);
    }
    let Some(descriptor) = cache::descriptor(root, &path, limit)? else { return Ok(None); };
    if !files.contains_key(&descriptor.sha256) {
        *total += descriptor.size_bytes;
        if files.len() >= MAX_FILES || *total > MAX_TOTAL_BYTES {
            return Err(LibraryError::InvalidWorkArtwork);
        }
        files.insert(
            descriptor.sha256.clone(),
            LocalBlob {
                descriptor: descriptor.clone(),
                path,
                limit,
            },
        );
    }
    Ok(Some(descriptor))
}

fn read_existing_image(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, LibraryError> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(LibraryError::InvalidWorkArtwork),
    };
    let before = file
        .metadata()
        .map_err(|_| LibraryError::InvalidWorkArtwork)?;
    if !before.is_file() || before.len() > limit {
        return Err(LibraryError::InvalidWorkArtwork);
    }
    if before.len() == 0 {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| LibraryError::InvalidWorkArtwork)?;
    let after = file
        .metadata()
        .map_err(|_| LibraryError::InvalidWorkArtwork)?;
    if before.len() != bytes.len() as u64
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err(LibraryError::InvalidWorkArtwork);
    }
    Ok(Some(bytes))
}

fn blob_for(bytes: &[u8]) -> Result<ArtworkBlob, LibraryError> {
    let content_type =
        match image::guess_format(bytes).map_err(|_| LibraryError::InvalidWorkArtwork)? {
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::WebP => "image/webp",
            image::ImageFormat::Gif => "image/gif",
            _ => return Err(LibraryError::InvalidWorkArtwork),
        };
    let sha256 = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(ArtworkBlob {
        object_key: format!("work-artwork/mobile/{sha256}"),
        sha256,
        size_bytes: bytes.len() as u64,
        content_type: content_type.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tiny_http::{Response, Server};

    #[test]
    fn snapshot_preparation_does_not_acquire_library_mutex() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let _guard = library.connection().unwrap();
        let events = std::sync::Mutex::new(Vec::new());
        let snapshot = library.cloud_collections_snapshot(None, &|event| events.lock().unwrap().push(event)).unwrap();
        assert!(snapshot.replica.collections.is_empty());
        assert_eq!(events.lock().unwrap()[0].phase, "preparing");
    }

    // Explicit operational entry point: never opens Library or performs startup writes.
    #[test]
    #[ignore = "Publishes cloud metadata and artwork; requires explicit operator approval"]
    fn publish_approved_readonly_collection_snapshot() {
        assert_eq!(std::env::var("LAKOMICS_COLLECTION_PUBLISH_APPROVED").as_deref(), Ok("yes"));
        let root = PathBuf::from(std::env::var("LAKOMICS_COLLECTION_SOURCE").unwrap()).canonicalize().unwrap();
        let client = CloudClient::new(&std::env::var("LAKOMICS_COLLECTION_ENDPOINT").unwrap()).unwrap();
        let token = credential::read_cloud_api_token_os().unwrap();
        let revision = client.collections_revision(&token).unwrap();
        let mut connection = rusqlite::Connection::open_with_flags(root.join("library.sqlite"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let snapshot = snapshot_from_connection(&root, &mut connection, revision, &|_| {}).unwrap();
        println!("Prepared {} collections and {} unique artwork files; {} cover-ready works; {} volumes", snapshot.replica.collections.len(), snapshot.files.len(), snapshot.replica.collections.iter().filter(|c| available_artwork(&c.artworks, c.summary.selected_work_artwork_id.as_deref()) || c.summary.cover_asset_id.is_some()).count(), snapshot.replica.collections.iter().map(|c|c.volumes.len()).sum::<usize>());
        let result = publish_snapshot(&client, &token, snapshot, &|_| {}).unwrap();
        println!("Collection publication: {}", serde_json::to_string(&result).unwrap());
    }

    #[test]
    fn source_folder_covers_and_editions_publish_without_library_writes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let source = temp.path().join("collection-sources/book");
        let game = source.join("games/game");
        let manga = source.join("comics/manga");
        std::fs::create_dir_all(game.join("covers")).unwrap();
        std::fs::create_dir_all(manga.join("covers")).unwrap();
        for path in [game.join("thumbnail.png"),game.join("covers/preferred.png"),manga.join("covers/vol_2_cover.png"),manga.join("covers/vol_1_cover.png"),manga.join("covers/vol_1.1_cover.png")] {
            image::RgbaImage::from_pixel(480,720,image::Rgba([120,100,80,255])).save(path).unwrap();
        }
        std::fs::write(game.join("info.txt"), "Cover: covers/preferred.png").unwrap();
        let connection = library.connection().unwrap();
        connection.execute("UPDATE library_settings SET collection_source_root=?1 WHERE singleton=1", [source.to_str().unwrap()]).unwrap();
        connection.execute_batch("INSERT INTO collections(id,name,type,source_path,created_at,updated_at) VALUES ('g','Game','game','game','2026','2026'),('m','Manga','manga','manga','2026','2026'); INSERT INTO collection_volumes(id,collection_id,volume_number,edition_index,sort_order,created_at,updated_at) VALUES ('retained-volume','m',1,0,1,'2026','2026');").unwrap();
        drop(connection);
        let observer = rusqlite::Connection::open_with_flags(temp.path().join("library.sqlite"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let before: i64 = observer.query_row("PRAGMA data_version", [], |r|r.get(0)).unwrap();
        let first = library.cloud_collections_snapshot(None, &|_| {}).unwrap();
        let second = library.cloud_collections_snapshot(None, &|_| {}).unwrap();
        assert_eq!(serde_json::to_value(&first.replica).unwrap(),serde_json::to_value(&second.replica).unwrap());
        let game = first.replica.collections.iter().find(|c|c.summary.id=="g").unwrap();
        assert_eq!(game.summary.selected_work_artwork_id.as_deref(),Some(source_id("artwork/g/collection-sources/book/games/game/covers/preferred.png").as_str()));
        let manga = first.replica.collections.iter().find(|c|c.summary.id=="m").unwrap();
        assert_eq!(manga.volumes.len(),3);
        assert_eq!(manga.volumes.iter().find(|v|v.volume_number==1&&v.edition_index==0).unwrap().id,"retained-volume");
        assert!(manga.volumes.iter().all(|v|available_artwork(&manga.artworks,v.cover_artwork_id.as_deref())));
        for collection in &first.replica.collections {
            assert!(collection.summary.source_path.is_none());
            for art in &collection.artworks {
                let blob=art.thumbnail.as_ref().unwrap();
                let image=image::open(&first.files[&blob.sha256].path).unwrap();
                assert!(image.width()<=360 && image.height()<=360);
            }
        }
        assert_eq!(observer.query_row::<i64,_,_>("PRAGMA data_version",[],|r|r.get(0)).unwrap(),before);
        assert_eq!(observer.query_row::<i64,_,_>("SELECT count(*) FROM collection_work_artworks",[],|r|r.get(0)).unwrap(),0);
        assert_eq!(observer.query_row::<i64,_,_>("SELECT count(*) FROM collection_volumes",[],|r|r.get(0)).unwrap(),1);
        assert_eq!(observer.query_row::<i64,_,_>("SELECT count(*) FROM assets",[],|r|r.get(0)).unwrap(),0);
    }

    #[test]
    fn source_projection_rejects_a_folder_outside_the_library() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        std::fs::create_dir_all(outside.path().join("game")).unwrap();
        let connection = library.connection().unwrap();
        connection.execute("UPDATE library_settings SET collection_source_root=?1 WHERE singleton=1",[outside.path().to_str().unwrap()]).unwrap();
        connection.execute_batch("INSERT INTO collections(id,name,type,source_path,created_at,updated_at) VALUES ('g','Game','game','game','2026','2026')").unwrap();
        drop(connection);
        assert!(matches!(library.cloud_collections_snapshot(None, &|_| {}),Err(LibraryError::InvalidWorkArtwork)));
    }

    #[test]
    fn committed_snapshot_preserves_volume_ids_order_and_missing_artwork_without_imports() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let connection = library.connection().unwrap();
        connection.execute_batch("INSERT INTO collections (id,name,type,source_path,showcase,showcase_order,created_at,updated_at) VALUES ('collection-one','Manga','manga','C:\\private\\provider',1,7,'2026-01-01','2026-01-01');
            INSERT INTO collection_work_artworks (id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES ('cover-one','collection-one','local','one','cover','work-artwork/missing.png','image/png',1,1,1,'2026-01-01','2026-01-01');
            INSERT INTO collection_volumes (id,collection_id,volume_number,edition_index,sort_order,cover_artwork_id,created_at,updated_at) VALUES ('volume-ten','collection-one',10,0,10,'cover-one','2026-01-01','2026-01-01'),('volume-two','collection-one',2,0,2,NULL,'2026-01-01','2026-01-01'),('edition-two','collection-one',2,1,2,NULL,'2026-01-01','2026-01-01');").unwrap();
        drop(connection);
        let observer = rusqlite::Connection::open_with_flags(
            temp.path().join("library.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let before: i64 = observer
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .unwrap();
        let snapshot = library
            .cloud_collections_snapshot(Some("old-revision".into()), &|_| {})
            .unwrap();
        let value = serde_json::to_value(&snapshot.replica).unwrap();
        let item = &value["collections"][0];
        assert_eq!(value["baseRevision"], "old-revision");
        assert_eq!(item["id"], "collection-one");
        assert_eq!(item["showcaseOrder"], 7);
        assert!(item.get("sourcePath").is_none());
        assert_eq!(item["volumes"][0]["id"], "volume-two");
        assert_eq!(item["volumes"][1]["id"], "volume-ten");
        assert_eq!(item["volumes"][2]["id"], "edition-two");
        assert_eq!(item["volumes"][2]["displayLabel"], "2.1");
        assert_eq!(item["artworks"][0]["id"], "cover-one");
        assert!(item["artworks"][0]["original"].is_null());
        assert!(snapshot.files.is_empty());
        let after: i64 = observer
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);
        assert!(!temp
            .path()
            .join("work-artwork-thumbnails/collection-one")
            .exists());
    }

    #[test]
    fn av_is_excluded_before_artwork_loading_without_dropping_supported_types() {
        let temp = tempfile::tempdir().unwrap();
        let library = crate::library::Library::open(temp.path()).unwrap();
        let mut connection = library.connection().unwrap();
        for (id, kind) in [("g","game"),("m","manga"),("v","movie"),("a","av")] {
            connection.execute("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES(?1,?1,?2,'2026','2026')",rusqlite::params![id,kind]).unwrap();
        }
        connection.execute("INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES('av-front','a','local-manual','cover/hash','cover','../outside-invalid.png','image/png',10,20,1,'2026','2026')",[]).unwrap();
        let snapshot = snapshot_from_connection(temp.path(), &mut connection, None, &|_| {}).unwrap();
        let ids: std::collections::BTreeSet<_> = snapshot.replica.collections.iter().map(|item|item.summary.id.as_str()).collect();
        assert_eq!(ids, ["g","m","v"].into_iter().collect());
        assert!(snapshot.files.is_empty());
    }

    #[test]
    fn artwork_content_address_deduplicates_and_rejects_unsafe_or_oversized_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        std::fs::write(root.join("one.png"), bytes).unwrap();
        std::fs::write(root.join("two.png"), bytes).unwrap();
        std::fs::write(root.join("empty.png"), []).unwrap();
        let mut files = BTreeMap::new();
        let mut total = 0;
        let first = add_blob(&root, "one.png", 1024, &mut files, &mut total)
            .unwrap()
            .unwrap();
        let second = add_blob(&root, "two.png", 1024, &mut files, &mut total)
            .unwrap()
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(files.len(), 1);
        assert_eq!(total, bytes.len() as u64);
        assert_eq!(
            first.object_key,
            format!("work-artwork/mobile/{}", first.sha256)
        );
        assert!(add_blob(&root, "../outside.png", 1024, &mut files, &mut total).is_err());
        assert!(add_blob(&root, "one.png", 2, &mut files, &mut total).is_err());
        assert!(add_blob(&root, "empty.png", 1024, &mut files, &mut total)
            .unwrap()
            .is_none());
        std::fs::write(root.join("one.png"), b"\x89PNG\r\n\x1a\nchanged").unwrap();
        assert_ne!(
            blob_for(
                &read_existing_image(&root.join("one.png"), 1024)
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            first
        );
    }

    #[test]
    fn publication_waits_for_all_artwork_with_at_most_four_transfers() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let mut files = BTreeMap::new();
        let mut total = 0;
        for index in 0..8 {
            let name = format!("{index}.png");
            std::fs::write(root.join(&name), [b"\x89PNG\r\n\x1a\n".as_slice(), &[index as u8]].concat()).unwrap();
            add_blob(&root, &name, MAX_ORIGINAL_BYTES, &mut files, &mut total).unwrap();
        }
        let server = Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
        let worker = std::thread::spawn(move || {
            let check=server.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap();
            assert_eq!(check.url(),"/v1/collections/artworks/check");check.respond(Response::empty(404)).unwrap();
            for _ in 0..2 {
                let mut pending = Vec::new();
                for _ in 0..4 {
                    let mut request = server.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap();
                    assert_eq!(request.url(), "/v1/collections/artworks/prepare");
                    let body: serde_json::Value = serde_json::from_reader(request.as_reader()).unwrap();
                    pending.push((request, body));
                }
                assert!(server.recv_timeout(std::time::Duration::from_millis(100)).unwrap().is_none());
                for (request, body) in pending {
                    request.respond(Response::from_string(json!({"objectKey":format!("work-artwork/mobile/{}",body["sha256"].as_str().unwrap()),"uploadUrl":null,"requiredHeaders":{}}).to_string())).unwrap();
                }
            }
            let request = server.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap();
            assert_eq!(request.url(), "/v1/collections/replica");
            request.respond(Response::from_string(json!({"revision":"published"}).to_string())).unwrap();
        });
        let snapshot = Snapshot { files, replica: CollectionReplica {version:1,base_revision:None,collections:vec![]} };
        let events = std::sync::Mutex::new(Vec::new());
        assert_eq!(publish_snapshot(&client, "test-token", snapshot, &|event| events.lock().unwrap().push(event)).unwrap().revision, "published");
        let events = events.into_inner().unwrap();
        let counts: Vec<_> = events.iter().filter(|event| event.phase == "uploading").map(|event| event.completed).collect();
        assert_eq!(counts, (0..=8).collect::<Vec<_>>());
        assert_eq!(events.last().unwrap().phase, "publishing");
        worker.join().unwrap();
    }

    #[test]
    fn confirmed_artwork_skips_file_reads_and_individual_requests() {
        let server=Server::http("127.0.0.1:0").unwrap();
        let client=CloudClient::new(&format!("http://{}",server.server_addr())).unwrap();
        let blob=blob_for(b"\x89PNG\r\n\x1a\nknown").unwrap();
        let files=BTreeMap::from([(blob.sha256.clone(),LocalBlob{descriptor:blob,path:PathBuf::from("does-not-exist.png"),limit:100})]);
        let worker=std::thread::spawn(move || {
            let mut request=server.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap();
            assert_eq!(request.url(),"/v1/collections/artworks/check");
            let body:serde_json::Value=serde_json::from_reader(request.as_reader()).unwrap();assert_eq!(body["items"].as_array().unwrap().len(),1);
            request.respond(Response::from_string(r#"{"missing":[]}"#)).unwrap();
            let request=server.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap();
            assert_eq!(request.url(),"/v1/collections/replica");
            request.respond(Response::from_string(r#"{"revision":"published"}"#)).unwrap();
        });
        let snapshot=Snapshot{files,replica:CollectionReplica{version:1,base_revision:None,collections:vec![]}};
        assert_eq!(publish_snapshot(&client,"test-token",snapshot,&|_|{}).unwrap().uploaded,0);
        worker.join().unwrap();
    }

    #[test]
    fn publisher_reuses_existing_blob_and_surfaces_stale_revision() {
        let server = Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        let blob = blob_for(bytes).unwrap();
        let expected = blob.clone();
        let thread = std::thread::spawn(move || {
            let request = server
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert_eq!(request.url(), "/v1/collections?limit=1");
            request
                .respond(Response::from_string(
                    json!({"revision":"before"}).to_string(),
                ))
                .unwrap();
            let mut request = server
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert_eq!(request.url(), "/v1/collections/artworks/prepare");
            let body: serde_json::Value = serde_json::from_reader(request.as_reader()).unwrap();
            assert_eq!(
                body,
                json!({"sha256":expected.sha256,"sizeBytes":expected.size_bytes,"contentType":expected.content_type})
            );
            request
                .respond(Response::from_string(
                    json!({"objectKey":expected.object_key,"uploadUrl":null,"requiredHeaders":{}})
                        .to_string(),
                ))
                .unwrap();
            let request = server
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert_eq!(request.url(), "/v1/collections/replica");
            request.respond(Response::empty(409)).unwrap();
        });
        assert_eq!(
            client
                .collections_revision("test-token")
                .unwrap()
                .as_deref(),
            Some("before")
        );
        assert!(!client
            .upload_collection_artwork(&blob, bytes, "test-token")
            .unwrap());
        assert!(matches!(
            client.publish_collections(b"{}", "test-token"),
            Err(LibraryError::CloudObjectKeyConflict)
        ));
        thread.join().unwrap();
    }

    #[test]
    fn publisher_rejects_wrong_hash_plain_http_and_authorization_upload_headers() {
        let server = Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        let blob = blob_for(bytes).unwrap();
        let key = blob.object_key.clone();
        let thread = std::thread::spawn(move || {
            for response in [
                json!({"objectKey":"work-artwork/mobile/wrong","uploadUrl":null,"requiredHeaders":{}}),
                json!({"objectKey":key,"uploadUrl":"http://storage.example.test/upload","requiredHeaders":{}}),
                json!({"objectKey":key,"uploadUrl":"https://storage.example.test/upload","requiredHeaders":{"Authorization":"Bearer leaked"}}),
            ] {
                let request = server
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap()
                    .unwrap();
                assert_eq!(request.url(), "/v1/collections/artworks/prepare");
                request
                    .respond(Response::from_string(response.to_string()))
                    .unwrap();
            }
        });
        for _ in 0..3 {
            assert!(matches!(
                client.upload_collection_artwork(&blob, bytes, "test-token"),
                Err(LibraryError::InvalidCloudResponse)
            ));
        }
        thread.join().unwrap();
    }
}

// Only committed presentation metadata crosses the boundary, never provider URLs or credentials.
fn committed_series(db: &rusqlite::Connection, id: &str) -> Result<Option<serde_json::Value>, LibraryError> {
    use rusqlite::OptionalExtension;
    let raw: Option<String> = db.query_row("SELECT provider_data_json FROM collection_external_bindings WHERE collection_id=?1 AND provider='tmdb' AND external_id LIKE 'tv:%' LIMIT 1", [id], |r| r.get(0)).optional()?;
    let Some(raw) = raw else { return Ok(None) };
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
    let Some(series) = value.get("series").filter(|s| s.is_object()) else { return Ok(None) };
    let seasons = series.get("seasons").and_then(|s| s.as_array()).into_iter().flatten().map(|s| {
        let episodes: Vec<_> = s.get("episodes").and_then(|v| v.as_array()).into_iter().flatten().map(|e| serde_json::json!({"id":e["id"],"episodeNumber":e["episodeNumber"],"name":e["name"],"airDate":e["airDate"],"runtimeMinutes":e["runtimeMinutes"]})).collect();
        serde_json::json!({"id":s["id"],"seasonNumber":s["seasonNumber"],"name":s["name"],"airDate":s["airDate"],"posterArtworkId":s["posterArtworkId"],"episodes":episodes})
    }).collect::<Vec<_>>();
    Ok(Some(serde_json::json!({"status":series["status"],"cast":series.get("cast").cloned().unwrap_or(serde_json::json!([])),"seasons":seasons})))
}

#[cfg(test)]
mod series_projection_tests {
    #[test]
    fn committed_tv_metadata_omits_provider_urls_and_overview() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE collection_external_bindings(collection_id TEXT,provider TEXT,external_id TEXT,provider_data_json TEXT)").unwrap();
        let data = serde_json::json!({"series":{"status":"Ended","cast":["Actor"],"seasons":[{"id":1,"seasonNumber":1,"name":"Season 1","airDate":"2024-01-01","posterArtworkId":"poster","posterPath":"/private-provider-path","overview":"Imported overview","episodes":[{"id":2,"episodeNumber":1,"name":"Episode","airDate":null,"runtimeMinutes":24,"overview":"Imported episode overview"}]}]}});
        db.execute("INSERT INTO collection_external_bindings VALUES('work','tmdb','tv:1',?1)",[data.to_string()]).unwrap();
        let result = super::committed_series(&db,"work").unwrap().unwrap();
        assert_eq!(result["seasons"][0]["posterArtworkId"], "poster");
        assert_eq!(result["seasons"][0]["episodes"][0]["runtimeMinutes"],24);
        assert!(!result.to_string().contains("overview"));
        assert!(!result.to_string().contains("private-provider"));
    }
}
