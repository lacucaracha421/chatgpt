use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use rusqlite::{params, OptionalExtension};
use serde::Deserialize;

use super::{
    error::LibraryError,
    models::VideoPreparationProgress,
    Library,
};

const MAX_SCRUB_FRAMES: u64 = 240;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct VideoProbe {
    pub(crate) container: String,
    pub(crate) video_codec: String,
    pub(crate) audio_codec: Option<String>,
    pub(crate) duration_ms: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Deserialize)]
struct ProbeOutput {
    streams: Vec<ProbeStream>,
    format: ProbeFormat,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: String,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Deserialize)]
struct ProbeFormat {
    format_name: String,
    duration: String,
}

pub(crate) trait VideoTool {
    fn probe(&self, source: &Path, extension: &str) -> Result<VideoProbe, LibraryError>;
    fn create_poster(&self, source: &Path, destination: &Path) -> Result<(), LibraryError>;
    fn create_scrub_frames(
        &self,
        source: &Path,
        timestamps_ms: &[u64],
        destination: &Path,
    ) -> Result<(), LibraryError>;
    fn create_proxy(&self, source: &Path, destination: &Path) -> Result<(), LibraryError>;
}

struct PendingVideo {
    asset_id: String,
    relative_path: String,
    duration_ms: u64,
    container: String,
    video_codec: String,
    audio_codec: Option<String>,
}

struct ProcessVideoTool;

pub(crate) fn probe_video(source: &Path, extension: &str) -> Result<VideoProbe, LibraryError> {
    ProcessVideoTool.probe(source, extension)
}

impl VideoTool for ProcessVideoTool {
    fn probe(&self, source: &Path, extension: &str) -> Result<VideoProbe, LibraryError> {
        let output = run_tool(
            "ffprobe",
            [
                "-v".into(),
                "error".into(),
                "-show_streams".into(),
                "-show_format".into(),
                "-of".into(),
                "json".into(),
                source.as_os_str().to_owned(),
            ],
        )?;
        let stdout = String::from_utf8(output).map_err(|_| LibraryError::VideoPreparationFailed)?;
        parse_probe(&stdout, extension)
    }

    fn create_poster(&self, source: &Path, destination: &Path) -> Result<(), LibraryError> {
        run_tool(
            "ffmpeg",
            [
                "-y".into(),
                "-v".into(),
                "error".into(),
                "-ss".into(),
                "0.5".into(),
                "-i".into(),
                source.as_os_str().to_owned(),
                "-frames:v".into(),
                "1".into(),
                "-vf".into(),
                "scale=640:640:force_original_aspect_ratio=decrease".into(),
                destination.as_os_str().to_owned(),
            ],
        )?;
        Ok(())
    }

    fn create_scrub_frames(
        &self,
        source: &Path,
        timestamps_ms: &[u64],
        destination: &Path,
    ) -> Result<(), LibraryError> {
        let first = timestamps_ms
            .first()
            .copied()
            .ok_or(LibraryError::VideoPreparationFailed)?;
        let count =
            u64::try_from(timestamps_ms.len()).map_err(|_| LibraryError::VideoPreparationFailed)?;
        let duration_ms = first
            .checked_mul(2)
            .and_then(|interval| interval.checked_mul(count))
            .ok_or(LibraryError::VideoPreparationFailed)?;
        fs::create_dir(destination).map_err(|_| LibraryError::VideoPreparationFailed)?;
        let output_pattern = destination.join("%03d.webp");
        run_tool(
            "ffmpeg",
            [
                "-y".into(),
                "-v".into(),
                "error".into(),
                "-i".into(),
                source.as_os_str().to_owned(),
                "-vf".into(),
                format!(
                    "fps={count}000/{duration_ms},scale=640:640:force_original_aspect_ratio=decrease"
                )
                .into(),
                "-frames:v".into(),
                count.to_string().into(),
                "-c:v".into(),
                "libwebp".into(),
                "-start_number".into(),
                "0".into(),
                output_pattern.as_os_str().to_owned(),
            ],
        )?;
        Ok(())
    }

