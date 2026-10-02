"""Legacy PC registration must not overwrite authority-owned committed Assets."""
from tests.test_asset_authority import AssetAuthorityFixture, LIBRARY, api_app
import asset_authority
from fastapi import HTTPException
from types import SimpleNamespace


class LegacyAssetUpsertTests(AssetAuthorityFixture):
    def body(self):
        return dict(id="10000000-0000-4000-8000-000000000001", kind="image",
                    object_key="library/first/original", thumbnail_key=None,
                    content_type="image/png", size_bytes=17, sha256="a" * 64)

    def register(self, body):
        try:
            result = api_app.create_asset(api_app.AssetCreate(**body), self.publisher["Authorization"])
            return SimpleNamespace(status_code=200, text=str(result))
        except HTTPException as exc:
            return SimpleNamespace(status_code=exc.status_code, text=str(exc.detail))

    def activate(self):
        with api_app.get_db() as db:
            db.execute("INSERT INTO authority_domains VALUES(?, 'assets', 1, 1, 0, 'test', NULL, '2026-10-02')", [LIBRARY])
            for row in db.execute("SELECT id FROM assets WHERE committed=1").fetchall():
                asset_authority.register_replication(db, LIBRARY, row[0], "2026-10-02")
            db.commit()

    def snapshot(self):
        with api_app.get_db() as db:
            return [list(map(tuple, db.execute("SELECT * FROM " + table))) for table in
                    ("assets", "asset_authority_state", "asset_authority_changes")]

    def test_owned_committed_asset_rejects_changes_and_preserves_idempotent_retry(self):
        body = self.body()
        self.assertEqual(self.register(body).status_code, 200)
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET committed=1 WHERE id=?", [body["id"]])
            db.commit()
        self.activate()
        before = self.snapshot()
        for field, value in dict(kind="video", object_key="library/other/original",
                                 sha256="b" * 64, thumbnail_key="other/thumb",
                                 content_type="video/mp4", size_bytes=99).items():
            with self.subTest(field=field):
                response = self.register({**body, field: value})
                self.assertEqual(response.status_code, 409, response.text)
                self.assertEqual(self.snapshot(), before)
        response = self.register(body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.snapshot(), before)

    def test_pc_first_create_and_retry_still_work_with_active_authority(self):
        self.activate()
        body = self.body()
        for _ in range(2):
            response = self.register(body)
            self.assertEqual(response.status_code, 200, response.text)
        with api_app.get_db() as db:
            row = db.execute("SELECT object_key,sha256 FROM assets WHERE id=?", [body["id"]]).fetchone()
            self.assertEqual(tuple(row), (body["object_key"], body["sha256"]))

    def test_unowned_legacy_upsert_remains_available(self):
        body = self.body()
        self.assertEqual(self.register(body).status_code, 200)
        self.assertEqual(self.register({**body, "size_bytes": 18}).status_code, 200)

    def test_committed_asset_without_authority_state_is_not_fenced(self):
        self.activate()
        body = self.body()
        self.assertEqual(self.register(body).status_code, 200)
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET committed=1 WHERE id=?", [body["id"]])
            db.commit()
        self.assertEqual(self.register({**body, "size_bytes": 18}).status_code, 200)

    def test_owned_retired_assets_are_also_fenced(self):
        body = self.body()
        self.assertEqual(self.register(body).status_code, 200)
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET committed=1 WHERE id=?", [body["id"]])
            db.commit()
        self.activate()
        for lifecycle in ("trash", "tombstoned"):
            with self.subTest(lifecycle=lifecycle):
                with api_app.get_db() as db:
                    db.execute("UPDATE asset_authority_state SET lifecycle=? WHERE asset_id=?", [lifecycle, body["id"]])
                    db.commit()
                before = self.snapshot()
                self.assertEqual(self.register({**body, "object_key": "changed"}).status_code, 409)
                self.assertEqual(self.snapshot(), before)
