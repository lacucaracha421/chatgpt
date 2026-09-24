"""Classification authority 2A: inactive substrate, commands, baseline and replay.

These tests pin the properties ADR-0037 requires before Classification can become the
next server-authoritative domain, and they pin the properties this batch must *not*
change. The recurring hazards are:

* an inactive domain altering legacy publication, replication or read behavior;
* assignment being modelled as Album-style N-valued membership rather than the
  single-valued ``asset -> classification | null`` relation the product actually has;
* a delete that silently drops assignments instead of reassigning them to the parent;
* a stale structural or assignment edit winning by arrival order;
* "absent from a delta" being read as a deletion;
* a baseline that stops being recoverable once the domain grows, or that omits the
  unassigned/tombstone revision a client needs to compose its next command;
* a protected ``originals`` node being renamed, moved or deleted.

This batch ships no activation route, so the fixture activates the epoch by writing
the authority row directly — the same way ``test_sync_authority`` writes rows — and
every inactive-domain test asserts against the *legacy* tables instead.
"""
import datetime
import json
import sqlite3
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api_auth
import authority
import classification_authority
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

LIBRARY = "a" * 32
OTHER_LIBRARY = "b" * 32
BASELINE = "/v1/classifications/authority/baseline"
CHANGES = "/v1/classifications/authority/changes"
COMMANDS = "/v1/classifications/authority/commands"

R1 = "11111111-1111-4111-8111-111111111111"
R2 = "22222222-2222-4222-8222-222222222222"
R3 = "33333333-3333-4333-8333-333333333333"
R4 = "44444444-4444-4444-8444-444444444444"
R5 = "55555555-5555-4555-8555-555555555555"
R6 = "66666666-6666-4666-8666-666666666666"
R7 = "77777777-7777-4777-8777-777777777777"
R8 = "88888888-8888-4888-8888-888888888888"

ROOT = "10000000-0000-4000-8000-000000000001"
WORK = "10000000-0000-4000-8000-000000000002"
TAG = "10000000-0000-4000-8000-000000000003"
OTHER = "10000000-0000-4000-8000-000000000004"
ORIGINALS = "lakomics-originals"

ASSET = "20000000-0000-4000-8000-000000000001"
ASSET2 = "20000000-0000-4000-8000-000000000002"
ASSET3 = "20000000-0000-4000-8000-000000000003"


def activate_asset_lifecycle(get_db, library_id, lifecycles):
    """Activate the Asset lifecycle domain with the given canonical states (link rule)."""
    import asset_authority
    asset_authority.startup(get_db)
    with get_db() as db:
        db.execute("INSERT INTO authority_domains(library_id,domain,epoch,contract_version,"
                   "change_cursor,baseline_digest,baseline_revision,activated_at)"
                   " VALUES(?,'assets',1,1,0,?,NULL,'2026-09-24T00:00:00Z')",
                   [library_id, "0" * 64])
        for asset_id, state in lifecycles.items():
            db.execute("INSERT INTO asset_authority_state(library_id,asset_id,lifecycle,"
                       "entity_revision,created_at,updated_at) VALUES(?,?,?,1,?,?)",
                       [library_id, asset_id, state, "2026-09-24T00:00:00Z",
                        "2026-09-24T00:00:00Z"])
        db.commit()


class ClassificationAuthorityFixture(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "control.sqlite"

        @contextmanager
        def get_db():
            db = sqlite3.connect(self.database, timeout=10)
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        self.get_db = get_db
        authority.startup(get_db)
        api_auth.startup(get_db)
        classification_authority.startup(get_db)
        with get_db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,"
                       " committed INTEGER NOT NULL DEFAULT 1)")
            # The legacy tables this batch must leave alone.
            db.execute("CREATE TABLE IF NOT EXISTS classification_snapshots("
                       " singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL,"
                       " published_at TEXT NOT NULL, updated_at TEXT NOT NULL,"
                       " revision INTEGER NOT NULL DEFAULT 1)")
            db.execute("CREATE TABLE IF NOT EXISTS asset_classifications("
                       " asset_id TEXT NOT NULL, classification_id TEXT NOT NULL,"
                       " added_at TEXT NOT NULL, PRIMARY KEY(asset_id,classification_id))")
            db.executemany("INSERT OR IGNORE INTO assets(id,committed) VALUES(?,1)",
                           [(ASSET,), (ASSET2,), (ASSET3,)])
            _, self.client_token = api_auth.provision_token(db, "client", "classifications")
            _, self.publisher_token = api_auth.provision_token(db, "publisher", "classifications")
            db.commit()
        self.app = FastAPI()
        classification_authority.register_classification_authority(
            self.app, get_db, api_auth.client_guard(get_db, "shared"),
            api_auth.publisher_guard(get_db))
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    @property
    def auth(self):
        return {"Authorization": f"Bearer {self.client_token}"}

    @property
    def publisher_auth(self):
        """Structural commands are publisher-only, so they need their own credential."""
        return {"Authorization": f"Bearer {self.publisher_token}"}

    # -- activation (written directly: this batch ships no activation route) ------

    def activate(self, library_id=LIBRARY, epoch=1, contract_version=1, cursor=0,
                 classifications=None, roles=None, assignments=None):
        """Create the authority epoch and its canonical state.

        There is no activation route in 2A, so the epoch row is written the way
        ``test_sync_authority`` writes authority rows. The structural fixture is the
        shape a staged baseline is later required to produce: a root, a work under it,
        a tag under the work, an unrelated root, and the protected originals root.
        """
        if classifications is None:
            classifications = [
                {"id": ROOT, "kind": "root", "name": "게임", "parentId": None,
                 "iconKey": "folder", "colorKey": "blue"},
                {"id": WORK, "kind": "work", "name": "블루 아카이브", "parentId": ROOT,
                 "iconKey": None, "colorKey": None},
                {"id": TAG, "kind": "tag", "name": "아로나", "parentId": WORK,
                 "iconKey": None, "colorKey": None},
                {"id": OTHER, "kind": "root", "name": "만화", "parentId": None,
                 "iconKey": None, "colorKey": None},
                {"id": ORIGINALS, "kind": "root", "name": "오리지널", "parentId": None,
                 "iconKey": "sparkles", "colorKey": None},
            ]
        if roles is None:
            roles = [{"role": "originals", "classificationId": ORIGINALS}]
        if assignments is None:
            assignments = []
        with self.get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            now = "2026-09-16T00:00:00Z"
            for entry in classifications:
                db.execute(
                    "INSERT INTO classification_authority_state(library_id,classification_id,"
                    "kind,name,parent_id,icon_key,color_key,deleted,entity_revision,created_at,"
                    "updated_at) VALUES(?,?,?,?,?,?,?,0,?,?,?)",
                    [library_id, entry["id"], entry["kind"], entry["name"],
                     entry["parentId"], entry["iconKey"], entry["colorKey"], 1, now, now])
            for role in roles:
                db.execute("INSERT INTO classification_authority_roles(library_id,role,"
                           "classification_id) VALUES(?,?,?)",
                           [library_id, role["role"], role["classificationId"]])
            for assignment in assignments:
                db.execute(
                    "INSERT INTO classification_authority_assignments(library_id,asset_id,"
                    "classification_id,entity_revision,created_at,updated_at)"
                    " VALUES(?,?,?,?,?,?)",
                    [library_id, assignment["assetId"], assignment["classificationId"],
                     assignment.get("entityRevision", 1), now, now])
            db.execute(
                "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,"
                "change_cursor,baseline_digest,baseline_revision,activated_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                [library_id, classification_authority.DOMAIN, epoch, contract_version,
                 cursor, "d" * 64, None, now])
            db.commit()

    # -- legacy surfaces ---------------------------------------------------------

    def publish_legacy_snapshot(self, entries=None, published_at="2026-09-16T00:00:00Z"):
        """Write the legacy snapshot exactly as ``PUT /v1/classifications`` stores it."""
        payload = json.dumps({"entries": entries or [], "published_at": published_at},
                             separators=(",", ":"), sort_keys=True)
        with self.get_db() as db:
            db.execute(
                "INSERT INTO classification_snapshots(singleton,payload,published_at,updated_at,"
                "revision) VALUES(1,?,?,?,1) ON CONFLICT(singleton) DO UPDATE SET"
                " payload=excluded.payload,published_at=excluded.published_at,"
                " updated_at=excluded.updated_at,revision=revision+1",
                [payload, published_at, published_at])
            db.commit()
        return payload

    def legacy_state(self):
        with self.get_db() as db:
            snapshot = db.execute("SELECT payload,published_at,revision"
                                  " FROM classification_snapshots WHERE singleton=1").fetchone()
            links = [tuple(row) for row in db.execute(
                "SELECT asset_id,classification_id FROM asset_classifications"
                " ORDER BY asset_id,classification_id")]
        return (tuple(snapshot) if snapshot is not None else None, links)

    # -- reads -------------------------------------------------------------------

    def command(self, command_type, operation_id=R1, classification_id=ROOT, **extra):
        """Issue a command with the credential its class requires.

        Structural commands are publisher-only in v1; assignment is an ordinary client
        operation. Tests that need the *wrong* credential pass `headers=` explicitly.
        """
        headers = extra.pop("headers", None)
        body = {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
                "operationId": operation_id, "commandType": command_type}
        if command_type == classification_authority.ASSIGNMENT:
            body["assetId"] = extra.pop("assetId", ASSET)
            body["classificationId"] = extra.pop("classificationId", None)
        else:
            body["classificationId"] = classification_id
        body.update(extra)
        if headers is None:
            headers = (self.auth if command_type == classification_authority.ASSIGNMENT
                       else self.publisher_auth)
        return self.client.put(COMMANDS, headers=headers, json=body)

    def changes(self, after=0, limit=100, epoch=1, library_id=LIBRARY, headers=None):
        return self.client.get(
            CHANGES, params={"libraryId": library_id, "epoch": str(epoch),
                             "after": str(after), "limit": str(limit)},
            headers=headers or self.auth)

    def baseline(self, library_id=LIBRARY, epoch=1, headers=None, **extra):
        params = {"libraryId": library_id, "epoch": str(epoch)}
        params.update(extra)
        return self.client.get(BASELINE, params=params, headers=headers or self.auth)

    def baseline_pages(self, library_id=LIBRARY, epoch=1, classifications_per_page=None,
                       assignments_per_page=None):
        """Walk every baseline page and reconstruct the state, as a client must."""
        params = {"libraryId": library_id, "epoch": str(epoch)}
        if classifications_per_page:
            params["limit"] = str(classifications_per_page)
        classifications, assignments = {}, {}
        body = self.baseline(**params).json()
        snapshot = body["snapshotCursor"]
        roles = body["roles"]
        assert body["section"] == classification_authority.CLASSIFICATIONS_SECTION
        pages = [body]
        while True:
            for item in body["items"]:
                classifications[item["id"]] = item
            if not body["hasMore"]:
                break
            body = self.baseline(
                snapshot=str(snapshot),
                section=classification_authority.CLASSIFICATIONS_SECTION,
                after=body["nextAfter"], **({"limit": str(classifications_per_page)}
                                            if classifications_per_page else {})).json()
            pages.append(body)
        assignment_params = {"snapshot": str(snapshot),
                             "section": classification_authority.ASSIGNMENTS_SECTION}
        if assignments_per_page:
            assignment_params["limit"] = str(assignments_per_page)
        body = self.baseline(**assignment_params).json()
        pages.append(body)
        while True:
            for item in body["items"]:
                assignments[item["assetId"]] = item
            if not body["hasMore"]:
                break
            body = self.baseline(after=body["nextAfter"], **assignment_params).json()
            pages.append(body)
        return {"snapshotCursor": snapshot, "classifications": classifications,
                "assignments": assignments, "roles": roles,
                "complete": pages[-1]["complete"], "pages": pages}

    # -- direct state inspection -------------------------------------------------

    def classification_rows(self):
        with self.get_db() as db:
            return [tuple(row) for row in db.execute(
                "SELECT classification_id,kind,name,parent_id,icon_key,color_key,deleted,"
                "entity_revision FROM classification_authority_state"
                " ORDER BY classification_id")]

    def assignment_rows(self):
        with self.get_db() as db:
            return [tuple(row) for row in db.execute(
                "SELECT asset_id,classification_id,entity_revision"
                " FROM classification_authority_assignments ORDER BY asset_id")]

    def role_rows(self):
        with self.get_db() as db:
            return [tuple(row) for row in db.execute(
                "SELECT role,classification_id FROM classification_authority_roles"
                " ORDER BY role")]

    def change_rows(self):
        with self.get_db() as db:
            return [tuple(row) for row in db.execute(
                "SELECT sequence,command_type,classification_id,asset_id,entity_revision,"
                "operation_id FROM classification_authority_changes ORDER BY sequence")]

    def authority_rows(self):
        with self.get_db() as db:
            return [tuple(row) for row in db.execute(
                "SELECT library_id,domain,epoch,contract_version,change_cursor"
                " FROM authority_domains ORDER BY domain")]

    def cursor(self):
        with self.get_db() as db:
            row = db.execute("SELECT change_cursor FROM authority_domains WHERE domain=?",
                             [classification_authority.DOMAIN]).fetchone()
            return row[0] if row else None

    def assert_coded(self, response, status, code):
        self.assertEqual(response.status_code, status, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], code, detail)
        return detail


