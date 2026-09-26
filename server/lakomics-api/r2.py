import os

import boto3
from botocore.config import Config

import head_cache

R2_ENDPOINT = os.environ["R2_ENDPOINT"]
R2_ACCESS_KEY_ID = os.environ["R2_ACCESS_KEY_ID"]
R2_SECRET_ACCESS_KEY = os.environ["R2_SECRET_ACCESS_KEY"]
R2_BUCKET = os.environ.get("R2_BUCKET", "lakomics-media")

_s3 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name="auto",
    config=Config(signature_version="s3v4"),
)


def thumbnail_storage_client():
    """Keep background transfers bounded without changing interactive media clients."""
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
        config=Config(
            signature_version="s3v4", connect_timeout=5, read_timeout=15,
            retries={"mode": "standard", "total_max_attempts": 2},
            max_pool_connections=1,
        ),
    )


def presign_put(object_key: str, content_type: str, expires_in: int = 600,
                content_length: int | None = None) -> str:
    """``content_length`` is signed into the URL (``X-Amz-SignedHeaders``), so a PUT
    whose ``Content-Length`` differs from it fails the signature check."""
    head_cache.ticket_heads.invalidate(_s3, R2_BUCKET, object_key)
    params = {
        "Bucket": R2_BUCKET,
        "Key": object_key,
        "ContentType": content_type,
    }
    if content_length is not None:
        params["ContentLength"] = content_length
    return _s3.generate_presigned_url(
        "put_object",
        Params=params,
        ExpiresIn=expires_in,
    )


def presign_get(object_key: str, expires_in: int = 600) -> str:
    return _s3.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": R2_BUCKET,
            "Key": object_key,
        },
        ExpiresIn=expires_in,
    )
