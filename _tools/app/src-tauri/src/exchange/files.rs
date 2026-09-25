//! Receiver-side file handling for the file exchange: safe leaf names, the
//! part-file → final-name writer that never overwrites, and digests.
//!
//! Nothing here touches the network, so every rule is unit-tested.
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
};

/// Room for " (999)" and the part-file prefix under every filesystem's 255 limit.
const MAX_LEAF_BYTES: usize = 200;
const MAX_EXTENSION_BYTES: usize = 32;
const MAX_COLLISION_NUMBER: u32 = 999;
pub(crate) const FALLBACK_NAME: &str = "받은 파일";
const PART_SUFFIX: &str = ".lakomics-part";

/// C0/C1 controls (NUL included) and the bidi characters that make "gpj.exe" render as
/// "exe.jpg". The server strips these too; the receiver does not trust that.
fn invisible(ch: char) -> bool {
    let c = ch as u32;
    c < 0x20
        || (0x7f..=0x9f).contains(&c)
        || (0x202a..=0x202e).contains(&c)
        || (0x2066..=0x2069).contains(&c)
        || matches!(c, 0x200e | 0x200f | 0x061c)
}

/// `CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` (and the superscript digits Windows
/// also reserves), matched on the part before the first dot, case-insensitively.
fn reserved_on_windows(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    let (Some(prefix), Some(rest)) = (stem.get(..3), stem.get(3..)) else {
        return false;
    };
    (prefix == "COM" || prefix == "LPT")
        && matches!(
            rest,
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        )
}

fn truncate_bytes(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Split `name.ext` into `("name", ".ext")`; a leading-dot name has no extension.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(index) if index > 0 && name.len() - index - 1 <= MAX_EXTENSION_BYTES => {
            (&name[..index], &name[index..])
        }
        _ => (name, ""),
    }
}

fn truncate_keeping_extension(name: &str) -> String {
    if name.len() <= MAX_LEAF_BYTES {
        return name.to_owned();
    }
    let (stem, extension) = split_extension(name);
    if !extension.is_empty() && extension.len() < MAX_LEAF_BYTES {
        let stem = truncate_bytes(stem, MAX_LEAF_BYTES - extension.len()).trim_end();
        return format!("{stem}{extension}");
    }
    truncate_bytes(name, MAX_LEAF_BYTES).trim_end().to_owned()
}

/// The leaf name a received file is saved under, for this OS's filesystem rules.
///
/// Only a leaf ever comes out: anything up to the last `/` or `\` is dropped. Windows
/// also replaces `<>:"/\|?*`, trims trailing dots and spaces and prefixes reserved
/// device names with `_`. An unusable name becomes [`FALLBACK_NAME`].
pub(crate) fn sanitize_leaf(raw: &str, windows: bool) -> String {
    let visible: String = raw.chars().filter(|ch| !invisible(*ch)).collect();
    let leaf = visible.rsplit(['/', '\\']).next().unwrap_or("");
    let mut name: String = if windows {
        leaf.chars()
            .map(|ch| match ch {
                '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
                other => other,
            })
            .collect()
    } else {
        leaf.to_owned()
    };
    name = truncate_keeping_extension(name.trim());
    if windows {
        name = name.trim_end_matches(['.', ' ']).to_owned();
        if reserved_on_windows(&name) {
            name.insert(0, '_');
        }
    }
    if name.is_empty() || name == "." || name == ".." {
        return FALLBACK_NAME.to_owned();
    }
    name
}

/// `name.ext`, `name (1).ext`, `name (2).ext`, ...
pub(crate) fn candidate_name(leaf: &str, number: u32) -> String {
    if number == 0 {
        return leaf.to_owned();
    }
    let (stem, extension) = split_extension(leaf);
    format!("{stem} ({number}){extension}")
}

/// A child of `dir` named exactly `name`, or an error when joining would escape it.
fn child(dir: &Path, name: &str) -> io::Result<PathBuf> {
    let path = dir.join(name);
    if path.parent() != Some(dir) || path.file_name() != Some(OsStr::new(name)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unsafe file name",
        ));
    }
    Ok(path)
}

