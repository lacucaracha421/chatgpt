package com.lakomics.mobile;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import java.util.function.ToLongFunction;

/** Account/generation-scoped, in-flight sharing and bounded, expiry-aware original tickets. */
final class TicketBatcher<C,T> {
 static final int MAX_PENDING=128, MAX_BATCH=50;
 static final long DELAY_MILLIS=12;
 static final class Batch {
  final long id;final int size;
  volatile long httpNanos=-1;
  Batch(long id,int size){this.id=id;this.size=size;}
 }
 private static final java.util.concurrent.atomic.AtomicLong batchSequence=new java.util.concurrent.atomic.AtomicLong();
 static final class Item {
  volatile Batch batch;
  final String id,variant;
  final boolean fresh;
  Item(String id,String variant,boolean fresh){this.id=id;this.variant=variant;this.fresh=fresh;}
 }
 interface Transport<C,T> {List<T> fetch(C connection,List<Item> items)throws Exception;}
 private final ScheduledExecutorService worker;
 private final Transport<C,T> transport;
 private final Map<String,Pending> pending=new LinkedHashMap<>();
 private final ToLongFunction<T> expiry;
 private final LongSupplier clock;
 private final Map<String,T> completed=new LinkedHashMap<>();
 private int consumers;
 private boolean scheduled;
 private final class Pending {
  final String key,scope;
  final C connection;
  final Item item;
  final List<Waiter> waiters=new ArrayList<>();
  boolean dispatched;
  Pending(String key,String scope,C connection,Item item){this.key=key;this.scope=scope;this.connection=connection;this.item=item;}
 }
 final class Waiter implements AutoCloseable {
  private final Pending owner;
  private final BooleanSupplier canceled;
  private final CompletableFuture<T> result=new CompletableFuture<>();
  private Waiter(Pending owner,BooleanSupplier canceled){this.owner=owner;this.canceled=canceled;}
  Batch timing(){return owner.item.batch;}
  T await()throws Exception{
   try{
    while(true){
     if(canceled.getAsBoolean())throw new CancellationException();
     try{T value=result.get(100,TimeUnit.MILLISECONDS);if(canceled.getAsBoolean())throw new CancellationException();return value;}
     catch(TimeoutException ignored){}
     catch(ExecutionException failure){Throwable cause=failure.getCause();if(cause instanceof Exception)throw (Exception)cause;throw new IOException("Media ticket unavailable",cause);}
    }
   }finally{close();}
  }
  @Override public void close(){synchronized(TicketBatcher.this){detach(this);if(owner.waiters.isEmpty()&&!owner.dispatched)pending.remove(owner.key,owner);}}
 }
 TicketBatcher(ScheduledExecutorService worker,Transport<C,T> transport){this(worker,transport,value->0,System::currentTimeMillis);}
 TicketBatcher(ScheduledExecutorService worker,Transport<C,T> transport,ToLongFunction<T> expiry,LongSupplier clock){this.worker=worker;this.transport=transport;this.expiry=expiry;this.clock=clock;}
 private String key(String scope,String id,String variant){return scope+"\n"+id+"\n"+variant;}
 private boolean valid(T value){return value!=null && expiry.applyAsLong(value)-15_000>clock.getAsLong();}
 synchronized Waiter submit(String scope,C connection,String id,String variant,BooleanSupplier canceled)throws IOException{
  return submit(scope,connection,id,variant,canceled,false);
 }
 synchronized Waiter submit(String scope,C connection,String id,String variant,BooleanSupplier canceled,boolean fresh)throws IOException{
  if(canceled.getAsBoolean())throw new CancellationException();
  prune();
  String cacheKey=key(scope,id,variant);
  T cached=completed.get(cacheKey);
  if(fresh || !valid(cached))completed.remove(cacheKey);
  else {
   Waiter waiter=new Waiter(new Pending(cacheKey,scope,connection,new Item(id,variant,false)),canceled);
   waiter.result.complete(cached);return waiter;
  }
  String key=cacheKey+(fresh?"\nfresh":"");
  Pending entry=pending.get(key);
  if(consumers>=MAX_PENDING || entry==null&&pending.size()>=MAX_PENDING)throw new IOException("Media tickets busy");
  if(entry==null){entry=new Pending(key,scope,connection,new Item(id,variant,fresh));pending.put(key,entry);}
  Waiter waiter=new Waiter(entry,canceled);entry.waiters.add(waiter);consumers++;
  if(!scheduled){
   scheduled=true;
   try{worker.schedule(this::flush,DELAY_MILLIS,TimeUnit.MILLISECONDS);}
   catch(RejectedExecutionException failure){scheduled=false;clear();throw new IOException("Media tickets unavailable",failure);}
  }
  return waiter;
 }
 private void detach(Waiter waiter){if(waiter.owner.waiters.remove(waiter)){consumers--;waiter.result.cancel(false);}}
 private void prune(){
  Iterator<Pending> entries=pending.values().iterator();
  while(entries.hasNext()){
   Pending entry=entries.next();
   for(Waiter waiter:new ArrayList<>(entry.waiters))if(waiter.canceled.getAsBoolean())detach(waiter);
   // Keep a dispatched key joinable until its HTTP response, even if all old callers left.
   if(entry.waiters.isEmpty()&&!entry.dispatched)entries.remove();
  }
 }
 synchronized void clear(){
  for(Pending entry:pending.values())for(Waiter waiter:entry.waiters)waiter.result.completeExceptionally(new IOException("Media tickets invalidated"));
  for(Pending entry:pending.values())entry.waiters.clear();
  pending.clear();completed.clear();consumers=0;
 }
 private void flush(){
  while(true){
   List<Pending> batch=new ArrayList<>();
   synchronized(this){
    prune();
    String scope=null;boolean fresh=false;
    for(Pending entry:pending.values())if(!entry.dispatched){
     if(scope==null){scope=entry.scope;fresh=entry.item.fresh;}
     if(scope.equals(entry.scope)&&fresh==entry.item.fresh){entry.dispatched=true;batch.add(entry);if(batch.size()==MAX_BATCH)break;}
    }
    if(batch.isEmpty()){scheduled=false;return;}
   }
   Batch timing=new Batch(batchSequence.incrementAndGet(),batch.size());
   for(Pending entry:batch)entry.item.batch=timing;
   List<T> results=null;Exception failure=null;
   try{
    List<Item> items=new ArrayList<>();for(Pending entry:batch)items.add(entry.item);
    results=transport.fetch(batch.get(0).connection,Collections.unmodifiableList(items));
    if(results.size()!=batch.size())throw new IOException("Invalid media ticket response");
   }catch(Exception error){failure=error;}
   synchronized(this){
    for(int i=0;i<batch.size();i++){
     Pending entry=batch.get(i);
     if(!pending.remove(entry.key,entry))continue;
     T value=failure==null?results.get(i):null;
     if(entry.item.variant.equals("original") && valid(value)){
      completed.put(key(entry.scope,entry.item.id,entry.item.variant),value);
      while(completed.size()>240)completed.remove(completed.keySet().iterator().next());
     }
     for(Waiter waiter:entry.waiters){
      if(waiter.canceled.getAsBoolean())waiter.result.cancel(false);
      else if(failure!=null)waiter.result.completeExceptionally(failure);
      else if(value==null)waiter.result.completeExceptionally(new IOException("Media unavailable"));
      else waiter.result.complete(value);
     }
     consumers-=entry.waiters.size();entry.waiters.clear();
    }
   }
  }
 }
}
