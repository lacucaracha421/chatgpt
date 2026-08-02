# Korean Subtitle English Dub Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Windows GUI that combines the video from a Korean hard-subtitled YouTube upload with the audio from its English-dubbed counterpart.

**Architecture:** A small Tkinter application sends one `JobRequest` to a background workflow. The workflow validates inputs, prepares pinned `yt-dlp`, FFmpeg, and Deno binaries under Local AppData, downloads one video stream and one audio stream, then asks FFmpeg to mux them into a temporary MP4 before atomically moving the verified result.

**Tech Stack:** Python 3.12+, Tkinter and Python standard library at runtime, pytest for tests, PyInstaller for a single-file Windows executable, pinned yt-dlp 2026.06.09, FFmpeg 8.1.2 essentials build, and Deno 2.8.1.

## Global Constraints

- The tool is independent of Lakomics and lives under `tools/video-dub-tool/`.
- The UI and user-facing errors are Korean.
- The output is MP4; the video stream is copied without re-encoding when MP4-compatible.
- Only the audio is converted to AAC when its source codec is not MP4-compatible.
- Positive offset delays English audio; negative offset trims its beginning.
- Duration difference is `PROCEED` at at most 2 seconds, `WARN` above 2 through 10 seconds, and `BLOCK` above 10 seconds.
- Existing output files are never overwritten.
- Incomplete work stays in a unique temporary directory and is removed on success, failure, or cancellation.
- One job runs at a time.
- No account bypass, region bypass, DRM bypass, cookie extraction, subtitle extraction, or edit-sequence auto-alignment is implemented.
- Runtime dependencies are Python standard library only; do not add a GUI framework or media Python package.

---

## File Map

- `tools/video-dub-tool/pyproject.toml`: package metadata and development-only dependencies.
- `tools/video-dub-tool/src/video_dub_tool/workflow.py`: request validation, duration policy, download/mux orchestration, and workflow errors.
- `tools/video-dub-tool/src/video_dub_tool/tools.py`: pinned tool manifest, verified installation, and cancellable subprocess execution.
- `tools/video-dub-tool/src/video_dub_tool/media.py`: yt-dlp/FFmpeg argument construction and ffprobe result parsing.
- `tools/video-dub-tool/src/video_dub_tool/app.py`: Tkinter widgets and thread-safe UI state.
- `tools/video-dub-tool/src/video_dub_tool/__main__.py`: application entry point.
- `tools/video-dub-tool/tests/`: focused unit and local-media integration tests.
- `tools/video-dub-tool/build.ps1`: clean test and PyInstaller build command.
- `tools/video-dub-tool/README.md`: user instructions and known limits.
- `tools/video-dub-tool/THIRD_PARTY_NOTICES.md`: dependency sources and license links.

### Task 1: Request Validation and Duration Policy

**Files:**
- Create: `tools/video-dub-tool/pyproject.toml`
- Create: `tools/video-dub-tool/src/video_dub_tool/__init__.py`
- Create: `tools/video-dub-tool/src/video_dub_tool/workflow.py`
- Create: `tools/video-dub-tool/tests/test_workflow.py`

**Interfaces:**
- Produces: `JobRequest(korean_url: str, english_url: str, output_path: Path, offset_seconds: float)`
- Produces: `validate_request(request: JobRequest) -> None`
- Produces: `DurationAction` with `PROCEED`, `WARN`, and `BLOCK`
- Produces: `DurationAssessment(action: DurationAction, difference_seconds: float, english_end_seconds: float)`
- Produces: `assess_duration(korean_duration: float, english_duration: float, offset_seconds: float) -> DurationAssessment`
- Produces: `ValidationError` carrying a Korean user-facing message

- [ ] **Step 1: Create package metadata and write failing validation tests**

```toml
[build-system]
requires = ["setuptools>=77"]
build-backend = "setuptools.build_meta"

[project]
name = "video-dub-tool"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = []

[project.optional-dependencies]
dev = ["pytest>=8.4,<9", "pyinstaller>=6.15,<7"]

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
markers = ["integration: uses locally installed FFmpeg binaries"]
```

```python
def test_rejects_existing_output(tmp_path):
    output = tmp_path / "result.mp4"
    output.write_bytes(b"existing")
    request = JobRequest(
        "https://youtube.com/watch?v=korean",
        "https://youtube.com/watch?v=english",
        output,
        0.0,
    )
    with pytest.raises(ValidationError, match="이미 존재"):
        validate_request(request)


@pytest.mark.parametrize("value", ["nan", "inf", "-inf"])
def test_rejects_non_finite_offset(tmp_path, value):
    request = JobRequest(
        "https://youtube.com/watch?v=korean",
        "https://youtube.com/watch?v=english",
        tmp_path / "result.mp4",
        float(value),
    )
    with pytest.raises(ValidationError, match="유한한 숫자"):
        validate_request(request)
```

