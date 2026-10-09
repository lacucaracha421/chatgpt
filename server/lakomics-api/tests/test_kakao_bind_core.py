"""Standard-library fixtures: real planner/storage/authority bodies, fake transport.

Like the wishlist plain-Python fixtures, AST loading avoids unavailable HTTP/model
packages. Only mobile projection model validation is replaced by an identity adapter;
HTTP/Pydantic validation and lifecycle integration must run on the server stage.
"""
import ast
import contextlib
import datetime
import hashlib
import json
import math
import os
import re
import sqlite3
import threading
import time
import types
import unittest
import uuid
from collections import OrderedDict, deque
from functools import cmp_to_key
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qsl, urlsplit

import asset_visibility
import av_contract
import kakao_bind_worker as kb

ROOT = Path(__file__).resolve().parents[1]
LIBRARY = "e" * 32
NOW = datetime.datetime(2026, 10, 10, tzinfo=datetime.timezone.utc)


class HTTPError(Exception):
    def __init__(self, status_code, detail=None, headers=None):
        self.status_code, self.detail, self.headers = status_code, detail, headers


def load_core(name, namespace, select=lambda node: True):
    """Execute unchanged definitions, omitting imports and unrelated HTTP models."""
    tree = ast.parse((ROOT / (name + ".py")).read_text(encoding="utf-8"))
    module = types.ModuleType("fixture_" + name)
    module.__dict__.update(namespace)
    nodes = [node for node in tree.body if not isinstance(node, (ast.Import, ast.ImportFrom)) and select(node)]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(ROOT / (name + ".py")), "exec"), module.__dict__)
    return module


def cores():
    standard = dict(json=json, hashlib=hashlib, re=re, os=os, sqlite3=sqlite3, threading=threading,
                    time=time, uuid=uuid, UUID=uuid.UUID, uuid4=uuid.uuid4, math=math,
                    HTTPException=HTTPError, cmp_to_key=cmp_to_key, OrderedDict=OrderedDict, deque=deque,
                    parse_qsl=parse_qsl, urlsplit=urlsplit, kakao_bind_worker=kb)
    authority = load_core("authority", standard)
    ca = load_core("collection_authority", {**standard, "datetime": datetime,
                   "authority": authority, "asset_visibility": asset_visibility, "av_contract": av_contract})
    def binding_select(node):
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            return node.name not in {"Strict", "MangaDexChoice", "KakaoGroup", "KakaoChoice", "Expected",
                                     "BindCommand", "Reason", "BindResult"}
        if isinstance(node, ast.Assign):
            return not any(isinstance(t, ast.Name) and t.id in {"CollectionId", "OperationId", "Display", "Url"}
                           for t in node.targets)
        return True
    bindings = load_core("collection_bindings", {**standard, "datetime": datetime.datetime,
                        "timedelta": datetime.timedelta, "timezone": datetime.timezone,
                        "collection_authority": ca}, binding_select)
    route_line = next(n.lineno for n in ast.parse((ROOT / "collection_release_checks.py").read_text(encoding="utf-8")).body
                      if isinstance(n, ast.ClassDef) and n.name == "RunRequest")
    rc = load_core("collection_release_checks", {**standard, "datetime": datetime.datetime,
                   "timedelta": datetime.timedelta, "timezone": datetime.timezone, "bindings": bindings,
                   "authority": authority, "ca": ca}, lambda node: getattr(node, "lineno", 0) < route_line)
    return ca, bindings, rc


