"""Fixture contracts and optional real-snapshot acceptance. No model loads here."""
import importlib.util
from contextlib import closing
import io
import json
import os
from pathlib import Path
import sqlite3
import shutil
import uuid
import unittest
from unittest.mock import patch

import numpy as np

HERE = Path(__file__).resolve().parent


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('nl_index'), 'index component is missing')
        import nl_index
        import nl_rank_reference
        import nl_query_worker
        self.index, self.rank, self.worker = nl_index, nl_rank_reference, nl_query_worker
        # Python 3.14 TemporaryDirectory creates private ACLs the managed sandbox
        # cannot reopen. Ordinary mkdir inherits the writable runtime ACL.
        self.root = HERE / ('fixture-' + uuid.uuid4().hex)
        self.root.mkdir()
        self.addCleanup(shutil.rmtree, self.root)
        self.db = self.root / 'library.sqlite'
        with closing(sqlite3.connect(self.db)) as c, c:
            c.executescript('''
                CREATE TABLE assets(id TEXT PRIMARY KEY, content_hash TEXT,
                  relative_path TEXT, status TEXT, media_kind TEXT);
                CREATE TABLE character_targets(id TEXT PRIMARY KEY, display_name TEXT,
                  series_classification_id TEXT);
                CREATE TABLE classification_entries(id TEXT PRIMARY KEY, name TEXT);
                INSERT INTO classification_entries VALUES ('csm','체인소맨'), ('zzz','젠레스');
                CREATE TABLE character_target_tagger_tags(target_id TEXT, tag TEXT);
                CREATE TABLE asset_auto_tags(asset_id TEXT, tag TEXT, score REAL);
                INSERT INTO assets VALUES ('a','hash-a','a.jpg','normal','image'),
                  ('b','hash-b','b.gif','normal','gif'), ('c','hash-c','c.jpg','normal','image'),
                  ('gone','hash-gone','g.jpg','trash','image'),
                  ('video','hash-video','v.mp4','normal','video');
                INSERT INTO character_targets VALUES ('target','레제/Reze','csm'), ('empty','없는',NULL);
                INSERT INTO character_target_tagger_tags VALUES ('target','reze'),('target','reze_alt');
                INSERT INTO asset_auto_tags VALUES ('a','reze',0.35),('b','reze',0.7),
                  ('a','reze_alt',0.7),('c','reze',0),('gone','reze',1);
            ''')
        self.store = self.index.VectorStore(self.root / 'state')
        self.addCleanup(self.store.close)
        self.rows = self.index.corpus(self.db)
        self.vectors = {'a': [1, 0], 'b': [0, 1], 'c': [-1, 0]}
        for row in self.rows:
            self.store.put_batch('siglip', [(row['content_hash'], self.vector(self.vectors[row['id']]))])
        self.inbox = self.root / 'inbox'

    def export(self):
        return self.index.export_inbox(self.store, self.rows, self.inbox, ['siglip'])

    @staticmethod
    def vector(values):
        return np.pad(np.asarray(values, dtype=np.float32), (0, 1152-len(values)))

    def test_content_hash_reuses_after_move_and_model_or_preprocess_invalidates(self):
        moved = dict(self.rows[0], id='reimported', relative_path='moved.jpg')
        self.assertTrue(self.store.contains(moved['content_hash'], 'siglip'))
        self.assertFalse(self.store.contains(moved['content_hash'], 'qwen8b'))
        self.assertFalse(self.store.contains(moved['content_hash'], 'siglip', preprocess='different'))
        self.assertFalse(self.store.contains(moved['content_hash'], 'siglip', model_id='different'))

    def test_export_schema_float16_and_unchanged_skip(self):
        first = self.export()
        path = self.inbox / 'nl-search-latest.sqlite'
        before = path.read_bytes(), path.stat().st_mtime_ns
        with closing(sqlite3.connect(path)) as c:
            meta = dict(c.execute('SELECT key,value FROM meta'))
            self.assertEqual((meta['format'], meta['version'], meta['asset_count']),
                             ('lakomics-nl-search', '1', '3'))
            self.assertEqual(meta['siglip_dim'], '1152')
            self.assertEqual([r[0] for r in c.execute('SELECT asset_id FROM siglip ORDER BY asset_id')], ['a','b','c'])
            blob = c.execute("SELECT vector FROM siglip WHERE asset_id='a'").fetchone()[0]
            self.assertEqual(len(blob), 2304)
            np.testing.assert_array_equal(np.frombuffer(blob, dtype='<f2')[:2], [1, 0])
            self.assertFalse(c.execute("SELECT name FROM sqlite_master WHERE name='qwen8b'").fetchall())
        self.assertTrue(first['changed'])
        self.assertFalse(self.export()['changed'])
        self.assertEqual(before, (path.read_bytes(), path.stat().st_mtime_ns))

    def test_atomic_export_failure_preserves_old_and_publish_is_complete(self):
        self.export()
        path = self.inbox / 'nl-search-latest.sqlite'
        old = path.read_bytes()
        self.store.put_batch('siglip', [('hash-a', self.vector([0.6, 0.8]))])
        import os
        replace = os.replace
        def inspect(source, destination):
            self.assertEqual(path.read_bytes(), old)
            with closing(sqlite3.connect(source)) as c:
                self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                self.assertEqual(c.execute('SELECT count(*) FROM siglip').fetchone()[0], 3)
            raise OSError('simulated interrupted publish')
        with patch('nl_index.os.replace', side_effect=inspect):
            with self.assertRaisesRegex(OSError, 'interrupted'):
                self.export()
        self.assertEqual(path.read_bytes(), old)
        self.assertEqual(list(self.inbox.glob('*.tmp')), [])
        with patch('nl_index.os.replace', wraps=replace):
            self.assertTrue(self.export()['changed'])

    def test_alias_tags_only_mixed_threshold_fallback_and_no_hit(self):
        self.export()
        ranker = self.rank.Ranker(self.inbox / 'nl-search-latest.sqlite', self.db)
        response = {'ok': True, 'siglip': self.vector([0, 1]).tolist()}
        for query in ('레제', 'Reze', '레제 Reze'):
            result = ranker.rank(query, response)
            self.assertEqual(result, {'route': 'tags', 'asset_ids': ['a','b']})
        self.assertEqual(ranker.rank('레제 웃는', response),
                         {'route':'mixed', 'asset_ids':['b','a']})
        self.assertEqual(ranker.rank('없는 웃는', response),
                         {'route':'mixed_fallback', 'asset_ids':[]})
        self.assertEqual(ranker.rank('풍경', response)['asset_ids'], ['b','a','c'])
        self.assertEqual(ranker.rank('레제는', response)['route'], 'siglip')
        self.assertEqual(ranker.rank('풍경', response, top=0)['asset_ids'], [])
        # The character's series folder name and any words between it and the name stay on the name route.
        for query in ('체인소맨 레제', '레제 체인소맨', '체인소맨 톱 맨 레제'):
            self.assertEqual(ranker.rank(query, response)['route'], 'tags', query)
        self.assertEqual(ranker.rank('체인소맨 레제 웃는', response)['route'], 'mixed')
        self.assertEqual(ranker.rank('젠레스 레제', response)['route'], 'mixed')  # another series' name
        # Boundary 0.35 is included, 0.349 is excluded; tag-only keeps both.
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute('DELETE FROM asset_auto_tags')
            c.executemany('INSERT INTO asset_auto_tags VALUES (?,?,?)',
                          [('a','reze',0.35),('b','reze',0.349)])
        ranker = self.rank.Ranker(self.inbox / 'nl-search-latest.sqlite', self.db)
        self.assertEqual(ranker.rank('레제 웃는', response)['asset_ids'], ['a'])

    def test_invalid_vectors_rejected_without_partial_batch(self):
        with self.assertRaises(ValueError):
            self.store.put_batch('siglip', [('new', self.vector([1, 0])), ('bad', self.vector([float('nan'), 1]))])
        self.assertFalse(self.store.contains('new', 'siglip'))
        with self.assertRaises(ValueError):
            self.store.put_batch('siglip', [('bad', [0, 0])])
        with self.assertRaises(ValueError):
            self.store.put_batch('siglip', [('wrong-dimension', [1, 0])])

    def test_qwen_export_optional_table_actual_dimension_and_order_independent_digest(self):
        qwen = np.zeros(4096, dtype=np.float32)
        qwen[0] = 1
        self.store.put_batch('qwen8b', [('hash-a', qwen)])
        self.index.export_inbox(self.store, self.rows, self.inbox, ['siglip','qwen8b'])
        with closing(sqlite3.connect(self.inbox / 'nl-search-latest.sqlite')) as c:
            meta = dict(c.execute('SELECT key,value FROM meta'))
            self.assertEqual(meta['qwen_dim'], '4096')
            self.assertEqual(len(c.execute('SELECT vector FROM qwen8b').fetchone()[0]), 8192)
        self.assertFalse(self.index.export_inbox(self.store, self.rows, self.inbox, ['qwen8b','siglip'])['changed'])

    def test_oversize_protocol_line_is_drained_and_next_request_works(self):
        class Encoder:
            def embed(self, text):
                return {'en':'smile', 'siglip':[1., 0.]}
        source = io.StringIO('x'*(self.worker.MAX_MESSAGE_BYTES+20)+'\n' +
                             '{"id":"next","op":"embed","text":"x"}\n')
        output = io.StringIO()
        self.worker.serve(Encoder(), source, output, {})
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertFalse(lines[1]['ok'])
        self.assertEqual(lines[2]['id'], 'next')

    def test_seed_maps_ids_to_hashes_and_supports_checkpoints_and_aggregate(self):
        folder = self.root / 'trial' / 'siglip'
        (folder / 'vectors').mkdir(parents=True)
        (folder / 'ids.json').write_text(json.dumps(['b','a','gone']), encoding='utf-8')
        np.save(folder / 'emb.npy', np.stack([self.vector([1,0]), self.vector([-1,0]), self.vector([0,1])]).astype('<f2'))
        np.save(folder / 'vectors' / 'b.npy', self.vector([0,1]).astype('<f2'))
        store = self.index.VectorStore(self.root / 'seed-state')
        self.addCleanup(store.close)
        stats = self.index.seed_from_trial(store, self.rows, self.root / 'trial', ['siglip'])
        self.assertEqual(stats['siglip']['imported'], 2)
        self.assertFalse(store.contains('hash-gone', 'siglip'))
        np.testing.assert_array_equal(np.frombuffer(store.get('hash-b','siglip'),dtype='<f2')[:2], [0,1])
        np.testing.assert_array_equal(np.frombuffer(store.get('hash-a','siglip'),dtype='<f2')[:2], [-1,0])
        self.assertEqual(self.index.seed_from_trial(store, self.rows, self.root / 'trial', ['siglip'])['siglip']['cached'], 2)

    def test_preprocess_first_gif_frame_no_upscale_long_side_and_exif(self):
        from PIL import Image
        from runtime_support import packed_image
        gif = self.root / 'animated.gif'
        red = Image.new('RGB',(32,16),'red')
        blue = Image.new('RGB',(32,16),'blue')
        red.save(gif, save_all=True, append_images=[blue], duration=20, loop=0)
        with packed_image(gif) as image:
            self.assertEqual((image.mode,image.size), ('RGB',(32,16)))
            self.assertGreater(image.getpixel((10,8))[0], 250)
            self.assertLess(image.getpixel((10,8))[2], 5)
        jpg = self.root / 'large.jpg'
        large = Image.new('RGB',(2048,1024),'white')
        exif = Image.Exif()
        exif[274] = 6
        large.save(jpg, exif=exif)
        with packed_image(jpg) as image:
            self.assertEqual(image.size, (512,1024))
        red.close()
        blue.close()
        large.close()

    def test_read_only_connection_cannot_modify_library(self):
        from runtime_support import read_only
        with closing(read_only(self.db)) as c:
            with self.assertRaises(sqlite3.OperationalError):
                c.execute("DELETE FROM assets")

    def test_protocol_ready_embed_error_shutdown_and_eof(self):
        class Encoder:
            def embed(self, text):
                return {'en':'smile', 'siglip':[0.123456789, 0.987654321]}
        source = io.StringIO('{"id":"one","op":"embed","text":"웃는"}\n'
                             '{"id":"bad","op":"other"}\n[]\n{broken\n'
                             '{"id":"empty","op":"embed","text":""}\n'
                             '{"op":"shutdown"}\n{"id":"after","op":"embed","text":"x"}\n')
        output = io.StringIO()
        self.worker.serve(Encoder(), source, output, {'load_seconds':0})
        lines = [json.loads(s) for s in output.getvalue().splitlines()]
        self.assertEqual(lines[0]['type'], 'ready')
        self.assertEqual(lines[1]['siglip'], [0.123457, 0.987654])
        self.assertEqual(lines[1]['id'], 'one')
        self.assertTrue(all(not x['ok'] for x in lines[2:6]))
        self.assertEqual(len(lines), 6)
        empty = io.StringIO()
        self.worker.serve(Encoder(), io.StringIO(''), empty, {})
        self.assertEqual(len(empty.getvalue().splitlines()), 1)

    def test_real_snapshot_h_opus(self):
        trial_root = os.environ.get('LAKOMICS_NL_SEARCH_TRIAL')
        if not trial_root:
            self.skipTest('set LAKOMICS_NL_SEARCH_TRIAL to opt into trial snapshot acceptance')
        trial = Path(trial_root)
        export = trial / 'runtime' / 'inbox' / 'nl-search-latest.sqlite'
        responses = trial / 'runtime' / 'worker-responses.json'
        if not export.exists() or not responses.exists():
            self.skipTest('real export/live worker responses absent; run smoke_runtime.py first')
        report = self.rank.check_equivalence(export, trial / 'library-snapshot.sqlite',
                                             trial, json.loads(responses.read_text(encoding='utf-8')))
        self.assertEqual(report['checked'], 32)
        # CPU fp32 query vectors (trial used GPU fp16) may swap near-tied neighbours: the top-10 set
        # must match for every query and the exact order for at least 30 of 32.
        self.assertTrue(all(set(m['expected']) == set(m['actual']) for m in report['mismatches']), report['mismatches'])
        self.assertLessEqual(len(report['mismatches']), 2)

    def test_offline_opus_snapshot_resolves_without_unused_model_card(self):
        from runtime_support import OPUS, require_snapshot
        snapshot = self.root / 'hf' / 'hub' / ('models--' + OPUS.replace('/', '--')) / 'snapshots' / 'fixture'
        snapshot.mkdir(parents=True)
        (snapshot / 'pytorch_model.bin').write_bytes(b'fixture')
        with patch.dict(os.environ, {'HF_HOME': str(self.root / 'hf')}), patch(
                'huggingface_hub.snapshot_download', return_value=str(snapshot)) as download:
            self.assertEqual(require_snapshot(OPUS), snapshot)
            self.assertTrue(download.call_args.kwargs['local_files_only'])
            self.assertNotIn('README.md', download.call_args.kwargs['allow_patterns'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
