use super::{Cursor, ListPage, Post, SearchPage};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub(crate) struct SomiIndex {
    pub(super) db: Connection,
}
pub(super) fn db_error(_: rusqlite::Error) -> String {
    "소미 목차를 읽거나 저장할 수 없습니다".into()
}
impl SomiIndex {
    pub async fn sync<F, Fut, Continue>(
        index: &std::sync::Mutex<Self>,
        mut list: F,
        may_go_on: Continue,
        refresh_since: Option<i64>,
    ) -> Result<(), String>
    where
        F: FnMut(Option<Cursor>) -> Fut,
        Fut: std::future::Future<Output = Result<ListPage, String>>,
        Continue: Fn() -> bool,
    {
        use super::locked;
        if !may_go_on() {
            return Ok(());
        }
        let (_, _, complete, resume) = locked(index)?.progress()?;
        let first_walk = !complete && resume.is_none();
        let mut page = list(None).await?;
        if !may_go_on() {
            return Ok(());
        }
        let mut known = locked(index)?.record(&page, first_walk)?;
        if !first_walk {
            // Counts on known posts only change when they are read again, so a refresh walks
            // past the first known post down to `refresh_since`.
            let reaches_back = |page: &ListPage| {
                refresh_since.is_some_and(|since| {
                    page.items.iter().map(|post| post.seconds).min() >= Some(since)
                })
            };
            while (!known || reaches_back(&page)) && page.has_more && may_go_on() {
                let cursor = page.next_cursor.clone();
                let next = list(cursor.clone()).await?;
                if !may_go_on() {
                    return Ok(());
                }
                if next.next_cursor == cursor && next.has_more {
                    return Err("소미 수집 위치가 진행되지 않습니다".into());
                }
                known = locked(index)?.record(&next, false)?;
                page = next;
            }
        }
        while may_go_on() {
            let (_, _, complete, resume) = locked(index)?.progress()?;
            if complete {
                break;
            }
            let Some(cursor) = resume else {
                break;
            };
            let page = list(Some(cursor.clone())).await?;
            if !may_go_on() {
                return Ok(());
            }
            if page.next_cursor.as_ref() == Some(&cursor) && page.has_more {
                return Err("소미 수집 위치가 진행되지 않습니다".into());
            }
            locked(index)?.record(&page, true)?;
        }
        if may_go_on() {
            locked(index)?.mark_synced(chrono::Utc::now().timestamp())?;
        }
        Ok(())
    }
    pub fn open(path: &Path) -> Result<Self, String> {
        let db = Connection::open(path).map_err(db_error)?;
        db.execute_batch("PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY,seconds INTEGER NOT NULL,nanos INTEGER NOT NULL,title TEXT NOT NULL,writer_handle TEXT NOT NULL,writer_name TEXT NOT NULL,views INTEGER NOT NULL,votes INTEGER NOT NULL,comments INTEGER NOT NULL,cover_key TEXT,pages INTEGER,gone INTEGER NOT NULL DEFAULT 0,seen_at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS posts_place ON posts(seconds DESC,nanos DESC,id DESC);
          CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),total INTEGER,complete INTEGER NOT NULL DEFAULT 0,resume TEXT);
          INSERT OR IGNORE INTO state(id) VALUES(1);
          CREATE TABLE IF NOT EXISTS reading(id TEXT PRIMARY KEY,last_page INTEGER NOT NULL,updated_at INTEGER NOT NULL);").map_err(db_error)?;
        let columns = db
            .prepare("PRAGMA table_info(state)")
            .map_err(db_error)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        for (name, kind) in [
            ("handle", "TEXT"),
            ("display_name", "TEXT"),
            ("synced_at", "INTEGER"),
        ] {
            if !columns.iter().any(|column| column == name) {
                db.execute_batch(&format!("ALTER TABLE state ADD COLUMN {name} {kind}"))
                    .map_err(db_error)?;
            }
        }
        let columns = db
            .prepare("PRAGMA table_info(reading)")
            .map_err(db_error)?
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        for (name, kind) in [
            ("changed_at", "INTEGER NOT NULL DEFAULT 0"),
            ("dirty", "INTEGER NOT NULL DEFAULT 1"),
        ] {
            if !columns.iter().any(|c| c == name) {
                db.execute_batch(&format!("ALTER TABLE reading ADD COLUMN {name} {kind}"))
                    .map_err(db_error)?;
            }
        }
        db.execute(
            "UPDATE reading SET changed_at=updated_at*1000 WHERE changed_at=0",
            [],
        )
        .map_err(db_error)?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS bookmarks(id TEXT PRIMARY KEY,title TEXT NOT NULL,writer_handle TEXT NOT NULL,writer_name TEXT NOT NULL,cover_key TEXT NOT NULL,post_seconds INTEGER NOT NULL,bookmarked INTEGER NOT NULL,changed_at INTEGER NOT NULL,dirty INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS sync_cursor(endpoint TEXT PRIMARY KEY,revision INTEGER NOT NULL);").map_err(db_error)?;
        Ok(Self { db })
    }
    pub fn profile(&self) -> Result<Option<super::KoneProfile>, String> {
        self.db
            .query_row(
                "SELECT handle,display_name FROM state WHERE id=1",
                [],
                |row| {
                    let handle: Option<String> = row.get(0)?;
                    let display_name: Option<String> = row.get(1)?;
                    Ok(handle
                        .zip(display_name)
                        .map(|(handle, display_name)| super::KoneProfile {
                            handle,
                            display_name,
                        }))
                },
            )
            .map_err(db_error)
    }
    pub fn save_profile(&self, profile: Option<&super::KoneProfile>) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE state SET handle=?,display_name=? WHERE id=1",
                params![profile.map(|p| &p.handle), profile.map(|p| &p.display_name)],
            )
            .map_err(db_error)?;
        Ok(())
    }
    pub fn sync_due(&self, now: i64, forced: bool) -> Result<bool, String> {
        self.db
            .query_row(
                "SELECT complete,synced_at FROM state WHERE id=1",
                [],
                |row| {
                    let complete: bool = row.get(0)?;
                    let synced_at: Option<i64> = row.get(1)?;
                    Ok(forced || !complete || synced_at.is_none_or(|at| now - at >= 3600))
                },
            )
            .map_err(db_error)
    }
    pub fn mark_synced(&self, now: i64) -> Result<(), String> {
        self.db
            .execute("UPDATE state SET synced_at=? WHERE id=1", [now])
            .map_err(db_error)?;
        Ok(())
    }
    pub fn progress(&self) -> Result<(i64, Option<i64>, bool, Option<Cursor>), String> {
        let count = self
            .db
            .query_row("SELECT count(*) FROM posts WHERE gone=0", [], |r| r.get(0))
            .map_err(db_error)?;
        let (total, complete, resume): (Option<i64>, bool, Option<String>) = self
            .db
            .query_row(
                "SELECT total,complete,resume FROM state WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(db_error)?;
        let resume = resume
            .map(|s| serde_json::from_str(&s).map_err(|_| "소미 수집 위치를 읽을 수 없습니다"))
            .transpose()?;
        Ok((count, total, complete, resume))
    }
    /// Page rows and the resume point commit together; a crash replays at most one page.
    pub fn record(&mut self, page: &ListPage, advance: bool) -> Result<bool, String> {
        let tx = self.db.transaction().map_err(db_error)?;
        let mut known = false;
        for post in &page.items {
            known |= tx
                .query_row("SELECT 1 FROM posts WHERE id=?", [&post.id], |r| {
                    r.get::<_, i32>(0)
                })
                .optional()
                .map_err(db_error)?
                .is_some();
            tx.execute("INSERT INTO posts(id,seconds,nanos,title,writer_handle,writer_name,views,votes,comments,cover_key,seen_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,unixepoch()) ON CONFLICT(id) DO UPDATE SET seconds=excluded.seconds,nanos=excluded.nanos,title=excluded.title,writer_handle=excluded.writer_handle,writer_name=excluded.writer_name,views=excluded.views,votes=excluded.votes,comments=excluded.comments,cover_key=COALESCE(excluded.cover_key,posts.cover_key),gone=0,seen_at=excluded.seen_at",params![post.id,post.seconds,post.nanos,post.title,post.writer_handle,post.writer_name,post.views,post.votes,post.comments,post.cover_key]).map_err(db_error)?;
        }
        if let Some(total) = page.count {
            tx.execute("UPDATE state SET total=? WHERE id=1", [total])
                .map_err(db_error)?;
        }
        if advance {
            let resume = page
                .next_cursor
                .as_ref()
                .filter(|_| page.has_more)
                .map(serde_json::to_string)
                .transpose()
                .map_err(|_| "소미 수집 위치 오류")?;
            tx.execute(
                "UPDATE state SET complete=?,resume=? WHERE id=1",
                params![!page.has_more, resume],
            )
            .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(known)
    }
    pub fn search(
        &self,
        query: &str,
        sort: &str,
        days: Option<u32>,
        offset: u32,
        limit: u32,
        bookmarked: bool,
    ) -> Result<SearchPage, String> {
        let order = match sort {
            "added" if bookmarked => "bookmark_changed DESC,id DESC",
            "new" => "seconds DESC,nanos DESC,id DESC",
            "old" => "seconds,nanos,id",
            "votes" => "votes DESC,seconds DESC,nanos DESC,id DESC",
            "views" => "views DESC,seconds DESC,nanos DESC,id DESC",
            "comments" => "comments DESC,seconds DESC,nanos DESC,id DESC",
            _ => return Err("소미 정렬 방식 오류".into()),
        };
        // Stored bookmark metadata keeps missing and gone posts available in this view.
        let source = "(SELECT p.id,p.seconds,p.nanos,p.title,p.writer_handle,p.writer_name,p.views,p.votes,p.comments,p.cover_key,p.pages,p.gone,COALESCE(b.bookmarked,0) AS bookmarked,COALESCE(b.changed_at,0) AS bookmark_changed FROM posts p LEFT JOIN bookmarks b ON b.id=p.id
            UNION ALL SELECT b.id,b.post_seconds,0,b.title,b.writer_handle,b.writer_name,0,0,0,b.cover_key,NULL,1,b.bookmarked,b.changed_at FROM bookmarks b WHERE NOT EXISTS(SELECT 1 FROM posts p WHERE p.id=b.id))";
        let mut filter = if bookmarked { "bookmarked=1" } else { "gone=0" }.to_string();
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        for word in query.split_whitespace() {
            filter.push_str(" AND (instr(lower(title),?)>0 OR instr(lower(writer_name),?)>0 OR instr(lower(writer_handle),?)>0)");
            for _ in 0..3 {
                args.push(word.to_lowercase().into());
            }
        }
        if let Some(days) = days {
            filter.push_str(" AND seconds>=unixepoch()-?*86400");
            args.push(days.into());
        }
        let total = self
            .db
            .query_row(
                &format!("SELECT count(*) FROM {source} WHERE {filter}"),
                rusqlite::params_from_iter(&args),
                |r| r.get(0),
            )
            .map_err(db_error)?;
        args.push(limit.into());
        args.push(offset.into());
        let mut stmt=self.db.prepare(&format!("SELECT id,seconds,nanos,title,writer_handle,writer_name,views,votes,comments,cover_key,pages,bookmarked FROM {source} WHERE {filter} ORDER BY {order} LIMIT ? OFFSET ?")).map_err(db_error)?;
        let items = stmt
            .query_map(rusqlite::params_from_iter(&args), |r| Self::read_post(r))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(SearchPage { items, total })
    }
    pub(super) fn read_post(r: &rusqlite::Row<'_>) -> rusqlite::Result<Post> {
        Ok(Post {
            id: r.get(0)?,
            seconds: r.get(1)?,
            nanos: r.get(2)?,
            title: r.get(3)?,
            writer_handle: r.get(4)?,
            writer_name: r.get(5)?,
            views: r.get(6)?,
            votes: r.get(7)?,
            comments: r.get(8)?,
            cover_key: r.get(9)?,
            pages: r.get(10)?,
            cover: None,
            bookmarked: r.get(11)?,
        })
    }
    pub fn posts_by_ids(&self, ids: &[String]) -> Result<Vec<Post>, String> {
        let mut stmt = self.db.prepare("SELECT id,seconds,nanos,title,writer_handle,writer_name,views,votes,comments,cover_key,pages,COALESCE((SELECT bookmarked FROM bookmarks b WHERE b.id=posts.id),0) FROM posts WHERE gone=0 AND id=?").map_err(db_error)?;
        let mut posts = Vec::new();
        for id in ids {
            if let Some(post) = stmt
                .query_row([id], Self::read_post)
                .optional()
                .map_err(db_error)?
            {
                posts.push(post);
            }
        }
        Ok(posts)
    }
    pub fn rank_of(&self, post: &Post) -> Result<u32, String> {
        self.db
            .query_row(
                "SELECT count(*) FROM posts WHERE gone=0 AND (seconds,nanos,id)>(?,?,?)",
                params![post.seconds, post.nanos, post.id],
                |r| r.get(0),
            )
            .map_err(db_error)
    }
    pub fn place_at(&self, rank: u32) -> Result<Option<Cursor>, String> {
        self.db.query_row("SELECT seconds,nanos,id FROM posts WHERE gone=0 ORDER BY seconds DESC,nanos DESC,id DESC LIMIT 1 OFFSET ?",[rank],|r|Ok(Cursor{seconds:r.get(0)?,nanos:r.get(1)?,id:r.get(2)?})).optional().map_err(db_error)
    }
    pub fn gone(&self, id: &str) -> Result<(), String> {
        self.db
            .execute("UPDATE posts SET gone=1 WHERE id=?", [id])
            .map_err(db_error)?;
        Ok(())
    }
    pub fn set_pages(&self, id: &str, n: usize) -> Result<(), String> {
        self.db
            .execute("UPDATE posts SET pages=? WHERE id=?", params![n as i64, id])
            .map_err(db_error)?;
        Ok(())
    }
    pub fn last_page(&self, id: &str) -> Result<u32, String> {
        Ok(self
            .db
            .query_row("SELECT last_page FROM reading WHERE id=?", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db_error)?
            .unwrap_or(1))
    }
    pub fn save_page(&self, id: &str, page: u32) -> Result<(), String> {
        self.db.execute("INSERT INTO reading(id,last_page,updated_at,changed_at,dirty) SELECT id,min(max(?1,1),pages),unixepoch(),max(?3,COALESCE((SELECT changed_at+1 FROM reading r WHERE r.id=posts.id),0)),1 FROM posts WHERE id=?2 AND pages>0 ON CONFLICT(id) DO UPDATE SET last_page=excluded.last_page,updated_at=excluded.updated_at,changed_at=excluded.changed_at,dirty=1",params![page,id,chrono::Utc::now().timestamp_millis()]).map_err(db_error)?;
        Ok(())
    }
}
pub(crate) fn plan_runs(mut ranks: Vec<u32>) -> Vec<(u32, u32)> {
    ranks.sort_unstable();
    ranks.dedup();
    let mut out: Vec<(u32, u32)> = Vec::new();
    for rank in ranks {
        if let Some((from, size)) = out.last_mut() {
            if rank - (*from + *size - 1) <= 31 && rank - *from < 100 {
                *size = rank - *from + 1;
                continue;
            }
        }
        out.push((rank, 1));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn somi_stored_profile_survives_reopen_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("somi.db");
        let db = SomiIndex::open(&path).unwrap();
        db.save_profile(Some(&super::super::KoneProfile {
            handle: "reader".into(),
            display_name: "Reader".into(),
        }))
        .unwrap();
        drop(db);
        let db = SomiIndex::open(&path).unwrap();
        let profile = db.profile().unwrap().unwrap();
        assert_eq!(
            (profile.handle.as_str(), profile.display_name.as_str()),
            ("reader", "Reader")
        );
        db.save_profile(None).unwrap();
        drop(db);
        assert!(SomiIndex::open(&path).unwrap().profile().unwrap().is_none());
    }
    #[test]
    fn somi_old_schema_upgrade_keeps_posts_and_resume() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("somi.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1),total INTEGER,complete INTEGER NOT NULL DEFAULT 0,resume TEXT);
            INSERT INTO state VALUES(1,12,0,'{\"seconds\":7,\"nanos\":0,\"id\":\"old\"}');
            CREATE TABLE posts(id TEXT PRIMARY KEY,seconds INTEGER NOT NULL,nanos INTEGER NOT NULL,title TEXT NOT NULL,writer_handle TEXT NOT NULL,writer_name TEXT NOT NULL,views INTEGER NOT NULL,votes INTEGER NOT NULL,comments INTEGER NOT NULL,cover_key TEXT,pages INTEGER,gone INTEGER NOT NULL DEFAULT 0,seen_at INTEGER NOT NULL);
            INSERT INTO posts VALUES('old',7,0,'Saved post','writer','Writer',10,2,1,NULL,8,0,7);
            CREATE TABLE reading(id TEXT PRIMARY KEY,last_page INTEGER NOT NULL,updated_at INTEGER NOT NULL);
            INSERT INTO reading VALUES('old',6,123);").unwrap();
        drop(db);
        let db = SomiIndex::open(&path).unwrap();
        let (count, total, complete, resume) = db.progress().unwrap();
        assert_eq!((count, total, complete), (1, Some(12), false));
        assert_eq!(resume.unwrap().id, "old");
        assert_eq!(db.last_page("old").unwrap(), 6);
        assert_eq!(db.dirty_rows().unwrap()[0].changed_at, 123000);
        assert_eq!(
            db.search("", "new", None, 0, 60, false).unwrap().items[0].pages,
            Some(8)
        );
        assert!(db.profile().unwrap().is_none());
        assert!(db.sync_due(10000, false).unwrap());
    }
    #[test]
    fn somi_hourly_sync_gate_persists_and_only_success_advances_it() {
        use std::{future::ready, sync::Mutex};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("somi.db");
        let db = SomiIndex::open(&path).unwrap();
        let now = chrono::Utc::now().timestamp();
        assert!(db.sync_due(now, false).unwrap());
        db.mark_synced(now).unwrap();
        assert!(db.sync_due(now + 1, false).unwrap()); // Incomplete collection.
        db.db.execute("UPDATE state SET complete=1", []).unwrap();
        assert!(!db.sync_due(now + 3599, false).unwrap());
        assert!(db.sync_due(now + 3600, false).unwrap());
        assert!(db.sync_due(now + 1, true).unwrap());
        drop(db);
        let db = Mutex::new(SomiIndex::open(&path).unwrap());
        assert!(!db.lock().unwrap().sync_due(now + 1, false).unwrap());
        db.lock().unwrap().mark_synced(now - 3600).unwrap();
        let result = tauri::async_runtime::block_on(SomiIndex::sync(
            &db,
            |_| ready(Err("offline".into())),
            || true,
            Some(now - 90 * 86400),
        ));
        assert!(result.is_err());
        assert!(db.lock().unwrap().sync_due(now, false).unwrap());
        tauri::async_runtime::block_on(SomiIndex::sync(
            &db,
            |_| {
                ready(Ok(ListPage {
                    items: vec![],
                    count: Some(0),
                    has_more: false,
                    next_cursor: None,
                    previews: vec![],
                }))
            },
            || true,
            Some(now - 90 * 86400),
        ))
        .unwrap();
        assert!(!db.lock().unwrap().sync_due(now, false).unwrap());
    }
    #[test]
    fn somi_sync_resumes_after_failure_then_stops_at_known_post() {
        use std::{collections::VecDeque, future::ready, sync::Mutex};
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("somi.db");
        let cursor = Cursor {
            seconds: 2,
            nanos: 0,
            id: "b".into(),
        };
        let make_head = || ListPage {
            items: vec![post("a", 3, "새 책", 1), post("b", 2, "옛 책", 5)],
            count: Some(3),
            has_more: true,
            next_cursor: Some(cursor.clone()),
            previews: Vec::new(),
        };
        let db = Mutex::new(SomiIndex::open(&path).unwrap());
        let mut replies = VecDeque::from([Ok(make_head()), Err("connection lost".to_string())]);
        let result = tauri::async_runtime::block_on(SomiIndex::sync(
            &db,
            |_| ready(replies.pop_front().unwrap()),
            || true,
            None,
        ));
        assert!(result.is_err());
        drop(db);
        let db = Mutex::new(SomiIndex::open(&path).unwrap());
        assert_eq!(
            db.lock().unwrap().progress().unwrap().3,
            Some(cursor.clone())
        );
        let last = ListPage {
            items: vec![post("c", 1, "마지막", 3)],
            count: None,
            has_more: false,
            next_cursor: None,
            previews: Vec::new(),
        };
        let mut replies = VecDeque::from([Ok(make_head()), Ok(last)]);
        let mut calls = Vec::new();
        tauri::async_runtime::block_on(SomiIndex::sync(
            &db,
            |cursor| {
                calls.push(cursor);
                ready(replies.pop_front().unwrap())
            },
            || true,
            None,
        ))
        .unwrap();
        assert_eq!(calls, vec![None, Some(cursor.clone())]);
        assert!(db.lock().unwrap().progress().unwrap().2);
        let mut calls = 0;
        tauri::async_runtime::block_on(SomiIndex::sync(
            &db,
            |_| {
                calls += 1;
                ready(Ok(make_head()))
            },
            || true,
            None,
        ))
        .unwrap();
        assert_eq!(calls, 1);
        let mut calls = 0;
        tauri::async_runtime::block_on(SomiIndex::sync(
            &db,
            |_| {
                calls += 1;
                ready(Ok(make_head()))
            },
            || false,
            None,
        ))
        .unwrap();
        assert_eq!(calls, 0);
    }
    #[test]
    fn somi_refresh_rereads_known_posts_down_to_its_window() {
        use std::{collections::VecDeque, future::ready, sync::Mutex};
        let page = |seconds: i64, more: bool| ListPage {
            items: vec![post(&format!("p{seconds}"), seconds, "책", 1)],
            count: None,
            has_more: more,
            next_cursor: more.then(|| Cursor {
                seconds,
                nanos: 0,
                id: format!("p{seconds}"),
            }),
            previews: Vec::new(),
        };
        let db = Mutex::new(SomiIndex::open(Path::new(":memory:")).unwrap());
        for seconds in [30, 20, 10] {
            db.lock()
                .unwrap()
                .record(&page(seconds, false), true)
                .unwrap();
        }
        let mut replies = VecDeque::from([page(30, true), page(20, true), page(10, true)]);
        let mut calls = 0;
        tauri::async_runtime::block_on(SomiIndex::sync(
            &db,
            |_| {
                calls += 1;
                ready(Ok(replies.pop_front().unwrap()))
            },
            || true,
            Some(15),
        ))
        .unwrap();
        assert_eq!(calls, 3);
    }
    #[test]
    fn somi_period_keeps_only_recent_posts() {
        let mut db = SomiIndex::open(Path::new(":memory:")).unwrap();
        let now = chrono::Utc::now().timestamp();
        db.record(
            &ListPage {
                items: vec![
                    post("recent", now - 86400, "새", 1),
                    post("old", now - 40 * 86400, "옛", 9),
                ],
                count: None,
                has_more: false,
                next_cursor: None,
                previews: Vec::new(),
            },
            true,
        )
        .unwrap();
        let month = db.search("", "votes", Some(30), 0, 10, false).unwrap();
        assert_eq!((month.total, month.items[0].id.as_str()), (1, "recent"));
        assert_eq!(
            db.search("", "votes", None, 0, 10, false).unwrap().items[0].id,
            "old"
        );
    }
    fn post(id: &str, seconds: i64, title: &str, votes: i64) -> Post {
        Post {
            id: id.into(),
            seconds,
            nanos: 0,
            title: title.into(),
            writer_handle: "writer".into(),
            writer_name: "작가".into(),
            views: 10 - votes,
            votes,
            comments: votes,
            cover_key: None,
            pages: None,
            cover: None,
            bookmarked: false,
        }
    }
    #[test]
    fn somi_resume_known_search_sorts_and_position() {
        let mut db = SomiIndex::open(Path::new(":memory:")).unwrap();
        let cursor = Cursor {
            seconds: 2,
            nanos: 0,
            id: "b".into(),
        };
        let first = ListPage {
            items: vec![post("a", 3, "새 책", 1), post("b", 2, "옛 책", 5)],
            count: Some(3),
            has_more: true,
            next_cursor: Some(cursor.clone()),
            previews: Vec::new(),
        };
        assert!(!db.record(&first, true).unwrap());
        assert_eq!(db.progress().unwrap().3, Some(cursor));
        assert!(db.record(&first, false).unwrap());
        assert!(!db.progress().unwrap().2);
        db.record(
            &ListPage {
                items: vec![post("c", 1, "옛 작품", 3)],
                count: None,
                has_more: false,
                next_cursor: None,
                previews: Vec::new(),
            },
            true,
        )
        .unwrap();
        assert!(db.progress().unwrap().2);
        assert!(db.progress().unwrap().3.is_none());
        assert_eq!(
            db.search("옛 작가", "votes", None, 0, 10, false)
                .unwrap()
                .items
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "c"]
        );
        for (sort, id) in [
            ("new", "a"),
            ("old", "c"),
            ("votes", "b"),
            ("views", "a"),
            ("comments", "b"),
        ] {
            assert_eq!(
                db.search("", sort, None, 0, 1, false).unwrap().items[0].id,
                id
            );
        }
        assert_eq!(db.search("%", "new", None, 0, 10, false).unwrap().total, 0);
        db.set_pages("a", 7).unwrap();
        db.save_page("a", 4).unwrap();
        assert_eq!(db.last_page("a").unwrap(), 4);
        db.gone("b").unwrap();
        assert_eq!(
            db.search("", "votes", None, 0, 10, false).unwrap().items[0].id,
            "c"
        );
    }
    #[test]
    fn somi_cover_runs_use_bounded_ranges() {
        assert_eq!(
            plan_runs(vec![202, 2, 0, 2, 100, 101]),
            vec![(0, 3), (100, 2), (202, 1)]
        );
    }
}
