import hashlib
import json
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path

import numpy as np
from PIL import Image

import card_cutout


class FakeInput:
    name = "image"


class FakeOutput:
    name = "mask"


class FakeSession:
    """Stands in for the ONNX session: the mask is a filled disc in the middle."""

    def __init__(self, fail=False):
        self.calls, self.fail = [], fail

    def get_inputs(self):
        return [FakeInput()]

    def get_outputs(self):
        return [FakeOutput()]

    def run(self, names, feed):
        blob = feed["image"]
        self.calls.append(blob)
        if self.fail:
            raise RuntimeError("gpu lost")
        yy, xx = np.mgrid[:card_cutout.SIZE, :card_cutout.SIZE]
        radius = np.hypot(yy - 512, xx - 512)
        mask = np.clip((300 - radius) / 8.0, 0, 1).astype(np.float32)  # soft edge
        return [mask[None, None]]


class CardCutoutTests(unittest.TestCase):
    def setUp(self):
        # Python 3.14's Windows mkdtemp mode (0o700) prevents sandbox access.
        self.root = Path(tempfile.gettempdir()) / f"card-cutout-{uuid.uuid4().hex}"
        self.root.mkdir()
        self.addCleanup(shutil.rmtree, self.root)

    def source(self, size=(200, 300), background=(250, 250, 250), name="source.png"):
        image = Image.new("RGB", size, background)
        pixels = image.load()
        cx, cy = size[0] / 2, size[1] / 2
        for y in range(size[1]):
            for x in range(size[0]):
                if (x - cx) ** 2 + (y - cy) ** 2 < (min(size) * 0.3) ** 2:
                    pixels[x, y] = (200, 30, 40)
        path = self.root / name
        image.save(path)
        return path

    def test_preprocess_matches_the_model_contract(self):
        blob = card_cutout.preprocess(Image.new("RGB", (50, 80), (255, 255, 255)))
        self.assertEqual((blob.shape, blob.dtype), ((1, 3, 1024, 1024), np.float32))
        expected = (1.0 - card_cutout.MEAN) / card_cutout.STD
        np.testing.assert_allclose(blob[0, :, 10, 10], expected, rtol=1e-5)

    def test_mask_becomes_alpha_of_the_requested_size_and_bad_masks_are_rejected(self):
        mask = np.ones((1, 1, 1024, 1024), np.float32)
        alpha = card_cutout.mask_to_alpha(mask, (30, 20))
        self.assertEqual((alpha.shape, alpha.dtype, int(alpha.min())), ((20, 30), np.uint8, 255))
        for bad in (np.ones((1, 1, 8, 8), np.float32), np.full((1, 1, 1024, 1024), np.nan, np.float32)):
            with self.assertRaises(ValueError):
                card_cutout.mask_to_alpha(bad, (30, 20))

    def test_output_is_limited_to_1100_px(self):
        self.assertEqual(card_cutout.fit_size((2200, 1100)), (1100, 550))
        self.assertEqual(card_cutout.fit_size((300, 400)), (300, 400))

    def test_decontamination_removes_background_colour_at_the_edge_only(self):
        rgb = np.full((40, 40, 3), 255, np.uint8)
        alpha = np.zeros((40, 40), np.uint8)
        alpha[10:30, 10:30] = 255
        rgb[10:30, 10:30] = (200, 30, 40)
        # One soft edge column: 50 % red over the white page.
        alpha[10:30, 9] = 128
        rgb[10:30, 9] = (228, 142, 147)
        out = card_cutout.decontaminate(rgb, alpha)
        self.assertLess(int(out[20, 9, 1]), 60)          # the white fringe is gone
        np.testing.assert_array_equal(out[12:28, 12:28], rgb[12:28, 12:28])  # opaque inside untouched
        np.testing.assert_array_equal(out[0:5], rgb[0:5])  # background untouched

    def test_decontamination_never_changes_alpha_or_removes_inside_pixels(self):
        rgb = np.full((30, 30, 3), 255, np.uint8)
        alpha = np.full((30, 30), 90, np.uint8)  # a faint but real subject, far from any edge
        alpha[:3] = 0
        out = card_cutout.decontaminate(rgb, alpha)
        self.assertEqual(out.shape, rgb.shape)
        np.testing.assert_array_equal(out[10:20, 10:20], rgb[10:20, 10:20])  # not near the edge: unchanged

    def test_transparent_pixels_take_nearby_foreground_colour(self):
        rgb = np.zeros((20, 20, 3), np.uint8)
        alpha = np.zeros((20, 20), np.uint8)
        alpha[8:12, 8:12] = 255
        rgb[8:12, 8:12] = (10, 200, 30)
        out = card_cutout.fill_transparent(rgb, alpha)
        np.testing.assert_array_equal(out[9, 5], (10, 200, 30))
        np.testing.assert_array_equal(out[0, 0], (10, 200, 30))  # beyond the growth radius: mean colour
        np.testing.assert_array_equal(out[8:12, 8:12], rgb[8:12, 8:12])

    def test_encoding_is_webp_with_alpha_within_the_size_limit(self):
        rng = np.random.default_rng(1)
        noise = Image.fromarray(rng.integers(0, 255, (300, 300, 4), dtype=np.uint8), "RGBA")
        data, content_type, extension = card_cutout.encode(noise)
        self.assertEqual((content_type, extension), ("image/webp", "webp"))
        self.assertLessEqual(len(data), card_cutout.MAX_BYTES)
        import io
        self.assertEqual(Image.open(io.BytesIO(data)).mode, "RGBA")

    def test_cut_writes_a_cutout_with_alpha_and_reports_its_hash(self):
        cutter = card_cutout.Cutter(None, session=FakeSession(), provider_name="CPUExecutionProvider")
        reply = card_cutout.handle(cutter, {"type": "cutout", "id": "a1", "src": str(self.source()),
                                            "dstStem": str(self.root / "out" / "a1")})
        self.assertTrue(reply["ok"], reply)
        self.assertEqual((reply["id"], reply["contentType"], reply["width"], reply["height"]), ("a1", "image/webp", 200, 300))
        data = Path(reply["file"]).read_bytes()
        self.assertEqual((reply["sha256"], reply["sizeBytes"]), (hashlib.sha256(data).hexdigest(), len(data)))
        self.assertFalse(list((self.root / "out").glob("*.part")))
        image = Image.open(reply["file"])
        self.assertEqual(image.mode, "RGBA")
        self.assertEqual(image.getpixel((100, 150))[3], 255)  # inside the subject
        self.assertEqual(image.getpixel((2, 2))[3], 0)         # background

    def test_a_large_source_is_scaled_down(self):
        cutter = card_cutout.Cutter(None, session=FakeSession(), provider_name="CPUExecutionProvider")
        reply = card_cutout.handle(cutter, {"type": "cutout", "id": "big", "src": str(self.source((2400, 1200), name="big.png")),
                                            "dstStem": str(self.root / "big")})
        self.assertEqual((reply["ok"], reply["width"], reply["height"]), (True, 1100, 550))

    def test_failures_are_replies_not_crashes(self):
        cutter = card_cutout.Cutter(None, session=FakeSession(), provider_name="CPUExecutionProvider")
        broken = self.root / "broken.png"
        broken.write_bytes(b"not an image")
        reply = card_cutout.handle(cutter, {"type": "cutout", "id": "x", "src": str(broken), "dstStem": str(self.root / "x")})
        self.assertEqual((reply["ok"], reply["id"]), (False, "x"))
        self.assertFalse(card_cutout.handle(cutter, {"type": "other"})["ok"])
        failing = card_cutout.Cutter(None, session=FakeSession(fail=True), provider_name="CPUExecutionProvider")
        self.assertFalse(card_cutout.handle(failing, {"type": "cutout", "id": "y", "src": str(self.source()),
                                                      "dstStem": str(self.root / "y")})["ok"])

    def test_serve_speaks_ndjson_and_stops_on_shutdown(self):
        cutter = card_cutout.Cutter(None, session=FakeSession(), provider_name="CPUExecutionProvider")
        lines = [json.dumps({"type": "cutout", "id": "s1", "src": str(self.source()), "dstStem": str(self.root / "s1")}),
                 "garbage", json.dumps({"type": "shutdown"}), json.dumps({"type": "cutout", "id": "late"})]
        import contextlib
        import io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            card_cutout.serve(cutter, lines)
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual([r["type"] for r in replies], ["ready", "result", "result"])
        self.assertEqual((replies[0]["model"], replies[1]["ok"], replies[2]["ok"]), ("toonout-1", True, False))


if __name__ == "__main__":
    unittest.main()
