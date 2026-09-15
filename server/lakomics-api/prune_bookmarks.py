"""Server-local retention maintenance for the catalog bookmark authority.

Run this on the host that owns the control database, on whatever schedule the
operator chooses. It is deliberately not an HTTP route: pruning is an
authority-management operation, and no client credential should be able to
trigger history deletion.

Only the change log and operation receipts are pruned. Bookmark state and
tombstones are never deleted, because absence of a change row must never be read
as "this bookmark was removed".

    python prune_bookmarks.py --db data/lakomics.sqlite3 --dry-run
    python prune_bookmarks.py --db data/lakomics.sqlite3
"""
import argparse
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import api_auth
import catalog_bookmarks


def counts(db, days):
    cutoff = catalog_bookmarks._cutoff(days)
    changes = db.execute(
        "SELECT COUNT(*) FROM catalog_bookmark_changes WHERE changed_at < ?", [cutoff]).fetchone()[0]
    receipts = db.execute(
        "SELECT COUNT(*) FROM catalog_bookmark_receipts WHERE accepted_at < ?", [cutoff]).fetchone()[0]
    state = db.execute("SELECT COUNT(*) FROM catalog_bookmark_state").fetchone()[0]
    return changes, receipts, state


def main(argv=None):
    parser = argparse.ArgumentParser(description="Prune expired catalog bookmark history.")
    parser.add_argument("--db", default=str(api_auth.DEFAULT_DB))
    parser.add_argument("--days", type=int, default=catalog_bookmarks.RETENTION_DAYS)
    parser.add_argument("--receipt-days", type=int, default=catalog_bookmarks.RECEIPT_RETENTION_DAYS)
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would be pruned without deleting anything")
    arguments = parser.parse_args(argv)

    if arguments.days < 1 or arguments.receipt_days < 1:
        print("retention windows must be at least one day", file=sys.stderr)
        return 2
    if arguments.receipt_days < arguments.days:
        # Receipts must outlive the change window, or a retry inside the supported
        # offline window would be re-applied as a new logical mutation.
        print("receipt retention must be at least the change retention", file=sys.stderr)
        return 2

    def get_db():
        connection = sqlite3.connect(arguments.db, timeout=10)
        connection.row_factory = sqlite3.Row
        # Ensure the schema exists so a dry run against a fresh database reports
        # zeros instead of failing on a missing table.
        connection.executescript(catalog_bookmarks.DDL)
        return connection

    connection = get_db()
    try:
        changes, receipts, state = counts(connection, arguments.days)
    finally:
        connection.close()
    if arguments.dry_run:
        print(f"would prune: changes={changes} receipts={receipts} (state rows kept={state})")
        return 0
    result = catalog_bookmarks.prune(get_db, days=arguments.days,
                                    receipt_days=arguments.receipt_days)
    print(f"pruned: changes={result['changes']} receipts={result['receipts']}")
    print(f"bookmark state rows retained: {state}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