- [ ] **Step 2: Run validation tests and verify RED**

Run: `python -m pytest tests/test_workflow.py -v`

Expected: collection fails because `video_dub_tool.workflow` does not exist.

- [ ] **Step 3: Implement the request type and validation**

```python
@dataclass(frozen=True)
class JobRequest:
    korean_url: str
    english_url: str
    output_path: Path
    offset_seconds: float = 0.0


def validate_request(request: JobRequest) -> None:
    for label, value in (("한글 영상", request.korean_url), ("영어 영상", request.english_url)):
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValidationError(f"{label} URL이 올바르지 않습니다.")
    if request.output_path.suffix.lower() != ".mp4":
        raise ValidationError("결과 파일은 .mp4여야 합니다.")
    if not math.isfinite(request.offset_seconds):
        raise ValidationError("오디오 오프셋은 유한한 숫자여야 합니다.")
    if request.output_path.exists():
        raise ValidationError("결과 파일이 이미 존재합니다. 다른 이름을 선택하세요.")
```

- [ ] **Step 4: Run validation tests and verify GREEN**

Run: `python -m pytest tests/test_workflow.py -v`

Expected: all validation tests pass.

- [ ] **Step 5: Write failing duration-policy tests**

```python
@pytest.mark.parametrize(
    ("korean", "english", "offset", "expected"),
    [
        (390.0, 390.0, 0.0, DurationAction.PROCEED),
        (390.0, 387.0, 0.0, DurationAction.WARN),
        (390.0, 379.0, 0.0, DurationAction.BLOCK),
        (390.0, 385.0, 5.0, DurationAction.PROCEED),
        (390.0, 395.0, -5.0, DurationAction.PROCEED),
    ],
)
def test_duration_policy(korean, english, offset, expected):
    assert assess_duration(korean, english, offset).action is expected
```

- [ ] **Step 6: Run the duration test and verify RED**

Run: `python -m pytest tests/test_workflow.py::test_duration_policy -v`

Expected: FAIL because `assess_duration` is not defined.

- [ ] **Step 7: Implement the duration policy**

```python
def assess_duration(
    korean_duration: float,
    english_duration: float,
    offset_seconds: float,
) -> DurationAssessment:
    english_end = max(0.0, english_duration + offset_seconds)
    difference = abs(korean_duration - english_end)
    action = (
        DurationAction.PROCEED
        if difference <= 2.0
        else DurationAction.WARN
        if difference <= 10.0
        else DurationAction.BLOCK
    )
    return DurationAssessment(action, difference, english_end)
```

- [ ] **Step 8: Run Task 1 tests and commit**

Run: `python -m pytest tests/test_workflow.py -v`

Expected: PASS.

```powershell
git add tools/video-dub-tool
git commit -m "feat: validate video dub jobs"
```

### Task 2: Verified Runtime Tool Installation

**Files:**
- Create: `tools/video-dub-tool/src/video_dub_tool/tools.py`
- Create: `tools/video-dub-tool/tests/test_tools.py`

**Interfaces:**
- Produces: `ToolSpec(name: str, version: str, url: str, sha256: str, members: Sequence[tuple[str, str]])`
- Produces: `ToolPaths(yt_dlp: Path, ffmpeg: Path, ffprobe: Path, deno: Path)`
- Produces: `install_tool(spec: ToolSpec, root: Path, download: Download = download_file) -> Sequence[Path]`
- Produces: `ensure_tools(root: Path | None = None) -> ToolPaths`
- Produces: `CommandRunner.run(args: Sequence[str], cancel: Event, emit: Callable[[str], None]) -> str`
- Produces: `ToolInstallError`, `CommandFailed`, and `JobCancelled`

- [ ] **Step 1: Write failing checksum and archive-extraction tests**

