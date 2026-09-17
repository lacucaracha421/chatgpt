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
final class LibraryReplicaStore implements AlbumReplica.State, ClassificationReplica.State {
    static final String MEMBERSHIP_COMMAND = "setAlbumMembership";

    static final class MembershipEdit {
        final boolean changed;
        final boolean desiredState;
        final long expectedRevision;
        final String operationId;

        MembershipEdit(boolean changed, boolean desiredState, long expectedRevision,
                       String operationId) {
            this.changed = changed;
            this.desiredState = desiredState;
            this.expectedRevision = expectedRevision;
            this.operationId = operationId;
        }
    }
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
        value.put("outboxPendingCount", 0L);
        value.put("outboxBlockedCount", 0L);
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
            long pending = 0, blocked = 0;
            for (ReplicaDb.OutboxRow row : db.outbox()) {
                if (row.blocked()) blocked++; else pending++;
            }
            value.put("outboxPendingCount", pending);
            value.put("outboxBlockedCount", blocked);
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
                db.clearOutbox();
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

    /** Durable outgoing intents for the owning connection, oldest first. */
    List<ReplicaDb.OutboxRow> outbox(String scope) {
        lock.lock();
        try {
            if (!owns(scope)) return java.util.Collections.emptyList();
            return new java.util.ArrayList<>(db.outbox());
        } finally {
            lock.unlock();
        }
    }

    /**
     * Apply one local membership choice and append its immutable command in one transaction.
     * The relation revision remains the last confirmed server revision; queued predecessors
     * predict the expectation for this command without pretending they were confirmed.
     */
    MembershipEdit queueMembership(String scope, String albumId, String assetId,
                                   boolean desiredState, String operationId, String now) {
        if (assetId == null || !assetId.matches("[A-Za-z0-9_-]{1,128}")) {
            throw new IllegalArgumentException("Invalid Asset id");
        }
        lock.lock();
        try {
            db.begin();
            try {
                ReplicaDb.StoredAuthority authority = db.authority();
                if (authority == null || !authority.scope.equals(scope)) {
                    throw new IllegalStateException("Album authority is not adopted");
                }
                boolean albumLive = false;
                for (AlbumReplica.Album album : db.albums(true)) {
                    if (album.id.equals(albumId)) { albumLive = true; break; }
                }
                if (!albumLive) throw new IllegalArgumentException("Unknown Album");
                AlbumReplica.Member current = db.member(albumId, assetId);
                boolean currentDesired = current != null && current.desiredState;
                long confirmedRevision = current == null ? 0 : current.entityRevision;
                List<ReplicaDb.OutboxRow> queued = db.outbox();
                long predecessorCount = 0;
                long nextSeq = 1;
                for (ReplicaDb.OutboxRow row : queued) {
                    nextSeq = Math.max(nextSeq, row.seq + 1);
                    if (row.albumId.equals(albumId) && row.assetId.equals(assetId)) {
                        if (row.blocked()) throw new IllegalStateException("Album membership is blocked");
                        predecessorCount++;
                    }
                }
                if (currentDesired == desiredState) {
                    db.rollback();
                    return new MembershipEdit(false, desiredState,
                            confirmedRevision + predecessorCount, operationId);
                }
                long expected = confirmedRevision + predecessorCount;
                String payload = membershipPayload(authority, operationId, albumId, assetId,
                        desiredState, expected);
                db.writeMember(new AlbumReplica.Member(albumId, assetId, desiredState,
                        confirmedRevision), now);
                db.writeOutbox(new ReplicaDb.OutboxRow(nextSeq, operationId, MEMBERSHIP_COMMAND,
                        albumId, assetId, authority.libraryId, authority.epoch,
                        authority.contractVersion, desiredState, expected, payload,
                        "pending", null, null, now));
                db.commit();
                return new MembershipEdit(true, desiredState, expected, operationId);
            } catch (RuntimeException failure) {
                try { db.rollback(); } catch (RuntimeException ignored) { }
                throw failure;
            }
        } finally {
            lock.unlock();
        }
    }

