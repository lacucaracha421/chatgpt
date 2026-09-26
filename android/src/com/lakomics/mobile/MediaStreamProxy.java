package com.lakomics.mobile;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/**
 * Native Range proxy for library media the WebView plays (`/media-stream/<token>`).
 *
 * The WebView never reaches storage for these assets: a stale pooled keep-alive socket to the
 * storage host stalled its media requests for ~2 min (2026-09-26 device evidence). Here each
 * storage request uses a fresh connection, a stalled first attempt is retried on another
 * fresh connection before any byte reaches the player, and a stream that stalls mid-body
 * resumes from its position. Platform-free: Android glue lives in {@link MediaRepository}
 * and {@link MainActivity}.
 */
final class MediaStreamProxy {
 static final String PREFIX="/media-stream/";
 /** A presigned storage URL; `expiresAt` is epoch millis, `size` the object size or <= 0. */
 static final class Ticket {
  final String url;final long expiresAt,size;
  Ticket(String url,long expiresAt,long size){this.url=url;this.expiresAt=expiresAt;this.size=size;}
 }
 /** The asset's ticket source; `fresh` asks the server to re-read the object's metadata. */
 interface Tickets {Ticket fetch(boolean fresh)throws Exception;}
 /** One storage request whose status line and headers have arrived. */
 interface Connection {int status();String header(String name);InputStream body()throws IOException;void disconnect();}
 interface Upstream {Connection open(String url,String range,int connectMs,int readMs)throws IOException;}
 /** What the WebView receives; Content-Type travels as `mime`. */
 static final class Response {
  final int status;final String reason,mime;final Map<String,String> headers;final InputStream body;
  Response(int status,String reason,String mime,Map<String,String> headers,InputStream body){this.status=status;this.reason=reason;this.mime=mime;this.headers=headers;this.body=body;}
 }
 static final class Limits {
  int streams=4,tokens=64,resumes=2,head=32768;
  long permitWaitMs=8000,evictIdleMs=2000,tokenIdleMs=TimeUnit.HOURS.toMillis(2),openBudgetMs=30000,renewBeforeMs=60000;
  /** The first attempt fails fast so its retry lands before the viewer's own 8 s check. */
  int firstConnectMs=2000,firstReadMs=5000,connectMs=3000,readMs=15000;
 }

 private final Upstream upstream;
 private final Consumer<String> log;
 private final LongSupplier clock;
 private final Limits limits;
 private final Semaphore permits;
 private final SecureRandom random=new SecureRandom();
 private final LinkedHashMap<String,Entry> tokens=new LinkedHashMap<>(16,0.75f,true);
 private final Set<Body> streams=new HashSet<>();

 MediaStreamProxy(Upstream upstream,Consumer<String> log,LongSupplier clock,Limits limits){
  this.upstream=upstream;this.log=log;this.clock=clock;this.limits=limits;permits=new Semaphore(limits.streams,true);
 }
 MediaStreamProxy(Consumer<String> log){this(new HttpUpstream(),log,System::currentTimeMillis,new Limits());}

 /**
  * One token's asset. `close` takes no lock: it runs under the app's connection lock, while a
  * renewal holds `renewal` and then takes that connection lock for its HTTP call.
  */
 private static final class Entry {
  final String asset,mime;final Tickets tickets;
  long lastUsed;
  private final Object renewal=new Object();
  private volatile Ticket ticket;private volatile long total;private volatile boolean closed;
  Entry(String asset,String mime,Tickets tickets,Ticket initial,long now){this.asset=asset;this.mime=mime;this.tickets=tickets;ticket=initial;lastUsed=now;}
  /** The current ticket, renewed when near expiry or when `stale` is still the current one. */
  Ticket ticket(Ticket stale,long now,long renewBefore)throws Exception{
   synchronized(renewal){
    if(closed)throw new IOException("Media stream invalidated");
    Ticket current=ticket;boolean failed=stale!=null&&current==stale;
    if(current==null||failed||current.expiresAt-now<renewBefore){
     Ticket next=tickets.fetch(failed);
     if(next==null||next.url==null)throw new IOException("No media ticket");
     if(closed)throw new IOException("Media stream invalidated");
     ticket=current=next;
    }
    return current;
   }
  }
  long expected(Ticket used){return used.size>0?used.size:total;}
  void observed(long size){total=size;}
  long total(){Ticket current=ticket;return current!=null&&current.size>0?current.size:total;}
  boolean closed(){return closed;}
  void close(){closed=true;}
 }

