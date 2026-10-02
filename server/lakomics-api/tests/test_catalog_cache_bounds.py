"""Catalog cache tests call the transport directly; no sockets or TestClient."""
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from tests.test_capture_api_stub import fake_s3  # noqa: F401
import app


class CatalogCacheBoundsTests(unittest.TestCase):
    def setUp(self):
        app._catalog_cache.clear()
        self.addCleanup(app._catalog_cache.clear)

    def test_hits_preserve_body_status_and_original_expiry(self):
        with mock.patch.object(app.time, 'monotonic', return_value=100) as clock, mock.patch.object(
                app, '_catalog_fetch_with_retry', return_value=(200, b'page')) as fetch:
            first = app._catalog_cached_get('a')
            clock.return_value = 159
            hit = app._catalog_cached_get('a')
            self.assertEqual((hit.body, hit.status_code, hit.media_type), (first.body, 200, 'text/html'))
            self.assertEqual(fetch.call_count, 1)
            clock.return_value = 160
            app._catalog_cached_get('a')
            self.assertEqual(fetch.call_count, 2)

    def test_expired_other_keys_are_reclaimed_on_read(self):
        with mock.patch.object(app.time, 'monotonic', return_value=0) as clock, mock.patch.object(
                app, '_catalog_fetch_with_retry', return_value=(200, b'page')):
            app._catalog_cached_get('old')
            clock.return_value = 20
            app._catalog_cached_get('live')
            clock.return_value = 60
            app._catalog_cached_get('live')
            self.assertEqual(list(app._catalog_cache), ['live'])

    def test_byte_limit_evicts_lru_and_replacement_is_counted_once(self):
        with mock.patch.object(app, 'CATALOG_CACHE_MAX_BYTES', 6), mock.patch.object(
                app, '_catalog_fetch_with_retry', return_value=(200, b'abc')):
            for key in ['a', 'b', 'a', 'c']:
                app._catalog_cached_get(key)
            self.assertEqual(list(app._catalog_cache), ['a', 'c'])
            self.assertEqual(sum(len(v[2]) for v in app._catalog_cache.values()), 6)

    def test_entry_limit_and_oversized_cache_bypass(self):
        with mock.patch.object(app, 'CATALOG_CACHE_MAX_ENTRIES', 2), mock.patch.object(
                app, '_catalog_fetch_with_retry', return_value=(200, b'a')):
            for key in ['a', 'b', 'c']:
                app._catalog_cached_get(key)
            self.assertEqual(list(app._catalog_cache), ['b', 'c'])
        with mock.patch.object(app, 'CATALOG_CACHE_MAX_BYTES', 1), mock.patch.object(
                app, '_catalog_fetch_with_retry', return_value=(200, b'large')):
            self.assertEqual(app._catalog_cached_get('large').body, b'large')
            self.assertNotIn('large', app._catalog_cache)

    def test_concurrent_fetches_and_hits_stay_bounded(self):
        barrier = threading.Barrier(8)

        def fetch(url):
            barrier.wait(timeout=5)
            return 200, b'x' * 1024

        with mock.patch.object(app, 'CATALOG_CACHE_MAX_BYTES', 3 * 1024), mock.patch.object(
                app, '_catalog_fetch_with_retry', side_effect=fetch):
            with ThreadPoolExecutor(max_workers=8) as pool:
                replies = list(pool.map(app._catalog_cached_get, [str(i) for i in range(8)]))
        self.assertEqual(len(replies), 8)
        self.assertLessEqual(sum(len(v[2]) for v in app._catalog_cache.values()), 3 * 1024)

    def test_slow_fetch_cannot_retain_entries_expired_while_fetching(self):
        with mock.patch.object(app.time, 'monotonic', return_value=0) as clock:
            app._catalog_cache['old'] = (0, 200, b'old')

            def fetch(url):
                clock.return_value = 61
                return 200, b'new'

            with mock.patch.object(app, '_catalog_fetch_with_retry', side_effect=fetch):
                self.assertEqual(app._catalog_cached_get('new').body, b'new')
            self.assertFalse(app._catalog_cache)
