package com.lakomics.mobile;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Album authority receive on Android: baseline adoption and ordered change replay.
 *
 * Android is already a replica, so this engine never compares a baseline against local
 * canonical state the way the main PC must. There is also no outbox here: this batch
 * emits no Album command at all, and the absence is enforced by the network allowlist
 * rather than by convention, so a future editing batch cannot appear by accident.
 *
 * Two invariants carry correctness, and both are enforced where they can be observed
 * rather than trusted:
 *
 * 1. **Nothing local changes until a baseline is complete.** Every page of one frozen
 *    snapshot is accumulated outside the replica and only installed once the final
 *    membership page reports `complete`, so a failed or interrupted walk leaves the
 *    previous replica exactly as it was.
 * 2. **A change page and its cursor commit together.** Contiguity is checked against
 *    the stored cursor inside the same transaction that writes the page, so the cursor
 *    can never advance over a change that was not applied.
 *
 * Every failure is a coded {@link AlbumReplica.Failure}, because the server's own
 * states share status codes: `cursorExpired`, `cursorAhead` and `baselineChanged` are
 * all 409 and all recover by adopting a fresh baseline, while `authorityInactive` and
 * `authorityContractUnsupported` must never be answered by writing anything.
 */
final class AlbumAuthoritySync {
    /**
     * Attempts at one frozen baseline walk before deferring to the poll loop.
     *
     * Any Album command advances the domain cursor, so a concurrent change invalidates
     * a frozen snapshot mid-walk. Retrying here converges once the domain is briefly
     * quiet; the foreground poll is the retry of last resort, so this stays bounded
     * rather than spinning.
     */
    static final int BASELINE_ATTEMPTS = 3;

    private final AlbumReplica.Transport transport;
    private final AlbumReplica.State state;
    private final AlbumReplica.Clock clock;

    AlbumAuthoritySync(AlbumReplica.Transport transport, AlbumReplica.State state,
                       AlbumReplica.Clock clock) {
        this.transport = transport;
        this.state = state;
        this.clock = clock;
    }

    /** Outcome of one reconciliation pass, for the status surface and the schedule. */
    static final class Result {
        /** True when an authority for this scope is stored in the replica. */
        boolean adopted;
        /** True when this pass installed a baseline (first adoption or re-adoption). */
        boolean adoptedBaseline;
        /** True when this pass replaced the replica because its identity changed. */
        boolean readopted;
        int appliedChanges;
        Long serverCursor;
        Long localCursor;
        String code;
        boolean retryable;
        String libraryId;
        long epoch;

        Map<String, Object> toJson() {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("adopted", adopted);
            value.put("adoptedBaseline", adoptedBaseline);
            value.put("readopted", readopted);
            value.put("appliedChanges", appliedChanges);
            value.put("serverCursor", serverCursor);
            value.put("localCursor", localCursor);
            value.put("libraryId", libraryId);
            value.put("epoch", adopted ? epoch : null);
            value.put("code", code);
            value.put("retryable", retryable);
            return value;
        }
    }

    /**
     * The adopted Album authority for this connection scope, or null.
     *
     * Read without any network access, so a consumer can ask "is this Android
     * installation an Album replica yet" while offline.
     */
    AlbumReplica.Adopted adopted(String scope) {
        return state.adopted(scope);
    }

    /**
     * Diagnostic counts for `scope`.
     *
     * Scoped deliberately: a consumer must ask for the connection it is displaying, so the
     * counts cannot describe a replica belonging to a connection the caller is not showing.
     */
    Map<String, Object> status(String scope) {
        return state.status(scope);
    }

    /**
     * Live Albums for `scope`, for a 2C-2 consumer. Never exposes tombstones as Albums.
     *
     * The scope is a required argument rather than an implicit field on the engine: an
     * unscoped accessor is exactly the path that let a replaced connection's rows be read
     * under the new one, and leaving one available would invite a future consumer to use it.
     */
    Map<String, AlbumReplica.Album> liveAlbums(String scope) {
        return state.albums(scope, true);
    }

    /** Live membership relations for `scope`, keyed `albumId:assetId`. */
    Map<String, AlbumReplica.Member> liveMemberships(String scope) {
        return state.memberships(scope, true);
    }

    /** Discard this connection's replica. Called only on an explicit connection change. */
    void reset() {
        state.clear();
    }

