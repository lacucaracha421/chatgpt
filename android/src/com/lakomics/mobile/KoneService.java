package com.lakomics.mobile;

import android.app.Service;
import android.content.Intent;
import android.os.*;
import android.net.Uri;
import android.webkit.*;
import org.json.*;
import java.util.ArrayDeque;

/** The sole request transport with cookies. No raw profile data is ever serialized. */
public final class KoneService extends Service {
    static void configureCookies(WebView w){CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(w,true);}
    static final int REQUEST=1,CHUNK=2,RESULT=3;
    static final int CHUNK_SIZE=48*1024,MAX_BASE64=4*((5*1024*1024+2)/3);
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final ArrayDeque<Message> queue=new ArrayDeque<>();
    private final Messenger messenger=new Messenger(new Handler(Looper.getMainLooper()){@Override public void handleMessage(Message m){admit(m);}});
    private WebView web;private Message current;private boolean ready;private long sequence,lastStart,deadline;
    private final Runnable idle=()->{if(current==null&&queue.isEmpty()){destroyWeb();stopSelf();}};
    @Override public IBinder onBind(Intent intent){handler.removeCallbacks(idle);handler.postDelayed(idle,60000);return messenger.getBinder();}
    @Override public boolean onUnbind(Intent intent){handler.removeCallbacks(idle);handler.postDelayed(idle,60000);return false;}
    private void admit(Message incoming){
        if(incoming.what!=REQUEST||incoming.replyTo==null)return;
        Bundle b=incoming.getData();String op=b.getString("op",""),body=b.getString("body","");
        if(!("profile".equals(op)||"logout".equals(op)||"list".equals(op)||"get".equals(op))||body.length()>4096||queue.size()>=16){send(incoming,RESULT,"","코네 요청을 완료할 수 없습니다",0);return;}
        Message copy=Message.obtain();copy.copyFrom(incoming);copy.setData(new Bundle(b));queue.add(copy);handler.removeCallbacks(idle);next();
    }
    private void ensureWeb(){
        if(web!=null)return;KonePage.initialize();web=new WebView(this);KonePage.configure(web);
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return r.isForMainFrame()&&!KonePage.allowed(r.getUrl());}
            @Override public boolean shouldOverrideUrlLoading(WebView v,String u){return !KonePage.allowed(Uri.parse(u));}
            @Override public void onPageFinished(WebView v,String u){if(KonePage.kone(Uri.parse(u))){ready=true;run();}}
            @Override public void onReceivedSslError(WebView v,SslErrorHandler h,android.net.http.SslError e){h.cancel();}
            @Override public boolean onRenderProcessGone(WebView v,RenderProcessGoneDetail d){finish("", "코네에 연결할 수 없습니다",0);destroyWeb();return true;}
        });web.loadUrl("https://kone.gg/s/somisoft");
    }
    private void next(){
        if(current!=null||queue.isEmpty())return;current=queue.remove();long token=++sequence;
        deadline=SystemClock.elapsedRealtime()+60000;
        handler.postDelayed(()->{if(current!=null&&sequence==token)finish("","코네 요청 시간이 초과되었습니다",0);},60000);
        if("logout".equals(current.getData().getString("op"))){
            try{KonePage.initialize();CookieManager.getInstance().removeAllCookies(ok->{CookieManager.getInstance().flush();finish("{}","",200);destroyWeb();});}catch(Exception e){finish("","코네 로그아웃을 완료하지 못했습니다",0);}return;
        }
        try{ensureWeb();run();}catch(Exception e){finish("","코네에 연결할 수 없습니다",0);}
    }
    private boolean started;
    private void run(){
        if(current==null||!ready||started)return;
        long delay=300-(SystemClock.elapsedRealtime()-lastStart);if(delay>0){handler.postDelayed(this::run,delay);return;}
        if(web.getUrl()==null||!KonePage.kone(Uri.parse(web.getUrl())))return;
        started=true;lastStart=SystemClock.elapsedRealtime();long token=sequence;
        String op=current.getData().getString("op"),body=current.getData().getString("body","");
        String script="profile".equals(op)?profileScript():requestScript("list".equals(op)?"list":"get",body);
        String wrapper="(()=>{const token="+token+";window.__somiToken=token;window.__somi=null;const controller=new AbortController();window.__somiAbort=()=>controller.abort();const timer=setTimeout(()=>controller.abort(),60000);(async()=>{"+script+"})().then(v=>{if(window.__somiToken===token)window.__somi=v}).catch(()=>{if(window.__somiToken===token)window.__somi={status:0,error:'network'}}).finally(()=>clearTimeout(timer));})()";
        web.evaluateJavascript(wrapper,v->poll(token));
    }
    private void poll(long token){
        if(current==null||sequence!=token||web==null)return;
        if(SystemClock.elapsedRealtime()>=deadline){finish("","코네 요청 시간이 초과되었습니다",0);return;}
        // Pull bounded pieces from the renderer too: never marshal a 7 MiB JSON string.
        web.evaluateJavascript("window.__somiToken==="+token+"&&window.__somi?JSON.stringify({status:window.__somi.status,error:window.__somi.error||'',handle:window.__somi.handle||'',displayName:window.__somi.displayName||'',length:(window.__somi.base64||'').length}):null",value->{
            if(current==null||sequence!=token)return;
            try{Object parsed=new JSONTokener(value).nextValue();if(!(parsed instanceof String)){handler.postDelayed(()->poll(token),100);return;}JSONObject meta=new JSONObject((String)parsed);
                int status=meta.optInt("status"),length=meta.optInt("length");
                if(!meta.optString("error").isEmpty()||length>MAX_BASE64){finish("","코네 요청을 완료할 수 없습니다",status);return;}
                if("profile".equals(current.getData().getString("op"))){finish(new JSONObject().put("handle",meta.optString("handle")).put("displayName",meta.optString("displayName")).toString(),"",status);return;}
                chunks(token,0,length,status);
            }catch(Exception e){finish("","소미 응답 형식 오류",0);}
        });
    }
    private void chunks(long token,int offset,int length,int status){
        if(current==null||sequence!=token||web==null)return;
        if(offset>=length){finish("","",status);return;}
        int end=Math.min(length,offset+CHUNK_SIZE);
        web.evaluateJavascript("window.__somiToken==="+token+"?window.__somi.base64.slice("+offset+","+end+"):null",value->{
            if(current==null||sequence!=token)return;
            try{Object decoded=new JSONTokener(value).nextValue();if(!(decoded instanceof String)||((String)decoded).length()!=end-offset)throw new IllegalArgumentException();send(current,CHUNK,(String)decoded,"",offset);chunks(token,end,length,status);}catch(Exception e){finish("","소미 응답 형식 오류",0);}
        });
    }
    private void finish(String value,String error,int status){
        if(current==null)return;send(current,RESULT,value,error,status);current=null;sequence++;started=false;
        if(web!=null)try{web.evaluateJavascript("if(window.__somiAbort)window.__somiAbort();window.__somi=null",null);}catch(RuntimeException ignored){/* A dead renderer is destroyed by onRenderProcessGone. */}
        handler.removeCallbacks(idle);handler.postDelayed(idle,60000);handler.post(this::next);
    }
    private void send(Message to,int what,String value,String error,int status){try{Message m=Message.obtain(null,what);Bundle b=new Bundle();b.putLong("id",to.getData().getLong("id"));b.putString("value",value);b.putString("error",error);b.putInt("status",status);m.setData(b);to.replyTo.send(m);}catch(RemoteException ignored){}}
    private static String profileScript(){return "const r=await fetch('/__data.json?x-sveltekit-invalidated=1',{credentials:'include',redirect:'error',cache:'no-store',signal:controller.signal});if(r.status===401||r.status===403)return {status:r.status};let n=0;const reader=r.body.getReader(),chunks=[];while(true){const p=await reader.read();if(p.done)break;n+=p.value.length;if(n>5242880){await reader.cancel();throw Error();}chunks.push(p.value);}const b=new Uint8Array(n);let o=0;for(const c of chunks){b.set(c,o);o+=c.length;}const j=JSON.parse(new TextDecoder().decode(b));const d=j.nodes[0].data;const ref=i=>Number.isInteger(i)&&i>=0?d[i]:undefined;const root=d[0],s=root&&ref(root.session),p=s&&ref(s.profile),h=p&&ref(p.handle),name=p&&ref(p.displayName);return {status:r.status,handle:typeof h==='string'&&h.length<=256?h:'',displayName:typeof name==='string'&&name.length<=256?name:''};";}
    private static String requestScript(String path,String body){return "const raw=atob("+JSONObject.quote(body)+"),body=Uint8Array.from(raw,c=>c.charCodeAt(0));const r=await fetch('https://api.kone.gg/v1/article/"+path+"',{method:'QUERY',credentials:'include',redirect:'error',headers:{'content-type':'application/sef',accept:'application/sef'},body,signal:controller.signal});if(r.status===401||r.status===403)return {status:r.status};let n=0;const reader=r.body.getReader(),chunks=[];while(true){const p=await reader.read();if(p.done)break;n+=p.value.length;if(n>5242880){await reader.cancel();return {status:r.status,error:'bound'}}chunks.push(p.value);}const b=new Uint8Array(n);let o=0;for(const c of chunks){b.set(c,o);o+=c.length;}let text='';for(let i=0;i<b.length;i+=8192)text+=String.fromCharCode.apply(null,b.subarray(i,i+8192));return {status:r.status,base64:btoa(text)};";}
    private void destroyWeb(){ready=false;started=false;if(web!=null){web.stopLoading();web.destroy();web=null;}}
    @Override public void onDestroy(){handler.removeCallbacksAndMessages(null);destroyWeb();super.onDestroy();}
}
