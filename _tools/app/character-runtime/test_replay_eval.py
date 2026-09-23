"""Synthetic chronology, leakage isolation and immutable I/O regressions."""
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import numpy as np

from holdout_dataset import open_readonly
from holdout_rules import automatic_targets, current_policy, recommendation
from replay_dataset import canonical, load_dataset, resolve_scopes, save_exclusive, SCHEMA
from replay_eval import (Features, FINGERPRINT, Replay, available_at, duplicate_groups,
                         evaluate, metrics, post_key, prepare_labels, read_features,
                         score_crops, threshold, time_ns)


def h(number):
    return f"{number:064x}"


def feature(number, axes=(0,)):
    vectors = np.zeros((len(axes), 768), dtype=np.float32)
    for index, axis in enumerate(axes):
        vectors[index, axis] = 1
    return Features(h(number), [(i, 0, i + 10, 10) for i in range(len(axes))], vectors, False)


def event(number, at, decision="accepted", target="t", sequence=None):
    return dict(target_id=target, source_asset_id=str(number), asset_hash=h(number),
                decision=decision, origin="manual", sequence=sequence or number,
                created_at=at, time=time_ns(at))


def dataset():
    return {"targets": [{"id": "t", "name": "T", "series_id": "s", "enabled": True}],
            "references": [], "regions": [], "assets": [], "decisions": []}


