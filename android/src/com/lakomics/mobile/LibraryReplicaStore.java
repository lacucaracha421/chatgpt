package com.lakomics.mobile;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The durable Android Library replica store.
 *
 * One store holds shared Library replica state for every replicated domain, deliberately
 * separate from `notes.sqlite`: Notes is an encrypted personal domain with its own sync
 * rules, and merging the two would couple an encrypted store to a plaintext authority
 * replica that has to be replaceable wholesale.
 *
 * This class owns every rule about what the replica holds — which rows are written, which
 * are retained as tombstones, when the cursor moves, and what belongs to one transaction.
 * {@link ReplicaDb} only moves typed rows, so the rules below run unchanged against the
 * Android database and against a real SQLite engine in the check harness.
 *
 * All operations take one reentrant lock, because the connection is shared: a page apply
 * and its cursor advance must not be able to interleave with a baseline install.
 */
final class LibraryReplicaStore implements AlbumReplica.State {
    private final ReplicaDb db;
    private final ReentrantLock lock = new ReentrantLock();

    LibraryReplicaStore(ReplicaDb db) {
        this.db = db;
    }

    void close() {
        lock.lock();
        try {
            db.close();
        } finally {
            lock.unlock();
        }
    }

    // -----------------------------------------------------------------------
    // Authority identity (Scope H)
    // -----------------------------------------------------------------------

    /**
     * The adopted Album authority for this connection scope, or null.
     *
     * Rows written under another connection are invisible rather than overwritten: a
     * replaced account cannot see the previous one's replica even if the new connection
     * never issued an explicit reset.
     */
    @Override
    public AlbumReplica.Adopted adopted(String scope) {
        lock.lock();
        try {
            ReplicaDb.StoredAuthority stored = db.authority();
            if (!owns(scope)) return null;
            return new AlbumReplica.Adopted(stored.scope, stored.libraryId, stored.epoch,
                    stored.contractVersion, stored.cursor, stored.adoptedAt, stored.reconciledAt);
        } finally {
            lock.unlock();
        }
    }

    /**
     * Whether the stored authority belongs to `scope`. Caller holds {@link #lock}.
     *
     * Every scoped read goes through this, so "which connection owns these rows" is
     * answered under the same lock as the rows themselves. Reading the authority and the
     * rows in two separate critical sections would let a replacement land between them and
     * serve one connection's rows under another's identity.
     */
    private boolean owns(String scope) {
        ReplicaDb.StoredAuthority stored = db.authority();
        return stored != null && stored.scope.equals(scope);
    }

