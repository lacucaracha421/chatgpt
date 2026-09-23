"""No R2 credentials, network, API dependencies or production data required."""
import importlib.util
import os
from pathlib import Path
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import head_cache


KEY = "derived/image-thumbnails/v1/" + "a" * 64 + ".webp"
ARTWORK = "work-artwork/mobile/" + "b" * 64
METADATA = {"ContentType": "image/webp", "ContentLength": 12}
ENDPOINT = "https://" + "a" * 32 + ".r2.cloudflarestorage.com"


class HeadCacheTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.cache = head_cache.HeadMetadataCache(ttl_seconds=30, max_entries=2,
                                                  clock=lambda: self.now)
        self.storage = mock.Mock()
        self.storage.meta.endpoint_url = ENDPOINT
        self.storage.head_object.return_value = dict(METADATA)

    def head(self, key=KEY, bucket="bucket", identity=("metadata",)):
        return self.cache.head(self.storage, bucket, key, identity=identity)

    def test_success_hit_reduces_calls_and_returns_only_copied_metadata(self):
        self.storage.head_object.return_value["private"] = "not retained"
        first = self.head()
        first["ContentLength"] = -1
        self.assertEqual(self.head(), METADATA)
        self.storage.head_object.assert_called_once_with(Bucket="bucket", Key=KEY)

    def test_expiry_is_absolute_and_hits_do_not_extend_it(self):
        self.head()
        self.now = 29
        self.head()
        self.assertEqual(self.storage.head_object.call_count, 1)
        self.now = 30
        self.head()
        self.assertEqual(self.storage.head_object.call_count, 2)

    def test_slow_head_does_not_extend_ttl(self):
        def slow(**kwargs):
            self.now += 31
            return METADATA
        self.storage.head_object.side_effect = slow
        self.head()
        self.head()
        self.assertEqual(self.storage.head_object.call_count, 2)

    def test_capacity_evicts_least_recently_used_and_bucket_key_are_distinct(self):
        self.head()
        self.head(ARTWORK)
        self.head()  # Keep KEY; evict ARTWORK on the next bucket.
        self.head(bucket="other")
        self.assertEqual(len(self.cache._entries), 2)
        self.head()
        self.assertEqual(self.storage.head_object.call_count, 3)
        self.head(ARTWORK)
        self.assertEqual(self.storage.head_object.call_count, 4)
        self.assertEqual(len(self.cache._entries), 2)

    def test_identical_bucket_key_and_identity_do_not_cross_backends(self):
        other = mock.Mock()
        other.meta.endpoint_url = ENDPOINT.replace("a" * 32, "b" * 32)
        other.head_object.return_value = {**METADATA, "ContentLength": 99}
        self.assertEqual(self.head(), METADATA)
        self.assertEqual(self.cache.head(other, "bucket", KEY, identity=("metadata",)),
                         {**METADATA, "ContentLength": 99})
        self.assertEqual(self.head(), METADATA)
        self.storage.head_object.assert_called_once()
        other.head_object.assert_called_once()

    def test_fresh_verification_from_same_backend_distinct_client_invalidates(self):
        other = mock.Mock()
        other.meta.endpoint_url = ENDPOINT
        other.head_object.return_value = dict(METADATA)
        self.head()
        self.assertEqual(self.cache.head(other, "bucket", KEY, identity=("metadata",)), METADATA)
        other.head_object.assert_not_called()
        self.cache.head(other, "bucket", KEY)
        self.head()
        other.head_object.assert_called_once()
        self.assertEqual(self.storage.head_object.call_count, 2)

    def test_invalidation_is_scoped_to_backend_not_just_bucket_and_key(self):
        other = mock.Mock()
        other.meta.endpoint_url = ENDPOINT.replace("a" * 32, "b" * 32)
        self.head()
        self.cache.invalidate(other, "bucket", KEY)
        self.head()
        self.storage.head_object.assert_called_once()
        same_backend = mock.Mock()
        same_backend.meta.endpoint_url = ENDPOINT + "/"
        self.cache.invalidate(same_backend, "bucket", KEY)
        self.head()
        self.assertEqual(self.storage.head_object.call_count, 2)

    def test_unknown_backend_does_not_cache_or_cross_client_boundaries(self):
        for endpoint in (None, "", mock.Mock()):
            with self.subTest(endpoint_type=type(endpoint).__name__):
                self.storage.meta.endpoint_url = endpoint
                self.storage.reset_mock()
                self.head()
                self.head()
                self.assertEqual(self.storage.head_object.call_count, 2)
                self.assertFalse(self.cache._entries)

    def test_cache_keeps_no_raw_endpoint_or_client(self):
        self.head()
        namespace, bucket, key = next(iter(self.cache._entries))
        self.assertIsInstance(namespace, bytes)
        self.assertEqual(len(namespace), 32)
        self.assertEqual((bucket, key), ("bucket", KEY))
        self.assertNotIn(ENDPOINT, repr(self.cache._entries))

    def test_changed_metadata_identity_requires_head(self):
        self.head(identity=(12, "image/webp", 1))
        self.head(identity=(12, "image/webp", 2))
        self.assertEqual(self.storage.head_object.call_count, 2)

    def test_only_exact_content_addressed_namespaces_are_cached(self):
        keys = ["library/id/thumbnail", "images/inbox/id/original", "thumbnails/hash",
                "backups/library-metadata.sqlite", "work-artwork/legacy/a",
                KEY + "/extra", KEY.replace("a" * 64, "a" * 63),
                KEY.replace("a" * 64, "A" * 64), KEY.replace("v1", "v9")]
        for key in keys:
            with self.subTest(key=key):
                self.storage.reset_mock()
                self.head(key)
                self.head(key)
                self.assertEqual(self.storage.head_object.call_count, 2)
        for prefix in ("derived/media-thumbnails/v1/gif/", "derived/media-thumbnails/v2/video/"):
            key = prefix + "c" * 64 + ".webp"
            self.storage.reset_mock()
            self.head(key)
            self.head(key)
            self.assertEqual(self.storage.head_object.call_count, 1)

    def test_errors_and_incomplete_results_are_not_sticky(self):
        for failure in (FileNotFoundError("missing"), RuntimeError("storage unavailable")):
            self.storage.head_object.side_effect = [failure, METADATA]
            with self.assertRaises(type(failure)):
                self.head()
            self.assertEqual(self.head(), METADATA)
            self.cache.invalidate(self.storage, "bucket", KEY)
        self.storage.head_object.side_effect = [{}, METADATA]
        self.assertEqual(self.head(), {"ContentType": None, "ContentLength": None})
        self.assertEqual(self.head(), METADATA)

    def test_fresh_verification_bypasses_and_invalidates_ticket_success(self):
        self.head()
        self.storage.head_object.side_effect = FileNotFoundError()
        with self.assertRaises(FileNotFoundError):
            self.head(identity=None)
        with self.assertRaises(FileNotFoundError):
            self.head()
        self.assertEqual(self.storage.head_object.call_count, 3)

    def test_invalidation_during_inflight_head_prevents_repopulation(self):
        entered, release = Event(), Event()
        def slow(**kwargs):
            entered.set()
            self.assertTrue(release.wait(2))
            return METADATA
        self.storage.head_object.side_effect = slow
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.head)
            try:
                self.assertTrue(entered.wait(2))
                self.cache.invalidate(self.storage, "bucket", KEY)
            finally:
                release.set()
            self.assertEqual(pending.result(timeout=2), METADATA)
        self.storage.head_object.side_effect = None
        self.head()
        self.assertEqual(self.storage.head_object.call_count, 2)

    def test_parallel_heads_do_not_hold_cache_lock_across_storage_calls(self):
        barrier = Barrier(8)
        def parallel(**kwargs):
            barrier.wait(timeout=2)
            return METADATA
        self.storage.head_object.side_effect = parallel
        keys = ["work-artwork/mobile/" + f"{i:064x}" for i in range(8)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(self.head, keys)), [METADATA] * 8)
        self.assertEqual(len(self.cache._entries), 2)

    def test_presign_put_invalidates_without_changing_contract(self):
        # Load the real r2.py with fake SDK modules, rather than the API suite's
        # module-wide r2 stub. No boto3 installation or credentials are needed.
        client = mock.Mock()
        client.meta.endpoint_url = ENDPOINT
        boto = mock.Mock()
        boto.client.side_effect = [client, self.storage]
        spec = importlib.util.spec_from_file_location("r2_cache_test", Path(head_cache.__file__).with_name("r2.py"))
        module = importlib.util.module_from_spec(spec)
        env = {"R2_ENDPOINT": ENDPOINT, "R2_ACCESS_KEY_ID": "test",
               "R2_SECRET_ACCESS_KEY": "test", "R2_BUCKET": "bucket"}
        with mock.patch.dict(sys.modules, {"boto3": boto, "botocore.config": mock.Mock()}), mock.patch.dict(os.environ, env), mock.patch.object(head_cache, "ticket_heads", self.cache):
            spec.loader.exec_module(module)
            worker_client = module.thumbnail_storage_client()
            self.assertIs(worker_client, self.storage)
            self.assertIsNot(worker_client, module._s3)
            self.assertEqual([call.kwargs["endpoint_url"] for call in boto.client.call_args_list], [ENDPOINT, ENDPOINT])
            self.head()
            module.presign_put(KEY, "image/webp", 123)
            self.head()
        self.assertEqual(self.storage.head_object.call_count, 2)
        client.generate_presigned_url.assert_called_once_with(
            "put_object", Params={"Bucket": "bucket", "Key": KEY, "ContentType": "image/webp"}, ExpiresIn=123)


if __name__ == "__main__":
    unittest.main()