 /** Registers an asset and returns its unguessable token (128 random bits, lowercase hex). */
 String register(String asset,String mime,Tickets tickets,Ticket initial){
  byte[] bytes=new byte[16];random.nextBytes(bytes);
  StringBuilder token=new StringBuilder(32);for(byte b:bytes)token.append(String.format(Locale.ROOT,"%02x",b&255));
  long now=clock.getAsLong();
  synchronized(this){
   prune(now);
   while(tokens.size()>=limits.tokens){Iterator<Entry> eldest=tokens.values().iterator();eldest.next().close();eldest.remove();}
   tokens.put(token.toString(),new Entry(asset,safeMime(mime),tickets,initial,now));
  }
  return token.toString();
 }
 private void prune(long now){for(Iterator<Entry> it=tokens.values().iterator();it.hasNext();){Entry e=it.next();if(now-e.lastUsed>limits.tokenIdleMs){e.close();it.remove();}}}
 /** Invalidates every token and stops every open stream (connection change, cache clear). */
 void clear(){
  List<Body> open;int count;
  synchronized(this){count=tokens.size();for(Entry e:tokens.values())e.close();tokens.clear();open=new ArrayList<>(streams);}
  for(Body body:open)body.abort("cleared");
  if(count>0||!open.isEmpty())log.accept("media-proxy clear tokens="+count+" streams="+open.size());
 }
 synchronized int activeStreams(){return streams.size();}
 synchronized int tokenCount(){return tokens.size();}

 static String safeMime(String mime){return mime!=null&&mime.matches("(video|audio|image)/[a-z0-9.+-]{1,64}")?mime:"application/octet-stream";}
 static String logId(String value){return value!=null&&value.matches("[A-Za-z0-9_-]{1,128}")?value:"-";}
 private static String ms(long nanos){return String.format(Locale.ROOT,"%.1f",nanos/1_000_000.0);}
 private static Response error(int status,String reason,Map<String,String> headers){return new Response(status,reason,"text/plain",headers,new java.io.ByteArrayInputStream(new byte[0]));}

 /** Serves one WebView request. Blocks while storage answers; every failure closes its connection. */
 Response serve(String token,String method,String rangeHeader){
  long started=System.nanoTime();
  Entry entry=null;
  synchronized(this){
   long now=clock.getAsLong();
   if(token!=null&&token.matches("[0-9a-f]{32}"))entry=tokens.get(token);
   if(entry!=null&&now-entry.lastUsed>limits.tokenIdleMs){entry.close();tokens.remove(token);entry=null;}
   if(entry!=null)entry.lastUsed=now;
  }
  if(entry==null){log.accept("media-proxy fail id=- status=404 reason=gone attempts=0 totalMs="+ms(System.nanoTime()-started));return error(404,"Not Found",MediaStreamRange.base());}
  String id=logId(entry.asset);
  if(!"GET".equals(method))return error(405,"Method Not Allowed",MediaStreamRange.base());
  MediaStreamRange.Request request;
  try{request=MediaStreamRange.parse(rangeHeader);}
  catch(MediaStreamRange.Unsupported e){log.accept("media-proxy fail id="+id+" status=416 reason=range attempts=0 totalMs="+ms(System.nanoTime()-started));return error(416,"Range Not Satisfiable",MediaStreamRange.unsatisfiable(entry.total()));}
  boolean permit;
  try{permit=acquire();}catch(InterruptedException e){Thread.currentThread().interrupt();permit=false;}
  long waited=System.nanoTime()-started;
  if(!permit){log.accept("media-proxy fail id="+id+" status=503 reason=busy attempts=0 totalMs="+ms(waited));return error(503,"Service Unavailable",MediaStreamRange.base());}
  boolean handed=false;
  try{
   Opened opened=open(entry,request,-1);
   if(opened.plan==null){
    log.accept("media-proxy fail id="+id+" status=416 reason=range attempts="+opened.attempts+" totalMs="+ms(System.nanoTime()-started));
    return error(416,"Range Not Satisfiable",MediaStreamRange.unsatisfiable(opened.unsatisfiedTotal));
   }
   Body body=new Body(entry,opened);
   synchronized(this){if(entry.closed()){opened.connection.disconnect();return error(404,"Not Found",MediaStreamRange.base());}streams.add(body);}
   handed=true;
   log.accept("media-proxy open id="+id+" status="+opened.plan.status+" range="+(request==null?"none":request.kind())+" attempts="+opened.attempts+" refreshed="+(opened.refreshed?1:0)
    +" waitMs="+ms(waited)+" headersMs="+ms(opened.headersNanos)+" firstByteMs="+ms(opened.firstByteNanos)+" totalMs="+ms(System.nanoTime()-started)+" active="+activeStreams());
   return new Response(opened.plan.status,opened.plan.reason(),entry.mime,opened.plan.headers(),body);
  }catch(Failure failure){
   log.accept("media-proxy fail id="+id+" status="+failure.status+" reason="+failure.reason+" attempts="+failure.attempts+" totalMs="+ms(System.nanoTime()-started));
   return error(failure.status,failure.status==404?"Not Found":failure.status==504?"Gateway Timeout":"Bad Gateway",MediaStreamRange.base());
  }finally{if(!handed)permits.release();}
 }

