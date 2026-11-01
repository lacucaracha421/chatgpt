//! Isolated, cookie-owning kone browser transport. Remote pages have no IPC capability.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

const LIMIT: usize = 5 * 1024 * 1024;
const UNAVAILABLE: &str = "코네에 연결할 수 없습니다";
const TIMEOUT: &str = "코네 응답 시간이 초과되었습니다";
/// The hidden browser costs about 430 MB and requests come hourly, so it leaves between them.
const IDLE_CLOSE: Duration = Duration::from_secs(60);
#[derive(Default)]
pub(crate) struct KoneTransport {
    gate: tokio::sync::Mutex<()>,
    last: Mutex<Option<Instant>>,
    idle_watch: AtomicBool,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KoneProfile {
    pub handle: String,
    pub display_name: String,
}
#[derive(serde::Deserialize)]
struct Response {
    status: u16,
    body: String,
}
pub(crate) struct KoneResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub(crate) fn allowed(method: &str, path: &str) -> bool {
    method == "QUERY" && matches!(path, "/v1/article/list" | "/v1/article/get")
}
fn allowed_page(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some("kone.gg" | "challenges.cloudflare.com")
        )
}
fn browse(app: &AppHandle, url: url::Url) {
    if allowed_page(&url) {
        if let Some(w) = app.get_webview_window("kone-login") {
            let _ = w.navigate(url);
        }
    } else if url.scheme() == "https" {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}
fn window(app: &AppHandle, login: bool) -> Result<WebviewWindow, String> {
    let label = if login {
        "kone-login"
    } else {
        "kone-transport"
    };
    if let Some(w) = app.get_webview_window(label) {
        return Ok(w);
    }
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| UNAVAILABLE)?
        .join("kone-webview");
    std::fs::create_dir_all(&dir).map_err(|_| UNAVAILABLE)?;
    let nav_app = app.clone();
    let pop_app = app.clone();
    // Both builders use identical browser settings so WebView2 can share its profile.
    crate::motion::apply_browser_args(
        WebviewWindowBuilder::new(
            app,
            label,
            WebviewUrl::External(
                if login {
                    "https://kone.gg/account/signin?path=%2Fs%2Fsomisoft"
                } else {
                    "https://kone.gg"
                }
                .parse()
                .unwrap(),
            ),
        ),
        app,
    )
    .data_directory(dir)
    .title("코네")
    .inner_size(1100.0, 860.0)
    .visible(login)
    .skip_taskbar(!login)
    .on_navigation(move |url| {
        if allowed_page(url) {
            true
        } else {
            // Only the user's own window may hand a link to the browser; the hidden one never does.
            if login && url.scheme() == "https" {
                let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        }
    })
    .on_new_window(move |url, _| {
        browse(&pop_app, url);
        NewWindowResponse::Deny
    })
    .on_page_load(move |w, p| {
        if matches!(p.event(), PageLoadEvent::Finished) {
            let _ = w.eval("window.__lakomicsKoneReady=true");
            if login
                && p.url().host_str() == Some("kone.gg")
                && !p.url().path().starts_with("/account/")
            {
                let _ = w.close();
            }
        }
    })
    .build()
    .map_err(|_| UNAVAILABLE.into())
}
async fn pause(duration: Duration) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration))
        .await
        .map_err(|_| UNAVAILABLE.to_owned())
}
async fn evaluate(w: &WebviewWindow, script: &str, deadline: Instant) -> Result<String, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(TIMEOUT.into());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    w.eval_with_callback(script, move |s| {
        let _ = tx.send(s);
    })
    .map_err(|_| UNAVAILABLE)?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(remaining).map_err(|_| TIMEOUT.to_owned())
    })
    .await
    .map_err(|_| UNAVAILABLE.to_owned())?
}
fn unquote(s: String) -> String {
    serde_json::from_str::<String>(&s).unwrap_or(s)
}
impl KoneTransport {
    /// One watcher per hidden window. Holding the gate proves no request is in flight.
    fn watch_idle(&self, app: &AppHandle) {
        if self.idle_watch.swap(true, Ordering::AcqRel) {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let transport = app.state::<KoneTransport>();
            loop {
                let _ = pause(Duration::from_secs(5)).await;
                let idle = transport
                    .last
                    .lock()
                    .map(|last| last.is_none_or(|at| at.elapsed() >= IDLE_CLOSE))
                    .unwrap_or(false);
                if !idle {
                    continue;
                }
                let Ok(_guard) = transport.gate.try_lock() else {
                    continue;
                };
                if let Some(w) = app.get_webview_window("kone-transport") {
                    let _ = w.destroy();
                }
                transport.idle_watch.store(false, Ordering::Release);
                break;
            }
        });
    }
    async fn exchange(
        &self,
        app: &AppHandle,
        script: &str,
        epoch: Option<u64>,
    ) -> Result<String, String> {
        let _guard = self.gate.lock().await;
        let last = *self.last.lock().map_err(|_| UNAVAILABLE)?;
        if let Some(last) = last {
            pause(Duration::from_millis(300).saturating_sub(last.elapsed())).await?;
        }
        if epoch.is_some_and(|epoch| !app.state::<crate::somi::SomiState>().current(epoch)) {
            return Err("SOMI_LOGIN_REQUIRED".into());
        }
        let deadline = Instant::now() + Duration::from_secs(60);
        let w = window(app, false)?;
        self.watch_idle(app);
        loop {
            if w.url()
                .ok()
                .is_some_and(|url| url.scheme() == "https" && url.host_str() == Some("kone.gg"))
                && evaluate(&w, "window.__lakomicsKoneReady === true", deadline).await? == "true"
            {
                break;
            }
            if Instant::now() >= deadline {
                let _ = w.destroy();
                return Err(TIMEOUT.into());
            }
            pause(Duration::from_millis(50)).await?;
        }
        if epoch.is_some_and(|epoch| !app.state::<crate::somi::SomiState>().current(epoch)) {
            return Err("SOMI_LOGIN_REQUIRED".into());
        }
        w.eval(script).map_err(|_| UNAVAILABLE)?;
        let result=async {
            loop {
                let response=evaluate(&w,"(() => {const r=window.__lakomicsKoneResponse;if(r==null)return null;delete window.__lakomicsKoneResponse;return r;})()",deadline).await?;
                if response!="null" {return Ok(unquote(response));}
                pause(Duration::from_millis(50)).await?;
            }
        }.await;
        *self.last.lock().map_err(|_| UNAVAILABLE)? = Some(Instant::now());
        if result.is_err() {
            // Destroy the page to abort its in-flight fetch before allowing a new one.
            let _ = w.destroy();
        }
        result
    }
    pub async fn request(
        &self,
        app: &AppHandle,
        method: &str,
        path: &str,
        body: &[u8],
        epoch: u64,
    ) -> Result<KoneResponse, String> {
        if !allowed(method, path) || body.len() > LIMIT {
            return Err("허용되지 않은 코네 요청".into());
        }
        let body = serde_json::to_string(&base64(body)).map_err(|_| UNAVAILABLE)?;
        let url = serde_json::to_string(&format!("https://api.kone.gg{path}"))
            .map_err(|_| UNAVAILABLE)?;
        let script = format!(
            r#"window.__lakomicsKoneResponse=null;void(async()=>{{
          const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),55000);
          try {{const r=await fetch({url},{{method:'QUERY',credentials:'include',redirect:'error',signal:controller.signal,headers:{{'content-type':'application/sef',accept:'application/sef'}},body:Uint8Array.from(atob({body}),c=>c.charCodeAt(0))}});
          const reader=r.body.getReader();let parts=[],size=0;for(;;){{const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>{LIMIT}){{await reader.cancel();throw 0;}}parts.push(v.value);}}
          let binary='';for(const part of parts)for(let i=0;i<part.length;i+=8192)binary+=String.fromCharCode(...part.subarray(i,i+8192));
          window.__lakomicsKoneResponse=JSON.stringify({{status:r.status,body:btoa(binary)}});
          }}catch{{window.__lakomicsKoneResponse=JSON.stringify({{status:0,body:''}});}}finally{{clearTimeout(timer);}}
        }})();"#
        );
        let response: Response =
            serde_json::from_str(&self.exchange(app, &script, Some(epoch)).await?)
                .map_err(|_| UNAVAILABLE)?;
        if response.status == 0 {
            return Err(UNAVAILABLE.into());
        }
        Ok(KoneResponse {
            status: response.status,
            body: unbase64(&response.body)?,
        })
    }
    pub async fn profile(&self, app: &AppHandle) -> Result<Option<KoneProfile>, String> {
        // The raw page data stays inside this parser boundary; only the two public strings escape.
        let script = r#"window.__lakomicsKoneResponse=null;void(async()=>{
          try {const r=await fetch('https://kone.gg/__data.json?x-sveltekit-invalidated=1',{credentials:'include',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(55000)});
          if(!r.ok)throw 0;const reader=r.body.getReader();let parts=[],size=0;for(;;){const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>5242880){await reader.cancel();throw 0;}parts.push(v.value);}
          const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}
          window.__lakomicsKoneResponse=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
          }catch{window.__lakomicsKoneResponse='error';}
        })();"#;
        let response = self.exchange(app, script, None).await?;
        let value = serde_json::from_str(&response).map_err(|_| UNAVAILABLE)?;
        Ok(parse_profile(&value))
    }
    pub async fn open_login(&self, app: &AppHandle) -> Result<(), String> {
        let _guard = self.gate.lock().await;
        let w = window(app, true)?;
        w.show().map_err(|_| UNAVAILABLE)?;
        w.set_focus().map_err(|_| UNAVAILABLE)?;
        let app = app.clone();
        // SvelteKit can leave /account/ through history navigation without a page-load event.
        tauri::async_runtime::spawn(async move {
            loop {
                if pause(Duration::from_millis(250)).await.is_err() {
                    break;
                }
                let Some(w) = app.get_webview_window("kone-login") else {
                    break;
                };
                if w.url().ok().is_some_and(|url| {
                    url.scheme() == "https"
                        && url.host_str() == Some("kone.gg")
                        && !url.path().starts_with("/account/")
                }) {
                    let _ = w.close();
                    break;
                }
            }
            app.state::<crate::somi::SomiState>().recheck_login();
        });
        Ok(())
    }
    pub async fn logout(&self, app: &AppHandle) -> Result<(), String> {
        {
            let _guard = self.gate.lock().await;
            if let Some(w) = app.get_webview_window("kone-login") {
                w.close().map_err(|_| UNAVAILABLE)?;
            }
            let w = window(app, false)?;
            w.clear_all_browsing_data().map_err(|_| UNAVAILABLE)?;
        }
        // WebView2 clears asynchronously. Keep the profile alive until its page confirms logout.
        let deadline = Instant::now() + Duration::from_secs(60);
        while self.profile(app).await?.is_some() {
            if Instant::now() >= deadline {
                return Err(TIMEOUT.into());
            }
        }
        Ok(())
    }
}
fn parse_profile(json: &serde_json::Value) -> Option<KoneProfile> {
    let data = json.get("nodes")?.get(0)?.get("data")?.as_array()?;
    let field = |value: &serde_json::Value, key: &str| -> Option<&serde_json::Value> {
        data.get(value.get(key)?.as_u64()? as usize)
    };
    let profile = field(field(data.first()?, "session")?, "profile")?;
    let handle = field(profile, "handle")?.as_str()?.to_owned();
    let display_name = field(profile, "displayName")
        .and_then(|v| v.as_str())
        .unwrap_or(&handle)
        .to_owned();
    Some(KoneProfile {
        handle,
        display_name,
    })
}
const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn base64(bytes: &[u8]) -> String {
    let mut out = String::new();
    for b in bytes.chunks(3) {
        let n = ((b[0] as u32) << 16)
            | ((b.get(1).copied().unwrap_or(0) as u32) << 8)
            | b.get(2).copied().unwrap_or(0) as u32;
        for i in 0..4 {
            out.push(if i > b.len() {
                '='
            } else {
                B64[((n >> (18 - i * 6)) & 63) as usize] as char
            });
        }
    }
    out
}
fn unbase64(s: &str) -> Result<Vec<u8>, String> {
    if s.len() > LIMIT.div_ceil(3) * 4 || s.len() % 4 != 0 {
        return Err(UNAVAILABLE.into());
    }
    let mut out = Vec::new();
    for b in s.as_bytes().chunks(4) {
        let mut n = 0u32;
        for c in b {
            n = (n << 6)
                | if *c == b'=' {
                    0
                } else {
                    B64.iter().position(|v| v == c).ok_or(UNAVAILABLE)? as u32
                };
        }
        out.push((n >> 16) as u8);
        if b[2] != b'=' {
            out.push((n >> 8) as u8);
        }
        if b[3] != b'=' {
            out.push(n as u8);
        }
    }
    if out.len() > LIMIT {
        return Err(UNAVAILABLE.into());
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kone_profile_only_surfaces_public_names() {
        let value = serde_json::json!({"nodes":[{"data":[{"session":1},{"profile":2},{"handle":3,"displayName":4,"email":5},"somi-user","소미 사용자","private@example.test"]}]});
        let profile = parse_profile(&value).unwrap();
        assert_eq!(
            serde_json::to_value(profile).unwrap(),
            serde_json::json!({"handle":"somi-user","displayName":"소미 사용자"})
        );
        let value = serde_json::json!({"nodes":[{"data":[{"session":1},null]}]});
        assert!(parse_profile(&value).is_none());
        let value = serde_json::json!({"nodes":[{"data":[{"session":1},{"profile":2},{"handle":3,"email":4},"reader","private@example.test"]}]});
        assert_eq!(parse_profile(&value).unwrap().display_name, "reader");
    }
    #[test]
    fn kone_request_allowlist() {
        assert!(allowed("QUERY", "/v1/article/list"));
        assert!(allowed("QUERY", "/v1/article/get"));
        for (m, p) in [
            ("POST", "/v1/article/get"),
            ("QUERY", "/v1/article/vote"),
            ("QUERY", "/v1/article/list?x=1"),
            ("DELETE", "/v1/article/list"),
        ] {
            assert!(!allowed(m, p));
        }
    }
    #[test]
    fn kone_base64_roundtrip() {
        for b in [b"a".as_slice(), b"ab", b"abc", &[0, 255, 128, 64]] {
            assert_eq!(unbase64(&base64(b)).unwrap(), b);
        }
    }
}
