"""Stdlib SQLite coverage for mobile search and device filters over the shared PC fixture.

Only DDL constants are read from API-dependent modules; no HTTP dependencies are
stubbed. Publication and prepared-cache behavior are covered by the API tests.
"""
import ast
import contextlib

import json

import sqlite3
import sys

import unittest
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))



from mobile_catalog_query import (QueryError, compile_query, count_groups, detail, editions,  # noqa: E402
                                  freeze_query, mobile_query_text, parse_query, search_groups,
                                  tag_value_variants)


FIXTURE = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/mobile-catalog-v1.json").read_text(encoding="utf-8"))

# The fixture inserts group rows, but the group tables themselves belong to the
# API test's own DDL. A stdlib-only suite must supply them, so the constant is
# extracted from `tests/test_mobile_catalog.py` instead of being copied: one
# definition stays authoritative and this file cannot drift from it.
def ddl_constant(path, name):
    source = (SERVER_DIR / path).read_text(encoding="utf-8")
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == name for target in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found in {path}")


GROUP_DDL = ddl_constant("tests/test_mobile_catalog.py", "GROUP_DDL")
USER_DDL = ddl_constant("mobile_catalog_replica.py", "USER_DDL")
PROJECTION_DDL = ddl_constant("mobile_catalog_replica.py", "PROJECTION_DDL")

# Fixture facts: work 1 = "alpha" category 1 artist:foo; work 2 = "beta"
# category 2 artist:bar; work 3 = "alpha beta" category 1 artist:foo group:blocked;
# work 4 category 4 and hidden; work 5 category 1 artist:blocked; works 6 and 7
# share group g6. Visible latest-ordered default result is g1, g3, g6.
ALL = ["g1", "g3", "g6"]


def open_fixture(projection=False):
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(USER_DDL + GROUP_DDL + FIXTURE["setup"]
                     + (PROJECTION_DDL if projection else ""))
    return db


@contextlib.contextmanager
def fixture(projection=False):
    """The shared fixture as a context manager, so no connection is left open."""
    db = open_fixture(projection)
    try:
        yield db
    finally:
        db.close()


def build_projection(db):
    """The same work-state derivation `prepare_users` performs at publication."""
    db.execute("""INSERT INTO mobile_catalog_work_state
      SELECT work.Id,member.group_id,
        EXISTS(SELECT 1 FROM catalog.Tags tag WHERE tag.WorkId=work.Id AND tag.Namespace='language' AND tag.Value='korean'),
        EXISTS(SELECT 1 FROM catalog.Tags tag WHERE tag.WorkId=work.Id AND tag.Namespace='language' AND tag.Value='japanese'),
        NOT EXISTS(SELECT 1 FROM online_catalog_hidden_categories hidden WHERE hidden.category=work.Category)
          AND NOT EXISTS(SELECT 1 FROM catalog.Tags tag JOIN online_catalog_blocked_tags blocked
            ON blocked.namespace=tag.Namespace AND blocked.value=tag.Value WHERE tag.WorkId=work.Id),
        EXISTS(SELECT 1 FROM online_catalog_bookmarks bookmark WHERE bookmark.provider='kHentai' AND bookmark.work_id=CAST(work.Id AS TEXT))
      FROM catalog.Works work JOIN online_catalog_group_members member
        ON member.provider='kHentai' AND member.catalog_work_id=work.Id
      WHERE work.Expunged=0""")
    db.commit()


def add_work(db, work_id, title, tags=(), language="korean"):
    """One synthetic work in its own group, mirroring the fixture's shape."""
    db.execute("INSERT INTO catalog.Works VALUES(?,?,NULL,1,'Other',?,NULL,10,NULL,NULL,1,NULL,0)",
               [work_id, title, 5000 - work_id])
    for namespace, value in [*tags, ("language", language)]:
        db.execute("INSERT INTO catalog.Tags VALUES(?,?,?)", [work_id, namespace, value])
    db.execute("INSERT INTO online_catalog_group_members VALUES('kHentai',?,?,?,0,1,1)",
               [str(work_id), work_id, "g%d" % work_id])
    db.execute("INSERT INTO online_catalog_group_handles(provider,anchor_work_id,group_id,sequence) VALUES('kHentai',?,?,?)",
               [str(work_id), "g%d" % work_id, work_id])
    return "g%d" % work_id