```python
def test_install_tool_rejects_wrong_checksum(tmp_path):
    spec = ToolSpec("demo", "1", "https://example.invalid/demo", "0" * 64, ())
    with pytest.raises(ToolInstallError, match="무결성"):
        install_tool(spec, tmp_path, lambda _url, path: path.write_bytes(b"bad"))


def test_install_tool_installs_direct_executable(tmp_path):
    digest = hashlib.sha256(b"exe").hexdigest()
    spec = ToolSpec("demo", "1", "https://example.invalid/demo.exe", digest, ())
    paths = install_tool(spec, tmp_path, lambda _url, path: path.write_bytes(b"exe"))
    assert paths == (tmp_path / "demo-1" / "demo.exe",)
    assert paths[0].read_bytes() == b"exe"


def test_install_tool_extracts_only_declared_member(tmp_path):
    archive = tmp_path / "source.zip"
    with ZipFile(archive, "w") as zip_file:
        zip_file.writestr("package/bin/ffmpeg.exe", b"ffmpeg")
        zip_file.writestr("../../escape.exe", b"escape")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    spec = ToolSpec(
        "ffmpeg",
        "test",
        "https://example.invalid/ffmpeg.zip",
        digest,
        (("/bin/ffmpeg.exe", "ffmpeg.exe"),),
    )
    paths = install_tool(spec, tmp_path / "tools", lambda _url, path: shutil.copy2(archive, path))
    assert paths[0].read_bytes() == b"ffmpeg"
    assert not (tmp_path / "escape.exe").exists()
```

- [ ] **Step 2: Run installer tests and verify RED**

Run: `python -m pytest tests/test_tools.py -v`

Expected: collection fails because `video_dub_tool.tools` does not exist.

- [ ] **Step 3: Implement streaming download, SHA-256 verification, and declared-member extraction**

```python
def install_tool(spec: ToolSpec, root: Path, download: Download = download_file) -> Sequence[Path]:
    version_dir = root / f"{spec.name}-{spec.version}"
    output_names = [output_name for _suffix, output_name in spec.members] or [f"{spec.name}.exe"]
    outputs = tuple(version_dir / output_name for output_name in output_names)
    if all(path.is_file() for path in outputs):
        return outputs
    root.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=root) as temporary:
        package = Path(temporary) / "package"
        download(spec.url, package)
        if file_sha256(package) != spec.sha256:
            raise ToolInstallError(f"{spec.name} 다운로드 무결성 확인에 실패했습니다.")
        staging = Path(temporary) / "staging"
        staging.mkdir()
        if spec.members:
            with ZipFile(package) as archive:
                for suffix, output_name in spec.members:
                    matches = [name for name in archive.namelist() if name.endswith(suffix)]
                    if len(matches) != 1:
                        raise ToolInstallError(f"{spec.name} 압축 파일 구성이 올바르지 않습니다.")
                    with archive.open(matches[0]) as source, (staging / output_name).open("wb") as target:
                        shutil.copyfileobj(source, target)
        else:
            shutil.copy2(package, staging / f"{spec.name}.exe")
        staging.replace(version_dir)
    return tuple(version_dir / output_name for _suffix, output_name in spec.members)
```

- [ ] **Step 4: Add the exact pinned Windows x64 manifest**

```python
YT_DLP = ToolSpec(
    "yt-dlp",
    "2026.06.09",
    "https://github.com/yt-dlp/yt-dlp/releases/download/2026.06.09/yt-dlp.exe",
    "3a48cb955d55c8821b60ccbdbbc6f61bc958f2f3d3b7ad5eaf3d83a543293a27",
    (),
)
FFMPEG = ToolSpec(
    "ffmpeg",
    "8.1.2",
    "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip",
    "db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec",
    (("/bin/ffmpeg.exe", "ffmpeg.exe"), ("/bin/ffprobe.exe", "ffprobe.exe")),
)
DENO = ToolSpec(
    "deno",
    "2.8.1",
    "https://github.com/denoland/deno/releases/download/v2.8.1/deno-x86_64-pc-windows-msvc.zip",
    "5fb5bac71f609fb91ec8960fb290885aadc27eeb22f07a8eca0c3db6be38b11a",
    (("deno.exe", "deno.exe"),),
)
```

- [ ] **Step 5: Write a failing cancellation test for the subprocess runner**

```python
def test_command_runner_cancels_process(tmp_path):
    cancel = Event()
    cancel.set()
    with pytest.raises(JobCancelled):
        CommandRunner().run(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            cancel,
            lambda _line: None,
        )
```

- [ ] **Step 6: Run the cancellation test and verify RED**

Run: `python -m pytest tests/test_tools.py::test_command_runner_cancels_process -v`

Expected: FAIL because `CommandRunner` is not implemented.

- [ ] **Step 7: Implement cancellable hidden subprocess execution**

```python
class CommandRunner:
    def run(self, args: Sequence[str], cancel: Event, emit: Callable[[str], None]) -> str:
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        process = subprocess.Popen(
            list(args),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creationflags,
        )
        lines: Queue[str | None] = Queue()
        reader = Thread(target=_read_lines, args=(process.stdout, lines), daemon=True)
        reader.start()
        output: list[str] = []
        while process.poll() is None or not lines.empty():
            if cancel.is_set():
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                raise JobCancelled("작업을 취소했습니다.")
            try:
                line = lines.get(timeout=0.1)
            except Empty:
                continue
            if line is not None:
                output.append(line)
                emit(line.rstrip())
        if process.returncode:
            raise CommandFailed(args[0], process.returncode, "".join(output))
        return "".join(output)
```

