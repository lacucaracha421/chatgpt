"""Shared card routes on temporary sqlite databases; no real storage or library."""
import json
import random
import sqlite3
import threading
import unittest
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from math import sqrt
from types import SimpleNamespace
from unittest import mock

import api_auth
import authority
import cards
from tests.test_home_upcoming import HomeFixture

PREFIX = cards.PREFIX
NOW = datetime(2026, 10, 15, 3, tzinfo=timezone.utc)
SHA = "a" * 64

FIXTURE_DDL = """
CREATE TABLE assets(id TEXT PRIMARY KEY,kind TEXT NOT NULL,object_key TEXT NOT NULL,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,collected_at TEXT,committed INTEGER,
 width INTEGER,height INTEGER);
CREATE TABLE asset_authority_state(library_id TEXT,asset_id TEXT,lifecycle TEXT,
 PRIMARY KEY(library_id,asset_id));
CREATE TABLE mobile_character_state(singleton INTEGER PRIMARY KEY,revision TEXT,
 published_at TEXT,index_json TEXT);
CREATE TABLE mobile_character_members(node_id TEXT,filter TEXT,position INTEGER,asset_id TEXT,
 PRIMARY KEY(node_id,filter,position),UNIQUE(node_id,filter,asset_id));
CREATE TABLE mobile_character_hidden_members(node_id TEXT,filter TEXT,asset_id TEXT,
 PRIMARY KEY(node_id,filter,asset_id));
CREATE TABLE album_library_settings(library_id TEXT PRIMARY KEY,likes_album_id TEXT);
CREATE TABLE album_authority_members(library_id TEXT,album_id TEXT,asset_id TEXT,desired_state INTEGER,
 PRIMARY KEY(library_id,album_id,asset_id));
"""


def nodes():
    return [{"id": "series:series1", "kind": "series", "sourceId": "series1", "seriesId": "series1", "name": "Series"},
            {"id": "character:c1", "kind": "character", "sourceId": "c1", "seriesId": "series1", "name": "Character"}]


def add_image(db, asset_id, at=NOW, kind="image", collected=None, committed=1):
    db.execute("INSERT INTO assets(id,kind,object_key,created_at,updated_at,collected_at,committed,width,height) "
               "VALUES(?,?,?,?,?,?,?,?,?)", [asset_id, kind, "original/" + asset_id, cards._iso(at), cards._iso(at),
                                           collected, committed, 800, 1200])


def publish_nodes(db, value=None):
    db.execute("INSERT OR REPLACE INTO mobile_character_state VALUES(1,'revision',?,?)",
               [cards._iso(NOW), json.dumps({"nodes": nodes() if value is None else value})])


