"""SHA-256 verified image originals, signed disk downloads and bounded warm-up."""
import argparse
import base64
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import queue
import re
import secrets
import sqlite3
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from urllib.parse import urlencode, urlparse

from fastapi import Request
from starlette.background import BackgroundTask
from starlette.responses import Response, StreamingResponse

# Same 50 MiB original image limit as capture_store.MAX_CAPTURE_IMAGE_BYTES.
MAX_BYTES = 50 * 1024 * 1024
WORKERS = 4
logger = logging.getLogger(__name__)


def eligible(asset, variant='original'):
    row = dict(asset)
    return (variant == 'original' and row.get('committed') == 1
            and row.get('kind') in ('image', 'gif')
            and isinstance(row.get('content_type'), str) and row['content_type'].startswith('image/')
            and isinstance(row.get('sha256'), str)
            and re.fullmatch(r'[0-9a-fA-F]{64}', row['sha256']) is not None
            and bool(row.get('object_key')) and type(row.get('size_bytes')) is int
            and 0 <= row['size_bytes'] <= MAX_BYTES)


class OriginalCache:
    def __init__(self, root):
        self.root = Path(root)

    def path(self, digest):
        if not isinstance(digest, str) or re.fullmatch(r'[0-9a-fA-F]{64}', digest) is None:
            return None
        digest = digest.lower()
        return self.root / digest[:2] / digest[2:]

    def hit(self, asset):
        if not eligible(asset):
            return None
        path = self.path(asset['sha256'])
        try:
            if path.is_file() and path.stat().st_size == asset['size_bytes']:
                return path
        except OSError:
            pass
        return None

    def fill(self, client, bucket, asset):
        """Publish only complete, digest-verified bytes, using the thumbnail cache pattern."""
        if not eligible(asset):
            return 'skipped'
        if self.hit(asset) is not None:
            return 'skipped'
        path = self.path(asset['sha256'])
        temporary = None
        try:
            response = client.get_object(Bucket=bucket, Key=asset['object_key'])
            with closing(response['Body']) as body:
                declared = response.get('ContentLength')
                if declared is not None and (type(declared) is not int or declared != asset['size_bytes']):
                    return 'failed'
                path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + '.',
                                                 suffix='.tmp', delete=False) as output:
                    temporary = Path(output.name)
                    digest, size = hashlib.sha256(), 0
                    while True:
                        chunk = body.read(min(64 * 1024, asset['size_bytes'] + 1 - size))
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > asset['size_bytes']:
                            return 'failed'
                        digest.update(chunk)
                        output.write(chunk)
                    if size != asset['size_bytes'] or digest.hexdigest() != asset['sha256'].lower():
                        return 'failed'
                os.replace(temporary, path)
                temporary = None
            return 'done'
        except Exception as error:
            logger.warning('Original cache fill failed (%s)', type(error).__name__)
            return 'failed'
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass


class BackgroundFill:
    def __init__(self):
        self.queue = queue.Queue(maxsize=256)
        self.pending = set()
        self.lock = threading.Lock()
        self.started = False

    def enqueue(self, cache, client, bucket, asset):
        if not eligible(asset):
            return
        identity = (cache.root, asset['sha256'].lower())
        with self.lock:
            if identity in self.pending:
                return
            if not self.started:
                for _ in range(WORKERS):
                    threading.Thread(target=self._work, name='original-fill', daemon=True).start()
                self.started = True
            try:
                self.queue.put_nowait((identity, cache, client, bucket, dict(asset)))
            except queue.Full:
                return
            self.pending.add(identity)

    def _work(self):
        while True:
            identity, cache, client, bucket, asset = self.queue.get()
            try:
                cache.fill(client, bucket, asset)
            finally:
                with self.lock:
                    self.pending.discard(identity)
                self.queue.task_done()


background = BackgroundFill()


def cache_for(api):
    return OriginalCache(api.DB_PATH.parent / 'original-cache')


def metadata(api, asset, variant):
    if eligible(asset, variant) and cache_for(api).hit(asset) is not None:
        return {'ContentLength': asset['size_bytes'], 'ContentType': asset['content_type']}
    return None


def _secret(api):
    # Reuse the existing server secret when configured. Provisioned-client-only
    # servers get a separate key; hard-link publication never exposes a partial key.
    if api.API_TOKEN:
        return api.API_TOKEN.encode('utf-8')
    path = api.DB_PATH.parent / 'original-cache-secret'
    try:
        return path.read_bytes()
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
        try:
            with temporary.open('wb') as output:
                os.chmod(temporary, 0o600)
                output.write(secrets.token_bytes(32))
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        finally:
            temporary.unlink(missing_ok=True)
        return path.read_bytes()


