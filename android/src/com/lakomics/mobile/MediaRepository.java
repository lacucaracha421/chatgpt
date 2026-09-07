package com.lakomics.mobile;

import android.content.Context;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.OperationCanceledException;
import android.os.ParcelFileDescriptor;
import org.json.JSONObject;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.locks.ReentrantLock;

/** One account-scoped disk budget for the app, DocumentsUI and Photo Picker. */
final class MediaRepository {
 static final long MAX_ORIGINAL=512L*1024*1024, MAX_VIEW_IMAGE=32L*1024*1024;
 private static MediaRepository instance;
 static synchronized MediaRepository get(Context context){
  if(instance==null)try{instance=new MediaRepository(context.getApplicationContext());}catch(IOException e){throw new IllegalStateException("Cache unavailable",e);}
  return instance;
 }
 private final SecureSettings settings;
 private final CloudClient client;
 private final ThumbnailCache cache;
 private final Semaphore transfers=new Semaphore(4,true);
 private final Set<CancellationSignal> active=ConcurrentHashMap.newKeySet();
 private final Map<String,LockEntry> locks=new HashMap<>();
 private static final class LockEntry{final ReentrantLock lock=new ReentrantLock();int users;}
 private static final class Scope{String key;long generation;}
 private MediaRepository(Context context)throws IOException{
  settings=new SecureSettings(context);client=new CloudClient(settings);
  cache=new ThumbnailCache(new File(context.getCacheDir(),"thumbnail-media"));
  // Retired provider cache contains only disposable downloads; metadata stays intact.
  File[] legacy=new File(context.getCacheDir(),"document-media").listFiles();
  if(legacy!=null)for(File file:legacy)if(file.isFile())file.delete();
 }
 private Scope scope(String id,String variant)throws Exception{
  if(id==null || !id.matches("[A-Za-z0-9_-]{1,128}") || !(variant.equals("thumbnail") || variant.equals("original")))throw new IllegalArgumentException();
  return scopedIdentity(variant.equals("thumbnail")?id:id+"\noriginal");
 }
 private Scope scopedIdentity(String value)throws Exception{
  synchronized(LibraryDocumentsProvider.CONNECTION_LOCK){
   JSONObject connection=settings.read();if(!connection.has("token"))throw new IllegalStateException();
   Scope scope=new Scope();String identity=connection.getString("endpoint")+"\n"+connection.getString("token")+"\n"+value;
   scope.key=ThumbnailCache.key(identity);scope.generation=cache.generation();return scope;
  }
 }
 JSONObject status()throws Exception{long[] s=cache.status();return new JSONObject().put("bytes",s[0]).put("count",s[1]).put("limit",s[2]);}
 void clear()throws IOException{for(CancellationSignal signal:active)signal.cancel();cache.clear();}
 InputStream stream(String key,long generation)throws IOException{return cache.open(key,generation);}
 private JSONObject ticket(String id,String variant,CancellationSignal signal)throws Exception{
  return client.api("/v1/library/assets/"+Uri.encode(id)+"/media-ticket","POST",new JSONObject().put("variant",variant),signal);
 }
 static boolean imageMime(String mime){return mime!=null && mime.matches("image/(jpeg|png|webp|gif|avif|heic|heif|bmp)");}
 private JSONObject local(Scope scope,String mime)throws Exception{
  return new JSONObject().put("url","https://app.lakomics.local/media-cache/"+scope.generation+"/"+scope.key+"?mime="+Uri.encode(mime)+"&v="+System.nanoTime()).put("expires_in",240);
 }
 JSONObject browser(String id,String variant,String mime,CancellationSignal signal)throws Exception{
  Scope scope=scope(id,variant);
  if(variant.equals("original") && !imageMime(mime))return ticket(id,variant,signal);
  try{cache.file(scope.key,scope.generation);return local(scope,variant.equals("thumbnail")?"image/webp":mime);}catch(FileNotFoundException ignored){}
  JSONObject first=ticket(id,variant,signal);
  if(variant.equals("original") && (!imageMime(first.optString("content_type")) || first.optLong("size_bytes",Long.MAX_VALUE)>MAX_VIEW_IMAGE))return first;
  fill(id,variant,scope,signal,first);
  return local(scope,variant.equals("thumbnail")?"image/webp":first.optString("content_type",mime));
 }
 private static boolean retryable(Exception error){
  if(error instanceof CloudClient.HttpFailure){int status=((CloudClient.HttpFailure)error).status;return status==408 || status==429 || status>=500 || status==403;}
  return error instanceof java.net.SocketTimeoutException || error instanceof java.net.SocketException || error instanceof EOFException;
 }
 private interface TicketSource {JSONObject read()throws Exception;}
 private void fill(String id,String variant,Scope scope,CancellationSignal signal,JSONObject first)throws Exception{
  fillFrom(variant,scope,signal,first,()->ticket(id,variant,signal));
 }
 private void fillFrom(String variant,Scope scope,CancellationSignal signal,JSONObject first,TicketSource source)throws Exception{
  LockEntry entry;synchronized(locks){entry=locks.get(scope.key);if(entry==null){entry=new LockEntry();locks.put(scope.key,entry);}entry.users++;}
  boolean locked=false,permit=false;active.add(signal);
  try{
   long deadline=System.currentTimeMillis()+180000;
   while(!(locked=entry.lock.tryLock(100,TimeUnit.MILLISECONDS))){signal.throwIfCanceled();if(System.currentTimeMillis()>deadline)throw new IOException("Media busy");}
   signal.throwIfCanceled();
   try{cache.file(scope.key,scope.generation);return;}catch(FileNotFoundException ignored){}
   while(!(permit=transfers.tryAcquire(100,TimeUnit.MILLISECONDS))){signal.throwIfCanceled();if(System.currentTimeMillis()>deadline)throw new IOException("Media busy");}
   long maximum=variant.equals("thumbnail")?ThumbnailCache.MAX_FILE:MAX_ORIGINAL;
   JSONObject initial=first==null?source.read():first;
   long expected=initial.optLong("size_bytes",0);if(expected>maximum)throw new IOException("Original exceeds 512 MiB selection limit");
   long reservation=expected>0?expected:maximum;
   cache.obtain(scope.key,scope.generation,reservation,file->{
    JSONObject current=initial;
    for(int attempt=0;;attempt++){
     signal.throwIfCanceled();
     try{client.download(current.getString("url"),file,reservation,signal);if(expected>0 && file.length()!=expected)throw new EOFException("Incomplete media");signal.throwIfCanceled();return;}
     catch(Exception failure){signal.throwIfCanceled();if(attempt>=1 || !retryable(failure))throw failure;current=source.read();}
    }
   });
  }finally{active.remove(signal);if(permit)transfers.release();if(locked)entry.lock.unlock();synchronized(locks){if(--entry.users==0)locks.remove(scope.key);}}
 }
 JSONObject collectionArtwork(String collection,String artwork,String variant,String revision,CancellationSignal signal)throws Exception{
  if(!collection.matches("[A-Za-z0-9_-]{1,128}") || !artwork.matches("[A-Za-z0-9_-]{1,128}") || !revision.matches("[a-f0-9]{64}") || !(variant.equals("thumbnail") || variant.equals("original")))throw new IllegalArgumentException();
  Scope scope=scopedIdentity("collection/"+collection+"/"+artwork+"/"+revision+"/"+variant);
  try(InputStream input=new BufferedInputStream(cache.open(scope.key,scope.generation))){
   input.mark(16);byte[] header=new byte[12];int count=input.read(header);input.reset();
   String mime=count==12 && header[0]=='R' && header[1]=='I' && header[2]=='F' && header[3]=='F' && header[8]=='W' && header[9]=='E' && header[10]=='B' && header[11]=='P'?"image/webp":java.net.URLConnection.guessContentTypeFromStream(input);
   if(imageMime(mime))return local(scope,mime);
  }catch(FileNotFoundException ignored){}
  TicketSource source=()->client.api("/v1/collections/"+collection+"/artworks/"+artwork+"/media-ticket","POST",new JSONObject().put("variant",variant),signal);
  JSONObject first=source.read();
  if(!imageMime(first.optString("content_type")) || first.optLong("size_bytes",Long.MAX_VALUE)>ThumbnailCache.MAX_FILE)throw new IOException("Artwork exceeds limit");
  fillFrom(variant,scope,signal,first,source);signal.throwIfCanceled();return local(scope,first.getString("content_type"));
 }
 ParcelFileDescriptor open(String id,String variant,CancellationSignal cancel)throws FileNotFoundException{
  CancellationSignal signal=cancel==null?new CancellationSignal():cancel;
  try{
   Scope scope=scope(id,variant);fill(id,variant,scope,signal,null);signal.throwIfCanceled();
   synchronized(cache){return ParcelFileDescriptor.open(cache.file(scope.key,scope.generation),ParcelFileDescriptor.MODE_READ_ONLY);}
  }catch(OperationCanceledException e){throw e;}catch(Exception e){throw new FileNotFoundException("Media unavailable. Check connection or the 512 MiB original limit.");}
 }
}
