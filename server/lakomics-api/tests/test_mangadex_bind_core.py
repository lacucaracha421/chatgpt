"""Offline SQLite/transport fixtures, including the real shared blob staging body."""
import copy
import hashlib
import io
import json
import os
import time
import types
import unittest
import uuid
import warnings
from unittest import mock

import kakao_bind_worker as kb
import mangadex_bind as md
from tests import test_kakao_bind_core as kakao_fixtures
from tests.test_kakao_bind_core import HTTPError, LIBRARY, NOW, ROOT, load_core

MANGA = "d1a9fdeb-f713-407f-960c-8326b586e6fd"
COVER = "11111111-1111-4111-8111-111111111111"
FIXTURES = ROOT.parents[1] / "_tools/app/src-tauri/src/library/fixtures"


class MissingBlob(Exception):
    response = {"Error": {"Code": "404"}}


def artwork_core(ca):
    names = {"fail", "_stored_blob", "store_artwork_bytes", "check_artwork_stop", "image_dimensions",
             "artwork_thumbnail", "mangadex_image", "mangadex_ready"}
    module = load_core("work_providers", dict(ca=ca, HTTPException=HTTPError, ClientError=MissingBlob,
        json=json, io=io, hashlib=hashlib, time=time, uuid=uuid, warnings=warnings,
        MAX_ARTWORK_BYTES=16 * 1024 * 1024, MAX_AUTO_IMAGE_PIXELS=16 * 1024 * 1024,
        MAX_THUMBNAIL_BYTES=2 * 1024 * 1024, ARTWORK_THUMBNAIL_BOUND=360,
        ARTWORK_THUMBNAIL_MIME="image/webp", artwork_key=lambda sha: "work-artwork/mobile/" + sha,
        positive=lambda n: type(n) is int and n > 0,
        head_cache=types.SimpleNamespace(ticket_heads=types.SimpleNamespace(invalidate=lambda *args: None))),
        lambda node: getattr(node, "name", None) in names)
    module.UpstreamStatus = type("UpstreamStatus", (Exception,), {
        "__init__": lambda self, status, retry_after=None: (setattr(self, "status", status),
             setattr(self, "retry_after", retry_after)) and None})
    return module


