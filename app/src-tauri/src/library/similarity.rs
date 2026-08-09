use std::{
    fs::File,
    io::{BufReader, Seek, SeekFrom},
};

use image::{DynamicImage, ImageReader};
use rusqlite::params;

use super::{error::LibraryError, models::SimilarityIndexProgress, Library, MediaVariant};

const SIMILARITY_DISTANCE_MAX: u32 = 6;
const INDEX_BATCH_SIZE: u32 = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SimilarAssetCandidate {
    pub(crate) asset_id: String,
    pub(crate) distance: u32,
}

impl Library {
    pub fn index_missing_similarity_hashes(&self) -> Result<SimilarityIndexProgress, LibraryError> {
        let asset_ids = {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT id
                 FROM assets
                 WHERE status = 'normal'
                   AND perceptual_hash IS NULL
                   AND perceptual_hash_error IS NULL
                 ORDER BY collected_at, id
                 LIMIT ?1",
            )?;
            let ids = statement
                .query_map([INDEX_BATCH_SIZE], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };

        for asset_id in &asset_ids {
            let result = self
                .resolve_media(asset_id, MediaVariant::Asset)
                .and_then(|media| perceptual_hash_from_bytes(&media.bytes));
            let connection = self.connection()?;
            match result {
                Ok(hash) => {
                    connection.execute(
                        "UPDATE assets
                         SET perceptual_hash = ?2
                         WHERE id = ?1 AND status = 'normal'",
                        params![asset_id, hash.to_be_bytes()],
                    )?;
                }
                Err(error) => {
                    let code = similarity_index_error_code(&error).ok_or(error)?;
                    connection.execute(
                        "UPDATE assets
                         SET perceptual_hash_error = ?2
                         WHERE id = ?1 AND status = 'normal'",
                        params![asset_id, code],
                    )?;
                }
            }
        }

        let connection = self.connection()?;
        let (remaining, failed): (i64, i64) = connection.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN perceptual_hash IS NULL AND perceptual_hash_error IS NULL THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN perceptual_hash_error IS NOT NULL THEN 1 ELSE 0 END), 0)
             FROM assets
             WHERE status = 'normal'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(SimilarityIndexProgress {
            processed: asset_ids.len() as u64,
            remaining: remaining as u64,
            failed: failed as u64,
        })
    }

    pub(crate) fn find_similar_asset(
        &self,
        target_hash: u64,
    ) -> Result<Option<SimilarAssetCandidate>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, perceptual_hash
             FROM assets
             WHERE status = 'normal' AND perceptual_hash IS NOT NULL
             ORDER BY collected_at, id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut best: Option<SimilarAssetCandidate> = None;
        for row in rows {
            let (asset_id, bytes) = row?;
            let bytes: [u8; 8] = bytes
                .try_into()
                .map_err(|_| LibraryError::InvalidPerceptualHash)?;
            let distance = hamming_distance(target_hash, u64::from_be_bytes(bytes));
            if distance <= SIMILARITY_DISTANCE_MAX
                && best
                    .as_ref()
                    .is_none_or(|candidate| distance < candidate.distance)
            {
                best = Some(SimilarAssetCandidate { asset_id, distance });
            }
        }
        Ok(best)
    }
}

pub(crate) fn perceptual_hash_from_file(mut file: File) -> Result<u64, LibraryError> {
    file.seek(SeekFrom::Start(0))
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let image = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|_| LibraryError::UnsupportedImage)?
        .decode()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    Ok(perceptual_hash(&image))
}

fn perceptual_hash_from_bytes(bytes: &[u8]) -> Result<u64, LibraryError> {
    image::load_from_memory(bytes)
        .map(|image| perceptual_hash(&image))
        .map_err(|_| LibraryError::UnsupportedImage)
}

fn perceptual_hash(image: &DynamicImage) -> u64 {
    let pixels = image
        .resize_exact(9, 8, image::imageops::FilterType::Triangle)
        .to_luma8();
    let mut hash = 0_u64;
    for y in 0..8 {
        for x in 0..8 {
            hash <<= 1;
            hash |= u64::from(pixels.get_pixel(x, y)[0] > pixels.get_pixel(x + 1, y)[0]);
        }
    }
    hash
}

fn hamming_distance(left: u64, right: u64) -> u32 {
    (left ^ right).count_ones()
}

