//! The Python cutout child (`character-runtime/card_cutout.py`): one owned process, one image
//! at a time, NDJSON over stdin/stdout, killed on drop. It shares the character runtime's
//! interpreter (onnxruntime with DirectML, numpy, Pillow); nothing is installed for it.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

const MAX_MESSAGE: u64 = 64 * 1024;
const START_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CUT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const POLL: Duration = Duration::from_millis(200);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Cut {
    pub file: PathBuf,
    pub content_type: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub width: u32,
    pub height: u32,
    pub ms: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WorkerError {
    /// The caller asked to stop (workload gate closed or app exit); the child was killed.
    Interrupted,
    /// This image could not be cut; the worker is still fine.
    Image(String),
    /// The process died, answered nonsense or timed out; it must be restarted.
    Broken(String),
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Interrupted => f.write_str("중단됨"),
            Self::Image(why) | Self::Broken(why) => f.write_str(why),
        }
    }
}

/// What a result line means for request `id`.
pub(crate) fn parse_result(value: &Value, id: &str) -> Result<Cut, WorkerError> {
    let broken = |why: &str| WorkerError::Broken(format!("누끼 worker 응답 오류: {why}"));
    if value["type"] != "result" || value["id"].as_str() != Some(id) {
        return Err(broken("unexpected message"));
    }
    if value["ok"] != true {
        return Err(WorkerError::Image(
            value["error"]
                .as_str()
                .unwrap_or("누끼를 만들지 못했습니다")
                .chars()
                .take(300)
                .collect(),
        ));
    }
    let text = |key: &str| value[key].as_str().ok_or_else(|| broken(key));
    let number = |key: &str| value[key].as_u64().ok_or_else(|| broken(key));
    let content_type = text("contentType")?;
    if !matches!(content_type, "image/webp" | "image/png") {
        return Err(broken("contentType"));
    }
    Ok(Cut {
        file: PathBuf::from(text("file")?),
        content_type: content_type.to_owned(),
        sha256: text("sha256")?.to_owned(),
        size_bytes: number("sizeBytes")?,
        width: number("width")? as u32,
        height: number("height")? as u32,
        ms: number("ms")?,
    })
}

pub(crate) fn request_line(id: &str, src: &Path, dst_stem: &Path) -> Vec<u8> {
    let mut line = serde_json::to_vec(&json!({
        "type": "cutout", "id": id, "src": src, "dstStem": dst_stem,
    }))
    .expect("a request is plain JSON");
    line.push(b'\n');
    line
}

pub(crate) struct Worker {
    child: Child,
    stdin: std::process::ChildStdin,
    output: mpsc::Receiver<Result<Value, String>>,
    pub provider: String,
}

