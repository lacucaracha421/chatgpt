use std::io::{BufRead, Cursor, Read, Seek};

use image::{codecs::webp::WebPDecoder, DynamicImage, ImageDecoder};

use super::{LibraryError, MAX_IMAGE_BYTES};

pub(super) fn decode_webp(mut reader: impl BufRead + Seek) -> Result<DynamicImage, LibraryError> {
    // Keep image's metadata parsing and animated first-frame compositing. The existing
    // libwebp dependency decodes static pixels faster, with the same fancy upsampling.
    let mut decoder = WebPDecoder::new(&mut reader).map_err(|_| LibraryError::UnsupportedImage)?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    if decoder.has_animation() {
        let mut image =
            DynamicImage::from_decoder(decoder).map_err(|_| LibraryError::UnsupportedImage)?;
        image.apply_orientation(orientation);
        return Ok(image);
    }
    let dimensions = decoder.dimensions();
    let has_alpha = decoder.color_type().has_alpha();
    drop(decoder);

    reader
        .rewind()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let mut bytes = Vec::new();
    reader
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| LibraryError::UnsupportedImage)?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(LibraryError::UnsupportedImage);
    }

    let native = webp::Decoder::new(&bytes).decode().filter(|pixels| {
        (pixels.width(), pixels.height()) == dimensions && pixels.is_alpha() == has_alpha
    });
    let mut image = match native {
        Some(pixels) if has_alpha => {
            image::RgbaImage::from_raw(dimensions.0, dimensions.1, pixels.to_vec())
                .map(DynamicImage::ImageRgba8)
                .ok_or(LibraryError::UnsupportedImage)?
        }
        Some(pixels) => image::RgbImage::from_raw(dimensions.0, dimensions.1, pixels.to_vec())
            .map(DynamicImage::ImageRgb8)
            .ok_or(LibraryError::UnsupportedImage)?,
        // Preserve support for files accepted by image but rejected by libwebp.
        None => DynamicImage::from_decoder(
            WebPDecoder::new(Cursor::new(bytes)).map_err(|_| LibraryError::UnsupportedImage)?,
        )
        .map_err(|_| LibraryError::UnsupportedImage)?,
    };
    image.apply_orientation(orientation);
    Ok(image)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use image::{codecs::webp::WebPDecoder, DynamicImage, ImageDecoder, Rgba, RgbaImage};

    use super::decode_webp;
    use crate::library::ingestion::encode_thumbnail_webp;

    fn reference(bytes: &[u8]) -> DynamicImage {
        let mut decoder = WebPDecoder::new(Cursor::new(bytes)).unwrap();
        let orientation = decoder.orientation().unwrap();
        let mut image = DynamicImage::from_decoder(decoder).unwrap();
        image.apply_orientation(orientation);
        image
    }

    fn with_orientation(bytes: &[u8], width: u32, height: u32, orientation: u8) -> Vec<u8> {
        fn chunk(output: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
            output.extend_from_slice(tag);
            output.extend_from_slice(&(data.len() as u32).to_le_bytes());
            output.extend_from_slice(data);
            if data.len() % 2 != 0 {
                output.push(0);
            }
        }
        let mut output = b"RIFF\0\0\0\0WEBP".to_vec();
        let mut extended = vec![0x18, 0, 0, 0]; // EXIF and alpha.
        extended.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
        extended.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
        chunk(&mut output, b"VP8X", &extended);
        let mut offset = 12;
        while offset + 8 <= bytes.len() {
            let size =
                u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            let end = offset + 8 + size + size % 2;
            if &bytes[offset..offset + 4] != b"VP8X" {
                output.extend_from_slice(&bytes[offset..end]);
            }
            offset = end;
        }
        let exif = [
            b'I',
            b'I',
            42,
            0,
            8,
            0,
            0,
            0,
            1,
            0,
            0x12,
            1,
            3,
            0,
            1,
            0,
            0,
            0,
            orientation,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ];
        chunk(&mut output, b"EXIF", &exif);
        let riff_size = (output.len() - 8) as u32;
        output[4..8].copy_from_slice(&riff_size.to_le_bytes());
        output
    }

    #[test]
    fn thumbnail_webp_decode_preserves_orientation_alpha_and_dimensions() {
        // Odd dimensions catch rounding differences; all eight EXIF transforms are covered.
        let source = RgbaImage::from_fn(721, 479, |x, y| {
            Rgba([
                (x % 251) as u8,
                (y % 239) as u8,
                ((x + y) % 233) as u8,
                [0, 128, 255][(x / 241) as usize],
            ])
        });
        for lossless in [false, true] {
            let mut config = webp::WebPConfig::new().unwrap();
            config.lossless = i32::from(lossless);
            config.quality = 85.0;
            config.exact = 1;
            let bytes = webp::Encoder::from_rgba(source.as_raw(), 721, 479)
                .encode_advanced(&config)
                .unwrap();
            for orientation in 1..=8 {
                let bytes = with_orientation(&bytes, 721, 479, orientation);
                let actual = decode_webp(Cursor::new(&bytes)).unwrap();
                let expected = reference(&bytes);
                let rotated = orientation >= 5;
                assert_eq!(
                    (actual.width(), actual.height()),
                    if rotated { (479, 721) } else { (721, 479) }
                );
                assert_eq!(actual.as_bytes(), expected.as_bytes());
                let thumbnail = encode_thumbnail_webp(&actual).unwrap();
                assert_eq!(thumbnail, encode_thumbnail_webp(&expected).unwrap());
                let decoded = image::load_from_memory(&thumbnail).unwrap().to_rgba8();
                assert_eq!(
                    decoded.dimensions(),
                    if rotated { (239, 360) } else { (360, 239) }
                );
                let alpha: Vec<_> = decoded.pixels().map(|p| p[3]).collect();
                for value in [0, 128, 255] {
                    assert!(alpha.contains(&value));
                }
            }
        }
    }

    #[test]
    fn thumbnail_webp_decode_preserves_animated_first_frame() {
        let mut config = webp::WebPConfig::new().unwrap();
        config.lossless = 1;
        let mut encoder = webp::AnimEncoder::new(17, 13, &config);
        let first = RgbaImage::from_pixel(17, 13, Rgba([180, 60, 30, 128]));
        let second = RgbaImage::from_pixel(17, 13, Rgba([30, 60, 180, 255]));
        encoder.add_frame(webp::AnimFrame::from_rgba(first.as_raw(), 17, 13, 0));
        encoder.add_frame(webp::AnimFrame::from_rgba(second.as_raw(), 17, 13, 100));
        let bytes = encoder.encode();
        assert!(webp::BitstreamFeatures::new(&bytes)
            .unwrap()
            .has_animation());
        let actual = decode_webp(Cursor::new(&*bytes)).unwrap();
        let expected = reference(&bytes);
        assert_eq!(actual.as_bytes(), expected.as_bytes());
        assert_eq!(
            encode_thumbnail_webp(&actual).unwrap(),
            encode_thumbnail_webp(&expected).unwrap()
        );
    }

    #[test]
    fn thumbnail_webp_decode_rejects_truncated_input() {
        assert!(decode_webp(Cursor::new(b"RIFF\0\0\0\0WEBP")).is_err());
    }
}
