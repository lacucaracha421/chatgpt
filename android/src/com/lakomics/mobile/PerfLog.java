package com.lakomics.mobile;

import android.util.Log;
import org.json.JSONObject;
import java.util.Locale;

/** Measurements only. No request scheduling, payloads, credentials or URLs. */
final class PerfLog {
 // Android's tag property is opt-in (DEBUG); ordinary INFO logging does not enable catalog timing.
 private static final boolean ENABLED=Log.isLoggable("LakomicsPerf",Log.DEBUG);
 static boolean enabled(){return ENABLED;}
 static double millis(JSONObject p,String key){double value=p.optDouble(key,-1);return Double.isNaN(value)||Double.isInfinite(value)||value<0||value>180000?-1:value;}
 static final ThreadLocal<Op> current=new ThreadLocal<>();
 static String id(String value){return value!=null&&value.matches("[A-Za-z0-9_-]{1,128}")?value:"-";}
 static String ms(long nanos){return String.format(Locale.ROOT,"%.3f",nanos/1_000_000.0);}
 static void write(String line){try{Log.i("LakomicsPerf",line);}catch(RuntimeException ignored){}}
 static final class Pool {
  private int runningThumb,runningMedia,waitingThumb,waitingMedia;
  synchronized Op submit(String operation,int queued){
   Op op=new Op(operation,runningThumb,runningMedia,waitingThumb,waitingMedia,queued);
   if(operation.equals("thumbnail"))waitingThumb++;else waitingMedia++;
   return op;
  }
  synchronized void start(Op op){
   op.queue=System.nanoTime()-op.submitted;op.started=true;
   if(op.operation.equals("thumbnail")){waitingThumb--;runningThumb++;}else{waitingMedia--;runningMedia++;}
   current.set(op);
  }
  synchronized void remove(Op op){
   if(op.operation.equals("thumbnail")){if(op.started)runningThumb--;else waitingThumb--;}
   else{if(op.started)runningMedia--;else waitingMedia--;}
   if(op.started)current.remove();
  }
 }
 static final class Op {
  final long submitted=System.nanoTime();
  final String operation;
  final int inflightThumb,inflightMedia,queuedThumb,queuedMedia,queued;
  boolean started;
  String asset="-",request="-",cache="unknown",status="error";
  long queue,lock,ticket,permit,download,bytes,commit,obtain;
  double jsQueue=-1;
  int downloads,httpStatus,rateLimited;
  final StringBuilder batches=new StringBuilder();
  Op(String operation,int it,int im,int qt,int qm,int q){this.operation=operation;inflightThumb=it;inflightMedia=im;queuedThumb=qt;queuedMedia=qm;queued=q;}
  void batch(TicketBatcher.Batch timing){
   if(timing==null)return;
   if(batches.length()>0)batches.append(',');
   batches.append(timing.id).append(':').append(timing.size).append(':').append(timing.httpNanos<0?"-1":ms(timing.httpNanos));
  }
  void finish(String payload){
   long total=System.nanoTime()-submitted;
   // Canceled-before-start and rejected ops never reach the normal payload parse.
   if(asset.equals("-"))try{JSONObject p=new JSONObject(payload);asset=id(p.optString(operation.equals("catalogCover")?"workId":operation.equals("collectionArtwork")?"artworkId":"assetId"));request=id(p.optString("perfId"));jsQueue=millis(p,"jsQueueMs");}catch(Exception ignored){}
   write(operation+" req="+request+" status="+status+" cache="+cache+
    " queueMs="+(started?ms(queue):"-1")+" lockMs="+ms(lock)+" ticketMs="+ms(ticket)+
    " batch="+(batches.length()==0?"-":batches)+" permitMs="+ms(permit)+" downloadMs="+ms(download)+
    " bytes="+bytes+" commitMs="+ms(commit)+" obtainMs="+ms(obtain)+" totalMs="+ms(total)+
    " inflightThumb="+inflightThumb+" inflightMedia="+inflightMedia+" queuedThumb="+queuedThumb+" queuedMedia="+queuedMedia+" queued="+queued+
    ((operation.equals("catalogCover")||operation.equals("collectionArtwork"))?" jsQueueMs="+String.format(Locale.ROOT,"%.3f",jsQueue)+" nativeQueueMs="+(started?ms(queue):"-1")+" storeMs="+ms(commit)+" downloads="+downloads+" httpStatus="+httpStatus+" rateLimited="+rateLimited:""));
  }
 }
 /** One-way bridge: fixed vocabulary and numeric fields only, never arbitrary JS text. */
 static void javascript(String payload){
  if(!enabled())return;
  try{
   if(payload==null||payload.length()>16384)return;
   JSONObject p=new JSONObject(payload);
   if("http_session".equals(p.optString("event"))){HttpSessionPerf.log();return;}
   if("screen".equals(p.optString("event"))){
    String screen=p.optString("screen"),trigger=p.optString("trigger"),status=p.optString("status");
    if(!screen.matches("home|assets|collections|catalog|notes|more|collection\\.work|album|folder|releaseCalendar|contentSearch|catalog\\.reader")||!trigger.matches("tab|open|back")||!status.matches("ok|incomplete|error|canceled"))return;
    write("js screen="+screen+" trigger="+trigger+" readyMs="+millis(p,"readyMs")+" imagesReadyMs="+millis(p,"imagesReadyMs")+" status="+status);return;
   }
   if("startup".equals(p.optString("event"))||"startup_request".equals(p.optString("event"))){
    if(!enabled())return;
    if("startup_request".equals(p.optString("event"))){
     String name=p.optString("name"),status=p.optString("status");if(!StartupPerf.jsName(name)||!status.matches("ok|error|canceled"))return;
     write("js startupRequest="+name+" status="+status+" startMs="+millis(p,"startMs")+" endMs="+millis(p,"endMs"));return;
    }
    StringBuilder line=new StringBuilder("js startup=1");
    for(String key:new String[]{"firstReactRenderMs","homeReadyMs","viewportImagesReadyMs","splashLeavingMs","splashEndMs"})line.append(' ').append(key).append('=').append(millis(p,key));
    org.json.JSONArray requests=p.optJSONArray("requests");int issued=0,cancelled=0,reissued=0,pending=0;
    StringBuilder routes=new StringBuilder();
    if(requests==null||requests.length()>64)return;
    for(int i=0;i<requests.length();i++){
     JSONObject r=requests.getJSONObject(i);String name=r.optString("name");if(!StartupPerf.jsName(name))return;
     int n=r.optInt("issued"),c=r.optInt("cancelled"),a=r.optInt("reissued"),w=r.optInt("pending");if(n<0||n>10000||c<0||c>n||a<0||a>n||w<0||w>n)return;
     issued+=n;cancelled+=c;reissued+=a;pending+=w;
     if(routes.length()>0)routes.append(',');
     routes.append(name).append(':').append(millis(r,"firstStartMs")).append(':').append(millis(r,"firstEndMs")).append(':').append(millis(r,"lastEndMs")).append(':').append(n).append(':').append(c).append(':').append(a).append(':').append(w);
    }
    write(line+" issued="+issued+" cancelled="+cancelled+" reissued="+reissued+" pending="+pending+" requests="+(routes.length()==0?"-":routes));return;
   }
   if(payload.length()>2048)return;
   if("catalog_screen".equals(p.optString("event"))){
    if(!enabled())return;
    int visible=p.optInt("visible",0),loaded=p.optInt("loaded",-1);
    String status=p.optString("status");
    if(visible<1||visible>200||loaded<0||loaded>visible||!status.matches("ok|incomplete"))return;
    write("js catalogScreen="+id(p.optString("screen"))+" status="+status+" visible="+visible+" loaded="+loaded+
     " firstCoverMs="+String.format(Locale.ROOT,"%.3f",millis(p,"firstCoverMs"))+" visible90Ms="+String.format(Locale.ROOT,"%.3f",millis(p,"visible90Ms")));
    return;
   }
   if("video".equals(p.optString("event"))){
    // Library video element state: fixed event names and small integers only.
    String media=p.optString("media"),name=p.optString("name");
    if(!media.matches("loadstart|loadedmetadata|canplay|playing|waiting|stalled|suspend|abort|emptied|error|retry")||!name.matches("[A-Z0-9_]{0,48}"))return;
    StringBuilder line=new StringBuilder("js video=").append(media)
     .append(" network=").append(p.optInt("network",-1)).append(" ready=").append(p.optInt("ready",-1));
    if(p.has("code"))line.append(" code=").append(p.optInt("code",-1)).append(" name=").append(name.isEmpty()?"-":name);
    write(line.toString());return;
   }
   String event=p.optString("event"),source=p.optString("source"),status=p.optString("status"),kind=p.optString("kind");
   if(!event.matches("open|native|decoded|commit|end|prefetch_start|prefetch_finish")||
      !source.matches("unknown|prepared|memory|shared|native|pending")||
      !status.matches("ok|error|canceled")||!kind.matches("image|video|other"))return;
   StringBuilder line=new StringBuilder("js event=").append(event)
    .append(" req=").append(id(p.optString("req"))).append(" kind=").append(kind)
    .append(" prepared=").append(p.optBoolean("prepared")?1:0).append(" source=").append(source).append(" status=").append(status);
   for(String key:new String[]{"elapsedMs","nativeMs","decodeMs","commitMs","tapToDisplayedMs"}){
    double value=p.optDouble(key,-1);if(!Double.isNaN(value)&&!Double.isInfinite(value)&&value>=0)
     line.append(' ').append(key).append('=').append(String.format(Locale.ROOT,"%.3f",value));
   }
   write(line.toString());
  }catch(Exception ignored){}
 }
}