- [ ] **Step 8: Run Task 2 tests and commit**

Run: `python -m pytest tests/test_tools.py -v`

Expected: PASS.

```powershell
git add tools/video-dub-tool
git commit -m "feat: prepare verified media tools"
```

### Task 3: Media Commands and Result Verification

**Files:**
- Create: `tools/video-dub-tool/src/video_dub_tool/media.py`
- Create: `tools/video-dub-tool/tests/test_media.py`

**Interfaces:**
- Produces: `VideoMetadata(title: str, duration: float)`
- Produces: `metadata_command(yt_dlp: Path, deno: Path, ffmpeg: Path, url: str) -> list[str]`
- Produces: `download_video_command(yt_dlp: Path, deno: Path, ffmpeg: Path, url: str, output_template: Path) -> list[str]`
- Produces: `download_audio_command(yt_dlp: Path, deno: Path, ffmpeg: Path, url: str, output_template: Path) -> list[str]`
- Produces: `parse_metadata(output: str) -> VideoMetadata`
- Produces: `probe_audio_codec(ffprobe: Path, audio: Path, cancel: Event, runner: CommandRunner) -> str`
- Produces: `mux_command(ffmpeg: Path, video: Path, audio: Path, output: Path, offset_seconds: float, duration_seconds: float, audio_codec: str) -> list[str]`
- Produces: `verify_output(ffprobe: Path, output: Path, cancel: Event, runner: CommandRunner) -> None`

- [ ] **Step 1: Write failing command-construction tests**

```python
def test_positive_offset_delays_audio():
    command = mux_command(Path("ffmpeg"), Path("video.mp4"), Path("audio.webm"), Path("out.mp4"), 1.5, 390.0, "opus")
    assert command[command.index("-itsoffset") + 1] == "1.5"
    assert command[command.index("-t") + 1] == "390"
    assert command[command.index("-c:v") + 1] == "copy"
    assert command[command.index("-c:a") + 1] == "aac"


def test_negative_offset_trims_audio():
    command = mux_command(Path("ffmpeg"), Path("video.mp4"), Path("audio.m4a"), Path("out.mp4"), -2.25, 390.0, "aac")
    assert command[command.index("-ss") + 1] == "2.25"
    assert command[command.index("-c:a") + 1] == "copy"


def test_ytdlp_commands_supply_deno_and_disable_playlists():
    command = metadata_command(Path("yt-dlp"), Path("deno"), Path("ffmpeg"), "https://youtu.be/id")
    assert ["--js-runtimes", "deno:deno"] == command[1:3]
    assert ["--ffmpeg-location", "."] == command[3:5]
    assert "--no-playlist" in command
```

- [ ] **Step 2: Run media tests and verify RED**

Run: `python -m pytest tests/test_media.py -v`

Expected: collection fails because `video_dub_tool.media` does not exist.

- [ ] **Step 3: Implement yt-dlp and mux command builders**

```python
def mux_command(ffmpeg, video, audio, output, offset_seconds, duration_seconds, audio_codec):
    command = [str(ffmpeg), "-hide_banner", "-nostdin", "-i", str(video)]
    if offset_seconds > 0:
        command += ["-itsoffset", format_seconds(offset_seconds), "-i", str(audio)]
    elif offset_seconds < 0:
        command += ["-ss", format_seconds(-offset_seconds), "-i", str(audio)]
    else:
        command += ["-i", str(audio)]
    audio_args = ["-c:a", "copy"] if audio_codec in {"aac", "mp3"} else ["-c:a", "aac", "-b:a", "192k"]
    return command + [
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", *audio_args,
        "-t", format_seconds(duration_seconds), "-movflags", "+faststart", str(output),
    ]
```

Use `--dump-single-json --skip-download --no-playlist --no-warnings` for metadata, `bestvideo[ext=mp4]/bestvideo` for the Korean stream, and `bestaudio` for the English stream. Every yt-dlp command must include `--js-runtimes deno:<absolute deno path>`, `--ffmpeg-location <absolute ffmpeg directory>`, `--newline`, and `--no-playlist`.

- [ ] **Step 4: Write failing metadata and probe-verification tests**