    fn create_proxy(&self, source: &Path, destination: &Path) -> Result<(), LibraryError> {
        run_tool(
            "ffmpeg",
            [
                "-y".into(),
                "-v".into(),
                "error".into(),
                "-i".into(),
                source.as_os_str().to_owned(),
                "-vf".into(),
                "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30".into(),
                "-c:v".into(),
                "h264_mf".into(),
                "-pix_fmt".into(),
                "nv12".into(),
                "-c:a".into(),
                "aac".into(),
                "-movflags".into(),
                "+faststart".into(),
                destination.as_os_str().to_owned(),
            ],
        )?;
        Ok(())
    }
}

impl Library {
    pub fn prepare_pending_videos(
        &self,
        limit: u32,
    ) -> Result<VideoPreparationProgress, LibraryError> {
        self.prepare_pending_videos_with(&ProcessVideoTool, limit)
    }

    pub(crate) fn prepare_pending_videos_with<T: VideoTool>(
        &self,
        tool: &T,
        limit: u32,
    ) -> Result<VideoPreparationProgress, LibraryError> {
        let _guard = self
            .video_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut progress = VideoPreparationProgress {
            processed: 0,
            remaining: 0,
            failed: 0,
            changed_asset_ids: Vec::new(),
        };
        for _ in 0..limit.clamp(1, 10) {
            let Some(video) = self.reserve_pending_video()? else {
                break;
            };
            let asset_id = video.asset_id.clone();
            if self.prepare_video(tool, video).is_err() {
                self.mark_video_failed(&asset_id)?;
                progress.failed += 1;
            }
            progress.processed += 1;
            progress.changed_asset_ids.push(asset_id);
        }
        progress.remaining = u32::try_from(self.connection()?.query_row(
            "SELECT COUNT(*) FROM video_assets WHERE preparation_state = 'pending'",
            [],
            |row| row.get::<_, i64>(0),
        )?)
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
        Ok(progress)
    }

    pub fn retry_video_preparation(
        &self,
        asset_id: &str,
    ) -> Result<(), LibraryError> {
        let changed = self.connection()?.execute(
            "UPDATE video_assets
             SET preparation_state = 'pending', preparation_error = NULL
             WHERE asset_id = ?1 AND preparation_state = 'failed'
               AND EXISTS (
                 SELECT 1 FROM assets
                 WHERE assets.id = video_assets.asset_id AND assets.status = 'normal'
               )",
            [asset_id],
        )?;
        if changed == 0 {
            return Err(LibraryError::AssetNotFound);
        }
        Ok(())
    }