class CardRoutes(HomeFixture):
    def setUp(self):
        self.storage = mock.Mock()
        self.storage.head_object.return_value = {"ContentLength": 10, "ContentType": "image/webp"}
        self.put_url = mock.Mock(return_value="https://r2.test/put")
        self.get_url = mock.Mock(side_effect=lambda key, ttl: "https://r2.test/" + key)
        self.module = SimpleNamespace(register=lambda app, db, reader, publisher: cards.register(
            app, db, reader, publisher, storage=lambda: self.storage, bucket=lambda: "test-bucket",
            presign_put=self.put_url, presign_get=self.get_url))
        super().setUp()
        self.clock = mock.patch.object(cards, "_now", return_value=NOW)
        self.now = self.clock.start()
        self.addCleanup(self.clock.stop)
        with self.get_db() as db:
            db.executescript(authority.AUTHORITY_DDL + FIXTURE_DDL)
            add_image(db, "art1")
            publish_nodes(db)
            db.execute("INSERT INTO mobile_character_members VALUES('character:c1','all',0,'art1')")
            db.commit()

    def state(self, headers=None):
        return self.client.get(PREFIX + "/state", headers=self.auth if headers is None else headers)

    def open(self, pack="d-20261015", operation="operation-1", headers=None):
        return self.client.post(PREFIX + f"/packs/{pack}/open", headers=self.auth if headers is None else headers,
                                json={"operationId": operation})

    def album(self, **params):
        return self.client.get(PREFIX + "/album", headers=self.auth, params=params)

    def prepare(self, headers=None, **extra):
        return self.client.post(PREFIX + "/cutouts/prepare", headers=self.publisher if headers is None else headers,
            json={"assetId": "art1", "sha256": SHA, "sizeBytes": 10, "contentType": "image/webp",
                  "model": "toonout-1", **extra})

    def complete(self, asset="art1", headers=None):
        return self.client.post(PREFIX + f"/cutouts/{asset}/complete",
                                headers=self.publisher if headers is None else headers)

    def ticket(self, asset="art1", headers=None):
        return self.client.post(PREFIX + f"/cutouts/{asset}/ticket", headers=self.auth if headers is None else headers)

    def keep(self, pack="d-20261015", slots=range(5), operation=None, headers=None):
        return self.client.post(PREFIX + f"/packs/{pack}/keep", headers=self.auth if headers is None else headers,
                                json={"operationId": operation or "keep-" + pack, "slots": list(slots)})

    def pack(self, pack="d-20261015", headers=None):
        return self.client.get(PREFIX + f"/packs/{pack}", headers=self.auth if headers is None else headers)

    def fixed_open(self, pack="d-20261015", tiers=None, keep=True):
        """Open with fixed tiers; by default also keep every card and return the keep reply."""
        with mock.patch.object(cards, "roll_pack", return_value=tiers or ["sr"] * 5):
            opened = self.ok(self.open(pack))
        return self.ok(self.keep(pack)) if keep else opened

    def predraw(self, tiers, pack_state=True):
        """Grant today's pack (a state read) while the roll is fixed, so the pre-draw has these tiers."""
        with mock.patch.object(cards, "roll_pack", return_value=tiers):
            return self.ok(self.state())

    def pending(self, pack="d-20261015"):
        with self.get_db() as db:
            return [dict(r) for r in db.execute("SELECT * FROM card_pending WHERE pack_id=? ORDER BY slot", [pack])]

    def second_character(self):
        with self.get_db() as db:
            add_image(db, "art2")
            add_image(db, "art3")
            publish_nodes(db, nodes() + [{**nodes()[1], "id": "character:c2", "sourceId": "c2", "name": "Second"}])
            db.execute("INSERT INTO mobile_character_members VALUES('character:c2','all',0,'art2')")
            db.execute("INSERT INTO mobile_character_members VALUES('character:c2','all',1,'art3')")
            db.commit()

    def album_total(self):
        with self.get_db() as db:
            return db.execute("SELECT COALESCE(SUM(count),0) FROM card_album").fetchone()[0]

    def other_client(self):
        with self.get_db() as db:
            _, token = api_auth.provision_token(db, "client")
            db.commit()
        return {"Authorization": "Bearer " + token}

    def force_pack(self, pack="b-20261015"):
        with self.get_db() as db:
            db.execute("INSERT INTO card_packs(id,kind,day,granted_at) VALUES(?,?,?,?)",
                       [pack, "bonus" if pack.startswith("b") else "daily", "2026-10-15", cards._iso(NOW)])
            db.commit()

    def activate(self, db, domain):
        db.execute("INSERT INTO authority_domains VALUES('library',?,1,1,0,'digest',NULL,?)",
                   [domain, cards._iso(NOW)])

    def test_roles(self):
        self.assertEqual(self.state({}).status_code, 401)
        self.assertEqual(self.open(headers={}).status_code, 401)
        self.assertEqual(self.client.get(PREFIX + "/album").status_code, 401)
        self.assertEqual(self.prepare(headers=self.auth).status_code, 401)
        self.assertEqual(self.complete(headers=self.auth).status_code, 401)
        self.assertEqual(self.client.get(PREFIX + "/cutout-candidates", headers=self.auth).status_code, 401)
        self.assertEqual(self.ticket(headers={}).status_code, 401)
        self.assertEqual(self.keep(headers={}).status_code, 401)
        self.assertEqual(self.pack(headers={}).status_code, 401)
        self.ok(self.state(self.publisher))
        self.ok(self.open(headers=self.publisher))

    def test_initial_state_and_etag(self):
        reply = self.state()
        state = self.ok(reply)
        self.assertEqual(state["version"], 1)
        self.assertEqual(state["day"], "2026-10-15")
        self.assertEqual(state["nextResetAt"], "2026-10-15T20:00:00+00:00")
        self.assertEqual(state["unopened"], [{"id": "d-20261015", "kind": "daily", "day": "2026-10-15"}])
        self.assertEqual(state["albumSummary"], {"cards": 0, "total": 0})
        self.assertEqual(state["pendingKeep"], [])
        self.assertEqual(state["prefetch"], [{"packId": "d-20261015", "assetIds": ["art1"], "cutoutAssetIds": []}])
        self.assertEqual(state["bonusThreshold"], 50)
        self.assertFalse(state["bonusGranted"])
        self.assertEqual(self.state({**self.auth, "If-None-Match": reply.headers["ETag"]}).status_code, 304)

    def test_startup_does_not_grant_or_backfill(self):
        with self.get_db() as db:
            self.assertEqual(cards.status_signal(db), 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM card_packs").fetchone()[0], 0)
            cards.startup_db(db)
            self.assertEqual(cards.status_signal(db), 0)

    def test_gap_accrual_cap_and_consumed_past_days(self):
        self.ok(self.state())
        self.now.return_value = NOW + timedelta(days=6)
        state = self.ok(self.state())
        self.assertEqual([p["id"] for p in state["unopened"]], ["d-20261015", "d-20261016", "d-20261017"])
        self.ok(self.open())
        state = self.ok(self.state())
        self.assertEqual([p["id"] for p in state["unopened"]], ["d-20261016", "d-20261017", "d-20261021"])
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT accrued_through FROM card_state").fetchone()[0], "2026-10-21")
            self.assertIsNone(db.execute("SELECT 1 FROM card_packs WHERE id='d-20261018'").fetchone())

    def test_0500_kst_edge_and_saved_window(self):
        boundary = datetime(2026, 10, 14, 20, tzinfo=timezone.utc)
        with self.get_db() as db:
            add_image(db, "before", boundary - timedelta(seconds=1))
            add_image(db, "at", boundary)
            add_image(db, "next", boundary + timedelta(days=1))
            db.commit()
        self.now.return_value = boundary - timedelta(microseconds=1)
        before = self.ok(self.state())
        self.assertEqual((before["day"], before["savedToday"]), ("2026-10-14", 1))
        self.now.return_value = boundary
        after = self.ok(self.state())
        self.assertEqual((after["day"], after["savedToday"]), ("2026-10-15", 2))
        self.assertEqual(after["nextResetAt"], cards._iso(boundary + timedelta(days=1)))

    def test_bonus_49_then_50_includes_gifs_and_collected_at(self):
        with self.get_db() as db:
            for i in range(48):
                add_image(db, f"saved{i}", NOW - timedelta(days=20), kind=("gif" if i % 2 else "animated_gif"),
                          collected=cards._iso(NOW))
            add_image(db, "video", kind="video")
            add_image(db, "pending", committed=0)
            db.commit()
        first = self.ok(self.state())
        self.assertEqual(first["savedToday"], 49)
        self.assertFalse(first["bonusGranted"])
        with self.get_db() as db:
            add_image(db, "fiftieth")
            db.commit()
        state = self.ok(self.state())
        self.assertTrue(state["bonusGranted"])
        self.assertEqual(len(state["unopened"]), 2)
        self.assertEqual(len(self.ok(self.state())["unopened"]), 2)

    def test_bonus_is_subject_to_cap(self):
        self.ok(self.state())
        self.now.return_value = NOW + timedelta(days=2)
        with self.get_db() as db:
            for i in range(50):
                add_image(db, f"bonus{i}", self.now.return_value)
            db.commit()
        state = self.ok(self.state())
        self.assertEqual(len(state["unopened"]), 3)
        self.assertFalse(state["bonusGranted"])
        self.ok(self.open())
        state = self.ok(self.state())
        self.assertEqual(len(state["unopened"]), 3)
        self.assertTrue(state["bonusGranted"])

    def test_past_day_bonus_during_gap_but_no_late_retroactive_bonus(self):
        self.ok(self.state())
        with self.get_db() as db:
            for i in range(50):
                add_image(db, f"gap{i}", NOW + timedelta(days=1))
            db.commit()
        self.now.return_value = NOW + timedelta(days=3)
        state = self.ok(self.state())
        self.assertEqual({p["id"] for p in state["unopened"]}, {"d-20261015", "d-20261016", "b-20261016"})
        with self.get_db() as db:
            for i in range(50):
                add_image(db, f"late{i}", NOW + timedelta(days=2))
            db.commit()
        self.ok(self.open())
        self.ok(self.open("d-20261016"))
        self.ok(self.state())
        with self.get_db() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM card_packs WHERE id='b-20261017'").fetchone())

    def test_open_is_idempotent_across_principals_and_later_album_changes(self):
        first = self.fixed_open(keep=False)
        self.assertFalse(first["alreadyOpened"])
        decided = self.ok(self.keep())
        self.force_pack()
        self.fixed_open("b-20261015")
        with self.get_db() as db:
            publish_nodes(db, [{**n, "name": "Renamed"} for n in nodes()])
            db.commit()
        other = self.other_client()
        repeat = self.ok(self.open(operation="other-operation", headers=other))
        self.assertTrue(repeat["alreadyOpened"])
        self.assertEqual(repeat["cards"], decided["cards"])
        self.assertEqual(repeat["openedAt"], first["openedAt"])
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM card_draws WHERE pack_id='d-20261015'").fetchone()[0], 5)
            self.assertEqual(db.execute("SELECT open_operation_id FROM card_packs WHERE id='d-20261015'").fetchone()[0],
                             "operation-1")
            self.assertEqual(db.execute("SELECT SUM(count) FROM card_album").fetchone()[0], 10)

    def test_concurrent_open_is_one_draw(self):
        self.ok(self.state())
        barrier = threading.Barrier(2)

        def run(i):
            barrier.wait(timeout=5)
            return self.open(operation=f"operation-{i}")

        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(run, range(2)))
        results = [self.ok(r) for r in replies]
        self.assertEqual(sorted(r["alreadyOpened"] for r in results), [False, True])
        self.assertEqual(results[0]["cards"], results[1]["cards"])
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM card_draws").fetchone()[0], 5)
        self.assertEqual(self.album_total(), 0)  # opening never touches the album

    def test_concurrent_keeps_with_different_operations_decide_once(self):
        self.fixed_open(keep=False)
        barrier = threading.Barrier(2)

        def run(i):
            barrier.wait(timeout=5)
            return self.keep(slots=[0, 1, 2], operation=f"keep-operation-{i}")

        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(run, range(2)))
        self.assertEqual(sorted(r.status_code for r in replies), [200, 409])
        self.assertEqual(self.album_total(), 3)

    def test_concurrent_keeps_with_one_operation_are_idempotent(self):
        self.fixed_open(keep=False)
        barrier = threading.Barrier(2)

        def run(_):
            barrier.wait(timeout=5)
            return self.keep(slots=[0, 1, 2], operation="same-keep")

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = [self.ok(r) for r in pool.map(run, range(2))]
        self.assertEqual(sorted(r["alreadyKept"] for r in results), [False, True])
        self.assertEqual(results[0]["cards"], results[1]["cards"])
        self.assertEqual(self.album_total(), 3)

    def test_no_characters_does_not_consume_pack(self):
        self.ok(self.state())
        with self.get_db() as db:
            publish_nodes(db, [])
            db.commit()
        reply = self.open()
        self.assertEqual((reply.status_code, self.code(reply)), (409, "noCharacters"))
        with self.get_db() as db:
            self.assertIsNone(db.execute("SELECT opened_at FROM card_packs").fetchone()[0])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM card_draws").fetchone()[0], 0)

    def test_extras_excluded_folders_and_no_image_characters_skipped(self):
        extra = []
        with self.get_db() as db:
            for i, fields in enumerate(({"role": "extras"}, {"excluded": True}, {"kind": "folder"}, {})):
                extra.append({**nodes()[1], "id": f"character:skip{i}", "sourceId": f"skip{i}", **fields})
                add_image(db, f"skip-art{i}", kind="video" if i == 3 else "image")
                db.execute("INSERT INTO mobile_character_members VALUES(?,'all',0,?)", [f"character:skip{i}", f"skip-art{i}"])
            publish_nodes(db, nodes() + extra)
            db.commit()
        result = self.ok(self.open())
        self.assertEqual({c["characterId"] for c in result["cards"]}, {"c1"})

    def test_hidden_trashed_missing_canonical_and_pending_images_never_drawn(self):
        with self.get_db() as db:
            self.activate(db, "assets")
            db.execute("INSERT INTO asset_authority_state VALUES('library','art1','normal')")
            for i, (asset, lifecycle) in enumerate((("hidden", "normal"), ("trash", "trashed"),
                                                    ("missing-state", None), ("pending", "normal")), 1):
                add_image(db, asset, committed=0 if asset == "pending" else 1)
                db.execute("INSERT INTO mobile_character_members VALUES('character:c1','all',?,?)", [i, asset])
                if lifecycle:
                    db.execute("INSERT INTO asset_authority_state VALUES('library',?,?)", [asset, lifecycle])
            db.execute("INSERT INTO mobile_character_hidden_members VALUES('character:c1','all','hidden')")
            db.commit()
        result = self.ok(self.open())
        self.assertEqual({c["artAssetId"] for c in result["cards"]}, {"art1"})
        self.assertEqual(self.ok(self.state())["savedToday"], 2)  # hidden member is still a library image

    def test_duplicate_count_level_first_art_and_separate_tiers(self):
        first = self.fixed_open()
        self.assertEqual([c["count"] for c in first["cards"]], [1, 2, 3, 4, 5])
        self.assertEqual([c["isNew"] for c in first["cards"]], [True, False, False, False, False])
        with self.get_db() as db:
            add_image(db, "art2")
            db.execute("UPDATE mobile_character_members SET asset_id='art2'")
            db.commit()
        self.force_pack()
        second = self.fixed_open("b-20261015", ["sr", "sr", "sr", "sr", "ssr"])
        self.assertEqual([c["level"] for c in second["cards"]], [5, 5, 5, 5, 1])
        self.assertEqual([c["artAssetId"] for c in second["cards"]], ["art1"] * 4 + ["art2"])
        album = self.ok(self.album())["cards"]
        self.assertEqual({c["tier"]: c["count"] for c in album}, {"sr": 9, "ssr": 1})
        self.assertTrue(all(c["firstDrawnAt"] == cards._iso(NOW) for c in album))
        self.assertEqual(self.ok(self.state())["albumSummary"], {"cards": 2, "total": 10})

    def test_serials_increment_per_tier_and_album_keeps_first(self):
        first = self.fixed_open(tiers=["ur", "ur", "lr", "lr", "sr"])
        self.assertEqual([c["serial"] for c in first["cards"]], ["1", "2", "1", "2", None])
        self.force_pack()
        second = self.fixed_open("b-20261015", ["lr", "ur", "lr", "ur", "sr"])
        self.assertEqual([c["serial"] for c in second["cards"]], ["3", "3", "4", "4", None])
        album = self.ok(self.album())["cards"]
        self.assertEqual({c["tier"]: c["serial"] for c in album}, {"lr": "1", "ur": "1", "sr": None})

    def test_album_keyset_pagination_and_invalid_cursors(self):
        self.fixed_open(tiers=["n", "r", "sr", "ssr", "ur"])
        result, cursor = [], None
        for _ in range(3):
            page = self.ok(self.album(limit=2, **({"after": cursor} if cursor else {})))
            result.extend(page["cards"])
            cursor = page["nextCursor"]
        self.assertIsNone(cursor)
        self.assertEqual(len({(c["characterId"], c["tier"]) for c in result}), 5)
        for after in ("invalid!", "bnVsbA", cards._cursor("c1", "bad")):
            self.assertEqual(self.album(after=after).status_code, 422)
        for limit in (0, 201):
            self.assertEqual(self.album(limit=limit).status_code, 422)

    def test_cover_likes_priority_stable_independent_of_draw_and_daily_cache(self):
        with self.get_db() as db:
            self.activate(db, "albums")
            db.execute("INSERT INTO album_library_settings VALUES('library','likes')")
            for i in range(8):
                add_image(db, f"liked{i}")
                db.execute("INSERT INTO album_authority_members VALUES('library','likes',?,1)", [f"liked{i}"])
            add_image(db, "unliked")
            db.execute("INSERT INTO album_authority_members VALUES('library','likes','unliked',0)")
            db.commit()
        cover = self.ok(self.state())["cover"]
        self.assertEqual(len(cover["assetIds"]), 5)
        self.assertTrue(all(a.startswith("liked") for a in cover["assetIds"]))
        with self.get_db() as db:
            db.execute("UPDATE card_state SET cover_day=NULL,cover_json=NULL")
            db.commit()
        self.assertEqual(self.ok(self.state())["cover"], cover)  # same day seed without the cache
        self.assertEqual({c["artAssetId"] for c in self.fixed_open()["cards"]}, {"art1"})
        self.assertEqual(self.ok(self.state())["cover"], cover)
        with self.get_db() as db:
            db.execute("UPDATE album_authority_members SET desired_state=0")
            db.commit()
        self.assertEqual(self.ok(self.state())["cover"], cover)
        self.now.return_value += timedelta(days=1)
        self.assertEqual(self.ok(self.state())["cover"]["day"], "2026-10-16")

    def test_cover_fills_without_duplicates_and_filters_retired_cached_art(self):
        with self.get_db() as db:
            self.activate(db, "albums")
            db.execute("INSERT INTO album_library_settings VALUES('library','likes')")
            db.execute("INSERT INTO album_authority_members VALUES('library','likes','art1',1)")
            for i in range(1, 7):
                add_image(db, f"fill{i}")
                db.execute("INSERT INTO mobile_character_members VALUES('character:c1','all',?,?)", [i, f"fill{i}"])
            db.commit()
        cover = self.ok(self.state())["cover"]
        self.assertEqual(len(set(cover["assetIds"])), 5)
        self.assertEqual(cover["assetIds"][0], "art1")
        with self.get_db() as db:
            self.activate(db, "assets")
            for asset in ["art1"] + [f"fill{i}" for i in range(1, 7)]:
                db.execute("INSERT INTO asset_authority_state VALUES('library',?,?)",
                           [asset, "trashed" if asset == cover["assetIds"][0] else "normal"])
            db.commit()
        self.assertNotIn(cover["assetIds"][0], self.ok(self.state())["cover"]["assetIds"])

    def test_cutout_flow_signed_size_candidates_ready_and_owned_ticket(self):
        self.fixed_open(tiers=["ssr", "ur", "lr", "sr", "n"])
        self.assertEqual(self.ok(self.client.get(PREFIX + "/cutout-candidates", headers=self.publisher)), {"assetIds": ["art1"]})
        prepared = self.ok(self.prepare())
        key = "card-cutouts/art1/" + SHA + ".webp"
        self.put_url.assert_called_once_with(key, "image/webp", cards.TICKET_SECONDS, content_length=10)
        self.assertEqual(prepared["upload"]["requiredHeaders"]["Content-Length"], "10")
        self.assertEqual(self.ticket().status_code, 404)
        self.ok(self.complete())
        self.ok(self.complete())
        self.storage.head_object.assert_called_once_with(Bucket="test-bucket", Key=key)
        self.assertEqual(self.ok(self.ticket())["url"], "https://r2.test/" + key)
        self.assertIsNone(self.ok(self.prepare())["upload"])
        self.assertEqual(self.ok(self.client.get(PREFIX + "/cutout-candidates", headers=self.publisher)), {"assetIds": []})
        album = self.ok(self.album())["cards"]
        self.assertEqual([c["cutout"] for c in album if c["tier"] == "ssr"], [{"assetId": "art1"}])
        self.assertEqual([c["cutout"] for c in album if c["tier"] == "n"], [None])

    def test_cutout_size_mismatch_conflict_missing_and_storage_failure(self):
        self.ok(self.prepare())
        self.storage.head_object.return_value = {"ContentLength": 11}
        reply = self.complete()
        self.assertEqual((reply.status_code, self.code(reply)), (409, "sizeMismatch"))
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT state FROM card_cutouts").fetchone()[0], "uploading")
        self.assertEqual(self.ticket().status_code, 404)
        self.assertEqual(self.prepare(sha256="b" * 64).status_code, 409)
        self.assertEqual(self.complete("unknown").status_code, 404)
        self.storage.head_object.side_effect = RuntimeError("private storage details")
        reply = self.complete()
        self.assertEqual((reply.status_code, self.code(reply)), (503, "storageUnavailable"))
        self.assertNotIn("private storage details", reply.text)

    def test_png_cutout_maximum_size_is_accepted(self):
        self.ok(self.prepare(contentType="image/png", sizeBytes=cards.MAX_CUTOUT_BYTES))
        self.put_url.assert_called_once_with("card-cutouts/art1/" + SHA + ".png", "image/png",
                                             cards.TICKET_SECONDS, content_length=cards.MAX_CUTOUT_BYTES)
        self.storage.head_object.return_value = {"ContentLength": cards.MAX_CUTOUT_BYTES}
        self.ok(self.complete())

    def test_missing_upload_is_a_coded_conflict(self):
        self.ok(self.prepare())

        class MissingObject(Exception):
            response = {"Error": {"Code": "NoSuchKey"}}

        self.storage.head_object.side_effect = MissingObject()
        reply = self.complete()
        self.assertEqual((reply.status_code, self.code(reply)), (409, "uploadMissing"))

    def test_cutout_ticket_denies_unowned_art_accepts_todays_cover_and_expires_cover_access(self):
        with self.get_db() as db:
            add_image(db, "unowned")
            db.commit()
        self.ok(self.prepare(assetId="unowned"))
        self.ok(self.complete("unowned"))
        self.assertEqual(self.ticket("unowned").status_code, 404)
        self.ok(self.state())
        self.ok(self.prepare())
        self.ok(self.complete())
        self.ok(self.ticket())  # cover grants access without album ownership
        self.now.return_value += timedelta(days=1)
        self.assertEqual(self.ticket().status_code, 404)  # yesterday's cover cannot grant access
        self.fixed_open("d-20261016")
        self.ok(self.ticket())  # owned art remains accessible
        with self.get_db() as db:
            self.activate(db, "assets")
            db.execute("INSERT INTO asset_authority_state VALUES('library','art1','trashed')")
            db.commit()
        self.assertEqual(self.ticket().status_code, 404)

    def test_strict_bodies_size_limits_and_pack_ids(self):
        for value in ({}, {"operationId": True}, {"operationId": ""}, {"operationId": "x", "extra": 1}):
            reply = self.client.post(PREFIX + "/packs/d-20261015/open", headers=self.auth, json=value)
            self.assertEqual((reply.status_code, self.code(reply)), (422, "invalidCardRequest"))
        for pack in ("d-2026101", "x-20261015", "d-202610150", "d-abcdefgh"):
            self.assertEqual(self.open(pack).status_code, 422)
        self.assertEqual(self.open("d-20260101").status_code, 404)
        self.ok(self.open())
        for value in ({}, {"operationId": "k"}, {"operationId": "k", "slots": [5]}, {"operationId": "k", "slots": [-1]},
                      {"operationId": "k", "slots": [True]}, {"operationId": "k", "slots": [0, 1, 2, 3, 4, 0]},
                      {"operationId": "k", "slots": [1], "extra": 1}, {"operationId": "", "slots": []}):
            reply = self.client.post(PREFIX + "/packs/d-20261015/keep", headers=self.auth, json=value)
            self.assertEqual((reply.status_code, self.code(reply)), (422, "invalidCardRequest"), value)
        self.assertEqual(self.keep(slots=[1, 1]).status_code, 422)
        for pack in ("d-2026101", "x-20261015"):
            self.assertEqual(self.keep(pack).status_code, 422)
            self.assertEqual(self.pack(pack).status_code, 422)
        self.assertEqual(self.keep("d-20260101").status_code, 404)
        self.assertEqual(self.pack("d-20260101").status_code, 404)
        self.assertEqual(self.album_total(), 0)
        for extra in ({"sizeBytes": cards.MAX_CUTOUT_BYTES + 1}, {"sizeBytes": True}, {"sizeBytes": 0},
                      {"contentType": "image/jpeg"}, {"sha256": "bad"}, {"model": "other"}, {"extra": 1}):
            self.assertEqual(self.prepare(**extra).status_code, 422)
        big = b"x" * (cards.MAX_BODY_BYTES + 1)
        for path, headers in (("/packs/d-20261015/open", self.auth), ("/packs/d-20261015/keep", self.auth),
                              ("/cutouts/prepare", self.publisher)):
            reply = self.client.post(PREFIX + path, headers=headers, content=big)
            self.assertEqual((reply.status_code, self.code(reply)), (413, "cardBodyTooLarge"))

    def test_open_bumps_signal_and_repeat_does_not(self):
        self.ok(self.state())
        with self.get_db() as db:
            before = cards.status_signal(db)
        self.ok(self.open())
        with self.get_db() as db:
            after = cards.status_signal(db)
        self.assertGreater(after, before)
        self.ok(self.open())
        with self.get_db() as db:
            self.assertEqual(cards.status_signal(db), after)
        self.ok(self.keep(slots=[0]))
        with self.get_db() as db:
            decided = cards.status_signal(db)
        self.assertGreater(decided, after)
        self.ok(self.keep(slots=[0]))
        with self.get_db() as db:
            self.assertEqual(cards.status_signal(db), decided)


    def test_pack_is_drawn_at_grant_and_open_applies_that_draw(self):
        self.predraw(["n", "r", "sr", "ssr", "ur"])
        pending = self.pending()
        self.assertEqual([r["tier"] for r in pending], ["n", "r", "sr", "ssr", "ur"])
        self.assertEqual({r["art_asset_id"] for r in pending}, {"art1"})
        self.assertEqual(self.pending("b-20261015"), [])
        with mock.patch.object(cards, "roll_pack", side_effect=AssertionError("must not roll at open")):
            opened = self.ok(self.open())
        self.assertEqual([c["tier"] for c in opened["cards"]], ["n", "r", "sr", "ssr", "ur"])
        self.assertEqual(self.pending(), [])
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM card_draws").fetchone()[0], 5)

    def test_grant_while_no_character_is_eligible_draws_later(self):
        with self.get_db() as db:
            publish_nodes(db, [])
            db.commit()
        state = self.ok(self.state())
        self.assertEqual(state["prefetch"], [])
        self.assertEqual(self.pending(), [])
        with self.get_db() as db:
            publish_nodes(db)
            db.commit()
        state = self.ok(self.state())
        self.assertEqual(len(self.pending()), 5)
        self.assertEqual([p["packId"] for p in state["prefetch"]], ["d-20261015"])

    def test_old_packs_are_drawn_lazily_on_state_and_on_open(self):
        self.force_pack()
        self.assertEqual(self.pending("b-20261015"), [])  # granted before pre-drawing existed
        state = self.ok(self.state())
        self.assertEqual(len(self.pending("b-20261015")), 5)
        self.assertEqual({p["packId"] for p in state["prefetch"]}, {"d-20261015", "b-20261015"})
        with self.get_db() as db:
            db.execute("DELETE FROM card_pending")
            db.commit()
        opened = self.ok(self.open("b-20261015"))
        self.assertEqual(len(opened["cards"]), 5)
        self.assertEqual(len(self.pending("d-20261015")), 5)  # the other pack was drawn by that same open
        self.assertEqual(self.pending("b-20261015"), [])

    def test_open_shows_would_be_values_without_touching_the_album(self):
        opened = self.fixed_open(tiers=["ur", "ur", "sr", "sr", "n"], keep=False)
        self.assertEqual([c["count"] for c in opened["cards"]], [1, 2, 1, 2, 1])
        self.assertEqual([c["isNew"] for c in opened["cards"]], [True, False, True, False, True])
        self.assertEqual([c["serial"] for c in opened["cards"]], [None] * 5)  # serials are given when kept
        self.assertEqual([c["kept"] for c in opened["cards"]], [False] * 5)
        self.assertEqual(self.album_total(), 0)
        self.assertEqual(self.ok(self.album())["cards"], [])
        self.assertEqual(self.ok(self.state())["albumSummary"], {"cards": 0, "total": 0})
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT next FROM card_serials WHERE tier='ur'").fetchone()[0], 1)
        # A card that is already owned shows as a duplicate in the next opened pack.
        self.ok(self.keep(slots=[0]))
        self.force_pack()
        second = self.fixed_open("b-20261015", ["ur", "n", "n", "n", "n"], keep=False)
        self.assertEqual([c["isNew"] for c in second["cards"]], [False, True, False, False, False])
        self.assertEqual([c["count"] for c in second["cards"]], [2, 1, 2, 3, 4])

    def test_keep_subset_updates_album_serials_and_actual_values(self):
        self.fixed_open(tiers=["ur", "ur", "lr", "sr", "n"], keep=False)
        kept = self.ok(self.keep(slots=[1, 2, 3]))
        self.assertFalse(kept["alreadyKept"])
        self.assertEqual([c["kept"] for c in kept["cards"]], [False, True, True, True, False])
        self.assertEqual([c["serial"] for c in kept["cards"]], [None, "1", "1", None, None])
        # Slot 0 was not kept, so slot 1 is the first ur card the album sees.
        self.assertEqual([c["count"] for c in kept["cards"]][1:4], [1, 1, 1])
        self.assertEqual([c["isNew"] for c in kept["cards"]][1:4], [True, True, True])
        album = self.ok(self.album())["cards"]
        self.assertEqual({c["tier"]: (c["count"], c["serial"]) for c in album}, {"ur": (1, "1"), "lr": (1, "1"), "sr": (1, None)})
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT next FROM card_serials WHERE tier='ur'").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT kept_at,keep_operation_id FROM card_packs WHERE id='d-20261015'").fetchone()[1],
                             "keep-d-20261015")
        self.assertEqual(self.ok(self.pack())["cards"], kept["cards"])
        self.assertEqual(self.ok(self.state())["albumSummary"], {"cards": 3, "total": 3})

    def test_keep_none_decides_the_pack_without_album_changes(self):
        self.fixed_open(keep=False)
        decided = self.ok(self.keep(slots=[]))
        self.assertEqual([c["kept"] for c in decided["cards"]], [False] * 5)
        self.assertEqual(self.album_total(), 0)
        self.assertEqual(self.ok(self.state())["pendingKeep"], [])

    def test_keep_is_idempotent_and_a_second_decision_is_refused(self):
        self.fixed_open(keep=False)
        first = self.ok(self.keep(slots=[0, 1], operation="keep-a"))
        again = self.ok(self.keep(slots=[0, 1, 2], operation="keep-a"))
        self.assertTrue(again["alreadyKept"])
        self.assertEqual(again["cards"], first["cards"])
        other = self.keep(slots=[2], operation="keep-b")
        self.assertEqual((other.status_code, self.code(other)), (409, "alreadyKept"))
        self.assertEqual(self.album_total(), 2)
        reopened = self.ok(self.open(operation="again"))
        self.assertTrue(reopened["alreadyOpened"])
        self.assertEqual(reopened["cards"], first["cards"])

    def test_keep_requires_an_opened_known_pack(self):
        self.ok(self.state())
        reply = self.keep()
        self.assertEqual((reply.status_code, self.code(reply)), (409, "packNotOpened"))
        reply = self.pack()
        self.assertEqual((reply.status_code, self.code(reply)), (409, "packNotOpened"))
        self.assertEqual(self.keep("d-20250101").status_code, 404)
        self.assertEqual(self.album_total(), 0)

    def test_pending_keep_listing_and_pack_read(self):
        self.ok(self.state())
        self.ok(self.open())
        state = self.ok(self.state())
        self.assertEqual(state["unopened"], [])
        self.assertEqual(state["pendingKeep"], [{"packId": "d-20261015", "openedAt": cards._iso(NOW),
                                                 "expiresAt": cards._iso(NOW + timedelta(days=7))}])
        self.assertEqual(state["prefetch"], [])
        read = self.ok(self.pack())
        self.assertEqual((read["packId"], read["keptAt"], read["expired"]), ("d-20261015", None, False))
        self.assertEqual(len(read["cards"]), 5)
        self.assertEqual([c["kept"] for c in read["cards"]], [False] * 5)
        self.ok(self.keep())
        self.assertEqual(self.ok(self.state())["pendingKeep"], [])
        self.assertIsNotNone(self.ok(self.pack())["keptAt"])

    def test_unkept_packs_do_not_count_toward_the_unopened_cap(self):
        self.ok(self.state())
        self.now.return_value = NOW + timedelta(days=2)
        self.assertEqual(len(self.ok(self.state())["unopened"]), 3)
        for pack in ("d-20261015", "d-20261016", "d-20261017"):
            self.ok(self.open(pack))
        self.now.return_value = NOW + timedelta(days=3)
        state = self.ok(self.state())
        self.assertEqual([p["id"] for p in state["unopened"]], ["d-20261018"])
        self.assertEqual(len(state["pendingKeep"]), 3)

    def test_unkept_cards_expire_after_seven_days(self):
        self.ok(self.state())
        self.ok(self.open())
        self.now.return_value = NOW + timedelta(days=7) - timedelta(seconds=1)
        self.assertEqual(len(self.ok(self.state())["pendingKeep"]), 1)
        self.now.return_value = NOW + timedelta(days=7)
        with self.get_db() as db:
            before = cards.status_signal(db)
        state = self.ok(self.state())
        self.assertEqual(state["pendingKeep"], [])
        with self.get_db() as db:
            self.assertGreater(cards.status_signal(db), before)
            self.assertIsNotNone(db.execute("SELECT expired_at FROM card_packs WHERE id='d-20261015'").fetchone()[0])
        reply = self.keep()
        self.assertEqual((reply.status_code, self.code(reply)), (409, "packExpired"))
        self.assertEqual(self.album_total(), 0)
        read = self.ok(self.pack())
        self.assertTrue(read["expired"])
        self.assertEqual([c["kept"] for c in read["cards"]], [False] * 5)

    def test_keep_works_until_the_last_second_even_before_accrual_marks_expiry(self):
        self.ok(self.state())
        self.ok(self.open())
        self.now.return_value = NOW + timedelta(days=7) - timedelta(seconds=1)
        self.ok(self.keep(slots=[0]))
        self.assertEqual(self.album_total(), 1)

    def test_a_pack_opened_on_one_device_can_be_kept_on_another(self):
        self.ok(self.state())
        other = self.other_client()
        self.ok(self.open())
        self.assertEqual(self.ok(self.state(other))["pendingKeep"][0]["packId"], "d-20261015")
        read = self.ok(self.pack(headers=other))
        kept = self.ok(self.keep(slots=[0, 3], operation="other-device", headers=other))
        self.assertEqual([c["slot"] for c in kept["cards"]], [c["slot"] for c in read["cards"]])
        self.assertEqual(self.ok(self.pack())["keptAt"], kept["keptAt"])
        self.assertEqual(self.ok(self.state())["pendingKeep"], [])
        self.assertEqual(self.album_total(), 2)

    def test_ineligible_slot_is_redrawn_at_open_keeping_its_tier(self):
        self.second_character()
        self.predraw(["n", "r", "sr", "ssr", "ur"])
        with self.get_db() as db:
            db.execute("UPDATE card_pending SET character_id='c2',art_asset_id='art2' WHERE slot IN (0,1)")
            db.execute("UPDATE card_pending SET character_id='c1',art_asset_id='art3' WHERE slot=2")
            db.execute("UPDATE card_pending SET character_id='c1',art_asset_id='art1' WHERE slot IN (3,4)")
            # c2 loses its registration and art3 (listed under c2) is no longer a c1 image.
            publish_nodes(db)
            db.commit()
        opened = self.ok(self.open())
        self.assertEqual([c["tier"] for c in opened["cards"]], ["n", "r", "sr", "ssr", "ur"])
        self.assertEqual({c["characterId"] for c in opened["cards"]}, {"c1"})
        self.assertEqual({c["artAssetId"] for c in opened["cards"]}, {"art1"})

    def test_trashed_pre_drawn_art_is_redrawn_at_open(self):
        with self.get_db() as db:
            add_image(db, "art4")
            db.execute("INSERT INTO mobile_character_members VALUES('character:c1','all',1,'art4')")
            db.commit()
        self.predraw(["n"] * 5)
        with self.get_db() as db:
            db.execute("UPDATE card_pending SET art_asset_id='art4'")
            db.execute("INSERT INTO mobile_character_hidden_members VALUES('character:c1','all','art4')")
            db.commit()
        opened = self.ok(self.open())
        self.assertEqual({c["artAssetId"] for c in opened["cards"]}, {"art1"})

    def test_prefetch_lists_only_art_ids_unordered_and_stable(self):
        self.second_character()
        reply = None
        with mock.patch.object(cards, "roll_pack", return_value=["lr", "ur", "ssr", "sr", "n"]):
            reply = self.state()
        state = self.ok(reply)
        self.assertEqual(len(state["prefetch"]), 1)
        entry = state["prefetch"][0]
        self.assertEqual(set(entry), {"packId", "assetIds", "cutoutAssetIds"})
        shown = {r["art_asset_id"] for r in self.pending()}
        self.assertEqual(set(entry["assetIds"]), shown)
        self.assertEqual(len(entry["assetIds"]), len(set(entry["assetIds"])))
        text = json.dumps(state["prefetch"])
        for secret in ("lr", "ur", "ssr", "sr", "tier", "character", "Character", "Second", "slot", "c1", "c2"):
            self.assertNotIn('"' + secret + '"', text)
        self.assertEqual(self.ok(self.state())["prefetch"], state["prefetch"])  # stable between reads
        self.assertEqual(self.state({**self.auth, "If-None-Match": reply.headers["ETag"]}).status_code, 304)

    def test_prefetch_drops_art_that_is_no_longer_visible_and_follows_album_art(self):
        self.fixed_open()  # keeps (c1, sr) with art1
        with self.get_db() as db:
            add_image(db, "art2")
            db.execute("UPDATE mobile_character_members SET asset_id='art2'")
            db.commit()
        self.force_pack()
        with mock.patch.object(cards, "roll_pack", return_value=["sr"] * 5):
            state = self.ok(self.state())
        self.assertEqual(state["prefetch"], [{"packId": "b-20261015", "assetIds": ["art1"], "cutoutAssetIds": []}])
        with self.get_db() as db:
            self.activate(db, "assets")
            db.execute("INSERT INTO asset_authority_state VALUES('library','art1','trashed')")
            db.commit()
        self.assertEqual(self.ok(self.state())["prefetch"], [])

    def test_prefetch_cutout_ids_do_not_depend_on_the_tier(self):
        self.predraw(["n"] * 5)
        self.ok(self.prepare())
        self.ok(self.complete())
        entry = self.ok(self.state())["prefetch"][0]
        self.assertEqual((entry["assetIds"], entry["cutoutAssetIds"]), (["art1"], ["art1"]))  # an N card, same answer as an LR

    def test_upgrade_marks_cards_opened_before_the_keep_step_as_kept(self):
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        db.executescript("""
CREATE TABLE card_packs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, day TEXT NOT NULL, granted_at TEXT NOT NULL,
 opened_at TEXT, opened_by TEXT, open_operation_id TEXT);
CREATE TABLE card_draws(pack_id TEXT NOT NULL, slot INTEGER NOT NULL, character_id TEXT NOT NULL,
 tier TEXT NOT NULL, art_asset_id TEXT NOT NULL, serial INTEGER, was_new INTEGER NOT NULL,
 card_json TEXT NOT NULL, PRIMARY KEY(pack_id,slot));
INSERT INTO card_packs VALUES('d-20261014','daily','2026-10-14','2026-10-14T00:00:00+00:00','2026-10-14T01:00:00+00:00','p','o');
INSERT INTO card_packs VALUES('d-20261015','daily','2026-10-15','2026-10-15T00:00:00+00:00',NULL,NULL,NULL);
INSERT INTO card_draws VALUES('d-20261014',0,'c1','sr','art1',NULL,1,'{}');
""")
        cards.startup_db(db)
        self.assertEqual(db.execute("SELECT kept_at FROM card_packs WHERE id='d-20261014'").fetchone()[0],
                         "2026-10-14T01:00:00+00:00")
        self.assertIsNone(db.execute("SELECT kept_at FROM card_packs WHERE id='d-20261015'").fetchone()[0])
        self.assertEqual(db.execute("SELECT kept FROM card_draws").fetchone()[0], 1)
        # Once migrated, a pack that is opened but undecided must stay undecided on later starts.
        db.execute("UPDATE card_packs SET opened_at='2026-10-15T02:00:00+00:00' WHERE id='d-20261015'")
        cards.startup_db(db)
        self.assertIsNone(db.execute("SELECT kept_at FROM card_packs WHERE id='d-20261015'").fetchone()[0])
        db.close()