def frozen(db, text="", **overrides):
    query = {"language": "all", "revealBlocked": False, "text": text, "scope": "all", "sort": "latest"}
    query.update(overrides)
    return freeze_query(db, query)


def groups(db, text="", **overrides):
    """Group ids and the exact count for one query, as the list and count routes read it."""
    query = frozen(db, text, **overrides)
    return [row["groupId"] for row in search_groups(db, query)], count_groups(db, query)


class PlainPhraseSearchTests(unittest.TestCase):
    """`searchMode=mobile` on a whole plain value, and its legacy counterpart."""

    def test_plain_phrase_matches_both_stored_tag_spellings(self):
        with fixture() as db:
            # Work 2 stores 'john doe' (g1); work 3 stores 'john_doe' (g3).
            db.execute("INSERT INTO catalog.Tags VALUES(2,'artist','john doe')")
            db.execute("INSERT INTO catalog.Tags VALUES(3,'artist','john_doe')")
            self.assertEqual(groups(db, "john doe", searchMode="mobile")[0], ["g1", "g3"])
            self.assertEqual(groups(db, "john_doe", searchMode="mobile")[0], ["g1", "g3"])
            self.assertEqual(groups(db, "john doe", searchMode="mobile")[1], 2)

    def test_namespaced_plain_phrase_matches_both_spellings_inside_one_namespace(self):
        with fixture() as db:
            db.execute("INSERT INTO catalog.Tags VALUES(2,'artist','john doe')")
            db.execute("INSERT INTO catalog.Tags VALUES(3,'artist','john_doe')")
            for text in ("artist:john doe", "artist:john_doe", 'artist:"john doe"', 'artist:"john_doe"'):
                self.assertEqual(groups(db, text, searchMode="mobile")[0], ["g1", "g3"], text)
            # A phrase stays inside the namespace it names.
            self.assertEqual(groups(db, "parody:john_doe", searchMode="mobile")[0], [])
            self.assertEqual(groups(db, "group:blocked", searchMode="mobile")[0], ["g3"])

    def test_legacy_reading_is_unchanged_when_no_mode_is_sent(self):
        with fixture() as db:
            db.execute("INSERT INTO catalog.Tags VALUES(2,'artist','john doe')")
            db.execute("INSERT INTO catalog.Tags VALUES(3,'artist','john_doe')")
            # An omitted mode keeps the historical exact-stored-spelling behaviour.
            self.assertEqual(groups(db, "john doe")[0], [])
            self.assertEqual(groups(db, "john_doe")[0], [])
            self.assertEqual(groups(db, "artist:john_doe")[0], ["g3"])
            # The legacy tokenizer ends the value at the space, so the trailing
            # word becomes an unrelated title term and finds nothing here.
            self.assertEqual(groups(db, "artist:john doe")[0], [])

    def test_plain_phrase_ast_keeps_the_legacy_title_branch(self):
        # The phrase node carries the legacy title expression plus the exact forms.
        self.assertEqual(mobile_query_text("foo", "mobile"), ("phrase", ("title", "foo"), ("foo",)))
        self.assertEqual(mobile_query_text("john doe", "mobile"),
                         ("phrase", ("and", ("title", "john"), ("title", "doe")), ("john doe", "john_doe")))
        self.assertEqual(mobile_query_text("john_doe", "mobile"),
                         ("phrase", ("title", "john_doe"), ("john_doe", "john doe")))
        # Without the mode the wrapper is exactly the legacy parser.
        self.assertEqual(mobile_query_text("john doe"), parse_query("john doe"))
        self.assertEqual(mobile_query_text(""), parse_query(""))

    def test_plain_phrase_compiles_title_words_or_exact_tag_values(self):
        sql, params = compile_query(mobile_query_text("john doe", "mobile"))
        self.assertIn("work.Title LIKE", sql)
        self.assertIn("t.Value IN (?,?)", sql)
        # The title branch keeps the phrase's own words only, so no separator
        # rewriting reaches the title pattern.
        self.assertEqual(params.count("%john%"), 2)
        self.assertEqual(params.count("%doe%"), 2)
        self.assertEqual(params.count("john doe"), 1)
        self.assertEqual(params.count("john_doe"), 1)
        # An exact value comparison is used, never a pattern on tag text.
        self.assertNotIn("t.Value LIKE", sql)

    def test_title_branch_keeps_word_semantics_not_underscore_wildcards(self):
        with fixture() as db:
            space_title = add_work(db, 13, "john doe")
            underscore_title = add_work(db, 14, "john_doe")
            # A plain phrase searches its own words, so both stored title
            # spellings are reachable through the title branch.
            self.assertEqual(groups(db, "john doe", searchMode="mobile")[0], [space_title, underscore_title])
            # A one-word phrase is a literal substring: 'john' is in 'john_doe'.
            self.assertEqual(sorted(groups(db, "john", searchMode="mobile")[0]),
                             sorted([underscore_title, space_title]))
            # The underscore spelling is literal for the title branch, so it
            # matches its own stored form and not the spaced one.
            self.assertEqual(groups(db, "john_doe", searchMode="mobile")[0], [underscore_title])

    def test_underscore_and_percent_are_never_wildcards(self):
        with fixture() as db:
            artist = add_work(db, 11, "artist")
            artxst = add_work(db, 12, "artXst")
            under = add_work(db, 10, "under_score")
            percent = add_work(db, 8, "100%_")
            percent_other = add_work(db, 9, "100%X")
            # `_` stays a literal for a plain phrase's title branch: 'art_st'
            # reaches neither 'artist' nor 'artXst'.
            self.assertEqual(groups(db, "art_st", searchMode="mobile")[0], [])
            # `%` never wildcards, so '100%_' does not match the stored '100%X'.
            self.assertEqual(groups(db, "100%_", searchMode="mobile")[0], [percent])
            # A stored underscore still matches its own literal spelling.
            self.assertEqual(groups(db, "under_score", searchMode="mobile")[0], [under])
            # The legacy reading of the same literals is unchanged.
            self.assertEqual(groups(db, "100%_")[0], [percent])
            self.assertEqual(groups(db, "art_st")[0], [])
            self.assertEqual(groups(db, "under_score")[0], [under])
            self.assertTrue(artist and artxst and percent_other)

    def test_exact_tag_forms_do_not_widen_beyond_separator_spellings(self):
        with fixture() as db:
            # A partial phrase is a different exact value, so the tag candidate
            # misses while the title branch still finds a substring.
            underscore = add_work(db, 10, "under_score")
            self.assertEqual(groups(db, "under", searchMode="mobile")[0], [underscore])
            self.assertEqual(tag_value_variants("under_score"), ("under_score", "under score"))
            self.assertEqual(tag_value_variants("under%score"), ("under%score",))
            self.assertEqual(tag_value_variants(""), ())

    def test_tag_value_variants_pair_with_the_stored_tag_text(self):
        with fixture() as db:
            # Both directions produce the same two exact candidates.
            spaced = add_work(db, 20, "no title match", tags=[("artist", "a b")])
            underscored = add_work(db, 21, "no title match", tags=[("artist", "a_b")])
            for text in ("artist:a b", "artist:a_b"):
                self.assertEqual(groups(db, text, searchMode="mobile")[0], [spaced, underscored], text)
            # An explicit single value stays exact when it names only one spelling.
            self.assertEqual(groups(db, "artist:a", searchMode="mobile")[0], [])


