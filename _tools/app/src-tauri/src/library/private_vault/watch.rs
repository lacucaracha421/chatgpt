//! Background watcher that tells the frontend when drives are mounted or removed, so the
//! Private Vault status is re-read only then instead of scanning every mount root on a timer.
//!
//! - Linux: `poll()` on `/proc/self/mountinfo` for `POLLPRI`/`POLLERR`, which the kernel raises
//!   whenever the mount table changes. The file is read only after such a signal.
//! - Windows: the `GetLogicalDrives()` bitmask, compared every couple of seconds (no disk I/O),
//!   plus a once-per-minute reconciliation for media swapped inside a persistent drive letter.
//!
//! When the cheap wait fails the watcher falls back to re-reading the mount set every
//! [`FALLBACK_INTERVAL`]; it never goes back to probing vault files on a short timer.
//! One watcher runs per app, started from the Tauri setup hook and stopped on exit.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    thread::{self, Thread},
    time::{Duration, Instant},
};

/// Tauri event emitted (without payload) after the mount set changed.
pub(crate) const VAULT_MOUNTS_CHANGED_EVENT: &str = "external-vault-changed";

/// Mount changes arrive in bursts (a USB with several partitions, udisks remounts); wait this
/// long after a signal before reading the new mount set. It also caps the check rate.
const SETTLE: Duration = Duration::from_millis(500);
/// Re-read interval once the cheap change signal no longer works.
const FALLBACK_INTERVAL: Duration = Duration::from_secs(15);
/// Longest time the thread blocks before it looks at the stop flag again.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const STOP_CHECK: Duration = Duration::from_secs(2);
/// `GetLogicalDrives()` comparison interval.
#[cfg_attr(not(windows), allow(dead_code))]
const DRIVE_CHECK_INTERVAL: Duration = Duration::from_millis(1_500);

static STARTED: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
static THREAD: OnceLock<Thread> = OnceLock::new();

/// Starts the app's single mount watcher; later calls do nothing. `notify` runs on the
/// watcher thread after each mount-set change.
pub(crate) fn start_mount_watcher(notify: impl FnMut() + Send + 'static) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = thread::Builder::new()
        .name("vault-mount-watch".into())
        .spawn(move || {
            let mut notify = notify;
            #[cfg(target_os = "linux")]
            run(&mut linux::MountInfo::open(), &STOP, &mut notify);
            #[cfg(windows)]
            run(&mut windows::LogicalDrives::new(), &STOP, &mut notify);
            #[cfg(not(any(target_os = "linux", windows)))]
            let _ = &mut notify;
        });
    match spawned {
        Ok(handle) => {
            let _ = THREAD.set(handle.thread().clone());
        }
        // Without a watcher the focus/visibility refresh in the frontend still works.
        Err(_) => STARTED.store(false, Ordering::SeqCst),
    }
}

/// Asks the watcher to end; it exits within [`STOP_CHECK`] at the latest.
pub(crate) fn stop_mount_watcher() {
    STOP.store(true, Ordering::SeqCst);
    if let Some(thread) = THREAD.get() {
        thread.unpark();
    }
}

/// Sleeps up to `duration`, returning early once `stop` is set (the stopper unparks us).
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
fn park_for(duration: Duration, stop: &AtomicBool) {
    let deadline = Instant::now() + duration;
    while !stop.load(Ordering::SeqCst) {
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        thread::park_timeout(deadline - now);
    }
}

/// What a wait for a mount change ended with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Wake {
    /// The OS signalled a mount change: settle, then compare the mount set.
    Signalled,
    /// A periodic check is due: compare the mount set now.
    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    Due,
    /// Nothing happened; only the stop flag needs a look.
    Idle,
    /// The cheap wait does not work (any more): switch to the slow fallback.
    Failed,
}

/// One platform's mount set and its change signal.
trait MountProbe {
    type Signature: PartialEq;
    /// The current mount set, or `None` when it cannot be read.
    fn signature(&mut self) -> Option<Self::Signature>;
    /// Blocks until the mount set may have changed or a stop check is due.
    fn wait(&mut self, stop: &AtomicBool) -> Wake;
    fn sleep(&mut self, duration: Duration, stop: &AtomicBool);
}

/// Remembers the last mount signature. The first observation is only the baseline: the
/// frontend reads the vault status at startup itself.
struct ChangeDetector<T> {
    last: Option<T>,
}

impl<T: PartialEq> ChangeDetector<T> {
    fn new() -> Self {
        Self { last: None }
    }

