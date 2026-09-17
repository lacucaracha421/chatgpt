package com.lakomics.mobile;

/**
 * The one definition of the Library replica schema.
 *
 * It lives outside both database adapters so it has exactly one source of truth. The
 * Android adapter and the JVM check harness both execute *these* statements, so a
 * statement that is no longer valid SQLite fails in the harness rather than only on a
 * device, and neither side can drift into its own idea of the schema.
 *
 * Version 1 contained only rebuildable server state. Version 2 adds a durable outgoing
 * outbox, so the database is no longer disposable while local intent is pending: known
 * older schemas upgrade in place and an unknown future schema fails closed without deleting
 * the file. User media, notes and device caches are still not represented here.
 *
 * Version 4 adds the read-only Classification replica. Each domain keeps its own singleton
 * authority row, so one domain can be adopted while another is not, and a domain's rows
 * are cleared only by that domain's own reset.
 */
final class ReplicaSchema {
    /** Version 4 adds the Classification read replica beside the Album domain. */
    static final int VERSION = 4;

    /** v0 is fresh, v1-v3 are older replicas; all upgrade in place. */
    static boolean canUpgradeFrom(int version) {
        return version >= 0 && version < VERSION;
    }

    /**
     * A future schema may contain unsent local intent, so an older build must preserve
     * the file and fail closed instead of deleting a database it cannot interpret.
     */
    static void requireReadableVersion(int version) {
        if (version > VERSION) {
            throw new IllegalStateException("Replica database was written by a newer app");
        }
    }

    /**
     * The unreleased intermediate v2 outbox did not store library/contract identity.
     * Existing rows cannot be safely reconstructed from the current authority after a
     * replacement, so they receive sentinel values. The v3 replay/flush guards preserve
     * them but block them before display or network delivery instead of guessing.
     */
    static String[] upgradeStatements(int version) {
        if (version == 2) return new String[]{
                "ALTER TABLE album_authority_outbox ADD COLUMN library_id TEXT NOT NULL DEFAULT ''",
                "ALTER TABLE album_authority_outbox ADD COLUMN contract_version INTEGER NOT NULL DEFAULT 0",
        };
        return new String[0];
    }

    static final String[] DDL = {
            "CREATE TABLE IF NOT EXISTS album_authority("
                    + "singleton INTEGER PRIMARY KEY CHECK(singleton=1),"
                    + "scope TEXT NOT NULL,library_id TEXT NOT NULL,epoch INTEGER NOT NULL,"
                    + "contract_version INTEGER NOT NULL,cursor INTEGER NOT NULL,"
                    + "adopted_at TEXT NOT NULL,reconciled_at TEXT)",
            "CREATE TABLE IF NOT EXISTS album_state("
                    + "album_id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT,"
                    + "icon_key TEXT,color_key TEXT,deleted INTEGER NOT NULL,"
                    + "entity_revision INTEGER NOT NULL,updated_at TEXT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS album_state_parent ON album_state(parent_id)",
            "CREATE TABLE IF NOT EXISTS album_membership_state("
                    + "album_id TEXT NOT NULL,asset_id TEXT NOT NULL,"
                    + "desired_state INTEGER NOT NULL,entity_revision INTEGER NOT NULL,"
                    + "updated_at TEXT NOT NULL,PRIMARY KEY(album_id,asset_id))",
            "CREATE TABLE IF NOT EXISTS album_authority_outbox("
                    + "seq INTEGER PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,"
                    + "command_type TEXT NOT NULL,album_id TEXT NOT NULL,asset_id TEXT NOT NULL,"
                    + "library_id TEXT NOT NULL,epoch INTEGER NOT NULL,contract_version INTEGER NOT NULL,"
                    + "desired_state INTEGER NOT NULL,"
                    + "expected_revision INTEGER NOT NULL,payload TEXT NOT NULL,"
                    + "state TEXT NOT NULL CHECK(state IN ('pending','blocked')),"
                    + "conflict_code TEXT,conflict_detail TEXT,created_at TEXT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS album_outbox_state ON album_authority_outbox(state,seq)",
            // ---------------------------------------------------------------
            // Classification read replica (v4). Read-only in this phase: there is
            // deliberately no Classification outbox table, because Android issues no
            // Classification command.
            // ---------------------------------------------------------------
            "CREATE TABLE IF NOT EXISTS classification_authority("
                    + "singleton INTEGER PRIMARY KEY CHECK(singleton=1),"
                    + "scope TEXT NOT NULL,library_id TEXT NOT NULL,epoch INTEGER NOT NULL,"
                    + "contract_version INTEGER NOT NULL,cursor INTEGER NOT NULL,"
                    + "adopted_at TEXT NOT NULL,reconciled_at TEXT)",
            "CREATE TABLE IF NOT EXISTS classification_state("
                    + "classification_id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,"
                    + "parent_id TEXT,icon_key TEXT,color_key TEXT,deleted INTEGER NOT NULL,"
                    + "entity_revision INTEGER NOT NULL,updated_at TEXT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS classification_state_parent"
                    + " ON classification_state(parent_id)",
            // One row per Asset. `classification_id` nullable is the authoritative
            // *unassigned* state at a real revision, which is not the same as "never seen";
            // visible membership is `classification_id IS NOT NULL` only.
            "CREATE TABLE IF NOT EXISTS classification_assignment_state("
                    + "asset_id TEXT PRIMARY KEY,classification_id TEXT,"
                    + "entity_revision INTEGER NOT NULL,updated_at TEXT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS classification_assignment_classification"
                    + " ON classification_assignment_state(classification_id)",
            // The immutable role binding. No command produces it, so it is learned only
            // from a baseline and is what makes the protected id interpretable.
            "CREATE TABLE IF NOT EXISTS classification_role_state("
                    + "role TEXT PRIMARY KEY,classification_id TEXT NOT NULL)",
    };

