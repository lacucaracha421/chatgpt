package com.lakomics.mobile;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The Android Album-authority replica contract: types, paths and validation.
 *
 * This is deliberately Android-independent so the rules that decide what the replica
 * accepts can be checked in the JVM harness, exactly like {@link PickerSnapshot} and
 * {@code DocumentTreePolicy}. It is *not* the legacy `album_replica` display snapshot:
 * that mixed Album state with Asset display state, while this domain is only Album
 * identity/appearance/hierarchy plus Asset↔Album relations.
 *
 * The server is the authority, so nothing here re-implements server policy. Validation
 * is bounded and typed instead: a response must carry the exact identity, contract and
 * shape the domain defines, and everything else is a malformed response rather than
 * something to interpret leniently. Bounds mirror the server's documented domain
 * maxima and exist so a misbehaving server cannot make this client allocate without
 * limit.
 */
final class AlbumReplica {
    /** The shared domain name the server reports this authority under. */
    static final String DOMAIN = "albums";
    /** The Album domain contract this build speaks. */
    static final int CONTRACT_VERSION = 1;
    /** Version of the aggregate `/v1/sync/status` document, not of this domain. */
    static final int PROTOCOL_VERSION = 1;

    /** Documented domain maxima, mirrored from the server contract. */
    static final int MAX_ALBUMS = 2_000;
    static final int MAX_MEMBERSHIPS = 100_000;
    /** Page sizes the server accepts, one per section. */
    static final int ALBUM_PAGE = 1_000;
    static final int MEMBERSHIP_PAGE = 2_000;
    /** Catch-up page size. The server bounds `limit` to 1..=500. */
    static final int CHANGE_PAGE = 100;
    /** Safety valve: refuse an unbounded walk rather than loop forever. */
    static final int MAX_PAGES = 10_000;

    static final String SECTION_ALBUMS = "albums";
    static final String SECTION_MEMBERSHIPS = "memberships";

    static final String SYNC_STATUS_PATH = "/v1/sync/status";
    static final String BASELINE_PATH = "/v1/albums/baseline";
    static final String CHANGES_PATH = "/v1/albums/changes";

    /** The six command types this contract version can emit. */
    static final String[] COMMAND_TYPES = {"createAlbum", "renameAlbum", "moveAlbum",
            "updateAlbumAppearance", "deleteAlbum", "setAlbumMembership"};

    // Coded authority states, one vocabulary with the server and the PC.
    static final String CODE_INACTIVE = "authorityInactive";
    static final String CODE_AMBIGUOUS = "authorityAmbiguous";
    static final String CODE_LIBRARY_MISMATCH = "authorityLibraryMismatch";
    static final String CODE_CONTRACT_UNSUPPORTED = "authorityContractUnsupported";
    static final String CODE_CURSOR_EXPIRED = "cursorExpired";
    static final String CODE_CURSOR_AHEAD = "cursorAhead";
    static final String CODE_BASELINE_CHANGED = "baselineChanged";
    static final String CODE_BASELINE_TOO_LARGE = "baselinePageTooLarge";
    // Client-side states this build reports itself.
    static final String CODE_UNAUTHORIZED = "unauthorized";
    static final String CODE_UNEXPECTED_STATUS = "unexpectedStatus";
    static final String CODE_MALFORMED = "malformedResponse";
    static final String CODE_TRANSPORT = "transportFailure";
    static final String CODE_SYNC_STATUS_UNAVAILABLE = "syncStatusUnavailable";
    static final String CODE_STORE_UNAVAILABLE = "replicaStoreUnavailable";

    private static final Pattern LIBRARY_ID = Pattern.compile("^[0-9a-f]{32}$");
    private static final Pattern ENTITY_ID = Pattern.compile("^[A-Za-z0-9_-]{1,128}$");
    private static final int MAX_NAME_CODE_POINTS = 200;
    private static final int MAX_APPEARANCE_LENGTH = 64;

