"""Process-local ticket metadata only; never cache authorization or signed URLs."""
import hashlib
import re
import threading
import time
from collections import OrderedDict


# Writers: cloud/collections.rs hashes artwork bytes; image_thumbnails.py binds
# derived keys to a verified source digest and a versioned encoding recipe.
# Mutable originals may opt in only for clients that verify the row digest on download.
# Legacy artwork/thumbnail and backup keys still always use a fresh HEAD.
_IMMUTABLE_KEY = re.compile(
    r"(?:work-artwork/mobile/[a-f0-9]{64}|"
    r"derived/(?:image-thumbnails/v[12]|media-thumbnails/v1/gif|"
    r"media-thumbnails/v2/video)/[a-f0-9]{64}\.webp)"
)


def _storage_namespace(storage):
    # R2 endpoints include the account. Both interactive and worker boto clients
    # expose the configured endpoint via ClientMeta; object identity is not stable
    # across those clients. Keep only an opaque digest, never URLs or credentials.
    endpoint = getattr(getattr(storage, "meta", None), "endpoint_url", None)
    if not isinstance(endpoint, str) or not endpoint:
        return None
    return hashlib.sha256(endpoint.rstrip("/").encode("utf-8")).digest()


class HeadMetadataCache:
    def __init__(self, *, ttl_seconds=30, max_entries=512, clock=time.monotonic):
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self.clock = clock
        self._entries = OrderedDict()
        self._lock = threading.Lock()
        self._generation = 0

    def invalidate(self, storage, bucket, key):
        namespace = _storage_namespace(storage)
        if namespace is None:
            return
        with self._lock:
            self._entries.pop((namespace, bucket, key), None)
            # A HEAD already in flight must not undo a fresh verification/write.
            # One generation avoids an unbounded map of per-key invalidations.
            self._generation += 1

    def head(self, storage, bucket, key, *, identity=None, verified_original=False, fresh=False):
        """Reuse success for immutable keys or digest-verified originals, with unchanged DB metadata.

        Omit identity for upload verification: always HEAD and invalidate tickets.
        Network calls stay outside the lock; concurrent cold misses may duplicate
        HEADs, but do not serialize the existing bounded ticket request pool.
        """
        namespace = _storage_namespace(storage)
        if namespace is None or not (_IMMUTABLE_KEY.fullmatch(key) or verified_original):
            return storage.head_object(Bucket=bucket, Key=key)
        if identity is None or fresh:
            self.invalidate(storage, bucket, key)
            try:
                return storage.head_object(Bucket=bucket, Key=key)
            finally:
                self.invalidate(storage, bucket, key)
        cache_key = (namespace, bucket, key)
        started = self.clock()
        with self._lock:
            entry = self._entries.get(cache_key)
            if entry is not None:
                expires, cached_identity, metadata = entry
                if started < expires and cached_identity == identity:
                    self._entries.move_to_end(cache_key)
                    return dict(metadata)
                self._entries.pop(cache_key)
            generation = self._generation
        try:
            response = storage.head_object(Bucket=bucket, Key=key)
        except Exception:
            self.invalidate(storage, bucket, key)
            raise
        metadata = {field: response.get(field) for field in ("ContentType", "ContentLength")}
        # Incomplete responses still retain the caller's fallback/error semantics,
        # but are not reusable successes.
        if (isinstance(metadata["ContentType"], str) and metadata["ContentType"]
                and type(metadata["ContentLength"]) is int and metadata["ContentLength"] >= 0):
            with self._lock:
                if generation == self._generation and self.clock() < started + self.ttl_seconds:
                    self._entries[cache_key] = (started + self.ttl_seconds, identity, metadata)
                    self._entries.move_to_end(cache_key)
                    while len(self._entries) > self.max_entries:
                        self._entries.popitem(last=False)
        return dict(metadata)


ticket_heads = HeadMetadataCache()
