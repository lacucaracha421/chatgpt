"""Machine budgets change scheduling, never the extraction contract."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from character_encoder import SmallEncoder, extraction_digest, feature_id, SMALL_SHA256
from feature_cache import ReferenceBundles
from runtime import BASELINE
from scan_worker import runtime_arguments, configured_encoder


class PerformanceConfigTests(unittest.TestCase):
    def arguments(self, main=False):
        args = ["--models", "/fixture/models", "--cache", "/fixture/cache",
                "--augmentation-model", "/fixture/s36.onnx"]
        if main:
            args += ["--s36-intra-threads", "4", "--s36-inter-threads", "1",
                     "--reference-cache-bytes", str(128 * 1024 * 1024)]
        return runtime_arguments(args)

    def test_worker_arguments_reach_encoder_sessions_and_reference_cache(self):
        for main in (False, True):
            args = self.arguments(main)
            with patch("character_encoder.sha256", side_effect=[SMALL_SHA256, BASELINE["sha256"]["character-detector.onnx"]]), \
                    patch("character_encoder.ort.InferenceSession") as session:
                encoder = configured_encoder(args)
            opts = session.call_args.kwargs["sess_options"]
            self.assertEqual(opts.intra_op_num_threads, 4 if main else 2)
            self.assertEqual(opts.inter_op_num_threads, 1)
            self.assertEqual(opts.get_session_config_entry("session.intra_op.allow_spinning"), "0")
            self.assertEqual(session.call_args.kwargs["providers"], ["CPUExecutionProvider"])
            self.assertIs(encoder.options, opts)
            self.assertIsNone(encoder.detector)
            bundles = ReferenceBundles(None, max_bytes=args.reference_cache_bytes)
            self.assertEqual(bundles.max_bytes, (128 if main else 64) * 1024 * 1024)

    def test_pre_profile_s36_extraction_identity_is_preserved(self):
        self.assertEqual(extraction_digest(), "9dfab57dc3c81cbc0e7e9d6b4af6bba5ae4c5494633ef17f369d284683cb223c")
        source = Path(__file__).with_name("character_encoder.py").read_text()
        self.assertNotEqual(extraction_digest(source.replace('["CPUExecutionProvider"]', '["CUDAExecutionProvider"]')),
                            extraction_digest())
        self.assertNotEqual(extraction_digest(source.replace('ccip_input(view)', 'ccip_input(image)')),
                            extraction_digest())

    def test_invalid_budgets_are_rejected(self):
        with self.assertRaises(SystemExit):
            runtime_arguments(["--models", "/fixture", "--cache", "/fixture", "--s36-intra-threads", "0"])

    @unittest.skipUnless(os.environ.get("LAKOMICS_CHARACTER_TEST_MODELS"), "explicit read-only models required")
    def test_profiles_produce_equivalent_vectors_with_the_same_feature_identity(self):
        models = Path(os.environ["LAKOMICS_CHARACTER_TEST_MODELS"])
        identities, vectors = [], []
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "sample.png"
            Image.fromarray(np.random.default_rng(42).integers(0, 256, (96, 96, 3), dtype=np.uint8)).save(path)
            for threads in (2, 4):
                encoder = SmallEncoder(models / "augmentation/model_feat.onnx", models / "character-detector.onnx",
                                       intra_threads=threads, inter_threads=1)
                vectors.append(encoder.extract(path, boxes=[]).vectors)
                identities.append(feature_id())
        np.testing.assert_allclose(vectors[0], vectors[1], rtol=1e-5, atol=1e-6)
        self.assertEqual(identities[0], identities[1])
