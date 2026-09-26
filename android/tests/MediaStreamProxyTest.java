package com.lakomics.mobile;

import java.io.*;
import java.net.SocketTimeoutException;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/** Retry, stall, resume, permit and token rules of the native media proxy against a scripted storage. */
public final class MediaStreamProxyTest {
    private static int checks;
    private static void check(boolean value){checks++;if(!value)throw new AssertionError("check "+checks);}
    private static final int SIZE=100_000;
    private static final byte[] DATA=new byte[SIZE];
    static{for(int i=0;i<SIZE;i++)DATA[i]=(byte)(i*31+7);}

    /** What one storage call does. */
    enum Mode {OK,STALL_HEADERS,STALL_BODY,HANG_BODY,FAIL_AFTER,STATUS,WRONG_RANGE,UNSATISFIABLE}
    static final class Step {final Mode mode;final int value;Step(Mode mode,int value){this.mode=mode;this.value=value;}}
    static Step step(Mode mode){return new Step(mode,0);}
    static Step step(Mode mode,int value){return new Step(mode,value);}
    static final class Call {final String url,range;final int connectMs,readMs;Call(String url,String range,int connectMs,int readMs){this.url=url;this.range=range;this.connectMs=connectMs;this.readMs=readMs;}}

    /** Storage double: serves ranges of DATA, following a script of steps (then OK). */
    static final class Storage implements MediaStreamProxy.Upstream {
        final Deque<Step> script=new ArrayDeque<>();
        final List<Call> calls=Collections.synchronizedList(new ArrayList<>());
        final AtomicInteger open=new AtomicInteger(),disconnects=new AtomicInteger();
        Storage then(Step... steps){script.addAll(Arrays.asList(steps));return this;}
        @Override public MediaStreamProxy.Connection open(String url,String range,int connectMs,int readMs)throws IOException{
            calls.add(new Call(url,range,connectMs,readMs));
            Step step;synchronized(script){step=script.isEmpty()?step(Mode.OK):script.poll();}
            if(step.mode==Mode.STALL_HEADERS)throw new SocketTimeoutException("headers");
            open.incrementAndGet();
            return new Fake(step,range);
        }
        final class Fake implements MediaStreamProxy.Connection {
            final Step step;final Map<String,String> headers=new HashMap<>();int status;long start,end;
            final CountDownLatch closed=new CountDownLatch(1);boolean disconnected;
            Fake(Step step,String range){
                this.step=step;
                if(step.mode==Mode.STATUS){status=step.value;return;}
                if(step.mode==Mode.UNSATISFIABLE){status=416;headers.put("Content-Range","bytes */"+SIZE);return;}
                try{
                    MediaStreamRange.Request request=MediaStreamRange.parse(range);
                    if(request==null){status=200;start=0;end=SIZE;}
                    else{long[] span=MediaStreamRange.wanted(request,SIZE);status=206;start=span[0];end=span[1]+1;}
                }catch(Exception e){throw new AssertionError(e);}
                long shown=step.mode==Mode.WRONG_RANGE?start+1:start;
                headers.put("Content-Length",Long.toString(end-shown));
                if(status==206)headers.put("Content-Range","bytes "+shown+"-"+(end-1)+"/"+SIZE);
            }
            public int status(){return status;}
            public String header(String name){return headers.get(name);}
            public InputStream body(){
                return new InputStream(){
                    long at=start;
                    public int read()throws IOException{byte[] one=new byte[1];int n=read(one,0,1);return n<0?-1:one[0]&255;}
                    public int read(byte[] b,int off,int len)throws IOException{
                        synchronized(Fake.this){if(disconnected)throw new IOException("Socket closed");}
                        if(step.mode==Mode.STALL_BODY)throw new SocketTimeoutException("body");
                        if(step.mode==Mode.HANG_BODY&&at>=start+step.value){
                            try{closed.await(5,TimeUnit.SECONDS);}catch(InterruptedException e){throw new InterruptedIOException();}
                            throw new IOException("Socket closed");
                        }
                        if(step.mode==Mode.FAIL_AFTER&&at>=start+step.value)throw new SocketTimeoutException("mid-body");
                        if(at>=end)return -1;
                        long limit=end;if((step.mode==Mode.FAIL_AFTER||step.mode==Mode.HANG_BODY)&&start+step.value<limit)limit=start+step.value;
                        int n=(int)Math.min(Math.min(len,4096),limit-at);
                        System.arraycopy(DATA,(int)at,b,off,n);at+=n;return n;
                    }
                };
            }
            public void disconnect(){synchronized(this){if(disconnected)return;disconnected=true;}open.decrementAndGet();disconnects.incrementAndGet();closed.countDown();}
        }
    }
    static final class Tickets implements MediaStreamProxy.Tickets {
        final AtomicInteger fetched=new AtomicInteger(),fresh=new AtomicInteger();final AtomicLong now;
        Tickets(AtomicLong now){this.now=now;}
        public MediaStreamProxy.Ticket fetch(boolean isFresh){fetched.incrementAndGet();if(isFresh)fresh.incrementAndGet();return new MediaStreamProxy.Ticket("https://storage.invalid/renewed-"+fetched.get(),now.get()+300_000,SIZE);}
    }
    static MediaStreamProxy.Limits limits(){
        MediaStreamProxy.Limits l=new MediaStreamProxy.Limits();
        l.permitWaitMs=300;l.evictIdleMs=60_000;l.firstConnectMs=5;l.firstReadMs=6;l.connectMs=10;l.readMs=15;l.head=1024;
        return l;
    }
    static final List<String> logs=Collections.synchronizedList(new ArrayList<>());
    static final AtomicLong clock=new AtomicLong(1_000_000);
    static MediaStreamProxy proxy(Storage storage,MediaStreamProxy.Limits limits){logs.clear();return new MediaStreamProxy(storage,logs::add,clock::get,limits);}
    static String register(MediaStreamProxy proxy,Tickets tickets){return proxy.register("asset_1","video/mp4",tickets,new MediaStreamProxy.Ticket("https://storage.invalid/first",clock.get()+300_000,SIZE));}
    /** Reads like Android WebView: skip(first byte) for `bytes=N-`, then read to the end. */
    static byte[] drain(InputStream body,long skip)throws IOException{
        long left=skip;while(left>0){long moved=body.skip(left);if(moved<=0)throw new IOException("skip");left-=moved;}
        ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[7000];int n;
        while((n=body.read(buffer,0,buffer.length))!=-1)out.write(buffer,0,n);
        return out.toByteArray();
    }
    static boolean same(byte[] actual,int from,int to){return Arrays.equals(actual,Arrays.copyOfRange(DATA,from,to));}
    static boolean logged(String prefix,String... parts){synchronized(logs){for(String line:logs)if(line.startsWith(prefix)&&Arrays.stream(parts).allMatch(line::contains))return true;}return false;}