 /** A permit, reclaiming a stream that read nothing recently when all are held. */
 private boolean acquire()throws InterruptedException{
  long deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(limits.permitWaitMs);
  while(true){
   if(permits.tryAcquire(100,TimeUnit.MILLISECONDS))return true;
   long now=System.nanoTime();
   Body idle=null;
   synchronized(this){for(Body body:streams)if(now-body.lastActive>=TimeUnit.MILLISECONDS.toNanos(limits.evictIdleMs)&&(idle==null||body.lastActive<idle.lastActive))idle=body;}
   if(idle!=null)idle.abort("evicted");
   if(now-deadline>=0)return permits.tryAcquire();
  }
 }

 static final class Failure extends Exception {
  final int status,attempts;final String reason;
  Failure(int status,String reason,int attempts){super(reason);this.status=status;this.reason=reason;this.attempts=attempts;}
 }
 /** A validated storage reply with its first body bytes already read. `plan` is null for a 416. */
 static final class Opened {
  Connection connection;InputStream in;MediaStreamRange.Plan plan;byte[] head;int headLength,attempts;boolean refreshed;long headersNanos,firstByteNanos,unsatisfiedTotal=-1;
 }
 /**
  * Opens storage for `request` with at most one retry on a fresh connection (stall, network
  * error, 408/429/5xx) and one ticket renewal (403/404/410 or a reply that does not match).
  * `resumeTotal` > 0 pins the object size of a stream being resumed.
  */
 private Opened open(Entry entry,MediaStreamRange.Request request,long resumeTotal)throws Failure{
  long deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(limits.openBudgetMs);
  boolean resume=resumeTotal>0,retried=false,refreshed=false;
  int attempts=0;Ticket stale=null;Failure last=null;
  while(true){
   if(attempts>0&&System.nanoTime()-deadline>=0)throw last;
   attempts++;
   Ticket ticket;
   try{ticket=entry.ticket(stale,clock.getAsLong(),limits.renewBeforeMs);}
   catch(Exception e){throw new Failure(entry.closed()?404:502,entry.closed()?"invalidated":"ticket",attempts);}
   stale=null;
   boolean fast=attempts==1&&!resume;
   Connection c=null;boolean keep=false;long t0=System.nanoTime();
   try{
    c=upstream.open(ticket.url,request==null?null:request.header(),fast?limits.firstConnectMs:limits.connectMs,fast?limits.firstReadMs:limits.readMs);
    int status=c.status();long headers=System.nanoTime()-t0;
    if(status==403||status==404||status==410){
     last=new Failure(status==403?502:404,"expired",attempts);
     if(!refreshed){refreshed=true;stale=ticket;continue;}
     throw last;
    }
    if(status==416){
     if(resume)throw new Failure(502,"mismatch",attempts);
     Opened unsatisfied=new Opened();unsatisfied.attempts=attempts;unsatisfied.refreshed=refreshed;unsatisfied.unsatisfiedTotal=MediaStreamRange.unsatisfiedTotal(c.header("Content-Range"));
     return unsatisfied;
    }
    if(status==408||status==429||status>=500){
     last=new Failure(502,"http",attempts);
     if(!retried){retried=true;continue;}
     throw last;
    }
    if(status!=200&&status!=206)throw new Failure(502,"http",attempts);
    String encoding=c.header("Content-Encoding");
    if(encoding!=null&&!encoding.trim().equalsIgnoreCase("identity"))throw new Failure(502,"mismatch",attempts);
    MediaStreamRange.Plan plan;
    try{plan=MediaStreamRange.validate(request,status,c.header("Content-Range"),c.header("Content-Length"),resume?resumeTotal:entry.expected(ticket));}
    catch(MediaStreamRange.Mismatch mismatch){
     last=new Failure(502,"mismatch",attempts);
     if(!refreshed&&!resume){refreshed=true;stale=ticket;continue;}
     throw last;
    }
    if(!resume)entry.observed(plan.total);
    // Read the first bytes here: a reply that stalls before its body is retried on a
    // fresh connection instead of being handed to the player.
    InputStream in=c.body();byte[] head=new byte[(int)Math.min(limits.head,plan.count)];int n=0;
    while(n==0)n=in.read(head,0,head.length);
    if(n<0)throw new EOFException("Storage reply has no body");
    Opened opened=new Opened();
    opened.connection=c;opened.in=in;opened.plan=plan;opened.head=head;opened.headLength=n;opened.attempts=attempts;opened.refreshed=refreshed;
    opened.headersNanos=headers;opened.firstByteNanos=System.nanoTime()-t0;
    keep=true;return opened;
   }catch(IOException e){
    last=new Failure(e instanceof SocketTimeoutException?504:502,e instanceof SocketTimeoutException?"timeout":e instanceof EOFException?"eof":"io",attempts);
    if(!retried){retried=true;continue;}
    throw last;
   }finally{if(!keep&&c!=null)c.disconnect();}
  }
 }

