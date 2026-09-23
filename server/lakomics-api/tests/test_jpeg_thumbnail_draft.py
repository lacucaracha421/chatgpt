"""JPEG reduced-decoder regressions using generated, non-library sources only."""
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import warnings

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import head_cache
import image_thumbnail_encode as encoder
import image_thumbnails as worker

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFile, ImageStat, JpegImagePlugin
except ImportError:
    Image = None


def jpeg(size=(4099, 2053), orientation=1, mode="RGB", progressive=False):
    image = Image.new("RGB", size, (230, 30, 20))
    draw = ImageDraw.Draw(image)
    w, h = size
    draw.rectangle((w // 2, 0, w, h // 2), fill=(20, 210, 40))
    draw.rectangle((0, h // 2, w // 2, h), fill=(20, 40, 230))
    draw.rectangle((w // 2, h // 2, w, h), fill=(240, 220, 20))
    exif = Image.Exif()
    exif[274] = orientation
    sink = io.BytesIO()
    image.convert(mode).save(sink, "JPEG", quality=95, exif=exif, progressive=progressive)
    return sink.getvalue()


def decode(payload):
    with Image.open(io.BytesIO(payload)) as image:
        image.load()
        return image.copy()


@unittest.skipIf(Image is None, "Pillow unavailable")
class JpegDraftTests(unittest.TestCase):
    def setUp(self):
        # The production encoder is isolated; preserve its process-global settings
        # when exercising the same functions in this unittest process.
        self.enterContext(warnings.catch_warnings())
        self.enterContext(mock.patch.object(Image, "MAX_IMAGE_PIXELS", Image.MAX_IMAGE_PIXELS))
        self.enterContext(mock.patch.object(ImageFile, "LOAD_TRUNCATED_IMAGES", False))

    def encode(self, source, kind="image"):
        return encoder._still_thumbnail(io.BytesIO(source), kind)

    def full_decode(self, source, kind="image"):
        with mock.patch.object(JpegImagePlugin.JpegImageFile, "draft", return_value=None):
            return self.encode(source, kind)

    def test_real_decoder_is_reduced_before_load_including_progressive(self):
        real_load = JpegImagePlugin.JpegImageFile.load
        for progressive in (False, True):
            with self.subTest(progressive=progressive):
                source = jpeg(progressive=progressive)
                decoded = []

                def load(image):
                    if image.tile:
                        configured = image.decoderconfig
                        result = real_load(image)
                        decoded.append((image.size, configured))
                        return result
                    return real_load(image)

                with mock.patch.object(JpegImagePlugin.JpegImageFile, "load", load):
                    payload, metadata = self.encode(source)
                self.assertEqual(len(decoded), 1)
                self.assertEqual(decoded[0][0], (1025, 514))
                self.assertEqual(decoded[0][1][0], 4)  # libjpeg's decoder scale, not a later resize
                self.assertEqual(decode(payload).size, (512, 256))
                self.assertEqual(metadata, {"width": 4099, "height": 2053, "duration_ms": None})

    def test_all_exif_pixel_transforms_keep_original_odd_geometry_and_fractional_box(self):
        # TL/TR/BL/BR indices after each EXIF transform, independent of ImageOps.
        corners = {1: (0, 1, 2, 3), 2: (1, 0, 3, 2), 3: (3, 2, 1, 0),
                   4: (2, 3, 0, 1), 5: (0, 2, 1, 3), 6: (2, 0, 3, 1),
                   7: (3, 1, 2, 0), 8: (1, 3, 0, 2)}
        colors = ((230, 30, 20), (20, 210, 40), (20, 40, 230), (240, 220, 20))
        boxes = {1: (0, 0, 1024.75, 513.25), 2: (0.25, 0, 1025, 513.25),
                 3: (0.25, 0.75, 1025, 514), 4: (0, 0.75, 1024.75, 514),
                 5: (0, 0, 513.25, 1024.75), 6: (0.75, 0, 514, 1024.75),
                 7: (0.75, 0.25, 514, 1025), 8: (0, 0.25, 513.25, 1025)}
        for orientation in range(1, 9):
            with self.subTest(orientation=orientation):
                with mock.patch.object(encoder, "_scaled", wraps=encoder._scaled) as scaled:
                    payload, metadata = self.encode(jpeg(orientation=orientation))
                tile = decode(payload)
                expected_source = (2053, 4099) if orientation >= 5 else (4099, 2053)
                self.assertEqual((metadata["width"], metadata["height"]), expected_source)
                self.assertEqual(tile.size, (256, 512) if orientation >= 5 else (512, 256))
                self.assertEqual(scaled.call_args.args[2], boxes[orientation])
                self.assertNotIn(274, tile.getexif())
                points = ((tile.width // 4, tile.height // 4),
                          (tile.width * 3 // 4, tile.height // 4),
                          (tile.width // 4, tile.height * 3 // 4),
                          (tile.width * 3 // 4, tile.height * 3 // 4))
                for point, index in zip(points, corners[orientation]):
                    for actual, expected in zip(tile.getpixel(point), colors[index]):
                        self.assertLess(abs(actual - expected), 12)

    def test_odd_sharp_lines_do_not_resize_draft_padding_into_content(self):
        image = Image.new("RGB", (4097, 3001), "white")
        draw = ImageDraw.Draw(image)
        for x in range(0, image.width, 19):
            draw.line((x, 0, x, image.height), fill="black", width=3)
        source = io.BytesIO()
        image.save(source, "JPEG", quality=93)
        full = decode(self.full_decode(source.getvalue())[0]).convert("RGB")
        reduced = decode(self.encode(source.getvalue())[0]).convert("RGB")
        error = ImageStat.Stat(ImageChops.difference(full, reduced))
        # A focused pixel-alignment regression, not a perceptual quality gate.
        self.assertLess(sum(error.mean) / 3, 8)

    def test_original_budget_rejects_before_draft_or_load(self):
        source = bytearray(jpeg(size=(32, 16)))
        sof = source.index(b"\xff\xc0")
        source[sof + 5:sof + 9] = (5000).to_bytes(2, "big") * 2
        for disable_pillow_guard in (False, True):
            with self.subTest(disable_pillow_guard=disable_pillow_guard):
                # Also exercise the explicit budget guard without Pillow's own guard.
                with mock.patch.object(Image, "_decompression_bomb_check",
                                       wraps=None if disable_pillow_guard else Image._decompression_bomb_check), \
                     mock.patch.object(JpegImagePlugin.JpegImageFile, "draft") as draft, \
                     mock.patch.object(JpegImagePlugin.JpegImageFile, "load") as load:
                    with self.assertRaises(encoder._UnsupportedInput):
                        self.encode(source)
                    draft.assert_not_called()
                    load.assert_not_called()

    def test_truncated_jpeg_is_strict_even_when_pillow_global_was_permissive(self):
        source = jpeg()
        for truncated in (source[:-2], source[:len(source) // 2]):
            with self.subTest(length=len(truncated)):
                ImageFile.LOAD_TRUNCATED_IMAGES = True
                with self.assertRaises(encoder._UnsupportedInput):
                    self.encode(truncated)
                self.assertFalse(ImageFile.LOAD_TRUNCATED_IMAGES)

    def test_small_and_thin_jpeg_geometry_never_upscales(self):
        for size in ((121, 91), (1, 1), (1, 4099), (4099, 1)):
            with self.subTest(size=size):
                source = jpeg(size=size, orientation=6)
                payload, metadata = self.encode(source)
                self.assertEqual((metadata["width"], metadata["height"]), size[::-1])
                scale = min(1, 512 / max(size))
                expected = tuple(max(1, round(edge * scale)) for edge in size[::-1])
                self.assertEqual(decode(payload).size, expected)
                if max(size) <= 512:
                    baseline, _ = self.full_decode(source)
                    self.assertEqual(payload, baseline)
                    self.assertEqual(decode(payload).size, size[::-1])

    def test_real_child_publishes_original_dimensions_and_rejects_truncation_atomically(self):
        for truncated in (False, True):
            with self.subTest(truncated=truncated), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "source"
                output = Path(directory) / "tile.webp"
                payload = jpeg(orientation=6)
                source.write_bytes(payload[:-2] if truncated else payload)
                completed = subprocess.run(
                    [sys.executable, encoder.__file__, str(source), str(output), "image"],
                    capture_output=True, timeout=20, check=False)
                sidecar = Path(str(output) + ".json")
                if truncated:
                    self.assertEqual(completed.returncode, encoder.EXIT_UNSUPPORTED_INPUT)
                    self.assertEqual(list(Path(directory).iterdir()), [source])
                else:
                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    self.assertEqual(json.loads(sidecar.read_text()),
                                     {"width": 2053, "height": 4099, "duration_ms": None})
                    self.assertEqual(decode(output.read_bytes()).size, (256, 512))

    def test_grayscale_and_cmyk_color_are_not_changed_to_another_decoder_mode(self):
        for mode in ("L", "CMYK"):
            with self.subTest(mode=mode):
                source = jpeg(mode=mode)
                full, _ = self.full_decode(source)
                payload, _ = self.encode(source)
                actual, expected = decode(payload).convert("RGB"), decode(full).convert("RGB")
                error = ImageStat.Stat(ImageChops.difference(actual, expected))
                self.assertLess(sum(error.mean) / 3, 2)

    def test_non_jpeg_bytes_and_transparency_match_original_pipeline(self):
        for mode, format_name, kind in (("RGBA", "PNG", "image"), ("LA", "PNG", "image"),
                                        ("P", "PNG", "image"), ("RGBA", "WEBP", "image"),
                                        ("P", "GIF", "gif")):
            with self.subTest(mode=mode, format=format_name):
                image = Image.new("RGBA", (801, 603), (255, 0, 0, 0))
                image.paste((30, 200, 60, 255), (0, 0, 400, 603))
                image = image.convert(mode)
                if mode == "P":
                    image.info["transparency"] = 0
                source = io.BytesIO()
                image.save(source, format_name)
                with Image.open(io.BytesIO(source.getvalue())) as original:
                    original.load()
                    frame = encoder._transposed(original)
                    reference = encoder._scaled(frame)
                    sink = io.BytesIO()
                    reference.save(sink, "WEBP", quality=encoder.WEBP_QUALITY, method=encoder.WEBP_METHOD)
                with mock.patch.object(Image.Image, "draft", side_effect=AssertionError("non-JPEG draft")):
                    payload, metadata = self.encode(source.getvalue(), kind)
                self.assertEqual(payload, sink.getvalue())
                self.assertEqual(metadata, {"width": 801, "height": 603, "duration_ms": None})
                self.assertEqual(decode(payload).getchannel("A").getextrema(), (0, 255))


class RecipeTests(unittest.TestCase):
    def test_new_image_recipe_changes_but_gif_and_video_do_not(self):
        digest = "a" * 64
        self.assertEqual(worker.derived_key(digest), f"derived/image-thumbnails/v2/{digest}.webp")
        self.assertEqual(worker.derived_key(digest, "gif"), f"derived/media-thumbnails/v1/gif/{digest}.webp")
        self.assertEqual(worker.derived_key(digest, "video"), f"derived/media-thumbnails/v2/video/{digest}.webp")

    def test_head_cache_reuses_old_and_new_images_but_not_unknown_recipes(self):
        storage = mock.Mock()
        storage.meta.endpoint_url = "https://fixture.invalid"
        storage.head_object.return_value = {"ContentType": "image/webp", "ContentLength": 42}
        cache = head_cache.HeadMetadataCache()
        for version, expected_calls in (("v1", 1), ("v2", 1), ("v3", 2), ("v12", 2)):
            with self.subTest(version=version):
                storage.head_object.reset_mock()
                key = f"derived/image-thumbnails/{version}/" + "a" * 64 + ".webp"
                for _ in range(2):
                    cache.head(storage, "fixture", key, identity=("same",))
                self.assertEqual(storage.head_object.call_count, expected_calls)


if __name__ == "__main__":
    unittest.main()
