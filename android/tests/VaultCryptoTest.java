package com.lakomics.mobile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Opens the Rust-generated fixture; no Android runtime, test crypto, or mocks. */
public final class VaultCryptoTest {
    private static int checks;
    interface Checked { void run() throws Exception; }
    static void check(boolean value) { checks++;if(!value)throw new AssertionError("check "+checks); }
    static void rejects(Checked work) throws Exception {
        checks++;try{work.run();}catch(VaultCrypto.Invalid expected){return;}throw new AssertionError("accepted invalid input: "+checks);
    }
    static final class Bytes implements VaultCrypto.Source {
        final byte[] value;boolean closed;int reads;
        Bytes(byte[] value){this.value=value;}
        public long size(){return value.length;}
        public byte[] read(long offset,int length) throws IOException {
            reads++;
            if(closed || offset<0 || offset+length>value.length)throw new IOException();
            return Arrays.copyOfRange(value,(int)offset,(int)offset+length);
        }
        public void close(){closed=true;}
    }
    static int expected(long offset){return (int)(offset%251);}
    /**
     * One intercepted request as Android WebView's stream reader performs it: parse Range, call
     * skip(first byte) on the returned stream until it is consumed, then read with a 4 KiB buffer.
     * `webViewSkips=false` models a reader that relies on the stream being pre-positioned.
     * `stopAfter` models Chromium cancelling a request (the stream is closed early).
     */
    static byte[] request(byte[] object,byte[] master,VaultCrypto.Header header,String id,String range,boolean webViewSkips,long stopAfter) throws Exception {
        Bytes source=new Bytes(object);
        VaultCrypto.Reader reader=new VaultCrypto.Reader(source,master,header,id,1);
        VaultCrypto.Plan plan=VaultCrypto.plan(range,reader.length);
        check(plan.status==(range==null?200:206));
        check(plan.headers.get("Accept-Ranges").equals("bytes"));check(plan.headers.get("Cache-Control").equals("no-store"));
        check(plan.headers.get("Content-Length").equals(Long.toString(plan.count)));
        check(range==null?!plan.headers.containsKey("Content-Range"):plan.headers.get("Content-Range").equals("bytes "+plan.start+"-"+(plan.start+plan.count-1)+"/"+reader.length));
        check(!plan.reason.isEmpty()); // WebView ignores a custom status without a reason phrase.
        int before=source.reads;
        java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();
        try(VaultCrypto.Body body=new VaultCrypto.Body(reader)) {
            body.limit(plan.start,plan.count);
            check(body.available()==0); // WebView must not derive (int-limited) sizes from available().
            if(webViewSkips)for(long left=plan.start;left>0;){long n=body.skip(left);check(n>0);left-=n;}
            byte[] buffer=new byte[4096];
            for(int n;out.size()<stopAfter && (n=body.read(buffer,0,buffer.length))!=-1;)out.write(buffer,0,n);
            if(stopAfter==Long.MAX_VALUE)check(body.read(buffer,0,buffer.length)==-1);
        }
        check(source.closed);
        byte[] bytes=out.toByteArray();
        if(stopAfter==Long.MAX_VALUE){
            check(bytes.length==plan.count); // exactly Content-Length: never short, never long
            long chunks=(plan.start+plan.count-1)/VaultCrypto.CHUNK-plan.start/VaultCrypto.CHUNK+1;
            check(source.reads-before==chunks); // each chunk read and verified once, not once per 4 KiB read
        }
        for(int i=0;i<bytes.length;i++)if((bytes[i]&255)!=expected(plan.start+i))throw new AssertionError("byte "+(plan.start+i)+" of "+range);
        return bytes;
    }
    static void streaming(byte[] video,byte[] master,VaultCrypto.Header header,String id) throws Exception {
        long length=2L*VaultCrypto.CHUNK+37,all=Long.MAX_VALUE;
        // Chromium's media loader: probe from 0 and cancel, jump near the end (moov atom), resume
        // mid-object across a chunk boundary, re-request from a later position, then bounded and suffix ranges.
        for(boolean skips:new boolean[]{true,false}) {
            check(request(video,master,header,id,"bytes=0-",skips,70000).length>=70000);
            request(video,master,header,id,"bytes="+(length-200)+"-",skips,all);
            request(video,master,header,id,"bytes=65530-",skips,all);
            request(video,master,header,id,"bytes=70000-",skips,all);
            request(video,master,header,id,"bytes=0-",skips,all);
            request(video,master,header,id,"bytes=131071-131073",skips,all);
            request(video,master,header,id,"bytes=100-199",skips,all);
            request(video,master,header,id,"bytes=-10",skips,all);
            request(video,master,header,id,null,skips,all);
        }
        VaultCrypto.Plan past=VaultCrypto.plan("bytes="+length+"-",length);
        check(past.status==416 && past.headers.get("Content-Range").equals("bytes */"+length) && !past.headers.containsKey("Content-Length"));
        // Skipping never decrypts, and never moves past the declared end.
        Bytes source=new Bytes(video);
        try(VaultCrypto.Body body=new VaultCrypto.Body(new VaultCrypto.Reader(source,master,header,id,1))) {
            body.limit(10,20);int reads=source.reads;
            check(body.skip(Long.MAX_VALUE)==30);check(source.reads==reads);check(body.read()==-1);
        }
        // Revocation (lock, or WebView closing the request) ends the stream and wipes the cached chunk.
        try(VaultCrypto.Body body=new VaultCrypto.Body(new VaultCrypto.Reader(new Bytes(video),master,header,id,1))) {
            check(body.read()==expected(0));
            body.revoke();
            boolean refused=false;try{body.read();}catch(IOException expected){refused=true;}check(refused);
        }
        // A damaged middle chunk is never served, not even the part before the damage.
        byte[] damaged=video.clone();damaged[VaultCrypto.HEADER+VaultCrypto.CHUNK+VaultCrypto.TAG+500]^=1;
        try(VaultCrypto.Body body=new VaultCrypto.Body(new VaultCrypto.Reader(new Bytes(damaged),master,header,id,1))) {
            body.limit(VaultCrypto.CHUNK,10);check(body.skip(VaultCrypto.CHUNK)==VaultCrypto.CHUNK);
            boolean refused=false;try{body.read(new byte[10],0,10);}catch(IOException expected){refused=true;}check(refused);
        }
    }
    public static void main(String[] args) throws Exception {
        Path root=Paths.get(System.getProperty("vault.fixtures","android/tests/fixtures/private-vault"));
        Path dir=root.resolve(".lakomics-vault");
        Map<String,Object> fixture=VaultCrypto.json(Files.readAllBytes(root.resolve("fixture.json")),4096);
        byte[] headerBytes=Files.readAllBytes(dir.resolve("vault.json"));
        VaultCrypto.Header header=new VaultCrypto.Header(headerBytes);
        String password=VaultCrypto.string(fixture,"password"),recovery=VaultCrypto.string(fixture,"recoveryKey");
        byte[] master=header.unlock(password,false),recovered=header.unlock(" \t"+recovery.substring(0,32).toUpperCase(Locale.ROOT)+"-\r\n"+recovery.substring(32),true);
        check(Arrays.equals(master,recovered));
        rejects(()->header.unlock("wrong password",false));
        rejects(()->header.unlock(recovery.substring(1),true));
        rejects(()->header.unlock(recovery+"\u00a0",true)); // PC ignores only ASCII separators.
        rejects(()->header.unlock(recovery.replace('2','3'),true));
        String indexId=VaultCrypto.INDEX_ID,videoId="03030303030303030303030303030303";
        byte[] index;
        try(VaultCrypto.Reader reader=new VaultCrypto.Reader(new Bytes(Files.readAllBytes(dir.resolve("index.bin"))),master,header,indexId,2)) {
            index=reader.range(0,(int)reader.length);
        }
        List<VaultCrypto.Item> items=VaultCrypto.index(index);
        check(items.size()==2);check(items.get(0).title.equals("사용자 지정 제목"));
        check(items.get(0).kind.equals("image"));check(items.get(0).mime.equals("image/png"));
        check(items.get(0).thumbnail.equals("02020202020202020202020202020202"));
        check(items.get(0).width==1 && items.get(0).height==1);
        for(String id:new String[]{items.get(0).object,items.get(0).thumbnail}) {
            try(VaultCrypto.Reader reader=new VaultCrypto.Reader(new Bytes(Files.readAllBytes(dir.resolve("objects").resolve(id))),master,header,id,1)) {
                check(VaultCrypto.thumbnailMime(reader.range(0,16)).equals("image/png"));
                byte[] png=reader.range(0,(int)reader.length);
                for(int offset=8;offset<png.length;){
                    int size=java.nio.ByteBuffer.wrap(png,offset,4).getInt();
                    java.util.zip.CRC32 crc=new java.util.zip.CRC32();crc.update(png,offset+4,size+4);
                    check(crc.getValue()==(java.nio.ByteBuffer.wrap(png,offset+8+size,4).getInt()&0xffffffffL));offset+=size+12;
                }
            }
        }
        byte[] video=Files.readAllBytes(dir.resolve("objects").resolve(videoId));
        try(VaultCrypto.Reader reader=new VaultCrypto.Reader(new Bytes(video),master,header,videoId,1)) {
            check(reader.length==2*VaultCrypto.CHUNK+37);
            for(int[] range:new int[][]{{0,17},{65529,30},{131063,46},{131100,100},{131109,5}}) {
                byte[] bytes=reader.range(range[0],range[1]);
                check(bytes.length==Math.min(range[1],Math.max(0,reader.length-range[0])));
                for(int i=0;i<bytes.length;i++)check((bytes[i]&255)==(range[0]+i)%251);
            }
            reader.revoke();rejects(()->reader.range(0,1));
        }
        byte[] damaged=video.clone();damaged[VaultCrypto.HEADER+9]^=1;
        try(VaultCrypto.Reader reader=new VaultCrypto.Reader(new Bytes(damaged),master,header,videoId,1)) {
            rejects(()->reader.range(0,1));
        }
        byte[] damagedLast=video.clone();damagedLast[damagedLast.length-1]^=1;
        rejects(()->new VaultCrypto.Reader(new Bytes(damagedLast),master,header,videoId,1));
        rejects(()->new VaultCrypto.Reader(new Bytes(Arrays.copyOf(video,video.length-1)),master,header,videoId,1));
        rejects(()->new VaultCrypto.Reader(new Bytes(Arrays.copyOf(video,VaultCrypto.HEADER+VaultCrypto.CHUNK+VaultCrypto.TAG)),master,header,videoId,1));
        rejects(()->new VaultCrypto.Reader(new Bytes(video),master,header,items.get(0).object,1));
        rejects(()->new VaultCrypto.Reader(new Bytes(video),master,header,videoId,2));
        byte[] reordered=video.clone();
        System.arraycopy(video,VaultCrypto.HEADER+VaultCrypto.CHUNK+VaultCrypto.TAG,reordered,VaultCrypto.HEADER,VaultCrypto.CHUNK+VaultCrypto.TAG);
        try(VaultCrypto.Reader reader=new VaultCrypto.Reader(new Bytes(reordered),master,header,videoId,1)){rejects(()->reader.range(0,1));}
        byte[] badVersion=video.clone();badVersion[4]=2;
        rejects(()->new VaultCrypto.Reader(new Bytes(badVersion),master,header,videoId,1));
        try(VaultCrypto.Reader reader=new VaultCrypto.Reader(new Bytes(Files.readAllBytes(root.resolve("unknown-index.bin"))),master,header,indexId,2)) {
            rejects(()->VaultCrypto.index(reader.range(0,(int)reader.length)));
        }
        String indexText=new String(index,StandardCharsets.UTF_8);
        rejects(()->VaultCrypto.index(VaultCrypto.utf8(indexText.replace(items.get(0).object,"../../etc/passwd"))));
        for(String id:new String[]{"abc","0303030303030303030303030303030G","AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","../030303030303030303030303030303","03030303030303030303030303030303/"})rejects(()->VaultCrypto.objectId(id));
        byte[] extended=Arrays.copyOf(video,video.length+1);
        rejects(()->new VaultCrypto.Reader(new Bytes(extended),master,header,videoId,1));
        byte[] saltChanged=video.clone();saltChanged[6]^=1;
        rejects(()->new VaultCrypto.Reader(new Bytes(saltChanged),master,header,videoId,1));
        rejects(()->new VaultCrypto.Reader(new Bytes(new byte[VaultCrypto.HEADER+15]),master,header,videoId,1));
        String headerText=new String(headerBytes,StandardCharsets.UTF_8);
        VaultCrypto.Header otherVault=new VaultCrypto.Header(VaultCrypto.utf8(headerText.replace("00112233-4455-6677-8899-aabbccddeeff","10112233-4455-6677-8899-aabbccddeeff")));
        rejects(()->new VaultCrypto.Reader(new Bytes(video),master,otherVault,videoId,1));
        for(String count:new String[]{"599999","20000001","0","600000.0"})rejects(()->new VaultCrypto.Header(VaultCrypto.utf8(headerText.replace("600000",count))));
        rejects(()->new VaultCrypto.Header(VaultCrypto.utf8(headerText.replace("pbkdf2-hmac-sha256","argon2id"))));
        rejects(()->new VaultCrypto.Header(VaultCrypto.utf8(headerText.replace("\"formatVersion\": 1","\"formatVersion\": 99"))));
        check(Arrays.equals(master,new VaultCrypto.Header(VaultCrypto.utf8(headerText.replaceFirst("\\{","{\"unknown\":{\"version\":3},"))).unlock(recovery,true)));
        String session="abcdefabcdefabcdefabcdefabcdefab",path="/vault/"+session+"/"+videoId;
        check(VaultCrypto.route(path,session).equals(videoId));
        for(String bad:new String[]{path+"?x",path+"/",path.replace("/vault/","/vault/%2e%2e/"),path.replace(session,videoId),path.replace(videoId,videoId.toUpperCase(Locale.ROOT)+"A")})rejects(()->VaultCrypto.route(bad,session));
        rejects(()->VaultCrypto.route(path,null));
        check(Arrays.equals(VaultCrypto.range(null,100),new long[]{0,100}));
        check(Arrays.equals(VaultCrypto.range("bytes=60-199",100),new long[]{60,40}));
        check(Arrays.equals(VaultCrypto.range("bytes=60-",100),new long[]{60,40}));
        check(Arrays.equals(VaultCrypto.range("bytes=-200",100),new long[]{0,100}));
        for(String bad:new String[]{"bytes=100-","bytes=90-89","bytes=-0","bytes=0-1,5-6","bytes=9223372036854775808-","bytes=0-+1"})rejects(()->VaultCrypto.range(bad,100));
        rejects(()->VaultCrypto.range("bytes=0-",0));
        streaming(video,master,header,videoId);
        VaultCrypto.wipe(master);VaultCrypto.wipe(recovered);VaultCrypto.wipe(index);
        check(Arrays.equals(master,new byte[32]));
        System.out.println("VaultCryptoTest: "+checks+" checks passed (Rust golden fixture)");
    }
}