    pub(crate) fn requeue_interrupted_video_preparation(&self) -> Result<(), LibraryError> {
        let connection = self.connection()?;
        let candidates = connection
            .prepare(
                "SELECT asset_id, preparation_state, playback_kind, scrub_frame_count
                 FROM video_assets
                 WHERE preparation_state IN ('processing', 'ready')",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(connection);

        for (asset_id, state, playback_kind, scrub_frame_count) in candidates {
            let interrupted = state == "processing";
            let incomplete = state == "ready"
                && !self.video_derivatives_complete(
                    &asset_id,
                    playback_kind.as_deref(),
                    scrub_frame_count,
                );
            if !interrupted && !incomplete {
                continue;
            }
            self.remove_video_derivatives(&asset_id)?;
            let mut connection = self.connection()?;
            let transaction = connection.transaction()?;
            transaction.execute(
                "UPDATE assets SET thumbnail_relative_path = NULL WHERE id = ?1",
                [&asset_id],
            )?;
            transaction.execute(
                "UPDATE video_assets
                 SET preparation_state = 'pending', preparation_error = NULL,
                     playback_kind = NULL, poster_relative_path = NULL,
                     scrub_relative_dir = NULL, scrub_frame_count = 0,
                     proxy_relative_path = NULL
                 WHERE asset_id = ?1",
                [&asset_id],
            )?;
            transaction.commit()?;
        }
        Ok(())
    }

    fn video_derivatives_complete(
        &self,
        asset_id: &str,
        playback_kind: Option<&str>,
        scrub_frame_count: i64,
    ) -> bool {
        let Ok(scrub_frame_count) = u64::try_from(scrub_frame_count) else {
            return false;
        };
        if !safe_asset_id(asset_id) || !(1..=MAX_SCRUB_FRAMES).contains(&scrub_frame_count) {
            return false;
        }
        let directory = self.root().join("video-media").join(asset_id);
        if require_non_empty_file(&directory.join("poster.webp")).is_err() {
            return false;
        }
        if (0..scrub_frame_count).any(|index| {
            require_non_empty_file(&directory.join("scrub").join(format!("{index:03}.webp")))
                .is_err()
        }) {
            return false;
        }
        match playback_kind {
            Some("original") => true,
            Some("proxy") => require_non_empty_file(&directory.join("playback.mp4")).is_ok(),
            _ => false,
        }
    }

    fn remove_video_derivatives(&self, asset_id: &str) -> Result<(), LibraryError> {
        if !safe_asset_id(asset_id) {
            return Err(LibraryError::UnsafeMediaPath);
        }
        let directory = self.root().join("video-media").join(asset_id);
        let metadata = match fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(LibraryError::UnsafeMediaPath),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(LibraryError::UnsafeMediaPath);
        }
        let canonical_root =
            fs::canonicalize(self.root()).map_err(|_| LibraryError::UnsafeMediaPath)?;
        let canonical_directory =
            fs::canonicalize(&directory).map_err(|_| LibraryError::UnsafeMediaPath)?;
        if canonical_directory == canonical_root
            || !canonical_directory.starts_with(&canonical_root)
        {
            return Err(LibraryError::UnsafeMediaPath);
        }
        fs::remove_dir_all(canonical_directory).map_err(|_| LibraryError::VideoPreparationFailed)
    }