    fn observe(&mut self, next: T) -> bool {
        let changed = self.last.as_ref().is_some_and(|last| *last != next);
        self.last = Some(next);
        changed
    }
}

/// The watcher loop, shared by every platform. It reads the mount set only after a signal,
/// a due periodic check, or (degraded) every [`FALLBACK_INTERVAL`], and calls `notify` only
/// when the signature differs (a mount change, or Windows' slow reconciliation tick).
fn run<P: MountProbe>(probe: &mut P, stop: &AtomicBool, notify: &mut dyn FnMut()) {
    let mut detector = ChangeDetector::new();
    let mut degraded = false;
    while !stop.load(Ordering::SeqCst) {
        match probe.signature() {
            Some(signature) => {
                if detector.observe(signature) {
                    notify();
                }
            }
            None => degraded = true,
        }
        loop {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            if degraded {
                probe.sleep(FALLBACK_INTERVAL, stop);
                break;
            }
            match probe.wait(stop) {
                Wake::Signalled => {
                    probe.sleep(SETTLE, stop);
                    break;
                }
                Wake::Due => break,
                Wake::Idle => {}
                Wake::Failed => degraded = true,
            }
        }
    }
}

/// Mount set of `/proc/self/mountinfo`: (mount id, mount point) pairs, sorted. Mount options
/// are ignored; a remount of another device at the same point gets a new mount id.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn mountinfo_signature(text: &str) -> Vec<(String, String)> {
    let mut mounts = text
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let id = fields.next()?;
            let mount_point = fields.nth(3)?;
            Some((id.to_owned(), mount_point.to_owned()))
        })
        .collect::<Vec<_>>();
    mounts.sort_unstable();
    mounts
}

/// `GetLogicalDrives()` returns 0 on failure (a running Windows always has a system drive).
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn drive_mask(raw: u32) -> Option<u32> {
    (raw != 0).then_some(raw)
}

/// Include a slow reconciliation tick so a persistent reader letter cannot hide a swap.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn drive_signature(raw: u32, elapsed: Duration) -> Option<(u32, u64)> {
    // GetLogicalDrives does not report media changes inside an existing reader. Avoid volume
    // queries on empty readers here; let the normal vault discovery reconcile at a slow rate.
    drive_mask(raw).map(|mask| (mask, elapsed.as_secs() / 60))
}

#[cfg(target_os = "linux")]
mod linux {
    use std::{
        fs::{self, File},
        io,
        os::fd::AsRawFd,
        sync::atomic::AtomicBool,
        time::Duration,
    };

    use super::{mountinfo_signature, park_for, MountProbe, Wake, STOP_CHECK};

    const MOUNTINFO: &str = "/proc/self/mountinfo";

    /// Keeps one open handle only for `poll()`; each reading opens the file afresh.
    pub(super) struct MountInfo {
        polled: Option<File>,
    }

    impl MountInfo {
        pub(super) fn open() -> Self {
            Self {
                polled: File::open(MOUNTINFO).ok(),
            }
        }
    }

    impl MountProbe for MountInfo {
        type Signature = Vec<(String, String)>;

        fn signature(&mut self) -> Option<Self::Signature> {
            fs::read_to_string(MOUNTINFO)
                .ok()
                .map(|text| mountinfo_signature(&text))
        }

        fn wait(&mut self, _stop: &AtomicBool) -> Wake {
            let Some(file) = &self.polled else {
                return Wake::Failed;
            };
            poll_mount_change(file, STOP_CHECK)
        }

        fn sleep(&mut self, duration: Duration, stop: &AtomicBool) {
            park_for(duration, stop);
        }
    }

