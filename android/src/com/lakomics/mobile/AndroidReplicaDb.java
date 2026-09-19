package com.lakomics.mobile;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Android implementation of the replica storage seam.
 *
 * Everything here is translation: open the app-private database, execute the shared
 * schema and move typed rows. No rule about what the replica *means* lives on this side,
 * so this adapter cannot disagree with {@link LibraryReplicaStore} about state — only
 * about syntax, which the check harness catches because it drives the same store through
 * its own adapter over a real SQLite engine.
 */
final class AndroidReplicaDb implements ReplicaDb, AssetReplica.Storage {
    /** The app-private database file, under no-backup storage. */
    static final String FILE_NAME = "library-replica.sqlite";

    /** Open the replica database for this application. */
    static AndroidReplicaDb open(android.content.Context context) {
        return new AndroidReplicaDb(new File(context.getNoBackupFilesDir(), FILE_NAME));
    }

    private final File file;
    private SQLiteDatabase db;

    AndroidReplicaDb(File file) {
        this.file = file;
        open();
        migrate();
    }

    private void open() {
        db = SQLiteDatabase.openOrCreateDatabase(file, null);
        db.enableWriteAheadLogging();
    }

    /**
     * Upgrade in place through the one shared definition of the upgrade.
     *
     * Only the transaction is owned here: the column adds, the DDL and the version stamp
     * are decided by {@link ReplicaSchema#migrate}, so the check harness that drives the
     * same call over a real SQLite engine observes the shipped sequence rather than a
     * paraphrase of it.
     */
    private void migrate() {
        db.beginTransaction();
        try {
            ReplicaSchema.migrate(new ReplicaSchema.Statements() {
                @Override
                public int version() {
                    return db.getVersion();
                }

                @Override
                public void execute(String statement) {
                    db.execSQL(statement);
                }

                @Override
                public void setVersion(int version) {
                    db.setVersion(version);
                }
            });
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    @Override public AssetReplica.Snapshot readAssets(String scope) {
        try(Cursor c=db.rawQuery("SELECT library_id,epoch,cursor FROM asset_authority WHERE singleton=1 AND scope=?",new String[]{scope})) {
            if(!c.moveToFirst())return null;
            java.util.Map<String,java.util.Map<String,Object>> rows=new java.util.TreeMap<>();
            try(Cursor assets=db.rawQuery("SELECT asset_id,projection FROM asset_state ORDER BY asset_id",null)) {
                while(assets.moveToNext())rows.put(assets.getString(0),AssetReplica.projection(Json.parse(assets.getString(1))));
            }
            return new AssetReplica.Snapshot(c.getString(0),c.getLong(1),c.getLong(2),rows);
        }
    }
    @Override public void replaceAssets(String scope,AssetReplica.Snapshot snapshot) {
        db.beginTransaction();
        try {
            db.execSQL("DELETE FROM asset_state");
            for(java.util.Map<String,Object> p:snapshot.rows.values()) db.execSQL("INSERT INTO asset_state VALUES(?,?,?,?)",new Object[]{p.get("assetId"),p.get("lifecycle"),p.get("entityRevision"),new org.json.JSONObject(p).toString()});
            db.execSQL("INSERT OR REPLACE INTO asset_authority VALUES(1,?,?,?,?)",new Object[]{scope,snapshot.library,snapshot.epoch,snapshot.cursor});
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    @Override public void clearAssets() {
        db.beginTransaction();try{db.execSQL("DELETE FROM asset_state");db.execSQL("DELETE FROM asset_authority");db.setTransactionSuccessful();}finally{db.endTransaction();}
    }

    @Override
    public StoredAuthority authority() {
        try (Cursor cursor = db.rawQuery(ReplicaSchema.READ_AUTHORITY, null)) {
            if (!cursor.moveToFirst()) return null;
            return new StoredAuthority(cursor.getString(0), cursor.getString(1),
                    cursor.getLong(2), cursor.getLong(3), cursor.getLong(4),
                    cursor.getString(5), cursor.isNull(6) ? null : cursor.getString(6));
        }
    }

    @Override
    public List<AlbumReplica.Album> albums(boolean liveOnly) {
        List<AlbumReplica.Album> rows = new ArrayList<>();
        try (Cursor cursor = db.rawQuery(ReplicaSchema.READ_ALBUMS
                + (liveOnly ? " WHERE deleted=0" : "") + " ORDER BY album_id", null)) {
            while (cursor.moveToNext()) {
                rows.add(new AlbumReplica.Album(cursor.getString(0), cursor.getString(1),
                        cursor.isNull(2) ? null : cursor.getString(2),
                        cursor.isNull(3) ? null : cursor.getString(3),
                        cursor.isNull(4) ? null : cursor.getString(4),
                        cursor.getInt(5) != 0, cursor.getLong(6)));
            }
        }
        return rows;
    }

    @Override
    public List<AlbumReplica.Member> members(boolean liveOnly) {
        List<AlbumReplica.Member> rows = new ArrayList<>();
        try (Cursor cursor = db.rawQuery(ReplicaSchema.READ_MEMBERS
                + (liveOnly ? " WHERE desired_state=1" : "") + " ORDER BY album_id,asset_id",
                null)) {
            while (cursor.moveToNext()) {
                rows.add(new AlbumReplica.Member(cursor.getString(0), cursor.getString(1),
                        cursor.getInt(2) != 0, cursor.getLong(3)));
            }
        }
        return rows;
    }

    @Override
    public AlbumReplica.Member member(String albumId, String assetId) {
        try (Cursor cursor = db.rawQuery(ReplicaSchema.READ_MEMBER, new String[]{albumId, assetId})) {
            if (!cursor.moveToFirst()) return null;
            return new AlbumReplica.Member(cursor.getString(0), cursor.getString(1),
                    cursor.getInt(2) != 0, cursor.getLong(3));
        }
    }

    @Override
    public List<OutboxRow> outbox() {
        List<OutboxRow> rows = new ArrayList<>();
        try (Cursor cursor = db.rawQuery(ReplicaSchema.READ_OUTBOX, null)) {
            while (cursor.moveToNext()) {
                rows.add(new OutboxRow(cursor.getLong(0), cursor.getString(1), cursor.getString(2),
                        cursor.getString(3), cursor.getString(4), cursor.getString(5),
                        cursor.getLong(6), cursor.getLong(7), cursor.getInt(8) != 0,
                        cursor.getLong(9), cursor.getString(10), cursor.getString(11),
                        cursor.isNull(12) ? null : cursor.getString(12),
                        cursor.isNull(13) ? null : cursor.getString(13), cursor.getString(14)));
            }
        }
        return rows;
    }

    @Override
    public void writeAuthority(StoredAuthority authority) {
        db.execSQL(ReplicaSchema.WRITE_AUTHORITY, new Object[]{authority.scope, authority.libraryId,
                authority.epoch, authority.contractVersion, authority.cursor,
                authority.adoptedAt, authority.reconciledAt});
    }

    @Override
    public void writeAlbum(AlbumReplica.Album album, String now) {
        db.execSQL(ReplicaSchema.WRITE_ALBUM, new Object[]{album.id, album.name, album.parentId,
                album.iconKey, album.colorKey, album.deleted ? 1 : 0, album.entityRevision, now});
    }

    @Override
    public void writeMember(AlbumReplica.Member member, String now) {
        db.execSQL(ReplicaSchema.WRITE_MEMBER, new Object[]{member.albumId, member.assetId,
                member.desiredState ? 1 : 0, member.entityRevision, now});
    }

    @Override
    public void retireLiveMembers(String albumId, String now) {
        db.execSQL(ReplicaSchema.RETIRE_LIVE_MEMBERS, new Object[]{now, albumId});
    }

    @Override
    public void clearAlbums() {
        db.execSQL(ReplicaSchema.CLEAR_ALBUMS);
    }

    @Override
    public void clearMembers() {
        db.execSQL(ReplicaSchema.CLEAR_MEMBERS);
    }

    @Override
    public void writeOutbox(OutboxRow row) {
        db.execSQL(ReplicaSchema.WRITE_OUTBOX, new Object[]{row.seq, row.operationId, row.commandType,
                row.albumId, row.assetId, row.libraryId, row.epoch, row.contractVersion,
                row.desiredState ? 1 : 0, row.expectedRevision, row.payload, row.createdAt});
    }

    @Override
    public void deleteOutbox(long seq) {
        db.execSQL(ReplicaSchema.DELETE_OUTBOX, new Object[]{seq});
    }

    @Override
    public void blockOutbox(long seq, String code, String detail) {
        db.execSQL(ReplicaSchema.BLOCK_OUTBOX, new Object[]{code, detail, seq});
    }

    @Override
    public void clearOutbox() { db.execSQL(ReplicaSchema.CLEAR_OUTBOX); }

    @Override
    public void clearAuthority() {
        db.execSQL(ReplicaSchema.CLEAR_AUTHORITY);
    }

    @Override
    public void setCursor(long cursor, String now) {
        db.execSQL(ReplicaSchema.SET_CURSOR, new Object[]{cursor, now});
    }

    @Override
    public void setReconciledAt(String now) {
        db.execSQL(ReplicaSchema.SET_RECONCILED, new Object[]{now});
    }

    // -----------------------------------------------------------------------
    // Classification read replica
    // -----------------------------------------------------------------------

    @Override
    public StoredAuthority classificationAuthority() {
        try (Cursor cursor = db.rawQuery(ReplicaSchema.READ_CLASSIFICATION_AUTHORITY, null)) {
            if (!cursor.moveToFirst()) return null;
            return new StoredAuthority(cursor.getString(0), cursor.getString(1), cursor.getLong(2),
                    cursor.getLong(3), cursor.getLong(4), cursor.getString(5),
                    cursor.isNull(6) ? null : cursor.getString(6));
        }
    }

    @Override
    public List<ClassificationReplica.Node> classifications(boolean liveOnly) {
        String sql = ReplicaSchema.READ_CLASSIFICATIONS
                + (liveOnly ? " WHERE deleted=0" : "");
        List<ClassificationReplica.Node> rows = new ArrayList<>();
        try (Cursor cursor = db.rawQuery(sql, null)) {
            while (cursor.moveToNext()) {
                rows.add(new ClassificationReplica.Node(cursor.getString(0), cursor.getString(1),
                        cursor.getString(2), cursor.isNull(3) ? null : cursor.getString(3),
                        cursor.isNull(4) ? null : cursor.getString(4),
                        cursor.isNull(5) ? null : cursor.getString(5),
                        cursor.getLong(6) != 0, cursor.getLong(7)));
            }
        }
        return rows;
    }

    @Override
    public List<ClassificationReplica.Assignment> assignments() {
        List<ClassificationReplica.Assignment> rows = new ArrayList<>();
        try (Cursor cursor = db.rawQuery(ReplicaSchema.READ_CLASSIFICATION_ASSIGNMENTS, null)) {
            while (cursor.moveToNext()) {
                rows.add(new ClassificationReplica.Assignment(cursor.getString(0),
                        cursor.isNull(1) ? null : cursor.getString(1), cursor.getLong(2)));
            }
        }
        return rows;
    }

    @Override
    public String classificationRole(String role) {
        try (Cursor cursor = db.rawQuery(ReplicaSchema.READ_CLASSIFICATION_ROLE,
                new String[]{role})) {
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        }
    }

    @Override
    public void writeClassificationAuthority(StoredAuthority authority) {
        db.execSQL(ReplicaSchema.WRITE_CLASSIFICATION_AUTHORITY, new Object[]{
                authority.scope, authority.libraryId, authority.epoch, authority.contractVersion,
                authority.cursor, authority.adoptedAt, authority.reconciledAt});
    }

    @Override
    public void writeClassification(ClassificationReplica.Node node, String now) {
        db.execSQL(ReplicaSchema.WRITE_CLASSIFICATION_NODE, new Object[]{node.id, node.kind,
                node.name, node.parentId, node.iconKey, node.colorKey, node.deleted ? 1 : 0,
                node.entityRevision, now});
    }

    @Override
    public void writeAssignment(ClassificationReplica.Assignment assignment, String now) {
        db.execSQL(ReplicaSchema.WRITE_CLASSIFICATION_ASSIGNMENT, new Object[]{assignment.assetId,
                assignment.classificationId, assignment.entityRevision, now});
    }

    @Override
    public void applyAssignmentTransition(String from, String to, String now) {
        db.execSQL(ReplicaSchema.APPLY_CLASSIFICATION_TRANSITION, new Object[]{to, now, from});
    }

    @Override
    public void clearAssignment(String assetId) {
        db.execSQL(ReplicaSchema.CLEAR_CLASSIFICATION_ASSIGNMENT, new Object[]{assetId});
    }

    @Override
    public void writeClassificationRole(String role, String classificationId) {
        db.execSQL(ReplicaSchema.WRITE_CLASSIFICATION_ROLE, new Object[]{role, classificationId});
    }

    @Override
    public void clearClassifications() {
        db.execSQL(ReplicaSchema.CLEAR_CLASSIFICATION_NODES);
    }

    @Override
    public void clearAssignments() {
        db.execSQL(ReplicaSchema.CLEAR_CLASSIFICATION_ASSIGNMENTS);
    }

    @Override
    public void clearClassificationRole() {
        db.execSQL(ReplicaSchema.CLEAR_CLASSIFICATION_ROLES);
    }

    @Override
    public void clearClassificationAuthority() {
        db.execSQL(ReplicaSchema.CLEAR_CLASSIFICATION_AUTHORITY);
    }

    @Override
    public void setClassificationCursor(long cursor, String now) {
        db.execSQL(ReplicaSchema.SET_CLASSIFICATION_CURSOR, new Object[]{cursor, now});
    }

    @Override
    public void setClassificationReconciledAt(String now) {
        db.execSQL(ReplicaSchema.SET_CLASSIFICATION_RECONCILED, new Object[]{now});
    }

    // -----------------------------------------------------------------------
    // Classification assignment outbox (v5)
    // -----------------------------------------------------------------------

    @Override
    public List<ClassificationAssignment> classificationOutbox() {
        List<ClassificationAssignment> rows = new ArrayList<>();
        try (Cursor cursor = db.rawQuery(ReplicaSchema.READ_CLASSIFICATION_OUTBOX, null)) {
            while (cursor.moveToNext()) {
                rows.add(new ClassificationAssignment(cursor.getLong(0), cursor.getString(1),
                        cursor.getString(2), cursor.getString(3),
                        cursor.isNull(4) ? null : cursor.getString(4), cursor.getString(5),
                        cursor.getLong(6), cursor.getLong(7), cursor.getLong(8),
                        cursor.getString(9), cursor.getString(10),
                        cursor.isNull(11) ? null : cursor.getString(11),
                        cursor.isNull(12) ? null : cursor.getString(12), cursor.getString(13)));
            }
        }
        return rows;
    }

    @Override
    public void writeClassificationOutbox(ClassificationAssignment row) {
        db.execSQL(ReplicaSchema.WRITE_CLASSIFICATION_OUTBOX, new Object[]{row.seq,
                row.operationId, row.commandType, row.assetId, row.classificationId, row.libraryId,
                row.epoch, row.contractVersion, row.expectedRevision, row.payload, row.createdAt});
    }

    @Override
    public void deleteClassificationOutbox(long seq) {
        db.execSQL(ReplicaSchema.DELETE_CLASSIFICATION_OUTBOX, new Object[]{seq});
    }

    @Override
    public void blockClassificationOutbox(long seq, String code, String detail) {
        db.execSQL(ReplicaSchema.BLOCK_CLASSIFICATION_OUTBOX, new Object[]{code, detail, seq});
    }

    @Override
    public void rebaseClassificationOutbox(long seq, long expectedRevision, String payload) {
        db.execSQL(ReplicaSchema.REBASE_CLASSIFICATION_OUTBOX,
                new Object[]{expectedRevision, payload, seq});
    }

    @Override
    public void clearClassificationOutbox() {
        db.execSQL(ReplicaSchema.CLEAR_CLASSIFICATION_OUTBOX);
    }

    @Override
    public void begin() {
        db.beginTransaction();
    }

    @Override
    public void commit() {
        db.setTransactionSuccessful();
        db.endTransaction();
    }

    @Override
    public void rollback() {
        db.endTransaction();
    }

    @Override
    public void close() {
        db.close();
    }
}
