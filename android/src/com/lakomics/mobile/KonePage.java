package com.lakomics.mobile;

import android.net.Uri;
import android.os.Build;
import android.webkit.WebView;
import android.webkit.WebSettings;

/** Used only by components declared in :kone, before constructing their first WebView. */
final class KonePage {
    static final String SIGNIN="https://kone.gg/account/signin?path=%2Fs%2Fsomisoft";
    private static boolean initialized;
    static synchronized void initialize(){
        if(Build.VERSION.SDK_INT<28)throw new IllegalStateException("Android 9 이상이 필요합니다");
        if(!initialized){WebView.setDataDirectorySuffix("kone");initialized=true;}
    }
    static boolean kone(Uri u){return "https".equals(u.getScheme())&&"kone.gg".equals(u.getHost())&&(u.getPort()==-1||u.getPort()==443)&&u.getUserInfo()==null;}
    static boolean allowed(Uri u){return kone(u)||("https".equals(u.getScheme())&&"challenges.cloudflare.com".equals(u.getHost())&&(u.getPort()==-1||u.getPort()==443)&&u.getUserInfo()==null);}
    static void configure(WebView w){
        WebSettings s=w.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setJavaScriptCanOpenWindowsAutomatically(false);
        // CookieManager is process-wide. This helper must never run in the main process.
        KoneService.configureCookies(w);
    }
}
