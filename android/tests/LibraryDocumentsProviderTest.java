package com.lakomics.mobile;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import javax.tools.ToolProvider;
import java.net.URLClassLoader;

/** Executes the provider's actual grant method with platform-free boundary fixtures. */
public final class LibraryDocumentsProviderTest {
 public static void main(String[] args)throws Exception{
  Path source=Paths.get("android/src/com/lakomics/mobile/LibraryDocumentsProvider.java");
  String provider=Files.readString(source);
  String method=provider.substring(provider.indexOf(" @Override public boolean isChildDocument("),provider.indexOf(" @Override public ParcelFileDescriptor openDocument("))
   .replace("@Override ","");
  String fixture="package com.lakomics.mobile; import java.util.*; import java.nio.charset.StandardCharsets; public class ProviderGrantFixture {"
   +"static final Object CONNECTION_LOCK=new Object(); boolean configured(){return true;} boolean albumsAdopted(){return true;} boolean liveAlbum(String id){return id.equals(\"album:live\");} "
   +"static class Uri {static String encode(String s){return s;}} static class Base64 {static final int URL_SAFE=1,NO_WRAP=2; static byte[] decode(String s,int flags){return java.util.Base64.getUrlDecoder().decode(s);}} "
   +"static class JSONObject {JSONObject(){} JSONObject(String s){} boolean optBoolean(String k,boolean d){return member;} JSONArray getJSONArray(String k){return new JSONArray();} String getString(String k){return \"C\";} boolean isNull(String k){return true;} String optString(String k,String d){return d;}} "
   +"static class JSONArray {int length(){return 0;} JSONObject getJSONObject(int i){return new JSONObject();}} static boolean member=false,offline=false; JSONObject api(String p,String m,Object b,Object c)throws Exception{if(offline)throw new Exception(); return new JSONObject();} "
   +method+" public static void run(){ProviderGrantFixture p=new ProviderGrantFixture();"
   +"for(String child:new String[]{\"asset:unrelated\",\"class:C\",\"album:other\",\"all\",\"root\",\"album-page:later\"}) if(p.isChildDocument(\"album:live\",child))throw new AssertionError(\"Album grant escaped to \"+child);"
   +"if(!p.isChildDocument(\"albums\",\"album:live\") || p.isChildDocument(\"albums\",\"album:deleted\"))throw new AssertionError(\"Live album check\");"
   +"if(p.isChildDocument(\"album-page:later\",\"asset:any\"))throw new AssertionError(\"Continuation grant\");"
   +"if(p.isChildDocument(\"class:C\",\"asset:A\"))throw new AssertionError(\"Nonmember\"); member=true; if(!p.isChildDocument(\"class:C\",\"asset:A\"))throw new AssertionError(\"Member denied\"); offline=true; if(p.isChildDocument(\"class:C\",\"asset:A\"))throw new AssertionError(\"Offline granted\"); }}";
  Path output=Files.createTempDirectory("provider-grant-test-");
  Path java=output.resolve("ProviderGrantFixture.java");Files.writeString(java,fixture,StandardCharsets.UTF_8);
  int result=ToolProvider.getSystemJavaCompiler().run(null,null,null,"-d",output.toString(),source.resolveSibling("DocumentTreePolicy.java").toString(),java.toString());
  if(result!=0)throw new AssertionError("Fixture compilation failed");
  try(URLClassLoader loader=new URLClassLoader(new java.net.URL[]{output.toUri().toURL()},null)){
   try{loader.loadClass("com.lakomics.mobile.ProviderGrantFixture").getMethod("run").invoke(null);}
   catch(java.lang.reflect.InvocationTargetException e){throw new AssertionError(e.getCause());}
  }
  System.out.println("LibraryDocumentsProvider: grant regression checks passed");
 }
}
