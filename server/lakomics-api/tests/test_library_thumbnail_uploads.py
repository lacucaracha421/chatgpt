"""Socket-free server/SQLite/storage contract tests for immutable thumbnails."""
import base64
import hashlib
import io
import inspect
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from botocore.exceptions import ClientError
from fastapi import HTTPException
from fastapi.params import Param
from starlette.requests import Request

from tests.test_capture_api_stub import fake_s3  # install app's R2 import stub
import app as api
import asset_replication as replication
import asset_uploads
import head_cache
import library_thumbnails as thumbs
import media_tickets
import thumbnail_uploads as routes

RED = base64.b64decode('UklGRhwAAABXRUJQVlA4TA8AAAAvAUAAAAcQ/Y/+ByKi/wEA')
BLUE = base64.b64decode('UklGRhwAAABXRUJQVlA4TA8AAAAvAUAAAAcQ0f/+ByKi/wEA')
ASSET = '00000000-0000-4000-8000-000000000001'
AUTH = 'Bearer test-token'


class Storage:
    def __init__(self):
        self.objects = {}
        self.gets, self.puts, self.heads, self.deletes = [], [], [], []
        self.on_get = lambda key: None
        self.on_put = lambda key: None
        self.meta = mock.Mock(endpoint_url='https://fake.invalid')

    def seed(self, key, data=RED, content_type='image/webp'):
        self.objects[key] = (data, content_type)

    def get_object(self, *, Bucket, Key):
        self.gets.append(Key)
        self.on_get(Key)
        if Key not in self.objects:
            raise ClientError({'Error': {'Code': 'NoSuchKey'}}, 'GetObject')
        data, content_type = self.objects[Key]
        return {'Body': io.BytesIO(data), 'ContentLength': len(data), 'ContentType': content_type, 'ETag': 'fixture'}

    def put_object(self, *, Bucket, Key, Body, ContentType):
        self.puts.append(Key)
        self.objects[Key] = (Body.read(), ContentType)
        self.on_put(Key)

    def head_object(self, *, Bucket, Key):
        self.heads.append(Key)
        data, content_type = self.objects[Key]
        return {'ContentLength': len(data), 'ContentType': content_type}

    def delete_object(self, *, Bucket, Key):
        self.deletes.append(Key)
        self.objects.pop(Key, None)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'db.sqlite3'
        self.storage = Storage()
        self.patches = [mock.patch.object(api, 'DB_PATH', self.path), mock.patch.object(api, 'API_TOKEN', 'test-token'),
                        mock.patch.object(api, '_s3', self.storage), mock.patch.object(routes, '_storage', self.storage),
                        mock.patch.object(head_cache, 'ticket_heads', head_cache.HeadMetadataCache())]
        for patch in self.patches:
            patch.start()
        api.startup()
        api.startup_replication()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.temp.cleanup()

    def seed(self, asset=ASSET, data=RED, committed=1, key=True):
        replication.replication_prepare(replication.ReplicationPrepare(asset_id=asset, kind='image',
                                         content_type='image/png', sha256='a'*64, size_bytes=100), AUTH)
        thumb_key = f'library/{asset}/thumbnail' if key else None
        with api.get_db() as db:
            thumbs.remember_key(db, thumb_key)
            db.execute('UPDATE assets SET committed=?,thumbnail_key=? WHERE id=?', (committed, thumb_key, asset))
            db.commit()
        if thumb_key:
            self.storage.seed(thumb_key, data)
        return thumb_key

    def row(self, asset=ASSET):
        with api.get_db() as db:
            return dict(db.execute('SELECT * FROM assets WHERE id=?', (asset,)).fetchone())

    def gen(self):
        with api.get_db() as db:
            return db.execute('SELECT generation FROM asset_list_generation').fetchone()[0]

    def prepare(self, data=RED, asset=ASSET, op='op1', **kwargs):
        request = routes.ThumbnailPrepare(asset_id=asset, operation_id=op, sha256=hashlib.sha256(data).hexdigest(),
                                          size_bytes=len(data), content_type='image/webp', **kwargs)
        with mock.patch('r2.presign_put', return_value='https://upload.invalid') as signer:
            result = routes.prepare_thumbnail(request, AUTH)
            if not result['committed']:
                self.assertEqual(signer.call_args.kwargs['content_length'], len(data))
                self.assertLessEqual(signer.call_args.kwargs['expires_in'], 600)
        return result

    def upload(self, data=RED, **kwargs):
        session = self.prepare(data, **kwargs)
        self.storage.seed(session['upload_object_key'], data)
        return session

    def commit(self, session, asset=ASSET):
        return routes.commit_thumbnail(routes.ThumbnailCommit(asset_id=asset, upload_id=session['upload_id']), AUTH)

    def replication_body(self, **overrides):
        body = dict(asset_id=ASSET, kind='image', content_type='image/png', expected_revision=0, commit_id='metadata1',
                    original=dict(object_key=f'library/{ASSET}/original', content_type='image/png', size_bytes=100, sha256='a'*64),
                    thumbnail=dict(object_key=f'library/{ASSET}/thumbnail', content_type='image/webp', size_bytes=1))
        body.update(overrides)
        return replication.ReplicationCommit(**body)