    public static void main(String[] args)throws Exception {
        tokens();
        ranges();
        retries();
        resume();
        permits();
        clearing();
        System.out.println("MediaStreamProxy: "+checks+" checks passed");
    }

    static void tokens()throws Exception {
        Storage storage=new Storage();MediaStreamProxy.Limits l=limits();l.tokens=2;l.tokenIdleMs=1000;
        MediaStreamProxy proxy=proxy(storage,l);Tickets tickets=new Tickets(clock);
        String a=register(proxy,tickets),b=register(proxy,tickets);
        check(a.matches("[0-9a-f]{32}")&&b.matches("[0-9a-f]{32}")&&!a.equals(b));
        check(proxy.serve("0123456789abcdef0123456789abcdef","GET","bytes=0-").status==404);
        check(proxy.serve("../"+a,"GET","bytes=0-").status==404&&proxy.serve(null,"GET",null).status==404);
        check(proxy.serve(a,"HEAD",null).status==405);
        check(storage.calls.isEmpty()&&logged("media-proxy fail","status=404","reason=gone"));
        // Bounded: a third token evicts the least recently used one.
        proxy.serve(a,"POST",null);String c=register(proxy,tickets);
        check(proxy.tokenCount()==2&&proxy.serve(b,"GET",null).status==404);
        // Idle TTL.
        clock.addAndGet(1001);
        check(proxy.serve(a,"GET",null).status==404&&proxy.serve(c,"GET",null).status==404);
        check(storage.calls.isEmpty()&&proxy.tokenCount()==0);
        // A token's unsupported Range syntax is answered locally.
        String d=register(proxy,tickets);
        MediaStreamProxy.Response multi=proxy.serve(d,"GET","bytes=0-1,5-6");
        check(multi.status==416&&("bytes */"+SIZE).equals(multi.headers.get("Content-Range"))&&storage.calls.isEmpty());
    }