class AdvancedExpressionSearchTests(unittest.TestCase):
    """Advanced grammar keeps its meaning; only exact tag spellings gain aliases."""

    def test_boolean_and_field_semantics_are_preserved(self):
        with fixture() as db:
            db.execute("INSERT INTO catalog.Tags VALUES(2,'artist','john doe')")
            # An advanced expression keeps its shape; only the exact tag leaves gain
            # separator aliases of their own stored spelling.
            self.assertEqual(mobile_query_text("artist:foo AND pages>=100", "mobile"),
                             ("and", ("tag_variants", "artist", ("foo",)), ("pages", ">=", 100)))
            self.assertEqual(mobile_query_text("id:1 OR artist:foo", "mobile"),
                             ("or", ("id", 1), ("tag_variants", "artist", ("foo",))))
            self.assertEqual(mobile_query_text("category:1 artist:foo", "mobile"),
                             ("and", ("category", 1), ("tag_variants", "artist", ("foo",))))
            # `artist:foo AND pages>=100` still means work 3 alone.
            self.assertEqual(groups(db, "artist:foo AND pages>=100", searchMode="mobile")[0], ["g3"])
            # A boolean keeps the legacy title-only reading of its words: a
            # namespace-free word never becomes a tag lookup in mobile mode.
            self.assertEqual(parse_query("a OR b"), ("or", ("title", "a"), ("title", "b")))
            self.assertEqual(mobile_query_text("john OR doe", "mobile"), parse_query("john OR doe"))

    def test_advanced_expression_only_aliases_exact_tag_spellings(self):
        expr = mobile_query_text("artist:john_doe AND pages>=100", "mobile")
        self.assertEqual(expr, ("and", ("tag_variants", "artist", ("john_doe", "john doe")), ("pages", ">=", 100)))
        # A negated tag keeps the alias inside the negation.
        self.assertEqual(mobile_query_text("-artist:john_doe", "mobile"),
                         ("not", ("tag_variants", "artist", ("john_doe", "john doe"))))
        # Non-tag leaves are untouched.
        self.assertEqual(mobile_query_text("id:1 artist:john_doe", "mobile"),
                         ("and", ("id", 1), ("tag_variants", "artist", ("john_doe", "john doe"))))

    def test_negation_stays_title_only_for_a_bare_word(self):
        with fixture() as db:
            # `-foo` negates the legacy title reading, not a tag lookup. Work 4 is
            # hidden and work 5 carries a blocked tag, so both need revealBlocked.
            self.assertEqual(mobile_query_text("-foo", "mobile"), ("not", ("title", "foo")))
            self.assertEqual(groups(db, "-foo", searchMode="mobile", revealBlocked=True)[0],
                             ["g4", "g5", "g1", "g3", "g6"])
            # A namespace-free `foo OR foo` is still two title terms.
            self.assertEqual(groups(db, "foo OR foo", searchMode="mobile")[0], [])

    def test_quote_and_field_value_bounds_are_unchanged(self):
        # A quoted value is one token, so the space inside it stays part of the
        # value rather than starting a new title term.
        self.assertEqual(parse_query('artist:"john doe"'), ("tag", "artist", "john doe"))
        self.assertEqual(parse_query("artist:john_doe"), ("tag", "artist", "john_doe"))
        self.assertEqual(mobile_query_text("artist:john_doe", "mobile")[0], "tag_variants")


