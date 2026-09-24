package com.lakomics.mobile;

/** One leading walk and one trailing walk for a burst of forced invalidations. */
final class PickerRefreshSchedule {
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
