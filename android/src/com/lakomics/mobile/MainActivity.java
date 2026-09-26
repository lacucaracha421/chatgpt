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
 private PrivateVault vault;
 private WebView web; private SecureSettings settings; private CloudClient client; private MediaRepository media; private NotesRepository notes;
 private final ThreadPoolExecutor workers=new ThreadPoolExecutor(4,4,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(48));
 private final ThreadPoolExecutor mediaWorkers=new ThreadPoolExecutor(4,4,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(24));
 private final PerfLog.Pool perfPool=new PerfLog.Pool();
 private final ConcurrentHashMap<String,CancellationSignal> active=new ConcurrentHashMap<>();
 private final ConcurrentHashMap<String,CancellationSignal> nonEssential=new ConcurrentHashMap<>();
 private boolean stopped=true;
 private boolean destroyed=false;
 private volatile boolean foreground=false;
 private static final int EXCHANGE_PICK=0x4c58,EXCHANGE_TREE=0x4c59;
 private volatile String exchangeTarget;
 private final ExchangeService.Listener exchangeListener=this::emit;
 private ExchangeService exchange(){return ExchangeService.get(this);}
 /** 보내기: the system document picker, multi-select, no storage permission. */
 private JSONObject pickForExchange(String target)throws Exception{
  if(!ExchangeTransfer.uuid(target))throw new ExchangeService.UserError("받는 기기를 선택해 주세요.");
  exchangeTarget=target;
  Intent pick=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true)
   .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
  runOnUiThread(()->{try{startActivityForResult(pick,EXCHANGE_PICK);}catch(ActivityNotFoundException missing){emitExchangeNotice("파일 선택기를 열 수 없습니다.");}});
  return new JSONObject().put("launched",true);
 }
 /** 폴더 보내기: the system folder picker; its transient grant covers the zipping step. */
 private JSONObject pickFolderForExchange(String target)throws Exception{
  if(!ExchangeTransfer.uuid(target))throw new ExchangeService.UserError("받는 기기를 선택해 주세요.");
  exchangeTarget=target;
  Intent pick=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
  runOnUiThread(()->{try{startActivityForResult(pick,EXCHANGE_TREE);}catch(ActivityNotFoundException missing){emitExchangeNotice("폴더 선택기를 열 수 없습니다.");}});
  return new JSONObject().put("launched",true);
 }
 private void emitExchangeNotice(String message){try{emit("lakomics-exchange-notice",new JSONObject().put("message",message));}catch(JSONException ignored){}}
 /** 열기: hand the saved Downloads entry to a viewer app with a read grant. */
 private void openExchange(String id)throws Exception{
  Uri uri=exchange().savedUri(id);String type=getContentResolver().getType(uri);
  Intent view=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,type==null?"application/octet-stream":type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
  FutureTask<Void> start=new FutureTask<>(()->{startActivity(view);return null;});
  runOnUiThread(start);
  try{start.get(5,TimeUnit.SECONDS);}
  catch(java.util.concurrent.ExecutionException e){if(e.getCause() instanceof ActivityNotFoundException)throw new ExchangeService.UserError("이 파일을 열 수 있는 앱이 없습니다.");throw new IOException("Cannot open");}
 }
 // Metering follows the WebView warm-up policy; native also fences queued work on pause.
 private boolean ticketWarmAllowed(){return foreground&&batteryAllowsWarm();}
 private JSONObject batteryState()throws JSONException{
  Intent battery=registerReceiver(null,new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
  int raw=battery==null?-1:battery.getIntExtra(BatteryManager.EXTRA_LEVEL,-1);
  int scale=battery==null?-1:battery.getIntExtra(BatteryManager.EXTRA_SCALE,-1);
  int level=raw>=0&&scale>0?(int)(100L*raw/scale):-1;
  int state=battery==null?-1:battery.getIntExtra(BatteryManager.EXTRA_STATUS,-1);
  boolean charging=state==BatteryManager.BATTERY_STATUS_CHARGING||state==BatteryManager.BATTERY_STATUS_FULL;
  PowerManager power=(PowerManager)getSystemService(Context.POWER_SERVICE);
  return new JSONObject().put("charging",charging).put("level",level).put("powerSave",power==null||power.isPowerSaveMode());
 }
 private boolean batteryAllowsWarm(){try{JSONObject b=batteryState();return b.optBoolean("charging")||(b.optInt("level",-1)>=50&&!b.optBoolean("powerSave",true));}catch(Exception e){return false;}}
 private JSONObject connectionStatus()throws Exception{return settings.status().put("battery",batteryState());}
 private static JSONObject mediaBusy(){try{return new JSONObject().put("code","media_busy");}catch(JSONException e){return null;}}
 private static boolean optionalWork(String op){return Arrays.asList("thumbnail","media","collectionArtwork","catalogImage","mediaTickets","pickerRefresh").contains(op);}
 private void cancelOptional(String id,CancellationSignal signal){
  signal.cancel();nonEssential.remove(id,signal);
  try{emit("lakomics-native",new JSONObject().put("id",id).put("ok",false).put("cancelled",true));}catch(JSONException ignored){}
 }
 private synchronized void stopNonEssential(){stopped=true;for(Map.Entry<String,CancellationSignal> entry:nonEssential.entrySet())cancelOptional(entry.getKey(),entry.getValue());}
 @Override public void onCreate(Bundle b){super.onCreate(b);settings=new SecureSettings(this);client=new CloudClient(settings);notes=new NotesRepository(this,settings);vault=new PrivateVault(this,state->emit("lakomics-vault",state));
  try{media=MediaRepository.get(this);}catch(IllegalStateException ignored){}
  getWindow().setStatusBarColor(Color.rgb(16,17,18));getWindow().setNavigationBarColor(Color.rgb(16,17,18));
  web=new WebView(this);web.setBackgroundColor(Color.rgb(16,17,18));
  android.widget.FrameLayout frame=new android.widget.FrameLayout(this);frame.setBackgroundColor(Color.rgb(16,17,18));frame.addView(web,new android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT));setContentView(frame);
  hideStatusBar();
  // Edge-to-edge (targetSdk 35 on Android 15+) no longer resizes the window for the soft
  // keyboard, and a WebView ignores its own padding, so the page never learned the keyboard
  // covered it. The frame pads the keyboard's height below the WebView, shrinking the page
  // above the keyboard as adjustResize did, and hands the WebView the insets without it.
  if(Build.VERSION.SDK_INT>=30)frame.setOnApplyWindowInsetsListener((v,insets)->{v.setPadding(0,0,0,insets.getInsets(WindowInsets.Type.ime()).bottom);return new WindowInsets.Builder(insets).setInsets(WindowInsets.Type.ime(),android.graphics.Insets.NONE).build();});
  web.setOnApplyWindowInsetsListener((v,insets)->{if(Build.VERSION.SDK_INT>=30){android.graphics.Insets i=insets.getInsets(WindowInsets.Type.systemBars());v.setPadding(i.left,i.top,i.right,i.bottom);}else v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets;});
  WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setMediaPlaybackRequiresUserGesture(false);s.setJavaScriptCanOpenWindowsAutomatically(false);s.setSupportMultipleWindows(false);s.setSaveFormData(false);s.setSafeBrowsingEnabled(true);
  CookieManager.getInstance().setAcceptCookie(false);WebView.setWebContentsDebuggingEnabled(false);
  web.addJavascriptInterface(new Bridge(),"LakomicsNative");ExchangeService.get(this).addListener(exchangeListener);
  web.setWebViewClient(new WebViewClient(){
   @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest r){return !bundled(r.getUrl());}
   @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest r){Uri u=r.getUrl();if(bundled(u)){if(u.getPath()!=null && u.getPath().startsWith("/vault/"))return vault.serve(r);return asset(u);}if(r.isForMainFrame() || !"https".equals(u.getScheme()))return denied();return null;}
   @Override public void onReceivedSslError(WebView v,android.webkit.SslErrorHandler h,android.net.http.SslError e){h.cancel();}
   @Override public boolean onRenderProcessGone(WebView v,RenderProcessGoneDetail d){vault.lock("");finish();return true;}
  });web.loadUrl(ORIGIN+"/index.html");
 }
 // The bundled FAULT game (single self-contained file: inline scripts, data: font) runs only as a same-origin
 // frame of the app. It gets no network access beyond this origin and blob: photos handed over by the app.
 private static final String FAULT_GAME_CSP="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:; font-src data:; media-src blob:; connect-src 'self' blob:; frame-src 'none'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
 static boolean faultGame(String path){return path!=null && path.matches("/assets/fault-[A-Za-z0-9_-]+\\.html");}
 private static boolean bundled(Uri u){return "https".equals(u.getScheme()) && "app.lakomics.local".equals(u.getHost()) && u.getPort()==-1 && u.getUserInfo()==null;}
 private WebResourceResponse denied(){return new WebResourceResponse("text/plain","UTF-8",403,"Forbidden",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
 private WebResourceResponse asset(Uri u){try{String p=u.getPath();if(p==null || p.contains("..") || p.contains("\\"))return denied();if(p.startsWith("/media-cache/") || p.startsWith("/thumbnail-cache/")){String[] parts=p.split("/");if(parts.length!=4 || media==null)return denied();String type=u.getQueryParameter("mime");if(!MediaRepository.imageMime(type))type="image/webp";Map<String,String> cacheHeaders=new HashMap<>();cacheHeaders.put("Cache-Control","private, max-age="+ThumbnailCache.MAX_AGE_SECONDS+", immutable");cacheHeaders.put("X-Content-Type-Options","nosniff");return new WebResourceResponse(type,null,200,"OK",cacheHeaders,media.stream(parts[3],Long.parseLong(parts[2])));}if(p.equals("/"))p="/index.html";String mime=p.endsWith(".html")?"text/html":p.endsWith(".js")?"text/javascript":p.endsWith(".css")?"text/css":p.endsWith(".woff2")?"font/woff2":p.endsWith(".ttf")?"font/ttf":p.endsWith(".svg")?"image/svg+xml":"application/octet-stream";
  Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-store");headers.put("X-Content-Type-Options","nosniff");headers.put("Content-Security-Policy",faultGame(p)?FAULT_GAME_CSP:"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src https: blob:; font-src 'self'; connect-src https:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");return new WebResourceResponse(mime,"UTF-8",200,"OK",headers,getAssets().open(p.substring(1)));}catch(Exception e){return denied();}}
 private void emit(String event,JSONObject detail){runOnUiThread(()->{if(!destroyed && web!=null && web.getUrl()!=null && web.getUrl().startsWith(ORIGIN+"/"))web.evaluateJavascript("window.dispatchEvent(new CustomEvent("+JSONObject.quote(event)+",{detail:"+(detail==null?"null":detail.toString())+"}))",null);});}
 private void reply(String id,boolean ok,Object data,String error){reply(id,ok,data,error,null,null);}
 private void reply(String id,boolean ok,Object data,String error,Integer status,Object details){try{emit("lakomics-native",new JSONObject().put("id",id).put("ok",ok).put("status",status==null?JSONObject.NULL:status).put("data",data==null?JSONObject.NULL:data).put("error",error==null?JSONObject.NULL:error).put("details",details==null?JSONObject.NULL:details));}catch(JSONException ignored){}}
 private void cancelOtherRequests(CancellationSignal current){for(CancellationSignal s:active.values())if(s!=current)s.cancel();}
 private static String errorMessage(Exception e){
  if(e instanceof VaultCrypto.Invalid || e instanceof ExchangeService.UserError || e instanceof NotesRepository.UserError)return e.getMessage();
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
 /** Album replica status for the native/WebView bridge. */
 private JSONObject albumStatus()throws Exception{return AlbumReplicaService.get(this).status();}
 /**
  * Copy a bounded metadata string the user explicitly asked for.
  *
  * Runs on the UI thread and waits for it, so the reply reports the clipboard write
  * itself: posting and then answering immediately would claim success before the write
  * happened, or after it silently failed.
  */
 private void copyText(final String text,final CancellationSignal signal)throws Exception{
  final String value=ClipboardPolicy.text(text),label=ClipboardPolicy.label();
  final FutureTask<Void> write=new FutureTask<>(()->{signal.throwIfCanceled();ClipboardManager manager=(ClipboardManager)getSystemService(Context.CLIPBOARD_SERVICE);if(manager==null)throw new IOException("Clipboard unavailable");manager.setPrimaryClip(ClipData.newPlainText(label,value));return null;});
  runOnUiThread(write);
  try{write.get(5,TimeUnit.SECONDS);}
  catch(java.util.concurrent.ExecutionException e){Throwable cause=e.getCause();if(cause instanceof Exception)throw (Exception)cause;throw new IOException("Clipboard write failed");}
  finally{write.cancel(false);}
 }
 private JSONObject thumbnail(String id,CancellationSignal signal)throws Exception{return media==null?client.api("/v1/library/assets/"+Uri.encode(id)+"/media-ticket","POST",new JSONObject().put("variant","thumbnail"),signal):media.browser(id,"thumbnail","image/webp",signal);}
 /** Fingerprint (BiometricPrompt, API 28+) can open secret notes; the PIN is always the fallback. */
 private boolean biometricAvailable(){
  if(Build.VERSION.SDK_INT<28)return false;
  if(Build.VERSION.SDK_INT>=30){android.hardware.biometrics.BiometricManager m=getSystemService(android.hardware.biometrics.BiometricManager.class);return m!=null&&m.canAuthenticate(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG)==android.hardware.biometrics.BiometricManager.BIOMETRIC_SUCCESS;}
  if(Build.VERSION.SDK_INT>=29){android.hardware.biometrics.BiometricManager m=getSystemService(android.hardware.biometrics.BiometricManager.class);return m!=null&&m.canAuthenticate()==android.hardware.biometrics.BiometricManager.BIOMETRIC_SUCCESS;}
  return getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_FINGERPRINT);
 }
 /** Shows the system fingerprint prompt and waits for its result on this worker thread. */
 private void authenticateBiometric(CancellationSignal signal)throws Exception{
  if(Build.VERSION.SDK_INT<28||!biometricAvailable())throw new NotesRepository.UserError("이 기기에서는 지문으로 열 수 없습니다. PIN을 입력해 주세요.");
  final CountDownLatch done=new CountDownLatch(1);final String[] failure={null};final CancellationSignal prompt=new CancellationSignal();
  signal.setOnCancelListener(prompt::cancel);
  runOnUiThread(()->{
   try{
    Executor main=getMainExecutor();
    android.hardware.biometrics.BiometricPrompt.Builder builder=new android.hardware.biometrics.BiometricPrompt.Builder(this).setTitle("암호 메모 열기").setSubtitle("지문으로 이 기기의 암호 메모를 엽니다")
     .setNegativeButton("PIN 입력",main,(dialog,which)->{failure[0]="";done.countDown();});
    if(Build.VERSION.SDK_INT>=29)builder.setConfirmationRequired(false);
    if(Build.VERSION.SDK_INT>=30)builder.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG);
    builder.build().authenticate(prompt,main,new android.hardware.biometrics.BiometricPrompt.AuthenticationCallback(){
     @Override public void onAuthenticationSucceeded(android.hardware.biometrics.BiometricPrompt.AuthenticationResult result){done.countDown();}
     @Override public void onAuthenticationError(int code,CharSequence message){
      failure[0]=code==android.hardware.biometrics.BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED||code==android.hardware.biometrics.BiometricPrompt.BIOMETRIC_ERROR_CANCELED?"":"지문으로 열지 못했습니다. PIN을 입력해 주세요.";done.countDown();}
    });
   }catch(RuntimeException e){failure[0]="지문 인증을 시작하지 못했습니다. PIN을 입력해 주세요.";done.countDown();}
  });
  // The WebView request times out at 45 s; close the prompt before that.
  if(!done.await(40,TimeUnit.SECONDS)){prompt.cancel();throw new NotesRepository.UserError("지문 인증 시간이 지났습니다. 다시 시도하거나 PIN을 입력해 주세요.");}
  signal.throwIfCanceled();
  if(failure[0]!=null)throw new NotesRepository.UserError(failure[0].isEmpty()?"PIN을 입력해 주세요.":failure[0]);
 }
 private final Handler clipboardHandler=new Handler(Looper.getMainLooper());
 /** The clip this app placed for a secret value (its timestamp), until it is cleared or replaced. */
 private long secretClip=-1,secretClipDue=0;
 /**
  * Copies a secret-note value, marked sensitive so the system hides its preview, and clears
  * it after 30 s if the clipboard still holds it. The value is never logged.
  */
 private void copySecret(final String text,final CancellationSignal signal)throws Exception{
  final String value=ClipboardPolicy.text(text);
  final FutureTask<Void> write=new FutureTask<>(()->{signal.throwIfCanceled();ClipboardManager manager=(ClipboardManager)getSystemService(Context.CLIPBOARD_SERVICE);if(manager==null)throw new IOException("Clipboard unavailable");
   ClipData clip=ClipData.newPlainText(ClipboardPolicy.label(),value);PersistableBundle extras=new PersistableBundle();
   extras.putBoolean(Build.VERSION.SDK_INT>=33?ClipDescription.EXTRA_IS_SENSITIVE:"android.content.extra.IS_SENSITIVE",true);clip.getDescription().setExtras(extras);
   manager.setPrimaryClip(clip);ClipDescription placed=manager.getPrimaryClipDescription();
   secretClip=placed==null?-1:placed.getTimestamp();secretClipDue=SystemClock.uptimeMillis()+30_000;
   clipboardHandler.removeCallbacks(clearSecretClip);clipboardHandler.postDelayed(clearSecretClip,30_000);return null;});
  runOnUiThread(write);
  try{write.get(5,TimeUnit.SECONDS);}
  catch(java.util.concurrent.ExecutionException e){Throwable cause=e.getCause();if(cause instanceof Exception)throw (Exception)cause;throw new IOException("Clipboard write failed");}
  finally{write.cancel(false);}
 }
 /** Runs on the main thread; while the app is in the background the clip cannot be checked, so resume retries. */
 private final Runnable clearSecretClip=()->{
  if(secretClip<0||SystemClock.uptimeMillis()<secretClipDue)return;
  ClipboardManager manager=(ClipboardManager)getSystemService(Context.CLIPBOARD_SERVICE);if(manager==null){secretClip=-1;return;}
  ClipDescription now;try{now=manager.getPrimaryClipDescription();}catch(RuntimeException e){now=null;}
  // Unreadable without window focus (Android 10+): keep it and check again on focus.
  if(now==null)return;
  if(now.getTimestamp()==secretClip){if(Build.VERSION.SDK_INT>=28)manager.clearPrimaryClip();else manager.setPrimaryClip(ClipData.newPlainText("",""));}
  secretClip=-1;
 };
 final class Bridge {
  @JavascriptInterface public void cancel(String id){CancellationSignal s=active.remove(id);if(s!=null)s.cancel();}
  @JavascriptInterface public void request(String id,String operation,String payload){
   if("perfLog".equals(operation)){PerfLog.javascript(payload);return;}
   // A note save carries up to 128 KiB of text (256 KiB plaintext); every other request stays small.
   if(id==null || id.length()>128 || payload==null || payload.length()>(operation!=null&&operation.startsWith("notes")?1_048_576:65536)){return;}CancellationSignal signal=new CancellationSignal();if(active.putIfAbsent(id,signal)!=null)return;
   if("vaultShow".equals(operation)){
    try{final boolean visible=new JSONObject(payload).getBoolean("visible");runOnUiThread(()->{
     if(destroyed){active.remove(id);return;}
     vault.setVisible(visible);web.setImportantForAutofill(visible?View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS:View.IMPORTANT_FOR_AUTOFILL_AUTO);
     try{workers.execute(()->{try{if(!signal.isCanceled())reply(id,true,visible?vault.inspect():vault.state(),null);}catch(Exception e){reply(id,false,null,errorMessage(e));}finally{active.remove(id,signal);}});}
     catch(RejectedExecutionException e){active.remove(id,signal);reply(id,false,null,"잠시 후 다시 시도해 주세요.");}
    });}catch(JSONException e){active.remove(id,signal);reply(id,false,null,"보관함 화면을 열 수 없습니다.");}return;
   }
   if("vaultUnlock".equals(operation))signal.setOnCancelListener(()->vault.lock("보관함 열기가 취소되었습니다"));
   if("vaultLock".equals(operation)){vault.lock("보관함이 잠겼습니다");try{reply(id,true,vault.state(),null);}catch(JSONException ignored){}active.remove(id);return;}
   final long vaultEpoch=vault.epoch();
   if(optionalWork(operation)){synchronized(MainActivity.this){nonEssential.put(id,signal);if(stopped)cancelOptional(id,signal);}}
   final PerfLog.Op perf=operation.equals("thumbnail")||operation.equals("media")?perfPool.submit(operation,mediaWorkers.getQueue().size()):null;
   final boolean mediaWork=operation.equals("thumbnail") || operation.equals("media") || operation.equals("collectionArtwork") || operation.equals("catalogImage");
   final Runnable task=()->{if(perf!=null)perfPool.start(perf);try{signal.throwIfCanceled();JSONObject p=new JSONObject(payload);Object data;
    if(perf!=null){perf.asset=PerfLog.id(p.optString("assetId"));perf.request=PerfLog.id(p.optString("perfId"));}
    switch(operation){
     case "vaultPick":data=vault.pick();break;
     case "vaultState":data=vault.inspect();break;
     case "vaultUnlock":data=vault.unlock(p.getString("secret"),p.optBoolean("recovery"),signal,vaultEpoch);break;
     case "notesState":data=notes.state();break;
     case "notesUnlock":data=notes.unlock(p.getString("key"));break;
     case "notesSave":data=notes.save(payload);break;
     case "notesSync":data=notes.sync(signal);break;
     case "notesDismissConflictCopy":data=notes.dismissConflictCopy(p.getString("id"));break;
     case "notesLedgerMonthId":data=notes.ledgerMonthId(p.getString("ledger"),p.getString("month"));break;
     // Secret notes (암호 메모): a per-device PIN or the fingerprint opens an in-process session.
     case "notesSecretStatus":data=notes.secretStatus().put("biometric",biometricAvailable());break;
     case "notesSecretSetPin":data=notes.secretSetPin(p.optString("pin"));break;
     case "notesSecretUnlock":if(p.optBoolean("biometric")){authenticateBiometric(signal);data=notes.secretUnlockBiometric();}else data=notes.secretUnlock(p.optString("pin"));break;
     case "notesSecretResetPin":data=notes.secretResetPin(p.optString("recoveryKey"),p.optString("pin"));break;
     case "notesSecretLock":notes.lockSecrets();data=new JSONObject();break;
     case "notesSecretTouch":data=notes.touchSecrets();break;
     case "notesRecoveryKey":data=notes.recoveryKey();break;
     case "notesCopySecret":copySecret(p.getString("text"),signal);data=new JSONObject();break;
     case "status":data=connectionStatus();break;
     case "cacheStatus":data=cacheStatus();break;
     case "clearCache":if(media==null)throw new IOException();media.clear();data=cacheStatus();break;
     case "thumbnail":data=thumbnail(p.getString("assetId"),signal);break;
     case "collectionArtwork":if(media==null)throw new IOException("Cache unavailable");data=media.collectionArtwork(p.getString("collectionId"),p.getString("artworkId"),p.getString("variant"),p.getString("revision"),p.optString("digest",""),signal);break;
     case "catalogImage":if(media==null)throw new IOException("Cache unavailable");data=media.catalogImage(p.getString("workId"),p.getString("revision"),p.getString("kind"),p.getInt("index"),p.getString("url"),signal);break;
     case "mediaTickets":data=media==null?new JSONObject().put("items",new JSONArray()):media.prewarmTickets(p.getJSONArray("assetIds"),signal,MainActivity.this::ticketWarmAllowed);break;
     case "media":data=media==null?client.api("/v1/library/assets/"+Uri.encode(p.getString("assetId"))+"/media-ticket","POST",new JSONObject().put("variant","original"),signal):media.browser(p.getString("assetId"),"original",p.optString("mime"),signal);break;
     case "pickerStatus":data=pickerStatus();break;
     case "albumStatus":data=albumStatus();break;
     case "albumTree":data=albumStatus().put("albums",AlbumReplicaService.get(MainActivity.this).albumList());break;
     case "albumMemberships":data=AlbumReplicaService.get(MainActivity.this).membershipState(p.getString("assetId"));break;
     case "albumMembershipSet":data=AlbumReplicaService.get(MainActivity.this).setMembership(p.getString("assetId"),p.getString("albumId"),p.getBoolean("desiredState"));break;
     case "albumMembershipResolve":data=AlbumReplicaService.get(MainActivity.this).resolveMembership(p.getString("assetId"),p.getString("albumId"),p.getString("action"));break;
     // The single-Asset Classification editor. Both operations are narrow: the read
     // returns the visible assignment plus the live hierarchy, and the write accepts only
     // an Asset id and a desired Classification id (null for unassigned). The native layer
     // owns every protocol field — operation id, library, epoch, contract, command name and
     // expected revision — so no raw Classification command can be constructed here.
     case "classificationAssignmentState":data=AlbumReplicaService.get(MainActivity.this).classificationAssignmentState(p.getString("assetId"));break;
     case "classificationAssignmentSet":data=AlbumReplicaService.get(MainActivity.this).setClassificationAssignment(p.getString("assetId"),p.isNull("classificationId")?null:p.getString("classificationId"));break;
     // Library Trash: the web supplies only the Asset, `trash`/`restore` and the lifecycle
     // revision it saw; the native outbox owns every protocol field. There is no empty or
     // tombstone operation: emptying the trash stays on the PC.
     case "assetLifecycleState":data=AlbumReplicaService.get(MainActivity.this).assetLifecycleState();break;
     case "assetLifecycleSet":data=AlbumReplicaService.get(MainActivity.this).setAssetLifecycle(p.getString("assetId"),p.getString("command"),p.optLong("seenRevision",0));break;
     case "assetLifecycleDismiss":data=AlbumReplicaService.get(MainActivity.this).dismissAssetLifecycle(p.getString("assetId"));break;
     case "pickerRefresh":PickerLibrary.get(MainActivity.this).refreshManual();data=pickerStatus();break;
     case "openPickerSettings":if(Build.VERSION.SDK_INT<33)throw new UnsupportedOperationException();Intent pickerSettings=new Intent(android.provider.MediaStore.ACTION_PICK_IMAGES_SETTINGS);if(pickerSettings.resolveActivity(getPackageManager())==null)throw new UnsupportedOperationException();runOnUiThread(()->{try{startActivity(pickerSettings);}catch(ActivityNotFoundException ignored){}});data=new JSONObject();break;
     case "configure": String endpoint=NetworkPolicy.endpoint(p.getString("endpoint"),p.optBoolean("allowPrivateHttp",false));String token=p.getString("token");client.validate(endpoint,token,signal);LibraryDocumentsProvider.beginConnectionChange();try{synchronized(LibraryDocumentsProvider.CONNECTION_LOCK){signal.throwIfCanceled();settings.write(endpoint,token,p.optBoolean("allowPrivateHttp",false));client.clearConditional();cancelOtherRequests(signal);if(media!=null)media.clear();PickerLibrary.get(MainActivity.this).reset();
      // A replacement connection clears the old replica and keeps Album reconciliation
      // running. Configuring does not pause the activity, so a bare reset would stop the
      // loop until the user backgrounded and resumed the app.
      AlbumReplicaService.get(MainActivity.this).replaceConnection();LibraryDocumentsProvider.reset(MainActivity.this);exchange().reset();}}finally{LibraryDocumentsProvider.endConnectionChange();} data=connectionStatus();break;
     case "disconnect":LibraryDocumentsProvider.beginConnectionChange();try{synchronized(LibraryDocumentsProvider.CONNECTION_LOCK){signal.throwIfCanceled();cancelOtherRequests(signal);settings.clear();client.clearConditional();if(media!=null)media.clear();PickerLibrary.get(MainActivity.this).reset();AlbumReplicaService.get(MainActivity.this).reset();LibraryDocumentsProvider.reset(MainActivity.this);settings.clearExchangeTokens();exchange().reset();}}finally{LibraryDocumentsProvider.endConnectionChange();}data=connectionStatus();break;
     case "api":data=p.optBoolean("conditional")&&p.optString("method","GET").equals("GET")?client.conditionalApi(p.getString("path"),signal):client.api(p.getString("path"),p.optString("method","GET"),p.optJSONObject("body"),signal);break;
     case "bookmarkCommand": String provider=p.getString("provider");String workId=p.getString("providerWorkId");if(!provider.matches("kHentai|heliotrope") || !workId.matches("[0-9A-Za-z_-]{1,64}"))throw new IllegalArgumentException("Invalid bookmark identity");BookmarkCommand.validate(p);JSONObject command=BookmarkCommand.body(p);
      try{data=client.api(BookmarkCommand.path(provider,workId),"PUT",command,signal);}
      catch(CloudClient.HttpFailure failure){
       // A revision conflict is a recoverable state, not a failure: it carries the
       // authoritative revision the client must re-base the same intent onto.
       BookmarkCommand.Conflict conflict=BookmarkCommand.conflict(failure.detailObject());
       if(conflict!=null){JSONObject resolved=new JSONObject();resolved.put("conflict",new JSONObject().put("revision",conflict.revision).put("desiredState",conflict.desired));data=resolved;}
       else throw failure;
      }
      break;
     case "openExternal":Uri uri=Uri.parse(p.getString("url"));if(!Arrays.asList("http","https").contains(uri.getScheme()) || uri.getHost()==null || uri.getUserInfo()!=null)throw new Exception();runOnUiThread(()->{try{startActivity(new Intent(Intent.ACTION_VIEW,uri).addCategory(Intent.CATEGORY_BROWSABLE));}catch(ActivityNotFoundException ignored){}});data=new JSONObject();break;
     // File exchange (보내기/받기). Native owns every protocol field, the device id and token.
     case "exchangeState":data=exchange().snapshot();break;
     case "exchangeDevices":data=exchange().refreshNow();break;
     case "exchangeVisible":exchange().setVisible(p.getBoolean("visible"));data=exchange().snapshot();break;
     case "exchangeToken":data=exchange().setToken(p.optString("token","").trim());break;
     case "exchangeSend":data=pickForExchange(p.getString("toDevice"));break;
     case "exchangeSendFolder":data=pickFolderForExchange(p.getString("toDevice"));break;
     case "exchangeRetry":exchange().retry(p.getString("transferId"));data=exchange().snapshot();break;
     case "exchangeCancel":exchange().cancel(p.getString("transferId"));data=exchange().snapshot();break;
     case "exchangeOpen":openExchange(p.getString("transferId"));data=new JSONObject();break;
     case "copyText":copyText(p.getString("text"),signal);data=new JSONObject();break;
     case "finish":runOnUiThread(()->finish());data=new JSONObject();break;
     default:throw new UnsupportedOperationException();
    }if(perf!=null)perf.status="ok";if(!signal.isCanceled())reply(id,true,data,null);
   }catch(Exception e){if(!signal.isCanceled())reply(id,false,null,errorMessage(e),e instanceof CloudClient.HttpFailure?((CloudClient.HttpFailure)e).status:null,e instanceof CloudClient.HttpFailure?((CloudClient.HttpFailure)e).detailObject():null);}finally{active.remove(id,signal);nonEssential.remove(id,signal);if(perf!=null){if(signal.isCanceled())perf.status="canceled";perfPool.remove(perf);perf.finish(payload);}}};
   // An abandoned media request leaves the queue at once instead of holding one of its slots
   // until a worker reaches it. Once the task runs, its network calls replace this listener.
   if(mediaWork)signal.setOnCancelListener(()->{if(mediaWorkers.remove(task)){active.remove(id,signal);nonEssential.remove(id,signal);if(perf!=null){perf.status="canceled";perfPool.remove(perf);perf.finish(payload);}}});
   try{(mediaWork?mediaWorkers:workers).execute(task);}catch(RejectedExecutionException e){if(mediaWork)signal.setOnCancelListener(null);active.remove(id,signal);nonEssential.remove(id,signal);if(perf!=null){perf.status="rejected";perfPool.remove(perf);perf.finish(payload);}
    // A full media queue means the request never started: the "media_busy" code lets a visible caller retry it later instead of showing it as broken.
    reply(id,false,null,"요청이 많습니다. 잠시 후 다시 시도해 주세요.",null,mediaWork?mediaBusy():null);}
  }
 }
 @Override public void onTrimMemory(int level){if(vault!=null)vault.lock("메모리를 확보하기 위해 잠겼습니다");super.onTrimMemory(level);}
 @Override protected void onActivityResult(int request,int result,Intent data){
  if(request==EXCHANGE_TREE){
   final String target=exchangeTarget;final Uri tree=result==RESULT_OK&&data!=null?data.getData():null;
   if(tree!=null&&target==null)emitExchangeNotice("받는 기기를 다시 선택해 주세요.");
   if(tree!=null&&target!=null)try{workers.execute(()->{try{exchange().sendFolder(tree,target);}catch(ExchangeService.UserError e){emitExchangeNotice(e.getMessage());}catch(Exception e){emitExchangeNotice("폴더를 보낼 준비를 하지 못했습니다.");}});}catch(RejectedExecutionException e){emitExchangeNotice("잠시 후 다시 시도해 주세요.");}
   return;
  }
  if(request==EXCHANGE_PICK){
   final String target=exchangeTarget;final List<Uri> picked=new ArrayList<>();
   if(result==RESULT_OK && data!=null){if(data.getClipData()!=null)for(int i=0;i<data.getClipData().getItemCount();i++)picked.add(data.getClipData().getItemAt(i).getUri());else if(data.getData()!=null)picked.add(data.getData());}
   if(!picked.isEmpty() && target==null)emitExchangeNotice("받는 기기를 다시 선택해 주세요.");
   if(!picked.isEmpty() && target!=null)try{workers.execute(()->{try{exchange().send(picked,target,true);}catch(ExchangeService.UserError e){emitExchangeNotice(e.getMessage());}catch(Exception e){emitExchangeNotice("파일을 보낼 준비를 하지 못했습니다.");}});}catch(RejectedExecutionException e){emitExchangeNotice("잠시 후 다시 시도해 주세요.");}
   return;
  }
  if(vault!=null && vault.picked(request,result,data)){try{workers.execute(()->{try{emit("lakomics-vault",vault.inspect());}catch(Exception ignored){}});}catch(RejectedExecutionException ignored){}return;}
  super.onActivityResult(request,result,data);
 }
 @Override public void onBackPressed(){emit("lakomics-back",null);}
 private void hideStatusBar(){
  if(Build.VERSION.SDK_INT>=30){
   WindowInsetsController controller=getWindow().getInsetsController();
   if(controller!=null){controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);controller.hide(WindowInsets.Type.statusBars());}
  }else getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
 }
 @Override public void onWindowFocusChanged(boolean focused){super.onWindowFocusChanged(focused);if(focused){hideStatusBar();clipboardHandler.post(clearSecretClip);}}
 @Override protected void onResume(){super.onResume();if(vault!=null)vault.resumed();synchronized(this){stopped=false;}foreground=true;hideStatusBar();if(web!=null){web.resumeTimers();web.onResume();emit("lakomics-resume",null);if(Build.VERSION.SDK_INT>=33)PickerLibrary.get(this).resume();}
  // Foreground-only Album replication: this resumes polling and reconciles now, and
  // onPause stops it. Nothing here keeps the device awake or runs in the background.
  AlbumReplicaService.get(this).setListGenerationListener(generation->{try{emit("lakomics-list-generation",new JSONObject().put("generation",generation));}catch(JSONException ignored){}});
  // File exchange works only while an activity is resumed; its arrival signal comes from the pass started next.
  ExchangeService.get(this).setForeground(true);
  AlbumReplicaService.get(this).start();}
 @Override protected void onPause(){foreground=false;emit("lakomics-pause",null);if(web!=null){web.onPause();web.pauseTimers();}PickerLibrary.get(this).pause();AlbumReplicaService.get(this).stop();ExchangeService.get(this).setForeground(false);super.onPause();}
 @Override protected void onStop(){if(vault!=null)vault.stopped();
  // Secret notes lock when the app goes to the background; the WebView drops their content.
  if(notes!=null){notes.lockSecrets();emit("lakomics-notes-locked",null);}stopNonEssential();super.onStop();}
 @Override protected void onDestroy(){destroyed=true;if(vault!=null)vault.destroy();AlbumReplicaService.get(this).setListGenerationListener(null);ExchangeService.get(this).removeListener(exchangeListener);stopRequests();workers.shutdownNow();mediaWorkers.shutdownNow();if(web!=null){web.removeJavascriptInterface("LakomicsNative");web.stopLoading();web.destroy();web=null;}super.onDestroy();}
}