    fn reserve_pending_video(&self) -> Result<Option<PendingVideo>, LibraryError> {
        self.connection()?
            .query_row(
                "UPDATE video_assets
                 SET preparation_state = 'processing'
                 WHERE asset_id = (
                    SELECT video_assets.asset_id FROM video_assets
                    JOIN assets ON assets.id = video_assets.asset_id
                    WHERE video_assets.preparation_state = 'pending'
                      AND assets.status = 'normal'
                    ORDER BY video_assets.asset_id LIMIT 1
                 )
                 RETURNING asset_id, duration_ms, container, video_codec, audio_codec,
                    (SELECT relative_path FROM assets WHERE assets.id = video_assets.asset_id)",
                [],
                |row| {
                    Ok(PendingVideo {
                        asset_id: row.get(0)?,
                        duration_ms: u64::try_from(row.get::<_, i64>(1)?)
                            .map_err(|_| rusqlite::Error::InvalidQuery)?,
                        container: row.get(2)?,
                        video_codec: row.get(3)?,
                        audio_codec: row.get(4)?,
                        relative_path: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    fn prepare_video<T: VideoTool>(
        &self,
        tool: &T,
        video: PendingVideo,
    ) -> Result<(), LibraryError> {
        if !safe_asset_id(&video.asset_id) {
            return Err(LibraryError::VideoPreparationFailed);
        }
        let source = self.root().join(&video.relative_path);
        if !source.is_file() {
            return Err(LibraryError::VideoPreparationFailed);
        }
        let pending = self
            .root()
            .join("video-media")
            .join(format!(".pending-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&pending).map_err(|_| LibraryError::VideoPreparationFailed)?;
        let prepared = (|| {
            let poster = pending.join("poster.webp");
            tool.create_poster(&source, &poster)?;
            let timestamps = scrub_timestamps_ms(video.duration_ms);
            let scrub = pending.join("scrub");
            tool.create_scrub_frames(&source, &timestamps, &scrub)?;
            let playback_kind = if direct_playback(
                &video.container,
                &video.video_codec,
                video.audio_codec.as_deref(),
            ) {
                "original"
            } else {
                tool.create_proxy(&source, &pending.join("playback.mp4"))?;
                "proxy"
            };
            require_non_empty_file(&poster)?;
            for index in 0..timestamps.len() {
                require_non_empty_file(&scrub.join(format!("{index:03}.webp")))?;
            }
            if playback_kind == "proxy" {
                require_non_empty_file(&pending.join("playback.mp4"))?;
            }
            Ok::<_, LibraryError>((playback_kind, timestamps.len()))
        })();
        let (playback_kind, scrub_frame_count) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                let _ = fs::remove_dir_all(&pending);
                return Err(error);
            }
        };
        let final_directory = self.root().join("video-media").join(&video.asset_id);
        if final_directory.exists() {
            fs::remove_dir_all(&pending).map_err(|_| LibraryError::VideoPreparationFailed)?;
            return Err(LibraryError::VideoPreparationFailed);
        }
        fs::rename(&pending, &final_directory).map_err(|_| LibraryError::VideoPreparationFailed)?;
        let poster_relative_path = format!("video-media/{}/poster.webp", video.asset_id);
        let scrub_relative_dir = format!("video-media/{}/scrub", video.asset_id);
        let proxy_relative_path = (playback_kind == "proxy")
            .then(|| format!("video-media/{}/playback.mp4", video.asset_id));
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE assets SET thumbnail_relative_path = ?2 WHERE id = ?1",
            params![video.asset_id, poster_relative_path],
        )?;
        transaction.execute(
            "UPDATE video_assets
             SET preparation_state = 'ready', preparation_error = NULL,
                 playback_kind = ?2, poster_relative_path = ?3, scrub_relative_dir = ?4,
                 scrub_frame_count = ?5, proxy_relative_path = ?6
             WHERE asset_id = ?1",
            params![
                video.asset_id,
                playback_kind,
                poster_relative_path,
                scrub_relative_dir,
                i64::try_from(scrub_frame_count).map_err(|_| rusqlite::Error::InvalidQuery)?,
                proxy_relative_path
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn mark_video_failed(&self, asset_id: &str) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "UPDATE video_assets
             SET preparation_state = 'failed', preparation_error = 'video_preparation_failed'
             WHERE asset_id = ?1",
            [asset_id],
        )?;
        Ok(())
    }
}

fn safe_asset_id(asset_id: &str) -> bool {
    !asset_id.is_empty()
        && asset_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn run_tool<const N: usize>(name: &str, arguments: [OsString; N]) -> Result<Vec<u8>, LibraryError> {
    let executable = tool_path(name).ok_or(LibraryError::VideoToolUnavailable)?;
    let output = Command::new(executable)
        .args(arguments)
        .output()
        .map_err(|_| LibraryError::VideoToolUnavailable)?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(LibraryError::VideoPreparationFailed)
    }
}

fn tool_path(name: &str) -> Option<PathBuf> {
    let executable_name = format!("{name}.exe");
    let current_executable = std::env::current_exe().ok();
    let bundled = current_executable
        .as_deref()
        .and_then(Path::parent)
        .map(|directory| directory.join(&executable_name));
    let test_bundle = current_executable
        .as_deref()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(|directory| directory.join(&executable_name));
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}-x86_64-pc-windows-msvc.exe"));
    [bundled, test_bundle, Some(source)]
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
}

fn require_non_empty_file(path: &Path) -> Result<(), LibraryError> {
    if path
        .metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
    {
        Ok(())
    } else {
        Err(LibraryError::VideoPreparationFailed)
    }
}

fn direct_playback(container: &str, video_codec: &str, audio_codec: Option<&str>) -> bool {
    match (container, video_codec) {
        ("mp4" | "mov", "h264") => matches!(audio_codec, None | Some("aac" | "mp3")),
        ("webm", "vp8" | "vp9" | "av1") => {
            matches!(audio_codec, None | Some("opus" | "vorbis"))
        }
        _ => false,
    }
}

fn scrub_timestamps_ms(duration_ms: u64) -> Vec<u64> {
    let count = duration_ms.div_ceil(1_000).clamp(1, MAX_SCRUB_FRAMES);
    (0..count)
        .map(|index| ((index * 2 + 1) * duration_ms) / (count * 2))
        .collect()
}

pub(crate) fn parse_probe(json: &str, extension: &str) -> Result<VideoProbe, LibraryError> {
    let output: ProbeOutput =
        serde_json::from_str(json).map_err(|_| LibraryError::UnsupportedVideo)?;
    let container = extension.to_ascii_lowercase();
    let format_matches = match container.as_str() {
        "mp4" | "mov" => output
            .format
            .format_name
            .split(',')
            .any(|name| name == "mov"),
        "webm" => output
            .format
            .format_name
            .split(',')
            .any(|name| name == "webm"),
        _ => false,
    };
    if !format_matches {
        return Err(LibraryError::UnsupportedVideo);
    }
    let video = output
        .streams
        .iter()
        .find(|stream| stream.codec_type == "video")
        .ok_or(LibraryError::UnsupportedVideo)?;
    let video_codec = video
        .codec_name
        .clone()
        .ok_or(LibraryError::UnsupportedVideo)?;
    let width = video
        .width
        .filter(|value| *value > 0)
        .ok_or(LibraryError::UnsupportedVideo)?;
    let height = video
        .height
        .filter(|value| *value > 0)
        .ok_or(LibraryError::UnsupportedVideo)?;
    let duration_seconds = output
        .format
        .duration
        .parse::<f64>()
        .map_err(|_| LibraryError::UnsupportedVideo)?;
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Err(LibraryError::UnsupportedVideo);
    }
    let audio_codec = output
        .streams
        .iter()
        .find(|stream| stream.codec_type == "audio")
        .and_then(|stream| stream.codec_name.clone());
    Ok(VideoProbe {
        container,
        video_codec,
        audio_codec,
        duration_ms: (duration_seconds * 1_000.0).round() as u64,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::Path,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use rusqlite::params;

    use super::{direct_playback, parse_probe, scrub_timestamps_ms, VideoProbe, VideoTool};
    use crate::library::{error::LibraryError, models::MediaSummary, Library};

    #[derive(Default)]
    struct FakeVideoTool {
        proxy_calls: AtomicUsize,
    }

    struct FailingVideoTool;

    impl VideoTool for FakeVideoTool {
        fn probe(&self, _source: &Path, _extension: &str) -> Result<VideoProbe, LibraryError> {
            unreachable!("preparation uses persisted probe metadata")
        }

        fn create_poster(&self, _source: &Path, destination: &Path) -> Result<(), LibraryError> {
            fs::write(destination, b"poster").map_err(|_| LibraryError::VideoPreparationFailed)
        }

        fn create_scrub_frames(
            &self,
            _source: &Path,
            timestamps_ms: &[u64],
            destination: &Path,
        ) -> Result<(), LibraryError> {
            fs::create_dir(destination).map_err(|_| LibraryError::VideoPreparationFailed)?;
            for (index, timestamp) in timestamps_ms.iter().enumerate() {
                fs::write(
                    destination.join(format!("{index:03}.webp")),
                    timestamp.to_string(),
                )
                .map_err(|_| LibraryError::VideoPreparationFailed)?;
            }
            Ok(())
        }

        fn create_proxy(&self, _source: &Path, destination: &Path) -> Result<(), LibraryError> {
            self.proxy_calls.fetch_add(1, Ordering::SeqCst);
            fs::write(destination, b"proxy").map_err(|_| LibraryError::VideoPreparationFailed)
        }
    }

    impl VideoTool for FailingVideoTool {
        fn probe(&self, _source: &Path, _extension: &str) -> Result<VideoProbe, LibraryError> {
            Err(LibraryError::VideoPreparationFailed)
        }

        fn create_poster(&self, _source: &Path, _destination: &Path) -> Result<(), LibraryError> {
            Err(LibraryError::VideoPreparationFailed)
        }

        fn create_scrub_frames(
            &self,
            _source: &Path,
            _timestamps_ms: &[u64],
            _destination: &Path,
        ) -> Result<(), LibraryError> {
            unreachable!()
        }

        fn create_proxy(&self, _source: &Path, _destination: &Path) -> Result<(), LibraryError> {
            unreachable!()
        }
    }

    #[test]
    fn webm_vp9_opus_and_mp4_h264_aac_use_original_playback() {
        assert!(direct_playback("webm", "vp9", Some("opus")));
        assert!(direct_playback("mp4", "h264", Some("aac")));
        assert!(direct_playback("mov", "h264", None));
    }

    #[test]
    fn prores_hevc_and_incompatible_audio_use_proxy_playback() {
        assert!(!direct_playback("mov", "prores", Some("pcm_s16le")));
        assert!(!direct_playback("mp4", "hevc", Some("aac")));
        assert!(!direct_playback("webm", "vp9", Some("aac")));
    }

    #[test]
    fn scrub_plan_uses_one_frame_per_second_up_to_two_hundred_forty() {
        let short = scrub_timestamps_ms(20_000);
        assert_eq!(short.len(), 20);
        assert_eq!(short.first(), Some(&500));
        assert_eq!(short.last(), Some(&19_500));

        let long = scrub_timestamps_ms(3_600_000);
        assert_eq!(long.len(), 240);
        assert_eq!(long.first(), Some(&7_500));
        assert_eq!(long.last(), Some(&3_592_500));
    }

    #[test]
    fn ffprobe_json_is_normalized_to_video_metadata() {
        let json = r#"{
            "streams": [
                {"codec_type":"video","codec_name":"vp9","width":1920,"height":1080},
                {"codec_type":"audio","codec_name":"opus"}
            ],
            "format": {"format_name":"matroska,webm","duration":"65.432"}
        }"#;

        let probe = parse_probe(json, "webm").unwrap();

        assert_eq!(probe.container, "webm");
        assert_eq!(probe.video_codec, "vp9");
        assert_eq!(probe.audio_codec.as_deref(), Some("opus"));
        assert_eq!(probe.duration_ms, 65_432);
        assert_eq!((probe.width, probe.height), (1920, 1080));
    }

    #[test]
    fn ffprobe_json_rejects_missing_video_or_invalid_duration() {
        let audio_only = r#"{
            "streams": [{"codec_type":"audio","codec_name":"aac"}],
            "format": {"format_name":"mov,mp4","duration":"10.0"}
        }"#;
        let zero_duration = r#"{
            "streams": [{"codec_type":"video","codec_name":"h264","width":10,"height":10}],
            "format": {"format_name":"mov,mp4","duration":"0"}
        }"#;

        assert!(parse_probe(audio_only, "mp4").is_err());
        assert!(parse_probe(zero_duration, "mp4").is_err());
        assert!(parse_probe(zero_duration, "mkv").is_err());
    }

    #[test]
    fn preparation_installs_complete_outputs_before_marking_ready() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_pending_video(&library, "video-1", "mp4", "h264", Some("aac"), 2_000);
        let tool = FakeVideoTool::default();

        let progress = library.prepare_pending_videos_with(&tool, 1).unwrap();

        assert_eq!(progress.processed, 1);
        assert_eq!(progress.remaining, 0);
        assert_eq!(progress.failed, 0);
        assert_eq!(progress.changed_asset_ids, vec!["video-1"]);
        assert_eq!(tool.proxy_calls.load(Ordering::SeqCst), 0);
        let asset = library.get_asset("video-1").unwrap();
        assert!(matches!(
            asset.media,
            MediaSummary::Video {
                preparation_state: crate::library::models::VideoPreparationState::Ready,
                scrub_frame_count: 2,
                ..
            }
        ));
        assert_eq!(
            asset.thumbnail_relative_path.as_deref(),
            Some("video-media/video-1/poster.webp")
        );
        assert!(library
            .root()
            .join("video-media/video-1/poster.webp")
            .is_file());
        assert!(library
            .root()
            .join("video-media/video-1/scrub/000.webp")
            .is_file());
        assert!(library
            .root()
            .join("video-media/video-1/scrub/001.webp")
            .is_file());
        assert!(!library
            .root()
            .join("video-media/video-1/playback.mp4")
            .exists());
    }

    #[test]
    fn incompatible_video_creates_a_proxy_before_marking_ready() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_pending_video(
            &library,
            "video-1",
            "mov",
            "prores",
            Some("pcm_s16le"),
            1_000,
        );
        let tool = FakeVideoTool::default();

        let progress = library.prepare_pending_videos_with(&tool, 1).unwrap();

        assert_eq!(progress.failed, 0);
        assert_eq!(tool.proxy_calls.load(Ordering::SeqCst), 1);
        assert!(library
            .root()
            .join("video-media/video-1/playback.mp4")
            .is_file());
        let playback_kind: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT playback_kind FROM video_assets WHERE asset_id = 'video-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(playback_kind, "proxy");
    }

