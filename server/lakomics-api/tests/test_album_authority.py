"""Album authority: baseline, activation, fence, command and replay contracts.

These tests pin the properties ADR-0037 requires for Album to be the second
server-authoritative domain. The recurring hazards are:

* activation replacing state nobody re-validated, or activating state that does not
  belong to the staged snapshot;
* a legacy snapshot overwriting server state after cut-over;
* a stale structural or membership edit silently winning;
* "absent from a delta" being read as a deletion;
* one domain's cursor advancing while another's is disturbed;
* a baseline that stops being recoverable once the domain grows.

The fixture writes the legacy snapshot through the shipped route and activates
through the publisher-only route, so the fence under test is the real one.
"""
import copy
import json
import sqlite3
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import album_authority
import api_auth
import authority
import catalog_bookmarks
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

LIBRARY = "a" * 32
OTHER_LIBRARY = "b" * 32
SNAPSHOT = "/v1/library/album-snapshot"
BASELINE = "/v1/albums/baseline"
CHANGES = "/v1/albums/changes"
COMMANDS = "/v1/albums/commands"
ACTIVATE = "/v1/albums/authority/activate"

R1 = "11111111-1111-4111-8111-111111111111"
R2 = "22222222-2222-4222-8222-222222222222"
R3 = "33333333-3333-4333-8333-333333333333"
R4 = "44444444-4444-4444-8444-444444444444"
R5 = "55555555-5555-4555-8555-555555555555"
R6 = "66666666-6666-4666-8666-666666666666"
R7 = "77777777-7777-4777-8777-777777777777"

ASSET = "20000000-0000-4000-8000-000000000001"
ASSET2 = "20000000-0000-4000-8000-000000000002"
ASSET3 = "20000000-0000-4000-8000-000000000003"


def fixture_snapshot(version=album_authority.SNAPSHOT_VERSION, appearance=True,
                     memberships=None, media=None):
    """The Album snapshot a PC publisher sends.

    Version 3 is authority-ready: it carries appearance on every Album *and* the
    canonical membership collection, which is separate from the normal-visible display
    `media` array. Versions 1 and 2 are the older display shapes.
    """
    albums = [
        {"id": "root", "name": "업로드용", "parent_id": None},
        {"id": "child", "name": "임시", "parent_id": "root"},
        {"id": "other", "name": "Other", "parent_id": None},
    ]
    if appearance:
        albums[0].update(icon_key="folder", color_key="blue")
        albums[1].update(icon_key=None, color_key=None)
        albums[2].update(icon_key="star", color_key="red")
    body = {
        "published_at": "2026-09-15T00:00:00Z",
        "albums": albums,
        "media": (media if media is not None else
                  [{"id": ASSET, "date": 12345, "width": 100, "height": 100,
                    "duration": 0, "albums": ["child", "root"]}]),
    }
    if version is not None:
        body["snapshotVersion"] = version
    if version is not None and version >= album_authority.SNAPSHOT_VERSION:
        body["memberships"] = (memberships if memberships is not None else
                               [{"albumId": "child", "assetId": ASSET},
                                {"albumId": "root", "assetId": ASSET}])
    return body


class AlbumAuthorityFixture(unittest.TestCase):
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
        catalog_bookmarks.startup(get_db)
        album_authority.startup(get_db)
        with get_db() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, committed INTEGER NOT NULL DEFAULT 1)")
            db.execute(
                "CREATE TABLE IF NOT EXISTS album_replica(singleton INTEGER PRIMARY KEY"
                " CHECK(singleton=1), payload TEXT NOT NULL, published_at TEXT NOT NULL)")
            db.executemany("INSERT OR IGNORE INTO assets(id,committed) VALUES(?,1)",
                           [(ASSET,), (ASSET2,), (ASSET3,)])
            _, self.publisher_token = api_auth.provision_token(db, "publisher", "albums")
            _, self.client_token = api_auth.provision_token(db, "client", "albums")
            db.commit()
        self.app = FastAPI()
        # The legacy snapshot route is registered here in the same shape the shipped
        # `app.py` uses, so the fence under test is the real one: it validates the
        # versioned shape, calls `authority.fence_legacy_write` inside the transaction
        # that replaces the replica, and returns the stored snapshot digest.
        @self.app.put(SNAPSHOT)
        def publish_album_replica(request_body: dict, authorization: str | None = Header(default=None)):
            api_auth.publisher_guard(get_db)(authorization)
            version = request_body.get("snapshotVersion", 1)
            if version not in (1, 2, album_authority.SNAPSHOT_VERSION):
                raise HTTPException(422, {"code": "unsupportedAlbumSnapshotVersion"})
            for album in request_body["albums"]:
                if version >= 2 and not album_authority.valid_appearance(
                        album.get("icon_key"), album.get("color_key")):
                    raise HTTPException(400, "Invalid album appearance")
            if version >= album_authority.SNAPSHOT_VERSION and "memberships" not in request_body:
                # An absent canonical set is not an empty set: the publisher must state
                # it, exactly as the production route requires.
                raise HTTPException(422, {"code": "missingAlbumMemberships"})
            stored = {"snapshotVersion": version, "albums": request_body["albums"],
                      "media": request_body.get("media", []),
                      "memberships": request_body.get("memberships", [])}
            payload = json.dumps(stored, separators=(",", ":"), sort_keys=True)
            published = request_body["published_at"]
            with get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                authority.fence_legacy_write(db, album_authority.DOMAIN)
                old = db.execute("SELECT published_at FROM album_replica WHERE singleton=1").fetchone()
                if old and old["published_at"] > published:
                    raise HTTPException(409, "Stale album snapshot")
                db.execute(
                    "INSERT INTO album_replica VALUES (1,?,?) ON CONFLICT(singleton)"
                    " DO UPDATE SET payload=excluded.payload,published_at=excluded.published_at",
                    (payload, published))
                db.commit()
                return {"ok": True, "snapshotVersion": version,
                        "snapshotDigest": album_authority.stored_snapshot_digest(db)}

        album_authority.register_album_authority(
            self.app, get_db, api_auth.client_guard(get_db, "shared"),
            api_auth.publisher_guard(get_db))
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    @property
    def publisher(self):
        return {"Authorization": f"Bearer {self.publisher_token}"}

    @property
    def client_auth(self):
        return {"Authorization": f"Bearer {self.client_token}"}

    # -- legacy publisher ------------------------------------------------

    def publish(self, snapshot=None):
        return self.client.put(SNAPSHOT, headers=self.publisher,
                               json=snapshot or fixture_snapshot())

    def snapshot_digest(self, snapshot=None):
        """Digest of the snapshot as stored, computed the way the server does."""
        stub = snapshot or fixture_snapshot()
        stored = {"snapshotVersion": stub.get("snapshotVersion", 1),
                  "albums": stub["albums"], "media": stub.get("media", []),
                  "memberships": stub.get("memberships", [])}
        return album_authority.digest(stored)

    # -- activation ------------------------------------------------------

    def activate(self, body=None, headers=None):
        """Activate, defaulting to the digest of the currently staged snapshot."""
        if body is None:
            body = {"libraryId": LIBRARY, "expectedSnapshotDigest": self.snapshot_digest()}
        return self.client.post(ACTIVATE, headers=self.publisher if headers is None else headers,
                                json=body)

    # -- reads -----------------------------------------------------------

    def baseline_pages(self, library_id=LIBRARY, epoch=1, albums_per_page=None,
                       memberships_per_page=None, headers=None):
        """Walk every baseline page and return the reconstructed state.

        This is how a client is required to consume the baseline: it must request all
        sections/pages against one frozen snapshot cursor before adopting anything.
        """
        params = {"libraryId": library_id, "epoch": str(epoch)}
        if albums_per_page:
            params["limit"] = str(albums_per_page)
        albums, memberships = {}, {}
        page = self.client.get(BASELINE, params=params, headers=headers or self.client_auth)
        if page.status_code != 200:
            return page, None
        body = page.json()
        snapshot = body["snapshotCursor"]
        assert body["section"] == album_authority.ALBUMS_SECTION
        pages = [body]
        while True:
            for item in body["items"]:
                albums[item["id"]] = item
            if not body["hasMore"]:
                break
            following = dict(params, snapshot=str(snapshot),
                             section=album_authority.ALBUMS_SECTION, after=body["nextAfter"])
            body = self.client.get(BASELINE, params=following, headers=headers or self.client_auth).json()
            pages.append(body)
        memberships_params = dict(params, snapshot=str(snapshot),
                                  section=album_authority.MEMBERSHIPS_SECTION)
        if memberships_per_page:
            memberships_params["limit"] = str(memberships_per_page)
        body = self.client.get(BASELINE, params=memberships_params,
                               headers=headers or self.client_auth).json()
        pages.append(body)
        while True:
            for item in body["items"]:
                memberships[(item["albumId"], item["assetId"])] = item
            if not body["hasMore"]:
                break
            following = dict(memberships_params, after=body["nextAfter"])
            body = self.client.get(BASELINE, params=following,
                                   headers=headers or self.client_auth).json()
            pages.append(body)
        return None, {"snapshotCursor": snapshot, "albums": albums,
                      "memberships": memberships,
                      "complete": pages[-1]["complete"], "pages": pages}

    def baseline(self, library_id=LIBRARY, epoch=1, headers=None):
        """The first baseline page only, for shape assertions."""
        return self.client.get(BASELINE,
                               params={"libraryId": library_id, "epoch": str(epoch)},
                               headers=headers or self.client_auth)

    def changes(self, after=0, limit=100, epoch=1, library_id=LIBRARY):
        return self.client.get(
            CHANGES, params={"libraryId": library_id, "epoch": str(epoch), "after": str(after),
                             "limit": str(limit)}, headers=self.client_auth)

    def command(self, command_type, operation_id=R1, album_id="root", **extra):
        body = {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
                "operationId": operation_id, "commandType": command_type,
                "albumId": album_id}
        body.update(extra)
        return self.client.put(COMMANDS, headers=self.client_auth, json=body)

    def authority_rows(self):
        with self.get_db() as db:
            return [tuple(row) for row in db.execute(
                "SELECT library_id,domain,epoch,contract_version,change_cursor"
                " FROM authority_domains ORDER BY domain")]

    def album_rows(self):
        with self.get_db() as db:
            return [tuple(row) for row in db.execute(
                "SELECT album_id,name,parent_id,icon_key,color_key,deleted,entity_revision"
                " FROM album_authority_state ORDER BY album_id")]

    def member_rows(self):
        with self.get_db() as db:
            return [tuple(row) for row in db.execute(
                "SELECT album_id,asset_id,desired_state,entity_revision"
                " FROM album_authority_members ORDER BY album_id,asset_id")]

    def change_rows(self):
        with self.get_db() as db:
            return [tuple(row) for row in db.execute(
                "SELECT sequence,command_type,album_id,asset_id,entity_revision,operation_id"
                " FROM album_authority_changes ORDER BY sequence")]

    def cursor(self, domain=album_authority.DOMAIN):
        with self.get_db() as db:
            row = db.execute("SELECT change_cursor FROM authority_domains WHERE domain=?",
                             [domain]).fetchone()
            return row[0] if row else None


