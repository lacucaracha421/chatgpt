package com.lakomics.mobile;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal strict JSON reader for the native replica protocol.
 *
 * The Album replica engine deliberately depends on no Android class, so that the part
 * which decides what the replica holds can run in the JVM check harness. In that
 * harness the platform's own `org.json` is a compile-time stub that throws at runtime,
 * so this reader replaces it there and on the device alike.
 *
 * It is stricter than a general-purpose parser on purpose: every document it reads is
 * a bounded server response whose exact shape the domain contract already defines.
 * Duplicate keys, trailing content, excessive nesting and oversized bodies are
 * rejected rather than interpreted, so ambiguity in a response can never become
 * ambiguity in accepted state.
 */
final class Json {
    /** The authenticated transport already bounds one response to 4 MiB. */
    static final int MAX_LENGTH = 4 * 1024 * 1024;
    static final int MAX_DEPTH = 16;

    private final String text;
    private int maxDepth = MAX_DEPTH;
    private int at;

    private Json(String text) { this.text = text; }

    /** Parse one complete document into maps, lists, strings, longs, booleans or null. */
    static Object parse(String text) {
        return parse(text, MAX_LENGTH, MAX_DEPTH);
    }

    static Object parse(String text, int maxLength, int maxDepth) {
        if (text == null) throw new IllegalArgumentException("Missing JSON body");
        if (text.length() > maxLength) throw new IllegalArgumentException("JSON body is too large");
        Json reader = new Json(text);
        reader.maxDepth = maxDepth;
        reader.space();
        Object value = reader.value(0);
        reader.space();
        if (reader.at != reader.text.length()) throw new IllegalArgumentException("Trailing JSON content");
        return value;
    }

    /** Serialize maps, lists, strings, integers, doubles, booleans and null; the inverse of {@link #parse}. */
    static String write(Object value) {
        StringBuilder out = new StringBuilder();
        write(out, value);
        return out.toString();
    }

