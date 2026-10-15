//! `/preview/<asset-id>[/<max>]`: a screen-size copy of a library image for the one-at-a-time
//! review views, where the original (often 20+ MP) decodes too slowly to flip through.
//!
//! The copy is made in memory from the original, kept in a small LRU and never written to the
//! library or to disk. The media protocol hands the handler only the URL path, so `max` is a
//! path segment rather than a query. Anything that cannot be scaled (video is refused by the
//! `/asset/` rules already; GIF/AVIF and undecodable files are not touched) and anything already
//! within `max` is served as the original bytes, so a preview never costs quality it did not
//! have to.
use std::{
    collections::{HashMap, VecDeque},
    io::{Cursor, Read},
    sync::{Mutex, OnceLock},
    time::UNIX_EPOCH,
};

use tauri::http::{
    header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE},
    Response, StatusCode,
};

use crate::library::{error::LibraryError, Library, MediaVariant};

pub(super) const DEFAULT_MAX: u32 = 1600;
const MIN_MAX: u32 = 640;
const MAX_MAX: u32 = 2560;
/// Sized for the card pack warm-up (2026-10-15): five card arts plus the day's cover collage and
/// a few review views must stay resident together until a pack is opened, so the budget is
/// twice the earlier 24 entries / 64 MB (a 1280 px JPEG preview is typically 0.2-1.5 MB).
const CACHE_ENTRIES: usize = 48;
const CACHE_BYTES: usize = 128 * 1024 * 1024;
const JPEG_QUALITY: u8 = 82;
/// Beyond this the decode would take seconds and hundreds of MB; serve the original instead.
const MAX_DECODE_PIXELS: u64 = 150_000_000;
/// The server-side copy is exact for the file's current bytes (its key holds size and mtime);
/// the short WebView lifetime only keeps back-and-forth flipping off the protocol.
const PREVIEW_CACHE_CONTROL: &str = "private, max-age=60";

/// `/preview/<id>` or `/preview/<id>/<max>`: the id as written and the clamped long edge.
pub(super) fn parse(path: &str) -> Option<(String, u32)> {
    let mut segments = path.strip_prefix("/preview/")?.split('/');
    let id = segments.next()?;
    if uuid::Uuid::parse_str(id).is_err() {
        return None;
    }
    let max = match segments.next() {
        None => DEFAULT_MAX,
        Some(value) => {
            if value.is_empty()
                || !value.bytes().all(|byte| byte.is_ascii_digit())
                || value.len() > 6
            {
                return None;
            }
            value.parse::<u32>().ok()?.clamp(MIN_MAX, MAX_MAX)
        }
    };
    segments.next().is_none().then(|| (id.to_owned(), max))
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct Key {
    asset_id: String,
    max: u32,
    length: u64,
    modified_ns: u128,
}

struct Entry {
    bytes: Vec<u8>,
    mime: &'static str,
}

pub(super) struct Lru {
    entries: HashMap<Key, Entry>,
    order: VecDeque<Key>,
    bytes: usize,
    max_entries: usize,
    max_bytes: usize,
}

impl Lru {
    pub(super) fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            max_entries,
            max_bytes,
        }
    }

    fn get(&mut self, key: &Key) -> Option<(Vec<u8>, &'static str)> {
        let entry = self.entries.get(key)?;
        let found = (entry.bytes.clone(), entry.mime);
        self.touch(key);
        Some(found)
    }

    fn insert(&mut self, key: Key, bytes: Vec<u8>, mime: &'static str) {
        self.remove(&key);
        if bytes.len() > self.max_bytes {
            return;
        }
        while self.entries.len() >= self.max_entries
            || bytes.len() > self.max_bytes.saturating_sub(self.bytes)
        {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.bytes -= entry.bytes.len();
            }
        }
        self.bytes += bytes.len();
        self.order.push_back(key.clone());
        self.entries.insert(key, Entry { bytes, mime });
    }

    fn remove(&mut self, key: &Key) {
        if let Some(entry) = self.entries.remove(key) {
            self.bytes -= entry.bytes.len();
        }
        self.order.retain(|candidate| candidate != key);
    }

    fn touch(&mut self, key: &Key) {
        self.order.retain(|candidate| candidate != key);
        self.order.push_back(key.clone());
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

fn shared_cache() -> &'static Mutex<Lru> {
    static CACHE: OnceLock<Mutex<Lru>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Lru::new(CACHE_ENTRIES, CACHE_BYTES)))
}

