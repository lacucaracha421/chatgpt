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
final class AndroidReplicaDb implements ReplicaDb {
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

    private void migrate() {
        int version = db.getVersion();
        if (version > ReplicaSchema.VERSION) {
            // A newer build wrote this file, so its schema cannot be interpreted here. It
            // is a replica and holds nothing that exists nowhere else, so it is rebuilt
            // from the server rather than guessed at. User media lives in other
            // directories and is not touched by this.
            db.close();
            if (!file.delete()) throw new IllegalStateException("Cannot replace the replica database");
            open();
            version = db.getVersion();
        }
        if (version >= ReplicaSchema.VERSION) return;
        db.beginTransaction();
        try {
            for (String statement : ReplicaSchema.DDL) db.execSQL(statement);
            db.setVersion(ReplicaSchema.VERSION);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
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
