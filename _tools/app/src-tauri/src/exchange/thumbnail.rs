//! Small JPEG thumbnails of exchanged images for the 전송 timeline, made on this PC from
//! the sent original or the saved copy and cached in app data (never from the server).

use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

pub(super) const FOLDER: &str = "exchange-thumbs";
const EDGE: u32 = 256;
const MAX_FILES: usize = 500;
const IMAGE_EXTENSIONS: [&str; 5] = ["jpg", "jpeg", "png", "webp", "gif"];

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn cache_path(dir: &Path, transfer_id: &str) -> Option<PathBuf> {
    uuid::Uuid::parse_str(transfer_id)
        .ok()
        .map(|id| dir.join(format!("{}.jpg", id.hyphenated())))
}

/// Decode `source` (upright per its EXIF orientation) into a JPEG no larger than `EDGE`.
fn encode(source: &Path) -> Option<Vec<u8>> {
    use image::ImageDecoder;
    let reader = image::ImageReader::open(source)
        .ok()?
        .with_guessed_format()
        .ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let orientation = decoder.orientation().ok();
    let mut picture = image::DynamicImage::from_decoder(decoder).ok()?;
    if let Some(orientation) = orientation {
        picture.apply_orientation(orientation);
    }
    let small = picture.thumbnail(EDGE, EDGE).into_rgb8();
    let mut out = Cursor::new(Vec::new());
    small.write_to(&mut out, image::ImageFormat::Jpeg).ok()?;
    Some(out.into_inner())
}

fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    if files.len() <= MAX_FILES {
        return;
    }
    files.sort();
    for (_, path) in files.iter().take(files.len() - MAX_FILES) {
        let _ = fs::remove_file(path);
    }
}

/// The cached thumbnail, made from `source` when missing. `None` for non-images.
fn thumbnail(dir: Option<&Path>, transfer_id: &str, source: Option<&Path>) -> Option<Vec<u8>> {
    let cached = dir.and_then(|dir| cache_path(dir, transfer_id));
    if let Some(bytes) = cached.as_ref().and_then(|path| fs::read(path).ok()) {
        return Some(bytes);
    }
    let source = source.filter(|path| is_image(path))?;
    let bytes = encode(source)?;
    if let (Some(dir), Some(path)) = (dir, cached) {
        if fs::create_dir_all(dir).is_ok() && fs::write(&path, &bytes).is_ok() {
            prune(dir);
        }
    }
    Some(bytes)
}

/// Keep a finished send's thumbnail: its original is no longer tracked afterwards.
pub(super) fn cache_later(dir: Option<PathBuf>, transfer_id: &str, source: PathBuf) {
    let Some(dir) = dir else { return };
    if !is_image(&source) || cache_path(&dir, transfer_id).is_none_or(|path| path.is_file()) {
        return;
    }
    let transfer_id = transfer_id.to_owned();
    let _ = std::thread::Builder::new()
        .name("exchange-thumbnail".into())
        .spawn(move || {
            thumbnail(Some(&dir), &transfer_id, Some(&source));
        });
}

/// JPEG bytes of a sent or received image's thumbnail; an empty body when there is none.
pub(super) async fn response(transfer_id: String) -> tauri::ipc::Response {
    let (dir, source) = {
        let state = super::lock();
        let job = state
            .jobs
            .iter()
            .find(|job| job.stored.transfer_id == transfer_id && job.stored.folder.is_none())
            .map(|job| job.stored.path.clone());
        let received = || {
            state
                .stored
                .ledger(&transfer_id)
                .filter(|row| !row.publishing)
                .map(|row| row.path.clone())
        };
        (state.thumbs.clone(), job.or_else(received))
    };
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        thumbnail(dir.as_deref(), &transfer_id, source.as_deref())
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnails_are_made_once_and_kept() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("photo.png");
        image::RgbImage::from_pixel(900, 600, image::Rgb([200, 120, 40]))
            .save(&source)
            .unwrap();
        let cache = root.path().join(FOLDER);
        let id = "0b7c8f4e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";
        let bytes = thumbnail(Some(&cache), id, Some(&source)).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (256, 171));
        // The original may move or vanish after the send; the cached copy remains.
        fs::remove_file(&source).unwrap();
        assert_eq!(thumbnail(Some(&cache), id, None).unwrap(), bytes);
    }

    #[test]
    fn non_images_and_bad_ids_have_no_thumbnail() {
        let root = tempfile::tempdir().unwrap();
        let text = root.path().join("notes.txt");
        fs::write(&text, "hello").unwrap();
        let cache = root.path().join(FOLDER);
        assert!(thumbnail(
            Some(&cache),
            "0b7c8f4e-1d2a-4c3b-9e8f-7a6b5c4d3e2f",
            Some(&text)
        )
        .is_none());
        assert!(cache_path(&cache, "../escape").is_none());
    }
}
