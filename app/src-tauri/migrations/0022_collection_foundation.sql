ALTER TABLE collections ADD COLUMN developer TEXT;
ALTER TABLE collections ADD COLUMN production_company TEXT;
ALTER TABLE collections ADD COLUMN release_date TEXT;
ALTER TABLE collections ADD COLUMN showcase_order INTEGER;

UPDATE collections
SET developer = author
WHERE type = 'game'
  AND author IS NOT NULL
  AND trim(author) <> '';

UPDATE collections AS current
SET showcase_order = (
    SELECT COUNT(*)
    FROM collections AS earlier
    WHERE earlier.showcase = 1
      AND (earlier.legacy_kind IS NULL OR earlier.legacy_kind <> 'gacha')
      AND earlier.type = current.type
      AND (
          earlier.created_at < current.created_at
          OR (earlier.created_at = current.created_at AND earlier.id < current.id)
      )
)
WHERE current.showcase = 1
  AND (current.legacy_kind IS NULL OR current.legacy_kind <> 'gacha');

CREATE INDEX collections_by_type_release_date
ON collections(type, release_date);

CREATE INDEX collections_by_showcase_order
ON collections(type, showcase_order)
WHERE showcase = 1;

PRAGMA user_version = 22;
