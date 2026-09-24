"""In-process latency benchmark for the polling/status endpoints on a synthetic dataset.

Boots the real application against a throwaway data directory (never a production
database, token or R2 endpoint), fills it with a library-shaped synthetic dataset, and
measures each polling endpoint through FastAPI's ``TestClient``. Only sizes are
realistic; every row is generated.

    cd server/lakomics-api
    .venv/bin/python tools/poll_benchmark.py --runs 200 --json /tmp/before.json

The numbers are relative (one process, no network, no TLS); use them to compare a
change against the same script on the same machine, not as production latency.
"""
import argparse
import hashlib
import json
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

SHARED_TOKEN = "bench-shared-token"
# The shared token is read from the environment at import time by app.py.
os.environ["LAKOMICS_API_TOKEN"] = SHARED_TOKEN

import tests.test_capture_api_stub as stub  # noqa: E402  (installs the R2 stub)

import app as api  # noqa: E402
import api_auth  # noqa: E402
import mobile_catalog_replica as replica  # noqa: E402
from app_lifecycle import lifecycle  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

LIBRARY = "c" * 32
STAMP = "2026-09-20T00:00:00Z"

SIZES = {
    "assets": 9_200, "collections": 549, "character_review_items": 667,
    "catalog_works": 3_000, "catalog_tags_per_work": 12,
    "classifications": 600, "albums": 300, "album_members": 6_000,
    "changes_per_domain": 3_000, "bookmarks": 400, "bookmark_changes": 1_000,
    "captures_done": 5_000, "captures_pending": 12,
}


