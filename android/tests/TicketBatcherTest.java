package com.lakomics.mobile;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public final class TicketBatcherTest {
 private static int checks;
 private static void check(boolean value){checks++;if(!value)throw new AssertionError("check "+checks);}
 private interface Checked {void run()throws Exception;}
 private static void unavailable(Checked action)throws Exception{try{action.run();throw new AssertionError("Expected IOException");}catch(IOException expected){checks++;}}
 private static void canceled(Checked action)throws Exception{try{action.run();throw new AssertionError("Expected cancellation");}catch(CancellationException expected){checks++;}}
 private static void latch(CountDownLatch latch)throws Exception{if(!latch.await(3,TimeUnit.SECONDS))throw new AssertionError("Latch timed out");}
 private static List<String> values(String connection,List<TicketBatcher.Item> items){List<String> values=new ArrayList<>();for(TicketBatcher.Item item:items)values.add(connection+"/"+item.id+"/"+item.variant);return values;}
 private static final class Task extends FutureTask<Void> implements ScheduledFuture<Void> {
  Task(Runnable action){super(action,null);}
  public long getDelay(TimeUnit unit){return 0;}
  public int compareTo(Delayed other){return 0;}
 }
 /** Advance only the 12ms dispatch boundary; no wall-clock sleeps in policy tests. */
 private static final class Scheduler extends ScheduledThreadPoolExecutor {
  final Queue<Task> tasks=new ArrayDeque<>();
  Scheduler(){super(1);}
  @Override public ScheduledFuture<?> schedule(Runnable action,long delay,TimeUnit unit){
   check(unit.toMillis(delay)==12);Task task=new Task(action);tasks.add(task);return task;
  }
  void flush()throws Exception{Task task=tasks.remove();task.run();task.get(3,TimeUnit.SECONDS);}
 }
 private static void coalescesAndPrunes()throws Exception{
  Scheduler scheduler=new Scheduler();AtomicInteger calls=new AtomicInteger();
  TicketBatcher<String,String> batcher=new TicketBatcher<>(scheduler,(connection,items)->{
   calls.incrementAndGet();check(items.size()==2);check(items.get(0).id.equals("same"));check(items.get(1).id.equals("other"));
   check(items.get(0).batch==items.get(1).batch);check(items.get(0).batch.size==2);
   items.get(0).batch.httpNanos=1234567;
   return values(connection,items);
  });
  AtomicBoolean firstCanceled=new AtomicBoolean(),queuedCanceled=new AtomicBoolean();
  TicketBatcher<String,String>.Waiter first=batcher.submit("account/1","a","same","thumbnail",firstCanceled::get);
  TicketBatcher<String,String>.Waiter second=batcher.submit("account/1","a","same","thumbnail",()->false);
  TicketBatcher<String,String>.Waiter removed=batcher.submit("account/1","a","removed","thumbnail",queuedCanceled::get);
  TicketBatcher<String,String>.Waiter other=batcher.submit("account/1","a","other","thumbnail",()->false);
  firstCanceled.set(true);queuedCanceled.set(true);
  check(scheduler.tasks.size()==1);scheduler.flush();
  canceled(first::await);canceled(removed::await);
  check(second.await().equals("a/same/thumbnail"));check(other.await().equals("a/other/thumbnail"));check(calls.get()==1);
  check(second.timing()==other.timing());check(second.timing().httpNanos==1234567);check(second.timing().id>0);
  check(removed.timing()==null);
  canceled(()->batcher.submit("account/1","a","pre-canceled","thumbnail",()->true));
  TicketBatcher<String,String>.Waiter abandoned=batcher.submit("account/1","a","abandoned","thumbnail",()->false);
  abandoned.close();scheduler.flush();canceled(abandoned::await);check(calls.get()==1);
 }
 private static void inFlightSharing()throws Exception{
  ScheduledExecutorService scheduler=Executors.newSingleThreadScheduledExecutor();ExecutorService consumers=Executors.newFixedThreadPool(2);
  CountDownLatch entered=new CountDownLatch(1),finish=new CountDownLatch(1);AtomicInteger calls=new AtomicInteger();
  try{
   TicketBatcher<String,String> batcher=new TicketBatcher<>(scheduler,(connection,items)->{
    calls.incrementAndGet();entered.countDown();latch(finish);return values(connection,items);
   });
   AtomicBoolean firstCanceled=new AtomicBoolean();
   TicketBatcher<String,String>.Waiter first=batcher.submit("a/1","a","same","thumbnail",firstCanceled::get);
   Future<String> firstResult=consumers.submit(first::await);latch(entered);
   firstCanceled.set(true);
   try{firstResult.get(3,TimeUnit.SECONDS);throw new AssertionError("Expected cancellation");}catch(ExecutionException expected){check(expected.getCause() instanceof CancellationException);}
   // Even with no remaining old consumer, the dispatched key must stay joinable.
   TicketBatcher<String,String>.Waiter second=batcher.submit("a/1","a","same","thumbnail",()->false);
   Future<String> secondResult=consumers.submit(second::await);finish.countDown();
   check(secondResult.get(3,TimeUnit.SECONDS).equals("a/same/thumbnail"));check(calls.get()==1);
  }finally{finish.countDown();scheduler.shutdownNow();consumers.shutdownNow();check(scheduler.awaitTermination(3,TimeUnit.SECONDS));check(consumers.awaitTermination(3,TimeUnit.SECONDS));}
 }
 private static void cancelOneInFlight()throws Exception{
  Scheduler scheduler=new Scheduler();AtomicBoolean canceled=new AtomicBoolean();AtomicInteger calls=new AtomicInteger();
  TicketBatcher<String,String> batcher=new TicketBatcher<>(scheduler,(connection,items)->{calls.incrementAndGet();check(items.size()==1);canceled.set(true);return values(connection,items);});
  TicketBatcher<String,String>.Waiter first=batcher.submit("a/1","a","same","thumbnail",canceled::get);
  TicketBatcher<String,String>.Waiter second=batcher.submit("a/1","a","same","thumbnail",()->false);
  scheduler.flush();canceled(first::await);check(second.await().equals("a/same/thumbnail"));check(calls.get()==1);
 }
 private static void scopesAndVariants()throws Exception{
  Scheduler scheduler=new Scheduler();List<String> connections=new ArrayList<>();List<Integer> sizes=new ArrayList<>();
  TicketBatcher<String,String> batcher=new TicketBatcher<>(scheduler,(connection,items)->{connections.add(connection);sizes.add(items.size());return values(connection,items);});
  List<TicketBatcher<String,String>.Waiter> waiters=new ArrayList<>();
  waiters.add(batcher.submit("endpointA/tokenA/configA/1","old","same","thumbnail",()->false));
  waiters.add(batcher.submit("endpointA/tokenA/configA/1","old","same","original",()->false));
  waiters.add(batcher.submit("endpointB/tokenA/configA/1","endpoint","same","thumbnail",()->false));
  waiters.add(batcher.submit("endpointA/tokenB/configA/1","token","same","thumbnail",()->false));
  waiters.add(batcher.submit("endpointA/tokenA/configB/1","config","same","thumbnail",()->false));
  waiters.add(batcher.submit("endpointA/tokenA/configA/2","generation","same","thumbnail",()->false));
  scheduler.flush();check(connections.equals(Arrays.asList("old","endpoint","token","config","generation")));check(sizes.equals(Arrays.asList(2,1,1,1,1)));
  check(waiters.get(0).await().equals("old/same/thumbnail"));check(waiters.get(1).await().equals("old/same/original"));
  for(int i=2;i<waiters.size();i++)check(waiters.get(i).await().equals(connections.get(i-1)+"/same/thumbnail"));
 }
 private static void failureAndFreshRetry()throws Exception{
  Scheduler scheduler=new Scheduler();AtomicInteger calls=new AtomicInteger();
  TicketBatcher<String,String> batcher=new TicketBatcher<>(scheduler,(connection,items)->{
   if(calls.incrementAndGet()==1)throw new IOException("offline");return values(connection,items);
  });
  TicketBatcher<String,String>.Waiter first=batcher.submit("a/1","a","same","thumbnail",()->false);
  TicketBatcher<String,String>.Waiter second=batcher.submit("a/1","a","same","thumbnail",()->false);
  scheduler.flush();unavailable(first::await);unavailable(second::await);
  TicketBatcher<String,String>.Waiter retry=batcher.submit("a/1","a","same","thumbnail",()->false);scheduler.flush();check(retry.await().equals("a/same/thumbnail"));
  check(first.timing()==second.timing());check(first.timing().id!=retry.timing().id);
  // A transfer retry must renew the ticket, not reuse a completed capability.
  TicketBatcher<String,String>.Waiter fresh=batcher.submit("a/1","a","same","thumbnail",()->false);scheduler.flush();check(fresh.await().equals("a/same/thumbnail"));check(calls.get()==3);
  TicketBatcher<String,String> partial=new TicketBatcher<>(scheduler,(connection,items)->Arrays.asList(null,"good"));
  TicketBatcher<String,String>.Waiter missing=partial.submit("a/1","a","missing","thumbnail",()->false);
  TicketBatcher<String,String>.Waiter good=partial.submit("a/1","a","good","thumbnail",()->false);
  scheduler.flush();unavailable(missing::await);check(good.await().equals("good"));
 }
 private static void boundsAndLaterBatchCancellation()throws Exception{
  Scheduler scheduler=new Scheduler();AtomicBoolean laterCanceled=new AtomicBoolean();List<Integer> sizes=new ArrayList<>();
  TicketBatcher<String,String> batcher=new TicketBatcher<>(scheduler,(connection,items)->{sizes.add(items.size());laterCanceled.set(true);return values(connection,items);});
  List<TicketBatcher<String,String>.Waiter> waiters=new ArrayList<>();
  for(int i=0;i<TicketBatcher.MAX_PENDING;i++)waiters.add(batcher.submit("a/1","a","id"+i,"thumbnail",i>=100?laterCanceled::get:()->false));
  unavailable(()->batcher.submit("a/1","a","overflow","thumbnail",()->false));
  unavailable(()->batcher.submit("a/1","a","id0","thumbnail",()->false));
  check(scheduler.tasks.size()==1);scheduler.flush();check(sizes.equals(Arrays.asList(50,50)));
  for(int i=0;i<100;i++)check(waiters.get(i).await().equals("a/id"+i+"/thumbnail"));
  for(int i=100;i<waiters.size();i++)canceled(waiters.get(i)::await);
  TicketBatcher<String,String>.Waiter recovered=batcher.submit("a/1","a","recovered","thumbnail",()->false);scheduler.flush();check(recovered.await().equals("a/recovered/thumbnail"));
  AtomicBoolean allCanceled=new AtomicBoolean();
  for(int i=0;i<TicketBatcher.MAX_PENDING;i++)batcher.submit("a/1","a","duplicate","thumbnail",allCanceled::get);
  unavailable(()->batcher.submit("a/1","a","duplicate","thumbnail",()->false));
  allCanceled.set(true);
  TicketBatcher<String,String>.Waiter survivor=batcher.submit("a/1","a","duplicate","thumbnail",()->false);scheduler.flush();check(survivor.await().equals("a/duplicate/thumbnail"));
 }
 private static void clearDuringFlight()throws Exception{
  ScheduledExecutorService scheduler=Executors.newSingleThreadScheduledExecutor();CountDownLatch entered=new CountDownLatch(1),finish=new CountDownLatch(1);AtomicInteger calls=new AtomicInteger();
  try{
   TicketBatcher<String,String> batcher=new TicketBatcher<>(scheduler,(connection,items)->{if(calls.incrementAndGet()==1){entered.countDown();latch(finish);}return values(connection,items);});
   TicketBatcher<String,String>.Waiter old=batcher.submit("a/1","old","same","thumbnail",()->false);latch(entered);batcher.clear();unavailable(old::await);
   // Reusing even the same key must not let the old completion remove its replacement.
   TicketBatcher<String,String>.Waiter replacement=batcher.submit("a/1","new","same","thumbnail",()->false);finish.countDown();
   check(replacement.await().equals("new/same/thumbnail"));check(calls.get()==2);
  }finally{finish.countDown();scheduler.shutdownNow();check(scheduler.awaitTermination(3,TimeUnit.SECONDS));}
  Scheduler manual=new Scheduler();TicketBatcher<String,String> batcher=new TicketBatcher<>(manual,(connection,items)->{throw new AssertionError("Cleared queue dispatched");});
  TicketBatcher<String,String>.Waiter queued=batcher.submit("a/1","old","same","thumbnail",()->false);batcher.clear();manual.flush();unavailable(queued::await);
 }
 private static void interruptionAndRejectedScheduler()throws Exception{
  Scheduler scheduler=new Scheduler();TicketBatcher<String,String> batcher=new TicketBatcher<>(scheduler,(connection,items)->{throw new AssertionError("Interrupted waiter dispatched");});
  TicketBatcher<String,String>.Waiter waiter=batcher.submit("a/1","a","same","thumbnail",()->false);
  Thread.currentThread().interrupt();try{waiter.await();throw new AssertionError("Expected interruption");}catch(InterruptedException expected){checks++;}finally{Thread.interrupted();}
  scheduler.flush();
  ScheduledExecutorService stopped=Executors.newSingleThreadScheduledExecutor();stopped.shutdownNow();
  TicketBatcher<String,String> rejected=new TicketBatcher<>(stopped,TicketBatcherTest::values);
  unavailable(()->rejected.submit("a/1","a","same","thumbnail",()->false));
  unavailable(()->rejected.submit("a/1","a","same","thumbnail",()->false));
 }
 private static void prewarmedOriginalExpiryAndFreshRetry()throws Exception{
  Scheduler scheduler=new Scheduler();AtomicLong now=new AtomicLong(1_000);AtomicInteger calls=new AtomicInteger();
  TicketBatcher<String,Long> batcher=new TicketBatcher<>(scheduler,(connection,items)->{
   calls.incrementAndGet();List<Long> result=new ArrayList<>();for(TicketBatcher.Item item:items)result.add(now.get()+300_000);return result;
  },value->value,now::get);
  TicketBatcher<String,Long>.Waiter warm=batcher.submit("a/1","a","image","original",()->false);
  scheduler.flush();warm.await();calls.set(0);
  // This is the same submit/await path used by browser() after a disk miss.
  batcher.submit("a/1","a","image","original",()->false).await();check(calls.get()==0);check(scheduler.tasks.isEmpty());
  now.addAndGet(285_000); // Safety margin, not wall-clock timing.
  TicketBatcher<String,Long>.Waiter expired=batcher.submit("a/1","a","image","original",()->false);
  scheduler.flush();expired.await();check(calls.get()==1);
  TicketBatcher<String,Long>.Waiter fresh=batcher.submit("a/1","a","image","original",()->false,true);
  scheduler.flush();fresh.await();check(calls.get()==2);
  batcher.clear();TicketBatcher<String,Long>.Waiter cleared=batcher.submit("a/1","a","image","original",()->false);
  scheduler.flush();cleared.await();check(calls.get()==3);
  TicketBatcher<String,Long>.Waiter account=batcher.submit("b/1","b","image","original",()->false);
  scheduler.flush();account.await();check(calls.get()==4);
 }
 public static void main(String[] args)throws Exception{
  prewarmedOriginalExpiryAndFreshRetry();coalescesAndPrunes();inFlightSharing();cancelOneInFlight();scopesAndVariants();failureAndFreshRetry();boundsAndLaterBatchCancellation();clearDuringFlight();interruptionAndRejectedScheduler();
  System.out.println("TicketBatcher: "+checks+" checks passed");
 }
}
