import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

import numpy as np

from character_augmentation import S36FeatureCache
from character_encoder import feature_id
from feature_cache import extraction_fingerprint
from replay_eval import Features, Replay, duplicate_groups, time_ns
from s36_shadow import handle, score
from holdout_rules import current_policy


def feature(h, *axes):
    vectors = np.zeros((len(axes), 768), dtype=np.float32)
    for i, axis in enumerate(axes):
        vectors[i, axis] = 1
    return Features(h, [(i*20, 0, i*20+16, 16) for i in range(len(axes))], vectors, False)


def dataset():
    return {"targets": [{"id": "t", "series_id": "s", "enabled": True}],
            "references": [{"target_id": "t", "asset_hash": "a"*64, "kind": "anchor"}],
            "regions": [], "decisions": [], "images": {}, "policy": current_policy()}


class ShadowTests(unittest.TestCase):
    def test_matches_calibration_witness_one_vote_per_image_and_knn3(self):
        data = dataset()
        data["decisions"] = [{"sequence": 1, "target_id": "t", "asset_hash": "b"*64,
                              "decision": "accepted", "origin": "manual", "created_at": "2026-01-01T00:00:00Z"}]
        features = {"a"*64: feature("a"*64, 0), "b"*64: feature("b"*64, 1, 0),
                    "c"*64: feature("c"*64, 1, 0)}
        now = time_ns("2026-02-01T00:00:00Z")
        self.assertAlmostEqual(score(data, features, "c"*64, now)["t"], 0)
        replay = Replay(data, features, duplicate_groups({})[0], lag=0, witness="references")
        event = {**data["decisions"][0], "time": time_ns(data["decisions"][0]["created_at"])}
        replay.run([], [event]); replay.release(now)
        self.assertEqual(score(data, features, "c"*64, now)["t"], replay.query("t", "c"*64, now)[0]["knn3"])
        # Automatic acceptances cannot add votes.
        data["decisions"][0]["origin"] = "automatic"
        self.assertEqual(score(data, features, "b"*64, now)["t"], 0)

    def test_same_post_transitive_pdq_groups_excluded_and_empty_abstains(self):
        data = dataset()
        data["images"] = {"a"*64: {"pdq": ["0"*64], "source_urls": []},
                          "b"*64: {"pdq": ["0"*64], "source_urls": ["https://x.com/a/status/123"]},
                          "c"*64: {"pdq": [], "source_urls": ["https://x.com/b/status/123/photo/1"]}}
        features = {"a"*64: feature("a"*64, 0), "c"*64: feature("c"*64, 0)}
        self.assertIsNone(score(data, features, "c"*64, time_ns("2026-02-01T00:00:00Z"))["t"])
        self.assertIsNone(score(dataset(), {}, "c"*64, time_ns("2026-02-01T00:00:00Z"))["t"])

    def test_manual_rejection_clear_and_future_labels_do_not_supply_positive_votes(self):
        for decision in ("rejected", "cleared"):
            data = dataset()
            data["decisions"] = [{"sequence": 1, "target_id": "t", "asset_hash": "a"*64,
                                  "decision": decision, "origin": "manual", "created_at": "2026-01-01T00:00:00Z"}]
            features = {"a"*64: feature("a"*64, 0), "c"*64: feature("c"*64, 0)}
            self.assertIsNone(score(data, features, "c"*64, time_ns("2026-02-01T00:00:00Z"))["t"])
            self.assertEqual(score(data, features, "c"*64, time_ns("2025-01-01T00:00:00Z"))["t"], 0)

    def test_worker_protocol_cache_extraction_reuse_fallback_and_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "image.png"; path.write_bytes(b"fixture-source")
            h = hashlib.sha256(path.read_bytes()).hexdigest()
            cache = root / ".cache/characters"
            b36 = cache / extraction_fingerprint(); b36.mkdir(parents=True)
            base = feature(h, 0)
            np.savez(b36 / (h+".npz"), content_hash=h, boxes=np.asarray(base.boxes), vectors=base.vectors, fallback=False)
            encoder = Mock(); encoder.extract.return_value = base
            model = SimpleNamespace(cache_root=cache, encoder_for=Mock(return_value=encoder))
            S36FeatureCache(cache, cleanup=False).write(feature("a"*64, 0))
            snapshot = root / "snapshot.json"; snapshot.write_text(json.dumps(dataset()))
            request = {"featureId": feature_id(), "targets": ["t"], "snapshotPath": str(snapshot),
                       "assetId": "asset", "hash": h, "path": str(path), "mediaKind": "image", "scoredAt": "2026-02-01T00:00:00Z"}
            with patch("replay_eval.current_policy", side_effect=AssertionError("packaged runtime has no Rust sources")):
                first = handle(model, request)
            self.assertEqual(first["type"], "s36_shadow_result")
            self.assertEqual(first["scores"], {"t": 0.0})
            self.assertEqual(handle(model, request), first)
            encoder.extract.assert_called_once()
            model.encoder_for.assert_called_once()
            with self.assertRaisesRegex(ValueError, "identity"):
                handle(model, {**request, "featureId": "f"*64})
            with self.assertRaisesRegex(ValueError, "roster"):
                handle(model, {**request, "targets": ["foreign"]})
            self.assertIsNone(handle(model, {**request, "mediaKind": "video"})["scores"]["t"])
            np.savez(b36 / (h+".npz"), content_hash=h, boxes=np.empty((0,4),dtype=np.int32), vectors=base.vectors, fallback=True)
            self.assertIsNone(handle(model, request)["scores"]["t"])
            # The complete request never opens any database.
            with patch("sqlite3.connect", side_effect=AssertionError("DB forbidden")):
                handle(model, request)

    def test_scan_worker_dispatch_keeps_native_query_after_shadow_failure(self):
        import scan_worker
        for fail in (False, True):
            cache = Mock(hits=0, misses=0)
            cache.extract.return_value = feature("c"*64, 0)
            inbox = Mock()
            inbox.get.side_effect = [json.dumps({"type": "s36_shadow"}),
                                     json.dumps({"type": "load_query", "assetId": "q", "hash": "c"*64, "path": "/fixture/image"}),
                                     KeyboardInterrupt()]
            response = {"type": "s36_shadow_result", "scores": {"t": 0.1}}
            with patch.object(scan_worker.sys, "argv", ["scan_worker.py", "--models", "/fixture/models", "--cache", "/fixture/cache", "--augmentation-model", "/fixture/s36"]), \
                 patch.object(scan_worker.sys, "stdin", Mock()), \
                 patch.object(scan_worker.threading, "Thread"), \
                 patch.object(scan_worker.queue, "Queue", return_value=inbox), \
                 patch.object(scan_worker, "Runtime"), \
                 patch.object(scan_worker, "FeatureCache", return_value=cache), \
                 patch.object(scan_worker, "emit") as emit, \
                 patch("character_augmentation.augmenter", return_value=(Mock(), None)), \
                 patch("s36_shadow.handle", side_effect=ValueError("fixture failure") if fail else None, return_value=response):
                with self.assertRaises(KeyboardInterrupt):
                    scan_worker.main()
            messages = [call.args[0] for call in emit.call_args_list]
            self.assertEqual(messages[0]["type"], "ready")
            self.assertEqual(messages[1]["type"], "s36_shadow_unavailable" if fail else "s36_shadow_result")
            self.assertEqual(messages[2]["type"], "query_loaded")
            self.assertEqual(messages[2]["contentHash"], "c"*64)

    def test_cancel_control_is_consumed_without_becoming_a_native_request(self):
        import io
        import queue
        import threading
        import scan_worker
        inbox, cancel = queue.Queue(), threading.Event()
        lines = io.StringIO('{"type":"s36_shadow"}\n{"type":"s36_shadow_cancel"}\n')
        with patch.object(scan_worker.sys, "stdin", lines), \
             patch.object(scan_worker.os, "_exit", side_effect=EOFError):
            with self.assertRaises(EOFError):
                scan_worker.read_requests(inbox, cancel)
        self.assertTrue(cancel.is_set())
        self.assertEqual(inbox.qsize(), 1)
        self.assertEqual(json.loads(inbox.get())["type"], "s36_shadow")
        with self.assertRaisesRegex(ValueError, "preempted"):
            handle(Mock(), {}, cancelled=cancel.is_set)

    def test_feature_identity_still_matches_pinned_policy(self):
        policy = json.loads(Path(__file__).with_name("s36_policy.json").read_text())
        self.assertEqual(feature_id(), policy["feature_id"])

    def test_multi_person_manual_witness_without_references_abstains(self):
        data = dataset(); data["references"] = []
        data["decisions"] = [{"sequence": 1, "target_id": "t", "asset_hash": "b"*64,
                              "decision": "accepted", "origin": "manual", "created_at": "2026-01-01T00:00:00Z"}]
        features = {"b"*64: feature("b"*64, 0, 1), "c"*64: feature("c"*64, 0)}
        self.assertIsNone(score(data, features, "c"*64, time_ns("2026-02-01T00:00:00Z"))["t"])


if __name__ == "__main__":
    unittest.main()
