package com.lakomics.mobile;

import java.io.*;
import java.net.*;
import java.util.Arrays;

/** Host-side binary response checks; Android bridge/device integration is separate. */
public final class CloudClientTest {
 static int checks;
 interface Attempt {void run()throws Exception;}
 static void reject(Attempt work)throws Exception{try{work.run();}catch(IOException expected){checks++;return;}throw new AssertionError("Invalid image accepted");}
 static final class Response extends HttpURLConnection {
  int status=200;String mime="image/jpeg",encoding,length;byte[] bytes={1,2,3};boolean closed;
  Response()throws Exception{super(new URL("https://test.example/v1/providers/image"));}
  public int getResponseCode(){return status;}
  public String getContentType(){return mime;}
  public String getHeaderField(String key){return key.equals("Content-Length")?length:key.equals("Content-Encoding")?encoding:null;}
  public InputStream getInputStream(){return new ByteArrayInputStream(bytes){public void close()throws IOException{closed=true;super.close();}};}
  public void connect(){} public void disconnect(){} public boolean usingProxy(){return false;}
 }
 public static void main(String[] args)throws Exception{
  for(String mime:new String[]{"image/jpeg","image/png","image/webp","IMAGE/PNG; charset=binary"}){
   Response c=new Response();c.mime=mime;c.length="3";
   if(!Arrays.equals(CloudClient.providerImageBytes(c,null),c.bytes)||!c.closed)throw new AssertionError("Image bytes changed or stream leaked");checks++;
  }
  for(String mime:new String[]{"text/html","application/json","image/svg+xml","",null}){Response c=new Response();c.mime=mime;reject(()->CloudClient.providerImageBytes(c,null));}
  for(int status:new int[]{302,401,404,500}){Response c=new Response();c.status=status;reject(()->CloudClient.providerImageBytes(c,null));}
  for(String length:new String[]{"0","2","4","4194305","bad"}){Response c=new Response();c.length=length;reject(()->CloudClient.providerImageBytes(c,null));}
  Response empty=new Response();empty.bytes=new byte[0];reject(()->CloudClient.providerImageBytes(empty,null));
  Response big=new Response();big.bytes=new byte[4*1024*1024+1];reject(()->CloudClient.providerImageBytes(big,null));
  Response jacket=new Response();jacket.bytes=new byte[4*1024*1024+1];jacket.length=String.valueOf(jacket.bytes.length);CloudClient.providerImageBytes(jacket,null,8L*1024*1024);checks++;
  Response oversizedJacket=new Response();oversizedJacket.bytes=new byte[8*1024*1024+1];reject(()->CloudClient.providerImageBytes(oversizedJacket,null,8L*1024*1024));
  Response encoded=new Response();encoded.encoding="gzip";reject(()->CloudClient.providerImageBytes(encoded,null));
  Response unknownLength=new Response();CloudClient.providerImageBytes(unknownLength,null);checks++;
  System.out.println("CloudClient: "+checks+" checks passed");
 }
}
