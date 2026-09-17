package com.lakomics.mobile;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The Android Classification-authority replica contract: types, paths and validation.
 *
 * This is the *read* side of the `classifications` domain. It shares the replica
 * database and the sync/status contract with {@link AlbumReplica}, but Classification and
 * Album are separate canonical domains with separate identities, hierarchies and
 * revision lineages, so nothing here is derived from the Album side.
 *
 * Android is already a replica, so this client never issues a Classification command and
 * carries no Classification outbox: there is no baseline comparison against local
 * canonical state the way the main PC must do at first adoption, and no optimistic
 * materialization to protect. Android's *legacy* mobile write surfaces are unchanged and
 * are not routed through the authority.
 *
 * Validation is bounded and typed rather than a re-implementation of server policy: a
 * response must carry the exact identity, contract and shape the domain defines, and
 * everything else is a malformed response rather than something to interpret leniently.
 *
 * Three properties of this domain change the shape of the reader relative to Albums:
 *
 * 1. **Assignment is single-valued** (`asset_id -> classificationId | null`). An explicit
 *    null is the authoritative *unassigned* state at a real revision, which is revision
 *    state a fresh client needs; it is not visible membership.
 * 2. **`originals` is immutable role state**, not a Classification a command can produce.
 *    It has no change row to be learned from, so it rides on every baseline page, and a
 *    fresh replica must hold it to interpret the protected id.
 * 3. **A delete is one change carrying two parts** — a Classification tombstone and the
 *    assignment transition that moved its Assets — so the decoder accepts exactly that
 *    shape and the store applies it as one indivisible unit.
 */
final class ClassificationReplica {
    /** The shared domain name the server reports this authority under. */
    static final String DOMAIN = "classifications";
    /** The Classification domain contract this build speaks. */
    static final int CONTRACT_VERSION = 1;
    /** Version of the aggregate `/v1/sync/status` document, not of this domain. */
    static final int PROTOCOL_VERSION = 1;

    /** Documented domain maxima, mirrored from the server contract. */
    static final int MAX_CLASSIFICATIONS = 20_000;
    static final int MAX_ASSIGNMENTS = 200_000;
    /** Page sizes the server accepts, one per section. */
    static final int CLASSIFICATION_PAGE = 1_000;
    static final int ASSIGNMENT_PAGE = 2_000;
    /** Catch-up page size. The server bounds `limit` to 1..=500. */
    static final int CHANGE_PAGE = 100;
    /** Safety valve: refuse an unbounded walk rather than loop forever. */
    static final int MAX_PAGES = 10_000;

    static final String SECTION_CLASSIFICATIONS = "classifications";
    static final String SECTION_ASSIGNMENTS = "assignments";

    static final String SYNC_STATUS_PATH = "/v1/sync/status";
    static final String BASELINE_PATH = "/v1/classifications/authority/baseline";
    static final String CHANGES_PATH = "/v1/classifications/authority/changes";

    /** The single immutable role this contract version carries. */
    static final String ORIGINALS_ROLE = "originals";

    /** The six command types this contract version can emit. */
    static final String[] COMMAND_TYPES = {"createClassification", "renameClassification",
            "moveClassification", "updateClassificationAppearance", "deleteClassification",
            "setAssetClassification"};

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
    private static final int MAX_ROLE_LENGTH = 32;

    private ClassificationReplica() {}

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

    /** The `detail.code` of a rejected response, or null when it names none. */
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

    static String baselinePath(String libraryId, long epoch, Long snapshot, String section,
                               String after) {
        StringBuilder path = new StringBuilder(BASELINE_PATH)
                .append("?libraryId=").append(libraryId).append("&epoch=").append(epoch);
        if (snapshot != null) {
            path.append("&snapshot=").append(snapshot.longValue());
            path.append("&section=").append(section == null ? SECTION_CLASSIFICATIONS : section);
            if (after != null) path.append("&after=").append(after);
        }
        path.append("&limit=").append(snapshot == null || SECTION_CLASSIFICATIONS.equals(section)
                ? CLASSIFICATION_PAGE : ASSIGNMENT_PAGE);
        return path.toString();
    }