```python
def test_parse_metadata_requires_positive_duration():
    with pytest.raises(MediaError, match="재생 시간"):
        parse_metadata('{"title":"bad","duration":0}')


class StubRunner:
    def __init__(self, output: str):
        self.output = output

    def run(self, _args, _cancel, _emit):
        return self.output


def test_verify_output_requires_video_and_audio(tmp_path):
    runner = StubRunner('{"streams":[{"codec_type":"video"}]}')
    with pytest.raises(MediaError, match="오디오"):
        verify_output(Path("ffprobe"), tmp_path / "out.mp4", Event(), runner)
```

- [ ] **Step 5: Run probe tests and verify RED**

Run: `python -m pytest tests/test_media.py -v`

Expected: FAIL because parsing and verification are not implemented.

- [ ] **Step 6: Implement JSON parsing and stream verification**

```python
def parse_metadata(output: str) -> VideoMetadata:
    payload = json.loads(output)
    duration = float(payload.get("duration") or 0)
    if duration <= 0:
        raise MediaError("영상 재생 시간을 확인할 수 없습니다.")
    return VideoMetadata(str(payload.get("title") or "제목 없음"), duration)


def verify_output(ffprobe, output, cancel, runner):
    payload = json.loads(runner.run([
        str(ffprobe), "-v", "error", "-show_streams", "-of", "json", str(output)
    ], cancel, lambda _line: None))
    stream_types = {stream.get("codec_type") for stream in payload.get("streams", [])}
    if "video" not in stream_types or "audio" not in stream_types:
        raise MediaError("완성 파일의 영상 또는 오디오 스트림을 확인할 수 없습니다.")
```

- [ ] **Step 7: Run Task 3 tests and commit**

Run: `python -m pytest tests/test_media.py -v`

Expected: PASS.

```powershell
git add tools/video-dub-tool
git commit -m "feat: build media download and mux commands"
```

### Task 4: End-to-End Workflow

**Files:**
- Modify: `tools/video-dub-tool/src/video_dub_tool/workflow.py`
- Modify: `tools/video-dub-tool/tests/test_workflow.py`

**Interfaces:**
- Consumes: `ensure_tools`, `CommandRunner`, media command builders, `verify_output`
- Produces: `run_job(request: JobRequest, cancel: Event, emit: Callable[[str], None], *, runner: CommandRunner | None = None, tool_paths: ToolPaths | None = None) -> Path`
- Produces: ordered `ProgressEvent(stage: str, message: str)` text through `emit`
- Produces: `DurationMismatchError`

- [ ] **Step 1: Write a failing happy-path workflow test**

```python
def stub_job_io(monkeypatch, durations):
    metadata = iter(VideoMetadata(title, duration) for title, duration in durations)
    monkeypatch.setattr(workflow, "load_metadata", lambda _tools, _url, _cancel, _runner: next(metadata))

    def download(_tools, _url, work, kind, _cancel, _runner):
        path = work / f"{kind}.bin"
        path.write_bytes(kind.encode())
        return path

    def mux(_tools, _video, _audio, output, _offset, _duration, _cancel, _runner):
        output.write_bytes(b"verified mp4")

    monkeypatch.setattr(workflow, "download_stream", download)
    monkeypatch.setattr(workflow, "mux_streams", mux)
    monkeypatch.setattr(workflow, "verify_output", lambda _ffprobe, _output, _cancel, _runner: None)
    return ToolPaths(Path("yt-dlp"), Path("ffmpeg"), Path("ffprobe"), Path("deno"))


def test_run_job_moves_only_verified_result(tmp_path, monkeypatch):
    request = JobRequest(
        "https://youtu.be/korean",
        "https://youtu.be/english",
        tmp_path / "result.mp4",
        0.0,
    )
    tools = stub_job_io(monkeypatch, [("ko", 390.0), ("en", 390.0)])
    result = run_job(request, Event(), lambda _message: None, runner=CommandRunner(), tool_paths=tools)
    assert result == request.output_path
    assert request.output_path.read_bytes() == b"verified mp4"
```

The fake writes only deterministic local files; it does not assert mock call counts. The production change that makes this pass is the actual sequencing and final atomic move.

- [ ] **Step 2: Run the happy-path test and verify RED**

Run: `python -m pytest tests/test_workflow.py::test_run_job_moves_only_verified_result -v`

Expected: FAIL because `run_job` does not exist.

- [ ] **Step 3: Implement the minimal workflow**