class InactiveClassificationAuthorityTests(ClassificationAuthorityFixture):
    """Zero behavior change while the domain has no authority row."""

    def test_startup_creates_no_authority_and_activates_nothing(self):
        self.assertEqual(self.authority_rows(), [])
        self.assertEqual(self.classification_rows(), [])
        self.assertEqual(self.assignment_rows(), [])

    def test_reads_report_inactive_without_faking_an_empty_baseline(self):
        for response in (self.baseline(), self.changes()):
            self.assert_coded(response, 409, authority.CODE_AUTHORITY_INACTIVE)

    def test_commands_are_rejected_while_inactive(self):
        for response in (
            self.command(classification_authority.CREATE, R1, classification_id="new",
                         kind="root", name="새 분류", parentId=None, iconKey=None,
                         colorKey=None),
            self.command(classification_authority.RENAME, R2, name="이름", expectedRevision=1),
            self.command(classification_authority.DELETE, R3, expectedRevision=1),
            self.command(classification_authority.ASSIGNMENT, R4, assetId=ASSET,
                         classificationId=None, expectedRevision=0),
        ):
            self.assert_coded(response, 409, authority.CODE_AUTHORITY_INACTIVE)
        self.assertEqual(self.authority_rows(), [])
        self.assertEqual(self.classification_rows(), [])

    def test_no_authority_operation_mutates_legacy_snapshot_or_replication_state(self):
        """The whole point of the batch: the legacy writers stay untouched."""
        payload = self.publish_legacy_snapshot(
            entries=[{"id": ROOT, "kind": "root", "name": "게임", "parentId": None,
                      "iconKey": None, "colorKey": None, "assetCount": 3}])
        with self.get_db() as db:
            db.execute("INSERT INTO asset_classifications(asset_id,classification_id,added_at)"
                       " VALUES(?,?,?)", [ASSET, ROOT, "2026-09-16T00:00:00Z"])
            db.commit()
        before = self.legacy_state()
        self.assertIsNotNone(before[0])
        self.assertEqual(before[1], [(ASSET, ROOT)])

        # Every inactive authority surface, exercised against real legacy state.
        self.baseline()
        self.changes()
        self.command(classification_authority.CREATE, R1, classification_id="new",
                     kind="root", name="새 분류", parentId=None, iconKey=None,
                     colorKey=None)
        self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET,
                     classificationId=None, expectedRevision=0)

        self.assertEqual(self.legacy_state(), before)
        self.assertEqual(self.authority_rows(), [])
        with self.get_db() as db:
            stored = db.execute("SELECT payload FROM classification_snapshots"
                                " WHERE singleton=1").fetchone()[0]
        self.assertEqual(stored, payload)

    def test_the_module_registers_activation_but_startup_still_activates_nothing(self):
        paths = {route.path for route in self.app.routes}
        self.assertIn(BASELINE, paths)
        self.assertIn(CHANGES, paths)
        self.assertIn(COMMANDS, paths)
        self.assertIn("/v1/classifications/authority/activate", paths)
        with self.get_db() as db:
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM authority_domains WHERE domain=?",
                [classification_authority.DOMAIN]).fetchone()[0], 0)

    def test_baseline_and_changes_require_authentication(self):
        self.assertEqual(self.client.get(BASELINE, params={"libraryId": LIBRARY,
                                                           "epoch": "1"}).status_code, 401)
        self.assertEqual(self.client.get(CHANGES, params={"libraryId": LIBRARY,
                                                          "epoch": "1"}).status_code, 401)


class CreateValidationTests(ClassificationAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()

    def test_create_root_work_and_tag_with_trimmed_names(self):
        created = self.command(classification_authority.CREATE, R1, classification_id="new",
                               kind="root", name="  새 루트  ", parentId=None,
                               iconKey="book", colorKey="green")
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["classification"], {
            "id": "new", "kind": "root", "name": "새 루트", "parentId": None,
            "iconKey": "book", "colorKey": "green", "deleted": False, "entityRevision": 1})

        work = self.command(classification_authority.CREATE, R2, classification_id="work",
                            kind="work", name="작품", parentId=ROOT, iconKey=None,
                            colorKey=None)
        self.assertEqual(work.status_code, 200, work.text)
        self.assertEqual(work.json()["classification"]["kind"], "work")

        tag = self.command(classification_authority.CREATE, R3, classification_id="tag",
                           kind="tag", name="태그", parentId="work", iconKey=None,
                           colorKey=None)
        self.assertEqual(tag.status_code, 200, tag.text)

    def test_parent_and_kind_combinations_are_validated(self):
        cases = {
            # A root cannot have a parent.
            "root-with-parent": {"kind": "root", "parentId": ROOT},
            # A work must hang directly under a root.
            "work-without-parent": {"kind": "work", "parentId": None},
            "work-under-tag": {"kind": "work", "parentId": TAG},
            # A tag requires some parent.
            "tag-without-parent": {"kind": "tag", "parentId": None},
        }
        for label, case in cases.items():
            with self.subTest(case=label):
                response = self.command(classification_authority.CREATE, R4,
                                        classification_id="invalid", name="무효",
                                        iconKey=None, colorKey=None, **case)
                self.assert_coded(response, 422, "invalidClassificationParent")
        self.assertEqual([row[0] for row in self.classification_rows()],
                         sorted([ROOT, WORK, TAG, OTHER, ORIGINALS]))

    def test_an_unknown_parent_is_not_found_not_invalid(self):
        response = self.command(classification_authority.CREATE, R4,
                                classification_id="new", kind="tag", name="태그",
                                parentId="ghost", iconKey=None, colorKey=None)
        self.assert_coded(response, 404, "classificationNotFound")

    def test_an_unknown_kind_is_rejected(self):
        response = self.command(classification_authority.CREATE, R4,
                                classification_id="new", kind="folder", name="무효",
                                parentId=None, iconKey=None, colorKey=None)
        self.assert_coded(response, 422, "invalidClassificationKind")

    def test_blank_and_oversized_names_are_rejected(self):
        for name, code in (("   ", "emptyClassificationName"),
                           ("가" * (classification_authority.MAX_NAME + 1),
                            "classificationNameTooLong")):
            with self.subTest(name=name[:8]):
                response = self.command(classification_authority.CREATE, R4,
                                        classification_id="new", kind="root", name=name,
                                        parentId=None, iconKey=None, colorKey=None)
                self.assert_coded(response, 422, code)

    def test_a_name_is_trimmed_before_the_length_check(self):
        response = self.command(classification_authority.CREATE, R4,
                                classification_id="new", kind="root",
                                name="  " + "가" * classification_authority.MAX_NAME + "  ",
                                parentId=None, iconKey=None, colorKey=None)
        self.assertEqual(response.status_code, 200, response.text)

    def test_an_existing_or_tombstoned_id_cannot_be_recreated(self):
        self.assertEqual(self.command(classification_authority.CREATE, R4,
                                      classification_id="dup", kind="root", name="하나",
                                      parentId=None, iconKey=None,
                                      colorKey=None).status_code, 200)
        self.assert_coded(
            self.command(classification_authority.CREATE, R5, classification_id="dup",
                         kind="root", name="둘", parentId=None, iconKey=None, colorKey=None),
            409, "classificationExists")
        self.assertEqual(
            self.command(classification_authority.DELETE, R6, classification_id="dup",
                         expectedRevision=1).status_code, 200)
        # A tombstone is gone, not reusable: reviving it would resurrect a
        # classification whose deletion the assignment log already recorded.
        self.assert_coded(
            self.command(classification_authority.CREATE, R7, classification_id="dup",
                         kind="root", name="셋", parentId=None, iconKey=None, colorKey=None),
            409, "classificationExists")


class NameUniquenessTests(ClassificationAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()

    def test_sibling_names_are_unique_case_insensitively(self):
        self.assert_coded(
            self.command(classification_authority.CREATE, R1, classification_id="dup",
                         kind="root", name="게임", parentId=None, iconKey=None,
                         colorKey=None),
            409, "duplicateClassificationName")
        self.assert_coded(
            self.command(classification_authority.CREATE, R2, classification_id="dup",
                         kind="tag", name="아로나", parentId=WORK, iconKey=None,
                         colorKey=None),
            409, "duplicateClassificationName")

    def test_the_same_name_is_allowed_under_a_different_parent(self):
        response = self.command(classification_authority.CREATE, R1,
                                classification_id="dup", kind="tag", name="게임",
                                parentId=WORK, iconKey=None, colorKey=None)
        self.assertEqual(response.status_code, 200, response.text)

    def test_a_rename_duplicate_is_a_naming_error_not_a_revision_conflict(self):
        detail = self.assert_coded(
            self.command(classification_authority.RENAME, R1, classification_id=OTHER,
                         name="게임", expectedRevision=1),
            409, "duplicateClassificationName")
        self.assertNotIn("current", detail)
        # The revision was valid, so the node is untouched and still renameable.
        self.assertEqual(
            self.command(classification_authority.RENAME, R2, classification_id=OTHER,
                         name="만화책", expectedRevision=1).status_code, 200)

    def test_a_tombstone_does_not_reserve_its_name(self):
        self.assertEqual(
            self.command(classification_authority.DELETE, R1, classification_id=OTHER,
                         expectedRevision=1).status_code, 200)
        response = self.command(classification_authority.CREATE, R2,
                                classification_id="reuse", kind="root", name="만화",
                                parentId=None, iconKey=None, colorKey=None)
        self.assertEqual(response.status_code, 200, response.text)

    def test_a_rename_to_an_equivalent_name_is_accepted(self):
        response = self.command(classification_authority.RENAME, R1,
                                classification_id=OTHER, name="  만화  ",
                                expectedRevision=1)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["classification"]["name"], "만화")


