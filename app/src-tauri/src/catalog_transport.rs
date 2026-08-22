use crate::library::error::LibraryError;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, RecvTimeoutError},
    },
    time::Duration,
};
use tauri::{
    webview::PageLoadEvent, AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const K_HENTAI_ORIGIN: &str = "https://k-hentai.org";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

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
        let script = request_script(path)?;
        let _guard = self.begin_request()?;
        let window = ensure_window(app).await?;
        let (sender, receiver) = std::sync::mpsc::channel();
        window
            .eval_with_callback(script, move |value| {
                let _ = sender.send(value);
            })
            .map_err(|_| LibraryError::CatalogTransportUnavailable)?;
        let callback = tauri::async_runtime::spawn_blocking(move || {
            receive_callback(receiver, REQUEST_TIMEOUT)
        })
        .await
        .map_err(|_| LibraryError::CatalogTransportUnavailable)??;
        decode_callback(&callback)
    }
}

async fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, LibraryError> {
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

    tauri::async_runtime::spawn_blocking(move || receive_callback(ready_receiver, REQUEST_TIMEOUT))
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
        r#"(async () => {{
          try {{
            const response = await fetch({path}, {{ credentials: 'include', cache: 'no-store' }});
            return JSON.stringify({{ ok: response.ok, status: response.status, body: await response.text() }});
          }} catch (error) {{
            return JSON.stringify({{ ok: false, status: 0, body: String(error) }});
          }}
        }})()"#
    ))
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
        decode_callback, receive_callback, request_script, search_page_path, CatalogTransport,
    };
    use crate::library::error::LibraryError;
    use std::time::Duration;

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
    fn encodes_the_path_as_a_json_string_in_the_request_script() {
        let script = request_script("/ajax/search?search=language%3Akorean").unwrap();
        assert!(script.contains("fetch(\"/ajax/search?search=language%3Akorean\""));
        assert!(!script.contains("fetch('/ajax"));
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