    /** The adoption row and its cursor. `singleton=1` is the adoption marker itself. */
    static final String WRITE_AUTHORITY =
            "INSERT OR REPLACE INTO album_authority(singleton,scope,library_id,epoch,"
                    + "contract_version,cursor,adopted_at,reconciled_at) VALUES(1,?,?,?,?,?,?,?)";
    /** One Album row, live or tombstoned. `deleted` is what keeps a tombstone readable. */
    static final String WRITE_ALBUM =
            "INSERT OR REPLACE INTO album_state(album_id,name,parent_id,icon_key,color_key,"
                    + "deleted,entity_revision,updated_at) VALUES(?,?,?,?,?,?,?,?)";
    /** One relation, live or tombstoned: removal keeps its revision rather than deleting. */
    static final String WRITE_MEMBER =
            "INSERT OR REPLACE INTO album_membership_state(album_id,asset_id,desired_state,"
                    + "entity_revision,updated_at) VALUES(?,?,?,?,?)";
    /**
     * Deleting an Album retires its live relations without inventing a revision.
     *
     * The delete change row carries only the Album tombstone, so bumping a relation here
     * would create revision state that no replay of that row could reproduce. Removing
     * the row instead would destroy the revision a later re-add must present.
     */
    static final String RETIRE_LIVE_MEMBERS =
            "UPDATE album_membership_state SET desired_state=0,updated_at=?"
                    + " WHERE album_id=? AND desired_state=1";

