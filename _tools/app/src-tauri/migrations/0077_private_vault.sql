ALTER TABLE library_settings ADD COLUMN private_vault_id TEXT;
ALTER TABLE library_settings ADD COLUMN private_vault_last_root TEXT;

PRAGMA user_version = 77;
