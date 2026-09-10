import ipaddress
import os
import socket
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import httpx

from r2 import _s3, R2_BUCKET

MAX_CAPTURE_IMAGE_BYTES = 50 * 1024 * 1024
MAX_CAPTURE_VIDEO_BYTES = int(os.environ.get("MAX_CAPTURE_VIDEO_BYTES", 512 * 1024 * 1024))
HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)


class CaptureValidationError(Exception):
    pass


class CaptureDownloadError(Exception):
    pass


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


def fetch_media_to_r2(media_url: str, object_key: str, media_type: str, source: str = "x") -> tuple[str, int]:
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
        with httpx.stream(
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
            declared_length = response.headers.get("content-length")
            if declared_length:
                try:
                    if int(declared_length) > maximum_bytes:
                        raise CaptureValidationError(f"{media_type} is too large")
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
                        raise CaptureValidationError(f"{media_type} is too large")
                    output.write(chunk)
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
        return content_type, size_bytes
    except httpx.HTTPError as exc:
        raise CaptureDownloadError(str(exc)) from exc
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def fetch_image_to_r2(media_url: str, object_key: str) -> tuple[str, int]:
    return fetch_media_to_r2(media_url, object_key, "image", "x")


def delete_r2_object(object_key: str) -> None:
    _s3.delete_object(Bucket=R2_BUCKET, Key=object_key)
