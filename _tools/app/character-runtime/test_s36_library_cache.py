"""Only temporary fixture libraries, tiny images and fake ONNX sessions."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from character_encoder import SmallEncoder, feature_id
from character_augmentation import S36FeatureCache
from feature_cache import extraction_fingerprint
from replay_dataset import SCHEMA, canonical, locate
from runtime import Features, sha256
from s36_library_cache import candidates, prepare


class FakeEncoder:
    def __init__(self, *models):
        self.detected = self.extracted = 0
        self.boxes = [(0, 0, 24, 24)]
        self.after_extract = lambda path: None

    def detect(self, image):
        self.detected += 1
        return self.boxes

    def extract(self, path, expected_hash, boxes):
        self.extracted += 1
        self.after_extract(path)
        return Features(expected_hash, boxes, np.ones((len(boxes), 768), np.float32), False)


class LibraryCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library = self.root / 'library'
        self.library.mkdir()
        self.models = self.root / 'models'
        self.stop = self.root / 'STOP'
        self.encoder = FakeEncoder()
        self.factories = 0

    def factory(self, *models):
        self.factories += 1
        return self.encoder

    def image(self, color='blue'):
        temp = self.root / 'source.png'
        Image.new('RGB', (32, 32), color).save(temp)
        h = sha256(temp)
        path = self.library / 'assets' / h[:2] / (h + '.png')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(temp.read_bytes())
        return h, path

    def b36(self, h, fallback=False):
        path = self.library / '.cache/characters' / extraction_fingerprint() / (h + '.npz')
        path.parent.mkdir(parents=True, exist_ok=True)
        boxes = np.array([] if fallback else [[0, 0, 24, 24]], np.int64).reshape(-1, 4)
        np.savez(path, content_hash=h, vectors=np.ones((1, 768), np.float32), boxes=boxes, fallback=fallback)
        return path

    def snapshot(self):
        return {str(p.relative_to(self.library)): ('dir' if p.is_dir() else p.read_bytes())
                for p in self.library.rglob('*')}

    def run_prepare(self, items, **options):
        opts = dict(cpu_minutes=10, stop=self.stop, expect_namespace=feature_id(), encoder_factory=self.factory)
        opts.update(options)
        return prepare(items, self.library, self.models, **opts)

    def test_dry_run_json_no_writes_or_encoder_with_counts(self):
        a, _ = self.image('red')
        b, _ = self.image('blue')
        c, _ = self.image('green')
        d, _ = self.image('white')
        self.b36(a)
        self.b36(c, fallback=True)
        cache = S36FeatureCache(self.library / '.cache/characters')
        cache.write(Features(d, [(0, 0, 24, 24)], np.ones((1, 768), np.float32), False))
        stray = cache.root / 'orphan.part'
        stray.write_bytes(b'leave untouched')
        items = {a: 'image', b: 'image', c: 'image', d: 'image', 'f'*64: 'video'}
        before = self.snapshot()
        report = self.run_prepare(items, dry_run=True)
        self.assertEqual(report['total_candidates'], 5)
        self.assertEqual(report['already_cached'], 1)
        self.assertEqual(report['b36_box_hits'], 1)
        self.assertEqual(report['detector_needed'], 1)
        self.assertEqual(report['skipped_by_reason'], {'whole_fallback': 1, 'non_image': 1})
        self.assertEqual(self.factories, 0)
        self.assertEqual(self.snapshot(), before)
        hashes = self.root / 'hashes.json'
        hashes.write_text(json.dumps([{'content_hash': h, 'media_kind': k} for h, k in items.items()]))
        environment = dict(os.environ)
        environment.pop('ORT_DISABLE_TELEMETRY', None)  # CLI must set it before import.
        before_root = {str(p.relative_to(self.root)) for p in self.root.rglob('*')}
        result = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('s36_library_cache.py').resolve()), '--hashes', str(hashes),
            '--library', str(self.library), '--models', str(self.models), '--cpu-minutes', '10',
            '--stop', str(self.stop), '--dry-run'], cwd=self.root, env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['feature_id'], feature_id())
        self.assertEqual(self.snapshot(), before)
        self.assertEqual({str(p.relative_to(self.root)) for p in self.root.rglob('*')}, before_root)

    def test_only_s36_namespace_changes_b36_readonly_resume_and_limit(self):
        a, _ = self.image('red')
        b, _ = self.image('blue')
        self.b36(a)
        before = self.snapshot()
        items = {a: 'image', b: 'image'}
        first = self.run_prepare(items, limit=1)
        self.assertEqual(first['written'], 1)
        second = self.run_prepare(items, limit=1)
        self.assertEqual((second['already_cached'], second['written']), (1, 1))
        self.assertEqual(self.encoder.detected, 1)
        self.assertEqual(self.encoder.extracted, 2)
        after = self.snapshot()
        self.assertEqual({p: after[p] for p in before}, before)
        prefix = '.cache/characters/s36-augmentation-v1/' + feature_id()
        for p in after.keys() - before.keys():
            self.assertTrue(p in ('.cache', '.cache/characters', '.cache/characters/s36-augmentation-v1', prefix)
                            or p in (f'{prefix}/{a}.npz', f'{prefix}/{b}.npz'), p)
        third = self.run_prepare(items)
        self.assertEqual((third['already_cached'], third['written']), (2, 0))
        self.assertEqual(self.snapshot(), after)

    def test_namespace_mismatch_stop_zero_budget_and_limit_write_nothing(self):
        h, _ = self.image()
        before = self.snapshot()
        for namespace in (None, 'f'*64):
            with self.assertRaisesRegex(ValueError, 'namespace'):
                self.run_prepare({h: 'image'}, expect_namespace=namespace)
        self.assertEqual(self.run_prepare({h: 'image'}, cpu_minutes=0)['stopped'], 'cpu_budget')
        self.assertEqual(self.run_prepare({h: 'image'}, limit=0)['stopped'], 'limit')
        self.stop.touch()
        self.assertEqual(self.run_prepare({h: 'image'})['stopped'], 'STOP')
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.factories, 0)

    def test_cpu_and_stop_during_extraction_prevent_publication(self):
        h, _ = self.image()
        self.b36(h)
        before = self.snapshot()
        clock = [0.0]
        self.encoder.after_extract = lambda path: clock.__setitem__(0, 61.0)
        result = self.run_prepare({h: 'image'}, cpu_minutes=1, clock=lambda: clock[0])
        self.assertEqual(result['stopped'], 'cpu_budget')
        self.encoder.after_extract = lambda path: self.stop.touch()
        result = self.run_prepare({h: 'image'})
        self.assertEqual(result['stopped'], 'STOP')
        self.assertEqual(self.snapshot(), before)

    def test_no_detection_skips_feature_inference_and_creates_no_cache(self):
        h, _ = self.image()
        before = self.snapshot()
        self.encoder.boxes = []
        result = self.run_prepare({h: 'image'})
        self.assertEqual(result['skipped_by_reason'], {'whole_fallback': 1})
        self.assertEqual((self.encoder.detected, self.encoder.extracted), (1, 0))
        self.assertEqual(self.snapshot(), before)

    def test_corrupt_caches_recompute_without_changing_b36(self):
        h, _ = self.image()
        base = self.b36(h)
        base.write_bytes(b'corrupt B36 fixture')
        cache = S36FeatureCache(self.library / '.cache/characters')
        cache.root.mkdir(parents=True)
        cache.path(h).write_bytes(b'corrupt S36 fixture')
        report = self.run_prepare({h: 'image'})
        self.assertEqual((report['detector_needed'], report['written']), (1, 1))
        self.assertEqual(base.read_bytes(), b'corrupt B36 fixture')
        self.assertIsNotNone(cache.read(h, [(0, 0, 24, 24)]))

    def test_namespace_change_during_extraction_refuses_publication(self):
        import s36_library_cache as tool
        h, _ = self.image()
        self.b36(h)
        before = self.snapshot()
        identity = feature_id()
        with patch.object(tool, 'feature_id', side_effect=[identity, 'f'*64]):
            with self.assertRaisesRegex(ValueError, 'namespace changed'):
                self.run_prepare({h: 'image'})
        self.assertEqual(self.snapshot(), before)

    def test_hash_mismatch_and_changed_source_never_published(self):
        h, path = self.image()
        self.b36(h)
        self.encoder.after_extract = lambda p: p.write_bytes(b'changed by fixture')
        with self.assertRaisesRegex(ValueError, 'Source changed'):
            self.run_prepare({h: 'image'})
        self.assertFalse(S36FeatureCache(self.library / '.cache/characters').path(h).exists())
        report = self.run_prepare({h: 'image'}, dry_run=True)
        self.assertEqual(report['skipped_by_reason'], {'source_hash_mismatch': 1})

    def test_source_hash_checked_after_decode_before_detector(self):
        import s36_library_cache as tool
        original = tool.checked_image
        h, path = self.image()
        def changed(*args):
            result = original(*args)
            path.write_bytes(b'changed while decoding')
            return result
        with patch.object(tool, 'checked_image', side_effect=changed):
            with self.assertRaisesRegex(ValueError, 'decoding'):
                self.run_prepare({h: 'image'})
        self.assertEqual(self.factories, 0)

    def test_readonly_dataset_and_hash_list_validation(self):
        h, _ = self.image()
        data = {'schema': SCHEMA, 'assets': [{'content_hash': h, 'media_kind': 'image'}]}
        dataset = self.root / 'dataset.json'
        dataset.write_text(json.dumps({'dataset': data, 'sha256': hashlib.sha256(canonical(data)).hexdigest()}))
        before = dataset.read_bytes()
        self.assertEqual(candidates(dataset=dataset), {h: 'image'})
        self.assertEqual(dataset.read_bytes(), before)
        data['assets'].append({'content_hash': h, 'media_kind': 'video'})
        hashes = self.root / 'hashes.json'
        hashes.write_text(json.dumps(data['assets']))
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            candidates(hashes=hashes)

    def test_symlink_escape_refused_and_invalid_hash_never_globbed(self):
        h, path = self.image()
        external = self.root / 'outside.png'
        external.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(external)
        with self.assertRaisesRegex(ValueError, 'escapes'):
            locate(self.library, [h])
        with self.assertRaisesRegex(ValueError, 'Invalid'):
            locate(self.library, ['../escape'])
        path.unlink()
        path.write_bytes(external.read_bytes())
        (self.library / '.cache').symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            self.run_prepare({h: 'image'})

    def test_detector_reuses_runtime_helpers_and_two_thread_sessions(self):
        import character_encoder as encoder
        from runtime import decode, expanded_box
        raw = np.zeros((1, 8400, 6), np.float32)
        raw[0, 1010, 2:4] = 2
        raw[0, 1010, 4:] = [.9, 1]
        class Detector:
            def get_inputs(self):
                return [type('Input', (), {'name': 'input'})()]
            def run(self, *args):
                return [raw]
        calls = []
        def session(path, **kwargs):
            calls.append((path, kwargs['sess_options']))
            return Detector()
        def digest(path):
            return encoder.SMALL_SHA256 if str(path) == 's36' else encoder.BASELINE['sha256']['character-detector.onnx']
        with patch.object(encoder, 'sha256', side_effect=digest), patch.object(encoder.ort, 'InferenceSession', side_effect=session):
            engine = SmallEncoder('s36', 'detector')
            image = Image.new('RGB', (640, 640))
            actual = engine.detect(image)
        boxes, scores = decode(raw, image.size, 1)
        expected = [expanded_box(boxes[i], image.size) for i in np.argsort(scores)[::-1][:8]]
        expected = [b for b in expected if min(b[2]-b[0], b[3]-b[1]) >= 24]
        self.assertEqual(actual, expected)
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(opts.intra_op_num_threads <= 2 and opts.inter_op_num_threads == 1 for _, opts in calls))


if __name__ == '__main__':
    unittest.main()
