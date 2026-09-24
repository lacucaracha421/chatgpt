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
