//! The ToonOut cutout model (MIT, ~490 MB): downloaded once into the PC app data folder on the
//! first cutout run, never bundled or committed. The download is resumable (`.part`), checked
//! against a pinned length and SHA-256, and only then renamed into place.
use super::cache::hex;
use sha2::{Digest, Sha256};
use std::{
    fmt,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime},
};

pub(crate) const FILE_NAME: &str = "birefnet-toonout-fp16.onnx";
pub(crate) const URL: &str =
    "https://huggingface.co/sprited/birefnet-toonout-onnx/resolve/main/birefnet-toonout-fp16.onnx";
pub(crate) const BYTES: u64 = 492_381_880;
pub(crate) const SHA256: &str = "213a8a98ee426ef8f02d247eb5a5a9889359e37c2e1e7e31e282d61034d08a83";
/// Development and tests only: an existing copy of the same file. It is verified like a
/// downloaded one and is never downloaded or replaced.
pub(crate) const OVERRIDE_ENV: &str = "LAKOMICS_CARD_CUTOUT_MODEL";

#[derive(Clone, Copy, Debug)]
pub(crate) struct Source<'a> {
    pub url: &'a str,
    pub bytes: u64,
    pub sha256: &'a str,
}

pub(crate) const PINNED: Source<'static> = Source {
    url: URL,
    bytes: BYTES,
    sha256: SHA256,
};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ModelError {
    Cancelled,
    Network(String),
    Io(String),
    /// Wrong length or hash: the file was discarded.
    Corrupt,
    /// The override file is missing or is not the pinned model.
    BadOverride,
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => f.write_str("취소됨"),
            Self::Network(why) => write!(f, "모델을 내려받지 못했습니다: {why}"),
            Self::Io(why) => write!(f, "모델 파일을 저장하지 못했습니다: {why}"),
            Self::Corrupt => f.write_str("내려받은 모델이 올바르지 않아 지웠습니다."),
            Self::BadOverride => f.write_str("지정한 카드 누끼 모델 파일이 올바르지 않습니다."),
        }
    }
}

impl From<std::io::Error> for ModelError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

/// One opened download: the body from the requested offset, and whether the server really
/// resumed there (a server that ignores the range sends everything from byte zero).
pub(crate) struct Opened {
    pub reader: Box<dyn Read + Send>,
    pub resumed: bool,
}

pub(crate) trait Fetch {
    fn open(&self, url: &str, from: u64) -> Result<Opened, ModelError>;
}

pub(crate) struct HttpFetch;

impl Fetch for HttpFetch {
    fn open(&self, url: &str, from: u64) -> Result<Opened, ModelError> {
        let agent = crate::http_agent::agent(
            ureq::Agent::config_builder()
                .https_only(true)
                .max_redirects(5)
                .http_status_as_error(false)
                .timeout_connect(Some(Duration::from_secs(30)))
                .timeout_global(Some(Duration::from_secs(3 * 3600)))
                .build(),
        );
        let mut request = agent.get(url);
        if from > 0 {
            request = request.header("Range", format!("bytes={from}-"));
        }
        let response = request
            .call()
            .map_err(|e| ModelError::Network(e.to_string()))?;
        let status = response.status().as_u16();
        let resumed = match (status, from) {
            (206, from) if from > 0 => {
                let starts = response
                    .headers()
                    .get("content-range")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| v.starts_with(&format!("bytes {from}-")));
                if !starts {
                    return Err(ModelError::Network("unexpected range".into()));
                }
                true
            }
            (200, _) => false,
            // A stale `.part` longer than the file: start over without the range.
            (416, from) if from > 0 => return self.open(url, 0),
            _ => return Err(ModelError::Network(format!("HTTP {status}"))),
        };
        Ok(Opened {
            reader: Box::new(response.into_body().into_reader()),
            resumed,
        })
    }
}

fn part_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.part"))
}

fn hash_file(path: &Path, cancel: &AtomicBool) -> Result<(String, u64), ModelError> {
    let mut file = std::fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(ModelError::Cancelled);
        }
        let n = file.read(&mut buffer)?;
        if n == 0 {
            return Ok((hex(&digest.finalize()), total));
        }
        digest.update(&buffer[..n]);
        total += n as u64;
    }
}

#[derive(Clone, PartialEq, Eq)]
struct Verified {
    path: PathBuf,
    len: u64,
    modified: SystemTime,
    sha256: String,
}
static VERIFIED: Mutex<Option<Verified>> = Mutex::new(None);