#[cfg(test)]
thread_local! {
    /// Decodes performed on this thread, so a test can tell a cache hit from a rebuild.
    pub(super) static BUILDS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub(super) enum Made {
    /// Already within the requested edge, or not worth re-encoding: serve the original bytes.
    Original,
    Scaled {
        bytes: Vec<u8>,
        mime: &'static str,
    },
}

/// Downscale `bytes` so its long edge is at most `max`, upright per EXIF orientation.
/// `None` when the file cannot be decoded here (the caller then serves the original).
pub(super) fn make(bytes: &[u8], max: u32) -> Option<Made> {
    use image::ImageDecoder;
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let (width, height) = reader.into_dimensions().ok()?;
    if width.max(height) <= max {
        return Some(Made::Original);
    }
    if u64::from(width) * u64::from(height) > MAX_DECODE_PIXELS {
        return None;
    }
    #[cfg(test)]
    BUILDS.with(|count| count.set(count.get() + 1));
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let orientation = decoder.orientation().ok();
    let mut picture = image::DynamicImage::from_decoder(decoder).ok()?;
    if let Some(orientation) = orientation {
        picture.apply_orientation(orientation);
    }
    // `thumbnail` is a box filter: several times faster than Lanczos on a 6000 px original
    // and sharp enough for a screen-size review copy.
    let small = picture.thumbnail(max, max);
    let mut out = Vec::new();
    if small.color().has_alpha() {
        small
            .write_with_encoder(image::codecs::png::PngEncoder::new_with_quality(
                &mut out,
                image::codecs::png::CompressionType::Fast,
                image::codecs::png::FilterType::Sub,
            ))
            .ok()?;
        return Some(Made::Scaled {
            bytes: out,
            mime: "image/png",
        });
    }
    let rgb = small.into_rgb8();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .ok()?;
    Some(Made::Scaled {
        bytes: out,
        mime: "image/jpeg",
    })
}

fn previewable(mime: &str) -> bool {
    matches!(mime, "image/jpeg" | "image/png" | "image/webp")
}

fn ok(bytes: Vec<u8>, mime: &str, cache_control: Option<&'static str>) -> Response<Vec<u8>> {
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, mime)
        .header(CONTENT_LENGTH, bytes.len().to_string());
    if let Some(cache_control) = cache_control {
        response = response.header(CACHE_CONTROL, cache_control);
    }
    response.body(bytes).expect("preview response is valid")
}

fn status(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("empty response is valid")
}

pub(super) fn response(library: &Library, asset_id: &str, max: u32) -> Response<Vec<u8>> {
    serve(shared_cache(), library, asset_id, max)
}