```python
def run_job(request, cancel, emit, *, runner=None, tool_paths=None):
    validate_request(request)
    runner = runner or CommandRunner()
    emit("필요한 도구를 확인하는 중...")
    tools = tool_paths or ensure_tools()
    with TemporaryDirectory(prefix="video-dub-tool-") as temporary:
        work = Path(temporary)
        korean = load_metadata(tools, request.korean_url, cancel, runner)
        english = load_metadata(tools, request.english_url, cancel, runner)
        assessment = assess_duration(korean.duration, english.duration, request.offset_seconds)
        if assessment.action is DurationAction.BLOCK:
            raise DurationMismatchError(
                f"영상 길이 차이가 {assessment.difference_seconds:.1f}초입니다. 오프셋을 확인하세요."
            )
        if assessment.action is DurationAction.WARN:
            emit(f"주의: 영상 길이가 {assessment.difference_seconds:.1f}초 다릅니다.")
        video = download_stream(tools, request.korean_url, work, "video", cancel, runner)
        audio = download_stream(tools, request.english_url, work, "audio", cancel, runner)
        temporary_output = work / "result.mp4"
        mux_streams(
            tools, video, audio, temporary_output, request.offset_seconds,
            korean.duration, cancel, runner
        )
        verify_output(tools.ffprobe, temporary_output, cancel, runner)
        request.output_path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(temporary_output, request.output_path)
    emit(f"완료: {request.output_path}")
    return request.output_path
```

- [ ] **Step 4: Write failing block, warning, cancellation, and failed-output tests**

```python
def test_run_job_blocks_duration_difference_over_ten_seconds(tmp_path, monkeypatch):
    request = JobRequest("https://youtu.be/ko", "https://youtu.be/en", tmp_path / "out.mp4", 0.0)
    tools = stub_job_io(monkeypatch, [("ko", 390.0), ("en", 370.0)])
    with pytest.raises(DurationMismatchError, match="20.0초"):
        run_job(request, Event(), lambda _message: None, runner=CommandRunner(), tool_paths=tools)
    assert not request.output_path.exists()


def test_run_job_warns_for_three_second_difference(tmp_path, monkeypatch):
    request = JobRequest("https://youtu.be/ko", "https://youtu.be/en", tmp_path / "out.mp4", 0.0)
    tools = stub_job_io(monkeypatch, [("ko", 390.0), ("en", 387.0)])
    messages = []
    run_job(request, Event(), messages.append, runner=CommandRunner(), tool_paths=tools)
    assert any("주의" in message for message in messages)


def test_run_job_leaves_no_output_when_cancelled(tmp_path, monkeypatch):
    request = JobRequest("https://youtu.be/ko", "https://youtu.be/en", tmp_path / "out.mp4", 0.0)
    tools = stub_job_io(monkeypatch, [("ko", 390.0), ("en", 390.0)])
    monkeypatch.setattr(
        workflow,
        "download_stream",
        lambda _tools, _url, _work, _kind, _cancel, _runner: (_ for _ in ()).throw(
            JobCancelled("작업을 취소했습니다.")
        ),
    )
    with pytest.raises(JobCancelled):
        run_job(request, Event(), lambda _message: None, runner=CommandRunner(), tool_paths=tools)
    assert not request.output_path.exists()
```

- [ ] **Step 5: Run the failure-path tests and verify RED**

Run: `python -m pytest tests/test_workflow.py -v`

Expected: at least one test fails until every failure path leaves the final path untouched.

- [ ] **Step 6: Complete failure mapping and cleanup behavior**

Translate `ToolInstallError`, `CommandFailed`, malformed yt-dlp JSON, missing downloaded files, `MediaError`, and `OSError` into a `WorkflowError` with a concise Korean message. Preserve `JobCancelled` as a distinct state. Do not include URL query strings, cookies, or full subprocess environment in messages.

```python
except CommandFailed as error:
    detail = last_nonempty_line(error.output)
    raise WorkflowError(f"외부 도구 실행에 실패했습니다: {detail}") from error
except OSError as error:
    raise WorkflowError(f"파일을 저장할 수 없습니다: {error.strerror or error}") from error
```

- [ ] **Step 7: Run Task 4 tests and commit**

Run: `python -m pytest tests/test_workflow.py -v`

Expected: PASS.

```powershell
git add tools/video-dub-tool
git commit -m "feat: combine downloaded video and English audio"
```

### Task 5: Tkinter GUI

**Files:**
- Create: `tools/video-dub-tool/src/video_dub_tool/app.py`
- Create: `tools/video-dub-tool/src/video_dub_tool/__main__.py`
- Create: `tools/video-dub-tool/tests/test_app.py`

**Interfaces:**
- Consumes: `JobRequest`, `run_job`, `WorkflowError`, and `JobCancelled`
- Produces: `VideoDubApp(root: tkinter.Tk, run: RunJob = run_job)`
- Produces: `main() -> None`

- [ ] **Step 1: Write a failing initial-state and request-building GUI test**