class InactiveAlbumAuthorityTests(AlbumAuthorityFixture):
    def test_legacy_route_is_unchanged_with_zero_authority_rows(self):
        response = self.publish()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.authority_rows(), [])
        with self.get_db() as db:
            self.assertIsNotNone(db.execute(
                "SELECT payload FROM album_replica WHERE singleton=1").fetchone())

    def test_a_version_1_publisher_is_still_accepted_before_cutover(self):
        """Older PC publishers must keep working; only activation needs version 2."""
        response = self.publish(fixture_snapshot(version=None, appearance=False))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["snapshotVersion"], 1)

    def test_reads_report_inactive_without_faking_an_empty_baseline(self):
        self.publish()
        for response in (self.baseline(), self.changes()):
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"]["code"],
                             authority.CODE_AUTHORITY_INACTIVE)

    def test_startup_activates_nothing(self):
        self.assertEqual(self.authority_rows(), [])
        self.assertEqual(self.album_rows(), [])


class ActivationBindingTests(AlbumAuthorityFixture):
    """Activation must be bound to the staged snapshot, not to caller-supplied state."""

    def test_activation_derives_state_from_the_stored_snapshot_only(self):
        response = self.publish()
        self.assertEqual(response.status_code, 200, response.text)
        digest = response.json()["snapshotDigest"]
        activated = self.activate({"libraryId": LIBRARY, "expectedSnapshotDigest": digest})
        self.assertEqual(activated.status_code, 200, activated.text)
        body = activated.json()
        self.assertEqual((body["libraryId"], body["epoch"], body["contractVersion"],
                          body["cursor"], body["snapshotVersion"]), (LIBRARY, 1, 1, 0, 3))
        self.assertEqual((body["albumCount"], body["membershipCount"]), (3, 2))
        self.assertEqual(self.album_rows(), [
            ("child", "임시", "root", None, None, 0, 1),
            ("other", "Other", None, "star", "red", 0, 1),
            ("root", "업로드용", None, "folder", "blue", 0, 1),
        ])
        self.assertEqual(self.member_rows(), [
            ("child", ASSET, 1, 1), ("root", ASSET, 1, 1)])

    def test_state_b_cannot_be_substituted_for_staged_snapshot_a(self):
        """The reproduced exploit: A's digest with unrelated canonical state B.

        The activation body carries no hierarchy or membership at all, so there is no
        way to propose B. Extra content is rejected outright.
        """
        self.publish()
        digest = self.snapshot_digest()
        substituted = {
            "libraryId": LIBRARY,
            "expectedSnapshotDigest": digest,
            # Exactly the shape the pre-fix contract accepted.
            "albums": [{"id": "evil", "name": "Attacker", "parentId": None,
                        "iconKey": None, "colorKey": None}],
            "memberships": [{"albumId": "evil", "assetId": ASSET}],
        }
        response = self.activate(substituted)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], "invalidAlbumBaseline")
        self.assertEqual(self.authority_rows(), [])
        self.assertEqual(self.album_rows(), [])

        # The legitimate activation of A still works and yields A's state.
        self.assertEqual(self.activate().status_code, 200)
        self.assertEqual({row[0] for row in self.album_rows()}, {"root", "child", "other"})

    def test_activation_requires_the_digest_of_the_snapshot_actually_stored(self):
        self.publish()
        response = self.activate({"libraryId": LIBRARY, "expectedSnapshotDigest": "0" * 64})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "albumBaselineChanged")
        self.assertEqual(self.authority_rows(), [])

    def test_a_version_1_snapshot_is_not_authority_ready(self):
        """Appearance and canonical membership are canonical; version 1 has neither.

        Defaulting to `null` would silently replace real PC appearance, so activation
        fails explicitly instead.
        """
        self.publish(fixture_snapshot(version=None, appearance=False))
        response = self.activate({"libraryId": LIBRARY,
                                  "expectedSnapshotDigest": self.snapshot_digest(
                                      fixture_snapshot(version=None, appearance=False))})
        self.assertEqual(response.status_code, 409, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], "albumSnapshotNotAuthorityReady")
        self.assertEqual((detail["snapshotVersion"], detail["requiredVersion"]), (1, 3))
        self.assertEqual(self.authority_rows(), [])

    def test_an_unknown_snapshot_version_is_rejected_at_publication(self):
        response = self.publish(fixture_snapshot(version=99))
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], "unsupportedAlbumSnapshotVersion")