class MoveSemanticsTests(ClassificationAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()

    def test_a_root_moved_under_a_parent_becomes_a_tag(self):
        response = self.command(classification_authority.MOVE, R1, classification_id=OTHER,
                                parentId=ROOT, expectedRevision=1)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["classification"]["kind"], "tag")
        self.assertEqual(response.json()["classification"]["parentId"], ROOT)

    def test_a_tag_moved_to_the_top_level_becomes_a_root(self):
        response = self.command(classification_authority.MOVE, R1, classification_id=TAG,
                                parentId=None, expectedRevision=1)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["classification"]["kind"], "root")
        self.assertIsNone(response.json()["classification"]["parentId"])

    def test_a_move_within_the_same_level_keeps_its_kind(self):
        response = self.command(classification_authority.CREATE, R1,
                                classification_id="tag2", kind="tag", name="다른 태그",
                                parentId=WORK, iconKey=None, colorKey=None)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            self.command(classification_authority.MOVE, R2, classification_id="tag2",
                         parentId=TAG, expectedRevision=1).json()["classification"]["kind"],
            "tag")

    def test_a_work_cannot_become_a_top_level_root(self):
        """The derivation leaves a work unchanged, so the parent rule rejects it."""
        self.assert_coded(
            self.command(classification_authority.MOVE, R1, classification_id=WORK,
                         parentId=None, expectedRevision=1),
            422, "invalidClassificationParent")

    def test_a_work_cannot_move_under_a_non_root(self):
        self.assert_coded(
            self.command(classification_authority.MOVE, R1, classification_id=WORK,
                         parentId=TAG, expectedRevision=1),
            422, "invalidClassificationParent")

    def test_moving_a_node_is_not_a_cycle_for_its_own_subtree(self):
        """Moving a node under its own descendant must be refused."""
        response = self.command(classification_authority.MOVE, R1, classification_id=ROOT,
                                parentId=TAG, expectedRevision=1)
        self.assert_coded(response, 422, "classificationCycle")

    def test_a_node_cannot_be_its_own_parent(self):
        response = self.command(classification_authority.MOVE, R1, classification_id=TAG,
                                parentId=TAG, expectedRevision=1)
        self.assert_coded(response, 422, "classificationCycle")

    def test_kind_validation_precedes_the_cycle_check_like_the_pc(self):
        """The PC validates the kind/parent combination before looking for a cycle.

        `library/classification.rs::move_classification` derives the next kind, calls
        `validate_parent`, and only then runs the recursive descendant check. A `work`
        placed under itself therefore fails the kind rule, and reporting it as a cycle
        would disagree with the client that produced the command.
        """
        response = self.command(classification_authority.MOVE, R1, classification_id=WORK,
                                parentId=WORK, expectedRevision=1)
        self.assert_coded(response, 422, "invalidClassificationParent")

    def test_a_move_to_a_missing_parent_is_not_found(self):
        self.assert_coded(
            self.command(classification_authority.MOVE, R1, classification_id=TAG,
                         parentId="ghost", expectedRevision=1),
            404, "classificationNotFound")

    def test_a_move_to_an_occupied_sibling_name_is_a_naming_error(self):
        self.assertEqual(self.command(classification_authority.CREATE, R1,
                                      classification_id="twin", kind="tag", name="아로나",
                                      parentId=ROOT, iconKey=None, colorKey=None).status_code,
                         200)
        # TAG is named 아로나 under WORK; moving it under ROOT collides with "twin".
        self.assert_coded(
            self.command(classification_authority.MOVE, R2, classification_id=TAG,
                         parentId=ROOT, expectedRevision=1),
            409, "duplicateClassificationName")


class OriginalsProtectionTests(ClassificationAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()

    def test_the_role_is_carried_and_never_mutated_by_a_command(self):
        self.assertEqual(self.role_rows(), [("originals", ORIGINALS)])
        self.assertEqual(
            self.command(classification_authority.RENAME, R1, classification_id=ROOT,
                         name="게임2", expectedRevision=1).status_code, 200)
        self.assertEqual(self.role_rows(), [("originals", ORIGINALS)])

    def test_rename_move_and_delete_of_originals_are_refused(self):
        for label, response in (
            ("rename", self.command(classification_authority.RENAME, R1,
                                    classification_id=ORIGINALS, name="바뀐 이름",
                                    expectedRevision=1)),
            ("move", self.command(classification_authority.MOVE, R2,
                                  classification_id=ORIGINALS, parentId=ROOT,
                                  expectedRevision=1)),
            ("move-root", self.command(classification_authority.MOVE, R3,
                                       classification_id=ORIGINALS, parentId=None,
                                       expectedRevision=1)),
            ("delete", self.command(classification_authority.DELETE, R4,
                                    classification_id=ORIGINALS, expectedRevision=1)),
        ):
            with self.subTest(case=label):
                self.assert_coded(response, 409, "protectedClassification")

    def test_appearance_of_originals_is_still_editable(self):
        """The PC protects rename, move and delete — not the icon."""
        response = self.command(classification_authority.APPEARANCE, R1,
                                classification_id=ORIGINALS, iconKey="star",
                                colorKey="pink", expectedRevision=1)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["classification"]["iconKey"], "star")

    def test_protection_is_reported_before_a_revision_conflict(self):
        """A command that can never succeed must not be told to rebase."""
        detail = self.assert_coded(
            self.command(classification_authority.DELETE, R1, classification_id=ORIGINALS,
                         expectedRevision=99),
            409, "protectedClassification")
        self.assertNotIn("current", detail)

    def test_a_classification_without_the_role_is_fully_editable(self):
        self.assertEqual(
            self.command(classification_authority.DELETE, R1, classification_id=OTHER,
                         expectedRevision=1).status_code, 200)


class AppearanceValidationTests(ClassificationAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()

    def test_appearance_round_trips_and_resets(self):
        set_response = self.command(classification_authority.APPEARANCE, R1,
                                    classification_id=TAG, iconKey="photo",
                                    colorKey="pink", expectedRevision=1)
        self.assertEqual(set_response.status_code, 200, set_response.text)
        self.assertEqual((set_response.json()["classification"]["iconKey"],
                          set_response.json()["classification"]["colorKey"]),
                         ("photo", "pink"))

        reset = self.command(classification_authority.APPEARANCE, R2,
                             classification_id=TAG, iconKey=None, colorKey=None,
                             expectedRevision=2)
        self.assertEqual(reset.status_code, 200, reset.text)
        self.assertEqual((reset.json()["classification"]["iconKey"],
                          reset.json()["classification"]["colorKey"]), (None, None))

    def test_unknown_keys_are_rejected_without_changing_appearance(self):
        for icon_key, color_key in (("uploaded-svg", "pink"), ("photo", "#ffffff")):
            with self.subTest(icon=icon_key, color=color_key):
                response = self.command(classification_authority.APPEARANCE, R1,
                                        classification_id=TAG, iconKey=icon_key,
                                        colorKey=color_key, expectedRevision=1)
                self.assert_coded(response, 422, "invalidClassificationAppearance")
        self.assertEqual(
            [row for row in self.classification_rows() if row[0] == TAG][0][4:6], (None, None))

    def test_appearance_is_validated_on_create_too(self):
        response = self.command(classification_authority.CREATE, R1,
                                classification_id="new", kind="root", name="새 분류",
                                parentId=None, iconKey="not-an-icon", colorKey=None)
        self.assert_coded(response, 422, "invalidClassificationAppearance")


class AssignmentTests(ClassificationAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()

    def test_an_unassigned_asset_is_never_seen_at_revision_zero(self):
        response = self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                                classificationId=None, expectedRevision=0)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["changed"])
        self.assertEqual(response.json()["assignments"],
                         [{"assetId": ASSET, "classificationId": None,
                           "entityRevision": 0}])
        self.assertEqual(self.assignment_rows(), [])

    def test_assign_change_and_clear_are_one_lineage(self):
        assigned = self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                                classificationId=WORK, expectedRevision=0)
        self.assertEqual(assigned.status_code, 200, assigned.text)
        self.assertEqual(assigned.json()["assignments"],
                         [{"assetId": ASSET, "classificationId": WORK,
                           "entityRevision": 1}])

        changed = self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET,
                               classificationId=TAG, expectedRevision=1)
        self.assertEqual(changed.json()["assignments"],
                         [{"assetId": ASSET, "classificationId": TAG,
                           "entityRevision": 2}])
        # One row per asset: assignment is single-valued, not a relation set.
        self.assertEqual(self.assignment_rows(), [(ASSET, TAG, 2)])

        cleared = self.command(classification_authority.ASSIGNMENT, R3, assetId=ASSET,
                               classificationId=None, expectedRevision=2)
        self.assertEqual(cleared.json()["assignments"],
                         [{"assetId": ASSET, "classificationId": None,
                           "entityRevision": 3}])
        # Clearing retains the row as revision state so a later assign can present it.
        self.assertEqual(self.assignment_rows(), [(ASSET, None, 3)])

    def test_an_assignment_at_its_current_value_is_a_receipted_no_op(self):
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=WORK, expectedRevision=0)
        before = self.change_rows()
        repeat = self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET,
                              classificationId=WORK, expectedRevision=1)
        self.assertEqual(repeat.status_code, 200, repeat.text)
        self.assertFalse(repeat.json()["changed"])
        self.assertIsNone(repeat.json()["changeSequence"])
        self.assertEqual(repeat.json()["authorityCursor"], 1)
        self.assertEqual(self.change_rows(), before)
        # A no-op does not require the caller to know a revision it cannot observe.
        self.assertEqual(
            self.command(classification_authority.ASSIGNMENT, R3, assetId=ASSET,
                         classificationId=WORK, expectedRevision=99).status_code, 200)

    def test_a_stale_assignment_revision_conflicts_with_the_current_state(self):
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=WORK, expectedRevision=0)
        detail = self.assert_coded(
            self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET,
                         classificationId=TAG, expectedRevision=0),
            409, "revisionConflict")
        self.assertEqual(detail["current"], {"assetId": ASSET, "classificationId": WORK,
                                             "entityRevision": 1})
        # Nothing was overwritten.
        self.assertEqual(self.assignment_rows(), [(ASSET, WORK, 1)])

    def test_two_classifications_cannot_both_hold_one_asset(self):
        """Single-valued assignment is the schema, not a convention."""
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=WORK, expectedRevision=0)
        self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET,
                     classificationId=TAG, expectedRevision=1)
        self.assertEqual(len(self.assignment_rows()), 1)
        self.assertEqual(self.assignment_rows()[0][1], TAG)

    def test_assignment_requires_an_existing_committed_asset(self):
        with self.get_db() as db:
            db.execute("INSERT INTO assets(id,committed) VALUES('uncommitted',0)")
            db.commit()
        detail = self.assert_coded(
            self.command(classification_authority.ASSIGNMENT, R1, assetId="uncommitted",
                         classificationId=WORK, expectedRevision=0),
            422, "invalidClassificationAssignment")
        self.assertEqual(detail["assetId"], "uncommitted")
        self.assertEqual(self.assignment_rows(), [])

    def test_a_trashed_asset_accepts_assignment_changes(self):
        # Link rule: a phone-trashed Asset keeps its organization and must not jam the
        # PC classification queue.
        activate_asset_lifecycle(self.get_db, LIBRARY, {ASSET: "trash"})
        self.assertEqual(self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                                      classificationId=WORK, expectedRevision=0).status_code, 200)
        self.assertEqual(self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET,
                                      classificationId=None, expectedRevision=1).status_code, 200)

    def test_a_tombstoned_asset_is_refused_with_a_definitive_code(self):
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET2,
                     classificationId=WORK, expectedRevision=0)
        activate_asset_lifecycle(self.get_db, LIBRARY, {ASSET: "tombstoned", ASSET2: "tombstoned"})
        detail = self.assert_coded(
            self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET,
                         classificationId=WORK, expectedRevision=0), 409, "assetTombstoned")
        self.assertEqual(detail["assetId"], ASSET)
        self.assert_coded(
            self.command(classification_authority.ASSIGNMENT, R3, assetId=ASSET2,
                         classificationId=None, expectedRevision=1), 409, "assetTombstoned")
        self.assertEqual(self.assignment_rows(), [(ASSET2, WORK, 1)])

    def test_clearing_does_not_require_the_asset_to_be_committed(self):
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=WORK, expectedRevision=0)
        with self.get_db() as db:
            db.execute("UPDATE assets SET committed=0 WHERE id=?", [ASSET])
            db.commit()
        self.assertEqual(
            self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET,
                         classificationId=None, expectedRevision=1).status_code, 200)

    def test_assigning_to_a_missing_or_tombstoned_classification_fails(self):
        detail = self.assert_coded(
            self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                         classificationId="ghost", expectedRevision=0),
            404, "classificationNotFound")
        self.assertEqual(detail["classificationId"], "ghost")

        self.assertEqual(self.command(classification_authority.DELETE, R2,
                                      classification_id=OTHER,
                                      expectedRevision=1).status_code, 200)
        self.assert_coded(
            self.command(classification_authority.ASSIGNMENT, R3, assetId=ASSET,
                         classificationId=OTHER, expectedRevision=0),
            404, "classificationNotFound")

    def test_an_assignment_never_bumps_the_classification_revision(self):
        before = [row for row in self.classification_rows() if row[0] == WORK][0]
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=WORK, expectedRevision=0)
        after = [row for row in self.classification_rows() if row[0] == WORK][0]
        self.assertEqual(before, after)

    def test_the_assignment_command_validates_its_own_envelope(self):
        malformed = {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
                     "operationId": R1, "commandType": classification_authority.ASSIGNMENT,
                     "assetId": ASSET, "classificationId": WORK}
        response = self.client.put(COMMANDS, headers=self.auth, json=malformed)
        self.assert_coded(response, 422, "invalidClassificationCommand")
        response = self.client.put(
            COMMANDS, headers=self.auth,
            json={**malformed, "expectedRevision": 0, "desiredState": True})
        self.assert_coded(response, 422, "invalidClassificationCommand")


