"""Machine-local receipts and verification use only temporary fixture libraries."""
import json
import os
from pathlib import Path
import sqlite3
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
from PIL import Image
import pytest

import character_encoder as encoder
from character_augmentation import S36FeatureCache
from runtime import Features, sha256


def pinned():
    return json.loads(Path(encoder.__file__).with_name("s36_policy.json").read_text())["feature_id"]


@pytest.mark.parametrize("receipt", ["{", "[]", "null", '"text"',
    json.dumps({"a" * 64: "b" * 64}),
    json.dumps({"a" * 64: [pinned()]}),
    json.dumps({"a" * 64: pinned(), "bad": 1})])
def test_receipt_fails_closed(tmp_path, monkeypatch, receipt):
    monkeypatch.setattr(encoder, "feature_id", lambda: "a" * 64)
    (tmp_path / "s36-compatibility.json").write_text(receipt)
    assert encoder.effective_feature_id(tmp_path) == "a" * 64


def test_effective_identity_and_namespace(tmp_path, monkeypatch):
    monkeypatch.setattr(encoder, "feature_id", lambda: "a" * 64)
    assert encoder.effective_feature_id(tmp_path) == "a" * 64
    (tmp_path / "s36-compatibility.json").write_text(json.dumps({"a" * 64: pinned()}))
    assert encoder.effective_feature_id(tmp_path) == pinned()
    assert encoder.feature_id() == "a" * 64
    cache = S36FeatureCache(tmp_path / "cache", models=tmp_path)
    assert cache.root.name == pinned()
    feature = Features("c" * 64, [(0, 0, 8, 8)], np.ones((1, 768), np.float32), False)
    cache.write(feature)
    assert cache.read(feature.content_hash, feature.boxes) is not None
    with pytest.raises(ValueError, match="Stale"):
        encoder.load_feature(cache.path(feature.content_hash), feature.content_hash)
    (tmp_path / "s36-compatibility.json").unlink()
    assert S36FeatureCache(tmp_path / "cache", models=tmp_path).root.name == "a" * 64


@pytest.fixture
def library(tmp_path):
    root, models = tmp_path / "library", tmp_path / "models"
    root.mkdir(); models.mkdir()
    with sqlite3.connect(root / "library.sqlite") as db:
        db.execute("CREATE TABLE assets(content_hash TEXT, relative_path TEXT, status TEXT, media_kind TEXT)")
    cache = S36FeatureCache(root / ".cache/characters", implementation=pinned())
    b36 = root / ".cache/characters" / ("b" * 64)
    b36.mkdir(parents=True)
    for index in range(20):
        path = root / ("source.png" if index == 0 else f"source-{index}.png")
        Image.new("RGB", (8, 8), (255, index, 0)).save(path)
        h = sha256(path)
        current = Features(h, [(0, 0, 8, 8)], np.ones((1, 768), np.float32), False)
        with sqlite3.connect(root / "library.sqlite") as db:
            db.execute("INSERT INTO assets VALUES (?, ?, 'normal', 'image')", (h, path.name))
        cache.write(current)
        np.savez(b36 / (h + ".npz"), content_hash=h, boxes=np.asarray(current.boxes),
                 vectors=current.vectors, fallback=False)
        if index == 0:
            feature = current
    return root, models, feature


def snapshot(root):
    return {str(p.relative_to(root)): (p.read_bytes(), p.stat().st_mtime_ns)
            for p in root.rglob("*") if p.is_file()}


def engine_factory(library):
    feature = library[2]
    def extract(path, expected_hash=None, boxes=None):
        assert boxes is None  # Recompute detection; never force cached geometry.
        h = sha256(path)
        assert expected_hash in (None, h)
        return (feature if path.name == "source.png" else
                Features(h, [(0, 0, 8, 8)], np.ones((1, 768), np.float32), False))
    return lambda *args: SimpleNamespace(extract=extract)