```python
@pytest.fixture
def tk_root():
    root = tk.Tk()
    root.withdraw()
    yield root
    root.destroy()


def pump_events_until(root, condition, timeout=2.0):
    deadline = time.monotonic() + timeout
    while not condition() and time.monotonic() < deadline:
        root.update()
        time.sleep(0.01)
    assert condition()


def test_app_builds_request_and_locks_controls(tk_root, tmp_path):
    captured = []
    release = Event()

    def fake_run(request, cancel, emit):
        captured.append(request)
        release.wait(2)
        return request.output_path

    app = VideoDubApp(tk_root, fake_run)
    app.korean_url.set("https://youtu.be/korean")
    app.english_url.set("https://youtu.be/english")
    app.output_path.set(str(tmp_path / "result.mp4"))
    app.offset.set("1.25")
    app.start()
    pump_events_until(tk_root, lambda: bool(captured))
    assert captured[0].offset_seconds == 1.25
    assert app.create_button["state"] == "disabled"
    assert app.cancel_button["state"] == "normal"
    release.set()
```

- [ ] **Step 2: Run GUI tests and verify RED**

Run: `python -m pytest tests/test_app.py -v`

Expected: collection fails because `video_dub_tool.app` does not exist.

- [ ] **Step 3: Implement the single-window UI and background worker**

Build the exact controls from the design with `ttk.Label`, `ttk.Entry`, `ttk.Button`, and a read-only `tk.Text`. Use a `Queue[tuple[str, object]]` and `root.after(100, self._poll)`; the worker thread may only put queue messages and must never call Tk methods.

```python
def start(self) -> None:
    try:
        try:
            offset_seconds = float(self.offset.get())
        except ValueError as error:
            raise ValidationError("오디오 오프셋은 숫자여야 합니다.") from error
        request = JobRequest(
            self.korean_url.get().strip(),
            self.english_url.get().strip(),
            Path(self.output_path.get().strip()),
            offset_seconds,
        )
        validate_request(request)
    except ValidationError as error:
        messagebox.showerror("입력 확인", str(error), parent=self.root)
        return
    self.cancel_event.clear()
    self._set_working(True)
    Thread(target=self._worker, args=(request,), daemon=True).start()


def _worker(self, request: JobRequest) -> None:
    try:
        result = self.run(request, self.cancel_event, lambda line: self.events.put(("log", line)))
        self.events.put(("done", result))
    except JobCancelled as error:
        self.events.put(("cancelled", str(error)))
    except Exception as error:
        self.events.put(("error", str(error)))
```

- [ ] **Step 4: Write failing completion, error, and cancellation state tests**

```python
def fill_valid_inputs(app, tmp_path):
    app.korean_url.set("https://youtu.be/korean")
    app.english_url.set("https://youtu.be/english")
    app.output_path.set(str(tmp_path / "result.mp4"))
    app.offset.set("0")


def test_app_unlocks_after_error(tk_root, tmp_path):
    def failing_run(_request, _cancel, _emit):
        raise WorkflowError("테스트 실패")

    app = VideoDubApp(tk_root, failing_run)
    fill_valid_inputs(app, tmp_path)
    app.start()
    pump_events_until(tk_root, lambda: app.create_button["state"] == "normal")
    assert app.cancel_button["state"] == "disabled"
    assert "테스트 실패" in app.log.get("1.0", "end")


def test_cancel_sets_the_worker_event(tk_root, tmp_path):
    release = Event()

    def blocking_run(request, cancel, _emit):
        release.wait(2)
        if cancel.is_set():
            raise JobCancelled("작업을 취소했습니다.")
        return request.output_path

    app = VideoDubApp(tk_root, blocking_run)
    fill_valid_inputs(app, tmp_path)
    app.start()
    app.cancel()
    assert app.cancel_event.is_set()
    release.set()
```

- [ ] **Step 5: Run GUI state tests and verify RED**

Run: `python -m pytest tests/test_app.py -v`

Expected: FAIL until queue polling maps all terminal states back to unlocked controls.

- [ ] **Step 6: Complete queue polling, file picker, window close, and entry point**

`취소` sets the event and leaves the controls locked until the worker exits. Closing while a job runs asks once whether to cancel and exit. The save dialog uses `defaultextension=".mp4"` and `filetypes=[("MP4 영상", "*.mp4")]`.

```python
def main() -> None:
    root = tk.Tk()
    root.title("한글 자막 · 영어 더빙 합성")
    root.minsize(720, 480)
    VideoDubApp(root)
    root.mainloop()
```

- [ ] **Step 7: Run Task 5 tests and commit**

Run: `python -m pytest tests/test_app.py -v`

Expected: PASS.

```powershell
git add tools/video-dub-tool
git commit -m "feat: add standalone video dub GUI"
```

### Task 6: Local Media Integration, Packaging, and User Documentation

