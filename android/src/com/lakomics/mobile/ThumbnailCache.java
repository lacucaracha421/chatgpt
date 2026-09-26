package com.lakomics.mobile;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Private, disposable media bytes. Network work runs outside the disk lock. */
final class ThumbnailCache {
 static final long LIMIT=1024L*1024*1024, MAX_FILE=16L*1024*1024;
 /** The one native cache lifetime. WebView must never let a copy outlive it. */
 // Thumbnails are warmed library-wide, so age only drops media unseen for a year;
 // the 1 GiB least-recently-used bound still applies.
 static final long MAX_AGE_SECONDS=365L*24*60*60;
 private static final long MAX_AGE=MAX_AGE_SECONDS*1000;
 interface Download {void write(File file)throws Exception;}
 private final File directory;
 private final long limit;
 private long generation;
 private long reserved;
 // Totals of cached entries. One directory scan builds them; writes and removals keep
 // them current, and an hourly rescan applies the age limit. Scanning ~10k files on
 // every write made each download wait over a second behind the cache lock.
 private long bytes=-1,count;
 private long sweptAt;
 private static final long SWEEP_EVERY=60L*60*1000;
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
 /** An opaque server media revision (e.g. `thumbnail_revision`); empty when the server sends none. */
 static boolean validRevision(String revision){return revision!=null && (revision.isEmpty() || revision.matches("[A-Za-z0-9._-]{1,128}"));}
 /**
  * The cache key of one Asset's media on one account (`endpoint\ntoken`).
  *
  * A thumbnail with a revision is its own entry, so a regenerated thumbnail is fetched
  * again and served under a new URL instead of the retained old one. Without a revision
  * (a server that sends none, DocumentsUI, Photo Picker) the key is the pre-revision key,
  * so existing entries stay valid.
  */
 static String mediaKey(String account,String id,String variant,String revision)throws Exception{
  if(!validRevision(revision))throw new IllegalArgumentException("Invalid media revision");
  String value=variant.equals("thumbnail")?(revision.isEmpty()?id:id+"\nthumbnail\n"+revision):id+"\n"+variant;
  return key(account+"\n"+value);
 }
 /** The WebView URL path of one cached object: a new key or generation is a new URL. */
 static String localPath(long generation,String key){return "https://app.lakomics.local/media-cache/"+generation+"/"+key;}
 synchronized long generation(){return generation;}
 // A marker in the disposable directory survives process restarts, but not cache
 // clearing (including Android removing the directory). Never persist credentials.
 synchronized String warmGeneration()throws IOException{
  File marker=new File(directory,".warm-generation");
  if(marker.isFile())try(DataInputStream input=new DataInputStream(new FileInputStream(marker))){
   String value=input.readUTF();
   if(value.matches("[a-f0-9-]{36}"))return value;
  }catch(EOFException ignored){}
  if(!directory.isDirectory() && !directory.mkdirs())throw new IOException("Cache unavailable");
  String value=UUID.randomUUID().toString();
  try(DataOutputStream output=new DataOutputStream(new FileOutputStream(marker))){output.writeUTF(value);}
  bytes=-1; // Android may have removed bytes without going through clear().
  return value;
 }
 /** One bounded, read-only probe; it does not download or refresh LRU timestamps. */
 synchronized boolean[] cached(List<String> keys,long expected)throws IOException{
  check(expected);
  if(keys.size()>100)throw new IllegalArgumentException("Too many thumbnails");
  boolean[] result=new boolean[keys.size()];long now=System.currentTimeMillis();
  for(int i=0;i<keys.size();i++){
   File file=entry(keys.get(i));
   result[i]=file.isFile() && now-file.lastModified()<=MAX_AGE;
  }
  return result;
 }
 private File[] files(){File[] files=directory.listFiles();return files==null?new File[0]:files;}
 private File entry(String key)throws IOException{if(!key.matches("[a-f0-9]{64}"))throw new IOException("Invalid cache key");return new File(directory,key);}
 private void check(long expected)throws IOException{if(expected!=generation)throw new IOException("Cache invalidated");}
 // Settings asks rarely, so it gets an exact rescan (including the age limit).
 synchronized long[] status(){index(true);return new long[]{bytes,count,limit};}
 private void index(boolean force){
  long now=System.currentTimeMillis();
  if(!force && bytes>=0 && now-sweptAt<SWEEP_EVERY)return;
  long total=0,entries=0;
  for(File file:files())if(file.getName().matches("[a-f0-9]{64}")){
   if(now-file.lastModified()>MAX_AGE && file.delete())continue;
   total+=file.length();entries++;
  }
  bytes=total;count=entries;sweptAt=now;
 }
 synchronized void clear()throws IOException{
  generation++;
  // Invalidate progress before deleting bytes, even if a later deletion fails.
  File marker=new File(directory,".warm-generation");
  if(marker.exists() && !marker.delete())throw new IOException("Cache clear incomplete");
  boolean failed=false;
  for(File file:files())if(file.isFile() && !file.delete())failed=true;
  bytes=-1;index(true);
  if(failed)throw new IOException("Cache clear incomplete");
 }
 private void trim(long incoming){
  index(false);
  if(bytes+incoming<=limit)return;
  // Least recently used first; read each timestamp once instead of inside the comparator.
  File[] files=files();long[] used=new long[files.length];Integer[] order=new Integer[files.length];
  for(int i=0;i<files.length;i++){used[i]=files[i].lastModified();order[i]=i;}
  Arrays.sort(order,Comparator.comparingLong(i->used[i]));
  for(int i:order){
   if(bytes+incoming<=limit)break;
   File file=files[i];if(!file.getName().matches("[a-f0-9]{64}"))continue;
   long length=file.length();if(file.delete()){bytes-=length;count--;}
  }
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
   if(bytes+reserved+maximum>limit)throw new IOException("Cache capacity busy");
   temporary=File.createTempFile("incoming-",".part",directory);reserved+=maximum;
  }
  try{
   download.write(temporary);
   synchronized(this){
    check(expected);
    long size=temporary.length();if(size<=0 || size>maximum || size>limit)throw new IOException("Media exceeds cache limit");
    File cached=entry(key);
    if(cached.isFile()){long previous=cached.length();if(!cached.delete())throw new IOException("Cache replace failed");bytes-=previous;count--;}
    trim(size);
    if(bytes+size>limit)throw new IOException("Cache capacity unavailable");
    if(!temporary.renameTo(cached))throw new IOException("Cache write failed");
    bytes+=size;count++;
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
 synchronized void remove(String key,long expected)throws IOException{check(expected);index(false);File file=entry(key);if(file.exists()){long length=file.length();if(!file.delete())throw new IOException("Cache remove failed");bytes-=length;count--;}}
}