def boot(root: Path):
    api.DB_PATH = root / "lakomics.sqlite3"

    @api.app.get("/_bench/noop")
    def noop():
        return {"ok": True}
    api.API_TOKEN = SHARED_TOKEN
    for handler in lifecycle(api.app).startup_handlers:
        if handler.__name__ == "startup_image_thumbnails":
            continue  # background R2 worker; not part of any polling path
        handler()


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def populate(root: Path):
    with api.get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        columns = [row["name"] for row in db.execute("PRAGMA table_info(assets)")]
        wanted = {"id", "kind", "object_key", "thumbnail_key", "content_type", "size_bytes",
                  "sha256", "created_at", "updated_at", "committed", "committed_at",
                  "collected_at", "width", "height", "duration_ms"}
        cols = [c for c in columns if c in wanted]
        assets, states, assignments, members = [], [], [], []
        for i in range(SIZES["assets"]):
            ident = f"asset-{i:05d}"
            video = i % 7 == 0
            stamp = f"2026-{(i % 12) + 1:02d}-{(i % 28) + 1:02d}T{i % 24:02d}:00:00Z"
            values = {
                "id": ident, "kind": "video" if video else "image",
                "object_key": f"originals/{ident}", "thumbnail_key": f"derived/{ident}.webp",
                "content_type": "video/mp4" if video else "image/jpeg",
                "size_bytes": 100_000 + i, "sha256": sha(ident), "created_at": stamp,
                "updated_at": stamp, "committed": 1, "committed_at": stamp,
                "collected_at": stamp, "width": 1000, "height": 1500 if i % 3 else 800,
                "duration_ms": 12_000 if video else None,
            }
            assets.append([values[c] for c in cols])
            life = "trash" if i % 50 == 0 else "normal"
            states.append((LIBRARY, ident, life, 1, values["kind"], values["object_key"],
                           values["content_type"], values["size_bytes"], values["sha256"],
                           stamp, stamp))
            if i % 25:
                assignments.append((LIBRARY, ident, f"class-{i % SIZES['classifications']:03d}",
                                    1, stamp, stamp))
        db.executemany(f"INSERT INTO assets({','.join(cols)}) VALUES({','.join('?' for _ in cols)})", assets)
        db.executemany(
            "INSERT INTO asset_authority_state(library_id,asset_id,lifecycle,entity_revision,kind,"
            "object_key,content_type,size_bytes,sha256,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)", states)
        db.executemany("INSERT INTO classification_authority_assignments VALUES(?,?,?,?,?,?)", assignments)
        db.executemany(
            "INSERT INTO classification_authority_state(library_id,classification_id,kind,name,"
            "parent_id,entity_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
            [(LIBRARY, f"class-{i:03d}", "work" if i else "root", f"Class {i}",
              None if i == 0 else "class-000", 1, STAMP, STAMP)
             for i in range(SIZES["classifications"])])
        db.executemany(
            "INSERT INTO album_authority_state(library_id,album_id,name,parent_id,entity_revision,"
            "created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            [(LIBRARY, f"album-{i:03d}", f"Album {i}", None, 1, STAMP, STAMP)
             for i in range(SIZES["albums"])])
        seen = set()
        for i in range(SIZES["album_members"]):
            key = (f"album-{i % SIZES['albums']:03d}", f"asset-{(i * 7) % SIZES['assets']:05d}")
            if key in seen:
                continue
            seen.add(key)
            members.append((LIBRARY, key[0], key[1], 1, 1, STAMP, STAMP))
        db.executemany("INSERT INTO album_authority_members VALUES(?,?,?,?,?,?,?)", members)

        n = SIZES["changes_per_domain"]
        for domain in ("assets", "classifications", "albums", "catalog-bookmarks"):
            cursor = n if domain != "catalog-bookmarks" else SIZES["bookmark_changes"]
            db.execute(
                "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,"
                "baseline_digest,baseline_revision,activated_at) VALUES(?,?,1,1,?,?,?,?)",
                [LIBRARY, domain, cursor, sha(domain), "bench", STAMP])
        db.executemany(
            "INSERT INTO asset_authority_changes VALUES(?,?,?,?,?,?,?,?,?)",
            [(LIBRARY, 1, s, "trashAsset" if s % 2 else "restoreAsset", f"asset-{s % SIZES['assets']:05d}",
              2, f"op-asset-{s}", json.dumps({"lifecycle": "trash" if s % 2 else "normal"}), STAMP)
             for s in range(1, n + 1)])
        db.executemany(
            "INSERT INTO classification_authority_changes VALUES(?,?,?,?,?,?,?,?,?,?)",
            [(LIBRARY, 1, s, "setAssetClassification", f"class-{s % SIZES['classifications']:03d}",
              f"asset-{s % SIZES['assets']:05d}", 2, f"op-class-{s}",
              json.dumps({"classificationId": f"class-{s % SIZES['classifications']:03d}"}), STAMP)
             for s in range(1, n + 1)])
        db.executemany(
            "INSERT INTO album_authority_changes VALUES(?,?,?,?,?,?,?,?,?,?)",
            [(LIBRARY, 1, s, "addAlbumAsset", f"album-{s % SIZES['albums']:03d}",
              f"asset-{s % SIZES['assets']:05d}", 2, f"op-album-{s}",
              json.dumps({"desiredState": 1}), STAMP)
             for s in range(1, n + 1)])
        db.executemany(
            "INSERT INTO catalog_bookmark_state VALUES(?,?,?,?,?,?,?)",
            [(LIBRARY, "kHentai", str(100_000 + i), 1, 1, STAMP, STAMP) for i in range(SIZES["bookmarks"])])
        db.executemany(
            "INSERT INTO catalog_bookmark_changes(library_id,epoch,sequence,provider,work_id,desired_state,"
            "entity_revision,operation_id,created_at,updated_at,changed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            [(LIBRARY, 1, s, "kHentai", str(100_000 + (s % SIZES["bookmarks"])), s % 2, 2,
              f"op-bookmark-{s}", STAMP, STAMP, STAMP) for s in range(1, SIZES["bookmark_changes"] + 1)])

        db.execute("INSERT INTO mobile_collection_replica VALUES(1,?,?)", ["rev-bench", STAMP])
        db.executemany(
            "INSERT INTO mobile_collections VALUES(?,?,?,?,?,?)",
            [(f"collection-{i:04d}", "manga" if i % 3 else "game", f"Collection {i}", i % 10 == 0,
              i if i % 10 == 0 else None, json.dumps({"id": f"collection-{i:04d}", "name": f"Collection {i}"}))
             for i in range(SIZES["collections"])])
        db.executemany(
            "INSERT INTO mobile_collection_artwork VALUES(?,?,?)",
            [(sha(f"art-{i}"), 50_000 + i, "image/webp") for i in range(SIZES["collections"])])

        db.execute(
            "INSERT INTO mobile_character_review_state VALUES(1,?,?,?,?,?,?,?,?)",
            [LIBRARY, "feed-bench", 10, 0, 0, "policy-1", STAMP, STAMP])
        db.executemany(
            "INSERT INTO mobile_character_review_targets VALUES(?,?,?,?,?)",
            [(f"target-{i:02d}", f"Character {i}", "series-1", sha(f"fp-{i}"), "[]") for i in range(40)])
        db.executemany(
            "INSERT INTO mobile_character_review_items VALUES(?,?,?,?,?,?,?,?,?)",
            [(i + 1, f"target-{i % 40:02d}", f"asset-{(i * 13) % SIZES['assets']:05d}", 1, 0, 0,
              "candidate", 0.5, "s36") for i in range(SIZES["character_review_items"])])

        capture_cols = [row["name"] for row in db.execute("PRAGMA table_info(captures)")]
        base = {"source_url": "https://x.com/u/status/1", "media_url": "https://pbs.twimg.com/media/x.jpg",
                "classification_id": "class-001", "media_type": "image", "source": "x",
                "content_type": "image/jpeg", "size_bytes": 123_456, "created_at": STAMP,
                "updated_at": STAMP, "object_key": None}
        rows = []
        for i in range(SIZES["captures_done"] + SIZES["captures_pending"]):
            pending = i >= SIZES["captures_done"]
            values = {**base, "id": f"capture-{i:05d}", "status": "pending" if pending else "imported",
                      "object_key": f"inbox/capture-{i:05d}",
                      "source_url": f"https://x.com/u/status/{i}",
                      "media_url": f"https://pbs.twimg.com/media/{i}.jpg"}
            rows.append([values.get(c) for c in capture_cols])
        db.executemany(f"INSERT INTO captures({','.join(capture_cols)}) VALUES({','.join('?' for _ in capture_cols)})", rows)

        _, client_token = api_auth.provision_token(db, "client", "bench-client")
        _, publisher_token = api_auth.provision_token(db, "publisher", "bench-publisher")
        db.commit()
    return client_token, publisher_token


