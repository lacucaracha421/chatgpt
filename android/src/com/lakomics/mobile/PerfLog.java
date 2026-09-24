package com.lakomics.mobile;

import android.util.Log;
import org.json.JSONObject;
import java.util.Locale;

/** Measurements only. No request scheduling, payloads, credentials or URLs. */
final class PerfLog {
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
   if(asset.equals("-"))try{JSONObject p=new JSONObject(payload);asset=id(p.optString("assetId"));request=id(p.optString("perfId"));}catch(Exception ignored){}
   write(operation+" id="+asset+" req="+request+" status="+status+" cache="+cache+
    " queueMs="+(started?ms(queue):"-1")+" lockMs="+ms(lock)+" ticketMs="+ms(ticket)+
    " batch="+(batches.length()==0?"-":batches)+" permitMs="+ms(permit)+" downloadMs="+ms(download)+
    " bytes="+bytes+" commitMs="+ms(commit)+" obtainMs="+ms(obtain)+" totalMs="+ms(total)+
    " inflightThumb="+inflightThumb+" inflightMedia="+inflightMedia+" queuedThumb="+queuedThumb+" queuedMedia="+queuedMedia+" queued="+queued);
  }
 }
 /** One-way bridge: fixed vocabulary and numeric fields only, never arbitrary JS text. */
 static void javascript(String payload){
  try{
   if(payload==null||payload.length()>2048)return;
   JSONObject p=new JSONObject(payload);
   String event=p.optString("event"),source=p.optString("source"),status=p.optString("status"),kind=p.optString("kind");
   if(!event.matches("open|native|decoded|commit|end|prefetch_start|prefetch_finish")||
      !source.matches("unknown|prepared|memory|shared|native|pending")||
      !status.matches("ok|error|canceled")||!kind.matches("image|video|other"))return;
   StringBuilder line=new StringBuilder("js event=").append(event).append(" id=").append(id(p.optString("id")))
    .append(" req=").append(id(p.optString("req"))).append(" kind=").append(kind)
    .append(" prepared=").append(p.optBoolean("prepared")?1:0).append(" source=").append(source).append(" status=").append(status);
   for(String key:new String[]{"elapsedMs","nativeMs","decodeMs","commitMs"}){
    double value=p.optDouble(key,-1);if(!Double.isNaN(value)&&!Double.isInfinite(value)&&value>=0)
     line.append(' ').append(key).append('=').append(String.format(Locale.ROOT,"%.3f",value));
   }
   write(line.toString());
  }catch(Exception ignored){}
 }
}