    /// The kernel marks a mountinfo handle with `POLLPRI | POLLERR` once per mount table
    /// change (the mark is cleared by the `poll` that reports it).
    pub(super) fn poll_mount_change(file: &File, timeout: Duration) -> Wake {
        let mut request = libc::pollfd {
            fd: file.as_raw_fd(),
            events: libc::POLLPRI,
            revents: 0,
        };
        let timeout_ms = libc::c_int::try_from(timeout.as_millis()).unwrap_or(libc::c_int::MAX);
        // SAFETY: `request` is one valid pollfd for an open descriptor owned by `file`,
        // which outlives the call.
        let ready = unsafe { libc::poll(&mut request, 1, timeout_ms) };
        if ready < 0 {
            return if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                Wake::Idle
            } else {
                Wake::Failed
            };
        }
        if ready == 0 {
            return Wake::Idle;
        }
        if request.revents & (libc::POLLPRI | libc::POLLERR) != 0
            && request.revents & libc::POLLNVAL == 0
        {
            Wake::Signalled
        } else {
            // POLLHUP/POLLNVAL would return at once on every call; never spin on it.
            Wake::Failed
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::{
        sync::atomic::AtomicBool,
        time::{Duration, Instant},
    };

    use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;

    use super::{drive_signature, park_for, MountProbe, Wake, DRIVE_CHECK_INTERVAL};

    pub(super) struct LogicalDrives {
        started: Instant,
    }

    impl LogicalDrives {
        pub(super) fn new() -> Self {
            Self {
                started: Instant::now(),
            }
        }
    }

    impl MountProbe for LogicalDrives {
        type Signature = (u32, u64);

        fn signature(&mut self) -> Option<Self::Signature> {
            // SAFETY: GetLogicalDrives takes no arguments and only returns a bitmask.
            drive_signature(unsafe { GetLogicalDrives() }, self.started.elapsed())
        }

        fn wait(&mut self, stop: &AtomicBool) -> Wake {
            park_for(DRIVE_CHECK_INTERVAL, stop);
            Wake::Due
        }

        fn sleep(&mut self, duration: Duration, stop: &AtomicBool) {
            park_for(duration, stop);
        }
    }
}

#[cfg(test)]
mod private_vault_watch_tests {
    use std::{
        collections::VecDeque,
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };

    use super::{
        drive_mask, mountinfo_signature, run, ChangeDetector, MountProbe, Wake, FALLBACK_INTERVAL,
        SETTLE,
    };

    /// Scripted probe: readings and waits come from queues; the run stops when the waits
    /// are used up.
    struct Scripted {
        readings: VecDeque<Option<u32>>,
        waits: VecDeque<Wake>,
        reads: usize,
        sleeps: Vec<Duration>,
    }

    impl Scripted {
        fn new(readings: &[Option<u32>], waits: &[Wake]) -> Self {
            Self {
                readings: readings.iter().copied().collect(),
                waits: waits.iter().copied().collect(),
                reads: 0,
                sleeps: Vec::new(),
            }
        }
    }

    impl MountProbe for Scripted {
        type Signature = u32;

        fn signature(&mut self) -> Option<u32> {
            self.reads += 1;
            self.readings.pop_front().unwrap_or(None)
        }

        fn wait(&mut self, stop: &AtomicBool) -> Wake {
            self.waits.pop_front().unwrap_or_else(|| {
                stop.store(true, Ordering::SeqCst);
                Wake::Idle
            })
        }

        fn sleep(&mut self, duration: Duration, stop: &AtomicBool) {
            self.sleeps.push(duration);
            if duration == FALLBACK_INTERVAL && self.readings.is_empty() {
                stop.store(true, Ordering::SeqCst);
            }
        }
    }

    fn run_scripted(probe: &mut Scripted) -> usize {
        let stop = AtomicBool::new(false);
        let mut notified = 0;
        run(probe, &stop, &mut || notified += 1);
        notified
    }

    #[test]
    fn review_regression_same_letter_media_gets_bounded_reconciliation() {
        let mut detector = ChangeDetector::new();
        let signature = |seconds| super::drive_signature(0b10100, Duration::from_secs(seconds)).unwrap();
        assert!(!detector.observe(signature(0)));
        for second in 1..60 {
            assert!(!detector.observe(signature(second)), "no fast idle vault scans");
        }
        assert!(detector.observe(signature(60)), "insertion at an existing drive letter must refresh");
        assert!(!detector.observe(signature(61)));
        assert!(detector.observe(signature(120)), "replacement at the same letter must refresh too");
        assert_eq!(super::drive_signature(0, Duration::from_secs(120)), None);
    }

    #[test]
    fn windows_reconciliation_is_limited_to_one_refresh_per_idle_minute() {
        let mut detector = ChangeDetector::new();
        let mut refreshes = 0;
        for check in 0..=600 {
            let elapsed = Duration::from_millis(check * 1_500);
            refreshes += usize::from(detector.observe(super::drive_signature(0b10100, elapsed)));
        }
        assert_eq!(refreshes, 15, "15 idle minutes allow exactly 15 safety refreshes");
    }

    #[test]
    fn detector_reports_only_changes_after_the_baseline() {
        let mut detector = ChangeDetector::new();
        assert!(!detector.observe(0b0100));
        assert!(!detector.observe(0b0100));
        assert!(detector.observe(0b1100), "drive E: appeared");
        assert!(!detector.observe(0b1100));
        assert!(detector.observe(0b0100), "drive E: disappeared");
    }