/// Create an empty file under the first free candidate name. `create_new` makes the
/// check and the claim one step, so an existing file (or a folder) is never reused.
pub(crate) fn reserve(dir: &Path, leaf: &str) -> io::Result<PathBuf> {
    for number in 0..=MAX_COLLISION_NUMBER {
        let path = child(dir, &candidate_name(leaf, number))?;
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no free file name",
    ))
}

/// Move a verified part file (kept in the app's own data folder) to its final name in
/// `dir`: reserve the name, then rename the part over that empty reservation. A file
/// that existed before is never replaced.
pub(crate) fn finalize(part: &Path, dir: &Path, leaf: &str) -> io::Result<PathBuf> {
    finalize_with(part, dir, leaf, |from, to| fs::rename(from, to))
}

fn finalize_with(
    part: &Path,
    dir: &Path,
    leaf: &str,
    rename: impl Fn(&Path, &Path) -> io::Result<()>,
) -> io::Result<PathBuf> {
    if !part.is_file() {
        return Err(io::Error::from(io::ErrorKind::NotFound));
    }
    let path = reserve(dir, leaf)?;
    // A rename fails across filesystems (app data and Downloads may differ): copy to
    // a temporary name inside `dir`, then rename that over the reservation.
    let moved = rename(part, &path).or_else(|_| copy_over(part, dir, &path));
    if let Err(error) = moved {
        // Only our own empty reservation is removed.
        if fs::metadata(&path).is_ok_and(|meta| meta.len() == 0) {
            let _ = fs::remove_file(&path);
        }
        return Err(error);
    }
    let _ = fs::remove_file(part);
    mark_downloaded(&path);
    Ok(path)
}

fn copy_over(part: &Path, dir: &Path, reserved: &Path) -> io::Result<()> {
    let mut temp = tempfile::Builder::new()
        .prefix(".lakomics-")
        .suffix(".tmp")
        .tempfile_in(dir)?;
    io::copy(&mut File::open(part)?, temp.as_file_mut())?;
    temp.as_file().sync_all()?;
    temp.persist(reserved).map_err(|error| error.error)?;
    Ok(())
}

/// Mark-of-the-Web: SmartScreen and Office treat the file as downloaded content.
#[cfg(windows)]
fn mark_downloaded(path: &Path) {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    let _ = fs::write(PathBuf::from(stream), b"[ZoneTransfer]\r\nZoneId=3\r\n");
}

#[cfg(not(windows))]
fn mark_downloaded(_path: &Path) {}

/// The download target for one transfer inside the app's part folder (never Downloads).
pub(crate) fn part_path(parts: &Path, transfer_id: &uuid::Uuid) -> PathBuf {
    parts.join(format!("{}{PART_SUFFIX}", transfer_id.hyphenated()))
}

/// Delete part files in `parts` whose transfer is not in `keep` (the current inbox), or,
/// with `keep` = `None`, those not modified within `max_age`. Returns how many went.
pub(crate) fn sweep_parts(
    parts: &Path,
    keep: Option<&std::collections::HashSet<String>>,
    max_age: std::time::Duration,
) -> usize {
    let Ok(entries) = fs::read_dir(parts) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_suffix(PART_SUFFIX))
        else {
            continue;
        };
        let stale = match keep {
            Some(keep) => !keep.contains(id),
            None => entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|at| at.elapsed().ok())
                .is_some_and(|age| age > max_age),
        };
        if stale
            && entry.file_type().is_ok_and(|kind| kind.is_file())
            && fs::remove_file(entry.path()).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

/// Where a download resumes: `Some(offset)` to fetch from `offset`, `None` when the part
/// already holds every byte. A part longer than the file starts over.
pub(crate) fn resume_offset(part_len: u64, size: u64) -> Option<u64> {
    match part_len {
        n if n == size => None,
        n if n < size => Some(n),
        _ => Some(0),
    }
}

