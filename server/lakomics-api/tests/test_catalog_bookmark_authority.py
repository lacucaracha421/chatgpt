"""Batch B3: one-time catalog-bookmark authority activation and the PC fence.

B3 adds the activation endpoint, the publication bookmark fence, and the
external-publication library identity header. Bookmark mutation, receipts, the
change log, and credential roles remain out of scope.
"""
import json
import unittest
from unittest import mock

import catalog_bookmarks
import mobile_catalog_replica as replica
from tests import test_mobile_catalog as base

AUTH = base.AUTH
LIBRARY = "a" * 32
OTHER_LIBRARY = "b" * 32
REVISION_A = "1" * 64
ACTIVATION = "/v1/mobile-catalog/bookmark-authority/activate"


class CatalogBookmarkAuthorityActivationTests(unittest.TestCase):
    setUp = base.MobileCatalogApiTests.setUp
    tearDown = base.MobileCatalogApiTests.tearDown
    publish = base.MobileCatalogApiTests.publish
    search = base.MobileCatalogApiTests.search

    def status(self):
        return self.client.get("/v1/mobile-catalog/status", headers=AUTH).json()

    def revision(self):
        return self.status()["publicationRevision"]

    def activate(self, library_id=LIBRARY, revision=None, token=AUTH, body=None):
        revision = self.revision() if revision is None else revision
        payload = {"libraryId": library_id, "expectedPublicationRevision": revision} if body is None else body
        return self.client.post(ACTIVATION, headers=token, json=payload)

    def publish_from(self, library_id, base_revision=None, users=None):
        uploaded = self.client.put("/v1/mobile-catalog/replicas/" + self.digest, headers=AUTH, content=self.data)
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        headers = dict(AUTH)
        if library_id is not None:
            headers["X-Lakomics-Library-Id"] = library_id
        return self.client.put("/v1/mobile-catalog/publication", headers=headers, json={
            "version": 1, "baseRevision": base_revision, "contentDigest": self.digest,
            "userSnapshot": users if users is not None else self.users})

    def authority_rows(self):
        with self.get_db() as db:
            domain = db.execute(
                "SELECT library_id,epoch,contract_version,change_cursor,baseline_digest,baseline_revision,activated_at"
                " FROM authority_domains WHERE domain=?", [catalog_bookmarks.DOMAIN]).fetchall()
            state = db.execute(
                "SELECT provider,work_id,desired_state,entity_revision,created_at,updated_at"
                " FROM catalog_bookmark_state ORDER BY provider,work_id").fetchall()
        return [dict(row) for row in domain], [dict(row) for row in state]

    def publish_users(self, revision):
        with self.get_db() as db:
            row = db.execute("SELECT user_revision FROM mobile_catalog_publications WHERE revision=?", [revision]).fetchone()
            payload = db.execute("SELECT payload FROM mobile_catalog_users WHERE revision=?", [row["user_revision"]]).fetchone()
        return json.loads(payload[0])

    # --- 1/2. authentication and body shape ---
    def test_activation_requires_authentication(self):
        self.publish()
        self.assertEqual(self.client.post(ACTIVATION, headers={}, json={
            "libraryId": LIBRARY, "expectedPublicationRevision": self.revision()}).status_code, 401)
        self.assertEqual(self.client.post(ACTIVATION, headers={"Authorization": "Bearer wrong"}, json={
            "libraryId": LIBRARY, "expectedPublicationRevision": self.revision()}).status_code, 401)
        self.assertEqual(self.activate().status_code, 200, "authenticated request must succeed")

    def test_activation_rejects_malformed_or_extraneous_body_fields(self):
        self.publish()
        revision = self.revision()
        cases = [
            {"libraryId": LIBRARY, "expectedPublicationRevision": revision, "extra": 1},
            {"libraryId": LIBRARY},
            {"expectedPublicationRevision": revision},
            {"libraryId": LIBRARY.upper(), "expectedPublicationRevision": revision},
            {"libraryId": "a" * 31, "expectedPublicationRevision": revision},
            {"libraryId": "g" * 32, "expectedPublicationRevision": revision},
            {"libraryId": LIBRARY, "expectedPublicationRevision": revision.upper()},
            {"libraryId": LIBRARY, "expectedPublicationRevision": "1" * 63},
            {"libraryId": LIBRARY, "expectedPublicationRevision": "g" * 64},
            {"libraryId": 1, "expectedPublicationRevision": revision},
        ]
        for case in cases:
            self.assertEqual(self.activate(body=case).status_code, 422, case)
        self.assertIsNone(self.status()["authorityLibraryId"])

    def test_activation_rejects_when_no_publication_exists(self):
        response = self.activate(revision=REVISION_A)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIsNone(self.status()["authorityLibraryId"])

    def test_expected_publication_revision_mismatch_is_rejected(self):
        self.publish()
        response = self.activate(revision=REVISION_A)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIsNone(self.status()["authorityLibraryId"])

    # --- 5/6/7/8. baseline import ---
    def test_baseline_import_preserves_provider_work_id_and_created_at(self):
        self.publish()
        response = self.activate()
        self.assertEqual(response.status_code, 200, response.text)
        _, state = self.authority_rows()
        expected = sorted(self.users["bookmarks"], key=replica.encode)
        self.assertEqual([[row["provider"], row["work_id"], row["created_at"]] for row in state], expected)
        self.assertTrue(any(row["provider"] == "heliotrope" for row in state))

    def test_baseline_rows_are_baseline_state_and_cursor_starts_at_zero(self):
        self.publish()
        self.assertEqual(self.activate().status_code, 200)
        domain, state = self.authority_rows()
        self.assertEqual(len(domain), 1)
        self.assertEqual(domain[0]["epoch"], 1)
        self.assertEqual(domain[0]["contract_version"], catalog_bookmarks.CONTRACT_VERSION)
        self.assertEqual(domain[0]["change_cursor"], 0)
        self.assertEqual(domain[0]["library_id"], LIBRARY)
        self.assertTrue(domain[0]["activated_at"])
        self.assertTrue(state)
        for row in state:
            self.assertEqual(row["desired_state"], 1, row)
            self.assertEqual(row["entity_revision"], 1, row)
            self.assertEqual(row["updated_at"], domain[0]["activated_at"])

    def test_baseline_digest_and_revision_are_correct(self):
        self.publish()
        revision = self.revision()
        self.assertEqual(self.activate().status_code, 200)
        domain, _ = self.authority_rows()
        expected = sorted(self.users["bookmarks"], key=replica.encode)
        self.assertEqual(domain[0]["baseline_digest"], replica.digest(expected))
        self.assertEqual(domain[0]["baseline_revision"], revision)

    def test_activation_does_not_change_publication_revision(self):
        before = self.publish().json()["publicationRevision"]
        response = self.activate()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.revision(), before)
        self.assertEqual(self.search(limit=40).json()["publicationRevision"], before)

    # --- 10/11/12. idempotency and rejection ---
    def test_identical_activation_retry_returns_the_same_authority_state(self):
        self.publish()
        first = self.activate()
        self.assertEqual(first.status_code, 200, first.text)
        domain_before, state_before = self.authority_rows()
        retry = self.activate()
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json(), first.json())
        domain_after, state_after = self.authority_rows()
        self.assertEqual(domain_after, domain_before)
        self.assertEqual(state_after, state_before)

    def test_different_library_activation_is_rejected(self):
        self.publish()
        self.assertEqual(self.activate(LIBRARY).status_code, 200)
        response = self.activate(OTHER_LIBRARY)
        self.assertEqual(response.status_code, 409, response.text)
        domain, _ = self.authority_rows()
        self.assertEqual(domain[0]["library_id"], LIBRARY)

    def test_different_baseline_activation_is_rejected(self):
        self.publish()
        revision_a = self.revision()
        self.assertEqual(self.activate(revision=revision_a).status_code, 200)
        # A server-internal republish advances the current revision; a different
        # baseline must not reactivate or replace the existing authority.
        self.assertEqual(self.client.put("/v1/mobile-catalog/visibility", headers=AUTH, json={
            "hiddenCategories": [[4, "2026-09-14T00:00:00Z"]], "blockedTags": []}).status_code, 200)
        revision_b = self.revision()
        self.assertNotEqual(revision_a, revision_b)
        response = self.activate(revision=revision_b)
        self.assertEqual(response.status_code, 409, response.text)
        domain, _ = self.authority_rows()
        self.assertEqual(domain[0]["change_cursor"], 0)
        self.assertEqual(domain[0]["baseline_revision"], revision_a)
        self.assertEqual(self.activate(revision=revision_a).status_code, 200)

    # --- 13/14/15/16. publication library identity fence ---
    def test_inactive_publication_still_works_without_a_library_header(self):
        response = self.publish()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(self.status()["authorityLibraryId"])

    def test_active_publication_requires_the_library_header(self):
        self.publish()
        self.assertEqual(self.activate().status_code, 200)
        response = self.publish(base=self.revision())
        self.assertEqual(response.status_code, 409, response.text)

    def test_active_publication_rejects_a_wrong_library_header(self):
        self.publish()
        self.assertEqual(self.activate().status_code, 200)
        response = self.publish_from(OTHER_LIBRARY, self.revision())
        self.assertEqual(response.status_code, 409, response.text)

    def test_active_publication_succeeds_with_the_matching_header(self):
        self.publish()
        self.assertEqual(self.activate().status_code, 200)
        response = self.publish_from(LIBRARY, self.revision())
        self.assertEqual(response.status_code, 200, response.text)

    # --- 17/18/19. fence behavior ---
    def test_stale_pc_bookmarks_cannot_replace_authority_bookmarks(self):
        self.publish()
        self.assertEqual(self.activate().status_code, 200)
        stale = json.loads(json.dumps(self.users))
        stale["bookmarks"] = [["kHentai", "6", "1999-01-01T00:00:00Z"]]
        stale["bookmarks"].sort(key=replica.encode)
        response = self.publish_from(LIBRARY, self.revision(), stale)
        self.assertEqual(response.status_code, 200, response.text)
        _, state = self.authority_rows()
        self.assertEqual([[row["provider"], row["work_id"]] for row in state],
                         [["heliotrope", "3"], ["kHentai", "03"], ["kHentai", "1"]])
        scoped = self.search(scope="bookmarked", limit=40).json()
        self.assertEqual(sorted(row["groupId"] for row in scoped["items"]), ["g1"])

    def test_publication_compatibility_snapshot_is_authority_derived(self):
        self.publish()
        self.assertEqual(self.activate().status_code, 200)
        stale = json.loads(json.dumps(self.users))
        stale["bookmarks"] = []
        response = self.publish_from(LIBRARY, self.revision(), stale)
        self.assertEqual(response.status_code, 200, response.text)
        derived = self.publish_users(response.json()["publicationRevision"])
        self.assertEqual(derived["bookmarks"], sorted(self.users["bookmarks"], key=replica.encode))
        self.assertEqual(derived["hiddenCategories"], self.users["hiddenCategories"])
        self.assertEqual(derived["preferences"], self.users["preferences"])

    def test_publication_does_not_alter_authority_epoch_cursor_or_revisions(self):
        self.publish()
        self.assertEqual(self.activate().status_code, 200)
        before_domain, before_state = self.authority_rows()
        self.assertEqual(self.publish_from(LIBRARY, self.revision()).status_code, 200)
        after_domain, after_state = self.authority_rows()
        self.assertEqual(after_domain, before_domain)
        self.assertEqual(after_state, before_state)

    # --- 20/21. server-internal republishing preserves authority ---
    def test_catalog_refresh_preserves_authority_bookmarks(self):
        from mobile_catalog_refresh import DDL, RefreshWorker

        self.publish()
        self.assertEqual(self.activate().status_code, 200)
        before_domain, before_state = self.authority_rows()
        worker = RefreshWorker(self.get_db, lambda: self.root / "artifacts",
                               lambda language, cursor: json.dumps([{
                                   "id": "1001", "title": "New", "filecount": "20", "views": 7,
                                   "posted": 1800000000000, "tags": [{"tag": ["language", "korean"]}]}]))
        with self.get_db() as db:
            db.executescript(DDL)
        import uuid
        worker.request(str(uuid.uuid4()), "korean")
        self.assertTrue(worker.run_once())
        self.assertEqual(worker.status()["state"], "completed")
        self.assertEqual(self.authority_rows(), (before_domain, before_state))
        self.assertEqual(sorted(row["groupId"] for row in self.search(scope="bookmarked", limit=40).json()["items"]), ["g1"])

    def test_visibility_republish_preserves_authority_bookmarks(self):
        self.publish()
        self.assertEqual(self.activate().status_code, 200)
        before_domain, before_state = self.authority_rows()
        policy = {"hiddenCategories": [[4, "2026-09-14T00:00:00Z"]],
                  "blockedTags": [["artist", "blocked", "now"]]}
        response = self.client.put("/v1/mobile-catalog/visibility", headers=AUTH, json=policy)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.authority_rows(), (before_domain, before_state))

    # --- 22/23/24. capability, status, schema ---
    def test_bookmark_write_follows_authority_activation(self):
        self.publish()
        self.assertFalse(self.status()["capabilities"]["bookmarkWrite"])
        self.assertEqual(self.activate().status_code, 200)
        self.assertTrue(self.status()["capabilities"]["bookmarkWrite"])

    def test_status_exposes_authority_metadata(self):
        self.publish()
        inactive = self.status()
        self.assertIsNone(inactive["authorityLibraryId"])
        self.assertIsNone(inactive["authorityEpoch"])
        self.assertIsNone(inactive["authorityContractVersion"])
        self.assertIsNone(inactive["authorityCursor"])
        revision = self.revision()
        self.assertEqual(self.activate().status_code, 200)
        active = self.status()
        self.assertEqual(active["authorityLibraryId"], LIBRARY)
        self.assertEqual(active["authorityEpoch"], 1)
        self.assertEqual(active["authorityContractVersion"], catalog_bookmarks.CONTRACT_VERSION)
        self.assertEqual(active["authorityCursor"], 0)
        self.assertEqual(active["publicationRevision"], revision)
        self.assertTrue(active["ready"])

    def test_activation_creates_no_receipts_or_change_rows(self):
        self.publish()
        self.assertEqual(self.activate().status_code, 200)
        with self.get_db() as db:
            names = {row["name"] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("authority_domains", names)
            self.assertIn("catalog_bookmark_state", names)
            # B4 adds the command tables, but activation itself is a baseline: it
            # produces cursor 0 with no receipts and no change-log rows.
            self.assertEqual(db.execute("SELECT COUNT(*) FROM catalog_bookmark_receipts").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM catalog_bookmark_changes").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT change_cursor FROM authority_domains").fetchone()[0], 0)


