package com.lakomics.mobile;

import java.io.*;
import java.net.SocketTimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

public final class MediaTransferTest {
    private static int checks;
    private interface Checked { void run()throws Exception; }
    private static void check(boolean value){checks++;if(!value)throw new AssertionError("check "+checks);}
    private static void rejects(Checked action)throws Exception{try{action.run();throw new AssertionError("Expected rejection");}catch(IOException expected){checks++;}}
    private static long transfer(int count,long max,long expected)throws Exception{return MediaTransfer.copy(new ByteArrayInputStream(new byte[count]),new ByteArrayOutputStream(),max,expected,System.nanoTime()+MediaTransfer.DEADLINE_NANOS,null);}
    public static void main(String[] args)throws Exception {
        check(MediaTransfer.expectedLength(null,10)==-1);
        check(MediaTransfer.expectedLength(" 10 ",10)==10);
        for(String value:new String[]{"0","-1","+1","1, 1","abc","11","99999999999999999999999999"})rejects(()->MediaTransfer.expectedLength(value,10));
        check(transfer(10,10,10)==10);check(transfer(10,10,-1)==10);
        rejects(()->transfer(0,10,-1));rejects(()->transfer(0,10,0));
        rejects(()->transfer(9,10,10));rejects(()->transfer(10,10,9));rejects(()->transfer(11,10,-1));
        try{transfer(9,10,10);throw new AssertionError("truncated body must be retryable");}catch(EOFException expected){check(true);}
        ByteArrayOutputStream output=new ByteArrayOutputStream();
        InputStream chunks=new ByteArrayInputStream(new byte[11]){@Override public synchronized int read(byte[] b,int off,int len){return super.read(b,off,Math.min(len,4));}};
        rejects(()->MediaTransfer.copy(chunks,output,10,10,System.nanoTime()+MediaTransfer.DEADLINE_NANOS,null));check(output.size()==8);
        AtomicInteger reads=new AtomicInteger();InputStream unread=new InputStream(){public int read(){reads.incrementAndGet();return -1;}};
        try{MediaTransfer.copy(unread,output,10,-1,System.nanoTime()-1,null);throw new AssertionError("deadline");}catch(SocketTimeoutException expected){check(reads.get()==0);}
        try{MediaTransfer.copy(unread,output,10,-1,System.nanoTime()+MediaTransfer.DEADLINE_NANOS,()->{throw new IllegalStateException("cancelled");});throw new AssertionError("cancellation");}catch(IllegalStateException expected){check(reads.get()==0);}
        AtomicInteger cancellation=new AtomicInteger();
        try{MediaTransfer.copy(new ByteArrayInputStream(new byte[1]),output,10,-1,System.nanoTime()+MediaTransfer.DEADLINE_NANOS,()->{if(cancellation.incrementAndGet()==2)throw new IllegalStateException("cancelled after read");});throw new AssertionError("late cancellation");}catch(IllegalStateException expected){check(cancellation.get()==2);}
        System.out.println("MediaTransfer: "+checks+" checks passed");
    }
}
