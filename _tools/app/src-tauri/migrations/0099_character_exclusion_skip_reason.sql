-- Durable outcome of a mobile character exclusion the PC consumed without applying.
--
-- `character_exclusions.rs` consumes an entry that can never apply (its character was
-- deleted, its image trashed or changed, or the image is a reference of the character)
-- as skipped, so it cannot hold the cursor. The skip must stay observable: the receipt
-- records its closed reason (`targetMissing`, `assetMissing`, `assetChanged`,
-- `protectedReference`); NULL means the entry was applied or was already current.
ALTER TABLE mobile_character_exclusion_receipts ADD COLUMN skip_reason TEXT;

PRAGMA user_version = 99;