    /**
     * One reconcile pass: discover, adopt or catch up, then report.
     *
     * `scope` is the opaque connection identity the replica is stored under. It is
     * compared before anything is written, so rows written under another account can
     * never be served as this one's state.
     */
    Result reconcile(String scope) {
        Result result = new Result();
        AlbumReplica.Adopted local = state.adopted(scope);
        result.adopted = local != null;
        if (local != null) {
            result.libraryId = local.libraryId;
            result.epoch = local.epoch;
            result.localCursor = local.cursor;
        }
        try {
            AlbumReplica.Status status = discover();
            AlbumReplica.Domain remote = status.domain();
            if (remote == null) {
                // No active `albums` authority: the domain is still PC-owned, so nothing
                // is adopted and no existing replica is touched. An already-adopted
                // replica is reported as such rather than silently discarded, because
                // authority going inactive is not proof that its state became invalid.
                return result;
            }
            if (remote.contractVersion != AlbumReplica.CONTRACT_VERSION) {
                // Fails closed: a contract this build does not implement must not be
                // approximated, and the stored replica is left alone.
                result.code = AlbumReplica.CODE_CONTRACT_UNSUPPORTED;
                return result;
            }
            result.serverCursor = remote.cursor;
            result.libraryId = remote.libraryId;
            result.epoch = remote.epoch;
            if (local == null) {
                return adopt(scope, remote, result, false);
            }
            if (!local.libraryId.equals(remote.libraryId) || local.epoch != remote.epoch) {
                // A different library or epoch is a different authority, so the stored
                // cursor and rows describe something else. Re-adoption is the only
                // correct response; there is no incremental path across identities.
                return adopt(scope, remote, result, true);
            }
            if (local.contractVersion != remote.contractVersion) {
                return adopt(scope, remote, result, true);
            }
            try {
                applyChanges(scope, local, result);
                return result;
            } catch (AlbumReplica.Failure failure) {
                result.code = failure.code;
                result.retryable = failure.retryable;
                if (!recoverable(failure)) {
                    result.appliedChanges = 0;
                    result.localCursor = state.adopted(scope) == null ? null : local.cursor;
                    return result;
                }
                // Expiry means retained history no longer covers this cursor, and a
                // cursor ahead of the server means the identity is skewed. Both recover
                // the same way — a fresh complete baseline replaces only this domain's
                // replica. That is safe precisely because this batch has no write queue:
                // there is no unaccepted local intent that a baseline could overwrite.
                Result recovered = adopt(scope, remote, result, true);
                recovered.code = failure.code;
                return recovered;
            }
        } catch (AlbumReplica.Failure failure) {
            result.code = failure.code;
            result.retryable = failure.retryable;
            return result;
        }
    }

    private static boolean recoverable(AlbumReplica.Failure failure) {
        return AlbumReplica.CODE_CURSOR_EXPIRED.equals(failure.code)
                || AlbumReplica.CODE_CURSOR_AHEAD.equals(failure.code)
                || AlbumReplica.CODE_BASELINE_CHANGED.equals(failure.code);
    }

    /** Read and validate the aggregate domain status. */
    private AlbumReplica.Status discover() throws AlbumReplica.Failure {
        Object document = get(AlbumReplica.statusPath(), true);
        return AlbumReplica.parseStatus(document);
    }

    /**
     * Walk every page of one frozen baseline, then install it in one transaction.
     *
     * `replace` distinguishes a first adoption from re-adoption after an identity
     * change. Neither path compares against existing local Album state: on Android that
     * state *is* a replica, so a difference is convergence rather than data loss.
     */
    private Result adopt(String scope, AlbumReplica.Domain remote, Result result, boolean replace)
            throws AlbumReplica.Failure {
        AlbumReplica.Adopted previous = state.adopted(scope);
        int attempt = 0;
        while (true) {
            attempt++;
            try {
                Baseline baseline = fetch(remote);
                String now = clock.now();
                AlbumReplica.Adopted authority = new AlbumReplica.Adopted(scope, remote.libraryId,
                        remote.epoch, remote.contractVersion, baseline.cursor, now, now);
                state.installBaseline(authority, baseline.albums, baseline.members, now);
                result.adopted = true;
                result.adoptedBaseline = true;
                result.readopted = replace && previous != null;
                result.localCursor = baseline.cursor;
                // The adopted cursor is the snapshot's, not the `/status` reading from
                // before the walk: only the former describes the state just installed.
                result.serverCursor = baseline.cursor;
                result.libraryId = remote.libraryId;
                result.epoch = remote.epoch;
                result.code = null;
                return result;
            } catch (AlbumReplica.Failure failure) {
                if (AlbumReplica.CODE_BASELINE_CHANGED.equals(failure.code)
                        && attempt < BASELINE_ATTEMPTS) {
                    continue;
                }
                throw failure;
            }
        }
    }

    /** The complete Album state a baseline describes, accumulated outside the replica. */
    private static final class Baseline {
        final List<AlbumReplica.Album> albums = new ArrayList<>();
        final List<AlbumReplica.Member> members = new ArrayList<>();
        long cursor;
    }