class CardOdds(unittest.TestCase):
    def test_guarantee_over_seeded_packs_and_relative_reroll(self):
        for seed in range(3000):
            with self.subTest(seed=seed):
                self.assertTrue(any(t in cards.TIERS[2:] for t in cards.roll_pack(random.Random(seed))))
        rng = mock.Mock()
        rng.randrange.side_effect = [0, 0, 0, 0, 0, 199]
        self.assertEqual(cards.roll_pack(rng), ["n", "n", "n", "n", "lr"])
        self.assertEqual(rng.randrange.call_args_list[-1], mock.call(200))

    def test_200k_base_rolls_match_odds(self):
        rng = random.Random(9137)
        counts = Counter(cards.roll_tier(rng) for _ in range(200_000))
        for tier, weight in zip(cards.TIERS, cards.WEIGHTS):
            expected = weight / 1000
            tolerance = 5 * sqrt(expected * (1 - expected) / 200_000)
            self.assertAlmostEqual(counts[tier] / 200_000, expected, delta=tolerance)

    def test_tier_weight_boundaries(self):
        rng = mock.Mock()
        offset = 0
        for tier, weight in zip(cards.TIERS, cards.WEIGHTS):
            for value in (offset, offset + weight - 1):
                rng.randrange.return_value = value
                self.assertEqual(cards.roll_tier(rng), tier)
            offset += weight


