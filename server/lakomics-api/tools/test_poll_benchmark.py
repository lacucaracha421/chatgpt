"""Local-only benchmark contracts. No TestClient/thread bridge or network required."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import poll_benchmark as perf
import asset_filters


class BenchmarkTest(unittest.TestCase):
    def test_reuse_refuses_unmarked_data_without_touching_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "lakomics.sqlite3"
            database.write_bytes(b"not a benchmark")
            with self.assertRaisesRegex(ValueError, "marker"):
                perf.prepare_root(root)
            self.assertEqual(database.read_bytes(), b"not a benchmark")
            self.assertFalse((root / perf.MARKER).exists())

    def test_reuse_requires_same_fixture_and_no_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            perf.prepare_root(root)
            perf.prepare_root(root)
            (root / "bad").symlink_to("/tmp")
            with self.assertRaisesRegex(ValueError, "symlinks"):
                perf.prepare_root(root)

    def test_nearest_rank_p95_and_status_failures(self):
        response = SimpleNamespace(status_code=200, content=b"{}", text="{}", headers={})
        client = SimpleNamespace(get=lambda *args, **kwargs: response)
        spec = ("example", "GET", "/v1/library/assets", {}, None, None)
        with patch.object(perf.time, "perf_counter", side_effect=[0, .001, 1, 1.003]):
            result = perf.measure(client, spec, 2, 0)
        self.assertEqual(result["p95_ms"], 3)
        self.assertEqual(result["requests"], 2)
        self.assertEqual(result["bytes_min"], 2)
        response.status_code = 422
        with self.assertRaisesRegex(RuntimeError, "expected 200"):
            perf.measure(client, spec, 1, 0)
        with self.assertRaises(ValueError):
            perf.measure(client, spec, 0, 0)

    def test_304_requires_etag(self):
        client = SimpleNamespace(get=lambda *args, **kwargs: SimpleNamespace(status_code=200, headers={}))
        with self.assertRaisesRegex(RuntimeError, "ETag"):
            perf.measure(client, ("status (304)", "GET", "/v1/sync/status", {}, None, None), 1, 0)

    def test_routes_and_parameter_names_still_exist(self):
        routes = {route.path: route for route in perf.api.app.routes if hasattr(route, "dependant")}
        for name, method, path, headers, params, body in perf.endpoints("client", "publisher"):
            if path == "/_bench/noop":
                continue
            self.assertIn(path, routes, name)
            self.assertIn(method, routes[path].methods, name)
            # Some routes explicitly parse request.query_params, others use FastAPI fields.
            fields = routes[path].dependant.query_params
            if fields and params:
                self.assertTrue(set(params) <= {field.alias for field in fields}, name)

    def test_fixture_populates_real_suggestion_and_filter_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            perf.boot(Path(directory))
            perf.populate(Path(directory))
            with perf.api.get_db() as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM assets").fetchone()[0], perf.SIZES["assets"])
                self.assertGreater(db.execute("SELECT COUNT(*) FROM library_tag_counts WHERE count>0").fetchone()[0], 0)
                for filters in (asset_filters.parse("images", "portrait"),
                                asset_filters.parse("videos", duration_min=10000, duration_max=20000),
                                asset_filters.parse(tags=["tag-1"], artist="artist-1")):
                    clause, params = asset_filters.filter_clause(filters)
                    self.assertGreater(db.execute("SELECT COUNT(*) FROM assets asset WHERE 1=1 " + clause, params).fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
