package com.lakomics.mobile;

import java.io.*;
import java.net.SocketTimeoutException;
import java.util.concurrent.TimeUnit;

/** Streaming integrity rules for an individual media response, independent of ticket retries. */
final class MediaTransfer {
    static final long DEADLINE_NANOS=TimeUnit.SECONDS.toNanos(180);
    static long expectedLength(String header,long max)throws IOException {
        if(max<=0)throw new IOException("Invalid transfer limit");
        if(header==null)return -1;
        String value=header.trim();
        if(!value.matches("[0-9]+"))throw new IOException("Invalid media length");
        long size;try{size=Long.parseLong(value);}catch(NumberFormatException e){throw new IOException("Invalid media length");}
        if(size<=0||size>max)throw new IOException("Media length exceeds transfer bounds");
        return size;
    }
    static long copy(InputStream in,OutputStream out,long max,long expected,long deadline,Runnable cancellation)throws IOException {
        if(max<=0||expected==0||expected>max||expected< -1)throw new IOException("Invalid transfer bounds");
        byte[] buffer=new byte[32768];long count=0;
        while(true){
            check(deadline,cancellation);
            int n=in.read(buffer);
            check(deadline,cancellation);
            if(n==-1)break;
            if(n==0)continue;
            if(n>max-count||(expected>=0&&n>expected-count))throw new IOException("Media exceeds transfer bounds");
            out.write(buffer,0,n);count+=n;
        }
        if(count==0||(expected>=0&&count!=expected))throw new EOFException("Incomplete media response");
        return count;
    }
    private static void check(long deadline,Runnable cancellation)throws SocketTimeoutException {
        if(cancellation!=null)cancellation.run();
        if(System.nanoTime()-deadline>=0)throw new SocketTimeoutException("Media transfer deadline exceeded");
    }
}
