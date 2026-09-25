//! A minimal STORED (uncompressed) zip writer for sending a folder as one file.
//!
//! Local headers, central directory and end record only: no compression, no ZIP64
//! (the exchange caps a file at 2 GiB, so every offset fits in 32 bits), UTF-8 names
//! with the language-encoding flag, forward-slash paths under the folder's own name,
//! and directory entries for empty folders. Symlinks are skipped, never followed.
use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::SystemTime,
};

const LOCAL_HEADER: u32 = 0x0403_4b50;
const CENTRAL_HEADER: u32 = 0x0201_4b50;
const END_RECORD: u32 = 0x0605_4b50;
const VERSION: u16 = 20;
const UTF8_NAMES: u16 = 1 << 11;
const LOCAL_HEADER_LEN: u64 = 30;
const CENTRAL_HEADER_LEN: u64 = 46;
const END_RECORD_LEN: u64 = 22;
pub(crate) const MAX_ENTRIES: usize = 65_535;

fn crc_table() -> &'static [u32; 256] {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (index, slot) in table.iter_mut().enumerate() {
            let mut value = index as u32;
            for _ in 0..8 {
                value = if value & 1 != 0 {
                    0xEDB8_8320 ^ (value >> 1)
                } else {
                    value >> 1
                };
            }
            *slot = value;
        }
        table
    })
}

/// Running CRC-32 (IEEE); start with `0`.
pub(crate) fn crc32_update(crc: u32, bytes: &[u8]) -> u32 {
    let table = crc_table();
    let mut value = !crc;
    for byte in bytes {
        value = table[((value ^ u32::from(*byte)) & 0xff) as usize] ^ (value >> 8);
    }
    !value
}

/// One archive member.
#[derive(Debug, Clone)]
pub(crate) struct Entry {
    /// `Folder/sub/file.txt`, or `Folder/empty/` for a directory.
    pub name: String,
    /// `None` for a directory entry.
    pub source: Option<PathBuf>,
    pub size: u64,
    pub modified: Option<SystemTime>,
}

#[derive(Debug, Default)]
pub(crate) struct Plan {
    pub entries: Vec<Entry>,
    /// Symlinks and folders that could not be listed.
    pub skipped: usize,
    /// Bytes of file content.
    pub content_bytes: u64,
}

#[derive(Debug)]
pub(crate) enum ZipError {
    /// Refused before writing, with the Korean message for the row.
    Refused(String),
    Cancelled,
    Io(io::Error),
}

impl From<io::Error> for ZipError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

fn relative_name(parts: &[String]) -> String {
    parts.join("/")
}

/// List `root` (a folder) without following symlinks. Anything under `exclude` (the
/// app's own temp-zip folder) is left out. Entries are sorted, so the same folder
/// gives the same archive.
pub(crate) fn plan(root: &Path, exclude: &Path) -> Result<Plan, ZipError> {
    let meta = fs::symlink_metadata(root)?;
    if !meta.is_dir() {
        return Err(ZipError::Io(io::Error::from(io::ErrorKind::InvalidInput)));
    }
    let top = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "폴더".to_owned());
    let exclude = fs::canonicalize(exclude).unwrap_or_else(|_| exclude.to_path_buf());
    let mut plan = Plan::default();
    walk(root, &mut vec![top], &exclude, &mut plan)?;
    check_limits(&plan)?;
    Ok(plan)
}

