-- Structured, non-secret failure reasons beside the user-facing cloud activity message.
--
-- The forensic trace of the locked-keyring sample (2026-09-18 22:44 KST) had to
-- reconstruct its cause from timestamps: every background failure collapsed into one
-- generic connectivity message, so a specific `CredentialStoreLocked` was
-- indistinguishable from a real network outage in the durable record. The human
-- message stays exactly as it was - it is what the UI shows - and this column carries
-- the machine-readable reason next to it.
--
-- The stored value is a closed code from `CloudFailureReason::code`, never a formatted
-- error, so no token, filesystem path or backend diagnostic can reach the database.

ALTER TABLE cloud_activity ADD COLUMN last_reason TEXT;
ALTER TABLE cloud_activity ADD COLUMN metadata_last_reason TEXT;

PRAGMA user_version = 87;