class ActivationTests(AlbumAuthorityFixture):
    def test_invalid_hierarchy_is_rejected_before_activation(self):
        # Each case is a version-3 (authority-ready) snapshot whose *canonical*
        # membership is what must be rejected, so the failure is about the content
        # rather than about the snapshot version.
        cases = {
            "self-parent": ([{"id": "a", "name": "A", "parent_id": "a",
                              "icon_key": None, "color_key": None}], []),
            "missing-parent": ([{"id": "a", "name": "A", "parent_id": "ghost",
                                 "icon_key": None, "color_key": None}], []),
            "cycle": ([{"id": "a", "name": "A", "parent_id": "b", "icon_key": None, "color_key": None},
                       {"id": "b", "name": "B", "parent_id": "a", "icon_key": None, "color_key": None}], []),
            "duplicate-sibling-name": ([
                {"id": "a", "name": "Same", "parent_id": None, "icon_key": None, "color_key": None},
                {"id": "b", "name": "same", "parent_id": None, "icon_key": None, "color_key": None}], []),
            "empty-name": ([{"id": "a", "name": "   ", "parent_id": None,
                             "icon_key": None, "color_key": None}], []),
            "duplicate-id": ([{"id": "a", "name": "A", "parent_id": None, "icon_key": None, "color_key": None},
                              {"id": "a", "name": "B", "parent_id": None, "icon_key": None, "color_key": None}], []),
            "unknown-album-membership": ([{"id": "a", "name": "A", "parent_id": None,
                                           "icon_key": None, "color_key": None}],
                                         [{"albumId": "ghost", "assetId": ASSET}]),
            "membership-without-albumId-key": ([{"id": "a", "name": "A", "parent_id": None,
                                                 "icon_key": None, "color_key": None}],
                                               [{"album_id": "a", "asset_id": ASSET}]),
        }
        for label, (albums, memberships) in cases.items():
            with self.subTest(case=label):
                snapshot = {"published_at": "2026-09-15T00:01:00Z", "snapshotVersion": 3,
                            "albums": albums, "media": [], "memberships": memberships}
                self.publish(snapshot)
                response = self.activate({"libraryId": LIBRARY,
                                          "expectedSnapshotDigest": self.snapshot_digest(snapshot)})
                self.assertEqual(response.status_code, 422, f"{label}: {response.text}")
                self.assertEqual(self.authority_rows(), [], label)

    def test_a_version_3_snapshot_without_canonical_membership_is_rejected(self):
        """The field must be explicit: an absent set is not an empty set."""
        snapshot = fixture_snapshot()
        del snapshot["memberships"]
        response = self.publish(snapshot)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], "missingAlbumMemberships")
        with self.get_db() as db:
            self.assertIsNone(db.execute(
                "SELECT payload FROM album_replica WHERE singleton=1").fetchone())
        self.assertEqual(self.authority_rows(), [])

    def test_an_unrenderable_appearance_is_rejected_at_publication(self):
        """The value is canonical state, so it is refused before it can be stored."""
        response = self.publish({"published_at": "2026-09-15T00:01:00Z", "snapshotVersion": 2,
                                 "albums": [{"id": "a", "name": "A", "parent_id": None,
                                             "icon_key": "not-an-icon", "color_key": None}],
                                 "media": []})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.status_code, 400, response.text)
        with self.get_db() as db:
            self.assertIsNone(db.execute(
                "SELECT payload FROM album_replica WHERE singleton=1").fetchone())

    def test_activation_retains_membership_for_asset_not_yet_materialized_on_server(self):
        snapshot = fixture_snapshot(memberships=[{"albumId": "root",
                                                  "assetId": "no-such-asset"}])
        self.publish(snapshot)
        response = self.activate({"libraryId": LIBRARY,
                                  "expectedSnapshotDigest": self.snapshot_digest(snapshot)})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["membershipCount"], 1)
        self.assertEqual(self.member_rows(), [("root", "no-such-asset", 1, 1)])
        error, baseline = self.baseline_pages()
        self.assertIsNone(error)
        self.assertEqual(baseline["memberships"][("root", "no-such-asset")], {
            "albumId": "root", "assetId": "no-such-asset",
            "desiredState": True, "entityRevision": 1})

    def test_identical_retry_is_idempotent_and_a_different_second_is_rejected(self):
        self.publish()
        body = {"libraryId": LIBRARY, "expectedSnapshotDigest": self.snapshot_digest()}
        first = self.activate(body)
        self.assertEqual(first.status_code, 200, first.text)
        rows_after_first = (self.album_rows(), self.member_rows(), self.authority_rows())

        retry = self.activate(body)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json(), first.json())
        self.assertEqual((self.album_rows(), self.member_rows(), self.authority_rows()),
                         rows_after_first)

        # A genuinely different baseline (a new publication) cannot re-activate.
        changed = fixture_snapshot()
        changed["published_at"] = "2026-09-15T00:10:00Z"
        changed["albums"][2]["name"] = "Renamed by PC"
        self.assertEqual(self.publish(changed).status_code, 409)
        self.assertEqual((self.album_rows(), self.member_rows(), self.authority_rows()),
                         rows_after_first)

    def test_activation_requires_publisher_authority(self):
        self.publish()
        self.assertEqual(self.activate(headers=self.client_auth).status_code, 401)
        self.assertEqual(self.activate(headers={}).status_code, 401)


class FenceTests(AlbumAuthorityFixture):
    def legacy_after_activation(self):
        snapshot = copy.deepcopy(fixture_snapshot())
        snapshot["published_at"] = "2026-09-15T00:05:00Z"
        return snapshot

    def test_activation_and_the_legacy_fence_are_atomic(self):
        self.publish()
        self.activate()
        response = self.publish(self.legacy_after_activation())
        self.assertEqual(response.status_code, 409, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], authority.CODE_LEGACY_WRITER_FENCED)
        self.assertEqual(detail["domain"], album_authority.DOMAIN)
        self.assertEqual(detail["epoch"], 1)

    def test_the_fenced_write_leaves_replica_and_authority_state_untouched(self):
        self.publish()
        self.activate()
        with self.get_db() as db:
            before = db.execute(
                "SELECT payload,published_at FROM album_replica WHERE singleton=1").fetchone()
        before_authority = self.authority_rows()
        self.assertEqual(self.publish(self.legacy_after_activation()).status_code, 409)
        with self.get_db() as db:
            after = db.execute(
                "SELECT payload,published_at FROM album_replica WHERE singleton=1").fetchone()
        self.assertEqual(tuple(after), tuple(before))
        self.assertEqual(self.authority_rows(), before_authority)

    def test_a_different_library_cannot_bypass_the_fence(self):
        self.publish()
        self.activate()
        response = self.activate({"libraryId": OTHER_LIBRARY,
                                  "expectedSnapshotDigest": self.snapshot_digest()})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn(response.json()["detail"]["code"],
                      {"albumAuthorityActive", "albumBaselineChanged", "authorityLibraryMismatch"})
        self.assertEqual(self.publish(self.legacy_after_activation()).status_code, 409)