def _signature(api, digest, payload):
    return hmac.new(_secret(api), ('original-cache:' + digest + ':' + payload).encode('ascii'),
                    hashlib.sha256).hexdigest()


def public_origin(base_url):
    """The https origin clients reach. The API sits behind a plain TCP relay, so it sees
    requests as http; the configured public URL (as for extension pairing) wins. Never hand
    out a non-https link: clients refuse it, so the R2 ticket is used instead."""
    raw = os.environ.get('LAKOMICS_EXTENSION_BASE_URL', '').strip() or (str(base_url) if base_url is not None else '')
    parsed = urlparse(raw)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password:
        return None
    return 'https://' + parsed.netloc


def ticket_url(api, asset, variant, key, base_url, ttl):
    if eligible(asset, variant):
        cache = cache_for(api)
        origin = public_origin(base_url)
        if origin is not None and cache.hit(asset) is not None:
            digest = asset['sha256'].lower()
            payload = base64.urlsafe_b64encode(json.dumps(
                [int(time.time()) + ttl, asset['content_type']], separators=(',', ':')).encode()).decode()
            token = payload + '.' + _signature(api, digest, payload)
            return origin + '/v1/library/original-cache/' + digest + '?' + urlencode({'token': token})
        background.enqueue(cache, api._s3, api.R2_BUCKET, asset)
    return api.presign_get(key, ttl)


def register(app, api):
    @app.get('/v1/library/original-cache/{digest}')
    def download(digest: str, request: Request):
        token = request.query_params.get('token', '')
        if len(token) > 1024 or re.fullmatch(r'[0-9a-f]{64}', digest) is None:
            return Response(status_code=404)
        try:
            payload, signature = token.split('.')
            if not hmac.compare_digest(_signature(api, digest, payload), signature):
                return Response(status_code=404)
            expiry, mime = json.loads(base64.urlsafe_b64decode(payload))
            if type(expiry) is not int or expiry <= time.time() or not isinstance(mime, str):
                return Response(status_code=404)
        except (ValueError, TypeError, UnicodeError):
            return Response(status_code=404)
        path = cache_for(api).path(digest)
        try:
            cached = path.open('rb')
        except OSError:
            return Response(status_code=404)
        try:
            size = os.fstat(cached.fileno()).st_size
            headers = {'Accept-Ranges': 'bytes', 'Cache-Control': f'private, max-age={max(0, expiry - int(time.time()))}',
                       'Content-Type': mime, 'Content-Length': str(size)}
            start, end, status = 0, size - 1, 200
            requested = request.headers.get('range')
            if requested is not None:
                match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
                try:
                    if match is None or not any(match.groups()) or size == 0:
                        raise ValueError
                    first, last = match.groups()
                    if first:
                        start = int(first)
                        end = min(int(last), size - 1) if last else size - 1
                    else:
                        suffix = int(last)
                        if suffix <= 0:
                            raise ValueError
                        start = max(0, size - suffix)
                    if start >= size or end < start:
                        raise ValueError
                except ValueError:
                    cached.close()
                    headers.update({'Content-Range': f'bytes */{size}', 'Content-Length': '0'})
                    return Response(status_code=416, headers=headers)
                status = 206
                headers.update({'Content-Range': f'bytes {start}-{end}/{size}',
                                'Content-Length': str(end - start + 1)})

            def stream():
                with cached:
                    cached.seek(start)
                    remaining = end - start + 1
                    while remaining > 0:
                        chunk = cached.read(min(64 * 1024, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        yield chunk
            return StreamingResponse(stream(), status_code=status, headers=headers,
                                     background=BackgroundTask(cached.close))
        except BaseException:
            cached.close()
            raise


def warm(db_path, client, bucket):
    """Release a read-only DB snapshot before bounded network work, as thumbnails do."""
    import asset_visibility

    db_path = Path(db_path).resolve()
    cache = OriginalCache(db_path.parent / 'original-cache')
    counts = dict(done=0, skipped=0, failed=0)
    with closing(sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        asset_visibility.install(db)
        rows = [dict(row) for row in db.execute(
            "SELECT id,kind,committed,content_type,size_bytes,sha256,object_key "
            "FROM visible_assets WHERE committed=1 AND kind IN ('image','gif')")]
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for start in range(0, len(rows), 64):
            for result in pool.map(lambda row: cache.fill(client, bucket, row), rows[start:start + 64]):
                counts[result] += 1
    print('done={done} skipped={skipped} failed={failed}'.format(**counts))
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--warm', action='store_true', required=True)
    parser.parse_args()
    import app as api
    counts = warm(api.DB_PATH, api._s3, api.R2_BUCKET)
    return 1 if counts['failed'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