/// Same access rules as `/asset/<id>`: only a normal or review image Asset resolves; trash,
/// video, unknown ids and missing files answer exactly as the original route does.
pub(super) fn serve(
    cache: &Mutex<Lru>,
    library: &Library,
    asset_id: &str,
    max: u32,
) -> Response<Vec<u8>> {
    let mut media = match library.resolve_media_with_revision(asset_id, MediaVariant::Asset) {
        Ok((media, _)) => media,
        Err(
            LibraryError::AssetNotFound
            | LibraryError::MediaNotFound
            | LibraryError::UnsafeMediaPath
            | LibraryError::MangaRootNotSet
            | LibraryError::MangaSeriesNotFound
            | LibraryError::CollectionSourceRootNotSet
            | LibraryError::CollectionSourcePathNotSet,
        ) => return status(StatusCode::NOT_FOUND),
        Err(_) => return status(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let key = Key {
        asset_id: asset_id.to_owned(),
        max,
        length: media.length,
        modified_ns: media
            .file
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |age| age.as_nanos()),
    };
    if previewable(media.mime) {
        if let Some((bytes, mime)) = cache.lock().ok().and_then(|mut cache| cache.get(&key)) {
            return ok(bytes, mime, Some(PREVIEW_CACHE_CONTROL));
        }
    }
    let mut bytes = Vec::with_capacity(usize::try_from(media.length).unwrap_or(0));
    if media.file.read_to_end(&mut bytes).is_err() {
        return status(StatusCode::INTERNAL_SERVER_ERROR);
    }
    if previewable(media.mime) {
        if let Some(Made::Scaled {
            bytes: scaled,
            mime,
        }) = make(&bytes, max)
        {
            if let Ok(mut cache) = cache.lock() {
                cache.insert(key, scaled.clone(), mime);
            }
            return ok(scaled, mime, Some(PREVIEW_CACHE_CONTROL));
        }
    }
    // Small, undecodable or non-previewable: the original, exactly as `/asset/` serves it.
    ok(bytes, media.mime, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: &str) -> Key {
        Key {
            asset_id: id.into(),
            max: 1600,
            length: 1,
            modified_ns: 1,
        }
    }

    #[test]
    fn parses_only_closed_paths_and_clamps_the_edge() {
        let id = "00000000-0000-4000-8000-000000000001";
        assert_eq!(parse(&format!("/preview/{id}")), Some((id.into(), 1600)));
        assert_eq!(
            parse(&format!("/preview/{id}/2048")),
            Some((id.into(), 2048))
        );
        assert_eq!(parse(&format!("/preview/{id}/100")), Some((id.into(), 640)));
        assert_eq!(
            parse(&format!("/preview/{id}/99999")),
            Some((id.into(), 2560))
        );
        for bad in [
            "/preview/".to_string(),
            "/preview/not-a-uuid".to_string(),
            format!("/preview/{id}/"),
            format!("/preview/{id}/abc"),
            format!("/preview/{id}/-5"),
            format!("/preview/{id}/1600/extra"),
            format!("/preview/{id}/12345678"),
        ] {
            assert_eq!(parse(&bad), None, "{bad}");
        }
    }

    #[test]
    fn lru_drops_the_least_recently_used_over_entry_and_byte_budgets() {
        let mut lru = Lru::new(2, 100);
        lru.insert(key("a"), vec![0; 10], "image/jpeg");
        lru.insert(key("b"), vec![0; 10], "image/jpeg");
        assert!(lru.get(&key("a")).is_some()); // a is now newer than b
        lru.insert(key("c"), vec![0; 10], "image/jpeg");
        assert!(lru.get(&key("b")).is_none());
        assert!(lru.get(&key("a")).is_some() && lru.get(&key("c")).is_some());
        lru.insert(key("d"), vec![0; 95], "image/jpeg");
        assert_eq!(lru.len(), 1);
        lru.insert(key("e"), vec![0; 101], "image/jpeg");
        assert!(
            lru.get(&key("e")).is_none(),
            "an entry over the byte budget is not kept"
        );
    }

    #[test]
    fn shared_budget_keeps_a_card_pack_with_its_cover_and_review_views() {
        let mut lru = Lru::new(CACHE_ENTRIES, CACHE_BYTES);
        for index in 0..(5 + 5 + 20) {
            lru.insert(
                key(&format!("art{index}")),
                vec![0; 2 * 1024 * 1024],
                "image/jpeg",
            );
        }
        assert_eq!(lru.len(), 30);
        assert!(lru.get(&key("art0")).is_some());
    }

    fn noisy_jpeg(width: u32, height: u32) -> Vec<u8> {
        // Cheap deterministic texture so the JPEG is as heavy as a real photograph.
        let mut seed = 0x2545_f491_u32;
        let image = image::RgbImage::from_fn(width, height, |x, y| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = (seed >> 24) as u8 / 8;
            image::Rgb([
                ((x * 255 / width) as u8).saturating_add(noise),
                ((y * 255 / height) as u8).saturating_add(noise),
                (((x + y) * 255 / (width + height)) as u8).saturating_add(noise),
            ])
        });
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92)
            .encode(
                image.as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        out
    }

    #[test]
    fn a_6000_by_4000_original_becomes_a_small_jpeg_and_the_time_is_reported() {
        let original = noisy_jpeg(6000, 4000);
        let started = std::time::Instant::now();
        let Some(Made::Scaled { bytes, mime }) = make(&original, 1600) else {
            panic!("not scaled")
        };
        let elapsed = started.elapsed();
        let (width, height) = image::ImageReader::new(Cursor::new(&bytes))
            .with_guessed_format()
            .unwrap()
            .into_dimensions()
            .unwrap();
        assert_eq!((width, height), (1600, 1067));
        assert_eq!(mime, "image/jpeg");
        assert!(bytes.len() < original.len() / 4);
        // Generous bound: a slow CI box still fails only for a real regression (e.g. Lanczos).
        assert!(elapsed < std::time::Duration::from_secs(5), "{elapsed:?}");
        println!(
            "PREVIEW-MEASURE 6000x4000 jpeg: original {} bytes -> preview {} bytes ({}x{}) in {:?}",
            original.len(),
            bytes.len(),
            width,
            height,
            elapsed
        );
    }

    #[test]
    fn small_and_undecodable_inputs_are_not_re_encoded() {
        let small = noisy_jpeg(800, 600);
        assert!(matches!(make(&small, 1600), Some(Made::Original)));
        assert!(matches!(make(&small, 800), Some(Made::Original)));
        assert!(make(b"not an image", 1600).is_none());
    }

    #[test]
    fn alpha_images_keep_their_transparency() {
        let mut image = image::RgbaImage::from_pixel(3000, 2000, image::Rgba([10, 20, 30, 0]));
        image.put_pixel(1, 1, image::Rgba([200, 0, 0, 255]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let Some(Made::Scaled { mime, bytes }) = make(&png, 1000) else {
            panic!("not scaled")
        };
        assert_eq!(mime, "image/png");
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (1000, 667));
        assert!(decoded.color().has_alpha());
    }
}
