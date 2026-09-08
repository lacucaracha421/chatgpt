package com.lakomics.mobile;
import android.os.CancellationSignal;
import org.json.*;
import java.net.*;
import java.io.*;
final class CloudClient {
 final SecureSettings settings;
 CloudClient(SecureSettings s){settings=s;}
 JSONObject api(String path,String method,JSONObject body,CancellationSignal cancel) throws Exception {
  return authenticated(settings.read(),path,method,body,cancel);
 }
 void validate(String endpoint,String token,CancellationSignal cancel)throws Exception{
  SecureSettings.validateToken(token);
  authenticated(new JSONObject().put("endpoint",endpoint).put("token",token),"/v1/library/classifications","GET",null,cancel).getJSONArray("items");
 }
 static final class HttpFailure extends IOException {final int status;HttpFailure(int s){super("HTTP failure");status=s;}}
 private JSONObject authenticated(JSONObject s,String path,String method,JSONObject body,CancellationSignal cancel)throws Exception{
  NetworkPolicy.api(path,method);if(!s.has("token"))throw new IllegalStateException("Not configured");
  HttpURLConnection c=(HttpURLConnection)new URL(s.getString("endpoint")+path).openConnection();boolean reusable=false;
  try {
   prepare(c,cancel);c.setRequestMethod(method);c.setRequestProperty("Authorization","Bearer "+s.getString("token"));c.setRequestProperty("Accept","application/json");
   if(method.equals("POST")){byte[] b=(body==null?"{}":body.toString()).getBytes("UTF-8");if(b.length>65536)throw new IOException("Request too large");c.setDoOutput(true);c.setFixedLengthStreamingMode(b.length);c.setRequestProperty("Content-Type","application/json");try(OutputStream o=c.getOutputStream()){o.write(b);}}
   int code=c.getResponseCode();if(code<200 || code>=300)throw new HttpFailure(code);
   ByteArrayOutputStream out=new ByteArrayOutputStream();try(InputStream in=c.getInputStream()){copy(in,out,4*1024*1024,cancel);}JSONObject result=new JSONObject(out.toString("UTF-8"));stripKeys(result);reusable=true;return result;
  } finally {if(cancel!=null)cancel.setOnCancelListener(null);if(!reusable)c.disconnect();}
 }
 static void stripKeys(Object value) throws JSONException {if(value instanceof JSONObject){JSONObject o=(JSONObject)value;o.remove("object_key");java.util.Iterator<String> keys=o.keys();while(keys.hasNext())stripKeys(o.get(keys.next()));}else if(value instanceof JSONArray){JSONArray a=(JSONArray)value;for(int i=0;i<a.length();i++)stripKeys(a.get(i));}}
 static void prepare(HttpURLConnection c,CancellationSignal signal){c.setConnectTimeout(12000);c.setReadTimeout(20000);c.setInstanceFollowRedirects(false);if(signal!=null){signal.throwIfCanceled();signal.setOnCancelListener(c::disconnect);}}
 static void copy(InputStream in,OutputStream out,long max,CancellationSignal signal)throws IOException {byte[] b=new byte[32768];long deadline=System.currentTimeMillis()+90000;long count=0;int n;while((n=in.read(b))!=-1){if(signal!=null)signal.throwIfCanceled();if(System.currentTimeMillis()>deadline)throw new SocketTimeoutException("Transfer deadline exceeded");count+=n;if(count>max)throw new IOException("Media exceeds cache limit");out.write(b,0,n);}}
 void download(String url,File file,long max,CancellationSignal signal)throws Exception {
  URI u=new URI(url);if(!"https".equals(u.getScheme()) || u.getHost()==null || u.getUserInfo()!=null)throw new IOException("Invalid media URL");
  long deadline=System.nanoTime()+MediaTransfer.DEADLINE_NANOS;
  HttpURLConnection c=(HttpURLConnection)u.toURL().openConnection();try{
   prepare(c,signal);c.setRequestProperty("Accept-Encoding","identity");
   int status=c.getResponseCode();if(status!=200)throw new HttpFailure(status);
   String encoding=c.getHeaderField("Content-Encoding");if(encoding!=null&&!encoding.equalsIgnoreCase("identity"))throw new IOException("Unsupported media encoding");
   long expected=MediaTransfer.expectedLength(c.getHeaderField("Content-Length"),max);
   try(InputStream in=c.getInputStream();OutputStream out=new FileOutputStream(file)){MediaTransfer.copy(in,out,max,expected,deadline,signal==null?null:signal::throwIfCanceled);}
  }finally{if(signal!=null)signal.setOnCancelListener(null);c.disconnect();}
 }
}
