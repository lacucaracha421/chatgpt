"""Operator-only: delete every AV person that no live or trashed work credits.

Dry-run is the default: the database is opened read-only and the count and names of the people
that would go are printed. ``--apply`` writes, through the ordinary Collections authority command
``deletePerson`` (guarded by the person's entity revision, refused while any live or trashed work
still credits the person), one transaction per person. Each delete bumps the authority cursor and
appends a ``deletedPeople`` change, so the publication revision and the change feed move and the PC
forgets the person on its next sync (its row, portrait, profile, favourite mark and the remembered
server confirmation); the tablet keeps no people of its own. People that are still credited are never
touched, and a rerun finds nothing left to do.

This finishes ``av_director_purge.py``, which had to leave the people who only ever had director
credits behind as unreferenced records. Run on the server from the API directory, after the PC build
that understands ``deletedPeople`` is installed: ``python3 av_person_purge.py``.
"""
import argparse
from datetime import datetime, timezone
import json
import sqlite3
import uuid
from pathlib import Path

import authority
import collection_authority as ca


def connect(path, readonly):
    db = sqlite3.connect(Path(path).resolve().as_uri() + ('?mode=ro' if readonly else '?mode=rw'), uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    return db


def unreferenced(db, library_id):
    """(person_id, name) of every person without a credit on a live or trashed work."""
    return [(r['person_id'], r['display_name'] or json.loads(r['payload']).get('displayName') or r['person_id'])
            for r in db.execute(
                "SELECT person_id,display_name,payload FROM collection_authority_people p WHERE library_id=?"
                " AND NOT EXISTS(SELECT 1 FROM collection_authority_works w,json_each(w.av_credits) c"
                "  WHERE w.library_id=p.library_id AND w.lifecycle IN ('live','trashed')"
                "  AND json_extract(c.value,'$.personId')=p.person_id) ORDER BY person_id", (library_id,))]


def delete_person(get_db, domain, person_id):
    """Delete one person in one transaction; returns the outcome."""
    library, epoch = domain['libraryId'], domain['epoch']
    with get_db() as db:
        db.execute('BEGIN IMMEDIATE')
        try:
            live = authority.active_domain(db, ca.DOMAIN)
            if live is None or live['libraryId'] != library or live['epoch'] != epoch:
                db.rollback()
                return 'authorityChanged'
            row = db.execute("SELECT entity_revision FROM collection_authority_people WHERE library_id=? AND person_id=?",
                             (library, person_id)).fetchone()
            if row is None:
                db.rollback()
                return 'personUnavailable'
            body = dict(libraryId=library, epoch=epoch, contractVersion=ca.CONTRACT_VERSION, operationId=str(uuid.uuid4()),
                        commandType=ca.DELETE_PERSON, personId=person_id, expectedRevision=row['entity_revision'])
            lib, command_epoch, version, operation, kind, entity = ca.parse_command(body)
            ca.apply_command(db, library_id=lib, epoch=command_epoch, contract_version=version, command_type=kind,
                             operation_id=operation, entity=entity, now=datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
            db.commit()
            return ca.DELETE_PERSON
        except BaseException:
            db.rollback()
            raise


def run(get_db, apply, log=print):
    with get_db() as db:
        domain = authority.active_domain(db, ca.DOMAIN)
        if domain is None:
            raise ValueError('The Collections authority is not active on this database')
        people = unreferenced(db, domain['libraryId'])
    outcomes = {}
    if apply:
        for person_id, name in people:
            try:
                outcome = delete_person(get_db, domain, person_id)
            except Exception as exc:
                detail = getattr(exc, 'detail', None)
                outcome = 'error:' + (detail.get('code') if isinstance(detail, dict) else type(exc).__name__)
            outcomes[outcome] = outcomes.get(outcome, 0) + 1
            log(json.dumps(dict(personId=person_id, name=name, outcome=outcome), ensure_ascii=False))
    return dict(mode='apply' if apply else 'dry-run', peopleToDelete=len(people),
                names=[name for _, name in people], outcomes=outcomes)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--database', default=str(Path(__file__).resolve().parent / 'data' / 'lakomics.sqlite3'))
    parser.add_argument('--apply', action='store_true', help='write; the default is a read-only dry run that prints the people')
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
