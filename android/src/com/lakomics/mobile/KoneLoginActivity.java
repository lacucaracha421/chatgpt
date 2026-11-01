package com.lakomics.mobile;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.net.Uri;
import android.webkit.*;

/** Visible sign-in, sharing the existing probe's persistent :kone data directory. */
public final class KoneLoginActivity extends Activity {
    private final Handler handler=new Handler();private WebView web;private boolean sawAccount;
    private final Runnable poll=new Runnable(){public void run(){if(web==null)return;check(web.getUrl());if(web!=null)handler.postDelayed(this,100);}};
    @Override public void onCreate(Bundle state){
        super.onCreate(state);setResult(RESULT_CANCELED);
        try{KonePage.initialize();}catch(Exception e){finish();return;}
        web=new WebView(this);KonePage.configure(web);
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return r.isForMainFrame()&&!KonePage.allowed(r.getUrl());}
            @Override public boolean shouldOverrideUrlLoading(WebView v,String u){return !KonePage.allowed(Uri.parse(u));}
            @Override public void onPageFinished(WebView v,String u){check(u);}
            @Override public void onReceivedSslError(WebView v,SslErrorHandler h,android.net.http.SslError e){h.cancel();}
        });setContentView(web);web.loadUrl(KonePage.SIGNIN);handler.post(poll);
    }
    private void check(String url){
        if(url==null)return;Uri u=Uri.parse(url);if(!KonePage.kone(u))return;String path=u.getPath();boolean account=path!=null&&(path.equals("/account")||path.startsWith("/account/"));
        if(account)sawAccount=true;
        if(sawAccount&&!account){setResult(RESULT_OK);finish();}
    }
    @Override protected void onDestroy(){handler.removeCallbacksAndMessages(null);if(web!=null){web.stopLoading();web.destroy();web=null;}super.onDestroy();}
}
