"""Operator-only backfill: replace 800 px AV jackets with the full digital-CDN wrap jacket.

Dry-run is the default and writes nothing (the database is opened read-only); ``--apply``
writes. For every live AV work whose selected LibreDMM crops came from a jacket at most
800 px wide it looks up the high-resolution jacket exactly like a new lookup does
(``av_inbox.hires_addresses`` / ``fetch_hires``). When one exists with the same aspect
ratio, the stored split lines are scaled, the same surfaces are re-cropped, and the new
artwork is added and selected through the ordinary Collections authority commands, so the
change feed carries it to the PC and the tablet. The old artwork rows and every old blob
stay; only the selection moves. A different aspect ratio is left untouched and listed
for a manual re-split. Pending inbox candidates (status ``found``) with a small jacket
are re-queued so the worker fetches them again with the new jacket logic.

Results are kept in ``av_jacket_backfill`` so a rerun skips finished and hopeless items.
Every remote fetch is spaced by ``--delay`` seconds (LibreDMM at least 2 s).
"""
import argparse
from collections import Counter
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import json
import re
import signal
import sqlite3
import time
import uuid
from pathlib import Path

from fastapi import HTTPException

import authority
import av_inbox as av
import collection_authority as ca
import work_providers as wp

NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, 'https://lakomics.invalid/serverAvJacketBackfill')
IMAGE_ID = re.compile(r'([^:]+):([0-9a-f]{64}):([0-9]+):([0-9]+):(front|spine|back)')
SLOT = dict(front='work', spine='spine', back='back')
KIND = dict(front='cover', spine='spine', back='back')
OLD_MAX_WIDTH = 800
ASPECT_TOLERANCE = 0.015
LIBREDMM_MIN_DELAY = 2.0
DDL = """CREATE TABLE IF NOT EXISTS av_jacket_backfill (
 scope TEXT NOT NULL, ref_id TEXT NOT NULL, old_sha TEXT NOT NULL, state TEXT NOT NULL,
 new_sha TEXT, detail TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(scope, ref_id, old_sha))"""
#: Finished or hopeless; a rerun skips them unless ``--retry``. error/conflict are always retried.
TERMINAL = ('done', 'aspect_mismatch', 'no_hires')


class Skip(Exception):
    pass


