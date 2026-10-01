import unittest
from unittest.mock import patch
import numpy as np
from PIL import Image
import cover_focus as focus


class CoverFocusTests(unittest.TestCase):
    def setUp(self):
        self.image = Image.new("RGB", (400, 600))

    def detection(self, boxes, scores=None):
        return np.array(boxes, dtype=np.float32).reshape(-1, 4), np.array(scores or [0.9] * len(boxes), dtype=np.float32)

    def test_none_keeps_centre_fallback(self):
        with patch.object(focus, "_detect", return_value=self.detection([])):
            self.assertEqual(focus.cover_focus(None, self.image), (None, "none"))

    def test_close_up_keeps_box_centre_without_second_detector(self):
        with patch.object(focus, "_detect", return_value=self.detection([[0, 0, 400, 600]])) as detector:
            self.assertEqual(focus.cover_focus(None, self.image), (0.5, "close-up"))
            self.assertEqual(detector.call_count, 1)

    def test_head_uses_top_quarter(self):
        with patch.object(focus, "_detect", side_effect=[self.detection([[40, 40, 240, 540]]), self.detection([[10, 0, 70, 100]])]) as detector:
            value, method = focus.cover_focus(None, self.image)
            self.assertAlmostEqual(value, 0.2)
            self.assertEqual(method, "head")
            self.assertEqual(detector.call_args.args[1].size, (200, 140))

    def test_top_35_percent_then_body_fallback(self):
        person = self.detection([[40, 40, 240, 540]])
        with patch.object(focus, "_detect", side_effect=[person, self.detection([]), self.detection([[30, 0, 90, 100]])]):
            self.assertEqual(focus.cover_focus(None, self.image)[1], "head")
        with patch.object(focus, "_detect", side_effect=[person, self.detection([]), self.detection([])]):
            value, method = focus.cover_focus(None, self.image)
            self.assertAlmostEqual(value, 0.35)
            self.assertEqual(method, "body")

    def test_prominent_person_is_score_times_sqrt_area(self):
        boxes, scores = self.detection([[0, 0, 40, 40], [100, 0, 300, 500]], [0.99, 0.8])
        self.assertEqual(focus._best(boxes, scores, self.image.size)[0].tolist(), [100, 0, 300, 500])

    def test_cli_uses_only_frozen_detector_and_returns_json_without_writes(self):
        import contextlib
        import io
        import json
        import tempfile
        from pathlib import Path
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder) / "cover.png"
            self.image.save(image)
            before = image.read_bytes()
            expected = focus.runtime.BASELINE["sha256"]["character-detector.onnx"]
            opts = SimpleNamespace(intra_op_num_threads=0, inter_op_num_threads=0)
            output = io.StringIO()
            with patch("sys.argv", ["cover_focus.py", "--models", folder, "--image", str(image)]), patch.object(focus.runtime, "sha256", side_effect=[expected, "before", "before"]), patch("onnxruntime.SessionOptions", return_value=opts), patch("onnxruntime.InferenceSession") as session, patch.object(focus, "cover_focus", return_value=(0.25, "head")), contextlib.redirect_stdout(output):
                focus.main()
            self.assertEqual(json.loads(output.getvalue()), {"focusX": 0.25, "method": "head"})
            self.assertEqual(session.call_count, 1)
            self.assertEqual(Path(session.call_args.args[0]).name, "character-detector.onnx")
            self.assertEqual(image.read_bytes(), before)
            self.assertEqual(sorted(p.name for p in Path(folder).iterdir()), ["cover.png"])


if __name__ == "__main__":
    unittest.main()