    static String changesPath(String libraryId, long epoch, long after) {
        return CHANGES_PATH + "?libraryId=" + libraryId + "&epoch=" + epoch
                + "&after=" + after + "&limit=" + CHANGE_PAGE;
    }

    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    /** One Classification row. `deleted` marks a retained tombstone, not an absent row. */
    static final class Node {
        final String id;
        final String kind;
        final String name;
        final String parentId;
        final String iconKey;
        final String colorKey;
        final boolean deleted;
        final long entityRevision;

        Node(String id, String kind, String name, String parentId, String iconKey,
             String colorKey, boolean deleted, long entityRevision) {
            this.id = id;
            this.kind = kind;
            this.name = name;
            this.parentId = parentId;
            this.iconKey = iconKey;
            this.colorKey = colorKey;
            this.deleted = deleted;
            this.entityRevision = entityRevision;
        }
    }

    /**
     * One Asset assignment lineage. `classificationId == null` is the authoritative
     * *unassigned* state at a real revision, which is revision state a later command must
     * be able to present; it is never visible membership.
     */
    static final class Assignment {
        final String assetId;
        final String classificationId;
        final long entityRevision;

        Assignment(String assetId, String classificationId, long entityRevision) {
            this.assetId = assetId;
            this.classificationId = classificationId;
            this.entityRevision = entityRevision;
        }
    }

    /** One immutable role binding. v1 carries exactly `originals`. */
    static final class Role {
        final String role;
        final String classificationId;

        Role(String role, String classificationId) {
            this.role = role;
            this.classificationId = classificationId;
        }
    }

    /**
     * The deterministic assignment transition a delete carries.
     *
     * `affectsAssignments` is the server's own count of assignments that named the deleted
     * Classification, which is what lets the replica prove its retained lineage is
     * complete before applying the move.
     */
    static final class Transition {
        final String fromClassificationId;
        final String toClassificationId;
        final long affectsAssignments;

        Transition(String fromClassificationId, String toClassificationId,
                   long affectsAssignments) {
            this.fromClassificationId = fromClassificationId;
            this.toClassificationId = toClassificationId;
            this.affectsAssignments = affectsAssignments;
        }
    }

    /** A validated `/v1/sync/status` document, restricted to what this domain reads. */
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