    static void ranges()throws Exception {
        Storage storage=new Storage();MediaStreamProxy proxy=proxy(storage,limits());Tickets tickets=new Tickets(clock);String token=register(proxy,tickets);
        MediaStreamProxy.Response r=proxy.serve(token,"GET","bytes=0-");
        check(r.status==206&&r.mime.equals("video/mp4")&&("bytes 0-"+(SIZE-1)+"/"+SIZE).equals(r.headers.get("Content-Range")));
        check(Integer.toString(SIZE).equals(r.headers.get("Content-Length"))&&"bytes".equals(r.headers.get("Accept-Ranges"))&&"no-store".equals(r.headers.get("Cache-Control")));
        Call first=storage.calls.get(0);
        check(first.url.equals("https://storage.invalid/first")&&"bytes=0-".equals(first.range)&&first.connectMs==5&&first.readMs==6);
        check(r.body.available()==0&&proxy.activeStreams()==1);
        check(same(drain(r.body,0),0,SIZE));
        r.body.close();r.body.close();
        check(proxy.activeStreams()==0&&storage.open.get()==0&&logged("media-proxy open","status=206","range=open","attempts=1")&&logged("media-proxy end","reason=closed","bytes="+SIZE));
        // WebView skips to the first byte before reading; reading without the skip is the same.
        r=proxy.serve(token,"GET","bytes=40000-");
        check(r.status==206&&("bytes 40000-"+(SIZE-1)+"/"+SIZE).equals(r.headers.get("Content-Range"))&&same(drain(r.body,40000),40000,SIZE));r.body.close();
        r=proxy.serve(token,"GET","bytes=40000-");check(same(drain(r.body,0),40000,SIZE));r.body.close();
        r=proxy.serve(token,"GET","bytes=10-19");
        check(r.status==206&&"10".equals(r.headers.get("Content-Length"))&&same(drain(r.body,10),10,20));r.body.close();
        r=proxy.serve(token,"GET","bytes=-100");check(r.status==206&&same(drain(r.body,0),SIZE-100,SIZE));r.body.close();
        r=proxy.serve(token,"GET",null);
        check(r.status==200&&!r.headers.containsKey("Content-Range")&&storage.calls.get(storage.calls.size()-1).range==null&&same(drain(r.body,0),0,SIZE));r.body.close();
        // Storage 416 passes through with the object size.
        storage.then(step(Mode.UNSATISFIABLE));
        r=proxy.serve(token,"GET","bytes=200000-");
        check(r.status==416&&("bytes */"+SIZE).equals(r.headers.get("Content-Range")));
        check(proxy.activeStreams()==0&&storage.open.get()==0);
    }

