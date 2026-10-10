package com.lakomics.mobile;
import android.os.Build;
import android.os.SystemClock;
import org.json.JSONObject;
import java.util.concurrent.*;

/** Opt-in measurements only; never retain payloads, paths, identities or credentials. */
final class StartupPerf {
 private static volatile long entered=-1,process=-1;
 private static final ThreadLocal<Request> current=new ThreadLocal<>();
 static void begin(){if(!PerfLog.enabled())return;entered=SystemClock.elapsedRealtime();process=Build.VERSION.SDK_INT>=24?android.os.Process.getStartElapsedRealtime():-1;phase("onCreateEntry");}
 static boolean enabled(){return entered>=0&&PerfLog.enabled()&&SystemClock.elapsedRealtime()-entered<=15000;}
 static long clock(){return entered>=0&&PerfLog.enabled()?SystemClock.elapsedRealtime():-1;}
 static void phase(String name){if(entered<0||!PerfLog.enabled())return;long now=SystemClock.elapsedRealtime();PerfLog.write("startupNative phase="+name+" activityMs="+(now-entered)+" processMs="+(process<0?-1:now-process));}
 static void step(String name,long start){if(start<0||!PerfLog.enabled())return;long now=SystemClock.elapsedRealtime();PerfLog.write("startupNative phase="+name+" activityMs="+(now-entered)+" processMs="+(process<0?-1:now-process)+" durationMs="+(now-start)+" uiThread="+(android.os.Looper.myLooper()==android.os.Looper.getMainLooper()?1:0));}
 // Exact public routes only. Dynamic identities collapse to a fixed family label.
 static String route(String path){
  if("download".equals(path))return "download";if(path==null)return "other";String p=path.split("\\?",2)[0];
  if(p.equals("/v1/library/assets"))return path.matches(".*[?&]subtree=1(?:&.*)?")?"library.assets.subtree":path.matches(".*[?&](tag|artist)=[^&]*(?:&.*)?")?"library.assets.search":"library.assets";
  if(p.equals("/v1/collections")){for(String type:new String[]{"manga","game","movie"})if(path.matches(".*[?&]type="+type+"(?:&.*)?"))return "collections."+type;return "collections";}
  if(p.matches("/v1/(library/(assets|summary|classifications|characters|characters/status|characters/review|similarity/review|revisit|list-generation|media-tickets)|captures/pending|home/(upcoming|av-pick)|collections(/(status|releases|releases/counts|bindings/status))?|mobile-catalog/(status|refresh|count|duplicates)|albums/(likes|assets|baseline|changes)|sync/status|assets/authority/(status|baseline|changes)|classifications/authority/(baseline|changes)|exchange/(devices|inbox|outbox))"))return p.substring(4).replace('/','.');
  if(p.matches("/v1/(library/search/description|albums/commands|classifications/authority/commands|home/upcoming/wishlist|collections/(bindings/(status|requests|search/(kakao|mangadex))|authority/(status|baseline|changes|trash|commands)|personal-edits|releases/acknowledge))"))return p.substring(4).replace('/','.');
  if(p.matches("/v1/collections/bindings/requests/[^/]+(/cancel)?"))return "collections.bindings.requests";
  if(p.startsWith("/v1/notes/"))return "notes";
  if(p.matches("/v1/collections/people/[^/]+"))return "collections.people";
  if(p.matches("/v1/collections/[^/]+/artworks/[^/]+/media-ticket"))return "collections.artworkTicket";
  if(p.matches("/v1/collections/[^/]+"))return "collections.work";
  if(p.startsWith("/v1/collections/"))return "collections.detail";
  if(p.startsWith("/v1/home/covers/"))return "home.coverTicket";
  if(p.startsWith("/v1/library/assets/"))return "library.assetTicket";
  return "other";
 }
 static boolean jsName(String name){return name!=null&&name.matches("other|notes|status|notesState|notesSync|syncSignals|albumTree|albumStatus|pickerStatus|exchangeState|exchangeDevices|cacheStatus|thumbnail|media|homeCover|collectionArtwork|catalogImage|mediaTickets|thumbnailsCached|collectionArtworksCached|library\\.(assets|assets\\.subtree|assets\\.search|search\\.description|summary|classifications|characters|characters\\.status|characters\\.review|similarity\\.review|revisit|list-generation|media-tickets|assetTicket)|captures\\.pending|home\\.(upcoming|upcoming\\.wishlist|av-pick|coverTicket)|collections(\\.(manga|game|movie|status|releases|releases\\.counts|bindings\\.(status|requests|search\\.(kakao|mangadex))|authority\\.(status|baseline|changes|trash|commands)|personal-edits|releases\\.acknowledge|people|artworkTicket|work|detail))?|mobile-catalog\\.(status|refresh|count|duplicates)|albums\\.(likes|assets|commands|baseline|changes)|classifications\\.authority\\.(commands|baseline|changes)|sync\\.status");}
 static Request submit(String operation,String payload,ThreadPoolExecutor pool,String lane){
  if(!enabled())return null;String name="other";
  if("api".equals(operation))try{name=route(new JSONObject(payload).optString("path"));}catch(Exception ignored){}
  else if(operation!=null&&operation.matches("status|notesState|notesSync|syncSignals|albumTree|albumStatus|pickerStatus|exchangeState|exchangeDevices|cacheStatus|thumbnail|media|homeCover|collectionArtwork|catalogImage|mediaTickets|thumbnailsCached|collectionArtworksCached"))name=operation;
  return new Request(name,pool,lane);
 }
 static final class Request {
  final long submitted=SystemClock.elapsedRealtime();final String route,lane;final int size,active,queued;long started=-1,delay;String status="error";
  Request(String name,ThreadPoolExecutor pool,String lane){route=name;this.lane=lane;size=pool.getPoolSize();active=pool.getActiveCount();queued=pool.getQueue().size();}
  void start(){started=SystemClock.elapsedRealtime();current.set(this);}
  long queue(){return started<0?-1:Math.max(0,started-submitted-delay);}
  void finish(String terminal){if(started>=0)current.remove();if(!PerfLog.enabled())return;long end=SystemClock.elapsedRealtime();PerfLog.write("startupRequest route="+route+" lane="+lane+" status="+(terminal==null?status:terminal)+" submitMs="+(submitted-entered)+" queueMs="+queue()+" runMs="+(started<0?-1:end-started)+" poolSize="+size+" active="+active+" queued="+queued);}
 }
 static Http http(String path){if(!PerfLog.enabled())return null;Request request=current.get();return enabled()||request!=null?new Http(route(path),request):null;}
 static final class Http {
  final long start=SystemClock.elapsedRealtime();final String route;final Request request;
  Http(String route,Request request){this.route=route;this.request=request;}
  void finish(boolean canceled){if(!PerfLog.enabled())return;PerfLog.write("startupHttp route="+route+" lane="+(request==null?"direct":request.lane)+" status="+(canceled?"canceled":"finished")+" startMs="+(start-entered)+" queueMs="+(request==null?-1:request.queue())+" runMs="+(SystemClock.elapsedRealtime()-start)+" poolSize="+(request==null?-1:request.size)+" active="+(request==null?-1:request.active));}
 }
 /** Same single-thread scheduled executor and task/Future semantics. Observe only when opted in. */
 static ScheduledExecutorService scheduled(String lane,ThreadFactory factory){
  if(!PerfLog.enabled())return Executors.newSingleThreadScheduledExecutor(factory);
  return new ScheduledThreadPoolExecutor(1,factory){
   @Override protected <V> RunnableScheduledFuture<V> decorateTask(Runnable r,RunnableScheduledFuture<V> task){return enabled()?new ScheduledTask<V>(task,this,lane):task;}
   @Override protected <V> RunnableScheduledFuture<V> decorateTask(Callable<V> c,RunnableScheduledFuture<V> task){return enabled()?new ScheduledTask<V>(task,this,lane):task;}
  };
 }
 private static final class ScheduledTask<V> implements RunnableScheduledFuture<V> {
  final RunnableScheduledFuture<V> task;final ThreadPoolExecutor pool;final String lane;Request timing;
  ScheduledTask(RunnableScheduledFuture<V> task,ThreadPoolExecutor pool,String lane){this.task=task;this.pool=pool;this.lane=lane;submitted();}
  void submitted(){timing=enabled()?new Request("task",pool,lane):null;if(timing!=null)timing.delay=Math.max(0,task.getDelay(TimeUnit.MILLISECONDS));}
  public void run(){Request previous=current.get(),measurement=timing;try{if(measurement!=null)measurement.start();task.run();}finally{if(previous==null)current.remove();else current.set(previous);if(task.isPeriodic())submitted();}}
  public boolean isPeriodic(){return task.isPeriodic();}
  public long getDelay(TimeUnit unit){return task.getDelay(unit);}
  public int compareTo(Delayed other){return task.compareTo(other instanceof ScheduledTask?((ScheduledTask<?>)other).task:other);}
  public boolean cancel(boolean interrupt){return task.cancel(interrupt);}
  public boolean isCancelled(){return task.isCancelled();}
  public boolean isDone(){return task.isDone();}
  public V get()throws InterruptedException,ExecutionException{return task.get();}
  public V get(long timeout,TimeUnit unit)throws InterruptedException,ExecutionException,TimeoutException{return task.get(timeout,unit);}
 }
}
