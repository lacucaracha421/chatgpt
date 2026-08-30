from __future__ import annotations

import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import httpx

from r2 import _s3, R2_BUCKET


MAX_CAPTURE_IMAGE_BYTES = 50 * 1024 * 1024
MAX_CAPTURE_VIDEO_BYTES = int(
    os.environ.get("MAX_CAPTURE_VIDEO_BYTES", 512 * 1024 * 1024)
)
HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)


class CaptureValidationError(Exception):
    pass


class CaptureDownloadError(Exception):
    pass


def fetch_media_to_r2(
    media_url: str,
    object_key: str,
    media_type: str,
) -> tuple[str, int]:
    if media_type == "image":
        allowed_hosts = {"pbs.twimg.com"}
        maximum_bytes = MAX_CAPTURE_IMAGE_BYTES
    elif media_type == "video":
        allowed_hosts = {"video.twimg.com"}
        maximum_bytes = MAX_CAPTURE_VIDEO_BYTES
    else:
        raise CaptureValidationError("Unsupported media type")

    parsed = urlparse(media_url)

    if parsed.scheme != "https" or parsed.hostname not in allowed_hosts:
        raise CaptureValidationError(f"Unsupported {media_type} media URL")

    temp_path: Path | None = None

    try:
        with httpx.stream(
            "GET",
            media_url,
            headers={
                "User-Agent": "Lakomics-Collector/1.0",
                "Accept": "video/mp4" if media_type == "video" else "image/*",
            },
            follow_redirects=False,
            timeout=HTTP_TIMEOUT,
        ) as response:
            if response.status_code != 200:
                raise CaptureDownloadError(
                    f"X media returned HTTP {response.status_code}"
                )

            content_type = (
                response.headers.get("content-type", "application/octet-stream")
                .split(";", 1)[0]
                .strip()
                .lower()
            )

            valid_content_type = (
                content_type.startswith("image/")
                if media_type == "image"
                else content_type == "video/mp4"
            )
            if not valid_content_type:
                raise CaptureValidationError(
                    f"Unsupported content type: {content_type}"
                )

            declared_length = response.headers.get("content-length")
            if declared_length:
                try:
                    if int(declared_length) > maximum_bytes:
                        raise CaptureValidationError(
                            f"{media_type.capitalize()} is too large"
                        )
                except ValueError:
                    pass

            fd, raw_path = tempfile.mkstemp(prefix="lakomics-capture-")
            os.close(fd)
            temp_path = Path(raw_path)

            size_bytes = 0
            with temp_path.open("wb") as output:
                for chunk in response.iter_bytes(256 * 1024):
                    size_bytes += len(chunk)
                    if size_bytes > maximum_bytes:
                        raise CaptureValidationError(
                            f"{media_type.capitalize()} is too large"
                        )
                    output.write(chunk)

        if size_bytes == 0:
            raise CaptureValidationError(f"Empty {media_type} response")

        try:
            with temp_path.open("rb") as body:
                _s3.put_object(
                    Bucket=R2_BUCKET,
                    Key=object_key,
                    Body=body,
                    ContentType=content_type,
                )
        except Exception as exc:
            try:
                delete_r2_object(object_key)
            except Exception:
                pass
            raise CaptureDownloadError(str(exc)) from exc

        return content_type, size_bytes

    except httpx.HTTPError as exc:
        raise CaptureDownloadError(str(exc)) from exc

    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def fetch_image_to_r2(media_url: str, object_key: str) -> tuple[str, int]:
    return fetch_media_to_r2(media_url, object_key, "image")


def delete_r2_object(object_key: str) -> None:
    _s3.delete_object(Bucket=R2_BUCKET, Key=object_key)
