package com.lakomics.mobile;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Notes v2 plaintext schema (inside the encrypted payload only), its limits, the fallback
 * body for pre-v2 clients, the read-only guard and the three-way merge.
 *
 * A port of the PC `library/notes/model.rs` and the decode/view/draft rules of
 * `library/notes.rs`; both run the shared fixtures in `tests/fixtures/notes-v2/`. It
 * links neither the Android runtime nor `org.json`, so the JVM check harness runs it.
 */
final class NotesModel {
    static final long SUPPORTED_SCHEMA = 2;
    static final int MAX_TITLE_CHARS = 200;
    static final int MAX_BODY_BYTES = 128 * 1024;
    static final int MAX_PLAINTEXT_BYTES = 256 * 1024;
    static final int MAX_ITEMS = 500;
    static final int MAX_ITEM_CHARS = 1000;
    static final int MAX_LABELS = 20;
    static final int MAX_LABEL_CHARS = 40;
    static final int MAX_FIELDS = 200;
    static final int MAX_FIELD_LABEL_CHARS = 100;
    static final int MAX_FIELD_VALUE_CHARS = 4000;
    static final int MAX_KEY_LEN = 64;
    static final String TEXT = "text", CHECKLIST = "checklist", SECRET = "secret";
    /** Ledger (가계부) notes: see the "Ledger" section below and `library/notes/ledger.rs`. */
    static final String LEDGER = "ledger", LEDGER_MONTH = "ledger-month";
    static final int MAX_RECURRING = 200, MAX_PLANNED = 300, MAX_ENTRIES = 300, MAX_LEDGER_NAME_CHARS = 100, MAX_LEDGER_MEMO_CHARS = 500, MAX_LEDGER_BODY_BYTES = 24 * 1024;
    static final long AMOUNT_BOUND = 1_000_000_000_000L, MAX_EVERY = 120;
    static boolean ledgerKind(String kind) { return LEDGER.equals(kind) || LEDGER_MONTH.equals(kind); }
    static boolean knownKind(Object kind) { return TEXT.equals(kind) || CHECKLIST.equals(kind) || SECRET.equals(kind) || LEDGER.equals(kind) || LEDGER_MONTH.equals(kind); }
    static final List<String> COLORS = Collections.unmodifiableList(Arrays.asList("red", "orange", "amber", "green", "teal", "blue", "indigo", "pink"));

    private NotesModel() {}

    /** A user-facing (Korean) refusal; shown as is. */
    static final class Invalid extends Exception {
        Invalid(String message) { super(message); }
    }

    /** Payload shape errors: a key with an unexpected JSON type or a missing required key. */
    static final class Shape extends Exception {
        Shape(String key) { super("Unexpected note key " + key); }
    }

    // ----------------------------------------------------------------------------------
    // Entries

    abstract static class Entry {
        String id, order;
        LinkedHashMap<String, Object> extra = new LinkedHashMap<>();
        /** A content change (not a pure move) relative to `base`. */
        abstract boolean edited(Entry base);
        abstract Entry copy();
        abstract void write(Map<String, Object> out);
        Map<String, Object> toMap() {
            Map<String, Object> out = new LinkedHashMap<>();
            write(out);
            out.putAll(extra);
            return out;
        }
        @Override public boolean equals(Object other) {
            return other != null && other.getClass() == getClass() && toMap().equals(((Entry) other).toMap());
        }
        @Override public int hashCode() { return toMap().hashCode(); }
    }

    static final class Item extends Entry {
        String text;
        boolean checked;
        Item(String id, String text, boolean checked, String order) { this.id = id; this.text = text; this.checked = checked; this.order = order; }
        @Override boolean edited(Entry base) { Item b = (Item) base; return !text.equals(b.text) || checked != b.checked; }
        @Override Item copy() { Item c = new Item(id, text, checked, order); c.extra = new LinkedHashMap<>(extra); return c; }
        @Override void write(Map<String, Object> out) { out.put("id", id); out.put("text", text); out.put("checked", checked); out.put("order", order); }
    }

    static final class Field extends Entry {
        String label, value;
        Field(String id, String label, String value, String order) { this.id = id; this.label = label; this.value = value; this.order = order; }
        @Override boolean edited(Entry base) { Field b = (Field) base; return !label.equals(b.label) || !value.equals(b.value); }
        @Override Field copy() { Field c = new Field(id, label, value, order); c.extra = new LinkedHashMap<>(extra); return c; }
        @Override void write(Map<String, Object> out) { out.put("id", id); out.put("label", label); out.put("value", value); out.put("order", order); }
    }

    // ----------------------------------------------------------------------------------
    // Content

    /** Decrypted note payload. v1 notes keep their exact keys; unknown keys survive in `extra`. */
    static final class Content {
        Long schema;
        String kind;
        String title = "", body = "";
        String memo, color;
        List<String> labels = new ArrayList<>();
        List<Item> items;
        List<Field> fields;
        /** Month note: its ledger note id and `YYYY-MM` (both immutable). */
        String ledger, month;
        /** `income` key present (null or integer won); absent when false. */
        boolean hasIncome;
        Long income;
        /** Ledger collections as canonical JSON maps (known keys in order, then unknown keys). */
        List<Map<String, Object>> recurring, planned, entries;
        boolean pinned, deleted, archived;
        String createdAt, updatedAt;
        LinkedHashMap<String, Object> extra = new LinkedHashMap<>();

        static Content fresh(String now) { Content c = new Content(); c.createdAt = now; c.updatedAt = now; return c; }

        String kind() { return kind == null ? TEXT : kind; }

        /** False for a newer schema or an unknown type: such a note is read-only here. */
        boolean supported() {
            return (schema == null || schema <= SUPPORTED_SCHEMA) && knownKind(kind());
        }

        Content copy() {
            Content c = new Content();
            c.schema = schema; c.kind = kind; c.title = title; c.body = body; c.memo = memo; c.color = color;
            c.labels = new ArrayList<>(labels);
            c.items = items == null ? null : copyItems(items);
            c.fields = fields == null ? null : copyFields(fields);
            c.ledger = ledger; c.month = month; c.hasIncome = hasIncome; c.income = income;
            c.recurring = copyMaps(recurring); c.planned = copyMaps(planned); c.entries = copyMaps(entries);
            c.pinned = pinned; c.deleted = deleted; c.archived = archived; c.createdAt = createdAt; c.updatedAt = updatedAt;
            c.extra = new LinkedHashMap<>(extra);
            return c;
        }

        /** Canonical key order (see the fixture rules); absent keys are left out. */
        Map<String, Object> toMap() {
            Map<String, Object> out = new LinkedHashMap<>();
            if (schema != null) out.put("schema", schema);
            if (kind != null) out.put("type", kind);
            out.put("title", title);
            out.put("body", body);
            if (memo != null) out.put("memo", memo);
            if (color != null) out.put("color", color);
            if (!labels.isEmpty()) out.put("labels", new ArrayList<Object>(labels));
            if (items != null) { List<Object> list = new ArrayList<>(); for (Item i : items) list.add(i.toMap()); out.put("items", list); }
            if (fields != null) { List<Object> list = new ArrayList<>(); for (Field f : fields) list.add(f.toMap()); out.put("fields", list); }
            if (ledger != null) out.put("ledger", ledger);
            if (month != null) out.put("month", month);
            if (hasIncome) out.put("income", income);
            if (recurring != null) out.put("recurring", new ArrayList<Object>(recurring));
            if (planned != null) out.put("planned", new ArrayList<Object>(planned));
            if (entries != null) out.put("entries", new ArrayList<Object>(entries));
            out.put("pinned", pinned);
            out.put("deleted", deleted);
            if (archived) out.put("archived", true);
            out.put("createdAt", createdAt);
            out.put("updatedAt", updatedAt);
            for (Map.Entry<String, Object> e : extra.entrySet()) if (!out.containsKey(e.getKey())) out.put(e.getKey(), e.getValue());
            return out;
        }

        String toJson() { return write(toMap()); }

        @Override public boolean equals(Object other) { return other instanceof Content && toMap().equals(((Content) other).toMap()); }
        @Override public int hashCode() { return toMap().hashCode(); }

