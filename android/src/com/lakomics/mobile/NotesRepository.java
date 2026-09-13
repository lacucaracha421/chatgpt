package com.lakomics.mobile;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.CancellationSignal;
import org.json.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;
import javax.crypto.Cipher;
/** Encrypted local records, short DB locks, and revision-based sync preserving both edits. */
final class NotesRepository {
 private final SQLiteDatabase db;
 private final SecureSettings settings;
 private final CloudClient client;
 private final ReentrantLock syncing=new ReentrantLock();
 NotesRepository(Context context,SecureSettings settings){
  this.settings=settings;this.client=new CloudClient(settings);
  db=context.openOrCreateDatabase("notes.sqlite",0,null);db.enableWriteAheadLogging();
  db.execSQL("CREATE TABLE IF NOT EXISTS note_items(scope TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,local_revision INTEGER NOT NULL,remote_revision INTEGER NOT NULL,pending INTEGER NOT NULL,operation_id TEXT NOT NULL,conflict INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,id))");
  db.execSQL("CREATE TABLE IF NOT EXISTS note_state(scope TEXT PRIMARY KEY,cursor INTEGER NOT NULL DEFAULT 0,synced_at TEXT)");
 }
 private static final class Vault {String endpoint,scope,vault;byte[] key;JSONObject connection;}
 private Vault vault()throws Exception{
  JSONObject connection=settings.read();if(!connection.has("token"))throw new IOException("Notes unavailable");
  Vault v=new Vault();v.connection=connection;v.endpoint=connection.getString("endpoint");String key=settings.notesKey(v.endpoint,null);if(key.isEmpty())return null;
  v.key=NotesCrypto.unhex(key);v.vault=NotesCrypto.vault(v.key);v.scope=ThumbnailCache.key(v.endpoint)+":"+v.vault;return v;
 }
 private void current(Vault v)throws Exception{Vault now=vault();if(now==null||!now.scope.equals(v.scope))throw new IOException("Notes connection changed");}
 JSONObject unlock(String key)throws Exception{
  byte[] bytes=NotesCrypto.unhex(key.trim());if(bytes.length!=32)throw new IllegalArgumentException("A 64 character Notes key is required");
  String endpoint=settings.read().getString("endpoint");String old=settings.notesKey(endpoint,null);
  if(!old.isEmpty()&&!NotesCrypto.vault(NotesCrypto.unhex(old)).equals(NotesCrypto.vault(bytes)))throw new IOException("Notes key differs from this device vault");
  settings.notesKey(endpoint,NotesCrypto.hex(bytes));return state();
 }
 private JSONObject seal(Vault v,String id,JSONObject content)throws Exception{
  byte[] nonce=NotesCrypto.nonce();return new JSONObject().put("version",1).put("nonce",NotesCrypto.hex(nonce)).put("ciphertext",NotesCrypto.hex(NotesCrypto.crypt(Cipher.ENCRYPT_MODE,v.key,id,nonce,content.toString().getBytes(StandardCharsets.UTF_8))));
 }
 private JSONObject open(Vault v,String id,JSONObject payload)throws Exception{
  if(payload.getInt("version")!=1||payload.getString("ciphertext").length()>600000)throw new IOException("Invalid notes envelope");
  JSONObject result=new JSONObject(new String(NotesCrypto.crypt(Cipher.DECRYPT_MODE,v.key,id,NotesCrypto.unhex(payload.getString("nonce")),NotesCrypto.unhex(payload.getString("ciphertext"))),StandardCharsets.UTF_8));
  validate(result);return result;
 }
 private static void validate(JSONObject content)throws Exception{
  String title=content.getString("title"),body=content.getString("body");
  if(title.codePointCount(0,title.length())>200||body.getBytes(StandardCharsets.UTF_8).length>128*1024)throw new IOException("Note is too large");
  content.getBoolean("pinned");content.getBoolean("deleted");content.getString("createdAt");content.getString("updatedAt");
 }
 private JSONObject row(Cursor c)throws Exception{return new JSONObject().put("id",c.getString(0)).put("payload",new JSONObject(c.getString(1))).put("localRevision",c.getLong(2)).put("remoteRevision",c.getLong(3)).put("pending",c.getInt(4)!=0).put("operationId",c.getString(5)).put("conflict",c.getInt(6)!=0);}
 private JSONObject find(Vault v,String id)throws Exception{try(Cursor c=db.rawQuery("SELECT id,payload,local_revision,remote_revision,pending,operation_id,conflict FROM note_items WHERE scope=? AND id=?",new String[]{v.scope,id})){return c.moveToFirst()?row(c):null;}}
 private JSONObject plain(Vault v,JSONObject item)throws Exception{JSONObject content=open(v,item.getString("id"),item.getJSONObject("payload"));content.put("id",item.getString("id")).put("localRevision",item.getLong("localRevision")).put("pending",item.getBoolean("pending")).put("conflict",item.getBoolean("conflict"));return content;}
 private void put(Vault v,String id,JSONObject payload,long local,long remote,boolean pending,String operation,boolean conflict){
  ContentValues values=new ContentValues();values.put("scope",v.scope);values.put("id",id);values.put("payload",payload.toString());values.put("local_revision",local);values.put("remote_revision",remote);values.put("pending",pending?1:0);values.put("operation_id",operation);values.put("conflict",conflict?1:0);if(db.insertWithOnConflict("note_items",null,values,SQLiteDatabase.CONFLICT_REPLACE)<0)throw new android.database.sqlite.SQLiteException("Cannot save note");
 }
 synchronized JSONObject state()throws Exception{
  Vault v=vault();if(v==null)return new JSONObject().put("unlocked",false).put("notes",new JSONArray());JSONArray items=new JSONArray();
  try(Cursor c=db.rawQuery("SELECT id,payload,local_revision,remote_revision,pending,operation_id,conflict FROM note_items WHERE scope=? ORDER BY rowid DESC",new String[]{v.scope})){while(c.moveToNext())items.put(plain(v,row(c)));}
  String synced=null;try(Cursor c=db.rawQuery("SELECT synced_at FROM note_state WHERE scope=?",new String[]{v.scope})){if(c.moveToFirst())synced=c.getString(0);}
  return new JSONObject().put("unlocked",true).put("notes",items).put("lastSyncedAt",synced==null?JSONObject.NULL:synced);
 }
 synchronized JSONObject save(JSONObject draft)throws Exception{
  Vault v=vault();if(v==null)throw new IOException("Notes locked");String id=draft.getString("id");JSONObject old=find(v,id);long expected=draft.getLong("expectedRevision");boolean conflict=old!=null&&expected!=old.getLong("localRevision");
  if(old==null&&expected!=0)conflict=true;
  JSONObject content=new JSONObject().put("title",draft.getString("title")).put("body",draft.getString("body")).put("pinned",draft.getBoolean("pinned")).put("deleted",draft.optBoolean("deleted",false)).put("createdAt",old==null?Instant.now().toString():open(v,id,old.getJSONObject("payload")).getString("createdAt")).put("updatedAt",Instant.now().toString());validate(content);
  if(conflict){id=UUID.randomUUID().toString();old=null;}
  put(v,id,seal(v,id,content),old==null?1:old.getLong("localRevision")+1,old==null?0:old.getLong("remoteRevision"),true,UUID.randomUUID().toString(),conflict||(old!=null&&old.getBoolean("conflict")));
  return plain(v,find(v,id));
 }
 private void apply(Vault v,JSONObject remote)throws Exception{
  String id=remote.getString("id");JSONObject payload=remote.getJSONObject("payload");open(v,id,payload);JSONObject local=find(v,id);long revision=remote.getLong("revision");
  if(local!=null&&local.getLong("remoteRevision")>=revision)return;
  if(local!=null&&local.getBoolean("pending")){
   if(local.getString("operationId").equals(remote.getString("operationId"))){put(v,id,local.getJSONObject("payload"),local.getLong("localRevision"),revision,false,remote.getString("operationId"),local.getBoolean("conflict"));return;}
   String copy=UUID.randomUUID().toString();JSONObject preserved=open(v,id,local.getJSONObject("payload"));put(v,copy,seal(v,copy,preserved),1,0,true,UUID.randomUUID().toString(),true);
  }
  put(v,id,payload,local==null?1:local.getLong("localRevision")+1,revision,false,remote.getString("operationId"),false);
 }
 JSONObject sync(CancellationSignal signal)throws Exception{
  if(!syncing.tryLock())return state();
  try{
   Vault v=vault();if(v==null)return state();
   // Bounded pages keep responses below the authenticated transport budget. Cursor commits with records.
   for(int page=0;page<10;page++){
    long after=0;synchronized(this){try(Cursor c=db.rawQuery("SELECT cursor FROM note_state WHERE scope=?",new String[]{v.scope})){if(c.moveToFirst())after=c.getLong(0);}}
    current(v);JSONObject result=client.apiFor(v.connection,"/v1/notes/"+v.vault+"?after="+after+"&limit=5","GET",null,signal);current(v);JSONArray items=result.getJSONArray("items");
    synchronized(this){db.beginTransaction();try{for(int i=0;i<items.length();i++){JSONObject item=items.getJSONObject(i);apply(v,item);after=Math.max(after,item.getLong("sequence"));}db.execSQL("INSERT OR IGNORE INTO note_state(scope,cursor) VALUES(?,0)",new Object[]{v.scope});db.execSQL("UPDATE note_state SET cursor=? WHERE scope=?",new Object[]{after,v.scope});db.setTransactionSuccessful();}finally{db.endTransaction();}}
    if(result.isNull("nextCursor"))break;
    if(page==9)return state(); // finish pulling before pushing from an outdated remote view
   }
   JSONArray pending=new JSONArray();synchronized(this){try(Cursor c=db.rawQuery("SELECT id,payload,local_revision,remote_revision,pending,operation_id,conflict FROM note_items WHERE scope=? AND pending=1 LIMIT 10",new String[]{v.scope})){while(c.moveToNext())pending.put(row(c));}}
   for(int i=0;i<pending.length();i++){
    JSONObject item=pending.getJSONObject(i);String id=item.getString("id");current(v);signal.throwIfCanceled();JSONObject result;
    try{result=client.apiFor(v.connection,"/v1/notes/"+v.vault+"/"+id,"PUT",new JSONObject().put("expectedRevision",item.getLong("remoteRevision")).put("operationId",item.getString("operationId")).put("payload",item.getJSONObject("payload")),signal);}catch(CloudClient.HttpFailure failure){if(failure.status==409)continue;throw failure;}
    current(v);synchronized(this){JSONObject now=find(v,id);if(now==null)continue;
     // Editing while PUT is in flight keeps the newer draft pending, based on the acknowledged server revision.
     put(v,id,now.getJSONObject("payload"),now.getLong("localRevision"),result.getLong("revision"),!now.getString("operationId").equals(item.getString("operationId")),now.getString("operationId"),now.getBoolean("conflict"));
    }
   }
   synchronized(this){db.execSQL("UPDATE note_state SET synced_at=? WHERE scope=?",new Object[]{Instant.now().toString(),v.scope});}
   return state();
  }finally{syncing.unlock();}
 }
}