**Files:**
- Create: `tools/video-dub-tool/tests/test_media_integration.py`
- Create: `tools/video-dub-tool/build.ps1`
- Create: `tools/video-dub-tool/README.md`
- Create: `tools/video-dub-tool/THIRD_PARTY_NOTICES.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `ensure_tools`, `mux_command`, and `verify_output`
- Produces: `tools/video-dub-tool/dist/KoreanSubtitleEnglishDub.exe`

- [ ] **Step 1: Add the local-media integration test**

```python
def run(args):
    subprocess.run([str(value) for value in args], check=True, capture_output=True, text=True)


def video_codec(ffprobe, path):
    completed = subprocess.run(
        [str(ffprobe), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


@pytest.fixture(scope="session")
def prepared_tools():
    return ensure_tools()


@pytest.mark.integration
def test_mux_preserves_video_codec_and_adds_audio(tmp_path, prepared_tools):
    video = tmp_path / "video.mp4"
    audio = tmp_path / "audio.wav"
    output = tmp_path / "output.mp4"
    run([prepared_tools.ffmpeg, "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=2",
         "-an", "-c:v", "libx264", video])
    run([prepared_tools.ffmpeg, "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-c:a", "pcm_s16le", audio])
    source_codec = video_codec(prepared_tools.ffprobe, video)
    run(mux_command(prepared_tools.ffmpeg, video, audio, output, 0.25, 2.0, "pcm_s16le"))
    verify_output(prepared_tools.ffprobe, output, Event(), CommandRunner())
    assert video_codec(prepared_tools.ffprobe, output) == source_codec
```

- [ ] **Step 2: Run the integration test**

Run: `python -m pytest tests/test_media_integration.py -m integration -v`

Expected: PASS with video codec `h264` before and after muxing and an audio stream in the result. This adds end-to-end coverage for media behavior already developed test-first in Tasks 3 and 4; it does not introduce new production behavior.

- [ ] **Step 3: Run all tests after adding integration coverage**

The session fixture calls `ensure_tools()` once. Checksum mismatch, extraction failure, FFmpeg execution failure, and stream verification failure must fail the test rather than skip it.

Run: `python -m pytest -v`

Expected: all tests pass.

- [ ] **Step 4: Add build script and ignore generated artifacts**

```powershell
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot
python -m pip install -e ".[dev]"
python -m pytest -v
python -m PyInstaller --noconfirm --clean --onefile --windowed `
  --name KoreanSubtitleEnglishDub `
  --paths src `
  src/video_dub_tool/__main__.py
Write-Host "Built: $projectRoot\dist\KoreanSubtitleEnglishDub.exe"
```

Append only these generated paths to the repository `.gitignore`:

```gitignore
tools/video-dub-tool/build/
tools/video-dub-tool/dist/
tools/video-dub-tool/*.spec
tools/video-dub-tool/src/*.egg-info/
```

- [ ] **Step 5: Document the exact user workflow and third-party sources**

`README.md` must state:

1. Run `KoreanSubtitleEnglishDub.exe`.
2. Paste the Korean hard-subtitled video URL and English-dubbed video URL.
3. Choose an MP4 output path.
4. Leave offset at `0.0` unless the audio starts early or late.
5. Positive values delay audio; negative values trim its beginning.
6. First run downloads about 170 MB of verified tools and requires internet.
7. Use only videos the user may download and edit.
8. Automatic scene-edit alignment and restricted-video bypass are not supported.

`THIRD_PARTY_NOTICES.md` must link to yt-dlp, FFmpeg, Gyan FFmpeg builds, and Deno release/license pages and record the exact pinned versions from Task 2.

- [ ] **Step 6: Run the complete automated verification**

Run: `python -m pytest -v`

Expected: all unit, GUI, and local-media integration tests pass with no warnings.

- [ ] **Step 7: Build the standalone EXE**

Run: `powershell -ExecutionPolicy Bypass -File .\build.ps1`

Expected: `dist/KoreanSubtitleEnglishDub.exe` exists and exits only when the GUI closes.

- [ ] **Step 8: Manually verify the user-provided pair**

Use:

- Korean: `https://www.youtube.com/watch?v=SaC_4njK1cc`
- English: `https://www.youtube.com/watch?v=k1rmP5woxP0`
- Offset: `0.0`

Expected:

- Both metadata durations are 390 seconds.
- The result contains the Korean hard-subtitled picture and English audio.
- The result opens in the Windows default media player.
- A spot check at the beginning, middle, and end shows no visible cumulative drift.

- [ ] **Step 9: Commit packaging and documentation**

```powershell
git add .gitignore tools/video-dub-tool
git commit -m "build: package standalone video dub tool"
```
