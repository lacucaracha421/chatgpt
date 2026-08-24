use crate::library::error::LibraryError;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, RecvTimeoutError},
    },
    time::{Duration, Instant},
};
use tauri::{
    webview::PageLoadEvent, AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const K_HENTAI_ORIGIN: &str = "https://k-hentai.org";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const RESPONSE_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Default)]
pub(crate) struct CatalogTransport {
    busy: AtomicBool,
}

struct RequestGuard<'a>(&'a AtomicBool);

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl CatalogTransport {
    fn begin_request(&self) -> Result<RequestGuard<'_>, LibraryError> {
        self.busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| LibraryError::CatalogTransportBusy)?;
        Ok(RequestGuard(&self.busy))
    }

    pub(crate) async fn fetch_text(
        &self,
        app: &AppHandle,
        path: &str,
    ) -> Result<String, LibraryError> {
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        let script = request_script(path)?;
        let _guard = self.begin_request()?;
        let window = ensure_window(app, deadline).await?;
        window
            .eval(script)
            .map_err(|_| LibraryError::CatalogTransportUnavailable)?;
        let callback = poll_response(&window, deadline).await?;
        decode_callback(&callback)
    }
}

async fn ensure_window(
    app: &AppHandle,
    deadline: Instant,
) -> Result<WebviewWindow, LibraryError> {
    if let Some(window) = app.get_webview_window("catalog-transport") {
        return Ok(window);
    }

    let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
    let window = WebviewWindowBuilder::new(
        app,
        "catalog-transport",
        WebviewUrl::External(
            K_HENTAI_ORIGIN
                .parse()
                .expect("static catalog origin is valid"),
        ),
    )
    .visible(false)
    .skip_taskbar(true)
    .on_navigation(|url| url.origin().ascii_serialization() == K_HENTAI_ORIGIN)
    .on_page_load(move |_window, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            let _ = ready_sender.send(String::new());
        }
    })
    .build()
    .map_err(|_| LibraryError::CatalogTransportUnavailable)?;

    let remaining = remaining_until(deadline, Instant::now());
    if remaining.is_zero() {
        return Err(LibraryError::CatalogTransportTimedOut);
    }
    tauri::async_runtime::spawn_blocking(move || receive_callback(ready_receiver, remaining))
        .await
        .map_err(|_| LibraryError::CatalogTransportUnavailable)??;
    Ok(window)
}

fn receive_callback(receiver: Receiver<String>, timeout: Duration) -> Result<String, LibraryError> {
    receiver.recv_timeout(timeout).map_err(|error| match error {
        RecvTimeoutError::Timeout => LibraryError::CatalogTransportTimedOut,
        RecvTimeoutError::Disconnected => LibraryError::CatalogTransportUnavailable,
    })
}

async fn evaluate(
    window: &WebviewWindow,
    script: &str,
    timeout: Duration,
) -> Result<String, LibraryError> {
    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .eval_with_callback(script, move |value| {
            let _ = sender.send(value);
        })
        .map_err(|_| LibraryError::CatalogTransportUnavailable)?;
    tauri::async_runtime::spawn_blocking(move || receive_callback(receiver, timeout))
        .await
        .map_err(|_| LibraryError::CatalogTransportUnavailable)?
}

async fn poll_response(window: &WebviewWindow, deadline: Instant) -> Result<String, LibraryError> {
    loop {
        let remaining = remaining_until(deadline, Instant::now());
        if remaining.is_zero() {
            return Err(LibraryError::CatalogTransportTimedOut);
        }
        let value = evaluate(window, response_script(), remaining).await?;
        if value != "null" {
            return Ok(value);
        }
        let delay = poll_delay(remaining_until(deadline, Instant::now()));
        if delay.is_zero() {
            return Err(LibraryError::CatalogTransportTimedOut);
        }
        tauri::async_runtime::spawn_blocking(move || std::thread::sleep(delay))
            .await
            .map_err(|_| LibraryError::CatalogTransportUnavailable)?;
    }
}