class CardAppWiring(unittest.TestCase):
    def setUp(self):
        # Reuse the real-app startup fixture, including storage stubs and worker exclusions.
        from tests.test_home_upcoming import AppWiring
        AppWiring.setUp(self)

    def tearDown(self):
        from tests.test_home_upcoming import AppWiring
        AppWiring.tearDown(self)

    def test_signal_wiring_and_write_waiters(self):
        api = self.fixtures.api_app
        auth = self.fixtures.AUTH
        with mock.patch.object(cards, "_now", return_value=NOW):
            with api.get_db() as db:
                add_image(db, "card-art")
                publish_nodes(db)
                db.execute("INSERT INTO mobile_character_members VALUES('character:c1','all',0,'card-art')")
                db.commit()
            self.assertEqual(self.client.get(PREFIX + "/state", headers=auth).status_code, 200)
            # This fixture's token is not a sync-status principal; read the signal the route serves directly.
            with api.get_db() as db:
                before = api.status_signals(db)["cards"]
            with mock.patch.object(api.write_signal, "bump", wraps=api.write_signal.bump) as wake:
                reply = self.client.post(PREFIX + "/packs/d-20261015/open", headers=auth, json={"operationId": "op"})
                self.assertEqual(reply.status_code, 200, reply.text)
                self.assertTrue(wake.called)
            with api.get_db() as db:
                after = api.status_signals(db)["cards"]
            self.assertGreater(after, before)
            self.assertEqual(self.client.get(PREFIX + "/album", headers=auth).status_code, 200)


if __name__ == "__main__":
    unittest.main()
