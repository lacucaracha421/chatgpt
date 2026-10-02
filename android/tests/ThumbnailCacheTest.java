package com.lakomics.mobile;
import java.io.*;
import java.nio.file.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.time.LocalDate;
import java.time.ZoneId;
public final class ThumbnailCacheTest {
 private static int checks;
 private static void check(boolean result){checks++;if(!result)throw new AssertionError("check "+checks);}
 private static void put(ThumbnailCache cache,String key,int bytes)throws Exception{cache.obtain(key,cache.generation(),file->Files.write(file.toPath(),new byte[bytes]));}
 private static final long DAY=24L*60*60*1000;
 private static final String A=hash("policy-a"),B=hash("policy-b"),C=hash("policy-c"),D=hash("policy-d");
 private static String hash(String value){try{return ThumbnailCache.key(value);}catch(Exception e){throw new AssertionError(e);}}
 private static final class Fixture implements AutoCloseable {
  final File dir=Files.createTempDirectory("lakomics-cache-policy-").toFile();
  final AtomicLong now=new AtomicLong(LocalDate.of(2026,1,10).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()+12*60*60*1000);
  final long limit;ThumbnailCache cache;
  Fixture(long limit)throws Exception{this.limit=limit;reopen();}
  void reopen()throws Exception{cache=new ThumbnailCache(dir,limit,now::get);}
  void put(String key,ThumbnailCache.Kind kind,int bytes)throws Exception{cache.obtain(key,cache.generation(),kind,bytes,file->Files.write(file.toPath(),new byte[bytes]));}
  void view(String key)throws Exception{cache.file(key,cache.generation());}
  boolean has(String key)throws Exception{return cache.cached(java.util.Collections.singletonList(key),cache.generation())[0];}
  public void close()throws Exception{for(File file:dir.listFiles())Files.deleteIfExists(file.toPath());Files.delete(dir.toPath());}
 }
 private static void policyTests()throws Exception{
  ThumbnailCache.Kind keep=ThumbnailCache.Kind.KEEP,view=ThumbnailCache.Kind.VIEW;
  // An older two-day view beats a newer view opened repeatedly on only one day.
  // Exercise file(), open(), obtain-hit, and process restart in the same scenario.
  try(Fixture f=new Fixture(20)){
   f.put(A,view,10);f.now.addAndGet(DAY);f.view(A);f.now.addAndGet(1000);f.put(B,view,10);
   long journalSize=new File(f.dir,".media-usage").length();
   for(int i=0;i<10;i++){
    f.now.addAndGet(1000);f.view(B);
    try(InputStream input=f.cache.open(B,f.cache.generation())){check(input.read()==0);}
    f.cache.obtain(B,f.cache.generation(),view,10,file->{throw new AssertionError("hit downloaded");});
   }
   check(new File(f.dir,".media-usage").length()==journalSize);
   f.reopen();f.put(C,view,10);check(f.has(A)&&!f.has(B)&&f.has(C));
  }
  // Both open() and obtain-hit count a new local day.
  for(boolean stream:new boolean[]{true,false})try(Fixture f=new Fixture(20)){
   f.put(A,view,10);f.now.addAndGet(DAY);
   if(stream)try(InputStream input=f.cache.open(A,f.cache.generation())){check(input.read()==0);}
   else f.cache.obtain(A,f.cache.generation(),view,10,file->{throw new AssertionError("hit downloaded");});
   f.now.addAndGet(1000);f.put(B,view,10);f.put(C,view,10);check(f.has(A)&&!f.has(B));
  }
  // Calendar dates are local: crossing Seoul midnight counts even within one UTC day.
  java.util.TimeZone originalZone=java.util.TimeZone.getDefault();
  try{
   java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("Asia/Seoul"));
   try(Fixture f=new Fixture(20)){
    f.now.set(LocalDate.of(2026,1,11).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()-1000);
    f.put(A,view,10);f.now.addAndGet(2000);f.view(A);f.now.addAndGet(1000);
    f.put(B,view,10);f.put(C,view,10);check(f.has(A)&&!f.has(B));
   }
  }finally{java.util.TimeZone.setDefault(originalZone);}
  // A probe on another day changes neither frequency nor recency.
  try(Fixture f=new Fixture(20)){
   f.put(A,view,10);f.now.addAndGet(1000);f.put(B,view,10);f.now.addAndGet(DAY);
   byte[] before=Files.readAllBytes(new File(f.dir,".media-usage").toPath());
   long mtime=new File(f.dir,A).lastModified();check(f.has(A));
   check(new File(f.dir,A).lastModified()==mtime);
   check(java.util.Arrays.equals(before,Files.readAllBytes(new File(f.dir,".media-usage").toPath())));
   f.put(C,view,10);check(!f.has(A)&&f.has(B));
  }
  // Frequency bonus beats modest recency among multi-day VIEW entries.
  try(Fixture f=new Fixture(20)){
   f.put(A,view,10);for(int i=0;i<3;i++){f.now.addAndGet(DAY);f.view(A);}
   f.now.addAndGet(1000);f.put(B,view,10);f.now.addAndGet(DAY);f.view(B);
   f.put(C,view,10);check(f.has(A)&&!f.has(B));
  }
  // The bonus is capped: an old, very frequent view can still lose to a newer revisit.
  try(Fixture f=new Fixture(20)){
   f.put(A,view,10);for(int i=0;i<39;i++){f.now.addAndGet(DAY);f.view(A);}
   f.now.addAndGet(35*DAY);f.put(B,view,10);f.now.addAndGet(DAY);f.view(B);
   f.put(C,view,10);check(!f.has(A)&&f.has(B));
  }
  // KEEP survives even newer VIEW pressure. Excess KEEP evicts in LRU order,
  // but a VIEW admission cannot push the surviving set below half the budget.
  try(Fixture f=new Fixture(20)){
   f.put(A,keep,6);f.now.addAndGet(1000);f.put(B,keep,6);f.now.addAndGet(1000);f.put(C,keep,6);
   f.reopen();f.put(D,view,8);check(!f.has(A)&&f.has(B)&&f.has(C)&&f.has(D));
   try{f.put(A,view,9);throw new AssertionError("KEEP floor crossed");}catch(IOException expected){check(f.has(B)&&f.has(C));}
   check(f.cache.status()[0]==12&&f.cache.status()[2]==20);
  }
  try(Fixture f=new Fixture(20)){
   f.put(A,keep,5);f.now.addAndGet(1000);f.put(B,keep,5);f.put(C,view,10);
   f.put(D,view,10);check(f.has(A)&&f.has(B)&&!f.has(C)&&f.has(D));
   // Smaller-than-floor KEEP sets are also protected.
   f.cache.remove(B,f.cache.generation());f.put(C,view,15);check(f.has(A)&&f.has(C));
  }
  // Older cache hits acquire their caller's kind, without a new download.
  for(boolean stream:new boolean[]{true,false})try(Fixture f=new Fixture(20)){
   f.put(A,view,10);Files.delete(new File(f.dir,".media-usage").toPath());f.reopen();
   if(stream)try(InputStream input=f.cache.open(A,f.cache.generation(),keep)){check(input.read()==0);}
   else f.cache.file(A,f.cache.generation(),keep);
   f.put(B,view,10);f.put(C,view,10);check(f.has(A)&&!f.has(B));
  }
  // Missing, truncated and checksum-corrupt indexes all fall back to ordinary LRU.
  for(int damage=0;damage<3;damage++)try(Fixture f=new Fixture(20)){
   f.put(A,keep,10);f.now.addAndGet(1000);f.put(B,view,10);
   File journal=new File(f.dir,".media-usage");byte[] content=Files.readAllBytes(journal.toPath());
   if(damage==0)Files.delete(journal.toPath());
   else if(damage==1)Files.write(journal.toPath(),java.util.Arrays.copyOf(content,content.length-1));
   else{content[content.length-1]^=1;Files.write(journal.toPath(),content);}
   f.reopen();check(f.cache.status()[0]==20);f.put(C,view,10);check(!f.has(A)&&f.has(B)&&f.has(C));
   f.reopen();check(f.has(C));
  }
  // Clear resets kind, day counts, marker and stale generations, including on restart.
  try(Fixture f=new Fixture(20)){
   f.put(A,keep,10);f.now.addAndGet(DAY);f.view(A);String marker=f.cache.warmGeneration();
   long old=f.cache.generation();f.cache.clear();check(f.cache.status()[0]==0);
   check(!new File(f.dir,".media-usage").exists());check(!marker.equals(f.cache.warmGeneration()));
   try{f.cache.obtain(A,old,keep,10,file->{throw new AssertionError("stale download");});throw new AssertionError("stale write");}catch(IOException expected){check(true);}
   f.put(A,view,10);f.now.addAndGet(1000);f.put(B,view,10);f.reopen();f.put(C,view,10);check(!f.has(A)&&f.has(B));
  }
  // Removal and later reuse cannot inherit the old kind or visit count.
  try(Fixture f=new Fixture(20)){
   f.put(A,keep,10);f.now.addAndGet(DAY);f.view(A);f.cache.remove(A,f.cache.generation());
   f.reopen();f.put(A,view,10);f.now.addAndGet(1000);f.put(B,view,10);f.put(C,view,10);check(!f.has(A)&&f.has(B));
  }
  // Age expiry overrides both the KEEP floor and repeated-view preference.
  try(Fixture f=new Fixture(20)){
   f.put(A,keep,10);f.put(B,view,10);f.now.addAndGet(DAY);f.view(B);
   f.now.addAndGet((ThumbnailCache.MAX_AGE_SECONDS+1)*1000);
   check(!f.has(A)&&!f.has(B));check(f.cache.status()[0]==0&&f.cache.status()[1]==0);
  }
  // Interrupted downloads do not publish metadata and never hold the disk lock.
  try(Fixture f=new Fixture(20)){
   try{f.cache.obtain(A,f.cache.generation(),keep,10,file->{
    Thread reader=new Thread(()->f.cache.status());reader.start();reader.join(2000);check(!reader.isAlive());
    Files.write(file.toPath(),new byte[10]);throw new IOException("interrupted");
   });throw new AssertionError("failed download committed");}catch(IOException expected){check(!f.has(A)&&f.cache.status()[0]==0);}
   check(!new File(f.dir,".media-usage").exists());
  }
  // At its bound the journal compacts from memory, preserving rankings on restart.
  try(Fixture f=new Fixture(20)){
   f.put(A,keep,10);File journal=new File(f.dir,".media-usage");byte[] first=Files.readAllBytes(journal.toPath());
   try(OutputStream output=new BufferedOutputStream(new FileOutputStream(journal,true))){for(int i=1;i<100_000;i++)output.write(first,4,81);}
   check(journal.length()==4+100_000L*81);f.reopen();f.now.addAndGet(DAY);f.view(A);
   check(journal.length()==85);f.reopen();f.put(B,view,10);f.put(C,view,10);check(f.has(A)&&!f.has(B));
  }
  // A leftover compaction temp does not replace the last committed index.
  try(Fixture f=new Fixture(20)){
   f.put(A,keep,10);Files.write(new File(f.dir,".media-usage.part").toPath(),new byte[]{1,2,3});
   f.reopen();check(!new File(f.dir,".media-usage.part").exists());
   f.put(B,view,10);f.put(C,view,10);check(f.has(A)&&!f.has(B));
  }
  // Optional metadata write failures must not prevent a valid media download/open.
  try(Fixture f=new Fixture(20)){
   check(new File(f.dir,".media-usage").mkdir());
   f.put(A,keep,10);check(f.has(A));f.view(A);check(f.cache.status()[0]==10);
  }
  // Thumbnails cached before kinds existed become KEEP through the warm probe, without a
  // refreshed last use, so a one-day view is evicted before them.
  try(Fixture f=new Fixture(20)){
   File legacy=new File(f.dir,A);Files.write(legacy.toPath(),new byte[10]);
   long stamp=f.now.get()-5*DAY;check(legacy.setLastModified(stamp));f.reopen();
   check(f.cache.cachedKeep(java.util.Collections.singletonList(A),f.cache.generation())[0]);
   check(legacy.lastModified()==stamp);
   f.now.addAndGet(DAY);f.put(B,view,10);f.now.addAndGet(DAY);f.put(C,view,10);
   check(f.has(A)&&!f.has(B)&&f.has(C));
   f.reopen();check(f.has(A));
  }
  // Inserts below the budget do not rescan a large directory on each write.
  File actual=Files.createTempDirectory("lakomics-cache-scans-").toFile();AtomicInteger scans=new AtomicInteger();
  File counted=new File(actual.getPath()){@Override public File[] listFiles(){scans.incrementAndGet();return super.listFiles();}};
  try{
   ThumbnailCache cache=new ThumbnailCache(counted,1000);int initial=scans.get();
   for(int i=0;i<100;i++)cache.obtain(hash("scan-"+i),cache.generation(),keep,1,file->Files.write(file.toPath(),new byte[1]));
   check(scans.get()==initial);check(cache.status()[0]==100&&cache.status()[1]==100);
  }finally{for(File file:actual.listFiles())Files.delete(file.toPath());Files.delete(actual.toPath());}
 }
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
   new File(dir,b).setLastModified(System.currentTimeMillis()-(ThumbnailCache.MAX_AGE_SECONDS+86400)*1000);check(cache.status()[0]==0);
   long old=cache.generation();
   try{cache.obtain(c,old,file->{Files.write(file.toPath(),new byte[4]);cache.clear();});throw new AssertionError("stale commit");}catch(IOException expected){check(cache.status()[0]==0);}
   try{cache.open(c,old);throw new AssertionError("stale read");}catch(IOException expected){check(true);}
   try{cache.open("../outside",cache.generation());throw new AssertionError("path escape");}catch(IOException expected){check(true);}
   try{put(cache,a,11);throw new AssertionError("oversize");}catch(IOException expected){check(cache.status()[0]==0);}
   try{cache.obtain(a,cache.generation(),file->{Files.write(file.toPath(),new byte[4]);throw new IOException("interrupted");});}catch(IOException expected){check(dir.listFiles().length==0);}
   put(cache,a,5);try(InputStream in=cache.open(a,cache.generation())){check(in.read()==0);}cache.remove(a,cache.generation());check(cache.status()[0]==0);put(cache,a,5);cache.clear();check(cache.status()[0]==0 && cache.status()[1]==0);
   // In-flight reservations share the same cap as completed files.
   cache.obtain(a,cache.generation(),6,file->{
    Files.write(file.toPath(),new byte[4]);
    try{cache.obtain(b,cache.generation(),6,other->Files.write(other.toPath(),new byte[6]));throw new AssertionError("overlapping reservations");}catch(IOException expected){check(true);}
   });
   check(cache.status()[0]==4);
   cache.obtain(b,cache.generation(),6,file->Files.write(file.toPath(),new byte[6]));check(cache.status()[0]==10);
   cache.clear();cache.obtain(c,cache.generation(),10,file->Files.write(file.toPath(),new byte[10]));check(cache.file(c,cache.generation()).length()==10);
   // Batched probes neither download nor refresh age/LRU, and respect invalidation.
   long used=System.currentTimeMillis()-10000;new File(dir,c).setLastModified(used);
   boolean[] hits=cache.cached(java.util.Arrays.asList(a,c),cache.generation());
   check(!hits[0] && hits[1]);check(new File(dir,c).lastModified()==used);
   check(cache.cached(java.util.Collections.emptyList(),cache.generation()).length==0);
   try{cache.cached(java.util.Collections.nCopies(101,c),cache.generation());throw new AssertionError("unbounded probe");}catch(IllegalArgumentException expected){check(true);}
   try{cache.cached(java.util.Arrays.asList("../outside"),cache.generation());throw new AssertionError("probe path escape");}catch(IOException expected){check(true);}
   new File(dir,c).setLastModified(System.currentTimeMillis()-(ThumbnailCache.MAX_AGE_SECONDS+1)*1000);
   check(!cache.cached(java.util.Arrays.asList(c),cache.generation())[0]);
   String epoch=cache.warmGeneration();
   check(new ThumbnailCache(dir,10).warmGeneration().equals(epoch));
   long beforeClear=cache.generation();cache.clear();String cleared=cache.warmGeneration();
   check(!epoch.equals(cleared));check(new ThumbnailCache(dir,10).warmGeneration().equals(cleared));
   try{cache.cached(java.util.Arrays.asList(c),beforeClear);throw new AssertionError("stale probe");}catch(IOException expected){check(true);}
   // Android can remove the disposable directory independently of the WebView state.
   put(cache,a,5);
   for(File file:dir.listFiles())Files.delete(file.toPath());Files.delete(dir.toPath());
   String removed=cache.warmGeneration();check(!removed.equals(cleared));
   put(cache,b,10);check(cache.status()[0]==10);
   check(new ThumbnailCache(dir,10).warmGeneration().equals(removed));
   // A thumbnail revision is part of the key: a regenerated thumbnail of the same Asset
   // misses the retained entry and is served under a new URL. No revision keeps the old key.
   String account="https://a.example\ntoken";
   String legacy=ThumbnailCache.mediaKey(account,"asset1","thumbnail","");
   check(legacy.equals(ThumbnailCache.key(account+"\nasset1")));
   check(ThumbnailCache.mediaKey(account,"asset1","original","").equals(ThumbnailCache.key(account+"\nasset1\noriginal")));
   String r1=ThumbnailCache.mediaKey(account,"asset1","thumbnail","r1"),r2=ThumbnailCache.mediaKey(account,"asset1","thumbnail","r2");
   check(!r1.equals(r2) && !r1.equals(legacy));
   check(ThumbnailCache.mediaKey(account,"asset1","original","r1").equals(ThumbnailCache.mediaKey(account,"asset1","original","")));
   File revisionDir=Files.createTempDirectory("lakomics-revisions-").toFile();
   try{
   ThumbnailCache revisions=new ThumbnailCache(revisionDir,10);
   revisions.obtain(r1,revisions.generation(),file->Files.write(file.toPath(),new byte[3]));
   boolean[] revised=revisions.cached(java.util.Arrays.asList(r1,r2),revisions.generation());
   check(revised[0] && !revised[1]);
   AtomicInteger refetched=new AtomicInteger();revisions.obtain(r2,revisions.generation(),file->{refetched.incrementAndGet();Files.write(file.toPath(),new byte[3]);});
   check(refetched.get()==1);
   check(!ThumbnailCache.localPath(revisions.generation(),r1).equals(ThumbnailCache.localPath(revisions.generation(),r2)));
   }finally{for(File file:revisionDir.listFiles())Files.deleteIfExists(file.toPath());Files.deleteIfExists(revisionDir.toPath());}
   try{ThumbnailCache.mediaKey(account,"asset1","thumbnail","../x");throw new AssertionError("unsafe revision");}catch(IllegalArgumentException expected){check(true);}
   policyTests();
   System.out.println("ThumbnailCache: "+checks+" checks passed");
  }finally{for(File file:dir.listFiles())Files.deleteIfExists(file.toPath());Files.deleteIfExists(dir.toPath());}
 }
}
