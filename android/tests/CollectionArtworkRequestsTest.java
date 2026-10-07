package com.lakomics.mobile;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Real media-ticket POSTs for a legacy list with no artworkVersions. */
public final class CollectionArtworkRequestsTest {
 private static final String PATH="/v1/collections/b8845f02-459e-461f-a49d-c0b9a6ae78dd/artworks/e5448c5e-4b3a-4da8-947c-9eaa693fd2b1/media-ticket";
 private static final class Failure extends IOException {
  final int status;Failure(int status){this.status=status;}
 }
 private static void check(boolean value){if(!value)throw new AssertionError();}
 public static void main(String[] args)throws Exception{
  List<String> requests=new ArrayList<>();boolean[] originalAvailable={true};
  HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
  server.createContext("/v1/collections",exchange->{
   exchange.getResponseHeaders().add("ETag","\"r1\"");
   if(exchange.getRequestHeaders().containsKey("If-None-Match")){exchange.sendResponseHeaders(304,-1);exchange.close();return;}
   byte[] body="{\"revision\":\"r1\",\"items\":[{\"id\":\"b8845f02-459e-461f-a49d-c0b9a6ae78dd\",\"selectedWorkArtworkId\":\"e5448c5e-4b3a-4da8-947c-9eaa693fd2b1\"}]}".getBytes(StandardCharsets.UTF_8);
   exchange.sendResponseHeaders(200,body.length);exchange.getResponseBody().write(body);exchange.close();
  });
  server.createContext(PATH,exchange->{
   check(exchange.getRequestMethod().equals("POST"));
   String body=new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8);
   requests.add(body);
   boolean original=body.equals("{\"variant\":\"original\"}");
   byte[] reply=(original&&originalAvailable[0]?"{\"sha256\":\"4a865c75\",\"content_type\":\"image/jpeg\",\"size_bytes\":301751}":"{\"detail\":\"Artwork variant unavailable\"}").getBytes(StandardCharsets.UTF_8);
   exchange.sendResponseHeaders(original&&originalAvailable[0]?200:404,reply.length);
   exchange.getResponseBody().write(reply);exchange.close();
  });
  server.start();
  try{
   // Native conditional reads can reuse an old summary without artworkVersions on 304.
   ConditionalRead lists=new ConditionalRead();
   ConditionalRead.Fetch list=etag->{
    HttpURLConnection connection=(HttpURLConnection)new URL("http://127.0.0.1:"+server.getAddress().getPort()+"/v1/collections?type=game").openConnection();
    try{
     if(etag!=null)connection.setRequestProperty("If-None-Match",etag);
     int status=connection.getResponseCode();
     String body=null;if(status==200)try(java.io.InputStream input=connection.getInputStream()){body=new String(input.readAllBytes(),StandardCharsets.UTF_8);}
     return new ConditionalRead.Reply(status,connection.getHeaderField("ETag"),body);
    }finally{connection.disconnect();}
   };
   String summary=lists.get("account","/v1/collections?type=game",list);
   check(summary.equals(lists.get("account","/v1/collections?type=game",list)));
   check(summary.contains("e5448c5e")&&!summary.contains("artworkVersions"));
   CollectionArtworkRequests policy=new CollectionArtworkRequests();
   CollectionArtworkRequests.Fetch<String> fetch=variant->{
    HttpURLConnection connection=(HttpURLConnection)new URL("http://127.0.0.1:"+server.getAddress().getPort()+PATH).openConnection();
    try{
     connection.setRequestMethod("POST");connection.setDoOutput(true);
     connection.setRequestProperty("Content-Type","application/json");
     try(java.io.OutputStream output=connection.getOutputStream()){output.write(("{\"variant\":\""+variant+"\"}").getBytes(StandardCharsets.UTF_8));}
     int status=connection.getResponseCode();if(status!=200)throw new Failure(status);
     try(java.io.InputStream input=connection.getInputStream()){return new String(input.readAllBytes(),StandardCharsets.UTF_8);}
    }finally{connection.disconnect();}
   };
   CollectionArtworkRequests.Missing missing=error->error instanceof Failure&&((Failure)error).status==404;
   String key="account/generation/work/artwork/r1";
   check(policy.read(key,"thumbnail",fetch,missing).contains("4a865c75"));
   check(requests.equals(java.util.Arrays.asList("{\"variant\":\"thumbnail\"}","{\"variant\":\"original\"}")));
   check(policy.variant(key,"thumbnail").equals("original"));
   for(int i=0;i<10;i++)policy.read(key,"thumbnail",fetch,missing);
   check(requests.stream().filter(body->body.contains("thumbnail")).count()==1);
   originalAvailable[0]=false;
   try{policy.read(key,"original",fetch,missing);throw new AssertionError();}catch(Failure expected){check(expected.status==404);}
   int count=requests.size();
   for(int i=0;i<10;i++)try{policy.read(key,"thumbnail",fetch,missing);throw new AssertionError();}catch(Failure expected){check(expected.status==404);}
   check(requests.size()==count);
   originalAvailable[0]=true;
   check(policy.read(key+"/r2","thumbnail",fetch,missing).contains("4a865c75"));
   check(requests.size()==count+2);
   check(policy.read("other-account/"+key,"thumbnail",fetch,missing).contains("4a865c75"));
   check(requests.size()==count+4);
   int[] transientCalls={0};
   for(int i=0;i<2;i++)try{policy.read("transient","thumbnail",variant->{transientCalls[0]++;throw new Failure(503);},missing);throw new AssertionError();}catch(Failure expected){check(expected.status==503);}
   check(transientCalls[0]==2);
   // A probe must not wait for a ticket still in flight for this artwork.
   java.util.concurrent.CountDownLatch started=new java.util.concurrent.CountDownLatch(1),finish=new java.util.concurrent.CountDownLatch(1);
   Thread worker=new Thread(()->{try{policy.read("busy","thumbnail",variant->{started.countDown();finish.await();return "ok";},missing);}catch(Exception error){throw new RuntimeException(error);}});
   worker.start();started.await();check(policy.variant("busy","thumbnail").equals("thumbnail"));finish.countDown();worker.join();
   policy.clear();check(policy.variant(key,"thumbnail").equals("thumbnail"));
   System.out.println("CollectionArtworkRequestsTest passed (legacy list/304 reuse, real POST fallback, revision/account misses, transient errors, nonblocking probe)");
  }finally{server.stop(0);}
 }
}