def run(library, **kwargs):
    import feature_equivalence as tool
    root, models, _ = library
    factory = engine_factory(library)
    return tool.verify(root, models, sample=kwargs.pop("sample", 20), kind=kwargs.pop("kind", "both"),
                       encoder_factory=factory, runtime_factory=factory, **kwargs)


def test_dry_run_and_atomic_merge(library):
    import feature_equivalence as tool
    root, models, _ = library
    before = snapshot(root)
    report = run(library)
    assert report["equivalent"] and not report["written"]
    assert report["results"]["s36"]["sample_size"] == 20
    assert report["results"]["s36"]["max_diff"] == 0
    assert not list(models.iterdir())
    (models / "cache-compatibility.json").write_text(json.dumps({"d" * 64: ["e" * 64]}))
    report = run(library, write=True)
    assert report["equivalent"] and report["written"]
    assert json.loads((models / "s36-compatibility.json").read_text())[encoder.feature_id()] == pinned()
    b36 = json.loads((models / "cache-compatibility.json").read_text())
    assert b36[tool.extraction_fingerprint()] == ["b" * 64]
    assert b36["d" * 64] == ["e" * 64]
    assert snapshot(root) == before
    assert not list(models.glob("*.part"))


@pytest.mark.parametrize("change", ["vector", "box", "fallback", "nan", "shape", "source", "missing"])
def test_any_mismatch_refuses_all_receipts(library, change):
    root, models, feature = library
    if change == "vector":
        feature.vectors[0, 0] += 0.0001
    elif change == "box":
        feature.boxes = [(0, 0, 7, 8)]
    elif change == "fallback":
        feature.fallback, feature.boxes = True, []
    elif change == "nan":
        feature.vectors[0, 0] = np.nan
    elif change == "shape":
        feature.vectors = np.ones((2, 768), np.float32)
    elif change == "source":
        (root / "source.png").write_bytes(b"changed")
    else:
        (root / "source.png").unlink()
    (models / "s36-compatibility.json").write_text(json.dumps({"d" * 64: pinned()}))
    before = snapshot(models)
    report = run(library, write=True)
    assert not report["equivalent"] and not report["written"]
    assert report["results"]["s36"]["mismatches"]
    assert snapshot(models) == before


def test_b36_failure_does_not_write_successful_s36_receipt(library):
    root, models, feature = library
    entry = root / ".cache/characters" / ("b" * 64) / (feature.content_hash + ".npz")
    entry.write_bytes(b"corrupt")
    report = run(library, write=True)
    assert report["results"]["s36"]["equivalent"]
    assert not report["equivalent"] and not report["written"]
    assert not list(models.iterdir())


@pytest.mark.parametrize("kind", ["s36", "b36"])
@pytest.mark.parametrize("sample", [20, 100])
def test_filters_unresolvable_entries_before_sampling(library, monkeypatch, kind, sample):
    import feature_equivalence as tool
    root, models, feature = library
    cache = tool.old_namespace(root / ".cache/characters", kind, None)[1]
    with sqlite3.connect(root / "library.sqlite") as db:
        for index, (status, media) in enumerate(
                [("trashed", "image"), ("removed", "image"), ("normal", "video"), (None, None)]):
            h = "f" * 63 + str(index)
            (cache / (h + ".npz")).write_bytes(b"unresolvable cache must not be read")
            if status is not None:
                db.execute("INSERT INTO assets VALUES (?, 'missing.png', ?, ?)", (h, status, media))
        # Multiple assets for one hash still contribute only one cache entry.
        db.execute("INSERT INTO assets VALUES (?, 'source.png', 'normal', 'image')", (feature.content_hash,))
    monkeypatch.setattr(tool.random, "sample", lambda entries, count: sorted(entries, reverse=True)[:count])
    before = snapshot(root)
    report = run(library, kind=kind, sample=sample, write=True)
    result = report["results"][kind]
    assert report["equivalent"] and report["written"]
    assert result["sample_size"] == 20
    assert result["resolvable_entries"] == 20
    assert result["skipped_unresolvable"] == 4
    assert result["mismatches"] == [] and result["errors"] == []
    assert result["max_diff"] == 0
    assert snapshot(root) == before


