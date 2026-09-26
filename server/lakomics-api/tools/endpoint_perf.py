"""Measurement-only profile of the tablet's hot and idle Cloud API endpoints (PERF-ALL-001).

Extends ``poll_benchmark.py`` (same throwaway data directory, same R2 stub, never a
production database, token, network or R2 endpoint) with what that script does not report:

* SQL statements and SQLite connections per request (a ``sqlite3.connect`` wrapper sets a
  trace callback on every connection the request opens, including the catalog replica);
* R2 ``HEAD`` calls per request (the stub counts them), with the process HEAD cache either
  cold (cleared before each run) or warm;
* the Collections endpoints on a library-shaped Collections replica (550 works: 388 games,
  149 manga with a realistic volume/cover spread, 13 movies — sizes from a read-only count
  of the Linux library on 2026-09-26, rows synthetic);
* whole-library walks the tablet repeats (Photo Picker snapshot and thumbnail warm-up:
  every ``/v1/library/assets?limit=100`` page).

Optional ``--head-latency-ms`` adds a sleep to each stubbed R2 HEAD to show how the
HEAD count turns into ticket latency; it is a model, not a measurement of R2.

    cd server/lakomics-api
    .venv/bin/python tools/endpoint_perf.py --runs 50 --json /tmp/endpoint-perf.json

Numbers are in-process (TestClient: no TLS, no network); compare runs of this script on
one machine. Statement, connection and HEAD counts are deterministic per request.
"""
import argparse
import hashlib
import json
import os
import random
import sqlite3
import statistics
import sys
import tempfile
import threading
import time
import types
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

# --- instrumentation installed before the application is imported ---------------------
_lock = threading.Lock()
_counts = {"statements": 0, "connections": 0, "heads": 0, "writes": 0}
_WRITE_PREFIXES = ("INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP")
_original_connect = sqlite3.connect


def _trace(statement):
    text = statement.lstrip().upper()
    with _lock:
        _counts["statements"] += 1
        if text.startswith(_WRITE_PREFIXES) and not text.startswith("CREATE TEMP"):
            _counts["writes"] += 1


def _counting_connect(*args, **kwargs):
    connection = _original_connect(*args, **kwargs)
    with _lock:
        _counts["connections"] += 1
    connection.set_trace_callback(_trace)
    return connection


sqlite3.connect = _counting_connect

import poll_benchmark as base  # noqa: E402  (boots the stubbed application)
from poll_benchmark import LIBRARY, SHARED_TOKEN, STAMP, api, sha, stub  # noqa: E402
import head_cache  # noqa: E402
import mobile_collections  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

HEAD_LATENCY = [0.0]
_original_head = stub.fake_s3.head_object


def _counting_head(*, Bucket, Key):
    with _lock:
        _counts["heads"] += 1
    if HEAD_LATENCY[0]:
        time.sleep(HEAD_LATENCY[0])
    return _original_head(Bucket=Bucket, Key=Key)


stub.fake_s3.head_object = _counting_head
# The real boto client exposes its endpoint; without it head_cache never caches.
stub.fake_s3.meta = types.SimpleNamespace(endpoint_url="https://bench.r2.invalid")

# Library-shaped Collections replica (counts from the Linux library, 2026-09-26).
MANGA_VOLUMES = [0, 0, 1, 1, 3, 3, 6, 6, 8, 9, 11, 13, 15, 17, 23, 37, 75, 104]
TYPES = [("game", 388), ("manga", 149), ("movie", 13)]
SHOWCASE = 24


def reset():
    with _lock:
        snapshot = dict(_counts)
        for key in _counts:
            _counts[key] = 0
    return snapshot


def blob(tag, size):
    digest = sha(tag)
    key = mobile_collections.artwork_key(digest)
    stub.fake_s3.objects[key] = {"bucket": "test-bucket", "body": b"x" * size, "content_type": "image/webp"}
    return {"sha256": digest, "sizeBytes": size, "contentType": "image/webp", "objectKey": key}