 /**
  * The response body. Positions are object offsets, as in the vault's body: Android WebView
  * applies the request's Range itself by calling skip(first byte) before reading, so skip only
  * moves the position, and a read never returns bytes outside [start, end).
  */
 final class Body extends InputStream {
  private final Entry entry;final long start,end,total;
  private final long opened=System.nanoTime();
  private Connection connection;private InputStream in;
  private byte[] head;private int headAt,headEnd;
  private long position,upstream,bytes;private int resumes;
  private volatile boolean aborted;private volatile String reason="closed";
  volatile long lastActive=System.nanoTime();
  private final AtomicBoolean finished=new AtomicBoolean();
  Body(Entry entry,Opened o){
   this.entry=entry;start=o.plan.start;end=o.plan.end();total=o.plan.total;
   connection=o.connection;in=o.in;head=o.head;headEnd=o.headLength;upstream=start;
  }
  private void check()throws IOException{if(aborted)throw new IOException("Media stream closed");}
  @Override public int available(){return 0;}
  @Override public long skip(long n)throws IOException{
   check();
   if(n<=0||position>=end)return 0;
   long moved=Math.min(n,end-position);position+=moved;return moved;
  }
  @Override public int read()throws IOException{byte[] one=new byte[1];int n=read(one,0,1);return n<0?-1:one[0]&255;}
  @Override public int read(byte[] target,int offset,int count)throws IOException{
   if(offset<0||count<0||count>target.length-offset)throw new IndexOutOfBoundsException();
   check();
   if(count==0)return 0;
   if(position<start)position=start;
   if(position>=end)return -1;
   lastActive=System.nanoTime();
   while(true){
    try{
     // A forward skip past `start` (not done by WebView today) discards the gap.
     while(upstream<position){byte[] gap=new byte[(int)Math.min(32768,position-upstream)];upstream+=raw(gap,0,gap.length);}
     int n=raw(target,offset,(int)Math.min(count,end-position));
     upstream+=n;position+=n;bytes+=n;lastActive=System.nanoTime();
     return n;
    }catch(IOException failure){
     if(aborted)throw new IOException("Media stream closed");
     resume(failure);
    }
   }
  }
  private int raw(byte[] target,int offset,int count)throws IOException{
   if(head!=null&&headAt<headEnd){int n=Math.min(count,headEnd-headAt);System.arraycopy(head,headAt,target,offset,n);headAt+=n;if(headAt==headEnd)head=null;return n;}
   int n;do{n=in.read(target,offset,count);}while(n==0);
   if(n<0)throw new EOFException("Storage reply ended early");
   return n;
  }
  /** Continues from the current position on a fresh connection, at most `limits.resumes` times. */
  private void resume(IOException cause)throws IOException{
   String id=logId(entry.asset);long started=System.nanoTime();
   String why=cause instanceof SocketTimeoutException?"timeout":cause instanceof EOFException?"eof":"io";
   if(resumes>=limits.resumes){log.accept("media-proxy resume id="+id+" ok=0 reason="+why+" attempts=0 resumes="+resumes+" totalMs=0.0");abort("error");throw cause;}
   resumes++;
   Connection previous;synchronized(this){previous=connection;connection=null;in=null;head=null;}
   if(previous!=null)previous.disconnect();
   Opened next;
   try{next=open(entry,MediaStreamRange.Request.from(upstream,end-1),total);}
   catch(Failure failure){log.accept("media-proxy resume id="+id+" ok=0 reason="+why+" attempts="+failure.attempts+" resumes="+resumes+" totalMs="+ms(System.nanoTime()-started));abort("error");throw new IOException("Media stream resume failed",cause);}
   if(next.plan==null||next.plan.start!=upstream||next.plan.end()!=end){if(next.connection!=null)next.connection.disconnect();abort("error");throw new IOException("Media stream resume mismatch",cause);}
   synchronized(this){
    if(aborted){next.connection.disconnect();throw new IOException("Media stream closed");}
    connection=next.connection;in=next.in;head=next.head;headAt=0;headEnd=next.headLength;
   }
   log.accept("media-proxy resume id="+id+" ok=1 reason="+why+" attempts="+next.attempts+" resumes="+resumes+" totalMs="+ms(System.nanoTime()-started));
  }
  /** From another thread: stops the transfer (a blocked read fails at once) and frees the permit. */
  void abort(String why){
   if(aborted)return;
   reason=why;aborted=true;
   Connection current;synchronized(this){current=connection;}
   if(current!=null)current.disconnect();
   finish();
  }
  @Override public void close(){
   aborted=true;
   Connection current;synchronized(this){current=connection;connection=null;}
   if(current!=null)current.disconnect();
   finish();
  }
  private void finish(){
   if(!finished.compareAndSet(false,true))return;
   synchronized(MediaStreamProxy.this){streams.remove(this);}
   permits.release();
   log.accept("media-proxy end id="+logId(entry.asset)+" reason="+reason+" bytes="+bytes+" resumes="+resumes+" durationMs="+ms(System.nanoTime()-opened));
  }
 }

