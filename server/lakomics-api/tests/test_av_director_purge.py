"""AV director purge: dry run counts, the authority removal, performers kept, rerun quiet."""
import json
import unittest

from tests import test_av_inbox as base
from tests import test_collection_authority as fixtures
import authority
import av_director_purge as purge
import collection_authority as ca


def person(id_, name):
    return dict(personId=id_, displayName=name, nameJa=name + 'JA')


def credit(id_, role, order, alias=None):
    return dict(personId=id_, role=role, order=order, creditName=alias)


class DirectorPurgeTests(unittest.TestCase):
    def setUp(self):
        self.t = base.AvInboxTests('fetch')
        self.t.setUp()
        self.addCleanup(self.t.doCleanups)
        self.get_db = self.t.get_db
        t = self.t
        t.create_av('w1', 'AAA-001')
        t.create_av('w2', 'AAA-002')
        t.create_av('clean', 'AAA-003')
        t.create_av('trashed', 'AAA-004')
        # w1: two performers, one performer-and-director, one director only; w2: a director only (shared) + a text director.
        t.command('setAvCredits', workId='w1', expectedRevision=2, people=[person('p1', 'P1'), person('p2', 'P2'), person('d1', 'D1')],
                  credits=[credit('p1', 'performer', 0, 'alias'), credit('p2', 'performer', 1), credit('p2', 'director', 0),
                           credit('d1', 'director', 1)])
        t.command('setAvCredits', workId='w2', expectedRevision=2, people=[], credits=[credit('d1', 'director', 0)])
        t.command('setAvCredits', workId='clean', expectedRevision=2, people=[], credits=[credit('p1', 'performer', 0)])
        t.command('setAvCredits', workId='trashed', expectedRevision=2, people=[person('d3', 'D3')], credits=[credit('d3', 'director', 0)])
        t.command('updateWork', workId='w2', changes=dict(director='監督'), expected=dict(director=None), expectedRevision=None)
        t.command('deleteWork', workId='trashed', expectedRevision=3)

    def run_purge(self, apply):
        return purge.run(self.get_db, apply, log=lambda line: None)

    def snapshot(self):
        with self.get_db() as db:
            works = {r['work_id']: (r['entity_revision'], json.loads(r['av_credits']), json.loads(r['fields']).get('director'))
                     for r in db.execute('SELECT * FROM collection_authority_works')}
            people = {r['person_id'] for r in db.execute('SELECT person_id FROM collection_authority_people')}
            cursor = authority.active_domain(db, ca.DOMAIN)['cursor']
        return works, people, cursor

    def test_dry_run_counts_and_writes_nothing(self):
        before = self.snapshot()
        summary = self.run_purge(False)
        self.assertEqual(summary['mode'], 'dry-run')
        self.assertEqual(summary['before'], dict(liveWorksWithDirectorCredits=2, directorCredits=3, liveWorksWithDirectorText=1,
                                                 trashedWorksWithDirectors=1, directorOnlyPeople=1, alreadyCleanLiveWorks=1))
        self.assertEqual(summary['worksToClean'], 2)
        self.assertEqual(self.snapshot(), before)

    def test_apply_removes_directors_keeps_performers_and_rerun_is_quiet(self):
        before = self.snapshot()
        summary = self.run_purge(True)
        self.assertEqual(summary['outcomes'], {'setAvCredits': 1, 'setAvCredits+updateWork': 1})
        works, people, cursor = self.snapshot()
        self.assertGreater(cursor, before[2])
        w1 = works['w1'][1]
        self.assertEqual([(c['personId'], c['role'], c['order'], c['creditName']) for c in w1],
                         [('p1', 'performer', 0, 'alias'), ('p2', 'performer', 1, None)])
        self.assertEqual(works['w2'][1:], ([], None))
        self.assertEqual(works['clean'], before[0]['clean'])
        # The trashed work is untouched and still counted; people records are kept.
        self.assertEqual(works['trashed'], before[0]['trashed'])
        self.assertEqual(people, before[1])
        self.assertIn('d1', people)
        for work in ('w1', 'w2'):
            self.assertEqual(works[work][0], before[0][work][0] + (2 if work == 'w2' else 1))
        with self.get_db() as db:
            projected = ca.work_projection(db, fixtures.LIBRARY, 'w1')
        self.assertEqual({c['role'] for c in projected['avCredits']}, {'performer'})
        self.assertEqual({p['personId'] for p in projected['avPeople']}, {'p1', 'p2'})
        self.assertEqual(summary['after'], dict(liveWorksWithDirectorCredits=0, directorCredits=0, liveWorksWithDirectorText=0,
                                                trashedWorksWithDirectors=1, directorOnlyPeople=0, alreadyCleanLiveWorks=3))
        after = self.snapshot()
        again = self.run_purge(True)
        self.assertEqual((again['worksToClean'], again['outcomes']), (0, {}))
        self.assertEqual(self.snapshot(), after)


if __name__ == '__main__':
    unittest.main()
