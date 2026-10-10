package com.lakomics.mobile;

import android.os.SystemClock;
import java.io.*;
import java.util.LinkedHashMap;
import java.util.Map;

/** Process-local, opt-in CloudClient body accounting. No URLs or identities are retained. */
final class HttpSessionPerf {
 private static Map<String,Counts> routes;
 private static long started=-1,lastLog;
 private static final class Counts {
  long requests,finished,failed,canceled,bytesIn,bytesOut,failedBytesIn,failedBytesOut,canceledBytesIn,canceledBytesOut;
 }
 static Sample begin(String path){
  if(!PerfLog.enabled())return null;
  synchronized(HttpSessionPerf.class){
   long now=SystemClock.elapsedRealtime();if(started<0){started=now;lastLog=now;routes=new LinkedHashMap<>();}
   String route=StartupPerf.route(path);Counts counts=routes.get(route);
   if(counts==null){counts=new Counts();routes.put(route,counts);}counts.requests++;
   return new Sample(counts);
  }
 }
 static void log(){
  if(!PerfLog.enabled()||started<0)return;
  synchronized(HttpSessionPerf.class){
  long now=SystemClock.elapsedRealtime();lastLog=now;
  for(Map.Entry<String,Counts> entry:routes.entrySet()){
   Counts c=entry.getValue();
   PerfLog.write("sessionHttp route="+entry.getKey()+" sessionMs="+(now-started)+" requests="+c.requests+
    " finished="+c.finished+" failed="+c.failed+" canceled="+c.canceled+" pending="+(c.requests-c.finished-c.failed-c.canceled)+
    " bytesIn="+c.bytesIn+" bytesOut="+c.bytesOut+" failedBytesIn="+c.failedBytesIn+" failedBytesOut="+c.failedBytesOut+
    " canceledBytesIn="+c.canceledBytesIn+" canceledBytesOut="+c.canceledBytesOut);
  }
  }
 }
 static InputStream input(InputStream stream,Sample sample){
  if(sample==null||stream==null)return stream;
  return new FilterInputStream(stream){
   @Override public int read()throws IOException{int value=in.read();if(value>=0)sample.received(1);return value;}
   @Override public int read(byte[] b,int off,int len)throws IOException{int n=in.read(b,off,len);if(n>0)sample.received(n);return n;}
  };
 }
 static OutputStream output(OutputStream stream,Sample sample){
  if(sample==null)return stream;
  return new FilterOutputStream(stream){
   @Override public void write(int value)throws IOException{out.write(value);sample.sent(1);}
   @Override public void write(byte[] b,int off,int len)throws IOException{out.write(b,off,len);sample.sent(len);}
   @Override public void close()throws IOException{out.close();}
  };
 }
 static final class Sample {
  final Counts counts;long bytesIn,bytesOut;boolean done;
  Sample(Counts counts){this.counts=counts;}
  void received(int n){if(!PerfLog.enabled())return;synchronized(HttpSessionPerf.class){bytesIn+=n;counts.bytesIn+=n;}}
  void sent(int n){if(!PerfLog.enabled())return;synchronized(HttpSessionPerf.class){bytesOut+=n;counts.bytesOut+=n;}}
  void finish(boolean success,boolean canceled){
   if(!PerfLog.enabled())return;
   synchronized(HttpSessionPerf.class){
    if(done)return;done=true;
    if(canceled){counts.canceled++;counts.canceledBytesIn+=bytesIn;counts.canceledBytesOut+=bytesOut;}
    else if(success)counts.finished++;
    else{counts.failed++;counts.failedBytesIn+=bytesIn;counts.failedBytesOut+=bytesOut;}
    // Completion-driven snapshots avoid another executor/timer or any idle work.
    if(PerfLog.enabled()&&SystemClock.elapsedRealtime()-lastLog>=60000)log();
   }
  }
 }
}
