-- Six derived default group cardinalities; canonical metadata remains external.
CREATE TABLE online_catalog_prepared_counts (
 provider TEXT NOT NULL,
 language TEXT NOT NULL CHECK(language IN ('all','korean','japanese')),
 reveal INTEGER NOT NULL CHECK(reveal IN (0,1)),
 source_revision TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0),
 count_rule_version INTEGER NOT NULL,
 policy_identity TEXT NOT NULL,
 exact_count INTEGER NOT NULL CHECK(typeof(exact_count)='integer' AND exact_count>=0),
 integrity_hash TEXT NOT NULL,
 PRIMARY KEY(provider,language,reveal)
) WITHOUT ROWID;
PRAGMA user_version=36;
