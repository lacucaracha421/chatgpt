"""File exchange module against an isolated FastAPI app, temporary SQLite and a fake R2."""
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from botocore.exceptions import ClientError
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api_auth
import file_exchange as fx

LEGACY = "shared-legacy-token"
HOUR = 3600
T0 = 1_790_000_000.0


class FakeStorage:
    def __init__(self):
        self.objects = {}
        self.deleted = []
        self.fail_delete = False
        self.signed = []

    def head_object(self, *, Bucket, Key):
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "404", "Message": "missing"}}, "HeadObject")
        return {"ContentLength": len(self.objects[Key]), "ContentType": "application/octet-stream"}

    def delete_object(self, *, Bucket, Key):
        if self.fail_delete:
            raise RuntimeError("R2 unavailable")
        self.deleted.append(Key)
        self.objects.pop(Key, None)

    def list_objects_v2(self, *, Bucket, Prefix, MaxKeys, StartAfter=None):
        self.listed_after = getattr(self, "listed_after", []) + [StartAfter]
        keys = sorted(key for key in self.objects if key.startswith(Prefix) and (StartAfter is None or key > StartAfter))
        return {"Contents": [{"Key": key} for key in keys[:MaxKeys]], "IsTruncated": len(keys) > MaxKeys}

    def generate_presigned_url(self, operation, Params, ExpiresIn):
        self.signed.append((operation, Params, ExpiresIn))
        return f"https://r2.example.test/{Params['Key']}?op={operation}&expires={ExpiresIn}"


def new_id():
    return str(uuid.uuid4())


class ExchangeFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        path = Path(self.temp.name) / "control.sqlite"

        @contextmanager
        def get_db():
            db = sqlite3.connect(path, timeout=10)
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        self.get_db = get_db
        self.now = T0
        self.storage = FakeStorage()
        self.puts = []

        def presign_put(key, content_type, expires_in=600, content_length=None):
            self.puts.append((key, content_type, expires_in, content_length))
            return f"https://r2.example.test/{key}?put={len(self.puts)}"

        self.app = FastAPI()
        startup = fx.register(self.app, get_db, api_auth.client_guard(get_db, LEGACY),
                              lambda: self.storage, lambda: "test-bucket", presign_put, clock=lambda: self.now)
        startup()
        self.client = TestClient(self.app)
        self.pc_principal, self.pc_token = self.provision("pc")
        self.tab_principal, self.tab_token = self.provision("tablet")
        self.pc, self.tab = new_id(), new_id()
        self.assertEqual(self.register(self.pc_token, self.pc, "My PC", "pc").status_code, 200)
        self.assertEqual(self.register(self.tab_token, self.tab, "Galaxy Tab S11", "android").status_code, 200)

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def provision(self, label):
        with self.get_db() as db:
            principal, token = api_auth.provision_token(db, "client", label)
            db.commit()
        return principal, token

    @staticmethod
    def auth(token, device=None):
        headers = {"Authorization": f"Bearer {token}"}
        if device:
            headers["X-Lakomics-Device"] = device
        return headers

    def register(self, token, device, name, kind):
        return self.client.put(f"/v1/exchange/devices/{device}", headers=self.auth(token),
                               json={"name": name, "kind": kind})

    def as_pc(self):
        return self.auth(self.pc_token, self.pc)

    def as_tab(self):
        return self.auth(self.tab_token, self.tab)

    def body(self, transfer_id=None, **overrides):
        body = {"transferId": transfer_id or new_id(), "toDevice": self.tab, "fileName": "사진.jpg",
                "sizeBytes": 5, "sha256": "a" * 64, "contentTypeHint": "image/jpeg"}
        body.update(overrides)
        return body

    def create(self, headers=None, **overrides):
        return self.client.post("/v1/exchange/transfers", headers=headers or self.as_pc(),
                                json=self.body(**overrides))

    def send_ready(self, data=b"hello", **overrides):
        created = self.create(sizeBytes=len(data), **overrides)
        self.assertEqual(created.status_code, 200, created.text)
        transfer = created.json()
        self.storage.objects[f"exchange/{transfer['toDevice']}/{transfer['transferId']}"] = data
        done = self.client.post(f"/v1/exchange/transfers/{transfer['transferId']}/complete", headers=self.as_pc())
        self.assertEqual(done.status_code, 200, done.text)
        return done.json()

    def assert_code(self, response, status, code):
        self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(response.json()["detail"]["code"], code)

    def exchange_status(self, principal):
        with self.get_db() as db:
            return fx.status(db, principal)


