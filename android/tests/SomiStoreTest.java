package com.lakomics.mobile;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Runs the shipped schema, transactions, searches and conflict rules on real SQLite. */
public final class SomiStoreTest {
    private static int checks;
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);checks++;}
    private static final String A="aaaaaaaaaaaaaaaaaaaaab",B="aaaaaaaaaaaaaaaaaaaaac",C="aaaaaaaaaaaaaaaaaaaaad";
    private static final long NOW=1792422015L;
    private static Map<String,Object> post(String id,long seconds,String title,String writer,long votes){return SomiStore.map("id",id,"seconds",seconds,"nanos",0,"title",title,"writerHandle",writer,"writerName",writer,"views",votes*2,"votes",votes,"comments",votes*3,"coverKey","");}
    @SuppressWarnings("unchecked") private static List<Map<String,Object>> items(Map<String,Object> page){return (List<Map<String,Object>>)page.get("items");}
    private static final class Sqlite implements SomiStore.Db,AutoCloseable {
        final Process process;final BufferedWriter input;final BufferedReader output;boolean fail;
        Sqlite(Path file)throws Exception{
            String script="import sqlite3,json,sys\nsys.stdin.reconfigure(encoding='utf-8')\nsys.stdout.reconfigure(encoding='utf-8')\nc=sqlite3.connect(sys.argv[1],isolation_level=None)\nc.row_factory=sqlite3.Row\nfor line in sys.stdin:\n try:\n  q=json.loads(line); r=c.execute(q['sql'],q['args']); print(json.dumps([dict(v) for v in r] if q['query'] else []),flush=True)\n except Exception as e: print(json.dumps({'error':str(e)}),flush=True)\n";
            String python=System.getenv("PYTHON");if(python==null||python.isEmpty())python="python3";
            process=new ProcessBuilder(python,"-I","-u","-c",script,file.toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();input=new BufferedWriter(new OutputStreamWriter(process.getOutputStream(),StandardCharsets.UTF_8));output=new BufferedReader(new InputStreamReader(process.getInputStream(),StandardCharsets.UTF_8));
        }
        @SuppressWarnings("unchecked") private List<Map<String,Object>> request(String sql,boolean query,Object... args){try{
            if(fail&&sql.startsWith("UPDATE state SET complete")){fail=false;throw new IllegalStateException("Fixture interrupted page commit");}
            input.write(Json.write(SomiStore.map("sql",sql,"query",query,"args",Arrays.asList(args))));input.newLine();input.flush();String line=output.readLine();if(line==null)throw new IOException("SQLite fixture stopped");Object reply=Json.parse(line);if(reply instanceof Map)throw new IllegalStateException(reply.toString());return (List<Map<String,Object>>)reply;
        }catch(IOException failure){throw new IllegalStateException(failure);}}
        public void exec(String sql,Object... args){request(sql,false,args);}
        public List<Map<String,Object>> query(String sql,Object... args){return request(sql,true,args);}
        public void transaction(Runnable work){exec("BEGIN");try{work.run();exec("COMMIT");}catch(RuntimeException error){exec("ROLLBACK");throw error;}}
        public void close()throws Exception{input.close();if(process.waitFor()!=0)throw new AssertionError("SQLite fixture failed");output.close();}
    }
    public static void main(String[] args)throws Exception{
        Path directory=Files.createTempDirectory(Paths.get("build"),"somi-store-"),file=directory.resolve("somi.sqlite3");
        try{
            SomiStore.Cursor resume=new SomiStore.Cursor(NOW,2,A);
            try(Sqlite db=new Sqlite(file)){
                SomiStore store=new SomiStore(db);check(!store.loggedIn(),"new schema is logged out");check(store.due(NOW,false),"first collection is due");
                store.profile("handle","이름");store.record(Collections.singletonList(post(A,NOW,"소미 첫 글","작가",2)),3L,true,resume,true,NOW);
                check(resume.equals(store.resume()),"page and resume commit together");check(!store.complete(),"partial collection remains incomplete");
            }
            try(Sqlite db=new Sqlite(file)){
                SomiStore store=new SomiStore(db);check(store.loggedIn(),"profile survives restart");check(resume.equals(store.resume()),"collection resumes after restart without schema upgrade");
                db.fail=true;try{store.record(Collections.singletonList(post(B,NOW-86400,"두 번째","다른 작가",20)),3L,false,null,true,NOW);throw new AssertionError("fixture should interrupt");}catch(IllegalStateException expected){}
                check(store.post(B)==null&&resume.equals(store.resume()),"interrupted page rolls back both rows and resume");
                check(!store.record(Arrays.asList(post(B,NOW-86400,"두 번째","다른 작가",20),post(C,NOW-100*86400,"오래된 글","작가",100)),3L,false,null,true,NOW),"new page is not known");
                check(store.complete()&&store.resume()==null,"last page completes collection");check(store.record(Collections.singletonList(post(A,NOW,"소미 첫 글","작가",3)),3L,true,resume,false,NOW),"refresh identifies first known post");check(store.complete(),"cover/refresh list does not reset collection");store.synced(NOW);
                check(SomiStore.n(store.search("","votes",null,1,false,NOW),"total")==3,"all posts searchable");
                check(items(store.search("글 작가","new",null,1,false,NOW)).size()==2,"every search word matches title or writer");
                check(items(store.search("","votes",7,1,false,NOW)).get(0).get("id").equals(B),"period excludes old popular post and keeps votes order");
                check(items(store.search("","old",null,1,false,NOW)).get(0).get("id").equals(C),"oldest first");
                check(store.rank(A)==0&&store.place(1).id.equals(B),"cover ranks and cursors use board order");
                check(SomiStore.runs(new ArrayList<>(Arrays.asList(0,7,120))).size()==2,"nearby covers share a bounded list run");
                store.toggle(A,1000);store.toggle(B,1001);check(items(store.search("","added",null,1,true,NOW)).get(0).get("id").equals(B),"bookmark added order");
                store.page(A,8,1000);Map<String,Object> sent=store.dirty().stream().filter(r->r.get("kind").equals("progress")).findFirst().get();store.page(A,9,1000);store.adopt(sent,1000L);check(store.page(A)==9,"in-flight acknowledgement cannot erase a newer local page");
                Map<String,Object> winner=SomiStore.map("kind","progress","postId",A,"page",12,"changedAt",2000L);store.adopt(winner,null);check(store.page(A)==12,"newer shared progress wins");check(store.dirty().stream().noneMatch(r->r.get("kind").equals("progress")),"remote winner clears progress dirtiness");
                Map<String,Object> remote=SomiStore.map("kind","bookmark","postId","aaaaaaaaaaaaaaaaaaaaae","title","공유 북마크","writerHandle","writer","writerName","이름","coverKey","","postSeconds",NOW,"bookmarked",true,"changedAt",3000L);
                store.pull("https://one",Arrays.asList(remote),7);check(store.cursor("https://one")==7&&store.cursor("https://two")==0,"shared cursor is endpoint scoped");
                check(items(store.search("공유","added",null,1,true,NOW)).size()==1,"shared-only bookmark retains metadata without board index");
                remote.put("bookmarked",false);remote.put("changedAt",3001L);store.pull("https://one",Arrays.asList(remote),8);check(items(store.search("공유","added",null,1,true,NOW)).isEmpty(),"newer bookmark tombstone wins");
                store.profile(null,null);check(!store.loggedIn()&&items(store.search("","added",null,1,true,NOW)).size()==2,"logout retains bookmarks for the next login");
            }
            try(Sqlite db=new Sqlite(file)){
                SomiStore store=new SomiStore(db);check(!store.due(NOW+3599,false)&&store.due(NOW+3600,false),"hourly gate survives restart");check(store.due(NOW+1,true),"explicit refresh bypasses hourly gate");check(store.page(A)==12,"shared progress survives restart");
            }
            System.out.println("SomiStoreTest: "+checks+" checks passed");
        }finally{Files.deleteIfExists(file);Files.delete(directory);}
    }
}