fn remaining_until(deadline: Instant, now: Instant) -> Duration {
    deadline.saturating_duration_since(now)
}

fn poll_delay(remaining: Duration) -> Duration {
    RESPONSE_POLL_INTERVAL.min(remaining)
}

pub(crate) fn search_page_path(cursor: Option<u64>) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("search", "language:korean");
    if let Some(cursor) = cursor {
        query.append_pair("next-id", &cursor.to_string());
    }
    format!("/ajax/search?{}", query.finish())
}

fn request_script(path: &str) -> Result<String, LibraryError> {
    validate_path(path)?;
    let path =
        serde_json::to_string(path).map_err(|_| LibraryError::InvalidCatalogTransportPath)?;
    Ok(format!(
        r#"(() => {{
          window.__lakomicsCatalogGeneration = (window.__lakomicsCatalogGeneration || 0) + 1;
          const generation = window.__lakomicsCatalogGeneration;
          window.__lakomicsCatalogResponse = null;
          void (async () => {{
            try {{
              const response = await fetch({path}, {{ credentials: 'include', cache: 'no-store' }});
              if (window.__lakomicsCatalogGeneration === generation) {{
                window.__lakomicsCatalogResponse = JSON.stringify({{ ok: response.ok, status: response.status, body: await response.text() }});
              }}
            }} catch (error) {{
              if (window.__lakomicsCatalogGeneration === generation) {{
                window.__lakomicsCatalogResponse = JSON.stringify({{ ok: false, status: 0, body: String(error) }});
              }}
            }}
          }})();
        }})();"#
    ))
}

fn response_script() -> &'static str {
    r#"(() => {
      const value = window.__lakomicsCatalogResponse;
      if (value === null || value === undefined) return null;
      delete window.__lakomicsCatalogResponse;
      return value;
    })()"#
}

