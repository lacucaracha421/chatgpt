"""Canonical R2 stub shared by tests that must import app.py without R2 env.

test_capture_api.py used to define this inline; the catalog transport tests
import app.py too, so the stub lives here to keep one mutable fake across
test modules regardless of import order.
"""

from __future__ import annotations

import sys
import types

from botocore.exceptions import ClientError


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, dict[str, object]] = {}
        self.deleted: list[str] = []
        self.fail_put = False

    def put_object(self, *, Bucket, Key, Body, ContentType):
        if self.fail_put:
            raise RuntimeError("R2 unavailable")
        self.objects[Key] = {
            "bucket": Bucket,
            "body": Body.read(),
            "content_type": ContentType,
        }

    def delete_object(self, *, Bucket, Key):
        self.deleted.append(Key)
        self.objects.pop(Key, None)

    def head_object(self, *, Bucket, Key):
        if Key not in self.objects:
            raise ClientError(
                {"Error": {"Code": "NoSuchKey", "Message": "missing"}},
                "HeadObject",
            )
        stored = self.objects[Key]
        return {
            "ContentLength": len(stored["body"]),
            "ContentType": stored["content_type"],
        }


fake_s3 = FakeS3()
fake_r2 = types.ModuleType("r2")
fake_r2._s3 = fake_s3  # type: ignore[attr-defined]
fake_r2.R2_BUCKET = "test-bucket"  # type: ignore[attr-defined]
fake_r2.presign_get = (  # type: ignore[attr-defined]
    lambda object_key, expires_in=600: (
        f"https://r2.example.test/{object_key}?expires={expires_in}"
    )
)
fake_r2.presign_put = (  # type: ignore[attr-defined]
    lambda object_key, content_type, expires_in=600: (
        f"https://r2.example.test/{object_key}?content_type={content_type}&expires={expires_in}"
    )
)
sys.modules.setdefault("r2", fake_r2)