@pytest.mark.parametrize("remaining", [0, 19])
@pytest.mark.parametrize("kind", ["s36", "b36"])
def test_below_minimum_refuses_receipts(library, remaining, kind):
    root, models, _ = library
    with sqlite3.connect(root / "library.sqlite") as db:
        db.execute("UPDATE assets SET status = 'trashed' WHERE rowid > ?", (remaining,))
    before = snapshot(root)
    report = run(library, kind=kind, sample=100, write=True)
    result = report["results"][kind]
    assert not report["equivalent"] and not report["written"]
    assert result["sample_size"] == 0
    assert result["resolvable_entries"] == remaining
    assert result["skipped_unresolvable"] == 20 - remaining
    assert result["mismatches"] == []
    assert f"only {remaining}" in result["errors"][0]
    assert not list(models.iterdir())
    assert snapshot(root) == before


def test_short_sample_and_missing_db_do_not_create_files(library):
    import feature_equivalence as tool
    root, models, _ = library
    before = snapshot(root)
    report = tool.verify(root, models, sample=19, kind="s36", write=True)
    assert not report["equivalent"] and not report["written"]
    assert "at least 20" in report["errors"][0]
    assert snapshot(root) == before
    (root / "library.sqlite").unlink()
    report = tool.verify(root, models, sample=20, write=True)
    assert report["errors"] and not report["written"]
    assert not (root / "library.sqlite").exists()


def test_b36_namespace_uses_entry_mtime_and_explicit_override(library):
    from feature_equivalence import old_namespace
    root, _, feature = library
    cache = root / ".cache/characters"
    newest = cache / ("f" * 64)
    newest.mkdir()
    entry = newest / (feature.content_hash + ".npz")
    entry.write_bytes(b"fixture")
    os.utime(entry, ns=(1, 1))
    assert old_namespace(cache, "b36", None)[0] == "b" * 64
    assert old_namespace(cache, "b36", "f" * 64)[0] == "f" * 64
    with pytest.raises(ValueError, match="full B36"):
        old_namespace(cache, "b36", "../escape")


@pytest.mark.parametrize("kind", ["s36", "b36"])
def test_malformed_receipt_never_overwritten(library, kind):
    _, models, _ = library
    name = "s36-compatibility.json" if kind == "s36" else "cache-compatibility.json"
    (models / name).write_text("[]")
    before = snapshot(models)
    report = run(library, write=True)
    assert report["equivalent"] and report["errors"] and not report["written"]
    assert snapshot(models) == before


def test_atomic_replace_failure_preserves_receipt(library, monkeypatch):
    import feature_equivalence as tool
    _, models, _ = library
    receipt = models / "s36-compatibility.json"
    receipt.write_text(json.dumps({"d" * 64: pinned()}))
    before = snapshot(models)
    monkeypatch.setattr(tool.os, "replace", Mock(side_effect=OSError("fixture replace failure")))
    report = run(library, write=True)
    assert not report["written"] and report["errors"]
    assert snapshot(models) == before


def test_receipt_write_inside_library_refused(library):
    root, _, feature = library
    models = root / "models"
    models.mkdir()
    before = snapshot(root)
    report = run((root, models, feature), write=True)
    assert report["equivalent"] and not report["written"] and report["errors"]
    assert snapshot(root) == before


def test_cli_json_and_failure_exit(library, monkeypatch, capsys):
    import feature_equivalence as tool
    root, models, _ = library
    assert tool.main(["--library", str(root), "--models", str(models), "--sample", "0"]) == 1
    assert json.loads(capsys.readouterr().out)["errors"]
    real_verify = tool.verify
    def verified(**kwargs):
        factory = engine_factory(library)
        return real_verify(**kwargs, encoder_factory=factory, runtime_factory=factory)
    monkeypatch.setattr(tool, "verify", verified)
    assert tool.main(["--library", str(root), "--models", str(models), "--sample", "20"]) == 0
    assert json.loads(capsys.readouterr().out)["equivalent"]


