//! Bounded, local thumbnail color sampling. Never generates media or reads originals.
use std::collections::{BTreeSet, HashMap};
use std::io::{Cursor, Read};
use std::time::{Duration, Instant, SystemTime};

use image::{DynamicImage, ImageDecoder, ImageReader};
use rusqlite::{params, Connection, OptionalExtension};

use super::{error::LibraryError, Library};

const MAX_FILES: usize = 64;
const PAGE_SIZE: usize = 32;
const CACHE_CAPACITY: usize = 512;
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PIXELS: u64 = 2_000_000;
const PREPARATION_BUDGET: Duration = Duration::from_millis(500);
pub(super) const COLOR_CUTOFF: f32 = 0.25;

#[derive(Debug, Clone)]
pub(super) struct ColorSignature {
    pub bins: [f32; 100],
}

pub(super) fn color_signature(image: &DynamicImage) -> Option<ColorSignature> {
    if image.width() == 0 || image.height() == 0 {
        return None;
    }
    // Nearest sampling avoids interpolating hidden RGB from transparent pixels
    // into opaque neighbors. Small thumbnails need no upscaling.
    let small = if image.width() <= 64 && image.height() <= 64 {
        image.to_rgba8()
    } else {
        image
            .resize(64, 64, image::imageops::FilterType::Nearest)
            .to_rgba8()
    };
    let mut bins = [0.0_f32; 100];
    for pixel in small.pixels() {
        let alpha = f32::from(pixel[3]) / 255.0;
        let [r, g, b] = [0, 1, 2].map(|i| f32::from(pixel[i]) / 255.0 * alpha + 1.0 - alpha);
        let value = r.max(g).max(b);
        let min = r.min(g).min(b);
        let delta = value - min;
        let saturation = if value > 0.0 { delta / value } else { 0.0 };
        let v = ((value * 4.0) as usize).min(3);
        if saturation < 0.15 {
            bins[96 + v] += 1.0;
        } else {
            let hue = if value == r {
                ((g - b) / delta).rem_euclid(6.0)
            } else if value == g {
                (b - r) / delta + 2.0
            } else {
                (r - g) / delta + 4.0
            };
            let h = hue * 2.0;
            let lower = h.floor() as usize % 12;
            let fraction = h.fract();
            let s = usize::from(saturation >= 0.5);
            bins[lower * 8 + s * 4 + v] += 1.0 - fraction;
            bins[((lower + 1) % 12) * 8 + s * 4 + v] += fraction;
        }
    }
    let total = (small.width() * small.height()) as f32;
    for bin in &mut bins {
        *bin /= total;
    }
    if bins.iter().any(|bin| *bin >= 0.95) {
        return None;
    }
    Some(ColorSignature { bins })
}

pub(super) fn color_distance(a: &ColorSignature, b: &ColorSignature) -> f32 {
    (1.0 - a
        .bins
        .iter()
        .zip(b.bins.iter())
        .map(|(a, b)| a.min(*b))
        .sum::<f32>())
    .clamp(0.0, 1.0)
}

type PageCursor = (String, String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ColorSource {
    pub id: String,
    pub hash: String,
    thumbnail: Option<String>,
    collected_at: String,
}

impl ColorSource {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            hash: row.get(1)?,
            thumbnail: row.get(2)?,
            collected_at: row.get(3)?,
        })
    }

    pub(super) fn is_current(&self, connection: &Connection) -> Result<bool, LibraryError> {
        Ok(connection.query_row(
            "SELECT 1 FROM assets WHERE id=?1 AND status='normal' AND content_hash=?2 AND thumbnail_relative_path IS ?3",
            params![self.id, self.hash, self.thumbnail], |_| Ok(())
        ).optional()?.is_some())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    length: u64,
    modified: SystemTime,
}

fn file_stamp(file: &std::fs::File) -> Option<FileStamp> {
    let metadata = file.metadata().ok()?;
    Some(FileStamp {
        length: metadata.len(),
        modified: metadata.modified().ok()?,
    })
}

#[derive(Debug, Clone)]
struct CacheEntry {
    source: ColorSource,
    stamp: Option<FileStamp>,
    signature: Option<ColorSignature>,
    used: u64,
}

