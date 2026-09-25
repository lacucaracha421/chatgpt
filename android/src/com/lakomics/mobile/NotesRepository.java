package com.lakomics.mobile;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.CancellationSignal;
import android.os.SystemClock;
import org.json.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;
import javax.crypto.Cipher;
/**
 * Encrypted local records, short DB locks and revision-based sync. Notes v2 (ADR-0035
 * amendments): saves keep unknown fields, a pull meeting a pending edit merges three-way
 * against the last acknowledged payload (`base_payload`), a save queued before a pull is
 * rebased through `note_revisions`, and only an unresolvable collision keeps both copies.
 * Notes this client cannot decode stay listed read-only; one unreadable row never fails
 * the list or a sync. Mirrors the PC `library/notes.rs`.
 */
final class NotesRepository {
 /** A refusal whose Korean text the WebView shows (or matches) as is. */
 static final class UserError extends Exception{UserError(String message){super(message);}}
 static final String LOCKED="메모 암호화 키를 등록해 주세요.",INVALID="암호화 키가 맞지 않거나 메모가 손상됐습니다.",RECOVERY_MISMATCH="복구키가 맞지 않습니다.",SHAPE="메모 데이터 형식이 올바르지 않습니다.";
 /** The UI answers these two with the PIN prompt instead of an error (same texts as the PC). */
 static final String SECRET_LOCKED="암호 메모 잠금을 해제해 주세요.",PIN_REQUIRED="복구키를 보려면 암호 메모 PIN을 먼저 입력해 주세요.";
 private final SQLiteDatabase db;
 private final SecureSettings settings;
 private final CloudClient client;
 private final ReentrantLock syncing=new ReentrantLock();
 /** The secret-note unlock session lives only in this process (never persisted). */
 private final NotesPin.Session secrets=new NotesPin.Session(SystemClock::elapsedRealtime);
 private final Object attempts=new Object();
 NotesRepository(Context context,SecureSettings settings){
  this.settings=settings;this.client=new CloudClient(settings);
  db=context.openOrCreateDatabase("notes.sqlite",0,null);db.enableWriteAheadLogging();
  // `conflict` is the local keep-both flag (사본); it is never synced.
  db.execSQL("CREATE TABLE IF NOT EXISTS note_items(scope TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,local_revision INTEGER NOT NULL,remote_revision INTEGER NOT NULL,pending INTEGER NOT NULL,operation_id TEXT NOT NULL,conflict INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,id))");
  db.execSQL("CREATE TABLE IF NOT EXISTS note_state(scope TEXT PRIMARY KEY,cursor INTEGER NOT NULL DEFAULT 0,synced_at TEXT)");
  boolean base=false;try(Cursor c=db.rawQuery("PRAGMA table_info(note_items)",null)){while(c.moveToNext())if("base_payload".equals(c.getString(1)))base=true;}
  // The last server-acknowledged envelope per note: the three-way merge base.
  if(!base)db.execSQL("ALTER TABLE note_items ADD COLUMN base_payload TEXT");
  // Payloads a pull replaced, so a save queued against that local revision can be rebased.
  db.execSQL("CREATE TABLE IF NOT EXISTS note_revisions(scope TEXT NOT NULL,id TEXT NOT NULL,local_revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id,local_revision))");
 }
 private static final class Vault {String endpoint,scope,vault;byte[] key;JSONObject connection;}
 private static final class Row {String id,payload,operationId,base;long localRevision,remoteRevision;boolean pending,conflictCopy;}
 private Vault vault()throws Exception{
  JSONObject connection=settings.read();if(!connection.has("token"))throw new IOException("Notes unavailable");
  Vault v=new Vault();v.connection=connection;v.endpoint=connection.getString("endpoint");String key=settings.notesKey(v.endpoint,null);if(key.isEmpty())return null;
  v.key=NotesCrypto.unhex(key);v.vault=NotesCrypto.vault(v.key);v.scope=ThumbnailCache.key(v.endpoint)+":"+v.vault;return v;
 }
 private Vault unlocked()throws Exception{Vault v=vault();if(v==null)throw new UserError(LOCKED);return v;}
 private void current(Vault v)throws Exception{Vault now=vault();if(now==null||!now.scope.equals(v.scope))throw new IOException("Notes connection changed");}
 JSONObject unlock(String key)throws Exception{
  byte[] bytes=NotesCrypto.unhex(key.trim());if(bytes.length!=32)throw new IllegalArgumentException("A 64 character Notes key is required");
  String endpoint=settings.read().getString("endpoint");String old=settings.notesKey(endpoint,null);
  if(!old.isEmpty()&&!NotesCrypto.vault(NotesCrypto.unhex(old)).equals(NotesCrypto.vault(bytes)))throw new IOException("Notes key differs from this device vault");
  settings.notesKey(endpoint,NotesCrypto.hex(bytes));return state();
 }
 private static String seal(Vault v,String id,String plaintext)throws Exception{
  byte[] nonce=NotesCrypto.nonce();return new JSONObject().put("version",1).put("nonce",NotesCrypto.hex(nonce)).put("ciphertext",NotesCrypto.hex(NotesCrypto.crypt(Cipher.ENCRYPT_MODE,v.key,id,nonce,plaintext.getBytes(StandardCharsets.UTF_8)))).toString();
 }
 /** Decrypts and decodes; fails only on a wrong key, tampering or non-JSON bytes. */
 private static NotesModel.Stored open(Vault v,String id,String envelope)throws Exception{
  JSONObject payload=new JSONObject(envelope);String nonce=payload.getString("nonce"),cipher=payload.getString("ciphertext");
  if(payload.getInt("version")!=1||nonce.length()!=24||cipher.length()>600000)throw new IOException("Invalid notes envelope");
  return NotesModel.Stored.decode(NotesModel.parsePayload(new String(NotesCrypto.crypt(Cipher.DECRYPT_MODE,v.key,id,NotesCrypto.unhex(nonce),NotesCrypto.unhex(cipher)),StandardCharsets.UTF_8)));
 }
 private static NotesModel.Stored tryOpen(Vault v,String id,String envelope){if(envelope==null)return null;try{return open(v,id,envelope);}catch(Exception unreadable){return null;}}
 private static final String COLUMNS="id,payload,local_revision,remote_revision,pending,operation_id,conflict,base_payload";
 private static Row row(Cursor c){Row r=new Row();r.id=c.getString(0);r.payload=c.getString(1);r.localRevision=c.getLong(2);r.remoteRevision=c.getLong(3);r.pending=c.getInt(4)!=0;r.operationId=c.getString(5);r.conflictCopy=c.getInt(6)!=0;r.base=c.isNull(7)?null:c.getString(7);return r;}
 private Row find(Vault v,String id){try(Cursor c=db.rawQuery("SELECT "+COLUMNS+" FROM note_items WHERE scope=? AND id=?",new String[]{v.scope,id})){return c.moveToFirst()?row(c):null;}}
 private JSONObject view(String id,NotesModel.Stored stored,long local,boolean pending,boolean conflictCopy)throws Exception{
  return new JSONObject(NotesModel.write(NotesModel.view(id,stored,local,pending,conflictCopy,secrets.isOpen())));
 }
 private void put(Vault v,String id,String payload,long local,long remote,boolean pending,String operation,boolean conflictCopy,String base){
  ContentValues values=new ContentValues();values.put("scope",v.scope);values.put("id",id);values.put("payload",payload);values.put("local_revision",local);values.put("remote_revision",remote);values.put("pending",pending?1:0);values.put("operation_id",operation);values.put("conflict",conflictCopy?1:0);if(base==null)values.putNull("base_payload");else values.put("base_payload",base);
  if(db.insertWithOnConflict("note_items",null,values,SQLiteDatabase.CONFLICT_REPLACE)<0)throw new android.database.sqlite.SQLiteException("Cannot save note");
 }
 /** Keeps the payload a pull is about to replace (the last 20 local revisions per note). */
 private void remember(Vault v,String id){
  db.execSQL("INSERT OR REPLACE INTO note_revisions(scope,id,local_revision,payload) SELECT scope,id,local_revision,payload FROM note_items WHERE scope=? AND id=?",new Object[]{v.scope,id});
  db.execSQL("DELETE FROM note_revisions WHERE scope=?1 AND id=?2 AND local_revision<(SELECT local_revision FROM note_items WHERE scope=?1 AND id=?2)-20",new Object[]{v.scope,id});
 }
 synchronized JSONObject state()throws Exception{
  Vault v=vault();if(v==null)return new JSONObject().put("unlocked",false).put("notes",new JSONArray());JSONArray items=new JSONArray();int unreadable=0;
  try(Cursor c=db.rawQuery("SELECT "+COLUMNS+" FROM note_items WHERE scope=? ORDER BY rowid DESC",new String[]{v.scope})){while(c.moveToNext()){Row r=row(c);
   // One damaged row must not hide the whole vault; it is counted instead.
   NotesModel.Stored stored=tryOpen(v,r.id,r.payload);if(stored==null){unreadable++;continue;}
   items.put(view(r.id,stored,r.localRevision,r.pending,r.conflictCopy));}}
  String synced=null;try(Cursor c=db.rawQuery("SELECT synced_at FROM note_state WHERE scope=?",new String[]{v.scope})){if(c.moveToFirst())synced=c.getString(0);}
  return new JSONObject().put("unlocked",true).put("notes",items).put("unreadable",unreadable).put("lastSyncedAt",synced==null?JSONObject.NULL:synced);
 }
 /**
  * Saves a draft that carries only the fields the WebView edits. A draft written against an
  * older local revision (a pull replaced the note while the save was queued) is rebased:
  * three-way merged with the payload it was based on; only an unresolvable collision keeps
  * it as a separate conflict copy, returned as `copiedTo`.
  */
 synchronized JSONObject save(String payload)throws Exception{
  Vault v=unlocked();NotesModel.Draft draft;
  try{draft=NotesModel.draft(Json.parse(payload));}catch(NotesModel.Shape|IllegalArgumentException invalid){throw new UserError(SHAPE);}
  String id=draft.id;if(!NotesModel.uuid(id)||!id.equals(id.toLowerCase(Locale.ROOT)))throw new UserError(INVALID);
  String now=Instant.now().toString();NotesModel.SecretOpen touch=secrets::touch;
  try{
   db.beginTransaction();
   try{
    Row old=find(v,id);NotesModel.Stored next;
    if(old==null)next=NotesModel.Stored.typed(NotesModel.applyDraft(null,draft,now,touch));
    else{
     NotesModel.Stored current;try{current=open(v,id,old.payload);}catch(Exception unreadable){throw new UserError(INVALID);}
     boolean stale=old.localRevision!=draft.expectedRevision;
     // Metadata patches are safe against any newer state.
     if(current.isRaw())next=NotesModel.Stored.raw(NotesModel.patchRaw(current.raw,draft,now));
     else if(!stale)next=NotesModel.Stored.typed(NotesModel.applyDraft(current.typed,draft,now,touch));
     else{
      String basePayload=null;try(Cursor c=db.rawQuery("SELECT payload FROM note_revisions WHERE scope=? AND id=? AND local_revision=?",new String[]{v.scope,id,Long.toString(draft.expectedRevision)})){if(c.moveToFirst())basePayload=c.getString(0);}
      NotesModel.Stored base=tryOpen(v,id,basePayload);boolean missing=base==null||base.isRaw();
      NotesModel.Content baseContent=missing?current.typed:base.typed;
      NotesModel.Content local=NotesModel.applyDraft(baseContent,draft,now,touch);
      NotesModel.Content merged=missing?null:NotesModel.merge(baseContent,local,current.typed);
      if(merged==null){
       String copy=UUID.randomUUID().toString();
       put(v,copy,seal(v,copy,local.toJson()),1,0,true,UUID.randomUUID().toString(),true,null);
       db.setTransactionSuccessful();
       return view(id,current,old.localRevision,old.pending,old.conflictCopy).put("copiedTo",copy);
      }
      next=NotesModel.Stored.typed(merged);
     }
    }
    long revision=old==null?1:old.localRevision+1;
    put(v,id,seal(v,id,next.toJson()),revision,old==null?0:old.remoteRevision,true,UUID.randomUUID().toString(),old!=null&&old.conflictCopy,old==null?null:old.base);
    db.setTransactionSuccessful();
    return view(id,next,revision,true,old!=null&&old.conflictCopy);
   }finally{db.endTransaction();}
  }catch(NotesModel.Invalid invalid){throw new UserError(invalid.getMessage());}
  catch(NotesModel.SecretLocked locked){throw new UserError(SECRET_LOCKED);}
 }
 /**
  * Applies one pulled server row. A pending local edit from another operation is merged
  * three-way against the last acknowledged payload; an unresolvable collision (or any side
  * this client cannot decode) keeps the local edit as a separate conflict copy and takes
  * the server version. A row that does not authenticate is skipped.
  */
 private void apply(Vault v,JSONObject remote)throws Exception{
  String id=remote.getString("id");long revision=remote.getLong("revision");String operation=remote.getString("operationId");
  if(!NotesModel.uuid(id)||!id.equals(id.toLowerCase(Locale.ROOT))||revision<1)return;
  String payload=remote.getJSONObject("payload").toString();NotesModel.Stored remoteStored=tryOpen(v,id,payload);if(remoteStored==null)return;
  Row local=find(v,id);
  if(local!=null){
   if(revision<=local.remoteRevision)return;
   remember(v,id);
   if(local.pending&&!local.operationId.equals(operation)){
    NotesModel.Stored mine=tryOpen(v,id,local.payload),base=tryOpen(v,id,local.base);
    NotesModel.Content merged=mine!=null&&base!=null&&!mine.isRaw()&&!base.isRaw()&&!remoteStored.isRaw()?NotesModel.merge(base.typed,mine.typed,remoteStored.typed):null;
    if(merged!=null&&!merged.equals(remoteStored.typed)){put(v,id,seal(v,id,merged.toJson()),local.localRevision+1,revision,true,UUID.randomUUID().toString(),local.conflictCopy,payload);return;}
    if(merged==null&&mine!=null){String copy=UUID.randomUUID().toString();put(v,copy,seal(v,copy,mine.toJson()),1,0,true,UUID.randomUUID().toString(),true,null);}
   }
  }
  put(v,id,payload,local==null?1:local.localRevision+1,revision,false,operation,local!=null&&local.conflictCopy,payload);
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
   java.util.List<Row> pending=new java.util.ArrayList<>();synchronized(this){try(Cursor c=db.rawQuery("SELECT "+COLUMNS+" FROM note_items WHERE scope=? AND pending=1 LIMIT 10",new String[]{v.scope})){while(c.moveToNext())pending.add(row(c));}}
   for(Row item:pending){
    current(v);signal.throwIfCanceled();JSONObject result;
    try{result=client.apiFor(v.connection,"/v1/notes/"+v.vault+"/"+item.id,"PUT",new JSONObject().put("expectedRevision",item.remoteRevision).put("operationId",item.operationId).put("payload",new JSONObject(item.payload)),signal);}catch(CloudClient.HttpFailure failure){if(failure.status==409)continue;throw failure;}
    current(v);synchronized(this){Row now=find(v,item.id);if(now==null)continue;
     // Editing while PUT is in flight keeps the newer draft pending, based on the acknowledged server revision.
     // The acknowledged payload is the merge base for later concurrent edits.
     put(v,item.id,now.payload,now.localRevision,result.getLong("revision"),!now.operationId.equals(item.operationId),now.operationId,now.conflictCopy,item.payload);
    }
   }
   synchronized(this){db.execSQL("UPDATE note_state SET synced_at=? WHERE scope=?",new Object[]{Instant.now().toString(),v.scope});}
   return state();
  }finally{syncing.unlock();}
 }
 synchronized JSONObject dismissConflictCopy(String id)throws Exception{Vault v=unlocked();db.execSQL("UPDATE note_items SET conflict=0 WHERE scope=? AND id=?",new Object[]{v.scope,id});return new JSONObject();}
 // ------------------------------------------------------------------------------------
 // Secret notes: per-device PIN (never synced) and the in-process unlock session.
 private boolean pinSet()throws Exception{return !settings.notesPin(null).isEmpty();}
 JSONObject secretStatus()throws Exception{return new JSONObject().put("pinSet",pinSet()).put("unlocked",secrets.isOpen());}
 private void setPin(String pin)throws Exception{
  if(!NotesPin.valid(pin))throw new UserError("PIN은 숫자 4~8자리로 입력해 주세요.");
  settings.notesPin(NotesPin.makeVerifier(pin,NotesPin.ITERATIONS));secrets.open();
 }
 JSONObject secretSetPin(String pin)throws Exception{
  unlocked();synchronized(attempts){if(pinSet())throw new UserError("이미 PIN이 설정돼 있습니다.");setPin(pin);}return state();
 }
 JSONObject secretUnlock(String pin)throws Exception{
  unlocked();
  synchronized(attempts){
   // Check, verify and record under one lock; the counter survives restarts.
   long[] failures=settings.notesPinFailures();long now=System.currentTimeMillis()/1000;long wait=NotesPin.lockoutRemaining(failures[0],failures[1],now);
   if(wait>=0)throw new UserError("PIN을 여러 번 틀렸습니다. "+wait+"초 뒤에 다시 시도해 주세요.");
   String verifier=settings.notesPin(null);if(verifier.isEmpty())throw new UserError("먼저 PIN을 설정해 주세요.");
   if(!NotesPin.check(verifier,pin)){settings.notesPinFailures(failures[0]+1,now);throw new UserError("PIN이 맞지 않습니다.");}
   settings.notesPinFailures(0,0);
  }
  secrets.open();return state();
 }
 /** Called after a successful BiometricPrompt; a PIN must exist as the fallback. */
 JSONObject secretUnlockBiometric()throws Exception{unlocked();if(!pinSet())throw new UserError("먼저 PIN을 설정해 주세요.");secrets.open();return state();}
 /** A forgotten PIN is replaced by proving the recovery key. */
 JSONObject secretResetPin(String recoveryKey,String pin)throws Exception{
  Vault v=unlocked();byte[] given;try{given=NotesCrypto.unhex(recoveryKey==null?"":recoveryKey.trim());}catch(IllegalArgumentException e){throw new UserError(RECOVERY_MISMATCH);}
  if(given.length!=32||!NotesCrypto.vault(given).equals(v.vault))throw new UserError(RECOVERY_MISMATCH);
  synchronized(attempts){setPin(pin);}return state();
 }
 void lockSecrets(){secrets.lock();}
 JSONObject touchSecrets()throws Exception{return new JSONObject().put("unlocked",secrets.touch());}
 /** The stored key is the recovery key; with a PIN set it needs an open PIN session (it can reset the PIN). */
 JSONObject recoveryKey()throws Exception{Vault v=unlocked();if(pinSet()&&!secrets.touch())throw new UserError(PIN_REQUIRED);return new JSONObject().put("key",NotesCrypto.hex(v.key));}
}