class CommandTests(AlbumAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.publish()
        self.activate()

    def test_create_rename_appearance_move_membership_delete_flow(self):
        created = self.command(album_authority.CREATE, R1, album_id="new",
                               name=" 새 앨범 ", parentId="root", iconKey="book", colorKey="green")
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["album"], {
            "id": "new", "name": "새 앨범", "parentId": "root", "iconKey": "book",
            "colorKey": "green", "deleted": False, "entityRevision": 1})

        renamed = self.command(album_authority.RENAME, R2, album_id="new",
                               name="바뀐 이름", expectedRevision=1)
        self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertEqual(renamed.json()["album"]["name"], "바뀐 이름")
        self.assertEqual(renamed.json()["album"]["entityRevision"], 2)

        appearance = self.command(album_authority.APPEARANCE, R3, album_id="new",
                                  iconKey=None, colorKey="pink", expectedRevision=2)
        self.assertEqual(appearance.json()["album"]["iconKey"], None)
        self.assertEqual(appearance.json()["album"]["colorKey"], "pink")

        moved = self.command(album_authority.MOVE, R4, album_id="new", parentId=None,
                             expectedRevision=3)
        self.assertEqual(moved.status_code, 200, moved.text)
        self.assertEqual(moved.json()["album"]["parentId"], None)

        add = self.command(album_authority.MEMBERSHIP, R5, album_id="new", assetId=ASSET2,
                           desiredState=True, expectedRevision=0)
        self.assertEqual(add.status_code, 200, add.text)
        self.assertEqual(add.json()["membership"], {"albumId": "new", "assetId": ASSET2,
                                                   "desiredState": True, "entityRevision": 1})

        remove = self.command(album_authority.MEMBERSHIP, R6, album_id="new", assetId=ASSET2,
                              desiredState=False, expectedRevision=1)
        self.assertEqual(remove.status_code, 200, remove.text)
        self.assertEqual(remove.json()["membership"]["entityRevision"], 2)
        self.assertEqual([row for row in self.member_rows() if row[0] == "new"],
                         [("new", ASSET2, 0, 2)])

        deleted = self.command(album_authority.DELETE, R7, album_id="new", expectedRevision=4)
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertTrue(deleted.json()["album"]["deleted"])
        self.assertEqual(deleted.json()["album"]["entityRevision"], 5)

    def test_new_membership_command_still_requires_a_committed_asset(self):
        response = self.command(album_authority.MEMBERSHIP, R1, album_id="other",
                                assetId="no-such-asset", desiredState=True,
                                expectedRevision=0)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], "invalidAlbumMembership")
        self.assertNotIn(("other", "no-such-asset", 1, 1), self.member_rows())

    def test_every_mutation_appends_one_change_and_advances_only_its_own_cursor(self):
        with self.get_db() as db:
            db.execute(
                "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,"
                "change_cursor,baseline_digest,baseline_revision,activated_at)"
                " VALUES(?,?,1,1,7,?,NULL,'2026-09-15T00:00:00Z')",
                [LIBRARY, catalog_bookmarks.DOMAIN, "d" * 64])
            db.commit()
        bookmark_cursor_before = self.cursor(catalog_bookmarks.DOMAIN)

        self.assertEqual(self.command(album_authority.RENAME, R1, album_id="other",
                                      name="Renamed", expectedRevision=1).status_code, 200)
        self.assertEqual(self.command(album_authority.MEMBERSHIP, R2, album_id="other",
                                      assetId=ASSET2, desiredState=True,
                                      expectedRevision=0).status_code, 200)

        self.assertEqual(self.cursor(), 2)
        self.assertEqual(self.cursor(catalog_bookmarks.DOMAIN), bookmark_cursor_before)
        self.assertEqual([row[0] for row in self.change_rows()], [1, 2])
        self.assertEqual([row[1] for row in self.change_rows()],
                         [album_authority.RENAME, album_authority.MEMBERSHIP])

    def test_retry_after_a_lost_response_applies_exactly_once(self):
        first = self.command(album_authority.RENAME, R1, album_id="other",
                             name="Once", expectedRevision=1)
        retry = self.command(album_authority.RENAME, R1, album_id="other",
                             name="Once", expectedRevision=1)
        self.assertEqual(retry.json(), first.json())
        self.assertEqual(len(self.change_rows()), 1)
        self.assertEqual(self.cursor(), 1)

    def test_operation_id_reuse_with_another_payload_conflicts(self):
        self.assertEqual(self.command(album_authority.RENAME, R1, album_id="other",
                                      name="First", expectedRevision=1).status_code, 200)
        reuse = self.command(album_authority.RENAME, R1, album_id="other",
                             name="Second", expectedRevision=1)
        self.assertEqual(reuse.status_code, 409, reuse.text)
        self.assertEqual(reuse.json()["detail"]["code"], "operationConflict")
        self.assertEqual(len(self.change_rows()), 1)

    def test_stale_structural_edits_conflict_and_do_not_overwrite(self):
        self.assertEqual(self.command(album_authority.RENAME, R1, album_id="other",
                                      name="Newer", expectedRevision=1).status_code, 200)
        for command_type, extra in [
            (album_authority.RENAME, {"name": "Stale"}),
            (album_authority.MOVE, {"parentId": "root"}),
            (album_authority.DELETE, {}),
        ]:
            with self.subTest(command=command_type):
                response = self.command(command_type, R2, album_id="other",
                                        expectedRevision=1, **extra)
                self.assertEqual(response.status_code, 409, response.text)
                detail = response.json()["detail"]
                self.assertEqual(detail["code"], "revisionConflict")
                self.assertEqual(detail["current"]["entityRevision"], 2)
                self.assertEqual(detail["current"]["name"], "Newer")
        self.assertEqual(len(self.change_rows()), 1)

    def test_duplicate_sibling_name_is_a_naming_error_not_a_revision_conflict(self):
        """A valid current revision with a taken name must not be reported as stale.

        Conflating the two would tell the user to rebase when the real fix is a
        different name, matching the PC's own distinction.
        """
        created = self.command(album_authority.CREATE, R1, album_id="new",
                               name="Taken", parentId=None, iconKey=None, colorKey=None)
        self.assertEqual(created.status_code, 200, created.text)

        rename = self.command(album_authority.RENAME, R2, album_id="other",
                              name="Taken", expectedRevision=1)
        self.assertEqual(rename.status_code, 409, rename.text)
        self.assertEqual(rename.json()["detail"]["code"], "duplicateAlbumName")

        # `dup` is named like `child` but sits under `other`; moving it under `root`
        # would create two siblings with the same name at a valid current revision.
        created_dup = self.command(album_authority.CREATE, R3, album_id="dup",
                                   name="임시", parentId="other", iconKey=None, colorKey=None)
        self.assertEqual(created_dup.status_code, 200, created_dup.text)
        move = self.command(album_authority.MOVE, R4, album_id="dup", parentId="root",
                            expectedRevision=1)
        self.assertEqual(move.status_code, 409, move.text)
        self.assertEqual(move.json()["detail"]["code"], "duplicateAlbumName")

    def test_move_rejects_self_and_descendant_cycles(self):
        self.assertEqual(self.command(album_authority.MOVE, R1, album_id="root",
                                      parentId="root", expectedRevision=1).status_code, 422)
        response = self.command(album_authority.MOVE, R1, album_id="root",
                                parentId="child", expectedRevision=1)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], "albumCycle")
        self.assertEqual(self.change_rows(), [])

    def test_delete_rejects_an_album_with_children(self):
        response = self.command(album_authority.DELETE, R1, album_id="root", expectedRevision=1)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "albumHasChildren")

    def test_commands_require_authentication_and_validate_their_envelope(self):
        self.assertEqual(self.client.put(COMMANDS, json={"commandType":
                         album_authority.RENAME}).status_code, 401)

        def envelope(**overrides):
            body = {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
                    "operationId": R1, "commandType": album_authority.RENAME,
                    "albumId": "other", "name": "X", "expectedRevision": 1}
            body.update(overrides)
            return body

        unknown = envelope(commandType="notACommand")
        del unknown["name"], unknown["expectedRevision"]
        self.assertEqual(self.client.put(COMMANDS, headers=self.client_auth,
                                         json=unknown).status_code, 422)
        self.assertEqual(self.client.put(COMMANDS, headers=self.client_auth,
                                         json=envelope(extra=1)).status_code, 422)
        response = self.client.put(COMMANDS, headers=self.client_auth, json=envelope(epoch=2))
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"],
                         authority.CODE_AUTHORITY_LIBRARY_MISMATCH)

    def test_commands_are_rejected_while_the_domain_is_inactive(self):
        with self.get_db() as db:
            db.execute("DELETE FROM authority_domains WHERE domain=?", [album_authority.DOMAIN])
            db.commit()
        response = self.command(album_authority.RENAME, R1, album_id="other", name="X",
                                expectedRevision=1)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], authority.CODE_AUTHORITY_INACTIVE)


class CursorSemanticsTests(AlbumAuthorityFixture):
    """`authorityCursor` is the cursor *after* acceptance, not before it."""

    def setUp(self):
        super().setUp()
        self.publish()
        self.activate()

    def test_changed_command_reports_its_own_acceptance_cursor(self):
        first = self.command(album_authority.RENAME, R1, album_id="other",
                             name="A", expectedRevision=1)
        self.assertEqual(first.json()["changeSequence"], 1)
        self.assertEqual(first.json()["authorityCursor"], 1)

        second = self.command(album_authority.MEMBERSHIP, R2, album_id="other",
                              assetId=ASSET2, desiredState=True, expectedRevision=0)
        self.assertEqual(second.json()["changeSequence"], 2)
        self.assertEqual(second.json()["authorityCursor"], 2)
        self.assertEqual(self.cursor(), 2)

    def test_noop_command_reports_the_existing_cursor(self):
        self.assertEqual(self.command(album_authority.RENAME, R1, album_id="other",
                                      name="A", expectedRevision=1).json()["authorityCursor"], 1)
        # `other` is a member of nothing yet, so removing is already satisfied.
        noop = self.command(album_authority.MEMBERSHIP, R2, album_id="other",
                            assetId=ASSET3, desiredState=False, expectedRevision=0)
        self.assertEqual(noop.status_code, 200, noop.text)
        body = noop.json()
        self.assertFalse(body["changed"])
        self.assertIsNone(body["changeSequence"])
        self.assertEqual(body["authorityCursor"], 1)
        self.assertEqual(self.cursor(), 1)

    def test_a_lost_response_retry_returns_the_corrected_recorded_cursor(self):
        first = self.command(album_authority.RENAME, R1, album_id="other",
                             name="A", expectedRevision=1)
        # A later command moves the domain cursor; the recorded result must keep
        # describing its own acceptance time rather than the current cursor.
        self.assertEqual(self.command(album_authority.RENAME, R2, album_id="child",
                                      name="B", expectedRevision=1).status_code, 200)
        self.assertEqual(self.cursor(), 2)

        retry = self.command(album_authority.RENAME, R1, album_id="other",
                             name="A", expectedRevision=1)
        self.assertEqual(retry.json(), first.json())
        self.assertEqual(retry.json()["authorityCursor"], 1)
        self.assertEqual(retry.json()["changeSequence"], 1)

    def test_a_receipt_records_the_acceptance_cursor(self):
        self.assertEqual(self.command(album_authority.RENAME, R1, album_id="other",
                                      name="A", expectedRevision=1).status_code, 200)
        with self.get_db() as db:
            stored = json.loads(db.execute(
                "SELECT result_payload FROM album_authority_receipts WHERE operation_id=?",
                [R1]).fetchone()[0])
        self.assertEqual(stored["authorityCursor"], 1)
        self.assertEqual(stored["changeSequence"], 1)


