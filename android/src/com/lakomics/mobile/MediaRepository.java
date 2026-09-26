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
 private final Semaphore transfers=new Semaphore(8,true);
 private final Set<CancellationSignal> active=ConcurrentHashMap.newKeySet();
 private final Map<String,LockEntry> locks=new HashMap<>();
 private static final class LockEntry{final ReentrantLock lock=new ReentrantLock();int users;}
 private static final class Scope{String key,ticketGroup;long generation;JSONObject connection;}
 private MediaRepository(Context context)throws IOException{
  settings=new SecureSettings(context);client=new CloudClient(settings);
  cache=new ThumbnailCache(new File(context.getCacheDir(),"thumbnail-media"));
  // Retired provider cache contains only disposable downloads; metadata stays intact.
  File[] legacy=new File(context.getCacheDir(),"document-media").listFiles();
  if(legacy!=null)for(File file:legacy)if(file.isFile())file.delete();
 }
 private Scope scope(String id,String variant)throws Exception{return scope(id,variant,"");}
 /** `revision` is the server's thumbnail revision, or empty; originals ignore it. */
 private Scope scope(String id,String variant,String revision)throws Exception{
  if(id==null || !id.matches("[A-Za-z0-9_-]{1,128}") || !(variant.equals("thumbnail") || variant.equals("original")) || !ThumbnailCache.validRevision(revision))throw new IllegalArgumentException();
  return scoped(account->ThumbnailCache.mediaKey(account,id,variant,variant.equals("thumbnail")?revision:""));
 }
 private Scope scopedIdentity(String value)throws Exception{return scoped(account->ThumbnailCache.key(account+"\n"+value));}
 private interface KeyFor{String key(String account)throws Exception;}
 private Scope scoped(KeyFor keyFor)throws Exception{
  synchronized(LibraryDocumentsProvider.CONNECTION_LOCK){
   JSONObject connection=settings.read();if(!connection.has("token"))throw new IllegalStateException();
   Scope scope=new Scope();String account=connection.getString("endpoint")+"\n"+connection.getString("token");
   scope.key=keyFor.key(account);scope.generation=cache.generation();scope.connection=connection;
   // Every connection replacement clears the cache, including same-credential reconfiguration.
   scope.ticketGroup=scope.generation+"/"+ThumbnailCache.key(account);return scope;
  }
 }
 JSONObject status()throws Exception{long[] s=cache.status();return new JSONObject().put("bytes",s[0]).put("count",s[1]).put("limit",s[2]);}
 /** `revisions` (optional, parallel to `ids`) names each thumbnail's revision, as {@link #browser} keys it. */
 JSONObject thumbnailsCached(JSONArray ids,JSONArray revisions,CancellationSignal signal)throws Exception{
  if(ids.length()>100)throw new IllegalArgumentException("Too many thumbnails");
  if(revisions!=null && revisions.length()!=ids.length())throw new IllegalArgumentException("Revisions do not match");
  synchronized(LibraryDocumentsProvider.CONNECTION_LOCK){
   // Read/decrypt the connection once for the entire page, not once per id.
   JSONObject connection=settings.read();if(!connection.has("token"))throw new IllegalStateException();
   String account=connection.getString("endpoint")+"\n"+connection.getString("token");
   List<String> keys=new ArrayList<>();
   for(int i=0;i<ids.length();i++){
    signal.throwIfCanceled();String id=ids.getString(i);
    if(!id.matches("[A-Za-z0-9_-]{1,128}"))throw new IllegalArgumentException("Invalid asset id");
    keys.add(ThumbnailCache.mediaKey(account,id,"thumbnail",revisions==null||revisions.isNull(i)?"":revisions.getString(i)));
   }
   synchronized(cache){
    String generation=ThumbnailCache.key(account)+"/"+cache.warmGeneration();
    boolean[] hits=cache.cached(keys,cache.generation());JSONArray cached=new JSONArray();
    for(int i=0;i<hits.length;i++)if(hits[i])cached.put(ids.getString(i));
    signal.throwIfCanceled();
    return new JSONObject().put("generation",generation).put("cachedIds",cached);
   }
  }
 }
 void clear()throws IOException{synchronized(LibraryDocumentsProvider.CONNECTION_LOCK){for(CancellationSignal signal:active)signal.cancel();try{cache.clear();}finally{tickets.clear();proxy.clear();}}}
 InputStream stream(String key,long generation)throws IOException{return cache.open(key,generation);}
 private final ScheduledExecutorService ticketWorker=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"lakomics-media-tickets");t.setDaemon(true);return t;});
 private final TicketBatcher<Scope,JSONObject> tickets=new TicketBatcher<>(ticketWorker,this::fetchTickets,MediaRepository::ticketExpiry,System::currentTimeMillis);
 private static long ticketExpiry(JSONObject value){try{return java.time.Instant.parse(value.getString("expires_at")).toEpochMilli();}catch(Exception ignored){return 0;}}
 JSONObject prewarmTickets(JSONArray ids,CancellationSignal signal,java.util.function.BooleanSupplier allowed)throws Exception{
  if(ids.length()>50)throw new IllegalArgumentException("Too many tickets");
  List<TicketBatcher<Scope,JSONObject>.Waiter> waiters=new ArrayList<>();List<String> keys=new ArrayList<>();
  try{
   synchronized(LibraryDocumentsProvider.CONNECTION_LOCK){
    for(int i=0;i<ids.length();i++){
     signal.throwIfCanceled();if(!allowed.getAsBoolean())break;
     String id=ids.getString(i);if(keys.contains(id))continue;Scope scope=scope(id,"original");
     waiters.add(tickets.submit(scope.ticketGroup,scope,id,"original",()->signal.isCanceled() || !allowed.getAsBoolean() || scope.generation!=cache.generation()));keys.add(id);
    }
   }
   JSONArray ready=new JSONArray();
   for(int i=0;i<waiters.size();i++)try{JSONObject value=waiters.get(i).await();ready.put(new JSONObject().put("assetId",keys.get(i)).put("expires_at",value.getString("expires_at")));}catch(Exception failure){signal.throwIfCanceled();}
   return new JSONObject().put("items",ready);
  }finally{for(TicketBatcher<Scope,JSONObject>.Waiter waiter:waiters)waiter.close();}
 }
 private JSONObject ticket(String id,String variant,Scope scope,CancellationSignal signal)throws Exception{return ticket(id,variant,scope,signal,false);}
 private JSONObject ticket(String id,String variant,Scope scope,CancellationSignal signal,boolean fresh)throws Exception{
  try{
   PerfLog.Op perf=PerfLog.current.get();
   TicketBatcher<Scope,JSONObject>.Waiter waiter;
   long submitted;
   synchronized(LibraryDocumentsProvider.CONNECTION_LOCK){
    if(scope.generation!=cache.generation())throw new IOException("Cache invalidated");
    submitted=System.nanoTime();
    waiter=tickets.submit(scope.ticketGroup,scope,id,variant,()->signal!=null&&signal.isCanceled() || scope.generation!=cache.generation(),fresh);
   }
   try{return waiter.await();}finally{if(perf!=null){perf.ticket+=System.nanoTime()-submitted;perf.batch(waiter.timing());}}
  }catch(CancellationException canceled){if(signal!=null)signal.throwIfCanceled();throw new IOException("Cache invalidated");}
 }
 private List<JSONObject> fetchTickets(Scope scope,List<TicketBatcher.Item> items)throws Exception{
  // Only account/cache invalidation cancels shared HTTP, never one consumer leaving.
  CancellationSignal signal=new CancellationSignal();
  synchronized(LibraryDocumentsProvider.CONNECTION_LOCK){if(scope.generation!=cache.generation())throw new IOException("Cache invalidated");active.add(signal);}
  try{
   JSONArray requests=new JSONArray();for(TicketBatcher.Item item:items)requests.put(new JSONObject().put("asset_id",item.id).put("variant",item.variant));
   JSONObject body=new JSONObject().put("items",requests);
   JSONArray results;long httpStarted=System.nanoTime();
   try{results=client.apiFor(scope.connection,"/v1/library/media-tickets?verify_digest=true"+(items.get(0).fresh?"&fresh_head=true":""),"POST",body,signal).getJSONArray("items");}
   finally{if(!items.isEmpty()&&items.get(0).batch!=null)items.get(0).batch.httpNanos=System.nanoTime()-httpStarted;}
   List<JSONObject> matches=new ArrayList<>();
   for(TicketBatcher.Item item:items){JSONObject match=null;for(int i=0;i<results.length();i++){JSONObject result=results.getJSONObject(i);if(result.optString("asset_id").equals(item.id)&&result.optString("variant").equals(item.variant)){if(result.optBoolean("ok"))match=result;break;}}matches.add(match);}
   return matches;
  }finally{active.remove(signal);}
 }
 private JSONObject directTicket(String id,Scope scope,CancellationSignal signal)throws Exception{
  // The proxy streams these bytes to WebView as they arrive, so it cannot promise digest verification.
  PerfLog.Op perf=PerfLog.current.get();long started=System.nanoTime();
  try{return client.apiFor(scope.connection,"/v1/library/assets/"+Uri.encode(id)+"/media-ticket","POST",new JSONObject().put("variant","original"),signal);}
  finally{if(perf!=null)perf.ticket+=System.nanoTime()-started;}
 }
 /** Library media the WebView streams (videos, oversized images) goes through this proxy, never straight to storage. */
 private final MediaStreamProxy proxy=new MediaStreamProxy(PerfLog::write);
 MediaStreamProxy.Response stream(String token,String method,String range){return proxy.serve(token,method,range);}
 private static MediaStreamProxy.Ticket proxyTicket(JSONObject ticket)throws Exception{
  long expires=ticketExpiry(ticket);
  if(expires<=0)expires=System.currentTimeMillis()+1000L*ticket.optLong("expires_in",60);
  return new MediaStreamProxy.Ticket(ticket.getString("url"),expires,ticket.optLong("size_bytes",0));
 }
 /**
  * A `/media-stream/` URL for one original. The first ticket is fetched here so a missing
  * Asset still fails this call; later tickets are renewed by the proxy on expiry or 403.
  * The token dies with the cache generation: a cleared cache or replaced connection clears it.
  */
 private JSONObject proxied(String id,Scope scope,String mime,CancellationSignal signal)throws Exception{
  JSONObject first=directTicket(id,scope,signal);signal.throwIfCanceled();
  String type=MediaStreamProxy.safeMime(first.optString("content_type",""));
  if(type.equals("application/octet-stream"))type=MediaStreamProxy.safeMime(mime);
  MediaStreamProxy.Ticket initial=proxyTicket(first);String token;
  synchronized(LibraryDocumentsProvider.CONNECTION_LOCK){
   if(scope.generation!=cache.generation())throw new IOException("Cache invalidated");
   token=proxy.register(id,type,fresh->{
    CancellationSignal renew=new CancellationSignal();
    synchronized(LibraryDocumentsProvider.CONNECTION_LOCK){if(scope.generation!=cache.generation())throw new IOException("Cache invalidated");active.add(renew);}
    try{return proxyTicket(client.apiFor(scope.connection,"/v1/library/assets/"+Uri.encode(id)+"/media-ticket"+(fresh?"?fresh_head=true":""),"POST",new JSONObject().put("variant","original"),renew));}
    finally{active.remove(renew);}
   },initial);
  }
  JSONObject result=new JSONObject().put("url","https://app.lakomics.local"+MediaStreamProxy.PREFIX+token).put("expires_in",1800).put("content_type",type);
  if(initial.size>0)result.put("size_bytes",initial.size);
  return result;
 }
 static boolean imageMime(String mime){return mime!=null && mime.matches("image/(jpeg|png|webp|gif|avif|heic|heif|bmp)");}
 private JSONObject local(Scope scope,String mime)throws Exception{
  // The URL stays stable for the lifetime of one cached object so WebView can reuse its
  // own copy. A replaced connection or a cleared cache moves the generation, which
  // changes this URL, so the namespace remains invalidated by the existing paths.
  // A thumbnail revision is part of the key, so a regenerated thumbnail gets a new URL too.
  return new JSONObject().put("url",ThumbnailCache.localPath(scope.generation,scope.key)+"?mime="+Uri.encode(mime)).put("expires_in",240);
 }
 JSONObject browser(String id,String variant,String mime,CancellationSignal signal)throws Exception{return browser(id,variant,mime,"",signal);}
 JSONObject browser(String id,String variant,String mime,String revision,CancellationSignal signal)throws Exception{
  if(signal==null)signal=new CancellationSignal();signal.throwIfCanceled();
  Scope scope=scope(id,variant,revision);
  PerfLog.Op perf=PerfLog.current.get();
  if(variant.equals("original") && mime!=null && !mime.isEmpty() && !imageMime(mime)){if(perf!=null)perf.cache="proxy";return proxied(id,scope,mime,signal);}
  // Hold the existing reentrant fill lock before requesting a ticket: a caller
  // arriving during another image's download must recheck the cache, not issue a ticket.
  LockEntry entry=retainLock(scope.key);boolean locked=false;
  try{
   long lockStarted=System.nanoTime();
   try{lock(entry,signal);locked=true;}finally{if(perf!=null)perf.lock+=System.nanoTime()-lockStarted;}
   signal.throwIfCanceled();
   try{cache.file(scope.key,scope.generation);if(perf!=null)perf.cache="hit";return local(scope,variant.equals("thumbnail")?"image/webp":imageMime(mime)?mime:cachedImageMime(scope));}catch(FileNotFoundException ignored){if(perf!=null)perf.cache="miss";}
   JSONObject first=ticket(id,variant,scope,signal);
   if(variant.equals("original") && (!imageMime(first.optString("content_type")) || first.optLong("size_bytes",Long.MAX_VALUE)>MAX_VIEW_IMAGE)){if(perf!=null)perf.cache="proxy";return proxied(id,scope,first.optString("content_type",mime),signal);}
   fill(id,variant,scope,signal,first);signal.throwIfCanceled();
   return local(scope,variant.equals("thumbnail")?"image/webp":first.optString("content_type",mime));
  }finally{releaseLock(scope.key,entry,locked);}
 }
 private static boolean retryable(Exception error){
  if(error instanceof CloudClient.HttpFailure){int status=((CloudClient.HttpFailure)error).status;return status==408 || status==429 || status>=500 || status==403;}
  return error instanceof java.net.SocketTimeoutException || error instanceof java.net.SocketException || error instanceof EOFException;
 }
 private interface TicketSource {JSONObject read(boolean fresh)throws Exception;}
 private void fill(String id,String variant,Scope scope,CancellationSignal signal,JSONObject first)throws Exception{
  fillFrom(variant,scope,signal,first,fresh->ticket(id,variant,scope,signal,fresh));
 }
 private LockEntry retainLock(String key){synchronized(locks){LockEntry entry=locks.get(key);if(entry==null){entry=new LockEntry();locks.put(key,entry);}entry.users++;return entry;}}
 private void lock(LockEntry entry,CancellationSignal signal)throws Exception{
  long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(180);
  while(!entry.lock.tryLock(100,TimeUnit.MILLISECONDS)){signal.throwIfCanceled();if(System.nanoTime()>deadline)throw new IOException("Media busy");}
 }
 private void releaseLock(String key,LockEntry entry,boolean locked){if(locked)entry.lock.unlock();synchronized(locks){if(--entry.users==0)locks.remove(key);}}
 private void fillFrom(String variant,Scope scope,CancellationSignal signal,JSONObject first,TicketSource source)throws Exception{
  PerfLog.Op perf=PerfLog.current.get();
  LockEntry entry=retainLock(scope.key);
  boolean locked=false,permit=false;active.add(signal);
  try{
   long deadline=System.currentTimeMillis()+180000;
   long lockStarted=System.nanoTime();
   try{lock(entry,signal);locked=true;}finally{if(perf!=null)perf.lock+=System.nanoTime()-lockStarted;}
   signal.throwIfCanceled();
   try{cache.file(scope.key,scope.generation);return;}catch(FileNotFoundException ignored){}
   long permitStarted=System.nanoTime();
   try{while(!(permit=transfers.tryAcquire(100,TimeUnit.MILLISECONDS))){signal.throwIfCanceled();if(System.currentTimeMillis()>deadline)throw new IOException("Media busy");}}
   finally{if(perf!=null)perf.permit+=System.nanoTime()-permitStarted;}
   long maximum=variant.equals("thumbnail")?ThumbnailCache.MAX_FILE:MAX_ORIGINAL;
   JSONObject initial=first==null?source.read(false):first;
   long expected=initial.optLong("size_bytes",0);if(expected>maximum)throw new IOException("Original exceeds 512 MiB selection limit");
   long reservation=expected>0?expected:maximum;
   long obtainStarted=System.nanoTime();final long[] callbackNanos={0};
   try{cache.obtain(scope.key,scope.generation,reservation,file->{
    long callbackStarted=System.nanoTime();
    try{JSONObject current=initial;
    for(int attempt=0;;attempt++){
     signal.throwIfCanceled();
     try{client.download(current.getString("url"),file,reservation,signal);MediaTransfer.verifyTicket(file,current.optLong("size_bytes",0),current.isNull("sha256")?"":current.optString("sha256"));signal.throwIfCanceled();return;}
     catch(Exception failure){signal.throwIfCanceled();if(attempt>=1 || !retryable(failure))throw failure;current=source.read(true);}
    }
    }finally{callbackNanos[0]+=System.nanoTime()-callbackStarted;}
   });}finally{if(perf!=null){long elapsed=System.nanoTime()-obtainStarted;perf.obtain+=elapsed;perf.commit+=elapsed-callbackNanos[0];}}
  }finally{active.remove(signal);if(permit)transfers.release();releaseLock(scope.key,entry,locked);}
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
  try{fillFrom("thumbnail",scope,signal,external,fresh->external);}catch(CloudClient.HttpFailure failure){if(failure.status==403)throw new IOException("Catalog image URL expired");throw failure;}
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
  TicketSource source=fresh->client.api("/v1/collections/"+collection+"/artworks/"+artwork+"/media-ticket","POST",new JSONObject().put("variant",variant),signal);
  JSONObject first=source.read(false);
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
