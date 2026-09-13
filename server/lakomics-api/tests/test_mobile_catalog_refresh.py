import copy
import json
import time
import unittest
import uuid
from unittest import mock

from tests import test_mobile_catalog as base
import mobile_catalog_replica as replica
from mobile_catalog_refresh import DDL, RefreshWorker, register_refresh
from catalog_refresh_content import parse_page


def page(ids, language="korean"):
    return json.dumps([{"id": str(i), "title": f"New {i}", "filecount": "20", "views": 7,
                        "posted": 1800000000000, "rating": "4.5",
                        "tags": [{"tag": ["language", language]}]} for i in ids])


class RefreshTests(unittest.TestCase):
    setUp = base.MobileCatalogApiTests.setUp
    tearDown = base.MobileCatalogApiTests.tearDown
    publish = base.MobileCatalogApiTests.publish
    search = base.MobileCatalogApiTests.search

    def worker(self, fetch):
        self.publish()
        worker = RefreshWorker(self.get_db, lambda: self.root / "artifacts", fetch)
        with self.get_db() as db:
            db.executescript(DDL)
        return worker

    def request(self, worker, language="korean"):
        return worker.request(str(uuid.uuid4()), language)

    def test_refresh_publishes_new_works_preserves_users_and_old_reader_revision(self):
        worker = self.worker(lambda *_: page([1002, 1001]))
        before = self.search().json()
        job = self.request(worker)
        self.assertEqual(worker.status()["state"], "queued")
        self.assertTrue(worker.run_once())
        self.assertEqual(worker.status()["state"], "completed")
        self.assertEqual(worker.status()["added"], 2)
        after = self.search().json()
        self.assertNotEqual(before["publicationRevision"], after["publicationRevision"])
        self.assertIn("1002", [row["providerWorkId"] for row in after["items"]])
        with replica.open_publication(self.root / "artifacts", self.get_db, before["publicationRevision"]) as (db, _):
            self.assertIsNone(db.execute("SELECT 1 FROM catalog.Works WHERE Id=1002").fetchone())
        with self.get_db() as db:
            current = replica.current(db)
            self.assertEqual(json.loads(db.execute("SELECT payload FROM mobile_catalog_users WHERE revision=?", [current["user_revision"]]).fetchone()[0]), self.users)
        self.assertEqual(worker.request(job["id"], "korean"), worker.status())
        self.assertFalse(worker.run_once())

    def test_later_stale_pc_content_cannot_remove_server_additions(self):
        worker = self.worker(lambda *_: page([1001]))
        self.request(worker); worker.run_once()
        prior = self.search().json()["publicationRevision"]
        users = copy.deepcopy(self.users); users["bookmarks"] = []
        response = self.publish(prior, users)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("1001", [item["providerWorkId"] for item in self.search().json()["items"]])
        self.assertEqual(self.search(scope="bookmarked").json()["items"], [])
        self.assertEqual(self.publish(prior, users).json(), response.json())

    def test_duplicates_and_language_mismatch_do_not_queue_extra_jobs(self):
        worker = self.worker(lambda *_: page([]))
        job = self.request(worker)
        duplicate_id = str(uuid.uuid4())
        self.assertEqual(worker.request(duplicate_id, 'korean')["id"], job["id"])
        with self.assertRaises(Exception) as raised:
            worker.request(job["id"], "japanese")
        self.assertEqual(raised.exception.status_code, 409)
        worker.run_once()
        self.assertEqual(worker.status()["state"], "completed")
        self.assertEqual(worker.status()["added"], 0)
        self.assertEqual(worker.request(duplicate_id, 'korean')["id"], job["id"])
        self.assertFalse(worker.run_once())

    def test_page_limit_continues_without_skipping_unpublished_range(self):
        calls = []
        worker = self.worker(lambda language, cursor: calls.append(cursor) or page(range(2000, 1950, -1)))
        job = self.request(worker)
        with self.get_db() as db:
            db.execute("UPDATE mobile_catalog_refresh_jobs SET page_limit=1 WHERE id=?", [job['id']]); db.commit()
        worker.run_once()
        self.assertTrue(worker.status()['hasMore'])
        worker.fetch_page = lambda language, cursor: calls.append(cursor) or page([1950])
        self.request(worker); worker.run_once()
        self.assertEqual(calls, [None, 1951])
        self.assertFalse(worker.status()['hasMore'])
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT watermark FROM mobile_catalog_refresh_streams WHERE language='korean'").fetchone()[0], 2000)

    def test_overlap_keeps_both_languages_and_the_existing_group(self):
        worker = self.worker(lambda *_: page([1001]))
        self.request(worker); worker.run_once()
        first = self.search(text='id:1001').json()['items'][0]['groupId']
        worker.fetch_page = lambda *_: page([1001], 'japanese')
        self.request(worker, 'japanese'); worker.run_once()
        self.assertEqual(self.search(text='id:1001', language='japanese').json()['items'][0]['groupId'], first)
        self.assertEqual(self.search(text='id:1001', language='korean').json()['items'][0]['groupId'], first)

    def test_lease_loss_at_publication_rolls_back_all_visible_effects(self):
        worker = self.worker(lambda *_: page([1001]))
        before = self.search().json()['publicationRevision']
        job = self.request(worker)
        original = replica.prepare_users
        def expire(*args):
            original(*args)
            with self.get_db() as db:
                db.execute("UPDATE mobile_catalog_refresh_jobs SET lease=0 WHERE id=?", [job['id']]); db.commit()
        with mock.patch.object(replica, 'prepare_users', side_effect=expire):
            worker.run_once()
        self.assertEqual(self.search().json()['publicationRevision'], before)
        with self.get_db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM mobile_catalog_server_additions').fetchone()[0], 0)
        worker.run_once()
        self.assertEqual(worker.status()['state'], 'completed')

    def test_failure_retains_baseline_and_does_not_advance_stream(self):
        worker = self.worker(lambda *_: page([1001], "japanese"))
        before = self.search().json()["publicationRevision"]
        self.request(worker); worker.run_once()
        self.assertEqual(worker.status()["state"], "failed")
        self.assertEqual(self.search().json()["publicationRevision"], before)
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM mobile_catalog_refresh_streams").fetchone()[0], 0)

    def test_restart_resumes_staged_page_and_fences_previous_lease(self):
        calls = []
        worker = self.worker(lambda language, cursor: calls.append(cursor) or page(list(range(2000, 1950, -1))))
        job = self.request(worker)
        # Stop immediately after committing the first full page.
        with mock.patch.object(worker.stop, "wait", return_value=True):
            worker.run_once()
        with self.get_db() as db:
            old_owner = db.execute("SELECT owner FROM mobile_catalog_refresh_jobs WHERE id=?", [job["id"]]).fetchone()[0]
            db.execute("UPDATE mobile_catalog_refresh_jobs SET lease=0 WHERE id=?", [job["id"]]); db.commit()
        resumed = RefreshWorker(self.get_db, worker.root, lambda language, cursor: calls.append(cursor) or page([]))
        resumed.run_once()
        self.assertEqual(calls, [None, 1951])
        self.assertEqual(resumed.status()["state"], "completed")
        self.assertEqual(resumed.status()["added"], 50)
        with self.get_db() as db, self.assertRaises(Exception):
            worker.owned(db, job["id"], old_owner)

    def test_pc_user_edit_during_fetch_is_preserved(self):
        def fetch(*_):
            current = self.search().json()["publicationRevision"]
            users = copy.deepcopy(self.users); users["bookmarks"] = []
            self.assertEqual(self.publish(current, users).status_code, 200)
            return page([1001])
        worker = self.worker(fetch)
        self.request(worker); worker.run_once()
        self.assertEqual(worker.status()["state"], "completed")
        self.assertEqual(self.search(scope="bookmarked").json()["items"], [])

    def test_pc_publication_during_index_preparation_rebases_the_worker(self):
        worker = self.worker(lambda *_: page([1001]))
        self.request(worker)
        original, published = replica.prepare_users, []
        def prepare(*args):
            original(*args)
            if not published:
                published.append(True)
                users = copy.deepcopy(self.users); users['bookmarks'] = []
                current = self.search().json()['publicationRevision']
                response = self.publish(current, users)
                self.assertEqual(response.status_code, 200, response.text)
        with mock.patch.object(replica, 'prepare_users', side_effect=prepare):
            worker.run_once()
        self.assertEqual(worker.status()['state'], 'completed')
        self.assertEqual(self.search(scope='bookmarked').json()['items'], [])
        self.assertIn('1001', [item['providerWorkId'] for item in self.search().json()['items']])

    def test_api_auth_shape_bounds_and_real_worker_lifecycle(self):
        self.publish()
        def auth(value):
            if value != base.AUTH["Authorization"]:
                replica.fail(401)
        worker = register_refresh(self.app, self.get_db, lambda: self.root / "artifacts", auth, lambda *_: page([1001]))
        with self.client:
            self.assertEqual(self.client.post('/v1/mobile-catalog/refresh', json={}).status_code, 401)
            self.assertEqual(self.client.post('/v1/mobile-catalog/refresh', headers=base.AUTH, content=b'x'*1025).status_code, 413)
            response = self.client.post('/v1/mobile-catalog/refresh', headers=base.AUTH, json={"operationId": str(uuid.uuid4()), "language": "korean"})
            self.assertEqual(response.status_code, 202, response.text)
            deadline = time.monotonic() + 5
            while worker.status()["state"] in ("queued", "running") and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertEqual(self.client.get('/v1/mobile-catalog/refresh', headers=base.AUTH).json()["job"]["state"], "completed")
        self.assertFalse(worker.thread.is_alive())

    def test_parser_rejects_malformed_or_nonprogress_pages(self):
        for body in ('{}', page([2, 2]), page([1, 2]), page([1], 'japanese'), '[{"id":0}]', page(range(100, 49, -1))):
            with self.assertRaises((ValueError, TypeError)):
                parse_page(body, 'korean')
        row = parse_page(page([1]), 'korean')[0]
        self.assertEqual(row['work']['Rating'], 4.5)
        self.assertEqual(row['work']['Posted'], 1800000000)
