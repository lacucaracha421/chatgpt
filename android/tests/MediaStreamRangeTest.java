package com.lakomics.mobile;

import java.util.Map;

public final class MediaStreamRangeTest {
    private static int checks;
    private interface Checked { void run()throws Exception; }
    private static void check(boolean value){checks++;if(!value)throw new AssertionError("check "+checks);}
    private static void mismatch(Checked action)throws Exception{try{action.run();throw new AssertionError("Expected mismatch");}catch(MediaStreamRange.Mismatch expected){checks++;}}
    private static void unsupported(String header)throws Exception{try{MediaStreamRange.parse(header);throw new AssertionError("Expected unsupported: "+header);}catch(MediaStreamRange.Unsupported expected){checks++;}}
    private static MediaStreamRange.Request range(String header)throws Exception{return MediaStreamRange.parse(header);}
    public static void main(String[] args)throws Exception {
        // Parsing: the single-range forms Chromium's media loader sends, forwarded unchanged.
        check(MediaStreamRange.parse(null)==null);
        check(range("bytes=0-").header().equals("bytes=0-")&&range("bytes=0-").kind().equals("open"));
        check(range("bytes=5-9").header().equals("bytes=5-9")&&range("bytes=5-9").kind().equals("bounded"));
        check(range(" bytes=7-7 ").header().equals("bytes=7-7"));
        check(range("bytes=-500").header().equals("bytes=-500")&&range("bytes=-500").kind().equals("suffix"));
        for(String bad:new String[]{"","bytes=","bytes=-","bytes=-0","bytes=9-5","bytes=1-2,4-5","items=0-","bytes = 0-","bytes=a-","bytes=0-1\r\nX: y","bytes=1234567890123456789-"})unsupported(bad);

        // 206 replies must describe exactly the requested bytes of the known object.
        MediaStreamRange.Plan plan=MediaStreamRange.validate(range("bytes=0-"),206,"bytes 0-99/100","100",100);
        check(plan.status==206&&plan.start==0&&plan.count==100&&plan.total==100&&plan.end()==100);
        Map<String,String> headers=plan.headers();
        check("bytes 0-99/100".equals(headers.get("Content-Range"))&&"100".equals(headers.get("Content-Length")));
        check("bytes".equals(headers.get("Accept-Ranges"))&&"no-store".equals(headers.get("Cache-Control"))&&"nosniff".equals(headers.get("X-Content-Type-Options")));
        plan=MediaStreamRange.validate(range("bytes=40-"),206,"bytes 40-99/100",null,0);
        check(plan.start==40&&plan.count==60&&plan.total==100);
        plan=MediaStreamRange.validate(range("bytes=10-19"),206,"bytes 10-19/100","10",100);
        check(plan.start==10&&plan.count==10&&"bytes 10-19/100".equals(plan.headers().get("Content-Range")));
        // A bounded request past the end is clamped by storage to the last byte.
        plan=MediaStreamRange.validate(range("bytes=90-500"),206,"bytes 90-99/100","10",100);
        check(plan.start==90&&plan.count==10);
        plan=MediaStreamRange.validate(range("bytes=-30"),206,"bytes 70-99/100","30",100);
        check(plan.start==70&&plan.count==30);
        plan=MediaStreamRange.validate(range("bytes=-300"),206,"bytes 0-99/100","100",100);
        check(plan.start==0&&plan.count==100);
        mismatch(()->MediaStreamRange.validate(range("bytes=40-"),206,"bytes 0-99/100","100",100));
        mismatch(()->MediaStreamRange.validate(range("bytes=40-"),206,"bytes 40-98/100","59",100));
        mismatch(()->MediaStreamRange.validate(range("bytes=10-19"),206,"bytes 10-29/100","20",100));
        mismatch(()->MediaStreamRange.validate(range("bytes=0-"),206,"bytes 0-99/100","99",100));
        mismatch(()->MediaStreamRange.validate(range("bytes=0-"),206,"bytes 0-99/100","100",101));
        mismatch(()->MediaStreamRange.validate(range("bytes=0-"),206,null,"100",100));
        mismatch(()->MediaStreamRange.validate(range("bytes=0-"),206,"bytes 0-99/*","100",0));
        mismatch(()->MediaStreamRange.validate(range("bytes=0-"),206,"bytes 0-100/100","101",0));
        mismatch(()->MediaStreamRange.validate(range("bytes=0-"),206,"bytes 5-4/100",null,0));
        mismatch(()->MediaStreamRange.validate(range("bytes=0-"),206,"bytes 0-99/100","-1",0));
        mismatch(()->MediaStreamRange.validate(range("bytes=100-"),206,"bytes 99-99/100","1",100));
        mismatch(()->MediaStreamRange.validate(range("bytes=-30"),206,"bytes 60-99/100","40",100));

        // 200 replies: a full request, or a ranged request covering the whole object.
        plan=MediaStreamRange.validate(null,200,null,"100",100);
        check(plan.status==200&&plan.count==100&&!plan.headers().containsKey("Content-Range")&&"100".equals(plan.headers().get("Content-Length")));
        plan=MediaStreamRange.validate(range("bytes=0-"),200,null,"100",0);
        check(plan.status==206&&plan.start==0&&plan.count==100&&"bytes 0-99/100".equals(plan.headers().get("Content-Range")));
        mismatch(()->MediaStreamRange.validate(range("bytes=10-"),200,null,"100",100));
        mismatch(()->MediaStreamRange.validate(null,200,null,null,100));
        mismatch(()->MediaStreamRange.validate(null,200,null,"99",100));
        mismatch(()->MediaStreamRange.validate(null,206,"bytes 10-99/100","90",100));
        plan=MediaStreamRange.validate(null,206,"bytes 0-99/100","100",100);
        check(plan.status==200&&plan.count==100);
        mismatch(()->MediaStreamRange.validate(range("bytes=0-"),204,null,"0",100));

        // 416 bookkeeping.
        check(MediaStreamRange.unsatisfiedTotal("bytes */100")==100&&MediaStreamRange.unsatisfiedTotal("bytes 0-1/100")==-1&&MediaStreamRange.unsatisfiedTotal(null)==-1);
        check("bytes */100".equals(MediaStreamRange.unsatisfiable(100).get("Content-Range"))&&!MediaStreamRange.unsatisfiable(0).containsKey("Content-Range"));
        System.out.println("MediaStreamRange: "+checks+" checks passed");
    }
}