fn validate_path(path: &str) -> Result<(), LibraryError> {
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains(['#', '\\'])
        || path.chars().any(char::is_control)
    {
        return Err(LibraryError::InvalidCatalogTransportPath);
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct TransportResponse {
    ok: bool,
    status: u16,
    body: String,
}

fn decode_callback(value: &str) -> Result<String, LibraryError> {
    let response = serde_json::from_str::<String>(value).unwrap_or_else(|_| value.to_owned());
    let response: TransportResponse = serde_json::from_str(&response)
        .map_err(|_| LibraryError::InvalidCatalogTransportResponse)?;
    match (response.ok, response.status) {
        (true, 200) => Ok(response.body),
        (_, 0) => Err(LibraryError::CatalogTransportUnavailable),
        _ => Err(LibraryError::CatalogTransportRejected(response.status)),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_callback, poll_delay, receive_callback, remaining_until, request_script,
        response_script, search_page_path, CatalogTransport, RESPONSE_POLL_INTERVAL,
    };
    use crate::library::error::LibraryError;
    use std::time::{Duration, Instant};

    fn callback_value(ok: bool, status: u16, body: &str) -> String {
        serde_json::to_string(
            &serde_json::json!({ "ok": ok, "status": status, "body": body }).to_string(),
        )
        .unwrap()
    }

    #[test]
    fn builds_closed_same_origin_paths() {
        assert_eq!(
            search_page_path(None),
            "/ajax/search?search=language%3Akorean"
        );
        assert_eq!(
            search_page_path(Some(4_127_793)),
            "/ajax/search?search=language%3Akorean&next-id=4127793",
        );
    }

    #[test]
    fn rejects_paths_that_can_leave_the_origin() {
        for path in [
            "https://example.test/",
            "//example.test/",
            "/r/1#fragment",
            "/r\\1",
            "/r/1\nalert(1)",
        ] {
            assert!(matches!(
                request_script(path),
                Err(LibraryError::InvalidCatalogTransportPath)
            ));
        }
    }

    #[test]
    fn starts_async_fetch_without_returning_its_promise_to_webview2() {
        let script = request_script("/ajax/search?search=language%3Akorean").unwrap();
        assert!(script.contains("window.__lakomicsCatalogResponse = null"));
        assert!(script.contains(
            "window.__lakomicsCatalogGeneration = (window.__lakomicsCatalogGeneration || 0) + 1"
        ));
        assert!(script.contains(
            "(() => {\n          window.__lakomicsCatalogGeneration ="
        ));
        assert!(script.contains("const generation = window.__lakomicsCatalogGeneration"));
        assert!(script.contains("void (async () =>"));
        assert!(script.contains(
            "if (window.__lakomicsCatalogGeneration === generation)"
        ));
        assert!(script.contains("credentials: 'include', cache: 'no-store'"));
        assert!(script.contains("fetch(\"/ajax/search?search=language%3Akorean\""));
        assert!(!script.trim_end().ends_with("})()"));
    }

    #[test]
    fn polls_and_consumes_only_a_completed_response_slot() {
        let script = response_script();

        assert!(script.contains("window.__lakomicsCatalogResponse"));
        assert!(script.contains("value === null"));
        assert!(script.contains("value === undefined"));
        assert!(script.contains("delete window.__lakomicsCatalogResponse"));
        assert!(!script.contains("fetch("));
    }

    #[test]
    fn computes_remaining_shared_deadline_without_sleeping() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(1);

        assert_eq!(remaining_until(deadline, now), Duration::from_secs(1));
        assert_eq!(remaining_until(deadline, deadline), Duration::ZERO);
        assert_eq!(remaining_until(deadline, deadline + Duration::from_secs(1)), Duration::ZERO);
    }

    #[test]
    fn caps_poll_delay_at_remaining_deadline() {
        assert_eq!(poll_delay(Duration::from_secs(1)), RESPONSE_POLL_INTERVAL);
        assert_eq!(poll_delay(Duration::from_millis(10)), Duration::from_millis(10));
    }

    #[test]
    fn decodes_the_json_string_returned_by_eval_with_callback() {
        let callback = callback_value(true, 200, r#"[{"id":1}]"#);
        assert_eq!(decode_callback(&callback).unwrap(), r#"[{"id":1}]"#);
    }

    #[test]
    fn decodes_the_direct_json_returned_by_webview2() {
        let callback = serde_json::json!({
            "ok": true,
            "status": 200,
            "body": "gallery html"
        })
        .to_string();

        assert_eq!(decode_callback(&callback).unwrap(), "gallery html");
    }

    #[test]
    fn rejects_http_and_transport_failures() {
        assert!(matches!(
            decode_callback(&callback_value(false, 429, "slow down")),
            Err(LibraryError::CatalogTransportRejected(429))
        ));
        assert!(matches!(
            decode_callback(&callback_value(false, 0, "offline")),
            Err(LibraryError::CatalogTransportUnavailable)
        ));
    }

    #[test]
    fn rejects_malformed_callback_values() {
        for callback in ["not-json", r#"{\"ok\":true}"#, r#"\"not-inner-json\""#] {
            assert!(matches!(
                decode_callback(callback),
                Err(LibraryError::InvalidCatalogTransportResponse)
            ));
        }
    }

    #[test]
    fn rejects_an_overlapping_request() {
        let transport = CatalogTransport::default();
        let first = transport.begin_request().unwrap();
        assert!(matches!(
            transport.begin_request(),
            Err(LibraryError::CatalogTransportBusy)
        ));
        drop(first);
        assert!(transport.begin_request().is_ok());
    }

    #[test]
    fn maps_a_missing_callback_to_timeout() {
        let (_sender, receiver) = std::sync::mpsc::channel();
        assert!(matches!(
            receive_callback(receiver, Duration::ZERO),
            Err(LibraryError::CatalogTransportTimedOut)
        ));
    }

    #[test]
    fn search_and_gallery_responses_share_the_same_decoder() {
        let search = callback_value(true, 200, r#"[{"id":4127792}]"#);
        let gallery = callback_value(
            true,
            200,
            r#"<script>const gallery = {"files":[]};</script>"#,
        );
        assert!(decode_callback(&search).unwrap().starts_with('['));
        assert!(decode_callback(&gallery).unwrap().contains("const gallery"));
    }
}