    private static void write(StringBuilder out, Object value) {
        if (value == null) { out.append("null"); return; }
        if (value instanceof String) { quote(out, (String) value); return; }
        if (value instanceof Boolean || value instanceof Long || value instanceof Integer) { out.append(value); return; }
        if (value instanceof Double) {
            double number = (Double) value;
            if (Double.isNaN(number) || Double.isInfinite(number)) throw new IllegalArgumentException("Unwritable JSON number");
            out.append(number);
            return;
        }
        if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!(entry.getKey() instanceof String)) throw new IllegalArgumentException("Unwritable JSON key");
                if (!first) out.append(',');
                first = false;
                quote(out, (String) entry.getKey());
                out.append(':');
                write(out, entry.getValue());
            }
            out.append('}');
            return;
        }
        if (value instanceof List) {
            out.append('[');
            boolean first = true;
            for (Object item : (List<?>) value) {
                if (!first) out.append(',');
                first = false;
                write(out, item);
            }
            out.append(']');
            return;
        }
        throw new IllegalArgumentException("Unwritable JSON value");
    }

    private static void quote(StringBuilder out, String text) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        out.append('"');
    }

    private void space() {
        while (at < text.length()) {
            char c = text.charAt(at);
            if (c != ' ' && c != '\t' && c != '\n' && c != '\r') return;
            at++;
        }
    }

    private Object value(int depth) {
        if (depth > maxDepth) throw new IllegalArgumentException("JSON nesting is too deep");
        if (at >= text.length()) throw new IllegalArgumentException("Truncated JSON body");
        char c = text.charAt(at);
        if (c == '{') return object(depth);
        if (c == '[') return array(depth);
        if (c == '"') return string();
        if (text.startsWith("true", at)) { at += 4; return Boolean.TRUE; }
        if (text.startsWith("false", at)) { at += 5; return Boolean.FALSE; }
        if (text.startsWith("null", at)) { at += 4; return null; }
        return number();
    }

    private Map<String, Object> object(int depth) {
        Map<String, Object> result = new LinkedHashMap<>();
        at++;
        space();
        if (at < text.length() && text.charAt(at) == '}') { at++; return result; }
        while (true) {
            space();
            if (at >= text.length() || text.charAt(at) != '"') throw new IllegalArgumentException("Malformed JSON object");
            String key = string();
            space();
            if (at >= text.length() || text.charAt(at) != ':') throw new IllegalArgumentException("Malformed JSON object");
            at++;
            space();
            // A repeated key would let two readers of one body disagree about its value.
            if (result.containsKey(key)) throw new IllegalArgumentException("Duplicate JSON key");
            result.put(key, value(depth + 1));
            space();
            if (at >= text.length()) throw new IllegalArgumentException("Truncated JSON body");
            char c = text.charAt(at++);
            if (c == '}') return result;
            if (c != ',') throw new IllegalArgumentException("Malformed JSON object");
        }
    }

    private List<Object> array(int depth) {
        List<Object> result = new ArrayList<>();
        at++;
        space();
        if (at < text.length() && text.charAt(at) == ']') { at++; return result; }
        while (true) {
            space();
            result.add(value(depth + 1));
            space();
            if (at >= text.length()) throw new IllegalArgumentException("Truncated JSON body");
            char c = text.charAt(at++);
            if (c == ']') return result;
            if (c != ',') throw new IllegalArgumentException("Malformed JSON array");
        }
    }

    private String string() {
        at++;
        StringBuilder result = new StringBuilder();
        while (true) {
            if (at >= text.length()) throw new IllegalArgumentException("Truncated JSON string");
            char c = text.charAt(at++);
            if (c == '"') return result.toString();
            if (c == '\\') {
                if (at >= text.length()) throw new IllegalArgumentException("Truncated JSON escape");
                char escape = text.charAt(at++);
                switch (escape) {
                    case '"': result.append('"'); break;
                    case '\\': result.append('\\'); break;
                    case '/': result.append('/'); break;
                    case 'b': result.append('\b'); break;
                    case 'f': result.append('\f'); break;
                    case 'n': result.append('\n'); break;
                    case 'r': result.append('\r'); break;
                    case 't': result.append('\t'); break;
                    case 'u':
                        if (at + 4 > text.length()) throw new IllegalArgumentException("Truncated JSON escape");
                        try { result.append((char) Integer.parseInt(text.substring(at, at + 4), 16)); }
                        catch (NumberFormatException invalid) { throw new IllegalArgumentException("Malformed JSON escape"); }
                        at += 4;
                        break;
                    default: throw new IllegalArgumentException("Malformed JSON escape");
                }
                continue;
            }
            if (c < 0x20) throw new IllegalArgumentException("Unescaped JSON control character");
            result.append(c);
        }
    }

    private Object number() {
        int start = at;
        if (at < text.length() && text.charAt(at) == '-') at++;
        int digits = at;
        while (at < text.length() && text.charAt(at) >= '0' && text.charAt(at) <= '9') at++;
        if (at == digits) throw new IllegalArgumentException("Malformed JSON number");
        if (at - digits > 1 && text.charAt(digits) == '0') throw new IllegalArgumentException("Malformed JSON number");
        boolean integral = true;
        if (at < text.length() && text.charAt(at) == '.') {
            integral = false;
            at++;
            int fraction = at;
            while (at < text.length() && text.charAt(at) >= '0' && text.charAt(at) <= '9') at++;
            if (at == fraction) throw new IllegalArgumentException("Malformed JSON number");
        }
        if (at < text.length() && (text.charAt(at) == 'e' || text.charAt(at) == 'E')) {
            integral = false;
            at++;
            if (at < text.length() && (text.charAt(at) == '+' || text.charAt(at) == '-')) at++;
            int exponent = at;
            while (at < text.length() && text.charAt(at) >= '0' && text.charAt(at) <= '9') at++;
            if (at == exponent) throw new IllegalArgumentException("Malformed JSON number");
        }
        String literal = text.substring(start, at);
        try { return integral ? (Object) Long.valueOf(literal) : (Object) Double.valueOf(literal); }
        catch (NumberFormatException invalid) { throw new IllegalArgumentException("Malformed JSON number"); }
    }
}
