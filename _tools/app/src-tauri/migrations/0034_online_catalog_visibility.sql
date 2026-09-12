CREATE TABLE online_catalog_hidden_categories (
  category INTEGER PRIMARY KEY CHECK(category BETWEEN 1 AND 11),
  created_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE online_catalog_blocked_tags (
  namespace TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(namespace, value)
) WITHOUT ROWID;

PRAGMA user_version = 34;