class ParseLimitTests(unittest.TestCase):
    """The parser's byte and token budgets, applied before any convenience form."""

    def test_source_over_4096_bytes_is_rejected(self):
        with self.assertRaises(QueryError) as raised:
            parse_query("a" * 4097)
        self.assertEqual(raised.exception.span["start"], 4096)
        # One byte under the limit still parses.
        self.assertEqual(parse_query("a" * 4096), ("title", "a" * 4096))
        # The same limit applies to a multibyte source.
        with self.assertRaises(QueryError):
            parse_query("\uac00" * 1366)

    def test_more_than_256_tokens_is_rejected(self):
        with self.assertRaises(QueryError):
            parse_query("a " * 257)
        self.assertIsNotNone(parse_query("a " * 256))

    def test_mobile_wrapper_parses_first_so_plain_input_is_bounded_too(self):
        # The convenience path must not bypass the parser's own limits.
        with self.assertRaises(QueryError):
            mobile_query_text("a " * 257, "mobile")
        with self.assertRaises(QueryError):
            mobile_query_text("a" * 4097, "mobile")

    def test_advanced_grammar_errors_are_still_errors(self):
        for text in ("alpha OR", "alpha AND", "id:john doe", "pages:john doe",
                     '"unclosed', "(alpha", "pages>-1", "id:0", "category:12"):
            with self.assertRaises(QueryError, msg=text):
                mobile_query_text(text, "mobile")
        # A field followed by a comparison is valid grammar, not an error: the
        # value token 'john' is simply a name that no number rule accepts.
        self.assertEqual(mobile_query_text("artist:john pages>=100", "mobile"),
                         ("and", ("tag_variants", "artist", ("john",)), ("pages", ">=", 100)))


