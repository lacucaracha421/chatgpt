"""Socket-free tests of the request marker and actual SQLite interruption."""
import contextvars
from contextlib import closing
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
import tests.test_capture_api_stub  # noqa: F401
import app as api
import read_budget

EXPENSIVE = 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n'


def complete(coroutine):
    try:
        coroutine.send(None)
    except StopIteration as done:
        return done.value
    finally:
        coroutine.close()
    raise AssertionError('Unexpected asynchronous IO')


class ReadBudgetTests(unittest.TestCase):
    def test_interrupts_real_sql_and_translates_only_its_own_interrupt(self):
        with closing(sqlite3.connect(':memory:')) as db:
            budget = read_budget.install(db, seconds=0)
            with self.assertRaises(sqlite3.OperationalError) as raised:
                db.execute(EXPENSIVE).fetchone()
            with self.assertRaises(HTTPException) as translated:
                budget.translate(raised.exception)
            self.assertEqual(translated.exception.status_code, 503)
            budget.translate(sqlite3.OperationalError('no such table'))
            db.set_progress_handler(None, 0)
            self.assertEqual(db.execute('SELECT 42').fetchone()[0], 42)

    def test_connection_translates_and_closes_on_timeout(self):
        original = read_budget.install
        with tempfile.TemporaryDirectory() as tmp, patch.object(api, 'DB_PATH', Path(tmp) / 'test.sqlite'):
            token = read_budget.http_read.set(True)
            try:
                with patch.object(read_budget, 'install', side_effect=lambda db: original(db, seconds=0)):
                    with self.assertRaises(HTTPException) as raised:
                        with api.get_db() as db:
                            db.execute(EXPENSIVE).fetchone()
                self.assertEqual(raised.exception.status_code, 503)
                with self.assertRaises(sqlite3.ProgrammingError):
                    db.execute('SELECT 1')
            finally:
                read_budget.http_read.reset(token)
            with api.get_db() as db:
                self.assertEqual(db.execute('SELECT 1').fetchone()[0], 1)

    def test_fetching_and_later_statements_share_the_connection_deadline(self):
        with closing(sqlite3.connect(':memory:')) as db:
            with patch.object(read_budget.time, 'monotonic', return_value=100):
                budget = read_budget.install(db)
                cursor = db.execute(EXPENSIVE.replace('SELECT sum(x)', 'SELECT x'))
                self.assertEqual(cursor.fetchone()[0], 1)
            with patch.object(read_budget.time, 'monotonic', return_value=116):
                with self.assertRaises(sqlite3.OperationalError):
                    cursor.fetchall()
                self.assertTrue(budget.expired)
                with self.assertRaises(sqlite3.OperationalError):
                    db.execute(EXPENSIVE).fetchone()

    def test_marker_method_scope_thread_copy_and_cleanup(self):
        observed = []
        async def downstream(scope, receive, send):
            observed.append(read_budget.http_read.get())
            # AnyIO copies ContextVars to its worker; verify that exact Python primitive.
            context = contextvars.copy_context()
            thread = threading.Thread(target=lambda: context.run(lambda: observed.append(read_budget.http_read.get())))
            thread.start()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
        middleware = read_budget.ReadBudgetMiddleware(downstream)
        for method in ('GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'):
            complete(middleware({'type': 'http', 'method': method}, None, None))
            self.assertFalse(read_budget.http_read.get())
        complete(middleware({'type': 'lifespan'}, None, None))
        self.assertEqual(observed, [True]*4 + [False]*10)

        async def failing(*args):
            raise ValueError('route failed')
        with self.assertRaises(ValueError):
            complete(read_budget.ReadBudgetMiddleware(failing)({'type': 'http', 'method': 'GET'}, None, None))
        self.assertFalse(read_budget.http_read.get())

    def test_writes_and_jobs_are_unbudgeted_and_errors_preserved(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(api, 'DB_PATH', Path(tmp) / 'test.sqlite'):
            with patch.object(read_budget, 'install') as install:
                with api.get_db() as db:
                    db.execute('CREATE TABLE jobs(id INTEGER)')
                    db.execute('INSERT INTO jobs VALUES(1)')
                    db.commit()
                install.assert_not_called()
            marker = read_budget.http_read.set(True)
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    with api.get_db() as db:
                        db.execute('SELECT * FROM missing')
            finally:
                read_budget.http_read.reset(marker)

    def test_long_poll_wait_is_outside_connection_deadline(self):
        with closing(sqlite3.connect(':memory:')) as db, patch.object(read_budget.time, 'monotonic', return_value=100):
            token = read_budget.http_read.set(True)
            try:
                # A connection opened after the wait gets a full budget.
                with patch.object(read_budget.time, 'monotonic', return_value=200):
                    budget = read_budget.install(db)
                    self.assertEqual(budget.deadline, 215)
                    self.assertEqual(budget.check(), 0)
                with patch.object(read_budget.time, 'monotonic', return_value=216):
                    self.assertEqual(budget.check(), 1)
            finally:
                read_budget.http_read.reset(token)

    def test_catalog_can_keep_its_shorter_budget(self):
        with closing(sqlite3.connect(':memory:')) as db, patch.object(read_budget.time, 'monotonic', return_value=100):
            self.assertEqual(read_budget.install(db, seconds=10).deadline, 110)

    def test_asgi_returns_503_json_without_sockets(self):
        app = FastAPI()
        app.add_middleware(read_budget.ReadBudgetMiddleware)

        @app.get('/read')
        async def read():
            with api.get_db() as db:
                db.execute(EXPENSIVE).fetchone()

        messages = []

        async def send(message):
            messages.append(message)

        async def receive():
            return {'type': 'http.request', 'body': b'', 'more_body': False}

        original = read_budget.install
        with tempfile.TemporaryDirectory() as tmp, patch.object(api, 'DB_PATH', Path(tmp) / 'test.sqlite'):
            with patch.object(read_budget, 'install', side_effect=lambda db: original(db, seconds=0)):
                complete(app({'type': 'http', 'method': 'GET', 'path': '/read', 'root_path': '',
                              'query_string': b'', 'headers': [], 'scheme': 'http',
                              'server': ('test', 80), 'client': ('test', 1)}, receive, send))
        self.assertEqual(messages[0]['status'], 503)
        self.assertEqual(messages[1]['body'], b'{"detail":"Database read took too long; please retry"}')
        self.assertFalse(read_budget.http_read.get())


if __name__ == '__main__':
    unittest.main()