def catalog_projection():
    works, tags, members, handles = [], [], [], []
    for i in range(SIZES["catalog_works"]):
        ident = 100_000 + i
        works.append({"Id": ident, "Title": f"Work {i}", "TitleJpn": None, "Category": (i % 5) + 1,
                      "Uploader": "bench", "Posted": 1_700_000_000 + i * 60, "Updated": None,
                      "FileCount": 20, "FileSize": None, "Rating": None, "Views": i % 1000,
                      "Thumb": None, "Expunged": 0})
        for t in range(SIZES["catalog_tags_per_work"]):
            namespace = ("language", "artist", "character", "female", "male", "other")[t % 6]
            tags.append({"WorkId": ident, "Namespace": namespace,
                         "Value": "korean" if t == 0 else f"{namespace}-{(i * 31 + t) % 900}"})
        members.append({"provider": "kHentai", "work_id": str(ident), "catalog_work_id": ident,
                        "group_id": f"group-{ident}", "thumbnail_valid": 1, "completeness": 1,
                        "lineage_terminal": 1})
        handles.append({"provider": "kHentai", "anchor_work_id": str(ident), "group_id": f"group-{ident}",
                        "sequence": 1})
    records, counts = [], {}
    for kind, rows in (("work", works), ("tag", tags), ("member", members), ("handle", handles),
                       ("translation", [])):
        records.extend({"kind": kind, "value": row} for row in rows)
        counts[kind] = len(rows)
    users = {"bookmarks": [], "hiddenCategories": [], "blockedTags": [], "preferences": [],
             "decisions": [], "decisionRevision": replica.digest([])}
    manifest = {"contractVersion": 1, "schemaVersion": 1, "sourceRevision": "bench-v1",
                "groupGeneration": 1, "groupDecisionRevision": users["decisionRevision"], "counts": counts}
    data = b"".join((replica.encode(record) + "\n").encode()
                    for record in [{"kind": "manifest", "value": manifest}, *records])
    return data, hashlib.sha256(data).hexdigest(), users


