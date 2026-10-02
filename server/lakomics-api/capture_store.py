import asyncio
import hashlib
import ipaddress
import os
import socket
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

import httpx

from r2 import _s3, R2_BUCKET

MAX_CAPTURE_IMAGE_BYTES = 50 * 1024 * 1024
MAX_CAPTURE_VIDEO_BYTES = int(os.environ.get("MAX_CAPTURE_VIDEO_BYTES", 512 * 1024 * 1024))
# At least 256 KiB/s after a 30 s setup allowance, at most five minutes.
CAPTURE_DOWNLOAD_GRACE_SECONDS = 30.0
CAPTURE_DOWNLOAD_BYTES_PER_SECOND = 256 * 1024
CAPTURE_DOWNLOAD_MAX_SECONDS = 300.0
MAX_CAPTURE_DOWNLOADS = 2
_DOWNLOAD_SLOTS = threading.BoundedSemaphore(MAX_CAPTURE_DOWNLOADS)
HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)


class CaptureValidationError(Exception):
    pass


class CaptureDownloadError(Exception):
    pass


class CaptureBusyError(CaptureDownloadError):
    pass


def download_budget(size_bytes: int) -> float:
    return min(CAPTURE_DOWNLOAD_MAX_SECONDS,
               CAPTURE_DOWNLOAD_GRACE_SECONDS + max(0, size_bytes) / CAPTURE_DOWNLOAD_BYTES_PER_SECOND)


@asynccontextmanager
async def _media_stream(*args, **kwargs):
    async with httpx.AsyncClient() as client:
        async with client.stream(*args, **kwargs) as response:
            yield response


def _known_source_host(source: str, host: str, media_type: str) -> bool:
    host = host.lower()
    if source == "x":
        return host == ("video.twimg.com" if media_type == "video" else "pbs.twimg.com")
    if source == "arca":
        return host in {"arca.live", "ac-o.arca.live", "ac.namu.la"} or (
            host.endswith(".namu.la") and host.removesuffix(".namu.la").startswith("ac-")
            and "." not in host.removesuffix(".namu.la")
        )
    if source == "dcinside":
        return host in {"image.dcinside.com", "vod.dcinside.com"} or any(
            host.endswith(suffix)
            and host.removesuffix(suffix).startswith("dcimg")
            and host.removesuffix(suffix)[5:].isdigit()
            for suffix in (".dcinside.com", ".dcinside.co.kr")
        )
    return source == "web"


def _public_addresses(host: str) -> set[str]:
    try:
        rows = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise CaptureValidationError("Media host could not be resolved") from exc
    addresses: set[str] = set()
    for row in rows:
        try:
            address = ipaddress.ip_address(row[4][0])
        except ValueError as exc:
            raise CaptureValidationError("Invalid media host address") from exc
        if not address.is_global:
            raise CaptureValidationError("Private or special-use media host is not allowed")
        addresses.add(str(address))
    if not addresses:
        raise CaptureValidationError("Media host could not be resolved")
    return addresses


def _validate_media_url(media_url: str, media_type: str, source: str) -> tuple[str, set[str] | None]:
    parsed = urlparse(media_url)
    host = (parsed.hostname or "").lower()
    try:
        port = parsed.port
    except ValueError as exc:
        raise CaptureValidationError(f"Unsupported {media_type} media URL") from exc
    if parsed.scheme != "https" or not host or parsed.username or parsed.password or parsed.fragment or port not in (None, 443):
        raise CaptureValidationError(f"Unsupported {media_type} media URL")
    if not _known_source_host(source, host, media_type):
        raise CaptureValidationError(f"Unsupported {source} media host")
    return host, _public_addresses(host) if source == "web" else None


class StoredMedia(tuple):
    """Compatible two-field result plus the digest verified while streaming."""
    def __new__(cls, content_type, size_bytes, sha256):
        result = super().__new__(cls, (content_type, size_bytes))
        result.sha256 = sha256
        return result


def fetch_media_to_r2(media_url: str, object_key: str, media_type: str, source: str = "x") -> tuple[str, int]:
    if not _DOWNLOAD_SLOTS.acquire(blocking=False):
        raise CaptureBusyError("Capture downloads busy; retry shortly")
    try:
        return _fetch_media_to_r2(media_url, object_key, media_type, source)
    finally:
        _DOWNLOAD_SLOTS.release()


