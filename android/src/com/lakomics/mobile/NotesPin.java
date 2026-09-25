package com.lakomics.mobile;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * Per-device PIN for secret notes (암호 메모), its escalating lockout and the in-memory
 * unlock session. Mirrors the PC `library/notes/secret.rs`: a salted PBKDF2-HMAC-SHA256
 * verifier with the same parameters, never synced, exported or backed up. The PIN is a
 * local screen lock, not an additional encryption layer.
 */
final class NotesPin {
    static final int ITERATIONS = 310_000;
    /** Re-lock after this much inactivity even if the UI never asked. */
    static final long IDLE_LOCK_MS = 5 * 60_000L;
    static final int MAX_FAILURES = 5;
    private static final long[] STEPS = {30, 60, 300, 900, 1800, 3600};

    private NotesPin() {}

    /** 4–8 ASCII digits. */
    static boolean valid(String pin) {
        if (pin == null || pin.length() < 4 || pin.length() > 8) return false;
        for (int i = 0; i < pin.length(); i++) { char c = pin.charAt(i); if (c < '0' || c > '9') return false; }
        return true;
    }

    private static byte[] derive(String pin, byte[] salt, int iterations) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(pin.toCharArray(), salt, iterations, 256);
        try { return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded(); }
        finally { spec.clearPassword(); }
    }

    /** The stored verifier `{v, iterations, salt, hash}` (hex), as on the PC. */
    static String makeVerifier(String pin, int iterations) throws Exception {
        if (!valid(pin)) throw new IllegalArgumentException("Invalid PIN");
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        Map<String, Object> verifier = new LinkedHashMap<>();
        verifier.put("v", 1L);
        verifier.put("iterations", (long) iterations);
        verifier.put("salt", NotesCrypto.hex(salt));
        verifier.put("hash", NotesCrypto.hex(derive(pin, salt, iterations)));
        return NotesModel.write(verifier);
    }

    static boolean check(String verifierJson, String pin) {
        try {
            if (!valid(pin)) return false;
            Map<String, Object> verifier = NotesModel.object(Json.parse(verifierJson), "verifier");
            Object v = verifier.get("v"), iterations = verifier.get("iterations");
            if (!Long.valueOf(1).equals(v) || !(iterations instanceof Long) || (Long) iterations < 1 || (Long) iterations > 10_000_000) return false;
            byte[] salt = NotesCrypto.unhex(NotesModel.string(verifier, "salt"));
            byte[] hash = NotesCrypto.unhex(NotesModel.string(verifier, "hash"));
            return MessageDigest.isEqual(derive(pin, salt, (int) (long) (Long) iterations), hash);
        } catch (Exception invalid) {
            return false;
        }
    }

    /**
     * Seconds to wait after `failures` consecutive wrong PINs, the last at `last` (Unix
     * seconds), or -1 when entry is allowed. 30 s, 1 min, 5 min, 15 min, 30 min, then 1 h.
     */
    static long lockoutRemaining(long failures, long last, long now) {
        if (failures < MAX_FAILURES) return -1;
        long step = STEPS[(int) Math.min(failures - MAX_FAILURES, STEPS.length - 1)];
        long until = last + step;
        return now < until ? until - now : -1;
    }

    /** Clock seam for the session (elapsed milliseconds). */
    interface Clock { long now(); }

    /** The in-process unlock session: one unlock opens every secret note of this device. */
    static final class Session {
        private final Clock clock;
        private long last = -1;
        Session(Clock clock) { this.clock = clock; }
        synchronized void open() { last = clock.now(); }
        synchronized void lock() { last = -1; }
        synchronized boolean isOpen() { return last >= 0 && clock.now() - last < IDLE_LOCK_MS; }
        /** True and refreshed while open and not idle-expired. */
        synchronized boolean touch() {
            if (isOpen()) { last = clock.now(); return true; }
            last = -1;
            return false;
        }
    }
}