@pytest.mark.parametrize("batch", [False, True])
def test_shadow_protocol_uses_receipt_and_pinned_cache(library, batch):
    from s36_shadow import handle
    from test_s36_shadow import dataset
    root, models, feature = library
    (models / "s36-compatibility.json").write_text(json.dumps({encoder.feature_id(): pinned()}))
    snapshot_path = root / "snapshot.json"
    data = dataset()
    data["references"][0]["asset_hash"] = feature.content_hash
    snapshot_path.write_text(json.dumps(data))
    model = SimpleNamespace(models=models, cache_root=root / ".cache/characters")
    query = {"assetId": "q", "hash": feature.content_hash}
    request = {"cachedOnly": True, "featureId": pinned(), "targets": ["t"],
               "snapshotPath": str(snapshot_path), "scoredAt": "2026-10-04T00:00:00Z"}
    request.update({"queries": [query]} if batch else query)
    response = handle(model, request)
    result = response["results"][0] if batch else response
    assert result["featureId"] == pinned() and result["queryAvailable"]
    request["featureId"] = "f" * 64
    with pytest.raises(ValueError, match="identity mismatch"):
        handle(model, request)


def test_library_preparation_uses_effective_namespace(library):
    from s36_library_cache import prepare
    root, models, feature = library
    path = root / "assets" / feature.content_hash[:2] / (feature.content_hash + ".png")
    path.parent.mkdir(parents=True)
    path.write_bytes((root / "source.png").read_bytes())
    (models / "s36-compatibility.json").write_text(json.dumps({encoder.feature_id(): pinned()}))
    before = snapshot(root)
    report = prepare({feature.content_hash: "image"}, root, models, cpu_minutes=1,
                     stop=root / "STOP", dry_run=True, expect_namespace=pinned())
    assert report["feature_id"] == pinned() and report["already_cached"] == 1
    assert snapshot(root) == before


def test_worker_ready_reports_effective_identity(library, monkeypatch):
    import character_augmentation as augmentation
    import scan_worker
    root, models, _ = library
    (models / "s36-compatibility.json").write_text(json.dumps({encoder.feature_id(): pinned()}))
    args = scan_worker.runtime_arguments(["--models", str(models), "--cache", str(root / "cache"),
                                         "--augmentation-model", str(models / "s36.onnx")])
    monkeypatch.setattr(scan_worker, "runtime_arguments", lambda: args)
    monkeypatch.setattr(scan_worker, "Runtime", Mock())
    monkeypatch.setattr(scan_worker.threading, "Thread", Mock())
    monkeypatch.setattr(scan_worker.sys, "stdin", Mock())
    monkeypatch.setattr(scan_worker.sys, "stdout", Mock())
    monkeypatch.setattr(augmentation, "augmenter", lambda *args, **kwargs: (object(), None))
    messages = []
    class Ready(BaseException):
        pass
    def emit(message):
        messages.append(message)
        raise Ready()
    monkeypatch.setattr(scan_worker, "emit", emit)
    with pytest.raises(Ready):
        scan_worker.main()
    assert messages[0]["type"] == "ready"
    assert messages[0]["s36FeatureId"] == pinned()


def test_live_shadow_reuses_verified_b36_and_s36_namespaces(library):
    from feature_cache import extraction_fingerprint
    from s36_shadow import extract_query
    root, models, feature = library
    (models / "s36-compatibility.json").write_text(json.dumps({encoder.feature_id(): pinned()}))
    (models / "cache-compatibility.json").write_text(
        json.dumps({extraction_fingerprint(): ["b" * 64]}))
    model = SimpleNamespace(models=models, cache_root=root / ".cache/characters",
                            encoder_for=Mock(side_effect=AssertionError("cached features require no inference")))
    request = {"hash": feature.content_hash, "path": str(root / "source.png"), "mediaKind": "image"}
    before = snapshot(root)
    assert extract_query(model, request) is not None
    assert snapshot(root) == before
    (models / "cache-compatibility.json").unlink()
    assert extract_query(model, request) is None
