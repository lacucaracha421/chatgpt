"""Real R2 configuration and operation routing; no credentials or network."""
import importlib.util
import io
from pathlib import Path
import unittest
from unittest import mock


class R2TimeoutTests(unittest.TestCase):
    def setUp(self):
        self.clients = [mock.Mock(name=name) for name in ("control", "transfer", "thumbnail")]
        env = {"R2_ENDPOINT": "https://test.r2.invalid", "R2_ACCESS_KEY_ID": "test",
               "R2_SECRET_ACCESS_KEY": "test", "R2_BUCKET": "bucket"}
        spec = importlib.util.spec_from_file_location(
            "r2_timeouts_test", Path(__file__).resolve().parents[1] / "r2.py")
        self.r2 = importlib.util.module_from_spec(spec)
        with mock.patch.dict("os.environ", env), mock.patch("boto3.client", side_effect=self.clients) as create:
            spec.loader.exec_module(self.r2)
            self.worker = self.r2.thumbnail_storage_client()
        self.configs = [call.kwargs["config"] for call in create.call_args_list]

    def test_short_head_timeouts_and_explicit_retry_cap(self):
        config = self.configs[0]
        self.assertEqual(config.signature_version, "s3v4")
        self.assertEqual((config.connect_timeout, config.read_timeout), (1, 2))
        self.assertEqual(config.retries, {"mode": "standard", "total_max_attempts": 2})
        self.assertEqual(config.max_pool_connections, 8)
        self.r2._s3.head_object(Bucket="bucket", Key="thumbnail")
        self.clients[0].head_object.assert_called_once_with(Bucket="bucket", Key="thumbnail")
        self.clients[1].head_object.assert_not_called()
        self.assertIs(self.r2._s3.meta, self.clients[0].meta)

    def test_large_transfers_retain_long_read_timeout_and_body_identity(self):
        config = self.configs[1]
        self.assertEqual((config.connect_timeout, config.read_timeout), (3, 60))
        self.assertEqual(config.retries, {"mode": "standard", "total_max_attempts": 3})
        body = io.BytesIO(b"media")
        self.r2._s3.put_object(Bucket="bucket", Key="original", Body=body, ContentType="video/mp4")
        self.r2._s3.get_object(Bucket="bucket", Key="original")
        self.clients[1].put_object.assert_called_once_with(
            Bucket="bucket", Key="original", Body=body, ContentType="video/mp4")
        self.clients[1].get_object.assert_called_once_with(Bucket="bucket", Key="original")
        self.clients[0].put_object.assert_not_called()
        self.clients[0].get_object.assert_not_called()
        self.assertEqual(body.tell(), 0)

    def test_thumbnail_worker_keeps_its_existing_transfer_budget(self):
        self.assertIs(self.worker, self.clients[2])
        config = self.configs[2]
        self.assertEqual((config.connect_timeout, config.read_timeout), (5, 15))
        self.assertEqual(config.retries, {"mode": "standard", "total_max_attempts": 2})
        self.assertEqual(config.max_pool_connections, 1)

    def test_presign_and_delete_contracts_unchanged(self):
        with mock.patch.object(self.r2.head_cache.ticket_heads, "invalidate") as invalidate:
            self.r2.presign_put("thumbnail", "image/webp", 123, content_length=12)
        invalidate.assert_called_once_with(self.r2._s3, "bucket", "thumbnail")
        self.r2.presign_get("thumbnail", 456)
        self.r2._s3.delete_object(Bucket="bucket", Key="thumbnail")
        self.clients[0].generate_presigned_url.assert_has_calls([
            mock.call("put_object", Params={"Bucket": "bucket", "Key": "thumbnail",
                      "ContentType": "image/webp", "ContentLength": 12}, ExpiresIn=123),
            mock.call("get_object", Params={"Bucket": "bucket", "Key": "thumbnail"}, ExpiresIn=456),
        ])
        self.clients[0].delete_object.assert_called_once_with(Bucket="bucket", Key="thumbnail")
        self.clients[1].generate_presigned_url.assert_not_called()


if __name__ == "__main__":
    unittest.main()
