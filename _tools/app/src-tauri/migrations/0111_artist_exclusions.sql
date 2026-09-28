-- Artist hub exclusions are explicit folder selections. A selected folder also excludes
-- every classification below it, while the images and their classification links remain.
CREATE TABLE artist_excluded_classifications (
    classification_id TEXT PRIMARY KEY
        REFERENCES classification_entries(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL
);

DROP VIEW IF EXISTS asset_artist_scope;
CREATE VIEW asset_artist_scope AS
WITH RECURSIVE excluded(id) AS (
    SELECT classification_id
    FROM artist_excluded_classifications
    UNION
    SELECT child.id
    FROM classification_entries AS child
    JOIN excluded AS parent ON child.parent_id = parent.id
), excluded_assets(asset_id) AS (
    SELECT DISTINCT link.asset_id
    FROM asset_classifications AS link
    JOIN excluded ON excluded.id = link.classification_id
)
SELECT asset.id AS asset_id,
 CASE
  WHEN assignment.artist_id IS NOT NULL THEN 'artist:' || assignment.artist_id
  WHEN COALESCE(asset.creator_handle, asset.creator_url) IS NULL THEN
   CASE WHEN asset.source_url IS NULL OR trim(asset.source_url) = '' THEN 'unknown:none' ELSE 'unknown:source' END
  WHEN member.artist_id IS NOT NULL THEN 'artist:' || member.artist_id
  ELSE COALESCE(asset.creator_handle, asset.creator_url)
 END AS scope_ref
FROM assets AS asset
LEFT JOIN asset_artist_assignments AS assignment ON assignment.asset_id = asset.id
LEFT JOIN artist_members AS member ON member.creator_key = COALESCE(asset.creator_handle, asset.creator_url)
WHERE NOT EXISTS (SELECT 1 FROM excluded_assets WHERE excluded_assets.asset_id = asset.id);

PRAGMA user_version = 111;
