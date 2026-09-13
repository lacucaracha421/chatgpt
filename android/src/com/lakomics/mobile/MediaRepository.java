package com.lakomics.mobile;

import android.content.Context;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.OperationCanceledException;
import android.os.ParcelFileDescriptor;
import org.json.JSONObject;
import org.json.JSONArray;
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
 private static final class TicketWaiter {String id,variant;JSONObject connection;CompletableFuture<JSONObject> result=new CompletableFuture<>();}
 private final List<TicketWaiter> ticketQueue=new ArrayList<>();
 private final ScheduledExecutorService ticketWorker=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"lakomics-media-tickets");t.setDaemon(true);return t;});
 private JSONObject ticket(String id,String variant,CancellationSignal signal)throws Exception{
  TicketWaiter waiter=new TicketWaiter();waiter.id=id;waiter.variant=variant;waiter.connection=settings.read();
  synchronized(ticketQueue){ticketQueue.add(waiter);if(ticketQueue.size()==1)ticketWorker.schedule(this::flushTickets,12,TimeUnit.MILLISECONDS);}
  while(true){if(signal!=null)signal.throwIfCanceled();try{return waiter.result.get(100,TimeUnit.MILLISECONDS);}catch(TimeoutException ignored){}catch(ExecutionException failure){Throwable cause=failure.getCause();if(cause instanceof Exception)throw (Exception)cause;throw new IOException("Media ticket unavailable");}}
 }
 private void flushTickets(){
  List<TicketWaiter> batch=new ArrayList<>();synchronized(ticketQueue){batch.addAll(ticketQueue);ticketQueue.clear();}
  // Configuration can change during the short batching window. Never mix account credentials.
  Map<String,List<TicketWaiter>> groups=new LinkedHashMap<>();
  for(TicketWaiter waiter:batch)groups.computeIfAbsent(waiter.connection.toString(),key->new ArrayList<>()).add(waiter);
  for(List<TicketWaiter> group:groups.values())for(int start=0;start<group.size();start+=50){
   List<TicketWaiter> part=group.subList(start,Math.min(start+50,group.size()));
   try{
    JSONArray requests=new JSONArray();for(TicketWaiter waiter:part)requests.put(new JSONObject().put("asset_id",waiter.id).put("variant",waiter.variant));
    JSONArray results=client.apiFor(part.get(0).connection,"/v1/library/media-tickets","POST",new JSONObject().put("items",requests),new CancellationSignal()).getJSONArray("items");
    for(TicketWaiter waiter:part){JSONObject match=null;for(int i=0;i<results.length();i++){JSONObject result=results.getJSONObject(i);if(result.optString("asset_id").equals(waiter.id)&&result.optString("variant").equals(waiter.variant)){match=result;break;}}if(match!=null&&match.optBoolean("ok"))waiter.result.complete(match);else waiter.result.completeExceptionally(new IOException("Media unavailable"));}
   }catch(Exception failure){for(TicketWaiter waiter:part)waiter.result.completeExceptionally(failure);}
  }
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
     try{client.download(current.getString("url"),file,reservation,signal);if(expected>0 && file.length()!=expected)throw new EOFException("Incomplete media");if(!current.optString("sha256").isEmpty()){java.security.MessageDigest hash=java.security.MessageDigest.getInstance("SHA-256");try(InputStream input=new FileInputStream(file)){byte[] buffer=new byte[32768];int count;while((count=input.read(buffer))!=-1)hash.update(buffer,0,count);}if(!NotesCrypto.hex(hash.digest()).equals(current.getString("sha256")))throw new IOException("Image digest mismatch");}signal.throwIfCanceled();return;}
     catch(Exception failure){signal.throwIfCanceled();if(attempt>=1 || !retryable(failure))throw failure;current=source.read();}
    }
   });
  }finally{active.remove(signal);if(permit)transfers.release();if(locked)entry.lock.unlock();synchronized(locks){if(--entry.users==0)locks.remove(scope.key);}}
 }
 private String cachedImageMime(Scope scope)throws Exception{
  try(InputStream raw=cache.open(scope.key,scope.generation);BufferedInputStream input=new BufferedInputStream(raw)){
   input.mark(32);byte[] header=new byte[16];int count=input.read(header);input.reset();
   if(count>=12 && header[0]=='R' && header[1]=='I' && header[2]=='F' && header[3]=='F' && header[8]=='W' && header[9]=='E' && header[10]=='B' && header[11]=='P')return "image/webp";
   if(count>=12 && header[4]=='f' && header[5]=='t' && header[6]=='y' && header[7]=='p' && header[8]=='a' && header[9]=='v' && header[10]=='i' && (header[11]=='f' || header[11]=='s'))return "image/avif";
   String mime=java.net.URLConnection.guessContentTypeFromStream(input);return imageMime(mime)?mime:null;
  }
 }
 JSONObject catalogImage(String workId,String revision,String kind,int index,String url,CancellationSignal signal)throws Exception{
  if(workId==null || !workId.matches("[1-9][0-9]{0,18}") || !(kind.equals("cover") || kind.equals("page")) || index<0 || index>=2000 || kind.equals("cover")&&index!=0)throw new IllegalArgumentException();
  NetworkPolicy.catalogImage(workId,revision,kind,index,url);Scope scope=scopedIdentity("catalog/kHentai/"+workId+"/"+kind+"/"+index+"/"+ThumbnailCache.key(url));
  try{String mime=cachedImageMime(scope);if(imageMime(mime))return local(scope,mime);cache.remove(scope.key,scope.generation);}catch(FileNotFoundException ignored){}
  JSONObject external=new JSONObject().put("url",url).put("size_bytes",0);
  try{fillFrom("thumbnail",scope,signal,external,()->external);}catch(CloudClient.HttpFailure failure){if(failure.status==403)throw new IOException("Catalog image URL expired");throw failure;}
  signal.throwIfCanceled();String mime=cachedImageMime(scope);if(!imageMime(mime)){cache.remove(scope.key,scope.generation);throw new IOException("Catalog image type is unsupported");}return local(scope,mime);
 }
 JSONObject collectionArtwork(String collection,String artwork,String variant,String revision,String digest,CancellationSignal signal)throws Exception{
  if(!collection.matches("[A-Za-z0-9_-]{1,128}") || !artwork.matches("[A-Za-z0-9_-]{1,128}") || !revision.matches("[a-f0-9]{64}") || !(variant.equals("thumbnail") || variant.equals("original")))throw new IllegalArgumentException();
  if(!digest.isEmpty()&&!digest.matches("[a-f0-9]{64}"))throw new IllegalArgumentException();
  Scope scope=scopedIdentity("collection/"+collection+"/"+artwork+"/"+(digest.isEmpty()?revision:digest)+"/"+variant);
  try(InputStream input=new BufferedInputStream(cache.open(scope.key,scope.generation))){
   input.mark(16);byte[] header=new byte[12];int count=input.read(header);input.reset();
   String mime=count==12 && header[0]=='R' && header[1]=='I' && header[2]=='F' && header[3]=='F' && header[8]=='W' && header[9]=='E' && header[10]=='B' && header[11]=='P'?"image/webp":java.net.URLConnection.guessContentTypeFromStream(input);
   if(imageMime(mime))return local(scope,mime);
  }catch(FileNotFoundException ignored){}
  TicketSource source=()->client.api("/v1/collections/"+collection+"/artworks/"+artwork+"/media-ticket","POST",new JSONObject().put("variant",variant),signal);
  JSONObject first=source.read();
  if(!digest.isEmpty()&&!digest.equals(first.optString("sha256")))throw new IOException("Artwork changed; refresh metadata");
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