    /** Retire one accepted row while keeping any later optimistic choice visible. */
    void confirmMembership(String scope, long seq, AlbumReplica.Member confirmed, String now) {
        lock.lock();
        try {
            db.begin();
            try {
                if (!owns(scope)) throw new IllegalStateException("Album authority scope changed");
                ReplicaDb.OutboxRow accepted = null;
                for (ReplicaDb.OutboxRow row : db.outbox()) if (row.seq == seq) accepted = row;
                if (accepted == null || !accepted.albumId.equals(confirmed.albumId)
                        || !accepted.assetId.equals(confirmed.assetId)) {
                    throw new IllegalStateException("Album command outcome mismatch");
                }
                AlbumReplica.Member visible = db.member(confirmed.albumId, confirmed.assetId);
                boolean desired = visible == null ? confirmed.desiredState : visible.desiredState;
                db.writeMember(new AlbumReplica.Member(confirmed.albumId, confirmed.assetId,
                        desired, confirmed.entityRevision), now);
                db.deleteOutbox(seq);
                db.commit();
            } catch (RuntimeException failure) {
                try { db.rollback(); } catch (RuntimeException ignored) { }
                throw failure;
            }
        } finally {
            lock.unlock();
        }
    }

    /** Mark one semantic conflict durable; payload and operation id stay unchanged. */
    void blockMembership(String scope, long seq, String code, String detail) {
        lock.lock();
        try {
            db.begin();
            try {
                if (!owns(scope)) throw new IllegalStateException("Album authority scope changed");
                db.blockOutbox(seq, code, detail);
                db.commit();
            } catch (RuntimeException failure) {
                try { db.rollback(); } catch (RuntimeException ignored) { }
                throw failure;
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * Explicitly resolve the oldest blocked intent for one relation by accepting the
     * authoritative state that rejected it. The rejected row is retired, then every later
     * immutable intent is replayed as presentation only; none of those payloads is rebased.
     */
    void useServerMembership(String scope, String albumId, String assetId, String now) {
        lock.lock();
        try {
            db.begin();
            try {
                ReplicaDb.StoredAuthority authority = requireAuthority(scope);
                ReplicaDb.OutboxRow blocked = requireBlockedMembership(albumId, assetId);
                AlbumReplica.Member authoritative = authoritativeMembership(authority, blocked);
                db.writeMember(authoritative, now);
                db.deleteOutbox(blocked.seq);
                replayOutbox(authority, now);
                db.commit();
            } catch (RuntimeException failure) {
                try { db.rollback(); } catch (RuntimeException ignored) { }
                throw failure;
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * Explicitly retry the oldest blocked intent for one relation as a brand-new command.
     *
     * The old payload and operation id are never modified or reused. The fresh row takes
     * the old row's local sequence so it remains at the same FIFO position, but its CAS
     * revision and authority identity are composed from the authority state known now.
     */
    MembershipEdit retryBlockedMembership(String scope, String albumId, String assetId,
                                          String operationId, String now) {
        if (operationId == null || operationId.isEmpty() || operationId.length() > 128) {
            throw new IllegalArgumentException("Invalid operation id");
        }
        lock.lock();
        try {
            db.begin();
            try {
                ReplicaDb.StoredAuthority authority = requireAuthority(scope);
                ReplicaDb.OutboxRow blocked = requireBlockedMembership(albumId, assetId);
                AlbumReplica.Member authoritative = authoritativeMembership(authority, blocked);
                long expected = authoritative.entityRevision;
                String payload = membershipPayload(authority, operationId, albumId, assetId,
                        blocked.desiredState, expected);
                db.writeMember(authoritative, now);
                db.deleteOutbox(blocked.seq);
                db.writeOutbox(new ReplicaDb.OutboxRow(blocked.seq, operationId,
                        MEMBERSHIP_COMMAND, albumId, assetId, authority.libraryId, authority.epoch,
                        authority.contractVersion, blocked.desiredState, expected, payload,
                        "pending", null, null, now));
                replayOutbox(authority, now);
                db.commit();
                return new MembershipEdit(true, blocked.desiredState, expected, operationId);
            } catch (RuntimeException failure) {
                try { db.rollback(); } catch (RuntimeException ignored) { }
                throw failure;
            }
        } finally {
            lock.unlock();
        }
    }

    /** Caller holds {@link #lock} and an open database transaction. */
    private ReplicaDb.StoredAuthority requireAuthority(String scope) {
        ReplicaDb.StoredAuthority authority = db.authority();
        if (authority == null || !authority.scope.equals(scope)) {
            throw new IllegalStateException("Album authority is not adopted");
        }
        return authority;
    }

    /** Oldest blocked row for this relation. Caller holds {@link #lock}. */
    private ReplicaDb.OutboxRow requireBlockedMembership(String albumId, String assetId) {
        for (ReplicaDb.OutboxRow row : db.outbox()) {
            if (row.blocked() && row.albumId.equals(albumId) && row.assetId.equals(assetId)) {
                return row;
            }
        }
        throw new IllegalStateException("Album membership is not blocked");
    }

    /**
     * Recover the authoritative base represented by a durable conflict.
     *
     * A replacement authority has already installed a new baseline before stale-identity
     * rows are blocked, so its current relation row is the authoritative base. For a
     * same-identity revision conflict the server response itself is the only safe source
     * of the newer relation state. Known terminal membership rejections happen after the
     * previous confirmed toggle was observed and do not mutate the relation, so the
     * pre-toggle state/revision remains the base until receive catches up structurally.
     */
    private AlbumReplica.Member authoritativeMembership(ReplicaDb.StoredAuthority authority,
                                                        ReplicaDb.OutboxRow blocked) {
        boolean sameIdentity = blocked.libraryId.equals(authority.libraryId)
                && blocked.epoch == authority.epoch
                && blocked.contractVersion == authority.contractVersion;
        if (!sameIdentity) {
            AlbumReplica.Member current = db.member(blocked.albumId, blocked.assetId);
            return current == null
                    ? new AlbumReplica.Member(blocked.albumId, blocked.assetId, false, 0)
                    : current;
        }
        if ("revisionConflict".equals(blocked.conflictCode)) {
            return revisionConflictMembership(blocked);
        }
        if ("invalidAlbumMembership".equals(blocked.conflictCode)
                || "albumNotFound".equals(blocked.conflictCode)) {
            return new AlbumReplica.Member(blocked.albumId, blocked.assetId,
                    !blocked.desiredState, blocked.expectedRevision);
        }
        throw new IllegalStateException("Unsupported Album conflict state");
    }

    @SuppressWarnings("unchecked")
    private static AlbumReplica.Member revisionConflictMembership(ReplicaDb.OutboxRow blocked) {
        try {
            Object parsed = Json.parse(blocked.conflictDetail);
            if (!(parsed instanceof Map)) throw new IllegalArgumentException("Expected object");
            Map<String, Object> root = (Map<String, Object>) parsed;
            Object detailValue = root.get("detail");
            if (!(detailValue instanceof Map)) throw new IllegalArgumentException("Expected detail");
            Map<String, Object> detail = (Map<String, Object>) detailValue;
            if (!"revisionConflict".equals(detail.get("code"))) {
                throw new IllegalArgumentException("Unexpected conflict code");
            }
            Object currentValue = detail.get("current");
            if (!(currentValue instanceof Map)) throw new IllegalArgumentException("Expected current");
            Map<String, Object> current = (Map<String, Object>) currentValue;
            Object album = current.get("albumId");
            Object asset = current.get("assetId");
            Object desired = current.get("desiredState");
            Object revision = current.get("entityRevision");
            if (!(album instanceof String) || !(asset instanceof String)
                    || !(desired instanceof Boolean) || !(revision instanceof Long)
                    || !blocked.albumId.equals(album) || !blocked.assetId.equals(asset)
                    || ((Long) revision) < 0 || ((Boolean) desired) == blocked.desiredState) {
                throw new IllegalArgumentException("Invalid membership conflict projection");
            }
            return new AlbumReplica.Member((String) album, (String) asset,
                    (Boolean) desired, (Long) revision);
        } catch (RuntimeException malformed) {
            throw new IllegalStateException("Album conflict state is incomplete", malformed);
        }
    }

    /**
     * Reapply only intents composed for this exact authority identity.
     *
     * A replacement library/epoch/contract is a different revision lineage. Those rows
     * remain durable but become blocked in the same transaction that installs the new
     * confirmed state, so an old optimistic choice can never appear inside the new library.
     */
    private void replayOutbox(ReplicaDb.StoredAuthority authority, String now) {
        for (ReplicaDb.OutboxRow row : db.outbox()) {
            String mismatch = null;
            if (!row.libraryId.equals(authority.libraryId)) mismatch = AlbumReplica.CODE_LIBRARY_MISMATCH;
            else if (row.epoch != authority.epoch) mismatch = "epochMismatch";
            else if (row.contractVersion != authority.contractVersion) mismatch = AlbumReplica.CODE_CONTRACT_UNSUPPORTED;
            if (mismatch != null) {
                if (!row.blocked()) db.blockOutbox(row.seq, mismatch, null);
                continue;
            }
            if (row.blocked()) continue;
            AlbumReplica.Member current = db.member(row.albumId, row.assetId);
            long revision = current == null ? 0 : current.entityRevision;
            db.writeMember(new AlbumReplica.Member(row.albumId, row.assetId,
                    row.desiredState, revision), now);
        }
    }

    private static String membershipPayload(ReplicaDb.StoredAuthority authority, String operationId,
                                            String albumId, String assetId, boolean desiredState,
                                            long expectedRevision) {
        return "{\"libraryId\":" + quote(authority.libraryId)
                + ",\"epoch\":" + authority.epoch
                + ",\"contractVersion\":" + authority.contractVersion
                + ",\"operationId\":" + quote(operationId)
                + ",\"commandType\":\"setAlbumMembership\""
                + ",\"albumId\":" + quote(albumId)
                + ",\"assetId\":" + quote(assetId)
                + ",\"desiredState\":" + desiredState
                + ",\"expectedRevision\":" + expectedRevision + "}";
    }

    private static String quote(String value) {
        StringBuilder out = new StringBuilder(value.length() + 2).append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
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
                ReplicaDb.StoredAuthority stored = new ReplicaDb.StoredAuthority(authority.scope,
                        authority.libraryId, authority.epoch, authority.contractVersion,
                        authority.cursor, authority.adoptedAt, authority.reconciledAt);
                db.writeAuthority(stored);
                replayOutbox(stored, now);
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
                // A receive can race a local edit that arrived after the pass checked the
                // queue. Replaying the durable intents inside this same transaction keeps
                // the user-visible desired state from being overwritten by confirmed rows.
                replayOutbox(stored, now);
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

    // -----------------------------------------------------------------------
    // Classification read replica
    // -----------------------------------------------------------------------

    /** The adopted Classification authority for this scope, or null. */
    @Override
    public ClassificationReplica.Adopted classificationAdopted(String scope) {
        lock.lock();
        try {
            ReplicaDb.StoredAuthority stored = db.classificationAuthority();
            if (stored == null || !stored.scope.equals(scope)) return null;
            return new ClassificationReplica.Adopted(stored.scope, stored.libraryId, stored.epoch,
                    stored.contractVersion, stored.cursor, stored.adoptedAt, stored.reconciledAt);
        } finally {
            lock.unlock();
        }
    }

    /**
     * Classification revision state for `scope`, keyed by id.
     *
     * Tombsones are retained and returned unless `liveOnly`: a deleted Classification's
     * revision is state a later command must present, so it is not absence. Rows are hidden
     * rather than deleted for a scope that does not own the stored authority.
     */
    @Override
    public Map<String, ClassificationReplica.Node> classificationNodes(String scope, boolean liveOnly) {
        lock.lock();
        try {
            Map<String, ClassificationReplica.Node> result = new LinkedHashMap<>();
            ReplicaDb.StoredAuthority stored = db.classificationAuthority();
            if (stored == null || !stored.scope.equals(scope)) return result;
            for (ClassificationReplica.Node node : db.classifications(liveOnly)) {
                result.put(node.id, node);
            }
            return result;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Assignment lineage state for `scope`, keyed by Asset id.
     *
     * An entry whose `classificationId` is null is an authoritative *unassigned* state at a
     * real revision, not a missing row. Consumers that publish visible membership must
     * therefore test the value, not the key's presence.
     */
    @Override
    public Map<String, ClassificationReplica.Assignment> classificationAssignments(String scope) {
        lock.lock();
        try {
            Map<String, ClassificationReplica.Assignment> result = new LinkedHashMap<>();
            ReplicaDb.StoredAuthority stored = db.classificationAuthority();
            if (stored == null || !stored.scope.equals(scope)) return result;
            for (ClassificationReplica.Assignment assignment : db.assignments()) {
                result.put(assignment.assetId, assignment);
            }
            return result;
        } finally {
            lock.unlock();
        }
    }

    /** The adopted `originals` binding for `scope`, or null when unadopted. */
    @Override
    public String classificationRole(String scope) {
        lock.lock();
        try {
            ReplicaDb.StoredAuthority stored = db.classificationAuthority();
            if (stored == null || !stored.scope.equals(scope)) return null;
            return db.classificationRole(ClassificationReplica.ORIGINALS_ROLE);
        } finally {
            lock.unlock();
        }
    }

    /** Diagnostic counts for the Classification domain and scope. */
    @Override
    public Map<String, Object> classificationStatus(String scope) {
        lock.lock();
        try {
            Map<String, Object> value = new LinkedHashMap<>();
            ReplicaDb.StoredAuthority stored = db.classificationAuthority();
            if (stored == null || !stored.scope.equals(scope)) {
                value.put("classificationCount", 0L);
                value.put("classificationTombstoneCount", 0L);
                value.put("assignmentCount", 0L);
                value.put("assignmentTombstoneCount", 0L);
                return value;
            }
            long live = 0, tombstoned = 0;
            for (ClassificationReplica.Node node : db.classifications(false)) {
                if (node.deleted) tombstoned++; else live++;
            }
            long assigned = 0, unassigned = 0;
            for (ClassificationReplica.Assignment assignment : db.assignments()) {
                if (assignment.classificationId == null) unassigned++; else assigned++;
            }
            value.put("classificationCount", live);
            value.put("classificationTombstoneCount", tombstoned);
            value.put("assignmentCount", assigned);
            value.put("assignmentTombstoneCount", unassigned);
            return value;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Replace this domain's replica with a complete baseline, as one unit.
     *
     * Only Classification rows are touched: Album state, Asset metadata, media bytes and
     * caches belong to other domains and other storage, and losing a replica must never
     * mean losing user media. The immutable role is installed in the same transaction, so a
     * replica can never hold Classifications without the binding that interprets them.
     */
    @Override
    public void installBaseline(ClassificationReplica.Adopted authority,
                                List<ClassificationReplica.Node> classifications,
                                List<ClassificationReplica.Assignment> assignments,
                                List<ClassificationReplica.Role> roles, String now) {
        lock.lock();
        try {
            db.begin();
            try {
                db.clearClassificationRole();
                db.clearAssignments();
                db.clearClassifications();
                for (ClassificationReplica.Node node : classifications) {
                    // A baseline never lists a deleted Classification, so a row arriving here
                    // is live state and the tombstone flag stays false.
                    if (!node.deleted) db.writeClassification(node, now);
                }
                for (ClassificationReplica.Assignment assignment : assignments) {
                    db.writeAssignment(assignment, now);
                }
                for (ClassificationReplica.Role role : roles) {
                    db.writeClassificationRole(role.role, role.classificationId);
                }
                db.writeClassificationAuthority(new ReplicaDb.StoredAuthority(authority.scope,
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
    public void applyClassificationChanges(String scope, long cursor,
                                          List<ClassificationReplica.Change> changes, String now)
            throws ClassificationReplica.Failure {
        lock.lock();
        try {
            db.begin();
            try {
                ReplicaDb.StoredAuthority stored = db.classificationAuthority();
                if (stored == null || !stored.scope.equals(scope) || stored.cursor != cursor) {
                    throw ClassificationReplica.malformed();
                }
                ClassificationReplica.requireContiguous(changes, stored.cursor);
                for (ClassificationReplica.Change change : changes) {
                    // A structural change writes the tombstone too; an assignment change
                    // writes the lineage value exactly as sent, so an authoritative unassign
                    // is retained as a row rather than mistaken for a never-seen Asset.
                    if (change.classification != null) {
                        db.writeClassification(change.classification, now);
                    }
                    if (change.assignment != null) {
                        db.writeAssignment(change.assignment, now);
                    }
                    if (change.transition != null) {
                        // The tombstone was written above and *is* the retained revision:
                        // this domain keeps one row per Classification with a `deleted`
                        // flag, so a deleted node stays readable at its real revision while
                        // `liveOnly` reads keep it out of every visible projection. The
                        // transition is the rest of the same indivisible change, and it is
                        // applied rather than re-derived so the replica reproduces the
                        // server's own revision numbers.
                        applyTransition(change.transition, now);
                    }
                }
                if (!changes.isEmpty()) {
                    db.setClassificationCursor(changes.get(changes.size() - 1).sequence, now);
                }
                db.commit();
            } catch (ClassificationReplica.Failure rejected) {
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

    /**
     * Apply a delete's assignment transition.
     *
     * The count is verified against this replica's retained assignment rows for that
     * Classification. Absence from a delta page is never read as deletion, and the baseline
     * carries every assignment row including unassigned ones, so this replica holds the
     * complete lineage and a count that disagrees is real divergence rather than a
     * legitimate difference in what has been materialized.
     */
    private void applyTransition(ClassificationReplica.Transition transition, String now)
            throws ClassificationReplica.Failure {
        long affected = 0;
        for (ClassificationReplica.Assignment assignment : db.assignments()) {
            if (transition.fromClassificationId.equals(assignment.classificationId)) affected++;
        }
        if (affected != transition.affectsAssignments) throw ClassificationReplica.malformed();
        db.applyAssignmentTransition(transition.fromClassificationId, transition.toClassificationId,
                now);
    }

    /** Record a successful pass that produced no change, so status shows freshness. */
    @Override
    public void touchClassification(String scope, String now) {
        lock.lock();
        try {
            ReplicaDb.StoredAuthority stored = db.classificationAuthority();
            if (stored != null && stored.scope.equals(scope)) db.setClassificationReconciledAt(now);
        } finally {
            lock.unlock();
        }
    }

    /**
     * Discard this connection's Classification replica.
     *
     * Classification rows only. Album, Bookmark and user media state are separate domains
     * with separate lifetimes, so a Classification reset cannot take them with it.
     */
    @Override
    public void clearClassifications() {
        lock.lock();
        try {
            db.begin();
            try {
                db.clearClassificationRole();
                db.clearAssignments();
                db.clearClassifications();
                db.clearClassificationAuthority();
                db.commit();
            } catch (RuntimeException failure) {
                db.rollback();
                throw failure;
            }
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
