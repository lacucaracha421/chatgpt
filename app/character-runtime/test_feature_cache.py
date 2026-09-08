from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from feature_cache import FeatureCache, runtime_fingerprint
from runtime import Features, sha256


class FakeEngine:
    def __init__(self):
        self.calls = 0

    def extract(self, path):
        self.calls += 1
        return Features(sha256(path), [(0, 0, 24, 24)], np.ones((1, 768), np.float32), False)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "image.png"
        Image.new("RGB", (32, 32), "blue").save(self.source)
        self.digest = sha256(self.source)
        self.engine = FakeEngine()
        self.cache = FeatureCache(self.root / "cache", self.engine, "version-a")

    def test_restart_reuses_exact_features_without_inference(self):
        cold = self.cache.extract(self.source, self.digest)
        (self.cache.root / "interrupted.part").write_bytes(b"partial")
        warm = FeatureCache(self.root / "cache", self.engine, "version-a")
        hit = warm.extract(self.source, self.digest)
        np.testing.assert_array_equal(cold.vectors, hit.vectors)
        self.assertEqual(cold.boxes, hit.boxes)
        self.assertEqual((warm.hits, warm.misses, self.engine.calls), (1, 0, 1))
        self.assertFalse(list(self.cache.root.glob("*.part")))

    def test_changed_content_is_not_a_hit_and_metadata_mismatch_fails(self):
        self.cache.extract(self.source, self.digest)
        Image.new("RGB", (32, 32), "red").save(self.source)
        with self.assertRaisesRegex(ValueError, "metadata"):
            self.cache.extract(self.source, self.digest)
        self.cache.extract(self.source, sha256(self.source))
        self.assertEqual(self.engine.calls, 2)

    def test_runtime_namespace_change_invalidates_features(self):
        self.cache.extract(self.source, self.digest)
        changed = FeatureCache(self.root / "cache", self.engine, "version-b")
        changed.extract(self.source, self.digest)
        self.assertEqual(self.engine.calls, 2)
        self.assertEqual(len(runtime_fingerprint()), 64)

    def test_corrupt_and_nonfinite_entries_recompute(self):
        self.cache.extract(self.source, self.digest)
        entry = self.cache.root / (self.digest + ".npz")
        entry.write_bytes(b"interrupted cache write")
        self.cache.extract(self.source, self.digest)
        np.savez(entry, vectors=np.full((1, 768), np.nan, np.float32),
                 content_hash=self.digest, boxes=np.array([[0, 0, 24, 24]]), fallback=False)
        self.cache.extract(self.source, self.digest)
        self.assertEqual(self.engine.calls, 3)

    def test_pixel_and_byte_limits_reject_before_inference(self):
        with patch("feature_cache.MAX_PIXELS", 100):
            with self.assertRaisesRegex(ValueError, "pixel"):
                self.cache.extract(self.source, self.digest)
        with patch("feature_cache.MAX_FILE_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "byte"):
                self.cache.extract(self.source, self.digest)
        self.assertEqual(self.engine.calls, 0)

    def test_atomic_publish_failure_leaves_no_partial_entry(self):
        with patch("feature_cache.os.replace", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                self.cache.extract(self.source, self.digest)
        self.assertFalse(list(self.cache.root.iterdir()))

class ExtractionIdentityTests(unittest.TestCase):
    def test_comparison_changes_keep_features_but_extraction_changes_invalidate(self):
        import copy
        from feature_cache import extraction_fingerprint
        from runtime import BASELINE
        source = Path(__file__).with_name('runtime.py').read_text()
        original = extraction_fingerprint(source)
        policy = copy.deepcopy(BASELINE)
        policy['threshold'] = 0.01
        policy['required_references'] = 4
        policy['sha256']['model_metrics.onnx'] = 'changed-metric'
        self.assertEqual(original, extraction_fingerprint(source.replace('second = np.sort(per_ref, axis=1)', 'second = np.sort(per_ref + 0, axis=1)'), policy))
        policy['sha256']['model_feat.onnx'] = 'changed-features'
        self.assertNotEqual(original, extraction_fingerprint(source, policy))
        self.assertNotEqual(original, extraction_fingerprint(source.replace('(384, 384)', '(383, 383)')))

    def test_verified_legacy_cache_reuse_avoids_inference_and_unknown_caches_do_not(self):
        from feature_cache import extraction_fingerprint, compatible_feature_caches
        import json
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); image=root/'input.png';Image.new('RGB',(32,32),'red').save(image)
            engine=FakeEngine(); old='a'*64; current=extraction_fingerprint()
            FeatureCache(root/'cache',engine,old).extract(image,sha256(image))
            (root/'cache-compatibility.json').write_text(json.dumps({current:[old,'../../bad']}))
            aliases=compatible_feature_caches(root,current)
            self.assertEqual(aliases,[old])
            new=FeatureCache(root/'cache',engine,current,aliases)
            new.extract(image,sha256(image))
            self.assertEqual((new.hits,new.misses,engine.calls),(1,0,1))
            changed=FeatureCache(root/'cache',engine,'b'*64,compatible_feature_caches(root,'b'*64))
            changed.extract(image,sha256(image))
            self.assertEqual(engine.calls,2)