class ModelAdapter:
    @staticmethod
    def model_validate(value):
        return types.SimpleNamespace(model_dump=lambda: value)


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.ca, self.bindings, self.rc = cores()
        self.environment = mock.patch.dict(os.environ, {kb.ENV: "1", "LAKOMICS_KAKAO_REST_KEY": "fixture"})
        self.environment.start()
        mobile = types.SimpleNamespace(Collection=ModelAdapter, CollectionVolumeRange=ModelAdapter,
                                       stored=lambda value: value.model_dump())
        self.modules = mock.patch.dict("sys.modules", {"mobile_collections": mobile})
        self.modules.start()
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(self.ca.authority.AUTHORITY_DDL)
        self.ca.startup_db(self.db)
        self.bindings.startup_db(self.db)
        kb.startup_db(self.db)
        self.db.execute("INSERT INTO authority_domains VALUES(?, 'collections',1,1,0,'baseline',NULL,?)",
                        (LIBRARY, self.rc.iso(NOW)))
        self.db.execute("CREATE TABLE collection_release_events(event_id TEXT PRIMARY KEY,collection_id TEXT,"
                        "provider TEXT,kind TEXT,volume_number INTEGER,previous_value TEXT,current_value TEXT,detected_at TEXT)")
        self.db.commit()
        self.create("a")
        self.create("b")
        self.items = self.products()
        self.calls = 0
        self.during_fetch = lambda: None
        self.bindings.kakao_key = lambda: "fixture"
        self.bindings.search_kakao_items = self.fetch
        self.worker = kb.Worker(self.connection, bindings=self.bindings, planner=self.rc, ca=self.ca, now=lambda: NOW)
        self.worker.thread = types.SimpleNamespace(is_alive=lambda: True)
        self.previous_worker = kb._current
        kb._current = self.worker

    def tearDown(self):
        kb._current = self.previous_worker
        self.db.close()
        self.modules.stop()
        self.environment.stop()

    @contextlib.contextmanager
    def connection(self):
        try:
            yield self.db
        except BaseException:
            self.db.rollback()
            raise

    def create(self, work_id):
        self.command("createWork", workId=work_id, type="manga", legacyKind="manga", name=work_id,
                     fields={}, binding=None)

    def command(self, kind, **fields):
        command = dict(libraryId=LIBRARY, epoch=1, contractVersion=1, operationId=str(uuid.uuid4()),
                       commandType=kind, **fields)
        lib, epoch, version, op, kind, entity = self.ca.parse_command(command)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            result = self.ca.apply_command(self.db, library_id=lib, epoch=epoch, contract_version=version,
                                          command_type=kind, operation_id=op, entity=entity, now=self.rc.iso(NOW))
            self.db.commit()
            return result
        except BaseException:
            self.db.rollback()
            raise

    def products(self, name="던전밥", numbers=(1, 2), publisher="출판사"):
        return [{"itemId": f"{name}:{publisher}:{n}", "title": f"{name} {n}", "baseTitle": name,
                 "volumeNumber": n, "author": "작가", "publisher": publisher, "isbn13": None,
                 "publicationDate": "2026-10-01", "thumbnail": None, "itemUrl": "https://example.invalid/book",
                 "raw": {"id": f"{name}:{n}"}} for n in numbers]

    def choice(self, items=None):
        candidates = self.bindings.group_kakao(self.items if items is None else items)
        return {"query": "던전밥", "title": "untrusted hint", "groups": [
            {"anchorItemId": c["anchorItemId"], "groupFingerprint": c["groupFingerprint"]} for c in candidates]}

    def submit(self, *, choice=None, work_id="a", operation_id=None, expected=None, provider="kakao", digest="digest"):
        with self.connection() as db:
            return self.bindings.store_request(db, operation_id=operation_id or str(uuid.uuid4()), collection_id=work_id,
                     provider=provider, choice_json=json.dumps(choice or self.choice()),
                     expected_json=None if expected is None else json.dumps(expected), digest=digest)["request"]

    def row(self, sequence):
        return self.db.execute("SELECT * FROM collection_binding_requests WHERE sequence=?", (sequence,)).fetchone()

    def fetch(self, key, query, **kwargs):
        self.assertFalse(self.db.in_transaction, "provider I/O must have no database transaction")
        self.calls += 1
        self.during_fetch()
        return self.items, 0

    def test_new_bind_atomic_quiet_baseline_and_replay_restart(self):
        request = self.submit(expected={"externalId": None})
        self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request["requestId"])["state"], "applied")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_volumes").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_release_events").fetchone()[0], 0)
        payload = json.loads(self.db.execute("SELECT payload FROM collection_authority_projection WHERE id='a'").fetchone()[0])
        self.assertEqual(len(payload["volumes"]), 2)
        before = list(self.db.iterdump())
        replay = self.submit(operation_id=request["operationId"])
        self.assertEqual(replay["state"], "applied")
        restarted = kb.Worker(self.connection, bindings=self.bindings, planner=self.rc, ca=self.ca)
        restarted.execute(request["requestId"])
        self.assertEqual(self.calls, 1)
        self.assertEqual(list(self.db.iterdump()), before)
        with self.assertRaises(HTTPError) as refused:
            self.submit(operation_id=request["operationId"], digest="changed")
        self.assertEqual(refused.exception.detail["code"], "operationConflict")

    def test_off_no_schema_thread_provider_writes_or_advertisement(self):
        with mock.patch.dict(os.environ, {kb.ENV: "0"}):
            fresh = sqlite3.connect(":memory:")
            self.bindings.startup_db(fresh)
            before = list(fresh.iterdump())
            kb.startup_db(fresh)
            self.assertFalse(kb.has_metadata(fresh))
            self.assertEqual(list(fresh.iterdump()), before)
            fresh.close()
            worker = kb.Worker(self.connection, bindings=self.bindings, planner=self.rc, ca=self.ca)
            worker.start()
            self.assertIsNone(worker.thread)
            request = self.submit()
            before = list(self.db.iterdump())
            self.worker.execute(request["requestId"])
            self.assertEqual(list(self.db.iterdump()), before)
            self.assertNotIn("executor", request)
            self.assertNotIn("kakaoApply", self.bindings.capabilities(self.db))
            self.assertEqual(kb.features(self.db), [])
            self.assertEqual(self.calls, 0)

    def test_readiness_and_expected_fence(self):
        self.assertEqual(kb.features(self.db), [kb.FEATURE])
        self.assertTrue(self.bindings.capabilities(self.db)["kakaoApply"])
        for missing in ("key", "worker", "authority"):
            with self.subTest(missing):
                with mock.patch.object(self.bindings, "kakao_key", return_value=None if missing == "key" else "fixture"), \
                     mock.patch.object(self.worker, "alive", return_value=missing != "worker"), \
                     mock.patch.object(self.worker, "domain", return_value=None if missing == "authority" else
                                       self.ca.authority.active_domain(self.db, "collections")):
                    self.assertEqual(kb.features(self.db), [])
                    with self.assertRaises(HTTPError) as error:
                        self.submit()
                    self.assertEqual(error.exception.status_code, 503)
        with self.assertRaises(HTTPError) as error:
            self.submit(expected={"externalId": "different"})
        self.assertEqual(error.exception.detail["code"], "bindingChanged")

    def test_mangadex_and_existing_pc_rows_are_not_seized(self):
        with mock.patch.dict(os.environ, {kb.ENV: "0"}):
            pc = self.submit()
        md = self.submit(provider="mangadex")
        self.worker.execute(pc["requestId"])
        self.worker.execute(md["requestId"])
        self.assertEqual(self.calls, 0)
        self.assertEqual(self.row(pc["requestId"])["executor"], "pc")
        self.assertEqual(self.row(md["requestId"])["executor"], "pc")

    def test_fetch_races_roll_back_without_reconnecting(self):
        for race in ("epoch", "trash", "unbind", "supersede", "snapshot", "aba"):
            with self.subTest(race):
                # Reset per scenario with independent fresh fixtures.
                if race != "epoch":
                    self.tearDown()
                    self.setUp()
                request = self.submit()
                def change():
                    if race == "epoch":
                        self.db.execute("UPDATE authority_domains SET epoch=2")
                        self.db.commit()
                    elif race == "trash":
                        self.command("deleteWork", workId="a", expectedRevision=self.ca.work_row(self.db, LIBRARY, "a")["entity_revision"])
                    elif race == "unbind":
                        self.command("unbindProvider", workId="a", provider="kakao", expectedRevision=0)
                    elif race == "supersede":
                        self.submit()
                    else:
                        self.command("bindProvider", workId="a", provider="kakao", externalId="same", config={}, expectedRevision=0)
                        if race == "snapshot":
                            self.command("applyProviderSnapshot", workId="a", provider="kakao", externalId="same",
                                         snapshot={}, values={}, details=None, baseSnapshotDigest=None)
                        else:
                            self.command("unbindProvider", workId="a", provider="kakao", expectedRevision=1)
                            self.command("bindProvider", workId="a", provider="kakao", externalId="same", config={}, expectedRevision=0)
                self.during_fetch = change
                self.worker.execute(request["requestId"])
                self.assertIn(self.row(request["requestId"])["state"], ("failed", "superseded"))
                self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_volume_sources").fetchone()[0], 0)

    def test_retry_after_restart_credentials_contention_and_stop(self):
        request = self.submit()
        self.during_fetch = lambda: (_ for _ in ()).throw(self.bindings.Upstream("status", 429, 900))
        self.worker.run_once()
        row = self.row(request["requestId"])
        self.assertEqual(row["state"], "pending")
        self.assertEqual(row["retry_count"], 1)
        self.assertEqual(row["next_attempt_at"], self.rc.iso(NOW + datetime.timedelta(seconds=900)))
        restarted = kb.Worker(self.connection, bindings=self.bindings, planner=self.rc, ca=self.ca, now=lambda: NOW)
        restarted.run_once()
        self.assertEqual(self.calls, 1)
        self.worker.remember(request["requestId"], sqlite3.OperationalError("database is locked"))
        self.assertEqual(self.row(request["requestId"])["state"], "pending")
        with mock.patch.object(self.bindings, "kakao_key", return_value=None):
            self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request["requestId"])["next_attempt_at"], self.rc.iso(NOW + datetime.timedelta(hours=1)))
        self.during_fetch = self.worker.drain
        self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request["requestId"])["state"], "pending")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_volumes").fetchone()[0], 0)

    def test_permanent_failure_reason_is_safe_and_public(self):
        request = self.submit()
        self.items = []
        self.worker.execute(request["requestId"])
        public = self.bindings._request(self.row(request["requestId"]))
        self.assertEqual(public["state"], "failed")
        self.assertEqual(public["reason"]["code"], "ambiguousBinding")
        self.assertIn("다시 선택", public["reason"]["message"])
        self.assertNotIn("untrusted hint", public["reason"]["message"])

    def test_rebind_keeps_old_products_and_tombstoned_manual_slots(self):
        self.command("upsertVolume", workId="a", volumeId="manual", volumeNumber=1, editionIndex=0,
                     sortOrder=42, displayLabel="manual", coverArtworkId=None, sourceProvider=None,
                     sourceCoverId=None, deleted=False, expectedRevision=0)
        self.command("upsertVolume", workId="a", volumeId="deleted", volumeNumber=2, editionIndex=0,
                     sortOrder=99, displayLabel="deleted", coverArtworkId=None, sourceProvider=None,
                     sourceCoverId=None, deleted=False, expectedRevision=0)
        self.command("upsertVolume", workId="a", volumeId="deleted", volumeNumber=2, editionIndex=0,
                     sortOrder=99, displayLabel="deleted", coverArtworkId=None, sourceProvider=None,
                     sourceCoverId=None, deleted=True, expectedRevision=1)
        original = dict(self.db.execute("SELECT * FROM collection_authority_volumes WHERE volume_id='manual'").fetchone())
        request = self.submit()
        self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request["requestId"])["state"], "applied")
        self.assertEqual(original, dict(self.db.execute("SELECT * FROM collection_authority_volumes WHERE volume_id='manual'").fetchone()))
        revived = self.db.execute("SELECT * FROM collection_authority_volumes WHERE volume_id='deleted'").fetchone()
        self.assertEqual((revived["deleted"], revived["entity_revision"], revived["sort_order"], revived["display_label"]),
                         (0, 3, 99, "deleted"))
        self.items = self.products(name="다른 만화", numbers=(3,))
        request = self.submit()
        self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request["requestId"])["state"], "applied")
        self.assertEqual([row[0] for row in self.db.execute("SELECT volume_number FROM collection_authority_volume_sources ORDER BY volume_number")], [1, 2, 3])

    def test_duplicate_provider_identity_rolls_back_entire_batch(self):
        first = self.submit(work_id="b")
        self.worker.execute(first["requestId"])
        request = self.submit()
        before = self.db.execute("SELECT COUNT(*) FROM collection_authority_receipts").fetchone()[0]
        self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request["requestId"])["state"], "failed")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_volume_sources WHERE work_id='a'").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_receipts").fetchone()[0], before)

    def route(self, name):
        tree = ast.parse((ROOT / "collection_bindings.py").read_text(encoding="utf-8"))
        register = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "register")
        node = next(node for node in register.body if isinstance(node, ast.FunctionDef) and node.name == name)
        node.decorator_list = []
        namespace = dict(self.bindings.__dict__, get_db=self.connection, require_client=lambda _: None,
                         require_publisher=lambda _: None, Header=lambda **_: None, Request=object,
                         invalid_request=lambda *_: self.bindings.fail(422, "invalidBindRequest", "invalid"),
                         invalid_result=lambda: self.bindings.fail(422, "invalidBindResult", "invalid"),
                         conditional=types.SimpleNamespace(json_response=lambda payload, _: payload))
        exec(compile(ast.Module(body=[node], type_ignores=[]), "binding_route_fixture", "exec"), namespace)
        return namespace[name]

    def test_publisher_scan_gaps_oldest_and_result_fences_survive_off(self):
        first = self.submit()
        with mock.patch.dict(os.environ, {kb.ENV: "0"}):
            pc = self.submit(provider="mangadex")
        last = self.submit(work_id="b")
        log = self.route("log")
        for off in (False, True):
            with self.subTest(off), mock.patch.dict(os.environ, {kb.ENV: "0" if off else "1"}):
                page = log(types.SimpleNamespace(query_params={"after": "0", "limit": "1"}))
                self.assertEqual(page["items"], [])
                self.assertEqual(page["nextCursor"], first["requestId"])
                self.assertTrue(page["hasMore"])
                self.assertEqual(page["oldestPendingSequence"], pc["requestId"])
                self.assertEqual(self.bindings.status_head(self.db)["oldestPending"], pc["requestId"])
                page = log(types.SimpleNamespace(query_params={"after": str(first["requestId"]), "limit": "1"}))
                self.assertEqual([item["requestId"] for item in page["items"]], [pc["requestId"]])
                page = log(types.SimpleNamespace(query_params={"after": str(pc["requestId"]), "limit": "1"}))
                self.assertEqual(page["items"], [])
                self.assertEqual(page["nextCursor"], last["requestId"])
                self.assertFalse(page["hasMore"])
                report = self.route("report")
                with self.assertRaises(HTTPError) as error:
                    report(first["requestId"], types.SimpleNamespace(state="applied", reason=None))
                self.assertEqual(error.exception.detail["code"], "bindExecutorMismatch")
        report(pc["requestId"], types.SimpleNamespace(state="applied", reason=None))
        self.assertIsNone(self.bindings.status_head(self.db)["oldestPending"])

    def test_review_only_change_merges_commit_time_dismissal(self):
        initial = self.submit()
        self.worker.execute(initial["requestId"])
        request = self.submit()
        self.during_fetch = lambda: self.command("setKakaoPartialDismissed", workId="a", dismissed=True, expectedVolumes=[1, 2])
        self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request["requestId"])["state"], "applied")
        binding = self.ca.binding_row(self.db, LIBRARY, "a", "kakao")
        self.assertEqual(json.loads(binding["config"])["reviewDismissedVolumes"], [1, 2])

    def test_receipt_and_applied_status_roll_back_on_commit_failure(self):
        request = self.submit()
        original = self.ca.apply_command_batch
        def crash(*args, **kwargs):
            original(*args, **kwargs)
            raise sqlite3.OperationalError("fixture crash before commit")
        with mock.patch.object(self.ca, "apply_command_batch", side_effect=crash):
            self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request["requestId"])["state"], "pending")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_volumes").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_receipts WHERE command_type='providerApply'").fetchone()[0], 0)
        self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request["requestId"])["state"], "applied")

    def test_legacy_choice_unnumbered_and_retention(self):
        candidate = self.choice()["groups"][0]
        legacy = self.bindings._kakao_groups_form({"query": "던전밥", "title": "hint", **candidate})
        self.assertEqual(self.plan(legacy)["config"]["version"], 1)
        self.items = self.products(numbers=(0,))
        self.assertEqual(self.plan(self.choice())["newSlots"], [1])
        request = self.submit()
        self.worker.execute(request["requestId"])
        pending = self.submit(work_id="b")
        self.db.execute("UPDATE collection_binding_requests SET updated_at='2000-01-01T00:00:00Z'")
        self.bindings._retain(self.db, NOW)
        self.db.commit()
        self.assertIsNone(self.row(request["requestId"]))
        self.assertIsNotNone(self.row(pending["requestId"]))

    def test_product_parser_and_ambiguous_fingerprint(self):
        raw = {"title": "던전밥 1", "authors": ["작가"], "publisher": "출판사",
               "isbn": "1234567890 9781234567890", "datetime": "2026-10-10T00:00:00+09:00",
               "url": "https://search.daum.net/search?w=bookpage&bookId=123", "thumbnail": "https://example.invalid/hint"}
        item = self.bindings.kakao_item(raw)
        self.assertEqual(item["itemId"], "isbn13:9781234567890")
        self.assertEqual(item["publicationDate"], "2026-10-10")
        self.assertEqual(item["itemUrl"], "https://search.daum.net/search?w=bookpage&bookId=123")
        self.assertIs(item["raw"], raw)
        choice = self.choice()
        choice["groups"][0]["anchorItemId"] = "absent"
        group = self.bindings.grouped_kakao(self.items)[0]
        with mock.patch.object(self.bindings, "grouped_kakao", return_value=[group, group]):
            with self.assertRaises(self.rc.Ambiguous):
                self.plan(choice)
        choice["groups"][0]["groupFingerprint"] = "absent"
        with self.assertRaises(self.rc.Ambiguous):
            self.plan(choice)

    def test_off_then_on_resumes_pinned_requests(self):
        request = self.submit()
        before = list(self.db.iterdump())
        with mock.patch.dict(os.environ, {kb.ENV: "0"}):
            self.worker.run_once()
            self.assertEqual(list(self.db.iterdump()), before)
        self.worker.run_once()
        self.assertEqual(self.row(request["requestId"])["state"], "applied")
        self.assertEqual(self.calls, 1)

    def test_tombstoned_binding_is_captured_and_can_be_rebound(self):
        first = self.submit()
        self.worker.execute(first["requestId"])
        binding = self.ca.binding_row(self.db, LIBRARY, "a", "kakao")
        self.command("unbindProvider", workId="a", provider="kakao", expectedRevision=binding["entity_revision"])
        tombstone = self.ca.binding_row(self.db, LIBRARY, "a", "kakao")
        request = self.submit(expected={"externalId": None})
        captured = json.loads(self.row(request["requestId"])["binding_precondition"])
        self.assertEqual(captured["revision"], tombstone["entity_revision"])
        self.assertFalse(captured["bound"])
        self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request["requestId"])["state"], "applied")

    def test_ambiguous_deleted_slot_identities_fail_without_partial_writes(self):
        for ident in ("old-one", "old-two"):
            self.command("upsertVolume", workId="a", volumeId=ident, volumeNumber=1, editionIndex=0,
                         sortOrder=1, displayLabel="manual", coverArtworkId=None, sourceProvider=None,
                         sourceCoverId=None, deleted=False, expectedRevision=0)
            self.command("upsertVolume", workId="a", volumeId=ident, volumeNumber=1, editionIndex=0,
                         sortOrder=1, displayLabel="manual", coverArtworkId=None, sourceProvider=None,
                         sourceCoverId=None, deleted=True, expectedRevision=1)
        request = self.submit()
        self.worker.execute(request["requestId"])
        public = self.bindings._request(self.row(request["requestId"]))
        self.assertEqual(public["reason"]["code"], "volumeConflict")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_volume_sources").fetchone()[0], 0)

    def test_shared_refresh_fixture_parity_and_delayed_selection(self):
        fixture = json.loads((ROOT.parents[1] / "_tools/app/src-tauri/src/library/fixtures/kakao_refresh.json").read_text(encoding="utf-8"))
        for case in fixture["cases"]:
            with self.subTest(case["name"]):
                items = []
                for p in case["products"]:
                    number, base = self.bindings.classify_product(p["title"])
                    items.append(dict(itemId=p["id"], title=p["title"], author=p["author"], publisher=p["publisher"],
                        isbn13=p["isbn13"], publicationDate=p["date"], itemUrl=p["url"], raw=p.get("raw", {"id": p["id"]}),
                        volumeNumber=number, baseTitle=base, thumbnail=None))
                existing = {row["volume"]: dict(volumeNumber=row["volume"], providerItemId=row["providerItemId"],
                    title=row["title"], author=row["author"], publisher=row["publisher"], isbn13=row["isbn13"],
                    publicationDate=row["publicationDate"], itemUrl=row["itemUrl"], data=row.get("data", {"id": row["providerItemId"]}))
                    for row in case["existingSources"]}
                call = dict(stored_config=case["binding"]["config"], external_id=case["binding"]["externalId"], items=items,
                    checked_at=case["checkedAt"], existing_sources=existing, existing_slots=set(case["existingSlots"]),
                    gating=case["gating"], previous_checked_at=case["previousCheckedAt"])
                expected = case["expected"]
                if expected["error"]:
                    with self.assertRaises(self.rc.Ambiguous):
                        self.rc.plan_refresh(**call)
                    continue
                plan = self.rc.plan_refresh(**call)
                for key in ("config", "externalId", "snapshot", "newSlots", "events", "result"):
                    self.assertEqual(plan[key], expected[key])
                self.assertEqual(plan["sources"], [{**row, "data": row.get("data", {"id": row["providerItemId"]})} for row in expected["sources"]])
        # Anchor wins even when the fingerprint drifts; missing anchor falls back.
        choice = self.choice()
        choice["groups"][0]["groupFingerprint"] = "old fingerprint"
        self.assertEqual(self.plan(choice)["newSlots"], [1, 2])
        choice = self.choice()
        choice["groups"][0]["anchorItemId"] = "disappeared"
        plan = self.plan(choice)
        self.assertEqual(plan["externalId"], self.choice()["groups"][0]["anchorItemId"])
        self.assertIn("disappeared", plan["config"]["knownItemIds"])
        choice["groups"].append(self.choice()["groups"][0])
        self.assertEqual(self.plan(choice)["config"]["version"], 1)
        self.items += self.products(publisher="다른 출판사")
        self.assertEqual(self.plan(self.choice())["config"]["version"], 2)
        self.assertEqual(self.plan(self.choice())["events"], [])

    def plan(self, choice):
        return self.rc.plan_bind(choice=choice, items=self.items, checked_at=self.rc.iso(NOW), stored_config=None,
                                 existing_sources={}, existing_slots=set())


if __name__ == "__main__":
    unittest.main()