class MembershipRevisionTests(AlbumAuthorityFixture):
    """Membership is its own revision lineage, separate from the Album entity."""

    def setUp(self):
        super().setUp()
        self.publish()
        self.activate()

    def test_never_seen_relation_has_revision_zero(self):
        add = self.command(album_authority.MEMBERSHIP, R1, album_id="other",
                           assetId=ASSET3, desiredState=True, expectedRevision=0)
        self.assertEqual(add.status_code, 200, add.text)
        self.assertEqual(add.json()["membership"]["entityRevision"], 1)

        stale = self.command(album_authority.MEMBERSHIP, R2, album_id="other",
                             assetId=ASSET3, desiredState=False, expectedRevision=0)
        self.assertEqual(stale.status_code, 409, stale.text)
        detail = stale.json()["detail"]
        self.assertEqual(detail["code"], "revisionConflict")
        self.assertEqual(detail["current"], {"albumId": "other", "assetId": ASSET3,
                                             "desiredState": True, "entityRevision": 1})

    def test_concurrent_opposite_edits_surface_a_conflict_not_last_write_wins(self):
        self.assertEqual(self.command(album_authority.MEMBERSHIP, R1, album_id="other",
                                      assetId=ASSET3, desiredState=True,
                                      expectedRevision=0).status_code, 200)
        # Device A removes using revision 1; device B also removes using revision 1.
        self.assertEqual(self.command(album_authority.MEMBERSHIP, R2, album_id="other",
                                      assetId=ASSET3, desiredState=False,
                                      expectedRevision=1).status_code, 200)
        loser = self.command(album_authority.MEMBERSHIP, R3, album_id="other",
                             assetId=ASSET3, desiredState=True, expectedRevision=1)
        self.assertEqual(loser.status_code, 409, loser.text)
        detail = loser.json()["detail"]
        self.assertEqual(detail["code"], "revisionConflict")
        self.assertFalse(detail["current"]["desiredState"])
        self.assertEqual(detail["current"]["entityRevision"], 2)
        # The tombstone revision is retained, so a later add can be composed safely.
        self.assertEqual([row for row in self.member_rows() if row[1] == ASSET3],
                         [("other", ASSET3, 0, 2)])

    def test_removal_retains_tombstone_revision_for_a_later_add(self):
        self.assertEqual(self.command(album_authority.MEMBERSHIP, R1, album_id="other",
                                      assetId=ASSET3, desiredState=True,
                                      expectedRevision=0).status_code, 200)
        self.assertEqual(self.command(album_authority.MEMBERSHIP, R2, album_id="other",
                                      assetId=ASSET3, desiredState=False,
                                      expectedRevision=1).status_code, 200)
        # Composing the re-add from the tombstone's revision is accepted.
        readd = self.command(album_authority.MEMBERSHIP, R3, album_id="other",
                             assetId=ASSET3, desiredState=True, expectedRevision=2)
        self.assertEqual(readd.status_code, 200, readd.text)
        self.assertEqual(readd.json()["membership"]["entityRevision"], 3)

    def test_an_album_revision_cannot_be_reused_as_a_membership_revision(self):
        """The two lineages are independent, so presenting the wrong one conflicts."""
        renamed = self.command(album_authority.RENAME, R1, album_id="other",
                               name="Renamed", expectedRevision=1)
        self.assertEqual(renamed.json()["album"]["entityRevision"], 2)
        # `other` has no relation yet: its membership revision is 0, not the Album's 2.
        wrong = self.command(album_authority.MEMBERSHIP, R2, album_id="other",
                             assetId=ASSET3, desiredState=True, expectedRevision=2)
        self.assertEqual(wrong.status_code, 409, wrong.text)
        detail = wrong.json()["detail"]
        self.assertEqual(detail["code"], "revisionConflict")
        self.assertEqual(detail["current"]["entityRevision"], 0)

    def test_an_already_satisfied_desired_state_is_receipted_without_a_change(self):
        add = self.command(album_authority.MEMBERSHIP, R1, album_id="other",
                           assetId=ASSET3, desiredState=True, expectedRevision=0)
        self.assertTrue(add.json()["changed"])
        noop = self.command(album_authority.MEMBERSHIP, R2, album_id="other",
                            assetId=ASSET3, desiredState=True, expectedRevision=0)
        self.assertEqual(noop.status_code, 200, noop.text)
        self.assertFalse(noop.json()["changed"])
        self.assertEqual(noop.json()["membership"]["entityRevision"], 1)
        self.assertEqual(len(self.change_rows()), 1)
        self.assertEqual(self.cursor(), 1)

    def test_a_membership_mutation_does_not_bump_the_album_revision(self):
        before = [row for row in self.album_rows() if row[0] == "other"][0]
        self.assertEqual(self.command(album_authority.MEMBERSHIP, R1, album_id="other",
                                      assetId=ASSET3, desiredState=True,
                                      expectedRevision=0).status_code, 200)
        after = [row for row in self.album_rows() if row[0] == "other"][0]
        self.assertEqual(after, before)