    /**
     * Fetch every page of one frozen snapshot.
     *
     * A mutation between pages returns `baselineChanged`, and pages that report
     * different snapshot cursors cannot describe one materialized state, so both are
     * rejected rather than combined. Nothing has been written at this point, which is
     * what makes "a failure leaves the old replica untouched" true by construction.
     */
    private Baseline fetch(AlbumReplica.Domain remote) throws AlbumReplica.Failure {
        Baseline baseline = new Baseline();
        Long snapshot = null;
        String section = AlbumReplica.SECTION_ALBUMS;
        String after = null;
        for (int page = 0; page < AlbumReplica.MAX_PAGES; page++) {
            String path = AlbumReplica.baselinePath(remote.libraryId, remote.epoch, snapshot,
                    snapshot == null ? null : section, after);
            AlbumReplica.Page decoded = AlbumReplica.parseBaselinePage(get(path, false),
                    remote.libraryId, remote.epoch, section);
            if (snapshot == null) {
                snapshot = decoded.snapshotCursor;
            } else if (decoded.snapshotCursor != snapshot.longValue()) {
                throw new AlbumReplica.Failure(AlbumReplica.CODE_BASELINE_CHANGED, true);
            }
            if (AlbumReplica.SECTION_ALBUMS.equals(decoded.section)) {
                if (baseline.albums.size() + decoded.albums.size() > AlbumReplica.MAX_ALBUMS) {
                    throw AlbumReplica.malformed();
                }
                baseline.albums.addAll(decoded.albums);
            } else {
                if (baseline.members.size() + decoded.members.size() > AlbumReplica.MAX_MEMBERSHIPS) {
                    throw AlbumReplica.malformed();
                }
                baseline.members.addAll(decoded.members);
            }
            if (decoded.hasMore) {
                after = decoded.nextAfter;
                continue;
            }
            if (AlbumReplica.SECTION_ALBUMS.equals(section)) {
                section = AlbumReplica.SECTION_MEMBERSHIPS;
                after = null;
                continue;
            }
            // The parser is what refuses a final membership page that is not marked
            // complete, so no page subset can ever be mistaken for a whole baseline.
            baseline.cursor = decoded.snapshotCursor;
            return baseline;
        }
        throw AlbumReplica.malformed();
    }

    /**
     * Apply the ordered change log until it is exhausted.
     *
     * Progress is measured against the cursor a page was *requested* from. Comparing a
     * freshly assigned cursor against itself can never fail, which would report every
     * honest `hasMore` as a protocol error and permanently cap catch-up at one page.
     */
    private void applyChanges(String scope, AlbumReplica.Adopted local, Result result)
            throws AlbumReplica.Failure {
        long cursor = local.cursor;
        for (int page = 0; page < AlbumReplica.MAX_PAGES; page++) {
            long requested = cursor;
            AlbumReplica.Changes changes = AlbumReplica.parseChanges(
                    get(AlbumReplica.changesPath(local.libraryId, local.epoch, requested), false),
                    local.libraryId, local.epoch, requested);
            if (!changes.items.isEmpty()) {
                // Contiguity is checked by the store inside the same transaction that
                // writes the rows and the cursor, so the two cannot diverge.
                state.applyChanges(scope, requested, changes.items, clock.now());
                result.appliedChanges += changes.items.size();
                cursor = changes.nextAfter;
            }
            result.localCursor = cursor;
            if (!changes.hasMore) {
                if (changes.items.isEmpty()) state.touch(scope, clock.now());
                return;
            }
            // A page claiming more work must have advanced past the cursor it was requested
            // from. The parser proves `hasMore` agrees with the advertised server cursor,
            // but that alone is not progress: a page with no rows and an unchanged cursor
            // can satisfy it, and answering it would request the same page forever.
            if (changes.nextAfter <= requested) throw AlbumReplica.malformed();
        }
        // An unbounded walk is refused rather than continued: the poll loop retries.
        throw new AlbumReplica.Failure(AlbumReplica.CODE_CURSOR_EXPIRED, true);
    }

    /** One authenticated read, mapping rejected responses to their coded state. */
    private Object get(String path, boolean syncStatus) throws AlbumReplica.Failure {
        String body;
        try {
            body = transport.get(path);
        } catch (AlbumReplica.HttpFailure failure) {
            throw AlbumReplica.mapFailure(failure.status, failure.body, syncStatus);
        } catch (Exception transportFailure) {
            throw new AlbumReplica.Failure(AlbumReplica.CODE_TRANSPORT, true);
        }
        try {
            return Json.parse(body);
        } catch (RuntimeException invalid) {
            throw AlbumReplica.malformed();
        }
    }
}