impl Worker {
    /// Starts the child and waits for its `ready` line (the model load).
    pub(crate) fn start(
        python: &Path,
        script: &Path,
        model: &Path,
        abort: &dyn Fn() -> bool,
    ) -> Result<Self, WorkerError> {
        let mut command = Command::new(python);
        command
            .arg("-B")
            .arg(script)
            .arg("--model")
            .arg(model)
            .args(["--provider", "auto"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env("OPENBLAS_NUM_THREADS", "2")
            .env("OMP_NUM_THREADS", "2")
            .env("MKL_NUM_THREADS", "2")
            .env("ORT_DISABLE_TELEMETRY", "1")
            .env("PYTHONUTF8", "1");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| WorkerError::Broken(format!("누끼 worker를 시작하지 못했습니다: {e}")))?;
        let stdin = child.stdin.take().expect("piped");
        let stdout = child.stdout.take().expect("piped");
        let (sender, output) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                let message = match (&mut reader)
                    .take(MAX_MESSAGE + 1)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => Err("누끼 worker가 종료되었습니다.".to_owned()),
                    Ok(_) if line.len() as u64 > MAX_MESSAGE || line.last() != Some(&b'\n') => {
                        Err("누끼 worker 응답 형식 오류".to_owned())
                    }
                    Ok(_) => serde_json::from_slice::<Value>(&line)
                        .map_err(|_| "누끼 worker 응답 JSON 오류".to_owned()),
                    Err(e) => Err(e.to_string()),
                };
                let failed = message.is_err();
                if sender.send(message).is_err() || failed {
                    break;
                }
            }
        });
        let mut worker = Self {
            child,
            stdin,
            output,
            provider: String::new(),
        };
        let ready = worker.receive(START_TIMEOUT, abort)?;
        if ready["type"] != "ready" {
            return Err(WorkerError::Broken(
                "누끼 worker가 준비되지 않았습니다.".into(),
            ));
        }
        worker.provider = ready["provider"].as_str().unwrap_or("unknown").to_owned();
        Ok(worker)
    }

    fn receive(
        &mut self,
        timeout: Duration,
        abort: &dyn Fn() -> bool,
    ) -> Result<Value, WorkerError> {
        let started = Instant::now();
        loop {
            if abort() {
                return Err(WorkerError::Interrupted);
            }
            if started.elapsed() >= timeout {
                return Err(WorkerError::Broken("누끼 worker 응답 시간 초과".into()));
            }
            match self.output.recv_timeout(POLL) {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(why)) => return Err(WorkerError::Broken(why)),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(WorkerError::Broken("누끼 worker가 종료되었습니다.".into()))
                }
            }
        }
    }

    /// Cuts `src` to `<dst_stem>.<ext>`. `abort` is polled while waiting, so a closed
    /// workload gate or app exit stops the child instead of letting it finish the image.
    pub(crate) fn cut(
        &mut self,
        id: &str,
        src: &Path,
        dst_stem: &Path,
        abort: &dyn Fn() -> bool,
    ) -> Result<Cut, WorkerError> {
        self.stdin
            .write_all(&request_line(id, src, dst_stem))
            .and_then(|()| self.stdin.flush())
            .map_err(|e| WorkerError::Broken(format!("누끼 worker 입력 오류: {e}")))?;
        let reply = self.receive(CUT_TIMEOUT, abort)?;
        parse_result(&reply, id)
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.stdin.write_all(b"{\"type\":\"shutdown\"}\n");
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok() -> Value {
        json!({"type":"result","id":"a1","ok":true,"file":"C:/c/a1.webp","contentType":"image/webp",
               "sha256":"ab","sizeBytes":123,"width":800,"height":1100,"ms":1500})
    }

    #[test]
    fn a_result_line_becomes_a_cut() {
        let cut = parse_result(&ok(), "a1").unwrap();
        assert_eq!(
            (
                cut.file,
                cut.content_type.as_str(),
                cut.size_bytes,
                cut.width,
                cut.height
            ),
            (PathBuf::from("C:/c/a1.webp"), "image/webp", 123, 800, 1100)
        );
    }

    #[test]
    fn a_failed_image_is_an_image_error_and_anything_else_is_broken() {
        let failed =
            json!({"type":"result","id":"a1","ok":false,"error":"UnidentifiedImageError: x"});
        assert_eq!(
            parse_result(&failed, "a1"),
            Err(WorkerError::Image("UnidentifiedImageError: x".into()))
        );
        assert!(matches!(
            parse_result(&ok(), "other"),
            Err(WorkerError::Broken(_))
        ));
        assert!(matches!(
            parse_result(&json!({"type":"ready"}), "a1"),
            Err(WorkerError::Broken(_))
        ));
        let mut wrong_type = ok();
        wrong_type["contentType"] = json!("image/jpeg");
        assert!(matches!(
            parse_result(&wrong_type, "a1"),
            Err(WorkerError::Broken(_))
        ));
        let mut missing = ok();
        missing.as_object_mut().unwrap().remove("sizeBytes");
        assert!(matches!(
            parse_result(&missing, "a1"),
            Err(WorkerError::Broken(_))
        ));
    }

    #[test]
    fn requests_are_one_json_line_with_paths_as_strings() {
        let line = request_line(
            "a1",
            Path::new("C:/work/a1.src"),
            Path::new("C:/cache/toonout-1/a1"),
        );
        assert_eq!(line.last(), Some(&b'\n'));
        let value: Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(
            value,
            json!({"type":"cutout","id":"a1","src":"C:/work/a1.src","dstStem":"C:/cache/toonout-1/a1"})
        );
    }

    #[test]
    fn a_missing_interpreter_is_a_broken_worker_not_a_panic() {
        let result = Worker::start(
            Path::new("Z:/definitely/missing/python.exe"),
            Path::new("card_cutout.py"),
            Path::new("model.onnx"),
            &|| false,
        );
        assert!(matches!(result, Err(WorkerError::Broken(_))));
    }
}
