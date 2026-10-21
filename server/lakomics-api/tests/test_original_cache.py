"""Original tickets and signed downloads with SQLite fixtures and stub R2 only."""
import hashlib
import io
import os
from pathlib import Path
import sqlite3
import tempfile
from contextlib import contextmanager
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from tests.test_capture_api_stub import fake_s3
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

import media_tickets
import original_cache as originals
import picker


class OriginalCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = b'original-image-bytes'
        self.asset = dict(id='image', kind='image', committed=1, content_type='image/png',
                          size_bytes=len(self.data), sha256=hashlib.sha256(self.data).hexdigest(),
                          object_key='library/image/original', thumbnail_key='thumb/image')
        self.cache = originals.OriginalCache(self.root / 'original-cache')
        self.storage = Mock()
        self.storage.get_object.side_effect = lambda **_: {
            'Body': io.BytesIO(self.data), 'ContentLength': len(self.data), 'ContentType': 'image/png'}
        self.storage.head_object.return_value = dict(ContentLength=len(self.data), ContentType='image/png')
        self.database = self.root / 'fixture.sqlite'
        with self.db() as db:
            db.execute('CREATE TABLE visible_assets(id TEXT, kind TEXT, committed INTEGER, content_type TEXT, '
                       'size_bytes INTEGER, sha256 TEXT, object_key TEXT, thumbnail_key TEXT)')
            db.execute('INSERT INTO visible_assets VALUES(:id,:kind,:committed,:content_type,'
                       ':size_bytes,:sha256,:object_key,:thumbnail_key)', self.asset)
            db.commit()
        self.api = SimpleNamespace(
            DB_PATH=self.database, API_TOKEN='fixture-server-secret', get_db=self.db,
            _s3=self.storage, R2_BUCKET='bucket', client_guard=lambda *_: self.guard,
            require_extension_client=self.guard, _ticket_digest=media_tickets._ticket_digest,
            _ticket_head=lambda asset, variant, key, **_: self.storage.head_object(Bucket='bucket', Key=key),
            _persist_thumbnail_metadata=Mock(), MEDIA_TICKET_TTL_SECONDS=300,
            presign_get=Mock(side_effect=lambda key, ttl: f'https://r2.example.test/{key}?ttl={ttl}'))
        self.enterContext(patch.object(media_tickets, 'api', self.api, create=True))
        self.enqueue = self.enterContext(patch.object(originals.background, 'enqueue'))
        app = FastAPI()
        media_tickets.register(app, self.api)
        picker.register(app, self.api)
        # Uvicorn's trusted proxy handling supplies the same request base used by
        # extension_profile. Untrusted forwarded headers are not read by our code.
        app.add_middleware(ProxyHeadersMiddleware, trusted_hosts='*')
        self.client = TestClient(app, base_url='https://api.internal')
        self.addCleanup(self.client.close)
        self.headers = {'Authorization': 'Bearer reader'}

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.database)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    def guard(self, authorization):
        if authorization != 'Bearer reader':
            raise HTTPException(401)

    def ticket(self, kind='single', variant='original'):
        if kind == 'single':
            response = self.client.post('/v1/library/assets/image/media-ticket',
                                        headers=self.headers, json={'variant': variant})
            self.assertEqual(response.status_code, 200, response.text)
            return response.json()
        if kind == 'batch':
            response = self.client.post('/v1/library/media-tickets', headers=self.headers,
                                        json={'items': [{'asset_id': 'image', 'variant': variant}]})
            self.assertEqual(response.status_code, 200, response.text)
            value = response.json()['items'][0]
            self.assertTrue(value['ok'], value)
            return value
        response = self.client.get('/v1/picker/' + variant + '/image', headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def fill(self):
        self.assertEqual(self.cache.fill(self.storage, 'bucket', self.asset), 'done')

    def test_all_ticket_hits_skip_r2_and_serve_full_and_ranges(self):
        self.fill()
        for kind in ('single', 'batch', 'picker'):
            ticket = self.ticket(kind)
            self.assertTrue(ticket['url'].startswith('https://api.internal/v1/library/original-cache/'))
            if kind != 'picker':
                self.assertEqual(ticket['sha256'], self.asset['sha256'])
                self.assertEqual(ticket['size_bytes'], len(self.data))
                self.assertEqual(ticket['content_type'], 'image/png')
            else:
                self.assertEqual(ticket['sizeBytes'], len(self.data))
                self.assertEqual(ticket['contentType'], 'image/png')
            full = self.client.get(ticket['url'])
            self.assertEqual(full.status_code, 200)
            self.assertEqual(full.content, self.data)
            self.assertEqual(full.headers['content-length'], str(len(self.data)))
            self.assertEqual(full.headers['content-type'], 'image/png')
            self.assertRegex(full.headers['cache-control'], r'^private, max-age=\d+$')
            for header, expected in [('bytes=2-5', self.data[2:6]), ('bytes=3-', self.data[3:]),
                                     ('bytes=-4', self.data[-4:]), ('bytes=0-9999', self.data)]:
                response = self.client.get(ticket['url'], headers={'Range': header})
                self.assertEqual(response.status_code, 206)
                self.assertEqual(response.content, expected)
                self.assertEqual(response.headers['content-length'], str(len(expected)))
                self.assertTrue(response.headers['content-range'].endswith('/' + str(len(self.data))))
            for header in ('bytes=999-', 'bytes=9-2', 'bytes=0-1,4-5', 'bytes=-0', 'invalid'):
                response = self.client.get(ticket['url'], headers={'Range': header})
                self.assertEqual(response.status_code, 416)
                self.assertEqual(response.headers['content-range'], 'bytes */' + str(len(self.data)))
        self.storage.head_object.assert_not_called()
        self.api.presign_get.assert_not_called()
        self.enqueue.assert_not_called()

    def test_misses_return_r2_and_enqueue_for_all_ticket_paths(self):
        for kind in ('single', 'batch', 'picker'):
            self.assertTrue(self.ticket(kind)['url'].startswith('https://r2.example.test/'))
        self.assertEqual(self.enqueue.call_count, 3)
        self.storage.get_object.assert_not_called()

    def test_bad_digest_and_incomplete_or_oversized_downloads_are_discarded(self):
        for data in (b'x' * len(self.data), self.data[:-1], self.data + b'x'):
            self.storage.get_object.side_effect = lambda **_: {'Body': io.BytesIO(data)}
            self.assertEqual(self.cache.fill(self.storage, 'bucket', self.asset), 'failed')
            self.assertIsNone(self.cache.hit(self.asset))
            self.assertEqual([p for p in self.cache.root.rglob('*') if p.is_file()], [])

    def test_expired_forged_missing_and_wrong_digest_tokens_rejected(self):
        self.fill()
        url = self.ticket()['url']
        with patch.object(originals.time, 'time', return_value=0):
            expired = self.ticket()['url']
        self.assertEqual(self.client.get(expired).status_code, 404)
        parts = urlsplit(url)
        token = parse_qs(parts.query)['token'][0]
        for query in ('', urlencode({'token': token[:-1] + ('a' if token[-1] != 'a' else 'b')}),
                      urlencode({'token': 'invalid'})):
            self.assertEqual(self.client.get(urlunsplit(parts._replace(query=query))).status_code, 404)
        self.assertEqual(self.client.get(url.replace(self.asset['sha256'], 'f' * 64)).status_code, 404)

    def test_video_invalid_digest_and_uncommitted_rows_never_cached(self):
        self.fill()
        for changes in ({'kind': 'video', 'content_type': 'video/mp4'}, {'sha256': None},
                        {'sha256': '../bad'}, {'committed': 0}, {'size_bytes': originals.MAX_BYTES + 1}):
            asset = dict(self.asset, **changes)
            self.assertIsNone(self.cache.hit(asset))
            self.assertEqual(self.cache.fill(self.storage, 'bucket', asset), 'skipped')
            self.assertEqual(originals.ticket_url(self.api, asset, 'original', asset['object_key'],
                                                 'https://public.example/', 300),
                             self.api.presign_get(asset['object_key'], 300))
        self.enqueue.assert_not_called()
        self.assertIsNone(originals.metadata(self.api, self.asset, 'thumbnail'))
        with self.db() as db:
            db.execute("UPDATE visible_assets SET kind='video',content_type='video/mp4'")
            db.commit()
        for kind in ('single', 'batch'):
            self.assertTrue(self.ticket(kind)['url'].startswith('https://r2.example.test/'))
        self.enqueue.assert_not_called()

    def test_gif_cache_and_thumbnail_tickets_unchanged(self):
        asset = dict(self.asset, kind='gif', content_type='image/gif')
        self.assertEqual(self.cache.fill(self.storage, 'bucket', asset), 'done')
        with self.db() as db:
            db.execute("UPDATE visible_assets SET kind='gif',content_type='image/gif'")
            db.commit()
        self.assertEqual(self.client.get(self.ticket('picker')['url']).headers['content-type'], 'image/gif')
        for kind in ('single', 'batch', 'picker'):
            self.assertTrue(self.ticket(kind, 'thumbnail')['url'].startswith('https://r2.example.test/'))
        self.enqueue.assert_not_called()

    def test_request_origin_uses_proxy_scheme_and_preserved_host(self):
        self.fill()
        headers = dict(self.headers, Host='laku.example.test:8443', **{'X-Forwarded-Proto': 'https'})
        response = self.client.post('/v1/library/assets/image/media-ticket', headers=headers,
                                    json={'variant': 'original'})
        self.assertTrue(response.json()['url'].startswith('https://laku.example.test:8443/'))

    def test_secret_persists_without_api_token(self):
        self.api.API_TOKEN = ''
        first = originals._secret(self.api)
        self.assertEqual(len(first), 32)
        self.assertEqual(originals._secret(self.api), first)
        if os.name != 'nt':
            self.assertEqual((self.root / 'original-cache-secret').stat().st_mode & 0o777, 0o600)

    def test_background_admission_bounded_and_deduplicated(self):
        worker = originals.BackgroundFill()
        worker.started = True
        for index in range(300):
            worker.enqueue(self.cache, self.storage, 'bucket', dict(self.asset, sha256=f'{index:064x}'))
        worker.enqueue(self.cache, self.storage, 'bucket', dict(self.asset, sha256='0' * 64))
        worker.enqueue(self.cache, self.storage, 'bucket', dict(self.asset, kind='video'))
        self.assertEqual(worker.queue.qsize(), 256)
        self.assertEqual(len(worker.pending), 256)

    def test_warm_reads_only_skips_existing_and_excludes_videos(self):
        self.fill()
        with self.db() as db:
            # The warm reader installs its own TEMP visible-assets view.
            db.execute('ALTER TABLE visible_assets RENAME TO assets')
            miss = dict(self.asset, id='miss', sha256=hashlib.sha256(b'new').hexdigest(),
                        object_key='original/miss', size_bytes=3)
            db.execute('INSERT INTO assets VALUES(:id,:kind,:committed,:content_type,'
                       ':size_bytes,:sha256,:object_key,:thumbnail_key)', miss)
            db.execute("INSERT INTO assets SELECT 'video','video',1,'video/mp4',size_bytes,sha256,"
                       "object_key,thumbnail_key FROM assets WHERE id='image'")
            db.commit()
        self.storage.get_object.side_effect = lambda **_: {'Body': io.BytesIO(b'new'), 'ContentLength': 3}
        with patch('builtins.print') as output:
            self.assertEqual(originals.warm(self.database, self.storage, 'bucket'),
                             dict(done=1, skipped=1, failed=0))
        output.assert_called_once_with('done=1 skipped=1 failed=0')
        self.assertEqual(self.cache.hit(miss).read_bytes(), b'new')


if __name__ == '__main__':
    unittest.main()
