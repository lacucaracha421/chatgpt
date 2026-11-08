package com.lakomics.mobile;

import android.app.Activity;
import android.content.Intent;
import android.os.CancellationSignal;
import org.json.*;
import java.io.IOException;
import java.net.URI;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/** Main-process Somi coordinator. Kone sessions never cross Binder; only decoded fields reach JS. */
final class SomiRepository {
    static final int LOGIN_REQUEST=0x534f;
    interface Events {void emit(String name,JSONObject detail);}
    private final Activity activity;private final SomiDatabase database;private final SomiStore store;
    private final KoneClient kone;private final CloudClient cloud;private final SecureSettings settings;private final MediaRepository media;private final Events events;
    private final ExecutorService collector=Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService shared=Executors.newSingleThreadScheduledExecutor();
    private ScheduledFuture<?> pageTimer;private volatile boolean syncing,closed;private boolean profileTried,sharedRunning,sharedAgain;
    private long sharedAt,sharedBackoff;private String sharedEndpoint="";
    private final AtomicLong epoch=new AtomicLong(),fillGeneration=new AtomicLong();
    private final Map<String,Preview> previews=new ConcurrentHashMap<>();
    private final Map<String,Opened> opened=new LinkedHashMap<>();
    private final Object openGate=new Object();
    private static final class Preview {final long at=System.currentTimeMillis();final String url;Preview(String u){url=u;}}
    private static final class Opened {final long at=System.currentTimeMillis();final String title,writer,error;final List<String> urls;Opened(String t,String w,List<String> u,String e){title=t;writer=w;urls=u;error=e;}}
    private static final class Page {List<Map<String,Object>> items=new ArrayList<>();Long total;boolean more;SomiStore.Cursor next;}
    SomiRepository(Activity activity,CloudClient cloud,SecureSettings settings,MediaRepository media,Events events){
        this.activity=activity;this.cloud=cloud;this.settings=settings;this.media=media;this.events=events;database=new SomiDatabase(activity);store=new SomiStore(database);kone=new KoneClient(activity);
        profileTried=activity.getPreferences(0).getBoolean("somiLoggedOut",false);
        if(profileTried)store.profile(null,null);
    }
    private static long now(){return System.currentTimeMillis()/1000;}
    private void require()throws IOException{if(closed||!store.loggedIn())throw new IOException("SOMI_LOGIN_REQUIRED");}
    private void current(long e)throws IOException{require();if(epoch.get()!=e)throw new IOException("SOMI_LOGIN_REQUIRED");}
    private void changed(){try{events.emit("lakomics-somi",new JSONObject(store.status(syncing)));}catch(Exception ignored){}}
    private synchronized void clearProfile(){epoch.incrementAndGet();fillGeneration.incrementAndGet();activity.getPreferences(0).edit().putBoolean("somiLoggedOut",true).commit();store.profile(null,null);previews.clear();synchronized(opened){opened.clear();}profileTried=true;changed();}
    private synchronized void expire(long expected){if(epoch.get()==expected)clearProfile();}
    JSONObject status(boolean collect)throws Exception{
        // No periodic profile checks. A remembered login is answered entirely from SQLite.
        boolean probe=false;synchronized(this){if(!store.loggedIn()&&!profileTried){profileTried=true;probe=true;}}
        if(probe)try{readProfile();}catch(Exception ignored){/* No saved profile to clear; the login action remains available. */}if(collect&&store.loggedIn())startCollection(false);if(collect)syncState(false);
        return new JSONObject(store.status(syncing));
    }
    private void readProfile()throws Exception{
        long e=epoch.get();KoneClient.Reply r=kone.call("profile",null);
        if(r.status==401||r.status==403){expire(e);return;}
        if(r.status!=200)throw new IOException("코네에 연결할 수 없습니다");
        JSONObject p=new JSONObject(r.value);String handle=p.optString("handle"),name=p.optString("displayName");
        synchronized(this){if(epoch.get()!=e||closed)return;if(handle.isEmpty()){clearProfile();return;}store.profile(handle,name);activity.getPreferences(0).edit().putBoolean("somiLoggedOut",false).commit();}changed();
    }
    JSONObject login(){activity.runOnUiThread(()->activity.startActivityForResult(new Intent(activity,KoneLoginActivity.class),LOGIN_REQUEST));return new JSONObject();}
    void loginResult(boolean success){if(!success)return;collector.execute(()->{try{readProfile();if(store.loggedIn()){startCollection(false);syncState(false);}}catch(Exception ignored){changed();}});}
    JSONObject logout()throws Exception{
        clearProfile();
        KoneClient.Reply reply=kone.call("logout",null);if(reply.status!=200)throw new IOException("코네 로그아웃을 완료하지 못했습니다");return new JSONObject();
    }
    private Object call(String path,byte[] request,long e)throws Exception{
        current(e);KoneClient.Reply r=kone.call(path,request);current(e);
        if(r.status==401||r.status==403){expire(e);throw new IOException("SOMI_LOGIN_REQUIRED");}
        Object value=null;try{value=SomiSef.decode(android.util.Base64.decode(r.value,android.util.Base64.DEFAULT));}catch(Exception failure){if(r.status>=200&&r.status<300)throw new IOException("소미 응답 형식 오류");}
        if(r.status>=300){String code=SomiSef.text(SomiSef.field(value,1)).toLowerCase(Locale.ROOT);for(String auth:new String[]{"auth","login","sign","session","nsfw","adult"})if(code.contains(auth)){expire(e);throw new IOException("SOMI_LOGIN_REQUIRED");}if(r.status==404)throw new IOException("SOMI_POST_GONE");throw new IOException("코네 요청을 완료할 수 없습니다");}
        if(value==null)throw new IOException("코네에 연결할 수 없습니다");return value;
    }
    private static String key(String url){try{NetworkPolicy.somiImage(url);String p=new URI(url).getPath();if(p!=null&&p.length()>=65){String key=p.substring(1,65);if(key.matches("[a-f0-9]{64}"))return key;}}catch(Exception ignored){}return "";}
    private static Map<String,Object> post(Object v){
        Object time=SomiSef.field(v,80);if(!(time instanceof SomiSef.Stamp))throw SomiSef.invalid();SomiSef.Stamp t=(SomiSef.Stamp)time;Object writer=SomiSef.field(v,32);
        return SomiStore.map("id",SomiSef.id(SomiSef.field(v,0)),"seconds",t.seconds,"nanos",t.nanos,"title",SomiSef.text(SomiSef.field(v,1)),"writerHandle",SomiSef.text(SomiSef.field(writer,16)),"writerName",SomiSef.text(SomiSef.field(writer,17)),"views",SomiSef.number(SomiSef.field(v,16)),"votes",SomiSef.number(SomiSef.field(v,17)),"comments",SomiSef.number(SomiSef.field(v,18)),"coverKey",null);
    }
    private Page list(SomiStore.Cursor cursor,int limit,long e)throws Exception{
        Object v=call("list",SomiSef.list(cursor,limit),e);if(!(SomiSef.field(v,0) instanceof List))throw SomiSef.invalid();Page p=new Page();
        for(Object item:SomiSef.items(SomiSef.field(v,0))){Map<String,Object> row=post(item);String url=SomiSef.text(SomiSef.field(item,128)),key=key(url);row.put("coverKey",key);if(!key.isEmpty())previews.put(SomiStore.s(row,"id"),new Preview(url));p.items.add(row);}
        Object count=SomiSef.field(v,1);p.total=count==null?null:SomiSef.number(count);p.more=Boolean.TRUE.equals(SomiSef.field(v,2));Object next=SomiSef.field(v,3),time=SomiSef.field(next,0);
        if(time instanceof SomiSef.Stamp){SomiSef.Stamp t=(SomiSef.Stamp)time;p.next=new SomiStore.Cursor(t.seconds,t.nanos,SomiSef.id(SomiSef.field(next,1)));}
        if(p.more&&(p.next==null||p.items.isEmpty()||p.next.equals(cursor)))throw new IOException("소미 수집 위치 응답 오류");
        previews.entrySet().removeIf(entry->System.currentTimeMillis()-entry.getValue().at>=540000);return p;
    }
    private boolean record(Page p,boolean advance,long e)throws IOException{synchronized(this){current(e);boolean known=store.record(p.items,p.total,p.more,p.next,advance,now());changed();return known;}}
    synchronized void startCollection(boolean forced){
        if(syncing||closed||!store.loggedIn()||!store.due(now(),forced))return;syncing=true;long e=epoch.get();changed();
        collector.execute(()->{try{
            boolean first=!store.complete()&&store.resume()==null;Page p=list(null,100,e);boolean known=record(p,first,e);
            if(!first){while((!known||recent(p))&&p.more){p=list(p.next,100,e);known=record(p,false,e);}}
            while(!store.complete()){SomiStore.Cursor c=store.resume();if(c==null)break;p=list(c,100,e);record(p,true,e);}
            synchronized(this){current(e);store.synced(now());}
        }catch(Exception ignored){/* Resume point survives; a later entry retries. */}finally{synchronized(this){syncing=false;}changed();}});
    }
    private static boolean recent(Page p){long min=Long.MAX_VALUE;for(Map<String,Object> row:p.items)min=Math.min(min,SomiStore.n(row,"seconds"));return min!=Long.MAX_VALUE&&min>=now()-90*86400L;}
    JSONObject refresh()throws Exception{require();startCollection(true);return new JSONObject(store.status(syncing));}
    JSONObject search(JSONObject p)throws Exception{
        require();String query=p.optString("query","");if(query.length()>2048)throw new IllegalArgumentException();int page=p.optInt("page",1);if(page<1||page>100000)throw new IllegalArgumentException();Integer days=p.isNull("days")?null:p.has("days")?p.getInt("days"):null;if(days!=null&&!Arrays.asList(7,30,90,365).contains(days))throw new IllegalArgumentException();
        Map<String,Object> result=store.search(query,p.optString("sort","new"),days,page,p.optBoolean("bookmarked"),now());
        @SuppressWarnings("unchecked") List<Map<String,Object>> items=(List<Map<String,Object>>)result.get("items");for(Map<String,Object> item:items){String k=SomiStore.s(item,"coverKey");if(!k.isEmpty())try{item.put("cover",media.somiCached(SomiStore.s(item,"id"),k).getString("url"));}catch(Exception ignored){}}
        return new JSONObject(result);
    }
    private static String validId(String id){SomiSef.idBytes(id);return id;}
    JSONArray fill(JSONArray ids,CancellationSignal signal)throws Exception{
        require();if(ids.length()>60)throw new IllegalArgumentException();long generation=fillGeneration.incrementAndGet(),e=epoch.get();List<String> requested=new ArrayList<>();List<Integer> ranks=new ArrayList<>();
        for(int i=0;i<ids.length();i++){String id=validId(ids.getString(i));requested.add(id);Map<String,Object> p=store.post(id);Preview preview=previews.get(id);boolean fresh=preview!=null&&System.currentTimeMillis()-preview.at<540000;if(p!=null&&!SomiStore.s(p,"coverKey").isEmpty()&&!hasCover(p)&&!fresh){long rank=store.rank(id);if(rank>=0)ranks.add((int)rank);}}
        for(int[] run:SomiStore.runs(ranks)){if(generation!=fillGeneration.get())return new JSONArray();signal.throwIfCanceled();Page p=list(run[0]==0?null:store.place(run[0]-1),run[1],e);current(e);if(generation!=fillGeneration.get())return new JSONArray();record(p,false,e);}
        JSONArray result=new JSONArray();for(String id:requested){current(e);if(generation!=fillGeneration.get())return new JSONArray();signal.throwIfCanceled();Map<String,Object> p=store.post(id);if(p==null)continue;String k=SomiStore.s(p,"coverKey");if(k.isEmpty())continue;
            try{JSONObject ticket;try{ticket=media.somiCached(id,k);}catch(Exception missing){Preview preview=previews.get(id);if(preview==null||System.currentTimeMillis()-preview.at>540000)continue;ticket=media.somiImage(id,k,true,preview.url,signal);}current(e);result.put(new JSONObject().put("id",id).put("cover",ticket.getString("url")));}catch(IOException ignored){}
        }return generation==fillGeneration.get()?result:new JSONArray();
    }
    private boolean hasCover(Map<String,Object> p){try{media.somiCached(SomiStore.s(p,"id"),SomiStore.s(p,"coverKey"));return true;}catch(Exception ignored){return false;}}
    private static void images(Object nodes,List<String> out){for(Object node:SomiSef.items(nodes)){String type=SomiSef.text(SomiSef.field(node,"type"));if(type.equals("image")||type.equals("image-extended")){Object attrs=SomiSef.field(node,"attrs");String url=SomiSef.text(SomiSef.field(attrs,"source"));if(url.isEmpty())url=SomiSef.text(SomiSef.field(attrs,"src"));try{NetworkPolicy.somiImage(url);out.add(url);}catch(Exception ignored){}}images(SomiSef.field(node,"content"),out);}}
    // Since 2026-11, kone sends the body as typed nodes: ImageNode keeps its address in field 2.
    private static void imageNodes(Object v,List<String> out){if(v instanceof SomiSef.Union){SomiSef.Union u=(SomiSef.Union)v;String url=SomiSef.text(SomiSef.field(u.value,2));if(u.name.equals("ImageNode"))try{NetworkPolicy.somiImage(url);out.add(url);}catch(Exception ignored){}imageNodes(u.value,out);}else if(v instanceof List)for(Object x:(List<?>)v)imageNodes(x,out);else if(v instanceof Map)for(Object x:((Map<?,?>)v).values())imageNodes(x,out);}
    JSONObject open(String raw)throws Exception{synchronized(openGate){return openPost(raw);}}
    private JSONObject openPost(String raw)throws Exception{
        String id=validId(raw);require();long e=epoch.get();Opened result;
        synchronized(opened){result=opened.get(id);if(result!=null&&System.currentTimeMillis()-result.at>=480000){opened.remove(id);result=null;}}
        if(result==null){Object v;try{v=call("get",SomiSef.get(id),e);}catch(IOException error){if("SOMI_POST_GONE".equals(error.getMessage()))store.gone(id);throw error;}
            Map<String,Object> p=post(v);if(!id.equals(p.get("id")))throw SomiSef.invalid();List<String> urls=new ArrayList<>();images(SomiSef.field(SomiSef.field(v,128),0),urls);if(urls.isEmpty())imageNodes(SomiSef.field(v,128),urls);if(urls.size()>2000)throw SomiSef.invalid();
            current(e);store.record(Collections.singletonList(p),null,false,null,false,now());store.pages(id,urls.size());result=new Opened(SomiStore.s(p,"title"),SomiStore.s(p,"writerName").isEmpty()?SomiStore.s(p,"writerHandle"):SomiStore.s(p,"writerName"),urls,urls.isEmpty()?"SOMI_NO_IMAGES":"");
            synchronized(opened){opened.entrySet().removeIf(entry->System.currentTimeMillis()-entry.getValue().at>=480000);opened.put(id,result);while(opened.size()>24)opened.remove(opened.keySet().iterator().next());}
        }
        current(e);if(!result.error.isEmpty())throw new IOException(result.error);JSONArray pages=new JSONArray();for(int i=0;i<result.urls.size();i++)pages.put(new JSONObject().put("index",i).put("url","").put("name",JSONObject.NULL).put("width",JSONObject.NULL).put("height",JSONObject.NULL).put("expiresAt",JSONObject.NULL));
        return new JSONObject().put("title",result.title).put("writer",result.writer).put("initialPage",Math.min(store.page(id),result.urls.size())).put("manifest",new JSONObject().put("provider","somi").put("providerWorkId",id).put("publicationRevision",Long.toString(result.at)).put("manifestExpiresAt",JSONObject.NULL).put("pages",pages));
    }
    JSONObject image(String raw,int index,CancellationSignal signal)throws Exception{
        String id=validId(raw);require();long e=epoch.get();Opened r;synchronized(opened){r=opened.get(id);}if(r==null||index<0||index>=r.urls.size())throw new IOException("소미 읽기 화면을 다시 열어 주세요");JSONObject ticket=media.somiImage(id,ThumbnailCache.key(r.urls.get(index)),false,r.urls.get(index),signal);current(e);return ticket;
    }
    JSONObject toggle(String raw)throws Exception{String id=validId(raw);require();boolean on=store.toggle(id,System.currentTimeMillis());syncState(true);changed();return new JSONObject().put("bookmarked",on);}
    JSONObject savePage(String raw,int page)throws Exception{String id=validId(raw);require();if(page<1||page>1000000)throw new IllegalArgumentException();store.page(id,page,System.currentTimeMillis());synchronized(this){if(pageTimer!=null)pageTimer.cancel(false);pageTimer=shared.schedule(()->syncState(true),4,TimeUnit.SECONDS);}return new JSONObject();}
    synchronized void syncState(boolean local){
        if(closed)return;if(sharedRunning){if(local)sharedAgain=true;return;}long now=System.currentTimeMillis();if(now<sharedBackoff||(!local&&now-sharedAt<60000))return;sharedRunning=true;sharedAt=now;
        shared.execute(()->{boolean success=false;try{reconcile();success=true;}catch(Exception failure){long delay=failure instanceof CloudClient.HttpFailure&&((CloudClient.HttpFailure)failure).status==404?3600000:60000;synchronized(this){sharedBackoff=System.currentTimeMillis()+delay;}}finally{boolean again;synchronized(this){sharedRunning=false;again=success&&sharedAgain;sharedAgain=false;}if(success)events.emit("lakomics-somi-state",new JSONObject());if(again)syncState(true);}});
    }
    @SuppressWarnings("unchecked") private void reconcile()throws Exception{
        JSONObject connection=settings.read();String endpoint=connection.optString("endpoint");if(!connection.has("token"))throw new IOException();
        synchronized(this){if(!sharedEndpoint.equals(endpoint)){sharedEndpoint=endpoint;sharedBackoff=0;}}
        for(Map<String,Object> row:store.dirty()){
            String kind=SomiStore.s(row,"kind"),id=SomiStore.s(row,"postId");Map<String,Object> body=new LinkedHashMap<>(row);body.remove("kind");body.remove("postId");
            JSONObject winner=cloud.apiFor(connection,"/v1/somi/"+(kind.equals("bookmark")?"bookmarks/":"progress/")+id,"PUT",new JSONObject(body),new CancellationSignal());
            store.adopt((Map<String,Object>)Json.parse(winner.toString()),SomiStore.n(row,"changedAt"));
        }
        boolean more;do{long cursor=store.cursor(endpoint);JSONObject page=cloud.apiFor(connection,"/v1/somi/state?since="+cursor+"&limit=200","GET",null,new CancellationSignal());Map<String,Object> value=(Map<String,Object>)Json.parse(page.toString());store.pull(endpoint,(List<Map<String,Object>>)value.get("items"),SomiStore.n(value,"nextRevision"));more=Boolean.TRUE.equals(value.get("hasMore"));}while(more&&!closed);
    }
    void resume(){syncState(false);}
    void flush(){synchronized(this){if(pageTimer!=null)pageTimer.cancel(false);}syncState(true);}
    void close(){synchronized(this){closed=true;epoch.incrementAndGet();fillGeneration.incrementAndGet();}collector.shutdownNow();shared.shutdownNow();kone.close();synchronized(store){database.close();}}
}
