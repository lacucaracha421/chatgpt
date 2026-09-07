package com.lakomics.mobile;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Private, disposable media bytes. Network work runs outside the disk lock. */
final class ThumbnailCache {
 static final long LIMIT=1024L*1024*1024, MAX_FILE=16L*1024*1024;
 private static final long MAX_AGE=7L*24*60*60*1000;
 interface Download {void write(File file)throws Exception;}
 private final File directory;
 private final long limit;
 private long generation;
 private long reserved;
 ThumbnailCache(File directory)throws IOException{this(directory,LIMIT);}
 ThumbnailCache(File directory,long limit)throws IOException{
  this.directory=directory;this.limit=limit;
  if(!directory.isDirectory() && !directory.mkdirs())throw new IOException("Cache unavailable");
  for(File file:files())if(file.getName().endsWith(".part"))file.delete();
  trim(0);
 }
 static String key(String identity)throws Exception{
  byte[] digest=MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8));
  StringBuilder result=new StringBuilder();for(byte b:digest)result.append(String.format(Locale.ROOT,"%02x",b&255));return result.toString();
 }
 synchronized long generation(){return generation;}
 private File[] files(){File[] files=directory.listFiles();return files==null?new File[0]:files;}
 private File entry(String key)throws IOException{if(!key.matches("[a-f0-9]{64}"))throw new IOException("Invalid cache key");return new File(directory,key);}
 private void check(long expected)throws IOException{if(expected!=generation)throw new IOException("Cache invalidated");}
 synchronized long[] status(){trim(0);long bytes=0,count=0;for(File file:files())if(file.getName().matches("[a-f0-9]{64}")){bytes+=file.length();count++;}return new long[]{bytes,count,limit};}
 synchronized void clear()throws IOException{
  generation++;
  boolean failed=false;
  for(File file:files())if(file.isFile() && !file.delete())failed=true;
  if(failed)throw new IOException("Cache clear incomplete");
 }
 private void trim(long incoming){
  File[] files=files();Arrays.sort(files,Comparator.comparingLong(File::lastModified));
  long total=0,now=System.currentTimeMillis();
  for(File file:files)if(file.getName().matches("[a-f0-9]{64}")){
   if(now-file.lastModified()>MAX_AGE)file.delete();
   if(file.exists())total+=file.length();
  }
  for(File file:files)if(total+incoming>limit && file.exists() && file.getName().matches("[a-f0-9]{64}")){long length=file.length();if(file.delete())total-=length;}
 }
 void obtain(String key,long expected,Download download)throws Exception{
  obtain(key,expected,Math.min(MAX_FILE,limit),download);
 }
 void obtain(String key,long expected,long maximum,Download download)throws Exception{
  File temporary;
  synchronized(this){
   check(expected);File cached=entry(key);
   if(cached.isFile() && System.currentTimeMillis()-cached.lastModified()<=MAX_AGE){cached.setLastModified(System.currentTimeMillis());return;}
   if(maximum<=0 || maximum>limit)throw new IOException("Media exceeds cache limit");
   trim(reserved+maximum);
   if(status()[0]+reserved+maximum>limit)throw new IOException("Cache capacity busy");
   temporary=File.createTempFile("incoming-",".part",directory);reserved+=maximum;
  }
  try{
   download.write(temporary);
   synchronized(this){
    check(expected);
    long size=temporary.length();if(size<=0 || size>maximum || size>limit)throw new IOException("Media exceeds cache limit");
    File cached=entry(key);
    if(cached.isFile() && !cached.delete())throw new IOException("Cache replace failed");
    trim(size);
    if(status()[0]+size>limit)throw new IOException("Cache capacity unavailable");
    if(!temporary.renameTo(cached))throw new IOException("Cache write failed");
   }
  }finally{synchronized(this){temporary.delete();reserved-=maximum;}}
 }
 synchronized File file(String key,long expected)throws IOException{
  check(expected);File file=entry(key);
  if(!file.isFile() || System.currentTimeMillis()-file.lastModified()>MAX_AGE)throw new FileNotFoundException();
  file.setLastModified(System.currentTimeMillis());return file;
 }
 synchronized InputStream open(String key,long expected)throws IOException{
  check(expected);File file=entry(key);
  if(System.currentTimeMillis()-file.lastModified()>MAX_AGE)throw new FileNotFoundException();
  InputStream stream=new FileInputStream(file);file.setLastModified(System.currentTimeMillis());return stream;
 }
}
