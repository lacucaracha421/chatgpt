mod index;
pub(crate) mod shared;
pub(crate) mod thumbs;
use crate::{
    kone_sef::{self as sef, Value},
    kone_transport::{KoneProfile, KoneTransport},
};
use index::{plan_runs, SomiIndex};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
const LOGIN: &str = "SOMI_LOGIN_REQUIRED";
/// How far back counts are read again. Votes settle within weeks.
const REFRESH_DAYS: i64 = 90;
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Cursor {
    seconds: i64,
    nanos: u32,
    id: String,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Post {
    id: String,
    seconds: i64,
    nanos: u32,
    title: String,
    writer_handle: String,
    writer_name: String,
    views: i64,
    votes: i64,
    comments: i64,
    cover_key: Option<String>,
    pages: Option<u32>,
    cover: Option<String>,
    bookmarked: bool,
}
pub(crate) struct ListPage {
    items: Vec<Post>,
    count: Option<i64>,
    has_more: bool,
    next_cursor: Option<Cursor>,
    previews: Vec<(String, String)>,
}
#[derive(serde::Serialize)]
pub(crate) struct SearchPage {
    items: Vec<Post>,
    total: i64,
}
#[derive(serde::Serialize)]
pub(crate) struct FilledCover {
    id: String,
    cover: String,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenedPost {
    title: String,
    writer: String,
    page_urls: Vec<String>,
    initial_page: u32,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    logged_in: bool,
    handle: Option<String>,
    display_name: Option<String>,
    collected: i64,
    total: Option<i64>,
    complete: bool,
    syncing: bool,
    sync_error: Option<String>,
}
#[derive(Default)]
pub(crate) struct SomiState {
    index: OnceLock<Mutex<SomiIndex>>,
    profile: Mutex<Option<KoneProfile>>,
    profile_loaded: AtomicBool,
    checked: Mutex<Option<Instant>>,
    epoch: AtomicU64,
    syncing: AtomicBool,
    error: Mutex<Option<String>>,
    opened: Mutex<HashMap<String, (Instant, Result<OpenedPost, String>)>>,
    previews: Mutex<HashMap<String, (Instant, String)>>,
    open_gate: tokio::sync::Mutex<()>,
    thumb_gate: tokio::sync::Mutex<()>,
    fill_generation: AtomicU64,
    fill_gate: tokio::sync::Mutex<()>,
    auth_gate: tokio::sync::Mutex<()>,
    shared_gate: Mutex<shared::SyncGate>,
    shared_generation: AtomicU64,
    shared_debouncing: AtomicBool,
}
fn locked<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    m.lock()
        .map_err(|_| "소미 저장소에 접근할 수 없습니다".into())
}
impl SomiState {
    /// Entry/focus are throttled; local writes bypass the success throttle only.
    pub fn sync_state(
        &self,
        app: &AppHandle,
        local_change: bool,
    ) -> Option<tauri::async_runtime::JoinHandle<()>> {
        if self.require_login().is_err() {
            return None;
        }
        let Ok(mut gate) = self.shared_gate.lock() else {
            return None;
        };
        if !gate.begin(local_change) {
            return None;
        }
        drop(gate);
        let app = app.clone();
        Some(tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<SomiState>();
            let result = (|| {
                let library = app
                    .state::<crate::commands::AppState>()
                    .current_library()
                    .ok_or("라이브러리 없음")?;
                let config = library
                    .cloud_sync_config()
                    .map_err(|_| "클라우드 설정 없음")?;
                let endpoint = config.api_base_url.as_deref().ok_or("클라우드 주소 없음")?;
                let token = crate::library::credential::read_cloud_api_token_os()
                    .map_err(|_| "클라우드 인증 없음")?;
                let client = library
                    .cloud_client(endpoint)
                    .map_err(|_| "클라우드 연결 실패")?;
                let token = token.expose();
                let remote = crate::cloud::client::somi::SomiRemote {
                    client: &client,
                    token: &token,
                };
                shared::reconcile(state.index(&app)?, client.base(), &remote)
            })();
            let pending = state
                .shared_gate
                .lock()
                .map(|mut gate| gate.finish(result))
                .unwrap_or(false);
            if pending {
                state.sync_state(&app, true);
            }
        }))
    }
    pub fn flush_state(&self, app: &AppHandle) {
        self.shared_generation.fetch_add(1, Ordering::AcqRel);
        self.sync_state(app, true);
    }
    fn debounce_state(&self, app: &AppHandle) {
        if self.shared_debouncing.swap(true, Ordering::AcqRel) {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<SomiState>();
            loop {
                let generation = state.shared_generation.load(Ordering::Acquire);
                std::thread::sleep(Duration::from_secs(4));
                if state.shared_generation.load(Ordering::Acquire) != generation {
                    continue;
                }
                state.shared_debouncing.store(false, Ordering::Release);
                state.sync_state(&app, true);
                if state.shared_generation.load(Ordering::Acquire) != generation {
                    state.debounce_state(&app);
                }
                break;
            }
        });
    }
    pub fn toggle_bookmark(&self, app: &AppHandle, id: &str) -> Result<bool, String> {
        self.require_login()?;
        let post = {
            let index = locked(self.index(app)?)?;
            index
                .posts_by_ids(&[id.to_owned()])?
                .into_iter()
                .next()
                .map(Ok)
                .unwrap_or_else(|| index.bookmark_post(id))?
        };
        let bookmarked = locked(self.index(app)?)?.toggle_bookmark(&post)?;
        self.sync_state(app, true);
        if bookmarked {
            let cover = self.cached_cover(&post).ok().flatten();
            let app = app.clone();
            let id = id.to_owned();
            tauri::async_runtime::spawn(async move {
                // Save an already resolved cover immediately, independently of grid fills.
                if let Some(url) = cover.filter(|url| thumbs::key_of(url).is_some()) {
                    let _ =
                        tauri::async_runtime::spawn_blocking(move || thumbs::download(&url)).await;
                } else {
                    // Board-list resolution never calls article/get or counts a view.
                    let _ = app.state::<SomiState>().fill_covers(&app, vec![id]).await;
                }
            });
        }
        Ok(bookmarked)
    }
    fn index(&self, app: &AppHandle) -> Result<&Mutex<SomiIndex>, String> {
        if self.index.get().is_none() {
            let dir = app
                .path()
                .app_local_data_dir()
                .map_err(|_| "소미 저장소에 접근할 수 없습니다")?
                .join("somi");
            std::fs::create_dir_all(dir.join("thumbs"))
                .map_err(|_| "소미 저장소에 접근할 수 없습니다")?;
            thumbs::configure(dir.join("thumbs"));
            let index = SomiIndex::open(&dir.join("somi.db"))?;
            let _ = self.index.set(Mutex::new(index));
        }
        Ok(self.index.get().unwrap())
    }
    fn require_login(&self) -> Result<u64, String> {
        if locked(&self.profile)?.is_some() {
            Ok(self.epoch.load(Ordering::Acquire))
        } else {
            Err(LOGIN.into())
        }
    }
    pub(crate) fn current(&self, epoch: u64) -> bool {
        self.epoch.load(Ordering::Acquire) == epoch && thumbs::AUTHENTICATED.load(Ordering::Acquire)
    }
    fn clear_session(&self, app: &AppHandle) -> Result<(), String> {
        self.epoch.fetch_add(1, Ordering::AcqRel);
        thumbs::AUTHENTICATED.store(false, Ordering::Release);
        *locked(&self.profile)? = None;
        *locked(&self.checked)? = Some(Instant::now());
        locked(self.index(app)?)?.save_profile(None)?;
        self.profile_loaded.store(true, Ordering::Release);
        locked(&self.opened)?.clear();
        locked(&self.previews)?.clear();
        Ok(())
    }
    pub async fn status(&self, app: &AppHandle, collect: bool) -> Result<Status, String> {
        {
            let _guard = self.auth_gate.lock().await;
            if !self.profile_loaded.load(Ordering::Acquire) {
                let profile = locked(self.index(app)?)?.profile()?;
                thumbs::AUTHENTICATED.store(profile.is_some(), Ordering::Release);
                *locked(&self.profile)? = profile;
                self.profile_loaded.store(true, Ordering::Release);
            }
            // Stored profiles never trigger page-data checks, including while offline.
            let refresh = locked(&self.profile)?.is_none()
                && locked(&self.checked)?.is_none_or(|at| {
                    app.get_webview_window("kone-login").is_some()
                        && at.elapsed() >= Duration::from_secs(2)
                });
            if refresh {
                *locked(&self.checked)? = Some(Instant::now());
                let epoch = self.epoch.load(Ordering::Acquire);
                let profile = app.state::<KoneTransport>().profile(app).await;
                if self.epoch.load(Ordering::Acquire) != epoch {
                    return Err(LOGIN.into());
                }
                match profile {
                    Ok(profile) => {
                        if profile.is_none() {
                            self.clear_session(app)?;
                        } else {
                            locked(self.index(app)?)?.save_profile(profile.as_ref())?;
                            *locked(&self.profile)? = profile;
                            thumbs::AUTHENTICATED.store(true, Ordering::Release);
                        }
                        *locked(&self.checked)? = Some(Instant::now());
                    }
                    Err(e) => {
                        return Err(e);
                    }
                }
            }
        }
        let profile = locked(&self.profile)?.clone();
        if collect && profile.is_some() {
            self.start_sync(app, false)?;
        }
        let (collected, total, complete, _) = locked(self.index(app)?)?.progress()?;
        Ok(Status {
            logged_in: profile.is_some(),
            handle: profile.as_ref().map(|p| p.handle.clone()),
            display_name: profile.map(|p| p.display_name),
            collected,
            total,
            complete,
            syncing: self.syncing.load(Ordering::Acquire),
            sync_error: locked(&self.error)?.clone(),
        })
    }
    pub(crate) fn recheck_login(&self) {
        if let Ok(mut checked) = self.checked.lock() {
            *checked = None;
        }
    }
    pub async fn logout(&self, app: &AppHandle) -> Result<(), String> {
        self.clear_session(app)?;
        let _guard = self.auth_gate.lock().await;
        self.clear_session(app)?;
        app.state::<KoneTransport>().logout(app).await
    }
    pub async fn login(&self, app: &AppHandle) -> Result<(), String> {
        *locked(&self.checked)? = None;
        app.state::<KoneTransport>().open_login(app).await
    }
    async fn call(
        &self,
        app: &AppHandle,
        path: &str,
        body: Vec<u8>,
        epoch: u64,
    ) -> Result<Value, String> {
        if !self.current(epoch) {
            return Err(LOGIN.into());
        }
        let response = app
            .state::<KoneTransport>()
            .request(app, "QUERY", path, &body, epoch)
            .await?;
        if !self.current(epoch) {
            return Err(LOGIN.into());
        }
        let decoded = sef::decode(&response.body);
        if response.status >= 300 {
            let code = decoded
                .as_ref()
                .ok()
                .map(|v| v.field(1).text().to_ascii_lowercase())
                .unwrap_or_default();
            if matches!(response.status, 401 | 403)
                || ["auth", "login", "sign", "session", "nsfw", "adult"]
                    .iter()
                    .any(|s| code.contains(s))
            {
                let _guard = self.auth_gate.lock().await;
                if self.current(epoch) {
                    self.clear_session(app)?;
                }
                return Err(LOGIN.into());
            }
            if response.status == 404 {
                return Err("SOMI_POST_GONE".into());
            }
            return Err("코네 요청을 완료할 수 없습니다".into());
        }
        decoded
    }
    async fn list(
        &self,
        app: &AppHandle,
        cursor: Option<&Cursor>,
        limit: u32,
        epoch: u64,
    ) -> Result<ListPage, String> {
        let body = list_request(cursor, limit)?;
        let v = self.call(app, "/v1/article/list", body, epoch).await?;
        let mut items = Vec::new();
        let mut previews = Vec::new();
        if !matches!(v.field(0), Value::Array(_)) {
            return Err("소미 목록 응답 형식 오류".into());
        }
        for value in v.field(0).items() {
            let mut post = read_post(value)?;
            // Empty is a known absence; None means a cover has not yet been observed.
            post.cover_key = Some(thumbs::key_of(value.field(128).text()).unwrap_or_default());
            if thumbs::key_of(value.field(128).text()).is_some() {
                previews.push((post.id.clone(), value.field(128).text().into()));
            }
            items.push(post);
        }
        let has_more = v.field(2) == &Value::Bool(true);
        let next_cursor = if let Value::Timestamp(seconds, nanos) = v.field(3).field(0) {
            Some(Cursor {
                seconds: *seconds,
                nanos: *nanos,
                id: v.field(3).field(1).id()?,
            })
        } else {
            None
        };
        if has_more && (next_cursor.is_none() || items.is_empty()) {
            return Err("소미 수집 위치 응답 오류".into());
        }
        let page = ListPage {
            items,
            count: if matches!(v.field(1), Value::Null) {
                None
            } else {
                Some(v.field(1).number())
            },
            has_more,
            next_cursor,
            previews,
        };
        let mut cache = locked(&self.previews)?;
        cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(540));
        for (id, url) in &page.previews {
            cache.insert(id.clone(), (Instant::now(), url.clone()));
        }
        Ok(page)
    }
    pub fn sync_now(&self, app: &AppHandle) -> Result<(), String> {
        self.require_login()?;
        self.start_sync(app, true)
    }
    fn start_sync(&self, app: &AppHandle, forced: bool) -> Result<(), String> {
        if !locked(self.index(app)?)?.sync_due(chrono::Utc::now().timestamp(), forced)? {
            return Ok(());
        }
        if self
            .syncing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(());
        }
        *locked(&self.error)? = None;
        let epoch = self.epoch.load(Ordering::Acquire);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<SomiState>();
            let result = state.sync(&app, epoch).await;
            if state.current(epoch) {
                *state.error.lock().unwrap() = result.err();
            }
            state.syncing.store(false, Ordering::Release);
        });
        Ok(())
    }
    /// Refresh the head until a known post, then resume the unfinished historical walk.
    async fn sync(&self, app: &AppHandle, epoch: u64) -> Result<(), String> {
        let refresh_since = Some(chrono::Utc::now().timestamp() - REFRESH_DAYS * 86400);
        SomiIndex::sync(
            self.index(app)?,
            |cursor| async move { self.list(app, cursor.as_ref(), 100, epoch).await },
            || self.current(epoch),
            refresh_since,
        )
        .await
    }
    pub async fn search(
        &self,
        app: &AppHandle,
        query: &str,
        sort: &str,
        page: u32,
        days: Option<u32>,
        bookmarked: bool,
    ) -> Result<SearchPage, String> {
        let epoch = self.require_login()?;
        let offset = page.max(1).saturating_sub(1).saturating_mul(60);
        let mut found =
            locked(self.index(app)?)?.search(query, sort, days, offset, 60, bookmarked)?;
        for post in &mut found.items {
            post.cover = self.cached_cover(post)?;
        }
        if !self.current(epoch) {
            return Err(LOGIN.into());
        }
        Ok(found)
    }
    fn cached_cover(&self, post: &Post) -> Result<Option<String>, String> {
        if let Some(key) = post.cover_key.as_deref().filter(|key| thumbs::saved(key)) {
            return Ok(Some(format!("http://lakomics.localhost/somi-thumb/{key}")));
        }
        Ok(locked(&self.previews)?
            .get(&post.id)
            .filter(|(at, _)| at.elapsed() < Duration::from_secs(540))
            .map(|(_, url)| url.clone()))
    }
    fn begin_fill(&self) -> u64 {
        self.fill_generation.fetch_add(1, Ordering::AcqRel) + 1
    }
    fn fill_is_current(&self, generation: u64) -> bool {
        self.fill_generation.load(Ordering::Acquire) == generation
    }
    pub async fn fill_covers(
        &self,
        app: &AppHandle,
        ids: Vec<String>,
    ) -> Result<Vec<FilledCover>, String> {
        let generation = self.begin_fill();
        let epoch = self.require_login()?;
        let _guard = self.fill_gate.lock().await;
        if !self.current(epoch) {
            return Err(LOGIN.into());
        }
        if !self.fill_is_current(generation) {
            return Ok(Vec::new());
        }
        // A fill only owns one visible page, even when the grid has appended older pages.
        let ids = &ids[..ids.len().min(60)];
        let posts = locked(self.index(app)?)?.posts_by_ids(ids)?;
        let mut need = Vec::new();
        for post in &posts {
            if post.cover_key.as_deref().is_some_and(|key| !key.is_empty())
                && self.cached_cover(post)?.is_none()
            {
                need.push(locked(self.index(app)?)?.rank_of(post)?);
            }
        }
        for (from, size) in plan_runs(need) {
            if !self.current(epoch) {
                return Err(LOGIN.into());
            }
            if !self.fill_is_current(generation) {
                return Ok(Vec::new());
            }
            let cursor = if from > 0 {
                locked(self.index(app)?)?.place_at(from - 1)?
            } else {
                None
            };
            let page = self.list(app, cursor.as_ref(), size, epoch).await?;
            if !self.current(epoch) {
                return Err(LOGIN.into());
            }
            if !self.fill_is_current(generation) {
                return Ok(Vec::new());
            }
            locked(self.index(app)?)?.record(&page, false)?;
        }
        let posts = locked(self.index(app)?)?.posts_by_ids(ids)?;
        let mut resolved = Vec::new();
        let mut downloads = Vec::new();
        for post in posts {
            if let Some(cover) = self.cached_cover(&post)? {
                if thumbs::key_of(&cover).is_some() {
                    downloads.push(cover.clone());
                }
                resolved.push(FilledCover { id: post.id, cover });
            }
        }
        if !self.current(epoch) {
            return Err(LOGIN.into());
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<SomiState>();
            let _gate = state.thumb_gate.lock().await;
            for url in downloads {
                if !state.current(epoch) {
                    break;
                }
                let _ = tauri::async_runtime::spawn_blocking(move || thumbs::download(&url)).await;
            }
        });
        Ok(resolved)
    }
    pub async fn open_post(&self, app: &AppHandle, id: &str) -> Result<OpenedPost, String> {
        let _guard = self.open_gate.lock().await;
        let epoch = self.require_login()?;
        let cached = locked(&self.opened)?
            .get(id)
            .filter(|(at, _)| at.elapsed() < Duration::from_secs(480))
            .map(|(_, p)| p.clone());
        if let Some(p) = cached {
            let mut p = p?;
            p.initial_page = locked(self.index(app)?)?.last_page(id)?;
            return Ok(p);
        }
        let value = match self
            .call(app, "/v1/article/get", get_request(id)?, epoch)
            .await
        {
            Ok(v) => v,
            Err(e) => {
                if e == "SOMI_POST_GONE" {
                    locked(self.index(app)?)?.gone(id)?;
                }
                return Err(e);
            }
        };
        let mut page_urls = Vec::new();
        images(value.field(128).field(0), &mut page_urls);
        if page_urls.is_empty() {
            locked(&self.opened)?.insert(id.into(), (Instant::now(), Err("SOMI_NO_IMAGES".into())));
            locked(self.index(app)?)?.set_pages(id, 0)?;
            return Err("SOMI_NO_IMAGES".into());
        }
        let post = read_post(&value)?;
        if post.id != id {
            return Err("소미 게시글 응답 오류".into());
        }
        let mut index = locked(self.index(app)?)?;
        index.record(
            &ListPage {
                items: vec![post.clone()],
                count: None,
                has_more: false,
                next_cursor: None,
                previews: Vec::new(),
            },
            false,
        )?;
        index.set_pages(id, page_urls.len())?;
        let initial_page = index.last_page(id)?;
        let result = OpenedPost {
            title: post.title,
            writer: if post.writer_name.is_empty() {
                post.writer_handle
            } else {
                post.writer_name
            },
            page_urls,
            initial_page,
        };
        let mut cache = locked(&self.opened)?;
        cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(480));
        cache.insert(id.into(), (Instant::now(), Ok(result.clone())));
        Ok(result)
    }
    pub fn save_page(&self, app: &AppHandle, id: &str, page: u32) -> Result<(), String> {
        self.require_login()?;
        locked(self.index(app)?)?.save_page(id, page)?;
        self.shared_generation.fetch_add(1, Ordering::AcqRel);
        self.debounce_state(app);
        Ok(())
    }
}
fn list_request(cursor: Option<&Cursor>, limit: u32) -> Result<Vec<u8>, String> {
    let page = if cursor.is_none() {
        Some(1i32.to_le_bytes().to_vec())
    } else {
        None
    };
    let cursor = cursor
        .map(|c| -> Result<Vec<u8>, String> {
            let mut time = vec![192];
            time.extend(c.seconds.to_le_bytes());
            time.extend(c.nanos.to_le_bytes());
            let mut id = vec![194];
            id.extend(sef::uuid_from_text(&c.id)?);
            Ok(sef::structure(vec![(0, time), (1, id)])[1..].to_vec())
        })
        .transpose()?;
    let pagination = sef::structure(vec![
        (0, sef::optional(26, page)),
        (1, sef::optional(65, cursor)),
        (2, sef::optional(24, None)),
        (
            16,
            sef::optional(26, Some((limit as i32).to_le_bytes().to_vec())),
        ),
    ]);
    Ok(sef::structure(vec![
        (0, sef::optional(49, Some(sef::string_payload("somisoft")))),
        (
            1,
            sef::optional(
                194,
                Some(sef::uuid_from_text("dmXhWHD_fpPMT7WB-R3Pyb")?.to_vec()),
            ),
        ),
        (2, sef::optional(49, None)),
        (3, sef::optional(24, None)),
        (4, sef::optional(24, None)),
        (5, sef::optional(24, None)),
        (6, sef::optional(65, Some(pagination[1..].to_vec()))),
    ]))
}
fn get_request(id: &str) -> Result<Vec<u8>, String> {
    let mut uuid = vec![194];
    uuid.extend(sef::uuid_from_text(id)?);
    Ok(sef::structure(vec![(0, uuid)]))
}
fn read_post(v: &Value) -> Result<Post, String> {
    let (seconds, nanos) = if let Value::Timestamp(s, n) = v.field(80) {
        (*s, *n)
    } else {
        return Err("소미 게시글 날짜 응답 오류".into());
    };
    Ok(Post {
        id: v.field(0).id()?,
        seconds,
        nanos,
        title: v.field(1).text().into(),
        writer_handle: v.field(32).field(16).text().into(),
        writer_name: v.field(32).field(17).text().into(),
        views: v.field(16).number(),
        votes: v.field(17).number(),
        comments: v.field(18).number(),
        cover_key: thumbs::key_of(v.field(128).text()),
        pages: None,
        cover: None,
        bookmarked: false,
    })
}
fn images(nodes: &Value, out: &mut Vec<String>) {
    for node in nodes.items() {
        if matches!(node.named("type").text(), "image" | "image-extended") {
            let attrs = node.named("attrs");
            let source = if attrs.named("source").text().is_empty() {
                attrs.named("src").text()
            } else {
                attrs.named("source").text()
            };
            if thumbs::page_allowed(source) {
                out.push(source.into());
            }
        }
        images(node.named("content"), out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn somi_new_fill_supersedes_previous_runs() {
        let state = SomiState::default();
        let first = state.begin_fill();
        assert!(state.fill_is_current(first));
        let next = state.begin_fill();
        assert!(!state.fill_is_current(first));
        assert!(state.fill_is_current(next));
    }
    // Expected bytes come from the encoder that talks to kone in VCK.
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
    #[test]
    fn kone_requests_match_the_encoder_kone_accepts() {
        assert_eq!(
            hex(&list_request(None, 100).unwrap()),
            "4107100003310108736f6d69736f6674100103c2010196deebbfc17b6ba64fe177217cc4cc10020331001003031800100403180010050318001006034101041000031a0101000000100103410010020318001010031a0164000000"
        );
        let cursor = Cursor {
            seconds: 1792422015,
            nanos: 327023000,
            id: "b01beyIE4BLPH1oH2CtQeb".into(),
        };
        assert_eq!(
            hex(&list_request(Some(&cursor), 7).unwrap()),
            "4107100003310108736f6d69736f6674100103c2010196deebbfc17b6ba64fe177217cc4cc10020331001003031800100403180010050318001006034101041000031a001001034101021000c07f30d66a0000000098f97d131001c201a14e9c1d3a7598961bee891811d47410020318001010031a0107000000"
        );
        assert_eq!(
            hex(&get_request("b01beyIE4BLPH1oH2CtQeb").unwrap()),
            "41011000c201a14e9c1d3a7598961bee891811d474"
        );
    }
}