class AuthTests(ExchangeFixture):
    def test_legacy_shared_token_and_anonymous_callers_are_refused(self):
        legacy = {"Authorization": f"Bearer {LEGACY}", "X-Lakomics-Device": self.tab}
        self.assert_code(self.client.get("/v1/exchange/inbox", headers=legacy), 403, "exchangeDeviceTokenRequired")
        self.assert_code(self.register(LEGACY, new_id(), "x", "pc"), 403, "exchangeDeviceTokenRequired")
        self.assertEqual(self.client.get("/v1/exchange/inbox", headers={"X-Lakomics-Device": self.tab}).status_code,
                         401)
        self.assertIsNone(self.exchange_status(api_auth.LEGACY_CLIENT))

    def test_a_device_is_bound_to_the_credential_that_registered_it(self):
        # The PC token cannot act as, read or rename the tablet.
        self.assert_code(self.client.get("/v1/exchange/inbox", headers=self.auth(self.pc_token, self.tab)),
                         403, "exchangeDeviceForbidden")
        self.assert_code(self.register(self.pc_token, self.tab, "stolen", "pc"), 403, "exchangeDeviceForbidden")
        self.assert_code(self.client.get("/v1/exchange/inbox", headers=self.auth(self.pc_token)),
                         400, "exchangeDeviceRequired")
        self.assert_code(self.client.get("/v1/exchange/inbox", headers=self.auth(self.pc_token, new_id())),
                         404, "exchangeDeviceUnknown")

    def test_a_revoked_credential_hides_its_device_and_a_new_token_may_rebind_it(self):
        transfer = self.send_ready()
        with self.get_db() as db:
            api_auth.revoke_token(db, self.tab_principal)
            db.commit()
        self.assertEqual(self.client.get("/v1/exchange/inbox", headers=self.as_tab()).status_code, 401)
        devices = self.client.get("/v1/exchange/devices", headers=self.as_pc()).json()["devices"]
        self.assertEqual([d["deviceId"] for d in devices], [self.pc])
        self.assert_code(self.create(), 404, "targetDeviceUnknown")
        principal, token = self.provision("tablet-2")
        self.assertEqual(self.register(token, self.tab, "Galaxy Tab S11", "android").status_code, 200)
        # Nothing addressed to the old credential is handed to the new one.
        self.assertEqual(self.client.get("/v1/exchange/inbox", headers=self.auth(token, self.tab)).json()["items"], [])
        row = self.client.get("/v1/exchange/outbox", headers=self.as_pc()).json()["items"][0]
        self.assertEqual((row["transferId"], row["state"]), (transfer["transferId"], "cancelled"))
        self.assertNotIn(f"exchange/{self.tab}/{transfer['transferId']}", self.storage.objects)


