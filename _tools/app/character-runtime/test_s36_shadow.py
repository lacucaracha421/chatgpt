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
from s36_shadow import handle, score, score_batch, GalleryFeatures, MAX_BATCH_QUERIES
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

    def test_cached_only_validates_missing_corrupt_fallback_without_inference(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cache = S36FeatureCache(root / "cache", cleanup=False)
            snapshot = root / "snapshot.json"; snapshot.write_text(json.dumps(dataset()))
            model = SimpleNamespace(cache_root=root / "cache", encoder_for=Mock(side_effect=AssertionError("inference forbidden")))
            request = {"cachedOnly": True, "featureId": feature_id(), "targets": ["t"],
                       "snapshotPath": str(snapshot), "assetId": "q", "hash": "c"*64,
                       "mediaKind": "image", "scoredAt": "2026-02-01T00:00:00Z"}
            cache.write(feature("a"*64, 0))
            with patch("s36_shadow.extract_query", side_effect=AssertionError("extraction forbidden")):
                self.assertFalse(handle(model, request)["queryAvailable"])
                cache.path("c"*64).write_bytes(b"corrupt")
                self.assertFalse(handle(model, request)["queryAvailable"])
                fallback = feature("c"*64, 0); fallback.fallback = True; fallback.boxes = []
                cache.write(fallback)
                self.assertFalse(handle(model, request)["queryAvailable"])
                cache.write(feature("c"*64, 0))
                with patch.object(S36FeatureCache, "write", side_effect=AssertionError("cache writes forbidden")):
                    result = handle(model, request)
                self.assertTrue(result["queryAvailable"])
                self.assertEqual(result["scores"], {"t": 0.0})
            model.encoder_for.assert_not_called()

    def test_group_cache_reused_and_invalidated_by_uncached_bridge_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); cache = S36FeatureCache(root / "cache", cleanup=False)
            for h in ("a"*64, "c"*64):
                cache.write(feature(h, 0))
            model = SimpleNamespace(cache_root=root / "cache")
            snapshot = root / "snapshot.json"; data = dataset()
            snapshot.write_text(json.dumps(data))
            request = {"cachedOnly": True, "featureId": feature_id(), "targets": ["t"],
                       "snapshotPath": str(snapshot), "assetId": "q", "hash": "c"*64,
                       "mediaKind": "image", "scoredAt": "2026-02-01T00:00:00Z"}
            with patch("replay_eval.duplicate_groups", wraps=duplicate_groups) as groups:
                self.assertEqual(handle(model, request)["scores"]["t"], 0)
                self.assertEqual(handle(model, request)["scores"]["t"], 0)
                self.assertEqual(groups.call_count, 1)
                data["images"] = {"a"*64: {"pdq": [], "source_urls": ["https://x.com/a/status/1"]},
                                  "b"*64: {"pdq": ["0"*64], "source_urls": ["https://x.com/b/status/1/photo/2"]},
                                  "c"*64: {"pdq": ["0"*63+"1"], "source_urls": []}}
                snapshot.write_text(json.dumps(data))
                self.assertIsNone(handle(model, request)["scores"]["t"])
                self.assertEqual(groups.call_count, 2)
                with self.assertRaisesRegex(ValueError, "preempted"):
                    handle(model, request, cancelled=lambda: True)

    def test_batch_exact_equivalence_with_temporal_witnesses_and_duplicate_groups(self):
        from s36_scoring import unit
        from runtime import FINGERPRINT
        data = dataset()
        data["targets"] += [{"id": "u", "series_id": "s", "enabled": True},
                            {"id": "future", "series_id": "s", "enabled": True,
                             "created_at": "2027-01-01T00:00:00Z"}]
        hashes = [hashlib.sha256(str(i).encode()).hexdigest() for i in range(20)]
        rng = np.random.default_rng(13)
        features = {}
        for i, h in enumerate(hashes[:-1]):
            f = feature(h, *range(1 + i % 3))
            # Nontrivial float32 scores, including multi-person references.
            f.vectors = unit(rng.normal(size=f.vectors.shape).astype(np.float32))
            features[h] = f
        features[hashes[18]].fallback = True
        data["references"] = [
            {"target_id": t, "asset_hash": hashes[i], "kind": "anchor"}
            for t in ("t", "u") for i in range(4)]
        data["references"] += [{"target_id": "t", "asset_hash": hashes[4], "kind": "learned",
                                "created_at": "2026-01-04T00:00:00Z"}]
        data["regions"] = [{"target_id": "u", "asset_hash": hashes[1],
                            "baseline_fingerprint": FINGERPRINT, "bounds": list(features[hashes[1]].boxes[1])}]
        data["decisions"] = [
            {"sequence": i + 1, "target_id": "t" if i % 2 else "u", "asset_hash": hashes[h],
             "decision": decision, "origin": "manual", "created_at": f"2026-01-{day:02}T00:00:00Z"}
            for i, (h, decision, day) in enumerate([
                (5, "accepted", 1), (6, "accepted", 1), (7, "rejected", 2),
                (5, "cleared", 3), (0, "rejected", 4), (8, "accepted", 4),
                (9, "accepted", 5), (1, "cleared", 5), (10, "accepted", 10),
                (18, "accepted", 2), (19, "accepted", 2)])]
        data["images"] = {
            hashes[0]: {"pdq": [], "source_urls": ["https://x.com/a/status/123"]},
            hashes[11]: {"pdq": ["0"*64], "source_urls": ["https://x.com/a/status/123/photo/2"]},
            hashes[12]: {"pdq": ["0"*63+"1"], "source_urls": []}}
        for date in ("2026-01-02", "2026-01-05", "2026-02-01"):
            now = time_ns(date + "T00:00:00Z")
            expected = [score(data, features, h, now) for h in hashes]
            with patch.object(Replay, "run", autospec=True, side_effect=Replay.run) as run:
                actual = score_batch(data, features, hashes, now)
                self.assertEqual(run.call_count, 1)
            self.assertEqual(actual, expected)

    def test_batch_reference_exclusion_changes_automatic_person_resolution(self):
        data = dataset()
        data["references"] = [{"target_id": "t", "asset_hash": h*64, "kind": "anchor"}
                              for h in "abc"]
        features = {"a"*64: feature("a"*64, 0), "b"*64: feature("b"*64, 0, 1),
                    "c"*64: feature("c"*64, 0, 2), "d"*64: feature("d"*64, 0)}
        now = time_ns("2026-02-01T00:00:00Z")
        hashes = [h*64 for h in "abcd"]
        self.assertEqual(score_batch(data, features, hashes, now),
                         [score(data, features, h, now) for h in hashes])
        self.assertIsNone(score_batch(data, features, hashes, now)[0]["t"])

    def test_batch_cancellation_between_queries(self):
        import s36_shadow
        data = dataset()
        features = {h*64: feature(h*64, 0) for h in "abc"}
        cancelled = False
        original = s36_shadow.knn
        def first(*args):
            nonlocal cancelled
            value = original(*args)
            cancelled = True
            return value
        with patch("s36_shadow.knn", side_effect=first) as knn_call:
            with self.assertRaisesRegex(ValueError, "preempted"):
                score_batch(data, features, ["b"*64, "c"*64], time_ns("2026-02-01T00:00:00Z"),
                            cancelled=lambda: cancelled)
            self.assertEqual(knn_call.call_count, 1)

    def test_batch_protocol_bounds_equivalence_and_resident_invalidation(self):
        import s36_shadow
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); cache = S36FeatureCache(root / "cache", cleanup=False)
            data = dataset()
            snapshot = root / "snapshot.json"; snapshot.write_text(json.dumps(data))
            hashes = [hashlib.sha256(str(i).encode()).hexdigest() for i in range(MAX_BATCH_QUERIES)]
            for h in ["a"*64, *hashes[:-2]]:
                cache.write(feature(h, 0))
            fallback = feature(hashes[-2], 0); fallback.fallback = True; fallback.boxes = []
            cache.write(fallback)
            request = {"cachedOnly": True, "featureId": feature_id(), "targets": ["t"],
                       "snapshotPath": str(snapshot), "scoredAt": "2026-02-01T00:00:00Z"}
            queries = [{"assetId": str(i), "hash": h} for i, h in enumerate(hashes)]
            expected = [handle(SimpleNamespace(cache_root=root / "cache"), {**request, **q}) for q in queries]
            model = SimpleNamespace(cache_root=root / "cache")
            original = s36_shadow.cached_feature
            with patch("s36_shadow.cached_feature", wraps=original) as read:
                self.assertEqual(handle(model, {**request, "queries": queries})["results"], expected)
                self.assertEqual(read.call_count, len(hashes) + 1)
                read.reset_mock()
                self.assertEqual(handle(model, {**request, "queries": queries})["results"], expected)
                read.assert_not_called()
                # Snapshot labels must be replayed even though vectors are resident.
                data["decisions"] = [{"sequence": 1, "target_id": "t", "asset_hash": "a"*64,
                                      "decision": "rejected", "origin": "manual", "created_at": "2026-01-01T00:00:00Z"}]
                snapshot.write_text(json.dumps(data))
                result = handle(model, {**request, "queries": queries})
                self.assertTrue(all(r["scores"]["t"] is None for r in result["results"]))
                read.assert_not_called()
                data["decisions"] = []; snapshot.write_text(json.dumps(data))
                cache.write(feature("a"*64, 1))
                result = handle(model, {**request, "queries": queries})
                self.assertEqual(result["results"][0]["scores"]["t"], 0.5)
                self.assertEqual(read.call_count, 1)
                cache.path("a"*64).unlink()
                self.assertIsNone(handle(model, {**request, "queries": queries})["results"][0]["scores"]["t"])
            for bad in ([], queries + [{"assetId": "extra", "hash": "e"*64}], [queries[0], queries[0]]):
                with self.assertRaisesRegex(ValueError, "batch"):
                    handle(model, {**request, "queries": bad})
            with patch("s36_shadow.MAX_RESIDENT_FEATURES", 2):
                handle(model, {**request, "queries": queries})
                self.assertLessEqual(len(model.shadow_features.entries), 2)
            with patch("s36_shadow.MAX_RESIDENT_BYTES", 1):
                handle(model, {**request, "queries": queries})
                self.assertLessEqual(model.shadow_features.bytes, 1)

    def test_resident_normalization_is_exact_across_batches_and_rosters(self):
        import s36_shadow
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cache = S36FeatureCache(root / "cache", cleanup=False)
            rng = np.random.default_rng(41)
            for h, axes in (("a", [0]), ("b", [0, 1]), ("c", [0, 1, 2])):
                f = feature(h*64, *axes)
                f.vectors = (rng.normal(size=f.vectors.shape) * 7).astype(np.float32)
                cache.write(f)
            snapshot = root / "snapshot.json"
            model = SimpleNamespace(cache_root=root / "cache")
            queries = [{"assetId": h, "hash": h*64} for h in "bc"]
            for target in ("t", "t", "u"):
                data = dataset()
                data["targets"][0].update(id=target, series_id=target)
                data["references"][0]["target_id"] = target
                snapshot.write_text(json.dumps(data))
                request = {"cachedOnly": True, "featureId": feature_id(), "targets": [target],
                           "snapshotPath": str(snapshot), "scoredAt": "2026-02-01T00:00:00Z"}
                expected = [handle(SimpleNamespace(cache_root=root / "cache"), {**request, **q}) for q in queries]
                warm = hasattr(model, "shadow_features")
                with patch("s36_shadow.cached_feature", wraps=s36_shadow.cached_feature) as read:
                    self.assertEqual(handle(model, {**request, "queries": queries})["results"], expected)
                    if warm:
                        read.assert_not_called()

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