class DeleteSemanticsTests(ClassificationAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()

    def test_deleting_a_non_root_reassigns_its_assets_to_the_parent(self):
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=TAG, expectedRevision=0)
        self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET2,
                     classificationId=TAG, expectedRevision=0)
        self.command(classification_authority.ASSIGNMENT, R3, assetId=ASSET3,
                     classificationId=WORK, expectedRevision=0)

        response = self.command(classification_authority.DELETE, R4,
                                classification_id=TAG, expectedRevision=1)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["classification"]["deleted"])
        # The whole effect is reported as one deterministic transition.
        self.assertEqual(body["assignmentTransition"],
                         {"fromClassificationId": TAG, "toClassificationId": WORK,
                          "affectsAssignments": 2})
        self.assertEqual((body["changeSequence"], body["authorityCursor"]), (4, 4))
        self.assertEqual(self.assignment_rows(),
                         [(ASSET, WORK, 2), (ASSET2, WORK, 2), (ASSET3, WORK, 1)])
        # A tombstone, not a vanished row.
        self.assertEqual([row for row in self.classification_rows() if row[0] == TAG][0][6], 1)

    def test_deleting_a_root_leaves_its_assets_unassigned(self):
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=OTHER, expectedRevision=0)
        response = self.command(classification_authority.DELETE, R2,
                                classification_id=OTHER, expectedRevision=1)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["assignmentTransition"],
                         {"fromClassificationId": OTHER, "toClassificationId": None,
                          "affectsAssignments": 1})
        self.assertEqual(self.assignment_rows(), [(ASSET, None, 2)])

    def test_a_delete_with_no_assignments_reports_a_zero_effect_transition(self):
        """An empty transition is still stated, so replay never has to infer it."""
        response = self.command(classification_authority.DELETE, R1,
                                classification_id=OTHER, expectedRevision=1)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["assignmentTransition"],
                         {"fromClassificationId": OTHER, "toClassificationId": None,
                          "affectsAssignments": 0})
        self.assertEqual(self.assignment_rows(), [])

    def test_deleting_a_classification_with_children_is_rejected(self):
        self.assert_coded(
            self.command(classification_authority.DELETE, R1, classification_id=WORK,
                         expectedRevision=1),
            409, "classificationHasChildren")
        self.assert_coded(
            self.command(classification_authority.DELETE, R2, classification_id=ROOT,
                         expectedRevision=1),
            409, "classificationHasChildren")
        self.assertEqual([row[6] for row in self.classification_rows()], [0, 0, 0, 0, 0])

    def test_a_child_tombstone_does_not_block_a_parent_delete(self):
        """Only a *live* child blocks the delete, matching the PC's `parent_id` rule."""
        self.assertEqual(
            self.command(classification_authority.DELETE, R1, classification_id=TAG,
                         expectedRevision=1).status_code, 200)
        self.assertEqual(
            self.command(classification_authority.DELETE, R2, classification_id=WORK,
                         expectedRevision=1).status_code, 200)

    def test_a_tombstoned_classification_cannot_be_edited(self):
        self.assertEqual(
            self.command(classification_authority.DELETE, R1, classification_id=OTHER,
                         expectedRevision=1).status_code, 200)
        self.assert_coded(
            self.command(classification_authority.RENAME, R2, classification_id=OTHER,
                         name="되살리기", expectedRevision=2),
            404, "classificationNotFound")

    def test_delete_requires_a_current_revision(self):
        self.assert_coded(
            self.command(classification_authority.DELETE, R1, classification_id=TAG,
                         expectedRevision=7),
            409, "revisionConflict")


class IdempotencyTests(ClassificationAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()

    def test_a_retry_after_a_lost_response_applies_exactly_once(self):
        first = self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                             classificationId=WORK, expectedRevision=0)
        self.assertEqual(first.status_code, 200, first.text)
        retry = self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                             classificationId=WORK, expectedRevision=0)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json(), first.json())
        self.assertEqual(len(self.change_rows()), 1)
        self.assertEqual(self.cursor(), 1)
        self.assertEqual(self.assignment_rows(), [(ASSET, WORK, 1)])

    def test_a_structural_retry_is_also_applied_once(self):
        first = self.command(classification_authority.CREATE, R1, classification_id="new",
                             kind="root", name="새 분류", parentId=None, iconKey=None,
                             colorKey=None)
        retry = self.command(classification_authority.CREATE, R1, classification_id="new",
                             kind="root", name="새 분류", parentId=None, iconKey=None,
                             colorKey=None)
        self.assertEqual(retry.json(), first.json())
        self.assertEqual(len(self.change_rows()), 1)
        self.assertEqual(len([row for row in self.classification_rows()
                              if row[0] == "new"]), 1)

    def test_a_delete_retry_does_not_move_assignments_twice(self):
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=TAG, expectedRevision=0)
        first = self.command(classification_authority.DELETE, R2, classification_id=TAG,
                             expectedRevision=1)
        self.assertEqual(first.status_code, 200, first.text)
        retry = self.command(classification_authority.DELETE, R2, classification_id=TAG,
                             expectedRevision=1)
        self.assertEqual(retry.json(), first.json())
        self.assertEqual(self.assignment_rows(), [(ASSET, WORK, 2)])
        # One assignment change plus one atomic delete — the retry added nothing, and
        # the delete did not append a row per affected assignment.
        self.assertEqual(len(self.change_rows()), 2)

    def test_reusing_an_operation_id_with_another_payload_conflicts(self):
        self.assertEqual(self.command(classification_authority.RENAME, R1,
                                      classification_id=OTHER, name="하나",
                                      expectedRevision=1).status_code, 200)
        detail = self.assert_coded(
            self.command(classification_authority.RENAME, R1, classification_id=OTHER,
                         name="둘", expectedRevision=1),
            409, "operationConflict")
        self.assertEqual(set(detail) >= {"code", "message"}, True)
        self.assertEqual([row for row in self.classification_rows()
                          if row[0] == OTHER][0][2], "하나")

    def test_reusing_an_operation_id_with_another_command_conflicts(self):
        self.assertEqual(self.command(classification_authority.CREATE, R1,
                                      classification_id="new", kind="root", name="새 분류",
                                      parentId=None, iconKey=None,
                                      colorKey=None).status_code, 200)
        self.assert_coded(
            self.command(classification_authority.RENAME, R1, classification_id="new",
                         name="다른 명령", expectedRevision=1),
            409, "operationConflict")

    def test_an_operation_id_is_scoped_to_its_epoch(self):
        """A receipt is per (library, epoch, operation), so a new epoch may reuse one."""
        self.assertEqual(self.command(classification_authority.RENAME, R1,
                                      classification_id=OTHER, name="하나",
                                      expectedRevision=1).status_code, 200)
        with self.get_db() as db:
            db.execute("UPDATE authority_domains SET epoch=2 WHERE domain=?",
                       [classification_authority.DOMAIN])
            db.commit()
        response = self.command(classification_authority.RENAME, R1,
                                classification_id=OTHER, name="둘", expectedRevision=2)
        self.assertEqual(response.status_code, 409, response.text)
        # Epoch mismatch is an identity problem, not an operation-id collision.
        self.assertEqual(response.json()["detail"]["code"],
                         authority.CODE_AUTHORITY_LIBRARY_MISMATCH)