class DeviceTests(ExchangeFixture):
    def test_list_marks_self_and_register_is_idempotent_and_sanitised(self):
        before = self.exchange_status(self.pc_principal)["revision"]
        again = self.register(self.pc_token, self.pc, "My PC", "pc")
        self.assertEqual(again.json(), {**again.json(), "deviceId": self.pc, "name": "My PC", "self": True})
        self.assertEqual(self.exchange_status(self.pc_principal)["revision"], before)
        renamed = self.register(self.pc_token, self.pc, "  Desk\u202etop \x07 PC ", "pc")
        self.assertEqual(renamed.json()["name"], "Desktop PC")
        self.assertGreater(self.exchange_status(self.pc_principal)["revision"], before)
        listed = self.client.get("/v1/exchange/devices", headers=self.as_tab())
        self.assertEqual([(d["deviceId"], d["kind"], d["self"]) for d in listed.json()["devices"]],
                         [(self.pc, "pc", False), (self.tab, "android", True)])
        cached = self.client.get("/v1/exchange/devices", headers={**self.as_tab(),
                                                                  "If-None-Match": listed.headers["ETag"]})
        self.assertEqual(cached.status_code, 304)

    def test_unregister_cancels_pending_transfers_and_deletes_objects(self):
        ready = self.send_ready()
        other = self.client.delete(f"/v1/exchange/devices/{self.tab}", headers=self.auth(self.pc_token))
        self.assert_code(other, 404, "exchangeDeviceUnknown")
        gone = self.client.delete(f"/v1/exchange/devices/{self.tab}", headers=self.auth(self.tab_token))
        self.assertEqual(gone.status_code, 200, gone.text)
        self.assertEqual(self.storage.objects, {})
        row = self.client.get("/v1/exchange/outbox", headers=self.as_pc()).json()["items"][0]
        self.assertEqual((row["transferId"], row["state"], row["failure"]),
                         (ready["transferId"], "cancelled", "deviceUnregistered"))
        self.assert_code(self.client.get("/v1/exchange/inbox", headers=self.as_tab()), 404, "exchangeDeviceUnknown")