def collections_fixture():
    rng = random.Random(20260926)
    items, blobs = [], {}
    index = 0
    for kind, count in TYPES:
        for n in range(count):
            ident = f"{kind}-{n:04d}"
            artworks, volumes = [], []

            def art(art_id, art_kind, selected=False):
                thumb, orig = blob(f"{ident}/{art_id}/t", 40_000), blob(f"{ident}/{art_id}/o", 400_000)
                blobs[thumb["sha256"]] = thumb
                blobs[orig["sha256"]] = orig
                artworks.append({"id": art_id, "kind": art_kind, "selected": selected,
                                 "thumbnail": thumb, "original": orig})
                return art_id
            cover = art("cover", "cover", True)
            if kind == "movie":
                for extra in range(4):
                    art(f"extra{extra}", "backdrop")
            elif kind == "game" and n % 10 == 0:
                art("hero", "hero")
            if kind == "manga":
                volume_count = rng.choice(MANGA_VOLUMES)
                covered = n % 3 == 0
                for v in range(volume_count):
                    volumes.append({"id": f"v{v}", "volumeNumber": v + 1, "editionIndex": 0,
                                    "displayLabel": str(v + 1),
                                    "coverArtworkId": art(f"vc{v}", "volume_cover") if covered else None,
                                    "localReleaseDate": f"20{10 + v % 15:02d}-0{1 + v % 9}-1{v % 9}"})
            payload = {
                "id": ident, "name": f"{kind.title()} work {n}", "type": kind,
                # Text sizes from the Linux library: games have none, manga/movie ~0.5 KB.
                "overview": None if kind == "game" else "개요 " * (70 if kind == "manga" else 85),
                "selectedWorkArtworkId": cover, "createdAt": STAMP, "updatedAt": STAMP,
                "year": 1990 + n % 35, "releaseDate": f"{1990 + n % 35}-0{1 + n % 9}-1{n % 9}",
                "genres": "action, drama", "myScore": (n % 10) / 2 if n % 3 else None,
                "showcase": index < SHOWCASE, "showcaseOrder": index if index < SHOWCASE else None,
                "volumes": volumes, "artworks": artworks,
            }
            items.append(mobile_collections.stored(mobile_collections.Collection.model_validate(payload)))
            index += 1
    with api.get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("DELETE FROM mobile_collections")
        db.executemany("INSERT INTO mobile_collections VALUES(?,?,?,?,?,?)", [
            (item["id"], item["type"], item["name"], int(item["showcase"]), item["showcaseOrder"],
             mobile_collections.encode(item)) for item in items])
        db.executemany("INSERT OR REPLACE INTO mobile_collection_artwork VALUES(?,?,?)",
                       [(b["sha256"], b["sizeBytes"], b["contentType"]) for b in blobs.values()])
        db.execute("INSERT OR REPLACE INTO mobile_collection_replica VALUES(1,?,?)", [sha("replica"), STAMP])
        db.commit()
    largest = max(items, key=lambda item: len(item["volumes"]))
    game = next(item for item in items if item["type"] == "game")
    return {"collections": len(items), "artworks": sum(len(i["artworks"]) for i in items),
            "largest_manga": largest["id"], "largest_manga_volumes": len(largest["volumes"]),
            "largest_payload_bytes": len(mobile_collections.encode(largest)), "game": game["id"],
            "manga_volume_cover": next((i["id"], i["volumes"][0]["coverArtworkId"]) for i in items
                                       if i["volumes"] and i["volumes"][0]["coverArtworkId"])}


def immutable_media_keys(count=400):
    """Model newly derived thumbnails with metadata committed by their writer.

    Historical rows without these nullable fields still take the HEAD path.
    Library originals deliberately remain mutable, even with a committed digest.
    """
    with api.get_db() as db:
        db.execute("UPDATE assets SET thumbnail_key='derived/image-thumbnails/v2/'||sha256||'.webp'")
        db.execute("UPDATE assets SET thumbnail_metadata_key=thumbnail_key,"
                   "thumbnail_size_bytes=64,thumbnail_content_type='image/webp'")
        rows = db.execute("SELECT id,object_key,thumbnail_key,content_type,size_bytes FROM assets "
                          "ORDER BY id LIMIT ?", [count]).fetchall()
        db.commit()
    for row in rows:
        stub.fake_s3.objects[row["thumbnail_key"]] = {"bucket": "test-bucket", "body": b"t" * 64,
                                                      "content_type": "image/webp"}
        stub.fake_s3.objects[row["object_key"]] = {"bucket": "test-bucket", "body": b"o" * 128,
                                                   "content_type": row["content_type"]}
    return [row["id"] for row in rows]


def measure(client, name, method, path, headers, body=None, runs=30, warmup=3, cold_heads=False,
            conditional=False):
    samples, counts = [], None
    if conditional:
        first = client.get(path, headers=headers)
        headers = {**headers, "If-None-Match": first.headers.get("ETag", "")}
    response = None
    for i in range(warmup + runs):
        if cold_heads:
            head_cache.ticket_heads._entries.clear()
        reset()
        start = time.perf_counter()
        response = client.request(method, path, headers=headers, json=body)
        elapsed = (time.perf_counter() - start) * 1000
        after = reset()
        if i >= warmup:
            samples.append(elapsed)
            counts = after
    samples.sort()
    return {"name": name, "status": response.status_code, "runs": runs,
            "p50_ms": round(statistics.median(samples), 3),
            "p95_ms": round(samples[max(0, int(len(samples) * 0.95) - 1)], 3),
            "sql_statements": counts["statements"], "sql_writes": counts["writes"],
            "sqlite_connections": counts["connections"], "r2_heads": counts["heads"],
            "bytes": len(response.content), "etag": bool(response.headers.get("ETag"))}