def scale_split(old_width, x1, x2, new_width):
    """The split lines of an old jacket mapped onto a jacket of the same shape and a new width."""
    if x1 == 0 and x2 == 0:
        return 0, 0
    def at(x):
        return min(new_width, (x * new_width * 2 + old_width) // (2 * old_width))
    return at(x1), max(at(x1), at(x2))


def same_aspect(old_width, old_height, new_width, new_height):
    old = old_width / old_height
    return abs(new_width / new_height - old) <= ASPECT_TOLERANCE * old


def jacket_groups(db, library_id):
    """Live AV works' LibreDMM crops grouped by the jacket and split they came from."""
    works = {r['work_id']: json.loads(r['selection']) for r in db.execute(
        "SELECT work_id,selection FROM collection_authority_works WHERE library_id=? AND type='av' AND lifecycle='live'",
        (library_id,))}
    groups = {}
    for art in db.execute("SELECT artwork_id,work_id,kind,provider_image_id,width,height FROM collection_authority_artworks "
                          "WHERE library_id=? AND provider='libredmm' ORDER BY work_id,artwork_id", (library_id,)):
        match = IMAGE_ID.fullmatch(art['provider_image_id'] or '')
        if art['work_id'] not in works or match is None or KIND[match[5]] != art['kind']:
            continue
        key = (art['work_id'], match[2], int(match[3]), int(match[4]))
        group = groups.setdefault(key, dict(workId=art['work_id'], code=match[1], sha=match[2], x1=key[2], x2=key[3],
                                            arts={}, selection=works[art['work_id']]))
        group['arts'].setdefault(match[5], dict(art))
    return list(groups.values())


def selected_surfaces(group):
    return [s for s in ('front', 'spine', 'back')
            if s in group['arts'] and group['selection'].get(SLOT[s]) == group['arts'][s]['artwork_id']]


def old_dimensions(group):
    """(width, height) of the jacket the crops came from, or None when the crops cannot say."""
    arts, x1, x2 = group['arts'], group['x1'], group['x2']
    front = arts.get('front')
    if front is None:
        return None
    wrap = not (x1 == 0 and x2 == 0)
    if (arts.get('spine') and arts['spine']['width'] != x2 - x1) or (arts.get('back') and arts['back']['width'] != x1):
        return None
    return front['width'] + (x2 if wrap else 0), front['height']


def surface_boxes(width, height, x1, x2):
    wrap = not (x1 == 0 and x2 == 0)
    return dict(front=(x2, 0, width, height) if wrap else (0, 0, width, height),
                spine=(x1, 0, x2, height), back=(0, 0, x1, height))


class Backfill:
    def __init__(self, get_db, storage, bucket, *, apply=False, delay=1.0, retry=False,
                 sleep=time.sleep, log=lambda line: print(line, flush=True), stop=lambda: False):
        self.get_db, self.storage, self.bucket = get_db, storage, bucket
        self.apply, self.delay, self.retry, self.sleep, self.log, self.stop = apply, delay, retry, sleep, log, stop
        self.next_at = {}
        self.counts = Counter()
        self.bytes = 0
        self.remote = 0
        self.manual = []

    # -- bookkeeping -------------------------------------------------------------------
    def previous(self, scope, ref_id, old_sha):
        with self.get_db() as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='av_jacket_backfill'").fetchone() is None:
                return None
            row = db.execute('SELECT state FROM av_jacket_backfill WHERE scope=? AND ref_id=? AND old_sha=?',
                             (scope, ref_id, old_sha)).fetchone()
        return None if row is None else row[0]

    def record(self, scope, ref_id, old_sha, state, new_sha=None, detail=None):
        if self.apply:
            with self.get_db() as db:
                db.execute('INSERT OR REPLACE INTO av_jacket_backfill VALUES(?,?,?,?,?,?,?)',
                           (scope, ref_id, old_sha, state, new_sha, None if detail is None else json.dumps(detail),
                            datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')))
                db.commit()

    def result(self, scope, ref_id, code, state, **info):
        self.counts[state] += 1
        self.log(json.dumps(dict(scope=scope, id=ref_id, code=code, state=state, **info), ensure_ascii=False))

    # -- remote ------------------------------------------------------------------------
    def pace(self, kind, minimum):
        wait = self.next_at.get(kind, 0) - time.monotonic()
        if wait > 0:
            self.sleep(wait)
        self.next_at[kind] = time.monotonic() + max(minimum, self.delay)

    def find_hires(self, code):
        """(jacket, reason): the high-resolution jacket tuple from av_inbox.fetch_hires, or why none."""
        self.pace('libredmm', LIBREDMM_MIN_DELAY)
        self.remote += 1
        try:
            data, _ = wp.outbound('https://www.libredmm.com/movies/' + code + '.json', deadline=time.monotonic() + 25,
                                  limit=av.MAX_JSON, headers={'User-Agent': 'Lakomics/0.2'})
            raw = json.loads(data)
        except wp.UpstreamStatus as exc:
            if exc.status == 404:
                return None, 'libredmmNotFound'
            raise
        if not isinstance(raw, dict) or av.normalize_code(raw.get('normalized_id')) != code:
            return None, 'libredmmMismatch'
        addresses = av.hires_addresses(code, raw)
        if not addresses:
            return None, 'noDigitalCid'
        jacket = av.fetch_hires(addresses, time.monotonic() + 40, lambda: self.pace('dmm', 0.5))
        return jacket, None if jacket else 'noHiresOnCdn'

    # -- one work's jacket -------------------------------------------------------------
    def work_group(self, domain, group):
        work, code, sha = group['workId'], group['code'], group['sha']
        selected = selected_surfaces(group)
        dims = old_dimensions(group)
        if not selected or av.normalize_code(code) != code:
            return self.counts.update(['skip_not_selected'])
        if dims is None:
            return self.result('work', work, code, 'skip_unknown_size')
        old_w, old_h = dims
        if old_w > OLD_MAX_WIDTH:
            return self.counts.update(['skip_already_large'])
        prior = self.previous('work', work, sha)
        if prior in TERMINAL and not self.retry:
            return self.counts.update(['skip_recorded_' + prior])
        jacket, why = self.find_hires(code)
        if jacket is None:
            self.record('work', work, sha, 'no_hires', detail=why)
            return self.result('work', work, code, 'no_hires', reason=why)
        data, mime, new_w, new_h = jacket
        if not same_aspect(old_w, old_h, new_w, new_h):
            info = dict(old=[old_w, old_h], new=[new_w, new_h])
            self.record('work', work, sha, 'aspect_mismatch', detail=info)
            self.manual.append(dict(workId=work, code=code, **info))
            return self.result('work', work, code, 'aspect_mismatch', **info)
        nx1, nx2 = scale_split(old_w, group['x1'], group['x2'], new_w)
        frame = av.decode_jacket(data, mime)
        try:
            boxes = surface_boxes(new_w, new_h, nx1, nx2)
            rendered = {s: av.render_surface(frame, boxes[s]) for s in selected}
        finally:
            frame.close()
        size = len(data) + sum(len(r['encoded']) for r in rendered.values())
        info = dict(old=[old_w, old_h], new=[new_w, new_h], oldSplit=[group['x1'], group['x2']], newSplit=[nx1, nx2],
                    surfaces=selected, bytes=size)
        if not self.apply:
            self.bytes += size
            return self.result('work', work, code, 'would_swap', **info)
        deadline = time.monotonic() + 120
        jacket_receipt = av.confirm_blobs(self.get_db, self.storage, self.bucket, [(data, mime)], deadline)[0]
        prepared = {}
        for surface, item in rendered.items():
            receipts = av.store_surface(self.get_db, self.storage, self.bucket, item, deadline)
            prepared[surface] = dict(original=receipts[0], thumbnail=receipts[1] if len(receipts) > 1 else None,
                                     width=item['width'], height=item['height'])
        try:
            outcome = self.swap(domain, group, jacket_receipt['sha256'], nx1, nx2, prepared)
        except Skip as exc:
            self.record('work', work, sha, 'conflict', detail=str(exc))
            return self.result('work', work, code, 'conflict', reason=str(exc))
        except HTTPException as exc:
            reason = exc.detail.get('code') if isinstance(exc.detail, dict) else str(exc.detail)
            self.record('work', work, sha, 'conflict', detail=reason)
            return self.result('work', work, code, 'conflict', reason=reason)
        self.bytes += size
        self.record('work', work, sha, 'done', jacket_receipt['sha256'], info)
        self.result('work', work, code, outcome, newSha=jacket_receipt['sha256'], **info)

    def swap(self, domain, group, new_sha, nx1, nx2, prepared):
        """Add the new crops and move the selection to them in one authority batch."""
        library, epoch, work, code = domain['libraryId'], domain['epoch'], group['workId'], group['code']
        batch = str(uuid.uuid5(NAMESPACE, f"{work}:{group['sha']}:{new_sha}:{nx1}:{nx2}"))
        with self.get_db() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                live = authority.active_domain(db, ca.DOMAIN)
                row = ca.work_row(db, library, work)
                if live is None or live['libraryId'] != library or live['epoch'] != epoch:
                    raise Skip('authorityChanged')
                if row is None or row['lifecycle'] != 'live':
                    raise Skip('workUnavailable')
                selection = json.loads(row['selection'])
                adds, selects, finished = [], [], 0

                def command(command_type, key, **fields):
                    return dict(libraryId=library, epoch=epoch, contractVersion=ca.CONTRACT_VERSION,
                                operationId=str(uuid.uuid5(uuid.UUID(batch), f'{command_type}:{key}')), commandType=command_type,
                                workId=work, **fields)
                for surface, item in prepared.items():
                    old = group['arts'][surface]
                    image_id = f'{code}:{new_sha}:{nx1}:{nx2}:{surface}'
                    existing = db.execute("SELECT artwork_id FROM collection_authority_artworks WHERE library_id=? AND work_id=? "
                                          "AND provider='libredmm' AND provider_image_id=? AND kind=? ORDER BY artwork_id LIMIT 1",
                                          (library, work, image_id, KIND[surface])).fetchone()
                    art_id = existing[0] if existing else str(uuid.uuid5(NAMESPACE, f'{work}:{image_id}'))
                    if selection.get(SLOT[surface]) == art_id:
                        finished += 1
                        continue
                    if selection.get(SLOT[surface]) != old['artwork_id']:
                        raise Skip('selectionChanged')
                    if existing is None:
                        adds.append(command(ca.ADD_ARTWORK, surface, artworkId=art_id, kind=KIND[surface],
                                            provider='libredmm', providerImageId=image_id, language='ja', **item))
                    selects.append(command(ca.SELECT_ARTWORK, surface, slot=SLOT[surface], artworkId=art_id,
                                           expectedArtworkId=old['artwork_id']))
                if finished == len(prepared):
                    db.rollback()
                    return 'already_done'
                ca.apply_command_batch(db, library_id=library, epoch=epoch, operation_id=batch, request_payload=dict(
                    origin='serverAvJacketBackfill', workId=work, oldSha=group['sha'], newSha=new_sha, x1=nx1, x2=nx2),
                    commands=adds + selects, now=datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
                db.commit()
            except BaseException:
                db.rollback()
                raise
        return 'done'

    # -- one pending inbox candidate ---------------------------------------------------
    def candidate(self, row):
        candidate = json.loads(row['candidate'])
        old_w, sha, code = candidate['jacketWidth'], candidate['jacket']['sha256'], row['normalized_code']
        id_ = row['request_id']
        if old_w > OLD_MAX_WIDTH or av.normalize_code(code) != code:
            return self.counts.update(['skip_candidate_large'])
        prior = self.previous('inbox', id_, sha)
        if prior in TERMINAL and not self.retry:
            return self.counts.update(['skip_recorded_' + prior])
        jacket, why = self.find_hires(code)
        if jacket is None:
            self.record('inbox', id_, sha, 'no_hires', detail=why)
            return self.result('inbox', id_, code, 'no_hires', reason=why)
        info = dict(old=[old_w, candidate['jacketHeight']], new=list(jacket[2:]), bytes=len(jacket[0]))
        if not self.apply:
            return self.result('inbox', id_, code, 'would_requeue', **info)
        with self.get_db() as db:
            # Back to the worker's queue, exactly like the "retry" action: the stale 800 px
            # candidate is not usable meanwhile, so a split drawn on it cannot be misapplied.
            changed = db.execute("UPDATE av_inbox SET status='queued',attempts=0,last_error=NULL,fetched_at=NULL,"
                                 "started_at=NULL,next_attempt_at=0,generation=generation+1,candidate=NULL "
                                 "WHERE request_id=? AND generation=? AND status='found'",
                                 (id_, row['generation'])).rowcount
            db.commit()
        if changed != 1:
            self.record('inbox', id_, sha, 'conflict', detail='candidateChanged')
            return self.result('inbox', id_, code, 'conflict', reason='candidateChanged')
        self.record('inbox', id_, sha, 'done', detail=info)
        self.result('inbox', id_, code, 'requeued', **info)

    # -- driver ------------------------------------------------------------------------
    def run(self, *, limit=None, candidates=True, deadline=None):
        with self.get_db() as db:
            domain = authority.active_domain(db, ca.DOMAIN)
            if domain is None:
                raise ValueError('The Collections authority is not active on this database')
            groups = jacket_groups(db, domain['libraryId'])
            pending = db.execute("SELECT request_id,normalized_code,candidate,generation FROM av_inbox "
                                 "WHERE status='found' AND candidate IS NOT NULL ORDER BY request_id").fetchall() if candidates else []
        def halted():
            return self.stop() or (limit is not None and self.remote >= limit) or (deadline is not None and time.monotonic() >= deadline)
        for kind, items, handler in (('work', groups, lambda g: self.work_group(domain, g)),
                                     ('inbox', pending, self.candidate)):
            for item in items:
                if halted():
                    self.counts['stopped_early'] += 1
                    break
                try:
                    handler(item)
                except Exception as exc:
                    ref = item['workId'] if kind == 'work' else item['request_id']
                    code = item['code'] if kind == 'work' else item['normalized_code']
                    sha = item['sha'] if kind == 'work' else json.loads(item['candidate'])['jacket']['sha256']
                    reason = exc.detail.get('code') if isinstance(exc, HTTPException) and isinstance(exc.detail, dict) else type(exc).__name__
                    self.record(kind, ref, sha, 'error', detail=reason)
                    self.result(kind, ref, code, 'error', reason=reason)
        return dict(mode='apply' if self.apply else 'dry-run', counts=dict(self.counts), remoteFetches=self.remote,
                    newBytes=self.bytes, manualResplit=self.manual)


def connect(path, readonly):
    db = sqlite3.connect(Path(path).resolve().as_uri() + ('?mode=ro' if readonly else '?mode=rw'), uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    return db


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--database', default=str(Path(__file__).resolve().parent / 'data' / 'lakomics.sqlite3'))
    parser.add_argument('--apply', action='store_true', help='write; the default is a read-only dry run')
    parser.add_argument('--limit', type=int, help='stop after this many remote item lookups')
    parser.add_argument('--delay', type=float, default=1.0, help='seconds between remote fetches (LibreDMM at least 2)')
    parser.add_argument('--retry', action='store_true', help='look again at items recorded as having no high-resolution jacket')
    parser.add_argument('--no-candidates', action='store_true', help='skip pending inbox candidates')
    parser.add_argument('--max-seconds', type=float, default=14400)
    args = parser.parse_args(argv)
    if args.delay < 0.5 or args.max_seconds <= 0 or (args.limit is not None and args.limit < 1):
        parser.error('Use --delay of at least 0.5, a positive --limit and a positive --max-seconds')
    stopped = False
    def on_term(signum, frame):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    storage = bucket = None
    if args.apply:
        import r2
        storage, bucket = (lambda: r2._s3), (lambda: r2.R2_BUCKET)
        with closing(connect(args.database, False)) as db:
            db.execute(DDL)
            db.commit()

    @contextmanager
    def get_db():
        db = connect(args.database, not args.apply)
        try:
            yield db
        finally:
            db.close()
    summary = Backfill(get_db, storage, bucket, apply=args.apply, delay=args.delay, retry=args.retry,
                       stop=lambda: stopped).run(limit=args.limit, candidates=not args.no_candidates,
                                                 deadline=time.monotonic() + args.max_seconds)
    print(json.dumps(dict(summary=summary), ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
