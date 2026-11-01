package com.lakomics.mobile;

import java.util.*;

/** Separate, local-first Somi database. SQL and transactions also run in the host SQLite fixture. */
final class SomiStore {
    interface Db {void exec(String sql,Object... args);List<Map<String,Object>> query(String sql,Object... args);void transaction(Runnable work);}
    static final class Cursor {
        final long seconds;final int nanos;final String id;
        Cursor(long s,int n,String i){seconds=s;nanos=n;id=i;}
        String json(){return Json.write(map("seconds",seconds,"nanos",nanos,"id",id));}
        @Override public boolean equals(Object o){return o instanceof Cursor&&((Cursor)o).seconds==seconds&&((Cursor)o).nanos==nanos&&((Cursor)o).id.equals(id);}
        @Override public int hashCode(){return Objects.hash(seconds,nanos,id);}
        @SuppressWarnings("unchecked") static Cursor parse(String text){if(text==null||text.isEmpty())return null;Map<String,Object> v=(Map<String,Object>)Json.parse(text);return new Cursor(n(v,"seconds"),(int)n(v,"nanos"),s(v,"id"));}
    }
    static Map<String,Object> map(Object... pairs){Map<String,Object> v=new LinkedHashMap<>();for(int i=0;i<pairs.length;i+=2)v.put((String)pairs[i],pairs[i+1]);return v;}
    static long n(Map<String,Object> r,String key){Object v=r.get(key);return v instanceof Number?((Number)v).longValue():0;}
    static String s(Map<String,Object> r,String key){Object v=r.get(key);return v instanceof String?(String)v:"";}
    private final Db db;
    SomiStore(Db db){
        this.db=db;
        db.transaction(()->{
            db.exec("CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY,seconds INTEGER NOT NULL,nanos INTEGER NOT NULL,title TEXT NOT NULL,writer_handle TEXT NOT NULL,writer_name TEXT NOT NULL,views INTEGER NOT NULL,votes INTEGER NOT NULL,comments INTEGER NOT NULL,cover_key TEXT,pages INTEGER,gone INTEGER NOT NULL DEFAULT 0,seen_at INTEGER NOT NULL)");
            db.exec("CREATE INDEX IF NOT EXISTS posts_time ON posts(seconds DESC,nanos DESC,id DESC)");
            db.exec("CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),total INTEGER,complete INTEGER NOT NULL DEFAULT 0,resume TEXT,handle TEXT,display_name TEXT,synced_at INTEGER)");
            db.exec("INSERT OR IGNORE INTO state(id) VALUES(1)");
            db.exec("CREATE TABLE IF NOT EXISTS bookmarks(id TEXT PRIMARY KEY,title TEXT NOT NULL,writer_handle TEXT NOT NULL,writer_name TEXT NOT NULL,cover_key TEXT NOT NULL,post_seconds INTEGER NOT NULL,bookmarked INTEGER NOT NULL,changed_at INTEGER NOT NULL,dirty INTEGER NOT NULL)");
            db.exec("CREATE TABLE IF NOT EXISTS reading(id TEXT PRIMARY KEY,page INTEGER NOT NULL,changed_at INTEGER NOT NULL,dirty INTEGER NOT NULL)");
            db.exec("CREATE TABLE IF NOT EXISTS shared(endpoint TEXT PRIMARY KEY,cursor INTEGER NOT NULL DEFAULT 0)");
        });
    }
    synchronized Map<String,Object> state(){return db.query("SELECT * FROM state WHERE id=1").get(0);}
    synchronized void profile(String handle,String name){db.exec("UPDATE state SET handle=?,display_name=? WHERE id=1",handle,name);}
    synchronized boolean loggedIn(){return !s(state(),"handle").isEmpty();}
    synchronized Map<String,Object> status(boolean syncing){Map<String,Object> r=state();return map("loggedIn",loggedIn(),"handle",r.get("handle"),"displayName",r.get("display_name"),"collected",n(db.query("SELECT count(*) AS n FROM posts WHERE gone=0").get(0),"n"),"total",r.get("total"),"complete",n(r,"complete")==1,"syncing",syncing);}
    synchronized boolean due(long now,boolean forced){Map<String,Object> r=state();return forced||n(r,"complete")==0||r.get("synced_at")==null||now-n(r,"synced_at")>=3600;}
    synchronized void synced(long now){db.exec("UPDATE state SET synced_at=? WHERE id=1",now);}
    synchronized Cursor resume(){return Cursor.parse(s(state(),"resume"));}
    synchronized boolean complete(){return n(state(),"complete")==1;}
    synchronized boolean record(List<Map<String,Object>> items,Long total,boolean more,Cursor next,boolean advance,long now){
        final boolean[] known={false};db.transaction(()->{
            for(Map<String,Object> p:items){String id=s(p,"id");known[0]|=!db.query("SELECT id FROM posts WHERE id=?",id).isEmpty();
                db.exec("INSERT INTO posts(id,seconds,nanos,title,writer_handle,writer_name,views,votes,comments,cover_key,seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET seconds=excluded.seconds,nanos=excluded.nanos,title=excluded.title,writer_handle=excluded.writer_handle,writer_name=excluded.writer_name,views=excluded.views,votes=excluded.votes,comments=excluded.comments,cover_key=coalesce(excluded.cover_key,posts.cover_key),gone=0,seen_at=excluded.seen_at",id,n(p,"seconds"),n(p,"nanos"),s(p,"title"),s(p,"writerHandle"),s(p,"writerName"),n(p,"views"),n(p,"votes"),n(p,"comments"),p.get("coverKey"),now);
            }
            if(total!=null)db.exec("UPDATE state SET total=? WHERE id=1",total);
            if(advance)db.exec("UPDATE state SET complete=?,resume=? WHERE id=1",more?0:1,more&&next!=null?next.json():null);
        });return known[0];
    }
    private static final String SOURCE="(SELECT p.*,coalesce(b.bookmarked,0) AS bookmarked,coalesce(b.changed_at,0) AS bookmark_changed FROM posts p LEFT JOIN bookmarks b ON b.id=p.id UNION ALL SELECT b.id,b.post_seconds,0,b.title,b.writer_handle,b.writer_name,0,0,0,b.cover_key,NULL,1,0,b.bookmarked,b.changed_at FROM bookmarks b WHERE NOT EXISTS(SELECT 1 FROM posts p WHERE p.id=b.id))";
    synchronized Map<String,Object> search(String query,String sort,Integer days,int page,boolean bookmarked,long now){
        String order;
        switch(sort){case "added":if(!bookmarked)throw new IllegalArgumentException();order="bookmark_changed DESC,id DESC";break;case "new":order="seconds DESC,nanos DESC,id DESC";break;case "old":order="seconds,nanos,id";break;case "votes":case "views":case "comments":order=sort+" DESC,seconds DESC,nanos DESC,id DESC";break;default:throw new IllegalArgumentException();}
        List<Object> args=new ArrayList<>();String where=bookmarked?"bookmarked=1":"gone=0";
        for(String word:query.toLowerCase(Locale.ROOT).trim().split("\\s+")){if(word.isEmpty())continue;where+=" AND (instr(lower(title),?)>0 OR instr(lower(writer_name),?)>0 OR instr(lower(writer_handle),?)>0)";for(int i=0;i<3;i++)args.add(word);}
        if(days!=null){where+=" AND seconds>=?";args.add(now-days*86400L);}
        long total=n(db.query("SELECT count(*) AS n FROM "+SOURCE+" WHERE "+where,args.toArray()).get(0),"n");args.add(60);args.add(Math.max(0,page-1)*60);
        List<Map<String,Object>> items=new ArrayList<>();for(Map<String,Object> r:db.query("SELECT * FROM "+SOURCE+" WHERE "+where+" ORDER BY "+order+" LIMIT ? OFFSET ?",args.toArray()))items.add(post(r));
        return map("items",items,"total",total);
    }
    private static Map<String,Object> post(Map<String,Object> r){return map("id",r.get("id"),"seconds",r.get("seconds"),"nanos",r.get("nanos"),"title",r.get("title"),"writerHandle",r.get("writer_handle"),"writerName",r.get("writer_name"),"views",r.get("views"),"votes",r.get("votes"),"comments",r.get("comments"),"coverKey",r.get("cover_key"),"pages",r.get("pages"),"cover",null,"bookmarked",n(r,"bookmarked")==1);}
    synchronized Map<String,Object> post(String id){List<Map<String,Object>> rows=db.query("SELECT * FROM "+SOURCE+" WHERE id=?",id);return rows.isEmpty()?null:post(rows.get(0));}
    synchronized long rank(String id){Map<String,Object> p=post(id);if(p==null)return -1;return n(db.query("SELECT count(*) AS n FROM posts WHERE gone=0 AND (seconds>? OR (seconds=? AND nanos>?) OR (seconds=? AND nanos=? AND id>?))",n(p,"seconds"),n(p,"seconds"),n(p,"nanos"),n(p,"seconds"),n(p,"nanos"),id).get(0),"n");}
    synchronized Cursor place(long rank){List<Map<String,Object>> rows=db.query("SELECT id,seconds,nanos FROM posts WHERE gone=0 ORDER BY seconds DESC,nanos DESC,id DESC LIMIT 1 OFFSET ?",rank);if(rows.isEmpty())return null;Map<String,Object> p=rows.get(0);return new Cursor(n(p,"seconds"),(int)n(p,"nanos"),s(p,"id"));}
    static List<int[]> runs(List<Integer> ranks){List<int[]> runs=new ArrayList<>();for(int rank:new TreeSet<>(ranks)){if(runs.isEmpty()){runs.add(new int[]{rank,1});continue;}int[] last=runs.get(runs.size()-1);int end=last[0]+last[1]-1;if(rank-end<=31&&rank-last[0]<100)last[1]=rank-last[0]+1;else runs.add(new int[]{rank,1});}return runs;}
    synchronized void gone(String id){db.exec("UPDATE posts SET gone=1 WHERE id=?",id);}
    synchronized void pages(String id,int pages){db.exec("UPDATE posts SET pages=? WHERE id=?",pages,id);}
    synchronized int page(String id){List<Map<String,Object>> rows=db.query("SELECT page FROM reading WHERE id=?",id);return rows.isEmpty()?1:(int)n(rows.get(0),"page");}
    private long changed(String table,String id,long now){List<Map<String,Object>> rows=db.query("SELECT changed_at FROM "+table+" WHERE id=?",id);return Math.max(now,rows.isEmpty()?0:n(rows.get(0),"changed_at")+1);}
    synchronized void page(String id,int page,long now){db.exec("INSERT OR REPLACE INTO reading VALUES(?,?,?,1)",id,page,changed("reading",id,now));}
    synchronized boolean toggle(String id,long now){Map<String,Object> p=post(id);if(p==null)throw new IllegalArgumentException("소미 게시글이 없습니다");boolean on=!Boolean.TRUE.equals(p.get("bookmarked"));db.exec("INSERT OR REPLACE INTO bookmarks VALUES(?,?,?,?,?,?,?,?,1)",id,s(p,"title"),s(p,"writerHandle"),s(p,"writerName"),s(p,"coverKey"),n(p,"seconds"),on?1:0,changed("bookmarks",id,now));return on;}
    synchronized long cursor(String endpoint){List<Map<String,Object>> rows=db.query("SELECT cursor FROM shared WHERE endpoint=?",endpoint);return rows.isEmpty()?0:n(rows.get(0),"cursor");}
    synchronized List<Map<String,Object>> dirty(){List<Map<String,Object>> rows=new ArrayList<>();for(Map<String,Object> r:db.query("SELECT * FROM bookmarks WHERE dirty=1"))rows.add(bookmarkWire(r));for(Map<String,Object> r:db.query("SELECT * FROM reading WHERE dirty=1"))rows.add(map("kind","progress","postId",s(r,"id"),"page",n(r,"page"),"changedAt",n(r,"changed_at")));return rows;}
    private Map<String,Object> bookmarkWire(Map<String,Object> r){return map("kind","bookmark","postId",s(r,"id"),"bookmarked",n(r,"bookmarked")==1,"title",s(r,"title"),"writerHandle",s(r,"writer_handle"),"writerName",s(r,"writer_name"),"coverKey",s(r,"cover_key"),"postSeconds",n(r,"post_seconds"),"changedAt",n(r,"changed_at"));}
    synchronized void adopt(Map<String,Object> row,Long sentAt){db.transaction(()->apply(row,sentAt));}
    private void apply(Map<String,Object> row,Long sentAt){
        boolean bookmark="bookmark".equals(s(row,"kind"));String table=bookmark?"bookmarks":"reading",id=s(row,"postId");long remote=n(row,"changedAt");
        List<Map<String,Object>> local=db.query("SELECT changed_at FROM "+table+" WHERE id=?",id);long at=local.isEmpty()?-1:n(local.get(0),"changed_at");
        // An in-flight reply cannot acknowledge a newer local edit. Pull ties keep local dirtiness.
        if(remote<at||(remote==at&&(sentAt==null||sentAt!=at)))return;
        if(bookmark)db.exec("INSERT OR REPLACE INTO bookmarks VALUES(?,?,?,?,?,?,?,?,0)",id,s(row,"title"),s(row,"writerHandle"),s(row,"writerName"),s(row,"coverKey"),n(row,"postSeconds"),Boolean.TRUE.equals(row.get("bookmarked"))?1:0,remote);
        else db.exec("INSERT OR REPLACE INTO reading VALUES(?,?,?,0)",id,n(row,"page"),remote);
    }
    synchronized void pull(String endpoint,List<Map<String,Object>> rows,long cursor){db.transaction(()->{for(Map<String,Object> row:rows)apply(row,null);db.exec("INSERT OR REPLACE INTO shared VALUES(?,?)",endpoint,cursor);});}
}
