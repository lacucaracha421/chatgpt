"""Mobile catalog tag autocomplete and short namespace forms; all data is synthetic."""
import sqlite3
import threading
import unittest

from tests import test_mobile_catalog as base
import mobile_catalog_replica as replica
import mobile_catalog_suggestions as suggestions
from mobile_catalog_query import expand_namespace, mobile_query_text, parse_query

AUTH = base.AUTH
# Fixture tag uses: language:korean 5, language:japanese 2, artist:foo 2, artist:bar 1,
# artist:blocked 1 (blocked by policy), group:blocked 1. EXTRA adds female:big breasts 3
# and a Korean label for artist:foo.
EXTRA = ("INSERT INTO catalog.Tags VALUES(1,'female','big breasts'),(2,'female','big breasts'),(3,'female','big breasts');"
         "INSERT INTO catalog.Translations VALUES('artist','foo','푸 작가');")


def projection(extra=EXTRA):
    """The shared fixture projection plus extra synthetic source rows."""
    setup = base.FIXTURE["setup"]
    base.FIXTURE["setup"] = setup + ";" + extra
    try:
        return base.fixture_projection()
    finally:
        base.FIXTURE["setup"] = setup


class SuggestionApiTests(unittest.TestCase):
    setUp = base.MobileCatalogApiTests.setUp
    tearDown = base.MobileCatalogApiTests.tearDown

    def publish(self, users=None):
        self.data, self.digest, self.users = projection()
        result = base.MobileCatalogApiTests.publish(self, users=users)
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def suggest(self, text, headers=AUTH, **params):
        return self.client.get("/v1/mobile-catalog/suggestions", headers=headers, params={"text": text, **params})

    def values(self, text, **params):
        response = self.suggest(text, **params)
        self.assertEqual(response.status_code, 200, response.text)
        return [item["value"] for item in response.json()["items"]]

    def test_status_advertises_the_capability(self):
        status = self.client.get("/v1/mobile-catalog/status", headers=AUTH).json()
        self.assertIs(status["capabilities"]["suggestions"], True)

    def test_orders_by_use_then_text_and_reports_count_and_label(self):
        self.publish()
        body = self.suggest("a").json()
        self.assertTrue(body["ready"])
        self.assertEqual([item["value"] for item in body["items"]], [
            "language:korean", "female:big breasts", "artist:foo", "language:japanese", "artist:bar"])
        foo = next(item for item in body["items"] if item["value"] == "artist:foo")
        self.assertEqual(foo, {"value": "artist:foo", "label": "푸 작가", "count": 2})
        self.assertIsNone(body["items"][0]["label"])

    def test_limit_defaults_to_ten_and_is_bounded(self):
        self.publish()
        self.assertEqual(self.values("a", limit=2), ["language:korean", "female:big breasts"])
        for limit in ("0", "11", "x"):
            self.assertEqual(self.suggest("a", limit=limit).status_code, 400, limit)
        self.assertEqual(suggestions.MAX_LIMIT, 10)

    def test_case_insensitive_namespace_label_and_short_namespace_input(self):
        self.publish()
        self.assertEqual(self.values("ARTIST:F"), ["artist:foo"])
        self.assertEqual(self.values("artist:fo"), ["artist:foo"])
        self.assertEqual(self.values("a:fo"), ["artist:foo"])
        self.assertEqual(self.values("F:BIG"), ["female:big breasts"])
        self.assertEqual(self.values("푸"), ["artist:foo"])
        self.assertEqual(self.values("zzz"), [])

    def test_blocked_tags_only_with_reveal_blocked(self):
        self.publish()
        self.assertEqual(self.values("blocked"), ["group:blocked"])
        self.assertEqual(self.values("a:b"), ["artist:bar"])
        self.assertEqual(self.values("blocked", revealBlocked="true"), ["artist:blocked", "group:blocked"])
        self.assertEqual(self.suggest("blocked", revealBlocked="yes").status_code, 400)

    def test_rejects_empty_oversized_missing_and_unknown_parameters(self):
        self.publish()
        self.assertEqual(self.suggest("").status_code, 422)
        self.assertEqual(self.suggest("   ").status_code, 422)
        self.assertEqual(self.suggest("가" * 67).status_code, 422)  # 201 bytes
        self.assertEqual(self.suggest("a" * 200).status_code, 200)
        self.assertEqual(self.client.get("/v1/mobile-catalog/suggestions", headers=AUTH).status_code, 400)
        self.assertEqual(self.suggest("a", language="all").status_code, 400)

    def test_requires_client_auth_and_reports_unpublished(self):
        self.assertEqual(self.suggest("a", headers={}).status_code, 401)
        self.assertEqual(self.suggest("a", headers={"Authorization": "Bearer wrong"}).status_code, 401)
        self.assertEqual(self.suggest("a").json(), {"ready": False, "publicationRevision": None, "items": []})

    def test_a_new_publication_replaces_the_cached_index(self):
        first = self.publish()["publicationRevision"]
        self.assertEqual(self.values("blocked"), ["group:blocked"])
        changed = self.client.put("/v1/mobile-catalog/visibility", headers=AUTH,
                                  json={"hiddenCategories": [[4, "now"]], "blockedTags": []})
        self.assertEqual(changed.status_code, 200, changed.text)
        second = changed.json()["publicationRevision"]
        self.assertNotEqual(first, second)
        body = self.suggest("blocked").json()
        self.assertEqual(body["publicationRevision"], second)
        self.assertEqual([item["value"] for item in body["items"]], ["artist:blocked", "group:blocked"])


