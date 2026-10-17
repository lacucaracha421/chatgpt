"""Operator-only: remove every AV director that is already registered.

Dry-run is the default: the database is opened read-only and only counts are printed.
``--apply`` writes, through the ordinary Collections authority commands (the same ones the PC
and the tablet issue), one transaction per work:

* ``setAvCredits`` replaces the work's credit list with its performer credits only (performers,
  their order, credit names and portrait crops are kept), guarded by the work's entity revision;
* ``updateWork`` clears a non-empty plain-text ``director`` field on the AV work (field-level CAS).

Each command bumps the work's entity revision and appends a change, so the projection, the
publication revision and the change feed move exactly as for a user's edit and every PC and
tablet converges on its next sync. Works that are already clean are skipped, so the script is
safe to rerun.

Person records are never deleted: the authority has no person-delete command, the PC and the
tablet remember a person once the server confirmed it (a hand-deleted row would make a later
``setAvCredits`` that re-uses the person fail), and a person without credits is not part of any
work's feed. A person who only ever had director credits therefore stays as an unreferenced
record (memo, favourite and portrait kept); only the PC's "add a person" search can show it.

Trashed works are skipped (a trashed work accepts no edits) and counted; run it again after
restoring one. Run on the server from the API directory: ``python3 av_director_purge.py``.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import sqlite3
import uuid
from pathlib import Path

import authority
import collection_authority as ca

NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, 'https://lakomics.invalid/serverAvDirectorPurge')


def connect(path, readonly):
    db = sqlite3.connect(Path(path).resolve().as_uri() + ('?mode=ro' if readonly else '?mode=rw'), uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    return db


def text_director(row):
    """The plain-text director of an AV work, or None when it is empty."""
    value = json.loads(row['fields']).get('director')
    return value if isinstance(value, str) and value.strip() else None


def inspect(db, library_id):
    """Counts of what the purge would touch (read-only)."""
    counts = dict(liveWorksWithDirectorCredits=0, directorCredits=0, liveWorksWithDirectorText=0,
                  trashedWorksWithDirectors=0, directorOnlyPeople=0, alreadyCleanLiveWorks=0)
    director_people, kept_people = set(), set()
    for row in db.execute("SELECT work_id,lifecycle,fields,av_credits FROM collection_authority_works "
                          "WHERE library_id=? AND type='av' AND lifecycle IN ('live','trashed') ORDER BY work_id",
                          (library_id,)):
        credits = json.loads(row['av_credits'])
        directors = [c for c in credits if c['role'] == 'director']
        text = text_director(row)
        kept_people.update(c['personId'] for c in credits if c['role'] != 'director')
        director_people.update(c['personId'] for c in directors)
        if row['lifecycle'] == 'trashed':
            counts['trashedWorksWithDirectors'] += bool(directors or text)
            # A trashed work keeps its directors until it is cleaned, so they still reference the person.
            kept_people.update(c['personId'] for c in directors)
            continue
        counts['directorCredits'] += len(directors)
        counts['liveWorksWithDirectorCredits'] += bool(directors)
        counts['liveWorksWithDirectorText'] += text is not None
        counts['alreadyCleanLiveWorks'] += not directors and text is None
    # People left with no credit anywhere after the purge: kept as unreferenced records.
    counts['directorOnlyPeople'] = len(director_people - kept_people)
    return counts


def targets(db, library_id):
    return [r['work_id'] for r in db.execute(
        "SELECT work_id,fields,av_credits FROM collection_authority_works "
        "WHERE library_id=? AND type='av' AND lifecycle='live' ORDER BY work_id", (library_id,))
        if any(c['role'] == 'director' for c in json.loads(r['av_credits'])) or text_director(r) is not None]


def purge_work(get_db, domain, work_id):
    """Remove one work's directors in one transaction; returns what changed."""
    library, epoch = domain['libraryId'], domain['epoch']
    with get_db() as db:
        db.execute('BEGIN IMMEDIATE')
        try:
            live = authority.active_domain(db, ca.DOMAIN)
            row = ca.work_row(db, library, work_id)
            if live is None or live['libraryId'] != library or live['epoch'] != epoch:
                db.rollback()
                return 'authorityChanged'
            if row is None or row['lifecycle'] != 'live' or row['type'] != 'av':
                db.rollback()
                return 'workUnavailable'
            credits = json.loads(row['av_credits'])
            done = []
            now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

            def run(command_type, key, **fields):
                body = dict(libraryId=library, epoch=epoch, contractVersion=ca.CONTRACT_VERSION,
                            operationId=str(uuid.uuid5(NAMESPACE, f'{work_id}:{command_type}:{key}')),
                            commandType=command_type, workId=work_id, **fields)
                lib, command_epoch, version, operation, kind, entity = ca.parse_command(body)
                ca.apply_command(db, library_id=lib, epoch=command_epoch, contract_version=version, command_type=kind,
                                 operation_id=operation, entity=entity, now=now)
                done.append(command_type)

            if any(c['role'] == 'director' for c in credits):
                kept = [dict(personId=c['personId'], role=c['role'], order=c['order'], creditName=c.get('creditName'))
                        for c in credits if c['role'] != 'director']
                # Normally every person already exists; a missing record is re-supplied from its credit.
                present = {r[0] for r in db.execute("SELECT person_id FROM collection_authority_people WHERE library_id=?",
                                                    (library,))}
                people = [dict(personId=c['personId'], displayName=c['name'], nameJa=c.get('nameJa'))
                          for c in credits if c['role'] != 'director' and c['personId'] not in present]
                run(ca.AV_CREDITS, row['entity_revision'], credits=kept, people=people,
                    expectedRevision=row['entity_revision'])
            old = text_director(row)
            if old is not None:
                digest = hashlib.sha256(old.encode()).hexdigest()
                run(ca.UPDATE, digest, changes=dict(director=None), expected=dict(director=json.loads(row['fields'])['director']),
                    expectedRevision=None)
            db.commit()
            return '+'.join(done) or 'unchanged'
        except BaseException:
            db.rollback()
            raise


def run(get_db, apply, log=print):
    with get_db() as db:
        domain = authority.active_domain(db, ca.DOMAIN)
        if domain is None:
            raise ValueError('The Collections authority is not active on this database')
        before = inspect(db, domain['libraryId'])
        works = targets(db, domain['libraryId'])
    outcomes = {}
    if apply:
        for work_id in works:
            try:
                outcome = purge_work(get_db, domain, work_id)
            except Exception as exc:
                detail = getattr(exc, 'detail', None)
                outcome = 'error:' + (detail.get('code') if isinstance(detail, dict) else type(exc).__name__)
            outcomes[outcome] = outcomes.get(outcome, 0) + 1
            log(json.dumps(dict(workId=work_id, outcome=outcome), ensure_ascii=False))
        with get_db() as db:
            after = inspect(db, domain['libraryId'])
    else:
        after = None
    return dict(mode='apply' if apply else 'dry-run', before=before, worksToClean=len(works), outcomes=outcomes, after=after)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--database', default=str(Path(__file__).resolve().parent / 'data' / 'lakomics.sqlite3'))
    parser.add_argument('--apply', action='store_true', help='write; the default is a read-only dry run that prints counts')
    args = parser.parse_args(argv)

    class Opener:
        def __enter__(self):
            self.db = connect(args.database, not args.apply)
            return self.db

        def __exit__(self, *exc):
            self.db.close()
    print(json.dumps(run(Opener, args.apply), ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
