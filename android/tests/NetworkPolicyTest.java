package com.lakomics.mobile;
public final class NetworkPolicyTest {
 static int checks=0;
 interface Attempt {void run() throws Exception;}
 static void pass(Attempt a)throws Exception{a.run();checks++;}
 static void reject(Attempt a)throws Exception{try{a.run();}catch(Exception e){checks++;return;}throw new AssertionError("Unsafe input accepted");}
 public static void main(String[] args)throws Exception{
 pass(()->NetworkPolicy.endpoint("https://example.com:443/",false));
 for(String host:new String[]{"10.0.0.1","127.0.0.1","172.16.0.1","172.31.255.255","192.168.1.1","100.64.0.1","100.127.255.254"})pass(()->NetworkPolicy.endpoint("http://"+host+":32146",true));
 for(String host:new String[]{"example.com","8.8.8.8","100.63.255.255","100.128.0.1","172.32.0.1","10.1","010.0.0.1","2130706433","[::1]","169.254.169.254"})reject(()->NetworkPolicy.endpoint("http://"+host,true));
 for(String endpoint:new String[]{"http://10.0.0.1","https://user:password@example.com","https://example.com/path","https://example.com?token=x","https://example.com#x","https://example.com:65536"})reject(()->NetworkPolicy.endpoint(endpoint,false));
 pass(()->NetworkPolicy.api("/v1/library/assets?limit=100&cursor=abc","GET"));pass(()->NetworkPolicy.api("/v1/library/assets/id-123/media-ticket","POST"));pass(()->NetworkPolicy.api("/v1/captures/id_1/download","GET"));
 for(String p:new String[]{"https://evil.test/v1/library/assets","//evil.test/v1/library/assets","/v1/library/assets/../prepare","/v1/library/assets#x","/v1/captures","/v1/library/metadata-backup","/v1/classifications"})reject(()->NetworkPolicy.api(p,"GET"));
 for(String method:new String[]{"POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/library/assets",method));
 pass(()->NetworkPolicy.catalogImage("42","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cover",0,"https://ehgt.org/t/cover.webp"));
 pass(()->NetworkPolicy.catalogImage("42","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","page",17,"https://a.siam-cdn.net/p.webp?expires=1800000000"));
 for(String url:new String[]{"http://a.siam-cdn.net/p.webp","https://evil.example/p.webp","https://siam-cdn.net.evil.example/p.webp","https://user@siam-cdn.net/p.webp","https://siam-cdn.net:444/p.webp","https://siam-cdn.net/p.webp#x"})reject(()->NetworkPolicy.catalogImage("42","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","page",0,url));
 reject(()->NetworkPolicy.catalogImage("01","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","page",0,"https://siam-cdn.net/p.webp"));reject(()->NetworkPolicy.catalogImage("42","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cover",1,"https://ehgt.org/t.webp"));reject(()->NetworkPolicy.catalogImage("42","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","page",2000,"https://siam-cdn.net/p.webp"));reject(()->NetworkPolicy.catalogImage("42","bad","page",0,"https://siam-cdn.net/p.webp"));
 pass(()->NetworkPolicy.api("/v1/collections?type=manga&limit=48","GET"));
 pass(()->NetworkPolicy.api("/v1/collections/work-1","GET"));
 pass(()->NetworkPolicy.api("/v1/collections/work-1/artworks/cover_2/media-ticket","POST"));
 reject(()->NetworkPolicy.api("/v1/collections/replica","PUT"));
 reject(()->NetworkPolicy.api("/v1/collections/artworks/prepare","POST"));
 reject(()->NetworkPolicy.api("/v1/collections/work-1","DELETE"));
 reject(()->NetworkPolicy.api("/v1/collections/work-1/artworks/../media-ticket","POST"));
 for(String p:new String[]{"/v1/mobile-catalog/status","/v1/mobile-catalog/search?language=korean","/v1/mobile-catalog/count?token=opaque","/v1/mobile-catalog/works/kHentai/42?context=opaque","/v1/mobile-catalog/works/kHentai/42/reader?context=opaque","/v1/mobile-catalog/groups/kHentai/group-1/editions?context=opaque"})pass(()->NetworkPolicy.api(p,"GET"));
 for(String p:new String[]{"/v1/mobile-catalog/publication","/v1/mobile-catalog/replicas/abc","/v1/mobile-catalog/bookmarks","/v1/mobile-catalog/works/kHentai/01","/v1/mobile-catalog/works/kHentai/01/reader","/v1/mobile-catalog/works/heliotrope/42","/v1/mobile-catalog/groups/kHentai/%2e%2e/editions"})for(String method:new String[]{"GET","POST","PUT","DELETE"})reject(()->NetworkPolicy.api(p,method));
 for(String method:new String[]{"GET","POST"})pass(()->NetworkPolicy.api("/v1/mobile-catalog/refresh",method));
 for(String method:new String[]{"PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/mobile-catalog/refresh",method));
 reject(()->NetworkPolicy.api("/v1/mobile-catalog/refresh/anything","POST"));
 // B7: the catalog bookmark command is the only catalog write, and only as PUT.
 pass(()->NetworkPolicy.api("/v1/mobile-catalog/bookmarks/kHentai/42","PUT"));
 pass(()->NetworkPolicy.api("/v1/mobile-catalog/bookmarks/kHentai/03","PUT"));
 pass(()->NetworkPolicy.api("/v1/mobile-catalog/bookmarks/heliotrope/42","PUT"));
 pass(()->NetworkPolicy.api("/v1/mobile-catalog/bookmarks/kHentai/work-id_1","PUT"));
 for(String method:new String[]{"GET","POST","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/mobile-catalog/bookmarks/kHentai/42",method));
 // The write stays scoped to one known provider and one opaque id segment: no
 // traversal, no extra path segment, no unknown provider. A query string is
 // stripped before matching, exactly as for every other route, and grants no
 // additional target.
 for(String p:new String[]{"/v1/mobile-catalog/bookmarks/kHentai","/v1/mobile-catalog/bookmarks/kHentai/","/v1/mobile-catalog/bookmarks","/v1/mobile-catalog/bookmarks/mangadex/42","/v1/mobile-catalog/bookmarks/kHentai/42/reader","/v1/mobile-catalog/bookmarks/kHentai/../42","/v1/mobile-catalog/bookmarks/kHentai/4%2F2","/v1/mobile-catalog/bookmarks/kHentai/4.2","/v1/mobile-catalog/bookmarks/kHentai/42#x"})reject(()->NetworkPolicy.api(p,"PUT"));
 reject(()->NetworkPolicy.api("/v1/mobile-catalog/bookmarks/kHentai/42","POST"));
 for(String method:new String[]{"GET","PUT","DELETE"})reject(()->NetworkPolicy.api("/v1/mobile-catalog/bookmarks/mangadex/42",method));
 StringBuilder longWorkId=new StringBuilder("/v1/mobile-catalog/bookmarks/kHentai/");for(int i=0;i<65;i++)longWorkId.append('1');
 reject(()->NetworkPolicy.api(longWorkId.toString(),"PUT"));
 StringBuilder longQuery=new StringBuilder("/v1/mobile-catalog/search?text=");for(int i=0;i<1365;i++)longQuery.append("%EA%B0%80");pass(()->NetworkPolicy.api(longQuery.toString(),"GET"));
 for(int i=0;i<5000;i++)longQuery.append('a');reject(()->NetworkPolicy.api(longQuery.toString(),"GET"));
 for(String path:new String[]{"/v1/library/characters","/v1/library/characters/assets?node=character%3Aid&revision=abc"}){pass(()->NetworkPolicy.api(path,"GET"));for(String method:new String[]{"POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api(path,method));}
 reject(()->NetworkPolicy.api("/v1/library/characters/replica","PUT"));
 String vault="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
 pass(()->NetworkPolicy.api("/v1/notes/"+vault+"?cursor=2&limit=5","GET"));
 pass(()->NetworkPolicy.api("/v1/notes/"+vault+"/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","PUT"));
 for(String method:new String[]{"POST","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/notes/"+vault+"/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",method));
 reject(()->NetworkPolicy.api("/v1/notes/short","GET"));
 reject(()->NetworkPolicy.api("/v1/notes/"+vault+"/../bad","PUT"));
 pass(()->NetworkPolicy.api("/v1/library/characters/status","GET"));
 // The manual character exclusion the device is allowed to submit: exactly this one POST.
 pass(()->NetworkPolicy.api("/v1/library/characters/exclusions","POST"));
 for(String method:new String[]{"GET","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/library/characters/exclusions",method));
 // A query string is stripped before matching, exactly as for every other route: it grants no
 // additional target and no additional capability.
 pass(()->NetworkPolicy.api("/v1/library/characters/exclusions?debug=1","POST"));
 // The exclusion log is a publisher-level read of every correction in the library, so GET
 // stays denied even though POST on the collection itself is allowed. Publication and every
 // subpath/typo variant of the exclusion route remain denied for every method.
 for(String path:new String[]{"/v1/library/characters/exclusions/","/v1/library/characters/exclusions/extra","/v1/library/characters/exclusion","/v1/library/characters/exclusionsx","/v1/library/characters/replica"})for(String method:new String[]{"GET","POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api(path,method));
 reject(()->NetworkPolicy.api("/v1/library/characters/exclusions%2f..","POST"));
 pass(()->NetworkPolicy.api("/v1/collections/status","GET"));
 // Personal Collection edits: the device may submit the command, but the edit feed is a
 // publisher-only read of every edit, so GET stays denied with or without a query.
 pass(()->NetworkPolicy.api("/v1/collections/personal-edits","POST"));
 reject(()->NetworkPolicy.api("/v1/collections/personal-edits","GET"));
 reject(()->NetworkPolicy.api("/v1/collections/personal-edits?libraryId=0123456789abcdef0123456789abcdef&after=0&limit=100","GET"));
 for(String method:new String[]{"PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/collections/personal-edits",method));
 // Album authority replication keeps its read paths. 2C-3 adds exactly the domain's
 // one typed mutation route, PUT /v1/albums/commands, and no other Album write.
 for(String path:new String[]{"/v1/sync/status","/v1/albums/baseline?libraryId=0123456789abcdef0123456789abcdef&epoch=1&limit=1000","/v1/albums/changes?libraryId=0123456789abcdef0123456789abcdef&epoch=1&after=0&limit=100"})pass(()->NetworkPolicy.api(path,"GET"));
 // The authority-backed Album contents projection, allowed only for GET.
 pass(()->NetworkPolicy.api("/v1/albums/assets?libraryId=0123456789abcdef0123456789abcdef&epoch=1&albumId=root&limit=40","GET"));
 for(String method:new String[]{"POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/albums/assets",method));
 reject(()->NetworkPolicy.api("/v1/albums/assets/extra","GET"));
 reject(()->NetworkPolicy.api("/v1/albums/assetsx","GET"));
 reject(()->NetworkPolicy.api("/v1/albums/../albums/assets","GET"));
 // Membership outbox delivery gets exactly one write route.
 pass(()->NetworkPolicy.api("/v1/albums/commands","PUT"));
 for(String method:new String[]{"GET","POST","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/albums/commands",method));
 reject(()->NetworkPolicy.api("/v1/albums/authority/activate","POST"));
 for(String path:new String[]{"/v1/albums/commands/","/v1/albums/authority/activate","/v1/albums","/v1/albums/","/v1/sync","/v1/sync/","/v1/sync/status/extra","/v1/sync/statusx","/v1/albums/baseline/extra","/v1/albums/baselinex","/v1/albums/commands/x"})for(String method:new String[]{"GET","POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api(path,method));
 for(String path:new String[]{"/v1/sync/status","/v1/albums/baseline","/v1/albums/changes"})for(String method:new String[]{"POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api(path,method));
 // Classification authority: exactly the two read routes stay GET-only, and the domain's
 // one typed mutation route is added as PUT. The route also carries structural commands for
 // the PC publisher, but Android cannot reach them: ClassificationAssignmentOutbox
 // constructs `setAssetClassification` internally and the server requires the publisher role
 // for every other command. Activate and every malformed variant stay denied.
 for(String path:new String[]{"/v1/classifications/authority/baseline?libraryId=0123456789abcdef0123456789abcdef&epoch=1&limit=1000","/v1/classifications/authority/changes?libraryId=0123456789abcdef0123456789abcdef&epoch=1&after=0&limit=100"})pass(()->NetworkPolicy.api(path,"GET"));
 for(String path:new String[]{"/v1/classifications/authority/baseline","/v1/classifications/authority/changes"})for(String method:new String[]{"POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api(path,method));
 // The assignment command route: PUT only, and only at this exact path.
 pass(()->NetworkPolicy.api("/v1/classifications/authority/commands","PUT"));
 for(String method:new String[]{"GET","POST","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/classifications/authority/commands",method));
 for(String path:new String[]{"/v1/classifications/authority/activate","/v1/classifications/authority","/v1/classifications/authority/","/v1/classifications/authority/baseline/extra","/v1/classifications/authority/baselinex","/v1/classifications/authority/changes/extra","/v1/classifications/authority/commands/","/v1/classifications/authority/commands/extra","/v1/classifications/authorityx/commands"})for(String method:new String[]{"GET","POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api(path,method));
 reject(()->NetworkPolicy.api("/v1/classifications/authority/../authority/baseline","GET"));
 reject(()->NetworkPolicy.api("/v1/classifications/authority/baseline%2f..","GET"));
 reject(()->NetworkPolicy.api("/v1/classifications/authority/../authority/commands","PUT"));
 reject(()->NetworkPolicy.api("/v1/classifications/authority/commands%2f..","PUT"));
 // A query string is stripped before matching, exactly as for every other route, and grants
 // no additional target.
 reject(()->NetworkPolicy.api("/v1/classifications/authority/activate?libraryId=0123456789abcdef0123456789abcdef","PUT"));
 reject(()->NetworkPolicy.api("/v1/albums/../albums/baseline","GET"));
 reject(()->NetworkPolicy.api("/v1/albums/baseline%2f..","GET"));
 // Unrelated writes stay blocked, so widening this allowlist did not widen any other.
 // The paths that legitimately accept these methods are excluded on purpose: a media
 // ticket is a read capability, and catalog refresh is a bounded server-side read.
 for(String path:new String[]{"/v1/library/assets/a-1/prepare","/v1/library/album-snapshot","/v1/library/album-media","/v1/library/metadata-backup","/v1/collections/replica","/v1/collections/artworks/prepare","/v1/mobile-catalog/publication","/v1/library/classifications","/v1/library/assets","/v1/library/revisit","/v1/captures/pending","/v1/library/characters"})for(String method:new String[]{"POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api(path,method));
 // Mobile character review: the device reads the candidate feed and submits decisions only.
 pass(()->NetworkPolicy.api("/v1/library/characters/review","GET"));
 pass(()->NetworkPolicy.api("/v1/library/characters/review?target=c&limit=20&cursor=abc","GET"));
 pass(()->NetworkPolicy.api("/v1/library/characters/review?asset=a-1","GET"));
 pass(()->NetworkPolicy.api("/v1/library/characters/review/decisions","POST"));
 for(String method:new String[]{"POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/library/characters/review",method));
 // The decision log is a publisher read of every decision, and the feed PUT is the PC's
 // publication: neither is reachable, with or without a query.
 for(String method:new String[]{"GET","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/library/characters/review/decisions",method));
 reject(()->NetworkPolicy.api("/v1/library/characters/review/decisions?libraryId=0123456789abcdef0123456789abcdef&after=0&limit=100","GET"));
 for(String method:new String[]{"GET","POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/library/characters/review/feed",method));
 for(String path:new String[]{"/v1/library/characters/review/","/v1/library/characters/reviewx","/v1/library/characters/review/decisions/","/v1/library/characters/review/decisions/extra","/v1/library/characters/review/../exclusions","/v1/library/characters/review%2f..","/v1/library/characters/review/decisions%2f.."})for(String method:new String[]{"GET","POST","PUT"})reject(()->NetworkPolicy.api(path,method));
 // Catalog tag autocomplete: a read under the catalog's 16 KiB path bound, GET only.
 pass(()->NetworkPolicy.api("/v1/mobile-catalog/suggestions?text=artist%3Aasa&limit=10","GET"));
 pass(()->NetworkPolicy.api("/v1/mobile-catalog/suggestions?text=%EA%B0%80&limit=10&revealBlocked=true","GET"));
 for(String method:new String[]{"POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/mobile-catalog/suggestions?text=a",method));
 for(String path:new String[]{"/v1/mobile-catalog/suggestions/","/v1/mobile-catalog/suggestionsx","/v1/mobile-catalog/suggestions/../publication","/v1/mobile-catalog/suggestions#x"})reject(()->NetworkPolicy.api(path,"GET"));
 StringBuilder longSuggestion=new StringBuilder("/v1/mobile-catalog/suggestions?text=");for(int i=0;i<17000;i++)longSuggestion.append('a');reject(()->NetworkPolicy.api(longSuggestion.toString(),"GET"));
 // Mobile similarity review: the device reads the pair queue and submits decisions only.
 pass(()->NetworkPolicy.api("/v1/library/similarity/review","GET"));
 pass(()->NetworkPolicy.api("/v1/library/similarity/review?limit=20&cursor=abc","GET"));
 pass(()->NetworkPolicy.api("/v1/library/similarity/review/decisions","POST"));
 for(String method:new String[]{"POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/library/similarity/review",method));
 for(String method:new String[]{"GET","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/library/similarity/review/decisions",method));
 reject(()->NetworkPolicy.api("/v1/library/similarity/review/decisions?libraryId=0123456789abcdef0123456789abcdef&after=0&limit=100","GET"));
 for(String method:new String[]{"GET","POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/library/similarity/review/feed",method));
 for(String path:new String[]{"/v1/library/similarity","/v1/library/similarity/review/","/v1/library/similarity/reviewx","/v1/library/similarity/review/decisions/","/v1/library/similarity/review/decisions/extra","/v1/library/similarity/review/../review/feed","/v1/library/similarity/review%2f..","/v1/library/similarity/review/decisions%2f.."})for(String method:new String[]{"GET","POST","PUT"})reject(()->NetworkPolicy.api(path,method));
 // Mobile Library Trash: the trash list is a GET, the lifecycle command route a PUT, and
 // trash-scoped tickets reuse the existing ticket POSTs with a query that widens nothing.
 pass(()->NetworkPolicy.api("/v1/library/trash","GET"));
 pass(()->NetworkPolicy.api("/v1/library/trash?limit=60&cursor=abc","GET"));
 for(String method:new String[]{"POST","PUT","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/library/trash",method));
 pass(()->NetworkPolicy.api("/v1/assets/authority/commands","PUT"));
 for(String method:new String[]{"GET","POST","DELETE","PATCH"})reject(()->NetworkPolicy.api("/v1/assets/authority/commands",method));
 pass(()->NetworkPolicy.api("/v1/library/media-tickets?lifecycle=trash","POST"));
 pass(()->NetworkPolicy.api("/v1/library/assets/a-1/media-ticket?lifecycle=trash","POST"));
 for(String path:new String[]{"/v1/library/trash/","/v1/library/trashx","/v1/library/trash/empty","/v1/library/trash/../assets","/v1/library/trash%2f..","/v1/assets/authority/commands/","/v1/assets/authority/commands/extra","/v1/assets/authority/activate","/v1/assets/authority/activation-baseline","/v1/assets/authority/activation-inventory","/v1/assets/authority/commands%2f.."})for(String method:new String[]{"GET","POST","PUT","DELETE"})reject(()->NetworkPolicy.api(path,method));
 reject(()->NetworkPolicy.api("/v1/assets/authority/activate?x=/v1/assets/authority/commands","PUT"));
 System.out.println("NetworkPolicy: "+checks+" checks passed");
 }
}
