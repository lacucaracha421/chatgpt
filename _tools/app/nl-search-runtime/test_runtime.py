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
# Fixture captions and auto-tags for the "no match" gate. Built so the examples below behave as with
# the 2026-10-05 trial captions; the Rust tests (library/nl_search_tests.rs) use the same texts.
GATE_CAPTIONS = [
    '은발에 안경을 쓴 여자가 파란 머리 포니테일 소녀와 서 있다. 셔츠에는 girl with 문구.',
    '해가 지는 하늘 아래, 비가 오는 도시 거리.',
    '아무도 없는 방에서 드라마를 보며 가나 초콜릿을 먹고, 신발을 신고 있다.',
]
GATE_TAGS = ['maid_headdress', 'glasses', 'rating:g', 'looking_at_viewer']
GATE_PASS = ['은발에 안경 쓴 여자', '파란 머리 트윈테일', '노을 지는 하늘', '비 오는 밤 도시 거리', 'maid',
             'girl with glasses']
GATE_NO_MATCH = ['ㅁㄴㅇㄹ', 'ㅋㅋㅋㅋㅋ', '아무말 대잔치', '가나다라마바사', '세금 신고 마감일', 'asdfqwer',
                 'zxcv bnm', '1234 5678']


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

    def write_captions(self, texts=GATE_CAPTIONS):
        path = self.root / 'state' / 'captions.jsonl'
        path.write_text(''.join(json.dumps({'id': f'id-{i}', 'text': text, 'secs': 1.0}, ensure_ascii=False) + '\n'
                                for i, text in enumerate(texts)) + '\n', encoding='utf-8')
        return path

    def test_tokeniser_units(self):
        from runtime_support import tag_words, text_units
        self.assertEqual(text_units('파란 머리 트윈테일'),
                         [('k', '파란'), ('k', '머리'), ('k', '트윈'), ('k', '윈테'), ('k', '테일')])
        self.assertEqual(text_units('노을 지는 하늘'), [('k', '노을'), ('k', '지는'), ('k', '하늘')])
        self.assertEqual(text_units('비 오는 밤'), [('k', '오는')])  # one-character tokens count nothing
        self.assertEqual(text_units('ㅋㅋㅋ'), [('k', 'ㅋㅋ'), ('k', 'ㅋㅋ')])  # jamo are Hangul; repeats count
        self.assertEqual(text_units('Girl, WITH glasses!'), [('w', 'girl'), ('w', 'with'), ('w', 'glasses')])
        self.assertEqual(text_units('1234 5678 ab x1y2 \u00e9t\u00e9'), [])  # digits, short or mixed words
        self.assertEqual(text_units('SD캐릭터 3월'), [('k', 'sd'), ('k', 'd캐'), ('k', '캐릭'), ('k', '릭터'),
                                                   ('k', '3월')])
        self.assertEqual(text_units('메이드복(maid)'), [('k', '메이'), ('k', '이드'), ('k', '드복'), ('w', 'maid')])
        self.assertEqual(tag_words(['Maid_headdress', 'rating:g', 'looking_at_viewer', 'hat (object)', '1girl']),
                         {'maid', 'headdress', 'rating', 'looking', 'viewer', 'hat', 'object', '1girl'})

    def test_gate_examples_with_fixture_vocabulary(self):
        from runtime_support import caption_vocabulary, tag_words
        vocab = caption_vocabulary(self.write_captions())
        words = tag_words(GATE_TAGS)
        for query in GATE_PASS:
            self.assertTrue(self.rank.gate_passes(query, vocab, words), query)
        for query in GATE_NO_MATCH:
            self.assertFalse(self.rank.gate_passes(query, vocab, words), query)
        self.assertEqual(self.rank.coverage('파란 머리 트윈테일', vocab, words), (3, 5))
        self.assertEqual(self.rank.coverage('노을 지는 하늘', vocab, words), (2, 3))
        self.assertEqual(self.rank.coverage('1234 5678', vocab, words), (0, 0))
        self.assertEqual(self.rank.coverage('maid', vocab, set()), (0, 1))  # known only as a tag word
        # No vocabulary: the gate is off.
        self.assertTrue(self.rank.gate_passes('ㅁㄴㅇㄹ', set(), words))
        self.assertIsNone(caption_vocabulary(self.root / 'state' / 'missing.jsonl'))

    def test_export_with_and_without_captions_vocabulary(self):
        from runtime_support import caption_vocabulary
        first = self.export()
        path = self.inbox / 'nl-search-latest.sqlite'
        with closing(sqlite3.connect(path)) as c:
            self.assertFalse(c.execute("SELECT name FROM sqlite_master WHERE name='vocab'").fetchall())
            self.assertNotIn('vocab_count', dict(c.execute('SELECT key,value FROM meta')))
        self.assertEqual(first['vocab_count'], 0)
        vocab = caption_vocabulary(self.write_captions())
        second = self.index.export_inbox(self.store, self.rows, self.inbox, ['siglip'], vocab)
        self.assertTrue(second['changed'])
        self.assertNotEqual(first['digest'], second['digest'])
        self.assertEqual(second['vocab_count'], len(vocab))
        with closing(sqlite3.connect(path)) as c:
            meta = dict(c.execute('SELECT key,value FROM meta'))
            self.assertEqual(meta['vocab_count'], str(len(vocab)))
            self.assertEqual(set(c.execute('SELECT kind,value FROM vocab')), vocab)
            self.assertEqual(c.execute("SELECT sql FROM sqlite_master WHERE name='vocab'").fetchone()[0],
                             'CREATE TABLE vocab(kind TEXT NOT NULL, value TEXT NOT NULL, '
                             'PRIMARY KEY(kind,value)) WITHOUT ROWID')
        self.assertFalse(self.index.export_inbox(self.store, self.rows, self.inbox, ['siglip'], set(vocab))['changed'])
        vocab.add(('k', '노을'))
        self.assertTrue(self.index.export_inbox(self.store, self.rows, self.inbox, ['siglip'], vocab)['changed'])
        # Captions gone (or empty): the table goes and the digest returns to the vocabulary-free one.
        self.assertEqual(self.index.export_inbox(self.store, self.rows, self.inbox, ['siglip'], None)['digest'],
                         first['digest'])
        self.assertEqual(self.index.export_inbox(self.store, self.rows, self.inbox, ['siglip'], set())['digest'],
                         first['digest'])

    def test_rank_gate_no_match_force_name_route_and_missing_vocab(self):
        from runtime_support import caption_vocabulary
        self.export()
        inbox = self.inbox / 'nl-search-latest.sqlite'
        response = {'ok': True, 'siglip': self.vector([0, 1]).tolist()}
        ranker = self.rank.Ranker(inbox, self.db)
        # Older export without vocab: the gate is off.
        self.assertEqual(ranker.rank('ㅁㄴㅇㄹ', response)['route'], 'siglip')
        self.index.export_inbox(self.store, self.rows, self.inbox, ['siglip'],
                                caption_vocabulary(self.write_captions()))
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute('CREATE TABLE auto_tag_vocabulary(tag TEXT PRIMARY KEY, category TEXT)')
            c.executemany('INSERT INTO auto_tag_vocabulary VALUES (?,?)', [(tag, 'general') for tag in GATE_TAGS])
        ranker = self.rank.Ranker(inbox, self.db)
        for query in GATE_NO_MATCH:
            # The worker response is not needed: no embedding happens.
            self.assertEqual(ranker.rank(query), {'route': 'no_match', 'asset_ids': []}, query)
        self.assertEqual(ranker.rank('ㅁㄴㅇㄹ', response, force=True), {'route': 'siglip', 'asset_ids': ['b', 'a', 'c']})
        for query in GATE_PASS:
            self.assertEqual(ranker.rank(query, response)['route'], 'siglip', query)
        # Name routes are never gated.
        self.assertEqual(ranker.rank('레제'), {'route': 'tags', 'asset_ids': ['a', 'b']})
        self.assertEqual(ranker.rank('레제 ㅁㄴㅇㄹ', response)['route'], 'mixed')
        self.assertEqual(ranker.rank('없는 ㅁㄴㅇㄹ')['route'], 'mixed_fallback')

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



