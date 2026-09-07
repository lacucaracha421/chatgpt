package com.lakomics.mobile;
public final class TemporaryImagePolicyTest {
 interface Attempt {void run()throws Exception;}
 static int checks=0;
 static void reject(Attempt a)throws Exception {try{a.run();}catch(Exception e){checks++;return;}throw new AssertionError("Unsafe source accepted");}
 public static void main(String[] args)throws Exception {
  if(!TemporaryImagePolicy.url("https://example.com/image.png?a=1&b=2").getHost().equals("example.com"))throw new AssertionError();checks++;
  for(String value:new String[]{"http://example.com/a.png","file:///a.png","content://photo/a","https://user:pass@example.com/a","https://example.com/a#fragment","https://example.com:1234/a","https://example.com\\evil"})reject(()->TemporaryImagePolicy.url(value));
  for(String host:new String[]{"127.0.0.1","10.0.0.1","192.168.1.2","169.254.169.254","100.64.0.1","[::1]","[fd00::1]"})reject(()->TemporaryImagePolicy.publicHost(TemporaryImagePolicy.url("https://"+host+"/a.png")));
  for(String mime:new String[]{"image/jpeg","image/png","image/gif","image/webp","image/avif","image/heic"}){if(!TemporaryImagePolicy.extension(mime).startsWith("."))throw new AssertionError();checks++;}
  reject(()->TemporaryImagePolicy.extension("text/html"));reject(()->TemporaryImagePolicy.extension("image/svg+xml"));
  System.out.println("TemporaryImagePolicy: "+checks+" checks passed");
 }
}