    static void retries()throws Exception {
        // A stall before the status line: one retry on a fresh connection with the longer timeouts.
        Storage storage=new Storage().then(step(Mode.STALL_HEADERS));MediaStreamProxy proxy=proxy(storage,limits());Tickets tickets=new Tickets(clock);String token=register(proxy,tickets);
        MediaStreamProxy.Response r=proxy.serve(token,"GET","bytes=0-");
        check(r.status==206&&storage.calls.size()==2&&storage.calls.get(1).connectMs==10&&storage.calls.get(1).readMs==15&&logged("media-proxy open","attempts=2"));
        check(same(drain(r.body,0),0,SIZE));r.body.close();
        // A stall after the headers but before any body byte is retried too; the stalled connection closes.
        storage=new Storage().then(step(Mode.STALL_BODY));proxy=proxy(storage,limits());token=register(proxy,tickets);
        r=proxy.serve(token,"GET","bytes=0-");
        check(r.status==206&&storage.calls.size()==2&&storage.disconnects.get()==1&&storage.open.get()==1);r.body.close();
        check(storage.open.get()==0);
        // Two stalls: 504, nothing left open, the permit returned.
        storage=new Storage().then(step(Mode.STALL_HEADERS),step(Mode.STALL_BODY));proxy=proxy(storage,limits());token=register(proxy,tickets);
        r=proxy.serve(token,"GET","bytes=0-");
        check(r.status==504&&storage.calls.size()==2&&storage.open.get()==0&&proxy.activeStreams()==0&&logged("media-proxy fail","status=504","reason=timeout","attempts=2"));
        // 5xx retries once.
        storage=new Storage().then(step(Mode.STATUS,503));proxy=proxy(storage,limits());token=register(proxy,tickets);
        r=proxy.serve(token,"GET","bytes=0-");check(r.status==206&&storage.calls.size()==2&&storage.open.get()==1);r.body.close();
        // 403 renews the ticket (fresh) and retries with the new URL.
        tickets=new Tickets(clock);
        storage=new Storage().then(step(Mode.STATUS,403));proxy=proxy(storage,limits());token=register(proxy,tickets);
        r=proxy.serve(token,"GET","bytes=0-");
        check(r.status==206&&tickets.fresh.get()==1&&storage.calls.get(1).url.equals("https://storage.invalid/renewed-1")&&logged("media-proxy open","refreshed=1"));r.body.close();
        // Twice 403: renewed once, then the failure is reported.
        tickets=new Tickets(clock);
        storage=new Storage().then(step(Mode.STATUS,403),step(Mode.STATUS,403));proxy=proxy(storage,limits());token=register(proxy,tickets);
        r=proxy.serve(token,"GET","bytes=0-");check(r.status==502&&tickets.fetched.get()==1&&storage.open.get()==0);
        // A reply that does not match the request renews the ticket once, then fails.
        tickets=new Tickets(clock);
        storage=new Storage().then(step(Mode.WRONG_RANGE));proxy=proxy(storage,limits());token=register(proxy,tickets);
        r=proxy.serve(token,"GET","bytes=0-");check(r.status==206&&tickets.fresh.get()==1&&storage.disconnects.get()==1);r.body.close();
        storage=new Storage().then(step(Mode.WRONG_RANGE),step(Mode.WRONG_RANGE));proxy=proxy(storage,limits());token=register(proxy,tickets);
        r=proxy.serve(token,"GET","bytes=0-");check(r.status==502&&storage.open.get()==0&&logged("media-proxy fail","reason=mismatch"));
        // A ticket near expiry is renewed (not fresh) before use.
        tickets=new Tickets(clock);storage=new Storage();proxy=proxy(storage,limits());
        token=proxy.register("asset_1","video/mp4",tickets,new MediaStreamProxy.Ticket("https://storage.invalid/old",clock.get()+10_000,SIZE));
        r=proxy.serve(token,"GET","bytes=0-");check(r.status==206&&tickets.fetched.get()==1&&tickets.fresh.get()==0&&storage.calls.get(0).url.endsWith("renewed-1"));r.body.close();
        // Unknown MIME types never reach the WebView as given.
        token=proxy.register("asset_1","text/html",tickets,null);r=proxy.serve(token,"GET","bytes=0-");check(r.mime.equals("application/octet-stream"));r.body.close();
    }

    static void resume()throws Exception {
        // The body fails mid-transfer: it continues from its position on a fresh connection.
        Storage storage=new Storage().then(step(Mode.FAIL_AFTER,30_000));MediaStreamProxy proxy=proxy(storage,limits());Tickets tickets=new Tickets(clock);String token=register(proxy,tickets);
        MediaStreamProxy.Response r=proxy.serve(token,"GET","bytes=1000-");
        byte[] body=drain(r.body,1000);
        check(same(body,1000,SIZE)&&storage.calls.size()==2&&("bytes=31000-"+(SIZE-1)).equals(storage.calls.get(1).range)&&storage.calls.get(1).readMs==15);
        r.body.close();check(storage.open.get()==0&&logged("media-proxy resume","ok=1","reason=timeout","resumes=1")&&logged("media-proxy end","resumes=1","bytes="+(SIZE-1000)));
        // Resumes are bounded; the failed stream frees its permit at once.
        storage=new Storage().then(step(Mode.FAIL_AFTER,2000),step(Mode.FAIL_AFTER,2000),step(Mode.FAIL_AFTER,2000));proxy=proxy(storage,limits());token=register(proxy,tickets);
        r=proxy.serve(token,"GET","bytes=0-");
        try{drain(r.body,0);throw new AssertionError("unbounded resume");}catch(SocketTimeoutException expected){check(true);}
        check(storage.calls.size()==3&&proxy.activeStreams()==0&&storage.open.get()==0&&logged("media-proxy resume","ok=0","resumes=2")&&logged("media-proxy end","reason=error"));
        try{r.body.read(new byte[10],0,10);throw new AssertionError("read after failure");}catch(IOException expected){check(true);}
        r.body.close();check(proxy.activeStreams()==0);
    }