class CommandEnvelopeTests(ClassificationAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()

    def test_the_envelope_and_field_set_are_enforced(self):
        base = {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
                "operationId": R1, "commandType": classification_authority.RENAME,
                "classificationId": OTHER, "name": "이름", "expectedRevision": 1}
        cases = {
            "missing-envelope-key": {key: value for key, value in base.items()
                                     if key != "operationId"},
            "extra-field": {**base, "albumId": ROOT},
            "unknown-command": {**base, "commandType": "toggleClassification"},
            "bad-library": {**base, "libraryId": "not-a-library"},
            "bad-epoch": {**base, "epoch": 0},
            "bad-contract": {**base, "contractVersion": 0},
            "bad-operation-id": {**base, "operationId": "not-a-uuid"},
            "bad-classification-id": {**base, "classificationId": "../escape"},
            "classification-revision-zero": {**base, "expectedRevision": 0},
        }
        for label, body in cases.items():
            with self.subTest(case=label):
                response = self.client.put(COMMANDS, headers=self.publisher_auth, json=body)
                self.assertEqual(response.status_code, 422, f"{label}: {response.text}")
                expected = {
                    "unknown-command": "unsupportedClassificationCommand",
                    # A semantically invalid revision is its own coded rejection, as in
                    # Album authority: it is a bad value, not a malformed envelope.
                    "classification-revision-zero": "invalidClassificationRevision",
                }.get(label, "invalidClassificationCommand")
                self.assertEqual(response.json()["detail"]["code"], expected)

    def test_a_command_for_another_library_or_contract_is_rejected(self):
        self.assert_coded(
            self.client.put(COMMANDS, headers=self.publisher_auth, json={
                "libraryId": OTHER_LIBRARY, "epoch": 1, "contractVersion": 1,
                "operationId": R2, "commandType": classification_authority.RENAME,
                "classificationId": OTHER, "name": "이름", "expectedRevision": 1}),
            409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH)
        self.assert_coded(
            self.client.put(COMMANDS, headers=self.publisher_auth, json={
                "libraryId": LIBRARY, "epoch": 1, "contractVersion": 2,
                "operationId": R3, "commandType": classification_authority.RENAME,
                "classificationId": OTHER, "name": "이름", "expectedRevision": 1}),
            409, authority.CODE_AUTHORITY_CONTRACT_UNSUPPORTED)

    def test_commands_require_authentication(self):
        response = self.client.put(COMMANDS, json={
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "operationId": R1,
            "commandType": classification_authority.RENAME, "classificationId": OTHER,
            "name": "이름", "expectedRevision": 1})
        self.assertEqual(response.status_code, 401)

    def test_an_unparseable_body_is_rejected(self):
        response = self.client.put(COMMANDS, headers=self.publisher_auth,
                                   content=b"{not json")
        self.assert_coded(response, 422, "invalidClassificationCommand")

    def test_a_stale_structural_revision_conflicts_and_does_not_overwrite(self):
        self.assertEqual(self.command(classification_authority.RENAME, R1,
                                      classification_id=OTHER, name="첫 이름",
                                      expectedRevision=1).status_code, 200)
        detail = self.assert_coded(
            self.command(classification_authority.RENAME, R2, classification_id=OTHER,
                         name="늦은 이름", expectedRevision=1),
            409, "revisionConflict")
        self.assertEqual(detail["current"]["name"], "첫 이름")
        self.assertEqual(detail["current"]["entityRevision"], 2)
        self.assertEqual([row for row in self.classification_rows()
                          if row[0] == OTHER][0][2], "첫 이름")

    def test_a_structural_command_requires_a_known_classification(self):
        self.assert_coded(
            self.command(classification_authority.RENAME, R1, classification_id="ghost",
                         name="이름", expectedRevision=1),
            404, "classificationNotFound")


class ChangeLogAndCursorTests(ClassificationAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()

    def test_every_mutation_appends_changes_and_advances_only_its_own_cursor(self):
        with self.get_db() as db:
            db.execute(
                "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,"
                "change_cursor,baseline_digest,baseline_revision,activated_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                [LIBRARY, "albums", 1, 1, 0, "e" * 64, None, "2026-09-16T00:00:00Z"])
            db.commit()
        self.command(classification_authority.CREATE, R1, classification_id="new",
                     kind="root", name="새 분류", parentId=None, iconKey=None,
                     colorKey=None)
        self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET,
                     classificationId="new", expectedRevision=0)
        self.assertEqual(self.cursor(), 2)
        with self.get_db() as db:
            albums_cursor = db.execute(
                "SELECT change_cursor FROM authority_domains WHERE domain='albums'").fetchone()[0]
        self.assertEqual(albums_cursor, 0)
        self.assertEqual([row[1] for row in self.change_rows()],
                         [classification_authority.CREATE,
                          classification_authority.ASSIGNMENT])

    def test_a_delete_is_one_sequence_regardless_of_affected_assignments(self):
        """The atomicity requirement: a delete cannot be split across change rows."""
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=TAG, expectedRevision=0)
        self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET2,
                     classificationId=TAG, expectedRevision=0)
        response = self.command(classification_authority.DELETE, R3,
                                classification_id=TAG, expectedRevision=1)
        body = response.json()
        # Tombstone plus a transition covering both assignments, in ONE sequence, and
        # the cursor advanced exactly once for the command.
        self.assertEqual((body["changeSequence"], body["authorityCursor"]), (3, 3))
        self.assertEqual(self.cursor(), 3)
        self.assertEqual([row[0] for row in self.change_rows()], [1, 2, 3])
        self.assertEqual(body["assignmentTransition"]["affectsAssignments"], 2)
        # The transition is carried by the delete's own change row, not by extra rows.
        delete_row = self.change_rows()[-1]
        self.assertEqual(delete_row[1], classification_authority.DELETE)

    def test_commit_rejects_multiple_deltas_before_writing_any_change(self):
        with self.get_db() as db:
            row = authority.require_active(
                db, classification_authority.DOMAIN, LIBRARY,
                classification_authority.CONTRACT_VERSION)
            before = db.execute(
                "SELECT COUNT(*) FROM classification_authority_changes").fetchone()[0]
            deltas = [
                {"assignment": {"assetId": ASSET, "classificationId": TAG,
                                "entityRevision": 1}},
                {"assignment": {"assetId": ASSET2, "classificationId": TAG,
                                "entityRevision": 1}},
            ]
            with self.assertRaisesRegex(RuntimeError, "exactly one change delta"):
                classification_authority._commit(
                    db, row, library_id=LIBRARY, epoch=1, operation_id=R8,
                    payload_sha="f" * 64, command_type=classification_authority.ASSIGNMENT,
                    classification_id=TAG, asset_id=None,
                    now="2026-09-16T00:00:00Z", deltas=deltas,
                    classification=None, assignments=[])
            after = db.execute(
                "SELECT COUNT(*) FROM classification_authority_changes").fetchone()[0]
            self.assertEqual(after, before)

    def test_changes_replay_accepted_mutations_in_order(self):
        self.command(classification_authority.CREATE, R1, classification_id="new",
                     kind="root", name="새 분류", parentId=None, iconKey=None,
                     colorKey=None)
        self.command(classification_authority.RENAME, R2, classification_id="new",
                     name="바뀐 이름", expectedRevision=1)
        items = self.changes().json()["items"]
        self.assertEqual([item["sequence"] for item in items], [1, 2])
        self.assertEqual([item["commandType"] for item in items],
                         [classification_authority.CREATE,
                          classification_authority.RENAME])
        self.assertEqual([item["classification"]["name"] for item in items],
                         ["새 분류", "바뀐 이름"])

    def test_a_cursor_ahead_of_the_authority_is_its_own_state(self):
        self.command(classification_authority.RENAME, R1, classification_id=OTHER,
                     name="이름", expectedRevision=1)
        self.assert_coded(self.changes(after=99), 409, "cursorAhead")

    def test_cursor_expiry_demands_a_fresh_baseline(self):
        self.command(classification_authority.RENAME, R1, classification_id=OTHER,
                     name="이름", expectedRevision=1)
        with self.get_db() as db:
            db.execute("INSERT INTO classification_authority_retention(library_id,epoch,"
                       "pruned_through,pruned_at) VALUES(?,?,?,?)",
                       [LIBRARY, 1, 1, "2026-09-16T00:00:00Z"])
            db.commit()
        detail = self.assert_coded(self.changes(after=0), 409, authority.CODE_CURSOR_EXPIRED)
        self.assertEqual(detail["authorityCursor"], 1)
        # A cursor exactly at the floor is still servable: nothing was pruned past it.
        self.assertEqual(self.changes(after=1).status_code, 200)

    def test_prune_records_the_floor_and_keeps_state(self):
        self.command(classification_authority.RENAME, R1, classification_id=OTHER,
                     name="이름", expectedRevision=1)
        future = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=400)
        result = classification_authority.prune(self.get_db, now=future)
        self.assertEqual(result["changes"], 1)
        self.assertEqual(self.change_rows(), [])
        # The classification itself is never pruned: its tombstone must outlive its
        # change row.
        self.assertEqual(len(self.classification_rows()), 5)
        self.assert_coded(self.changes(after=0), 409, authority.CODE_CURSOR_EXPIRED)

    def test_changes_reject_a_library_mismatch_and_bound_the_limit(self):
        self.assert_coded(self.changes(library_id=OTHER_LIBRARY), 409,
                          authority.CODE_AUTHORITY_LIBRARY_MISMATCH)
        self.assert_coded(self.changes(limit=0), 422, "invalidClassificationCommand")
        self.assert_coded(self.changes(after=-1), 422, "invalidClassificationCommand")


class BaselinePagingTests(ClassificationAuthorityFixture):
    def test_the_baseline_is_frozen_and_completes_only_at_the_end(self):
        self.activate()
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=WORK, expectedRevision=0)
        baseline = self.baseline_pages()
        self.assertTrue(baseline["complete"])
        self.assertEqual(baseline["snapshotCursor"], 1)
        self.assertEqual(baseline["classifications"][ROOT]["kind"], "root")
        self.assertEqual(baseline["assignments"][ASSET],
                         {"assetId": ASSET, "classificationId": WORK, "entityRevision": 1})
        self.assertTrue(all(page["complete"] is False for page in baseline["pages"][:-1]))

    def test_paging_is_deterministic_and_complete(self):
        self.activate()
        for index, asset in enumerate((ASSET, ASSET2, ASSET3)):
            self.assertEqual(
                self.command(classification_authority.ASSIGNMENT, [R1, R2, R3][index],
                             assetId=asset, classificationId=TAG,
                             expectedRevision=0).status_code, 200)
        paged = self.baseline_pages(classifications_per_page=2, assignments_per_page=1)
        whole = self.baseline_pages()
        self.assertEqual(paged["classifications"], whole["classifications"])
        self.assertEqual(paged["assignments"], whole["assignments"])
        self.assertGreater(len(paged["pages"]), len(whole["pages"]))
        self.assertEqual([item["id"] for item in paged["pages"][0]["items"]],
                         sorted(item["id"] for item in whole["classifications"].values())[:2])

    def test_an_unassigned_assignment_is_baseline_revision_state(self):
        """A cleared assignment must be readable so a client can compose its next CAS."""
        self.activate()
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=TAG, expectedRevision=0)
        self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET,
                     classificationId=None, expectedRevision=1)
        baseline = self.baseline_pages()
        self.assertEqual(baseline["assignments"][ASSET],
                         {"assetId": ASSET, "classificationId": None, "entityRevision": 2})

    def test_the_baseline_carries_no_tombstoned_classification(self):
        self.activate()
        self.assertEqual(
            self.command(classification_authority.DELETE, R1, classification_id=OTHER,
                         expectedRevision=1).status_code, 200)
        baseline = self.baseline_pages()
        self.assertNotIn(OTHER, baseline["classifications"])
        self.assertEqual(len(baseline["classifications"]), 4)

    def test_a_mutation_between_pages_invalidates_the_frozen_baseline(self):
        self.activate()
        first = self.baseline().json()
        self.assertEqual(
            self.command(classification_authority.DELETE, R1, classification_id=OTHER,
                         expectedRevision=1).status_code, 200)
        response = self.baseline(snapshot=str(first["snapshotCursor"]),
                                 section=classification_authority.ASSIGNMENTS_SECTION)
        detail = self.assert_coded(response, 409, "baselineChanged")
        self.assertEqual(detail["snapshotCursor"], first["snapshotCursor"])
        self.assertEqual(detail["authorityCursor"], self.cursor())

    def test_the_first_baseline_request_rejects_a_partial_freeze(self):
        self.activate()
        for extra in ({"section": classification_authority.ASSIGNMENTS_SECTION},
                      {"after": ROOT}):
            with self.subTest(extra=extra):
                self.assert_coded(self.baseline(**extra), 422,
                                  "invalidClassificationBaseline")

    def test_baseline_requests_validate_section_cursor_and_limit(self):
        self.activate()
        cases = (
            {"section": "unknown"}, {"limit": "0"}, {"limit": "99999"}, {"snapshot": "-1"},
            {"section": classification_authority.CLASSIFICATIONS_SECTION, "after": "../x"},
            {"section": classification_authority.ASSIGNMENTS_SECTION, "after": "../x"},
            {"epoch": "0"},
        )
        for extra in cases:
            with self.subTest(extra=extra):
                response = self.baseline(**extra)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(response.json()["detail"]["code"],
                                 "invalidClassificationBaseline")

    def test_a_baseline_for_a_mismatched_library_is_rejected(self):
        self.activate()
        self.assert_coded(self.baseline(library_id=OTHER_LIBRARY), 409,
                          authority.CODE_AUTHORITY_LIBRARY_MISMATCH)