    private AlbumReplica() {}

    // -----------------------------------------------------------------------
    // Failures
    // -----------------------------------------------------------------------

    /**
     * A coded sync failure. `retryable` distinguishes "try again later" from a state this
     * build cannot resolve by retrying, so the caller never has to guess — several
     * distinct authority states share HTTP 409.
     */
    static final class Failure extends Exception {
        final String code;
        final boolean retryable;

        Failure(String code, boolean retryable) {
            super(code);
            this.code = code;
            this.retryable = retryable;
        }
    }

    /** A non-2xx response, carried to the engine so it can map the coded reason. */
    static final class HttpFailure extends Exception {
        final int status;
        final String body;

        HttpFailure(int status, String body) {
            super("HTTP " + status);
            this.status = status;
            this.body = body;
        }
    }

    static Failure malformed() { return new Failure(CODE_MALFORMED, true); }

    /**
     * Map a rejected response to its coded state.
     *
     * Every authority state here is a 409, so mapping by status would collapse "this
     * cursor predates retained history" into "you are not the authority". The server's
     * `detail.code` is what separates them; an uncoded rejection stays retryable, so an
     * unknown future code cannot be mistaken for a state we understood.
     */
    static Failure mapFailure(int status, String body, boolean syncStatus) {
        String code = detailCode(body);
        if (code != null) {
            if (CODE_INACTIVE.equals(code)) return new Failure(CODE_INACTIVE, false);
            if (CODE_CONTRACT_UNSUPPORTED.equals(code)) {
                return new Failure(CODE_CONTRACT_UNSUPPORTED, false);
            }
            if (CODE_CURSOR_EXPIRED.equals(code)) return new Failure(CODE_CURSOR_EXPIRED, true);
            if (CODE_CURSOR_AHEAD.equals(code)) return new Failure(CODE_CURSOR_AHEAD, true);
            if (CODE_BASELINE_CHANGED.equals(code)) return new Failure(CODE_BASELINE_CHANGED, true);
            if (CODE_LIBRARY_MISMATCH.equals(code) || CODE_AMBIGUOUS.equals(code)) {
                return new Failure(CODE_LIBRARY_MISMATCH, true);
            }
            if (CODE_BASELINE_TOO_LARGE.equals(code)) {
                return new Failure(CODE_BASELINE_TOO_LARGE, true);
            }
        }
        if (status == 401 || status == 403) return new Failure(CODE_UNAUTHORIZED, true);
        // An older server without the route cannot report its authority state, which is
        // unknown rather than "none". The distinction is passed in rather than held in
        // shared mutable state, so concurrent callers cannot reinterpret each other.
        if (status == 404 && syncStatus) return new Failure(CODE_SYNC_STATUS_UNAVAILABLE, true);
        return new Failure(CODE_UNEXPECTED_STATUS, true);
    }

