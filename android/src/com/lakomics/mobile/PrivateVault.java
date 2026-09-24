package com.lakomics.mobile;

import android.app.Activity;
import android.content.*;
import android.database.Cursor;
import android.hardware.usb.UsbManager;
import android.net.Uri;
import android.os.*;
import android.provider.DocumentsContract;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.*;
import org.json.*;
import java.io.*;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/** A1: SAF read permission only. No USB mutation, cache, provider, or transfer integration. */
final class PrivateVault {
    static final int PICK_ROOT = 7104;
    // Diagnostics carry status, range and exception class only: never ids, titles, keys or plaintext.
    private static final String TAG = "LakomicsVault";
    interface Events { void emit(JSONObject state); }
    private final Activity activity;
    private final ContentResolver resolver;
    private final Events events;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final java.util.concurrent.ExecutorService closes = java.util.concurrent.Executors.newSingleThreadExecutor();
    private final Set<VaultStream> streams = new HashSet<>();
    private Uri root, vaultDir, objectsDir;
    private VaultCrypto.Header header;
    private byte[] master;
    private List<VaultCrypto.Item> items = Collections.emptyList();
    private final Map<String,String> media = new HashMap<>();
    private final Set<String> thumbnails = new HashSet<>();
    private String nonce, message = "";
    private long epoch, stoppedAt = -1;
    private boolean shown, unlocked, closed, picking;
    private final Runnable backgroundLock = () -> lock("백그라운드에서 1분이 지나 잠겼습니다");
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            if (Intent.ACTION_SCREEN_OFF.equals(i.getAction())) lock("화면이 꺼져 잠겼습니다");
            else unavailable("USB가 분리되어 잠겼습니다");
        }
    };
    PrivateVault(Activity activity, Events events) {
        this.activity=activity; this.resolver=activity.getContentResolver(); this.events=events;
        String saved=activity.getSharedPreferences("private-vault-tree",Context.MODE_PRIVATE).getString("root",null);
        if(saved!=null) root=Uri.parse(saved);
        IntentFilter filter=new IntentFilter(Intent.ACTION_SCREEN_OFF); filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        if(Build.VERSION.SDK_INT>=33) activity.registerReceiver(receiver,filter,Context.RECEIVER_NOT_EXPORTED);
        else activity.registerReceiver(receiver,filter);
    }
    private void ui(Runnable work) throws Exception {
        FutureTask<Void> task=new FutureTask<>(()->{work.run();return null;});
        activity.runOnUiThread(task);
        try {task.get(5,TimeUnit.SECONDS);} finally {task.cancel(false);}
    }
    // Called on the UI thread in bridge arrival order, before sending an acknowledgement.
    void setVisible(boolean visible) {
        synchronized(this){shown=visible;}
        if(visible) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else {lock("");activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);}
        if(Build.VERSION.SDK_INT>=33) activity.setRecentsScreenshotEnabled(!visible);
    }
    JSONObject pick() throws Exception {
        ui(()->{
            synchronized(this){if(!shown || closed || picking)return;picking=true;}
            lock("");
            Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION|Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            activity.startActivityForResult(intent,PICK_ROOT);
        });
        return state();
    }
    boolean picked(int request, int result, Intent data) {
        if(request!=PICK_ROOT)return false;
        synchronized(this){picking=false;}
        if(result==Activity.RESULT_OK && data!=null && data.getData()!=null) {
            try {
                Uri selected=data.getData();
                resolver.takePersistableUriPermission(selected,Intent.FLAG_GRANT_READ_URI_PERMISSION);
                synchronized(this){root=selected;vaultDir=null;objectsDir=null;header=null;epoch++;message="USB 폴더를 확인해 주세요";}
                activity.getSharedPreferences("private-vault-tree",Context.MODE_PRIVATE).edit().putString("root",selected.toString()).apply();
            } catch(Exception e){lock("USB 폴더 접근 권한을 확인해 주세요");}
        }
        publish();return true;
    }
    private Uri treeDocument(Uri tree) { return DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree)); }
    private Uri child(Uri parent,String name) throws IOException {
        Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(parent,DocumentsContract.getDocumentId(parent));
        try(Cursor cursor=resolver.query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)) {
            if(cursor==null)throw new IOException();
            while(cursor.moveToNext())if(name.equals(cursor.getString(1)))return DocumentsContract.buildDocumentUriUsingTree(parent,cursor.getString(0));
            return null;
        } catch(RuntimeException e){throw new IOException("SAF read failed",e);}
    }
    private Uri required(Uri parent,String name) throws IOException {
        Uri doc=child(parent,name);if(doc==null)throw new FileNotFoundException();return doc;
    }
    private final class SafSource implements VaultCrypto.Source {
        private final ParcelFileDescriptor descriptor;
        private final FileInputStream input;
        SafSource(Uri uri) throws IOException {
            try {
                descriptor=resolver.openFileDescriptor(uri,"r");
                if(descriptor==null)throw new IOException();
                input=new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
            } catch(RuntimeException e){throw new IOException("SAF open failed",e);}
        }
        @Override public long size() throws IOException {return input.getChannel().size();}
        @Override public byte[] read(long offset,int length) throws IOException {
            byte[] result=new byte[length]; java.nio.ByteBuffer buffer=java.nio.ByteBuffer.wrap(result);
            while(buffer.hasRemaining()) {
                int n=input.getChannel().read(buffer,offset+buffer.position());
                if(n<=0){VaultCrypto.wipe(result);throw new EOFException();}
            }
            return result;
        }
        @Override public void close() throws IOException {input.close();}
    }
    private VaultCrypto.Header readHeader(Uri dir) throws Exception {
        try(VaultCrypto.Source source=new SafSource(required(dir,"vault.json"))) {
            long length=source.size();if(length<1 || length>1024*1024)throw new VaultCrypto.Invalid();
            return new VaultCrypto.Header(source.read(0,(int)length));
        }
    }
    JSONObject inspect() throws Exception {
        final Uri selected; final long version;
        synchronized(this){selected=root;version=epoch;if(closed)return state();}
        if(selected==null)return state();
        try {
            Uri dir=child(treeDocument(selected),".lakomics-vault");
            if(dir==null){unavailableIfCurrent(version,"USB 폴더에 비밀 보관함이 없습니다");return state();}
            VaultCrypto.Header found=readHeader(dir); Uri objects=required(dir,"objects");
            synchronized(this){
                if(version!=epoch)return state();
                if(header!=null && !found.uuid.equals(header.uuid)){unavailable("다른 USB가 연결되어 잠겼습니다");return state();}
                vaultDir=dir;objectsDir=objects;header=found;
                if(master==null && message.equals("USB 폴더를 확인해 주세요"))message="";
            }
            return state();
        } catch(IOException|SecurityException e){unavailableIfCurrent(version,"USB를 읽을 수 없어 잠겼습니다. 연결을 확인해 주세요");return state();}
        catch(Exception e){unavailableIfCurrent(version,e instanceof VaultCrypto.Unsupported?"지원하지 않는 비밀 보관함 형식입니다":"USB 보관함 형식을 확인할 수 없어 잠겼습니다");return state();}
    }
    synchronized long epoch() { return epoch; }
    JSONObject unlock(String secret,boolean recovery,CancellationSignal cancellation,long requestedEpoch) throws Exception {
        // A lock while the expensive KDF runs invalidates this attempt; no auto-unlock.
        synchronized(this){if(requestedEpoch!=epoch)throw new VaultCrypto.Invalid("보관함이 잠겼습니다");}
        inspect();
        final VaultCrypto.Header current; final Uri dir; final long attempt;
        synchronized(this){
            if(requestedEpoch!=epoch || !shown || closed || vaultDir==null || header==null || stoppedAt>=0)throw new VaultCrypto.Invalid("USB 연결을 확인해 주세요");
            lock("");current=header;dir=vaultDir;attempt=epoch;
        }
        byte[] key=current.unlock(secret,recovery);
        synchronized(this){
            if(attempt!=epoch || cancellation.isCanceled() || closed || !shown || stoppedAt>=0){VaultCrypto.wipe(key);throw new VaultCrypto.Invalid("보관함이 잠겼습니다");}
            master=key;
        }
        try {
            List<VaultCrypto.Item> loaded;
            try {loaded=readIndex(dir,"index.bin",attempt);}
            catch(VaultCrypto.Unsupported e){throw e;}
            catch(VaultCrypto.Invalid|FileNotFoundException e){loaded=readIndex(dir,"index.prev.bin",attempt);}
            synchronized(this){
                if(attempt!=epoch || cancellation.isCanceled() || master==null)throw new VaultCrypto.Invalid("보관함이 잠겼습니다");
                items=loaded;media.clear();thumbnails.clear();
                for(VaultCrypto.Item item:items)if(!item.trashed){
                    media.put(item.object,item.mime);
                    if(item.thumbnail!=null){thumbnails.add(item.thumbnail);media.putIfAbsent(item.thumbnail,"image/webp");}
                    if(item.poster!=null){thumbnails.add(item.poster);media.putIfAbsent(item.poster,"image/webp");}
                }
                byte[] random=new byte[16];new SecureRandom().nextBytes(random);nonce=NotesCrypto.hex(random);
                unlocked=true;message="";return state();
            }
        } catch(Exception e){lockIfCurrent(attempt,e instanceof IOException?"USB를 읽을 수 없어 잠겼습니다":"보관함을 열 수 없어 잠겼습니다");throw e;}
    }
    private List<VaultCrypto.Item> readIndex(Uri dir,String name,long version) throws Exception {
        Uri document=required(dir,name);
        try(VaultStream stream=open(document,VaultCrypto.INDEX_ID,2,version)) {
            if(stream.reader.length>VaultCrypto.MAX_INDEX)throw new VaultCrypto.Invalid();
            byte[] plain=new byte[(int)stream.reader.length];
            try {
                int offset=0;
                while(offset<plain.length){
                    byte[] chunk=stream.reader.range(offset,Math.min(VaultCrypto.CHUNK,plain.length-offset));
                    try {
                        synchronized(this){if(version!=epoch || master==null)throw new VaultCrypto.Invalid();}
                        System.arraycopy(chunk,0,plain,offset,chunk.length);offset+=chunk.length;
                    } finally {VaultCrypto.wipe(chunk);}
                }
                return VaultCrypto.index(plain);
            } finally {VaultCrypto.wipe(plain);}
        }
    }
    private VaultStream open(Uri uri,String id,int purpose,long version) throws Exception {
        final byte[] key; final VaultCrypto.Header current;
        synchronized(this){
            if(version!=epoch || master==null || closed)throw new VaultCrypto.Invalid();
            if(streams.size()>=32)throw new VaultCrypto.Invalid("열린 미디어가 많습니다. 다시 시도해 주세요");
            key=master;current=header;
        }
        // SAF can stall during removal. Never hold the session monitor during I/O;
        // screen-off and detach must still revoke the key and visible session immediately.
        VaultCrypto.Reader reader=new VaultCrypto.Reader(new SafSource(uri),key,current,id,purpose,false);
        VaultStream stream=new VaultStream(reader,version);
        synchronized(this){
            if(version!=epoch || master==null || closed){reader.close();throw new VaultCrypto.Invalid();}
            streams.add(stream);
        }
        try{reader.authenticateEnd();return stream;}catch(Exception e){stream.close();throw e;}
    }
    private final class VaultStream extends VaultCrypto.Body {
        private final long version;
        private boolean ended;
        VaultStream(VaultCrypto.Reader reader,long version){super(reader);this.version=version;}
        @Override protected void check() throws IOException {
            super.check();
            synchronized(PrivateVault.this){if(ended || version!=epoch || master==null)throw new IOException("Vault locked");}
        }
        @Override protected IOException failed(Exception e) {
            // An authentication failure fails this response only; a USB read error locks (ADR-0039).
            boolean io=e instanceof IOException || e instanceof SecurityException;
            Log.w(TAG,"stream read failed: "+e.getClass().getSimpleName()+(io?" (USB read)":" (authentication)"));
            if(io)synchronized(PrivateVault.this){if(!ended && version==epoch)unavailable("USB를 읽을 수 없어 잠겼습니다");}
            return new IOException("Vault read failed");
        }
        @Override public void close() {
            synchronized(PrivateVault.this){ended=true;streams.remove(this);}
            try{super.close();}catch(IOException ignored){}
        }
    }
    synchronized JSONObject state() throws JSONException {
        JSONObject state=new JSONObject().put("epoch",epoch).put("selected",root!=null).put("present",vaultDir!=null).put("unlocked",unlocked).put("message",message);
        JSONArray list=new JSONArray();
        if(unlocked)for(VaultCrypto.Item item:items)if(!item.trashed){
            String base="https://app.lakomics.local/vault/"+nonce+"/";
            String thumb=item.thumbnail!=null?item.thumbnail:item.poster;
            list.put(new JSONObject().put("id",item.id).put("title",item.title).put("kind",item.kind).put("url",base+item.object).put("thumbnail",thumb==null?JSONObject.NULL:base+thumb)
                .put("width",item.width>0?item.width:JSONObject.NULL).put("height",item.height>0?item.height:JSONObject.NULL));
        }
        return state.put("items",list);
    }
    private synchronized void unavailable(String reason){vaultDir=null;objectsDir=null;header=null;lock(reason);}
    private synchronized void unavailableIfCurrent(long version,String reason){if(version==epoch)unavailable(reason);}
    private synchronized void lockIfCurrent(long version,String reason){if(version==epoch)lock(reason);}
    synchronized void lock(String reason) {
        epoch++;unlocked=false;nonce=null;if(master!=null){synchronized(master){VaultCrypto.wipe(master);}}master=null;items=Collections.emptyList();media.clear();thumbnails.clear();
        for(VaultStream stream:new ArrayList<>(streams)){stream.ended=true;stream.revoke();closes.execute(()->{try{stream.reader.close();}catch(IOException ignored){}});}
        streams.clear();
        message=reason;
        publish();
    }
    private void publish(){try{events.emit(state());}catch(JSONException ignored){}}
    private static WebResourceResponse response(VaultCrypto.Plan plan,InputStream body,String mime){return new WebResourceResponse(mime,null,plan.status,plan.reason,plan.headers,body);}
    private static WebResourceResponse error(int status,String reason){
        Log.w(TAG,"media request answered "+status);
        return new WebResourceResponse("text/plain",null,status,reason,VaultCrypto.baseHeaders(),new ByteArrayInputStream(new byte[0]));
    }
    WebResourceResponse serve(WebResourceRequest request) {
        VaultStream stream=null;long requestEpoch=-1;String range=null;
        try {
            Uri uri=request.getUrl();
            if(request.isForMainFrame() || uri.getQuery()!=null || uri.getFragment()!=null || !(request.getMethod().equals("GET") || request.getMethod().equals("HEAD")))return error(403,"Forbidden");
            for(Map.Entry<String,String> e:request.getRequestHeaders().entrySet())if(e.getKey().equalsIgnoreCase("Range"))range=e.getValue();
            final String id,mime;final Uri objects;final long version;
            synchronized(this){
                if(!shown || !unlocked || closed)return error(403,"Forbidden");
                id=VaultCrypto.route(uri.getEncodedPath(),nonce);mime=media.get(id);objects=objectsDir;version=epoch;requestEpoch=epoch;
                if(mime==null)return error(404,"Not Found");
            }
            stream=open(required(objects,id),id,1,version);
            String actualMime=mime;
            boolean isThumbnail;
            synchronized(this){if(version!=epoch)return error(403,"Forbidden");isThumbnail=thumbnails.contains(id);}
            if(isThumbnail){byte[] head=stream.reader.range(0,16);try{actualMime=VaultCrypto.thumbnailMime(head);}finally{VaultCrypto.wipe(head);}}
            VaultCrypto.Plan plan=VaultCrypto.plan(range,stream.reader.length);
            if(!isThumbnail || plan.status!=200)Log.i(TAG,"media "+actualMime+" range="+(range==null?"none":range)+" -> "+plan.status+" of "+plan.length);
            if(plan.status==416)return response(plan,new ByteArrayInputStream(new byte[0]),"text/plain");
            if(request.getMethod().equals("HEAD"))return response(plan,new ByteArrayInputStream(new byte[0]),actualMime);
            stream.limit(plan.start,plan.count);
            VaultStream body=stream;stream=null;return response(plan,body,actualMime);
        } catch(IOException|SecurityException e){
            Log.w(TAG,"media open failed: "+e.getClass().getSimpleName()+" range="+(range==null?"none":range));
            unavailableIfCurrent(requestEpoch,"USB를 읽을 수 없어 잠겼습니다");return error(503,"Unavailable");
        }
        catch(Exception e){Log.w(TAG,"media refused: "+e.getClass().getSimpleName()+(e instanceof VaultCrypto.Invalid?" "+e.getMessage():""));return error(403,"Forbidden");}
        finally{if(stream!=null)stream.close();}
    }
    void stopped(){synchronized(this){stoppedAt=SystemClock.elapsedRealtime();}main.removeCallbacks(backgroundLock);main.postDelayed(backgroundLock,60000);}
    void resumed(){
        synchronized(this){if(stoppedAt>=0 && SystemClock.elapsedRealtime()-stoppedAt>=60000)lock("백그라운드에서 1분이 지나 잠겼습니다");stoppedAt=-1;}
        main.removeCallbacks(backgroundLock);publish();
    }
    void destroy(){synchronized(this){closed=true;}main.removeCallbacks(backgroundLock);lock("");activity.unregisterReceiver(receiver);closes.shutdown();}
}
