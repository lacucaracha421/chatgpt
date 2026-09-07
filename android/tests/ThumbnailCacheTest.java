package com.lakomics.mobile;
import java.io.*;
import java.nio.file.*;
import java.util.concurrent.atomic.AtomicInteger;
public final class ThumbnailCacheTest {
 private static int checks;
 private static void check(boolean result){checks++;if(!result)throw new AssertionError("check "+checks);}
 private static void put(ThumbnailCache cache,String key,int bytes)throws Exception{cache.obtain(key,cache.generation(),file->Files.write(file.toPath(),new byte[bytes]));}
 public static void main(String[] args)throws Exception{
  File dir=Files.createTempDirectory("lakomics-thumbnails-").toFile();
  try{
   ThumbnailCache cache=new ThumbnailCache(dir,10);
   String a=ThumbnailCache.key("account1/asset"), b=ThumbnailCache.key("account2/asset"), c=ThumbnailCache.key("third");
   check(!a.equals(b));put(cache,a,6);
   AtomicInteger downloads=new AtomicInteger();cache.obtain(a,cache.generation(),f->downloads.incrementAndGet());check(downloads.get()==0);
   check(cache.status()[0]==6);
   ThumbnailCache reopened=new ThumbnailCache(dir,10);reopened.obtain(a,reopened.generation(),f->downloads.incrementAndGet());check(downloads.get()==0);
   new File(dir,a).setLastModified(System.currentTimeMillis()-10000);put(cache,b,6);
   check(!new File(dir,a).exists() && new File(dir,b).isFile());check(cache.status()[0]<=10);
   new File(dir,b).setLastModified(System.currentTimeMillis()-8L*24*60*60*1000);check(cache.status()[0]==0);
   long old=cache.generation();
   try{cache.obtain(c,old,file->{Files.write(file.toPath(),new byte[4]);cache.clear();});throw new AssertionError("stale commit");}catch(IOException expected){check(cache.status()[0]==0);}
   try{cache.open(c,old);throw new AssertionError("stale read");}catch(IOException expected){check(true);}
   try{cache.open("../outside",cache.generation());throw new AssertionError("path escape");}catch(IOException expected){check(true);}
   try{put(cache,a,11);throw new AssertionError("oversize");}catch(IOException expected){check(cache.status()[0]==0);}
   try{cache.obtain(a,cache.generation(),file->{Files.write(file.toPath(),new byte[4]);throw new IOException("interrupted");});}catch(IOException expected){check(dir.listFiles().length==0);}
   put(cache,a,5);try(InputStream in=cache.open(a,cache.generation())){check(in.read()==0);}cache.clear();check(cache.status()[0]==0 && cache.status()[1]==0);
   // In-flight reservations share the same cap as completed files.
   cache.obtain(a,cache.generation(),6,file->{
    Files.write(file.toPath(),new byte[4]);
    try{cache.obtain(b,cache.generation(),6,other->Files.write(other.toPath(),new byte[6]));throw new AssertionError("overlapping reservations");}catch(IOException expected){check(true);}
   });
   check(cache.status()[0]==4);
   cache.obtain(b,cache.generation(),6,file->Files.write(file.toPath(),new byte[6]));check(cache.status()[0]==10);
   cache.clear();cache.obtain(c,cache.generation(),10,file->Files.write(file.toPath(),new byte[10]));check(cache.file(c,cache.generation()).length()==10);
   System.out.println("ThumbnailCache: "+checks+" checks passed");
  }finally{for(File file:dir.listFiles())Files.deleteIfExists(file.toPath());Files.deleteIfExists(dir.toPath());}
 }
}