    static String detailCode(String body) {
        if (body == null || body.isEmpty()) return null;
        try {
            Object parsed = Json.parse(body);
            if (!(parsed instanceof Map)) return null;
            Object detail = ((Map<?, ?>) parsed).get("detail");
            if (detail instanceof Map) {
                Object code = ((Map<?, ?>) detail).get("code");
                if (code instanceof String) return (String) code;
            }
        } catch (RuntimeException ignored) {
            // A body that is not JSON cannot name a code; the status alone is used.
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Paths
    // -----------------------------------------------------------------------

    static String statusPath() { return SYNC_STATUS_PATH; }

    static String baselinePath(String libraryId, long epoch, Long snapshot, String section, String after) {
        StringBuilder path = new StringBuilder(BASELINE_PATH)
                .append("?libraryId=").append(libraryId).append("&epoch=").append(epoch);
        if (snapshot != null) {
            path.append("&snapshot=").append(snapshot.longValue());
            path.append("&section=").append(section == null ? SECTION_ALBUMS : section);
            if (after != null) path.append("&after=").append(after);
        }
        path.append("&limit=").append(snapshot == null || SECTION_ALBUMS.equals(section)
                ? ALBUM_PAGE : MEMBERSHIP_PAGE);
        return path.toString();
    }

    static String changesPath(String libraryId, long epoch, long after) {
        return CHANGES_PATH + "?libraryId=" + libraryId + "&epoch=" + epoch
                + "&after=" + after + "&limit=" + CHANGE_PAGE;
    }

    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    /**
     * The adopted authority identity, including the connection it belongs to.
     *
     * `scope` is an opaque hash of the configured endpoint and token, following the
     * existing native cache-scoping convention. It is what makes "rows from another
     * account cannot appear here" a stored fact rather than a hope that every caller
     * remembered to clear the replica.
     */
    static final class Adopted {
        final String scope;
        final String libraryId;
        final long epoch;
        final long contractVersion;
        final long cursor;
        final String adoptedAt;
        final String reconciledAt;

        Adopted(String scope, String libraryId, long epoch, long contractVersion, long cursor,
                String adoptedAt, String reconciledAt) {
            this.scope = scope;
            this.libraryId = libraryId;
            this.epoch = epoch;
            this.contractVersion = contractVersion;
            this.cursor = cursor;
            this.adoptedAt = adoptedAt;
            this.reconciledAt = reconciledAt;
        }
    }

    /** One Album row. `deleted` marks a retained tombstone, not an absent row. */
    static final class Album {
        final String id;
        final String name;
        final String parentId;
        final String iconKey;
        final String colorKey;
        final boolean deleted;
        final long entityRevision;

        Album(String id, String name, String parentId, String iconKey, String colorKey,
              boolean deleted, long entityRevision) {
            this.id = id;
            this.name = name;
            this.parentId = parentId;
            this.iconKey = iconKey;
            this.colorKey = colorKey;
            this.deleted = deleted;
            this.entityRevision = entityRevision;
        }
    }

    /**
     * One Album↔Asset relation. `desiredState=false` is a retained tombstone carrying
     * the relation's own revision, not "never seen".
     */
    static final class Member {
        final String albumId;
        final String assetId;
        final boolean desiredState;
        final long entityRevision;

        Member(String albumId, String assetId, boolean desiredState, long entityRevision) {
            this.albumId = albumId;
            this.assetId = assetId;
            this.desiredState = desiredState;
            this.entityRevision = entityRevision;
        }
    }

    /** One active domain reported by `/v1/sync/status`. */
    static final class Domain {
        final String name;
        final String libraryId;
        final long epoch;
        final long contractVersion;
        final long cursor;

        Domain(String name, String libraryId, long epoch, long contractVersion, long cursor) {
            this.name = name;
            this.libraryId = libraryId;
            this.epoch = epoch;
            this.contractVersion = contractVersion;
            this.cursor = cursor;
        }
    }

    /** The validated `/v1/sync/status` envelope. */
    static final class Status {
        final int protocolVersion;
        final boolean active;
        final String libraryId;
        final List<Domain> domains;

        Status(int protocolVersion, boolean active, String libraryId, List<Domain> domains) {
            this.protocolVersion = protocolVersion;
            this.active = active;
            this.libraryId = libraryId;
            this.domains = Collections.unmodifiableList(domains);
        }

        /** The Album domain, or null while the domain is not server-authoritative. */
        Domain domain() {
            for (Domain domain : domains) if (DOMAIN.equals(domain.name)) return domain;
            return null;
        }
    }

    /** One baseline page, already decoded for its declared section. */
    static final class Page {
        final long snapshotCursor;
        final String section;
        final List<Album> albums;
        final List<Member> members;
        final String nextAfter;
        final boolean hasMore;
        final boolean complete;

        Page(long snapshotCursor, String section, List<Album> albums, List<Member> members,
             String nextAfter, boolean hasMore, boolean complete) {
            this.snapshotCursor = snapshotCursor;
            this.section = section;
            this.albums = Collections.unmodifiableList(albums);
            this.members = Collections.unmodifiableList(members);
            this.nextAfter = nextAfter;
            this.hasMore = hasMore;
            this.complete = complete;
        }
    }

    /** One ordered, self-contained change row. Exactly one delta is present. */
    static final class Change {
        final long sequence;
        final String commandType;
        final Album album;
        final Member member;

        Change(long sequence, String commandType, Album album, Member member) {
            this.sequence = sequence;
            this.commandType = commandType;
            this.album = album;
            this.member = member;
        }
    }

    /** One change page. `nextAfter` is the cursor the page's rows describe. */
    static final class Changes {
        final long serverCursor;
        final List<Change> items;
        final long nextAfter;
        final boolean hasMore;

        Changes(long serverCursor, List<Change> items, long nextAfter, boolean hasMore) {
            this.serverCursor = serverCursor;
            this.items = Collections.unmodifiableList(items);
            this.nextAfter = nextAfter;
            this.hasMore = hasMore;
        }
    }

    // -----------------------------------------------------------------------
    // Parsing
    // -----------------------------------------------------------------------

    /**
     * Validate the aggregate status envelope.
     *
     * The rules mirror the PC's: a client must not be able to read "no active domain"
     * out of a response that actually reports one, because that reading is what would
     * let it adopt against a mismatched identity.
     */
    static Status parseStatus(Object document) throws Failure {
        Map<String, Object> root = object(document);
        long protocol = number(root, "protocolVersion");
        if (protocol != PROTOCOL_VERSION) throw new Failure(CODE_CONTRACT_UNSUPPORTED, false);
        boolean active = bool(root, "active");
        List<Object> raw = list(root, "domains");
        if (raw.size() > 64) throw malformed();
        List<Domain> domains = new ArrayList<>();
        for (Object entry : raw) {
            Map<String, Object> value = object(entry);
            String name = requiredString(value, "domain");
            if (name.isEmpty() || name.length() > 64) throw malformed();
            String libraryId = requiredString(value, "libraryId");
            if (!LIBRARY_ID.matcher(libraryId).matches()) throw malformed();
            long epoch = number(value, "epoch");
            long contract = number(value, "contractVersion");
            long cursor = number(value, "cursor");
            if (epoch < 1 || contract < 1 || cursor < 0) throw malformed();
            domains.add(new Domain(name, libraryId, epoch, contract, cursor));
        }
        String libraryId = optionalString(root, "libraryId");
        if (active != !domains.isEmpty()) throw malformed();
        if (!active) {
            if (libraryId != null || !domains.isEmpty()) throw malformed();
            return new Status((int) protocol, false, null, domains);
        }
        if (libraryId == null || !LIBRARY_ID.matcher(libraryId).matches()) throw malformed();
        boolean seen = false;
        for (Domain domain : domains) {
            // One library per server: a domain naming another library means the
            // aggregate cannot be acted on at all.
            if (!libraryId.equals(domain.libraryId)) throw malformed();
            for (Domain other : domains) if (other != domain && other.name.equals(domain.name)) {
                throw malformed();
            }
            seen = true;
        }
        if (!seen) throw malformed();
        return new Status((int) protocol, true, libraryId, domains);
    }

    /**
     * Validate one baseline page against the identity the walk started with.
     *
     * `section` must match its item shape: a page whose declared section disagrees with
     * its rows is malformed rather than something to guess at.
     */
    static Page parseBaselinePage(Object document, String libraryId, long epoch, String section)
            throws Failure {
        Map<String, Object> root = object(document);
        requireIdentity(root, libraryId, epoch);
        long snapshot = number(root, "snapshotCursor");
        if (snapshot < 0) throw malformed();
        String declared = requiredString(root, "section");
        if (!declared.equals(section) || !(SECTION_ALBUMS.equals(declared) || SECTION_MEMBERSHIPS.equals(declared))) {
            throw malformed();
        }
        List<Object> items = list(root, "items");
        boolean hasMore = bool(root, "hasMore");
        boolean complete = bool(root, "complete");
        String nextAfter = optionalString(root, "nextAfter");
        List<Album> albums = new ArrayList<>();
        List<Member> members = new ArrayList<>();
        if (SECTION_ALBUMS.equals(declared)) {
            if (items.size() > ALBUM_PAGE) throw malformed();
            // Only the final membership page can complete a baseline, so an Album page
            // claiming completeness is not a whole baseline and must not be read as one.
            if (complete) throw malformed();
            for (Object entry : items) albums.add(baselineAlbum(object(entry)));
            if (hasMore && (nextAfter == null || !ENTITY_ID.matcher(nextAfter).matches())) throw malformed();
        } else {
            if (items.size() > MEMBERSHIP_PAGE) throw malformed();
            for (Object entry : items) members.add(member(object(entry)));
            if (hasMore && (nextAfter == null || !membershipKey(nextAfter))) throw malformed();
            if (!hasMore && !complete) throw malformed();
        }
        if (!hasMore && nextAfter != null) throw malformed();
        return new Page(snapshot, declared, albums, members, nextAfter, hasMore, complete);
    }

    /**
     * Validate one ordered change page.
     *
     * `requested` is the cursor the page was asked from, which the server echoes back as
     * `nextAfter` when the page has no rows. Requiring the continuation to equal the rows
     * the page actually sent is what stops a page that silently omits history from being
     * committed as if it were the whole story.
     */
    static Changes parseChanges(Object document, String libraryId, long epoch, long requested)
            throws Failure {
        Map<String, Object> root = object(document);
        requireIdentity(root, libraryId, epoch);
        long serverCursor = number(root, "cursor");
        long nextAfter = number(root, "nextAfter");
        if (serverCursor < 0 || nextAfter < 0) throw malformed();
        // A successful page cannot describe a cursor beyond the authority's own. The server
        // answers `after > cursor` with 409 cursorAhead, so in any 200 both the cursor this
        // page was requested from and the continuation it advertises are bounded by the
        // advertised authority cursor. Without this, a page that claims to continue past
        // the authority is accepted whenever `hasMore` happens to agree with it — the
        // empty-page case, where `nextAfter == requested` and both sit beyond the cursor,
        // satisfies the `hasMore` rule because both sides are false.
        if (requested > serverCursor || nextAfter > serverCursor) throw malformed();
        List<Object> items = list(root, "items");
        if (items.size() > CHANGE_PAGE) throw malformed();
        boolean hasMore = bool(root, "hasMore");
        List<Change> changes = new ArrayList<>();
        for (Object entry : items) {
            Map<String, Object> value = object(entry);
            long sequence = number(value, "sequence");
            long authorityCursor = number(value, "authorityCursor");
            if (sequence < 1 || authorityCursor != sequence) throw malformed();
            String commandType = requiredString(value, "commandType");
            if (!knownCommand(commandType)) throw malformed();
            String operationId = requiredString(value, "operationId");
            if (operationId.length() > 128) throw malformed();
            String changedAt = requiredString(value, "changedAt");
            if (changedAt.length() > 64) throw malformed();
            Object album = value.get("album");
            Object member = value.get("membership");
            // Exactly one canonical delta: accepting both, or neither, would let a
            // malformed page silently desynchronize the replica.
            if ((album == null) == (member == null)) throw malformed();
            changes.add(new Change(sequence, commandType,
                    album == null ? null : album(object(album), true),
                    member == null ? null : member(object(member))));
        }
        // The server derives `nextAfter` as the last row's `sequence`, or the requested
        // cursor when the page is empty. Pinning that here means a page whose advertised
        // continuation disagrees with the rows it actually sent — or one that omits rows
        // and would otherwise look like an honest empty page — is refused rather than
        // committed, and it duplicates the contiguity rule instead of assuming the store
        // will catch it.
        long expected = changes.isEmpty() ? requested
                : changes.get(changes.size() - 1).sequence;
        if (nextAfter != expected) throw malformed();
        // `hasMore` must agree with what the page says is left: more work than the advance
        // reached, and never more than the server cursor allows.
        if (hasMore != nextAfter < serverCursor) throw malformed();
        return new Changes(serverCursor, changes, nextAfter, hasMore);
    }

    /**
     * Require one page to continue exactly where the replica's cursor is.
     *
     * A gap or a repeat is malformed rather than something to apply, and this runs
     * before any row is written, so a rejected page leaves the replica exactly as it
     * was.
     */
    static void requireContiguous(List<Change> changes, long cursor) throws Failure {
        long expected = cursor;
        for (Change change : changes) {
            if (change.sequence != expected + 1) throw malformed();
            expected = change.sequence;
        }
    }

    private static void requireIdentity(Map<String, Object> root, String libraryId, long epoch)
            throws Failure {
        String pageLibrary = requiredString(root, "libraryId");
        long pageEpoch = number(root, "epoch");
        long pageContract = number(root, "contractVersion");
        if (pageContract != CONTRACT_VERSION) throw new Failure(CODE_CONTRACT_UNSUPPORTED, false);
        // A page that describes another library or epoch cannot be combined with this
        // replica's identity. The state is retryable: the next cycle re-discovers the
        // authority and re-adopts.
        if (!pageLibrary.equals(libraryId) || pageEpoch != epoch) {
            throw new Failure(CODE_LIBRARY_MISMATCH, true);
        }
    }

    /** One baseline Album row: live by definition, because deleted Albums are excluded. */
    private static Album baselineAlbum(Map<String, Object> value) throws Failure {
        return album(value, false);
    }

    private static Album album(Map<String, Object> value, boolean deletedKeyExpected) throws Failure {
        String id = requiredString(value, "id");
        if (!ENTITY_ID.matcher(id).matches()) throw malformed();
        String name = requiredString(value, "name");
        if (name.isEmpty() || name.codePointCount(0, name.length()) > MAX_NAME_CODE_POINTS) {
            throw malformed();
        }
        String parentId = optionalString(value, "parentId");
        if (parentId != null && !ENTITY_ID.matcher(parentId).matches()) throw malformed();
        String iconKey = appearance(value, "iconKey");
        String colorKey = appearance(value, "colorKey");
        long revision = number(value, "entityRevision");
        if (revision < 1) throw malformed();
        boolean deleted = false;
        if (deletedKeyExpected) {
            Object flag = value.get("deleted");
            if (!(flag instanceof Boolean)) throw malformed();
            deleted = (Boolean) flag;
        }
        return new Album(id, name, parentId, iconKey, colorKey, deleted, revision);
    }

    private static Member member(Map<String, Object> value) throws Failure {
        String albumId = requiredString(value, "albumId");
        String assetId = requiredString(value, "assetId");
        if (!ENTITY_ID.matcher(albumId).matches() || !ENTITY_ID.matcher(assetId).matches()) {
            throw malformed();
        }
        Object desired = value.get("desiredState");
        if (!(desired instanceof Boolean)) throw malformed();
        long revision = number(value, "entityRevision");
        if (revision < 0) throw malformed();
        return new Member(albumId, assetId, (Boolean) desired, revision);
    }

    /**
     * Appearance keys are accepted as bounded text rather than against a fixed list.
     *
     * The server already rejected anything its own appearance set does not contain, so
     * a client that re-imposed today's list would hard-fail the whole domain the day a
     * key is added, while a client that only bounds the value keeps rendering.
     */
    private static String appearance(Map<String, Object> value, String key) throws Failure {
        String text = optionalString(value, key);
        if (text != null && text.length() > MAX_APPEARANCE_LENGTH) throw malformed();
        return text;
    }

    private static boolean knownCommand(String value) {
        for (String type : COMMAND_TYPES) if (type.equals(value)) return true;
        return false;
    }

    static boolean membershipKey(String value) {
        int separator = value.indexOf(':');
        if (separator <= 0 || separator != value.lastIndexOf(':')) return false;
        return ENTITY_ID.matcher(value.substring(0, separator)).matches()
                && ENTITY_ID.matcher(value.substring(separator + 1)).matches();
    }

    // -----------------------------------------------------------------------
    // JSON access
    // -----------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value) throws Failure {
        if (!(value instanceof Map)) throw malformed();
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Map<String, Object> value, String key) throws Failure {
        Object entry = value.get(key);
        if (!(entry instanceof List)) throw malformed();
        return (List<Object>) entry;
    }

    private static String requiredString(Map<String, Object> value, String key) throws Failure {
        Object entry = value.get(key);
        if (!(entry instanceof String)) throw malformed();
        return (String) entry;
    }

    private static String optionalString(Map<String, Object> value, String key) throws Failure {
        Object entry = value.get(key);
        if (entry == null) return null;
        if (!(entry instanceof String)) throw malformed();
        return (String) entry;
    }

    private static long number(Map<String, Object> value, String key) throws Failure {
        Object entry = value.get(key);
        // Only an integral number is a cursor/revision. A float or a numeric string is
        // a different value than the contract names, so it is rejected rather than
        // truncated.
        if (!(entry instanceof Long)) throw malformed();
        return (Long) entry;
    }

    private static boolean bool(Map<String, Object> value, String key) throws Failure {
        Object entry = value.get(key);
        if (!(entry instanceof Boolean)) throw malformed();
        return (Boolean) entry;
    }

    // -----------------------------------------------------------------------
    // Seams
    // -----------------------------------------------------------------------

    /**
     * One authenticated GET, returning the raw bounded body.
     *
     * The engine depends on this rather than on the Android client so the rules that
     * accept or reject server state can be exercised against a real local HTTP fixture
     * instead of a hand-written stub. Failures are passed through: an
     * {@link HttpFailure} carries a rejected response's status and body, and anything
     * else is a transport problem.
     */
    interface Transport {
        String get(String path) throws Exception;
    }

    /**
     * Durable replica state, with the transaction boundary the contract needs.
     *
     * The operations are deliberately whole-document rather than row-level: installing
     * a baseline replaces the replica in one unit, and applying a page commits its rows
     * and its cursor together. A caller cannot therefore advance a cursor separately
     * from the state that cursor describes.
     */
    interface State {
        Adopted adopted(String scope);

        /**
         * Diagnostic counts for `scope`.
         *
         * Scoped like the reads below: a mismatch reports zeros rather than another
         * connection's totals, because the same caller also sees {@link #adopted} return
         * null for that scope and the two answers must agree.
         */
        Map<String, Object> status(String scope);

        /**
         * Album revision state for `scope`, including tombstones unless `liveOnly`.
         *
         * Every read takes the scope explicitly so "which connection owns these rows" is
         * answered by the store under the lock that reads them, rather than by each caller
         * remembering to check first.
         */
        Map<String, Album> albums(String scope, boolean liveOnly);

        /** Relation revision state for `scope`, keyed `albumId:assetId`. */
        Map<String, Member> memberships(String scope, boolean liveOnly);

        void installBaseline(Adopted authority, List<Album> albums, List<Member> members,
                             String now);

        /**
         * Apply one validated page and advance the cursor.
         *
         * Declared to fail: a gap or a repeat is refused here, inside the transaction,
         * so a rejected page cannot leave the cursor advanced over rows it never wrote.
         */
        void applyChanges(String scope, long cursor, List<Change> changes, String now)
                throws Failure;

        void touch(String scope, String now);

        void clear();
    }

    /** Current UTC time as an ISO-8601 string, so tests are deterministic. */
    interface Clock {
        String now();
    }
}