 /** Storage over HttpURLConnection and the platform connection pool. */
 static final class HttpUpstream implements Upstream {
  @Override public Connection open(String url,String range,int connectMs,int readMs)throws IOException{
   URI uri;
   try{uri=new URI(url);}catch(URISyntaxException e){throw new IOException("Invalid media URL");}
   if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null)throw new IOException("Invalid media URL");
   final HttpURLConnection c=(HttpURLConnection)uri.toURL().openConnection();boolean ok=false;
   try{
    // Use the platform pool: the R2 hostname resolves to two addresses and one of them is
    // unreachable from some networks (seen 2026-09-26: TCP never completes). A short connect
    // timeout lets the platform move to the next address, it remembers the failed route and
    // tries the working one first next time, and a pooled connection to the working address
    // makes the player's follow-up range requests fast.
    c.setConnectTimeout(connectMs);c.setReadTimeout(readMs);c.setInstanceFollowRedirects(false);c.setUseCaches(false);
    c.setRequestProperty("Accept-Encoding","identity");
    if(range!=null)c.setRequestProperty("Range",range);
    final int status=c.getResponseCode();ok=true;
    return new Connection(){
     public int status(){return status;}
     public String header(String name){return c.getHeaderField(name);}
     public InputStream body()throws IOException{return c.getInputStream();}
     public void disconnect(){try{c.disconnect();}catch(RuntimeException ignored){}}
    };
   }finally{if(!ok)c.disconnect();}
  }
 }
}
