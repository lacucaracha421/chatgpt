package com.lakomics.mobile;

import java.util.*;

public final class SomiSefTest {
    private static int checks;
    static void equal(Object expected,Object actual){if(!Objects.equals(expected,actual))throw new AssertionError("Expected "+expected+", got "+actual);checks++;}
    private static String hex(byte[] bytes){StringBuilder s=new StringBuilder();for(byte b:bytes)s.append(String.format("%02x",b&255));return s.toString();}
    public static void main(String[] args){
        equal("4107100003310108736f6d69736f6674100103c2010196deebbfc17b6ba64fe177217cc4cc10020331001003031800100403180010050318001006034101041000031a0101000000100103410010020318001010031a0164000000",hex(SomiSef.list(null,100)));
        SomiStore.Cursor cursor=new SomiStore.Cursor(1792422015L,327023000,"b01beyIE4BLPH1oH2CtQeb");
        equal("4107100003310108736f6d69736f6674100103c2010196deebbfc17b6ba64fe177217cc4cc10020331001003031800100403180010050318001006034101041000031a001001034101021000c07f30d66a0000000098f97d131001c201a14e9c1d3a7598961bee891811d47410020318001010031a0107000000",hex(SomiSef.list(cursor,7)));
        equal("41011000c201a14e9c1d3a7598961bee891811d474",hex(SomiSef.get(cursor.id)));
        Object pagination=SomiSef.field(SomiSef.decode(SomiSef.list(cursor,7)),6),decoded=SomiSef.field(pagination,1);
        SomiSef.Stamp stamp=(SomiSef.Stamp)SomiSef.field(decoded,0);equal(cursor.seconds,stamp.seconds);equal(cursor.nanos,stamp.nanos);equal(cursor.id,SomiSef.id(SomiSef.field(decoded,1)));
        equal(Arrays.asList(null,-1L,5L),SomiSef.decode(SomiSef.bytes(64,3,24,3,0,1,255,1,5)));
        for(String id:Arrays.asList("dmXhWHD_fpPMT7WB-R3Pyb",cursor.id,"aaaaaaaaaaaaaaaaaaaaab"))equal(id,SomiSef.idText(SomiSef.idBytes(id)));
        for(int n:new int[]{127,128,16511,16512}){String text=String.join("",Collections.nCopies(n,"x"));equal(text,SomiSef.decode(SomiSef.concat(SomiSef.bytes(49),SomiSef.string(text))));}
        equal("소미",SomiSef.field(SomiSef.decode(SomiSef.structure(SomiSef.f(0,SomiSef.optional(49,SomiSef.string("소미"))))),0));
        try{SomiSef.decode(SomiSef.bytes(49,5,65));throw new AssertionError("Truncated response accepted");}catch(IllegalArgumentException expected){checks++;}
        System.out.println("SomiSefTest: "+checks+" checks passed");
    }
}
