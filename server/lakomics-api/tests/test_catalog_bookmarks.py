"""Batch B1: server-side catalog bookmark authority read substrate.

B1 ships the inactive-safe overlay only. There is no activation route and no
mutation route, so authority rows are injected directly here and every test
must still pass with zero authority rows exactly as the current API does.
"""
import hashlib
import sqlite3
import unittest
from unittest import mock

import catalog_bookmarks
import mobile_catalog_replica as replica
from mobile_catalog_query import freeze_query
from tests import test_mobile_catalog as base

AUTH = base.AUTH
LIBRARY = "a" * 32
OTHER_LIBRARY = "b" * 32


def rows_of(page):
    return [[row["groupId"], int(row["providerWorkId"]), row["versionCount"], row["hasBookmarkedVersion"]] for row in page["items"]]


class CatalogBookmarkAuthorityTests(unittest.TestCase):
    setUp = base.MobileCatalogApiTests.setUp
    tearDown = base.MobileCatalogApiTests.tearDown
    publish = base.MobileCatalogApiTests.publish
    search = base.MobileCatalogApiTests.search

    # --- direct authority injection (B1 deliberately has no activation route) ---
    def activate(self, library_id=LIBRARY, epoch=1, cursor=0, bookmarks=(), contract_version=1, digest="d" * 64):
        with self.get_db() as db:
            db.execute(
                "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,baseline_digest,baseline_revision,activated_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                [library_id, catalog_bookmarks.DOMAIN, epoch, contract_version, cursor, digest, None, "2026-09-14T00:00:00Z"])
            db.executemany("INSERT INTO catalog_bookmark_state VALUES(?,?,?,?,?,?,?)",
                           [[library_id, provider, work_id, desired, revision, created, created]
                            for provider, work_id, desired, revision, created in bookmarks])
            db.commit()

    def replace_authority(self, bookmarks, cursor=0, epoch=1, library_id=LIBRARY):
        with self.get_db() as db:
            db.execute("DELETE FROM catalog_bookmark_state WHERE library_id=?", [library_id])
            db.execute("DELETE FROM authority_domains WHERE library_id=?", [library_id])
            db.execute(
                "INSERT INTO authority_domains VALUES(?,?,?,?,?,?,?,?)",
                [library_id, catalog_bookmarks.DOMAIN, epoch, 1, cursor, "d" * 64, None, "2026-09-14T00:00:00Z"])
            db.executemany("INSERT INTO catalog_bookmark_state VALUES(?,?,?,?,?,?,?)",
                           [[library_id, provider, work_id, desired, revision, created, created]
                            for provider, work_id, desired, revision, created in bookmarks])
            db.commit()

    def bump(self, cursor):
        with self.get_db() as db:
            db.execute("UPDATE authority_domains SET change_cursor=? WHERE domain=?", [cursor, catalog_bookmarks.DOMAIN])
            db.commit()

    def users_bytes(self, revision):
        return replica.readable_users_path(self.root / "artifacts", revision).read_bytes()

    def status(self):
        return self.client.get("/v1/mobile-catalog/status", headers=AUTH).json()

    def open_with_authority(self, revision=None):
        return replica.open_publication(self.root / "artifacts", self.get_db, revision, catalog_bookmarks.load(self.get_db))

    # --- 1. schema ---
    def test_authority_tables_are_created_idempotently(self):
        catalog_bookmarks.startup(self.get_db)
        catalog_bookmarks.startup(self.get_db)
        with self.get_db() as db:
            self.assert_authority_schema(db)
        catalog_bookmarks.startup(self.get_db)
        with self.get_db() as db:
            self.assert_authority_schema(db)

    def assert_authority_schema(self, db):
        domains = {row["name"]: row for row in db.execute("PRAGMA table_info(authority_domains)")}
        self.assertEqual(list(domains), ["library_id", "domain", "epoch", "contract_version", "change_cursor",
                                         "baseline_digest", "baseline_revision", "activated_at"])
        self.assertEqual([row["pk"] for row in domains.values() if row["pk"]], [1, 2])
        state = {row["name"]: row for row in db.execute("PRAGMA table_info(catalog_bookmark_state)")}
        self.assertEqual(list(state), ["library_id", "provider", "work_id", "desired_state", "entity_revision",
                                       "created_at", "updated_at"])
        self.assertEqual([row["pk"] for row in state.values() if row["pk"]], [1, 2, 3])
        # B4 adds the command tables; B1's base tables must be unchanged by it.
        names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"catalog_bookmark_receipts", "catalog_bookmark_changes"} <= names, names)
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO catalog_bookmark_state VALUES('x','kHentai','1',2,1,'a','a')")
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO authority_domains VALUES('x','catalog-bookmarks',1,1,0,'d',NULL,'t')")
            db.execute("INSERT INTO authority_domains VALUES('x','catalog-bookmarks',1,1,0,'d',NULL,'t')")

    def test_zero_authority_rows_is_inactive(self):
        self.assertIsNone(catalog_bookmarks.load(self.get_db))
        self.assertIsNone(self.status()["authorityEpoch"])

    def test_more_than_one_authority_row_fails_safely(self):
        self.publish()
        self.activate(LIBRARY)
        self.activate(OTHER_LIBRARY)
        with self.assertRaises(Exception) as raised:
            catalog_bookmarks.load(self.get_db)
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(self.search().status_code, 503)

    def test_snapshot_preserves_identity_and_creation_time(self):
        self.activate(cursor=7, bookmarks=[("kHentai", "01", 1, 1, "2025-01-01T00:00:00Z"),
                                           ("kHentai", "2", 0, 3, "2025-02-02T00:00:00Z")])
        snapshot = catalog_bookmarks.load(self.get_db)
        self.assertEqual(snapshot["libraryId"], LIBRARY)
        self.assertEqual(snapshot["epoch"], 1)
        self.assertEqual(snapshot["cursor"], 7)
        self.assertEqual(snapshot["bookmarks"], [("kHentai", "01", "2025-01-01T00:00:00Z")])

    # --- 2. inactive parity ---
    def test_inactive_authority_matches_the_published_catalog_path(self):
        self.publish()
        self.assertIsNone(catalog_bookmarks.load(self.get_db))
        for case in base.FIXTURE["queries"]:
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in case.items() if k != "expected"}
            page = self.search(**params).json()
            self.assertEqual(rows_of(page), case["expected"], case)
        self.assertEqual(self.search(scope="all", limit=40).json()["totalCount"], 3)

    def test_inactive_bookmark_scope_keeps_the_baked_fast_path(self):
        self.publish()
        page = self.search(scope="bookmarked", limit=1).json()
        with replica.open_publication(self.root / "artifacts", self.get_db, page["publicationRevision"]) as (db, _):
            frozen = freeze_query(db, {"language": "all", "revealBlocked": False, "text": "", "scope": "bookmarked", "sort": "latest"})
            self.assertFalse(frozen["authorityBookmarks"])
            self.assertTrue(frozen["preparedState"])

    def test_active_bookmark_scope_drops_the_baked_fast_path(self):
        self.publish()
        self.activate(bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        with self.open_with_authority() as (db, _):
            frozen = freeze_query(db, {"language": "all", "revealBlocked": False, "text": "", "scope": "bookmarked", "sort": "latest"})
            self.assertTrue(frozen["authorityBookmarks"])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM main.online_catalog_bookmarks").fetchone()[0], 3)

    # --- 3/4. override without a new publication ---
    def test_injected_authority_overrides_bookmark_scope_without_republishing(self):
        before = self.publish().json()["publicationRevision"]
        self.assertEqual([row["groupId"] for row in self.search(scope="bookmarked", limit=40).json()["items"]], ["g1"])
        self.activate(bookmarks=[("kHentai", "6", 1, 1, "2026-01-01T00:00:00Z")])
        after = self.search(scope="bookmarked", limit=40).json()
        self.assertEqual([row["groupId"] for row in after["items"]], ["g6"])
        self.assertTrue(after["items"][0]["hasBookmarkedVersion"])
        self.assertEqual(after["publicationRevision"], before)
        self.assertEqual(self.status()["publicationRevision"], before)
        self.assertEqual(self.status()["authorityEpoch"], 1)
        self.assertTrue(self.status()["capabilities"]["bookmarkWrite"])

    def test_item_detail_and_editions_flags_follow_authority(self):
        self.publish()
        self.activate(bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        page = self.search(limit=40).json()
        g1 = next(row for row in page["items"] if row["groupId"] == "g1")
        # The g1 representative in this page is work 2, but the group has a
        # bookmarked version (work 1). The two flags describe different things.
        self.assertEqual(g1["providerWorkId"], "2")
        self.assertTrue(g1["hasBookmarkedVersion"])
        self.assertFalse(g1["bookmarked"])
        self.assertFalse(next(row for row in page["items"] if row["groupId"] == "g6")["hasBookmarkedVersion"])
        detail = self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": page["context"]}).json()
        self.assertTrue(detail["item"]["bookmarked"])
        editions = self.client.get("/v1/mobile-catalog/groups/kHentai/g1/editions", headers=AUTH, params={"context": page["context"]}).json()
        flags = {item["providerWorkId"]: item["bookmarked"] for item in editions["items"]}
        self.assertEqual(flags, {"1": True, "2": False})
        editions_g6 = self.client.get("/v1/mobile-catalog/groups/kHentai/g6/editions", headers=AUTH, params={"context": page["context"]}).json()
        self.assertTrue(all(not item["bookmarked"] for item in editions_g6["items"]))

    # --- 5/6. prepared pages and counts ---
    def test_prepared_page_patches_only_bookmark_fields(self):
        self.publish()
        before = self.search(limit=40).json()
        self.assertTrue(before["items"])
        self.activate(bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        after = self.search(limit=40).json()
        self.assertEqual(len(after["items"]), len(before["items"]))
        for new, old in zip(after["items"], before["items"]):
            for key in set(old) - {"bookmarked", "hasBookmarkedVersion"}:
                self.assertEqual(new[key], old[key], key)
        g1_new = next(row for row in after["items"] if row["groupId"] == "g1")
        g1_old = next(row for row in before["items"] if row["groupId"] == "g1")
        self.assertTrue(g1_new["hasBookmarkedVersion"])
        self.assertTrue(g1_old["hasBookmarkedVersion"])
        # g1's representative is work 2, so the item flag stays false while the
        # group-level flag is true.
        self.assertFalse(g1_new["bookmarked"])

    def test_prepared_page_patch_clears_a_stale_baked_flag(self):
        self.publish()
        before = next(row for row in self.search(limit=40).json()["items"] if row["groupId"] == "g1")
        self.assertTrue(before["hasBookmarkedVersion"])
        self.activate(bookmarks=[("kHentai", "3", 1, 1, "2026-01-01T00:00:00Z")])
        after = next(row for row in self.search(limit=40).json()["items"] if row["groupId"] == "g1")
        self.assertFalse(after["hasBookmarkedVersion"])
        self.assertFalse(after["bookmarked"])

    def test_prepared_counts_remain_unchanged_by_authority(self):
        self.publish()
        before = self.search(limit=40).json()["totalCount"]
        self.activate(bookmarks=[("kHentai", "6", 1, 1, "2026-01-01T00:00:00Z")])
        self.assertEqual(self.search(limit=40).json()["totalCount"], before)
        hot = self.search(sort="hotDay", limit=40).json()
        self.assertEqual(hot["countStatus"], "pending")
        counted = self.client.get("/v1/mobile-catalog/count", headers=AUTH, params={"token": hot["countToken"]})
        self.assertEqual(counted.status_code, 200, counted.text)
        self.assertEqual(counted.json()["totalCount"], before)

    # --- 7/8/9. exact-text authority matching ---
    def test_authority_text_identity_never_matches_across_canonical_forms(self):
        self.publish()
        self.activate(bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        self.assertEqual([row["groupId"] for row in self.search(scope="bookmarked", limit=40).json()["items"]], ["g1"])
        self.replace_authority([("kHentai", "01", 1, 2, "2026-01-01T00:00:00Z")])
        self.assertEqual(self.search(scope="bookmarked", limit=40).json()["items"], [])
        self.replace_authority([("kHentai", "2", 1, 3, "2026-01-01T00:00:00Z")])
        self.assertEqual([row["groupId"] for row in self.search(scope="bookmarked", limit=40).json()["items"]], ["g1"])
        self.replace_authority([("kHentai", "03", 1, 4, "2026-01-01T00:00:00Z")])
        self.assertEqual(self.search(scope="bookmarked", limit=40).json()["items"], [])

    # --- 10. coherence ---
    def test_one_response_uses_one_coherent_authority_snapshot(self):
        self.publish()
        self.activate(cursor=1, bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        original = catalog_bookmarks.load
        calls = []

        def loader(get_db):
            snapshot = original(get_db)
            calls.append(snapshot["cursor"])
            if len(calls) == 1:
                with get_db() as db:
                    db.execute("DELETE FROM catalog_bookmark_state WHERE library_id=?", [LIBRARY])
                    db.execute("UPDATE authority_domains SET change_cursor=99 WHERE library_id=?", [LIBRARY])
                    db.commit()
            return snapshot

        with mock.patch.object(catalog_bookmarks, "load", loader):
            page = self.search(scope="bookmarked", limit=40).json()
        self.assertEqual(len(calls), 1)
        self.assertEqual([row["groupId"] for row in page["items"]], ["g1"])
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM catalog_bookmark_state").fetchone()[0], 0)

    def test_authority_reads_do_not_write_the_users_projection(self):
        revision = self.publish().json()["publicationRevision"]
        before_hash = hashlib.sha256(self.users_bytes(revision)).hexdigest()
        self.activate(bookmarks=[("kHentai", "6", 1, 1, "2026-01-01T00:00:00Z")])
        self.search(scope="bookmarked", limit=40)
        self.search(limit=40)
        self.search(scope="bookmarked", limit=40)
        self.assertEqual(hashlib.sha256(self.users_bytes(revision)).hexdigest(), before_hash)

    def test_authority_overlay_does_not_hold_the_control_database_read_lock(self):
        self.publish()
        self.activate(bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        with self.open_with_authority() as (db, _):
            self.assertEqual(db.execute("SELECT COUNT(*) FROM online_catalog_bookmarks").fetchone()[0], 1)
            writer = sqlite3.connect(self.root / "control.sqlite", timeout=1)
            try:
                writer.execute("BEGIN IMMEDIATE")
                writer.execute("INSERT INTO catalog_bookmark_state VALUES(?,?,?,?,?,?,?)",
                               [LIBRARY, "kHentai", "9", 1, 1, "x", "x"])
                writer.commit()
            finally:
                writer.close()
            self.assertEqual(db.execute("SELECT COUNT(*) FROM online_catalog_bookmarks").fetchone()[0], 1)

    # --- 11/12. token markers ---
    def test_bookmark_scope_tokens_reject_cursor_changes(self):
        self.publish()
        self.activate(cursor=5, bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z"),
                                           ("kHentai", "6", 1, 1, "2026-01-01T00:00:00Z")])
        page = self.search(scope="bookmarked", limit=1).json()
        self.assertIsNotNone(page["nextCursor"])
        self.assertEqual(self.client.get("/v1/mobile-catalog/search", headers=AUTH,
                                        params={"cursor": page["nextCursor"]}).status_code, 200)
        self.bump(6)
        stale = self.client.get("/v1/mobile-catalog/search", headers=AUTH, params={"cursor": page["nextCursor"]})
        self.assertEqual(stale.status_code, 409, stale.text)

    def test_bookmark_scope_context_and_count_tokens_reject_cursor_changes(self):
        self.publish()
        self.activate(cursor=5, bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        hot = self.search(scope="bookmarked", sort="hotDay", limit=40).json()
        self.assertIsNotNone(hot["countToken"])
        context = self.search(scope="bookmarked", limit=40).json()["context"]
        self.assertEqual(self.client.get("/v1/mobile-catalog/count", headers=AUTH, params={"token": hot["countToken"]}).status_code, 200)
        self.assertEqual(self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": context}).status_code, 200)
        self.bump(6)
        self.assertEqual(self.client.get("/v1/mobile-catalog/count", headers=AUTH, params={"token": hot["countToken"]}).status_code, 409)
        self.assertEqual(self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": context}).status_code, 409)

    def test_bookmark_scope_tokens_reject_epoch_changes(self):
        self.publish()
        self.activate(epoch=1, cursor=5, bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        context = self.search(scope="bookmarked", limit=40).json()["context"]
        self.assertEqual(self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": context}).status_code, 200)
        with self.get_db() as db:
            db.execute("UPDATE authority_domains SET epoch=2 WHERE library_id=?", [LIBRARY])
            db.commit()
        self.assertEqual(self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": context}).status_code, 409)

    def test_scope_all_tokens_survive_authority_bookmark_changes(self):
        self.publish()
        self.activate(cursor=5, bookmarks=[])
        page = self.search(limit=1).json()
        self.assertIsNotNone(page["nextCursor"])
        before = self.client.get("/v1/mobile-catalog/search", headers=AUTH, params={"cursor": page["nextCursor"]}).json()
        detail = self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": page["context"]}).json()
        self.assertFalse(detail["item"]["bookmarked"])
        hot = self.search(sort="hotDay", limit=40).json()
        counts = self.client.get("/v1/mobile-catalog/count", headers=AUTH, params={"token": hot["countToken"]}).json()["totalCount"]
        self.bump(50)
        with self.get_db() as db:
            db.execute("INSERT INTO catalog_bookmark_state VALUES(?,?,?,?,?,?,?)", [LIBRARY, "kHentai", "1", 1, 1, "x", "x"])
            db.commit()
        after = self.client.get("/v1/mobile-catalog/search", headers=AUTH, params={"cursor": page["nextCursor"]})
        self.assertEqual(after.status_code, 200, after.text)
        self.assertEqual(after.json()["items"], before["items"])
        unchanged = self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": page["context"]})
        self.assertEqual(unchanged.status_code, 200, unchanged.text)
        counted = self.client.get("/v1/mobile-catalog/count", headers=AUTH, params={"token": hot["countToken"]})
        self.assertEqual(counted.status_code, 200, counted.text)
        self.assertEqual(counted.json()["totalCount"], counts)
        editions = self.client.get("/v1/mobile-catalog/groups/kHentai/g1/editions", headers=AUTH, params={"context": page["context"]})
        self.assertEqual(editions.status_code, 200, editions.text)

    def test_editions_context_is_bound_to_authority(self):
        self.publish()
        self.activate(cursor=5, bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        context = self.search(scope="bookmarked", limit=40).json()["context"]
        first = self.client.get("/v1/mobile-catalog/groups/kHentai/g1/editions", headers=AUTH, params={"context": context})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(any(item["bookmarked"] for item in first.json()["items"]))
        self.bump(6)
        stale = self.client.get("/v1/mobile-catalog/groups/kHentai/g1/editions", headers=AUTH, params={"context": context})
        self.assertEqual(stale.status_code, 409, stale.text)

    def test_unsupported_contract_version_fails_closed(self):
        self.publish()
        self.activate(contract_version=99, bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        with self.assertRaises(Exception) as raised:
            catalog_bookmarks.load(self.get_db)
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(self.search(scope="bookmarked", limit=40).status_code, 503)
        self.assertEqual(self.search(limit=40).status_code, 503)

    def test_inactive_bookmark_tokens_are_rejected_after_authority_activates(self):
        self.publish()
        page = self.search(scope="bookmarked", limit=40).json()
        self.assertIsNotNone(page["countToken"])
        self.assertEqual(self.client.get("/v1/mobile-catalog/count", headers=AUTH, params={"token": page["countToken"]}).status_code, 200)
        self.assertEqual(self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": page["context"]}).status_code, 200)
        self.activate(cursor=1, bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        self.assertEqual(self.client.get("/v1/mobile-catalog/count", headers=AUTH, params={"token": page["countToken"]}).status_code, 409)
        self.assertEqual(self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": page["context"]}).status_code, 409)

    def test_inactive_scope_all_tokens_survive_authority_activation(self):
        self.publish()
        page = self.search(limit=1).json()
        before = self.client.get("/v1/mobile-catalog/search", headers=AUTH, params={"cursor": page["nextCursor"]}).json()
        self.activate(cursor=1, bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        after = self.client.get("/v1/mobile-catalog/search", headers=AUTH, params={"cursor": page["nextCursor"]})
        self.assertEqual(after.status_code, 200, after.text)
        self.assertEqual(after.json()["items"], before["items"])
        self.assertEqual(self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": page["context"]}).status_code, 200)

    def test_authority_tokens_bind_the_library_identity(self):
        self.publish()
        self.activate(library_id=LIBRARY, epoch=1, cursor=7, bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        context = self.search(scope="bookmarked", limit=40).json()["context"]
        self.assertEqual(self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": context}).status_code, 200)
        # A different library with identical epoch/cursor must not accept the token.
        with self.get_db() as db:
            db.execute("DELETE FROM catalog_bookmark_state")
            db.execute("DELETE FROM authority_domains")
            db.execute("INSERT INTO authority_domains VALUES(?,?,?,?,?,?,?,?)",
                       [OTHER_LIBRARY, catalog_bookmarks.DOMAIN, 1, 1, 7, "d" * 64, None, "2026-09-14T00:00:00Z"])
            db.execute("INSERT INTO catalog_bookmark_state VALUES(?,?,?,?,?,?,?)",
                       [OTHER_LIBRARY, "kHentai", "1", 1, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"])
            db.commit()
        stale = self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": context})
        self.assertEqual(stale.status_code, 409, stale.text)

    def test_unsupported_contract_version_rejects_existing_tokens(self):
        self.publish()
        page = self.search(scope="bookmarked", limit=40).json()
        with self.get_db() as db:
            db.execute("INSERT INTO authority_domains VALUES(?,?,?,?,?,?,?,?)",
                       [LIBRARY, catalog_bookmarks.DOMAIN, 1, 99, 0, "d" * 64, None, "2026-09-14T00:00:00Z"])
            db.commit()
        self.assertEqual(self.client.get("/v1/mobile-catalog/count", headers=AUTH, params={"token": page["countToken"]}).status_code, 503)
        self.assertEqual(self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": page["context"]}).status_code, 503)

    def test_inactive_tokens_keep_the_current_behavior(self):
        self.publish()
        page = self.search(scope="bookmarked", limit=40).json()
        self.assertEqual(self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": page["context"]}).status_code, 200)
        # Inactive bookmark scope keeps today's shape: count is pending and a
        # count token is issued. Both must remain usable.
        self.assertEqual(page["countStatus"], "pending")
        self.assertIsNotNone(page["countToken"])
        counted = self.client.get("/v1/mobile-catalog/count", headers=AUTH, params={"token": page["countToken"]})
        self.assertEqual(counted.status_code, 200, counted.text)
        self.assertEqual(counted.json()["totalCount"], 1)
        self.assertIsNone(self.status()["authorityEpoch"])
        self.assertFalse(self.status()["capabilities"]["bookmarkWrite"])

    # --- 15. regression with authority active ---
    def test_existing_catalog_contract_is_unchanged_with_authority_active(self):
        self.publish()
        self.activate(bookmarks=[])
        for case in base.FIXTURE["queries"]:
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in case.items() if k != "expected"}
            page = self.search(**params).json()
            if case["scope"] == "bookmarked":
                self.assertEqual(page["items"], [], case)
                continue
            actual = rows_of(page)
            self.assertEqual([row[0] for row in actual], [row[0] for row in case["expected"]], case)
            self.assertEqual([row[1] for row in actual], [row[1] for row in case["expected"]], case)
            self.assertEqual([row[2] for row in actual], [row[2] for row in case["expected"]], case)
            self.assertEqual([row[3] for row in actual], [False] * len(case["expected"]), case)
        ready = self.search(scope="all", limit=40).json()
        self.assertTrue(ready["ready"])
        self.assertEqual(ready["totalCount"], 3)

    def test_reader_and_status_unaffected_by_authority(self):
        self.publish()
        self.activate(bookmarks=[("kHentai", "1", 1, 1, "2026-01-01T00:00:00Z")])
        page = self.search(language="korean").json()
        reader = self.client.get("/v1/mobile-catalog/works/kHentai/1/reader", headers=AUTH, params={"context": page["context"]})
        self.assertEqual(reader.status_code, 200, reader.text)
        self.assertEqual(reader.json()["publicationRevision"], page["publicationRevision"])
        self.assertEqual([item["index"] for item in reader.json()["pages"]], [0, 1])


if __name__ == "__main__":
    unittest.main()
