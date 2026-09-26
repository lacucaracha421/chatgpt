package com.lakomics.mobile;

/** One leading walk and one trailing walk for a burst of forced invalidations. */
final class PickerRefreshSchedule {
    /** Bump when the walk's projection changes, so a stored snapshot is walked again once. */
    private static final String SOURCE_FORMAT="picker-source-1";
    /**
     * What a complete walk's snapshot was built from: the server list generation plus the
     * local Album collections merged into it. The list generation moves with every Asset row,
     * the Asset, Album and Classification authority cursors, the legacy Classification
     * snapshot and Character publication, i.e. with everything the walk reads from the
     * server. Null when the server reports no generation: such a walk is never skipped.
     */
    static String sourceKey(String listGeneration, AlbumCollections albums) {
        if(listGeneration==null||listGeneration.isEmpty())return null;
        try {
            java.security.MessageDigest digest=java.security.MessageDigest.getInstance("SHA-256");
            digest.update(albums.names.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            digest.update((byte)0);
            digest.update(albums.byAsset.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder hex=new StringBuilder(SOURCE_FORMAT).append(':').append(listGeneration).append(':');
            for(byte b:digest.digest())hex.append(String.format("%02x",b));
            return hex.toString();
        } catch(java.security.NoSuchAlgorithmException unavailable) { return null; }
    }
    /** Whether a new walk would only rebuild the stored snapshot, so it can be skipped. */
    static boolean unchanged(String stored, String current, boolean ready) {
        return ready && current!=null && current.equals(stored);
    }
    static final long MIN_INTERVAL=5*60_000;
    private long last=-1;
    private boolean foreground, pending, running;
    void request(boolean force,long now) {
        if(force || last<0 || now-last>=15*60_000)pending=true;
    }
    void resume(){foreground=true;}
    void pause(){foreground=false;if(running){pending=true;last=-1;}}
    long delay(long now){return !foreground||!pending||running?-1:last<0?0:Math.max(0,MIN_INTERVAL-(now-last));}
    void started(long now){pending=false;running=true;last=now;}
    void finished(){running=false;}
    void reset(){last=-1;pending=false;running=false;}
}
