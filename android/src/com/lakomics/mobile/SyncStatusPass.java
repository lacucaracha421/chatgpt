package com.lakomics.mobile;

/** Shares one status response (including failure) across the three receive lanes of a pass. */
final class SyncStatusPass implements AlbumReplica.Transport {
    private final AlbumReplica.Transport transport;
    private String status;
    private Exception failure;
    private boolean loaded;
    private final java.util.Set<String> written=new java.util.HashSet<>();
    void wrote(String path){
        // A write before discovery is already reflected by its later status read.
        if(loaded)for(String domain:new String[]{"assets","albums","classifications"})
            if(path.startsWith("/v1/"+domain+"/"))written.add(domain);
    }
    SyncStatusPass(AlbumReplica.Transport transport) { this.transport=transport; }
    /**
     * The Library-relevant part of a status document, for change detection.
     *
     * A status read with this device's exchange token also carries `exchange.revision`,
     * which moves on every file transfer. Transfers are not Library changes, so they must not
     * mark the pass changed (picker refresh, metadata invalidation). An unreadable body is
     * compared as-is.
     */
    static String libraryStatus(String status) {
        try {
            Object parsed=Json.parse(status);
            if(!(parsed instanceof java.util.Map))return status;
            java.util.Map<?,?> copy=new java.util.LinkedHashMap<>((java.util.Map<?,?>)parsed);
            copy.remove("exchange");
            return String.valueOf(copy);
        } catch(RuntimeException unreadable) { return status; }
    }
    public String get(String path) throws Exception {
        if(!path.equals("/v1/sync/status")) return transport.get(path);
        if(!loaded) {
            loaded=true;
            try { status=transport.get(path); } catch(Exception e) { failure=e; }
        }
        if(failure!=null)throw failure;
        return status;
    }
    boolean canSkipUnchangedFeed(String domain) {
        return loaded && failure==null && !written.contains(domain);
    }
}