class TransferTests(ExchangeFixture):
    def test_full_round_trip_from_upload_to_acknowledged_delete(self):
        tab_revision = self.exchange_status(self.tab_principal)["revision"]
        created = self.create(sizeBytes=5)
        self.assertEqual(created.status_code, 200, created.text)
        transfer = created.json()
        key = f"exchange/{self.tab}/{transfer['transferId']}"
        self.assertEqual(transfer["state"], "uploading")
        self.assertEqual(transfer["upload"]["method"], "PUT")
        self.assertEqual(transfer["upload"]["requiredHeaders"], {"Content-Type": "application/octet-stream"})
        self.assertEqual(self.puts[-1], (key, "application/octet-stream", 900, 5))
        self.assertNotIn("object_key", created.text)
        # Uploading is not visible to the receiver and does not move its revision.
        self.assertEqual(self.exchange_status(self.tab_principal)["revision"], tab_revision)
        path = f"/v1/exchange/transfers/{transfer['transferId']}"
        self.assert_code(self.client.post(path + "/complete", headers=self.as_pc()), 409, "uploadMissing")
        self.assert_code(self.client.post(path + "/ticket", headers=self.as_tab()), 409, "transferNotReady")

        self.storage.objects[key] = b"hello"
        ready = self.client.post(path + "/complete", headers=self.as_pc())
        self.assertEqual(ready.json()["state"], "ready")
        self.assertEqual(ready.json()["expiresAt"], fx.iso(T0 + 24 * HOUR))
        self.assertEqual(self.client.post(path + "/complete", headers=self.as_pc()).json(), ready.json())
        self.assertGreater(self.exchange_status(self.tab_principal)["revision"], tab_revision)

        inbox = self.client.get("/v1/exchange/inbox", headers=self.as_tab())
        items = inbox.json()["items"]
        self.assertEqual([(i["transferId"], i["fileName"], i["fromName"]) for i in items],
                         [(transfer["transferId"], "사진.jpg", "My PC")])
        self.assertEqual(inbox.json()["revision"], self.exchange_status(self.tab_principal)["revision"])
        self.assertEqual(self.client.get("/v1/exchange/inbox", headers={
            **self.as_tab(), "If-None-Match": inbox.headers["ETag"]}).status_code, 304)
        self.assertEqual(self.client.get("/v1/exchange/inbox", headers=self.as_pc()).json()["items"], [])

        ticket = self.client.post(path + "/ticket", headers=self.as_tab()).json()
        self.assertEqual((ticket["sizeBytes"], ticket["expiresIn"]), (5, 600))
        operation, params, _ = self.storage.signed[-1]
        self.assertEqual((operation, params["Key"], params["ResponseContentDisposition"]),
                         ("get_object", key, "attachment"))

        self.assert_code(self.client.post(path + "/ack", headers=self.as_tab(), json={"sha256": "b" * 64}),
                         409, "digestMismatch")
        acked = self.client.post(path + "/ack", headers=self.as_tab(), json={"sha256": "a" * 64})
        self.assertEqual(acked.json()["state"], "delivered")
        self.assertNotIn(key, self.storage.objects)
        self.assertEqual(self.client.post(path + "/ack", headers=self.as_tab(),
                                          json={"sha256": "a" * 64}).json(), acked.json())
        self.assert_code(self.client.post(path + "/ticket", headers=self.as_tab()), 410, "transferGone")
        self.assertEqual(self.client.get("/v1/exchange/inbox", headers=self.as_tab()).json()["items"], [])
        outbox = self.client.get("/v1/exchange/outbox", headers=self.as_pc()).json()["items"]
        self.assertEqual([(o["state"], o["toName"]) for o in outbox], [("delivered", "Galaxy Tab S11")])

    def test_inbox_pages_follow_next_cursor_oldest_first(self):
        sent = []
        for step in range(5):
            self.now = T0 + step
            sent.append(self.send_ready()["transferId"])
        self.now = T0 + 10
        with mock.patch.object(fx, "INBOX_LIMIT", 2):
            first = self.client.get("/v1/exchange/inbox", headers=self.as_tab()).json()
            seen, pages, cursor = [i["transferId"] for i in first["items"]], 1, first["nextCursor"]
            while cursor:
                page = self.client.get("/v1/exchange/inbox", params={"after": cursor}, headers=self.as_tab()).json()
                seen += [i["transferId"] for i in page["items"]]
                pages, cursor = pages + 1, page["nextCursor"]
            # A row delivered between pages does not shift the continuation.
            second = self.client.get("/v1/exchange/inbox", params={"after": first["nextCursor"]},
                                     headers=self.as_tab()).json()
            self.client.post(f"/v1/exchange/transfers/{sent[2]}/ack", headers=self.as_tab(), json={"sha256": "a" * 64})
            again = self.client.get("/v1/exchange/inbox", params={"after": first["nextCursor"]},
                                    headers=self.as_tab()).json()
        self.assertEqual((seen, pages), (sent, 3))
        self.assertEqual([i["transferId"] for i in second["items"]], sent[2:4])
        self.assertEqual([i["transferId"] for i in again["items"]], sent[3:5])
        self.assertIsNone(again["nextCursor"])
        # Without `after` an old client still gets the first (oldest) page.
        self.assertIsNone(self.client.get("/v1/exchange/inbox", headers=self.as_tab()).json()["nextCursor"])
        for bad in ("x~2026", "12", "~2026-01-01", "1" * 19 + "~a"):
            self.assert_code(self.client.get("/v1/exchange/inbox", params={"after": bad}, headers=self.as_tab()),
                             422, "invalidCursor")

    def test_create_is_idempotent_on_transfer_id_and_refuses_reuse(self):
        transfer_id = new_id()
        first = self.create(transfer_id=transfer_id).json()
        second = self.create(transfer_id=transfer_id).json()
        self.assertNotEqual(first["upload"]["url"], second["upload"]["url"])
        self.assertEqual({k: v for k, v in first.items() if k != "upload"},
                         {k: v for k, v in second.items() if k != "upload"})
        self.assert_code(self.create(transfer_id=transfer_id, sizeBytes=6), 409, "transferIdReused")
        self.assert_code(self.client.post("/v1/exchange/transfers", headers=self.as_tab(),
                                          json=self.body(transfer_id=transfer_id, toDevice=self.pc)),
                         409, "transferIdReused")

    def test_limits_targets_and_validation(self):
        self.assert_code(self.create(sizeBytes=fx.MAX_FILE_BYTES + 1), 413, "fileTooLarge")
        self.assert_code(self.create(toDevice=self.pc), 422, "cannotSendToSelf")
        self.assert_code(self.create(toDevice=new_id()), 404, "targetDeviceUnknown")
        self.assert_code(self.create(fileName="../.."), 422, "invalidFileName")
        self.assert_code(self.create(sizeBytes="5"), 422, "invalidExchangeRequest")
        self.assert_code(self.create(extra=1), 422, "invalidExchangeRequest")
        self.assert_code(self.create(transferId="NOT-A-UUID"), 422, "invalidExchangeRequest")
        self.assertEqual(self.create(sizeBytes=fx.MAX_FILE_BYTES).status_code, 200)
        self.assertEqual(self.create(sizeBytes=fx.MAX_FILE_BYTES * 4).status_code, 413)
        for _ in range(4):
            self.assertEqual(self.create(sizeBytes=fx.MAX_FILE_BYTES).status_code, 200)
        self.assert_code(self.create(sizeBytes=fx.MAX_FILE_BYTES), 409, "quotaExceeded")
        huge = self.client.post("/v1/exchange/transfers", headers=self.as_pc(),
                                content=b'{"fileName":"' + b"x" * fx.MAX_BODY_BYTES + b'"}')
        self.assert_code(huge, 413, "exchangeRequestTooLarge")

    def test_batch_limit(self):
        batch = new_id()
        with mock.patch.object(fx, "MAX_BATCH_FILES", 2):
            self.assertEqual(self.create(batchId=batch).status_code, 200)
            self.assertEqual(self.create(batchId=batch).status_code, 200)
            self.assert_code(self.create(batchId=batch), 409, "batchTooLarge")
            self.assertEqual(self.create(batchId=new_id()).status_code, 200)

    def test_size_mismatch_fails_the_transfer_and_deletes_the_object(self):
        transfer = self.create(sizeBytes=5).json()
        key = f"exchange/{self.tab}/{transfer['transferId']}"
        self.storage.objects[key] = b"toolong"
        path = f"/v1/exchange/transfers/{transfer['transferId']}/complete"
        self.assert_code(self.client.post(path, headers=self.as_pc()), 409, "sizeMismatch")
        self.assertNotIn(key, self.storage.objects)
        self.assert_code(self.client.post(path, headers=self.as_pc()), 410, "transferGone")
        self.assertIsNone(self.create(transfer_id=transfer["transferId"]).json()["upload"])

    def test_receiver_only_routes_and_withdraw_or_decline(self):
        third_principal, third_token = self.provision("third")
        third = new_id()
        self.register(third_token, third, "Laptop", "pc")
        ready = self.send_ready()
        path = f"/v1/exchange/transfers/{ready['transferId']}"
        self.assert_code(self.client.post(path + "/ticket", headers=self.as_pc()), 404, "transferUnknown")
        self.assert_code(self.client.post(path + "/ticket", headers=self.auth(third_token, third)),
                         404, "transferUnknown")
        self.assert_code(self.client.post(path + "/ack", headers=self.as_pc(), json={"sha256": "a" * 64}),
                         404, "transferUnknown")
        self.assert_code(self.client.delete(path, headers=self.auth(third_token, third)), 404, "transferUnknown")
        declined = self.client.delete(path, headers=self.as_tab()).json()
        self.assertEqual((declined["state"], declined["failure"]), ("cancelled", "declined"))
        self.assertEqual(self.storage.objects, {})
        self.assertEqual(self.client.delete(path, headers=self.as_pc()).json(), declined)
        self.assert_code(self.client.post(path + "/ack", headers=self.as_tab(), json={"sha256": "a" * 64}),
                         410, "transferGone")
        withdrawn = self.create().json()
        body = self.client.delete(f"/v1/exchange/transfers/{withdrawn['transferId']}", headers=self.as_pc()).json()
        self.assertEqual((body["state"], body["failure"]), ("cancelled", "withdrawn"))


