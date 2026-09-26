package com.lakomics.mobile;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Delayed;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Foreground scheduling checks for Album replication.
 *
 * The defects these cover were *transition* defects, not replication ones: a connection
 * change disarmed the loop and nothing re-armed it, and once it did re-arm, a task left
 * over from the cancelled arm could still run because "is polling armed" was true again
 * for the newer arm. So these checks drive the state machine directly — foregrounded,
 * armed, immediate pass, repeating pass, disarmed, re-armed — instead of trying to
 * simulate an Android activity lifecycle, which is why {@link ForegroundSchedule} exists
 * as a seam at all.
 *
 * The timer records the tasks it was given and fires them on demand. Firing an *old* task
 * after a re-arm is exactly how the stale-generation defect is reproduced, so the
 * recording timer is not a convenience here: it is the only way to reach that state.
 */
public final class AlbumReplicaScheduleTest {
    private static int checks;

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
        checks++;
    }

    private static void equal(Object expected, Object actual, String message) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(message + " (expected " + expected + ", got " + actual + ")");
        }
        checks++;
    }

    /** Records the armed repeating tasks so a check can fire any generation by hand. */
    private static final class Recorder implements ForegroundSchedule.Timer {
        final List<Runnable> tasks = new ArrayList<>();
        final List<Long> intervals = new ArrayList<>();
        int cancelled;

        @Override
        public ScheduledFuture<?> schedule(Runnable task, long intervalMillis) {
            tasks.add(task);
            intervals.add(intervalMillis);
            return new Handle(this);
        }

        void fire(int index) { tasks.get(index).run(); }

        int pending() { return tasks.size() - cancelled; }
    }

    /** A future that reports cancellation back to the recorder. */
    private static final class Handle implements ScheduledFuture<Object> {
        private final Recorder recorder;

        Handle(Recorder recorder) { this.recorder = recorder; }

        @Override public boolean cancel(boolean mayInterruptIfRunning) {
            recorder.cancelled++;
            return true;
        }

        @Override public boolean isCancelled() { return false; }
        @Override public boolean isDone() { return false; }
        @Override public Object get() { throw new UnsupportedOperationException(); }
        @Override public Object get(long timeout, TimeUnit unit) {
            throw new UnsupportedOperationException();
        }
        @Override public long getDelay(TimeUnit unit) { return 0; }
        @Override public int compareTo(Delayed other) { return 0; }
    }

    private static final class Fixture {
        final Recorder timer = new Recorder();
        final List<String> events = new ArrayList<>();
        int immediate;
        int repeating;
        /** When true, an immediate request reports that single-flight refused it. */
        boolean immediateRefused;
        final ForegroundSchedule schedule;

        Fixture() {
            schedule = new ForegroundSchedule(timer, this::immediatePass, this::repeatingPass);
        }


        boolean immediatePass() {
            events.add("immediate");
            if (immediateRefused) return false;
            immediate++;
            return true;
        }

        void repeatingPass() {
            events.add("repeating");
            repeating++;
        }

        void invalidate() { events.add("invalidate"); }
    }

    public static void main(String[] args) throws Exception {
        explicitReadsValidateEqualCursorPages();
        classificationReadTransportStaysGetOnly();
        explicitClassificationReadsRejectReplay();
        idleRequestBudget();
        conditionalResponses();
        backoffAndWake();
        pickerBurstAndPause();
        pickerSkipsUnchangedLibrary();
        startsPollingAndReconcilesImmediately();
        repeatedResumeDoesNotDuplicateWork();
        pauseStopsPollingWithoutTouchingTheReplica();
        staleTimerFromAReplacedArmNeverRuns();
        staleTimerAfterStopNeverRuns();
        restartAfterLeavesExactlyOneArmedTimer();
        restartAfterInvalidatesBeforeTheImmediatePass();
        refusedImmediatePassIsRunWhenTheCurrentPassFinishes();
        aRestartCannotInterleaveBetweenTheCheckAndTheCallback();
        owedPassIsDroppedWhenPollingStops();
        connectionReplacementFromTheBackgroundDoesNotStartPolling();
        disconnectThenReconnectResumesPolling();
        exchangeRevisionIsNotALibraryChange();
        offlineSuspendsPollingAndReconnectReconciles();

        System.out.println("AlbumReplicaScheduleTest passed: " + checks
                + " checks (generations, start, pause, connection replacement, pending reconcile)");
    }

    /** A device-token status carries `exchange.revision`; only Library fields decide "changed". */
    private static void exchangeRevisionIsNotALibraryChange() {
        String base="{\"protocolVersion\":1,\"active\":true,\"libraryId\":\"lib\",\"domains\":[{\"domain\":\"albums\",\"cursor\":4}]";
        String a=SyncStatusPass.libraryStatus(base+",\"exchange\":{\"revision\":7}}");
        String b=SyncStatusPass.libraryStatus(base+",\"exchange\":{\"revision\":8}}");
        equal(a,b,"An exchange revision alone is not a Library change");
        equal(a,SyncStatusPass.libraryStatus(base+"}"),"Library-token and device-token status compare equal");
        check(!a.equals(SyncStatusPass.libraryStatus(base.replace("\"cursor\":4","\"cursor\":5")+",\"exchange\":{\"revision\":8}}")),"A moved domain cursor is still a change");
        equal("not json",SyncStatusPass.libraryStatus("not json"),"An unreadable body compares as-is");
    }

    /** Socket-free reproduction of the existing Album continuation fixtures. */
    private static void explicitReadsValidateEqualCursorPages() {
        String library="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        String row="{\"sequence\":8,\"authorityCursor\":8,\"commandType\":\"renameAlbum\","
                +"\"operationId\":\"x\",\"changedAt\":\"t\",\"album\":{\"id\":\"root\",\"name\":\"Skipped\","
                +"\"parentId\":null,\"description\":null,\"iconKey\":null,\"colorKey\":null,\"deleted\":false,\"entityRevision\":2}}";
        for(long[] entry:new long[][]{{6,8},{7,10},{7,7},{8,8}}) {
            int[] writes={0};List<String> requests=new ArrayList<>();
            AlbumReplica.Adopted local=new AlbumReplica.Adopted("account",library,1,1,7,"now","now");
            AlbumReplica.State state=(AlbumReplica.State)java.lang.reflect.Proxy.newProxyInstance(
                    AlbumReplica.State.class.getClassLoader(),new Class[]{AlbumReplica.State.class},(proxy,method,args)->{
                        if(method.getName().equals("adopted"))return local;
                        if(method.getName().equals("applyChanges")){writes[0]++;return null;}
                        throw new AssertionError("Unexpected store operation: "+method.getName());
                    });
            AlbumReplica.Transport transport=path->{
                requests.add(path);
                if(path.equals("/v1/sync/status"))return statusFor("albums",library,entry[0]);
                return "{\"libraryId\":\""+library+"\",\"epoch\":1,\"contractVersion\":1,\"cursor\":"+entry[0]
                        +",\"items\":["+row+"],\"nextAfter\":"+entry[1]+",\"hasMore\":"+(entry[1]!=entry[0])+"}";
            };
            AlbumAuthoritySync.Result result=new AlbumAuthoritySync(transport,state,()->"now").reconcile("account");
            boolean valid=entry[0]==8;
            equal(valid?null:AlbumReplica.CODE_MALFORMED,result.code,"Explicit reconcile validates continuation even at equal cursor");
            equal(valid?1:0,writes[0],"Rejected continuation never writes rows");
            equal(valid?8L:7L,result.localCursor,"Rejected continuation never advances cursor");
            equal(2,requests.size(),"Explicit reconcile reads the feed as well as status");
            check(requests.get(1).contains("after=7"),"Feed uses stored cursor");
        }
    }

    private static String statusFor(String domain,String library,long cursor) {
        return "{\"protocolVersion\":1,\"active\":true,\"libraryId\":\""+library+"\",\"domains\":[{\"domain\":\""+domain
                +"\",\"libraryId\":\""+library+"\",\"epoch\":1,\"contractVersion\":1,\"cursor\":"+cursor+"}]}";
    }

    @SuppressWarnings("unchecked")
    private static void explicitClassificationReadsRejectReplay() {
        String library="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        for(int kind=0;kind<3;kind++) {
            boolean valid=kind==2;long sequence=valid?3:2,ceiling=valid?3:2,next=kind==0?3:sequence;
            int[] writes={0};List<String> requests=new ArrayList<>();
            ClassificationReplica.Adopted local=new ClassificationReplica.Adopted("account",library,1,1,2,"now","now");
            ClassificationReplica.State state=(ClassificationReplica.State)java.lang.reflect.Proxy.newProxyInstance(
                    ClassificationReplica.State.class.getClassLoader(),new Class[]{ClassificationReplica.State.class},(proxy,method,args)->{
                        if(method.getName().equals("classificationAdopted"))return local;
                        if(method.getName().equals("applyClassificationChanges")){
                            ClassificationReplica.requireContiguous((List<ClassificationReplica.Change>)args[2],(Long)args[1]);
                            writes[0]++;return null;
                        }
                        throw new AssertionError("Unexpected store operation: "+method.getName());
                    });
            ClassificationReplica.Transport transport=path->{
                requests.add(path);
                if(path.equals("/v1/sync/status"))return statusFor("classifications",library,2);
                return "{\"libraryId\":\""+library+"\",\"epoch\":1,\"contractVersion\":1,\"cursor\":"+ceiling
                        +",\"items\":[{\"sequence\":"+sequence+",\"authorityCursor\":"+sequence
                        +",\"commandType\":\"renameClassification\",\"operationId\":\"x\",\"changedAt\":\"t\","
                        +"\"classification\":{\"id\":\"series\",\"kind\":\"tag\",\"name\":\"Once\",\"parentId\":null,"
                        +"\"iconKey\":null,\"colorKey\":null,\"deleted\":false,\"entityRevision\":3}}],\"nextAfter\":"+next+",\"hasMore\":false}";
            };
            ClassificationAuthoritySync.Result result=new ClassificationAuthoritySync(transport,state,()->"now").reconcile("account");
            equal(valid?null:ClassificationReplica.CODE_MALFORMED,result.code,"Explicit Classification receive validates replay/continuation at equal status cursor");
            equal(valid?1:0,result.appliedChanges,"Replayed change is not applied twice");
            equal(valid?1:0,writes[0],"Rejected Classification response writes nothing");
            equal(valid?3L:2L,result.localCursor,"Only a valid new change advances Classification cursor");
            equal(2,requests.size(),"Explicit Classification receive still requests the feed");
            check(requests.get(1).contains("after=2"),"Replay check resumes from its stored cursor");
        }
    }

    private static void classificationReadTransportStaysGetOnly() {
        for(java.lang.reflect.Method method:ClassificationReplica.Transport.class.getDeclaredMethods())
            equal("get",method.getName(),"Classification transport preserves its GET-only contract");
    }

    private static void backoffAndWake() {
        Fixture f=new Fixture();f.schedule.start();
        f.schedule.passFinished(false);f.schedule.passFinished(false);f.schedule.passFinished(false);f.schedule.passFinished(false);
        equal(List.of(5000L,15000L,30000L,60000L,60000L),f.timer.intervals,"Idle delay reaches one minute");
        f.schedule.passFinished(true);equal(5000L,f.timer.intervals.get(5),"Detected change resets delay");
        f.schedule.passFinished(false);f.schedule.wake();equal(5000L,f.timer.intervals.get(7),"Local outbox resets delay");
        equal(1,f.timer.pending(),"Backoff never accumulates timers");
        f.schedule.stop();f.schedule.wake();equal(0,f.timer.pending(),"Writes do not arm background polling");
        f.schedule.start();equal(5000L,f.timer.intervals.get(8),"Resume resets delay");
    }

    private static void pickerBurstAndPause() {
        PickerRefreshSchedule s=new PickerRefreshSchedule();s.resume();int walks=0;
        s.request(true,0);equal(0L,s.delay(0),"First forced refresh starts immediately");s.started(0);walks++;
        for(int i=1;i<300;i++)s.request(true,i*1000L);
        equal(-1L,s.delay(299000),"Running walk does not overlap");s.finished();
        equal(1000L,s.delay(299000),"Burst is held until five minutes");
        s.started(300000);walks++;s.finished();equal(-1L,s.delay(300001),"Only one trailing walk");
        equal(2,walks,"Five minute burst costs at most two walks");
        s.request(true,600000);s.started(600000);s.pause();s.finished();
        equal(-1L,s.delay(602000),"Pause keeps cancelled walk pending without a timer");
        s.resume();equal(0L,s.delay(610000),"Resume retries an interrupted walk");
    }

    /**
     * PERF-ALL-001: a Photo Picker refresh whose source did not move costs one list-generation
     * read instead of a full walk (list generation, classifications, 93 pages of 100 for 9,300
     * Assets, list generation = 96 requests). The walk below follows PickerLibrary.sync's
     * request order and uses the same decision.
     */
    private static void pickerSkipsUnchangedLibrary() {
        final String[] generation={"g1"};
        final AlbumCollections[] albums={AlbumCollections.empty()};
        final int[] requests={0};
        final String[] stored={""};
        final boolean[] ready={false};
        Runnable walk=()->{
            requests[0]++;String listGeneration=generation[0];
            if(PickerRefreshSchedule.unchanged(stored[0],PickerRefreshSchedule.sourceKey(listGeneration,albums[0]),ready[0]))return;
            requests[0]+=1+93+1;
            String key=PickerRefreshSchedule.sourceKey(listGeneration,albums[0]);
            stored[0]=key==null?"":key;ready[0]=true;
        };
        PickerRefreshSchedule s=new PickerRefreshSchedule();s.resume();
        long now=0;int walks=0;
        // Cold start and nine resumes 15+ minutes apart on an unchanged Library.
        for(int resume=0;resume<10;resume++,now+=16*60_000L){
            s.request(false,now);equal(0L,s.delay(now),"Resume after 15 min is due");s.started(now);walk.run();s.finished();walks++;
        }
        equal(10,walks,"Every resume still checks");
        equal(96+9,requests[0],"Unchanged resumes cost one list-generation read each (was 10 x 96)");
        requests[0]=0;generation[0]="g2";walk.run();
        equal(96,requests[0],"A moved list generation walks the Library");
        requests[0]=0;walk.run();equal(1,requests[0],"...and the next check is cheap again");
        java.util.Map<String,AlbumReplica.Album> albumMap=new java.util.TreeMap<>();albumMap.put("a1",new AlbumReplica.Album("a1","Trip",null,null,null,false,1));
        java.util.Map<String,AlbumReplica.Member> members=new java.util.TreeMap<>();members.put("a1/x",new AlbumReplica.Member("a1","x",true,1));
        albums[0]=AlbumCollections.build(albumMap,members);
        requests[0]=0;walk.run();equal(96,requests[0],"A local Album collection change walks even at the same generation");
        members.put("a1/y",new AlbumReplica.Member("a1","y",true,1));albums[0]=AlbumCollections.build(albumMap,members);
        requests[0]=0;walk.run();equal(96,requests[0],"A membership change walks");
        requests[0]=0;generation[0]=null;walk.run();walk.run();equal(192,requests[0],"No server generation: never skipped");
        equal(false,PickerRefreshSchedule.unchanged("",PickerRefreshSchedule.sourceKey("g1",AlbumCollections.empty()),true),"A snapshot stored without a source walks once");
        equal(false,PickerRefreshSchedule.unchanged(PickerRefreshSchedule.sourceKey("g1",AlbumCollections.empty()),PickerRefreshSchedule.sourceKey("g1",AlbumCollections.empty()),false),"An empty snapshot always walks");
    }

    private static void conditionalResponses() throws Exception {
        ConditionalRead.Reply empty=ConditionalRead.response(304,"v1",()->{throw new AssertionError("304 parsed as JSON");},code->{throw new AssertionError("304 treated as HTTP failure");});
        equal(304,empty.status,"CloudClient response path accepts 304 without reading a body");
        try{ConditionalRead.response(401,null,()->{throw new AssertionError("Failure parsed as success");},code->new java.io.IOException("auth"));throw new AssertionError("401 accepted");}catch(java.io.IOException expected){checks++;}
        ConditionalRead cache=new ConditionalRead();
        equal("first",cache.get("account-a","/status",tag->{equal(null,tag,"First GET has no validator");return new ConditionalRead.Reply(200,"v1","first");}),"200 body");
        equal("first",cache.get("account-a","/status",tag->{equal("v1",tag,"ETag sent on repeat");return new ConditionalRead.Reply(304,"v1",null);}),"304 preserves body");
        equal("old-server",cache.get("account-a","/status",tag->new ConditionalRead.Reply(200,null,"old-server")),"Ignoring validators remains compatible");
        cache.get("account-b","/status",tag->{equal(null,tag,"Account change drops validator");return new ConditionalRead.Reply(200,"b","other");});
        cache.clear();cache.get("account-b","/status",tag->{equal(null,tag,"Disconnect drops validator");return new ConditionalRead.Reply(200,null,"other");});
        try{cache.get("account-c","/status",tag->new ConditionalRead.Reply(304,null,null));throw new AssertionError("Uncached 304 accepted");}catch(java.io.IOException expected){checks++;}
    }

    /** The production three receive engines share the conditional status request. */
    private static void idleRequestBudget() throws Exception {
        String library="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        ConditionalRead cache=new ConditionalRead();
        java.util.Map<String,Long> cursors=new java.util.LinkedHashMap<>();
        for(String name:List.of("assets","albums","classifications"))cursors.put(name,0L);
        List<String> requests=new ArrayList<>();int[] notModified={0};
        AlbumReplica.Transport wire=path->{
            requests.add(path);
            if(!path.equals("/v1/sync/status"))throw new AlbumReplica.HttpFailure(503,"{}");
            StringBuilder domains=new StringBuilder();
            for(java.util.Map.Entry<String,Long> e:cursors.entrySet()){
                if(domains.length()>0)domains.append(',');
                domains.append("{\"domain\":\"").append(e.getKey()).append("\",\"libraryId\":\"").append(library).append("\",\"epoch\":1,\"contractVersion\":1,\"cursor\":").append(e.getValue()).append('}');
            }
            String body="{\"protocolVersion\":1,\"active\":true,\"libraryId\":\""+library+"\",\"domains\":["+domains+"]}";
            String etag=body;
            return cache.get("account",path,tag->{if(etag.equals(tag)){notModified[0]++;return new ConditionalRead.Reply(304,etag,null);}return new ConditionalRead.Reply(200,etag,body);});
        };
        AlbumReplica.Adopted album=new AlbumReplica.Adopted("account",library,1,1,0,"now","now");
        ClassificationReplica.Adopted classification=new ClassificationReplica.Adopted("account",library,1,1,0,"now","now");
        AlbumReplica.State albums=(AlbumReplica.State)java.lang.reflect.Proxy.newProxyInstance(AlbumReplica.State.class.getClassLoader(),new Class[]{AlbumReplica.State.class},(proxy,method,args)->{
            if(method.getName().equals("adopted"))return album;
            throw new AssertionError("Unexpected idle Album store work: "+method.getName());
        });
        ClassificationReplica.State classifications=(ClassificationReplica.State)java.lang.reflect.Proxy.newProxyInstance(ClassificationReplica.State.class.getClassLoader(),new Class[]{ClassificationReplica.State.class},(proxy,method,args)->{
            if(method.getName().equals("classificationAdopted"))return classification;
            throw new AssertionError("Unexpected idle Classification store work: "+method.getName());
        });
        AssetReplica.Storage assets=new AssetReplica.Storage(){
            public AssetReplica.Snapshot readAssets(String scope){return new AssetReplica.Snapshot(library,1,0,java.util.Collections.emptyMap());}
            public void replaceAssets(String scope,AssetReplica.Snapshot value){throw new AssertionError("Unexpected idle Asset write");}
            public void clearAssets(){throw new AssertionError("Unexpected idle clear");}
        };
        wire.get("/v1/sync/status");requests.clear();
        for(String changed:List.of("none","assets","albums","classifications")){
            for(String name:cursors.keySet())cursors.put(name,name.equals(changed)?1L:0L);
            requests.clear();SyncStatusPass pass=new SyncStatusPass(wire);
            try{new AssetReplica(pass,assets,new java.util.concurrent.locks.ReentrantLock(),()->pass.canSkipUnchangedFeed("assets")).sync("account");}catch(AlbumReplica.HttpFailure expected){}
            new AlbumAuthoritySync(pass,albums,()->"now",()->pass.canSkipUnchangedFeed("albums")).reconcile("account");
            new ClassificationAuthoritySync(pass::get,classifications,()->"now",()->pass.canSkipUnchangedFeed("classifications")).reconcile("account");
            equal(changed.equals("none")?1:2,requests.size(),"Only status plus changed domain feed: "+changed);
            equal("/v1/sync/status",requests.get(0),"Status shared across domains");
            if(!changed.equals("none"))check(requests.get(1).contains("/"+changed+"/")&&requests.get(1).contains("changes"),"Only changed domain requested");
        }
        equal(1,notModified[0],"Idle pass receives exactly one 304");
        SyncStatusPass afterWrite=new SyncStatusPass(wire);
        afterWrite.wrote("/v1/assets/authority/commands");
        check(!afterWrite.canSkipUnchangedFeed("assets"),"Cannot skip before status is loaded");
        afterWrite.get("/v1/sync/status");afterWrite.wrote("/v1/albums/commands");
        check(!afterWrite.canSkipUnchangedFeed("albums"),"Later Album write cannot use stale unchanged hint");
        check(afterWrite.canSkipUnchangedFeed("assets")&&afterWrite.canSkipUnchangedFeed("classifications"),"Local write does not fetch unrelated domains");
    }

    private static void startsPollingAndReconcilesImmediately() {
        Fixture fixture = new Fixture();
        equal(0, fixture.timer.pending(), "A new activity has nothing scheduled");
        fixture.schedule.start();
        equal(1, fixture.immediate, "Resuming reconciles immediately");
        equal(1, fixture.timer.pending(), "Resuming schedules one repeating pass");
        equal(ForegroundSchedule.INTERVAL_MILLIS, fixture.timer.intervals.get(0),
                "The repeating pass uses the foreground convergence target");
    }

    private static void repeatedResumeDoesNotDuplicateWork() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.schedule.start();
        fixture.schedule.start();
        equal(1, fixture.immediate, "A repeated resume does not queue extra passes");
        equal(1, fixture.timer.pending(), "A repeated resume does not schedule a second timer");
    }

    private static void pauseStopsPollingWithoutTouchingTheReplica() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.schedule.stop();
        equal(0, fixture.timer.pending(), "Pausing cancels the repeating pass");
        fixture.timer.fire(0);
        equal(0, fixture.repeating, "A pending tick after a pause does nothing");
        fixture.schedule.stop();
        equal(0, fixture.timer.pending(), "Pausing twice stays disarmed");
    }

    /**
     * The stale-generation defect.
     *
     * `start()` arms one generation and `restartAfter()` cancels it and arms the next. A
     * task already dequeued from the cancelled arm must not run merely because a *newer*
     * arm is currently armed — which is exactly what a shared `armed` boolean cannot see,
     * since that flag is true again by the time the old task fires.
     */
    private static void staleTimerFromAReplacedArmNeverRuns() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.schedule.restartAfter(fixture::invalidate);
        equal(2, fixture.timer.tasks.size(), "The replacement connection armed its own timer");
        equal(1, fixture.timer.cancelled, "and cancelled the replaced connection's timer");

        int before = fixture.repeating;
        fixture.timer.fire(0);
        equal(before, fixture.repeating,
                "A task from the replaced arm does not run after the re-arm");

        // The current generation still runs, so the check above is not passing because
        // ticking is broken outright.
        fixture.timer.fire(1);
        equal(before + 1, fixture.repeating, "The current arm's task still runs");

        // Firing the stale task again stays inert, and after a further re-arm the old
        // generations are still inert while only the newest one runs.
        fixture.timer.fire(0);
        equal(before + 1, fixture.repeating, "The stale task stays inert on a second firing");

        fixture.schedule.restartAfter(fixture::invalidate);
        fixture.timer.fire(0);
        fixture.timer.fire(1);
        equal(before + 1, fixture.repeating, "Two-arm-old tasks are inert after a further re-arm");
        fixture.timer.fire(2);
        equal(before + 2, fixture.repeating, "and only the newest arm's task runs");
    }

    /** A stop does not advance the generation, so the armed flag is what refuses this. */
    private static void staleTimerAfterStopNeverRuns() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.schedule.stop();
        fixture.timer.fire(0);
        equal(0, fixture.repeating, "A task from a stopped schedule does nothing");
    }

    private static void restartAfterLeavesExactlyOneArmedTimer() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.schedule.restartAfter(fixture::invalidate);
        equal(1, fixture.timer.pending(), "A replacement connection leaves one armed timer");
        // Repeating the replacement does not accumulate timers.
        fixture.schedule.restartAfter(fixture::invalidate);
        equal(1, fixture.timer.pending(), "and repeated replacements keep exactly one");
        equal(3, fixture.timer.tasks.size(), "each replacement arms exactly one timer");
    }

    /**
     * The ordering requirement.
     *
     * Arming runs the immediate pass synchronously, so the invalidation must happen first.
     * Otherwise the new connection's reconciliation would be invalidated by the clear that
     * followed it, and since it had started, nothing would be recorded as owed.
     */
    private static void restartAfterInvalidatesBeforeTheImmediatePass() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.events.clear();
        fixture.schedule.restartAfter(fixture::invalidate);
        equal(List.of("invalidate", "immediate"), fixture.events,
                "Invalidation runs before the replacement connection's immediate pass");
        equal(2, fixture.immediate, "The replacement connection reconciles against the new account");
    }

    /**
     * A refused immediate pass is owed, not dropped.
     *
     * While a pass is in flight single-flight refuses the request. Recording it as still
     * owed is what makes the replacement connection reconcile as soon as the slot frees,
     * rather than waiting for the next interval.
     */
    private static void refusedImmediatePassIsRunWhenTheCurrentPassFinishes() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        equal(1, fixture.immediate, "The first pass starts");

        // A pass is in flight, so the replacement connection's immediate request is refused.
        fixture.immediateRefused = true;
        fixture.schedule.restartAfter(fixture::invalidate);
        equal(1, fixture.immediate, "A refused immediate pass does not start concurrently");

        // The in-flight pass finishes and the slot frees; the owed pass must start then.
        fixture.immediateRefused = false;
        fixture.schedule.passFinished();
        equal(2, fixture.immediate, "The owed pass runs as soon as the slot frees");
        // Nothing stays owed, so a later completion does not double-request.
        fixture.schedule.passFinished();
        equal(2, fixture.immediate, "The owed pass is requested once");
    }

    /**
     * The generation boundary must be atomic, not merely narrow.
     *
     * Validating the generation and then releasing the lock before running the callback
     * leaves a window where a restart happens *after* the check and *before* the callback —
     * the old arm's pass then runs against the new connection. Holding the lock across the
     * callback closes it: a restart either completes before the tick or waits for it.
     *
     * The check observes that directly. While the repeating callback is suspended inside a
     * tick, a second thread attempts a replacement connection; under the correct contract
     * that attempt is blocked on the schedule's monitor, so its invalidation cannot have run
     * yet. The bounded wait only gives the second thread time to *reach* the monitor — the
     * assertion is about ordering, not about timing.
     */
    private static void aRestartCannotInterleaveBetweenTheCheckAndTheCallback() {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicBoolean invalidated = new AtomicBoolean();
        AtomicBoolean overlapping = new AtomicBoolean();
        Recorder timer = new Recorder();
        ForegroundSchedule schedule = new ForegroundSchedule(timer, () -> true, () -> {
            entered.countDown();
            try {
                if (!release.await(5, TimeUnit.SECONDS)) throw new AssertionError("callback not released");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        });
        schedule.start();

        Thread ticking = new Thread(() -> timer.fire(0), "album-schedule-tick");
        ticking.setDaemon(true);
        ticking.start();
        try {
            check(await(entered), "The repeating callback started");
            Thread restarting = new Thread(() -> {
                schedule.restartAfter(() -> invalidated.set(true));
                if (entered.getCount() == 0 && release.getCount() > 0) overlapping.set(true);
            }, "album-schedule-restart");
            restarting.setDaemon(true);
            restarting.start();
            // The restarting thread now blocks on the monitor the tick holds.
            restarting.join(1500);
            check(!invalidated.get(),
                    "A replacement connection cannot invalidate while a tick is between its check and its callback");
            release.countDown();
            restarting.join(5000);
            check(invalidated.get(), "The replacement connection completes once the tick finishes");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("interrupted");
        } finally {
            release.countDown();
            try {
                ticking.join(5000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /** Bounded wait, reported as a boolean so the check reads as an assertion. */
    private static boolean await(CountDownLatch latch) {
        try {
            return latch.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private static void owedPassIsDroppedWhenPollingStops() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.immediateRefused = true;
        fixture.schedule.restartAfter(fixture::invalidate);
        fixture.schedule.stop();
        fixture.immediateRefused = false;
        fixture.schedule.passFinished();
        equal(1, fixture.immediate, "A stopped schedule owes nothing, even with a pass outstanding");
    }

    private static void connectionReplacementFromTheBackgroundDoesNotStartPolling() {
        Fixture fixture = new Fixture();
        // Never resumed: configuring from the background must not begin polling.
        fixture.schedule.restartAfter(fixture::invalidate);
        equal(0, fixture.immediate, "A replacement connection from the background does not reconcile");
        equal(0, fixture.timer.pending(), "and schedules nothing");
        // A later resume still arms normally, so the background case is not "stuck off".
        fixture.schedule.start();
        equal(1, fixture.immediate, "and a later resume reconciles");
        equal(1, fixture.timer.pending(), "and arms its timer");
    }

    /**
     * Disconnect, then reconnect.
     *
     * A disconnect clears the replica and must not leave polling running against a
     * configuration that no longer exists. It is a stop, not a replacement: the schedule is
     * re-armed only when the activity is next foregrounded with a usable connection.
     */
    private static void disconnectThenReconnectResumesPolling() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.schedule.stop();
        equal(0, fixture.timer.pending(), "Disconnecting leaves no timer running");
        int afterDisconnect = fixture.immediate;
        fixture.schedule.stop();
        equal(afterDisconnect, fixture.immediate, "A repeated disconnect requests nothing");
        fixture.timer.fire(0);
        equal(0, fixture.repeating, "No pass runs while disconnected");

        fixture.schedule.start();
        equal(2, fixture.immediate, "A later resume reconciles against the current configuration");
        fixture.timer.fire(fixture.timer.tasks.size() - 1);
        equal(1, fixture.repeating, "and the loop runs again from there");
    }

    /** PERF-ALL-001 §8: no network means no failing passes; the reconnect runs the next one. */
    private static void offlineSuspendsPollingAndReconnectReconciles() {
        Fixture f = new Fixture();
        f.schedule.start();
        f.schedule.passFinished(false); f.schedule.passFinished(false);
        check(f.schedule.setOnline(false), "Losing the network is a change");
        equal(0, f.timer.pending(), "Offline cancels the repeating pass");
        f.schedule.wake();
        equal(0, f.timer.pending(), "A local write does not arm polling while offline");
        f.schedule.passFinished(false);
        equal(0, f.timer.pending(), "A failing pass does not re-arm or climb the back-off offline");
        f.schedule.stop(); f.schedule.start();
        equal(1, f.immediate, "Resuming while offline waits for the network");
        equal(0, f.timer.pending(), "Resuming while offline schedules nothing");
        check(!f.schedule.setOnline(false), "Offline twice is not a change");
        check(f.schedule.setOnline(true), "Reconnecting is a change");
        equal(2, f.immediate, "Reconnecting reconciles immediately");
        equal(1, f.timer.pending(), "Reconnecting arms exactly one repeating pass");
        equal(ForegroundSchedule.INTERVAL_MILLIS, f.timer.intervals.get(f.timer.intervals.size() - 1),
                "Reconnecting starts at the convergence target, not the back-off");
        f.schedule.stop(); f.schedule.setOnline(false); f.schedule.setOnline(true);
        equal(0, f.timer.pending(), "A reconnect in the background does not start polling");
        equal(2, f.immediate, "A reconnect in the background runs no pass");
    }
}
