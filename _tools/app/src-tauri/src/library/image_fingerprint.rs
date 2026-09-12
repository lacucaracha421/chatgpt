use image::DynamicImage;

use super::error::LibraryError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ImageFingerprint {
    pub(crate) bytes: [u8; 32],
    pub(crate) cropped_bytes: [u8; 32],
    pub(crate) quality: u8,
}

pub(crate) fn fingerprint(image: &DynamicImage) -> Result<ImageFingerprint, LibraryError> {
    if image.width() < 5 || image.height() < 5 {
        return Err(LibraryError::UnsupportedImage);
    }
    let (bytes, whole_quality) = pdq_for(image)?;
    let margin_x = image.width() / 20;
    let margin_y = image.height() / 20;
    let cropped = image.crop_imm(
        margin_x,
        margin_y,
        image.width() - margin_x * 2,
        image.height() - margin_y * 2,
    );
    let (cropped_bytes, cropped_quality) = pdq_for(&cropped)?;

    Ok(ImageFingerprint {
        bytes,
        cropped_bytes,
        quality: whole_quality.min(cropped_quality),
    })
}

impl ImageFingerprint {
    pub(crate) fn to_stored_bytes(self) -> [u8; 64] {
        let mut stored = [0; 64];
        stored[..32].copy_from_slice(&self.bytes);
        stored[32..].copy_from_slice(&self.cropped_bytes);
        stored
    }

    pub(crate) fn from_stored_bytes(bytes: &[u8], quality: u8) -> Result<Self, LibraryError> {
        if bytes.len() != 64 {
            return Err(LibraryError::InvalidPerceptualHash);
        }
        let mut whole = [0; 32];
        let mut cropped = [0; 32];
        whole.copy_from_slice(&bytes[..32]);
        cropped.copy_from_slice(&bytes[32..]);
        Ok(Self {
            bytes: whole,
            cropped_bytes: cropped,
            quality,
        })
    }
}

fn pdq_for(image: &DynamicImage) -> Result<([u8; 32], u8), LibraryError> {
    let rgba = image.thumbnail(512, 512).to_rgba8();
    let compatible =
        pdqhash::image::RgbaImage::from_raw(rgba.width(), rgba.height(), rgba.into_raw())
            .ok_or(LibraryError::UnsupportedImage)?;
    let (bytes, quality) =
        pdqhash::generate_pdq_full_size(&pdqhash::image::DynamicImage::ImageRgba8(compatible));
    if !quality.is_finite() || !(0.0..=1.0).contains(&quality) {
        return Err(LibraryError::UnsupportedImage);
    }
    Ok((bytes, (quality * 100.0).round() as u8))
}

pub(crate) fn hamming_distance(left: &[u8; 32], right: &[u8; 32]) -> u32 {
    left.iter()
        .zip(right)
        .map(|(left, right)| (left ^ right).count_ones())
        .sum()
}

pub(crate) fn minimum_distance(left: &ImageFingerprint, right: &ImageFingerprint) -> u32 {
    [
        hamming_distance(&left.bytes, &right.bytes),
        hamming_distance(&left.bytes, &right.cropped_bytes),
        hamming_distance(&left.cropped_bytes, &right.bytes),
        hamming_distance(&left.cropped_bytes, &right.cropped_bytes),
    ]
    .into_iter()
    .min()
    .unwrap_or(256)
}

pub(crate) fn dimensions_are_compatible(left: (u32, u32), right: (u32, u32)) -> bool {
    if left.0 == 0 || left.1 == 0 || right.0 == 0 || right.1 == 0 {
        return false;
    }
    let left_cross = u128::from(left.0) * u128::from(right.1);
    let right_cross = u128::from(right.0) * u128::from(left.1);
    left_cross.max(right_cross) * 100 <= left_cross.min(right_cross) * 115
}

#[cfg(test)]
mod tests {
    use image::{DynamicImage, ImageBuffer, Rgb};

    use super::{
        dimensions_are_compatible, fingerprint, hamming_distance, minimum_distance,
        ImageFingerprint,
    };

    #[test]
    fn fingerprint_returns_pdq_bytes_and_quality() {
        let image = detailed_fixture(640, 480);
        let result = fingerprint(&image).unwrap();

        assert_eq!(result.bytes.len(), 32);
        assert_eq!(result.cropped_bytes.len(), 32);
        assert!(result.quality <= 100);
        assert_eq!(hamming_distance(&result.bytes, &result.bytes), 0);
    }

    #[test]
    fn stored_fingerprint_round_trips_both_variants() {
        let fingerprint = fingerprint(&detailed_fixture(640, 480)).unwrap();

        assert_eq!(
            ImageFingerprint::from_stored_bytes(
                &fingerprint.to_stored_bytes(),
                fingerprint.quality
            )
            .unwrap(),
            fingerprint
        );
        assert!(ImageFingerprint::from_stored_bytes(&[0; 63], 100).is_err());
    }

    #[test]
    fn minimum_distance_matches_a_five_percent_crop() {
        let image = detailed_fixture(900, 600);
        let cropped = image.crop_imm(45, 30, 810, 540);

        assert!(
            minimum_distance(
                &fingerprint(&image).unwrap(),
                &fingerprint(&cropped).unwrap()
            ) <= 20
        );
    }

    #[test]
    fn hamming_distance_counts_all_256_bits() {
        assert_eq!(hamming_distance(&[0; 32], &[u8::MAX; 32]), 256);
    }

    #[test]
    fn aspect_ratio_uses_the_strict_factor() {
        assert!(dimensions_are_compatible((1000, 1000), (1150, 1000)));
        assert!(!dimensions_are_compatible((1000, 1000), (1151, 1000)));
        assert!(!dimensions_are_compatible((0, 1000), (1000, 1000)));
    }

    fn detailed_fixture(width: u32, height: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(ImageBuffer::from_fn(width, height, |x, y| {
            Rgb([
                ((x * 13 + y * 3) % 251) as u8,
                ((x * 5 + y * 17) % 241) as u8,
                ((x * 19 + y * 7) % 239) as u8,
            ])
        }))
    }
}
