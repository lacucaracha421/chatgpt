package com.lakomics.mobile;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.CharacterCodingException;
import java.util.*;

/** Kone's typed SEF boundary. Never expose undecoded bytes or response text to the app page. */
final class SomiSef {
    private static final String ALPHABET="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
    static final class Stamp { final long seconds; final int nanos; Stamp(long s,int n){seconds=s;nanos=n;} }
    static final class Id { final byte[] bytes; Id(byte[] b){bytes=b;} }
    static final class Union { final String name; final Object value; Union(String n,Object v){name=n;value=v;} }
    static Object field(Object v,Object key){return v instanceof Map?((Map<?,?>)v).get(key):null;}
    static Object field(Object v,int key){return field(v,Long.valueOf(key));}
    static String text(Object v){return v instanceof String?(String)v:"";}
    static long number(Object v){return v instanceof Number?((Number)v).longValue():0;}
    static List<?> items(Object v){return v instanceof List?(List<?>)v:Collections.emptyList();}
    static String id(Object v){if(!(v instanceof Id))throw invalid();return idText(((Id)v).bytes);}
    static String idText(byte[] bytes){
        char[] out=new char[22];
        for(int d=0;d<22;d++){int n=0;for(int k=0;k<6;k++){int bit=d*6+k;if(bit<128)n|=((bytes[bit/8]>>(bit%8))&1)<<k;}out[21-d]=ALPHABET.charAt(n);}return new String(out);
    }
    static byte[] idBytes(String text){
        if(text==null||!text.matches("[A-Za-z0-9_-]{22}"))throw invalid();byte[] out=new byte[16];
        for(int d=0;d<22;d++){int n=ALPHABET.indexOf(text.charAt(21-d));for(int k=0;k<6;k++){int bit=d*6+k,v=(n>>k)&1;if(bit<128)out[bit/8]|=v<<(bit%8);else if(v!=0)throw invalid();}}return out;
    }
    static IllegalArgumentException invalid(){return new IllegalArgumentException("소미 응답 형식 오류");}
    private static String utf8(byte[] b){try{return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(b)).toString();}catch(CharacterCodingException e){throw invalid();}}
    private static final class Desc {int type;Desc child;}
    private final byte[] bytes;private int at,elements;
    private SomiSef(byte[] b){bytes=b;}
    private byte[] take(int n){if(n<0||n>bytes.length-at)throw invalid();byte[] b=Arrays.copyOfRange(bytes,at,at+n);at+=n;return b;}
    private int read(){if(at>=bytes.length)throw invalid();return bytes[at++]&255;}
    private int readLength(int limit){long n=0;for(int i=0;i<5;i++){int b=read();n=n*128+(b&127);if(n>limit)throw invalid();if(b<128)return (int)n;n++;}throw invalid();}
    private Desc desc(int depth){if(depth>32)throw invalid();Desc d=new Desc();d.type=read();if(d.type==3||d.type==64)d.child=desc(depth+1);return d;}
    private Object value(int depth){Desc d=desc(depth);if(d.type==2)throw invalid();return payload(d,depth);}
    private long integer(int width,boolean signed){byte[] b=take(width);long n=signed&&b[width-1]<0?-1L:0;for(int i=width-1;i>=0;i--)n=(n<<8)|(b[i]&255);return n;}
    private Object payload(Desc d,int depth){
        if(depth>32||++elements>262144)throw invalid();int t=d.type;
        if(t==2)return value(depth);
        if(t==1){int b=read();if(b>1)throw invalid();return b==1;}
        if(t==3){int b=read();if(b==0)return null;if(b==1)return payload(d.child,depth);throw invalid();}
        if(t>=16&&t<=19)return integer(1<<(t-16),false);
        if(t>=24&&t<=27)return integer(1<<(t-24),true);
        switch(t){
            case 32:return (double)Float.intBitsToFloat((int)integer(4,false));
            case 33:return Double.longBitsToDouble(integer(8,false));
            case 48:case 49:{byte[] b=take(readLength(5*1024*1024));return t==48?b:utf8(b);}
            case 64:{int n=readLength(131072);List<Object> a=new ArrayList<>();for(int i=0;i<n;i++)a.add(payload(d.child,depth+1));return a;}
            case 65:{int n=readLength(131072);Map<Object,Object> m=new LinkedHashMap<>();for(int i=0;i<n;i++)m.put(value(depth+1),value(depth+1));return m;}
            case 66:return new Union(utf8(take(readLength(5*1024*1024))),value(depth+1));
            case 192:return new Stamp(integer(8,true),(int)integer(4,false));
            case 193:return integer(8,true);
            case 194:return new Id(take(16));
            default:throw invalid();
        }
    }
    static Object decode(byte[] b){if(b.length>5*1024*1024)throw invalid();SomiSef r=new SomiSef(b);Object v=r.value(0);if(r.at!=b.length)throw invalid();return v;}
    static byte[] concat(byte[]... chunks){ByteArrayOutputStream out=new ByteArrayOutputStream();for(byte[] b:chunks)out.write(b,0,b.length);return out.toByteArray();}
    static byte[] bytes(int... values){byte[] b=new byte[values.length];for(int i=0;i<b.length;i++)b[i]=(byte)values[i];return b;}
    static byte[] length(int n){List<Integer> out=new ArrayList<>();out.add(n%128);while((n/=128)>0){n--;out.add(0,128+n%128);}byte[] b=new byte[out.size()];for(int i=0;i<b.length;i++)b[i]=out.get(i).byteValue();return b;}
    static byte[] le(long n,int width){return Arrays.copyOf(ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(n).array(),width);}
    static byte[] optional(int type,byte[] body){return concat(bytes(3,type,body==null?0:1),body==null?new byte[0]:body);}
    static byte[] structure(byte[]... fields){ByteArrayOutputStream out=new ByteArrayOutputStream();out.write(65);byte[] n=length(fields.length);out.write(n,0,n.length);for(byte[] f:fields)out.write(f,0,f.length);return out.toByteArray();}
    static byte[] f(int key,byte[] v){return concat(bytes(16,key),v);}
    static byte[] string(String s){byte[] b=s.getBytes(StandardCharsets.UTF_8);return concat(length(b.length),b);}
    static byte[] list(SomiStore.Cursor cursor,int limit){
        byte[] c=null;if(cursor!=null){byte[] encoded=structure(f(0,concat(bytes(192),le(cursor.seconds,8),le(cursor.nanos,4))),f(1,concat(bytes(194),idBytes(cursor.id))));c=Arrays.copyOfRange(encoded,1,encoded.length);}
        byte[] pagination=structure(f(0,optional(26,cursor==null?le(1,4):null)),f(1,optional(65,c)),f(2,optional(24,null)),f(16,optional(26,le(limit,4))));
        return structure(f(0,optional(49,string("somisoft"))),f(1,optional(194,idBytes("dmXhWHD_fpPMT7WB-R3Pyb"))),f(2,optional(49,null)),f(3,optional(24,null)),f(4,optional(24,null)),f(5,optional(24,null)),f(6,optional(65,Arrays.copyOfRange(pagination,1,pagination.length))));
    }
    static byte[] get(String id){return structure(f(0,concat(bytes(194),idBytes(id))));}
}