def publish_catalog(client, publisher):
    data, digest, users = catalog_projection()
    import mobile_catalog
    headers = {"Authorization": f"Bearer {publisher}", mobile_catalog.LIBRARY_HEADER: LIBRARY}
    response = client.put(f"/v1/mobile-catalog/replicas/{digest}", headers=headers, content=data)
    assert response.status_code == 200, response.text
    response = client.put("/v1/mobile-catalog/publication", headers=headers,
                          json={"version": 1, "baseRevision": None, "contentDigest": digest, "userSnapshot": users})
    assert response.status_code == 200, response.text


def endpoints(client_token, publisher_token):
    shared = {"Authorization": f"Bearer {SHARED_TOKEN}"}
    device = {"Authorization": f"Bearer {client_token}"}
    publisher = {"Authorization": f"Bearer {publisher_token}"}
    n = SIZES["changes_per_domain"]
    feed = {"libraryId": LIBRARY, "epoch": 1}
    for asset_id in ("asset-00001", "asset-00002", "asset-00003"):
        for key in (f"originals/{asset_id}", f"derived/{asset_id}.webp"):
            stub.fake_s3.objects[key] = {"bucket": "test-bucket", "body": b"x" * 10, "content_type": "image/jpeg"}
    return [
        ("GET /_bench/noop (framework floor)", "GET", "/_bench/noop", device, None, None),
        ("GET /v1/sync/status", "GET", "/v1/sync/status", device, None, None),
        ("GET /v1/sync/status (304)", "GET", "/v1/sync/status", device, None, None),
        ("GET /v1/sync/status (shared token)", "GET", "/v1/sync/status", shared, None, None),
        ("GET /v1/mobile-catalog/status", "GET", "/v1/mobile-catalog/status", device, None, None),
        ("GET /v1/mobile-catalog/status (304)", "GET", "/v1/mobile-catalog/status", device, None, None),
        ("GET /v1/albums/changes (caught up)", "GET", "/v1/albums/changes", device, {**feed, "after": n}, None),
        ("GET /v1/albums/changes (caught up, 304)", "GET", "/v1/albums/changes", device, {**feed, "after": n}, None),
        ("GET /v1/albums/changes (100 items)", "GET", "/v1/albums/changes", device, {**feed, "after": n - 500}, None),
        ("GET /v1/classifications/authority/changes (caught up)", "GET", "/v1/classifications/authority/changes",
         device, {**feed, "after": n}, None),
        ("GET /v1/classifications/authority/changes (100 items)", "GET", "/v1/classifications/authority/changes",
         device, {**feed, "after": n - 500}, None),
        ("GET /v1/assets/authority/changes (caught up)", "GET", "/v1/assets/authority/changes", device,
         {**feed, "after": n}, None),
        ("GET /v1/assets/authority/changes (200 items)", "GET", "/v1/assets/authority/changes", device,
         {**feed, "after": n - 500}, None),
        ("GET /v1/mobile-catalog/bookmarks/changes (caught up)", "GET", "/v1/mobile-catalog/bookmarks/changes",
         device, {**feed, "after": SIZES["bookmark_changes"]}, None),
        ("GET /v1/library/assets", "GET", "/v1/library/assets", shared, {"limit": 50}, None),
        ("GET /v1/library/assets?classification_id", "GET", "/v1/library/assets", shared,
         {"limit": 50, "classification_id": "class-007"}, None),
        ("GET /v1/library/list-generation", "GET", "/v1/library/list-generation", shared, None, None),
        ("GET /v1/captures/pending", "GET", "/v1/captures/pending", shared, None, None),
        ("POST /v1/library/media-tickets (3 assets)", "POST", "/v1/library/media-tickets", shared, None,
         {"items": [{"asset_id": f"asset-0000{i}", "variant": "thumbnail"} for i in (1, 2, 3)]}),
        ("GET /v1/library/characters/exclusions", "GET", "/v1/library/characters/exclusions", publisher,
         {"libraryId": LIBRARY, "after": 0}, None),
        ("POST /v1/collections/artworks/check (50)", "POST", "/v1/collections/artworks/check", shared, None,
         {"items": [{"sha256": sha(f"art-{i}"), "sizeBytes": 50_000 + i, "contentType": "image/webp"}
                    for i in range(50)]}),
    ]