    /** The Classification adoption row and its cursor. Its presence is the domain marker. */
    static final String WRITE_CLASSIFICATION_AUTHORITY =
            "INSERT OR REPLACE INTO classification_authority(singleton,scope,library_id,epoch,"
                    + "contract_version,cursor,adopted_at,reconciled_at) VALUES(1,?,?,?,?,?,?,?)";
    static final String READ_CLASSIFICATION_AUTHORITY =
            "SELECT scope,library_id,epoch,contract_version,cursor,adopted_at,reconciled_at"
                    + " FROM classification_authority WHERE singleton=1";
    /** One Classification row, live or tombstoned. */
    static final String WRITE_CLASSIFICATION_NODE =
            "INSERT OR REPLACE INTO classification_state(classification_id,kind,name,parent_id,"
                    + "icon_key,color_key,deleted,entity_revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?)";
    static final String READ_CLASSIFICATIONS =
            "SELECT classification_id,kind,name,parent_id,icon_key,color_key,deleted,"
                    + "entity_revision FROM classification_state";
    /**
     * One Asset's assignment lineage, live or authoritatively unassigned.
     *
     * A cleared assignment keeps its row with a null `classification_id` and an incremented
     * revision, exactly as the server retains it, so absence stays reserved for "the
     * authority never mentioned this Asset".
     */
    static final String WRITE_CLASSIFICATION_ASSIGNMENT =
            "INSERT OR REPLACE INTO classification_assignment_state(asset_id,classification_id,"
                    + "entity_revision,updated_at) VALUES(?,?,?,?)";
    static final String READ_CLASSIFICATION_ASSIGNMENTS =
            "SELECT asset_id,classification_id,entity_revision FROM classification_assignment_state";
    /**
     * The deterministic assignment transition one delete performed.
     *
     * Every row naming the deleted Classification moves to its parent (or to unassigned for
     * a root) and each revision increments by exactly one, which is what the server did, so
     * the replica reproduces the same numbers rather than inventing a revision no replay of
     * that change row could reproduce.
     */
    static final String APPLY_CLASSIFICATION_TRANSITION =
            "UPDATE classification_assignment_state SET classification_id=?,updated_at=?,"
                    + "entity_revision=entity_revision+1 WHERE classification_id=?";
    static final String WRITE_CLASSIFICATION_ROLE =
            "INSERT OR REPLACE INTO classification_role_state(role,classification_id)"
                    + " VALUES(?,?)";
    static final String READ_CLASSIFICATION_ROLE =
            "SELECT classification_id FROM classification_role_state WHERE role=?";
    static final String CLEAR_CLASSIFICATION_NODES = "DELETE FROM classification_state";
    static final String CLEAR_CLASSIFICATION_ASSIGNMENTS =
            "DELETE FROM classification_assignment_state";
    static final String CLEAR_CLASSIFICATION_ROLES = "DELETE FROM classification_role_state";
    static final String CLEAR_CLASSIFICATION_AUTHORITY = "DELETE FROM classification_authority";
    static final String SET_CLASSIFICATION_CURSOR =
            "UPDATE classification_authority SET cursor=?,reconciled_at=? WHERE singleton=1";
    static final String SET_CLASSIFICATION_RECONCILED =
            "UPDATE classification_authority SET reconciled_at=? WHERE singleton=1";

    static final String CLEAR_ALBUMS = "DELETE FROM album_state";
    static final String CLEAR_MEMBERS = "DELETE FROM album_membership_state";
    static final String CLEAR_AUTHORITY = "DELETE FROM album_authority";
    static final String SET_CURSOR =
            "UPDATE album_authority SET cursor=?,reconciled_at=? WHERE singleton=1";
    static final String SET_RECONCILED =
            "UPDATE album_authority SET reconciled_at=? WHERE singleton=1";
    static final String READ_AUTHORITY =
            "SELECT scope,library_id,epoch,contract_version,cursor,adopted_at,reconciled_at"
                    + " FROM album_authority WHERE singleton=1";
    static final String READ_ALBUMS =
            "SELECT album_id,name,parent_id,icon_key,color_key,deleted,entity_revision"
                    + " FROM album_state";
    static final String READ_MEMBERS =
            "SELECT album_id,asset_id,desired_state,entity_revision"
                    + " FROM album_membership_state";
    static final String READ_MEMBER = READ_MEMBERS + " WHERE album_id=? AND asset_id=?";
    static final String READ_OUTBOX =
            "SELECT seq,operation_id,command_type,album_id,asset_id,library_id,epoch,contract_version,"
                    + "desired_state,expected_revision,payload,state,conflict_code,conflict_detail,created_at"
                    + " FROM album_authority_outbox ORDER BY seq";
    static final String WRITE_OUTBOX =
            "INSERT INTO album_authority_outbox(seq,operation_id,command_type,album_id,asset_id,"
                    + "library_id,epoch,contract_version,desired_state,expected_revision,payload,state,"
                    + "conflict_code,conflict_detail,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,NULL,?)";
    static final String DELETE_OUTBOX = "DELETE FROM album_authority_outbox WHERE seq=?";
    static final String BLOCK_OUTBOX =
            "UPDATE album_authority_outbox SET state='blocked',conflict_code=?,conflict_detail=?"
                    + " WHERE seq=?";
    static final String CLEAR_OUTBOX = "DELETE FROM album_authority_outbox";

    private ReplicaSchema() {}
}