class ReplayEquivalenceTests(ClassificationAuthorityFixture):
    """A client must be able to rebuild authority state from baseline + changes."""

    def setUp(self):
        super().setUp()
        self.activate()

    def authoritative_state(self):
        """Canonical state in the same tuple shape the replica builder produces.

        Normalizing here is what makes the comparison a statement about *content*; the
        replica side is built from JSON and could never equal a `sqlite3.Row`.
        """
        with self.get_db() as db:
            classifications = {row[0]: tuple(row) for row in db.execute(
                "SELECT classification_id,kind,name,parent_id,icon_key,color_key,deleted,"
                "entity_revision FROM classification_authority_state WHERE library_id=?",
                [LIBRARY])}
            assignments = {row[0]: tuple(row) for row in db.execute(
                "SELECT asset_id,classification_id,entity_revision"
                " FROM classification_authority_assignments WHERE library_id=?", [LIBRARY])}
        return classifications, assignments

    def apply_change(self, replica, change):
        """Apply exactly one change row, using only the row's own contents.

        Nothing is inferred from absence. A delete carries its tombstone *and* its
        assignment transition in the same row, so this applies the whole effect in one
        step — it can never leave a replica with the classification deleted while only
        some assignments moved.
        """
        classifications, assignments = replica
        if change.get("classification") is not None:
            node = change["classification"]
            classifications[node["id"]] = (node["id"], node["kind"], node["name"],
                                           node["parentId"], node["iconKey"],
                                           node["colorKey"], int(node["deleted"]),
                                           node["entityRevision"])
            transition = change.get("assignmentTransition")
            if transition is not None:
                source = transition["fromClassificationId"]
                destination = transition["toClassificationId"]
                moved = 0
                for asset_id, row in list(assignments.items()):
                    if row[1] == source:
                        assignments[asset_id] = (asset_id, destination, row[2] + 1)
                        moved += 1
                self.assertEqual(moved, transition["affectsAssignments"],
                                 "the transition count must match what replay moved")
        else:
            row = change["assignment"]
            assignments[row["assetId"]] = (row["assetId"], row["classificationId"],
                                           row["entityRevision"])
        return replica

    def adopt_baseline(self, baseline):
        return ({item["id"]: (item["id"], item["kind"], item["name"], item["parentId"],
                              item["iconKey"], item["colorKey"], int(item["deleted"]),
                              item["entityRevision"])
                 for item in baseline["classifications"].values()},
                {item["assetId"]: (item["assetId"], item["classificationId"],
                                   item["entityRevision"])
                 for item in baseline["assignments"].values()})

    def fetch_all_changes(self):
        items, after = [], 0
        while True:
            body = self.changes(after=after).json()
            items.extend(body["items"])
            if not body["hasMore"]:
                return items
            after = body["nextAfter"]

    def assert_replica_equals_authority(self, replica):
        classifications, assignments = self.authoritative_state()
        self.assertEqual(replica[0], classifications)
        self.assertEqual(replica[1], assignments)

    def test_a_replica_rebuilt_from_baseline_and_changes_equals_authority(self):
        baseline = self.baseline_pages()
        replica = self.adopt_baseline(baseline)
        self.assert_replica_equals_authority(replica)

        operations = [
            (classification_authority.CREATE, R1, {"classificationId": "new",
                                                   "kind": "root", "name": "새 분류",
                                                   "parentId": None, "iconKey": "book",
                                                   "colorKey": "green"}),
            (classification_authority.RENAME, R2, {"classificationId": "new",
                                                   "name": "바뀐 이름",
                                                   "expectedRevision": 1}),
            (classification_authority.MOVE, R3, {"classificationId": "new",
                                                 "parentId": ROOT,
                                                 "expectedRevision": 2}),
            (classification_authority.APPEARANCE, R4, {"classificationId": "new",
                                                       "iconKey": None,
                                                       "colorKey": "pink",
                                                       "expectedRevision": 3}),
            (classification_authority.ASSIGNMENT, R5, {"assetId": ASSET,
                                                       "classificationId": "new",
                                                       "expectedRevision": 0}),
            (classification_authority.ASSIGNMENT, R6, {"assetId": ASSET,
                                                       "classificationId": TAG,
                                                       "expectedRevision": 1}),
            (classification_authority.ASSIGNMENT, R7, {"assetId": ASSET2,
                                                       "classificationId": None,
                                                       "expectedRevision": 0}),
            (classification_authority.DELETE, R8, {"classificationId": TAG,
                                                   "expectedRevision": 1}),
        ]
        for command_type, operation_id, extra in operations:
            response = self.command(command_type, operation_id, **extra)
            self.assertEqual(response.status_code, 200, f"{command_type}: {response.text}")

        for change in self.fetch_all_changes():
            self.assertTrue(change.get("classification") or change.get("assignment"),
                            f"change {change['sequence']} carries no delta")
            self.apply_change(replica, change)
        self.assert_replica_equals_authority(replica)

    def test_a_delete_reassigns_through_the_log_without_a_point_read(self):
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=TAG, expectedRevision=0)
        baseline = self.baseline_pages()
        replica = self.adopt_baseline(baseline)
        self.command(classification_authority.DELETE, R2, classification_id=TAG,
                     expectedRevision=1)
        for change in self.fetch_all_changes():
            self.apply_change(replica, change)
        self.assert_replica_equals_authority(replica)
        # The whole effect arrived in the delete's own change row, and the moved
        # assignment is genuinely revision 2 because the transition said so.
        delete = [change for change in self.fetch_all_changes()
                  if change["commandType"] == classification_authority.DELETE][0]
        self.assertEqual(delete["assignmentTransition"],
                         {"fromClassificationId": TAG, "toClassificationId": WORK,
                          "affectsAssignments": 1})
        self.assertEqual(delete["classification"]["deleted"], True)
        self.assertEqual(replica[1][ASSET], (ASSET, WORK, 2))

    def test_each_change_row_is_self_contained(self):
        self.command(classification_authority.RENAME, R1, classification_id=OTHER,
                     name="바뀐 이름", expectedRevision=1)
        self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET,
                     classificationId=TAG, expectedRevision=0)
        self.command(classification_authority.DELETE, R3, classification_id=TAG,
                     expectedRevision=1)
        items = self.fetch_all_changes()
        structural = next(item for item in items if item["commandType"] ==
                          classification_authority.RENAME)
        self.assertEqual(set(structural["classification"]) >= {
            "id", "kind", "name", "parentId", "iconKey", "colorKey", "deleted",
            "entityRevision"}, True)
        self.assertNotIn("assignments", structural)
        assignment = next(item for item in items if item["commandType"] ==
                          classification_authority.ASSIGNMENT)
        self.assertEqual(assignment["assignment"],
                         {"assetId": ASSET, "classificationId": TAG,
                          "entityRevision": 1})
        # The delete row alone describes the tombstone and the whole transition, so a
        # replica never needs a second row (or a point read) to finish applying it.
        delete = next(item for item in items if item["commandType"] ==
                      classification_authority.DELETE)
        self.assertEqual(delete["classification"]["id"], TAG)
        self.assertEqual(delete["classification"]["deleted"], True)
        self.assertEqual(delete["assignmentTransition"],
                         {"fromClassificationId": TAG, "toClassificationId": WORK,
                          "affectsAssignments": 1})

    def test_an_untouched_asset_keeps_its_baseline_assignment(self):
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=WORK, expectedRevision=0)
        replica = self.adopt_baseline(self.baseline_pages())
        self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET2,
                     classificationId=TAG, expectedRevision=0)
        for change in self.fetch_all_changes():
            self.apply_change(replica, change)
        self.assert_replica_equals_authority(replica)
        self.assertEqual(replica[1][ASSET][1], WORK)


class DeleteAtomicityUnderPagingTests(ClassificationAuthorityFixture):
    """A delete's whole effect is one change row, so `/changes` cannot split it.

    Structure and assignment share one authority domain because a delete moves both.
    If the delete were emitted as one change row per affected assignment, a client
    reading `/changes?limit=` could commit a page where the Classification is already
    deleted while only some assignments had been reparented — a state the authority
    never held. These tests make the affected set much larger than the page limit and
    prove no externally committable partial state exists.
    """

    def setUp(self):
        super().setUp()
        self.activate()
        # 40 assignments on TAG — far more than the small page limit used below.
        self.assets = [f"20000000-0000-4000-8000-{index:012d}" for index in range(40)]
        with self.get_db() as db:
            db.executemany("INSERT OR IGNORE INTO assets(id,committed) VALUES(?,1)",
                           [(asset,) for asset in self.assets])
            db.commit()
        for index, asset in enumerate(self.assets):
            response = self.command(
                classification_authority.ASSIGNMENT,
                f"{index + 1:08x}-1111-4111-8111-111111111111",
                assetId=asset, classificationId=TAG, expectedRevision=0)
            self.assertEqual(response.status_code, 200, response.text)

    def test_many_assignments_do_not_split_the_delete(self):
        response = self.command(classification_authority.DELETE, R8,
                                classification_id=TAG, expectedRevision=1)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["assignmentTransition"]["affectsAssignments"], 40)
        # One sequence for the whole delete regardless of the affected count.
        self.assertEqual(body["changeSequence"], body["authorityCursor"])
        self.assertEqual(len(self.change_rows()), len(self.assets) + 1)

    def test_a_page_smaller_than_the_affected_set_cannot_expose_a_partial_delete(self):
        """Walk every page with limit=1 and prove each applied prefix is coherent."""
        response = self.command(classification_authority.DELETE, R8,
                                classification_id=TAG, expectedRevision=1)
        self.assertEqual(response.status_code, 200, response.text)
        transitions = []
        cursor = 0
        while True:
            page = self.changes(after=cursor, limit=1).json()
            for item in page["items"]:
                if item["commandType"] == classification_authority.DELETE:
                    transitions.append(item)
            cursor = page["nextAfter"]
            if not page["hasMore"]:
                break
        # The delete is visible on exactly one page, carrying its complete effect.
        self.assertEqual(len(transitions), 1)
        self.assertEqual(transitions[0]["assignmentTransition"]["affectsAssignments"], 40)
        with self.get_db() as db:
            remaining = db.execute(
                "SELECT COUNT(*) FROM classification_authority_assignments"
                " WHERE classification_id=?", [TAG]).fetchone()[0]
        # Server-side both halves happened together: nothing still names TAG.
        self.assertEqual(remaining, 0)

    def test_no_cursor_position_observes_the_tombstone_without_the_transition(self):
        """The invariant stated as a client sees it, at every prefix of the log."""
        self.command(classification_authority.DELETE, R8, classification_id=TAG,
                     expectedRevision=1)
        seen_tombstone = False
        cursor = 0
        while True:
            page = self.changes(after=cursor, limit=1).json()
            for item in page["items"]:
                if (item.get("classification") or {}).get("id") == TAG and \
                        item["classification"]["deleted"]:
                    seen_tombstone = True
                    # The same row must carry the whole assignment effect.
                    self.assertIn("assignmentTransition", item)
                    self.assertEqual(
                        item["assignmentTransition"]["affectsAssignments"], 40)
                if item.get("assignmentTransition") is not None:
                    self.assertTrue(seen_tombstone,
                                    "a transition must never precede its tombstone")
            cursor = page["nextAfter"]
            if not page["hasMore"]:
                break
        self.assertTrue(seen_tombstone)


class BaselineRoleTests(ClassificationAuthorityFixture):
    """The immutable `originals` role must be rebuildable from authority alone."""

    def test_a_complete_baseline_exposes_the_protected_role(self):
        self.activate()
        baseline = self.baseline_pages()
        self.assertEqual(baseline["roles"],
                         [{"role": "originals", "classificationId": ORIGINALS}])
        self.assertTrue(baseline["complete"])

    def test_every_page_of_one_frozen_baseline_reports_the_same_role(self):
        self.activate()
        for index, asset in enumerate((ASSET, ASSET2, ASSET3)):
            self.command(classification_authority.ASSIGNMENT, [R1, R2, R3][index],
                         assetId=asset, classificationId=TAG, expectedRevision=0)
        paged = self.baseline_pages(classifications_per_page=2, assignments_per_page=1)
        self.assertGreater(len(paged["pages"]), 4)
        for page in paged["pages"]:
            self.assertEqual(page["roles"],
                             [{"role": "originals", "classificationId": ORIGINALS}])
            self.assertEqual(page["snapshotCursor"], paged["snapshotCursor"])

    def test_the_role_cannot_change_through_commands(self):
        self.activate()
        before = self.baseline_pages()["roles"]
        # Every structural command that touches the protected node, plus a normal
        # rename elsewhere: none of them is a role mutation.
        for response in (
            self.command(classification_authority.RENAME, R1, classification_id=ORIGINALS,
                         name="바뀐 이름", expectedRevision=1),
            self.command(classification_authority.MOVE, R2, classification_id=ORIGINALS,
                         parentId=ROOT, expectedRevision=1),
            self.command(classification_authority.DELETE, R3, classification_id=ORIGINALS,
                         expectedRevision=1),
            self.command(classification_authority.APPEARANCE, R4,
                         classification_id=ORIGINALS, iconKey="star", colorKey="pink",
                         expectedRevision=1),
            self.command(classification_authority.RENAME, R5, classification_id=OTHER,
                         name="다른 이름", expectedRevision=1),
        ):
            self.assertEqual(response.status_code in (200, 409), True, response.text)
        self.assertEqual(self.baseline_pages()["roles"], before)
        self.assertEqual(self.role_rows(), [("originals", ORIGINALS)])
        # A role is never a change row: it has no command that could produce one.
        self.assertFalse([row for row in self.change_rows()
                          if row[1] not in classification_authority.COMMAND_TYPES])

    def test_baseline_reconstruction_retains_the_role(self):
        self.activate()
        self.command(classification_authority.DELETE, R1, classification_id=OTHER,
                     expectedRevision=1)
        baseline = self.baseline_pages()
        replica_role = baseline["roles"][0]
        self.assertEqual(replica_role["classificationId"], ORIGINALS)
        # The role still names a live classification the replica can resolve.
        self.assertIn(replica_role["classificationId"], baseline["classifications"])

    def test_an_empty_role_set_is_reported_as_empty_not_omitted(self):
        self.activate(roles=[])
        baseline = self.baseline_pages()
        self.assertEqual(baseline["roles"], [])
        self.assertIn("roles", baseline["pages"][0])


