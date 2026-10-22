package com.lakomics.mobile;
public final class AssetExportPolicyTest {
 static int checks=0;
 static void same(Object expected,Object actual){if(!expected.equals(actual))throw new AssertionError("Expected "+expected+" but was "+actual);checks++;}
 public static void main(String[] args){
  same("image/jpeg",AssetExportPolicy.mime(" Image/JPEG; charset=binary"));
  for(String bad:new String[]{null,"","image","image/../x","text/html\nx","image/"+"a".repeat(80)})same(AssetExportPolicy.UNKNOWN,AssetExportPolicy.mime(bad));
  same("Pictures/Lakomics/",AssetExportPolicy.folder(AssetExportPolicy.kind("image/webp")));
  same("Movies/Lakomics/",AssetExportPolicy.folder(AssetExportPolicy.kind("video/mp4")));
  same("Download/Lakomics/",AssetExportPolicy.folder(AssetExportPolicy.kind("image/svg+xml")));
  same("downloads",AssetExportPolicy.folderName(AssetExportPolicy.kind(AssetExportPolicy.UNKNOWN)));
  same("Lakomics-a1_B-2.mp4",AssetExportPolicy.displayName("a1_B-2","video/mp4"));
  same("Lakomics-x",AssetExportPolicy.displayName("x",AssetExportPolicy.UNKNOWN));
  for(String id:new String[]{null,"","../a","a/b","a b","a".repeat(129)}){
   try{AssetExportPolicy.displayName(id,"image/png");throw new AssertionError("Unsafe id accepted: "+id);}catch(IllegalArgumentException expected){checks++;}
  }
  System.out.println("AssetExportPolicy: "+checks+" checks passed");
 }
}
