use std::{collections::BTreeMap, error::Error, path::Path};

use rusqlite::{Connection, OpenFlags};

fn quality_bucket(quality: u8) -> &'static str {
    match quality {
        0..=9 => "0-9",
        10..=19 => "10-19",
        20..=29 => "20-29",
        30..=39 => "30-39",
        40..=49 => "40-49",
        50..=59 => "50-59",
        60..=69 => "60-69",
        70..=79 => "70-79",
        80..=89 => "80-89",
        90..=99 => "90-99",
        100 => "100",
        _ => "invalid",
    }
}

fn eligible_media(media_kind: &str) -> bool {
    matches!(media_kind, "image" | "gif")
}

#[derive(Debug)]
struct Fingerprint {
    whole: [u8; 32],
    cropped: [u8; 32],
    quality: u8,
}

fn fingerprint_file(path: &Path) -> Result<Fingerprint, Box<dyn Error>> {
    let image = image::open(path)?;
    if image.width() < 5 || image.height() < 5 {
        return Err("image is too small for PDQ".into());
    }
    let (whole, whole_quality) = pdq_for(&image)?;
    let margin_x = image.width() / 20;
    let margin_y = image.height() / 20;
    let cropped_image = image.crop_imm(
        margin_x,
        margin_y,
        image.width() - margin_x * 2,
        image.height() - margin_y * 2,
    );
    let (cropped, cropped_quality) = pdq_for(&cropped_image)?;
    Ok(Fingerprint {
        whole,
        cropped,
        quality: whole_quality.min(cropped_quality),
    })
}

fn pdq_for(image: &image::DynamicImage) -> Result<([u8; 32], u8), Box<dyn Error>> {
    let rgba = image.thumbnail(512, 512).to_rgba8();
    let compatible =
        pdqhash::image::RgbaImage::from_raw(rgba.width(), rgba.height(), rgba.into_raw())
            .ok_or("invalid RGBA dimensions")?;
    let (bytes, quality) =
        pdqhash::generate_pdq_full_size(&pdqhash::image::DynamicImage::ImageRgba8(compatible));
    if !quality.is_finite() || !(0.0..=1.0).contains(&quality) {
        return Err("PDQ returned an invalid quality".into());
    }
    Ok((bytes, (quality * 100.0).round() as u8))
}

fn hamming_distance(left: &[u8; 32], right: &[u8; 32]) -> u32 {
    left.iter()
        .zip(right)
        .map(|(left, right)| (left ^ right).count_ones())
        .sum()
}

fn minimum_distance(left: &Fingerprint, right: &Fingerprint) -> u32 {
    [
        hamming_distance(&left.whole, &right.whole),
        hamming_distance(&left.whole, &right.cropped),
        hamming_distance(&left.cropped, &right.whole),
        hamming_distance(&left.cropped, &right.cropped),
    ]
    .into_iter()
    .min()
    .unwrap_or(256)
}

fn dimensions_are_compatible(left: (u32, u32), right: (u32, u32)) -> bool {
    if left.0 == 0 || left.1 == 0 || right.0 == 0 || right.1 == 0 {
        return false;
    }
    let left_cross = u128::from(left.0) * u128::from(right.1);
    let right_cross = u128::from(right.0) * u128::from(left.1);
    left_cross.max(right_cross) * 100 <= left_cross.min(right_cross) * 115
}

fn main() -> Result<(), Box<dyn Error>> {
    let root = std::env::args_os()
        .nth(1)
        .map(std::path::PathBuf::from)
        .ok_or("usage: pdq_similarity_audit <library-root>")?;
    let database_path = root.join("library.sqlite");
    let connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    let mut statement = connection.prepare(
        "SELECT id, media_kind, relative_path
         FROM assets
         WHERE status = 'normal' AND media_kind IN ('image', 'gif')
         ORDER BY id",
    )?;
    let assets = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut succeeded = 0_u64;
    let mut failed = 0_u64;
    let mut below_fifty = 0_u64;
    let mut buckets = BTreeMap::<&'static str, u64>::new();
    for (id, media_kind, relative_path) in &assets {
        debug_assert!(eligible_media(media_kind));
        match fingerprint_file(&root.join(relative_path)) {
            Ok(fingerprint) => {
                succeeded += 1;
                below_fifty += u64::from(fingerprint.quality < 50);
                *buckets
                    .entry(quality_bucket(fingerprint.quality))
                    .or_default() += 1;
            }
            Err(error) => {
                failed += 1;
                eprintln!("fingerprint_error\t{id}\t{relative_path}\t{error}");
            }
        }
    }

    println!("eligible_assets\t{}", assets.len());
    println!("fingerprint_succeeded\t{succeeded}");
    println!("fingerprint_failed\t{failed}");
    println!("quality_below_50\t{below_fifty}");
    let below_percent = if succeeded == 0 {
        0.0
    } else {
        below_fifty as f64 * 100.0 / succeeded as f64
    };
    println!("quality_below_50_percent\t{below_percent:.2}");
    for (bucket, count) in buckets {
        println!("quality_bucket\t{bucket}\t{count}");
    }

    let mut statement = connection.prepare(
        "SELECT review.id,
                existing.relative_path, existing.width, existing.height,
                candidate.relative_path, candidate.width, candidate.height
         FROM similarity_reviews AS review
         JOIN assets AS existing ON existing.id = review.existing_asset_id
         JOIN assets AS candidate ON candidate.id = review.candidate_asset_id
         WHERE review.status = 'resolved' AND review.decision = 'keep_both'
           AND existing.media_kind IN ('image', 'gif')
           AND candidate.media_kind IN ('image', 'gif')
         ORDER BY review.id",
    )?;
    let pairs = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                (row.get::<_, u32>(2)?, row.get::<_, u32>(3)?),
                row.get::<_, String>(4)?,
                (row.get::<_, u32>(5)?, row.get::<_, u32>(6)?),
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (review_id, existing_path, existing_dimensions, candidate_path, candidate_dimensions) in
        pairs
    {
        let existing = fingerprint_file(&root.join(&existing_path));
        let candidate = fingerprint_file(&root.join(&candidate_path));
        match (existing, candidate) {
            (Ok(existing_hash), Ok(candidate_hash)) => {
                let distance = minimum_distance(&existing_hash, &candidate_hash);
                let aspect_ok =
                    dimensions_are_compatible(existing_dimensions, candidate_dimensions);
                println!(
                    "keep_both_pair\t{review_id}\tdistance={distance}\taspect_ok={aspect_ok}\tquality={}/{}",
                    existing_hash.quality, candidate_hash.quality
                );
            }
            (existing, candidate) => eprintln!(
                "keep_both_error\t{review_id}\texisting={:?}\tcandidate={:?}",
                existing.err(),
                candidate.err()
            ),
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{eligible_media, quality_bucket};

    #[test]
    fn quality_buckets_cover_zero_through_one_hundred() {
        assert_eq!(quality_bucket(0), "0-9");
        assert_eq!(quality_bucket(50), "50-59");
        assert_eq!(quality_bucket(100), "100");
    }

    #[test]
    fn eligible_media_includes_gif_but_not_video() {
        assert!(eligible_media("image"));
        assert!(eligible_media("gif"));
        assert!(!eligible_media("video"));
    }
}