class CommandAuthorizationTests(ClassificationAuthorityFixture):
    """Structural commands are publisher-only in v1; assignment is a client operation.

    R2 leaves the character-series-into-originals rule to the PC, so the server cannot
    yet enforce every structural invariant. A non-PC client must therefore not be able
    to originate a structural mutation, and the legacy shared credential must not gain
    publisher capability.
    """

    def setUp(self):
        super().setUp()
        self.activate()

    def structural_bodies(self):
        return [
            (classification_authority.CREATE, {"classificationId": "new", "kind": "root",
                                               "name": "새 분류", "parentId": None,
                                               "iconKey": None, "colorKey": None}),
            (classification_authority.RENAME, {"classificationId": OTHER, "name": "이름",
                                               "expectedRevision": 1}),
            (classification_authority.MOVE, {"classificationId": TAG, "parentId": None,
                                             "expectedRevision": 1}),
            (classification_authority.DELETE, {"classificationId": OTHER,
                                               "expectedRevision": 1}),
            (classification_authority.APPEARANCE, {"classificationId": TAG,
                                                   "iconKey": "star", "colorKey": "pink",
                                                   "expectedRevision": 1}),
        ]

    def issue(self, command_type, fields, headers, operation_id=R1):
        body = {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
                "operationId": operation_id, "commandType": command_type, **fields}
        return self.client.put(COMMANDS, headers=headers, json=body)

    def test_an_ordinary_client_cannot_issue_structural_commands(self):
        for command_type, fields in self.structural_bodies():
            with self.subTest(command=command_type):
                response = self.issue(command_type, fields, self.auth)
                self.assertEqual(response.status_code, 401, response.text)
        # Nothing was accepted.
        self.assertEqual(self.change_rows(), [])
        self.assertEqual(self.cursor(), 0)
        self.assertEqual([row[0] for row in self.classification_rows()],
                         sorted([ROOT, WORK, TAG, OTHER, ORIGINALS]))

    def test_a_publisher_can_issue_structural_commands(self):
        """Each command runs against freshly created state, so revisions are unambiguous."""
        created = self.client.put(COMMANDS, headers=self.publisher_auth, json={
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
            "operationId": f"{1:08x}-2222-4222-8222-222222222222",
            "commandType": classification_authority.CREATE, "classificationId": "target",
            "kind": "root", "name": "대상", "parentId": None, "iconKey": None,
            "colorKey": None})
        self.assertEqual(created.status_code, 200, created.text)
        sequence = [
            (classification_authority.RENAME,
             {"classificationId": "target", "name": "이름", "expectedRevision": 1}),
            (classification_authority.APPEARANCE,
             {"classificationId": "target", "iconKey": "star", "colorKey": "pink",
              "expectedRevision": 2}),
            (classification_authority.MOVE,
             {"classificationId": "target", "parentId": ROOT, "expectedRevision": 3}),
        ]
        for index, (command_type, fields) in enumerate(sequence, start=2):
            with self.subTest(command=command_type):
                response = self.issue(
                    command_type, fields, self.publisher_auth,
                    operation_id=f"{index:08x}-2222-4222-8222-222222222222")
                self.assertEqual(response.status_code, 200, response.text)
        # The moved node derived a new kind, exactly as the PC does.
        self.assertEqual(
            [row for row in self.classification_rows() if row[0] == "target"][0][1], "tag")
        # And delete is publisher-only too, on a separate node.
        deleted = self.issue(classification_authority.DELETE,
                             {"classificationId": OTHER, "expectedRevision": 1},
                             self.publisher_auth,
                             operation_id=f"{6:08x}-2222-4222-8222-222222222222")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(deleted.json()["classification"]["deleted"], True)

    def test_a_publisher_structural_command_advances_the_cursor_once(self):
        response = self.issue(classification_authority.RENAME,
                              {"classificationId": OTHER, "name": "이름",
                               "expectedRevision": 1}, self.publisher_auth)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["authorityCursor"], 1)
        self.assertEqual(self.cursor(), 1)

    def test_an_ordinary_client_can_issue_assignment_commands(self):
        response = self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                                classificationId=TAG, expectedRevision=0,
                                headers=self.auth)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.assignment_rows(), [(ASSET, TAG, 1)])
        # Including the canonical unassigned state.
        cleared = self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET,
                               classificationId=None, expectedRevision=1,
                               headers=self.auth)
        self.assertEqual(cleared.status_code, 200, cleared.text)

    def test_a_publisher_can_also_issue_assignment_commands(self):
        response = self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                                classificationId=TAG, expectedRevision=0,
                                headers=self.publisher_auth)
        self.assertEqual(response.status_code, 200, response.text)

    def test_the_legacy_shared_credential_is_a_client_not_a_publisher(self):
        """The shared token must not gain publisher capability through this route."""
        shared = {"Authorization": "Bearer shared"}
        assignment = self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                                  classificationId=TAG, expectedRevision=0,
                                  headers=shared)
        self.assertEqual(assignment.status_code, 200, assignment.text)
        for command_type, fields in self.structural_bodies():
            with self.subTest(command=command_type):
                self.assertEqual(
                    self.issue(command_type, fields, shared).status_code, 401)

    def test_an_unknown_command_name_requires_publisher_before_validation(self):
        """An unrecognized command is not a client operation, and reveals nothing."""
        body = {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
                "operationId": R1, "commandType": "toggleClassification",
                "classificationId": OTHER}
        self.assertEqual(
            self.client.put(COMMANDS, headers=self.auth, json=body).status_code, 401)
        response = self.client.put(COMMANDS, headers=self.publisher_auth, json=body)
        self.assert_coded(response, 422, "unsupportedClassificationCommand")

    def test_an_unauthenticated_structural_command_is_rejected(self):
        for command_type, fields in self.structural_bodies():
            with self.subTest(command=command_type):
                self.assertEqual(
                    self.issue(command_type, fields, {}).status_code, 401)

    def test_authorization_precedes_envelope_validation(self):
        """A client must not be able to probe the structural command contract."""
        response = self.client.put(
            COMMANDS, headers=self.auth,
            json={"commandType": classification_authority.RENAME})
        self.assertEqual(response.status_code, 401, response.text)


class BaselineSnapshotCoherenceTests(ClassificationAuthorityFixture):
    """One baseline page must come from one SQLite read snapshot.

    Python's sqlite3 does not open a transaction for a bare SELECT in this
    configuration, so without an explicit read transaction a command could commit
    between the authority-cursor read and the page-state read. The response would then
    be labeled with an older `snapshotCursor` while carrying newer canonical state — a
    page describing a library state that never existed.
    """

    def setUp(self):
        super().setUp()
        self.activate()

    def capture_page_read(self, hook):
        """Wrap `classification_page` so a test can observe inside the page read."""
        real_page = classification_authority.classification_page
        calls = {"count": 0}

        def wrapper(db, library_id, after, limit):
            calls["count"] += 1
            hook(db)
            return real_page(db, library_id, after, limit)

        classification_authority.classification_page = wrapper
        return real_page, calls

    def test_the_cursor_read_and_page_state_read_share_one_transaction(self):
        """The fix, pinned directly: both reads happen inside an explicit transaction.

        Python's sqlite3 opens no transaction for a bare SELECT, so without `BEGIN` the
        cursor read and the page read are separate snapshots and a commit between them
        would be observable.
        """
        observed = {}

        def hook(db):
            observed["in_transaction"] = db.in_transaction

        real_page, calls = self.capture_page_read(hook)
        try:
            response = self.baseline()
        finally:
            classification_authority.classification_page = real_page
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(calls["count"], 1)
        self.assertTrue(observed["in_transaction"],
                        "the page-state read must run inside the read transaction")

    def test_a_mutation_attempted_during_the_page_read_cannot_be_mixed_into_it(self):
        """Force a writer commit between cursor acquisition and page materialization.

        The page must never combine an older `snapshotCursor` with newer canonical
        state. Whichever way the concurrent writer resolves — refused by the reader's
        shared lock in rollback-journal mode, or applied invisibly after the snapshot in
        WAL — the response has to describe exactly the frozen cursor's state.
        """
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=TAG, expectedRevision=0)
        frozen = self.baseline().json()["snapshotCursor"]
        self.assertEqual(frozen, 1)
        attempt = {}

        def hook(_db):
            # A genuinely separate connection and transaction: the concurrent writer.
            writer = sqlite3.connect(self.database, timeout=0.25)
            try:
                writer.row_factory = sqlite3.Row
                writer.execute("BEGIN IMMEDIATE")
                writer.execute(
                    "UPDATE classification_authority_state SET name=?,"
                    "entity_revision=entity_revision+1 WHERE classification_id=?",
                    ["동시 변경", OTHER])
                writer.execute("UPDATE authority_domains SET change_cursor=change_cursor+1"
                               " WHERE domain=?", [classification_authority.DOMAIN])
                writer.commit()
                attempt["committed"] = True
            except sqlite3.OperationalError as error:
                attempt["committed"] = False
                attempt["error"] = str(error)
                writer.rollback()
            finally:
                writer.close()

        real_page, calls = self.capture_page_read(hook)
        try:
            response = self.baseline(snapshot=str(frozen),
                                     section=classification_authority.CLASSIFICATIONS_SECTION)
        finally:
            classification_authority.classification_page = real_page
        self.assertEqual(calls["count"], 1, "the mutation hook must have run")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()

        # The response is coherent either way: it keeps the frozen cursor, and every row
        # it carries is the row that cursor described — never the newer state.
        self.assertEqual(body["snapshotCursor"], frozen)
        names = {item["id"]: item["name"] for item in body["items"]}
        self.assertEqual(names[OTHER], "만화",
                         "the page must not carry state from after the frozen cursor")
        revisions = {item["id"]: item["entityRevision"] for item in body["items"]}
        self.assertEqual(revisions[OTHER], 1,
                         "the page must not carry the concurrent writer's revision")
        if attempt["committed"]:
            # A commit did land, so the domain moved and the same frozen cursor must now
            # be refused rather than quietly serving the older rows.
            self.assert_coded(
                self.baseline(snapshot=str(frozen),
                              section=classification_authority.ASSIGNMENTS_SECTION),
                409, "baselineChanged")
        else:
            # The reader's transaction was still open, so the writer could not commit at
            # all — the page was never at risk of mixing two states. This is the
            # rollback-journal behaviour and it is the stronger form of the guarantee.
            self.assertIn("locked", attempt["error"])
            self.assertEqual(self.cursor(), frozen)
            self.assertEqual(
                self.baseline(snapshot=str(frozen),
                              section=classification_authority.ASSIGNMENTS_SECTION)
                .status_code, 200)

    def test_a_committed_rename_is_never_mixed_into_a_stale_snapshot_page(self):
        """The end-to-end shape of the bug: stale cursor label with fresh content."""
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=TAG, expectedRevision=0)
        frozen = self.baseline().json()["snapshotCursor"]
        self.command(classification_authority.RENAME, R2, classification_id=OTHER,
                     name="새 이름", expectedRevision=1)
        # The stale snapshot is refused, so no page can carry "새 이름" under it.
        detail = self.assert_coded(
            self.baseline(snapshot=str(frozen),
                          section=classification_authority.CLASSIFICATIONS_SECTION),
            409, "baselineChanged")
        self.assertEqual(detail["snapshotCursor"], frozen)
        self.assertEqual(detail["authorityCursor"], self.cursor())
        # A fresh walk sees the new name and is internally consistent.
        fresh = self.baseline_pages()
        self.assertEqual(fresh["classifications"][OTHER]["name"], "새 이름")

    def test_the_baseline_read_does_not_hold_a_write_lock(self):
        """The read transaction must not block a concurrent command."""
        with self.get_db() as db:
            db.execute("BEGIN")
            try:
                self.baseline()
            finally:
                db.rollback()
        self.assertEqual(
            self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                         classificationId=TAG, expectedRevision=0).status_code, 200)