class FileNameTests(unittest.TestCase):
    def test_sanitisation(self):
        cases = {
            "photo.jpg": "photo.jpg",
            "../../etc/passwd": "passwd",
            "C:\\Users\\x\\evil.exe": "evil.exe",
            "inv\u202egpj.exe": "invgpj.exe",
            "a\x00b\x1f\x7f\x85c.txt": "abc.txt",
            "  spaced.txt  ": "spaced.txt",
            "e\u0301.txt": "\u00e9.txt",
            "CON.txt": "CON.txt",
        }
        for raw, expected in cases.items():
            self.assertEqual(fx.sanitize_file_name(raw), expected, raw)
        for raw in ("", ".", "..", "dir/", "\u202e", "a/..", "\x01"):
            self.assertIsNone(fx.sanitize_file_name(raw), raw)
        long = fx.sanitize_file_name("가" * 200 + ".jpeg")
        self.assertTrue(long.endswith(".jpeg"))
        self.assertLessEqual(len(long.encode("utf-8")), 255)
        self.assertLessEqual(len(fx.sanitize_file_name("x" * 400).encode("utf-8")), 255)


class SweepTests(ExchangeFixture):
    def sweep(self, **kwargs):
        return fx.sweep(self.get_db, lambda: self.storage, lambda: "test-bucket", now=self.now, **kwargs)

    def state(self, transfer_id):
        with self.get_db() as db:
            row = db.execute("SELECT state FROM exchange_transfers WHERE id=?", [transfer_id]).fetchone()
        return row and row[0]

    def test_expiry_deletes_objects_and_history_is_pruned_after_seven_days(self):
        ready = self.send_ready()
        uploading = self.create().json()
        self.storage.objects[f"exchange/{self.tab}/{uploading['transferId']}"] = b"part"
        self.now = T0 + 2 * HOUR
        revision = self.exchange_status(self.tab_principal)["revision"]
        self.assertEqual(self.sweep()["expired"], 1)
        self.assertEqual((self.state(uploading["transferId"]), self.state(ready["transferId"])),
                         ("expired", "ready"))
        self.assertGreater(self.exchange_status(self.tab_principal)["revision"], revision)
        self.assertEqual(len(self.client.get("/v1/exchange/inbox", headers=self.as_tab()).json()["items"]), 1)
        self.now = T0 + 24 * HOUR
        self.assertEqual(self.client.get("/v1/exchange/inbox", headers=self.as_tab()).json()["items"], [])
        self.assert_code(self.client.post(f"/v1/exchange/transfers/{ready['transferId']}/ticket",
                                          headers=self.as_tab()), 410, "transferGone")
        self.assertEqual(self.sweep()["expired"], 1)
        self.assertEqual(self.storage.objects, {})
        outbox = self.client.get("/v1/exchange/outbox", headers=self.as_pc()).json()["items"]
        self.assertEqual({o["state"] for o in outbox}, {"expired"})
        self.now = T0 + 24 * HOUR + 7 * 24 * HOUR + 1
        self.assertEqual(self.sweep()["rowsPruned"], 2)
        self.assertIsNone(self.state(ready["transferId"]))

    def test_failed_deletes_are_retried_and_rows_kept_until_the_object_is_gone(self):
        ready = self.send_ready()
        self.storage.fail_delete = True
        acked = self.client.post(f"/v1/exchange/transfers/{ready['transferId']}/ack", headers=self.as_tab(),
                                 json={"sha256": "a" * 64})
        self.assertEqual(acked.json()["state"], "delivered")
        self.now = T0 + 8 * 24 * HOUR
        summary = self.sweep()
        self.assertEqual((summary["objectsDeleted"], summary["rowsPruned"]), (0, 0))
        self.assertGreater(summary["errors"], 0)
        self.storage.fail_delete = False
        summary = self.sweep()
        self.assertEqual((summary["objectsDeleted"], summary["rowsPruned"]), (1, 1))

    def test_orphans_are_deleted_only_under_the_exchange_prefix(self):
        live = self.create().json()
        live_key = f"exchange/{self.tab}/{live['transferId']}"
        self.storage.objects[live_key] = b"uploading"
        self.storage.objects[f"exchange/{self.tab}/{new_id()}"] = b"orphan"
        self.storage.objects["library/asset/original"] = b"keep"
        self.assertEqual(self.sweep()["orphansDeleted"], 1)
        self.assertEqual(set(self.storage.objects), {live_key, "library/asset/original"})

    def test_orphan_scan_resumes_where_the_previous_sweep_stopped(self):
        orphans = sorted(f"exchange/{self.tab}/{new_id()}" for _ in range(5))
        for key in orphans:
            self.storage.objects[key] = b"orphan"
        cursor = {"startAfter": None}
        # A failing delete keeps the object, so progress comes from the cursor, not from deletion.
        self.storage.fail_delete = True
        self.sweep(orphan_limit=2, orphan_cursor=cursor)
        self.assertEqual(cursor["startAfter"], orphans[1])
        self.sweep(orphan_limit=2, orphan_cursor=cursor)
        self.assertEqual(cursor["startAfter"], orphans[3])
        self.sweep(orphan_limit=2, orphan_cursor=cursor)
        self.assertIsNone(cursor["startAfter"])  # last page: the next sweep starts over
        self.assertEqual(self.storage.listed_after, [None, orphans[1], orphans[3]])
        self.storage.fail_delete = False
        self.assertEqual(self.sweep(orphan_limit=2, orphan_cursor=cursor)["orphansDeleted"], 2)
        sweeper = fx.ExchangeSweeper(self.get_db, lambda: self.storage, lambda: "test-bucket")
        sweeper.run_once()
        self.assertIsNone(sweeper.orphan_cursor["startAfter"])

    def test_sweeper_switch(self):
        self.assertTrue(fx.sweep_enabled({}))
        self.assertFalse(fx.sweep_enabled({fx.SWEEP_ENV: "0"}))
        with mock.patch.dict("os.environ", {fx.SWEEP_ENV: "false"}):
            sweeper = fx.ExchangeSweeper(self.get_db, lambda: self.storage, lambda: "test-bucket")
            sweeper.start()
            self.assertIsNone(sweeper.thread)
        sweeper = fx.ExchangeSweeper(self.get_db, lambda: self.storage, lambda: "test-bucket")
        self.assertEqual(sweeper.run_once()["expired"], 0)


class PresignTests(unittest.TestCase):
    def test_upload_url_signs_the_declared_content_length(self):
        env = {"R2_ENDPOINT": "https://r2.example.test", "R2_ACCESS_KEY_ID": "id", "R2_SECRET_ACCESS_KEY": "secret"}
        # Load the real module by path: other suites replace `sys.modules["r2"]` with stubs.
        import importlib.util
        spec = importlib.util.spec_from_file_location("r2_presign_under_test", Path(__file__).resolve().parents[1] / "r2.py")
        r2 = importlib.util.module_from_spec(spec)
        with mock.patch.dict("os.environ", env):
            spec.loader.exec_module(r2)
        with mock.patch.object(r2.head_cache.ticket_heads, "invalidate"):
            bound = r2.presign_put("exchange/a/b", "application/octet-stream", 900, content_length=1234)
            plain = r2.presign_put("exchange/a/b", "application/octet-stream", 900)
        self.assertIn("X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost", bound)
        self.assertIn("X-Amz-SignedHeaders=content-type%3Bhost", plain)


if __name__ == "__main__":
    unittest.main()
