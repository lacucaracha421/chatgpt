"""Gzip complete JSON/text responses without buffering streamed bodies."""
import gzip

from starlette.datastructures import Headers, MutableHeaders


def _accepts_gzip(headers):
    for value in headers.getlist("accept-encoding"):
        for item in value.split(","):
            coding, *parameters = item.strip().lower().split(";")
            if coding.strip() != "gzip":
                continue
            quality = 1.0
            for parameter in parameters:
                name, _, value = parameter.strip().partition("=")
                if name.strip() == "q":
                    try:
                        quality = float(value)
                    except ValueError:
                        quality = 0.0
            if 0 < quality <= 1:
                return True
    return False


class TextGZipMiddleware:
    def __init__(self, app, minimum_size=1024):
        self.app = app
        self.minimum_size = minimum_size

    async def __call__(self, scope, receive, send):
        if (scope["type"] != "http" or scope["method"] == "HEAD"
                or scope["path"].rstrip("/") == "/v1/sync/status"
                or "range" in Headers(scope=scope)):
            await self.app(scope, receive, send)
            return

        accepts_gzip = _accepts_gzip(Headers(scope=scope))
        pending = None

        async def send_response(message):
            nonlocal pending
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                status = message["status"]
                if ("content-encoding" in headers or "content-range" in headers
                        or status == 206):
                    await send(message)
                    return
                # Conditional responses have no Content-Type, but must retain Vary
                # for the same validator across identity and gzip transfers.
                if status == 304:
                    headers.add_vary_header("Accept-Encoding")
                    await send(message)
                    return
                media_type = headers.get("content-type", "").partition(";")[0].strip().lower()
                if (status < 200 or status == 204 or media_type == "text/event-stream"
                        or not (media_type == "application/json" or media_type.startswith("text/"))):
                    await send(message)
                    return
                headers.add_vary_header("Accept-Encoding")
                # Ordinary responses declare their size. Streams without a length
                # must send their headers immediately, before waiting for data.
                if accepts_gzip and "content-length" in headers:
                    pending = message
                else:
                    await send(message)
                return

            if pending is not None:
                # A StreamingResponse marks even its first chunk more_body=True.
                # Forward it immediately and never collect subsequent chunks.
                body = message.get("body", b"")
                if (message["type"] == "http.response.body"
                        and not message.get("more_body", False) and len(body) >= self.minimum_size):
                    body = gzip.compress(body, compresslevel=6, mtime=0)
                    headers = MutableHeaders(scope=pending)
                    headers["Content-Encoding"] = "gzip"
                    headers["Content-Length"] = str(len(body))
                    message = {**message, "body": body}
                await send(pending)
                pending = None
            await send(message)

        await self.app(scope, receive, send_response)