class FakeCaptioner:
    """Stands in for the Qwen model: one scripted text per image; no GPU, no model files."""
    oom_errors = (MemoryError,)

    def __init__(self, fail_batches_over=None, empty=()):
        self.batches, self.fail_batches_over, self.empty = [], fail_batches_over, set(empty)

    def caption(self, images):
        if self.fail_batches_over is not None and len(images) > self.fail_batches_over:
            raise MemoryError('simulated out of memory')
        self.batches.append(list(images))
        return ['' if image in self.empty else 'Caption of ' + image + '\n\n키워드: 하나' for image in images]


class CaptionTests(unittest.TestCase):
    def setUp(self):
        import nl_caption
        import nl_index
        self.caption, self.index = nl_caption, nl_index
        self.root = HERE / ('fixture-' + uuid.uuid4().hex)
        self.root.mkdir()
        self.addCleanup(shutil.rmtree, self.root)
        self.db = self.root / 'library.sqlite'
        with closing(sqlite3.connect(self.db)) as c, c:
            c.executescript('''
                CREATE TABLE assets(id TEXT PRIMARY KEY, content_hash TEXT,
                  relative_path TEXT, status TEXT, media_kind TEXT);
                INSERT INTO assets VALUES ('a','h-a','a.jpg','normal','image'),
                  ('b','h-b','b.gif','normal','gif'), ('c','h-c','c.jpg','normal','image'),
                  ('d','h-a','d.jpg','normal','image'), ('e','h-e','e.jpg','normal','image'),
                  ('gone','h-g','g.jpg','trash','image'), ('video','h-v','v.mp4','normal','video');
            ''')
        self.rows = self.index.corpus(self.db)
        self.path = self.root / 'state' / 'captions.jsonl'

    def seed(self, *records):
        self.path.parent.mkdir(exist_ok=True)
        self.path.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records), encoding='utf-8')

    def lines(self):
        return [json.loads(line) for line in self.path.read_text(encoding='utf-8').splitlines()]

    def run_rows(self, captioner, todo, **kwargs):
        kwargs.setdefault('limit', 100)
        kwargs.setdefault('max_seconds', 100)
        return self.caption.caption_rows(captioner, todo, lambda row: row['id'], self.path, **kwargs)

    def test_plan_only_missing_images_and_content_hash_reuse(self):
        records = {'a': {'id': 'a', 'text': 'known', 'model': '8B'}, 'b': {'id': 'b', 'text': '  '}}
        copies, todo = self.caption.plan(self.rows, records)
        # d shares content with a, so it copies a's text; b has an empty text; trash and video are no corpus.
        self.assertEqual([r['id'] for r in copies], ['d'])
        self.assertEqual((copies[0]['text'], copies[0]['copied_from']), ('known', 'a'))
        self.assertEqual([r['id'] for r in todo], ['b', 'c', 'e'])

    def test_batches_append_resume_and_never_recaption(self):
        self.seed({'id': 'a', 'text': 'seed', 'secs': 1.0, 'model': '8B'})
        records = self.caption.load_records(self.path)
        _, todo = self.caption.plan(self.rows, records)
        first = self.run_rows(FakeCaptioner(), todo, limit=2, batch_size=2)
        self.assertEqual((first['captioned'], first['stopped']), (2, 'limit'))
        self.assertEqual([r['id'] for r in self.lines()], ['a', 'b', 'c'])
        records = self.caption.load_records(self.path)
        copies, todo = self.caption.plan(self.rows, records)
        self.assertEqual([r['id'] for r in todo], ['e'])
        fake = FakeCaptioner()
        second = self.run_rows(fake, todo, batch_size=8)
        self.assertEqual((second['captioned'], second['stopped'], fake.batches), (1, None, [['e']]))
        done = self.lines()[-1]
        self.assertEqual((done['id'], done['model']), ('e', '8B'))
        self.assertTrue(done['text'].startswith('Caption of e'))
        self.assertEqual(self.caption.plan(self.rows, self.caption.load_records(self.path))[1], [])

    def test_time_budget_stops_before_next_batch(self):
        ticks = iter(range(0, 1000, 10))
        _, todo = self.caption.plan(self.rows, {})
        report = self.run_rows(FakeCaptioner(), todo, max_seconds=25, batch_size=1, clock=lambda: next(ticks))
        self.assertEqual(report['stopped'], 'time')
        self.assertGreater(report['captioned'], 0)
        self.assertLess(report['captioned'], len(todo))

    def test_errors_do_not_stop_the_run_and_empty_text_is_not_stored(self):
        _, todo = self.caption.plan(self.rows, {})
        def open_image(row):
            if row['id'] == 'b':
                raise OSError('unreadable')
            return row['id']
        report = self.caption.caption_rows(FakeCaptioner(empty={'c'}), todo, open_image, self.path, 100, 100, 8)
        self.assertEqual(sorted(e['id'] for e in report['errors']), ['b', 'c'])
        self.assertEqual([r['id'] for r in self.lines()], ['a', 'd', 'e'])
        # Both failures stay missing, so the next run retries them.
        self.assertEqual([r['id'] for r in self.caption.plan(self.rows, self.caption.load_records(self.path))[1]],
                         ['b', 'c'])

    def test_out_of_memory_halves_the_batch(self):
        _, todo = self.caption.plan(self.rows, {})
        fake = FakeCaptioner(fail_batches_over=2)
        report = self.run_rows(fake, todo, batch_size=8)
        self.assertEqual(report['captioned'], len(todo))
        self.assertTrue(all(len(batch) <= 2 for batch in fake.batches))
        with self.assertRaises(RuntimeError):
            self.run_rows(FakeCaptioner(fail_batches_over=0), todo, batch_size=1)

    def test_interrupted_final_line_is_repaired_before_appending(self):
        self.seed({'id': 'a', 'text': '하나', 'model': '8B'})
        with self.path.open('a', encoding='utf-8', newline='\n') as stream:
            stream.write('{"id": "b", "text": "둘')  # crash in the middle of an append
        from runtime_support import caption_vocabulary, read_captions
        self.assertEqual(list(read_captions(self.path)), ['a'])
        self.assertTrue(caption_vocabulary(self.path))
        records = self.caption.load_records(self.path)
        self.assertEqual(list(records), ['a'])
        self.caption.append_records(self.path, [{'id': 'c', 'text': '셋'}])
        self.assertEqual([r['id'] for r in self.lines()], ['a', 'c'])
        # Damage in the middle is never silently skipped.
        self.path.write_text('{"id":"a","text":"x"}\nbroken\n{"id":"c","text":"y"}\n', encoding='utf-8')
        with self.assertRaises(json.JSONDecodeError):
            read_captions(self.path)

    def test_later_record_wins_and_missing_file_is_none(self):
        from runtime_support import read_captions
        self.assertIsNone(read_captions(self.root / 'missing.jsonl'))
        self.seed({'id': 'a', 'text': 'old'}, {'id': 'a', 'text': 'new'})
        self.assertEqual(read_captions(self.path)['a']['text'], 'new')

    def test_dry_run_counts_without_loading_a_model(self):
        self.seed({'id': 'a', 'text': 'seed'})
        report = self.caption.main(['--library', str(self.root), '--state', str(self.root / 'state'),
                                    '--db', str(self.db), '--dry-run'])
        self.assertEqual((report['corpus_count'], report['existing'], report['copied'], report['missing']),
                         (5, 1, 1, 3))
        self.assertEqual(len(self.lines()), 1)  # a dry run writes nothing

    def test_main_with_nothing_missing_loads_no_model_and_copies_duplicates(self):
        self.seed(*({'id': i, 'text': 'text ' + i} for i in ('a', 'b', 'c', 'e')))
        with patch('runtime_support.QwenCaptioner', side_effect=AssertionError('model must not load')):
            report = self.caption.main(['--library', str(self.root), '--state', str(self.root / 'state'),
                                        '--db', str(self.db)])
        self.assertEqual((report['copied'], report['missing'], report['remaining']), (1, 0, 0))
        self.assertEqual(self.lines()[-1]['id'], 'd')
        self.assertTrue((self.root / 'state' / 'last-caption-run.json').is_file())

    def test_export_has_captions_table_nfc_corpus_only_and_digest(self):
        store = self.index.VectorStore(self.root / 'vstate')
        self.addCleanup(store.close)
        for row in self.rows:
            vector = np.zeros(1152, dtype=np.float32)
            vector[0] = 1
            store.put_batch('siglip', [(row['content_hash'], vector)])
        inbox = self.root / 'inbox'
        path = inbox / 'nl-search-latest.sqlite'
        bare = self.index.export_inbox(store, self.rows, inbox, ['siglip'])
        with closing(sqlite3.connect(path)) as c:
            self.assertFalse(c.execute("SELECT name FROM sqlite_master WHERE name='captions'").fetchall())
            self.assertNotIn('caption_count', dict(c.execute('SELECT key,value FROM meta')))
        self.seed({'id': 'a', 'text': ' 안녕 '}, {'id': 'gone', 'text': '휴지통'}, {'id': 'zzz', 'text': '없음'},
                  {'id': 'b', 'text': '사하'})  # decomposed Hangul becomes NFC
        from runtime_support import read_captions
        records = read_captions(self.path)
        captions = self.index.export_captions(records, self.rows)
        self.assertEqual(captions, {'a': '안녕', 'b': '사하'})
        first = self.index.export_inbox(store, self.rows, inbox, ['siglip'], self.index.vocabulary(records), captions)
        self.assertTrue(first['changed'])
        self.assertEqual(first['caption_count'], 2)
        self.assertNotEqual(first['digest'], bare['digest'])
        with closing(sqlite3.connect(path)) as c:
            self.assertEqual(dict(c.execute('SELECT asset_id,text FROM captions')), captions)
            self.assertEqual(dict(c.execute('SELECT key,value FROM meta'))['caption_count'], '2')
            self.assertEqual(c.execute("SELECT sql FROM sqlite_master WHERE name='captions'").fetchone()[0],
                             'CREATE TABLE captions(asset_id TEXT PRIMARY KEY, text TEXT NOT NULL)')
        same = self.index.export_inbox(store, self.rows, inbox, ['siglip'], self.index.vocabulary(records), dict(captions))
        self.assertFalse(same['changed'])
        captions['a'] = '다른 설명'
        self.assertTrue(self.index.export_inbox(store, self.rows, inbox, ['siglip'], None, captions)['changed'])
        self.assertEqual(self.index.export_inbox(store, self.rows, inbox, ['siglip'], None, None)['digest'],
                         bare['digest'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
