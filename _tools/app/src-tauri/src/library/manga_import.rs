//! Local imports retain reversible page-name changes; archives stay at their source
//! because the application has no OS trash dependency.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Mutex, OnceLock},
};

const MAX_FILES: usize = 10_000;
const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
type Manifest = Vec<(PathBuf, u64, Vec<u8>)>;

struct Receipt {
    library: PathBuf,
    root: PathBuf,
    source: PathBuf,
    destination: PathBuf,
    archive: bool,
    archive_hash: Option<Vec<u8>>,
    names: Vec<(PathBuf, PathBuf)>,
    manifest: Manifest,
}
static RECEIPTS: OnceLock<Mutex<HashMap<String, Vec<Receipt>>>> = OnceLock::new();
fn receipts() -> &'static Mutex<HashMap<String, Vec<Receipt>>> {
    RECEIPTS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
pub(super) fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes junctions and other reparse points, not just symbolic links.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn image(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
        matches!(
            s.to_ascii_lowercase().as_str(),
            "jpg" | "jpeg" | "png" | "webp" | "avif" | "gif"
        )
    })
}
fn ignored(path: &Path) -> bool {
    path.components().any(|c| {
        let n = c.as_os_str().to_string_lossy();
        n.starts_with('.')
            || n.eq_ignore_ascii_case("__MACOSX")
            || n.eq_ignore_ascii_case("Thumbs.db")
            || n.eq_ignore_ascii_case("desktop.ini")
    })
}
// Compare numeric runs without integer overflow, then use the original path as a tie breaker.
fn natural(a: &str, b: &str) -> std::cmp::Ordering {
    let al = a.to_lowercase().replace('\\', "/");
    let bl = b.to_lowercase().replace('\\', "/");
    let mut a = al.as_bytes();
    let mut b = bl.as_bytes();
    while !a.is_empty() && !b.is_empty() {
        if a[0].is_ascii_digit() && b[0].is_ascii_digit() {
            let an = a.iter().take_while(|c| c.is_ascii_digit()).count();
            let bn = b.iter().take_while(|c| c.is_ascii_digit()).count();
            let av = a[..an]
                .iter()
                .position(|c| *c != b'0')
                .map(|i| &a[i..an])
                .unwrap_or(&[]);
            let bv = b[..bn]
                .iter()
                .position(|c| *c != b'0')
                .map(|i| &b[i..bn])
                .unwrap_or(&[]);
            let order = av.len().cmp(&bv.len()).then(av.cmp(bv));
            if !order.is_eq() {
                return order;
            }
            a = &a[an..];
            b = &b[bn..];
        } else {
            let order = a[0].cmp(&b[0]);
            if !order.is_eq() {
                return order;
            }
            a = &a[1..];
            b = &b[1..];
        }
    }
    a.len().cmp(&b.len())
}
fn hash(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(message)?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err("일반 파일만 가져올 수 있습니다".into());
    }
    let mut file = fs::File::open(path).map_err(message)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        let n = file.read(&mut buffer).map_err(message)?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        if bytes > MAX_BYTES {
            return Err("크기 제한(4GiB)을 초과했습니다".into());
        }
        hash.update(&buffer[..n]);
    }
    Ok(hash.finalize().to_vec())
}
fn files(root: &Path) -> Result<Manifest, String> {
    if is_link(&fs::symlink_metadata(root).map_err(message)?) {
        return Err("심볼릭 링크는 가져올 수 없습니다".into());
    }
    fn visit(
        root: &Path,
        relative: &Path,
        out: &mut Manifest,
        bytes: &mut u64,
        count: &mut usize,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 64 {
            return Err("폴더 깊이 제한(64)을 초과했습니다".into());
        }
        for entry in fs::read_dir(root.join(relative)).map_err(message)? {
            let entry = entry.map_err(message)?;
            let path = relative.join(entry.file_name());
            *count += 1;
            if *count > MAX_FILES {
                return Err("항목 수 제한(10,000개)을 초과했습니다".into());
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(message)?;
            // Refusing a folder with links also makes the cross-volume removal safe.
            if is_link(&metadata) || (!metadata.is_file() && !metadata.is_dir()) {
                return Err("심볼릭 링크 또는 특수 파일이 있는 폴더는 가져올 수 없습니다".into());
            }
            if metadata.is_dir() {
                visit(root, &path, out, bytes, count, depth + 1)?;
            } else {
                *bytes = bytes
                    .checked_add(metadata.len())
                    .ok_or("파일 크기 제한을 초과했습니다")?;
                if *bytes > MAX_BYTES {
                    return Err("크기 제한(4GiB)을 초과했습니다".into());
                }
                out.push((path, metadata.len(), hash(&entry.path())?));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    visit(root, Path::new(""), &mut out, &mut 0, &mut 0, 0)?;
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}
fn verify(root: &Path, manifest: &Manifest) -> Result<(), String> {
    if &files(root)? != manifest {
        return Err("파일이 변경되어 안전하게 이동하거나 되돌릴 수 없습니다".into());
    }
    Ok(())
}
fn copy_verify_remove(source: &Path, destination: &Path) -> Result<(), String> {
    let manifest = files(source)?;
    // Own the destination before cleanup is allowed. An existing directory is
    // never removed, including a collision between the existence check and copy.
    fs::create_dir(destination).map_err(message)?;
    fn copy(source: &Path, destination: &Path) -> Result<(), String> {
        for entry in fs::read_dir(source).map_err(message)? {
            let entry = entry.map_err(message)?;
            let target = destination.join(entry.file_name());
            if is_link(&fs::symlink_metadata(entry.path()).map_err(message)?) {
                return Err("링크는 이동할 수 없습니다".into());
            }
            let kind = entry.file_type().map_err(message)?;
            if kind.is_dir() {
                fs::create_dir(&target).map_err(message)?;
                copy(&entry.path(), &target)?;
            } else if kind.is_file() {
                fs::copy(entry.path(), &target).map_err(message)?;
                fs::OpenOptions::new()
                    .write(true)
                    .open(target)
                    .map_err(message)?
                    .sync_all()
                    .map_err(message)?;
            } else {
                return Err("심볼릭 링크는 이동할 수 없습니다".into());
            }
        }
        Ok(())
    }
    let copied = copy(source, destination)
        .and_then(|()| verify(destination, &manifest))
        .and_then(|()| verify(source, &manifest));
    if let Err(error) = copied {
        let _ = fs::remove_dir_all(destination);
        return Err(error);
    }
    // A failed removal retains the verified destination; never delete the only complete copy.
    fs::remove_dir_all(source).map_err(|e| {
        format!(
            "원본 제거 실패; 복사본 보존: {} ({e})",
            destination.display()
        )
    })
}
// Linux rename normally replaces an empty destination directory. Use its
// no-replace primitive so a concurrent name collision never consumes user data.
#[cfg(target_os = "linux")]
fn rename_folder(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    unsafe extern "C" {
        fn renameat2(
            old_dir: i32,
            old: *const std::ffi::c_char,
            new_dir: i32,
            new: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    let old = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let new = std::ffi::CString::new(destination.as_os_str().as_bytes())?;
    // SAFETY: both C strings stay alive for the call; -100 is AT_FDCWD,
    // and 1 is RENAME_NOREPLACE. Unsupported systems fail without moving data.
    if unsafe { renameat2(-100, old.as_ptr(), -100, new.as_ptr(), 1) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
#[cfg(not(target_os = "linux"))]
fn rename_folder(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}
fn move_folder(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Err("원래 위치에 같은 이름의 항목이 있습니다".into());
    }
    match rename_folder(source, destination) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_verify_remove(source, destination)
        }
        Err(e) => Err(message(e)),
    }
}
// Stage all pages first, so overlapping names (page1.jpg -> 001.jpg) never overwrite.
fn rename_pages(folder: &Path, names: &[(PathBuf, PathBuf)], reverse: bool) -> Result<(), String> {
    if names.is_empty() {
        return Ok(());
    }
    let staging = folder.join(format!(".lakomics-pages-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging).map_err(message)?;
    let mut staged = 0;
    let mut installed = 0;
    let result = (|| {
        for (i, (old, new)) in names.iter().enumerate() {
            let from = if reverse { new } else { old };
            fs::rename(folder.join(from), staging.join(i.to_string())).map_err(message)?;
            staged += 1;
        }
        for (i, (old, new)) in names.iter().enumerate() {
            let to = if reverse { old } else { new };
            let target = folder.join(to);
            if target.exists() {
                return Err("페이지 대상 이름이 이미 사용 중입니다".into());
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(message)?;
            }
            fs::rename(staging.join(i.to_string()), target).map_err(message)?;
            installed += 1;
        }
        Ok(())
    })();
    if result.is_err() {
        for i in (0..installed).rev() {
            let (old, new) = &names[i];
            fs::rename(
                folder.join(if reverse { old } else { new }),
                staging.join(i.to_string()),
            )
            .map_err(message)?;
        }
        for (i, (old, new)) in names.iter().enumerate().take(staged) {
            fs::rename(
                staging.join(i.to_string()),
                folder.join(if reverse { new } else { old }),
            )
            .map_err(message)?;
        }
    }
    fs::remove_dir(&staging).map_err(message)?;
    result
}
fn page_names(manifest: &Manifest) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let mut pages: Vec<_> = manifest
        .iter()
        .filter(|(p, _, _)| image(p) && !ignored(p))
        .map(|(p, _, _)| p.clone())
        .collect();
    if pages.is_empty() {
        return Err("이미지가 없습니다".into());
    }
    let scannable = pages.iter().all(|p| {
        p.components().count() == 1
            && p.file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.parse::<u32>().is_ok())
    });
    if scannable {
        return Ok(Vec::new());
    }
    pages.sort_by(|a, b| natural(&a.to_string_lossy(), &b.to_string_lossy()).then(a.cmp(b)));
    Ok(pages
        .into_iter()
        .enumerate()
        .map(|(i, p)| {
            let new = PathBuf::from(format!(
                "{:03}.{}",
                i + 1,
                p.extension()
                    .unwrap()
                    .to_string_lossy()
                    .to_ascii_lowercase()
            ));
            (p, new)
        })
        .collect())
}
fn extract(source: &Path, destination: &Path) -> Result<(), String> {
    let mut zip =
        zip::ZipArchive::new(fs::File::open(source).map_err(message)?).map_err(message)?;
    if zip.len() > MAX_FILES {
        return Err("항목 수 제한(10,000개)을 초과했습니다".into());
    }
    let mut pages = Vec::new();
    let mut bytes = 0u64;
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(message)?;
        let name = entry.name().replace('\\', "/");
        if name.starts_with('/')
            || name.contains(':')
            || name.split('/').any(|part| part == "..")
            || entry.enclosed_name().is_none()
        {
            return Err("압축 파일에 안전하지 않은 경로가 있습니다".into());
        }
        bytes = bytes
            .checked_add(entry.size())
            .ok_or("파일 크기 제한을 초과했습니다")?;
        if bytes > MAX_BYTES {
            return Err("크기 제한(4GiB)을 초과했습니다".into());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
            || entry.is_dir()
            || ignored(Path::new(&name))
            || !image(Path::new(&name))
        {
            continue;
        }
        pages.push((i, name));
    }
    if pages.is_empty() {
        return Err("이미지가 없습니다".into());
    }
    pages.sort_by(|a, b| natural(&a.1, &b.1).then(a.1.cmp(&b.1)));
    for (page, (index, name)) in pages.iter().enumerate() {
        let mut entry = zip.by_index(*index).map_err(message)?;
        let target = destination.join(format!(
            "{:03}.{}",
            page + 1,
            Path::new(name)
                .extension()
                .unwrap()
                .to_string_lossy()
                .to_ascii_lowercase()
        ));
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(message)?;
        let expected = entry.size();
        let written =
            std::io::copy(&mut (&mut entry).take(expected + 1), &mut out).map_err(message)?;
        if written != expected {
            return Err("압축 해제 크기 확인에 실패했습니다".into());
        }
        out.flush().map_err(message)?;
        out.sync_all().map_err(message)?;
    }
    Ok(())
}
fn root(library: &Library) -> Result<PathBuf, String> {
    let root = PathBuf::from(
        library
            .manga_root()
            .map_err(message)?
            .ok_or("망가 폴더가 설정되지 않았습니다")?,
    );
    super::super::manga_root_guard::require(
        library,
        &*library.connection().map_err(message)?,
        &root,
        true,
    )
    .map_err(message)?;
    fs::canonicalize(root).map_err(message)
}
fn import_one(library: &Library, root: &Path, source: &Path) -> Result<Receipt, String> {
    if fs::symlink_metadata(root.join(THUMB_DIR)).is_ok_and(|m| is_link(&m)) {
        return Err("안전하지 않은 썸네일 경로입니다".into());
    }
    let metadata = fs::symlink_metadata(source).map_err(message)?;
    if is_link(&metadata) {
        return Err("심볼릭 링크는 가져올 수 없습니다".into());
    }
    let source = fs::canonicalize(source).map_err(message)?;
    if source.starts_with(root) || root.starts_with(&source) {
        return Err("망가 폴더 또는 그 안의 항목은 가져올 수 없습니다".into());
    }
    let archive = metadata.is_file();
    if archive
        && !source
            .extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("zip") || s.eq_ignore_ascii_case("cbz"))
    {
        return Err("폴더, ZIP, CBZ만 가져올 수 있습니다 (RAR/CBR/7Z 미지원)".into());
    }
    if !archive && !metadata.is_dir() {
        return Err("일반 폴더 또는 압축 파일만 가져올 수 있습니다".into());
    }
    let name = if archive {
        source.file_stem()
    } else {
        source.file_name()
    }
    .ok_or("작품 이름이 없습니다")?
    .to_string_lossy()
    .into_owned();
    if name.starts_with('.') {
        return Err("숨김 항목은 가져올 수 없습니다".into());
    }
    let mut destination = root.join(&name);
    let mut suffix = 2;
    while fs::symlink_metadata(&destination).is_ok() {
        destination = root.join(format!("{name} ({suffix})"));
        suffix += 1;
    }
    let manifest = if archive { Vec::new() } else { files(&source)? };
    let names = if archive {
        Vec::new()
    } else {
        page_names(&manifest)?
    };
    let archive_hash = if archive { Some(hash(&source)?) } else { None };
    let staging = root.join(format!(".lakomics-import-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging).map_err(message)?;
    let work = staging.join("work");
    let prepared = if archive {
        fs::create_dir(&work)
            .map_err(message)
            .and_then(|()| extract(&source, &work))
    } else {
        move_folder(&source, &work).and_then(|()| rename_pages(&work, &names, false))
    };
    if let Err(error) = prepared {
        if !archive && work.exists() {
            move_folder(&work, &source)
                .map_err(|e| format!("{error}; 복구 실패: {e}; 보존 위치: {}", work.display()))?;
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let imported_manifest = match files(&work) {
        Ok(manifest) => manifest,
        Err(error) => {
            if !archive {
                rename_pages(&work, &names, true)?;
                move_folder(&work, &source)?;
            }
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    if let Err(error) = rename_folder(&work, &destination) {
        if !archive {
            rename_pages(&work, &names, true)?;
            move_folder(&work, &source)?;
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(message(error));
    }
    let _ = fs::remove_dir(&staging);
    let receipt = Receipt {
        library: library.root().to_path_buf(),
        root: root.into(),
        source,
        destination,
        archive,
        archive_hash,
        names,
        manifest: imported_manifest,
    };
    let thumb_dir = root.join(THUMB_DIR);
    let registered = fs::create_dir_all(&thumb_dir)
        .map_err(message)
        .and_then(|()| {
            scan_series_folder(
                library,
                root,
                receipt
                    .destination
                    .file_name()
                    .unwrap()
                    .to_str()
                    .ok_or("작품 이름을 읽을 수 없습니다")?,
                &thumb_dir,
                &mut create_thumbnail,
            )
            .map_err(message)
        })
        .and_then(|added| {
            if added {
                Ok(())
            } else {
                Err("작품을 등록하지 못했습니다".into())
            }
        });
    if let Err(error) = registered {
        undo_one(library, &receipt)?;
        return Err(error);
    }
    Ok(receipt)
}
fn undo_one(library: &Library, receipt: &Receipt) -> Result<(), String> {
    if receipt.library != library.root() || receipt.root != root(library)? {
        return Err("가져온 라이브러리 또는 망가 폴더가 변경되었습니다".into());
    }
    verify(&receipt.destination, &receipt.manifest)?;
    if receipt.archive {
        if Some(hash(&receipt.source)?) != receipt.archive_hash {
            return Err("압축 파일 원본이 변경되어 되돌릴 수 없습니다".into());
        }
        fs::remove_dir_all(&receipt.destination).map_err(message)?;
    } else {
        if fs::symlink_metadata(&receipt.source).is_ok() {
            return Err("원래 위치에 같은 이름의 항목이 있습니다".into());
        }
        rename_pages(&receipt.destination, &receipt.names, true)?;
        if let Err(error) = move_folder(&receipt.destination, &receipt.source) {
            rename_pages(&receipt.destination, &receipt.names, false)?;
            return Err(error);
        }
    }
    library
        .connection()
        .map_err(message)?
        .execute(
            "DELETE FROM manga_series WHERE relative_path = ?1",
            [receipt
                .destination
                .file_name()
                .unwrap()
                .to_string_lossy()
                .as_ref()],
        )
        .map_err(message)?;
    Ok(())
}
impl Library {
    pub fn import_local_manga(&self, paths: Vec<String>) -> Result<serde_json::Value, String> {
        let _guard = self
            .manga_scan_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let root = root(self)?;
        let mut imported = Vec::new();
        let mut failures = Vec::new();
        let mut archives = 0;
        for path in paths {
            match import_one(self, &root, Path::new(&path)) {
                Ok(receipt) => {
                    if receipt.archive {
                        archives += 1;
                    }
                    imported.push(receipt);
                }
                Err(error) => failures.push(serde_json::json!({"path":path,"message":error})),
            }
        }
        let count = imported.len();
        let token = uuid::Uuid::new_v4().to_string();
        let mut receipts = receipts()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if count > 0 {
            receipts.insert(token.clone(), imported);
        }
        Ok(
            serde_json::json!({"count":count,"undoToken":if count > 0 {Some(token)} else {None},"archivesRetained":archives,"failures":failures}),
        )
    }
    pub fn undo_local_manga_import(&self, token: &str) -> Result<serde_json::Value, String> {
        let _guard = self
            .manga_scan_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut receipts = receipts()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entries = receipts.get_mut(token).ok_or("되돌리기 기록이 없습니다")?;
        let mut remaining = Vec::new();
        let mut failures = Vec::new();
        let mut count = 0;
        for receipt in entries.drain(..).rev() {
            match undo_one(self, &receipt) {
                Ok(()) => count += 1,
                Err(error) => {
                    failures.push(serde_json::json!({"path":receipt.source,"message":error}));
                    remaining.push(receipt);
                }
            }
        }
        *entries = remaining;
        if entries.is_empty() {
            receipts.remove(token);
        }
        Ok(serde_json::json!({"count":count,"failures":failures}))
    }
    pub fn dismiss_local_manga_import(&self, token: &str) {
        let mut receipts = receipts()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if receipts
            .get(token)
            .is_some_and(|r| r.iter().all(|r| r.library == self.root()))
        {
            receipts.remove(token);
        }
    }
    pub fn refresh_local_manga_thumbnails(
        &self,
        ids: Option<Vec<String>>,
    ) -> Result<serde_json::Value, String> {
        let _guard = self
            .manga_scan_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let root = root(self)?;
        let mut refreshed = Vec::new();
        let mut failures = Vec::new();
        let series = self.list_manga_series().map_err(message)?;
        for entry in series
            .into_iter()
            .filter(|entry| ids.as_ref().is_none_or(|ids| ids.contains(&entry.id)))
        {
            let outcome = (|| {
                let relative: String = self
                    .connection()
                    .map_err(message)?
                    .query_row(
                        "SELECT relative_path FROM manga_series WHERE id=?1",
                        [&entry.id],
                        |r| r.get(0),
                    )
                    .map_err(message)?;
                if entry.id.contains(['/', '\\', ':']) {
                    return Err("안전하지 않은 작품 ID입니다".into());
                }
                let folder = root.join(relative);
                if is_link(&fs::symlink_metadata(&folder).map_err(message)?)
                    || !fs::canonicalize(&folder)
                        .map_err(message)?
                        .starts_with(&root)
                {
                    return Err("안전하지 않은 작품 경로입니다".into());
                }
                let pages = list_page_files(&folder).map_err(message)?;
                let first = pages.first().ok_or("이미지가 없습니다")?;
                let thumbs = root.join(THUMB_DIR);
                if fs::symlink_metadata(&thumbs).is_ok_and(|m| is_link(&m)) {
                    return Err("안전하지 않은 썸네일 경로입니다".into());
                }
                fs::create_dir_all(&thumbs).map_err(message)?;
                thumbnail_atomically(
                    &folder.join(first),
                    &thumbs.join(format!("{}.webp", entry.id)),
                    &mut create_thumbnail,
                )
                .map_err(message)?;
                self.connection()
                    .map_err(message)?
                    .execute(
                        "UPDATE manga_series SET page_count=?1 WHERE id=?2",
                        rusqlite::params![pages.len() as i64, entry.id],
                    )
                    .map_err(message)?;
                Ok::<_, String>(())
            })();
            match outcome {
                Ok(()) => refreshed.push(entry.id),
                Err(error) => {
                    failures.push(serde_json::json!({"path":entry.title,"message":error}))
                }
            }
        }
        Ok(
            serde_json::json!({"refreshedIds":refreshed,"revision":uuid::Uuid::new_v4().to_string(),"failures":failures}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Library, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let root = temp.path().join("manga");
        library.set_manga_root(root.to_str()).unwrap();
        (temp, library, root)
    }
    fn png(path: &Path, color: u8) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        image::RgbaImage::from_pixel(8, 8, image::Rgba([color, 0, 0, 255]))
            .save(path)
            .unwrap();
    }
    fn import(library: &Library, path: &Path) -> serde_json::Value {
        library
            .import_local_manga(vec![path.to_string_lossy().into_owned()])
            .unwrap()
    }
    fn archive(path: &Path, names: &[&str]) {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut cursor = cursor;
        image::RgbaImage::from_pixel(8, 8, image::Rgba([255, 0, 0, 255]))
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let bytes = cursor.into_inner();
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for name in names {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap();
    }
    #[test]
    fn manga_folder_move_normalizes_registers_and_undo_restores_names() {
        let (temp, library, root) = fixture();
        let source = temp.path().join("[author] work");
        png(&source.join("nested/page10.png"), 10);
        png(&source.join("nested/page2.png"), 2);
        fs::write(source.join("info.txt"), "notes").unwrap();
        let original = files(&source).unwrap();
        let result = import(&library, &source);
        assert_eq!(result["count"], 1);
        assert!(!source.exists());
        let work = root.join("[author] work");
        assert_eq!(
            image::open(work.join("001.png"))
                .unwrap()
                .to_rgba8()
                .get_pixel(0, 0)[0],
            2
        );
        assert_eq!(library.list_manga_series().unwrap()[0].author, "author");
        assert_eq!(library.list_manga_series().unwrap()[0].page_count, 2);
        assert!(root.join(THUMB_DIR).read_dir().unwrap().next().is_some());
        let undo = library
            .undo_local_manga_import(result["undoToken"].as_str().unwrap())
            .unwrap();
        assert_eq!(undo["count"], 1);
        assert_eq!(files(&source).unwrap(), original);
        assert!(!work.exists());
        assert!(library.list_manga_series().unwrap().is_empty());
    }
    #[test]
    fn manga_numeric_folder_moves_unchanged_and_name_clash_adds_suffix() {
        let (temp, library, root) = fixture();
        let source = temp.path().join("work");
        png(&source.join("002.png"), 2);
        png(&source.join("1.png"), 1);
        fs::create_dir(root.join("work")).unwrap();
        let before = files(&source).unwrap();
        let result = import(&library, &source);
        assert_eq!(result["count"], 1);
        assert_eq!(files(&root.join("work (2)")).unwrap(), before);
        assert!(root.join("work").is_dir());
    }
    #[test]
    fn manga_zip_cbz_flatten_natural_order_ignore_hidden_and_preserve_archive_for_undo() {
        for extension in ["zip", "cbz"] {
            let (temp, library, root) = fixture();
            let source = temp.path().join(format!("work.{extension}"));
            let mut cursor = std::io::Cursor::new(Vec::new());
            let mut zip = zip::ZipWriter::new(&mut cursor);
            for (name, color) in [
                ("chapter/page10.png", 10),
                ("chapter/page2.png", 2),
                ("__MACOSX/001.png", 99),
            ] {
                let mut image = std::io::Cursor::new(Vec::new());
                image::RgbaImage::from_pixel(8, 8, image::Rgba([color, 0, 0, 255]))
                    .write_to(&mut image, image::ImageFormat::Png)
                    .unwrap();
                zip.start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(image.get_ref()).unwrap();
            }
            zip.add_symlink(
                "link.png",
                "chapter/page2.png",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.finish().unwrap();
            fs::write(&source, cursor.into_inner()).unwrap();
            let result = import(&library, &source);
            assert_eq!(result["count"], 1);
            assert_eq!(result["archivesRetained"], 1);
            assert_eq!(
                list_page_files(&root.join("work")).unwrap(),
                vec!["001.png", "002.png"]
            );
            assert_eq!(
                image::open(root.join("work/001.png"))
                    .unwrap()
                    .to_rgba8()
                    .get_pixel(0, 0)[0],
                2
            );
            assert!(source.exists());
            assert_eq!(
                library
                    .undo_local_manga_import(result["undoToken"].as_str().unwrap())
                    .unwrap()["count"],
                1
            );
            assert!(source.exists());
            assert!(!root.join("work").exists());
        }
    }
    #[test]
    fn manga_zip_slip_is_refused_and_staging_cleaned() {
        for name in [
            "../evil.png",
            "/evil.png",
            "C:/evil.png",
            "safe/../../evil.png",
            "safe\\..\\evil.png",
        ] {
            let (temp, library, root) = fixture();
            let source = temp.path().join("bad.zip");
            archive(&source, &[name]);
            assert_eq!(import(&library, &source)["count"], 0);
            assert!(source.exists());
            assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
            assert!(!temp.path().join("evil.png").exists());
        }
    }
    #[test]
    fn manga_caps_and_nonimage_or_internal_drops_are_refused_without_writes() {
        let (temp, library, root) = fixture();
        assert_eq!(import(&library, &root)["count"], 0);
        let inside = root.join("already");
        png(&inside.join("001.png"), 1);
        assert_eq!(import(&library, &inside)["count"], 0);
        let source = temp.path().join("empty");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("notes.txt"), "keep").unwrap();
        assert_eq!(import(&library, &source)["count"], 0);
        assert!(source.exists());
        fs::File::create(source.join("huge.png"))
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(files(&source).unwrap_err().contains("4GiB"));
        let zip = temp.path().join("many.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&zip).unwrap());
        for i in 0..=MAX_FILES {
            writer
                .start_file(format!("{i}.png"), zip::write::SimpleFileOptions::default())
                .unwrap();
        }
        writer.finish().unwrap();
        assert!(import(&library, &zip)["failures"][0]["message"]
            .as_str()
            .unwrap()
            .contains("10,000"));
        let unsupported = temp.path().join("book.rar");
        fs::write(&unsupported, "keep").unwrap();
        assert_eq!(import(&library, &unsupported)["count"], 0);
    }
    #[test]
    fn manga_zip_declared_uncompressed_size_cap_is_checked_before_extracting() {
        let (temp, library, root) = fixture();
        let source = temp.path().join("oversize.zip");
        archive(&source, &["one.png", "two.png"]);
        let mut bytes = fs::read(&source).unwrap();
        let headers: Vec<_> = bytes
            .windows(4)
            .enumerate()
            .filter_map(|(i, b)| (b == b"PK\x01\x02").then_some(i))
            .collect();
        assert_eq!(headers.len(), 2);
        for header in headers {
            bytes[header + 24..header + 28]
                .copy_from_slice(&(3u32 * 1024 * 1024 * 1024).to_le_bytes());
        }
        fs::write(&source, bytes).unwrap();
        let result = import(&library, &source);
        assert_eq!(result["count"], 0);
        assert!(result["failures"][0]["message"]
            .as_str()
            .unwrap()
            .contains("4GiB"));
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    }
    #[test]
    fn manga_cross_volume_copy_verify_branch_and_undo_collision_preserve_data() {
        let (temp, library, root) = fixture();
        let source = temp.path().join("source");
        png(&source.join("001.png"), 1);
        fs::create_dir(source.join("empty")).unwrap();
        let before = files(&source).unwrap();
        let copied = temp.path().join("copy");
        copy_verify_remove(&source, &copied).unwrap();
        assert!(!source.exists());
        assert_eq!(files(&copied).unwrap(), before);
        assert!(copied.join("empty").is_dir());
        let result = import(&library, &copied);
        fs::create_dir(&copied).unwrap();
        let undo = library
            .undo_local_manga_import(result["undoToken"].as_str().unwrap())
            .unwrap();
        assert_eq!(undo["count"], 0);
        assert!(root.join("copy/001.png").exists());
    }
    #[test]
    fn manga_copy_branch_never_cleans_up_an_existing_destination() {
        let (temp, _, _) = fixture();
        let source = temp.path().join("source");
        png(&source.join("001.png"), 1);
        let destination = temp.path().join("destination");
        png(&destination.join("keep.png"), 2);
        assert!(copy_verify_remove(&source, &destination).is_err());
        assert!(source.join("001.png").exists());
        assert!(destination.join("keep.png").exists());
        assert!(rename_folder(&source, &destination).is_err());
        assert!(destination.join("keep.png").exists());
    }
    #[test]
    fn manga_refresh_thumbnail_uses_current_first_page_after_deletion() {
        let (temp, library, root) = fixture();
        let source = temp.path().join("work");
        png(&source.join("001.png"), 1);
        png(&source.join("002.png"), 240);
        assert_eq!(import(&library, &source)["count"], 1);
        let id = library.list_manga_series().unwrap()[0].id.clone();
        let thumb = root.join(THUMB_DIR).join(format!("{id}.webp"));
        let before = fs::read(&thumb).unwrap();
        fs::remove_file(root.join("work/001.png")).unwrap();
        let result = library
            .refresh_local_manga_thumbnails(Some(vec![id.clone()]))
            .unwrap();
        assert_eq!(result["refreshedIds"][0], id);
        assert!(result["failures"].as_array().unwrap().is_empty());
        assert_ne!(fs::read(&thumb).unwrap(), before);
        assert_eq!(
            image::open(thumb).unwrap().to_rgba8().get_pixel(0, 0)[0],
            240
        );
    }
    #[cfg(unix)]
    #[test]
    fn manga_folder_symlinks_are_refused_without_following() {
        let (temp, library, _) = fixture();
        let source = temp.path().join("work");
        png(&source.join("001.png"), 1);
        std::os::unix::fs::symlink(temp.path().join("library"), source.join("link")).unwrap();
        assert_eq!(import(&library, &source)["count"], 0);
        assert!(source.join("001.png").exists());
    }
}
