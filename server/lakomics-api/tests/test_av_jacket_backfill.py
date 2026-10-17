"""AV jacket backfill: decisions, the authority swap and reruns, with fake HTTP and fake R2."""
import asyncio
import hashlib
import io
import json
import unittest
from unittest import mock

from PIL import Image

from tests import test_av_inbox as base
from tests.test_av_inbox import Response, movie, png, request, wiki
from tests.test_capture_api_stub import fake_s3
import authority
import av_inbox as av
import av_jacket_backfill as bf
import collection_authority as ca
import work_providers as wp


class DecisionTests(unittest.TestCase):
    def test_split_scales_with_width_and_keeps_a_flat_jacket_flat(self):
        self.assertEqual(bf.scale_split(800, 378, 422, 2184), (1032, 1152))
        self.assertEqual(bf.scale_split(800, 378, 422, 1600), (756, 844))
        self.assertEqual(bf.scale_split(300, 0, 0, 900), (0, 0))

    def test_aspect_must_match_closely(self):
        self.assertTrue(bf.same_aspect(800, 538, 2184, 1468))
        self.assertFalse(bf.same_aspect(800, 538, 2184, 1638))
        self.assertFalse(bf.same_aspect(800, 538, 1700, 1200))


class BackfillTests(unittest.TestCase):
    def setUp(self):
        self.t = base.AvInboxTests('fetch')
        self.t.setUp()
        self.addCleanup(self.t.doCleanups)
        self.get_db = self.t.get_db
        with self.get_db() as db:
            db.execute(bf.DDL)
            db.commit()
        self.cdn = {}      # CDN URL -> (bytes, mime); anything else is a 404
        self.libredmm = {}  # code -> JSON record
        self.fetched = []

    def outbound(self, url, **kwargs):
        self.fetched.append(url)
        if url.startswith('https://www.libredmm.com/movies/'):
            code = url.rsplit('/', 1)[1][:-5]
            if code not in self.libredmm:
                raise wp.UpstreamStatus(404)
            return json.dumps(self.libredmm[code]).encode(), 'application/json'
        if url not in self.cdn:
            raise wp.UpstreamStatus(404)
        return self.cdn[url]

    def old_work(self, work, code, size=(800, 538)):
        """A confirmed AV work made the normal way: inbox candidate -> crops -> add + select."""
        t = self.t
        id_ = t.new(code)
        t.open.side_effect = [Response({**movie(), 'normalized_id': code}), Response(png(size), 'image/png'), Response(wiki())]
        self.assertTrue(t.worker.process_one())
        return self.confirm(id_, work, code)

    def confirm(self, id_, work, code, surfaces=None):
        """Crop the found candidate at its default split and apply it to a new AV work."""
        t = self.t
        split = json.loads(t.row(id_)['candidate'])['defaultSplit']
        surfaces = surfaces or (['front', 'spine', 'back'] if split['isWrap'] else ['front'])
        body = dict(x1=split['x1'], x2=split['x2'], surfaces=surfaces)
        items = asyncio.run(t.endpoint(av.PREFIX + '/{id_}/artwork', 'POST')(id_, request(body), t.auth))['items']
        t.create_av(work, code)
        for item in items:
            art = f"{work}-{item['surface']}"
            t.command('addArtwork', workId=work, artworkId=art, **{k: v for k, v in item.items() if k != 'surface'})
            t.command('selectArtwork', workId=work, slot='work' if item['surface'] == 'front' else item['surface'],
                      artworkId=art, expectedArtworkId=None)
        t.post(id_, 'applied', {'workId': work})
        return id_

    def record(self, code, cover, cid=None):
        """What LibreDMM answers for a code: the cover, and the digital cid its sample images carry."""
        self.libredmm[code] = {**movie(), 'normalized_id': code, 'cover_image_url': cover,
                               **({'sample_image_urls': [f'https://pics.dmm.co.jp/digital/video/{cid}/{cid}jp-1.jpg']} if cid else {})}

    def image(self, url, size):
        self.cdn[url] = (png(size), 'image/png')

    def lookup(self, code, cover, images, cid=None):
        """Run a real inbox lookup against the same fake CDN; returns the inbox id."""
        id_ = self.t.new(code)
        self.record(code, cover, cid)
        for url, size in images.items():
            self.image(url, size)
        with mock.patch.object(wp, 'outbound', side_effect=self.outbound):
            self.assertTrue(self.t.worker.process_one())
        self.assertEqual(self.t.row(id_)['status'], 'found')
        return id_

    def hires(self, code, cid, size):
        label = code.split('-')[0].lower()
        self.libredmm[code] = {**movie(), 'normalized_id': code, 'cover_image_url': f'https://pics.dmm.co.jp/mono/movie/adult/k9{label}001/k9{label}001pl.jpg',
                               'sample_image_urls': [f'https://pics.dmm.co.jp/digital/video/{cid}/{cid}jp-1.jpg']}
        image = io.BytesIO()
        Image.new('RGB', size, 'white').save(image, 'JPEG')
        self.cdn[av.HIRES_URL.format(cid=cid)] = (image.getvalue(), 'image/jpeg')

    def run_backfill(self, apply, candidates=False, retry=False):
        lines = []
        job = bf.Backfill(self.get_db, lambda: fake_s3, lambda: 'test-bucket', apply=apply, sleep=lambda _: None,
                          log=lines.append, retry=retry)
        with mock.patch.object(wp, 'outbound', side_effect=self.outbound):
            summary = job.run(candidates=candidates)
        return summary, [json.loads(line) for line in lines]

    def selection(self, work):
        with self.get_db() as db:
            row = ca.work_row(db, base.fixtures.LIBRARY, work)
            arts = {r['artwork_id']: r for r in db.execute(
                'SELECT * FROM collection_authority_artworks WHERE work_id=?', (work,))}
            cursor = authority.active_domain(db, ca.DOMAIN)['cursor']
        return json.loads(row['selection']), arts, cursor

    def test_dry_run_changes_nothing_then_apply_swaps_once_and_a_rerun_is_quiet(self):
        self.old_work('w1', 'SSIS-001')
        self.hires('SSIS-001', 'ssis00001', (1600, 1076))
        before = self.selection('w1')

        summary, lines = self.run_backfill(apply=False)
        self.assertEqual(summary['counts'], {'would_swap': 1})
        self.assertEqual((lines[0]['oldSplit'], lines[0]['newSplit'], lines[0]['surfaces']),
                         ([378, 422], [756, 844], ['front', 'spine', 'back']))
        self.assertEqual(self.selection('w1')[0], before[0])
        self.assertEqual(self.selection('w1')[2], before[2])

        blobs_before = set(fake_s3.objects)
        summary, lines = self.run_backfill(apply=True)
        self.assertEqual(summary['counts'], {'done': 1})
        selected, arts, cursor = self.selection('w1')
        self.assertGreater(cursor, before[2])
        for slot, surface, kind, width in (('work', 'front', 'cover', 756), ('spine', 'spine', 'spine', 88), ('back', 'back', 'back', 756)):
            new = arts[selected[slot]]
            self.assertNotEqual(selected[slot], before[0][slot])
            self.assertEqual((new['width'], new['height'], new['provider'], new['kind']), (width, 1076, 'libredmm', kind))
            self.assertTrue(new['provider_image_id'].endswith(f':756:844:{surface}'))
            self.assertIn(before[0][slot], arts)  # the old artwork row stays, only unselected
        self.assertTrue(blobs_before <= set(fake_s3.objects) and not fake_s3.deleted)
        stored = fake_s3.objects[wp.artwork_key(json.loads(arts[selected['work']]['original'])['sha256'])]['body']
        with Image.open(io.BytesIO(stored)) as image:
            self.assertEqual(image.size, (756, 1076))

        cursor = self.selection('w1')[2]
        self.fetched.clear()
        summary, _ = self.run_backfill(apply=True)
        self.assertEqual(summary['remoteFetches'], 0)
        self.assertEqual(self.fetched, [])
        self.assertEqual(self.selection('w1')[2], cursor)

    def test_other_aspect_or_no_wide_jacket_is_left_alone_and_not_asked_again(self):
        self.old_work('w2', 'ABW-001')
        self.old_work('w3', 'MIDE-005')
        self.hires('ABW-001', 'abw00001', (1600, 1200))
        self.libredmm['MIDE-005'] = {**movie(), 'normalized_id': 'MIDE-005'}  # mono cover only, no digital cid
        before = {w: self.selection(w) for w in ('w2', 'w3')}

        summary, lines = self.run_backfill(apply=True)
        self.assertEqual(summary['counts'], {'aspect_mismatch': 1, 'no_hires': 1})
        self.assertEqual(summary['manualResplit'], [dict(workId='w2', code='ABW-001', old=[800, 538], new=[1600, 1200])])
        self.assertEqual({w: self.selection(w) for w in before}, before)

        self.fetched.clear()
        summary, _ = self.run_backfill(apply=True)
        self.assertEqual((self.fetched, summary['counts']), ([], {'skip_recorded_aspect_mismatch': 1, 'skip_recorded_no_hires': 1}))

    def test_a_digital_jacket_that_is_not_wider_is_not_used(self):
        self.old_work('w4', 'SSIS-004')
        self.hires('SSIS-004', 'ssis00004', (800, 538))
        summary, lines = self.run_backfill(apply=True)
        self.assertEqual((summary['counts'], lines[0]['reason']), ({'no_hires': 1}, 'noHiresOnCdn'))

    def test_a_selection_changed_meanwhile_wins_over_the_backfill(self):
        self.old_work('w5', 'SSIS-005')
        self.hires('SSIS-005', 'ssis00005', (1600, 1076))
        real = bf.Backfill.swap
        def user_picks_first(job, *args):
            self.t.command('selectArtwork', workId='w5', slot='work', artworkId=None, expectedArtworkId='w5-front')
            return real(job, *args)
        with mock.patch.object(bf.Backfill, 'swap', user_picks_first):
            summary, lines = self.run_backfill(apply=True)
        self.assertEqual((summary['counts'], lines[0]['reason']), ({'conflict': 1}, 'selectionChanged'))
        selected, arts, _ = self.selection('w5')
        self.assertIsNone(selected['work'])
        self.assertEqual(len(arts), 3)

    def test_pending_candidate_with_a_small_jacket_goes_back_to_the_worker(self):
        id_ = self.t.new('SSIS-006')
        self.t.open.side_effect = [Response({**movie(), 'normalized_id': 'SSIS-006'}), Response(png(), 'image/png'), Response(wiki())]
        self.assertTrue(self.t.worker.process_one())
        self.hires('SSIS-006', 'ssis00006', (1600, 1076))
        self.assertEqual(self.run_backfill(False, candidates=True)[0]['counts'], {'would_requeue': 1})
        self.assertEqual(self.t.row(id_)['status'], 'found')
        self.assertEqual(self.run_backfill(True, candidates=True)[0]['counts'], {'requeued': 1})
        row = self.t.row(id_)
        self.assertEqual((row['status'], row['candidate'], row['generation']), ('queued', None, 1))
        # The worker's next pass takes the wide jacket through the ordinary lookup path.
        self.t.open.side_effect = [Response({**movie(), 'normalized_id': 'SSIS-006',
                                             'sample_image_urls': ['https://pics.dmm.co.jp/digital/video/ssis00006/ssis00006jp-1.jpg']}),
                                   Response(png((1600, 1076)), 'image/png'), Response(wiki())]
        self.assertTrue(self.t.worker.process_one())
        candidate = json.loads(self.t.row(id_)['candidate'])
        self.assertEqual((candidate['jacketWidth'], candidate['defaultSplit']['x1']), (1600, 756))

    # -- front-only covers and borrowed spines ----------------------------------------
    PS = 'https://pics.dmm.co.jp/mono/movie/adult/77midv032/77midv032ps.jpg'
    MONO = 'https://pics.dmm.co.jp/mono/movie/adult/k9snos130/k9snos130pl.jpg'

    def sha_of(self, url):
        return hashlib.sha256(self.cdn[url][0]).hexdigest()

    def surface_arts(self, work):
        selected, arts, _ = self.selection(work)
        return {surface: arts[selected[slot]] for slot, surface in (('work', 'front'), ('spine', 'spine'), ('back', 'back'))
                if selected.get(slot)}

    def test_front_only_cover_becomes_a_wrap_with_back_and_spine(self):
        pl = self.PS.replace('ps.jpg', 'pl.jpg')
        self.old_work('w10', 'MIDV-032', size=(147, 200))
        self.record('MIDV-032', self.PS)
        self.image(self.PS, (147, 200))
        self.image(pl, (800, 538))
        before = self.selection('w10')
        self.assertEqual({k for k, v in before[0].items() if v}, {'work'})

        summary, lines = self.run_backfill(apply=False)
        self.assertEqual(summary['counts'], {'would_wrap': 1})
        self.assertEqual((lines[0]['scope'], lines[0]['newSplit'], lines[0]['surfaces'], lines[0]['source']),
                         ('work-wrap', [378, 422], ['front', 'back', 'spine'], pl))
        self.assertEqual(self.selection('w10')[0], before[0])

        summary, lines = self.run_backfill(apply=True)
        self.assertEqual(summary['counts'], {'done': 1})
        sha = self.sha_of(pl)
        new = self.surface_arts('w10')
        self.assertEqual({k: (v['width'], v['height']) for k, v in new.items()},
                         {'front': (378, 538), 'spine': (44, 538), 'back': (378, 538)})
        for surface, art in new.items():
            self.assertEqual(art['provider_image_id'], f'MIDV-032:{sha}:378:422:{surface}')
        self.assertIn(before[0]['work'], self.selection('w10')[1])  # the old front-only artwork stays, unselected
        self.assertNotIn(before[0]['work'], self.selection('w10')[0].values())
        self.assertFalse(fake_s3.deleted)

        cursor = self.selection('w10')[2]
        self.fetched.clear()
        summary, _ = self.run_backfill(apply=True)
        self.assertEqual((self.fetched, self.selection('w10')[2]), ([], cursor))

    def test_front_only_cover_without_a_wrap_is_asked_once(self):
        self.old_work('w11', 'MIDV-033', size=(147, 200))
        self.record('MIDV-033', self.PS.replace('midv032', 'midv033'))
        self.image(self.PS.replace('midv032', 'midv033'), (147, 200))
        before = self.selection('w11')
        summary, lines = self.run_backfill(apply=True)
        self.assertEqual((summary['counts'], lines[0]['reason']), ({'no_wrap': 1}, 'noWrap'))
        self.assertEqual(self.selection('w11'), before)
        self.fetched.clear()
        self.assertEqual(self.run_backfill(apply=True)[0]['counts'], {'skip_recorded_no_wrap': 1})
        self.assertEqual(self.fetched, [])

    def test_front_only_cover_takes_the_wide_jacket_and_its_borrowed_spine(self):
        hires = av.HIRES_URL.format(cid='snos00130')
        self.old_work('w12', 'SNOS-130', size=(147, 200))
        self.record('SNOS-130', self.MONO, 'snos00130')
        self.image(hires, (2184, 1638))
        self.image(self.MONO, (800, 438))
        summary, lines = self.run_backfill(apply=True)
        self.assertEqual(summary['counts'], {'done': 1})
        sha = self.sha_of(hires)
        new = self.surface_arts('w12')
        self.assertEqual({k: (v['width'], v['height']) for k, v in new.items()},
                         {'front': (1092, 1638), 'spine': (135, 1638), 'back': (1092, 1638)})
        self.assertEqual(new['spine']['provider_image_id'], f'SNOS-130:{sha}:1092:1092:spine')
        self.assertEqual(lines[0]['spineFrom'], self.MONO)

    def test_wide_jacket_without_a_spine_gets_the_dvd_spine_and_nothing_else_changes(self):
        hires = av.HIRES_URL.format(cid='snos00130')
        id_ = self.lookup('SNOS-130', self.MONO, {hires: (2184, 1638)}, 'snos00130')  # no DVD wrap anywhere yet
        self.assertNotIn('spineSource', json.loads(self.t.row(id_)['candidate']))
        self.confirm(id_, 'w13', 'SNOS-130', ['front', 'back'])
        before = self.selection('w13')

        summary, lines = self.run_backfill(apply=True)  # nothing to borrow: asked once, remembered
        self.assertEqual((summary['counts'], lines[0]['reason']), ({'no_spine_source': 1}, 'noSpineSource'))
        self.fetched.clear()
        self.assertEqual(self.run_backfill(apply=True)[0]['counts'], {'skip_recorded_no_spine_source': 1})
        self.assertEqual(self.fetched, [])

        self.image(self.MONO, (800, 438))
        summary, lines = self.run_backfill(apply=False, retry=True)
        self.assertEqual(summary['counts'], {'would_borrow_spine': 1})
        self.assertEqual((lines[0]['scope'], lines[0]['spineBox'], lines[0]['spineSize'], lines[0]['surfaces']),
                         ('work-spine', [382, 418], [135, 1638], ['spine']))
        self.assertEqual(self.selection('w13')[0], before[0])

        summary, _ = self.run_backfill(apply=True, retry=True)
        self.assertEqual(summary['counts'], {'done': 1})
        selected, arts, cursor = self.selection('w13')
        self.assertEqual({s: selected[s] for s in ('work', 'back')}, {s: before[0][s] for s in ('work', 'back')})
        sha = arts[selected['work']]['provider_image_id'].split(':')[1]
        spine = arts[selected['spine']]
        self.assertEqual((spine['width'], spine['height'], spine['provider_image_id']),
                         (135, 1638, f'SNOS-130:{sha}:1092:1092:spine'))
        self.assertEqual(len(arts), 3)

        self.fetched.clear()
        summary, _ = self.run_backfill(apply=True, retry=True)
        self.assertEqual((summary['counts'], self.fetched, self.selection('w13')[2]), ({'skip_already_large': 1}, [], cursor))

    def test_dry_run_lists_every_kind_of_change_and_writes_nothing(self):
        hires = av.HIRES_URL.format(cid='snos00130')
        self.old_work('w20', 'SSIS-001')
        self.hires('SSIS-001', 'ssis00001', (1600, 1076))
        self.old_work('w21', 'MIDV-032', size=(147, 200))
        self.record('MIDV-032', self.PS)
        self.image(self.PS, (147, 200))
        self.image(self.PS.replace('ps.jpg', 'pl.jpg'), (800, 538))
        id_ = self.lookup('SNOS-130', self.MONO, {hires: (2184, 1638)}, 'snos00130')
        self.confirm(id_, 'w22', 'SNOS-130', ['front', 'back'])
        self.image(self.MONO, (800, 438))
        before = {w: self.selection(w) for w in ('w20', 'w21', 'w22')}

        summary, lines = self.run_backfill(apply=False)
        self.assertEqual(summary['counts'], {'would_swap': 1, 'would_wrap': 1, 'would_borrow_spine': 1})
        self.assertEqual({line['id'] for line in lines}, {'w20', 'w21', 'w22'})
        self.assertEqual({w: self.selection(w) for w in before}, before)
        with self.get_db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM av_jacket_backfill').fetchone()[0], 0)

        self.assertEqual(self.run_backfill(apply=True)[0]['counts'], {'done': 3})
        self.fetched.clear()
        self.run_backfill(apply=True)
        self.assertEqual(self.fetched, [])

    def test_pending_candidates_the_new_rules_improve_go_back_to_the_worker(self):
        ps = self.PS.replace('midv032', 'midv040')
        pl = 'https://pics.dmm.co.jp/mono/movie/adult/77midv041/77midv041pl.jpg'
        stuck = self.lookup('MIDV-040', ps, {ps: (147, 200)})
        fine = self.lookup('MIDV-041', pl, {pl: (800, 538)})
        # A front-only candidate whose wrap exists now goes back to the worker; one nothing can improve stays.
        self.image(ps.replace('ps.jpg', 'pl.jpg'), (800, 538))
        summary, _ = self.run_backfill(False, candidates=True)
        self.assertEqual(summary['counts'], {'would_requeue': 1, 'unchanged': 1})
        self.assertEqual((self.t.row(stuck)['status'], self.t.row(fine)['status']), ('found', 'found'))
        summary, _ = self.run_backfill(True, candidates=True)
        self.assertEqual(summary['counts'], {'requeued': 1, 'unchanged': 1})
        self.assertEqual((self.t.row(stuck)['status'], self.t.row(fine)['status']), ('queued', 'found'))
        self.fetched.clear()
        self.assertEqual(self.run_backfill(True, candidates=True)[0]['counts'], {'skip_recorded_unchanged': 1})
        self.assertEqual(self.fetched, [])