class ReplayEquivalenceTests(AlbumAuthorityFixture):
    """A client must be able to rebuild authority state from baseline + changes."""

    def setUp(self):
        super().setUp()
        self.publish()
        self.activate()

    def authoritative_state(self):
        """The canonical state as the server holds it, in replica form.

        Tombstones are included on both sides: the server retains them so a later
        command can present their revision, so a replica that dropped them would
        differ from authority for a reason that is not a replay bug.
        """
        with self.get_db() as db:
            albums = {row["album_id"]: album_authority.album_projection(row) for row in db.execute(
                "SELECT album_id,name,parent_id,icon_key,color_key,deleted,entity_revision"
                " FROM album_authority_state WHERE library_id=?", [LIBRARY])}
            memberships = {(row["album_id"], row["asset_id"]): album_authority.membership_projection(
                row["album_id"], row["asset_id"], row["desired_state"], row["entity_revision"])
                for row in db.execute(
                    "SELECT album_id,asset_id,desired_state,entity_revision"
                    " FROM album_authority_members WHERE library_id=?", [LIBRARY])}
        return albums, memberships

    def apply_change(self, replica, change):
        """Apply exactly one change row, using only the row's own contents."""
        albums, memberships = replica
        if change.get("album") is not None:
            album = change["album"]
            # The tombstone is retained, not dropped: a later command must be able to
            # present that revision, which is exactly why the server keeps it too.
            albums[album["id"]] = album
            if album["deleted"]:
                # Deleting an Album removes its memberships. The tombstone states that,
                # so the replica applies it from the same change rather than inferring
                # anything from absence.
                for key in [key for key in memberships if key[0] == album["id"]]:
                    memberships[key] = {**memberships[key], "desiredState": False}
        else:
            membership = change["membership"]
            memberships[(membership["albumId"], membership["assetId"])] = membership
        return replica

    def fetch_all_changes(self, after=0):
        items = []
        while True:
            body = self.changes(after=after).json()
            items.extend(body["items"])
            if not body["hasMore"]:
                return items
            after = body["nextAfter"]

    def test_a_replica_rebuilt_from_baseline_and_changes_equals_authority(self):
        error, baseline = self.baseline_pages()
        self.assertIsNone(error)
        self.assertTrue(baseline["complete"])
        replica = self.adopt_baseline(baseline)
        self.assertEqual(self.apply_and_compare(replica, 0), [])

        operations = [
            (album_authority.CREATE, R1, {"albumId": "new", "name": "새 앨범",
                                          "parentId": "root", "iconKey": "book",
                                          "colorKey": "green"}),
            (album_authority.RENAME, R2, {"albumId": "new", "name": "바뀐 이름",
                                          "expectedRevision": 1}),
            (album_authority.MOVE, R3, {"albumId": "new", "parentId": None,
                                        "expectedRevision": 2}),
            (album_authority.APPEARANCE, R4, {"albumId": "new", "iconKey": None,
                                              "colorKey": "pink", "expectedRevision": 3}),
            (album_authority.MEMBERSHIP, R5, {"albumId": "new", "assetId": ASSET2,
                                              "desiredState": True, "expectedRevision": 0}),
            (album_authority.MEMBERSHIP, R6, {"albumId": "new", "assetId": ASSET2,
                                              "desiredState": False, "expectedRevision": 1}),
            (album_authority.MEMBERSHIP, R7, {"albumId": "root", "assetId": ASSET3,
                                              "desiredState": True, "expectedRevision": 0}),
            (album_authority.DELETE, "88888888-8888-4888-8888-888888888888",
             {"albumId": "other", "expectedRevision": 1}),
        ]
        for command_type, operation_id, extra in operations:
            response = self.command(command_type, operation_id, **extra)
            self.assertEqual(response.status_code, 200, f"{command_type}: {response.text}")

        self.assertEqual(self.apply_and_compare(replica, 0), [])

    def apply_and_compare(self, replica, after):
        """Replay every change row into the replica and diff against authority."""
        changes = self.fetch_all_changes(after)
        for change in changes:
            self.assertIsNotNone(change.get("album") or change.get("membership"),
                                 f"change {change['sequence']} carries no delta")
            self.apply_change(replica, change)
        albums, memberships = self.authoritative_state()
        mismatches = []
        for album_id, expected in albums.items():
            if replica[0].get(album_id) != expected:
                mismatches.append(("album", album_id, replica[0].get(album_id), expected))
        for album_id in replica[0]:
            if album_id not in albums:
                mismatches.append(("album-extra", album_id, replica[0][album_id], None))
        for key, expected in memberships.items():
            if replica[1].get(key) != expected:
                mismatches.append(("membership", key, replica[1].get(key), expected))
        for key in replica[1]:
            if key not in memberships:
                mismatches.append(("membership-extra", key, replica[1][key], None))
        return mismatches

    def adopt_baseline(self, baseline):
        """The replica state a client holds immediately after adopting a baseline.

        A baseline describes live state only, so an album or membership the baseline
        omits is simply not known yet; the first authoritative change that mentions it
        establishes it. That is why the comparison is only meaningful after replay.
        """
        return ({album["id"]: {"id": album["id"], "name": album["name"],
                               "parentId": album["parentId"], "iconKey": album["iconKey"],
                               "colorKey": album["colorKey"], "deleted": False,
                               "entityRevision": album["entityRevision"]}
                 for album in baseline["albums"].values()},
                {key: membership for key, membership in baseline["memberships"].items()})

    def test_each_change_row_is_self_contained(self):
        self.assertEqual(self.command(album_authority.RENAME, R1, album_id="other",
                                      name="Renamed", expectedRevision=1).status_code, 200)
        self.assertEqual(self.command(album_authority.MEMBERSHIP, R2, album_id="other",
                                      assetId=ASSET2, desiredState=True,
                                      expectedRevision=0).status_code, 200)
        items = self.fetch_all_changes()
        structural, membership = items[0], items[1]
        self.assertEqual(structural["album"], {
            "id": "other", "name": "Renamed", "parentId": None, "iconKey": "star",
            "colorKey": "red", "deleted": False, "entityRevision": 2})
        self.assertEqual(membership["membership"], {
            "albumId": "other", "assetId": ASSET2, "desiredState": True,
            "entityRevision": 1})
        # The change row also identifies itself and its acceptance cursor.
        self.assertEqual((structural["sequence"], structural["authorityCursor"],
                          structural["commandType"], structural["operationId"]),
                         (1, 1, album_authority.RENAME, R1))
        self.assertNotIn("payload", structural)

    def test_a_deletion_replay_removes_the_album_and_its_memberships(self):
        # Adopt the baseline first, then delete: a client that adopted state while the
        # album existed learns about the deletion only from the change log, which is
        # exactly the case this test must cover.
        error, baseline = self.baseline_pages()
        self.assertIsNone(error)
        replica = self.adopt_baseline(baseline)
        self.assertIn("child", replica[0])
        self.assertIn(("child", ASSET), replica[1])
        self.assertEqual(self.apply_and_compare(replica, baseline["snapshotCursor"]), [])

        self.assertEqual(self.command(album_authority.DELETE, R1, album_id="child",
                                      expectedRevision=1).status_code, 200)

        self.assertEqual(self.apply_and_compare(replica, baseline["snapshotCursor"]), [])
        # The tombstone is retained and states the deletion explicitly.
        self.assertTrue(replica[0]["child"]["deleted"])
        self.assertFalse(replica[1][("child", ASSET)]["desiredState"])
        # A fresh baseline no longer lists the deleted album or its membership.
        error, fresh = self.baseline_pages()
        self.assertIsNone(error)
        self.assertNotIn("child", fresh["albums"])
        self.assertNotIn(("child", ASSET), fresh["memberships"])


class ChangeLogTests(AlbumAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.publish()
        self.activate()

    def test_changes_replay_accepted_mutations_in_order(self):
        self.assertEqual(self.command(album_authority.RENAME, R1, album_id="other",
                                      name="A", expectedRevision=1).status_code, 200)
        self.assertEqual(self.command(album_authority.MEMBERSHIP, R2, album_id="other",
                                      assetId=ASSET2, desiredState=True,
                                      expectedRevision=0).status_code, 200)
        body = self.changes().json()
        self.assertEqual((body["cursor"], body["nextAfter"], body["hasMore"]), (2, 2, False))
        self.assertEqual([item["sequence"] for item in body["items"]], [1, 2])
        self.assertEqual([item["commandType"] for item in body["items"]],
                         [album_authority.RENAME, album_authority.MEMBERSHIP])
        self.assertEqual(self.changes(after=1).json()["items"][0]["sequence"], 2)
        self.assertEqual(self.changes(after=2).json()["items"], [])

    def test_a_cursor_ahead_of_the_authority_is_its_own_state(self):
        response = self.changes(after=99)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "cursorAhead")

    def test_cursor_expiry_demands_a_fresh_baseline(self):
        self.assertEqual(self.command(album_authority.RENAME, R1, album_id="other",
                                      name="A", expectedRevision=1).status_code, 200)
        with self.get_db() as db:
            db.execute("DELETE FROM album_authority_changes WHERE sequence=1")
            db.execute("UPDATE album_authority_retention SET pruned_through=1"
                       " WHERE library_id=? AND epoch=1", [LIBRARY])
            db.commit()
        response = self.changes(after=0)
        self.assertEqual(response.status_code, 409, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], authority.CODE_CURSOR_EXPIRED)
        self.assertEqual(detail["authorityCursor"], 1)
        error, baseline = self.baseline_pages()
        self.assertIsNone(error)
        self.assertTrue(baseline["complete"])

    def test_changes_require_authentication_and_reject_a_library_mismatch(self):
        self.assertEqual(self.client.get(CHANGES, params={
            "libraryId": LIBRARY, "epoch": "1", "after": "0", "limit": "10"}).status_code, 401)
        response = self.changes(library_id=OTHER_LIBRARY)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"],
                         authority.CODE_AUTHORITY_LIBRARY_MISMATCH)