        /** The Classification domain, or null while the domain is not server-authoritative. */
        Domain domain() {
            for (Domain domain : domains) if (DOMAIN.equals(domain.name)) return domain;
            return null;
        }
    }

    /** One baseline page, already decoded for its declared section. */
    static final class Page {
        final long snapshotCursor;
        final String section;
        final List<Node> classifications;
        final List<Assignment> assignments;
        final List<Role> roles;
        final String nextAfter;
        final boolean hasMore;
        final boolean complete;

        Page(long snapshotCursor, String section, List<Node> classifications,
             List<Assignment> assignments, List<Role> roles, String nextAfter, boolean hasMore,
             boolean complete) {
            this.snapshotCursor = snapshotCursor;
            this.section = section;
            this.classifications = Collections.unmodifiableList(classifications);
            this.assignments = Collections.unmodifiableList(assignments);
            this.roles = Collections.unmodifiableList(roles);
            this.nextAfter = nextAfter;
            this.hasMore = hasMore;
            this.complete = complete;
        }
    }

    /**
     * One ordered, self-contained change row.
     *
     * A structural command carries one live Classification; an assignment command carries
     * one assignment; a delete carries a tombstone **and** its transition, which is the
     * only multi-part shape the contract defines.
     */
    static final class Change {
        final long sequence;
        final String commandType;
        final Node classification;
        final Assignment assignment;
        final Transition transition;

        Change(long sequence, String commandType, Node classification, Assignment assignment,
               Transition transition) {
            this.sequence = sequence;
            this.commandType = commandType;
            this.classification = classification;
            this.assignment = assignment;
            this.transition = transition;
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
     * The rules mirror the PC's: a client must not be able to read "no active domain" out
     * of a response that actually reports one, because that reading is what would let it
     * adopt against a mismatched identity.
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
            // One library per server: a domain naming another library means the aggregate
            // cannot be acted on at all.
            if (!libraryId.equals(domain.libraryId)) throw malformed();
            for (Domain other : domains) {
                if (other != domain && other.name.equals(domain.name)) throw malformed();
            }
            seen = true;
        }
        if (!seen) throw malformed();
        return new Status((int) protocol, true, libraryId, domains);
    }

    /**
     * Validate one baseline page against the identity the walk started with.
     *
     * `section` must match its item shape: a page whose declared section disagrees with its
     * rows is malformed rather than something to guess at.
     */
    static Page parseBaselinePage(Object document, String libraryId, long epoch, String section)
            throws Failure {
        Map<String, Object> root = object(document);
        requireIdentity(root, libraryId, epoch);
        long snapshot = number(root, "snapshotCursor");
        if (snapshot < 0) throw malformed();
        String declared = requiredString(root, "section");
        if (!declared.equals(section)
                || !(SECTION_CLASSIFICATIONS.equals(declared)
                     || SECTION_ASSIGNMENTS.equals(declared))) {
            throw malformed();
        }
        // The role set is immutable authority state with no change row, so every page
        // carries it. A page that carried a malformed or unsupported set is refused rather
        // than allowed to contribute a role this build cannot interpret.
        List<Role> roles = roles(root);
        List<Object> items = list(root, "items");
        boolean hasMore = bool(root, "hasMore");
        boolean complete = bool(root, "complete");
        String nextAfter = optionalString(root, "nextAfter");
        List<Node> classifications = new ArrayList<>();
        List<Assignment> assignments = new ArrayList<>();
        if (SECTION_CLASSIFICATIONS.equals(declared)) {
            if (items.size() > CLASSIFICATION_PAGE) throw malformed();
            // Only the final assignment page can complete a baseline, so a Classification
            // page claiming completeness is not a whole baseline and must not be read as one.
            if (complete) throw malformed();
            for (Object entry : items) classifications.add(baselineNode(object(entry)));
            if (hasMore && (nextAfter == null || !ENTITY_ID.matcher(nextAfter).matches())) {
                throw malformed();
            }
        } else {
            if (items.size() > ASSIGNMENT_PAGE) throw malformed();
            for (Object entry : items) assignments.add(assignment(object(entry)));
            if (hasMore && (nextAfter == null || !ENTITY_ID.matcher(nextAfter).matches())) {
                throw malformed();
            }
            if (!hasMore && !complete) throw malformed();
        }
        if (!hasMore && nextAfter != null) throw malformed();
        return new Page(snapshot, declared, classifications, assignments, roles, nextAfter,
                hasMore, complete);
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
        // A successful page cannot describe a cursor beyond the authority's own, nor move
        // behind the cursor it was requested from.
        if (requested > serverCursor || nextAfter > serverCursor) throw malformed();
        if (nextAfter < requested) throw malformed();
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
            if (operationId.isEmpty() || operationId.length() > 128) throw malformed();
            String changedAt = requiredString(value, "changedAt");
            if (changedAt.length() > 64) throw malformed();
            changes.add(change(value, commandType, sequence));
        }
        // The server derives `nextAfter` as the last row's `sequence`, or the requested
        // cursor when the page is empty. Pinning that here means a page whose advertised
        // continuation disagrees with the rows it actually sent — or one that omits rows
        // and would otherwise look like an honest empty page — is refused rather than
        // committed, and it duplicates the contiguity rule instead of assuming the store
        // will catch it.
        long expected = changes.isEmpty() ? requested : changes.get(changes.size() - 1).sequence;
        if (nextAfter != expected) throw malformed();
        if (hasMore != nextAfter < serverCursor) throw malformed();
        return new Changes(serverCursor, changes, nextAfter, hasMore);
    }

    /**
     * Decode one change row's delta for its declared command.
     *
     * Three shapes are valid and nothing else: a live Classification alone
     * (create/rename/move/appearance), an assignment alone, or a delete's tombstone **and**
     * transition together. A row whose payload disagrees with its own `commandType` is
     * malformed rather than applied as whatever its payload claimed.
     */
    private static Change change(Map<String, Object> value, String commandType, long sequence)
            throws Failure {
        Object classification = value.get("classification");
        Object assignment = value.get("assignment");
        Object transition = value.get("assignmentTransition");
        switch (commandType) {
            case "createClassification":
            case "renameClassification":
            case "moveClassification":
            case "updateClassificationAppearance": {
                if (classification == null || assignment != null || transition != null) {
                    throw malformed();
                }
                Node live = changedNode(object(classification));
                if (live.deleted) throw malformed();
                return new Change(sequence, commandType, live, null, null);
            }
            case "setAssetClassification": {
                if (classification != null || assignment == null || transition != null) {
                    throw malformed();
                }
                Assignment decoded = assignment(object(assignment));
                // A change row always describes a real advance, so revision 0 — the
                // "no row" representation of an unassigned lineage — cannot be a change.
                if (decoded.entityRevision < 1) throw malformed();
                return new Change(sequence, commandType, null, decoded, null);
            }
            default: {
                if (classification == null || assignment != null || transition == null) {
                    throw malformed();
                }
                Node tombstone = changedNode(object(classification));
                Transition move = transition(object(transition));
                if (!tombstone.deleted || !tombstone.id.equals(move.fromClassificationId)) {
                    throw malformed();
                }
                return new Change(sequence, commandType, tombstone, null, move);
            }
        }
    }

    /**
     * Require one page to continue exactly where the replica's cursor is.
     *
     * A gap or a repeat is malformed rather than something to apply, and this runs before
     * any row is written, so a rejected page leaves the replica exactly as it was.
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

    /** One baseline Classification row: live by definition, because tombstones are excluded. */
    private static Node baselineNode(Map<String, Object> value) throws Failure {
        Node node = node(value);
        if (node.deleted) throw malformed();
        return node;
    }

    /** One change-row Classification row, where `deleted` is meaningful and required. */
    private static Node changedNode(Map<String, Object> value) throws Failure {
        Object flag = value.get("deleted");
        if (!(flag instanceof Boolean)) throw malformed();
        return node(value);
    }

    private static Node node(Map<String, Object> value) throws Failure {
        String id = requiredString(value, "id");
        if (!ENTITY_ID.matcher(id).matches()) throw malformed();
        String kind = requiredString(value, "kind");
        if (!("root".equals(kind) || "work".equals(kind) || "tag".equals(kind))) throw malformed();
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
        Object flag = value.get("deleted");
        boolean deleted = flag instanceof Boolean && (Boolean) flag;
        // A tombstone never carries a parent. The server clears it inside the same delete
        // that sets the tombstone, so a deleted node cannot reserve a sibling name or appear
        // inside a hierarchy it no longer belongs to. Accepting a non-null parent here would
        // let a malformed page place a deleted Classification back into the tree.
        if (deleted && parentId != null) throw malformed();
        return new Node(id, kind, name, parentId, iconKey, colorKey, deleted, revision);
    }

    private static Assignment assignment(Map<String, Object> value) throws Failure {
        String assetId = requiredString(value, "assetId");
        if (!ENTITY_ID.matcher(assetId).matches()) throw malformed();
        String classificationId = optionalString(value, "classificationId");
        if (classificationId != null && !ENTITY_ID.matcher(classificationId).matches()) {
            throw malformed();
        }
        long revision = number(value, "entityRevision");
        // Zero is the representation of "this Asset has no assignment row", which is
        // expressed by *absence* in the replica rather than as a stored row.
        if (revision < 0) throw malformed();
        return new Assignment(assetId, classificationId, revision);
    }

    private static Transition transition(Map<String, Object> value) throws Failure {
        String from = requiredString(value, "fromClassificationId");
        if (!ENTITY_ID.matcher(from).matches()) throw malformed();
        String to = optionalString(value, "toClassificationId");
        if (to != null && !ENTITY_ID.matcher(to).matches()) throw malformed();
        long affected = number(value, "affectsAssignments");
        if (affected < 0) throw malformed();
        return new Transition(from, to, affected);
    }

    /**
     * The immutable role set carried on every baseline page.
     *
     * v1 defines exactly one role, so the set is bounded by the schema's own constraint.
     * A role this build cannot interpret is refused rather than stored, because the
     * protected id is what a structural command's safety depends on.
     */
    private static List<Role> roles(Map<String, Object> root) throws Failure {
        List<Object> raw = list(root, "roles");
        if (raw.isEmpty() || raw.size() > 4) throw malformed();
        List<Role> roles = new ArrayList<>();
        for (Object entry : raw) {
            Map<String, Object> value = object(entry);
            String role = requiredString(value, "role");
            String classificationId = requiredString(value, "classificationId");
            if (!ORIGINALS_ROLE.equals(role) || role.length() > MAX_ROLE_LENGTH) throw malformed();
            if (!ENTITY_ID.matcher(classificationId).matches()) throw malformed();
            for (Role existing : roles) {
                // One binding per role: a duplicate would make the protected id ambiguous.
                if (existing.role.equals(role)) throw malformed();
            }
            roles.add(new Role(role, classificationId));
        }
        return roles;
    }

    /**
     * Appearance keys are accepted as bounded text rather than against a fixed list.
     *
     * The server already rejected anything its own appearance set does not contain, so a
     * client that re-imposed today's list would hard-fail the whole domain the day a key is
     * added, while a client that only bounds the value keeps rendering.
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
        // Only an integral number is a cursor/revision. A float or a numeric string is a
        // different value than the contract names, so it is rejected rather than truncated.
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
     * The engine depends on this rather than on the Android client so the rules that accept
     * or reject server state can be exercised against a real local HTTP fixture instead of
     * a hand-written stub.
     */
    interface Transport {
        String get(String path) throws Exception;
    }

    /**
     * Durable replica state, with the transaction boundary the contract needs.
     *
     * The operations are whole-document rather than row-level: installing a baseline
     * replaces this domain's state in one unit, and applying a page commits its rows and
     * its cursor together, so a caller cannot advance a cursor separately from the state
     * that cursor describes.
     *
     * This is a **read replica**: there is no Classification outbox operation here at all,
     * because Android issues no Classification command in this phase.
     */
    interface State {
        /**
         * The adopted Classification authority for `scope`, or null.
         *
         * Named for the domain rather than for the operation: one store implements both
         * this seam and the Album one, and the two adoption rows are different tables with
         * different lifetimes. A shared name would also be impossible in Java, and the
         * prefix is the honest description of what is being read.
         */
        Adopted classificationAdopted(String scope);

        /** Diagnostic counts for `scope`; zeros when the scope owns nothing. */
        Map<String, Object> classificationStatus(String scope);

        /** Classification revision state for `scope`, including tombstones unless `liveOnly`. */
        Map<String, Node> classificationNodes(String scope, boolean liveOnly);

        /** Assignment lineage state for `scope`, keyed by Asset id. */
        Map<String, Assignment> classificationAssignments(String scope);

        /** The adopted `originals` binding for `scope`, or null. */
        String classificationRole(String scope);

        void installBaseline(Adopted authority, List<Node> classifications,
                             List<Assignment> assignments, List<Role> roles, String now);

        /**
         * Apply one validated page and advance the cursor.
         *
         * Declared to fail: a gap or a repeat is refused here, inside the transaction, so a
         * rejected page cannot leave the cursor advanced over rows it never wrote.
         */
        void applyClassificationChanges(String scope, long cursor, List<Change> changes,
                                        String now) throws Failure;

        void touchClassification(String scope, String now);

        /**
         * Discard this connection's Classification replica.
         *
         * Classification rows only: Album, Bookmark and user media state belong to other
         * domains, so one domain's reset cannot take them with it.
         */
        void clearClassifications();
    }

    /** The adopted authority identity, including the connection it belongs to. */
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

    /** Current UTC time as an ISO-8601 string, so tests are deterministic. */
    interface Clock {
        String now();
    }
}
