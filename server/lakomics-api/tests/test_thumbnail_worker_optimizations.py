"""Worker event delivery and ticket metadata invalidation, using local fixtures."""
import threading
from unittest import mock

import head_cache
import image_thumbnails
from tests.test_image_thumbnails import Fixture, ASSET_IMAGE, png_bytes, requires_pillow, requires_posix


class WorkerOptimizationTests(Fixture):
    @requires_pillow
    @requires_posix
    def test_wake_interrupts_idle_wait_without_changing_poll_interval(self):
        worker = self.worker(poll_seconds=60)
        waiting, finished = threading.Event(), threading.Event()
        original_wait = worker._wake.wait
        original_process = worker._process

        def wait(timeout):
            self.assertEqual(timeout, 60)
            waiting.set()
            return original_wait(timeout)

        def process(asset_id):
            original_process(asset_id)
            finished.set()

        with mock.patch.object(worker._wake, "wait", side_effect=wait), mock.patch.object(
                worker, "_process", side_effect=process):
            worker.start()
            try:
                self.assertTrue(waiting.wait(2))
                self.seed(ASSET_IMAGE, png_bytes())
                worker.wake()
                self.assertTrue(finished.wait(5), "wake waited for the 60-second fallback poll")
            finally:
                self.assertTrue(worker.stop(timeout=5))
        self.assertIsNotNone(self.thumbnail_key(ASSET_IMAGE))

    @requires_pillow
    @requires_posix
    def test_publishing_derived_bytes_invalidates_previous_ticket_metadata(self):
        digest = self.seed(ASSET_IMAGE, png_bytes())
        worker = self.worker()
        key = image_thumbnails.derived_key(digest)
        endpoint = "https://" + "a" * 32 + ".r2.cloudflarestorage.com"
        self.s3.meta = mock.Mock(endpoint_url=endpoint)
        storage = mock.Mock()
        storage.meta.endpoint_url = endpoint
        self.assertIsNot(storage, worker.s3)
        storage.head_object.return_value = {"ContentType": "image/webp", "ContentLength": 1}
        cache = head_cache.HeadMetadataCache()
        with mock.patch.object(head_cache, "ticket_heads", cache):
            cache.head(storage, worker.bucket, key, identity=(digest,))
            cache.head(storage, worker.bucket, key, identity=(digest,))
            storage.head_object.assert_called_once()
            self.assertTrue(worker.run_once())
            size = len(self.s3.objects[key]["body"])
            storage.head_object.return_value = {"ContentType": "image/webp", "ContentLength": size}
            metadata = cache.head(storage, worker.bucket, key, identity=(digest,))
        self.assertEqual(metadata["ContentLength"], size)
        self.assertEqual(storage.head_object.call_count, 2)