def walk(client, headers, limit=100):
    """Every Library page the Photo Picker snapshot / thumbnail warm-up reads."""
    cursor, pages, total_ms = None, 0, 0.0
    totals = {"statements": 0, "connections": 0, "heads": 0, "writes": 0}
    total_bytes = 0
    while True:
        params = {"limit": limit, **({"cursor": cursor} if cursor else {})}
        reset()
        start = time.perf_counter()
        response = client.get("/v1/library/assets", headers=headers, params=params)
        total_ms += (time.perf_counter() - start) * 1000
        for key, value in reset().items():
            totals[key] += value
        assert response.status_code == 200, response.text
        page = response.json()
        pages += 1
        total_bytes += len(response.content)
        cursor = page.get("next_cursor")
        if not page.get("has_more") or not cursor:
            break
    return {"name": f"walk /v1/library/assets?limit={limit} (all pages)", "pages": pages,
            "total_ms": round(total_ms, 1), "sql_statements": totals["statements"],
            "sqlite_connections": totals["connections"], "bytes": total_bytes}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--runs", type=int, default=30)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--head-latency-ms", type=float, default=0.0)
    parser.add_argument("--json", type=Path, default=None)
    arguments = parser.parse_args(argv)
    os.environ.setdefault("LAKOMICS_CATALOG_REFRESH_DISABLED", "1")
    temp = tempfile.TemporaryDirectory(prefix="lakomics-endpoint-perf-")
    root = Path(temp.name)
    try:
        base.boot(root)
        with TestClient(api.app) as client:
            client_token, publisher_token = base.populate(root)
            base.publish_catalog(client, publisher_token)
            fixture = collections_fixture()
            asset_ids = immutable_media_keys()
            HEAD_LATENCY[0] = arguments.head_latency_ms / 1000
            shared = {"Authorization": f"Bearer {SHARED_TOKEN}"}
            device = {"Authorization": f"Bearer {client_token}"}
            publisher = {"Authorization": f"Bearer {publisher_token}"}
            thumbs = {"items": [{"asset_id": a, "variant": "thumbnail"} for a in asset_ids[:50]]}
            originals = {"items": [{"asset_id": a, "variant": "original"} for a in asset_ids[50:100]]}
            game, (manga_id, volume_art) = fixture["game"], fixture["manga_volume_cover"]
            first = client.get("/v1/collections", headers=shared, params={
                "type": "game", "q": "", "showcase": "false", "limit": 48, "sort": "media_date",
                "direction": "desc", "rating": "all"}).json()
            deep_cursor = None
            params = {"limit": 40}
            for _ in range(50):
                page = client.get("/v1/library/assets", headers=shared, params=params).json()
                params = {"limit": 40, "cursor": page["next_cursor"]}
            deep_cursor = params["cursor"]
            releases = "/v1/collections/releases?limit=1&kinds=new_volume,release_date_changed,release_status_changed"
            catalog = ("/v1/mobile-catalog/search?provider=kHentai&language=korean&text=&sort=hotDay&scope=all"
                       "&revealBlocked=false&limit=40")
            specs = [
                # Tablet idle, every foreground pass (5 s -> 60 s backoff).
                ("idle: GET /v1/sync/status (device token, 304)", "GET", "/v1/sync/status", device, None, {"conditional": True}),
                ("idle: GET /v1/sync/status (device token, 200)", "GET", "/v1/sync/status", device, None, {}),
                ("idle: GET /v1/library/list-generation (unconditional)", "GET", "/v1/library/list-generation", shared, None, {}),
                # Per-tab idle polls (60 s; Catalog 30 s).
                ("idle Home/Library: GET /v1/library/characters/status", "GET", "/v1/library/characters/status", shared, None, {}),
                ("idle Collections: GET /v1/collections/status", "GET", "/v1/collections/status", shared, None, {}),
                ("idle Collections: GET releases counts (304)", "GET", releases, shared, None, {"conditional": True}),
                ("idle Catalog: GET /v1/mobile-catalog/status (304)", "GET", "/v1/mobile-catalog/status", device, None, {"conditional": True}),
                ("idle PC: GET /v1/collections/bindings/log (publisher, 304)", "GET",
                 "/v1/collections/bindings/log?after=0&limit=50", publisher, None, {"conditional": True}),
                ("bind wait: GET bindings/requests?collectionId", "GET",
                 f"/v1/collections/bindings/requests?collectionId={manga_id}&state=all&limit=20", shared, None, {}),
                # Library browsing.
                ("hot: GET /v1/library/assets?limit=40 (first page)", "GET", "/v1/library/assets?limit=40", shared, None, {}),
                ("hot: GET /v1/library/assets?limit=40 (page 51 by cursor)", "GET",
                 "/v1/library/assets?limit=40&cursor=" + deep_cursor, shared, None, {}),
                ("hot: GET /v1/library/assets?limit=100 (warm-up/picker page)", "GET", "/v1/library/assets?limit=100", shared, None, {}),
                ("hot: GET /v1/library/classifications (picker walk)", "GET", "/v1/library/classifications", shared, None, {}),
                ("hot: POST media-tickets 50 thumbnails verify_digest (HEAD cache cold)", "POST",
                 "/v1/library/media-tickets?verify_digest=true", shared, thumbs, {"cold_heads": True}),
                ("hot: POST media-tickets 50 thumbnails verify_digest (HEAD cache warm)", "POST",
                 "/v1/library/media-tickets?verify_digest=true", shared, thumbs, {}),
                ("hot: POST media-tickets 50 originals verify_digest (cold)", "POST",
                 "/v1/library/media-tickets?verify_digest=true", shared, originals, {"cold_heads": True}),
                # Collections tab.
                ("hot: GET /v1/collections game media_date desc (page 1)", "GET",
                 "/v1/collections?type=game&q=&showcase=false&limit=48&sort=media_date&direction=desc&rating=all", shared, None, {}),
                ("hot: GET /v1/collections game (page 2 by cursor)", "GET",
                 "/v1/collections?type=game&q=&showcase=false&limit=48&sort=media_date&direction=desc&rating=all&cursor="
                 + (first.get("nextCursor") or ""), shared, None, {}),
                ("hot: GET /v1/collections manga rating=4.5", "GET",
                 "/v1/collections?type=manga&q=&showcase=false&limit=48&sort=media_date&direction=desc&rating=4.5", shared, None, {}),
                ("hot: GET /v1/collections showcase", "GET", "/v1/collections?type=game&q=&showcase=true&limit=16", shared, None, {}),
                ("hot: GET /v1/collections/{largest manga} detail", "GET",
                 f"/v1/collections/{fixture['largest_manga']}", shared, None, {}),
                ("hot: POST artwork media-ticket game cover (HEAD cache cold)", "POST",
                 f"/v1/collections/{game}/artworks/cover/media-ticket", shared, {"variant": "thumbnail"}, {"cold_heads": True}),
                ("hot: POST artwork media-ticket game cover (HEAD cache warm)", "POST",
                 f"/v1/collections/{game}/artworks/cover/media-ticket", shared, {"variant": "thumbnail"}, {}),
                ("hot: POST artwork media-ticket manga volume cover (cold)", "POST",
                 f"/v1/collections/{manga_id}/artworks/{volume_art}/media-ticket", shared, {"variant": "thumbnail"}, {"cold_heads": True}),
                # Catalog.
                ("hot: GET /v1/mobile-catalog/search default (hotDay, korean, 40)", "GET", catalog, device, None, {}),
                ("hot: GET /v1/mobile-catalog/search text=artist", "GET",
                 catalog.replace("text=", "text=artist-5"), device, None, {}),
            ]
            results = []
            for name, method, path, headers, body, options in specs:
                line = measure(client, name, method, path, headers, body, arguments.runs, arguments.warmup, **options)
                results.append(line)
                print(f"{name:<74} {line['status']} p50 {line['p50_ms']:8.3f} ms p95 {line['p95_ms']:8.3f}"
                      f"  sql {line['sql_statements']:>3} (w {line['sql_writes']}) conn {line['sqlite_connections']}"
                      f"  heads {line['r2_heads']:>2}  {line['bytes']:>7} B")
            for limit in (100,):
                line = walk(client, shared, limit)
                results.append(line)
                print(f"{line['name']:<74} pages {line['pages']} total {line['total_ms']} ms  sql {line['sql_statements']}"
                      f"  conn {line['sqlite_connections']}  {line['bytes']} B")
        report = {"fixture": fixture, "sizes": base.SIZES, "head_latency_ms": arguments.head_latency_ms,
                  "python": sys.version.split()[0], "results": results}
        print(json.dumps({"fixture": fixture}), file=sys.stderr)
        if arguments.json:
            arguments.json.write_text(json.dumps(report, indent=1))
    finally:
        temp.cleanup()
    return 0


if __name__ == "__main__":
    sys.exit(main())