class DeviceFilterQueryTests(unittest.TestCase):
    """Categories and excluded tags, enforced identically on every read context."""

    def test_omitted_categories_are_unrestricted_and_empty_admits_nothing(self):
        with fixture() as db:
            self.assertEqual(groups(db)[0], ALL)
            self.assertEqual(groups(db, categories=[1])[0], ["g3", "g1", "g6"])
            self.assertEqual(groups(db, categories=[]), ([], 0))

    def test_category_selection_is_an_or_of_ids_and_respects_policy(self):
        with fixture() as db:
            # Only work 2 is category 2, only work 4 is category 4, no work is 3.
            self.assertEqual(groups(db, categories=[2])[0], ["g1"])
            self.assertEqual(groups(db, categories=[3])[0], [])
            self.assertEqual(groups(db, categories=[2, 3])[0], ["g1"])
            # Category 4 is hidden by policy, so it needs revealBlocked too.
            self.assertEqual(groups(db, categories=[4])[0], [])
            self.assertEqual(groups(db, revealBlocked=True, categories=[4])[0], ["g4"])

    def test_excluded_tags_match_exact_namespace_and_value_only(self):
        with fixture() as db:
            self.assertEqual(groups(db, excludedTags=[("artist", "foo")])[0], ["g1", "g6"])
            # "blocked" exists as artist:blocked (work 5) and group:blocked (work 3).
            self.assertEqual(groups(db, excludedTags=[("artist", "blocked")])[0], ["g1", "g3", "g6"])
            self.assertEqual(groups(db, excludedTags=[("group", "blocked")])[0], ["g1", "g6"])
            # Two exclusions intersect.
            self.assertEqual(groups(db, excludedTags=[("artist", "foo"), ("artist", "bar")])[0], ["g6"])

    def test_filters_apply_even_when_policy_is_revealed(self):
        with fixture() as db:
            self.assertEqual(groups(db, revealBlocked=True)[0], ["g4", "g5", "g1", "g3", "g6"])
            self.assertEqual(groups(db, revealBlocked=True, categories=[4])[0], ["g4"])
            self.assertEqual(groups(db, revealBlocked=True, excludedTags=[("artist", "blocked")])[0],
                             ["g4", "g1", "g3", "g6"])
            self.assertEqual(groups(db, revealBlocked=True, excludedTags=[("artist", "blocked")], categories=[1])[0],
                             ["g3", "g1", "g6"])

    def test_filters_compose_with_language_and_every_sort(self):
        with fixture() as db:
            self.assertEqual(groups(db, language="korean", categories=[1])[0], ["g3", "g1", "g6"])
            for sort in ("latest", "views", "hotDay", "hotWeek", "hotMonth"):
                items, total = groups(db, sort=sort, categories=[1])
                self.assertEqual(sorted(items), ["g1", "g3", "g6"], sort)
                self.assertEqual(total, 3, sort)
                items, total = groups(db, sort=sort, categories=[])
                self.assertEqual((items, total), ([], 0), sort)

    def test_filters_bind_detail_and_editions(self):
        with fixture() as db:
            excluded = frozen(db, excludedTags=[("artist", "foo")])
            self.assertIsNone(detail(db, 1, excluded))
            self.assertIsNotNone(detail(db, 2, excluded))
            result = editions(db, "g1", excluded, 0, 10)
            # Work 1 is excluded, so only work 2 remains in g1's editions.
            self.assertEqual([item["providerWorkId"] for item in result["items"]], ["2"])
            self.assertEqual(result["totalCount"], 1)
            empty = frozen(db, categories=[])
            self.assertIsNone(detail(db, 1, empty))
            self.assertEqual(editions(db, "g1", empty, 0, 10)["totalCount"], 0)
            self.assertIsNone(editions(db, "missing-group", excluded, 0, 10))

    def test_exclusion_is_negated_exact_pairs_not_a_tag_wide_rewrite(self):
        from mobile_catalog_query import eligible
        with fixture() as db:
            query = frozen(db, excludedTags=[("artist", "foo"), ("parody", "b")])
            where, values = eligible(query)
            # Each pair is one equality on namespace and value, in order.
            self.assertEqual(where.count("(t.Namespace=? AND t.Value=?)"), 2)
            self.assertEqual(values, ["artist", "foo", "parody", "b"])
            self.assertNotIn("LIKE", where)

    def test_prepared_state_and_fallback_paths_agree(self):
        with fixture() as db:
            fallback = groups(db, categories=[1], excludedTags=[("artist", "blocked")])
            self.assertFalse(frozen(db, categories=[1])["preparedState"])
        with fixture(projection=True) as db:
            build_projection(db)
            prepared_query = frozen(db, categories=[1], excludedTags=[("artist", "blocked")])
            self.assertTrue(prepared_query["preparedState"])
            prepared = ([row["groupId"] for row in search_groups(db, prepared_query)],
                        count_groups(db, prepared_query))
            self.assertEqual(prepared, fallback)
            # detail and editions agree with the list on the prepared path too.
            self.assertIsNone(detail(db, 5, prepared_query))
            self.assertEqual([item["providerWorkId"] for item in editions(db, "g1", prepared_query, 0, 10)["items"]],
                             ["1"])



    def test_filters_never_write_visibility_policy(self):
        with fixture() as db:
            before = list(map(tuple, db.execute("SELECT category FROM online_catalog_hidden_categories ORDER BY 1")))
            before += list(map(tuple, db.execute("SELECT namespace,value FROM online_catalog_blocked_tags ORDER BY 1,2")))
            frozen(db, revealBlocked=True, categories=[2], excludedTags=[("artist", "foo")])
            groups(db, revealBlocked=True, categories=[2], excludedTags=[("artist", "foo")])
            after = list(map(tuple, db.execute("SELECT category FROM online_catalog_hidden_categories ORDER BY 1")))
            after += list(map(tuple, db.execute("SELECT namespace,value FROM online_catalog_blocked_tags ORDER BY 1,2")))
            self.assertEqual(after, before)


