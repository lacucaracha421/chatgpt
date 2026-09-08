package com.lakomics.mobile;
import android.app.Activity;
import android.os.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.view.*;
import android.webkit.*;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
public final class MainActivity extends Activity {
 private static final String ORIGIN="https://app.lakomics.local";
 private WebView web; private SecureSettings settings; private CloudClient client; private MediaRepository media;
 private final ThreadPoolExecutor workers=new ThreadPoolExecutor(4,4,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(48));
 private final ThreadPoolExecutor mediaWorkers=new ThreadPoolExecutor(4,4,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(24));
 private final ConcurrentHashMap<String,CancellationSignal> active=new ConcurrentHashMap<>();
 private boolean destroyed=false;
 @Override public void onCreate(Bundle b){super.onCreate(b);settings=new SecureSettings(this);client=new CloudClient(settings);
  try{media=MediaRepository.get(this);}catch(IllegalStateException ignored){}
  getWindow().setStatusBarColor(Color.rgb(16,17,18));getWindow().setNavigationBarColor(Color.rgb(16,17,18));
  web=new WebView(this);web.setBackgroundColor(Color.rgb(16,17,18));setContentView(web);
  hideStatusBar();
  web.setOnApplyWindowInsetsListener((v,insets)->{if(Build.VERSION.SDK_INT>=30){android.graphics.Insets i=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.ime());v.setPadding(i.left,i.top,i.right,i.bottom);}else v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets;});
  WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setMediaPlaybackRequiresUserGesture(false);s.setJavaScriptCanOpenWindowsAutomatically(false);s.setSupportMultipleWindows(false);s.setSaveFormData(false);s.setSafeBrowsingEnabled(true);
  CookieManager.getInstance().setAcceptCookie(false);WebView.setWebContentsDebuggingEnabled(false);
  web.addJavascriptInterface(new Bridge(),"LakomicsNative");
  web.setWebViewClient(new WebViewClient(){
   @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest r){return !bundled(r.getUrl());}
   @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest r){Uri u=r.getUrl();if(bundled(u))return asset(u);if(r.isForMainFrame() || !"https".equals(u.getScheme()))return denied();return null;}
   @Override public void onReceivedSslError(WebView v,android.webkit.SslErrorHandler h,android.net.http.SslError e){h.cancel();}
   @Override public boolean onRenderProcessGone(WebView v,RenderProcessGoneDetail d){finish();return true;}
  });web.loadUrl(ORIGIN+"/index.html");
 }
 private static boolean bundled(Uri u){return "https".equals(u.getScheme()) && "app.lakomics.local".equals(u.getHost()) && u.getPort()==-1 && u.getUserInfo()==null;}
 private WebResourceResponse denied(){return new WebResourceResponse("text/plain","UTF-8",403,"Forbidden",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
 private WebResourceResponse asset(Uri u){try{String p=u.getPath();if(p==null || p.contains("..") || p.contains("\\"))return denied();if(p.startsWith("/media-cache/") || p.startsWith("/thumbnail-cache/")){String[] parts=p.split("/");if(parts.length!=4 || media==null)return denied();String type=u.getQueryParameter("mime");if(!MediaRepository.imageMime(type))type="image/webp";Map<String,String> cacheHeaders=new HashMap<>();cacheHeaders.put("Cache-Control","no-store");cacheHeaders.put("X-Content-Type-Options","nosniff");return new WebResourceResponse(type,null,200,"OK",cacheHeaders,media.stream(parts[3],Long.parseLong(parts[2])));}if(p.equals("/"))p="/index.html";String mime=p.endsWith(".html")?"text/html":p.endsWith(".js")?"text/javascript":p.endsWith(".css")?"text/css":p.endsWith(".woff2")?"font/woff2":p.endsWith(".ttf")?"font/ttf":p.endsWith(".svg")?"image/svg+xml":"application/octet-stream";
  Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-store");headers.put("X-Content-Type-Options","nosniff");headers.put("Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src https: blob:; font-src 'self'; connect-src https:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");return new WebResourceResponse(mime,"UTF-8",200,"OK",headers,getAssets().open(p.substring(1)));}catch(Exception e){return denied();}}
 private void emit(String event,JSONObject detail){runOnUiThread(()->{if(!destroyed && web!=null && web.getUrl()!=null && web.getUrl().startsWith(ORIGIN+"/"))web.evaluateJavascript("window.dispatchEvent(new CustomEvent("+JSONObject.quote(event)+",{detail:"+(detail==null?"null":detail.toString())+"}))",null);});}
 private void reply(String id,boolean ok,Object data,String error){reply(id,ok,data,error,null);}
 private void reply(String id,boolean ok,Object data,String error,Integer status){try{emit("lakomics-native",new JSONObject().put("id",id).put("ok",ok).put("status",status==null?JSONObject.NULL:status).put("data",data==null?JSONObject.NULL:data).put("error",error==null?JSONObject.NULL:error));}catch(JSONException ignored){}}
 private void cancelOtherRequests(CancellationSignal current){for(CancellationSignal s:active.values())if(s!=current)s.cancel();}
 private static String errorMessage(Exception e){
  if(e instanceof CloudClient.HttpFailure){int status=((CloudClient.HttpFailure)e).status;if(status==401 || status==403)return "인증에 실패했습니다. 토큰을 확인해 주세요.";if(status==404)return "요청한 정보를 찾을 수 없습니다.";return "서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";}
  if(e instanceof java.net.SocketTimeoutException)return "연결 시간이 초과되었습니다. 다시 시도해 주세요.";
  if(e instanceof java.net.UnknownHostException || e instanceof java.net.ConnectException)return "서버에 연결할 수 없습니다. 주소와 네트워크를 확인해 주세요.";
  if(e instanceof javax.net.ssl.SSLException)return "서버의 보안 연결을 확인할 수 없습니다.";
  if(e instanceof UnsupportedOperationException)return "지원하지 않는 요청입니다.";
  if(e instanceof IllegalArgumentException || e instanceof java.net.URISyntaxException)return "서버 주소, 토큰 또는 요청 형식을 확인해 주세요.";
  if(e instanceof IllegalStateException)return "먼저 서버 연결을 설정해 주세요.";
  return "요청에 실패했습니다. 연결 상태를 확인하고 다시 시도해 주세요.";
 }
 private void stopRequests(){for(CancellationSignal s:active.values())s.cancel();active.clear();}
 private JSONObject cacheStatus()throws Exception{if(media==null)throw new IOException("Cache unavailable");return media.status();}
 private JSONObject pickerStatus()throws Exception{
  JSONObject status=PickerLibrary.get(this).status().put("supported",Build.VERSION.SDK_INT>=33);
  if(Build.VERSION.SDK_INT>=33)try{status.put("eligible",android.provider.MediaStore.isSupportedCloudMediaProviderAuthority(getContentResolver(),PickerLibrary.AUTHORITY));status.put("selected",android.provider.MediaStore.isCurrentCloudMediaProviderAuthority(getContentResolver(),PickerLibrary.AUTHORITY));}catch(RuntimeException ignored){}
  return status;
 }
 private JSONObject thumbnail(String id,CancellationSignal signal)throws Exception{return media==null?client.api("/v1/library/assets/"+Uri.encode(id)+"/media-ticket","POST",new JSONObject().put("variant","thumbnail"),signal):media.browser(id,"thumbnail","image/webp",signal);}
 final class Bridge {
  @JavascriptInterface public void cancel(String id){CancellationSignal s=active.remove(id);if(s!=null)s.cancel();}
  @JavascriptInterface public void request(String id,String operation,String payload){
   if(id==null || id.length()>128 || payload==null || payload.length()>65536){return;}CancellationSignal signal=new CancellationSignal();if(active.putIfAbsent(id,signal)!=null)return;
   try{(operation.equals("thumbnail") || operation.equals("media") || operation.equals("collectionArtwork") || operation.equals("catalogImage")?mediaWorkers:workers).execute(()->{try{signal.throwIfCanceled();JSONObject p=new JSONObject(payload);Object data;
    switch(operation){
     case "status":data=settings.status();break;
     case "cacheStatus":data=cacheStatus();break;
     case "clearCache":if(media==null)throw new IOException();media.clear();data=cacheStatus();break;
     case "thumbnail":data=thumbnail(p.getString("assetId"),signal);break;
     case "collectionArtwork":if(media==null)throw new IOException("Cache unavailable");data=media.collectionArtwork(p.getString("collectionId"),p.getString("artworkId"),p.getString("variant"),p.getString("revision"),signal);break;
     case "catalogImage":if(media==null)throw new IOException("Cache unavailable");data=media.catalogImage(p.getString("workId"),p.getString("revision"),p.getString("kind"),p.getInt("index"),p.getString("url"),signal);break;
     case "media":data=media==null?client.api("/v1/library/assets/"+Uri.encode(p.getString("assetId"))+"/media-ticket","POST",new JSONObject().put("variant","original"),signal):media.browser(p.getString("assetId"),"original",p.optString("mime"),signal);break;
     case "pickerStatus":data=pickerStatus();break;
     case "pickerRefresh":PickerLibrary.get(MainActivity.this).refresh(true);data=pickerStatus();break;
     case "openPickerSettings":if(Build.VERSION.SDK_INT<33)throw new UnsupportedOperationException();Intent pickerSettings=new Intent(android.provider.MediaStore.ACTION_PICK_IMAGES_SETTINGS);if(pickerSettings.resolveActivity(getPackageManager())==null)throw new UnsupportedOperationException();runOnUiThread(()->{try{startActivity(pickerSettings);}catch(ActivityNotFoundException ignored){}});data=new JSONObject();break;
     case "configure": String endpoint=NetworkPolicy.endpoint(p.getString("endpoint"),p.optBoolean("allowPrivateHttp",false));String token=p.getString("token");client.validate(endpoint,token,signal);LibraryDocumentsProvider.beginConnectionChange();try{synchronized(LibraryDocumentsProvider.CONNECTION_LOCK){signal.throwIfCanceled();settings.write(endpoint,token,p.optBoolean("allowPrivateHttp",false));cancelOtherRequests(signal);if(media!=null)media.clear();PickerLibrary.get(MainActivity.this).reset();LibraryDocumentsProvider.reset(MainActivity.this);}}finally{LibraryDocumentsProvider.endConnectionChange();} data=settings.status();break;
     case "disconnect":LibraryDocumentsProvider.beginConnectionChange();try{synchronized(LibraryDocumentsProvider.CONNECTION_LOCK){signal.throwIfCanceled();cancelOtherRequests(signal);settings.clear();if(media!=null)media.clear();PickerLibrary.get(MainActivity.this).reset();LibraryDocumentsProvider.reset(MainActivity.this);}}finally{LibraryDocumentsProvider.endConnectionChange();}data=settings.status();break;
     case "api":data=client.api(p.getString("path"),p.optString("method","GET"),p.optJSONObject("body"),signal);break;
     case "openExternal":Uri uri=Uri.parse(p.getString("url"));if(!Arrays.asList("http","https").contains(uri.getScheme()) || uri.getHost()==null || uri.getUserInfo()!=null)throw new Exception();runOnUiThread(()->{try{startActivity(new Intent(Intent.ACTION_VIEW,uri).addCategory(Intent.CATEGORY_BROWSABLE));}catch(ActivityNotFoundException ignored){}});data=new JSONObject();break;
     case "finish":runOnUiThread(()->finish());data=new JSONObject();break;
     default:throw new UnsupportedOperationException();
    }if(!signal.isCanceled())reply(id,true,data,null);
   }catch(Exception e){if(!signal.isCanceled())reply(id,false,null,errorMessage(e),e instanceof CloudClient.HttpFailure?((CloudClient.HttpFailure)e).status:null);}finally{active.remove(id,signal);}});}catch(RejectedExecutionException e){active.remove(id,signal);reply(id,false,null,"요청이 많습니다. 잠시 후 다시 시도해 주세요.");}
  }
 }
 @Override public void onBackPressed(){emit("lakomics-back",null);}
 private void hideStatusBar(){
  if(Build.VERSION.SDK_INT>=30){
   WindowInsetsController controller=getWindow().getInsetsController();
   if(controller!=null){controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);controller.hide(WindowInsets.Type.statusBars());}
  }else getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
 }
 @Override public void onWindowFocusChanged(boolean focused){super.onWindowFocusChanged(focused);if(focused)hideStatusBar();}
 @Override protected void onResume(){super.onResume();hideStatusBar();if(web!=null){web.onResume();emit("lakomics-resume",null);if(Build.VERSION.SDK_INT>=33)PickerLibrary.get(this).refresh(false);}}
 @Override protected void onPause(){if(web!=null)web.onPause();super.onPause();}
 @Override protected void onDestroy(){destroyed=true;stopRequests();workers.shutdownNow();mediaWorkers.shutdownNow();if(web!=null){web.removeJavascriptInterface("LakomicsNative");web.stopLoading();web.destroy();web=null;}super.onDestroy();}
}
