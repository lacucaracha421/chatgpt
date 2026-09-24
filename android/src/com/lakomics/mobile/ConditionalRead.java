package com.lakomics.mobile;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

/** Bounded, connection-scoped conditional JSON reads. A 304 never becomes an empty document. */
final class ConditionalRead {
    static final class Reply {
        final int status;
        final String etag, body;
        Reply(int status, String etag, String body) { this.status=status; this.etag=etag; this.body=body; }
    }
    interface Fetch { Reply get(String etag) throws Exception; }
    interface Body { String read() throws Exception; }
    interface Failure { Exception create(int status); }
    /** Shared by CloudClient: a 304 has no JSON body and must not enter the error path. */
    static Reply response(int code,String etag,Body body,Failure failure)throws Exception {
        if(code==304)return new Reply(code,etag,null);
        if(code<200||code>=300)throw failure.create(code);
        return new Reply(code,etag,body.read());
    }
    private final Map<String,Reply> entries = new LinkedHashMap<>();
    private String scope = "";
    private long revision;
    synchronized void clear() { entries.clear(); scope=""; revision++; }
    String get(String connection, String path, Fetch fetch) throws Exception {
        final Reply previous;
        final long started;
        synchronized(this) {
            if(!scope.equals(connection)) { entries.clear(); scope=connection; revision++; }
            previous=entries.get(path); started=revision;
        }
        Reply reply=fetch.get(previous==null?null:previous.etag);
        if(reply.status==304) {
            if(previous==null) throw new IOException("304 without cached response");
            return previous.body;
        }
        if(reply.status!=200 || reply.body==null) throw new IOException("Invalid conditional response");
        synchronized(this) {
            if(started==revision) {
                entries.remove(path);
                if(reply.etag!=null && !reply.etag.isEmpty()) entries.put(path,reply);
                int size=0;for(Reply entry:entries.values())size+=entry.body.length();
                while(entries.size()>32 || size>4*1024*1024) {
                    String first=entries.keySet().iterator().next();size-=entries.remove(first).body.length();
                }
            }
        }
        return reply.body;
    }
}