class SharedFixtureContractTests(unittest.TestCase):
    """The fixture stays the single definition this suite and the Rust oracle share."""

    def test_fixture_queries_hold_for_the_frozen_query_path(self):
        with fixture() as db:
            for case in FIXTURE["queries"]:
                query = {key: value for key, value in case.items() if key != "expected"}
                query["sort"] = "latest"
                frozen_query = freeze_query(db, query)
                actual = [[row["groupId"], int(row["providerWorkId"]), row["versionCount"],
                           row["hasBookmarkedVersion"]] for row in search_groups(db, frozen_query)]
                self.assertEqual(actual, case["expected"], case)
                self.assertEqual(count_groups(db, frozen_query), len(actual))

    def test_fixture_invalid_queries_stay_invalid(self):
        for text in [*FIXTURE["invalid"], "a" * 4097, "a " * 257]:
            with self.assertRaises(QueryError, msg=text[:40]):
                parse_query(text)

    def test_legacy_results_are_unchanged_by_the_mobile_wrapper(self):
        # Replaying every fixture query through the mobile wrapper without the
        # mode must reproduce the legacy result byte for byte.
        with fixture() as db:
            for case in FIXTURE["queries"]:
                query = {key: value for key, value in case.items() if key != "expected"}
                query["sort"] = "latest"
                self.assertEqual(mobile_query_text(query.get("text", "")), parse_query(query.get("text", "")))

    def test_group_ddl_extraction_matches_the_api_test_definition(self):
        # The extraction must produce usable DDL, so prove it builds the tables the
        # fixture's inserts depend on.
        db = sqlite3.connect(":memory:")
        db.executescript(GROUP_DDL)
        names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertEqual(names, {"online_catalog_group_members", "online_catalog_group_handles"})
        db.close()


if __name__ == "__main__":
    unittest.main()