    static void permits()throws Exception {
        MediaStreamProxy.Limits l=limits();l.streams=2;
        Storage storage=new Storage();MediaStreamProxy proxy=proxy(storage,l);Tickets tickets=new Tickets(clock);String token=register(proxy,tickets);
        MediaStreamProxy.Response a=proxy.serve(token,"GET","bytes=0-"),b=proxy.serve(token,"GET","bytes=0-");
        long started=System.nanoTime();
        MediaStreamProxy.Response busy=proxy.serve(token,"GET","bytes=0-");
        check(busy.status==503&&System.nanoTime()-started>=TimeUnit.MILLISECONDS.toNanos(250)&&storage.calls.size()==2&&logged("media-proxy fail","reason=busy"));
        // Closing one frees its slot.
        a.body.close();MediaStreamProxy.Response c=proxy.serve(token,"GET","bytes=0-");check(c.status==206);
        b.body.close();c.body.close();check(proxy.activeStreams()==0&&storage.open.get()==0);
        // With every slot held by a stream that read nothing recently, the oldest idle one is reclaimed.
        l=limits();l.streams=2;l.evictIdleMs=0;storage=new Storage();proxy=proxy(storage,l);token=register(proxy,tickets);
        a=proxy.serve(token,"GET","bytes=0-");b=proxy.serve(token,"GET","bytes=0-");
        a.body.read(new byte[10],0,10);Thread.sleep(5);b.body.read(new byte[10],0,10);
        c=proxy.serve(token,"GET","bytes=0-");
        check(c.status==206&&logged("media-proxy end","reason=evicted")&&storage.open.get()==2);
        try{a.body.read(new byte[10],0,10);throw new AssertionError("evicted stream still reads");}catch(IOException expected){check(true);}
        check(b.body.read(new byte[10],0,10)==10);
        a.body.close();b.body.close();c.body.close();check(proxy.activeStreams()==0&&storage.open.get()==0);
    }

    static void clearing()throws Exception {
        // A cache clear or connection change stops a read blocked on storage and voids every token.
        Storage storage=new Storage().then(step(Mode.HANG_BODY,5000));MediaStreamProxy proxy=proxy(storage,limits());Tickets tickets=new Tickets(clock);String token=register(proxy,tickets);
        MediaStreamProxy.Response r=proxy.serve(token,"GET","bytes=0-");
        ExecutorService reader=Executors.newSingleThreadExecutor();
        Future<Object> blocked=reader.submit(()->{try{drain(r.body,0);return "finished";}catch(IOException e){return e;}});
        Thread.sleep(100);check(!blocked.isDone());
        long started=System.nanoTime();proxy.clear();
        Object outcome=blocked.get(2,TimeUnit.SECONDS);reader.shutdownNow();
        check(outcome instanceof IOException&&System.nanoTime()-started<TimeUnit.SECONDS.toNanos(2));
        check(proxy.activeStreams()==0&&storage.open.get()==0&&proxy.tokenCount()==0&&logged("media-proxy end","reason=cleared")&&logged("media-proxy clear","tokens=1","streams=1"));
        check(proxy.serve(token,"GET","bytes=0-").status==404);
        r.body.close();check(proxy.activeStreams()==0);
        // Closing while WebView is between reads also closes storage.
        storage=new Storage();proxy=proxy(storage,limits());token=register(proxy,tickets);
        MediaStreamProxy.Response open=proxy.serve(token,"GET","bytes=0-");open.body.read(new byte[100],0,100);
        check(storage.open.get()==1);open.body.close();check(storage.open.get()==0&&proxy.activeStreams()==0);
        // Clearing never waits for a ticket renewal in flight (the app clears under the lock a
        // renewal takes for its HTTP call); the renewal then ends as invalidated.
        storage=new Storage();proxy=proxy(storage,limits());
        CountDownLatch renewing=new CountDownLatch(1),release=new CountDownLatch(1);
        final MediaStreamProxy slow=proxy;
        token=slow.register("asset_1","video/mp4",fresh->{renewing.countDown();release.await(5,TimeUnit.SECONDS);return new MediaStreamProxy.Ticket("https://storage.invalid/late",clock.get()+300_000,SIZE);},null);
        final String pending=token;
        ExecutorService server=Executors.newSingleThreadExecutor();
        Future<MediaStreamProxy.Response> served=server.submit(()->slow.serve(pending,"GET","bytes=0-"));
        check(renewing.await(2,TimeUnit.SECONDS));
        started=System.nanoTime();slow.clear();check(System.nanoTime()-started<TimeUnit.MILLISECONDS.toNanos(500));
        release.countDown();
        check(served.get(2,TimeUnit.SECONDS).status==404&&storage.calls.isEmpty()&&slow.activeStreams()==0&&logged("media-proxy fail","reason=invalidated"));
        server.shutdownNow();
    }
}
