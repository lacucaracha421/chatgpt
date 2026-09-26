package com.lakomics.mobile;

import java.util.*;
import java.util.concurrent.locks.Lock;

/** Read-only canonical lifecycle replica. Network is always outside the database lock. */
final class AssetReplica {
    interface Storage {
        Snapshot readAssets(String scope);
        /**
         * The adopted authority identity and cursor without the rows, or null.
         *
         * Idle paths (the unchanged-cursor check, outbox delivery, "is it adopted") need only
         * this. A full {@link #readAssets} parses every Asset row (~9,300 on the tablet), so
         * a real database overrides this with a single-row read.
         */
        default Header readAssetHeader(String scope) { return readAssets(scope); }
        void replaceAssets(String scope, Snapshot snapshot);
        void clearAssets();
    }
    static class Header {
        final String library;
        final long epoch, cursor;
        Header(String library, long epoch, long cursor) {
            this.library=library; this.epoch=epoch; this.cursor=cursor;
        }
    }
    static final class Snapshot extends Header {
        final Map<String, Map<String,Object>> rows;
        Snapshot(String library, long epoch, long cursor, Map<String,Map<String,Object>> rows) {
            super(library, epoch, cursor);
            this.rows=Collections.unmodifiableMap(new TreeMap<>(rows));
        }
    }
    private final AlbumReplica.Transport transport;
    private final Storage storage;
    private final Lock lock;
    private final java.util.function.BooleanSupplier skipUnchanged;
    AssetReplica(AlbumReplica.Transport transport, Storage storage, Lock lock) {
        this(transport, storage, lock, () -> false);
    }
    AssetReplica(AlbumReplica.Transport transport, Storage storage, Lock lock,
                 java.util.function.BooleanSupplier skipUnchanged) {
        this.transport=transport; this.storage=storage; this.lock=lock; this.skipUnchanged=skipUnchanged;
    }
    private Snapshot read(String scope) {
        lock.lock(); try {return storage.readAssets(scope);} finally {lock.unlock();}
    }
    private Header header(String scope) {
        lock.lock(); try {return storage.readAssetHeader(scope);} finally {lock.unlock();}
    }
    private void save(String scope, Snapshot snapshot) {
        lock.lock(); try {storage.replaceAssets(scope,snapshot);} finally {lock.unlock();}
    }
    boolean sync(String scope) throws Exception {
        AlbumReplica.Status status=AlbumReplica.parseStatus(Json.parse(transport.get("/v1/sync/status")));
        AlbumReplica.Domain domain=null;
        for(AlbumReplica.Domain d:status.domains) if(d.name.equals("assets")) {
            if(domain!=null) throw new IllegalArgumentException("Ambiguous Asset domain");
            domain=d;
        }
        // The cursor comparison needs only the header; the rows are read when they are applied.
        Header head=header(scope);
        if(domain==null) {
            if(head!=null) throw new IllegalArgumentException("Adopted Asset domain disappeared");
            return false;
        }
        if(domain.contractVersion!=1) throw new IllegalArgumentException("Unsupported Asset contract");
        identity(head,domain);
        if(head==null) {baseline(scope,domain);return true;}
        if(head.cursor==domain.cursor && skipUnchanged.getAsBoolean())return false;
        Snapshot local=read(scope);
        identity(local,domain);
        if(local==null) {baseline(scope,domain);return true;}
        boolean changed=false;
        try {
            for(int page=0;page<2000;page++) {
                Map<String,Object> response=object(Json.parse(transport.get(path(domain,"changes")+"&after="+local.cursor+"&limit=200")));
                envelope(response,domain);
                long ceiling=number(response,"cursor");
                if(ceiling<local.cursor) throw new IllegalArgumentException("Cursor moved backward");
                List<?> items=list(response,"items");if(items.size()>200)throw new IllegalArgumentException("Page bound");
                long cursor=local.cursor;Map<String,Map<String,Object>> rows=new TreeMap<>(local.rows);
                for(Object item:items) {
                    Map<String,Object> change=object(item);
                    if(number(change,"sequence")!=++cursor||cursor>ceiling)throw new IllegalArgumentException("Change gap");
                    Map<String,Object> projection=projection(change.get("asset"));
                    String id=(String)projection.get("assetId");
                    if(!id.equals(change.get("assetId")))throw new IllegalArgumentException("Delta mismatch");
                    Map<String,Object> old=rows.get(id);
                    if(old!=null && (number(projection,"entityRevision")<=number(old,"entityRevision") || (old.get("lifecycle").equals("tombstoned")&&!projection.get("lifecycle").equals("tombstoned"))))throw new IllegalArgumentException("Invalid lifecycle revision");
                    rows.put(id,projection);
                }
                boolean more=bool(response,"hasMore");
                if(number(response,"nextAfter")!=cursor||more!=(cursor<ceiling)||more&&items.isEmpty())throw new IllegalArgumentException("Invalid continuation");
                if(!items.isEmpty()) {local=new Snapshot(domain.libraryId,domain.epoch,cursor,rows);save(scope,local);changed=true;}
                if(!more)return changed;
            }
            throw new IllegalArgumentException("Change traversal bound");
        } catch(AlbumReplica.HttpFailure failure) {
            if(!AlbumReplica.CODE_CURSOR_EXPIRED.equals(AlbumReplica.mapFailure(failure.status,failure.body,false).code))throw failure;
            baseline(scope,domain);return true;
        }
    }
    private void baseline(String scope, AlbumReplica.Domain domain) throws Exception {
        Map<String,Map<String,Object>> rows=new TreeMap<>();String after="";Long cursor=null;
        for(int page=0;page<2000;page++) {
            String request=path(domain,"baseline")+"&limit=500"+(after.isEmpty()?"":"&after="+after)+(cursor==null?"":"&expectedCursor="+cursor);
            Map<String,Object> response=object(Json.parse(transport.get(request)));envelope(response,domain);
            long current=number(response,"cursor");if(current<0||cursor!=null&&current!=cursor)throw new IllegalArgumentException("Baseline changed");cursor=current;
            List<?> items=list(response,"items");if(items.size()>500)throw new IllegalArgumentException("Page bound");
            String previous=after;
            for(Object item:items) {Map<String,Object> p=projection(item);String id=(String)p.get("assetId");if(id.compareTo(previous)<=0||rows.put(id,p)!=null||rows.size()>250000)throw new IllegalArgumentException("Invalid baseline order");previous=id;}
            boolean more=bool(response,"hasMore");Object next=response.get("nextAfter");
            if(!more) {if(next!=null)throw new IllegalArgumentException("Invalid final page");save(scope,new Snapshot(domain.libraryId,domain.epoch,cursor,rows));return;}
            if(items.isEmpty()||!previous.equals(next))throw new IllegalArgumentException("Invalid baseline continuation");after=previous;
        }
        throw new IllegalArgumentException("Baseline traversal bound");
    }
    private static void identity(Header local,AlbumReplica.Domain domain) {
        if(local!=null && (!local.library.equals(domain.libraryId)||local.epoch!=domain.epoch))
            throw new IllegalArgumentException("Asset authority identity changed");
    }
    private static String path(AlbumReplica.Domain domain,String kind) {return "/v1/assets/authority/"+kind+"?libraryId="+domain.libraryId+"&epoch="+domain.epoch;}
    private static void envelope(Map<String,Object> response,AlbumReplica.Domain domain) {
        if(!domain.libraryId.equals(response.get("libraryId"))||number(response,"epoch")!=domain.epoch||number(response,"contractVersion")!=1)throw new IllegalArgumentException("Envelope mismatch");
    }
    static Map<String,Object> projection(Object raw) {
        Map<String,Object> p=object(raw);Object id=p.get("assetId"),life=p.get("lifecycle"),sha=p.get("sha256"),size=p.get("sizeBytes");
        if(!(id instanceof String)||!((String)id).matches("[A-Za-z0-9_-]{1,128}")||!Arrays.asList("normal","trash","tombstoned").contains(life)||number(p,"entityRevision")<1||sha!=null&&(!(sha instanceof String)||!((String)sha).matches("[a-f0-9]{64}"))||size!=null&&number(p,"sizeBytes")<0)throw new IllegalArgumentException("Invalid Asset projection");
        return Collections.unmodifiableMap(new LinkedHashMap<>(p));
    }
    @SuppressWarnings("unchecked") static Map<String,Object> object(Object v) {if(!(v instanceof Map))throw new IllegalArgumentException("Object required");return (Map<String,Object>)v;}
    private static List<?> list(Map<String,Object> v,String key) {Object x=v.get(key);if(!(x instanceof List))throw new IllegalArgumentException("Array required");return (List<?>)x;}
    private static long number(Map<String,Object> v,String key) {Object n=v.get(key);if(!(n instanceof Long)||((Long)n)<0)throw new IllegalArgumentException("Integer required");return (Long)n;}
    private static boolean bool(Map<String,Object> v,String key) {Object b=v.get(key);if(!(b instanceof Boolean))throw new IllegalArgumentException("Boolean required");return (Boolean)b;}
}
