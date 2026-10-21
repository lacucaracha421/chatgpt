use std::{fs::File, io::BufReader};

use image::{DynamicImage, ImageDecoder, ImageReader, Rgb, RgbImage};

use super::{
    decode_and_fingerprint, decode_staging_image, encode_thumbnail_webp, staging_image_reader,
};
use crate::library::{error::LibraryError, image_fingerprint::fingerprint};

// The pre-sharing file path, kept independent of the new image-taking entry.
fn old_fingerprint(
    path: &std::path::Path,
) -> Result<crate::library::image_fingerprint::ImageFingerprint, LibraryError> {
    let reader = ImageReader::new(BufReader::new(File::open(path).unwrap()))
        .with_guessed_format()
        .unwrap();
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image =
        DynamicImage::from_decoder(decoder).map_err(|_| LibraryError::UnsupportedImage)?;
    image.apply_orientation(orientation);
    fingerprint(&image)
}

fn fixture() -> DynamicImage {
    DynamicImage::ImageRgb8(RgbImage::from_fn(721, 479, |x, y| {
        Rgb([
            ((x * 13 + y * 3) % 251) as u8,
            ((x * 5 + y * 17) % 241) as u8,
            ((x * 19 + y * 7) % 239) as u8,
        ])
    }))
}

#[test]
fn ingestion_shared_decode_matches_old_bits_quality_dimensions_and_thumbnail() {
    let temp = tempfile::tempdir().unwrap();
    let source = fixture();
    for extension in ["png", "jpg", "webp", "gif"] {
        let path = temp.path().join(format!("source.{extension}"));
        source.save(&path).unwrap();
        let expected = old_fingerprint(&path).unwrap();
        let old_thumbnail_image =
            decode_staging_image(staging_image_reader(File::open(&path).unwrap()).unwrap())
                .unwrap();
        let dimensions = (old_thumbnail_image.width(), old_thumbnail_image.height());
        let thumbnail = encode_thumbnail_webp(&old_thumbnail_image).unwrap();
        drop(old_thumbnail_image);
        let (shared, actual) = decode_and_fingerprint(File::open(&path).unwrap()).unwrap();
        assert_eq!(actual.unwrap(), expected, "{extension}");
        assert_eq!((shared.width(), shared.height()), dimensions);
        assert_eq!(
            encode_thumbnail_webp(&shared).unwrap(),
            thumbnail,
            "{extension}"
        );
        let from_file =
            crate::library::similarity::perceptual_hash_from_file(File::open(&path).unwrap())
                .unwrap();
        assert_eq!(from_file.fingerprint, expected);
        assert_eq!((from_file.width, from_file.height), dimensions);
    }
}

#[test]
fn ingestion_shared_decode_matches_old_exif_rotated_jpeg() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("rotated.jpg");
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
        .encode_image(&fixture())
        .unwrap();
    let mut exif = b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
    exif.extend_from_slice(&6u16.to_le_bytes());
    exif.extend_from_slice(&[0; 6]);
    let mut bytes = vec![0xff, 0xd8, 0xff, 0xe1];
    bytes.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
    bytes.extend_from_slice(&exif);
    bytes.extend_from_slice(&jpeg[2..]);
    std::fs::write(&path, bytes).unwrap();
    let expected = old_fingerprint(&path).unwrap();
    let old_image =
        decode_staging_image(staging_image_reader(File::open(&path).unwrap()).unwrap()).unwrap();
    let thumbnail = encode_thumbnail_webp(&old_image).unwrap();
    drop(old_image);
    let (image, actual) = decode_and_fingerprint(File::open(&path).unwrap()).unwrap();
    assert_eq!(actual.unwrap(), expected);
    assert_eq!((image.width(), image.height()), (479, 721));
    assert_eq!(encode_thumbnail_webp(&image).unwrap(), thumbnail);
}

#[test]
fn ingestion_shared_decode_keeps_thumbnail_when_fingerprint_is_unsupported() {
    let temp = tempfile::tempdir().unwrap();
    for extension in ["png", "webp"] {
        let path = temp.path().join(format!("small.{extension}"));
        RgbImage::from_pixel(4, 3, Rgb([30, 90, 120]))
            .save(&path)
            .unwrap();
        assert!(matches!(
            old_fingerprint(&path),
            Err(LibraryError::UnsupportedImage)
        ));
        let (image, hash) = decode_and_fingerprint(File::open(path).unwrap()).unwrap();
        assert!(hash.is_none());
        assert_eq!((image.width(), image.height()), (4, 3));
        assert!(image::load_from_memory(&encode_thumbnail_webp(&image).unwrap()).is_ok());
    }
}

#[test]
fn ingestion_shared_decode_rejects_input_rejected_by_both_decoders() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(temp.path(), b"RIFF\0\0\0\0WEBP").unwrap();
    assert!(matches!(
        decode_and_fingerprint(File::open(temp.path()).unwrap()),
        Err(LibraryError::UnsupportedImage)
    ));
}