class BaselinePagingTests(AlbumAuthorityFixture):
    """The baseline stays recoverable at the documented maxima, over bounded pages."""

    def setUp(self):
        super().setUp()

    def activate_with_memberships(self, count):
        """Publish and activate a snapshot carrying exactly `count` memberships.

        The count is the real membership count, not capped by a small fixture: the
        point of these tests is the documented maximum.
        """
        album_ids = ["bulk"]
        media = [{"id": f"asset-{index:07d}", "date": index, "width": 1, "height": 1,
                  "duration": 0, "albums": album_ids} for index in range(count)]
        with self.get_db() as db:
            db.executemany("INSERT OR IGNORE INTO assets(id,committed) VALUES(?,1)",
                           [(entry["id"],) for entry in media])
            db.commit()
        snapshot = {"snapshotVersion": 3, "published_at": "2026-09-15T00:00:00Z",
                    "albums": [{"id": "bulk", "name": "Bulk", "parent_id": None,
                                "icon_key": None, "color_key": None}],
                    "media": media,
                    "memberships": [{"albumId": "bulk", "assetId": entry["id"]}
                                    for entry in media]}
        self.assertEqual(self.publish(snapshot).status_code, 200)
        response = self.activate({"libraryId": LIBRARY,
                                  "expectedSnapshotDigest": self.snapshot_digest(snapshot)})
        self.assertEqual(response.status_code, 200, response.text)
        return len(media)

    def test_album_baseline_items_explicitly_mark_live_projection(self):
        self.activate_with_memberships(0)
        page = self.baseline().json()
        self.assertEqual(page["section"], album_authority.ALBUMS_SECTION)
        self.assertTrue(page["items"])
        for item in page["items"]:
            self.assertIn("deleted", item)
            self.assertFalse(item["deleted"])

    def test_a_fresh_baseline_exposes_a_tombstone_revision_for_a_later_readd(self):
        """The exact false-conflict sequence this change fixes.

        Add then remove leaves tombstone revision 2. A client that adopts a baseline
        afterwards must be able to compose the re-add from revision 2; if the baseline
        hid the tombstone it could only present 0 and would be told, wrongly, that its
        edit was stale.
        """
        self.activate_with_memberships(0)
        added = self.command(album_authority.MEMBERSHIP, R1, album_id="bulk",
                             assetId=ASSET, desiredState=True, expectedRevision=0)
        self.assertEqual(added.status_code, 200, added.text)
        self.assertEqual(added.json()["membership"]["entityRevision"], 1)
        removed = self.command(album_authority.MEMBERSHIP, R2, album_id="bulk",
                               assetId=ASSET, desiredState=False, expectedRevision=1)
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(removed.json()["membership"]["entityRevision"], 2)

        # A fresh client adopts the baseline only now.
        error, baseline = self.baseline_pages()
        self.assertIsNone(error)
        self.assertTrue(baseline["complete"])
        tombstone = baseline["memberships"][("bulk", ASSET)]
        self.assertFalse(tombstone["desiredState"])
        self.assertEqual(tombstone["entityRevision"], 2)

        readd = self.command(album_authority.MEMBERSHIP, R3, album_id="bulk",
                             assetId=ASSET, desiredState=True, expectedRevision=2)
        self.assertEqual(readd.status_code, 200, readd.text)
        self.assertEqual(readd.json()["membership"]["entityRevision"], 3)

    def test_a_baseline_tombstone_is_not_visible_album_membership(self):
        """Tombstone rows carry revisions; only `desiredState: true` is membership."""
        self.activate_with_memberships(0)
        self.assertEqual(self.command(album_authority.MEMBERSHIP, R1, album_id="bulk",
                                      assetId=ASSET, desiredState=True,
                                      expectedRevision=0).status_code, 200)
        self.assertEqual(self.command(album_authority.MEMBERSHIP, R2, album_id="bulk",
                                      assetId=ASSET, desiredState=False,
                                      expectedRevision=1).status_code, 200)
        error, baseline = self.baseline_pages()
        self.assertIsNone(error)
        live = {key for key, item in baseline["memberships"].items() if item["desiredState"]}
        self.assertNotIn(("bulk", ASSET), live)
        # The row is still present, which is the point: revision state, not membership.
        self.assertIn(("bulk", ASSET), baseline["memberships"])

    def test_a_large_membership_baseline_is_retrievable_over_bounded_pages(self):
        count = self.activate_with_memberships(album_authority.MAX_MEMBERSHIPS)
        error, baseline = self.baseline_pages(albums_per_page=1, memberships_per_page=2_000)
        self.assertIsNone(error)
        self.assertTrue(baseline["complete"])
        self.assertEqual(len(baseline["memberships"]), count)
        self.assertGreater(len(baseline["pages"]), 2)
        # Every page stays inside the response budget, so no client has to accept a
        # truncated page or an oversized response.
        for page in baseline["pages"]:
            encoded = len(json.dumps(page, separators=(",", ":"),
                                     ensure_ascii=False).encode())
            self.assertLess(encoded, album_authority.MAX_BASELINE_PAGE_BYTES, page["section"])

    def test_no_page_subset_looks_like_a_complete_baseline(self):
        self.activate_with_memberships(5)
        first = self.baseline().json()
        self.assertEqual(first["section"], album_authority.ALBUMS_SECTION)
        # Only the final membership page may claim completeness.
        self.assertFalse(first["complete"])
        memberships = self.client.get(BASELINE, params={
            "libraryId": LIBRARY, "epoch": "1", "snapshot": str(first["snapshotCursor"]),
            "section": album_authority.MEMBERSHIPS_SECTION, "limit": "2"},
            headers=self.client_auth).json()
        self.assertTrue(memberships["hasMore"])
        self.assertFalse(memberships["complete"])

    def test_a_mutation_between_pages_invalidates_the_frozen_baseline(self):
        self.activate_with_memberships(5)
        first = self.baseline().json()
        snapshot = first["snapshotCursor"]
        self.assertEqual(self.command(album_authority.RENAME, R1, album_id="bulk",
                                      name="Changed", expectedRevision=1).status_code, 200)
        response = self.client.get(BASELINE, params={
            "libraryId": LIBRARY, "epoch": "1", "snapshot": str(snapshot),
            "section": album_authority.ALBUMS_SECTION}, headers=self.client_auth)
        self.assertEqual(response.status_code, 409, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], "baselineChanged")
        self.assertEqual(detail["snapshotCursor"], snapshot)
        self.assertEqual(detail["authorityCursor"], 1)
        # A fresh walk against the new cursor succeeds and is complete.
        error, fresh = self.baseline_pages()
        self.assertIsNone(error)
        self.assertTrue(fresh["complete"])
        self.assertEqual(fresh["albums"]["bulk"]["name"], "Changed")

    def test_a_page_after_completion_is_still_bounded_and_explicit(self):
        self.activate_with_memberships(3)
        error, baseline = self.baseline_pages()
        self.assertIsNone(error)
        # Reading past the end returns an explicit empty page, never a silent subset.
        page = self.client.get(BASELINE, params={
            "libraryId": LIBRARY, "epoch": "1", "snapshot": str(baseline["snapshotCursor"]),
            "section": album_authority.MEMBERSHIPS_SECTION, "after": "zzz:"},
            headers=self.client_auth).json()
        self.assertEqual(page["items"], [])
        self.assertFalse(page["hasMore"])
        self.assertTrue(page["complete"])

    def test_baseline_and_changes_require_authentication(self):
        self.publish()
        self.activate()
        self.assertEqual(self.client.get(BASELINE, params={
            "libraryId": LIBRARY, "epoch": "1"}).status_code, 401)
        response = self.baseline(library_id=OTHER_LIBRARY)
        self.assertEqual(response.status_code, 409, response.text)