        /** Recomputes derived data: canonical entry order, fallback bodies and the schema marker. */
        void normalize() {
            String k = kind();
            if (CHECKLIST.equals(k)) {
                if (items == null) items = new ArrayList<>();
                sortEntries(items);
                body = checklistFallback(items);
            } else if (SECRET.equals(k)) {
                if (fields == null) fields = new ArrayList<>();
                sortEntries(fields);
                body = secretFallback(fields, memo == null ? "" : memo);
            } else if (LEDGER.equals(k)) {
                hasIncome = true;
                if (recurring == null) recurring = new ArrayList<>();
                if (planned == null) planned = new ArrayList<>();
                sortByOrder(recurring);
                sortByOrder(planned);
                body = ledgerFallback(title, income, recurring, planned);
            } else if (LEDGER_MONTH.equals(k)) {
                hasIncome = true;
                if (entries == null) entries = new ArrayList<>();
                sortLedgerEntries(entries);
                archived = true;
                body = monthFallback(month == null ? "" : month, income, entries);
            }
            if (TEXT.equals(kind)) kind = null;
            boolean v2 = kind != null || color != null || !labels.isEmpty() || archived || items != null || fields != null || memo != null;
            if (v2 && (schema == null ? 1 : schema) < SUPPORTED_SCHEMA) schema = SUPPORTED_SCHEMA;
        }

        /** Every Notes v2 limit; the message is shown to the user, null when valid. */
        String validate() {
            if (codePoints(title) > MAX_TITLE_CHARS || utf8(body) > MAX_BODY_BYTES) return "제목은 200자, 본문은 128 KiB까지 저장할 수 있습니다.";
            if (memo != null && utf8(memo) > MAX_BODY_BYTES) return "메모는 128 KiB까지 저장할 수 있습니다.";
            if (color != null) {
                if (color.isEmpty() || color.length() > 24) return "메모 색상이 올바르지 않습니다.";
                for (int i = 0; i < color.length(); i++) { char c = color.charAt(i); if (!(c >= 'a' && c <= 'z') && c != '-') return "메모 색상이 올바르지 않습니다."; }
            }
            if (labels.size() > MAX_LABELS) return "라벨은 메모마다 20개까지 붙일 수 있습니다.";
            Set<String> seen = new HashSet<>();
            for (String label : labels) {
                if (!trim(label).equals(label) || label.isEmpty() || codePoints(label) > MAX_LABEL_CHARS || hasControl(label)) return "라벨은 1~40자로 입력해 주세요.";
                if (!seen.add(labelKey(label))) return "같은 라벨이 이미 있습니다.";
            }
            if (items != null) {
                if (items.size() > MAX_ITEMS) return "체크리스트 항목은 500개까지 저장할 수 있습니다.";
                Set<String> ids = new HashSet<>();
                for (Item item : items) {
                    if (!validKey(item.id) || !validKey(item.order) || !ids.add(item.id)) return "체크리스트 항목 형식이 올바르지 않습니다.";
                    if (codePoints(item.text) > MAX_ITEM_CHARS) return "체크리스트 항목은 1000자까지 입력할 수 있습니다.";
                }
            }
            if (fields != null) {
                if (fields.size() > MAX_FIELDS) return "암호 메모 항목은 200개까지 저장할 수 있습니다.";
                Set<String> ids = new HashSet<>();
                for (Field field : fields) {
                    if (!validKey(field.id) || !validKey(field.order) || !ids.add(field.id)) return "암호 메모 항목 형식이 올바르지 않습니다.";
                    if (codePoints(field.label) > MAX_FIELD_LABEL_CHARS || codePoints(field.value) > MAX_FIELD_VALUE_CHARS) return "암호 메모 항목 이름은 100자, 값은 4000자까지 입력할 수 있습니다.";
                }
            }
            String ledgerProblem = validateLedger(this);
            if (ledgerProblem != null) return ledgerProblem;
            if (utf8(toJson()) > MAX_PLAINTEXT_BYTES) return "메모가 너무 큽니다. 256 KiB 이하로 줄여 주세요.";
            return null;
        }
    }

    static List<Item> copyItems(List<Item> list) { List<Item> out = new ArrayList<>(); for (Item i : list) out.add(i.copy()); return out; }
    static List<Field> copyFields(List<Field> list) { List<Field> out = new ArrayList<>(); for (Field f : list) out.add(f.copy()); return out; }

    // ----------------------------------------------------------------------------------
    // Strict parsing (serde semantics of the PC `Content`)

