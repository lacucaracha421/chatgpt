use super::{
    index::{db_error, SomiIndex},
    locked, Post,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct SyncGate {
    running: bool,
    attempted: Option<std::time::Instant>,
    retry_after: Option<std::time::Instant>,
    pending: bool,
}
impl SyncGate {
    pub fn begin(&mut self, local: bool) -> bool {
        let now = std::time::Instant::now();
        if self.running {
            self.pending |= local;
            return false;
        }
        if self.retry_after.is_some_and(|at| now < at)
            || (!local && self.attempted.is_some_and(|at| at.elapsed().as_secs() < 60))
        {
            return false;
        }
        self.running = true;
        self.attempted = Some(now);
        true
    }
    pub fn finish(&mut self, result: Result<bool, String>) -> bool {
        self.running = false;
        let pending = std::mem::take(&mut self.pending) && result == Ok(true);
        self.retry_after = match result {
            Ok(true) => None,
            Ok(false) => Some(std::time::Instant::now() + std::time::Duration::from_secs(3600)),
            Err(_) => Some(std::time::Instant::now() + std::time::Duration::from_secs(60)),
        };
        pending
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Fields {
    #[serde(rename_all = "camelCase")]
    Bookmark {
        bookmarked: bool,
        title: String,
        writer_handle: String,
        writer_name: String,
        cover_key: String,
        post_seconds: i64,
    },
    Progress {
        page: u32,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Row {
    pub post_id: String,
    pub changed_at: i64,
    pub revision: i64,
    #[serde(flatten)]
    pub fields: Fields,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Changes {
    pub items: Vec<Row>,
    pub next_revision: i64,
    pub latest_revision: i64,
    pub has_more: bool,
}
pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 22
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
impl Row {
    pub fn valid(&self) -> bool {
        valid_id(&self.post_id)
            && self.changed_at >= 0
            && self.revision >= 0
            && match &self.fields {
                Fields::Progress { page } => (1..=1_000_000).contains(page),
                Fields::Bookmark {
                    title,
                    writer_handle,
                    writer_name,
                    cover_key,
                    post_seconds,
                    ..
                } => {
                    title.chars().count() <= 1024
                        && writer_handle.chars().count() <= 256
                        && writer_name.chars().count() <= 256
                        && (cover_key.is_empty() || super::thumbs::valid_key(cover_key))
                        && *post_seconds >= 0
                        && [title, writer_handle, writer_name]
                            .iter()
                            .all(|s| !s.chars().any(|c| (c as u32) < 32))
                }
            }
    }
    pub fn kind(&self) -> &'static str {
        match self.fields {
            Fields::Bookmark { .. } => "bookmarks",
            Fields::Progress { .. } => "progress",
        }
    }
    pub fn body(&self) -> serde_json::Value {
        let mut value = serde_json::to_value(self).unwrap();
        for name in ["kind", "postId", "revision"] {
            value.as_object_mut().unwrap().remove(name);
        }
        value
    }
}
impl SomiIndex {
    pub fn toggle_bookmark(&self, post: &Post) -> Result<bool, String> {
        if !valid_id(&post.id) {
            return Err("소미 게시글 번호 오류".into());
        }
        let current: Option<(bool, i64)> = self
            .db
            .query_row(
                "SELECT bookmarked,changed_at FROM bookmarks WHERE id=?",
                [&post.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        let bookmarked = !current.is_some_and(|(value, _)| value);
        let changed_at = chrono::Utc::now()
            .timestamp_millis()
            .max(current.map_or(0, |(_, at)| at + 1));
        let row = Row {
            post_id: post.id.clone(),
            changed_at,
            revision: 0,
            fields: Fields::Bookmark {
                bookmarked,
                title: post.title.clone(),
                writer_handle: post.writer_handle.clone(),
                writer_name: post.writer_name.clone(),
                cover_key: post.cover_key.clone().unwrap_or_default(),
                post_seconds: post.seconds,
            },
        };
        if !row.valid() {
            return Err("소미 북마크 정보 오류".into());
        }
        self.db.execute("INSERT INTO bookmarks VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,writer_handle=excluded.writer_handle,writer_name=excluded.writer_name,cover_key=excluded.cover_key,post_seconds=excluded.post_seconds,bookmarked=excluded.bookmarked,changed_at=excluded.changed_at,dirty=1",
            params![post.id,post.title,post.writer_handle,post.writer_name,post.cover_key.as_deref().unwrap_or_default(),post.seconds,bookmarked,changed_at]).map_err(db_error)?;
        Ok(bookmarked)
    }
    pub fn bookmark_post(&self, id: &str) -> Result<Post, String> {
        self.db.query_row("SELECT id,post_seconds,0,title,writer_handle,writer_name,0,0,0,cover_key,NULL,bookmarked FROM bookmarks WHERE id=?", [id], SomiIndex::read_post).map_err(db_error)
    }
    pub fn dirty_rows(&self) -> Result<Vec<Row>, String> {
        let mut rows = Vec::new();
        let mut stmt = self.db.prepare("SELECT id,title,writer_handle,writer_name,cover_key,post_seconds,bookmarked,changed_at FROM bookmarks WHERE dirty=1 ORDER BY changed_at LIMIT 200").map_err(db_error)?;
        for row in stmt
            .query_map([], |r| {
                Ok(Row {
                    post_id: r.get(0)?,
                    changed_at: r.get(7)?,
                    revision: 0,
                    fields: Fields::Bookmark {
                        title: r.get(1)?,
                        writer_handle: r.get(2)?,
                        writer_name: r.get(3)?,
                        cover_key: r.get(4)?,
                        post_seconds: r.get(5)?,
                        bookmarked: r.get(6)?,
                    },
                })
            })
            .map_err(db_error)?
        {
            rows.push(row.map_err(db_error)?);
        }
        let mut stmt = self.db.prepare("SELECT id,last_page,changed_at FROM reading WHERE dirty=1 ORDER BY changed_at LIMIT 200").map_err(db_error)?;
        for row in stmt
            .query_map([], |r| {
                Ok(Row {
                    post_id: r.get(0)?,
                    changed_at: r.get(2)?,
                    revision: 0,
                    fields: Fields::Progress { page: r.get(1)? },
                })
            })
            .map_err(db_error)?
        {
            rows.push(row.map_err(db_error)?);
        }
        Ok(rows)
    }
    /// A response may acknowledge the sent timestamp, but never a newer local edit.
    pub fn apply_shared(&self, row: &Row, acknowledge: bool) -> Result<(), String> {
        if !row.valid() {
            return Err("소미 동기화 응답 오류".into());
        }
        match &row.fields {
            Fields::Bookmark {
                bookmarked,
                title,
                writer_handle,
                writer_name,
                cover_key,
                post_seconds,
            } => {
                self.db.execute("INSERT INTO bookmarks VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0) ON CONFLICT(id) DO UPDATE SET title=excluded.title,writer_handle=excluded.writer_handle,writer_name=excluded.writer_name,cover_key=excluded.cover_key,post_seconds=excluded.post_seconds,bookmarked=excluded.bookmarked,changed_at=excluded.changed_at,dirty=0 WHERE excluded.changed_at>bookmarks.changed_at OR (?9 AND excluded.changed_at=bookmarks.changed_at)", params![row.post_id,title,writer_handle,writer_name,cover_key,post_seconds,bookmarked,row.changed_at,acknowledge]).map_err(db_error)?;
            }
            Fields::Progress { page } => {
                self.db.execute("INSERT INTO reading(id,last_page,updated_at,changed_at,dirty) VALUES(?1,?2,?3/1000,?3,0) ON CONFLICT(id) DO UPDATE SET last_page=excluded.last_page,updated_at=excluded.updated_at,changed_at=excluded.changed_at,dirty=0 WHERE excluded.changed_at>reading.changed_at OR (?4 AND excluded.changed_at=reading.changed_at)", params![row.post_id,page,row.changed_at,acknowledge]).map_err(db_error)?;
            }
        }
        Ok(())
    }
    pub fn shared_cursor(&self, endpoint: &str) -> Result<i64, String> {
        Ok(self
            .db
            .query_row(
                "SELECT revision FROM sync_cursor WHERE endpoint=?",
                [endpoint],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?
            .unwrap_or(0))
    }
    fn apply_changes(
        &mut self,
        endpoint: &str,
        changes: &Changes,
        since: i64,
    ) -> Result<(), String> {
        if changes.next_revision < since
            || changes.latest_revision < changes.next_revision
            || (changes.has_more && changes.next_revision == since)
            || changes.items.len() > 200
        {
            return Err("소미 동기화 위치 오류".into());
        }
        let mut previous = since;
        for row in &changes.items {
            if row.revision <= previous || row.revision > changes.next_revision || !row.valid() {
                return Err("소미 동기화 응답 오류".into());
            }
            previous = row.revision;
        }
        self.db
            .execute_batch("SAVEPOINT somi_pull")
            .map_err(db_error)?;
        let result = (|| {
            for row in &changes.items {
                self.apply_shared(row, false)?;
            }
            self.db.execute("INSERT INTO sync_cursor VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET revision=excluded.revision", params![endpoint,changes.next_revision]).map_err(db_error)?;
            Ok::<_, String>(())
        })();
        if result.is_err() {
            let _ = self.db.execute_batch("ROLLBACK TO somi_pull");
        }
        self.db
            .execute_batch("RELEASE somi_pull")
            .map_err(db_error)?;
        result
    }
}

pub(crate) trait Remote {
    /// None means the routes do not exist on this server yet.
    fn push(&self, row: &Row) -> Result<Option<Row>, String>;
    fn pull(&self, since: i64) -> Result<Option<Changes>, String>;
}
pub(crate) fn reconcile(
    index: &Mutex<SomiIndex>,
    endpoint: &str,
    remote: &impl Remote,
) -> Result<bool, String> {
    // Never hold SQLite/the UI's mutex during network IO.
    loop {
        let rows = locked(index)?.dirty_rows()?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let Some(winner) = remote.push(&row)? else {
                return Ok(false);
            };
            if winner.post_id != row.post_id
                || winner.kind() != row.kind()
                || winner.changed_at < row.changed_at
            {
                return Err("소미 동기화 응답 오류".into());
            }
            locked(index)?.apply_shared(&winner, true)?;
        }
    }
    loop {
        let since = locked(index)?.shared_cursor(endpoint)?;
        let Some(changes) = remote.pull(since)? else {
            return Ok(false);
        };
        locked(index)?.apply_changes(endpoint, &changes, since)?;
        if !changes.has_more {
            return Ok(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "abcdefghijklmnopqrstuv";
    fn index() -> SomiIndex {
        SomiIndex::open(std::path::Path::new(":memory:")).unwrap()
    }
    fn bookmark(at: i64, saved: bool) -> Row {
        Row {
            post_id: ID.into(),
            changed_at: at,
            revision: 1,
            fields: Fields::Bookmark {
                bookmarked: saved,
                title: "Stored title".into(),
                writer_handle: "writer".into(),
                writer_name: "Writer".into(),
                cover_key: String::new(),
                post_seconds: 123,
            },
        }
    }
    struct Offline;
    impl Remote for Offline {
        fn push(&self, _: &Row) -> Result<Option<Row>, String> {
            Err("offline".into())
        }
        fn pull(&self, _: i64) -> Result<Option<Changes>, String> {
            panic!("failed push must keep cursor")
        }
    }
    #[test]
    fn somi_failed_push_keeps_dirty_and_cursor() {
        let db = index();
        db.apply_shared(&bookmark(100, true), false).unwrap();
        db.toggle_bookmark(&db.bookmark_post(ID).unwrap()).unwrap();
        let rows = db.dirty_rows().unwrap();
        assert_eq!(rows.len(), 1);
        let db = Mutex::new(db);
        assert!(reconcile(&db, "server", &Offline).is_err());
        assert_eq!(db.lock().unwrap().dirty_rows().unwrap(), rows);
        assert_eq!(db.lock().unwrap().shared_cursor("server").unwrap(), 0);
    }
    #[test]
    fn somi_pull_lww_missing_posts_and_tombstones() {
        let mut db = index();
        let newer = bookmark(200, true);
        db.apply_shared(&newer, false).unwrap();
        db.db.execute("UPDATE bookmarks SET dirty=1", []).unwrap();
        let stale = bookmark(100, false);
        db.apply_changes(
            "server",
            &Changes {
                items: vec![stale],
                next_revision: 1,
                latest_revision: 1,
                has_more: false,
            },
            0,
        )
        .unwrap();
        assert_eq!(
            db.search("Stored", "added", None, 0, 60, true)
                .unwrap()
                .items[0]
                .id,
            ID
        );
        assert_eq!(db.dirty_rows().unwrap().len(), 1);
        let mut removed = bookmark(300, false);
        removed.revision = 2;
        db.apply_changes(
            "server",
            &Changes {
                items: vec![removed],
                next_revision: 2,
                latest_revision: 2,
                has_more: false,
            },
            1,
        )
        .unwrap();
        assert_eq!(db.search("", "added", None, 0, 60, true).unwrap().total, 0);
        assert!(db.dirty_rows().unwrap().is_empty());
        assert_eq!(db.shared_cursor("server").unwrap(), 2);
        assert_eq!(db.shared_cursor("other-server").unwrap(), 0);
        let progress = Row {
            post_id: ID.into(),
            changed_at: 300,
            revision: 3,
            fields: Fields::Progress { page: 7 },
        };
        db.apply_shared(&progress, false).unwrap();
        db.apply_shared(
            &Row {
                changed_at: 200,
                fields: Fields::Progress { page: 2 },
                ..progress.clone()
            },
            false,
        )
        .unwrap();
        assert_eq!(db.last_page(ID).unwrap(), 7);
        // A response to an older in-flight push cannot erase a newer local edit.
        db.db
            .execute("UPDATE reading SET changed_at=400,dirty=1,last_page=9", [])
            .unwrap();
        db.apply_shared(&progress, true).unwrap();
        assert_eq!(db.last_page(ID).unwrap(), 9);
        assert_eq!(db.dirty_rows().unwrap().len(), 1);
    }
    #[test]
    fn somi_bookmarks_added_order_and_filters() {
        let db = index();
        db.apply_shared(&bookmark(100, true), false).unwrap();
        let mut next = bookmark(200, true);
        next.post_id = "abcdefghijklmnopqrstuw".into();
        db.apply_shared(&next, false).unwrap();
        let result = db.search("Writer", "added", None, 0, 60, true).unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.items[0].id, next.post_id);
        assert!(result.items[0].bookmarked);
        assert_eq!(
            db.search("", "added", Some(7), 0, 60, true).unwrap().total,
            0
        );
        assert_eq!(db.search("", "new", None, 0, 60, false).unwrap().total, 0);
    }
    #[test]
    fn somi_404_and_failures_back_off_without_losing_rows() {
        struct Missing;
        impl Remote for Missing {
            fn push(&self, _: &Row) -> Result<Option<Row>, String> {
                Ok(None)
            }
            fn pull(&self, _: i64) -> Result<Option<Changes>, String> {
                Ok(None)
            }
        }
        let db = Mutex::new(index());
        let mut gate = SyncGate::default();
        assert!(gate.begin(false));
        let result = reconcile(&db, "old-server", &Missing);
        assert_eq!(result, Ok(false));
        gate.finish(result);
        assert!(!gate.begin(false));
        assert!(!gate.begin(true));
        let mut failed = SyncGate::default();
        assert!(failed.begin(false));
        failed.finish(Err("missing credential".into()));
        assert!(!failed.begin(true));
    }
}