fn similarity_index_error_code(error: &LibraryError) -> Option<&'static str> {
    match error {
        LibraryError::AssetNotFound | LibraryError::MediaNotFound => Some("media_not_found"),
        LibraryError::UnsafeMediaPath => Some("unsafe_media_path"),
        LibraryError::ReadMedia { .. } => Some("read_media_failed"),
        LibraryError::UnsupportedImage => Some("unsupported_image"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, time::Instant};

    use image::{
        codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageBuffer, Rgb, RgbImage,
    };
    use rusqlite::params;
    use tempfile::TempDir;

    use super::super::{error::LibraryError, Library};
    use super::{hamming_distance, perceptual_hash};

    #[derive(Clone, Copy)]
    enum StripeDirection {
        Vertical,
        Horizontal,
    }

    struct TestLibrary {
        _temp: TempDir,
        library: Library,
    }

    #[test]
    fn resized_and_reencoded_image_is_nearer_than_an_unrelated_image() {
        let base = striped_fixture(900, 600, StripeDirection::Vertical);
        let resized_jpeg = jpeg_variant(&base, 450, 300, 70);
        let unrelated = striped_fixture(900, 600, StripeDirection::Horizontal);

        let base_hash = perceptual_hash(&base);
        let resized_hash = perceptual_hash(&resized_jpeg);
        let unrelated_hash = perceptual_hash(&unrelated);

        assert!(hamming_distance(base_hash, resized_hash) <= 6);
        assert!(hamming_distance(base_hash, unrelated_hash) > 6);
    }

    #[test]
    fn candidate_search_uses_distance_then_collected_at_then_id() {
        let fixture = library_with_hashes(&[
            ("later", 0b0001_u64, "2026-08-09T01:00:00Z"),
            ("earlier-b", 0b0010_u64, "2026-08-09T00:00:00Z"),
            ("earlier-a", 0b0100_u64, "2026-08-09T00:00:00Z"),
        ]);

        assert_eq!(
            fixture
                .library
                .find_similar_asset(0)
                .unwrap()
                .unwrap()
                .asset_id,
            "earlier-a"
        );
    }

    #[test]
    fn candidate_search_rejects_a_hash_blob_with_the_wrong_length() {
        let fixture = library_with_hashes(&[]);
        insert_asset(
            &fixture.library,
            "broken",
            "2026-08-09T00:00:00Z",
            Some(&[0; 7]),
        );

        let error = fixture.library.find_similar_asset(0).unwrap_err();

        assert!(matches!(error, LibraryError::InvalidPerceptualHash));
    }

    #[test]
    fn indexing_attempts_fifty_assets_and_records_media_failures_once() {
        let fixture = library_with_unindexed_assets(51);

        let first = fixture.library.index_missing_similarity_hashes().unwrap();
        let second = fixture.library.index_missing_similarity_hashes().unwrap();

        assert_eq!((first.processed, first.remaining, first.failed), (50, 1, 1));
        assert_eq!(
            (second.processed, second.remaining, second.failed),
            (1, 0, 1)
        );
        let error: String = fixture
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT perceptual_hash_error FROM assets WHERE id = 'asset-000'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(error, "media_not_found");
    }

    #[test]
    fn indexing_an_empty_library_returns_zero_counts() {
        let fixture = library_with_hashes(&[]);

        let progress = fixture.library.index_missing_similarity_hashes().unwrap();

        assert_eq!(
            (progress.processed, progress.remaining, progress.failed),
            (0, 0, 0)
        );
    }

    #[test]
    #[ignore]
    fn candidate_search_scans_fifty_thousand_hashes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            for index in 0..50_000_u64 {
                let id = format!("asset-{index:05}");
                let hash = index.rotate_left(17).to_be_bytes();
                transaction
                    .execute(
                        "INSERT INTO assets (
                            id, content_hash, media_kind, original_name, relative_path,
                            thumbnail_relative_path, byte_size, width, height, collected_at,
                            perceptual_hash
                         ) VALUES (?1, ?1, 'image', ?1, ?2, ?3, 1, 1, 1,
                            '2026-08-09T00:00:00Z', ?4)",
                        params![
                            id,
                            format!("assets/{id}.png"),
                            format!("thumbnails/{id}.webp"),
                            hash
                        ],
                    )
                    .unwrap();
            }
            transaction.commit().unwrap();
        }

        let started = Instant::now();
        let candidate = library.find_similar_asset(0).unwrap();
        let elapsed = started.elapsed();

        assert_eq!(candidate.unwrap().asset_id, "asset-00000");
        eprintln!("50k similarity scan: {elapsed:?}");
        assert!(elapsed.as_secs_f64() < 1.0);
    }

    fn striped_fixture(width: u32, height: u32, direction: StripeDirection) -> DynamicImage {
        DynamicImage::ImageRgb8(ImageBuffer::from_fn(width, height, |x, y| {
            let offset = match direction {
                StripeDirection::Vertical => x,
                StripeDirection::Horizontal => y,
            };
            let light = (offset / 32) % 2 == 0;
            Rgb(if light { [240, 180, 30] } else { [20, 60, 180] })
        }))
    }

    fn jpeg_variant(source: &DynamicImage, width: u32, height: u32, quality: u8) -> DynamicImage {
        let resized = source.resize_exact(width, height, FilterType::Triangle);
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, quality)
            .encode_image(&resized)
            .unwrap();
        image::load_from_memory(&bytes).unwrap()
    }

    fn library_with_hashes(rows: &[(&str, u64, &str)]) -> TestLibrary {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for (id, hash, collected_at) in rows {
            insert_asset(&library, id, collected_at, Some(&hash.to_be_bytes()));
        }
        TestLibrary {
            _temp: temp,
            library,
        }
    }

    fn library_with_unindexed_assets(count: usize) -> TestLibrary {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for index in 0..count {
            let id = format!("asset-{index:03}");
            insert_asset(&library, &id, "2026-08-09T00:00:00Z", None);
            if index != 0 {
                let path = library.root().join(format!("assets/{id}.png"));
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                RgbImage::from_pixel(12, 8, Rgb([index as u8, 80, 120]))
                    .save(&path)
                    .unwrap();
            }
        }
        TestLibrary {
            _temp: temp,
            library,
        }
    }

    fn insert_asset(library: &Library, id: &str, collected_at: &str, hash: Option<&[u8]>) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at,
                    perceptual_hash
                 ) VALUES (?1, ?1, 'image', ?1, ?2, ?3, 1, 1, 1, ?4, ?5)",
                params![
                    id,
                    format!("assets/{id}.png"),
                    format!("thumbnails/{id}.webp"),
                    collected_at,
                    hash,
                ],
            )
            .unwrap();
    }
}