fn walk(
    dir: &Path,
    parts: &mut Vec<String>,
    exclude: &Path,
    plan: &mut Plan,
) -> Result<(), ZipError> {
    let mut children: Vec<_> = match fs::read_dir(dir) {
        Ok(entries) => entries.flatten().collect(),
        Err(_) if parts.len() > 1 => {
            plan.skipped += 1;
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    children.sort_by_key(|entry| entry.file_name());
    let before = plan.entries.len();
    for child in children {
        let path = child.path();
        if fs::canonicalize(&path).is_ok_and(|real| real.starts_with(exclude)) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else {
            plan.skipped += 1;
            continue;
        };
        let name = child.file_name().to_string_lossy().into_owned();
        if meta.file_type().is_symlink() {
            plan.skipped += 1;
        } else if meta.is_dir() {
            parts.push(name);
            walk(&path, parts, exclude, plan)?;
            parts.pop();
        } else if meta.is_file() {
            parts.push(name);
            plan.entries.push(Entry {
                name: relative_name(parts),
                source: Some(path),
                size: meta.len(),
                modified: meta.modified().ok(),
            });
            plan.content_bytes += meta.len();
            parts.pop();
        }
        if plan.entries.len() > MAX_ENTRIES {
            return Err(too_many());
        }
    }
    if plan.entries.len() == before {
        // An empty folder (or one whose content was all skipped) keeps its place.
        plan.entries.push(Entry {
            name: format!("{}/", relative_name(parts)),
            source: None,
            size: 0,
            modified: fs::metadata(dir).and_then(|meta| meta.modified()).ok(),
        });
    }
    Ok(())
}

fn too_many() -> ZipError {
    ZipError::Refused(format!(
        "파일이 너무 많아 압축할 수 없음 (최대 {MAX_ENTRIES}개)"
    ))
}

/// The archive size a plan produces.
pub(crate) fn archive_size(plan: &Plan) -> u64 {
    plan.entries
        .iter()
        .map(|entry| {
            LOCAL_HEADER_LEN + CENTRAL_HEADER_LEN + 2 * entry.name.len() as u64 + entry.size
        })
        .sum::<u64>()
        + END_RECORD_LEN
}

fn check_limits(plan: &Plan) -> Result<(), ZipError> {
    if plan.entries.len() > MAX_ENTRIES {
        return Err(too_many());
    }
    if plan
        .entries
        .iter()
        .any(|entry| entry.name.len() > u16::MAX as usize)
    {
        return Err(ZipError::Refused(
            "경로가 너무 긴 파일이 있어 압축할 수 없음".to_owned(),
        ));
    }
    if archive_size(plan) > super::MAX_FILE_BYTES {
        return Err(ZipError::Refused(
            "폴더가 너무 큼 (압축 파일 최대 2GB)".to_owned(),
        ));
    }
    Ok(())
}

/// MS-DOS date and time (local time, 2-second resolution, 1980..=2107).
pub(crate) fn dos_time(modified: Option<SystemTime>) -> (u16, u16) {
    use chrono::{Datelike, Timelike};
    let Some(at) = modified else { return (0, 0x21) };
    let local: chrono::DateTime<chrono::Local> = at.into();
    if local.year() < 1980 {
        return (0, 0x21); // 1980-01-01 00:00
    }
    let year = local.year().min(2107) as u16;
    let time = ((local.hour() as u16) << 11)
        | ((local.minute() as u16) << 5)
        | (local.second() as u16 / 2);
    let date = ((year - 1980) << 9) | ((local.month() as u16) << 5) | local.day() as u16;
    (time, date)
}

struct Written {
    name: String,
    crc: u32,
    size: u32,
    offset: u32,
    time: u16,
    date: u16,
    directory: bool,
}

fn local_header(
    out: &mut File,
    name: &str,
    time: u16,
    date: u16,
    crc: u32,
    size: u32,
) -> io::Result<()> {
    let mut header = Vec::with_capacity(LOCAL_HEADER_LEN as usize + name.len());
    header.extend_from_slice(&LOCAL_HEADER.to_le_bytes());
    header.extend_from_slice(&VERSION.to_le_bytes());
    header.extend_from_slice(&UTF8_NAMES.to_le_bytes());
    header.extend_from_slice(&0u16.to_le_bytes()); // stored
    header.extend_from_slice(&time.to_le_bytes());
    header.extend_from_slice(&date.to_le_bytes());
    header.extend_from_slice(&crc.to_le_bytes());
    header.extend_from_slice(&size.to_le_bytes());
    header.extend_from_slice(&size.to_le_bytes());
    header.extend_from_slice(&(name.len() as u16).to_le_bytes());
    header.extend_from_slice(&0u16.to_le_bytes());
    header.extend_from_slice(name.as_bytes());
    out.write_all(&header)
}

/// Copy one file after its header; returns `(crc, bytes)`, or `None` if it could not
/// be read (the caller rewinds and skips it).
fn copy_member(
    source: &Path,
    out: &mut File,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<Option<(u32, u64)>, ZipError> {
    let Ok(mut input) = File::open(source) else {
        return Ok(None);
    };
    let mut buffer = vec![0u8; 256 * 1024];
    let (mut crc, mut total) = (0u32, 0u64);
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(ZipError::Cancelled);
        }
        let read = match input.read(&mut buffer) {
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Ok(None),
        };
        if read == 0 {
            break;
        }
        out.write_all(&buffer[..read])?;
        crc = crc32_update(crc, &buffer[..read]);
        total += read as u64;
        progress(read as u64);
    }
    Ok(Some((crc, total)))
}

/// Write `plan` to `output` (created or truncated). Returns how many files could not
/// be read and were left out. `progress` receives content bytes as they are copied.
pub(crate) fn write(
    plan: &Plan,
    output: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<usize, ZipError> {
    let mut out = File::create(output)?;
    let mut written: Vec<Written> = Vec::with_capacity(plan.entries.len());
    let mut skipped = 0;
    for entry in &plan.entries {
        let (time, date) = dos_time(entry.modified);
        let offset = out.stream_position()?;
        let Some(source) = &entry.source else {
            local_header(&mut out, &entry.name, time, date, 0, 0)?;
            written.push(Written {
                name: entry.name.clone(),
                crc: 0,
                size: 0,
                offset: offset as u32,
                time,
                date,
                directory: true,
            });
            continue;
        };
        local_header(&mut out, &entry.name, time, date, 0, 0)?;
        match copy_member(source, &mut out, cancel, &mut progress)? {
            Some((crc, size)) => {
                let end = out.stream_position()?;
                if end > super::MAX_FILE_BYTES {
                    // A file grew while being read.
                    return Err(ZipError::Refused(
                        "폴더가 너무 큼 (압축 파일 최대 2GB)".to_owned(),
                    ));
                }
                // Patch CRC and sizes into the local header (offset 14).
                out.seek(SeekFrom::Start(offset + 14))?;
                let mut patch = Vec::with_capacity(12);
                patch.extend_from_slice(&crc.to_le_bytes());
                patch.extend_from_slice(&(size as u32).to_le_bytes());
                patch.extend_from_slice(&(size as u32).to_le_bytes());
                out.write_all(&patch)?;
                out.seek(SeekFrom::Start(end))?;
                written.push(Written {
                    name: entry.name.clone(),
                    crc,
                    size: size as u32,
                    offset: offset as u32,
                    time,
                    date,
                    directory: false,
                });
            }
            None => {
                // Unreadable: drop the header written for it.
                out.set_len(offset)?;
                out.seek(SeekFrom::Start(offset))?;
                skipped += 1;
            }
        }
    }
    let central_offset = out.stream_position()?;
    let mut central = Vec::new();
    for member in &written {
        central.extend_from_slice(&CENTRAL_HEADER.to_le_bytes());
        central.extend_from_slice(&VERSION.to_le_bytes()); // made by (MS-DOS, 2.0)
        central.extend_from_slice(&VERSION.to_le_bytes()); // needed
        central.extend_from_slice(&UTF8_NAMES.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&member.time.to_le_bytes());
        central.extend_from_slice(&member.date.to_le_bytes());
        central.extend_from_slice(&member.crc.to_le_bytes());
        central.extend_from_slice(&member.size.to_le_bytes());
        central.extend_from_slice(&member.size.to_le_bytes());
        central.extend_from_slice(&(member.name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
        central.extend_from_slice(&(if member.directory { 0x10u32 } else { 0 }).to_le_bytes());
        central.extend_from_slice(&member.offset.to_le_bytes());
        central.extend_from_slice(member.name.as_bytes());
    }
    let count = written.len() as u16;
    central.extend_from_slice(&END_RECORD.to_le_bytes());
    central.extend_from_slice(&0u16.to_le_bytes());
    central.extend_from_slice(&0u16.to_le_bytes());
    central.extend_from_slice(&count.to_le_bytes());
    central.extend_from_slice(&count.to_le_bytes());
    central.extend_from_slice(&((central.len() - 4 - 2 - 2 - 2 - 2) as u32).to_le_bytes());
    central.extend_from_slice(&(central_offset as u32).to_le_bytes());
    central.extend_from_slice(&0u16.to_le_bytes());
    out.write_all(&central)?;
    if out.stream_position()? > super::MAX_FILE_BYTES {
        return Err(ZipError::Refused(
            "폴더가 너무 큼 (압축 파일 최대 2GB)".to_owned(),
        ));
    }
    out.sync_all()?;
    Ok(skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u16_at(bytes: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([bytes[at], bytes[at + 1]])
    }
    fn u32_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    /// A tiny reader: walks the central directory from the end record, checks every
    /// local header against it and returns `(name, data)` pairs.
    fn read_back(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
        let end = bytes.len() - END_RECORD_LEN as usize;
        assert_eq!(u32_at(bytes, end), END_RECORD);
        let count = u16_at(bytes, end + 10) as usize;
        assert_eq!(u16_at(bytes, end + 8) as usize, count);
        let size = u32_at(bytes, end + 12) as usize;
        let mut at = u32_at(bytes, end + 16) as usize;
        assert_eq!(at + size, end, "central directory ends at the end record");
        let mut members = Vec::new();
        for _ in 0..count {
            assert_eq!(u32_at(bytes, at), CENTRAL_HEADER);
            assert_eq!(u16_at(bytes, at + 8), UTF8_NAMES);
            assert_eq!(u16_at(bytes, at + 10), 0, "stored");
            let crc = u32_at(bytes, at + 16);
            let compressed = u32_at(bytes, at + 20) as usize;
            assert_eq!(u32_at(bytes, at + 24) as usize, compressed);
            let name_len = u16_at(bytes, at + 28) as usize;
            let local = u32_at(bytes, at + 42) as usize;
            let name = String::from_utf8(bytes[at + 46..at + 46 + name_len].to_vec()).unwrap();
            assert_eq!(u32_at(bytes, local), LOCAL_HEADER);
            assert_eq!(u32_at(bytes, local + 14), crc);
            assert_eq!(u32_at(bytes, local + 18) as usize, compressed);
            assert_eq!(u16_at(bytes, local + 26) as usize, name_len);
            assert_eq!(&bytes[local + 30..local + 30 + name_len], name.as_bytes());
            let data_at = local + 30 + name_len;
            let data = bytes[data_at..data_at + compressed].to_vec();
            assert_eq!(crc32_update(0, &data), crc, "{name}");
            members.push((name, data));
            at += 46 + name_len;
        }
        members
    }

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32_update(0, b"123456789"), 0xCBF4_3926);
        assert_eq!(
            crc32_update(crc32_update(0, b"1234"), b"56789"),
            0xCBF4_3926
        );
    }

    #[test]
    fn a_folder_round_trips_with_korean_names_and_empty_folders() {
        let source = tempfile::tempdir().unwrap();
        let root = source.path().join("사진 모음");
        fs::create_dir_all(root.join("하위/깊은")).unwrap();
        fs::create_dir_all(root.join("빈 폴더")).unwrap();
        fs::write(root.join("가.txt"), "안녕").unwrap();
        fs::write(root.join("하위/깊은/b.bin"), vec![7u8; 300_000]).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let plan = plan(&root, temp.path()).unwrap();
        let output = temp.path().join("사진 모음.zip");
        let mut copied = 0;
        let skipped = write(&plan, &output, &AtomicBool::new(false), |n| copied += n).unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(copied, 300_000 + "안녕".len() as u64);
        let bytes = fs::read(&output).unwrap();
        assert_eq!(bytes.len() as u64, archive_size(&plan));
        let members = read_back(&bytes);
        let names: Vec<&str> = members.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            [
                "사진 모음/가.txt",
                "사진 모음/빈 폴더/",
                "사진 모음/하위/깊은/b.bin"
            ]
        );
        assert_eq!(members[0].1, "안녕".as_bytes());
        assert_eq!(members[2].1, vec![7u8; 300_000]);
    }

    #[test]
    fn an_empty_root_folder_is_one_directory_entry() {
        let source = tempfile::tempdir().unwrap();
        let root = source.path().join("empty");
        fs::create_dir(&root).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let plan = plan(&root, temp.path()).unwrap();
        let output = temp.path().join("empty.zip");
        write(&plan, &output, &AtomicBool::new(false), |_| {}).unwrap();
        let members = read_back(&fs::read(&output).unwrap());
        assert_eq!(members, [("empty/".to_owned(), Vec::new())]);
    }

    #[test]
    fn limits_refuse_oversized_or_crowded_archives() {
        let entry = |size: u64| Entry {
            name: "d/f".into(),
            source: Some(PathBuf::from("/x")),
            size,
            modified: None,
        };
        let big = Plan {
            entries: vec![entry(super::super::MAX_FILE_BYTES)],
            ..Plan::default()
        };
        assert!(matches!(check_limits(&big), Err(ZipError::Refused(ref m)) if m.contains("2GB")));
        let fits = Plan {
            entries: vec![entry(1024)],
            ..Plan::default()
        };
        assert!(check_limits(&fits).is_ok());
        let crowded = Plan {
            entries: vec![entry(0); MAX_ENTRIES + 1],
            ..Plan::default()
        };
        assert!(
            matches!(check_limits(&crowded), Err(ZipError::Refused(ref m)) if m.contains("65535"))
        );
    }

    #[test]
    fn cancelling_stops_the_writer() {
        let source = tempfile::tempdir().unwrap();
        let root = source.path().join("f");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a"), b"x").unwrap();
        let temp = tempfile::tempdir().unwrap();
        let plan = plan(&root, temp.path()).unwrap();
        let result = write(
            &plan,
            &temp.path().join("f.zip"),
            &AtomicBool::new(true),
            |_| {},
        );
        assert!(matches!(result, Err(ZipError::Cancelled)));
    }

    #[test]
    fn the_temp_folder_is_never_included() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path().join("f");
        fs::create_dir_all(root.join("zips")).unwrap();
        fs::write(root.join("zips/f.zip"), b"partial").unwrap();
        fs::write(root.join("keep.txt"), b"k").unwrap();
        let plan = plan(&root, &root.join("zips")).unwrap();
        let names: Vec<&str> = plan
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, ["f/keep.txt"]);
    }

    #[test]
    fn dos_time_encodes_local_time_and_clamps_before_1980() {
        assert_eq!(dos_time(None), (0, 0x21));
        assert_eq!(dos_time(Some(SystemTime::UNIX_EPOCH)), (0, 0x21));
        let (_, date) = dos_time(Some(SystemTime::now()));
        assert!(date >> 9 >= 45, "year after 2025");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_skipped_not_followed() {
        let source = tempfile::tempdir().unwrap();
        let outside = source.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"s").unwrap();
        let root = source.path().join("f");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a.txt"), b"a").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link-dir")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link-file")).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let plan = plan(&root, temp.path()).unwrap();
        let names: Vec<&str> = plan
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, ["f/a.txt"]);
        assert_eq!(plan.skipped, 2);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_files_are_left_out_and_counted() {
        use std::os::unix::fs::PermissionsExt;
        let source = tempfile::tempdir().unwrap();
        let root = source.path().join("f");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a.txt"), b"a").unwrap();
        fs::write(root.join("b.txt"), b"b").unwrap();
        fs::set_permissions(root.join("a.txt"), fs::Permissions::from_mode(0o000)).unwrap();
        if File::open(root.join("a.txt")).is_ok() {
            return; // running as root: permissions do not apply
        }
        let temp = tempfile::tempdir().unwrap();
        let plan = plan(&root, temp.path()).unwrap();
        let output = temp.path().join("f.zip");
        let skipped = write(&plan, &output, &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!(skipped, 1);
        let members = read_back(&fs::read(&output).unwrap());
        assert_eq!(members, [("f/b.txt".to_owned(), b"b".to_vec())]);
    }
}
