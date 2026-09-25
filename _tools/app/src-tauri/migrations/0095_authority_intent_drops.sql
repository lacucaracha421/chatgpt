-- Durable record of Album and Classification intents the PC retired without delivering.
--
-- An Asset-subject intent (Album membership, Classification assignment) can become
-- undeliverable for reasons that are not a user conflict: its Asset was purged or
-- trashed before its upload ever committed, its Album was deleted while it waited for
-- that upload, or the server tombstoned the Asset. Such an intent is retired so it
-- cannot stop delivery or receive for the whole domain, but the retirement must stay
-- observable, so each domain keeps a count and the most recent reason here.
--
-- One row per domain, created on the first drop. `last_reason` is a closed code, never
-- a formatted error. Blocked intents are not counted here: they stay in their outbox
-- with `state = 'blocked'` and their `conflict_code`.
CREATE TABLE authority_intent_drops (
 domain TEXT PRIMARY KEY NOT NULL CHECK(domain IN ('albums','classifications')),
 dropped_count INTEGER NOT NULL DEFAULT 0 CHECK(dropped_count >= 0),
 last_reason TEXT,
 last_operation_id TEXT,
 last_dropped_at TEXT
);

PRAGMA user_version = 95;