    /** A diagnostic map for a scope that owns nothing: visible and retained counts are zero. */
    private static Map<String, Object> zeroCounts() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("albumCount", 0L);
        value.put("albumTombstoneCount", 0L);
        value.put("membershipCount", 0L);
        value.put("membershipTombstoneCount", 0L);
        return value;
    }

    /**
     * Diagnostics for the native/WebView status surface.
     *
     * Counts are of *visible* state, with retained tombstones reported separately, so
     * revision state that must not be shown is still observable as retained.
     *
     * Counts are scoped for the same reason rows are: a diagnostic that reported another
     * connection's totals would leak the previous account's shape, and would contradict the
     * `adopted(scope) == null` answer the same caller receives.
     */
    @Override
    public Map<String, Object> status(String scope) {
        lock.lock();
        try {
            if (!owns(scope)) return zeroCounts();
            long albums = 0;
            long albumTombstones = 0;
            for (AlbumReplica.Album album : db.albums(false)) {
                if (album.deleted) albumTombstones++;
                else albums++;
            }
            long members = 0;
            long memberTombstones = 0;
            for (AlbumReplica.Member member : db.members(false)) {
                if (member.desiredState) members++;
                else memberTombstones++;
            }
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("albumCount", albums);
            value.put("albumTombstoneCount", albumTombstones);
            value.put("membershipCount", members);
            value.put("membershipTombstoneCount", memberTombstones);
            return value;
        } finally {
            lock.unlock();
        }
    }

    /** Discard the replica. Used only by an explicit connection/account change. */
    @Override
    public void clear() {
        lock.lock();
        try {
            db.begin();
            try {
                db.clearMembers();
                db.clearAlbums();
                db.clearAuthority();
                db.commit();
            } catch (RuntimeException failure) {
                db.rollback();
                throw failure;
            }
        } finally {
            lock.unlock();
        }
    }

    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------

    /**
     * Album revision state, including tombstones, keyed by id.
     *
     * Empty for a scope that does not own the stored authority. The rows are hidden, never
     * deleted: a replacement is the explicit operation that clears them, and a mismatched
     * read is not a reason to destroy durable revision state.
     */
    @Override
    public Map<String, AlbumReplica.Album> albums(String scope, boolean liveOnly) {
        lock.lock();
        try {
            Map<String, AlbumReplica.Album> result = new LinkedHashMap<>();
            if (!owns(scope)) return result;
            for (AlbumReplica.Album album : db.albums(liveOnly)) result.put(album.id, album);
            return result;
        } finally {
            lock.unlock();
        }
    }

    /** Relation revision state, including tombstones, keyed `albumId:assetId`. */
    @Override
    public Map<String, AlbumReplica.Member> memberships(String scope, boolean liveOnly) {
        lock.lock();
        try {
            Map<String, AlbumReplica.Member> result = new LinkedHashMap<>();
            if (!owns(scope)) return result;
            for (AlbumReplica.Member member : db.members(liveOnly)) {
                result.put(member.albumId + ":" + member.assetId, member);
            }
            return result;
        } finally {
            lock.unlock();
        }
    }

    // -----------------------------------------------------------------------
    // Writes
    // -----------------------------------------------------------------------

    /**
     * Replace the Album replica with a complete baseline, as one unit.
     *
     * Only this domain's rows are touched. Asset metadata, media bytes and caches are
     * untouched, because losing replica metadata must never mean losing user media.
     */
    @Override
    public void installBaseline(AlbumReplica.Adopted authority, List<AlbumReplica.Album> albums,
                                List<AlbumReplica.Member> members, String now) {
        lock.lock();
        try {
            db.begin();
            try {
                db.clearMembers();
                db.clearAlbums();
                for (AlbumReplica.Album album : albums) {
                    // A baseline never lists a deleted Album, so a row arriving here is
                    // live state and the tombstone flag stays false.
                    if (!album.deleted) db.writeAlbum(album, now);
                }
                for (AlbumReplica.Member member : members) db.writeMember(member, now);
                db.writeAuthority(new ReplicaDb.StoredAuthority(authority.scope,
                        authority.libraryId, authority.epoch, authority.contractVersion,
                        authority.cursor, authority.adoptedAt, authority.reconciledAt));
                db.commit();
            } catch (RuntimeException failure) {
                db.rollback();
                throw failure;
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * Apply one validated change page and advance the cursor together.
     *
     * Contiguity is re-checked here against the stored cursor inside the transaction: the
     * check and the write must describe the same starting point, or a concurrent writer
     * could be advanced over. A rejected page writes nothing and moves no cursor.
     */
    @Override
    public void applyChanges(String scope, long cursor, List<AlbumReplica.Change> changes, String now)
            throws AlbumReplica.Failure {
        lock.lock();
        try {
            db.begin();
            try {
                ReplicaDb.StoredAuthority stored = db.authority();
                if (stored == null || !stored.scope.equals(scope) || stored.cursor != cursor) {
                    throw AlbumReplica.malformed();
                }
                AlbumReplica.requireContiguous(changes, stored.cursor);
                for (AlbumReplica.Change change : changes) {
                    // A structural change writes the tombstone too; a membership change
                    // writes desiredState exactly as sent, so a removal is retained as a
                    // tombstone revision rather than deleted.
                    if (change.album != null) applyAlbum(change.album, now);
                    if (change.member != null) db.writeMember(change.member, now);
                }
                if (!changes.isEmpty()) {
                    db.setCursor(changes.get(changes.size() - 1).sequence, now);
                }
                db.commit();
            } catch (AlbumReplica.Failure rejected) {
                db.rollback();
                throw rejected;
            } catch (RuntimeException failure) {
                db.rollback();
                throw failure;
            }
        } finally {
            lock.unlock();
        }
    }

    /** Record a successful pass that produced no change, so status shows freshness. */
    @Override
    public void touch(String scope, String now) {
        lock.lock();
        try {
            ReplicaDb.StoredAuthority stored = db.authority();
            if (stored != null && stored.scope.equals(scope)) db.setReconciledAt(now);
        } finally {
            lock.unlock();
        }
    }

    private void applyAlbum(AlbumReplica.Album album, String now) {
        if (album.deleted) {
            // The visible relations go; the tombstone row stays so the Album revision
            // remains readable. Each relation keeps its own revision rather than being
            // bumped or deleted, because the delete change row carries only the Album
            // tombstone: inventing a relation revision here would create state no replay
            // of that row could reproduce.
            db.retireLiveMembers(album.id, now);
        }
        db.writeAlbum(album, now);
    }
}