#[derive(Debug, Default)]
pub(super) struct ColorCache {
    entries: HashMap<String, CacheEntry>,
    cursors: [Option<PageCursor>; 2],
    clock: u64,
}

impl ColorCache {
    fn insert(&mut self, mut entry: CacheEntry) {
        self.clock += 1;
        entry.used = self.clock;
        self.entries.insert(entry.source.id.clone(), entry);
        if self.entries.len() > CACHE_CAPACITY {
            if let Some(oldest) = self
                .entries
                .values()
                .min_by_key(|entry| entry.used)
                .map(|entry| entry.source.id.clone())
            {
                self.entries.remove(&oldest);
            }
        }
    }
}

#[derive(Clone)]
pub(super) struct PreparedColor {
    pub source: ColorSource,
    pub signature: ColorSignature,
}

#[derive(Debug, Default)]
struct PreparationStats {
    reads: usize,
    decodes: usize,
}

fn candidate_page(
    connection: &Connection,
    cursor: Option<&PageCursor>,
    newest: bool,
) -> Result<Vec<ColorSource>, LibraryError> {
    let direction = if newest { "DESC" } else { "ASC" };
    let operator = if newest { "<" } else { ">" };
    // Page all normal rows, including rows without a poster. Filtering them in SQL
    // could walk an unbounded number of videos with no thumbnail.
    let keyset = if cursor.is_some() {
        format!("AND (collected_at,id) {operator} (?1,?2)")
    } else {
        String::new()
    };
    let sql = format!("SELECT id,content_hash,thumbnail_relative_path,collected_at FROM assets WHERE status='normal' {keyset} ORDER BY collected_at {direction},id {direction} LIMIT {PAGE_SIZE}");
    let mut statement = connection.prepare(&sql)?;
    let values: Vec<&dyn rusqlite::ToSql> = cursor
        .map(|(date, id)| vec![date as &dyn rusqlite::ToSql, id as &dyn rusqlite::ToSql])
        .unwrap_or_default();
    let result = statement
        .query_map(values.as_slice(), ColorSource::from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(result)
}

fn decode_signature(bytes: &[u8], stats: &mut PreparationStats) -> Option<ColorSignature> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_PIXELS as u32);
    limits.max_image_height = Some(MAX_PIXELS as u32);
    limits.max_alloc = Some(32 * 1024 * 1024);
    reader.limits(limits);
    let decoder = reader.into_decoder().ok()?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return None;
    }
    stats.decodes += 1;
    color_signature(&DynamicImage::from_decoder(decoder).ok()?)
}

