-- Classification Authority 2E: retire the legacy Classification dirty triggers.
--
-- Migration 0076 made `classification_entries` and `asset_classifications` bump the
-- shared `cloud_metadata_publication_state` counter so the legacy publisher could send
-- a whole Classification snapshot whenever local Classification state changed. Once a
-- Classification authority is adopted that lane is fenced server-side and the PC
-- consumes the generation locally instead of publishing it, so the counter itself has
-- no consumer left — but it was still being written on every mutation.
--
-- That is not a theoretical cost. Authority receive rewrites each confirmed assignment
-- (DELETE + INSERT, because assignment is single-valued), so a clean receive pass over
-- N confirmed assignments fired 2N trigger updates with no state change to publish:
-- production measured ~17,900 increments per five-second pass over 8,936 assignments.
--
-- The replacement triggers are conditional on the *absence* of the adoption row, which
-- is the same "singleton row present means adopted" convention migrations 0082/0083
-- use. Pre-adoption behaviour is therefore byte-identical — the legacy publisher still
-- sees every local Classification change — while an adopted library stops maintaining
-- a counter that nothing reads. The condition is read in the same statement as the
-- write, so an adoption racing a mutation cannot lose a pre-adoption increment.
--
-- Only the Classification-specific triggers are replaced. The `saved_x` and `albums`
-- triggers are untouched: those lanes are still live producers, and the two triggers
-- that bump Classification *and* `saved_x`/`albums` together are redefined to keep
-- their other kinds and drop only the Classification branch.

DROP TRIGGER IF EXISTS cloud_metadata_classifications_insert;
DROP TRIGGER IF EXISTS cloud_metadata_classifications_update;
DROP TRIGGER IF EXISTS cloud_metadata_classifications_delete;
DROP TRIGGER IF EXISTS cloud_metadata_membership_insert;
DROP TRIGGER IF EXISTS cloud_metadata_membership_update;
DROP TRIGGER IF EXISTS cloud_metadata_membership_delete;
DROP TRIGGER IF EXISTS cloud_metadata_asset_insert;
DROP TRIGGER IF EXISTS cloud_metadata_asset_delete;
DROP TRIGGER IF EXISTS cloud_metadata_asset_visibility;

-- Classification-only triggers: keep the legacy behaviour while unadopted.
CREATE TRIGGER cloud_metadata_classifications_insert
AFTER INSERT ON classification_entries
WHEN NOT EXISTS (SELECT 1 FROM classification_authority_sync WHERE singleton = 1)
BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='classifications';
END;
CREATE TRIGGER cloud_metadata_classifications_update
AFTER UPDATE ON classification_entries
WHEN NOT EXISTS (SELECT 1 FROM classification_authority_sync WHERE singleton = 1)
BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='classifications';
END;
CREATE TRIGGER cloud_metadata_classifications_delete
AFTER DELETE ON classification_entries
WHEN NOT EXISTS (SELECT 1 FROM classification_authority_sync WHERE singleton = 1)
BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='classifications';
END;
CREATE TRIGGER cloud_metadata_membership_insert
AFTER INSERT ON asset_classifications
WHEN NOT EXISTS (SELECT 1 FROM classification_authority_sync WHERE singleton = 1)
BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='classifications';
END;
CREATE TRIGGER cloud_metadata_membership_update
AFTER UPDATE ON asset_classifications
WHEN NOT EXISTS (SELECT 1 FROM classification_authority_sync WHERE singleton = 1)
BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='classifications';
END;
CREATE TRIGGER cloud_metadata_membership_delete
AFTER DELETE ON asset_classifications
WHEN NOT EXISTS (SELECT 1 FROM classification_authority_sync WHERE singleton = 1)
BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1 WHERE kind='classifications';
END;

-- Asset triggers that served Classification *and* another kind. Each keeps its other
-- kind unconditionally and drops Classification once adopted. `saved_x`/`albums` are
-- still legacy-produced domains, so their behaviour must not change.
CREATE TRIGGER cloud_metadata_asset_insert
AFTER INSERT ON assets
BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1
  WHERE kind = 'saved_x'
     OR (kind = 'classifications'
         AND NOT EXISTS (SELECT 1 FROM classification_authority_sync WHERE singleton = 1));
END;
CREATE TRIGGER cloud_metadata_asset_delete
AFTER DELETE ON assets
BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1
  WHERE kind IN ('saved_x','albums')
     OR (kind = 'classifications'
         AND NOT EXISTS (SELECT 1 FROM classification_authority_sync WHERE singleton = 1));
END;
CREATE TRIGGER cloud_metadata_asset_visibility
AFTER UPDATE OF status ON assets
BEGIN
 UPDATE cloud_metadata_publication_state SET generation=generation+1
  WHERE kind IN ('saved_x','albums')
     OR (kind = 'classifications'
         AND NOT EXISTS (SELECT 1 FROM classification_authority_sync WHERE singleton = 1));
END;

PRAGMA user_version = 85;
