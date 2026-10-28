"""AV inbox unit/handler tests: fake storage/SQLite and fail-closed outbound HTTP.

Handler tests execute coroutines directly with an inline threadpool stand-in, so
these unit tests also run where TestClient's cross-thread wakeups are unavailable.
They do not establish the ASGI HTTP/threadpool integration gate.
"""
import asyncio
import io
import json
import sqlite3
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


class AvJacketChoiceTests(unittest.TestCase):
    def setUp(self):
        self.mono = 'https://pics.dmm.co.jp/mono/movie/adult/1start649/1start649pl.jpg'
        self.hires = av.HIRES_URL.format(cid='1start00649')
        self.raw = dict(cover_image_url=self.mono, sample_image_urls=[
            'https://pics.dmm.co.jp/digital/video/1start00649/1start00649jp-1.jpg'])

    def jacket(self, size, *, matching=True, jpeg=False, brightness=0):
        """A patterned front at the actual split, with unrelated artwork on the back."""
        split = av.wrap_spine(*size)
        x2 = split[1] if split else av.default_split(*size)['x2']
        with Image.new('RGB', size, (120, 40, 80)) as image:
            width, height = size[0] - x2, size[1]
            # Relative blocks survive a change of resolution and JPEG encoding.
            for row in range(4):
                for col in range(3):
                    value = 35 if (row + col) % 2 else 210
                    if not matching:
                        value = 245 - value
                    value += brightness
                    image.paste((value, value, value),
                                (x2 + col * width // 3, row * height // 4,
                                 x2 + (col + 1) * width // 3, (row + 1) * height // 4))
            out = io.BytesIO()
            image.save(out, 'JPEG' if jpeg else 'PNG')
        return out.getvalue(), 'image/jpeg' if jpeg else 'image/png'

    def choose(self, images):
        self.asked = []
        def outbound(address, **kwargs):
            self.asked.append(address)
            if address in images:
                return images[address]
            raise wp.UpstreamStatus(404)
        with mock.patch.object(wp, 'outbound', side_effect=outbound):
            return av.choose_jacket('START-649', self.raw, time.monotonic() + 30)

    def test_matching_digital_front_keeps_hires_and_borrows_spine(self):
        chosen = self.choose({self.hires: self.jacket((1699, 1200), jpeg=True, brightness=10),
                              self.mono: self.jacket((800, 538))})
        self.assertEqual(chosen['address'], self.hires)
        self.assertEqual(chosen['spine']['address'], self.mono)
        self.assertEqual((chosen['spine']['x1'], chosen['spine']['x2']), av.wrap_spine(800, 538))

    def test_different_digital_front_uses_dvd_wrap_with_own_spine(self):
        for size in ((1699, 1200), (1600, 1076)):
            with self.subTest(size=size):
                chosen = self.choose({self.hires: self.jacket(size, matching=False),
                                      self.mono: self.jacket((800, 538))})
                self.assertEqual(chosen['address'], self.mono)
                self.assertIsNone(chosen['spine'])
                self.assertTrue(av.default_split(chosen['width'], chosen['height'])['useSpine'])

    def test_no_dvd_wrap_keeps_digital(self):
        chosen = self.choose({self.hires: self.jacket((1699, 1200), matching=False)})
        self.assertEqual(chosen['address'], self.hires)
        self.assertIsNone(chosen['spine'])
        self.assertEqual(self.asked.count(self.mono), 1)

    def test_cover_without_a_spine_is_reused_as_an_alternative(self):
        cover = self.jacket((800, 600))
        chosen = self.choose({self.hires: self.jacket((1699, 1200)), self.mono: cover})
        self.assertEqual(chosen['address'], self.hires)
        self.assertIsNone(chosen['spine'])
        alternative = next(image for image in chosen['alternatives'] if image['address'] == self.mono)
        self.assertEqual(alternative['data'], cover[0])
        self.assertIsNone(alternative['spine'])
        self.assertEqual(self.asked.count(self.mono), 1)

    def test_separate_optional_cover_failure_keeps_digital(self):
        self.raw['cover_image_url'] = 'https://pics.dmm.co.jp/jacket.jpg'
        for status in (404, 503):
            with self.subTest(status=status):
                def outbound(address, **kwargs):
                    if address == self.hires:
                        return self.jacket((1000, 672))
                    raise wp.UpstreamStatus(status if address == self.raw['cover_image_url'] else 404)
                with mock.patch.object(wp, 'outbound', side_effect=outbound):
                    chosen = av.choose_jacket('START-649', self.raw, time.monotonic() + 30)
                self.assertEqual(chosen['address'], self.hires)

    def test_no_digital_or_wrap_falls_back_to_cover(self):
        self.raw['cover_image_url'] = 'https://pics.dmm.co.jp/jacket.jpg'
        chosen = self.choose({self.raw['cover_image_url']: self.jacket((800, 538))})
        self.assertEqual(chosen['address'], self.raw['cover_image_url'])
        self.assertIsNone(chosen['spine'])


class AvInboxSignalTests(unittest.TestCase):
    def test_signal_moves_for_intake_status_actions_and_deletion(self):
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row

            @contextmanager
            def get_db():
                yield db

            intake.startup(get_db)
            previous = av.status_signal(db)
            id_ = str(uuid.uuid4())
            intake.insert(get_db, intake.LookupRequest(requestId=id_, productCode='SSIS-001'))
            self.assertGreater(av.status_signal(db), previous)
            # These all update the same row: a row count or request sequence misses them.
            for status in ('fetching', 'found', 'queued', 'dismissed', 'applied'):
                previous = av.status_signal(db)
                db.execute('UPDATE av_inbox SET status=? WHERE request_id=?', (status, id_))
                db.commit()
                self.assertGreater(av.status_signal(db), previous)
            previous = av.status_signal(db)
            db.execute('DELETE FROM av_lookup_requests WHERE request_id=?', (id_,))
            db.commit()
            self.assertGreater(av.status_signal(db), previous)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM av_inbox').fetchone()[0], 0)
        db.close()


class AvOwnedTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)

        @contextmanager
        def get_db():
            yield self.db

        self.get_db = get_db
        ca.startup(get_db)
        av.authority.startup(get_db)
        self.db.execute("INSERT INTO authority_domains VALUES(?,'collections',1,1,0,?,NULL,'2026')",
                        (fixtures.LIBRARY, 'a' * 64))
        self.app = FastAPI()

        def capture_auth(value):
            if value != 'Bearer collector':
                raise HTTPException(401)
            return 'collector'

        intake.register(self.app, get_db, capture_auth, capture_auth)
        self.endpoint = next(r.endpoint for r in self.app.routes if getattr(r, 'path', None) == '/v1/av-owned')
        patch = mock.patch.object(intake, 'run_in_threadpool', inline)
        patch.start()
        self.addCleanup(patch.stop)

    def add_work(self, id_, code, lifecycle='live', type_='av', library=fixtures.LIBRARY):
        self.db.execute("INSERT INTO collection_authority_works "
                        "(library_id,work_id,type,name,fields,showcase,selection,details,derived,lifecycle,"
                        "entity_revision,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?,?,?,1,'2026','2026')",
                        (library, id_, type_, id_, '{}', '{}', json.dumps({'av': {'productCode': code}}),
                         '{}', lifecycle))
        self.db.commit()

    def query(self, body, authorization='Bearer collector'):
        return asyncio.run(self.endpoint(request(body), authorization))

    def test_owned_normalized_live_av_codes_in_active_library_only(self):
        self.add_work('owned', 'mida703')
        self.add_work('trashed', 'DLDSS-467', lifecycle='trashed')
        self.add_work('other-type', 'ABW-100', type_='movie')
        self.add_work('other-library', 'SSIS-001', library='other')
        statements = []
        self.db.set_trace_callback(statements.append)
        self.assertEqual(self.query({'codes': ['mida703', 'MIDA-703', 'DLDSS-467', 'ABW-100', 'SSIS-001', 'MIDA-704']}),
                         {'owned': ['MIDA-703']})
        self.assertEqual(sum('SELECT * FROM collection_authority_works' in sql for sql in statements), 1)
        self.assertEqual(av.matches(self.db, 'MIDA-703')[0]['workId'], 'owned')
        self.db.execute("DELETE FROM authority_domains WHERE domain='collections'")
        self.assertEqual(self.query({'codes': ['MIDA-703']}), {'owned': []})

    def test_collector_auth_and_request_limits(self):
        with self.assertRaises(HTTPException) as denied:
            self.query({'codes': ['MIDA-703']}, 'Bearer wrong')
        self.assertEqual(denied.exception.status_code, 401)
        for body in ({'codes': ['MIDA-703'] * 201}, {'codes': ['x' * 41]}, {'codes': ['한' * 14]}):
            with self.subTest(body=body), self.assertRaises(HTTPException) as rejected:
                self.query(body)
            self.assertEqual(rejected.exception.status_code, 422)
        self.assertEqual(self.query({'codes': ['MIDA-703'] * 200}), {'owned': []})


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

    def test_defaults_fit_the_wide_digital_jacket(self):
        self.assertEqual(av.default_split(2184,1468),dict(x1=1032,x2=1152,isWrap=True,useSpine=True))
        # 4:3 wraps have no recognisable spine; the split stays valid and the confirmation UI adjusts it.
        split = av.default_split(2184,1638)
        self.assertEqual((split['x1'],split['x2'],split['useSpine']),(1092,1092,False))

    def test_digital_cid_candidates_pad_prefix_and_come_from_sample_urls(self):
        base='https://awsimgsrc.dmm.co.jp/pics_dig/digital/video/%s/%spl.jpg'
        def urls(code,**raw):
            return av.hires_addresses(code,raw)
        # Mono/DVD cover (k9ssis001) carries no cid; the sample images do.
        mono=dict(cover_image_url='https://pics.dmm.co.jp/mono/movie/adult/k9ssis001/k9ssis001pl.jpg',
                  sample_image_urls=['https://pics.dmm.co.jp/digital/video/ssis00001/ssis00001jp-1.jpg'])
        self.assertEqual(urls('SSIS-001',**mono),[base%(c,c) for c in ('ssis00001','1ssis00001','118ssis00001')])
        # Unpadded number is padded to five digits; the record's own prefix is tried last.
        self.assertEqual(urls('STARS-100',sample_image_urls=['https://pics.dmm.co.jp/digital/video/1stars100/1stars100jp-1.jpg']),
                         [base%(c,c) for c in ('stars00100','1stars00100','118stars00100')])
        self.assertEqual(urls('FNS-001',sample_image_urls=['https://x/digital/video/h_1074fns00001/h_1074fns00001jp-1.jpg']),
                         [base%(c,c) for c in ('fns00001','1fns00001','118fns00001','h_1074fns00001')])
        # The cover itself may already be a digital path; other titles' cids and cid-less records give nothing.
        self.assertEqual(len(urls('SSIS-001',cover_image_url='https://pics.dmm.co.jp/digital/video/ssis00001/ssis00001pl.jpg')),3)
        self.assertEqual(urls('SSIS-001',sample_image_urls=['https://pics.dmm.co.jp/digital/video/abw00001/abw00001jp-1.jpg']),[])
        self.assertEqual(urls('SSIS-001',cover_image_url='https://pics.dmm.co.jp/jacket.jpg'),[])
        self.assertEqual(urls('FC2-PPV-123',sample_image_urls=['https://x/digital/video/fc2ppv123/a.jpg']),[])

    def test_worker_takes_the_first_wider_digital_jacket_else_the_cover(self):
        samples=['https://pics.dmm.co.jp/digital/video/1stars100/1stars100jp-1.jpg']
        raw=lambda:Response({**movie(),'normalized_id':'STARS-100','sample_image_urls':samples})
        # none (404) -> same 800 px image (not wider) -> wide jacket: the third address wins.
        id_=self.new('stars100')
        self.open.side_effect=[raw(),Response({},status=404),Response(png(),'image/png'),Response(png((1000,672)),'image/png'),
                               # Three wrap probes and the separate optional LibreDMM cover.
                               *[Response({},status=404) for _ in range(4)],Response(wiki())]
        self.assertTrue(self.worker.process_one())
        asked=[call.args[0].full_url for call in self.open.call_args_list]
        self.assertEqual([u.rsplit('/',1)[1] for u in asked[1:4]],['stars00100pl.jpg','1stars00100pl.jpg','118stars00100pl.jpg'])
        candidate=json.loads(self.row(id_)['candidate'])
        self.assertEqual((candidate['jacketWidth'],candidate['jacketHeight']),(1000,672))
        self.assertEqual(candidate['defaultSplit'],av.default_split(1000,672))
        # Every digital address 404s: the cover path is used exactly as before.
        id_=self.new('stars100')
        self.open.side_effect=[raw(),*[Response({},status=404) for _ in range(3)],Response(png(),'image/png'),Response(wiki())]
        self.assertTrue(self.worker.process_one())
        self.assertEqual(json.loads(self.row(id_)['candidate'])['jacketWidth'],800)
        # A CDN that errors out costs one request, not the lookup.
        id_=self.new('stars100')
        self.open.side_effect=[raw(),Response({},status=503),Response(png(),'image/png'),Response(wiki())]
        self.assertTrue(self.worker.process_one())
        self.assertEqual(json.loads(self.row(id_)['candidate'])['jacketWidth'],800)

    def serve(self, code, record, images):
        """Route outbound HTTP by address: the LibreDMM record, the given PNGs (address -> bytes), Wikidata; else 404."""
        self.asked = []
        def route(request, timeout=None):
            url = request.full_url
            self.asked.append(url)
            if url.startswith('https://www.libredmm.com/'):
                return Response({**movie(), 'normalized_id': code, **record})
            if url.startswith('https://query.wikidata.org/'):
                return Response(wiki())
            if url in images:
                return Response(images[url], 'image/png')
            return Response({}, status=404)
        self.open.side_effect = route

    def stored_image(self, receipt):
        with Image.open(io.BytesIO(fake_s3.objects[wp.artwork_key(receipt['sha256'])]['body'])) as image:
            return image.convert('RGB')

    def test_wrap_and_centre_spine_of_a_dvd_wrap(self):
        self.assertEqual(av.wrap_spine(800,538),(378,422))
        self.assertEqual(av.wrap_spine(800,438),(382,418))  # much wider wrap: spine in the centre
        self.assertIsNone(av.wrap_spine(800,600))           # 4:3 has no spine to take
        self.assertTrue(av.is_spineless(2184,1638))
        self.assertFalse(av.is_spineless(2184,1468))
        self.assertFalse(av.is_spineless(378,538))
        self.assertEqual(av.default_split(2184,1638,True),dict(x1=1092,x2=1092,isWrap=True,useSpine=True))
        self.assertFalse(av.default_split(378,538,True)['useSpine'])

    def test_front_only_cover_is_replaced_by_its_wrap_when_it_is_one(self):
        ps='https://pics.dmm.co.jp/mono/movie/adult/77midv032/77midv032ps.jpg'
        mono=ps.replace('ps.jpg','pl.jpg')
        digital='https://pics.dmm.co.jp/digital/video/midv00032/midv00032pl.jpg'
        record=dict(cover_image_url=ps,sample_image_urls=['https://pics.dmm.co.jp/digital/video/midv00032/midv00032jp-1.jpg'])
        def found(images):
            id_=self.new('midv032')
            self.serve('MIDV-032',record,images)
            self.assertTrue(self.worker.process_one())
            return json.loads(self.row(id_)['candidate'])
        # The wrap on the mono path wins over the digital one; the front-only image is not kept.
        candidate=found({ps:png((147,200)),mono:png((800,538)),digital:png((800,565))})
        self.assertEqual((candidate['jacketWidth'],candidate['jacketHeight']),(800,538))
        self.assertEqual(candidate['defaultSplit'],av.default_split(800,538))
        self.assertLess(self.asked.index(ps),self.asked.index(mono))
        self.assertNotIn(digital,self.asked)
        # No mono wrap: the digital one on DMM's own host.
        candidate=found({ps:png((147,200)),digital:png((800,565))})
        self.assertEqual((candidate['jacketWidth'],candidate['jacketHeight']),(800,565))
        # A "pl" that is not clearly wider than a front changes nothing.
        candidate=found({ps:png((147,200)),mono:png((400,500))})
        self.assertEqual((candidate['jacketWidth'],candidate['defaultSplit']['isWrap']),(147,False))
        # A cover that is not front-only is never second-guessed.
        record['cover_image_url']=mono
        candidate=found({mono:png((800,538))})
        self.assertEqual(candidate['jacketWidth'],800)
        self.assertEqual([u for u in self.asked if u.startswith('https://pics.')],[mono])

    def test_spineless_digital_jacket_takes_the_spine_of_the_dvd_wrap(self):
        mono='https://pics.dmm.co.jp/mono/movie/adult/k9snos130/k9snos130pl.jpg'
        record=dict(cover_image_url=mono,sample_image_urls=['https://pics.dmm.co.jp/digital/video/snos00130/snos00130jp-1.jpg'])
        hires=av.HIRES_URL.format(cid='snos00130')
        id_=self.new('snos130')
        # The digital front must depict the same blue front as the DVD fixture.
        with Image.open(io.BytesIO(png((2184,1638)))) as digital:
            digital.paste('blue',(1092,0,2184,1638))
            out=io.BytesIO()
            digital.save(out,'PNG')
        self.serve('SNOS-130',record,{hires:out.getvalue(),mono:png((800,438))})
        self.assertTrue(self.worker.process_one())
        candidate=json.loads(self.row(id_)['candidate'])
        self.assertEqual((candidate['jacketWidth'],candidate['jacketHeight']),(2184,1638))
        self.assertEqual(candidate['defaultSplit'],dict(x1=1092,x2=1092,isWrap=True,useSpine=True))
        source=candidate['spineSource']
        self.assertEqual((source['address'],source['x1'],source['x2'],source['width'],source['height']),(mono,382,418,800,438))
        self.assertNotEqual(source['sha256'],candidate['jacket']['sha256'])
        self.assertEqual(av.detail(self.get_db,id_)['candidate']['spineSource']['sha256'],source['sha256'])
        # The PC shows the real strip in its spine menu: the borrowed image is served to a signed-in client.
        source_image=self.endpoint(av.PREFIX+'/{id_}/spine-source','GET')
        self.assertEqual(source_image(id_,self.auth).body,png((800,438)))
        self.code(lambda:source_image(id_,'bad'),'Unauthorized',401)
        fn=self.endpoint(av.PREFIX+'/{id_}/artwork','POST')
        def prepare(x1,x2,surfaces=('front','spine','back')):
            return {i['surface']:i for i in asyncio.run(fn(id_,request(dict(x1=x1,x2=x2,surfaces=list(surfaces))),self.auth))['items']}
        # The tablet sends the default split (x1 == x2): back and front from the wide jacket, the spine strip
        # of the DVD wrap scaled to its height.
        items=prepare(1092,1092)
        self.assertEqual({k:(v['width'],v['height']) for k,v in items.items()},
                         {'front':(1092,1638),'spine':(135,1638),'back':(1092,1638)})
        self.assertEqual(items['spine']['providerImageId'],f"SNOS-130:{candidate['jacket']['sha256']}:1092:1092:spine")
        pixel=self.stored_image(items['spine']['original']).getpixel((67,800))
        self.assertTrue(all(abs(a-b)<8 for a,b in zip(pixel,(0,128,0))),pixel)
        # The PC keeps a 1 px "spine" between the lines; that is still no spine of its own.
        items=prepare(1092,1093)
        self.assertEqual({k:v['width'] for k,v in items.items()},{'front':1091,'spine':135,'back':1092})
        # A spine drawn on purpose (at least 1% of the width) is cut from the wide jacket itself.
        items=prepare(1000,1150)
        self.assertEqual({k:v['width'] for k,v in items.items()},{'front':1034,'spine':150,'back':1000})
        # The authority accepts the borrowed spine like any other artwork.
        self.create_av('av','SNOS-130')
        spine={k:v for k,v in prepare(1092,1092,('spine',))['spine'].items() if k!='surface'}
        self.assertEqual(self.command('addArtwork',workId='av',artworkId='spine',**spine)['entities']['artworks'][0]['kind'],'spine')

    def test_no_spine_to_borrow_keeps_the_spine_less_split(self):
        mono='https://pics.dmm.co.jp/mono/movie/adult/k9snos130/k9snos130pl.jpg'
        digital='https://pics.dmm.co.jp/digital/video/snos00130/snos00130pl.jpg'
        record=dict(cover_image_url=mono,sample_image_urls=[digital.replace('pl.jpg','jp-1.jpg')])
        hires=av.HIRES_URL.format(cid='snos00130')
        id_=self.new('snos130')
        # The only wraps are 4:3 images, which have no spine to take.
        self.serve('SNOS-130',record,{hires:png((2184,1638)),mono:png((800,600)),digital:png((800,600))})
        self.assertTrue(self.worker.process_one())
        candidate=json.loads(self.row(id_)['candidate'])
        self.assertNotIn('spineSource',candidate)
        self.code(lambda:self.endpoint(av.PREFIX+'/{id_}/spine-source','GET')(id_,self.auth),'avInboxCandidateUnavailable',409)
        self.assertEqual(candidate['defaultSplit'],dict(x1=1092,x2=1092,isWrap=True,useSpine=False))
        fn=self.endpoint(av.PREFIX+'/{id_}/artwork','POST')
        self.code(lambda:asyncio.run(fn(id_,request(dict(x1=1092,x2=1092,surfaces=['spine'])),self.auth)),'invalidAvSplit',422)
        # A wide jacket with its own spine still checks for a matching DVD wrap.
        id_=self.new('snos130')
        self.serve('SNOS-130',record,{hires:png((2184,1468))})
        self.assertTrue(self.worker.process_one())
        self.assertNotIn('spineSource',json.loads(self.row(id_)['candidate']))
        self.assertEqual([u for u in self.asked if u.endswith('.jpg')],
                         [hires,*av.wrap_addresses('SNOS-130',record,with_cover=True)])

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
        # Directors are no longer imported: the key stays (empty) for older clients.
        self.assertEqual(detail['candidate']['directors'],[])
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


class AvJacketStorageTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.db.row_factory=sqlite3.Row
        self.addCleanup(self.db.close)
        @contextmanager
        def get_db():
            yield self.db
        self.get_db=get_db
        intake.startup(get_db)
        self.db.execute('CREATE TABLE mobile_collection_artwork (sha256 TEXT PRIMARY KEY, size_bytes INTEGER, content_type TEXT)')
        self.app=FastAPI()
        self.worker=av.register(self.app,get_db,lambda auth:None,lambda:fake_s3,lambda:'test-bucket')
        self.worker.pace=mock.Mock()
        self.worker.names=lambda names,deadline:{name:av.japanese(name) for name in names}
        self.auth='Bearer fixture'
        fake_s3.objects.clear()
        patch=mock.patch.object(fake_s3,'get_object',side_effect=lambda **kw:dict(
            Body=io.BytesIO(fake_s3.objects[kw['Key']]['body']),
            ContentLength=len(fake_s3.objects[kw['Key']]['body']),
            ContentType=fake_s3.objects[kw['Key']]['content_type']),create=True)
        patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(av,'run_in_threadpool',inline)
        patch.start();self.addCleanup(patch.stop)

    def endpoint(self,path,method):
        return next(r.endpoint for r in self.app.routes if getattr(r,'path',None)==path and method in r.methods)

    def new(self,code='SSIS-001'):
        return intake.insert(self.get_db,intake.LookupRequest(requestId=str(uuid.uuid4()),productCode=code))['requestId']

    def row(self,id_):
        return av.get_row(self.db,id_)

    def fetch(self,id_=None):
        id_=id_ or self.new()
        with mock.patch.object(wp,'outbound',side_effect=lambda address,**kw:
                (json.dumps(movie()).encode(),'application/json') if address.endswith('.json') else (png(),'image/png')):
            candidate=self.worker.fetch(self.row(id_)['normalized_code'],time.monotonic()+30)
        self.db.execute("UPDATE av_inbox SET status='found',candidate=? WHERE request_id=?",(json.dumps(candidate),id_))
        self.db.commit()
        return id_

    def serve(self,code,record,images):
        def outbound(address,**kw):
            if address.endswith('.json'):
                return json.dumps({**movie(),'normalized_id':code,**record}).encode(),'application/json'
            if address in images:
                return images[address],'image/png'
            raise wp.UpstreamStatus(404)
        patch=mock.patch.object(wp,'outbound',side_effect=outbound)
        patch.start();self.addCleanup(patch.stop)

    def post(self,id_,action):
        return av.change(self.get_db,id_,action,{})

    def test_alternatives_are_stored_listed_and_apply_their_own_spine(self):
        mono='https://pics.dmm.co.jp/mono/movie/adult/k9snos130/k9snos130pl.jpg'
        cover=mono.replace('pl.jpg','ps.jpg')
        hires=av.HIRES_URL.format(cid='snos00130')
        raw=dict(cover_image_url=cover,sample_image_urls=['https://pics.dmm.co.jp/digital/video/snos00130/snos00130jp-1.jpg'])
        id_=self.new('snos130')
        images={hires:png((2184,1638)),mono:png((800,438)),cover:png((147,200))}
        self.serve('SNOS-130',raw,images)
        self.assertTrue(self.worker.process_one())
        saved=json.loads(self.row(id_)['candidate'])
        choices=av.detail(self.get_db,id_)['candidate']['jackets']
        self.assertEqual(len(choices),3)
        self.assertEqual(sum(j['chosen'] for j in choices),1)
        self.assertEqual(next(j['key'] for j in choices if j['chosen']),saved['jacket']['sha256'])
        jacket_route=self.endpoint(av.PREFIX+'/{id_}/jacket','GET')
        artwork=self.endpoint(av.PREFIX+'/{id_}/artwork','POST')
        for choice in choices:
            stored=av.selected_jacket(saved,choice['key'])
            self.assertEqual(jacket_route(id_,self.auth,choice['key']).body,
                             av.stored_jacket(stored,lambda:fake_s3,lambda:'test-bucket',time.monotonic()+30)[0])
            split=choice['defaultSplit']
            surfaces=['front','spine','back'] if split['isWrap'] else ['front']
            body=dict(x1=split['x1'],x2=split['x2'],surfaces=surfaces,jacketKey=choice['key'])
            result=asyncio.run(artwork(id_,request(body),self.auth))['items']
            self.assertTrue(all(f":{choice['sha256']}:" in item['providerImageId'] for item in result))
            if choice['width']==2184:
                spine=next(i for i in result if i['surface']=='spine')
                self.assertEqual((spine['width'],spine['height']),(135,1638))
            elif choice['width']==800:
                spine=next(i for i in result if i['surface']=='spine')
                self.assertEqual((spine['width'],spine['height']),(36,438))

    def test_legacy_candidate_applies_and_found_can_be_relooked_up(self):
        id_=self.fetch()
        saved=json.loads(self.row(id_)['candidate'])
        saved.pop('jackets',None)
        with self.get_db() as db:
            db.execute('UPDATE av_inbox SET candidate=? WHERE request_id=?',(json.dumps(saved),id_))
            db.commit()
        artwork=self.endpoint(av.PREFIX+'/{id_}/artwork','POST')
        result=asyncio.run(artwork(id_,request(dict(x1=378,x2=422,surfaces=['front'])),self.auth))
        self.assertEqual(result['items'][0]['width'],378)
        generation=self.row(id_)['generation']
        reply=self.post(id_,'retry')
        self.assertEqual(reply['inbox']['status'],'queued')
        self.assertIsNone(reply['candidate'])
        self.assertGreater(self.row(id_)['generation'],generation)


if __name__ == '__main__':
    unittest.main()