class ReplayTests(unittest.TestCase):
    def test_future_equal_time_and_previous_day_feedback(self):
        at = "2026-09-10T10:00:00.000000001Z"
        earlier = event(1, "2026-09-09T23:59:59Z")
        same_day = event(2, "2026-09-10T01:00:00Z", "rejected")
        a, b = event(3, at), event(4, at, "rejected")
        future = event(5, "2026-09-11T00:00:00Z")
        events = [earlier, same_day, a, b, future]
        labels = [{**e, "label": int(e["decision"] == "accepted")} for e in events]
        replay = Replay(dataset(), {h(n): feature(n) for n in range(1, 6)}, {}, 1)
        rows = replay.run(labels, events)
        self.assertEqual(rows[2]["positive_votes"], 1)
        self.assertEqual(rows[2]["negative_votes"], 0)
        self.assertEqual(rows[2]["prior_counts"], [0, 1])
        self.assertEqual(rows[3]["prior_counts"], [0, 1])
        self.assertEqual(rows[4]["prior_counts"], [2, 2])
        immediate = Replay(dataset(), {h(n): feature(n) for n in range(1, 6)}, {}, 0).run(labels, events)
        self.assertEqual(immediate[2]["prior_counts"], [1, 1])
        self.assertEqual(immediate[3]["prior_counts"], [1, 1])
        self.assertEqual(time_ns(at) - time_ns(at.replace("001Z", "000Z")), 1)

    def test_revisions_replay_prior_state_not_final_labels(self):
        first = event(1, "2026-09-09T00:00:00Z", sequence=1)
        query = event(2, "2026-09-10T00:00:00Z", sequence=2)
        revision = event(1, "2026-09-11T00:00:00Z", "rejected", sequence=3)
        replay = Replay(dataset(), {h(n): feature(n) for n in (1, 2)}, {})
        rows = replay.run([{**query, "label": 1}, {**revision, "label": 0}], [first, query, revision])
        self.assertEqual(rows[0]["positive_votes"], 1)
        self.assertEqual(rows[0]["negative_votes"], 0)

    def test_pdq_transitive_and_post_exclusions(self):
        def im(pdq, url=None):
            return {"pdq": [f"{pdq:064x}"], "source_urls": [url] if url else []}
        images = {h(1): im(0), h(2): im((1 << 20) - 1), h(3): im((1 << 40) - 1),
                  h(4): im((1 << 256)-1, "https://twitter.com/u/status/123/photo/1"),
                  h(5): im(int("ab"*32, 16), "https://x.com/u/status/123/photo/2?s=20")}
        groups, _ = duplicate_groups(images)
        self.assertEqual(groups[h(1)], groups[h(3)])
        self.assertEqual(groups[h(4)], groups[h(5)])
        self.assertNotEqual(groups[h(1)], groups[h(4)])
        data = dataset()
        data["references"] = [{"target_id": "t", "asset_hash": h(n), "kind": "anchor"} for n in (1, 4)]
        replay = Replay(data, {h(n): feature(n) for n in range(1, 6)}, groups)
        self.assertEqual(set(replay.gallery("t", h(3), 10)[0]), {h(4)})
        self.assertEqual(set(replay.gallery("t", h(5), 10)[0]), {h(1)})
        self.assertNotEqual(post_key("https://a.test/board/view?id=1"), post_key("https://a.test/board/view?id=2"))
        self.assertIsNone(post_key("https://x.com/home"))

    def test_selected_multi_person_and_future_learned_reference(self):
        data = dataset()
        at = "2026-09-10T00:00:00Z"
        data["references"] = [{"target_id": "t", "asset_hash": h(1), "kind": "anchor"},
                              {"target_id": "t", "asset_hash": h(2), "kind": "learned", "created_at": at}]
        features = {h(1): feature(1, (0, 1)), h(2): feature(2)}
        replay = Replay(data, features, {})
        self.assertFalse(replay.gallery("t", h(8), time_ns(at))[0])
        data["regions"] = [{"target_id": "t", "asset_hash": h(1), "baseline_fingerprint": FINGERPRINT,
                            "bounds": list(features[h(1)].boxes[1])}]
        replay = Replay(data, features, {})
        positive = replay.gallery("t", h(8), time_ns(at))[0]
        self.assertEqual(set(positive), {h(1)})
        self.assertEqual(np.argmax(positive[h(1)]), 1)
        self.assertEqual(len(replay.gallery("t", h(8), time_ns(at)+1)[0]), 2)

    def test_common_person_inference_and_stale_selection(self):
        data = dataset()
        data["references"] = [{"target_id": "t", "asset_hash": h(n), "kind": "anchor"} for n in (1, 2, 3)]
        features = {h(1): feature(1), h(2): feature(2, (0, 1)), h(3): feature(3, (0, 2))}
        self.assertEqual(len(Replay(data, features, {}).gallery("t", h(8), 0)[0]), 3)
        data["regions"] = [{"target_id": "t", "asset_hash": h(2), "baseline_fingerprint": "stale", "bounds": [0, 0, 10, 10]}]
        self.assertNotIn(h(2), Replay(data, features, {}).gallery("t", h(8), 0)[0])

    def test_prior_canary_depends_only_on_past_manual_labels(self):
        replay = Replay(dataset(), {}, {}, lag=0)
        events = [event(1, "2026-09-09T00:00:00Z"), event(2, "2026-09-10T00:00:00Z", "rejected"),
                  event(3, "2026-09-11T00:00:00Z")]
        rows = replay.run([{**e, "label": int(e["decision"] == "accepted")} for e in events], events)
        self.assertEqual([r["scores"]["prior"] for r in rows], [-0.5, -1.0, -0.5])
        self.assertTrue(all(r["scores"]["contrast"] is None for r in rows))

    def test_future_target_cannot_supply_competitor_seeds(self):
        data = dataset()
        data["targets"][0]["created_at"] = "2026-09-11T00:00:00Z"
        data["references"] = [{"target_id": "t", "asset_hash": h(1), "kind": "anchor"}]
        replay = Replay(data, {h(1): feature(1)}, {})
        self.assertFalse(replay.gallery("t", h(2), time_ns("2026-09-11T00:00:00Z"))[0])
        self.assertEqual(len(replay.gallery("t", h(2), time_ns("2026-09-12T00:00:00Z"))[0]), 1)

    def test_contrast_compares_same_query_crop(self):
        query = feature(1, (0, 1)).vectors
        positive = feature(2).vectors
        negative = feature(3, (1,)).vectors
        scores, _ = score_crops(query, positive, negative, positive[:0], .5, current_policy())
        self.assertAlmostEqual(scores["contrast"], -.5)
        self.assertAlmostEqual(scores["knn3"], 0)

    def test_feature_sources_readonly_and_extra_pickle(self):
        import pickle
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bdir, sdir = root / h(50), root / h(51)
            bdir.mkdir()
            sdir.mkdir()
            sample = feature(1)
            path = bdir / (h(1) + ".npz")
            np.savez(path, content_hash=h(1), vectors=sample.vectors * 3,
                     boxes=np.array(sample.boxes), fallback=False)
            np.savez(sdir / (h(2) + ".npz"), content_hash=h(2), feature_id=h(51),
                     vectors=sample.vectors, boxes=np.array(sample.boxes), fallback=False)
            extra = root / "extra.pkl"
            extra.write_bytes(pickle.dumps({h(1): sample.vectors * 2, h(3): None}))
            original = path.read_bytes()
            features, info = read_features([sdir], "s36", extra, [bdir])
            self.assertEqual(set(features), {h(1), h(2)})
            self.assertAlmostEqual(np.linalg.norm(features[h(1)].vectors), 1)
            self.assertEqual(info["counts"]["extra_loaded"], 1)
            self.assertEqual(path.read_bytes(), original)
            with self.assertRaises(ValueError):
                read_features([sdir], "b36")

    def test_stream_counts_unknown_pairs_without_inventing_negatives(self):
        data = dataset()
        data.update(images={}, limitations=[])
        data["references"] = [{"target_id": "t", "asset_hash": h(1), "kind": "anchor"}]
        data["assets"] = [{"id": str(n), "content_hash": h(n), "status": "normal", "media_kind": "image", "series_scope": ["s"]} for n in (1, 2, 3, 4)]
        data["decisions"] = [event(2, "2026-09-09T00:00:00Z", "rejected"), event(3, "2026-09-10T00:00:00Z")]
        features = {h(n): feature(n, (1,) if n == 2 else (0,)) for n in (1, 2, 3, 4)}
        result = evaluate({"dataset": data, "sha256": "fixture"}, features, stream=True)
        self.assertEqual(result["coverage"]["labeled_pairs"], 2)
        self.assertEqual(result["stream"]["overall"]["unlabeled_pairs"], 1)
        self.assertEqual(result["stream"]["overall"]["accepted_volume"]["knn3"]["0.02"], 1)
        self.assertEqual(result["metrics"]["knn3"]["overall"]["negatives"], 1)

    def test_rule6_holdout_parity(self):
        policy = current_policy()
        query = feature(100).vectors
        for count in (5, 6, 7):
            pool = np.repeat(query, count, axis=0)
            scores, flag = score_crops(query, pool, pool[:0], pool[:0], 0.5, policy)
            evidence = {"passed": flag, "wholeFallback": False,
                        "referenceHashes": [h(n) for n in range(count)],
                        "queryBoxes": [[0, 0, 10, 10]],
                        "evidence": [{"referenceDistances": [0.0] * count,
                                      "matchedReferences": list(range(count))}]}
            self.assertEqual(flag, recommendation(evidence, policy))
            accepted = "t" in automatic_targets({"t": evidence}, {}, h(100), policy)
            self.assertEqual(accepted, scores["rule6"] is not None and scores["rule6"] <= policy["automatic_max_distance"])

    def test_walk_forward_threshold_never_uses_current_or_future(self):
        def row(i, day, score, label):
            return {**event(i, f"2026-09-{day:02d}T00:00:00Z"), "label": label,
                    "scores": {"knn3": score}}
        rows = [row(1, 9, 0.1, 1), row(2, 9, 0.3, 0), row(3, 10, 0.2, 1), row(4, 10, 0.05, 0)]
        result = metrics(rows, "knn3", 1)
        self.assertEqual(result["walk_forward"]["0.02"]["recall"], 0.5)
        self.assertEqual(result["walk_forward"]["0.02"]["final_threshold"], 0.3)
        self.assertEqual(result["oracle"]["0.02"]["threshold"], 0.05)
        self.assertEqual(result["walk_forward"]["0.02"]["cold_start_abstentions"], 2)
        self.assertEqual(threshold([0.1]*100, .02), 0.1)
        self.assertEqual(available_at(time_ns("2026-09-09T23:59:59Z"), 2), time_ns("2026-09-11T00:00:00Z"))

    def test_latest_manual_truth_and_unreviewed_automatic(self):
        data = dataset()
        data["assets"] = [{"id": str(n), "content_hash": h(n), "status": "normal", "media_kind": "image"} for n in (1, 2, 3)]
        data["decisions"] = [event(1, "2026-09-09T00:00:00Z"),
                             {**event(1, "2026-09-10T00:00:00Z", sequence=2), "origin": "automatic"},
                             {**event(2, "2026-09-10T00:00:00Z", sequence=3), "origin": "automatic"},
                             event(3, "2026-09-10T00:00:00Z", "cleared", sequence=4)]
        labels, _, automatic, excluded = prepare_labels(data)
        self.assertEqual([r["asset_hash"] for r in labels], [h(1)])
        self.assertEqual([r["asset_hash"] for r in automatic], [h(2)])
        self.assertEqual(excluded["latest_manual_cleared"], 1)

    def test_scope_nearest_optout_descendants_and_exclusions(self):
        entries = [{"id": i, "parent_id": p} for i, p in [("root", None), ("s", "root"), ("child", "s"), ("off", "s"), ("original", None)]]
        memberships = [{"asset_id": i, "classification_id": f} for i, f in [("a", "root"), ("b", "child"), ("c", "off"), ("d", "original"), ("e", "child"), ("e", "root")]]
        scopes = resolve_scopes(entries, [{"classification_id": "s", "auto_classify": 1}, {"classification_id": "off", "auto_classify": 0}],
                                [{"classification_id": "original", "role": "originals"}], [],
                                [{"asset_id": "b", "series_id": "s"}], memberships)
        self.assertEqual(scopes, {"a": ["s"], "b": [], "c": [], "d": [], "e": []})

    def test_database_readonly_and_output_exclusive_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            library = root / "library"
            library.mkdir()
            db = library / "library.sqlite"
            with sqlite3.connect(db) as c:
                c.execute("CREATE TABLE sample(value)")
                c.execute("INSERT INTO sample VALUES (1)")
            original = db.read_bytes()
            with open_readonly(db) as c:
                self.assertEqual(c.execute("PRAGMA query_only").fetchone()[0], 1)
                self.assertTrue(c.in_transaction)
                self.assertEqual(c.execute("SELECT value FROM sample").fetchone()[0], 1)
                with self.assertRaises(sqlite3.OperationalError):
                    c.execute("INSERT INTO sample VALUES (2)")
                c.execute("PRAGMA query_only=OFF")
                with self.assertRaises(sqlite3.OperationalError):
                    c.execute("INSERT INTO sample VALUES (2)")
            self.assertEqual(original, db.read_bytes())
            data = {"schema": SCHEMA}
            envelope = {"dataset": data, "sha256": hashlib.sha256(canonical(data)).hexdigest()}
            out = root / "dataset.json"
            save_exclusive(envelope, out, library)
            self.assertEqual(load_dataset(out), envelope)
            with self.assertRaises(FileExistsError):
                save_exclusive(envelope, out, library)
            with self.assertRaises(ValueError):
                save_exclusive(envelope, library / "bad.json", library)
            link = root / "link"
            link.symlink_to(library, target_is_directory=True)
            with self.assertRaises(ValueError):
                save_exclusive(envelope, link / "bad.json", library)
            envelope["dataset"]["tampered"] = True
            out.write_text(json.dumps(envelope))
            with self.assertRaises(ValueError):
                load_dataset(out)

    def test_readonly_wal_snapshot_sees_commits_and_is_stable(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "wal.sqlite"
            writer = sqlite3.connect(db)
            try:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("CREATE TABLE sample(value)")
                writer.execute("INSERT INTO sample VALUES (1)")
                writer.commit()
                with open_readonly(db) as reader:
                    self.assertEqual(reader.execute("SELECT value FROM sample").fetchall(), [(1,)])
                    writer.execute("INSERT INTO sample VALUES (2)")
                    writer.commit()
                    self.assertEqual(reader.execute("SELECT value FROM sample").fetchall(), [(1,)])
                with open_readonly(db) as reader:
                    self.assertEqual(reader.execute("SELECT value FROM sample").fetchall(), [(1,), (2,)])
            finally:
                writer.close()


class S36ReplayOptionsTests(unittest.TestCase):
    def test_shared_knn3_matches_frozen_float32_replay_fixture_exactly(self):
        import s36_scoring
        rng = np.random.default_rng(36)
        q, p, n, c = [s36_scoring.unit(rng.normal(size=(size, 768))) for size in (8, 11, 5, 7)]
        def old_knn(pool):
            d = .5 * (1. - q @ pool.T)
            k = min(3, len(pool))
            return np.partition(d, k-1, axis=1)[:, :k].mean(axis=1)
        own = old_knn(p)
        scores, _ = score_crops(q, p, n, c, .5, current_policy())
        self.assertEqual(scores['knn3'], float(own.min()))
        self.assertEqual(scores['contrast'], float((own - np.minimum(old_knn(n), old_knn(c))).min()))
        np.testing.assert_array_equal(s36_scoring.crop_scores(q, p, n, c, normalized=True)['knn3'], own)

    def test_reference_witness_excludes_manual_gallery_and_future_references(self):
        data = dataset()
        data['references'] = [{'target_id': 't', 'asset_hash': h(1), 'kind': 'anchor'},
            {'target_id': 't', 'asset_hash': h(5), 'kind': 'learned', 'created_at': '2026-09-20T00:00:00Z'}]
        features = {h(1): feature(1), h(5): feature(5, (1,)), h(9): feature(9, (0, 1))}
        engine = Replay(data, features, {}, witness='references')
        for n in (2, 3, 4):
            e = event(n, '2026-09-09T00:00:00Z')
            engine.state['t'][h(n)] = (e, feature(n, (1,)).vectors[0])
        for decision in ('accepted', 'rejected'):
            e = event(9, '2026-09-10T00:00:00Z', decision)
            self.assertEqual(np.argmax(engine.witness(e, e['time'])), 0)
        engine.witness_mode = 'gallery'
        e = event(9, '2026-09-10T00:00:00Z')
        self.assertEqual(np.argmax(engine.witness(e, e['time'])), 1)
        engine.witness_mode = 'references'
        engine.groups = {h(1): 'same', h(9): 'same'}
        self.assertIsNone(engine.witness(e, e['time']))

    def test_cap_latest_per_polarity_keeps_references_and_prior_counts(self):
        data = dataset()
        data['references'] = [{'target_id': 't', 'asset_hash': h(1), 'kind': 'anchor'}]
        engine = Replay(data, {h(1): feature(1)}, {}, gallery_cap=1)
        for n, decision in [(2, 'accepted'), (3, 'accepted'), (4, 'rejected'), (5, 'rejected')]:
            e = event(n, f'2026-09-{n:02}T00:00:00Z', decision)
            engine.state['t'][h(n)] = (e, feature(n).vectors[0])
        positive, negative, counts = engine.gallery('t', h(9), time_ns('2026-09-10T00:00:00Z'))
        self.assertEqual(set(positive), {h(1), h(3)})
        self.assertEqual(set(negative), {h(5)})
        self.assertEqual(counts, [2, 2])
        engine.gallery_cap = 0
        self.assertEqual(set(engine.gallery('t', h(9), 0)[0]), {h(1)})
        with self.assertRaises(ValueError):
            Replay(data, {}, {}, gallery_cap=-1)

    def test_custom_rates_reach_metrics_and_stream(self):
        data = dataset()
        data.update(images={}, limitations=[])
        result = evaluate({'dataset': data, 'sha256': 'fixture'}, {}, rates=(.1,), stream=True,
                          witness='references', gallery_cap=12)
        self.assertEqual(set(result['metrics']['knn3']['overall']['walk_forward']), {'0.1'})
        self.assertEqual(set(result['stream']['overall']['accepted_volume']['knn3']), {'0.1'})
        self.assertEqual(result['witness'], 'references')
        self.assertEqual(result['gallery_cap'], 12)
        for rates in ((), (1,), (-.1,), (float('nan'),)):
            with self.assertRaises(ValueError):
                evaluate({'dataset': data}, {}, rates=rates)


if __name__ == "__main__":
    unittest.main()
