package com.lakomics.mobile;

import android.app.Activity;
import android.content.ContentValues;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.provider.MediaStore;
import android.view.Gravity;
import android.widget.*;
import java.io.*;
import java.net.*;
import java.util.UUID;
import java.util.concurrent.*;

/** Explicit browser tap -> public HTTPS image -> local Pictures album, without cloud APIs. */
public final class TemporaryImageActivity extends Activity {
    private final CancellationSignal cancel=new CancellationSignal();
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private volatile HttpURLConnection connection;
    private TextView status;
    private static final String FOLDER="Pictures/Lakomics/임시보관/";
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);layout.setGravity(Gravity.CENTER);layout.setPadding(32,32,32,32);layout.setBackgroundColor(Color.rgb(24,25,24));
        status=new TextView(this);status.setTextColor(Color.rgb(221,220,206));status.setTextSize(18);status.setGravity(Gravity.CENTER);status.setText("임시보관에 저장 중…");layout.addView(status);
        Button close=new Button(this);close.setText("닫기");close.setOnClickListener(v->finish());layout.addView(close);setContentView(layout);
        Uri data=getIntent().getData();
        if(Build.VERSION.SDK_INT<29 || data==null || !"lakomics".equals(data.getScheme()) || !"temporary".equals(data.getHost()) || (data.getPath()!=null && !data.getPath().isEmpty())) {status.setText("지원하지 않는 임시 저장 요청입니다.");return;}
        String source=data.getQueryParameter("url");
        worker.execute(()->{
            File staging=null;
            try {
                URI uri=TemporaryImagePolicy.url(source);
                staging=File.createTempFile("temporary-image-",".part",getCacheDir());
                download(uri,staging);
                cancel.throwIfCanceled();
                BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;BitmapFactory.decodeFile(staging.getPath(),bounds);
                if(bounds.outWidth<=0 || bounds.outHeight<=0 || bounds.outWidth>32768 || bounds.outHeight>32768)throw new IOException("Invalid image dimensions");
                String suffix=TemporaryImagePolicy.extension(bounds.outMimeType);
                publish(staging,bounds.outMimeType,suffix,bounds.outWidth,bounds.outHeight);
                runOnUiThread(()->{if(!isFinishing()){Toast.makeText(this,"임시보관에 저장했습니다",Toast.LENGTH_SHORT).show();finish();}});
            } catch(Exception e) {runOnUiThread(()->{if(!isFinishing())status.setText("임시 저장하지 못했습니다.\n이미지 주소와 연결을 확인해 주세요.\n로그인이 필요한 이미지는 지원하지 않을 수 있습니다.");});}
            finally {if(staging!=null)staging.delete();worker.shutdown();}
        });
    }
    private void download(URI initial,File destination)throws Exception {
        URI current=initial;long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(90);
        for(int redirect=0;redirect<=3;redirect++) {
            cancel.throwIfCanceled();TemporaryImagePolicy.publicHost(current);
            HttpURLConnection c=(HttpURLConnection)current.toURL().openConnection();connection=c;
            c.setInstanceFollowRedirects(false);c.setConnectTimeout(12000);c.setReadTimeout(15000);c.setRequestProperty("Accept","image/*");c.setRequestProperty("Accept-Encoding","identity");
            try {
                int code=c.getResponseCode();cancel.throwIfCanceled();
                if(code==301 || code==302 || code==303 || code==307 || code==308) {
                    String location=c.getHeaderField("Location");if(location==null)throw new IOException("No redirect");
                    current=TemporaryImagePolicy.url(current.resolve(location).toString());continue;
                }
                if(code!=200)throw new IOException("Image unavailable");
                long expected=MediaTransfer.expectedLength(c.getHeaderField("Content-Length"),TemporaryImagePolicy.MAX_BYTES);
                try(InputStream in=c.getInputStream();OutputStream out=new FileOutputStream(destination)) {
                    MediaTransfer.copy(in,out,TemporaryImagePolicy.MAX_BYTES,expected,deadline,cancel::throwIfCanceled);
                }
                return;
            } finally {c.disconnect();connection=null;}
        }
        throw new IOException("Too many redirects");
    }
    private void publish(File file,String mime,String suffix,int width,int height)throws Exception {
        cancel.throwIfCanceled();
        ContentValues values=new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME,"Lakomics-"+UUID.randomUUID()+suffix);
        values.put(MediaStore.Images.Media.MIME_TYPE,mime);values.put(MediaStore.Images.Media.RELATIVE_PATH,FOLDER);
        values.put(MediaStore.Images.Media.IS_PENDING,1);values.put(MediaStore.Images.Media.DATE_TAKEN,System.currentTimeMillis());
        values.put(MediaStore.Images.Media.WIDTH,width);values.put(MediaStore.Images.Media.HEIGHT,height);
        Uri target=getContentResolver().insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),values);
        if(target==null)throw new IOException("No image storage");
        boolean committed=false;
        try {
            try(InputStream in=new FileInputStream(file);OutputStream out=getContentResolver().openOutputStream(target,"w")) {
                if(out==null)throw new IOException("No image output");
                MediaTransfer.copy(in,out,TemporaryImagePolicy.MAX_BYTES,file.length(),System.nanoTime()+TimeUnit.SECONDS.toNanos(30),cancel::throwIfCanceled);
            }
            cancel.throwIfCanceled();ContentValues ready=new ContentValues();ready.put(MediaStore.Images.Media.IS_PENDING,0);
            if(getContentResolver().update(target,ready,null,null)!=1)throw new IOException("Cannot publish image");
            committed=true;
        } finally {if(!committed)getContentResolver().delete(target,null,null);}
    }
    @Override public void onDestroy(){cancel.cancel();HttpURLConnection c=connection;if(c!=null)c.disconnect();worker.shutdownNow();super.onDestroy();}
}
