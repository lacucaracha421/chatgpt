"""AV inbox unit/handler tests: fake storage/SQLite and fail-closed outbound HTTP.

Handler tests execute coroutines directly with an inline threadpool stand-in, so
these unit tests also run where TestClient's cross-thread wakeups are unavailable.
They do not establish the ASGI HTTP/threadpool integration gate.
"""
import asyncio
import io
import json
import threading
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from unittest import mock

from fastapi import FastAPI, HTTPException
from starlette.requests import Request
from PIL import Image
from tests import test_collection_authority as fixtures
from tests.test_capture_api_stub import fake_s3
from tests.test_work_providers import Response
import api_auth
import av_inbox as av
import av_lookup_requests as intake
import collection_authority as ca
import work_providers as wp


def png(size=(800,538)):
    out = io.BytesIO()
    image = Image.new('RGB', size, 'white')
    for x, color in ((0,'red'), (378,'green'), (422,'blue')):
        image.paste(color, (x, 0, min(size[0], x+378 if x != 378 else 422), size[1]))
    image.save(out, 'PNG')
    return out.getvalue()


def movie(**changes):
    return dict(normalized_id='SSIS-001', title='作品', date='2021-06-11T23:00:00-07:00',
                makers=['Maker'], labels=['Label'], series='Series', actresses=[dict(name='日本名',image_url=None)],
                directors=['監督'], genres=['Genre'], cover_image_url='http://pics.dmm.co.jp/jacket.jpg',
                thumbnail_image_url=None, volume='120', **changes)


def wiki(names=('日本名', '監督')):
    return {'results': {'bindings': [dict(name={'value':n}, person={'value':'http://www.wikidata.org/entity/Q1'},
                    ko={'value':'한국 이름'}, fanza={'value':'123'}) for n in names]}}


async def inline(func, *args, **kwargs):
    return func(*args, **kwargs)


def request(body):
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    async def receive():
        return {'type':'http.request','body':data,'more_body':False}
    return Request({'type':'http', 'headers':[]}, receive)


class AvInboxTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CollectionAuthorityTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.addCleanup(self.fixture.tearDown)
        self.get_db = fixtures.api_app.get_db
        ca.startup(self.get_db)
        with self.get_db() as db:
            db.execute("INSERT INTO authority_domains VALUES(?,'collections',1,1,0,?,NULL,'2026')",
                       (fixtures.LIBRARY, 'a'*64))
            db.commit()
        fixtures.api_app.startup_extension_profile()
        intake.startup(self.get_db)
        self.app = FastAPI()
        intake.register(self.app, self.get_db, fixtures.api_app.require_admin_or_extension,
                        api_auth.publisher_guard(self.get_db),
                        api_auth.client_guard(self.get_db, fixtures.api_app.API_TOKEN))
        self.relay = wp.Relay()
        self.worker = av.register(self.app, self.get_db, fixtures.api_app._home_client,
                                 lambda:fake_s3, lambda:'test-bucket', relay=self.relay)
        self.now = 1000.0
        self.worker.clock = lambda:self.now
        self.worker.pace = mock.Mock()
        self.auth = self.fixture.auth['Authorization']
        self.publisher = self.fixture.publisher['Authorization']
        self.open = self.enter(mock.patch.object(wp._opener,'open', side_effect=AssertionError('Unmocked outbound HTTP')))
        self.enter(mock.patch.object(av,'run_in_threadpool',inline))
        self.enter(mock.patch.object(intake,'run_in_threadpool',inline))
        self.enter(mock.patch.object(ca,'run_in_threadpool',inline))
        self.enter(mock.patch.object(wp.time,'sleep'))
        def get_object(*, Bucket, Key):
            stored = fake_s3.objects[Key]
            return dict(Body=io.BytesIO(stored['body']), ContentLength=len(stored['body']), ContentType=stored['content_type'])
        self.enter(mock.patch.object(fake_s3,'get_object',side_effect=get_object,create=True))

    def enter(self, patch):
        value = patch.start()
        self.addCleanup(patch.stop)
        return value

    def endpoint(self, path, method):
        return next(r.endpoint for r in self.app.routes if getattr(r,'path',None)==path and method in r.methods)

    def post(self, id_, action, body=None, authorization=None):
        fn = self.endpoint(av.PREFIX+'/{id_}/{action}','POST')
        return asyncio.run(fn(id_,action,request({} if body is None else body), self.auth if authorization is None else authorization))

    def new(self, code='ssis00001'):
        body = intake.LookupRequest(requestId=str(uuid.uuid4()),productCode=code)
        return intake.insert(self.get_db,body)['requestId']

    def row(self,id_):
        with self.get_db() as db:
            return av.get_row(db,id_)

    def fetch(self,id_=None, size=(800,538)):
        id_ = id_ or self.new()
        self.open.side_effect = [Response(movie()),Response(png(size),'image/png'),Response(wiki())]
        self.assertTrue(self.worker.process_one())
        self.assertEqual(self.row(id_)['status'],'found')
        return id_

    def command(self, type_, operation=None, **fields):
        body = dict(libraryId=fixtures.LIBRARY,epoch=1,contractVersion=1,operationId=operation or str(uuid.uuid4()),
                    commandType=type_, **fields)
        library,epoch,version,operation,command,entity = ca.parse_command(body)
        with self.get_db() as db:
            db.execute('BEGIN IMMEDIATE')
            result = ca.apply_command(db,library_id=library,epoch=epoch,contract_version=version,
                                     command_type=command,operation_id=operation,entity=entity,now='2026-10-09T00:00:00Z')
            db.commit()
        return result

    def create_av(self,id_='av',code='SSIS-001'):
        self.command('createWork',workId=id_,type='av',name=code,legacyKind=None,fields={},binding=None)
        self.command('setAvDetails',workId=id_,changes={'productCode':code},expected={'productCode':None})

    def code(self, func, code, status=None):
        with self.assertRaises(HTTPException) as caught:
            func()
        detail = caught.exception.detail
        self.assertEqual(detail.get('code') if isinstance(detail,dict) else detail,code)
        if status:
            self.assertEqual(caught.exception.status_code,status)

    def test_normalization_matches_pc_code_families(self):
        for value,want in [(' ssis00001 ','SSIS-001'),('118abw00001','ABW-001'),('h_1472smkcx00003','SMKCX-003'),
                           ('k9ssis001','SSIS-001'),('ssis-00001','SSIS-00001'),('1stars123r','STARS-123'),
                           ('FC2 PPV 00123','FC2-PPV-123'),('259luxu00123','259LUXU-123'),
                           ('ABW_00001','ABW-001'),('ABW-0','ABW-000')]:
            self.assertEqual(av.normalize_code(value),want,value)
        for value in ('', 'invalid','a'*41, 'ＳＳＩＳ001',None,123,'ABW-1/../'):
            self.assertIsNone(av.normalize_code(value))

    def test_movie_fields_dates_series_and_invalid_snapshot(self):
        metadata, fields = av.parse_movie(json.dumps(movie()).encode(),'SSIS-001')
        self.assertEqual(metadata['series'],['Series'])
        self.assertEqual(fields['releaseDate'],'2021-06-12')
        self.assertEqual(fields['maker'],'Maker')
        self.assertNotIn('runtimeMinutes',fields)
        for changes in ({'normalized_id':'SSIS-002'},{'title':''},{'date':'2021-02-30T00:00:00Z'},
                        {'date':'2021-01-01'},{'actresses':[{'name':' '}]}):
            with self.assertRaises(ValueError):
                av.parse_movie(json.dumps({**movie(),**changes}).encode(),'SSIS-001')
        for series,expected in [(None,[]),(['a','b'],['a','b'])]:
            self.assertEqual(av.parse_movie(json.dumps({**movie(),'series':series}).encode(),'SSIS-001')[0]['series'],expected)

    def test_defaults_wrap_spine_boundaries_and_rounding(self):
        self.assertEqual(av.default_split(800,538),dict(x1=378,x2=422,isWrap=True,useSpine=True))
        self.assertEqual(av.default_split(378,538),dict(x1=0,x2=0,isWrap=False,useSpine=False))
        self.assertFalse(av.default_split(1000,600)['useSpine'])
        self.assertTrue(av.default_split(120,100)['isWrap'])
        self.assertFalse(av.default_split(119,100)['isWrap'])
        self.assertEqual(av.default_split(3,2)['x1'],1)

    def test_name_mapping_escaping_ambiguity_and_cache(self):
        values = wiki(['日本名'])
        self.assertEqual(av.parse_names(json.dumps(values).encode(),['日本名'])[0]['fanzaActressId'],'123')
        values['results']['bindings'].append({**values['results']['bindings'][0],'person':{'value':'https://www.wikidata.org/entity/Q2'}})
        self.assertEqual(av.parse_names(json.dumps(values).encode(),['日本名']),[av.japanese('日本名')])
        from urllib.parse import parse_qs,urlsplit
        query = parse_qs(urlsplit(av.wikidata_url(['a"}\\\n'])).query)['query'][0]
        self.assertIn('"a\\"}\\\\\\n"@ja',query)
        self.open.side_effect = [Response(wiki(['日本名']))]
        first = self.worker.names(['日本名'],time.monotonic()+25)
        self.open.side_effect = AssertionError('cache must suppress HTTP')
        self.assertEqual(self.worker.names(['日本名'],time.monotonic()+25),first)
        self.now += av.NAME_TTL+1
        self.open.side_effect = [Response({},status=503)]
        self.assertEqual(self.worker.names(['日本名'],time.monotonic()+25)['日本名'],av.japanese('日本名'))

    def test_worker_found_snapshot_and_authenticated_jacket(self):
        id_ = self.fetch()
        detail = av.detail(self.get_db,id_)
        self.assertEqual(detail['inbox']['attempts'],1)
        self.assertIsNotNone(detail['inbox']['fetchedAt'])
        self.assertEqual(detail['candidate']['performers'][0]['nameKo'],'한국 이름')
        self.assertEqual(detail['candidate']['directors'][0]['nameJa'],'監督')
        self.assertEqual(detail['candidate']['jacketUrl'],av.PREFIX+'/'+id_+'/jacket')
        endpoint = self.endpoint(av.PREFIX+'/{id_}/jacket','GET')
        self.assertEqual(endpoint(id_,self.auth).body,png())
        self.code(lambda:endpoint(id_,'bad'),'Unauthorized',401)

    def test_worker_202_backoff_timeout_and_restart(self):
        id_ = self.new()
        self.open.side_effect = [Response({},status=202)]
        self.assertTrue(self.worker.process_one())
        row = self.row(id_)
        self.assertEqual((row['status'],row['attempts'],row['next_attempt_at']),('fetching',1,1010))
        self.assertFalse(self.worker.process_one())
        restarted = av.Worker(self.get_db,lambda:fake_s3,lambda:'test-bucket',self.relay,clock=lambda:self.now)
        restarted.pace = mock.Mock()
        self.now = 1010
        self.open.side_effect = [Response({},status=202)]
        restarted.process_one()
        self.assertEqual(self.row(id_)['next_attempt_at'],1030)
        self.now = 1600
        self.open.side_effect = AssertionError('expired budget must not fetch')
        restarted.process_one()
        self.assertEqual((self.row(id_)['status'],self.row(id_)['last_error']),('error','avLookupReadyTimeout'))

    def test_empty_and_not_due_cycles_never_open_a_write_transaction(self):
        statements, connections = [], []
        @contextmanager
        def traced_db():
            with self.get_db() as db:
                db.set_trace_callback(statements.append)
                wrapped = mock.Mock(wraps=db)
                connections.append(wrapped)
                yield wrapped
        with mock.patch.object(self.worker, 'get_db', traced_db):
            for _ in range(3):
                self.assertFalse(self.worker.process_one())
                self.assertEqual(self.worker.idle_wait(), av.IDLE_SECONDS)
            id_ = self.new()
            with self.get_db() as db:
                db.execute('UPDATE av_inbox SET next_attempt_at=? WHERE request_id=?', (self.now+30, id_))
                db.commit()
            self.assertFalse(self.worker.process_one())
        writes = [sql for sql in statements if sql.lstrip().upper().startswith(
            ('BEGIN', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'))]
        self.assertEqual(writes, [])
        self.assertEqual(sum(db.rollback.call_count for db in connections), 4)

    def test_idle_wait_uses_earliest_queued_or_fetching_due_and_cap(self):
        self.assertEqual(self.worker.idle_wait(), av.IDLE_SECONDS)
        queued, fetching, closed = self.new(), self.new(), self.new()
        with self.get_db() as db:
            db.execute('UPDATE av_inbox SET next_attempt_at=? WHERE request_id=?', (self.now+30, queued))
            db.execute("UPDATE av_inbox SET status='fetching',next_attempt_at=? WHERE request_id=?",
                       (self.now+10, fetching))
            db.execute("UPDATE av_inbox SET status='dismissed' WHERE request_id=?", (closed,))
            db.commit()
        self.assertEqual(self.worker.idle_wait(), 10)
        self.now += 11
        self.assertEqual(self.worker.idle_wait(), 0)
        with self.get_db() as db:
            db.execute("UPDATE av_inbox SET next_attempt_at=? WHERE status IN ('queued','fetching')",
                       (self.now+120,))
            db.commit()
        self.assertEqual(self.worker.idle_wait(), av.IDLE_SECONDS)

    def test_post_insert_wakes_idle_worker_and_stop_wakes_idle_wait(self):
        waiting, fetched, waiting_again = threading.Event(), threading.Event(), threading.Event()
        real_wait = self.worker.wake_event.wait
        def wait(seconds):
            waiting.set()
            if fetched.is_set():
                waiting_again.set()
            return real_wait(seconds)
        def fetch(code, deadline):
            fetched.set()
            return {'fields': {'titleJa': 'test'}}
        with mock.patch.object(self.worker.wake_event, 'wait', side_effect=wait), \
                mock.patch.object(self.worker, 'fetch', side_effect=fetch):
            self.addCleanup(self.worker.stop)
            self.worker.start()
            self.assertTrue(waiting.wait(2), 'worker must enter the capped idle wait')
            self.assertFalse(self.worker.wake_event.is_set())
            create = self.endpoint('/v1/av-lookups', 'POST')
            body = dict(requestId=str(uuid.uuid4()), productCode='SSIS-003')
            asyncio.run(create(request(body), self.auth))
            self.assertTrue(fetched.wait(2), 'insert must wake the worker before the idle cap')
            self.assertTrue(waiting_again.wait(2))
            thread = self.worker.thread
            self.worker.stop()
            self.assertFalse(thread.is_alive())
            self.assertIsNone(self.worker.thread)

    def test_retry_and_fix_code_wake_after_commit(self):
        id_ = self.new()
        self.post(id_, 'dismiss')
        for action, body in [('retry', {}), ('fix-code', {'productCode': 'ABW-100'})]:
            self.worker.wake_event.clear()
            def wake():
                self.assertEqual(self.row(id_)['status'], 'queued')
                self.worker.wake_event.set()
            with mock.patch.object(self.worker, 'wake', side_effect=wake):
                self.post(id_, action, body)
            self.assertTrue(self.worker.wake_event.is_set())
            self.post(id_, 'dismiss')

    def test_intake_wakes_after_commit_and_replay_does_not_wake(self):
        body = intake.LookupRequest(requestId=str(uuid.uuid4()), productCode='SSIS-001')
        def wake():
            with self.get_db() as db:
                db.execute('BEGIN IMMEDIATE')
                self.assertEqual(av.get_row(db, body.requestId)['status'], 'queued')
                db.rollback()
        notify = mock.Mock(side_effect=wake)
        receipt = intake.insert(self.get_db, body, notify)
        notify.assert_called_once_with()
        notify.reset_mock()
        self.assertEqual(intake.insert(self.get_db, body, notify), receipt)
        notify.assert_not_called()

    def test_wake_during_idle_check_is_not_lost(self):
        cycles = []
        def idle_wait():
            cycles.append(True)
            if len(cycles) == 1:
                self.worker.wake()
            else:
                self.worker.drain()
            return av.IDLE_SECONDS
        def wait(seconds):
            self.assertTrue(self.worker.wake_event.is_set())
            return True
        with mock.patch.object(self.worker, 'process_one', return_value=False), \
                mock.patch.object(self.worker, 'idle_wait', side_effect=idle_wait), \
                mock.patch.object(self.worker.wake_event, 'wait', side_effect=wait) as waiting:
            self.worker.run()
        self.assertEqual(len(cycles), 2)
        waiting.assert_called_once_with(av.IDLE_SECONDS)

    def test_claim_rechecks_status_due_time_and_generation(self):
        for mutation in ("status='dismissed'", 'next_attempt_at=2000', 'generation=generation+1'):
            with self.subTest(mutation=mutation):
                id_ = self.new()
                connections = []
                @contextmanager
                def raced_db():
                    with self.get_db() as db:
                        def execute(sql, *args):
                            if sql == 'BEGIN IMMEDIATE':
                                with self.get_db() as other:
                                    other.execute('UPDATE av_inbox SET '+mutation+' WHERE request_id=?', (id_,))
                                    other.commit()
                            return db.execute(sql, *args)
                        wrapped = mock.Mock(wraps=db)
                        wrapped.execute.side_effect = execute
                        connections.append(wrapped)
                        yield wrapped
                with mock.patch.object(self.worker, 'get_db', raced_db), \
                        mock.patch.object(self.worker, 'fetch') as fetch:
                    self.assertFalse(self.worker.process_one())
                    fetch.assert_not_called()
                self.assertEqual(self.row(id_)['attempts'], 0)
                connections[0].rollback.assert_called_once()
                connections[0].commit.assert_not_called()
                self.post(id_, 'dismiss')

    def test_unexpected_fetch_exceptions_are_terminal_and_worker_stays_alive(self):
        for exception in (RuntimeError, OSError):
            with self.subTest(exception=exception.__name__):
                failed, succeeding = self.new(), self.new()
                with self.get_db() as db:
                    db.execute('UPDATE av_inbox SET next_attempt_at=900 WHERE request_id=?', (failed,))
                    db.execute('UPDATE av_inbox SET next_attempt_at=950 WHERE request_id=?', (succeeding,))
                    db.commit()
                finished = threading.Event()
                calls = []
                def fetch(code, deadline):
                    calls.append(code)
                    if len(calls) == 1:
                        raise exception('private provider body and secret token')
                    finished.set()
                    return {'fields': {'titleJa': 'test'}}
                with mock.patch.object(self.worker, 'fetch', side_effect=fetch), \
                        self.assertLogs('av_inbox', level='WARNING') as logs:
                    self.addCleanup(self.worker.stop)
                    self.worker.start()
                    try:
                        self.assertTrue(finished.wait(2), 'the loop must continue after an unexpected exception')
                        self.assertTrue(self.worker.thread.is_alive())
                    finally:
                        self.worker.stop()
                row = self.row(failed)
                self.assertEqual((row['status'], row['last_error'], row['attempts'], row['next_attempt_at']),
                                 ('error', 'providerUnavailable', 1, 0))
                self.assertEqual(self.row(succeeding)['status'], 'found')
                self.assertEqual(logs.output, ['WARNING:av_inbox:AV inbox attempt failed for request '+failed])

    def test_202_then_found_and_retry_resets_budget(self):
        id_ = self.new()
        self.open.side_effect = [Response({},status=202)]
        self.worker.process_one()
        self.now = 1010
        self.fetch(id_)
        self.assertEqual(self.row(id_)['attempts'],2)
        self.post(id_,'retry')
        row = self.row(id_)
        self.assertEqual((row['status'],row['attempts'],row['started_at'],row['candidate']),('queued',0,None,None))

    def test_not_found_error_and_jacket_404_is_not_code_not_found(self):
        for responses,status,error in [([Response({},status=404)],'not_found',None),
                                      ([Response({},status=302)],'error','providerRedirectRefused'),
                                      ([Response(movie()),Response({},status=404)],'error','providerNotFound'),
                                      ([Response({'normalized_id':'SSIS-001'})],'error','providerInvalidResponse')]:
            id_ = self.new()
            self.open.side_effect = responses
            self.worker.process_one()
            self.assertEqual((self.row(id_)['status'],self.row(id_)['last_error']),(status,error))
        id_ = self.new('nonsense')
        self.assertEqual(self.row(id_)['last_error'],'invalidProductCode')

    def test_jacket_host_size_animation_and_mime_guards(self):
        for value in ('https://127.0.0.1/x','https://pics.dmm.co.jp:443/x','https://user@pics.dmm.co.jp/x',
                      'https://pics.dmm.co.jp.evil.test/x','file:///etc/passwd'):
            with self.assertRaises(ValueError):
                av.jacket_address(value)
        self.assertEqual(av.jacket_address('http://image.mgstage.com/x'),'https://image.mgstage.com/x')
        for data,mime in ((png(),'image/jpeg'),(b'bad','image/png'),(b'x'*(av.MAX_JACKET+1),'image/png')):
            self.code(lambda:av.decode_jacket(data,mime),'providerImageInvalid')
        out=io.BytesIO()
        a,b=Image.new('RGB',(2,2),'red'),Image.new('RGB',(2,2),'blue')
        a.save(out,'PNG',save_all=True,append_images=[b])
        self.code(lambda:av.decode_jacket(out.getvalue(),'image/png'),'providerImageInvalid')
        with mock.patch.object(wp,'image_dimensions',return_value=(2,2)):
            self.code(lambda:av.decode_jacket(b'invalid','image/png'),'providerImageInvalid')

    def test_actions_list_order_pagination_and_fix_keeps_collector_replay(self):
        id1,id2 = self.new(),self.new()
        listing=self.endpoint(av.PREFIX,'GET')
        page=listing(None,1,False,self.auth)
        self.assertEqual(page['items'][0]['id'],id2)
        self.assertTrue(page['hasMore'])
        self.assertEqual(listing(page['nextBefore'],1,False,self.auth)['items'][0]['id'],id1)
        fixed=self.post(id1,'fix-code',{'productCode':'118abw00001'})
        self.assertEqual(fixed['inbox']['normalizedCode'],'ABW-001')
        self.assertEqual(fixed['inbox']['productCode'],'ssis00001')
        body=intake.LookupRequest(requestId=id1,productCode='ssis00001')
        self.assertEqual(intake.insert(self.get_db,body)['requestId'],id1)
        self.post(id2,'dismiss')
        self.assertEqual(len(listing(None,100,False,self.auth)['items']),1)
        self.assertEqual(len(listing(None,100,True,self.auth)['items']),2)
        self.post(id2,'retry')
        self.assertEqual(self.row(id2)['status'],'queued')
        self.code(lambda:self.post(id1,'fix-code',{'productCode':'oops'}),'invalidProductCode',422)
        self.code(lambda:self.post(id1,'dismiss',{'extra':1}),'invalidAvInboxAction',422)
        self.code(lambda:self.post(id1,'retry',b'x'*2049),'avLookupRequestTooLarge',413)
        self.code(lambda:self.post('missing','dismiss'),'avInboxNotFound',404)

    def test_generation_prevents_inflight_dismiss_fix_retry_results(self):
        for action,body in [('dismiss',{}),('fix-code',{'productCode':'ABW-100'}),('retry',{})]:
            id_=self.new()
            def fetch(code,deadline):
                av.change(self.get_db,id_,action,body)
                return {'stale':True}
            with mock.patch.object(self.worker,'fetch',side_effect=fetch):
                self.worker.process_one()
            self.assertIsNone(self.row(id_)['candidate'])
            self.assertEqual(self.row(id_)['status'],'dismissed' if action=='dismiss' else 'queued')
            self.post(id_,'dismiss')

    def test_artwork_crop_receipts_real_addArtwork_and_apply_sequence(self):
        id_=self.fetch()
        fn=self.endpoint(av.PREFIX+'/{id_}/artwork','POST')
        body=dict(x1=378,x2=422,surfaces=['front','spine','back'])
        prepared=asyncio.run(fn(id_,request(body),self.auth))['items']
        self.create_av()
        for item,color,width in zip(prepared,[(0,0,255),(0,128,0),(255,0,0)],[378,44,378]):
            self.assertEqual((item['width'],item['height']),(width,538))
            art=f"art-{item['surface']}"
            command={k:v for k,v in item.items() if k!='surface'}
            receipt=self.command('addArtwork',workId='av',artworkId=art,**command)
            self.assertEqual(receipt['entities']['artworks'][0]['provider'],'libredmm')
            with self.get_db() as db:
                ca._require_confirmed_blob(db,item['original'])
                ca._require_confirmed_blob(db,item['thumbnail'])
            encoded=fake_s3.objects[wp.artwork_key(item['original']['sha256'])]['body']
            with Image.open(io.BytesIO(encoded)) as image:
                self.assertEqual(image.format,'JPEG')
                pixel=image.getpixel((image.width//2,image.height//2))
                self.assertTrue(all(abs(a-b)<5 for a,b in zip(pixel,color)),pixel)
            slot='work' if item['surface']=='front' else item['surface']
            self.command('selectArtwork',workId='av',slot=slot,artworkId=art,expectedArtworkId=None)
        with self.get_db() as db:
            revision=ca.work_row(db,fixtures.LIBRARY,'av')['entity_revision']
        self.assertEqual(revision,5)  # create 1, details +1, each selected surface +1; addArtwork no bump.
        self.command('setAvCredits',workId='av',credits=[dict(personId='person',role='performer',order=0,creditName=None)],
                     people=[dict(personId='person',displayName='한국 이름',nameJa='日本名')],expectedRevision=revision)
        matched=av.detail(self.get_db,id_)['matches']
        self.assertEqual(matched[0]['workId'],'av')
        result=self.post(id_,'applied',{'workId':'av'})
        self.assertEqual(result['inbox']['status'],'applied')
        self.assertEqual(self.post(id_,'applied',{'workId':'av'})['inbox'],result['inbox'])
        self.code(lambda:self.post(id_,'retry'),'avInboxStateConflict',409)
        self.code(lambda:self.post(id_,'applied',{'workId':'other'}),'avInboxStateConflict',409)

    def test_artwork_split_validation_nonwrap_and_candidate_unavailable(self):
        id_=self.fetch()
        fn=self.endpoint(av.PREFIX+'/{id_}/artwork','POST')
        for body in [dict(x1=True,x2=422,surfaces=['front']),dict(x1=423,x2=422,surfaces=['front']),
                     dict(x1=0,x2=0,surfaces=['back']),dict(x1=10,x2=10,surfaces=['spine']),
                     dict(x1=10,x2=900,surfaces=['front']),dict(x1=10,x2=20,surfaces=['front','front']),
                     dict(x1=10,x2=20,surfaces=[{}]),dict(x1=10,x2=20,surfaces=[])]:
            self.code(lambda:asyncio.run(fn(id_,request(body),self.auth)),'invalidAvSplit',422)
        self.post(id_,'dismiss')
        self.code(lambda:asyncio.run(fn(id_,request(dict(x1=378,x2=422,surfaces=['front'])),self.auth)),
                  'avInboxCandidateUnavailable',409)
        id_=self.fetch(size=(300,538))
        items=asyncio.run(fn(id_,request(dict(x1=0,x2=0,surfaces=['front'])),self.auth))['items']
        self.assertEqual((items[0]['width'],items[0]['height']),(300,538))

    def test_storage_confirmation_failure_and_preparation_race(self):
        id_=self.new()
        self.open.side_effect=[Response(movie()),Response(png(),'image/png')]
        fake_s3.fail_put=True
        self.addCleanup(setattr,fake_s3,'fail_put',False)
        self.worker.process_one()
        self.assertEqual(self.row(id_)['last_error'],'providerArtworkStorageUnavailable')
        fake_s3.fail_put=False
        self.post(id_,'retry')
        self.fetch(id_)
        original=av.confirm_blobs
        def store(*args):
            receipts=original(*args)
            av.change(self.get_db,id_,'dismiss',{})
            return receipts
        with mock.patch.object(av,'confirm_blobs',side_effect=store):
            self.code(lambda:av.prepare_artwork(self.get_db,id_,dict(x1=378,x2=422,surfaces=['front']),
                                               time.monotonic()+25,lambda:fake_s3,lambda:'test-bucket'),
                      'avInboxStateConflict',409)

    def test_mark_applied_requires_found_and_matching_live_authority_work(self):
        id_=self.new()
        self.code(lambda:self.post(id_,'applied',{'workId':'av'}),'avInboxCandidateUnavailable',409)
        self.fetch(id_)
        self.create_av(code='ABW-001')
        self.code(lambda:self.post(id_,'applied',{'workId':'av'}),'avInboxWorkMismatch',409)
        self.assertEqual(av.detail(self.get_db,id_)['matches'],[])
        self.command('setAvDetails',workId='av',changes={'productCode':'ssis00001'},expected={'productCode':'ABW-001'})
        self.assertEqual(av.detail(self.get_db,id_)['matches'][0]['workId'],'av')
        self.command('deleteWork',workId='av',expectedRevision=3)
        self.assertEqual(av.detail(self.get_db,id_)['matches'],[])

    def test_ordinary_auth_all_new_routes_and_old_feed_compatibility(self):
        id_=self.new()
        for fn in [lambda token:self.endpoint(av.PREFIX,'GET')(None,100,False,token),
                   lambda token:self.endpoint(av.PREFIX+'/{id_}','GET')(id_,token),
                   lambda token:self.endpoint(av.PREFIX+'/{id_}/jacket','GET')(id_,token),
                   lambda token:self.post(id_,'dismiss',authorization=token),
                   lambda token:asyncio.run(self.endpoint(av.PREFIX+'/{id_}/artwork','POST')(id_,request({}),token))]:
            self.code(lambda:fn('bad'),'Unauthorized',401)
        # Publisher is also an ordinary reader, but ordinary readers cannot consume legacy feed.
        self.endpoint(av.PREFIX+'/{id_}','GET')(id_,self.publisher)
        feed=self.endpoint('/v1/av-lookups','GET')
        self.code(lambda:feed(0,100,self.auth),'Unauthorized',401)
        page=feed(0,100,self.publisher)
        self.assertEqual(set(page),{'items','nextAfter','hasMore'})
        self.assertEqual(set(page['items'][0]),{'requestId','sequence','receivedAt','productCode','sourceUrl'})
        create=self.endpoint('/v1/av-lookups','POST')
        body=dict(requestId=str(uuid.uuid4()),productCode='SSIS-003',sourceUrl=None)
        receipt=asyncio.run(create(request(body),self.auth))
        self.assertEqual(asyncio.run(create(request(body),self.auth)),receipt)
        self.code(lambda:asyncio.run(create(request({**body,'productCode':'SSIS-004'}),self.auth)),
                  'avLookupConflict',409)
        self.code(lambda:asyncio.run(create(request(b'x'*4097),self.auth)),'avLookupRequestTooLarge',413)

    def test_retention_keeps_actionable_candidates_and_migrates_legacy_records(self):
        id_=self.fetch()
        old=(datetime.now(timezone.utc)-timedelta(days=31)).isoformat()
        with self.get_db() as db:
            db.execute('UPDATE av_lookup_requests SET received_at=?',(old,))
            db.commit()
        self.new()
        self.assertEqual(self.row(id_)['status'],'found')
        self.post(id_,'dismiss')
        self.new()
        self.code(lambda:av.detail(self.get_db,id_),'avInboxNotFound',404)
        legacy=str(uuid.uuid4())
        with self.get_db() as db:
            db.execute('INSERT INTO av_lookup_requests VALUES(?,?,?,?,?,?)',(100,legacy,'118abw00001',None,'digest','2026'))
            db.commit()
        intake.startup(self.get_db)
        self.assertEqual(self.row(legacy)['normalized_code'],'ABW-001')
        intake.startup(self.get_db)
        self.assertEqual(self.row(legacy)['status'],'queued')

    def test_pacing_single_lane_and_lifecycle_ownership(self):
        worker=av.Worker(self.get_db,lambda:fake_s3,lambda:'test-bucket',self.relay)
        waits=[]
        clock=[10.0]
        def wait(seconds):
            waits.append(seconds)
            clock[0]+=seconds
            return False
        with mock.patch.object(av.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(worker.stop_event,'wait',side_effect=wait):
            worker.pace('libredmm',100)
            worker.pace('libredmm',100)
        self.assertEqual(waits,[0,2])
        worker.lane.acquire()
        self.assertFalse(worker.process_one())
        worker.lane.release()
        self.assertIn(self.worker.drain, self.app.state._lakomics_lifecycle.drain_handlers)
        self.worker.drain()
        self.assertTrue(self.worker.stop_event.is_set())
        self.assertTrue(self.worker.wake_event.is_set())
        with mock.patch.object(worker,'run',side_effect=lambda:worker.stop_event.wait(1)):
            worker.start()
            thread=worker.thread
            worker.start()
            self.assertIs(worker.thread,thread)
            worker.stop()
        self.assertIsNone(worker.thread)


    def test_http_wire_validation_with_inline_threadpool(self):
        import httpx
        import fastapi.routing
        id_ = self.new()
        with self.get_db() as db:
            db.execute('INSERT INTO extension_clients(id,token_hash,created_at) VALUES(?,?,?)',
                       ('collector', api_auth.token_hash('collector-only'), '2026'))
            db.commit()
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test') as http:
                auth = {'Authorization': self.auth}
                for params in ({'limit':0}, {'limit':101}, {'before':0}, {'includeClosed':'invalid'}):
                    reply = await http.get(av.PREFIX, headers=auth, params=params)
                    self.assertEqual(reply.status_code,422,reply.text)
                reply = await http.get(av.PREFIX, headers=auth)
                self.assertEqual(reply.status_code,200,reply.text)
                self.assertEqual(reply.json()['items'][0]['id'],id_)
                paths = [(av.PREFIX,'GET',None), (av.PREFIX+'/'+id_,'GET',None),
                         (av.PREFIX+'/'+id_+'/jacket','GET',None),
                         *[(av.PREFIX+'/'+id_+'/'+a,'POST',b) for a,b in
                           [('retry',{}),('fix-code',{'productCode':'ABW-100'}),('dismiss',{}),
                            ('applied',{'workId':'x'}),('artwork',{'x1':0,'x2':0,'surfaces':['front']})]]]
                for path,method,body in paths:
                    reply=await http.request(method,path,headers={'Authorization':'Bearer collector-only'},json=body)
                    self.assertEqual(reply.status_code,401,reply.text)
                for action in ('retry','dismiss'):
                    reply=await http.post(av.PREFIX+'/'+id_+'/'+action,headers=auth,json={})
                    self.assertEqual(reply.status_code,200,reply.text)
                reply=await http.get('/v1/av-lookups',headers={'Authorization':self.publisher})
                self.assertEqual(reply.json()['items'][0]['productCode'],'ssis00001')
                reply=await http.post('/v1/av-lookups',headers={'Authorization':'Bearer collector-only'},
                                      json=dict(requestId=str(uuid.uuid4()),productCode='SSIS-100'))
                self.assertEqual(reply.status_code,200,reply.text)
        with mock.patch.object(fastapi.routing,'run_in_threadpool',inline):
            asyncio.run(exercise())

    def test_transport_raw_response_limit_pixel_limit_and_unconfirmed_artwork(self):
        id_=self.new()
        self.open.side_effect=[Response(b'x'*(av.MAX_JSON+1))]
        self.worker.process_one()
        self.assertEqual(self.row(id_)['last_error'],'providerResponseTooLarge')
        self.post(id_,'retry')
        self.open.side_effect=[Response(movie()),Response(png(),'image/png')]
        with mock.patch.object(wp,'image_dimensions',side_effect=HTTPException(422,{'code':'providerImageInvalid'})):
            self.worker.process_one()
        self.assertEqual(self.row(id_)['last_error'],'providerImageInvalid')
        self.create_av()
        self.code(lambda:self.command('addArtwork',workId='av',artworkId='missing',kind='cover',provider='libredmm',
                                      providerImageId=None,width=1,height=1,language='ja',thumbnail=None,
                                      original={'sha256':'f'*64,'sizeBytes':10,'contentType':'image/jpeg'}),
                  'artworkBlobUnconfirmed',409)


if __name__ == '__main__':
    unittest.main()