class CatalogBookmarkPublicationRaceTests(CatalogBookmarkAuthorityActivationTests):
    """The final authority fence must run inside the commit transaction."""

    def current_revision(self):
        with self.get_db() as db:
            return replica.current(db)["revision"]

    def activate_latest(self, library_id=LIBRARY):
        with self.get_db() as db:
            revision = replica.current(db)["revision"]
            payload = db.execute(
                "SELECT payload FROM mobile_catalog_users WHERE revision="
                "(SELECT user_revision FROM mobile_catalog_publications WHERE revision=?)", [revision]).fetchone()
            bookmarks = sorted(json.loads(payload[0])["bookmarks"], key=replica.encode)
            db.execute("BEGIN IMMEDIATE")
            state = catalog_bookmarks.activate(
                db, library_id=library_id, expected_revision=revision, bookmarks=bookmarks,
                baseline_digest=replica.digest(bookmarks), current_revision=revision,
                now="2026-09-14T00:00:00Z")
            db.commit()
        return revision, state

    def activate_during_prepare_users(self, library_id=LIBRARY):
        """Activate deterministically after publish's initial snapshot is taken."""
        original = replica.prepare_users
        fired = []

        def prepare(*args, **kwargs):
            if not fired:
                fired.append(True)
                self.activate_latest(library_id)
            return original(*args, **kwargs)

        return mock.patch.object(replica, "prepare_users", prepare), fired

    # A. the real route must reach replica.publish and succeed
    def test_real_inactive_external_publication_succeeds_through_publish(self):
        response = self.publish()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["publicationRevision"], self.current_revision())

    # B. inactive -> active during publication must be rejected
    def test_activation_during_publication_rejects_and_keeps_current(self):
        before = self.publish().json()["publicationRevision"]
        stale = json.loads(json.dumps(self.users))
        stale["bookmarks"] = [["kHentai", "6", "1999-01-01T00:00:00Z"]]
        stale["bookmarks"].sort(key=replica.encode)
        patch, fired = self.activate_during_prepare_users()
        with patch:
            response = self.publish_from(LIBRARY, before, stale)
        self.assertTrue(fired, "activation hook did not run")
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.current_revision(), before)
        # Activation committed independently, so the baseline exists; what must not
        # happen is the stale PC snapshot becoming the current publication.
        scoped = self.search(scope="bookmarked", limit=40).json()
        self.assertEqual(scoped["publicationRevision"], before)
        self.assertEqual(sorted(row["groupId"] for row in scoped["items"]), ["g1"])
        self.assertNotIn("g6", [row["groupId"] for row in scoped["items"]])

    # C. the same race without the header must also be rejected
    def test_activation_during_publication_without_header_is_rejected(self):
        before = self.publish().json()["publicationRevision"]
        patch, fired = self.activate_during_prepare_users()
        with patch:
            response = self.publish_from(None, before)
        self.assertTrue(fired, "activation hook did not run")
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.current_revision(), before)

    # D. cursor/epoch drift before commit must be rejected
    def test_authority_cursor_drift_before_commit_is_rejected(self):
        before = self.publish().json()["publicationRevision"]
        self.activate_latest()
        original = replica.prepare_users
        fired = []

        def prepare(*args, **kwargs):
            if not fired:
                fired.append(True)
                with self.get_db() as db:
                    db.execute("UPDATE authority_domains SET change_cursor=7 WHERE domain=?", [catalog_bookmarks.DOMAIN])
                    db.commit()
            return original(*args, **kwargs)

        with mock.patch.object(replica, "prepare_users", prepare):
            response = self.publish_from(LIBRARY, before)
        self.assertTrue(fired, "cursor drift hook did not run")
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.current_revision(), before)

    def test_authority_epoch_drift_before_commit_is_rejected(self):
        before = self.publish().json()["publicationRevision"]
        self.activate_latest()
        original = replica.prepare_users
        fired = []

        def prepare(*args, **kwargs):
            if not fired:
                fired.append(True)
                with self.get_db() as db:
                    db.execute("UPDATE authority_domains SET epoch=2 WHERE domain=?", [catalog_bookmarks.DOMAIN])
                    db.commit()
            return original(*args, **kwargs)

        with mock.patch.object(replica, "prepare_users", prepare):
            response = self.publish_from(LIBRARY, before)
        self.assertTrue(fired, "epoch drift hook did not run")
        self.assertEqual(response.status_code, 409, response.text)

    # E. response-loss retry after a server-internal republish must still work
    def test_activation_retry_after_internal_republish_is_idempotent(self):
        self.publish()
        revision_a = self.revision()
        first = self.activate(revision=revision_a)
        self.assertEqual(first.status_code, 200, first.text)
        with self.get_db() as db:
            payload = db.execute(
                "SELECT payload FROM mobile_catalog_users WHERE revision="
                "(SELECT user_revision FROM mobile_catalog_publications WHERE revision=?)", [revision_a]).fetchone()
            users = json.loads(payload[0])
        users["hiddenCategories"] = [[4, "2026-09-14T00:00:00Z"]]
        visibility = self.client.put("/v1/mobile-catalog/visibility", headers=AUTH, json={
            "hiddenCategories": users["hiddenCategories"], "blockedTags": []})
        self.assertEqual(visibility.status_code, 200, visibility.text)
        self.assertNotEqual(self.current_revision(), revision_a, "current must have advanced")
        retry = self.activate(revision=revision_a)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json(), first.json())

    # F. a different baseline against existing authority is covered above by
    # test_different_baseline_activation_is_rejected, which also asserts the
    # original activation request keeps succeeding afterwards.


if __name__ == "__main__":
    unittest.main()
