"""Synthetic crop policy tests; no models, library or image outputs."""
import unittest

import numpy as np

from crop_policy_eval import (POLICIES, Policy, containment_merge, decode_raw,
                              derive, dropped_match, expand, locate, walk_forward_acceptances)
import replay_eval as replay
from runtime import decode, expanded_box


class CropPolicyTests(unittest.TestCase):
    def test_shared_locate_verifies_unique_content_without_writes(self):
        import hashlib
        from pathlib import Path
        import tempfile
        from replay_dataset import locate as shared_locate
        self.assertIs(locate, shared_locate)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            content = b'fixture asset bytes'
            h = hashlib.sha256(content).hexdigest()
            folder = root / 'assets' / h[:2]
            folder.mkdir(parents=True)
            path = folder / (h + '.png')
            path.write_bytes(content)
            self.assertEqual(locate(root, [h]), ({h: path}, {}))
            self.assertEqual(path.read_bytes(), content)
            other = folder / (h + '.jpg')
            other.write_bytes(content)
            self.assertEqual(locate(root, [h])[1][h], 'canonical_asset_path_candidates=2')
            other.unlink()
            path.write_bytes(b'changed')
            self.assertEqual(locate(root, [h])[1][h], 'source_hash_mismatch')

    def test_fragment_and_score_filters(self):
        boxes = [[50, 50, 90, 500], [200, 100, 400, 800], [500, 100, 750, 700]]
        value = derive(boxes, [.9, .6, .35], (1000, 1000), POLICIES[1])
        self.assertEqual(value["ids"], [1])
        self.assertEqual(derive(boxes[:1], [.9], (1000, 1000), POLICIES[1])["fallback"], True)

    def test_containment_prefers_larger_but_group_preserves_children(self):
        nested = [[0, 0, 100, 200], [10, 10, 60, 80]]
        self.assertEqual(containment_merge(nested, [1, 0]), [0])
        group = [[0, 0, 200, 200], [0, 0, 75, 190], [125, 0, 200, 190]]
        self.assertEqual(containment_merge(group, [0, 1, 2]), [1, 2])

    def test_asymmetric_margin_and_clipping(self):
        self.assertEqual(expand([100, 100, 200, 300], (500, 500), True), (82, 40, 218, 320))
        self.assertEqual(expand([0, 0, 100, 200], (100, 200), True), (0, 0, 100, 200))

    def test_prominence_preserves_equal_group_and_boundary(self):
        boxes = [[0, 0, 100, 100], [200, 0, 300, 100], [400, 0, 450, 50], [600, 0, 640, 40]]
        p = Policy("test", prominence=.25)
        self.assertEqual(set(derive(boxes, [.9, .8, .7, .6], (1000, 1000), p)["ids"]), {0, 1, 2})

    def test_prominence_cost_includes_newly_admitted_kept_crop(self):
        self.assertFalse(dropped_match([0, 1], [1, 2], [.1, .4], [.4, .05], .2))
        self.assertTrue(dropped_match([0, 1], [1, 2], [.1, .4], [.4, .5], .2))
        self.assertFalse(dropped_match([0, 1], [1], [.1, .4], [.4], None))

    def test_paired_decisions_match_replay_metrics(self):
        rows = []
        for sequence, day, label, score, status in [
                (1, 1, 0, .2, "available"), (2, 2, 1, .1, "available"),
                (3, 2, 0, .3, "available"), (4, 3, 1, None, "fallback")]:
            when = f"2026-09-{day:02}T12:00:00Z"
            rows.append(dict(sequence=sequence, time=replay.time_ns(when), created_at=when,
                             label=label, scores={"knn3": score}, feature_status=status, target_id="t"))
        accepted = walk_forward_acceptances(rows)
        self.assertEqual(accepted, {2})
        metric = replay.metrics([r for r in rows if r["feature_status"] == "available"], "knn3", 1)
        self.assertEqual(metric["walk_forward"]["0.02"]["tp"], len(accepted))

    def test_low_floor_decoder_and_p0_production_parity(self):
        output = np.zeros((1, 8400, 6), dtype=np.float32)
        output[0, :, 2:4] = 2
        for i, score in [(1010, .6), (1011, .5), (2040, .2), (5100, .8)]:
            output[0, i, 4:] = [score, 1]
        boxes, scores = decode_raw(output, (640, 640), 1)
        self.assertEqual(len(boxes), 4)
        production, confidence = decode(output, (640, 640), 1)
        expected = [expanded_box(production[i], (640, 640)) for i in np.argsort(confidence)[::-1][:8]]
        expected = [list(b) for b in expected if min(b[2]-b[0], b[3]-b[1]) >= 24]
        self.assertEqual(derive(boxes, scores, (640, 640), POLICIES[0])["boxes"], expected)


if __name__ == "__main__":
    unittest.main()