pub(crate) fn sha256_reader(
    mut reader: impl Read,
    mut progress: impl FnMut(u64),
) -> io::Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut total = 0u64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
        progress(total);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub(crate) fn sha256_file(path: &Path) -> io::Result<String> {
    sha256_reader(File::open(path)?, |_| {})
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verify {
    Ok,
    SizeMismatch,
    DigestMismatch,
}

/// A finished part must match the declared size and SHA-256 before it is saved or acked.
pub(crate) fn verify_part(part: &Path, size: u64, sha256: &str) -> io::Result<Verify> {
    if fs::metadata(part)?.len() != size {
        return Ok(Verify::SizeMismatch);
    }
    Ok(if sha256_file(part)? == sha256 {
        Verify::Ok
    } else {
        Verify::DigestMismatch
    })
}

/// ENOSPC / ERROR_DISK_FULL / ERROR_HANDLE_DISK_FULL.
pub(crate) fn is_disk_full(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::StorageFull)
        || matches!(error.raw_os_error(), Some(code) if (cfg!(windows) && (code == 112 || code == 39)) || (!cfg!(windows) && code == 28))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizer_golden_cases() {
        let both = [
            ("photo.jpg", "photo.jpg"),
            ("../../etc/passwd", "passwd"),
            ("C:\\Users\\me\\report.pdf", "report.pdf"),
            ("a\u{0000}b.txt", "ab.txt"),
            ("evil\u{202e}gpj.exe", "evilgpj.exe"),
            ("  spaced name.png  ", "spaced name.png"),
            ("", FALLBACK_NAME),
            ("..", FALLBACK_NAME),
            ("dir/", FALLBACK_NAME),
            ("한글 파일.mp4", "한글 파일.mp4"),
        ];
        for windows in [false, true] {
            for (raw, expected) in both {
                assert_eq!(
                    sanitize_leaf(raw, windows),
                    expected,
                    "{raw:?} windows={windows}"
                );
            }
        }
        let windows = [
            ("what?.txt", "what_.txt"),
            ("a<b>c:d\"e|f*.txt", "a_b_c_d_e_f_.txt"),
            ("trailing. . ", "trailing"),
            ("CON", "_CON"),
            ("con.txt", "_con.txt"),
            ("Lpt9.log", "_Lpt9.log"),
            ("COM10.txt", "COM10.txt"),
            ("CONSOLE.txt", "CONSOLE.txt"),
            ("a가.txt", "a가.txt"),
            ("...", FALLBACK_NAME),
        ];
        for (raw, expected) in windows {
            assert_eq!(sanitize_leaf(raw, true), expected, "{raw:?}");
        }
        let linux = [
            ("what?.txt", "what?.txt"),
            ("CON", "CON"),
            ("trailing.", "trailing."),
            ("...", "..."),
        ];
        for (raw, expected) in linux {
            assert_eq!(sanitize_leaf(raw, false), expected, "{raw:?}");
        }
    }

    #[test]
    fn long_names_keep_their_extension_within_the_byte_limit() {
        let name = format!("{}.jpeg", "가".repeat(120));
        let saved = sanitize_leaf(&name, true);
        assert!(saved.len() <= MAX_LEAF_BYTES);
        assert!(saved.ends_with(".jpeg"));
        let bare = "x".repeat(400);
        assert_eq!(sanitize_leaf(&bare, false).len(), MAX_LEAF_BYTES);
    }

    #[test]
    fn collision_numbering_goes_before_the_extension() {
        assert_eq!(candidate_name("a.txt", 0), "a.txt");
        assert_eq!(candidate_name("a.txt", 1), "a (1).txt");
        assert_eq!(candidate_name("archive.tar.gz", 2), "archive.tar (2).gz");
        assert_eq!(candidate_name(".bashrc", 1), ".bashrc (1)");
        assert_eq!(candidate_name("README", 3), "README (3)");
    }

    #[test]
    fn reservation_skips_existing_files_and_folders() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"mine").unwrap();
        fs::create_dir(dir.path().join("a (1).txt")).unwrap();
        let reserved = reserve(dir.path(), "a.txt").unwrap();
        assert_eq!(reserved, dir.path().join("a (2).txt"));
        assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"mine");
        assert_eq!(fs::metadata(&reserved).unwrap().len(), 0);
    }

    #[test]
    fn reservation_refuses_names_that_escape_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert!(reserve(dir.path(), "../x").is_err());
        assert!(reserve(dir.path(), "..").is_err());
    }

    #[test]
    fn finalize_never_overwrites_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("photo.jpg"), b"original").unwrap();
        let id = uuid::Uuid::new_v4();
        let part = part_path(dir.path(), &id);
        fs::write(&part, b"received").unwrap();
        let saved = finalize(&part, dir.path(), "photo.jpg").unwrap();
        assert_eq!(saved, dir.path().join("photo (1).jpg"));
        assert_eq!(fs::read(&saved).unwrap(), b"received");
        assert_eq!(fs::read(dir.path().join("photo.jpg")).unwrap(), b"original");
        assert!(!part.exists());
    }

    #[test]
    fn a_missing_part_leaves_no_reservation_behind() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.lakomics-part");
        assert!(finalize(&missing, dir.path(), "x.bin").is_err());
        assert!(!dir.path().join("x.bin").exists());
    }

    #[test]
    fn a_failed_rename_falls_back_to_copying_without_overwriting() {
        let parts = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        fs::write(downloads.path().join("clip.mp4"), b"mine").unwrap();
        let part = part_path(parts.path(), &uuid::Uuid::new_v4());
        fs::write(&part, b"received").unwrap();
        let cross_device = |_: &Path, _: &Path| Err(io::Error::other("EXDEV"));
        let saved = finalize_with(&part, downloads.path(), "clip.mp4", cross_device).unwrap();
        assert_eq!(saved, downloads.path().join("clip (1).mp4"));
        assert_eq!(fs::read(&saved).unwrap(), b"received");
        assert_eq!(
            fs::read(downloads.path().join("clip.mp4")).unwrap(),
            b"mine"
        );
        assert!(!part.exists());
        let leftovers: Vec<_> = fs::read_dir(downloads.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(leftovers.len(), 2, "{leftovers:?}");
    }

    #[test]
    fn sweeping_removes_parts_that_left_the_inbox_and_nothing_else() {
        let parts = tempfile::tempdir().unwrap();
        let (kept, gone) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        fs::write(part_path(parts.path(), &kept), b"a").unwrap();
        fs::write(part_path(parts.path(), &gone), b"b").unwrap();
        fs::write(parts.path().join("notes.txt"), b"c").unwrap();
        let keep = std::collections::HashSet::from([kept.hyphenated().to_string()]);
        assert_eq!(
            sweep_parts(parts.path(), Some(&keep), std::time::Duration::ZERO),
            1
        );
        assert!(part_path(parts.path(), &kept).exists());
        assert!(!part_path(parts.path(), &gone).exists());
        assert!(parts.path().join("notes.txt").exists());
        // The startup sweep only removes parts older than the limit.
        assert_eq!(
            sweep_parts(parts.path(), None, std::time::Duration::from_secs(3600)),
            0
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert_eq!(
            sweep_parts(parts.path(), None, std::time::Duration::from_millis(1)),
            1
        );
    }

    #[test]
    fn verification_catches_size_and_digest_mismatches() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("p");
        fs::write(&part, b"hello").unwrap();
        let good = sha256_file(&part).unwrap();
        assert_eq!(
            good,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(verify_part(&part, 5, &good).unwrap(), Verify::Ok);
        assert_eq!(verify_part(&part, 6, &good).unwrap(), Verify::SizeMismatch);
        assert_eq!(
            verify_part(&part, 5, &"0".repeat(64)).unwrap(),
            Verify::DigestMismatch
        );
    }

    #[test]
    fn resume_offsets() {
        assert_eq!(resume_offset(0, 10), Some(0));
        assert_eq!(resume_offset(4, 10), Some(4));
        assert_eq!(resume_offset(10, 10), None);
        assert_eq!(resume_offset(12, 10), Some(0));
        assert_eq!(resume_offset(0, 0), None);
    }

    #[test]
    fn part_files_are_named_by_transfer() {
        let id = uuid::Uuid::parse_str("0f8fad5b-d9cb-469f-a165-70867728950e").unwrap();
        let part = part_path(Path::new("/d"), &id);
        assert_eq!(
            part,
            Path::new("/d/0f8fad5b-d9cb-469f-a165-70867728950e.lakomics-part")
        );
    }
}