class UploadTests(Fixture):
    def test_verified_publish_equal_bytes_preserves_legacy_revision_and_generation(self):
        self.seed()
        before, generation = self.row(), self.gen()
        session = self.upload()
        self.assertEqual(self.gen(), generation)
        result = self.commit(session)
        after = self.row()
        self.assertEqual(result['thumbnail_revision'], thumbs.revision(before))
        self.assertEqual(self.gen(), generation)
        self.assertTrue(thumbs.trusted_receipt(after))
        self.assertEqual(after['metadata_revision'], before['metadata_revision'])
        self.assertEqual(after['updated_at'], before['updated_at'])
        self.assertEqual(self.storage.objects[after['thumbnail_key']][0], RED)
        self.assertNotIn(session['upload_object_key'], self.storage.objects)

    def test_first_and_changed_same_size_bytes_then_identical_retry(self):
        self.seed(key=False)
        first = self.commit(self.upload())
        self.assertEqual(first['thumbnail_revision'], 't1.' + hashlib.sha256(RED).hexdigest())
        generation = self.gen()
        second = self.commit(self.upload(BLUE, op='blue'))
        self.assertEqual(len(RED), len(BLUE))
        self.assertNotEqual(first['thumbnail_revision'], second['thumbnail_revision'])
        self.assertEqual(self.gen(), generation + 1)
        third = self.commit(self.upload(BLUE, op='blue2'))
        self.assertEqual(second['thumbnail_revision'], third['thumbnail_revision'])
        self.assertEqual(self.gen(), generation + 1)

    def test_bad_sha_type_length_and_container_do_not_publish(self):
        for data, content_type in ((BLUE, 'image/webp'), (RED, 'image/png'), (RED[:-1], 'image/webp'),
                                   (b'x'*len(RED), 'image/webp')):
            with self.subTest(data=data, content_type=content_type):
                self.seed()
                session = self.prepare(op=str(len(self.storage.gets)))
                self.storage.seed(session['upload_object_key'], data, content_type)
                with self.assertRaises(HTTPException) as caught:
                    self.commit(session)
                self.assertEqual(caught.exception.status_code, 422)
                self.assertFalse(self.row()['thumbnail_verified'])
                self.assertIsNone(self.row()['thumbnail_metadata_key'])

    def test_idempotency_payload_conflict_context_binding_and_temp_reuse(self):
        self.seed()
        session = self.upload()
        self.assertEqual(session['upload_id'], self.prepare()['upload_id'])
        with self.assertRaises(HTTPException):
            self.prepare(BLUE)
        first = self.commit(session)
        get_count = len(self.storage.gets)
        self.storage.seed(session['upload_object_key'], BLUE)  # still-live PUT URL
        self.assertEqual(first, self.commit(session))
        self.assertEqual(len(self.storage.gets), get_count)
        self.assertEqual(self.storage.objects[first['thumbnail_key']][0], RED)
        self.assertTrue(self.prepare()['committed'])
        with self.assertRaises(HTTPException):
            self.commit(session, asset='other')
        with self.assertRaises(HTTPException):
            replication.replication_commit(self.replication_body(thumbnail=None, thumbnail_mode='upload',
                                           thumbnail_upload_id=session['upload_id']), AUTH)

    def test_full_replication_commit_is_atomic_and_retries_without_temp(self):
        self.seed(committed=0, key=False)
        session = self.upload()
        with self.assertRaises(HTTPException):
            self.commit(session)
        request = self.replication_body(thumbnail=None, thumbnail_mode='upload', thumbnail_upload_id=session['upload_id'])
        result = replication.replication_commit(request, AUTH)
        self.assertEqual(self.row()['committed'], 1)
        self.assertEqual(result['object_keys']['thumbnail'], session['thumbnail_key'])
        count = len(self.storage.gets)
        retry = replication.replication_commit(request, AUTH)
        self.assertEqual(result['thumbnail_result'], retry['thumbnail_result'])
        self.assertEqual(len(self.storage.gets), count)
        with self.assertRaises(HTTPException):
            replication.replication_commit(request.model_copy(update={'creator_name': 'different'}), AUTH)

    def test_retain_reads_current_row_and_legacy_cannot_revert(self):
        self.seed()
        result = self.commit(self.upload())
        replication.replication_commit(self.replication_body(), AUTH)
        self.assertEqual(self.row()['thumbnail_key'], result['thumbnail_key'])
        replication.replication_commit(self.replication_body(thumbnail=None, thumbnail_mode='retain',
                                       expected_revision=1, commit_id='retain'), AUTH)
        self.assertTrue(thumbs.trusted_receipt(self.row()))
        asset_uploads.create_asset(asset_uploads.AssetCreate(id=ASSET, kind='image', object_key=f'library/{ASSET}/original',
                                  thumbnail_key=f'library/{ASSET}/thumbnail'), AUTH)
        self.assertEqual(self.row()['thumbnail_key'], result['thumbnail_key'])
        prepared = replication.replication_prepare(replication.ReplicationPrepare(asset_id=ASSET, kind='image'), AUTH)
        self.assertEqual(prepared['object_keys']['thumbnail'], result['thumbnail_key'])

    def test_final_presign_block_and_legacy_switch_default_off(self):
        self.seed()
        with self.assertRaises(HTTPException):
            asset_uploads.create_upload_presign(asset_uploads.PresignRequest(object_key=thumbs.immutable_key('a'*64)), AUTH)
        request = asset_uploads.PresignRequest(object_key=f'library/{ASSET}/thumbnail')
        with mock.patch.dict(os.environ, {'LAKOMICS_BLOCK_LEGACY_THUMBNAIL_UPLOADS': '0'}):
            self.assertIn('upload_url', asset_uploads.create_upload_presign(request, AUTH))
        with mock.patch.dict(os.environ, {'LAKOMICS_BLOCK_LEGACY_THUMBNAIL_UPLOADS': '1'}):
            with self.assertRaises(HTTPException) as caught:
                asset_uploads.create_upload_presign(request, AUTH)
            self.assertEqual(caught.exception.detail['code'], 'thumbnailUpgradeRequired')

    def test_no_forged_receipt_or_lazy_head_fill_for_new_namespace(self):
        self.seed()
        key = thumbs.immutable_key(hashlib.sha256(RED).hexdigest())
        self.storage.seed(key)
        with self.assertRaises(HTTPException):
            asset_uploads.create_asset(asset_uploads.AssetCreate(id='new', object_key='images/new', thumbnail_key=key), AUTH)
        row = {**self.row(), 'thumbnail_key': key, 'thumbnail_metadata_key': key,
               'thumbnail_size_bytes': len(RED), 'thumbnail_content_type': 'image/webp'}
        fills = []
        head_cache.ticket_heads = head_cache.HeadMetadataCache()
        media_tickets._ticket_head(row, 'thumbnail', key, thumbnail_metadata_fills=fills)
        self.assertEqual(self.storage.heads, [key])
        self.assertEqual(fills, [])

    def test_session_cas_during_get_and_expiry(self):
        self.seed()
        session = self.upload()
        def supersede(key):
            if key == session['upload_object_key']:
                self.storage.on_get = lambda key: None
                self.prepare(BLUE, op='supersede')
        self.storage.on_get = supersede
        with self.assertRaises(HTTPException):
            self.commit(session)
        self.assertFalse(self.row()['thumbnail_verified'])
        latest = self.upload(op='latest')
        with api.get_db() as db:
            db.execute('UPDATE thumbnail_upload_sessions SET expires_at=0 WHERE upload_id=?', (latest['upload_id'],))
            db.commit()
        with self.assertRaises(HTTPException) as caught:
            self.commit(latest)
        self.assertEqual(caught.exception.status_code, 410)

    def test_generation_and_projection_contract(self):
        self.seed()
        generation = self.gen()
        with api.get_db() as db:
            db.execute('UPDATE assets SET thumbnail_sha256=?,thumbnail_size_bytes=12,thumbnail_write_epoch=3', ('a'*64,))
            db.commit()
        self.assertEqual(self.gen(), generation)
        token = thumbs.revision(self.row())
        with api.get_db() as db:
            db.execute('UPDATE assets SET thumbnail_revision=?', (token,))
            db.commit()
        self.assertEqual(self.gen(), generation)
        self.assertEqual(api.mobile_asset_item(self.row())['thumbnail_revision'], token)
        self.assertNotIn('thumbnail_revision', asset_uploads.list_assets(AUTH)['items'][0])
        with api.get_db() as db:
            db.execute('UPDATE assets SET thumbnail_key=NULL,thumbnail_revision=NULL')
            db.commit()
        self.assertEqual(self.gen(), generation+1)
        self.assertIsNone(thumbs.revision(self.row()))

    def test_stale_temp_reclaim_never_deletes_final_or_legacy(self):
        old = self.seed()
        session = self.upload()
        result = self.commit(session)
        self.storage.seed(session['upload_object_key'], BLUE)
        self.assertEqual(thumbs.reclaim_temp(api.get_db, self.storage, api.R2_BUCKET, now=session['expires_at']+4000), 1)
        self.assertIn(old, self.storage.objects)
        self.assertIn(result['thumbnail_key'], self.storage.objects)

    def test_cold_tickets_zero_heads_for_new_rows_single_21_50_and_fresh_exception(self):
        self.seed()
        self.commit(self.upload())
        row = self.row()
        for count in (1, 21, 50):
            head_cache.ticket_heads = head_cache.HeadMetadataCache()
            for _ in range(count):
                self.assertEqual(media_tickets._ticket_head(row, 'thumbnail', row['thumbnail_key'])['ContentLength'], len(RED))
        self.assertEqual(self.storage.heads, [])
        media_tickets._ticket_head(row, 'thumbnail', row['thumbnail_key'], fresh_head=True)
        self.assertEqual(len(self.storage.heads), 1)

    def test_prepare_respects_active_missing_and_trashed_lifecycle(self):
        self.seed()
        with api.get_db() as db:
            db.execute('CREATE TABLE authority_domains(library_id TEXT,domain TEXT,epoch TEXT)')
            db.execute('CREATE TABLE asset_authority_state(library_id TEXT,asset_id TEXT,lifecycle TEXT,entity_revision INTEGER)')
            db.execute("INSERT INTO authority_domains VALUES('lib','assets','epoch')")
            db.commit()
        with self.assertRaises(HTTPException):
            self.prepare()
        with api.get_db() as db:
            db.execute("INSERT INTO asset_authority_state VALUES('lib',?,'trash',1)",(ASSET,))
            db.commit()
        with self.assertRaises(HTTPException):
            self.prepare()

    def test_live_list_handlers_preserve_wire_shapes_and_character_revisions(self):
        self.seed()
        api.startup_classifications()
        api.startup_mobile_characters()
        old_token = thumbs.revision(self.row())
        with api.get_db() as db:
            index = {'nodes':[], 'scopes':[{'nodeId':'series:s','filter':'all','sourceCount':1,'totalCount':1}]}
            db.execute('INSERT INTO mobile_character_state VALUES(1,?,?,?)', ('a'*64,'now',json.dumps(index)))
            db.execute('INSERT INTO mobile_character_assets VALUES(?,?)',(ASSET,json.dumps(api.mobile_asset_item(self.row()))))
            db.execute("INSERT INTO mobile_character_members VALUES('series:s','all',0,?)",(ASSET,))
            db.commit()
        def invoke(path, **values):
            endpoint = next(route.endpoint for route in api.app.routes if getattr(route,'path',None)==path)
            defaults = {name:(parameter.default.default if isinstance(parameter.default,Param) else parameter.default)
                        for name,parameter in inspect.signature(endpoint).parameters.items()
                        if parameter.default is not inspect.Parameter.empty}
            result = endpoint(**{**defaults, 'authorization':AUTH, **values})
            return json.loads(result.body) if hasattr(result,'body') else result
        library = invoke('/v1/library/assets')
        self.assertNotIn('thumbnail_revision',library['items'][0])
        self.commit(self.upload(BLUE))
        for sort in ('published','newest'):
            result = invoke('/v1/library/characters/assets',node='series:s',revision='a'*64,sort=sort,
                            request=Request({'type':'http','query_string':b''}))
            self.assertEqual([item['id'] for item in result['items']],[ASSET])
            self.assertEqual(result['items'][0]['thumbnail_revision'],thumbs.revision(self.row()))
            self.assertNotEqual(result['items'][0]['thumbnail_revision'],old_token)
            self.assertIn('listGeneration',result)

    def test_already_committed_without_thumbnail_keeps_pc_string_map_compatible(self):
        self.seed(key=False)
        result = replication.replication_prepare(replication.ReplicationPrepare(asset_id=ASSET,kind='image'), AUTH)
        self.assertNotIn('thumbnail',result['object_keys'])
        self.assertTrue(all(isinstance(value,str) for value in result['object_keys'].values()))

    def test_full_replication_rollback_if_metadata_transaction_fails(self):
        self.seed(committed=0, key=False)
        session = self.upload()
        with api.get_db() as db:
            db.execute("CREATE TRIGGER reject_commit BEFORE UPDATE OF metadata_revision ON assets BEGIN SELECT RAISE(ABORT,'fixture'); END")
            db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            replication.replication_commit(self.replication_body(thumbnail=None, thumbnail_mode='upload',
                                           thumbnail_upload_id=session['upload_id']), AUTH)
        self.assertFalse(self.row()['committed'])
        self.assertIsNone(self.row()['thumbnail_key'])
        with api.get_db() as db:
            self.assertEqual(db.execute('SELECT state FROM thumbnail_upload_sessions').fetchone()[0], 'pending')

    def test_bad_webp_with_correct_sha_and_length_is_rejected_by_decoder(self):
        self.seed()
        # Valid RIFF header and byte count, invalid compressed frame.
        invalid = RED[:20] + bytes(len(RED)-20)
        session = self.upload(invalid)
        with self.assertRaises(HTTPException) as caught:
            self.commit(session)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertFalse(self.row()['thumbnail_verified'])

    def test_stream_length_checks_close_the_body_and_do_not_trust_headers(self):
        body = io.BytesIO(RED)
        storage = mock.Mock()
        storage.get_object.return_value = {'Body':body,'ContentLength':len(RED)+1,'ContentType':'image/webp'}
        with self.assertRaises(thumbs.InvalidObject):
            thumbs.read_object(storage,'bucket','key',size=len(RED))
        self.assertTrue(body.closed)
        body = io.BytesIO(RED+b'x')
        storage.get_object.return_value = {'Body':body,'ContentLength':len(RED),'ContentType':'image/webp'}
        with self.assertRaises(thumbs.InvalidObject):
            thumbs.read_object(storage,'bucket','key',size=len(RED))
        self.assertTrue(body.closed)

    def test_expected_epoch_and_old_missing_object_fail_closed(self):
        old = self.seed()
        with self.assertRaises(HTTPException):
            self.prepare(expected_thumbnail_write_epoch=77)
        session = self.upload()
        del self.storage.objects[old]
        with self.assertRaises(HTTPException) as caught:
            self.commit(session)
        self.assertEqual(caught.exception.status_code,409)
        self.assertIsNone(self.row()['thumbnail_revision'])


if __name__ == '__main__':
    unittest.main()