    #[test]
    fn failed_video_waits_for_explicit_retry() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_pending_video(&library, "video-1", "mp4", "h264", Some("aac"), 1_000);

        let failed = library
            .prepare_pending_videos_with(&FailingVideoTool, 1)
            .unwrap();
        let repeated = library
            .prepare_pending_videos_with(&FailingVideoTool, 1)
            .unwrap();

        assert_eq!((failed.processed, failed.failed), (1, 1));
        assert_eq!((repeated.processed, repeated.remaining), (0, 0));
        library.retry_video_preparation("video-1").unwrap();
        let recovered = library
            .prepare_pending_videos_with(&FakeVideoTool::default(), 1)
            .unwrap();
        assert_eq!((recovered.processed, recovered.failed), (1, 0));
    }

    #[test]
    fn interrupted_processing_is_requeued_when_library_opens() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_pending_video(&library, "video-1", "mp4", "h264", Some("aac"), 1_000);
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE video_assets SET preparation_state = 'processing' WHERE asset_id = 'video-1'",
                [],
            )
            .unwrap();
        drop(library);

        let reopened = Library::open(temp.path()).unwrap();
        let state: String = reopened
            .connection()
            .unwrap()
            .query_row(
                "SELECT preparation_state FROM video_assets WHERE asset_id = 'video-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(state, "pending");
    }

    fn insert_pending_video(
        library: &Library,
        asset_id: &str,
        container: &str,
        video_codec: &str,
        audio_codec: Option<&str>,
        duration_ms: u64,
    ) {
        let source_relative_path = format!("assets/vi/{asset_id}.{container}");
        let source_path = library.root().join(&source_relative_path);
        fs::create_dir_all(source_path.parent().unwrap()).unwrap();
        fs::write(source_path, b"original").unwrap();
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (?1, ?2, 'video', ?3, ?4, NULL, 8, 1920, 1080,
                    '2026-08-09T00:00:00Z')",
                params![
                    asset_id,
                    format!("hash-{asset_id}"),
                    asset_id,
                    source_relative_path
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO video_assets (
                    asset_id, duration_ms, container, video_codec, audio_codec,
                    preparation_state, scrub_frame_count
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0)",
                params![
                    asset_id,
                    i64::try_from(duration_ms).unwrap(),
                    container,
                    video_codec,
                    audio_codec
                ],
            )
            .unwrap();
    }
}
