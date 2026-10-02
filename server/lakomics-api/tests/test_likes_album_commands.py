"""Exercise designation and deletion through the real transactional Album handler."""
import sqlite3
import sys
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import album_authority
import authority
from fastapi import HTTPException
LIBRARY = 'a' * 32
NOW = '2026-10-02T00:00:00Z'

class LikesAlbumCommands(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        @contextmanager
        def get_db():
            yield self.db
        authority.startup(get_db)
        album_authority.startup(get_db)
        self.db.execute('CREATE TABLE assets(id TEXT PRIMARY KEY, committed INTEGER NOT NULL DEFAULT 1)')
        self.db.execute("INSERT INTO assets VALUES('asset',1)")
        album_authority.activate(self.db, library_id=LIBRARY, rows=[], pairs=[], baseline_digest='0'*64, baseline_revision='0'*64, now=NOW, snapshot_version=3)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def command(self, kind, album_id='likes', operation=None, **fields):
        body = dict(libraryId=LIBRARY, epoch=1, contractVersion=1, commandType=kind,
                    operationId=operation or str(uuid.uuid4()), albumId=album_id, **fields)
        library_id, epoch, version, operation_id, command_type, entity = album_authority.parse_command(body)
        self.db.execute('BEGIN IMMEDIATE')
        try:
            result = album_authority.apply_command(self.db, library_id=library_id, epoch=epoch, contract_version=version,
                operation_id=operation_id, command_type=command_type, entity=entity, now=NOW)
            self.db.commit()
            return result
        except BaseException:
            self.db.rollback()
            raise

    def create(self, album_id, name, parent=None):
        return self.command(album_authority.CREATE, album_id, name=name, parentId=parent, iconKey=None, colorKey=None)

    def test_creation_receipt_rename_and_delete_protection(self):
        operation = str(uuid.uuid4())
        first = self.command(album_authority.ENSURE_LIKES, operation=operation)
        self.assertEqual(first, self.command(album_authority.ENSURE_LIKES, operation=operation))
        self.assertEqual(first['album']['name'], album_authority.LIKES_NAME)
        self.command(album_authority.RENAME, name='Renamed', expectedRevision=1)
        self.assertEqual(self.command(album_authority.ENSURE_LIKES, 'unused')['album']['id'], 'likes')
        with self.assertRaises(HTTPException) as caught:
            self.command(album_authority.DELETE, expectedRevision=2)
        self.assertEqual(caught.exception.detail['code'], 'likesAlbumProtected')
        self.assertEqual(self.db.execute('SELECT deleted FROM album_authority_state WHERE album_id="likes"').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT command_type FROM album_authority_changes ORDER BY sequence LIMIT 1').fetchone()[0], album_authority.CREATE)

    def test_single_name_adoption_membership_and_parent_guard(self):
        self.create('parent', 'Parent')
        self.create('child', album_authority.LIKES_NAME, 'parent')
        self.assertEqual(self.command(album_authority.ENSURE_LIKES)['album']['id'], 'child')
        added = self.command(album_authority.MEMBERSHIP, 'child', assetId='asset', desiredState=True, expectedRevision=0)
        self.assertTrue(added['membership']['desiredState'])
        removed = self.command(album_authority.MEMBERSHIP, 'child', assetId='asset', desiredState=False, expectedRevision=1)
        self.assertFalse(removed['membership']['desiredState'])
        for album_id, code in [('child','likesAlbumProtected'), ('parent','albumHasChildren')]:
            with self.assertRaises(HTTPException) as caught:
                self.command(album_authority.DELETE, album_id, expectedRevision=1)
            self.assertEqual(caught.exception.detail['code'], code)

    def test_ambiguous_unset_designation_can_be_resolved(self):
        self.create('parent', 'Parent')
        self.create('first', album_authority.LIKES_NAME)
        self.create('second', album_authority.LIKES_NAME, 'parent')
        self.db.execute('DELETE FROM album_library_settings')
        self.db.commit()
        with self.assertRaises(HTTPException) as caught:
            self.command(album_authority.ENSURE_LIKES)
        self.assertEqual(caught.exception.detail['code'], 'likesAlbumAmbiguous')
        self.command(album_authority.DELETE, 'second', expectedRevision=1)
        self.assertEqual(self.command(album_authority.ENSURE_LIKES)['album']['id'], 'first')

    def test_renamed_snapshot_keeps_designation(self):
        self.db.execute('DELETE FROM authority_domains WHERE domain="albums"')
        self.db.commit()
        rows=[dict(album_id='renamed', name='Already renamed', parent_id=None, icon_key=None, color_key=None)]
        album_authority.activate(self.db, library_id=LIBRARY, rows=rows, pairs=[], baseline_digest='1'*64,
                                 baseline_revision='1'*64, now=NOW, snapshot_version=3, likes_id='renamed')
        self.db.commit()
        with self.assertRaises(HTTPException) as caught:
            self.command(album_authority.DELETE, 'renamed', expectedRevision=1)
        self.assertEqual(caught.exception.detail['code'], 'likesAlbumProtected')

    def test_likes_read_reports_membership_and_bounds_requests(self):
        import asyncio
        from fastapi import FastAPI
        from unittest.mock import patch
        @contextmanager
        def get_db():
            yield self.db
        app = FastAPI()
        album_authority.register_album_authority(app, get_db, lambda _: None, lambda _: None)
        route = next(route for route in app.routes if getattr(route, 'path', '') == '/v1/albums/likes')
        self.assertEqual(route.methods, {'GET'})
        async def inline(call):
            return call()
        self.command(album_authority.ENSURE_LIKES)
        self.command(album_authority.MEMBERSHIP, assetId='asset', desiredState=True, expectedRevision=0)
        with patch.object(album_authority, 'run_in_threadpool', inline):
            state = asyncio.run(route.endpoint(LIBRARY, 1, 'asset'))
            self.assertEqual(state['albumId'], 'likes')
            self.assertEqual(state['memberships'], [{'assetId':'asset','desiredState':True,'entityRevision':1}])
            with self.assertRaises(HTTPException):
                asyncio.run(route.endpoint(LIBRARY, 1, ','.join('a'+str(i) for i in range(101))))
            with self.assertRaises(HTTPException):
                asyncio.run(route.endpoint(LIBRARY, 2, 'asset'))
