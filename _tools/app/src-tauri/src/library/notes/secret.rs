//! Per-device PIN for secret notes (암호 메모) and the in-process unlock session.
//!
//! The PIN never leaves this device: only a salted PBKDF2-HMAC-SHA256 verifier is kept,
//! in the OS credential store, and it is never synced or backed up.
use ring::{
    pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    num::NonZeroU32,
    sync::Mutex,
    time::{Duration, Instant},
};

pub const PIN_TARGET: &str = "Lakomics/NotesPin";
#[cfg(not(test))]
pub const ITERATIONS: u32 = 310_000;
/// Unit tests only; the stored verifier records its own iteration count.
#[cfg(test)]
pub const ITERATIONS: u32 = 1_000;
/// Re-lock after this much inactivity even if the UI never asked.
pub const IDLE_LOCK: Duration = Duration::from_secs(5 * 60);
const MAX_FAILURES: u32 = 5;

#[derive(Serialize, Deserialize)]
pub struct Verifier {
    v: u8,
    iterations: u32,
    salt: String,
    hash: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

/// 4–8 ASCII digits.
pub fn valid_pin(pin: &str) -> bool {
    (4..=8).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}

pub fn make_verifier(pin: &str, iterations: u32) -> Option<Verifier> {
    let mut salt = [0u8; 16];
    SystemRandom::new().fill(&mut salt).ok()?;
    let mut hash = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(iterations)?,
        &salt,
        pin.as_bytes(),
        &mut hash,
    );
    Some(Verifier {
        v: 1,
        iterations,
        salt: hex(&salt),
        hash: hex(&hash),
    })
}

pub fn check(verifier: &Verifier, pin: &str) -> bool {
    let (Some(salt), Some(hash), Some(iterations)) = (
        unhex(&verifier.salt),
        unhex(&verifier.hash),
        NonZeroU32::new(verifier.iterations),
    ) else {
        return false;
    };
    verifier.v == 1
        && pbkdf2::verify(
            pbkdf2::PBKDF2_HMAC_SHA256,
            iterations,
            &salt,
            pin.as_bytes(),
            &hash,
        )
        .is_ok()
}

#[derive(Default)]
struct Sessions {
    /// Library notes target -> last activity.
    open: HashMap<String, Instant>,
}
static SESSIONS: Mutex<Option<Sessions>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Sessions) -> T) -> T {
    let mut guard = SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Sessions::default))
}

/// True and refreshed while the session is open and not idle-expired.
pub fn touch(target: &str) -> bool {
    with(|s| match s.open.get(target) {
        Some(last) if last.elapsed() < IDLE_LOCK => {
            s.open.insert(target.to_owned(), Instant::now());
            true
        }
        _ => {
            s.open.remove(target);
            false
        }
    })
}

pub fn is_open(target: &str) -> bool {
    with(|s| {
        s.open
            .get(target)
            .is_some_and(|last| last.elapsed() < IDLE_LOCK)
    })
}

pub fn open(target: &str) {
    with(|s| {
        s.open.insert(target.to_owned(), Instant::now());
    });
}

pub fn lock(target: &str) {
    with(|s| {
        s.open.remove(target);
    });
}

/// Serializes PIN attempts so a failure is recorded before the next check runs.
pub static ATTEMPTS: Mutex<()> = Mutex::new(());

/// Seconds to wait after `failures` consecutive wrong PINs, the last at `last` (Unix
/// seconds). Escalates 30 s, 1 min, 5 min, 15 min, 30 min, then 1 h per further miss.
pub fn lockout_remaining(failures: u64, last: u64, now: u64) -> Option<u64> {
    const STEPS: [u64; 6] = [30, 60, 300, 900, 1800, 3600];
    if failures < MAX_FAILURES as u64 {
        return None;
    }
    let step = STEPS[((failures - MAX_FAILURES as u64) as usize).min(STEPS.len() - 1)];
    let until = last.saturating_add(step);
    (now < until).then(|| until - now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_accepts_only_the_pin_and_is_salted() {
        assert!(valid_pin("0000") && valid_pin("12345678"));
        assert!(
            !valid_pin("123")
                && !valid_pin("123456789")
                && !valid_pin("12a4")
                && !valid_pin("١٢٣٤")
        );
        let a = make_verifier("2468", 1000).unwrap();
        let b = make_verifier("2468", 1000).unwrap();
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.hash, b.hash);
        assert!(check(&a, "2468"));
        assert!(!check(&a, "2469"));
        let stored = serde_json::to_string(&a).unwrap();
        assert!(!stored.contains("2468"));
        let back: Verifier = serde_json::from_str(&stored).unwrap();
        assert!(check(&back, "2468"));
        let tampered = Verifier {
            iterations: 999,
            ..back
        };
        assert!(!check(&tampered, "2468"));
    }

    #[test]
    fn lockout_escalates_after_five_misses() {
        assert_eq!(lockout_remaining(4, 100, 100), None);
        assert_eq!(lockout_remaining(5, 100, 110), Some(20));
        assert_eq!(lockout_remaining(5, 100, 130), None);
        assert_eq!(lockout_remaining(6, 100, 100), Some(60));
        assert_eq!(lockout_remaining(7, 100, 100), Some(300));
        assert_eq!(lockout_remaining(50, 100, 100), Some(3600));
    }

    #[test]
    fn session_opens_locks_and_is_per_library() {
        let a = format!("test/{}", uuid::Uuid::new_v4());
        let b = format!("test/{}", uuid::Uuid::new_v4());
        assert!(!touch(&a));
        open(&a);
        assert!(touch(&a) && is_open(&a));
        assert!(!is_open(&b));
        lock(&a);
        assert!(!touch(&a));
    }
}