class SuggestionCacheTests(unittest.TestCase):
    def open(self, extra=""):
        db = sqlite3.connect(":memory:", check_same_thread=False)
        db.executescript(replica.USER_DDL + base.GROUP_DDL + base.FIXTURE["setup"] + ";" + extra)
        self.addCleanup(db.close)
        return db

    def test_builds_once_per_revision_even_under_concurrent_first_requests(self):
        db, cache = self.open(), suggestions.SuggestionCache()
        results = []
        threads = [threading.Thread(target=lambda: results.append(cache.index("r1", db))) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(cache.builds, 1)
        self.assertTrue(all(result is results[0] for result in results))
        newer = self.open("INSERT INTO catalog.Tags VALUES(1,'artist','zeta');")
        self.assertIn("artist:zeta", [entry[0] for entry in cache.index("r2", newer)])
        self.assertEqual(cache.builds, 2)
        self.assertIs(cache.index("r2", db), cache.index("r2", newer))

    def test_match_stops_at_the_limit(self):
        index = suggestions.build_index(self.open())
        self.assertEqual(len(suggestions.match(index, "a", 3)), 3)


class ShortNamespaceTests(unittest.TestCase):
    def test_short_forms_expand_to_catalog_namespaces_only(self):
        self.assertEqual(expand_namespace("A"), "artist")
        self.assertEqual(expand_namespace("cos"), "cosplayer")
        self.assertEqual(expand_namespace("loc"), "location")
        self.assertEqual(expand_namespace("r"), "r")
        self.assertEqual(expand_namespace("female"), "female")

    def test_every_grammar_position_reads_the_full_namespace(self):
        self.assertEqual(parse_query("a:asanagi"), parse_query("artist:asanagi"))
        self.assertEqual(parse_query('-f:"big breasts" OR (c:x AND p:y)'),
                         parse_query('-female:"big breasts" OR (character:x AND parody:y)'))
        self.assertEqual(mobile_query_text("a:asanagi", "mobile"), mobile_query_text("artist:asanagi", "mobile"))
        self.assertEqual(mobile_query_text("f:big breasts", "mobile"), ("tag_variants", "female", ("big breasts", "big_breasts")))
        self.assertEqual(mobile_query_text("-a:foo", "mobile"), mobile_query_text("-artist:foo", "mobile"))


if __name__ == "__main__":
    unittest.main()