class TrashMembershipPreservationTests(AlbumAuthorityFixture):
    """Canonical membership must not follow an Asset's display status.

    A trashed Asset keeps its `asset_albums` relations locally, and the product
    contract is that restoring it returns its Albums. Deriving canonical membership
    from the display `media` array would silently drop those relations at activation.
    """

    TRASHED = "20000000-0000-4000-8000-0000000000ff"

    def setUp(self):
        super().setUp()
        with self.get_db() as db:
            db.execute("INSERT OR IGNORE INTO assets(id,committed) VALUES(?,1)", (self.TRASHED,))
            db.commit()

    def staged(self, media_assets, canonical_pairs):
        """A version-3 snapshot whose display set and canonical set differ."""
        return {
            "snapshotVersion": 3,
            "published_at": "2026-09-15T00:00:00Z",
            "albums": [{"id": "root", "name": "업로드용", "parent_id": None,
                        "icon_key": "folder", "color_key": "blue"}],
            # The display array carries normal-visible Assets only.
            "media": [{"id": asset, "date": 1, "width": 1, "height": 1, "duration": 0,
                       "albums": ["root"]} for asset in media_assets],
            "memberships": [{"albumId": album_id, "assetId": asset_id}
                            for album_id, asset_id in canonical_pairs],
        }

    def test_a_trashed_assets_membership_is_staged_and_activated(self):
        snapshot = self.staged(media_assets=[ASSET],
                               canonical_pairs=[("root", ASSET), ("root", self.TRASHED)])
        self.assertEqual(self.publish(snapshot).status_code, 200)
        activated = self.activate({"libraryId": LIBRARY,
                                   "expectedSnapshotDigest": self.snapshot_digest(snapshot)})
        self.assertEqual(activated.status_code, 200, activated.text)
        self.assertEqual(activated.json()["membershipCount"], 2)
        self.assertEqual(self.member_rows(), [
            ("root", ASSET, 1, 1), ("root", self.TRASHED, 1, 1)])

    def test_activation_ignores_the_display_media_array_for_canonical_membership(self):
        """A display-only relation is not canonical membership, and vice versa."""
        snapshot = self.staged(media_assets=[ASSET, ASSET2],
                              canonical_pairs=[("root", ASSET2)])
        self.assertEqual(self.publish(snapshot).status_code, 200)
        self.assertEqual(self.activate({"libraryId": LIBRARY,
                                        "expectedSnapshotDigest": self.snapshot_digest(snapshot)}
                                       ).status_code, 200)
        # Exactly the canonical set, not the display set.
        self.assertEqual(self.member_rows(), [("root", ASSET2, 1, 1)])


class WireContractTests(AlbumAuthorityFixture):
    """The staged snapshot's exact wire shape and its size bound."""

    def test_the_stored_snapshot_is_version_3_with_both_collections(self):
        snapshot = fixture_snapshot()
        response = self.publish(snapshot)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["snapshotVersion"], 3)
        with self.get_db() as db:
            stored = json.loads(db.execute(
                "SELECT payload FROM album_replica WHERE singleton=1").fetchone()[0])
        self.assertEqual(stored["snapshotVersion"], 3)
        # Display and canonical collections are distinct fields, so the same stored
        # bytes serve the legacy display route and the authority baseline.
        self.assertEqual({album["id"] for album in stored["albums"]},
                         {"root", "child", "other"})
        self.assertEqual(stored["memberships"], [{"albumId": "child", "assetId": ASSET},
                                                 {"albumId": "root", "assetId": ASSET}])
        self.assertEqual([entry["id"] for entry in stored["media"]], [ASSET])

    def test_a_display_only_membership_does_not_become_canonical(self):
        """`media` describes display; only `memberships` is canonical."""
        snapshot = fixture_snapshot(memberships=[])
        self.assertEqual(self.publish(snapshot).status_code, 200)
        self.assertEqual(self.activate({"libraryId": LIBRARY,
                                        "expectedSnapshotDigest": self.snapshot_digest(snapshot)}
                                       ).status_code, 200)
        self.assertEqual(self.member_rows(), [])

    def test_the_staging_bound_fits_the_documented_maxima(self):
        """The upload bound must actually admit a supported library.

        The previous 16 MiB was inherited from the display-only replica and cannot hold
        2,000 Albums plus 100,000 display rows plus 100,000 canonical relations, so it
        would have rejected a documented maximum. This measures the real encoded shape
        at maximum-length identifiers.
        """
        albums = [{"id": "x" * 64, "name": "가" * 200, "parent_id": None,
                   "icon_key": "academic-cap", "color_key": "purple"}
                  for _ in range(album_authority.MAX_ALBUMS)]
        media = [{"id": "x" * 64, "date": 9_999_999_999_999, "width": 99_999,
                  "height": 99_999, "duration": 999_999, "albums": ["y" * 64]}
                 for _ in range(100_000)]
        memberships = [{"albumId": "x" * 64, "assetId": "y" * 64}
                       for _ in range(album_authority.MAX_MEMBERSHIPS)]
        encoded = len(json.dumps(
            {"snapshotVersion": 3, "published_at": "2026-09-15T00:00:00Z",
             "albums": albums, "media": media, "memberships": memberships},
            separators=(",", ":"), sort_keys=True).encode())
        self.assertLess(encoded, album_authority.MAX_STAGING_BYTES,
                        f"documented maxima encode to {encoded} bytes")
        # And the bound is still a bound: it is not unbounded acceptance.
        self.assertGreater(album_authority.MAX_STAGING_BYTES, 0)
        self.assertLess(album_authority.MAX_STAGING_BYTES, 256 * 1024 * 1024)


class BaselineBoundTests(unittest.TestCase):
    """Page sizes must keep the worst-case encoded page inside the response budget.

    The Android/native client reads at most 4 MiB per authenticated JSON response, so
    a page is only safe if maximum-length identifiers at the maximum page size fit.
    Measuring worst-case rows is what makes the constants evidence rather than a guess.
    """

    def encoded_bytes(self, section, items):
        page = album_authority.encode_page("a" * 32, 1, 1, 0, section, items, None, False)
        return len(json.dumps(page, separators=(",", ":"), ensure_ascii=False).encode())

    def test_the_largest_album_page_fits_the_budget(self):
        items = [{"id": "x" * 128, "name": "가" * album_authority.MAX_NAME,
                  "parentId": "y" * 128, "iconKey": "academic-cap", "colorKey": "purple",
                  "entityRevision": 999_999} for _ in range(album_authority.MAX_ALBUM_PAGE)]
        self.assertLess(self.encoded_bytes(album_authority.ALBUMS_SECTION, items),
                        album_authority.MAX_BASELINE_PAGE_BYTES)

    def test_the_largest_membership_page_fits_the_budget(self):
        items = [{"albumId": "x" * 128, "assetId": "y" * 128, "desiredState": True,
                  "entityRevision": 999_999}
                 for _ in range(album_authority.MAX_MEMBERSHIP_PAGE)]
        self.assertLess(self.encoded_bytes(album_authority.MEMBERSHIPS_SECTION, items),
                        album_authority.MAX_BASELINE_PAGE_BYTES)

    def test_an_oversized_page_fails_explicitly_rather_than_truncating(self):
        items = [{"albumId": "x" * 128, "assetId": "y" * 128, "desiredState": True,
                  "entityRevision": 1}
                 for _ in range(album_authority.MAX_MEMBERSHIP_PAGE * 40)]
        with self.assertRaises(HTTPException) as raised:
            self.encoded_bytes(album_authority.MEMBERSHIPS_SECTION, items)
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail["code"], "baselinePageTooLarge")

    def test_the_page_budget_stays_inside_the_native_response_budget(self):
        self.assertLess(album_authority.MAX_BASELINE_PAGE_BYTES, 4 * 1024 * 1024)

    def test_documented_maxima_are_reachable_within_the_page_contract(self):
        """The maxima must be servable by paging, which is the point of the change."""
        albums = album_authority.MAX_ALBUMS
        memberships = album_authority.MAX_MEMBERSHIPS
        self.assertGreaterEqual(
            albums, album_authority.MAX_ALBUM_PAGE * 2, "albums need more than one page")
        self.assertGreaterEqual(
            memberships, album_authority.MAX_MEMBERSHIP_PAGE * 2,
            "memberships need more than one page")


class AppearanceContractTests(unittest.TestCase):
    def test_icon_and_color_keys_match_the_pc_appearance_contract(self):
        """The server must reject exactly what the PC UI cannot render.

        `_tools/app/src-tauri/src/library/folder_appearance.rs` is the PC's source of
        truth. Comparing the lists here is what keeps a server-side acceptance from
        becoming an unrenderable client value.
        """
        source = (Path(__file__).resolve().parents[3]
                  / "_tools/app/src-tauri/src/library/folder_appearance.rs").read_text()
        for name, expected in (("ICON_KEYS", album_authority.ICON_KEYS),
                               ("COLOR_KEYS", album_authority.COLOR_KEYS)):
            start = source.index(f"const {name}")
            block = source[start:source.index("];", start)]
            literal = block.split("= [", 1)[1]
            found = tuple(part.strip().strip('"') for part in literal.split(",")
                          if part.strip().strip('"'))
            self.assertEqual(found, expected, name)


if __name__ == "__main__":
    unittest.main()
