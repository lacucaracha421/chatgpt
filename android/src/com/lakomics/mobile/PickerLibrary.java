package com.lakomics.mobile;

import android.content.Context;
import android.net.Uri;
import android.os.*;
import android.provider.MediaStore;
import android.util.AtomicFile;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;

/** Private complete metadata replica. Provider queries never perform network I/O. */
final class PickerLibrary {
    static final String AUTHORITY="com.lakomics.mobile.cloud";
    private static PickerLibrary instance;
    static synchronized PickerLibrary get(Context context){if(instance==null)instance=new PickerLibrary(context);return instance;}
    private final Context context;
    private final SecureSettings settings;
    private final CloudClient client;
    private final AtomicFile file;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private volatile PickerSnapshot snapshot=PickerSnapshot.empty();
    private long epoch=0,lastAttempt=0;
    private CancellationSignal active;
    private boolean running=false;
    private int scanned=0;
    private String error="",connection="";
    private PickerLibrary(Context c){context=c.getApplicationContext();settings=new SecureSettings(context);client=new CloudClient(settings);file=new AtomicFile(new File(context.getNoBackupFilesDir(),"picker-library.json"));load();}
    // The encrypted settings envelope is an opaque local connection revision, never returned or logged.
    private String revision(){return context.getSharedPreferences("connection",0).getString("encrypted","");}
    private void load(){try{connection=revision();if(connection.isEmpty())return;try(InputStream in=file.openRead()){ByteArrayOutputStream out=new ByteArrayOutputStream();CloudClient.copy(in,out,96L*1024*1024,null);JSONObject o=new JSONObject(out.toString("UTF-8"));if(!o.getString("connection").equals(connection))return;snapshot=decode(o);}}catch(Exception ignored){file.delete();}}
    synchronized JSONObject status(){try{return new JSONObject().put("syncing",running).put("scanned",scanned).put("mediaCount",snapshot.media.size()).put("albumCount",snapshot.albums.size()).put("lastSyncedAt",snapshot.syncedAt).put("error",error).put("ready",snapshot.syncedAt>0);}catch(JSONException e){throw new IllegalStateException(e);}}
    PickerSnapshot current(){refresh(false);return snapshot;}
    synchronized void refresh(boolean force){
        if(running)return;String current=revision();if(current.isEmpty())return;
        if(!current.equals(connection)){reset();connection=current;}
        long now=System.currentTimeMillis();if(!force&&now-lastAttempt<15L*60*1000)return;
        running=true;scanned=0;error="";lastAttempt=now;long attempt=epoch;String revision=current;CancellationSignal signal=new CancellationSignal();active=signal;
        worker.execute(()->sync(attempt,revision,signal));
    }
    /** Call under CONNECTION_LOCK after settings write/clear, before exposing the new connection. */
    synchronized void reset(){epoch++;if(active!=null)active.cancel();active=null;running=false;lastAttempt=0;scanned=0;error="";connection=revision();snapshot=PickerSnapshot.empty();file.delete();notifyPicker();}
    private void check(long attempt,String revision,CancellationSignal signal){signal.throwIfCanceled();synchronized(this){if(attempt!=epoch||!revision.equals(revision()))throw new OperationCanceledException();}}
    private void sync(long attempt,String revision,CancellationSignal signal){
        try{
            long deadline=SystemClock.elapsedRealtime()+10L*60*1000;
            check(attempt,revision,signal);JSONArray classes=client.api("/v1/library/classifications","GET",null,signal).getJSONArray("items");
            if(classes.length()>10000)throw new IOException("Classification bound exceeded");
            Map<String,String> parents=new HashMap<>(),names=new TreeMap<>();
            for(int i=0;i<classes.length();i++){JSONObject o=classes.getJSONObject(i);String id=o.getString("id");names.put(id,o.optString("name",id));parents.put(id,o.isNull("parent_id")?null:o.optString("parent_id",null));}
            Map<String,String> albums=new TreeMap<>();for(String id:names.keySet())albums.put("class:"+id,PickerSnapshot.breadcrumb(id,parents,names));
            Map<String,PickerSnapshot.Media> rows=new TreeMap<>();Set<String> cursors=new HashSet<>();String cursor="";int total=0;
            for(int page=0;;page++){
                check(attempt,revision,signal);if(page>=2000||SystemClock.elapsedRealtime()>deadline)throw new IOException("Refresh bound exceeded");
                JSONObject response=client.api("/v1/library/assets?limit=100"+(cursor.isEmpty()?"":"&cursor="+Uri.encode(cursor)),"GET",null,signal);JSONArray items=response.getJSONArray("items");
                if(items.length()>100||(total+=items.length())>PickerSnapshot.MAX_ITEMS)throw new IOException("Library bound exceeded");
                for(int i=0;i<items.length();i++){JSONObject o=items.getJSONObject(i);PickerSnapshot.Media m=media(o);if(m!=null){if(rows.put(m.id,m)!=null)throw new IOException("Unstable page traversal");}}
                synchronized(this){check(attempt,revision,signal);scanned=total;}
                cursor=response.isNull("next_cursor")?"":response.optString("next_cursor","");
                if(cursor.isEmpty()){if(response.optBoolean("has_more",false))throw new IOException("Incomplete page");break;}
                if(items.length()==0||cursor.length()>7000||!cursors.add(cursor))throw new IOException("Invalid page continuation");
            }
            check(attempt,revision,signal);PickerSnapshot next=snapshot.merge(rows,albums,System.currentTimeMillis());byte[] encoded=encode(next,revision);
            synchronized(this){check(attempt,revision,signal);save(encoded);snapshot=next;error="";}
            notifyPicker();
        }catch(Exception e){synchronized(this){if(epoch==attempt)error=e instanceof OperationCanceledException?"":"Library refresh failed. Previous library remains available; retry from Lakomics.";}}
        finally{synchronized(this){if(epoch==attempt){running=false;active=null;}}}
    }
    private static long date(JSONObject o){for(String key:new String[]{"collected_at","committed_at","source_published_at"}){String value=o.optString(key,"");try{return Math.max(0,Instant.parse(value).toEpochMilli());}catch(Exception ignored){}try{return Math.max(0,LocalDateTime.parse(value.replace(' ','T')).toInstant(ZoneOffset.UTC).toEpochMilli());}catch(Exception ignored){}}return 0;}
    private static PickerSnapshot.Media media(JSONObject o)throws JSONException {
        String id=o.getString("id"),mime=o.optString("content_type","").toLowerCase(Locale.ROOT);long size=o.optLong("size_bytes",0);
        if(!id.matches("[A-Za-z0-9_-]{1,200}")||!mime.matches("(image|video)/[a-z0-9.+_-]+")||size<=0||!o.optBoolean("committed",false)||!o.optBoolean("original_available",false))return null;
        Set<String> albums=new TreeSet<>();JSONArray ids=o.optJSONArray("classification_ids");if(ids!=null)for(int j=0;j<ids.length();j++)albums.add("class:"+ids.getString(j));
        return new PickerSnapshot.Media(id,mime,date(o),size,Math.max(0,o.optLong("duration_ms",0)),Math.max(0,o.optInt("width",0)),Math.max(0,o.optInt("height",0)),albums,0);
    }
    private static byte[] encode(PickerSnapshot s,String revision)throws Exception {
        JSONObject o=new JSONObject().put("connection",revision).put("collection",s.collection).put("generation",s.generation).put("syncedAt",s.syncedAt).put("albums",new JSONObject(s.albums)).put("deleted",new JSONObject(s.deleted));JSONArray rows=new JSONArray();
        for(PickerSnapshot.Media m:s.media.values())rows.put(new JSONObject().put("id",m.id).put("mime",m.mime).put("date",m.date).put("size",m.size).put("duration",m.duration).put("width",m.width).put("height",m.height).put("generation",m.generation).put("albums",new JSONArray(m.albums)));
        byte[] bytes=o.put("media",rows).toString().getBytes(StandardCharsets.UTF_8);if(bytes.length>96L*1024*1024)throw new IOException("Snapshot bound exceeded");return bytes;
    }
    private void save(byte[] bytes)throws Exception {FileOutputStream out=null;
        try{out=file.startWrite();out.write(bytes);file.finishWrite(out);}catch(Exception e){if(out!=null)file.failWrite(out);throw e;}
    }
    private static PickerSnapshot decode(JSONObject o)throws Exception {
        Map<String,PickerSnapshot.Media> rows=new TreeMap<>();Map<String,Long> deleted=new TreeMap<>();Map<String,String> albums=new TreeMap<>();
        JSONArray list=o.getJSONArray("media");if(list.length()>PickerSnapshot.MAX_ITEMS)throw new IOException();
        for(int i=0;i<list.length();i++){JSONObject m=list.getJSONObject(i);Set<String> membership=new TreeSet<>();JSONArray a=m.getJSONArray("albums");for(int j=0;j<a.length();j++)membership.add(a.getString(j));PickerSnapshot.Media media=new PickerSnapshot.Media(m.getString("id"),m.getString("mime"),m.getLong("date"),m.getLong("size"),m.getLong("duration"),m.getInt("width"),m.getInt("height"),membership,m.getLong("generation"));rows.put(media.id,media);}
        JSONObject d=o.getJSONObject("deleted"),a=o.getJSONObject("albums");for(Iterator<String> k=d.keys();k.hasNext();){String id=k.next();deleted.put(id,d.getLong(id));}for(Iterator<String> k=a.keys();k.hasNext();){String id=k.next();albums.put(id,a.getString(id));}
        return new PickerSnapshot(o.getString("collection"),o.getLong("generation"),o.getLong("syncedAt"),rows,deleted,albums);
    }
    private void notifyPicker(){if(Build.VERSION.SDK_INT>=33)try{MediaStore.notifyCloudMediaChangedEvent(context.getContentResolver(),AUTHORITY,snapshot.collection);}catch(SecurityException ignored){/* Eligibility/selection is controlled by Android. */}}
}
