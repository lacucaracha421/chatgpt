package com.lakomics.mobile;

/** Route-only host check; no Android services, network, device or credentials. */
public final class StartupPerfTest {
 public static void main(String[] args){
  String[][] cases={
   {"/v1/albums/commands","albums.commands"},
   {"/v1/albums/baseline?after=private","albums.baseline"},
   {"/v1/albums/changes","albums.changes"},
   {"/v1/classifications/authority/commands","classifications.authority.commands"},
   {"/v1/classifications/authority/baseline","classifications.authority.baseline"},
   {"/v1/classifications/authority/changes","classifications.authority.changes"},
   {"/v1/home/upcoming/wishlist","home.upcoming.wishlist"},
   {"/v1/collections/bindings/status","collections.bindings.status"},
   {"/v1/collections/bindings/search/kakao?query=private","collections.bindings.search.kakao"},
   {"/v1/collections/bindings/search/mangadex?query=private","collections.bindings.search.mangadex"},
   {"/v1/collections/bindings/requests?collectionId=private","collections.bindings.requests"},
   {"/v1/collections/bindings/requests/private/cancel","collections.bindings.requests"},
   {"/v1/library/assets?subtree=1&classification_id=private","library.assets.subtree"},
   {"/v1/library/assets?tag=private","library.assets.search"},
   {"/v1/library/assets?artist=private","library.assets.search"},
   {"/v1/library/assets?classification_id=private","library.assets"},
   {"/v1/library/search/description?q=private","library.search.description"},
   {"/v1/collections?type=manga","collections.manga"},
   {"/v1/collections?type=game","collections.game"},
   {"/v1/collections?type=movie","collections.movie"},
   {"/v1/collections?type=private","collections"},
   {"/v1/collections/bindings/search/private?query=private","collections.detail"},
  };
  for(String[] row:cases){
   if(!row[1].equals(StartupPerf.route(row[0])))throw new AssertionError("Fixed route mismatch: "+row[1]);
   if(!StartupPerf.jsName(row[1]))throw new AssertionError("JS vocabulary mismatch: "+row[1]);
  }
  if(StartupPerf.jsName("private")||StartupPerf.jsName("collections.bindings.search.private"))throw new AssertionError("Dynamic JS name admitted");
  System.out.println("StartupPerfTest: 22 route/JS-name pairs and 2 rejected names passed");
 }
}