    #[test]
    fn mountinfo_signature_ignores_options_and_order() {
        let before = "36 25 0:31 / /run/media/laku/USB rw,nosuid - vfat /dev/sdb1 rw\n\
                      22 1 8:2 / / rw,relatime - ext4 /dev/sda2 rw\n";
        let reordered_remount_options = "22 1 8:2 / / ro,relatime - ext4 /dev/sda2 ro\n\
             36 25 0:31 / /run/media/laku/USB rw,nosuid,noexec - vfat /dev/sdb1 rw\n";
        assert_eq!(
            mountinfo_signature(before),
            mountinfo_signature(reordered_remount_options)
        );
    }

    #[test]
    fn mountinfo_signature_changes_on_mount_unmount_and_swap_at_the_same_point() {
        let root = "22 1 8:2 / / rw - ext4 /dev/sda2 rw\n";
        let with_usb = format!("{root}36 25 0:31 / /run/media/laku/USB rw - vfat /dev/sdb1 rw\n");
        let other_usb = format!("{root}41 25 0:35 / /run/media/laku/USB rw - vfat /dev/sdc1 rw\n");
        let mut detector = ChangeDetector::new();
        assert!(!detector.observe(mountinfo_signature(root)));
        assert!(detector.observe(mountinfo_signature(&with_usb)));
        assert!(detector.observe(mountinfo_signature(&other_usb)));
        assert!(detector.observe(mountinfo_signature(root)));
        assert!(mountinfo_signature("\n  \n").is_empty());
    }

    #[test]
    fn drive_mask_treats_zero_as_a_failed_call() {
        assert_eq!(drive_mask(0), None);
        assert_eq!(drive_mask(0b100), Some(0b100));
    }

    #[test]
    fn signals_read_the_mount_set_once_after_settling_and_notify_only_on_change() {
        let mut probe = Scripted::new(
            &[Some(0b100), Some(0b100), Some(0b1100)],
            &[
                Wake::Idle,
                Wake::Idle,
                Wake::Signalled,
                Wake::Idle,
                Wake::Signalled,
            ],
        );
        assert_eq!(run_scripted(&mut probe), 1);
        // Baseline plus one reading per signal; idle wakeups read nothing.
        assert_eq!(probe.reads, 3);
        assert_eq!(probe.sleeps, vec![SETTLE, SETTLE]);
    }

    #[test]
    fn periodic_checks_notify_when_a_drive_letter_appears_or_disappears() {
        let mut probe = Scripted::new(
            &[Some(0b100), Some(0b100), Some(0b10100), Some(0b100)],
            &[Wake::Due, Wake::Due, Wake::Due],
        );
        assert_eq!(run_scripted(&mut probe), 2);
        assert!(probe.sleeps.is_empty());
    }

    #[test]
    fn a_failed_wait_falls_back_to_the_slow_interval_and_still_reports_changes() {
        let mut probe = Scripted::new(&[Some(0b100), Some(0b100), Some(0b1100)], &[Wake::Failed]);
        assert_eq!(run_scripted(&mut probe), 1);
        assert_eq!(probe.sleeps, vec![FALLBACK_INTERVAL; 3]);
        assert!(probe.waits.is_empty());
    }

    #[test]
    fn an_unreadable_mount_set_falls_back_to_the_slow_interval() {
        let mut probe = Scripted::new(&[None, Some(0b100), Some(0b1100)], &[Wake::Signalled]);
        assert_eq!(run_scripted(&mut probe), 1);
        assert_eq!(probe.sleeps, vec![FALLBACK_INTERVAL; 3]);
        assert_eq!(
            probe.waits.len(),
            1,
            "the broken signal path is not used again"
        );
    }

    #[test]
    fn a_set_stop_flag_ends_the_loop_without_reading() {
        let mut probe = Scripted::new(&[Some(1)], &[Wake::Idle]);
        let stop = AtomicBool::new(true);
        run(&mut probe, &stop, &mut || {
            panic!("no notification after stop")
        });
        assert_eq!(probe.reads, 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_mountinfo_poll_is_quiet_without_mount_changes() {
        let file = std::fs::File::open("/proc/self/mountinfo").unwrap();
        let text = std::fs::read_to_string("/proc/self/mountinfo").unwrap();
        assert!(!mountinfo_signature(&text).is_empty());
        // A freshly opened handle carries no pending change, so the watcher sleeps in poll()
        // instead of spinning (a concurrent mount on the test machine would be the only
        // exception).
        assert_eq!(
            super::linux::poll_mount_change(&file, Duration::from_millis(50)),
            Wake::Idle
        );
    }
}