class ChangesSnapshotCoherenceTests(ClassificationAuthorityFixture):
    """One `/changes` response must come from one SQLite read snapshot.

    The route reads four things: the authority identity, the advertised cursor, the
    retention floor and the change rows. Read without a transaction they are four
    separate autocommit snapshots, so a command can commit between them and the response
    then advertises the older cursor while carrying rows from the newer one. A replica
    cannot apply that coherently — it would be told `cursor = 1` with `nextAfter = 2`,
    which is the exact shape this class refuses.

    WAL is not a fix by itself: it gives each *statement* a snapshot, not a group of
    statements. This mirrors `BaselineSnapshotCoherenceTests`, which pins the same
    property for the baseline walk.
    """

    def setUp(self):
        super().setUp()
        self.activate()

    def capture_change_read(self, hook):
        """Wrap `change_items` so a test can observe inside the rows read."""
        real_items = classification_authority.change_items
        calls = {"count": 0}

        def wrapper(db, library_id, epoch, after, limit, ceiling=None):
            calls["count"] += 1
            hook(db)
            return real_items(db, library_id, epoch, after, limit, ceiling=ceiling)

        classification_authority.change_items = wrapper
        return real_items, calls

    def test_the_cursor_read_and_rows_read_share_one_transaction(self):
        """The fix, pinned directly: the rows read happens inside an explicit transaction."""
        observed = {}

        def hook(db):
            observed["in_transaction"] = db.in_transaction

        real_items, calls = self.capture_change_read(hook)
        try:
            response = self.changes()
        finally:
            classification_authority.change_items = real_items
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(calls["count"], 1)
        self.assertTrue(observed["in_transaction"],
                        "the change-rows read must run inside the read transaction")

    def test_a_commit_during_the_rows_read_can_never_exceed_the_advertised_cursor(self):
        """Force a writer commit between cursor acquisition and row materialization.

        The response must stay internally consistent — `nextAfter` can never exceed the
        `cursor` it advertises, because that would name a change the same response says
        does not exist yet.
        """
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=TAG, expectedRevision=0)
        attempt = {}

        def hook(_db):
            # A genuinely separate connection and transaction: the concurrent writer.
            writer = sqlite3.connect(self.database, timeout=0.25)
            try:
                writer.row_factory = sqlite3.Row
                writer.execute("BEGIN IMMEDIATE")
                writer.execute(
                    "UPDATE classification_authority_state SET name=?,"
                    "entity_revision=entity_revision+1 WHERE classification_id=?",
                    ["동시 변경", OTHER])
                writer.execute("UPDATE authority_domains SET change_cursor=change_cursor+1"
                               " WHERE domain=?", [classification_authority.DOMAIN])
                writer.execute(
                    "INSERT INTO classification_authority_changes(library_id,epoch,sequence,"
                    "command_type,classification_id,asset_id,entity_revision,operation_id,"
                    "payload,changed_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    [LIBRARY, 1, 2, classification_authority.ASSIGNMENT, None, ASSET, 2, R2,
                     json.dumps({"assetId": ASSET, "classificationId": TAG,
                                 "entityRevision": 2}), "2026-09-16T00:00:00Z"])
                writer.commit()
                attempt["committed"] = True
            except sqlite3.OperationalError as error:
                attempt["committed"] = False
                attempt["error"] = str(error)
                writer.rollback()
            finally:
                writer.close()

        real_items, calls = self.capture_change_read(hook)
        try:
            response = self.changes(after=0)
        finally:
            classification_authority.change_items = real_items
        self.assertEqual(calls["count"], 1, "the mutation hook must have run")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()

        # The invariant under test. It must hold whichever way the concurrent writer
        # resolved: refused by the reader's lock, or applied invisibly after the snapshot.
        self.assertLessEqual(
            body["nextAfter"], body["cursor"],
            "a response must never advertise a cursor its own rows already exceed")
        self.assertTrue(
            all(item["sequence"] <= body["cursor"] for item in body["items"]),
            "no returned row may sit beyond the advertised cursor")
        self.assertEqual(body["hasMore"], body["nextAfter"] < body["cursor"])
        if attempt["committed"]:
            # The commit landed after the snapshot, so the domain moved. The response is
            # the pre-commit state and must report itself as behind.
            self.assertEqual(body["cursor"], 1)
            self.assertEqual([item["sequence"] for item in body["items"]], [1])
        else:
            # The reader's transaction was still open, so the writer could not commit at
            # all — the stronger form of the guarantee.
            self.assertIn("locked", attempt["error"])

    def test_a_commit_after_the_snapshot_is_delivered_by_the_next_read(self):
        """No change may be lost or double-counted across the snapshot boundary."""
        self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                     classificationId=TAG, expectedRevision=0)
        first = self.changes(after=0).json()
        self.assertEqual(first["cursor"], 1)
        self.assertEqual([item["sequence"] for item in first["items"]], [1])
        self.assertFalse(first["hasMore"])

        # A second command advances the domain; the next read continues cleanly from the
        # cursor the first response advertised.
        self.assertEqual(
            self.command(classification_authority.ASSIGNMENT, R2, assetId=ASSET2,
                         classificationId=TAG, expectedRevision=0).status_code, 200)
        second = self.changes(after=first["nextAfter"]).json()
        self.assertEqual(second["cursor"], 2)
        self.assertEqual([item["sequence"] for item in second["items"]], [2])
        self.assertEqual(second["nextAfter"], 2)

    def test_the_rows_read_is_bounded_by_the_cursor_the_response_advertises(self):
        """The ceiling is a real bound, not a decorative argument.

        The explicit read transaction already makes a row beyond the advertised cursor
        unreachable, so this cannot be exercised through the route: it is pinned directly
        against the helper, which is the only place the bound lives. Without it, a later
        change that stopped reading inside the transaction would silently return rows the
        same response says do not exist yet.
        """
        for operation, asset in (("11111111-1111-4111-8111-000000000001", ASSET),
                                 ("22222222-2222-4222-8222-000000000002", ASSET2)):
            self.assertEqual(
                self.command(classification_authority.ASSIGNMENT, operation, assetId=asset,
                             classificationId=TAG, expectedRevision=0).status_code, 200)
        with self.get_db() as db:
            unbounded = classification_authority.change_items(db, LIBRARY, 1, 0, 100)
            ceilinged = classification_authority.change_items(db, LIBRARY, 1, 0, 100,
                                                              ceiling=1)
        self.assertEqual([item["sequence"] for item in unbounded], [1, 2])
        self.assertEqual([item["sequence"] for item in ceilinged], [1],
                         "a row beyond the advertised cursor must never be returned")

    def test_the_changes_read_does_not_hold_a_write_lock(self):
        """The read transaction must not block a concurrent command."""
        with self.get_db() as db:
            db.execute("BEGIN")
            try:
                self.changes()
            finally:
                db.rollback()
        self.assertEqual(
            self.command(classification_authority.ASSIGNMENT, R1, assetId=ASSET,
                         classificationId=TAG, expectedRevision=0).status_code, 200)


class BaselineBoundTests(unittest.TestCase):
    """Page sizes must keep the worst-case encoded page inside the response budget.

    The Android/native client reads at most 4 MiB per authenticated JSON response, so a
    page is only safe if maximum-length identifiers at the maximum page size fit.
    Measuring worst-case rows is what makes the constants evidence rather than a guess.
    """

    def encoded_bytes(self, section, items, roles=None):
        page = classification_authority.encode_page(
            "a" * 32, 1, 1, 0, section, items, None, False,
            roles if roles is not None else [{"role": "originals",
                                              "classificationId": "x" * 128}])
        return len(json.dumps(page, separators=(",", ":"), ensure_ascii=False).encode())

    def test_the_largest_classification_page_fits_the_budget(self):
        items = [{"id": "x" * 128, "kind": "tag", "name": "가" * classification_authority.MAX_NAME,
                  "parentId": "y" * 128, "iconKey": "academic-cap", "colorKey": "purple",
                  "entityRevision": 999_999}
                 for _ in range(classification_authority.MAX_CLASSIFICATION_PAGE)]
        self.assertLess(self.encoded_bytes(classification_authority.CLASSIFICATIONS_SECTION,
                                           items),
                        classification_authority.MAX_BASELINE_PAGE_BYTES)

    def test_the_largest_assignment_page_fits_the_budget(self):
        items = [{"assetId": "y" * 128, "classificationId": "x" * 128,
                  "entityRevision": 999_999}
                 for _ in range(classification_authority.MAX_ASSIGNMENT_PAGE)]
        self.assertLess(self.encoded_bytes(classification_authority.ASSIGNMENTS_SECTION,
                                           items),
                        classification_authority.MAX_BASELINE_PAGE_BYTES)

    def test_an_oversized_page_fails_explicitly_rather_than_truncating(self):
        items = [{"assetId": "y" * 128, "classificationId": "x" * 128, "entityRevision": 1}
                 for _ in range(classification_authority.MAX_ASSIGNMENT_PAGE * 50)]
        with self.assertRaises(HTTPException) as raised:
            self.encoded_bytes(classification_authority.ASSIGNMENTS_SECTION, items)
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail["code"], "baselinePageTooLarge")

    def test_the_role_projection_cannot_push_a_page_over_budget(self):
        """A role set is tiny and bounded, so carrying it per page stays safe.

        The schema's `CHECK(role IN ('originals'))` bounds the set to one row in v1, so
        the worst case is a single maximum-length id — measured here rather than assumed.
        """
        roles = [{"role": "originals", "classificationId": "x" * 128}]
        items = [{"assetId": "y" * 128, "classificationId": "x" * 128,
                  "entityRevision": 999_999}
                 for _ in range(classification_authority.MAX_ASSIGNMENT_PAGE)]
        with_roles = self.encoded_bytes(classification_authority.ASSIGNMENTS_SECTION,
                                        items, roles)
        without_roles = self.encoded_bytes(classification_authority.ASSIGNMENTS_SECTION,
                                           items, [])
        self.assertLess(with_roles, classification_authority.MAX_BASELINE_PAGE_BYTES)
        # The role projection costs a small constant, not a second section.
        self.assertLess(with_roles - without_roles, 256)

    def test_the_page_budget_stays_inside_the_native_response_budget(self):
        self.assertLess(classification_authority.MAX_BASELINE_PAGE_BYTES, 4 * 1024 * 1024)

    def test_the_documented_maxima_are_servable_by_paging(self):
        self.assertGreaterEqual(classification_authority.MAX_CLASSIFICATION_PAGE,
                               classification_authority.DEFAULT_CLASSIFICATION_PAGE)
        self.assertGreaterEqual(classification_authority.MAX_ASSIGNMENT_PAGE,
                               classification_authority.DEFAULT_ASSIGNMENT_PAGE)

    def test_the_measured_library_is_servable_by_paging(self):
        """The active library (58 classifications / 8,907 assignments, read read-only)
        must be retrievable, and its assignment set must genuinely need more than one
        page — which is why the unpaginated Album-style single response is not enough
        for this domain.
        """
        classifications, assignments = 58, 8_907
        self.assertLessEqual(
            classifications / classification_authority.MAX_CLASSIFICATION_PAGE, 1)
        self.assertGreater(
            assignments / classification_authority.MAX_ASSIGNMENT_PAGE, 1,
            "the measured library must require assignment paging")
        pages = -(-assignments // classification_authority.MAX_ASSIGNMENT_PAGE)
        self.assertLess(pages, 100, "the walk must stay bounded")


class AppearanceContractTests(unittest.TestCase):
    def test_icon_and_color_keys_match_the_pc_appearance_contract(self):
        """The server must reject exactly what the PC UI cannot render.

        `_tools/app/src-tauri/src/library/folder_appearance.rs` is the PC's source of
        truth, and `library/classification.rs` validates through it. Comparing the
        lists here is what keeps a server-side acceptance from becoming an unrenderable
        client value.
        """
        source = (Path(__file__).resolve().parents[3]
                  / "_tools/app/src-tauri/src/library/folder_appearance.rs").read_text()
        for name, expected in (("ICON_KEYS", classification_authority.ICON_KEYS),
                               ("COLOR_KEYS", classification_authority.COLOR_KEYS)):
            start = source.index(f"const {name}")
            block = source[start:source.index("];", start)]
            literal = block.split("= [", 1)[1]
            found = tuple(part.strip().strip('"') for part in literal.split(",")
                          if part.strip().strip('"'))
            self.assertEqual(found, expected, name)


class KindContractTests(unittest.TestCase):
    def test_the_kind_set_matches_the_pc_classification_check_constraint(self):
        """`kind IN ('root','work','tag')` is the PC schema's own constraint.

        The line is located inside the `classification_entries` block rather than by a
        file-wide search, because migration 0001 declares other `CHECK(... IN (...))`
        constraints (for example on `assets.media_kind`) that would match first.
        """
        source = (Path(__file__).resolve().parents[3]
                  / "_tools/app/src-tauri/migrations/0001_initial.sql").read_text()
        block = source[source.index("CREATE TABLE classification_entries"):
                       source.index("CREATE TABLE asset_classifications")]
        line = next(line for line in block.splitlines() if "kind TEXT NOT NULL CHECK" in line)
        self.assertEqual(
            tuple(part.strip().strip("'") for part in
                  line.split("IN (", 1)[1].split(")", 1)[0].split(",")),
            classification_authority.KINDS)


if __name__ == "__main__":
    unittest.main()
