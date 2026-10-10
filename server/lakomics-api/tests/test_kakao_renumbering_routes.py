"""HTTP/projection acceptance for Kakao moves, with fake provider transport."""
import datetime
import unittest

import collection_release_checks as rc
from tests import test_collection_authority as authority_fixtures
from tests import test_kakao_bind_routes as bind_routes
from tests.test_kakao_renumbering import renumber


class KakaoRenumberingRouteTests(unittest.TestCase):
    setUp = bind_routes.KakaoBindRouteTests.setUp
    body = bind_routes.KakaoBindRouteTests.body
    submit = bind_routes.KakaoBindRouteTests.submit

    def detail(self):
        return self.fixture.ok(self.fixture.client.get(
            "/v1/collections/a", headers=self.fixture.auth))["item"]

    def bind(self):
        self.transport.return_value = (self.items, 0)
        body = self.body()
        request = self.submit(body)
        self.worker.execute(request["requestId"])
        self.assertEqual(self.submit(body)["state"], "applied")

    def rows(self):
        with authority_fixtures.api_app.get_db() as db:
            return {table: [dict(row) for row in db.execute(
                f"SELECT * FROM {table} WHERE work_id='a' ORDER BY rowid")]
                for table in ("collection_authority_volumes", "collection_authority_ownership")}

    def scenario(self, initial_numbers, next_numbers, new=False, refresh=False):
        # Keep product IDs fixed while changing only their volume numbers.
        initial = [dict(self.items[0], itemId=f"product:{i}", volumeNumber=n,
                        title=f"던전밥 {n}") for i, n in enumerate(initial_numbers)]
        self.items = initial
        self.bind()
        fixture = self.fixture
        fixture.ok(fixture.command("upsertVolume", headers=fixture.publisher, workId="a",
            volumeId="edition-31", volumeNumber=31, editionIndex=1, sortOrder=99,
            displayLabel="special", coverArtworkId="cover", sourceProvider="mangadex",
            sourceCoverId="special-cover", deleted=False, expectedRevision=0))
        fixture.ok(fixture.command("setOwnershipTracking", headers=fixture.publisher, workId="a", editionIndex=0,
            count=31, expectedCount=None, expectedRevision=None))
        fixture.ok(fixture.command("setVolumeOwnership", headers=fixture.publisher, workId="a", volumeNumber=31,
            editionIndex=1, physical=True, digital=True, expectedRevision=0))
        fixture.ok(fixture.command("setReleaseSubscription", headers=fixture.publisher, workId="a", enabled=True,
            expectedEnabled=False, expectedRevision=None))
        before = self.rows()
        additions = [dict(initial[0], itemId="new:32", volumeNumber=32, title="던전밥 32")] if new else []
        self.items = renumber(initial, next_numbers, additions)
        self.transport.return_value = (self.items, 0)
        if refresh:
            with authority_fixtures.api_app.get_db() as db:
                rc.startup_db(db)
                db.commit()
            checker = rc.Worker(authority_fixtures.api_app.get_db)
            moment = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)
            self.assertEqual(checker.check_work("a", moment), new)
            self.assertFalse(checker.check_work("a", moment))
        else:
            self.bind()
        after = self.rows()
        for table, rows in before.items():
            for row in rows:
                self.assertIn(row, after[table])
        detail = self.detail()
        self.assertEqual(detail["volumes"][0]["coverArtworkId"], "cover")
        with authority_fixtures.api_app.get_db() as db:
            sources = [(row[0], row[1]) for row in db.execute(
                "SELECT volume_number,provider_item_id FROM collection_authority_volume_sources"
                " WHERE work_id='a' AND deleted=0 ORDER BY volume_number")]
            events = [(row[0], row[1]) for row in db.execute(
                "SELECT kind,volume_number FROM collection_release_events WHERE collection_id='a'")]
        self.assertEqual(sources, sorted((item["volumeNumber"], item["itemId"]) for item in self.items))
        self.assertEqual(events, [("new_volume", 32)] if refresh and new else [])
        release_reply = fixture.ok(fixture.client.get("/v1/collections/releases", headers=fixture.auth))
        self.assertEqual(release_reply["counts"]["unread"], int(refresh and new))

    def test_refresh_31_to_30(self):
        self.scenario((31,), (30,), refresh=True)

    def test_refresh_swap(self):
        self.scenario((30, 31), (31, 30), refresh=True)

    def test_refresh_move_plus_new_volume(self):
        self.scenario((31,), (30,), new=True, refresh=True)

    def test_bind_31_to_30(self):
        self.scenario((31,), (30,))

    def test_bind_swap(self):
        self.scenario((30, 31), (31, 30))

    def test_bind_move_plus_new_volume(self):
        self.scenario((31,), (30,), new=True)
