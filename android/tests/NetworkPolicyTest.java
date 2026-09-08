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
 for(String p:new String[]{"/v1/mobile-catalog/publication","/v1/mobile-catalog/replicas/abc","/v1/mobile-catalog/bookmarks","/v1/mobile-catalog/refresh","/v1/mobile-catalog/works/kHentai/01","/v1/mobile-catalog/works/kHentai/01/reader","/v1/mobile-catalog/works/heliotrope/42","/v1/mobile-catalog/groups/kHentai/%2e%2e/editions"})for(String method:new String[]{"GET","POST","PUT","DELETE"})reject(()->NetworkPolicy.api(p,method));
 StringBuilder longQuery=new StringBuilder("/v1/mobile-catalog/search?text=");for(int i=0;i<1365;i++)longQuery.append("%EA%B0%80");pass(()->NetworkPolicy.api(longQuery.toString(),"GET"));
 for(int i=0;i<5000;i++)longQuery.append('a');reject(()->NetworkPolicy.api(longQuery.toString(),"GET"));
 System.out.println("NetworkPolicy: "+checks+" checks passed");
 }
}
