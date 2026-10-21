"""Disk cache and warm-up checks with local fixtures; no network."""
import io
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

from tests.test_capture_api_stub import fake_s3
from picker import MIMES
from picker_thumbnail_cache import BackgroundFill, MAX_BYTES, ThumbnailCache, warm


class ThumbnailCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = ThumbnailCache(self.root / 'picker-thumbnails', MIMES)
        self.key = 'derived/image-thumbnails/test.webp'

    def storage(self, data=b'webp', mime='image/webp', declared=4):
        return Mock(get_object=Mock(return_value={
            'Body': io.BytesIO(data), 'ContentType': mime, 'ContentLength': declared}))

    def test_fill_round_trip_and_existing_file_is_skipped(self):
        client = self.storage()
        self.assertEqual(self.cache.fill(client, 'bucket', self.key, 4), 'done')
        self.assertEqual(self.cache.read(self.key, 4), (b'webp', 'image/webp'))
        self.assertEqual(self.cache.fill(client, 'bucket', self.key, 4), 'skipped')
        client.get_object.assert_called_once_with(Bucket='bucket', Key=self.key)

    def test_non_immutable_keys_are_never_cached_or_queued(self):
        client = self.storage()
        worker = BackgroundFill()
        for key in ('thumb/a', '../derived/a', ''):
            self.assertIsNone(self.cache.read(key))
            self.assertEqual(self.cache.fill(client, 'bucket', key), 'skipped')
            worker.enqueue(self.cache, client, 'bucket', key)
        client.get_object.assert_not_called()
        self.assertTrue(worker.queue.empty())
        self.assertFalse(self.cache.root.exists())

    def test_failed_stream_leaves_no_partial_file(self):
        body = Mock()
        body.read.side_effect = [b'we', OSError('download interrupted')]
        client = self.storage()
        client.get_object.return_value['Body'] = body
        with self.assertLogs('picker_thumbnail_cache', level='WARNING'):
            self.assertEqual(self.cache.fill(client, 'bucket', self.key, 4), 'failed')
        body.close.assert_called_once()
        self.assertIsNone(self.cache.read(self.key))
        self.assertEqual([p for p in self.cache.root.rglob('*') if p.is_file()], [])

    def test_invalid_type_oversize_and_truncated_bytes_are_not_published(self):
        for client, expected in [(self.storage(mime='text/html'), 4),
                                 (self.storage(declared=MAX_BYTES + 1), None),
                                 (self.storage(data=b'we'), 4),
                                 (self.storage(), 5)]:
            self.assertEqual(self.cache.fill(client, 'bucket', self.key, expected), 'failed')
            self.assertIsNone(self.cache.read(self.key))
        self.assertEqual([p for p in self.cache.root.rglob('*') if p.is_file()], [])

    def test_warm_skips_existing_and_uses_picker_eligibility(self):
        db_path = self.root / 'picker.sqlite'
        with sqlite3.connect(db_path) as db:
            db.execute('CREATE TABLE assets(id TEXT, committed INTEGER, kind TEXT, content_type TEXT, '
                       'object_key TEXT, thumbnail_key TEXT, thumbnail_metadata_key TEXT, '
                       'thumbnail_size_bytes INTEGER)')
            rows = [('hit', 1, 'image', 'image/png', 'original/hit', self.key, self.key, 4),
                    ('miss', 1, 'gif', 'image/gif', 'original/miss', 'derived/miss', 'derived/miss', 4),
                    ('pending', 0, 'image', 'image/png', 'original/pending', 'derived/pending', None, None),
                    ('video', 1, 'video', 'video/mp4', 'original/video', 'derived/video', None, None),
                    ('mutable', 1, 'image', 'image/png', 'original/mutable', 'thumb/a', None, None)]
            db.executemany('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?)', rows)
        self.assertEqual(self.cache.fill(self.storage(), 'bucket', self.key, 4), 'done')
        def get_object(**kwargs):
            self.assertEqual(kwargs['Key'], 'derived/miss')
            return {'Body': io.BytesIO(b'webp'), 'ContentType': 'image/webp', 'ContentLength': 4}
        with patch.object(fake_s3, 'get_object', side_effect=get_object, create=True) as get, \
                patch('builtins.print') as output:
            self.assertEqual(warm(db_path, fake_s3, 'bucket'), dict(done=1, skipped=1, failed=0))
        get.assert_called_once()
        output.assert_called_once_with('done=1 skipped=1 failed=0')
        self.assertEqual(self.cache.read('derived/miss'), (b'webp', 'image/webp'))

    def test_background_queue_is_bounded_and_deduplicated(self):
        worker = BackgroundFill()
        # Keep the queue undrained to exercise admission without network or timing.
        worker.started = True
        client = self.storage()
        for index in range(300):
            worker.enqueue(self.cache, client, 'bucket', 'derived/' + str(index), 4)
        worker.enqueue(self.cache, client, 'bucket', 'derived/0', 4)
        self.assertEqual(worker.queue.qsize(), 256)
        self.assertEqual(len(worker.pending), 256)


if __name__ == '__main__':
    unittest.main()