class MangaDexBindTests(unittest.TestCase):
    def setUp(self):
        self.base = kakao_fixtures.CoreTests()
        self.base.setUp()
        self.addCleanup(self.base.tearDown)
        self.env = mock.patch.dict(os.environ, {"LAKOMICS_MANGADEX_BINDS": "1", kb.ENV: "0"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.db, self.ca, self.bindings, self.rc = self.base.db, self.base.ca, self.base.bindings, self.base.rc
        self.db.execute("CREATE TABLE mobile_collection_artwork(sha256 TEXT PRIMARY KEY,size_bytes INTEGER,content_type TEXT)")
        self.db.commit()
        self.pipe = artwork_core(self.ca)
        self.pipe.mangadex_ready = lambda: True
        self.pipe.image_dimensions = lambda *args, **kw: (120, 180)
        self.pipe.artwork_thumbnail = lambda _: b"thumbnail"
        self.blobs, self.calls, self.stage_calls = {}, [], []
        self.during_fetch = lambda: None
        self.during_storage = lambda: None
        def head(**kw):
            self.assertFalse(self.db.in_transaction)
            self.stage_calls.append("head")
            self.during_storage()
            if kw["Key"] not in self.blobs:
                raise MissingBlob()
            return self.blobs[kw["Key"]]
        def put(**kw):
            self.assertFalse(self.db.in_transaction)
            self.stage_calls.append("put")
            data = kw["Body"].read()
            self.blobs[kw["Key"]] = {"ContentLength": len(data), "ContentType": kw["ContentType"]}
        self.storage = types.SimpleNamespace(head_object=head, put_object=put)
        self.fake_imports = mock.patch.dict("sys.modules", {"r2": types.SimpleNamespace(), "collection_bindings": self.bindings})
        self.fake_imports.start()
        self.addCleanup(self.fake_imports.stop)
        self.pipe.outbound = self.image
        self.bindings.http_get = self.http
        self.bindings.gate.mangadex_spacing = self.spacing
        self.detail = json.loads((FIXTURES / "mangadex_detail.json").read_text(encoding="utf-8"))
        self.covers = json.loads((FIXTURES / "mangadex_covers.json").read_text(encoding="utf-8"))["data"]
        self.page_override = None
        self.manga = md.Provider(self.bindings, self.ca, self.base.connection, lambda: self.storage, lambda: "fixture",
                                 artwork=self.pipe)
        self.worker = kb.Worker(self.base.connection, bindings=self.bindings, planner=self.rc, ca=self.ca,
                                now=lambda: NOW, manga=self.manga)
        self.worker.thread = types.SimpleNamespace(is_alive=lambda: True)
        kb._current = self.worker

    def spacing(self):
        self.assertTrue(self.bindings.gate.provider_locks["mangadex"].locked())
        self.calls.append("spacing")

    def http(self, url, params, headers, max_bytes, timeout, deadline):
        self.assertFalse(self.db.in_transaction)
        self.assertTrue(self.bindings.gate.provider_locks["mangadex"].locked())
        self.assertLessEqual(timeout, 20)
        self.calls.append((url, params))
        self.during_fetch()
        if "/manga/" in url:
            return json.dumps(self.detail).encode()
        offset = int(dict(params)["offset"])
        reply = self.page_override(offset) if self.page_override else {
            "result": "ok", "data": self.covers[offset:offset + 100], "total": len(self.covers), "offset": offset}
        return reply if isinstance(reply, bytes) else json.dumps(reply).encode()

    def image(self, url, **kwargs):
        self.assertFalse(self.db.in_transaction)
        self.calls.append((url, kwargs))
        self.assertTrue(self.bindings.gate.provider_locks["mangadex"].locked())
        self.assertEqual(kwargs["limit"], 16 * 1024 * 1024)
        return b"original", "image/jpeg"

    def submit(self, **kwargs):
        return self.base.submit(provider="mangadex", choice={"mangaId": MANGA, "title": "untrusted",
                 "coverUrl": "https://untrusted.invalid/preview"}, **kwargs)

    def row(self, request):
        return self.base.row(request["requestId"])

    def apply(self, **kwargs):
        request = self.submit(**kwargs)
        self.worker.execute(request["requestId"])
        return request

    def command(self, kind, **kwargs):
        return self.base.command(kind, **kwargs)

    def slot(self, ident, number=1, edition=0, **overrides):
        values = dict(workId="a", volumeId=ident, volumeNumber=number, editionIndex=edition,
            sortOrder=42, displayLabel="manual label", coverArtworkId=None, sourceProvider=None,
            sourceCoverId=None, deleted=False, expectedRevision=0)
        return self.command("upsertVolume", **{**values, **overrides})

    def extra_cover(self, number, *, locale="ja", ident=None):
        cover = copy.deepcopy(self.covers[0])
        cover["id"] = ident or str(uuid.uuid4())
        cover["attributes"].update(volume=str(number), locale=locale, fileName="valid.jpg")
        return cover

    def work(self):
        return self.ca.work_state(self.ca.work_row(self.db, LIBRARY, "a"))

    def test_rust_fixture_normalization_full_snapshot_original_receipt_quiet_replay(self):
        request = self.apply(expected={"externalId": None})
        self.assertEqual(self.row(request)["state"], "applied")
        binding = self.ca.binding_row(self.db, LIBRARY, "a", "mangadex")
        values = json.loads(binding["snapshot_values"])
        self.assertEqual(values, {"year": 2014, "author": "Ryoko Kui", "genres": "Fantasy, 모험",
            "overview": "던전을 탐험하며 마물을 요리하는 이야기.", "originalTitle": "ダンジョン飯"})
        snapshot = json.loads(binding["snapshot"])
        self.assertEqual(snapshot["detail"], self.detail)
        self.assertEqual(snapshot["covers"]["data"], self.covers)
        art = self.db.execute("SELECT * FROM collection_authority_artworks").fetchone()
        self.assertEqual((art["provider"], art["provider_image_id"], art["language"]), ("mangadex", COVER, "ja"))
        self.assertEqual(json.loads(art["original"])["sha256"], hashlib.sha256(b"original").hexdigest())
        self.assertEqual(self.work()["selection"]["work"], art["artwork_id"])
        self.assertIn((f"https://uploads.mangadex.org/covers/{MANGA}/a1b2c3d4-e5f6-47a8-9000-111122223333.jpg",
            dict(deadline=mock.ANY, limit=16 * 1024 * 1024, image=True, socket_seconds=1)), self.calls)
        self.assertEqual(self.calls.count("spacing"), 3)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_release_events").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_volume_sources").fetchone()[0], 0)
        schedule = self.work()["derived"]["releaseSchedule"]["mangadex"]
        self.assertEqual(schedule["volumes"], [{"volumeNumber": 1, "editionIndex": 0}])
        before, calls = list(self.db.iterdump()), len(self.calls)
        os.environ["LAKOMICS_MANGADEX_BINDS"] = "0"
        self.worker.execute(request["requestId"])
        self.assertEqual(self.submit(operation_id=request["operationId"])["state"], "applied")
        self.assertEqual(list(self.db.iterdump()), before)
        self.assertEqual(len(self.calls), calls)
        with self.assertRaises(HTTPError) as error:
            self.submit(operation_id=request["operationId"], digest="changed")
        self.assertEqual(error.exception.detail["code"], "operationConflict")

    def test_representative_literal_one_fallback_unrelated_and_malformed(self):
        self.covers = [self.extra_cover("1.0"), self.extra_cover("2"), self.extra_cover("1"), self.extra_cover("1")]
        parsed = md.parse_covers({"result": "ok", "data": self.covers}, MANGA, self.bindings)
        self.assertEqual(md.representative(parsed)["coverId"], self.covers[2]["id"])
        self.assertEqual(md.representative(parsed[:2])["coverId"], self.covers[0]["id"])
        unrelated = self.extra_cover("3")
        unrelated["relationships"] = [{"type": "manga", "id": str(uuid.uuid4())}]
        unrelated["attributes"]["fileName"] = "../invalid.jpg"
        self.assertEqual(md.parse_covers({"result": "ok", "data": [unrelated]}, MANGA, self.bindings), [])
        for change in (lambda c: c.update(id="broken"), lambda c: c["attributes"].update(fileName="../invalid.jpg")):
            cover = self.extra_cover("3")
            change(cover)
            with self.assertRaises(kb.Refused):
                md.parse_covers({"result": "ok", "data": [cover]}, MANGA, self.bindings)

    def test_no_japanese_cover_is_metadata_only_and_thumbnail_fallback(self):
        self.covers = [self.extra_cover("1", locale="ko")]
        request = self.apply()
        self.assertEqual(self.row(request)["state"], "applied")
        self.assertEqual(len(self.calls), 4)
        self.assertEqual(len(self.blobs), 0)
        self.covers = [self.extra_cover("1")]
        self.pipe.artwork_thumbnail = lambda _: None
        self.assertEqual(self.row(self.apply())["state"], "applied")
        art = self.db.execute("SELECT * FROM collection_authority_artworks").fetchone()
        self.assertIsNone(art["thumbnail"])

    def test_pagination_over_100_order_complete_and_invalid_pages(self):
        self.covers = [self.extra_cover(n) for n in range(1, 103)]
        fetched = self.manga.fetch(MANGA, stop=lambda: False)
        self.assertEqual(len(fetched["covers"]), 102)
        self.assertEqual([c["coverId"] for c in fetched["covers"]], [c["id"] for c in self.covers])
        for override in (
            lambda _: {"result": "ok", "data": self.covers},
            lambda _: {"result": "ok", "data": [], "total": 102},
            lambda n: {"result": "ok", "data": self.covers[:100] if n == 0 else [], "total": 102},
            lambda _: {"result": "ok", "data": self.covers[:1], "offset": 99},
            lambda _: b"x" * (4 * 1024 * 1024 + 1),
        ):
            with self.subTest(override=override):
                self.page_override = override
                with self.assertRaises(kb.Refused):
                    self.manga.fetch(MANGA, stop=lambda: False)

    def test_identity_snapshot_size_and_required_image_failure_no_partial_apply(self):
        scenarios = ("wrong_uuid", "snapshot_size", "missing_cover", "bad_image", "image_size")
        original = copy.deepcopy(self.detail)
        image = self.pipe.outbound
        for scenario in scenarios:
            self.detail, self.pipe.outbound = copy.deepcopy(original), image
            if scenario == "wrong_uuid":
                self.detail["data"]["id"] = str(uuid.uuid4())
                code = "invalidMangaDexIdentity"
            elif scenario == "snapshot_size":
                self.detail["data"]["padding"] = "x" * self.ca.MAX_SNAPSHOT_BYTES
                code = "mangadexResponseTooLarge"
            elif scenario == "missing_cover":
                self.pipe.outbound = lambda *a, **k: (_ for _ in ()).throw(self.pipe.UpstreamStatus(404))
                code = "mangadexCoverInvalid"
            elif scenario == "bad_image":
                self.pipe.image_dimensions = lambda *a, **k: self.pipe.fail(422, "providerImageInvalid", "unsafe")
                code = "mangadexCoverInvalid"
            else:
                self.pipe.outbound = lambda *a, **k: (b"x" * (16 * 1024 * 1024 + 1), "image/jpeg")
                code = "mangadexResponseTooLarge"
            with self.subTest(scenario):
                request = self.apply()
                self.assertEqual((self.row(request)["state"], self.row(request)["reason_code"]), ("failed", code))
                self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_bindings").fetchone()[0], 0)
                self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_artworks").fetchone()[0], 0)

    def test_manual_fields_three_way_clear_and_commit_time_edit(self):
        self.command("updateWork", workId="a", expected={}, changes={"author": "manual", "description": "memo", "myScore": 4.5},
                     expectedRevision=self.work()["entityRevision"])
        request = self.apply()
        self.assertEqual(self.row(request)["state"], "applied")
        self.assertEqual(self.work()["name"], "a")
        self.assertEqual(self.work()["fields"]["author"], "manual")
        self.assertEqual(self.work()["fields"]["description"], "memo")
        self.detail["data"]["attributes"].update(year=None, tags=[], description={})
        self.during_fetch = lambda: self.command("updateWork", workId="a", expected={}, changes={"overview": "new manual"},
                                                expectedRevision=self.work()["entityRevision"])
        self.apply()
        self.assertIsNone(self.work()["fields"]["year"])
        self.assertIsNone(self.work()["fields"]["genres"])
        self.assertEqual(self.work()["fields"]["overview"], "new manual")

    def test_selection_and_explicit_noop_clear_during_fetch_and_missing_history(self):
        for scenario in ("clear", "history", "selection"):
            request = self.submit()
            def race():
                self.during_fetch = lambda: None
                if scenario == "clear":
                    self.command("selectArtwork", workId="a", slot="work", artworkId=None, expectedArtworkId=None)
                elif scenario == "history":
                    self.command("updateWork", workId="a", expected={}, changes={"author": "manual"}, expectedRevision=self.work()["entityRevision"])
                    self.db.execute("DELETE FROM collection_authority_changes")
                    self.db.commit()
                else:
                    self.command("selectArtwork", workId="a", slot="work", artworkId=self.db.execute(
                        "SELECT artwork_id FROM collection_authority_artworks LIMIT 1").fetchone()[0], expectedArtworkId=None)
                    self.command("selectArtwork", workId="a", slot="work", artworkId=None,
                                 expectedArtworkId=self.work()["selection"]["work"])
            self.during_fetch = race
            self.worker.execute(request["requestId"])
            self.assertEqual(self.row(request)["state"], "applied")
            self.assertIsNone(self.work()["selection"]["work"])

    def test_existing_identity_immutable_work_and_volume_covers_preserved(self):
        self.slot("manual")
        self.apply()
        art = dict(self.db.execute("SELECT * FROM collection_authority_artworks").fetchone())
        selected = self.work()["selection"]["work"]
        self.pipe.outbound = lambda *a, **k: (b"replacement", "image/jpeg")
        self.apply()
        # selected flag revision is unchanged because no select command is needed.
        self.assertEqual(dict(self.db.execute("SELECT * FROM collection_authority_artworks").fetchone()), art)
        self.assertEqual(self.work()["selection"]["work"], selected)
        row = self.db.execute("SELECT * FROM collection_authority_volumes WHERE volume_id='manual'").fetchone()
        self.assertEqual((row["sort_order"], row["display_label"], row["cover_artwork_id"]), (42, "manual label", selected))
        self.covers = [self.extra_cover("1")]
        self.apply()
        self.assertEqual(self.db.execute("SELECT cover_artwork_id FROM collection_authority_volumes WHERE volume_id='manual'").fetchone()[0], selected)

    def test_editions_duplicates_other_provider_tombstones_moved_ids_and_bounds(self):
        self.slot("other", sourceProvider="kakao")
        self.slot("revive", number=2)
        self.slot("revive", number=2, deleted=True, expectedRevision=1)
        self.covers = [self.extra_cover(n) for n in (1, 2, "3.1", "3.2", "3.3", "3.3", "3.0", 0, "bad")]
        self.assertEqual(self.row(self.apply())["state"], "applied")
        rows = self.db.execute("SELECT * FROM collection_authority_volumes ORDER BY volume_number,edition_index").fetchall()
        self.assertEqual([(r["volume_number"], r["edition_index"]) for r in rows], [(1, 0), (2, 0), (3, 1), (3, 2), (3, 3)])
        self.assertEqual(rows[0]["source_provider"], "kakao")
        self.assertEqual((rows[1]["volume_id"], rows[1]["sort_order"], rows[1]["deleted"]), ("revive", 42, 0))
        moved = str(uuid.uuid5(md.NAMESPACE, "a:4:0:volume"))
        self.slot(moved, number=8)
        self.covers = [self.extra_cover(4)]
        self.assertEqual(self.row(self.apply())["state"], "failed")
        self.covers = [self.extra_cover(1_000_001)]
        self.assertEqual(self.row(self.apply())["reason_code"], "mangadexResponseTooLarge")

    def test_ambiguous_tombstones_and_duplicate_identity_rollback(self):
        for ident in ("old1", "old2"):
            self.slot(ident)
            self.slot(ident, deleted=True, expectedRevision=1)
        self.assertEqual(self.row(self.apply())["state"], "failed")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_bindings").fetchone()[0], 0)
        self.assertEqual(self.row(self.apply(work_id="b"))["state"], "applied")
        self.base.create("c")
        self.assertEqual(self.row(self.apply(work_id="c"))["reason_code"], "providerIdentityTaken")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_artworks WHERE work_id='a'").fetchone()[0], 0)

    def test_late_volume_failure_and_missing_blob_receipt_rollback(self):
        original = self.ca.apply_command_batch
        for scenario in ("late", "receipt"):
            def broken(db, **kwargs):
                if scenario == "late":
                    kwargs["commands"][-1]["expectedRevision"] = 99
                else:
                    db.execute("DELETE FROM mobile_collection_artwork")
                return original(db, **kwargs)
            with mock.patch.object(self.ca, "apply_command_batch", side_effect=broken):
                request = self.apply()
            self.assertEqual(self.row(request)["state"], "failed")
            self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_bindings").fetchone()[0], 0)
            self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_artworks").fetchone()[0], 0)
            self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_receipts WHERE command_type='providerApply'").fetchone()[0], 0)

    def test_binding_snapshot_unbind_aba_epoch_trash_and_supersession_races(self):
        scenarios = ("snapshot", "aba", "unbind", "epoch", "trash", "supersede")
        for scenario in scenarios:
            with self.subTest(scenario):
                if scenario != scenarios[0]:
                    self.doCleanups()
                    self.setUp()
                self.apply()
                request = self.submit()
                def race():
                    self.during_fetch = lambda: None
                    binding = self.ca.binding_row(self.db, LIBRARY, "a", "mangadex")
                    if scenario == "snapshot":
                        self.command("applyProviderSnapshot", workId="a", provider="mangadex", externalId=MANGA,
                            snapshot={}, values={}, details=None, baseSnapshotDigest=binding["snapshot_digest"])
                    elif scenario in ("aba", "unbind"):
                        self.command("unbindProvider", workId="a", provider="mangadex", expectedRevision=binding["entity_revision"])
                        if scenario == "aba":
                            self.command("bindProvider", workId="a", provider="mangadex", externalId=MANGA, config=None, expectedRevision=0)
                    elif scenario == "epoch":
                        self.db.execute("UPDATE authority_domains SET epoch=2")
                        self.db.commit()
                    elif scenario == "trash":
                        self.command("deleteWork", workId="a", expectedRevision=self.work()["entityRevision"])
                    else:
                        self.submit()
                self.during_fetch = race
                self.worker.execute(request["requestId"])
                self.assertIn(self.row(request)["state"], ("failed", "superseded"))

    def test_flags_readiness_retry_restart_and_off_during_stages(self):
        self.assertEqual(kb.features(self.db, "mangadex"), ["serverMangaDexBinds"])
        self.assertEqual(kb.features(self.db), [])
        request = self.submit()
        self.pipe.mangadex_ready = lambda: False
        self.assertNotIn("mangadexApply", self.bindings.capabilities(self.db))
        self.assertEqual(self.submit(operation_id=request["operationId"])["state"], "pending")
        with self.assertRaises(HTTPError) as error:
            self.submit(work_id="b")
        self.assertEqual(error.exception.detail["code"], "mangadexApplyUnavailable")
        self.pipe.mangadex_ready = lambda: True
        self.during_fetch = lambda: (_ for _ in ()).throw(self.bindings.Upstream("status", 429, 900))
        self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request)["next_attempt_at"], self.rc.iso(NOW + __import__("datetime").timedelta(seconds=900)))
        calls = len(self.calls)
        restarted = kb.Worker(self.base.connection, bindings=self.bindings, planner=self.rc, ca=self.ca,
                              now=lambda: NOW, manga=self.manga)
        restarted.run_once()
        self.assertEqual(len(self.calls), calls)
        for stage in ("fetch", "storage", "commit"):
            self.during_fetch = self.during_storage = lambda: None
            os.environ["LAKOMICS_MANGADEX_BINDS"] = "1"
            request = self.submit()
            def off():
                os.environ["LAKOMICS_MANGADEX_BINDS"] = "0"
            if stage == "fetch":
                self.during_fetch = off
            elif stage == "storage":
                self.during_storage = off
            original = self.ca.apply_command_batch
            def commit(*args, **kwargs):
                result = original(*args, **kwargs)
                off()
                return result
            with mock.patch.object(self.ca, "apply_command_batch", side_effect=commit if stage == "commit" else original):
                self.worker.execute(request["requestId"])
            self.assertEqual(self.row(request)["state"], "pending")
            self.assertEqual(self.row(request)["executor"], "server")
            self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_bindings").fetchone()[0], 0)
        os.environ["LAKOMICS_MANGADEX_BINDS"] = "1"
        self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request)["state"], "applied")

    def test_both_off_no_schema_thread_or_io_and_independent_lane(self):
        with mock.patch.dict(os.environ, {kb.ENV: "0", "LAKOMICS_MANGADEX_BINDS": "0"}):
            import sqlite3
            db = sqlite3.connect(":memory:")
            db.executescript(self.bindings.DDL)
            kb.startup_db(db)
            self.assertFalse(kb.has_metadata(db))
            db.close()
            worker = kb.Worker(lambda: (_ for _ in ()).throw(AssertionError("OFF I/O")),
                               bindings=self.bindings, planner=self.rc, ca=self.ca, manga=self.manga)
            worker.start()
            worker.run_once()
            worker.execute(1)
            self.assertIsNone(worker.thread)
        md_request = self.submit()
        os.environ["LAKOMICS_MANGADEX_BINDS"] = "0"
        os.environ[kb.ENV] = "1"
        kakao = self.base.submit(work_id="b")
        self.worker.run_once()
        self.assertEqual(self.row(md_request)["state"], "pending")
        self.assertEqual(self.base.row(kakao["requestId"])["state"], "applied")
        os.environ["LAKOMICS_MANGADEX_BINDS"] = "1"
        self.worker.run_once()
        self.assertEqual(self.row(md_request)["state"], "applied")

    def test_deadline_pixel_decoder_guard_and_safe_storage_retry(self):
        request = self.submit()
        self.during_storage = lambda: (_ for _ in ()).throw(OSError("secret URL"))
        self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request)["state"], "pending")
        self.assertEqual(self.row(request)["retry_count"], 1)
        self.assertIsNone(self.row(request)["reason_message"])
        self.manga.clock = lambda: 100
        with self.assertRaises(self.bindings.Upstream):
            self.manga.check(100, lambda: False)
        pipe = artwork_core(self.ca)
        image = types.SimpleNamespace(size=(4097, 4097), format="JPEG", verify=mock.Mock())
        context = mock.MagicMock()
        context.__enter__.return_value = image
        pil = types.SimpleNamespace(DecompressionBombWarning=RuntimeWarning, open=lambda _: context, MIME={"JPEG": "image/jpeg"})
        with mock.patch.dict("sys.modules", {"PIL": types.SimpleNamespace(Image=pil)}):
            with self.assertRaises(HTTPError):
                pipe.image_dimensions(b"image", "image/jpeg", max_pixels=16 * 1024 * 1024)
        image.verify.assert_not_called()

    def test_size_marked_upstream_is_permanent_but_plain_invalid_stays_invalid(self):
        large = self.bindings.Upstream("invalid")
        large.too_large = True
        self.assertEqual(self.manga.classify(large, self.rc).code, "mangadexResponseTooLarge")
        self.assertEqual(self.manga.classify(self.bindings.Upstream("invalid"), self.rc).code, "invalidMangaDexResponse")


if __name__ == "__main__":
    unittest.main()