def measure(client, spec, runs, warmup):
    name, method, path, headers, params, body = spec
    samples = []
    status = None
    if "304)" in name:
        # Conditional poll: the client sends back the ETag of the answer it already has.
        first = client.get(path, headers=headers, params=params)
        headers = {**headers, "If-None-Match": first.headers.get("ETag", "")}
    for i in range(warmup + runs):
        start = time.perf_counter()
        if method == "GET":
            response = client.get(path, headers=headers, params=params)
        else:
            response = client.post(path, headers=headers, json=body)
        elapsed = (time.perf_counter() - start) * 1000
        status = response.status_code
        if i >= warmup:
            samples.append(elapsed)
    samples.sort()
    return {"status": status, "runs": runs,
            "p50_ms": round(statistics.median(samples), 3),
            "p95_ms": round(samples[int(len(samples) * 0.95) - 1], 3),
            "mean_ms": round(statistics.fmean(samples), 3),
            "bytes": len(response.content)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--runs", type=int, default=200)
    parser.add_argument("--warmup", type=int, default=20)
    parser.add_argument("--json", type=Path, default=None, help="write the results as JSON here")
    parser.add_argument("--keep", type=Path, default=None, help="reuse/keep the data directory")
    arguments = parser.parse_args(argv)

    temp = None
    if arguments.keep is not None:
        root = arguments.keep
        root.mkdir(parents=True, exist_ok=True)
    else:
        temp = tempfile.TemporaryDirectory(prefix="lakomics-poll-benchmark-")
        root = Path(temp.name)
    os.environ.setdefault("LAKOMICS_CATALOG_REFRESH_DISABLED", "1")
    try:
        boot(root)
        with api.get_db() as db:
            populated = db.execute("SELECT COUNT(*) FROM assets").fetchone()[0]
        client_token, publisher_token = (None, None)
        with TestClient(api.app) as client:
            if not populated:
                started = time.perf_counter()
                client_token, publisher_token = populate(root)
                publish_catalog(client, publisher_token)
                (root / "tokens.json").write_text(json.dumps([client_token, publisher_token]))
                print(f"dataset built in {time.perf_counter() - started:.1f}s", file=sys.stderr)
            else:
                client_token, publisher_token = json.loads((root / "tokens.json").read_text())
            results = {}
            for spec in endpoints(client_token, publisher_token):
                results[spec[0]] = measure(client, spec, arguments.runs, arguments.warmup)
                line = results[spec[0]]
                print(f"{spec[0]:<62} {line['status']}  p50 {line['p50_ms']:7.3f} ms  p95 {line['p95_ms']:7.3f} ms"
                      f"  {line['bytes']:>6} B")
        report = {"sizes": SIZES, "python": sys.version.split()[0], "results": results}
        if arguments.json:
            arguments.json.write_text(json.dumps(report, indent=1))
    finally:
        if temp is not None:
            temp.cleanup()
    return 0


if __name__ == "__main__":
    sys.exit(main())
