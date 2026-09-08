package com.lakomics.mobile;
import java.net.URI;
final class NetworkPolicy {
 static String endpoint(String input, boolean privateHttp) throws Exception {
  URI u = new URI(input.trim());
  if (u.getUserInfo()!=null || u.getQuery()!=null || u.getFragment()!=null || u.getHost()==null || !(u.getPath().isEmpty() || u.getPath().equals("/"))) throw new IllegalArgumentException("Invalid endpoint");
  if (!"https".equals(u.getScheme()) && !(privateHttp && "http".equals(u.getScheme()) && privateIpv4(u.getHost()))) throw new IllegalArgumentException("HTTPS required; private HTTP needs explicit permission");
  if (u.getPort() < -1 || u.getPort() == 0 || u.getPort() > 65535) throw new IllegalArgumentException("Invalid port");
  return u.getScheme()+"://"+u.getRawAuthority();
 }
 static boolean privateIpv4(String host) {
  String[] p=host.split("\\.",-1); if(p.length!=4)return false; int[] n=new int[4];
  for(int i=0;i<4;i++){if(!p[i].matches("0|[1-9][0-9]{0,2}"))return false; n[i]=Integer.parseInt(p[i]);if(n[i]>255)return false;}
  return n[0]==10 || n[0]==127 || (n[0]==172 && n[1]>=16 && n[1]<=31) || (n[0]==192 && n[1]==168) || (n[0]==100 && n[1]>=64 && n[1]<=127);
 }
 static void api(String path,String method) throws Exception {
  if(path.length()>(path.startsWith("/v1/mobile-catalog/")?16384:8192) || path.contains("\\") || path.contains("#") || path.contains("\r") || path.contains("\n"))throw new IllegalArgumentException("Unsupported API path");
  String p=path.split("\\?",2)[0];
  boolean get=p.equals("/v1/library/classifications") || p.equals("/v1/library/assets") || p.equals("/v1/library/revisit") || p.equals("/v1/library/revisit/date") || p.matches("/v1/library/revisit/creator/[A-Za-z0-9_%.-]+/assets") || p.equals("/v1/captures/pending") || p.matches("/v1/captures/[A-Za-z0-9_-]+/download");
  boolean post=p.equals("/v1/library/media-tickets") || p.matches("/v1/library/assets/[A-Za-z0-9_-]+/media-ticket");
  get=get || p.equals("/v1/collections") || p.matches("/v1/collections/[A-Za-z0-9_-]{1,128}");
  get=get || p.equals("/v1/mobile-catalog/status") || p.equals("/v1/mobile-catalog/search") || p.equals("/v1/mobile-catalog/count") || p.matches("/v1/mobile-catalog/works/kHentai/[1-9][0-9]{0,18}") || p.matches("/v1/mobile-catalog/groups/kHentai/[A-Za-z0-9_-]{1,128}/editions");
  post=post || p.matches("/v1/collections/[A-Za-z0-9_-]{1,128}/artworks/[A-Za-z0-9_-]{1,128}/media-ticket");
  if(!(method.equals("GET") && get) && !(method.equals("POST") && post))throw new IllegalArgumentException("Unsupported read operation");
 }
}