/// True when `path` is exactly the pinned file. A full hash of ~490 MB happens once per
/// process; later checks compare length and modification time.
pub(crate) fn verify(
    path: &Path,
    source: &Source,
    cancel: &AtomicBool,
) -> Result<bool, ModelError> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Ok(false);
    };
    if !meta.is_file() || meta.len() != source.bytes {
        return Ok(false);
    }
    let key = Verified {
        path: path.to_path_buf(),
        len: meta.len(),
        modified: meta.modified()?,
        sha256: source.sha256.to_owned(),
    };
    if VERIFIED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        == Some(&key)
    {
        return Ok(true);
    }
    let (digest, _) = hash_file(path, cancel)?;
    let ok = digest == source.sha256;
    if ok {
        *VERIFIED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(key);
    }
    Ok(ok)
}

/// Resumes or starts the download of `source` into `dir/name`, verifies it and renames it
/// into place. `progress(done, total)` is called as bytes arrive.
pub(crate) fn download(
    fetch: &dyn Fetch,
    source: &Source,
    dir: &Path,
    name: &str,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<PathBuf, ModelError> {
    std::fs::create_dir_all(dir)?;
    let part = part_path(dir, name);
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have > source.bytes {
        std::fs::remove_file(&part)?;
        have = 0;
    }
    if have < source.bytes {
        let opened = fetch.open(source.url, have)?;
        if !opened.resumed {
            have = 0;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(have > 0)
            .truncate(have == 0)
            .open(&part)?;
        let mut reader = opened.reader;
        let mut buffer = vec![0u8; 256 * 1024];
        progress(have, source.bytes);
        loop {
            if cancel.load(Ordering::Acquire) {
                file.flush()?;
                return Err(ModelError::Cancelled);
            }
            let n = reader
                .read(&mut buffer)
                .map_err(|e| ModelError::Network(e.to_string()))?;
            if n == 0 {
                break;
            }
            if have + n as u64 > source.bytes {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Err(ModelError::Corrupt);
            }
            file.write_all(&buffer[..n])?;
            have += n as u64;
            progress(have, source.bytes);
        }
        file.sync_all()?;
    }
    if have != source.bytes {
        // Cut short: keep the `.part` so the next run resumes.
        return Err(ModelError::Network("download ended early".into()));
    }
    let (digest, _) = hash_file(&part, cancel)?;
    if digest != source.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(ModelError::Corrupt);
    }
    let target = dir.join(name);
    std::fs::rename(&part, &target)?;
    Ok(target)
}

/// The verified model file: the override when set (never downloaded), otherwise the copy in
/// `dir`, downloading it first if it is missing or does not match.
pub(crate) fn ensure(
    fetch: &dyn Fetch,
    source: &Source,
    dir: &Path,
    override_path: Option<PathBuf>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<PathBuf, ModelError> {
    if let Some(path) = override_path {
        return if verify(&path, source, cancel)? {
            Ok(path)
        } else {
            Err(ModelError::BadOverride)
        };
    }
    let target = dir.join(FILE_NAME);
    if verify(&target, source, cancel)? {
        return Ok(target);
    }
    if target.exists() {
        // A file of the wrong content under the final name: never trust it, fetch again.
        std::fs::remove_file(&target)?;
    }
    download(fetch, source, dir, FILE_NAME, cancel, progress)
}

pub(crate) fn override_from_env() -> Option<PathBuf> {
    std::env::var_os(OVERRIDE_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, io::Cursor};

    const DATA: &[u8] = b"pretend this is a 490 MB model";

    fn source() -> Source<'static> {
        Source {
            url: "https://example.test/model.onnx",
            bytes: DATA.len() as u64,
            sha256: Box::leak(hex(&Sha256::digest(DATA)).into_boxed_str()),
        }
    }

    /// Serves `DATA`; `honour_range` decides whether a resume offset is respected.
    struct Fake {
        honour_range: bool,
        body: Vec<u8>,
        opens: RefCell<Vec<u64>>,
        fail_after: Option<usize>,
    }
    impl Fake {
        fn new(honour_range: bool) -> Self {
            Self {
                honour_range,
                body: DATA.to_vec(),
                opens: RefCell::default(),
                fail_after: None,
            }
        }
    }
    struct Flaky(Cursor<Vec<u8>>, usize);
    impl Read for Flaky {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0.position() as usize >= self.1 {
                return Err(std::io::Error::other("connection reset"));
            }
            let limit = buf.len().min(self.1 - self.0.position() as usize);
            self.0.read(&mut buf[..limit])
        }
    }
    impl Fetch for Fake {
        fn open(&self, _: &str, from: u64) -> Result<Opened, ModelError> {
            self.opens.borrow_mut().push(from);
            let start = if self.honour_range { from as usize } else { 0 };
            let body = self.body[start..].to_vec();
            let reader: Box<dyn Read + Send> = match self.fail_after {
                Some(limit) => Box::new(Flaky(Cursor::new(body), limit)),
                None => Box::new(Cursor::new(body)),
            };
            Ok(Opened {
                reader,
                resumed: self.honour_range && from > 0,
            })
        }
    }

    fn run(fake: &Fake, dir: &Path) -> Result<PathBuf, ModelError> {
        ensure(
            fake,
            &source(),
            dir,
            None,
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
    }

    #[test]
    fn the_pinned_model_matches_the_approved_file() {
        assert_eq!(PINNED.bytes, 492_381_880);
        assert_eq!(PINNED.sha256.len(), 64);
        assert!(PINNED
            .url
            .starts_with("https://huggingface.co/sprited/birefnet-toonout-onnx/"));
    }

    #[test]
    fn a_fresh_download_is_verified_then_renamed_into_place() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(true);
        let mut seen = Vec::new();
        let path = ensure(
            &fake,
            &source(),
            dir.path(),
            None,
            &AtomicBool::new(false),
            &mut |d, t| seen.push((d, t)),
        )
        .unwrap();
        assert_eq!(path, dir.path().join(FILE_NAME));
        assert_eq!(std::fs::read(&path).unwrap(), DATA);
        assert!(!part_path(dir.path(), FILE_NAME).exists());
        assert_eq!(seen.last(), Some(&(DATA.len() as u64, DATA.len() as u64)));
        // The second call finds the verified file and does not open a connection.
        run(&fake, dir.path()).unwrap();
        assert_eq!(fake.opens.borrow().len(), 1);
    }

    #[test]
    fn a_partial_download_resumes_from_where_it_stopped() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(part_path(dir.path(), FILE_NAME), &DATA[..10]).unwrap();
        let fake = Fake::new(true);
        run(&fake, dir.path()).unwrap();
        assert_eq!(*fake.opens.borrow(), vec![10]);
        assert_eq!(std::fs::read(dir.path().join(FILE_NAME)).unwrap(), DATA);
    }

    #[test]
    fn a_server_that_ignores_the_range_restarts_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(part_path(dir.path(), FILE_NAME), b"garbage!!!").unwrap();
        run(&Fake::new(false), dir.path()).unwrap();
        assert_eq!(std::fs::read(dir.path().join(FILE_NAME)).unwrap(), DATA);
    }

    #[test]
    fn a_wrong_hash_is_discarded_and_never_renamed() {
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(true);
        fake.body = b"pretend this is a 490 MB model!".to_vec()[..DATA.len()].to_vec();
        fake.body[0] = b'X';
        assert_eq!(run(&fake, dir.path()), Err(ModelError::Corrupt));
        assert!(!dir.path().join(FILE_NAME).exists());
        assert!(!part_path(dir.path(), FILE_NAME).exists());
    }

    #[test]
    fn a_body_longer_than_the_pinned_length_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(true);
        fake.body.extend_from_slice(b"extra");
        assert_eq!(run(&fake, dir.path()), Err(ModelError::Corrupt));
        assert!(!part_path(dir.path(), FILE_NAME).exists());
    }

    #[test]
    fn an_interrupted_download_keeps_its_part_for_the_next_run() {
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(true);
        fake.fail_after = Some(12);
        assert!(matches!(
            run(&fake, dir.path()),
            Err(ModelError::Network(_))
        ));
        assert_eq!(
            std::fs::metadata(part_path(dir.path(), FILE_NAME))
                .unwrap()
                .len(),
            12
        );
        assert!(!dir.path().join(FILE_NAME).exists());
        let healthy = Fake::new(true);
        run(&healthy, dir.path()).unwrap();
        assert_eq!(*healthy.opens.borrow(), vec![12]);
    }

    #[test]
    fn cancelling_stops_the_download_and_keeps_the_part() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(true);
        let result = ensure(
            &Fake::new(true),
            &source(),
            dir.path(),
            None,
            &cancel,
            &mut |_, _| {},
        );
        assert_eq!(result, Err(ModelError::Cancelled));
        assert!(!dir.path().join(FILE_NAME).exists());
    }

    #[test]
    fn a_wrong_file_under_the_final_name_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE_NAME), b"same length? no").unwrap();
        run(&Fake::new(true), dir.path()).unwrap();
        assert_eq!(std::fs::read(dir.path().join(FILE_NAME)).unwrap(), DATA);
    }

    #[test]
    fn the_override_is_verified_and_never_downloaded_or_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("dev.onnx");
        std::fs::write(&good, DATA).unwrap();
        let fake = Fake::new(true);
        let cancel = AtomicBool::new(false);
        let found = ensure(
            &fake,
            &source(),
            dir.path(),
            Some(good.clone()),
            &cancel,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(found, good);
        let bad = dir.path().join("bad.onnx");
        std::fs::write(&bad, b"nope").unwrap();
        let missing = dir.path().join("missing.onnx");
        for path in [bad.clone(), missing] {
            assert_eq!(
                ensure(
                    &fake,
                    &source(),
                    dir.path(),
                    Some(path),
                    &cancel,
                    &mut |_, _| {}
                ),
                Err(ModelError::BadOverride)
            );
        }
        assert!(fake.opens.borrow().is_empty());
        assert_eq!(std::fs::read(&bad).unwrap(), b"nope");
    }
}
