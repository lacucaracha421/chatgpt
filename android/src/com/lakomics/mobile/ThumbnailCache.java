package com.lakomics.mobile;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.ZoneId;
import java.util.*;
import java.util.function.LongSupplier;
import java.util.zip.CRC32;

/** Private, disposable media bytes. Network work runs outside the disk lock. */
final class ThumbnailCache {
 static final long LIMIT=3L*1024*1024*1024, MAX_FILE=16L*1024*1024;
 /** The one native cache lifetime. WebView must never let a copy outlive it. */
 // Thumbnails are warmed library-wide, so age only drops media unseen for a year;
 // the 3 GiB bound still applies, with half reserved for reusable shelf/thumbnail media.
 static final long MAX_AGE_SECONDS=365L*24*60*60;
 private static final long MAX_AGE=MAX_AGE_SECONDS*1000;
 interface Download {void write(File file)throws Exception;}
 enum Kind { KEEP, VIEW }
 private final File directory;
 private final long limit;
 private final LongSupplier clock;
 private final long keepFloor;
 // Last use remains the file mtime (including legacy entries). Only kind/day changes
 // append to this journal, so repeated same-day opens do not rewrite the index.
 // At most 50k tracked entries and 100k fixed 81-byte records (~8 MiB). Compaction
 // walks memory, never the directory. Unknown entries retain the legacy LRU policy.
 private static final int INDEX_MAGIC=0x4c4d4301, MAX_TRACKED=50_000, MAX_RECORDS=100_000;
 private static final int RECORD_BYTES=81;
 private static final long DAY=24L*60*60*1000;
 private final Map<String,Usage> usage=new HashMap<>();
 private int journalRecords;
 private boolean journalReady;
 private static final class Usage {
  final Kind kind;final int days;final long day;
  Usage(Kind kind,int days,long day){this.kind=kind;this.days=days;this.day=day;}
 }
 private long generation;
 private long reserved;
 // Totals of cached entries. One directory scan builds them; writes and removals keep
 // them current, and an hourly rescan applies the age limit. Scanning ~10k files on
 // every write made each download wait over a second behind the cache lock.
 private long bytes=-1,count;
 private long sweptAt;
 private static final long SWEEP_EVERY=60L*60*1000;
 ThumbnailCache(File directory)throws IOException{this(directory,LIMIT);}
 ThumbnailCache(File directory,long limit)throws IOException{this(directory,limit,System::currentTimeMillis);}
 ThumbnailCache(File directory,long limit,LongSupplier clock)throws IOException{
  this.directory=directory;this.limit=limit;this.keepFloor=limit/2;this.clock=clock;
  if(!directory.isDirectory() && !directory.mkdirs())throw new IOException("Cache unavailable");
  synchronized(this){
   for(File file:files())if(file.getName().endsWith(".part"))file.delete();
   loadUsage();trim(0);
  }
 }
 private File journal(){return new File(directory,".media-usage");}
 private static byte[] record(String key,Usage value)throws IOException{
  ByteArrayOutputStream bytes=new ByteArrayOutputStream(RECORD_BYTES);
  DataOutputStream output=new DataOutputStream(bytes);
  output.write(key.getBytes(StandardCharsets.US_ASCII));
  output.writeByte(value==null?0:value.kind==Kind.KEEP?1:2);
  output.writeInt(value==null?0:value.days);output.writeLong(value==null?0:value.day);
  CRC32 crc=new CRC32();crc.update(bytes.toByteArray());output.writeInt((int)crc.getValue());
  return bytes.toByteArray();
 }
 private void loadUsage(){
  File file=journal();if(!file.isFile())return;
  try(DataInputStream input=new DataInputStream(new BufferedInputStream(new FileInputStream(file)))){
   long length=file.length();
   if(length<4 || length>4L+MAX_RECORDS*RECORD_BYTES || (length-4)%RECORD_BYTES!=0 || input.readInt()!=INDEX_MAGIC)throw new IOException("Invalid usage index");
   int records=(int)((length-4)/RECORD_BYTES);
   for(int i=0;i<records;i++){
    byte[] record=new byte[RECORD_BYTES];input.readFully(record);
    CRC32 crc=new CRC32();crc.update(record,0,RECORD_BYTES-4);
    DataInputStream row=new DataInputStream(new ByteArrayInputStream(record));
    byte[] keyBytes=new byte[64];row.readFully(keyBytes);String key=new String(keyBytes,StandardCharsets.US_ASCII);
    int kind=row.readUnsignedByte(),days=row.readInt();long day=row.readLong();
    if(row.readInt()!=(int)crc.getValue() || !key.matches("[a-f0-9]{64}") || kind>2 || (kind!=0 && (days<1 || day<0 || day>3_000_000)))throw new IOException("Invalid usage record");
    if(kind==0)usage.remove(key);else usage.put(key,new Usage(kind==1?Kind.KEEP:Kind.VIEW,days,day));
    if(usage.size()>MAX_TRACKED)throw new IOException("Usage index too large");
   }
   journalRecords=records;journalReady=true;
  }catch(IOException ignored){usage.clear();journalRecords=0;journalReady=false;}
 }
 private void compactUsage()throws IOException{
  File temporary=new File(directory,".media-usage.part");
  try(FileOutputStream file=new FileOutputStream(temporary);DataOutputStream output=new DataOutputStream(new BufferedOutputStream(file))){
   output.writeInt(INDEX_MAGIC);
   for(Map.Entry<String,Usage> entry:usage.entrySet())output.write(record(entry.getKey(),entry.getValue()));
   output.flush();file.getFD().sync();
  }
  // Same-directory replacement: a crash leaves either the old journal or the snapshot.
  // Files.move replaces the old journal on every host; File.renameTo refuses an existing target on Windows.
  try{java.nio.file.Files.move(temporary.toPath(),journal().toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING,java.nio.file.StandardCopyOption.ATOMIC_MOVE);}
  catch(IOException failed){throw new IOException("Usage index replace failed",failed);}
  journalRecords=usage.size();journalReady=true;
 }
 private void saveUsage(String key,Usage value){
  try{
   if(!journalReady || journalRecords>=MAX_RECORDS){compactUsage();return;}
   try(FileOutputStream file=new FileOutputStream(journal(),true)){file.write(record(key,value));}
   journalRecords++;
  }catch(IOException ignored){
   // Metadata is optional: damaged/partial journals lose ranking, never media access.
   usage.clear();journalReady=false;journalRecords=0;journal().delete();
  }
 }
 private void forgetUsage(String key){if(usage.remove(key)!=null)saveUsage(key,null);}
 private void used(File file,Kind kind){
  long now=clock.getAsLong();file.setLastModified(now);
  String key=file.getName();Usage previous=usage.get(key);
  long day=Instant.ofEpochMilli(now).atZone(ZoneId.systemDefault()).toLocalDate().toEpochDay();
  if(kind==null)kind=previous==null?Kind.VIEW:previous.kind;
  // A clock rollback must not turn repeated visits on the same date into frequency.
  if(previous!=null && previous.kind==kind && day<=previous.day)return;
  if(previous==null && usage.size()>=MAX_TRACKED)return;
  int days=previous==null?1:previous.days+(day>previous.day && previous.days<Integer.MAX_VALUE?1:0);
  Usage next=new Usage(kind,days,previous==null?day:Math.max(day,previous.day));
  usage.put(key,next);saveUsage(key,next);
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
 /** Shared by shelf probes and foreground loads; digests survive metadata-only publications. */
 static String collectionArtworkKey(String account,String collection,String artwork,String variant,String revision,String digest)throws Exception{
  if(collection==null || !collection.matches("[A-Za-z0-9_-]{1,128}") || artwork==null || !artwork.matches("[A-Za-z0-9_-]{1,128}") || revision==null || !revision.matches("[a-f0-9]{64}") || !("thumbnail".equals(variant) || "original".equals(variant)) || digest==null || !digest.isEmpty()&&!digest.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Invalid artwork");
  return key(account+"\ncollection/"+collection+"/"+artwork+"/"+(digest.isEmpty()?revision:digest)+"/"+variant);
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
  if(!journal().isFile()){usage.clear();journalReady=false;journalRecords=0;}
  String value=UUID.randomUUID().toString();
  try(DataOutputStream output=new DataOutputStream(new FileOutputStream(marker))){output.writeUTF(value);}
  bytes=-1; // Android may have removed bytes without going through clear().
  return value;
 }
 /** One bounded, read-only probe; it does not download or refresh LRU timestamps. */
 synchronized boolean[] cached(List<String> keys,long expected)throws IOException{
  check(expected);
  if(keys.size()>100)throw new IllegalArgumentException("Too many thumbnails");
  boolean[] result=new boolean[keys.size()];long now=clock.getAsLong();
  for(int i=0;i<keys.size();i++){
   File file=entry(keys.get(i));
   result[i]=file.isFile() && now-file.lastModified()<=MAX_AGE;
  }
  return result;
 }
 /**
  * The thumbnail warm probe: like {@link #cached}, and it also classifies hits that carry
  * no usage record yet (entries cached before kinds existed) as KEEP. It neither refreshes
  * last use nor counts a visit day.
  */
 synchronized boolean[] cachedKeep(List<String> keys,long expected)throws IOException{
  boolean[] result=cached(keys,expected);
  long day=Instant.ofEpochMilli(clock.getAsLong()).atZone(ZoneId.systemDefault()).toLocalDate().toEpochDay();
  for(int i=0;i<result.length;i++){
   String key=keys.get(i);
   if(!result[i] || usage.containsKey(key) || usage.size()>=MAX_TRACKED)continue;
   Usage value=new Usage(Kind.KEEP,1,day);usage.put(key,value);saveUsage(key,value);
  }
  return result;
 }
 private File[] files(){File[] files=directory.listFiles();return files==null?new File[0]:files;}
 private File entry(String key)throws IOException{if(!key.matches("[a-f0-9]{64}"))throw new IOException("Invalid cache key");return new File(directory,key);}
 private void check(long expected)throws IOException{if(expected!=generation)throw new IOException("Cache invalidated");}
 // Settings asks rarely, so it gets an exact rescan (including the age limit).
 synchronized long[] status(){index(true);return new long[]{bytes,count,limit};}
 private void index(boolean force){
  long now=clock.getAsLong();
  if(!force && bytes>=0 && now-sweptAt<SWEEP_EVERY)return;
  long total=0,entries=0;Set<String> live=new HashSet<>();
  for(File file:files())if(file.getName().matches("[a-f0-9]{64}")){
   if(now-file.lastModified()>MAX_AGE && file.delete())continue;
   total+=file.length();entries++;live.add(file.getName());
  }
  // A later append must not resurrect rows pruned by expiry/external deletion on
  // restart. Compact the in-memory survivors at the next metadata change.
  if(usage.keySet().retainAll(live))journalReady=false;
  bytes=total;count=entries;sweptAt=now;
 }
 synchronized void clear()throws IOException{
  generation++;
  usage.clear();journalReady=false;journalRecords=0;
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
  // Lower rank/score evicts first: one-day VIEW, repeated VIEW, then KEEP.
  // Repeated VIEW score = last use + min(visit days - 1, 30) * 24 hours.
  // The positive bonus retains frequently visited media longer; age expiry still wins.
  File[] files=files();long[] score=new long[files.length],lengths=new long[files.length];
  int[] rank=new int[files.length];Integer[] order=new Integer[files.length];long kept=0;
  for(int i=0;i<files.length;i++){
   File file=files[i];Usage value=usage.get(file.getName());
   score[i]=file.lastModified();lengths[i]=file.length();order[i]=i;
   if(value!=null){
    if(value.kind==Kind.KEEP){rank[i]=2;kept+=lengths[i];}
    else if(value.days>1){rank[i]=1;score[i]+=Math.min(value.days-1,30)*DAY;}
   }
  }
  Arrays.sort(order,Comparator.<Integer>comparingInt(i->rank[i]).thenComparingLong(i->score[i]));
  for(int i:order){
   if(bytes+incoming<=limit)break;
   File file=files[i];if(!file.getName().matches("[a-f0-9]{64}"))continue;
   long length=lengths[i];
   // Never cross the protected floor, even when a single KEEP file straddles it.
   if(rank[i]==2 && kept-length<keepFloor)continue;
   if(file.delete()){bytes-=length;count--;if(rank[i]==2)kept-=length;forgetUsage(file.getName());}
  }
 }
 void obtain(String key,long expected,Download download)throws Exception{
  obtain(key,expected,Math.min(MAX_FILE,limit),download);
 }
 void obtain(String key,long expected,long maximum,Download download)throws Exception{
  obtain(key,expected,Kind.VIEW,maximum,download);
 }
 void obtain(String key,long expected,Kind kind,long maximum,Download download)throws Exception{
  File temporary;
  synchronized(this){
   check(expected);File cached=entry(key);
   if(cached.isFile() && clock.getAsLong()-cached.lastModified()<=MAX_AGE){used(cached,kind);return;}
   // Do not carry the frequency of an expired object into its replacement.
   forgetUsage(key);
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
    bytes+=size;count++;used(cached,kind);
   }
  }finally{synchronized(this){temporary.delete();reserved-=maximum;}}
 }
 synchronized File file(String key,long expected)throws IOException{
  return file(key,expected,null);
 }
 synchronized File file(String key,long expected,Kind kind)throws IOException{
  check(expected);File file=entry(key);
  if(!file.isFile() || clock.getAsLong()-file.lastModified()>MAX_AGE)throw new FileNotFoundException();
  used(file,kind);return file;
 }
 synchronized InputStream open(String key,long expected)throws IOException{
  return open(key,expected,null);
 }
 synchronized InputStream open(String key,long expected,Kind kind)throws IOException{
  check(expected);File file=entry(key);
  if(clock.getAsLong()-file.lastModified()>MAX_AGE)throw new FileNotFoundException();
  InputStream stream=new FileInputStream(file);used(file,kind);return stream;
 }
 synchronized void remove(String key,long expected)throws IOException{check(expected);index(false);File file=entry(key);if(file.exists()){long length=file.length();if(!file.delete())throw new IOException("Cache remove failed");bytes-=length;count--;}forgetUsage(key);}
}