    private static final Set<String> KNOWN = new HashSet<>(Arrays.asList("schema", "type", "title", "body", "memo", "color", "labels", "items", "fields", "ledger", "month", "income", "recurring", "planned", "entries", "pinned", "deleted", "archived", "createdAt", "updatedAt"));

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object value, String key) throws Shape {
        if (!(value instanceof Map)) throw new Shape(key);
        return (Map<String, Object>) value;
    }
    static String string(Map<String, Object> map, String key) throws Shape {
        Object v = map.get(key);
        if (!(v instanceof String)) throw new Shape(key);
        return (String) v;
    }
    static String optString(Map<String, Object> map, String key) throws Shape {
        Object v = map.get(key);
        if (v == null) return null;
        if (!(v instanceof String)) throw new Shape(key);
        return (String) v;
    }
    static boolean bool(Map<String, Object> map, String key) throws Shape {
        Object v = map.get(key);
        if (!(v instanceof Boolean)) throw new Shape(key);
        return (Boolean) v;
    }
    /** `#[serde(default)] bool`: absent is false, null is an error. */
    static boolean defaultBool(Map<String, Object> map, String key) throws Shape {
        return map.containsKey(key) ? bool(map, key) : false;
    }
    static Long unsigned(Object v, String key) throws Shape {
        if (v == null) return null;
        if (!(v instanceof Long) || (Long) v < 0) throw new Shape(key);
        return (Long) v;
    }

    static Item item(Object value) throws Shape {
        Map<String, Object> map = object(value, "items");
        Item item = new Item(string(map, "id"), string(map, "text"), defaultBool(map, "checked"), string(map, "order"));
        for (Map.Entry<String, Object> e : map.entrySet())
            if (!Arrays.asList("id", "text", "checked", "order").contains(e.getKey())) item.extra.put(e.getKey(), e.getValue());
        return item;
    }
    static Field field(Object value) throws Shape {
        Map<String, Object> map = object(value, "fields");
        Field field = new Field(string(map, "id"), string(map, "label"), string(map, "value"), string(map, "order"));
        for (Map.Entry<String, Object> e : map.entrySet())
            if (!Arrays.asList("id", "label", "value", "order").contains(e.getKey())) field.extra.put(e.getKey(), e.getValue());
        return field;
    }
    static List<Item> items(Object value) throws Shape {
        if (value == null) return null;
        if (!(value instanceof List)) throw new Shape("items");
        List<Item> out = new ArrayList<>();
        for (Object entry : (List<?>) value) out.add(item(entry));
        return out;
    }
    static List<Field> fields(Object value) throws Shape {
        if (value == null) return null;
        if (!(value instanceof List)) throw new Shape("fields");
        List<Field> out = new ArrayList<>();
        for (Object entry : (List<?>) value) out.add(field(entry));
        return out;
    }
    static List<String> strings(Object value, String key) throws Shape {
        if (!(value instanceof List)) throw new Shape(key);
        List<String> out = new ArrayList<>();
        for (Object entry : (List<?>) value) { if (!(entry instanceof String)) throw new Shape(key); out.add((String) entry); }
        return out;
    }

    /** Parses a payload object; any unexpected type or missing required key is a `Shape` error. */
    static Content parse(Object value) throws Shape {
        Map<String, Object> map = object(value, "payload");
        Content c = new Content();
        c.schema = unsigned(map.get("schema"), "schema");
        c.kind = optString(map, "type");
        c.title = string(map, "title");
        c.body = string(map, "body");
        c.memo = optString(map, "memo");
        c.color = optString(map, "color");
        c.labels = map.containsKey("labels") ? strings(map.get("labels"), "labels") : new ArrayList<String>();
        c.items = items(map.get("items"));
        c.fields = fields(map.get("fields"));
        c.ledger = optString(map, "ledger");
        c.month = optString(map, "month");
        if (map.containsKey("income")) { c.hasIncome = true; c.income = income(map.get("income")); }
        c.recurring = ledgerList(map.get("recurring"), "recurring", NotesModel::recurringItem);
        c.planned = ledgerList(map.get("planned"), "planned", NotesModel::plannedItem);
        c.entries = ledgerList(map.get("entries"), "entries", NotesModel::ledgerEntry);
        c.pinned = bool(map, "pinned");
        c.deleted = bool(map, "deleted");
        c.archived = defaultBool(map, "archived");
        c.createdAt = string(map, "createdAt");
        c.updatedAt = string(map, "updatedAt");
        for (Map.Entry<String, Object> e : map.entrySet()) if (!KNOWN.contains(e.getKey())) c.extra.put(e.getKey(), e.getValue());
        return c;
    }

    // ----------------------------------------------------------------------------------
    // Stored payloads: typed, or raw (newer schema, unknown type, undecodable)

    /** A decrypted payload. `raw` notes are shown read-only and saved back byte for byte except pin/trash/archive. */
    static final class Stored {
        final Content typed;
        final Object raw;
        private Stored(Content typed, Object raw) { this.typed = typed; this.raw = raw; }
        static Stored typed(Content content) { return new Stored(content, null); }
        /** A metadata-patched raw payload stays raw (byte for byte) until it is read again. */
        static Stored raw(Object value) { return new Stored(null, value); }
        boolean isRaw() { return typed == null; }

        static Stored decode(Object value) {
            if (value instanceof Map) {
                Map<?, ?> map = (Map<?, ?>) value;
                Object schema = map.get("schema"), kind = map.get("type");
                boolean schemaOk = schema == null || (schema instanceof Long && (Long) schema >= 0 && (Long) schema <= SUPPORTED_SCHEMA);
                boolean typeOk = kind == null || knownKind(kind);
                if (schemaOk && typeOk) {
                    try {
                        Content content = parse(value);
                        if (codePoints(content.title) <= MAX_TITLE_CHARS && utf8(content.body) <= MAX_BODY_BYTES) return new Stored(content, null);
                    } catch (Shape ignored) {
                        // falls through to a raw, read-only note
                    }
                }
            }
            return new Stored(null, value);
        }

        /** What the UI may show: the typed content, or the readable basics of a raw note. */
        Content display() {
            if (typed != null) return typed.copy();
            Map<?, ?> map = raw instanceof Map ? (Map<?, ?>) raw : Collections.emptyMap();
            Content c = new Content();
            Object schema = map.get("schema");
            c.schema = schema instanceof Long && (Long) schema >= 0 ? (Long) schema : null;
            c.kind = map.get("type") instanceof String ? (String) map.get("type") : null;
            String title = map.get("title") instanceof String ? (String) map.get("title") : "";
            c.title = codePoints(title) > MAX_TITLE_CHARS ? title.substring(0, title.offsetByCodePoints(0, MAX_TITLE_CHARS)) : title;
            c.body = map.get("body") instanceof String ? (String) map.get("body") : "";
            c.pinned = Boolean.TRUE.equals(map.get("pinned"));
            c.deleted = Boolean.TRUE.equals(map.get("deleted"));
            c.archived = Boolean.TRUE.equals(map.get("archived"));
            c.createdAt = map.get("createdAt") instanceof String ? (String) map.get("createdAt") : "";
            c.updatedAt = map.get("updatedAt") instanceof String ? (String) map.get("updatedAt") : "";
            return c;
        }

        String toJson() { return typed != null ? typed.toJson() : write(raw); }
    }

    /** Metadata-only change of a raw payload; every other key is kept as stored. */
    @SuppressWarnings("unchecked")
    static Object patchRaw(Object raw, Draft draft, String now) throws Invalid {
        if (!(raw instanceof Map)) throw new Invalid("이 메모는 이 버전에서 바꿀 수 없습니다.");
        Map<String, Object> copy = new LinkedHashMap<>((Map<String, Object>) raw);
        if (draft.pinned != null) copy.put("pinned", draft.pinned);
        if (draft.deleted != null) copy.put("deleted", draft.deleted);
        if (draft.archived != null) copy.put("archived", draft.archived);
        copy.put("updatedAt", now);
        return copy;
    }

    /**
     * The note as the WebView receives it: unknown keys never leave native code, and a
     * secret note whose PIN session is closed carries only its title and metadata.
     */
    static Map<String, Object> view(String id, Stored stored, long localRevision, boolean pending, boolean conflictCopy, boolean revealSecret) {
        Content c = stored.display();
        boolean readOnly = stored.isRaw() || !c.supported();
        boolean redacted = SECRET.equals(c.kind()) && !revealSecret;
        c.extra.clear();
        if (c.items != null) for (Item i : c.items) i.extra.clear();
        if (c.fields != null) for (Field f : c.fields) f.extra.clear();
        c.recurring = knownOnly(c.recurring, RECURRING_KEYS);
        c.planned = knownOnly(c.planned, PLANNED_KEYS);
        c.entries = knownOnly(c.entries, ENTRY_KEYS);
        if (redacted) { c.body = ""; c.memo = null; c.labels = new ArrayList<>(); c.items = null; c.fields = null; }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id);
        out.putAll(c.toMap());
        out.put("localRevision", localRevision);
        out.put("pending", pending);
        out.put("conflict", false);
        out.put("conflictCopy", conflictCopy);
        out.put("readOnly", readOnly);
        out.put("redacted", redacted);
        return out;
    }

    // ----------------------------------------------------------------------------------
    // Save requests

    /** A save request. Absent fields keep the stored value (`color: null` clears the colour). */
    static final class Draft {
        String id;
        long expectedRevision;
        String title, body, kind, memo;
        Boolean pinned, deleted, archived;
        boolean colorPresent;
        String color;
        List<String> labels;
        List<Item> items;
        List<Field> fields;
        String ledger, month;
        boolean hasIncome;
        Long income;
        List<Map<String, Object>> recurring, planned, entries;
    }

    static Draft draft(Object value) throws Shape {
        Map<String, Object> map = object(value, "draft");
        Draft d = new Draft();
        d.id = string(map, "id");
        Object revision = map.get("expectedRevision");
        if (!(revision instanceof Long)) throw new Shape("expectedRevision");
        d.expectedRevision = (Long) revision;
        d.title = optString(map, "title");
        d.body = optString(map, "body");
        d.kind = optString(map, "type");
        d.memo = optString(map, "memo");
        d.pinned = optBool(map, "pinned");
        d.deleted = optBool(map, "deleted");
        d.archived = optBool(map, "archived");
        if (map.containsKey("color")) { d.colorPresent = true; d.color = optString(map, "color"); }
        d.labels = map.get("labels") == null ? null : strings(map.get("labels"), "labels");
        d.items = items(map.get("items"));
        d.fields = fields(map.get("fields"));
        d.ledger = optString(map, "ledger");
        d.month = optString(map, "month");
        if (map.containsKey("income")) { d.hasIncome = true; d.income = income(map.get("income")); }
        d.recurring = ledgerList(map.get("recurring"), "recurring", NotesModel::recurringItem);
        d.planned = ledgerList(map.get("planned"), "planned", NotesModel::plannedItem);
        d.entries = ledgerList(map.get("entries"), "entries", NotesModel::ledgerEntry);
        return d;
    }
    private static Boolean optBool(Map<String, Object> map, String key) throws Shape {
        Object v = map.get(key);
        if (v == null) return null;
        if (!(v instanceof Boolean)) throw new Shape(key);
        return (Boolean) v;
    }

    /** Thrown when a secret note's content would change while its PIN session is closed. */
    static final class SecretLocked extends Exception {
        SecretLocked() { super("암호 메모 잠금을 해제해 주세요."); }
    }

    interface SecretOpen { boolean touch(); }

    /** Applies a save request to the stored content (or a new note). */
    static Content applyDraft(Content old, Draft draft, String now, SecretOpen secretOpen) throws Invalid, SecretLocked {
        Content content = old == null ? Content.fresh(now) : old.copy();
        if (draft.pinned != null) content.pinned = draft.pinned;
        if (draft.deleted != null) content.deleted = draft.deleted;
        if (draft.archived != null) content.archived = draft.archived;
        content.updatedAt = now;
        if (!content.supported()) return content;
        if (draft.kind != null) {
            if (!knownKind(draft.kind)) throw new Invalid("지원하지 않는 메모 형식입니다.");
            if (!draft.kind.equals(content.kind()) && old != null && (SECRET.equals(draft.kind) || SECRET.equals(content.kind())))
                throw new Invalid("암호 메모는 다른 형식으로 바꿀 수 없습니다.");
            if (!draft.kind.equals(content.kind()) && old != null && (ledgerKind(draft.kind) || ledgerKind(content.kind())))
                throw new Invalid("가계부는 다른 형식으로 바꿀 수 없습니다.");
            content.kind = draft.kind;
        }
        if ((draft.ledger != null && content.ledger != null && !content.ledger.equals(draft.ledger)) || (draft.month != null && content.month != null && !content.month.equals(draft.month)))
            throw new Invalid("가계부 월 기록의 가계부와 달은 바꿀 수 없습니다.");
        if (draft.ledger != null) content.ledger = draft.ledger;
        if (draft.month != null) content.month = draft.month;
        if (draft.hasIncome) { content.hasIncome = true; content.income = draft.income; }
        boolean secret = SECRET.equals(content.kind());
        if (secret && (draft.fields != null || draft.memo != null || draft.labels != null) && !secretOpen.touch()) throw new SecretLocked();
        if (draft.title != null) content.title = draft.title;
        if (draft.colorPresent) content.color = draft.color;
        if (draft.labels != null) content.labels = new ArrayList<>(draft.labels);
        String kind = content.kind();
        if (CHECKLIST.equals(kind)) {
            if (draft.items != null) {
                List<Item> items = copyItems(draft.items);
                if (content.items != null) restoreExtra(items, content.items);
                content.items = items;
            }
            content.fields = null;
            content.memo = null;
            clearLedger(content);
        } else if (SECRET.equals(kind)) {
            if (draft.fields != null) {
                List<Field> fields = copyFields(draft.fields);
                if (content.fields != null) restoreExtra(fields, content.fields);
                content.fields = fields;
            }
            if (draft.memo != null) content.memo = draft.memo;
            content.items = null;
            clearLedger(content);
        } else if (LEDGER.equals(kind)) {
            if (draft.recurring != null) content.recurring = restoreLedgerExtra(draft.recurring, content.recurring, RECURRING_KEYS);
            if (draft.planned != null) content.planned = restoreLedgerExtra(draft.planned, content.planned, PLANNED_KEYS);
            content.items = null; content.fields = null; content.memo = null;
            content.entries = null; content.ledger = null; content.month = null;
        } else if (LEDGER_MONTH.equals(kind)) {
            if (draft.entries != null) content.entries = restoreLedgerExtra(draft.entries, content.entries, ENTRY_KEYS);
            content.items = null; content.fields = null; content.memo = null;
            content.recurring = null; content.planned = null;
        } else {
            if (draft.body != null) content.body = draft.body;
            content.items = null;
            content.fields = null;
            content.memo = null;
            clearLedger(content);
        }
        content.normalize();
        String problem = content.validate();
        if (problem != null) throw new Invalid(problem);
        return content;
    }

    /** The UI never sees unknown per-entry keys; keep them by id. */
    private static <T extends Entry> void restoreExtra(List<T> entries, List<T> old) {
        for (T entry : entries) {
            if (!entry.extra.isEmpty()) continue;
            for (T previous : old) if (previous.id.equals(entry.id)) { entry.extra = new LinkedHashMap<>(previous.extra); break; }
        }
    }

    // ----------------------------------------------------------------------------------
    // Three-way merge

    /** One-side rule: the side that changed wins; both changing differently is a collision (null). */
    private static final Object COLLISION = new Object();
    private static Object three(Object base, Object local, Object remote) {
        if (Objects.equals(local, remote) || Objects.equals(local, base)) return remote;
        if (Objects.equals(remote, base)) return local;
        return COLLISION;
    }
    private static Object threeOr(Object base, Object local, Object remote, Object collision) {
        Object result = three(base, local, remote);
        return result == COLLISION ? collision : result;
    }

    private static LinkedHashMap<String, Object> mergeExtra(Map<String, Object> base, Map<String, Object> local, Map<String, Object> remote) {
        LinkedHashSet<String> keys = new LinkedHashSet<>();
        keys.addAll(remote.keySet()); keys.addAll(local.keySet()); keys.addAll(base.keySet());
        LinkedHashMap<String, Object> merged = new LinkedHashMap<>();
        for (String key : keys) {
            // A present JSON null differs from an absent key, as in the Rust Option<&Value>.
            Object b = base.containsKey(key) ? Present.of(base.get(key)) : null;
            Object l = local.containsKey(key) ? Present.of(local.get(key)) : null;
            Object r = remote.containsKey(key) ? Present.of(remote.get(key)) : null;
            Object value = threeOr(b, l, r, r);
            if (value != null) merged.put(key, ((Present) value).value);
        }
        return merged;
    }
    /** A present value that may itself be JSON null. */
    private static final class Present {
        final Object value;
        private Present(Object value) { this.value = value; }
        static Present of(Object value) { return new Present(value); }
        @Override public boolean equals(Object other) { return other instanceof Present && Objects.equals(value, ((Present) other).value); }
        @Override public int hashCode() { return Objects.hashCode(value); }
    }

    private static Item mergeItem(Item b, Item l, Item r) {
        Object text = three(b.text, l.text, r.text);
        if (text == COLLISION) return null;
        Item merged = new Item(r.id, (String) text, (Boolean) threeOr(b.checked, l.checked, r.checked, r.checked), (String) threeOr(b.order, l.order, r.order, r.order));
        merged.extra = mergeExtra(b.extra, l.extra, r.extra);
        return merged;
    }
    private static Field mergeField(Field b, Field l, Field r) {
        Object label = three(b.label, l.label, r.label), value = three(b.value, l.value, r.value);
        if (label == COLLISION || value == COLLISION) return null;
        Field merged = new Field(r.id, (String) label, (String) value, (String) threeOr(b.order, l.order, r.order, r.order));
        merged.extra = mergeExtra(b.extra, l.extra, r.extra);
        return merged;
    }

    @SuppressWarnings("unchecked")
    private static <T extends Entry> List<T> mergeEntries(List<T> base, List<T> local, List<T> remote) {
        Map<String, T> b = index(base), l = index(local), r = index(remote);
        LinkedHashSet<String> ids = new LinkedHashSet<>();
        for (T e : remote) ids.add(e.id);
        for (T e : local) ids.add(e.id);
        for (T e : base) ids.add(e.id);
        List<T> merged = new ArrayList<>();
        for (String id : ids) {
            T be = b.get(id), le = l.get(id), re = r.get(id);
            T entry;
            if (be != null && le != null && re != null) {
                entry = be instanceof Item ? (T) mergeItem((Item) be, (Item) le, (Item) re) : (T) mergeField((Field) be, (Field) le, (Field) re);
                if (entry == null) return null;
            } else if (be != null && le == null && re != null) {
                // Deleted on one side: deletion wins unless the other side edited it.
                entry = re.edited(be) ? (T) re.copy() : null;
            } else if (be != null && le != null) {
                entry = le.edited(be) ? (T) le.copy() : null;
            } else if (le != null && re != null) {
                boolean same = le instanceof Item ? ((Item) le).text.equals(((Item) re).text)
                        : ((Field) le).label.equals(((Field) re).label) && ((Field) le).value.equals(((Field) re).value);
                if (!same) return null;
                entry = (T) re.copy();
            } else if (le != null) {
                entry = (T) le.copy();
            } else if (re != null) {
                entry = (T) re.copy();
            } else {
                entry = null;
            }
            if (entry != null) merged.add(entry);
        }
        sortEntries(merged);
        return merged;
    }
    private static <T extends Entry> Map<String, T> index(List<T> list) {
        Map<String, T> out = new HashMap<>();
        for (T e : list) out.put(e.id, e);
        return out;
    }

    /** Per label: added on either side is added; removed on either side (and in the base) is removed. */
    private static List<String> mergeLabels(List<String> base, List<String> local, List<String> remote) {
        Set<String> b = keys(base), l = keys(local), r = keys(remote);
        Set<String> seen = new HashSet<>();
        List<String> out = new ArrayList<>();
        List<String> all = new ArrayList<>(remote);
        all.addAll(local);
        for (String label : all) {
            String key = labelKey(label);
            boolean keep = b.contains(key) ? l.contains(key) && r.contains(key) : l.contains(key) || r.contains(key);
            if (keep && seen.add(key)) out.add(label);
        }
        return out;
    }
    private static Set<String> keys(List<String> labels) { Set<String> out = new HashSet<>(); for (String l : labels) out.add(labelKey(l)); return out; }

    private static boolean contentChanged(Content side, Content base) {
        return !side.body.equals(base.body) || !Objects.equals(side.memo, base.memo) || !Objects.equals(side.items, base.items) || !Objects.equals(side.fields, base.fields);
    }

    /** Three-way merge of decrypted payloads; null is an unresolvable collision (keep both copies). */
    @SuppressWarnings("unchecked")
    static Content merge(Content base, Content local, Content remote) {
        if (!(base.supported() && local.supported() && remote.supported())) return null;
        if (ledgerKind(base.kind()) || ledgerKind(local.kind()) || ledgerKind(remote.kind())) return mergeLedger(base, local, remote);
        String bk = base.kind(), lk = local.kind(), rk = remote.kind();
        Object kindValue = three(bk, lk, rk);
        if (kindValue == COLLISION) return null;
        String kind = (String) kindValue;
        // A type conversion rewrites the content; it cannot merge with a content edit.
        if ((!lk.equals(bk) && contentChanged(remote, base)) || (!rk.equals(bk) && contentChanged(local, base))) return null;
        List<Item> items;
        if (CHECKLIST.equals(kind)) {
            items = mergeEntries(orEmpty(base.items), orEmpty(local.items), orEmpty(remote.items));
            if (items == null) return null;
        } else {
            items = (List<Item>) threeOr(base.items, local.items, remote.items, remote.items);
        }
        List<Field> fields;
        if (SECRET.equals(kind)) {
            fields = mergeEntries(orEmpty(base.fields), orEmpty(local.fields), orEmpty(remote.fields));
            if (fields == null) return null;
        } else {
            fields = (List<Field>) threeOr(base.fields, local.fields, remote.fields, remote.fields);
        }
        String body = "";
        if (TEXT.equals(kind)) {
            Object merged = three(base.body, local.body, remote.body);
            if (merged == COLLISION) return null;
            body = (String) merged;
        }
        Object title = three(base.title, local.title, remote.title);
        Object memo = three(base.memo, local.memo, remote.memo);
        if (title == COLLISION || memo == COLLISION) return null;
        Content m = new Content();
        m.schema = local.schema == null ? remote.schema : remote.schema == null ? local.schema : Long.valueOf(Math.max(local.schema, remote.schema));
        m.kind = TEXT.equals(kind) ? null : kind;
        m.title = (String) title;
        m.body = body;
        m.memo = (String) memo;
        m.color = (String) threeOr(base.color, local.color, remote.color, remote.color);
        m.labels = mergeLabels(base.labels, local.labels, remote.labels);
        m.items = items == null ? null : copyItems(items);
        m.fields = fields == null ? null : copyFields(fields);
        m.ledger = (String) threeOr(base.ledger, local.ledger, remote.ledger, remote.ledger);
        m.month = (String) threeOr(base.month, local.month, remote.month, remote.month);
        setIncome(m, threeOr(incomeSlot(base), incomeSlot(local), incomeSlot(remote), incomeSlot(remote)));
        m.recurring = copyMaps((List<Map<String, Object>>) threeOr(base.recurring, local.recurring, remote.recurring, remote.recurring));
        m.planned = copyMaps((List<Map<String, Object>>) threeOr(base.planned, local.planned, remote.planned, remote.planned));
        m.entries = copyMaps((List<Map<String, Object>>) threeOr(base.entries, local.entries, remote.entries, remote.entries));
        m.pinned = (Boolean) threeOr(base.pinned, local.pinned, remote.pinned, remote.pinned);
        m.deleted = (Boolean) threeOr(base.deleted, local.deleted, remote.deleted, false);
        m.archived = (Boolean) threeOr(base.archived, local.archived, remote.archived, false);
        m.createdAt = (String) threeOr(base.createdAt, local.createdAt, remote.createdAt, remote.createdAt);
        m.updatedAt = local.updatedAt.compareTo(remote.updatedAt) >= 0 ? local.updatedAt : remote.updatedAt;
        m.extra = mergeExtra(base.extra, local.extra, remote.extra);
        m.normalize();
        return m.validate() == null ? m : null;
    }
    private static <T> List<T> orEmpty(List<T> list) { return list == null ? Collections.<T>emptyList() : list; }

    // ----------------------------------------------------------------------------------
    // Fallback bodies and helpers

    static <T extends Entry> void sortEntries(List<T> entries) {
        Collections.sort(entries, (a, b) -> { int c = a.order.compareTo(b.order); return c != 0 ? c : a.id.compareTo(b.id); });
    }

    static String oneLine(String text) {
        StringBuilder out = new StringBuilder();
        for (String part : text.split("[\r\n]", -1)) {
            if (part.isEmpty()) continue;
            if (out.length() > 0) out.append(' ');
            out.append(part);
        }
        return out.toString();
    }

    /** GFM task list in display order: open items, then the completed group. */
    static String checklistFallback(List<Item> items) {
        List<Item> sorted = new ArrayList<>(items);
        Collections.sort(sorted, (a, b) -> {
            if (a.checked != b.checked) return a.checked ? 1 : -1;
            int c = a.order.compareTo(b.order);
            return c != 0 ? c : a.id.compareTo(b.id);
        });
        StringBuilder out = new StringBuilder();
        for (Item item : sorted) {
            if (out.length() > 0) out.append('\n');
            out.append("- [").append(item.checked ? "x" : " ").append("] ").append(oneLine(item.text));
        }
        return out.toString();
    }

    /** `label: value` lines, then the free text after a blank line. */
    static String secretFallback(List<Field> fields, String memo) {
        List<Field> sorted = new ArrayList<>(fields);
        sortEntries(sorted);
        StringBuilder out = new StringBuilder();
        for (Field f : sorted) {
            if (out.length() > 0) out.append('\n');
            out.append(oneLine(f.label)).append(": ").append(oneLine(f.value));
        }
        if (!memo.isEmpty()) {
            if (out.length() > 0) out.append("\n\n");
            out.append(memo);
        }
        return out.toString();
    }

    /** Ids and fractional order keys: 1–64 printable ASCII characters. */
    static boolean validKey(String value) {
        if (value.isEmpty() || value.length() > MAX_KEY_LEN) return false;
        for (int i = 0; i < value.length(); i++) { char c = value.charAt(i); if (c < 0x21 || c > 0x7e) return false; }
        return true;
    }

    /** Case-insensitive label identity (clients normalize labels to NFC before saving). */
    static String labelKey(String label) { return label.toLowerCase(Locale.ROOT); }

    static int codePoints(String text) { return text.codePointCount(0, text.length()); }
    static int utf8(String text) { return text.getBytes(StandardCharsets.UTF_8).length; }

    private static boolean whitespace(int cp) { return Character.isWhitespace(cp) || Character.isSpaceChar(cp); }
    static String trim(String text) {
        int start = 0, end = text.length();
        while (start < end) { int cp = text.codePointAt(start); if (!whitespace(cp)) break; start += Character.charCount(cp); }
        while (end > start) { int cp = text.codePointBefore(end); if (!whitespace(cp)) break; end -= Character.charCount(cp); }
        return text.substring(start, end);
    }
    private static boolean hasControl(String text) {
        for (int i = 0; i < text.length(); ) { int cp = text.codePointAt(i); if (Character.getType(cp) == Character.CONTROL) return true; i += Character.charCount(cp); }
        return false;
    }

    /** A canonical UUID (the PC and server accept only these as note ids). */
    static boolean uuid(String id) {
        return id != null && id.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
    }

    // ----------------------------------------------------------------------------------
    // Ledger (가계부): a `ledger` note (income, recurring, planned) plus one hidden
    // `ledger-month` note per month (entries). A port of `library/notes/ledger.rs`:
    // collections stay canonical JSON maps; the merge forks an item on a field collision.
    // Charge dates and month figures are computed only by the shared TypeScript.

    static final List<String> RECURRING_KEYS = Collections.unmodifiableList(Arrays.asList("id", "name", "amount", "every", "unit", "start", "trial", "until", "memo", "order", "forkOf"));
    static final List<String> PLANNED_KEYS = Collections.unmodifiableList(Arrays.asList("id", "name", "amount", "month", "memo", "dropped", "order", "forkOf"));
    static final List<String> ENTRY_KEYS = Collections.unmodifiableList(Arrays.asList("id", "date", "amount", "name", "in", "createdAt", "recurring", "planned", "forkOf"));
    /** Keys the merge compares (all known keys but `id` and `order`). */
    private static final List<String> RECURRING_FIELDS = Arrays.asList("name", "amount", "every", "unit", "start", "trial", "until", "memo", "forkOf"), PLANNED_FIELDS = Arrays.asList("name", "amount", "month", "memo", "dropped", "forkOf"), ENTRY_FIELDS = ENTRY_KEYS.subList(1, 9);

    interface ItemParser { Map<String, Object> parse(Object value) throws Shape; }

    /** A JSON integer 0..Long.MAX (Rust `u64`). */
    static Long count(Map<String, Object> map, String key) throws Shape {
        Object v = map.get(key);
        if (!(v instanceof Long) || (Long) v < 0) throw new Shape(key);
        return (Long) v;
    }
    static Long income(Object v) throws Shape { return unsigned(v, "income"); }
    private static void putOpt(Map<String, Object> out, String key, Object value) { if (value != null) out.put(key, value); }
    private static void extras(Map<String, Object> in, Map<String, Object> out, List<String> known) {
        for (Map.Entry<String, Object> e : in.entrySet()) if (!known.contains(e.getKey())) out.put(e.getKey(), e.getValue());
    }
    static Map<String, Object> recurringItem(Object value) throws Shape {
        Map<String, Object> m = object(value, "recurring"), out = new LinkedHashMap<>();
        out.put("id", string(m, "id")); out.put("name", string(m, "name")); out.put("amount", count(m, "amount")); out.put("every", count(m, "every"));
        out.put("unit", string(m, "unit")); out.put("start", string(m, "start")); out.put("trial", defaultBool(m, "trial")); out.put("until", optString(m, "until"));
        out.put("memo", m.containsKey("memo") ? string(m, "memo") : ""); out.put("order", string(m, "order")); putOpt(out, "forkOf", optString(m, "forkOf"));
        extras(m, out, RECURRING_KEYS);
        return out;
    }
    static Map<String, Object> plannedItem(Object value) throws Shape {
        Map<String, Object> m = object(value, "planned"), out = new LinkedHashMap<>();
        out.put("id", string(m, "id")); out.put("name", string(m, "name")); out.put("amount", count(m, "amount")); out.put("month", optString(m, "month"));
        out.put("memo", m.containsKey("memo") ? string(m, "memo") : ""); out.put("dropped", defaultBool(m, "dropped")); out.put("order", string(m, "order"));
        putOpt(out, "forkOf", optString(m, "forkOf"));
        extras(m, out, PLANNED_KEYS);
        return out;
    }
    static Map<String, Object> ledgerEntry(Object value) throws Shape {
        Map<String, Object> m = object(value, "entries"), out = new LinkedHashMap<>();
        out.put("id", string(m, "id")); out.put("date", string(m, "date")); out.put("amount", count(m, "amount")); out.put("name", string(m, "name"));
        if (defaultBool(m, "in")) out.put("in", true);
        out.put("createdAt", string(m, "createdAt"));
        if (m.get("recurring") != null) {
            Map<String, Object> ref = object(m.get("recurring"), "recurring"), charge = new LinkedHashMap<>();
            charge.put("id", string(ref, "id")); charge.put("date", string(ref, "date"));
            extras(ref, charge, Arrays.asList("id", "date"));
            out.put("recurring", charge);
        }
        putOpt(out, "planned", optString(m, "planned"));
        putOpt(out, "forkOf", optString(m, "forkOf"));
        extras(m, out, ENTRY_KEYS);
        return out;
    }
    static List<Map<String, Object>> ledgerList(Object value, String key, ItemParser parser) throws Shape {
        if (value == null) return null;
        if (!(value instanceof List)) throw new Shape(key);
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object entry : (List<?>) value) out.add(parser.parse(entry));
        return out;
    }
    static List<Map<String, Object>> copyMaps(List<Map<String, Object>> list) {
        if (list == null) return null;
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> m : list) out.add(new LinkedHashMap<>(m));
        return out;
    }
    /** The WebView never receives unknown per-item keys. */
    static List<Map<String, Object>> knownOnly(List<Map<String, Object>> list, List<String> keys) {
        if (list == null) return null;
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> m : list) { Map<String, Object> k = new LinkedHashMap<>(); for (Map.Entry<String, Object> e : m.entrySet()) if (keys.contains(e.getKey())) k.put(e.getKey(), e.getValue()); out.add(k); }
        return out;
    }
    /** A save restores unknown per-item keys by id (for items the draft sent without any). */
    private static List<Map<String, Object>> restoreLedgerExtra(List<Map<String, Object>> items, List<Map<String, Object>> old, List<String> keys) {
        List<Map<String, Object>> out = copyMaps(items);
        if (old == null) return out;
        for (Map<String, Object> item : out) {
            if (!keys.containsAll(item.keySet())) continue;
            for (Map<String, Object> previous : old) if (previous.get("id").equals(item.get("id"))) { extras(previous, item, keys); break; }
        }
        return out;
    }
    private static void clearLedger(Content c) { c.ledger = null; c.month = null; c.hasIncome = false; c.income = null; c.recurring = null; c.planned = null; c.entries = null; }

    // Calendar strings and limits

    private static int daysInMonth(int year, int month) {
        if (month == 2) return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 ? 29 : 28;
        return month == 4 || month == 6 || month == 9 || month == 11 ? 30 : 31;
    }
    private static boolean digits(String text) { if (text.isEmpty()) return false; for (int i = 0; i < text.length(); i++) if (text.charAt(i) < '0' || text.charAt(i) > '9') return false; return true; }
    /** `YYYY-MM`. */
    static boolean validMonth(String value) {
        if (value == null || value.length() != 7 || value.charAt(4) != '-' || !digits(value.substring(0, 4)) || !digits(value.substring(5))) return false;
        int month = Integer.parseInt(value.substring(5));
        return month >= 1 && month <= 12;
    }
    /** `YYYY-MM-DD`, a real calendar date. */
    static boolean validDate(String value) {
        if (value == null || value.length() != 10 || value.charAt(7) != '-' || !validMonth(value.substring(0, 7)) || !digits(value.substring(8))) return false;
        int day = Integer.parseInt(value.substring(8));
        return day >= 1 && day <= daysInMonth(Integer.parseInt(value.substring(0, 4)), Integer.parseInt(value.substring(5, 7)));
    }
    private interface Check { String problem(Map<String, Object> item); }
    private static final String AMOUNT_PROBLEM = "금액은 0원 이상 1조 원 미만의 정수로 입력해 주세요.", NAME_PROBLEM = "이름은 100자, 메모는 500자까지 쓸 수 있습니다.";
    private static boolean amountOk(Object amount) { return amount instanceof Long && (Long) amount >= 0 && (Long) amount < AMOUNT_BOUND; }
    private static boolean key(Object value) { return value instanceof String && validKey((String) value); }
    private static String checkList(List<Map<String, Object>> list, int max, String tooMany, String malformed, Check check) {
        if (list == null) return null;
        if (list.size() > max) return tooMany;
        Set<Object> ids = new HashSet<>();
        for (Map<String, Object> item : list) {
            if (!key(item.get("id")) || !ids.add(item.get("id")) || (item.get("forkOf") != null && !key(item.get("forkOf")))) return malformed;
            String problem = check.problem(item);
            if (problem != null) return problem;
        }
        return null;
    }
    /** Every ledger limit (design §4.4); null when valid. */
    static String validateLedger(Content c) {
        if (c.income != null && !amountOk(c.income)) return AMOUNT_PROBLEM;
        String problem = checkList(c.recurring, MAX_RECURRING, "고정·구독은 200개까지 저장할 수 있습니다.", "고정·구독 형식이 올바르지 않습니다.", r -> {
            if (codePoints((String) r.get("name")) > MAX_LEDGER_NAME_CHARS || codePoints((String) r.get("memo")) > MAX_LEDGER_MEMO_CHARS) return NAME_PROBLEM;
            if (!amountOk(r.get("amount"))) return AMOUNT_PROBLEM;
            long every = (Long) r.get("every");
            if (every < 1 || every > MAX_EVERY || !Arrays.asList("week", "month", "year").contains(r.get("unit"))) return "주기는 1~120 사이로 입력해 주세요.";
            if (!validDate((String) r.get("start")) || (r.get("until") != null && !validDate((String) r.get("until"))) || !key(r.get("order"))) return "고정·구독 날짜가 올바르지 않습니다.";
            return null;
        });
        if (problem != null) return problem;
        problem = checkList(c.planned, MAX_PLANNED, "계획은 300개까지 저장할 수 있습니다.", "계획 형식이 올바르지 않습니다.", p -> {
            if (codePoints((String) p.get("name")) > MAX_LEDGER_NAME_CHARS || codePoints((String) p.get("memo")) > MAX_LEDGER_MEMO_CHARS) return NAME_PROBLEM;
            if (!amountOk(p.get("amount"))) return AMOUNT_PROBLEM;
            if ((p.get("month") != null && !validMonth((String) p.get("month"))) || !key(p.get("order"))) return "계획 형식이 올바르지 않습니다.";
            return null;
        });
        if (problem != null) return problem;
        if (LEDGER_MONTH.equals(c.kind()) && !(key(c.ledger) && validMonth(c.month))) return "가계부 월 기록 형식이 올바르지 않습니다.";
        problem = checkList(c.entries, MAX_ENTRIES, "기록은 500개까지 저장할 수 있습니다.", "기록 형식이 올바르지 않습니다.", e -> {
            if (codePoints((String) e.get("name")) > MAX_LEDGER_NAME_CHARS) return "기록 이름은 100자까지 쓸 수 있습니다.";
            if (!amountOk(e.get("amount"))) return AMOUNT_PROBLEM;
            if (!validDate((String) e.get("date")) || !key(e.get("createdAt"))) return "기록 날짜가 올바르지 않습니다.";
            Object ref = e.get("recurring");
            if ((ref instanceof Map && (!key(((Map<?, ?>) ref).get("id")) || !validDate((String) ((Map<?, ?>) ref).get("date")))) || (e.get("planned") != null && !key(e.get("planned")))) return "기록 형식이 올바르지 않습니다.";
            return null;
        });
        if (problem != null) return problem;
        if (ledgerKind(c.kind()) && utf8(c.body) > MAX_LEDGER_BODY_BYTES) return "가계부 요약이 너무 깁니다.";
        return null;
    }

    // Canonical order and the text fallback body

    private static String str(Map<String, Object> m, String key) { Object v = m.get(key); return v instanceof String ? (String) v : ""; }
    static void sortByOrder(List<Map<String, Object>> list) {
        Collections.sort(list, (a, b) -> { int c = str(a, "order").compareTo(str(b, "order")); return c != 0 ? c : str(a, "id").compareTo(str(b, "id")); });
    }
    /** Entries: date desc, createdAt desc, then id. */
    static void sortLedgerEntries(List<Map<String, Object>> list) {
        Collections.sort(list, (a, b) -> {
            int c = str(b, "date").compareTo(str(a, "date"));
            if (c == 0) c = str(b, "createdAt").compareTo(str(a, "createdAt"));
            return c != 0 ? c : str(a, "id").compareTo(str(b, "id"));
        });
    }
    /** 2300000 → "₩2,300,000". */
    static String won(long amount) {
        String digits = Long.toString(amount);
        StringBuilder out = new StringBuilder("₩");
        for (int i = 0; i < digits.length(); i++) { if (i > 0 && (digits.length() - i) % 3 == 0) out.append(','); out.append(digits.charAt(i)); }
        return out.toString();
    }
    private static long amount(Map<String, Object> m) { Object v = m.get("amount"); return v instanceof Long ? (Long) v : 0; }
    private static String words(String... parts) {
        StringBuilder out = new StringBuilder();
        for (String p : parts) { if (p.isEmpty()) continue; if (out.length() > 0) out.append(' '); out.append(p); }
        return out.toString();
    }
    private static String monthLabel(String month) {
        return validMonth(month) ? Integer.parseInt(month.substring(0, 4)) + "년 " + Integer.parseInt(month.substring(5)) + "월" : month;
    }
    private static String cycleWord(long every, String unit) {
        if (every == 1) return "week".equals(unit) ? "매주" : "month".equals(unit) ? "매월" : "매년";
        return every + ("week".equals(unit) ? "주" : "month".equals(unit) ? "개월" : "년") + "마다";
    }
    /** Over 24 KiB, keeps the longest prefix of lines that fits with "… N건 더" (N = dropped list lines). */
    private static String fitLines(List<String> lines) {
        String full = String.join("\n", lines);
        if (utf8(full) <= MAX_LEDGER_BODY_BYTES) return full;
        int[] after = new int[lines.size() + 1];
        for (int i = lines.size() - 1; i >= 0; i--) after[i] = after[i + 1] + (lines.get(i).startsWith("- ") ? 1 : 0);
        int best = 0, prefix = 0;
        for (int p = 0; p <= lines.size(); p++) {
            if (p > 0) prefix += utf8(lines.get(p - 1)) + (p > 1 ? 1 : 0);
            if (prefix + (p > 0 ? 1 : 0) + utf8("… " + after[p] + "건 더") <= MAX_LEDGER_BODY_BYTES) best = p;
        }
        List<String> kept = new ArrayList<>(lines.subList(0, best));
        kept.add("… " + after[best] + "건 더");
        return String.join("\n", kept);
    }
    static String ledgerFallback(String title, Long income, List<Map<String, Object>> recurring, List<Map<String, Object>> planned) {
        List<String> lines = new ArrayList<>();
        String heading = oneLine(title);
        lines.add("# " + (heading.isEmpty() ? "가계부" : heading));
        if (income != null) lines.add("월 수입 " + won(income));
        if (!recurring.isEmpty()) {
            List<Map<String, Object>> sorted = new ArrayList<>(recurring);
            sortByOrder(sorted);
            lines.add(""); lines.add("## 고정·구독");
            for (Map<String, Object> r : sorted) {
                Object every = r.get("every"), until = r.get("until");
                StringBuilder line = new StringBuilder("- ").append(words(oneLine(str(r, "name")), won(amount(r)))).append(" · ")
                        .append(cycleWord(every instanceof Long ? (Long) every : 0, str(r, "unit"))).append(" · ").append(str(r, "start")).append("부터");
                if (Boolean.TRUE.equals(r.get("trial"))) line.append(" · 무료 체험");
                if (until instanceof String && !((String) until).isEmpty()) line.append(" · ").append(until).append(" 만료");
                lines.add(line.toString());
            }
        }
        if (!planned.isEmpty()) {
            List<Map<String, Object>> sorted = new ArrayList<>(planned);
            sortByOrder(sorted);
            lines.add(""); lines.add("## 사고 싶은 것");
            for (Map<String, Object> p : sorted)
                lines.add("- " + words(oneLine(str(p, "name")), won(amount(p))) + " · " + (p.get("month") instanceof String ? p.get("month") : "언젠가") + (Boolean.TRUE.equals(p.get("dropped")) ? " · 안 사기로 함" : ""));
        }
        return fitLines(lines);
    }
    static String monthFallback(String month, Long income, List<Map<String, Object>> entries) {
        List<String> lines = new ArrayList<>();
        lines.add("# " + monthLabel(month) + " 기록 (" + entries.size() + "건)");
        if (income != null) lines.add("수입 " + won(income));
        List<Map<String, Object>> sorted = new ArrayList<>(entries);
        sortLedgerEntries(sorted);
        for (Map<String, Object> e : sorted) {
            String date = str(e, "date");
            lines.add("- " + words((date.length() >= 5 ? date.substring(5) : "") + " " + (Boolean.TRUE.equals(e.get("in")) ? "+" : "") + won(amount(e)), oneLine(str(e, "name"))));
        }
        return fitLines(lines);
    }

    // Ids

    /** UUID v4 layout (version 4, RFC 4122 variant) of the first 16 bytes. */
    private static String uuidShape(byte[] digest) {
        byte[] b = Arrays.copyOf(digest, 16);
        b[6] = (byte) ((b[6] & 0x0f) | 0x40);
        b[8] = (byte) ((b[8] & 0x3f) | 0x80);
        StringBuilder hex = new StringBuilder();
        for (int i = 0; i < 16; i++) hex.append(String.format("%02x", b[i] & 0xff));
        return hex.substring(0, 8) + "-" + hex.substring(8, 12) + "-" + hex.substring(12, 16) + "-" + hex.substring(16, 20) + "-" + hex.substring(20, 32);
    }
    private static byte[] hmac(byte[] key, byte[] message) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(message);
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }
    /**
     * Deterministic month-note id, so offline devices converge on one note: HMAC-SHA256 under
     * an HKDF-SHA256 subkey of the notes key (never the AES-GCM key itself).
     */
    static String monthId(byte[] notesKey, String ledger, String month) {
        byte[] prk = hmac("lakomics-notes-ledger:1".getBytes(StandardCharsets.UTF_8), notesKey);
        byte[] monthKey = hmac(prk, "ledger-month-id\u0001".getBytes(StandardCharsets.UTF_8));
        return uuidShape(hmac(monthKey, ("lakomics-ledger-month:1:" + ledger + ":" + month).getBytes(StandardCharsets.UTF_8)));
    }
    /** Canonical lowercase hyphenated UUID text. */
    static boolean canonicalUuid(String id) { return id != null && id.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"); }
    /** Id of the local copy of an item both sides changed differently; `stamp` = "local updatedAt:remote updatedAt". */
    static String forkId(String stamp, String id) {
        try {
            return uuidShape(MessageDigest.getInstance("SHA-256").digest(("lakomics-ledger-fork:1:" + stamp + ":" + id).getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }

    // Merge

    /** A pulled month note meeting a local copy with no merge base: merge against an empty month. */
    static Content emptyMonthBase(Content local, Content remote) {
        if (!LEDGER_MONTH.equals(local.kind()) || !LEDGER_MONTH.equals(remote.kind()) || local.ledger == null || !local.ledger.equals(remote.ledger) || !Objects.equals(local.month, remote.month)) return null;
        Content base = Content.fresh("");
        base.schema = SUPPORTED_SCHEMA; base.kind = LEDGER_MONTH; base.ledger = local.ledger; base.month = local.month;
        base.hasIncome = true; base.entries = new ArrayList<>(); base.archived = true;
        return base;
    }
    private static Object incomeSlot(Content c) { return c.hasIncome ? Present.of(c.income) : null; }
    private static void setIncome(Content c, Object slot) { c.hasIncome = slot != null; c.income = slot == null ? null : (Long) ((Present) slot).value; }
    private static Object slot(Map<String, Object> m, String key) { return m.containsKey(key) ? Present.of(m.get(key)) : null; }
    private static boolean edited(List<String> fields, Map<String, Object> side, Map<String, Object> base) {
        for (String k : fields) if (!Objects.equals(slot(side, k), slot(base, k))) return true;
        return false;
    }
    /** Per key: one-side rule; `order` and unknown keys take remote on a collision; null when a known field collides. */
    private static Map<String, Object> mergeObject(List<String> fields, Map<String, Object> b, Map<String, Object> l, Map<String, Object> r) {
        LinkedHashSet<String> keys = new LinkedHashSet<>(r.keySet());
        keys.addAll(l.keySet()); keys.addAll(b.keySet());
        Map<String, Object> out = new LinkedHashMap<>();
        for (String key : keys) {
            Object bv = slot(b, key), lv = slot(l, key), rv = slot(r, key), v;
            if (Objects.equals(lv, rv) || Objects.equals(lv, bv)) v = rv;
            else if (Objects.equals(rv, bv)) v = lv;
            else if (fields.contains(key)) return null;
            else v = rv;
            if (v != null) out.put(key, ((Present) v).value);
        }
        return out;
    }
    private static Map<String, Object> fork(Map<String, Object> local, String id, String stamp) {
        Map<String, Object> copy = new LinkedHashMap<>(local);
        copy.put("id", forkId(stamp, id));
        copy.put("forkOf", id);
        return copy;
    }
    private static Map<String, Map<String, Object>> byId(List<Map<String, Object>> list) {
        Map<String, Map<String, Object>> out = new HashMap<>();
        for (Map<String, Object> m : list) out.put((String) m.get("id"), m);
        return out;
    }
    /** Per-id merge of one collection; a field collision keeps the remote version and forks the local one. */
    private static List<Map<String, Object>> mergeList(List<Map<String, Object>> base, List<Map<String, Object>> local, List<Map<String, Object>> remote, List<String> fields, ItemParser parser, String stamp) throws Shape {
        Map<String, Map<String, Object>> b = byId(base), l = byId(local), r = byId(remote);
        LinkedHashSet<String> ids = new LinkedHashSet<>();
        for (Map<String, Object> m : remote) ids.add((String) m.get("id"));
        for (Map<String, Object> m : local) ids.add((String) m.get("id"));
        for (Map<String, Object> m : base) ids.add((String) m.get("id"));
        List<Map<String, Object>> merged = new ArrayList<>();
        for (String id : ids) {
            Map<String, Object> be = b.get(id), le = l.get(id), re = r.get(id);
            if (be != null && le != null && re != null) {
                Map<String, Object> m = mergeObject(fields, be, le, re);
                if (m != null) merged.add(m); else { merged.add(re); merged.add(fork(le, id, stamp)); }
            } else if (be != null && le == null && re != null) {
                // Deleted on one side: deletion wins unless the other side edited it.
                if (edited(fields, re, be)) merged.add(re);
            } else if (be != null && le != null) {
                if (edited(fields, le, be)) merged.add(le);
            } else if (le != null && re != null) {
                Map<String, Object> moved = new LinkedHashMap<>(le);
                if (re.containsKey("order")) moved.put("order", re.get("order"));
                if (moved.equals(re)) merged.add(re); else { merged.add(re); merged.add(fork(le, id, stamp)); }
            } else if (le != null) merged.add(le);
            else if (re != null) merged.add(re);
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> m : merged) out.add(parser.parse(m));
        return out;
    }
    private static List<Map<String, Object>> mergeOptList(List<Map<String, Object>> base, List<Map<String, Object>> local, List<Map<String, Object>> remote, List<String> fields, ItemParser parser, String stamp) throws Shape {
        if (local == null && remote == null) return null;
        return mergeList(orEmpty(base), orEmpty(local), orEmpty(remote), fields, parser, stamp);
    }
    /** Three-way merge when any side is a ledger type; null (keep both) only when type, ledger or month differ or a limit breaks. */
    @SuppressWarnings("unchecked")
    static Content mergeLedger(Content base, Content local, Content remote) {
        if (!base.kind().equals(local.kind()) || !local.kind().equals(remote.kind()) || !Objects.equals(base.ledger, local.ledger) || !Objects.equals(local.ledger, remote.ledger)
                || !Objects.equals(base.month, local.month) || !Objects.equals(local.month, remote.month)) return null;
        String stamp = local.updatedAt + ":" + remote.updatedAt;
        Content m = new Content();
        m.schema = local.schema == null ? remote.schema : remote.schema == null ? local.schema : Long.valueOf(Math.max(local.schema, remote.schema));
        m.kind = remote.kind;
        m.title = (String) threeOr(base.title, local.title, remote.title, remote.title);
        m.memo = (String) threeOr(base.memo, local.memo, remote.memo, remote.memo);
        m.color = (String) threeOr(base.color, local.color, remote.color, remote.color);
        m.labels = mergeLabels(base.labels, local.labels, remote.labels);
        List<Item> items = (List<Item>) threeOr(base.items, local.items, remote.items, remote.items);
        List<Field> fields = (List<Field>) threeOr(base.fields, local.fields, remote.fields, remote.fields);
        m.items = items == null ? null : copyItems(items);
        m.fields = fields == null ? null : copyFields(fields);
        m.ledger = remote.ledger;
        m.month = remote.month;
        setIncome(m, threeOr(incomeSlot(base), incomeSlot(local), incomeSlot(remote), incomeSlot(remote)));
        try {
            m.recurring = mergeOptList(base.recurring, local.recurring, remote.recurring, RECURRING_FIELDS, NotesModel::recurringItem, stamp);
            m.planned = mergeOptList(base.planned, local.planned, remote.planned, PLANNED_FIELDS, NotesModel::plannedItem, stamp);
            m.entries = mergeOptList(base.entries, local.entries, remote.entries, ENTRY_FIELDS, NotesModel::ledgerEntry, stamp);
        } catch (Shape unexpected) { return null; }
        m.pinned = (Boolean) threeOr(base.pinned, local.pinned, remote.pinned, remote.pinned);
        m.deleted = (Boolean) threeOr(base.deleted, local.deleted, remote.deleted, false);
        m.archived = (Boolean) threeOr(base.archived, local.archived, remote.archived, false);
        m.createdAt = (String) threeOr(base.createdAt, local.createdAt, remote.createdAt, remote.createdAt);
        m.updatedAt = local.updatedAt.compareTo(remote.updatedAt) >= 0 ? local.updatedAt : remote.updatedAt;
        m.extra = mergeExtra(base.extra, local.extra, remote.extra);
        m.normalize();
        return m.validate() == null ? m : null;
    }

    // ----------------------------------------------------------------------------------
    // JSON writer for the values `Json` reads (maps, lists, strings, longs, doubles, booleans, null)

    static String write(Object value) {
        StringBuilder out = new StringBuilder();
        write(out, value);
        return out.toString();
    }
    private static void write(StringBuilder out, Object value) {
        if (value == null) out.append("null");
        else if (value instanceof String) quote(out, (String) value);
        else if (value instanceof Boolean || value instanceof Long || value instanceof Integer) out.append(value);
        else if (value instanceof Double) {
            double d = (Double) value;
            if (Double.isNaN(d) || Double.isInfinite(d)) out.append("null"); else out.append(d);
        } else if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Iterator<? extends Map.Entry<?, ?>> it = ((Map<?, ?>) value).entrySet().iterator(); it.hasNext(); ) {
                Map.Entry<?, ?> e = it.next();
                if (!first) out.append(',');
                first = false;
                quote(out, String.valueOf(e.getKey()));
                out.append(':');
                write(out, e.getValue());
            }
            out.append('}');
        } else if (value instanceof List) {
            out.append('[');
            boolean first = true;
            for (Object entry : (List<?>) value) { if (!first) out.append(','); first = false; write(out, entry); }
            out.append(']');
        } else throw new IllegalArgumentException("Unsupported JSON value");
    }
    private static void quote(StringBuilder out, String text) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c)); else out.append(c);
            }
        }
        out.append('"');
    }

    /** Parses a decrypted payload; its size is bounded by the envelope cap. */
    static Object parsePayload(String text) {
        return Json.parse(text, 1_000_000, 128);
    }
}