def _fetch_media_to_r2(media_url: str, object_key: str, media_type: str, source: str) -> tuple[str, int]:
    if media_type in {"image", "animated_gif"}:
        maximum_bytes = MAX_CAPTURE_IMAGE_BYTES
        accept = "image/gif" if media_type == "animated_gif" else "image/*"
    elif media_type == "video":
        maximum_bytes = MAX_CAPTURE_VIDEO_BYTES
        accept = "video/mp4" if source == "x" else "video/*"
    else:
        raise CaptureValidationError("Unsupported media type")

    host, initial_addresses = _validate_media_url(media_url, media_type, source)
    temp_path: Path | None = None
    try:
        async def download():
            nonlocal temp_path
            started = asyncio.get_running_loop().time()
            async with asyncio.timeout_at(started + download_budget(0)) as deadline:
                async with _media_stream(
                    "GET", media_url,
                    headers={"User-Agent": "Lakomics-Collector/2.0", "Accept": accept},
                    follow_redirects=False,
                    timeout=HTTP_TIMEOUT,
                ) as response:
                    if response.status_code != 200:
                        raise CaptureDownloadError(f"Media returned HTTP {response.status_code}")
                    if initial_addresses is not None:
                        stream = getattr(response, "extensions", {}).get("network_stream")
                        peer = stream.get_extra_info("server_addr") if stream is not None and hasattr(stream, "get_extra_info") else None
                        try:
                            peer_ip = str(ipaddress.ip_address(peer[0])) if peer else ""
                        except (ValueError, TypeError):
                            peer_ip = ""
                        if not peer_ip or peer_ip not in initial_addresses:
                            raise CaptureValidationError("Media connection address was not validated")
                    content_type = response.headers.get("content-type", "application/octet-stream").split(";", 1)[0].strip().lower()
                    if media_type == "animated_gif":
                        valid_content_type = content_type == "image/gif"
                    elif media_type == "image":
                        valid_content_type = content_type.startswith("image/")
                    else:
                        valid_content_type = content_type in {"video/mp4", "video/webm"}
                    if not valid_content_type:
                        raise CaptureValidationError(f"Unsupported content type: {content_type}")
                    expected_bytes = 0
                    declared_length = response.headers.get("content-length")
                    if declared_length:
                        try:
                            expected_bytes = max(0, int(declared_length))
                            if expected_bytes > maximum_bytes:
                                raise CaptureValidationError(f"{media_type} is too large")
                        except ValueError:
                            pass
                    deadline.reschedule(started + download_budget(expected_bytes))
                    fd, raw_path = tempfile.mkstemp(prefix="lakomics-capture-")
                    os.close(fd)
                    temp_path = Path(raw_path)
                    size_bytes = 0
                    hasher = hashlib.sha256()
                    with temp_path.open("wb") as output:
                        async for chunk in response.aiter_bytes():
                            size_bytes += len(chunk)
                            if size_bytes > maximum_bytes:
                                raise CaptureValidationError(f"{media_type} is too large")
                            # Unknown lengths earn time only as bytes arrive. Never reset
                            # the start time, and do not aggregate slow chunks before checking.
                            deadline.reschedule(started + download_budget(max(expected_bytes, size_bytes)))
                            if asyncio.get_running_loop().time() >= deadline.when():
                                raise TimeoutError("Capture download deadline exceeded")
                            hasher.update(chunk)
                            output.write(chunk)
                return content_type, size_bytes, hasher.hexdigest()

        content_type, size_bytes, digest = asyncio.run(download())
        if size_bytes == 0:
            raise CaptureValidationError(f"Empty {media_type} response")
        try:
            with temp_path.open("rb") as body:
                _s3.put_object(Bucket=R2_BUCKET, Key=object_key, Body=body, ContentType=content_type)
        except Exception as exc:
            try:
                delete_r2_object(object_key)
            except Exception:
                pass
            raise CaptureDownloadError(str(exc)) from exc
        return StoredMedia(content_type, size_bytes, digest)
    except TimeoutError as exc:
        raise CaptureDownloadError("Capture download deadline exceeded") from exc
    except httpx.HTTPError as exc:
        raise CaptureDownloadError(str(exc)) from exc
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def fetch_image_to_r2(media_url: str, object_key: str) -> tuple[str, int]:
    return fetch_media_to_r2(media_url, object_key, "image", "x")


def delete_r2_object(object_key: str) -> None:
    _s3.delete_object(Bucket=R2_BUCKET, Key=object_key)