impl Library {
    fn color_cache(&self) -> std::sync::MutexGuard<'_, ColorCache> {
        self.revisit_color_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn color_media(&self, source: &ColorSource) -> Option<super::MediaResponse> {
        let path = source.thumbnail.as_deref()?;
        // Stored media is always library-relative, on either native platform.
        if path.is_empty()
            || path.contains('\\')
            || path.contains(':')
            || std::path::Path::new(path)
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return None;
        }
        self.open_library_media(path).ok()
    }

    fn prepare_color_candidates(&self, started: Instant) -> Result<PreparationStats, LibraryError> {
        let cursors = self.color_cache().cursors.clone();
        let pages = {
            let connection = self.connection()?;
            [
                candidate_page(&connection, cursors[0].as_ref(), false)?,
                candidate_page(&connection, cursors[1].as_ref(), true)?,
            ]
        };
        let mut stats = PreparationStats::default();
        let mut seen = BTreeSet::new();
        let mut attempted = 0;
        let mut pending = Vec::new();
        'pages: for (side, page) in pages.into_iter().enumerate() {
            if page.is_empty() {
                self.color_cache().cursors[side] = None;
            }
            for source in page {
                if started.elapsed() >= PREPARATION_BUDGET || attempted >= MAX_FILES {
                    break 'pages;
                }
                self.color_cache().cursors[side] =
                    Some((source.collected_at.clone(), source.id.clone()));
                if !seen.insert(source.id.clone()) {
                    continue;
                }
                let media = self.color_media(&source);
                let stamp = media.as_ref().and_then(|media| file_stamp(&media.file));
                let cached = self.color_cache().entries.get(&source.id).cloned();
                if let Some(entry) =
                    cached.filter(|entry| entry.source == source && entry.stamp == stamp)
                {
                    self.color_cache().insert(entry);
                    continue;
                }
                attempted += 1;
                let mut signature = None;
                if let (Some(mut media), Some(before)) = (media, stamp.as_ref()) {
                    if before.length <= MAX_BYTES {
                        let mut bytes = Vec::new();
                        stats.reads += 1;
                        if (&mut media.file)
                            .take(MAX_BYTES + 1)
                            .read_to_end(&mut bytes)
                            .is_ok()
                            && bytes.len() as u64 <= MAX_BYTES
                        {
                            signature = decode_signature(&bytes, &mut stats);
                        }
                        // Check both the open handle and the path: replacement by rename
                        // leaves metadata on the old open handle unchanged.
                        let after_path = self
                            .color_media(&source)
                            .and_then(|media| file_stamp(&media.file));
                        if file_stamp(&media.file).as_ref() != Some(before)
                            || after_path.as_ref() != Some(before)
                        {
                            continue;
                        }
                    }
                }
                pending.push(CacheEntry {
                    source,
                    stamp,
                    signature,
                    used: 0,
                });
            }
        }
        // One short connection for the whole batch, never one connection per file.
        // No file I/O or decoding occurs while this guard is held.
        let connection = self.connection()?;
        for entry in pending {
            if entry.source.is_current(&connection)? {
                self.color_cache().insert(entry);
            }
        }
        Ok(stats)
    }

    // The decode deadline only stops new thumbnail work. Validate the bounded
    // cache even after that deadline, otherwise a slow batch loses every result.
    // This stage reads file metadata only; it never reads or decodes image content.
    pub(super) fn current_colors(&self) -> Result<Vec<PreparedColor>, LibraryError> {
        let entries: Vec<_> = self
            .color_cache()
            .entries
            .values()
            .filter(|entry| entry.signature.is_some())
            .cloned()
            .collect();
        let current = {
            let connection = self.connection()?;
            entries
                .into_iter()
                .map(|entry| Ok((entry.source.is_current(&connection)?, entry)))
                .collect::<Result<Vec<_>, LibraryError>>()?
        };
        let mut valid = Vec::new();
        for (current, entry) in current {
            let stamp = if current {
                self.color_media(&entry.source)
                    .and_then(|media| file_stamp(&media.file))
            } else {
                None
            };
            if !current || stamp.is_none() || stamp != entry.stamp {
                self.color_cache().entries.remove(&entry.source.id);
                continue;
            }
            valid.push(PreparedColor {
                source: entry.source.clone(),
                signature: entry.signature.clone().unwrap(),
            });
            self.color_cache().insert(entry);
        }
        Ok(valid)
    }

    pub(super) fn colors_for_reshuffle(&self) -> Result<Vec<PreparedColor>, LibraryError> {
        // An explicit shuffle may refill the cache after restart and advance one
        // bounded page. Never drain the library or compete with another decoder.
        if let Ok(_worker) = self.revisit_color_lock.try_lock() {
            self.prepare_color_candidates(Instant::now())?;
        }
        self.current_colors()
    }

    pub fn prepare_revisit_color_bundle(
        &self,
        local_date: &str,
        now_utc: &str,
        expected_revision: i64,
    ) -> Result<Option<super::models::RevisitSlate>, LibraryError> {
        use super::revisit;
        revisit::parse_local_date(local_date)?;
        revisit::parse_utc_timestamp(now_utc)?;
        let Ok(_worker) = self.revisit_color_lock.try_lock() else {
            return Ok(None);
        };
        let started = Instant::now();
        {
            let connection = self.connection()?;
            if !revisit::can_prepare_color(&connection, local_date, expected_revision)? {
                return Ok(None);
            }
        }
        self.prepare_color_candidates(started)?;
        let colors = self.current_colors()?;
        let connection = self.connection()?;
        revisit::append_color_bundle(&connection, local_date, now_utc, expected_revision, &colors)
    }
}

#[cfg(test)]
#[path = "revisit_color_tests.rs"]
mod tests;
