package com.lakomics.mobile;

import android.content.*;
import android.os.*;
import java.io.IOException;
import java.util.concurrent.*;
import java.util.concurrent.locks.ReentrantLock;

/** Main-process Binder client; this class has no WebView or cookie access. */
final class KoneClient {
    static final class Reply {final int status;final String value;Reply(int s,String v){status=s;value=v;}}
    private final Context context;private final Handler handler=new Handler(Looper.getMainLooper());
    private final ReentrantLock lane=new ReentrantLock(true);
    private Messenger remote;private boolean bound,closed;private long sequence;
    private CompletableFuture<Messenger> connecting;
    private CompletableFuture<Reply> pending;private long pendingId;private final StringBuilder chunks=new StringBuilder();
    private final Runnable idle=this::unbind;
    private final Messenger receiver=new Messenger(new Handler(Looper.getMainLooper()){@Override public void handleMessage(Message m){
        Bundle b=m.getData();if(pending==null||b.getLong("id")!=pendingId)return;
        if(m.what==KoneService.CHUNK){String part=b.getString("value","");if(part.length()>KoneService.CHUNK_SIZE||b.getInt("status")!=chunks.length()||chunks.length()+part.length()>KoneService.MAX_BASE64){pending.completeExceptionally(new IOException("소미 응답이 너무 큽니다"));return;}chunks.append(part);}
        else if(m.what==KoneService.RESULT){String error=b.getString("error","");int status=b.getInt("status");if(!error.isEmpty()&&status!=401&&status!=403)pending.completeExceptionally(new IOException(error));else pending.complete(new Reply(status,chunks.length()>0?chunks.toString():b.getString("value","")));}
    }});
    private final ServiceConnection connection=new ServiceConnection(){
        public void onServiceConnected(ComponentName n,IBinder binder){remote=new Messenger(binder);if(connecting!=null)connecting.complete(remote);}
        public void onServiceDisconnected(ComponentName n){remote=null;if(pending!=null)pending.completeExceptionally(new IOException("코네 연결이 끊겼습니다"));}
        public void onBindingDied(ComponentName n){onServiceDisconnected(n);unbind();}
        public void onNullBinding(ComponentName n){if(connecting!=null)connecting.completeExceptionally(new IOException("코네에 연결할 수 없습니다"));unbind();}
    };
    KoneClient(Context c){context=c.getApplicationContext();}
    Reply call(String op,byte[] body)throws Exception{lane.lockInterruptibly();try{return exchange(op,body);}finally{lane.unlock();}}
    private Reply exchange(String op,byte[] body)throws Exception{
        final long id=++sequence;final CompletableFuture<Reply> result=new CompletableFuture<>();
        handler.post(()->{
            handler.removeCallbacks(idle);
            if(closed){result.completeExceptionally(new IOException("코네 연결이 닫혔습니다"));return;}
            pending=result;pendingId=id;chunks.setLength(0);
            if(remote!=null){dispatch(id,op,body,result);return;}
            connecting=new CompletableFuture<>();connecting.whenComplete((m,e)->{if(e!=null)result.completeExceptionally(e);else dispatch(id,op,body,result);});
            if(!bound){bound=context.bindService(new Intent(context,KoneService.class),connection,Context.BIND_AUTO_CREATE);if(!bound)connecting.completeExceptionally(new IOException("코네에 연결할 수 없습니다"));}
        });
        try{return result.get(65,TimeUnit.SECONDS);}finally{handler.post(()->{if(pendingId==id){pending=null;chunks.setLength(0);handler.removeCallbacks(idle);handler.postDelayed(idle,60000);if(!result.isDone())unbind();}});}
    }
    private void dispatch(long id,String op,byte[] body,CompletableFuture<Reply> result){
        if(pendingId!=id||result.isDone())return;
        try{Message m=Message.obtain(null,KoneService.REQUEST);m.replyTo=receiver;Bundle b=new Bundle();b.putLong("id",id);b.putString("op",op);b.putString("body",body==null?"":android.util.Base64.encodeToString(body,android.util.Base64.NO_WRAP));m.setData(b);remote.send(m);}catch(Exception e){result.completeExceptionally(new IOException("코네에 연결할 수 없습니다"));}
    }
    private void unbind(){if(bound){context.unbindService(connection);bound=false;}remote=null;connecting=null;}
    void close(){handler.post(()->{closed=true;handler.removeCallbacks(idle);if(pending!=null)pending.completeExceptionally(new IOException("코네 연결이 닫혔습니다"));unbind();});}
}
