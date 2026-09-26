package com.lakomics.mobile;
import android.os.CancellationSignal;
import org.json.*;
import java.net.*;
import java.io.*;
final class CloudClient {
 final SecureSettings settings;
 private final ConditionalRead conditional=new ConditionalRead();
 void clearConditional(){conditional.clear();}
 JSONObject conditionalApi(String path,CancellationSignal cancel)throws Exception{return conditionalApiFor(settings.read(),path,cancel);}
 JSONObject conditionalApiFor(JSONObject connection,String path,CancellationSignal cancel)throws Exception{
  String scope=ThumbnailCache.key(connection.getString("endpoint")+"\n"+connection.getString("token"));
  return new JSONObject(conditional.get(scope,path,etag->authenticatedReply(connection,path,"GET",null,cancel,etag)));
 }
 CloudClient(SecureSettings s){settings=s;}
 JSONObject api(String path,String method,JSONObject body,CancellationSignal cancel) throws Exception {
  return authenticated(settings.read(),path,method,body,cancel);
 }
 JSONObject apiFor(JSONObject connection,String path,String method,JSONObject body,CancellationSignal cancel)throws Exception{return authenticated(connection,path,method,body,cancel);}
 void validate(String endpoint,String token,CancellationSignal cancel)throws Exception{
  SecureSettings.validateToken(token);
  authenticated(new JSONObject().put("endpoint",endpoint).put("token",token),"/v1/library/classifications","GET",null,cancel).getJSONArray("items");
 }
 static final class HttpFailure extends IOException {final int status;final String detail;HttpFailure(int s,String d){super("HTTP failure");status=s;detail=d;}
  JSONObject detailObject(){if(detail==null||detail.isEmpty())return null;try{return new JSONObject(detail);}catch(JSONException ignored){return null;}}}
 private JSONObject authenticated(JSONObject s,String path,String method,JSONObject body,CancellationSignal cancel)throws Exception{
  ConditionalRead.Reply reply=authenticatedReply(s,path,method,body,cancel,null);
  if(reply.status==304)throw new IOException("Unexpected unconditional 304");
  return new JSONObject(reply.body);
 }
 private ConditionalRead.Reply authenticatedReply(JSONObject s,String path,String method,JSONObject body,CancellationSignal cancel,String etag)throws Exception{return authenticatedReply(s,path,method,body,cancel,etag,null);}
 /** A file exchange call: the device header names which registered device is acting. */
 ConditionalRead.Reply exchange(JSONObject s,String device,String path,String method,JSONObject body,CancellationSignal cancel,String etag)throws Exception{
  if(!ExchangeTransfer.uuid(device))throw new IllegalStateException("No exchange device");
  return authenticatedReply(s,path,method,body,cancel,etag,device);
 }
 private ConditionalRead.Reply authenticatedReply(JSONObject s,String path,String method,JSONObject body,CancellationSignal cancel,String etag,String device)throws Exception{
  NetworkPolicy.api(path,method);if(!s.has("token"))throw new IllegalStateException("Not configured");
  HttpURLConnection c=(HttpURLConnection)new URL(s.getString("endpoint")+path).openConnection();boolean reusable=false;
  try {
   prepare(c,cancel);c.setRequestMethod(method);c.setRequestProperty("Authorization","Bearer "+s.getString("token"));c.setRequestProperty("Accept","application/json");
   if(etag!=null)c.setRequestProperty("If-None-Match",etag);
   if(device!=null)c.setRequestProperty("X-Lakomics-Device",device);
   if(method.equals("POST") || method.equals("PUT")){byte[] b=(body==null?"{}":body.toString()).getBytes("UTF-8");if(b.length>(path.startsWith("/v1/notes/")?610000:65536))throw new IOException("Request too large");c.setDoOutput(true);c.setFixedLengthStreamingMode(b.length);c.setRequestProperty("Content-Type","application/json");try(OutputStream o=c.getOutputStream()){o.write(b);}}
   int code=c.getResponseCode();
   ConditionalRead.Reply reply=ConditionalRead.response(code,c.getHeaderField("ETag"),()->{
    ByteArrayOutputStream out=new ByteArrayOutputStream();
    try(InputStream in=c.getInputStream()){copy(in,out,4*1024*1024,cancel);}
    JSONObject result=new JSONObject(out.toString("UTF-8"));stripKeys(result);return result.toString();
   },status->new HttpFailure(status,errorBody(c)));
   reusable=true;return reply;
  } finally {if(cancel!=null)cancel.setOnCancelListener(null);if(!reusable)c.disconnect();}
 }
 /**
  * One `/v1/sync/status?wait=N&signals=1` long-poll (StatusWatcher). Its ETag is the caller's
  * own, never the conditional cache's; the read timeout covers the server's hold plus 20 s.
  */
 StatusWatcher.Reply longPollStatus(JSONObject s,String etag,int wait,CancellationSignal cancel)throws Exception{
  String path="/v1/sync/status?wait="+wait+"&signals=1";
  NetworkPolicy.api(path,"GET");if(!s.has("token"))throw new IllegalStateException("Not configured");
  HttpURLConnection c=(HttpURLConnection)new URL(s.getString("endpoint")+path).openConnection();boolean reusable=false;
  try {
   prepare(c,cancel);c.setReadTimeout((wait+20)*1000);c.setRequestProperty("Authorization","Bearer "+s.getString("token"));c.setRequestProperty("Accept","application/json");
   if(etag!=null)c.setRequestProperty("If-None-Match",etag);
   int code=c.getResponseCode();boolean capable=c.getHeaderField(StatusWatcher.WAIT_HEADER)!=null;
   ConditionalRead.Reply reply=ConditionalRead.response(code,c.getHeaderField("ETag"),()->{
    ByteArrayOutputStream out=new ByteArrayOutputStream();
    try(InputStream in=c.getInputStream()){copy(in,out,4*1024*1024,cancel);}
    return new JSONObject(out.toString("UTF-8")).toString();
   },status->new HttpFailure(status,errorBody(c)));
   reusable=true;return new StatusWatcher.Reply(reply.status,reply.etag,capable,reply.body);
  } finally {if(cancel!=null)cancel.setOnCancelListener(null);if(!reusable)c.disconnect();}
 }
 static String errorBody(HttpURLConnection c){
  // A rejected response body is bounded and read before disconnect, so the
  // client can still tell a revision conflict from an identity mismatch.
  InputStream stream=c.getErrorStream();if(stream==null)return null;
  try{ByteArrayOutputStream out=new ByteArrayOutputStream();copy(stream,out,65536,null);return out.toString("UTF-8");}
  catch(Exception ignored){return null;}
  finally{try{stream.close();}catch(Exception ignored){}}
 }
 static void stripKeys(Object value) throws JSONException {if(value instanceof JSONObject){JSONObject o=(JSONObject)value;o.remove("object_key");java.util.Iterator<String> keys=o.keys();while(keys.hasNext())stripKeys(o.get(keys.next()));}else if(value instanceof JSONArray){JSONArray a=(JSONArray)value;for(int i=0;i<a.length();i++)stripKeys(a.get(i));}}
 /**
  * The library list generation, or null when this server predates the endpoint.
  *
  * Generation checks guard refreshes against a mutation that lands mid-traversal, but
  * they are an optimization over the canonical read. A deployed server without the
  * route answers 404, and failing the whole refresh there would strand the picker on a
  * stale snapshot even though the library itself is fully readable.
  */
 static String listGeneration(CloudClient client,String token,CancellationSignal signal)throws Exception {
  try{return client.api("/v1/library/list-generation","GET",null,signal).getString("generation");}
  catch(HttpFailure unavailable){if(unavailable.status==404)return null;throw unavailable;}
 }
 static void prepare(HttpURLConnection c,CancellationSignal signal){c.setConnectTimeout(12000);c.setReadTimeout(20000);c.setInstanceFollowRedirects(false);if(signal!=null){signal.throwIfCanceled();signal.setOnCancelListener(c::disconnect);}}
 static void copy(InputStream in,OutputStream out,long max,CancellationSignal signal)throws IOException {byte[] b=new byte[32768];long deadline=System.currentTimeMillis()+90000;long count=0;int n;while((n=in.read(b))!=-1){if(signal!=null)signal.throwIfCanceled();if(System.currentTimeMillis()>deadline)throw new SocketTimeoutException("Transfer deadline exceeded");count+=n;if(count>max)throw new IOException("Media exceeds cache limit");out.write(b,0,n);}}
 void download(String url,File file,long max,CancellationSignal signal)throws Exception {
  PerfLog.Op perf=PerfLog.current.get();long downloadStarted=System.nanoTime();
  try{URI u=new URI(url);if(!"https".equals(u.getScheme()) || u.getHost()==null || u.getUserInfo()!=null)throw new IOException("Invalid media URL");
  long deadline=System.nanoTime()+MediaTransfer.DEADLINE_NANOS;
  HttpURLConnection c=(HttpURLConnection)u.toURL().openConnection();boolean reusable=false;try{
   prepare(c,signal);c.setRequestProperty("Accept-Encoding","identity");
   int status=c.getResponseCode();if(status!=200)throw new HttpFailure(status,null);
   String encoding=c.getHeaderField("Content-Encoding");if(encoding!=null&&!encoding.equalsIgnoreCase("identity"))throw new IOException("Unsupported media encoding");
   long expected=MediaTransfer.expectedLength(c.getHeaderField("Content-Length"),max);
   try(InputStream in=c.getInputStream();OutputStream out=new FileOutputStream(file)){try{MediaTransfer.copy(in,out,max,expected,deadline,signal==null?null:signal::throwIfCanceled);}finally{if(perf!=null)perf.bytes+=file.length();}}
   // A fully read and closed body lets the platform pool keep the TLS connection for the
   // next storage download; only failed or cancelled transfers tear the socket down.
   reusable=true;
  }finally{if(signal!=null)signal.setOnCancelListener(null);if(!reusable)c.disconnect();}
  }finally{if(perf!=null)perf.download+=System.nanoTime()-downloadStarted;}
 }
}
