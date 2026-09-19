"""One SQL projection for ordinary media readers, with inactive-safe fallback.

The predicate is defined once, here, because the same visibility rule has to hold for
every ordinary reader. Two copies drift, and a drifted copy is exactly how a trashed
Asset stays visible on one route while disappearing on another.
"""

#: Domain name whose activation switches the projection from legacy to authority-backed.
DOMAIN = "assets"


def _predicate(alias):
    """SQL boolean: may an ordinary reader expose row ``alias``.

    Inactive domain -> always true, so a library that never activated authority keeps
    byte-identical legacy visibility.

    Active domain -> true only when the Asset has an explicit canonical ``normal`` row.
    Expressed as "an explicit normal row exists" rather than "no non-normal row exists"
    so the read *fails closed*: a committed Asset whose authority row is missing (an
    interrupted promotion, a hand-edited database, a partially applied migration) is
    hidden rather than silently exposed. Treating absence as permission would make every
    bug that drops a canonical row a silent visibility leak, which is the one failure
    mode this projection exists to prevent.
    """
    return (
        "NOT EXISTS (SELECT 1 FROM authority_domains AS active_domain"
        f" WHERE active_domain.domain='{DOMAIN}')"
        " OR EXISTS (SELECT 1 FROM authority_domains AS active_domain"
        " JOIN asset_authority_state AS canonical"
        " ON canonical.library_id=active_domain.library_id"
        f" AND canonical.asset_id={alias}.id"
        f" WHERE active_domain.domain='{DOMAIN}'"
        " AND canonical.lifecycle='normal')"
    )


def visibility_clause(alias="asset"):
    """The same rule as a WHERE fragment, for a query that does not read the view."""
    return f"({_predicate(alias)})"


def install(db):
    if db.execute("SELECT 1 FROM sqlite_temp_master WHERE type='view' AND name='visible_assets'").fetchone():
        return
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' "
                                         "AND name IN ('assets','authority_domains','asset_authority_state')")}
    if 'assets' not in tables:
        return
    predicate = f" WHERE {_predicate('asset')}" if len(tables) == 3 else ""
    db.execute("CREATE TEMP VIEW visible_assets AS SELECT asset.* FROM assets AS asset" + predicate)
