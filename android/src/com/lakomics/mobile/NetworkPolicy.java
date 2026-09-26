package com.lakomics.mobile;
import java.net.URI;
import java.util.Locale;
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
 static void catalogImage(String workId,String revision,String kind,int index,String raw) throws Exception {
  if(workId==null || !workId.matches("[1-9][0-9]{0,18}") || revision==null || !revision.matches("[a-f0-9]{64}") || !(kind.equals("cover") || kind.equals("page")) || index<0 || index>=2000 || (kind.equals("cover") && index!=0) || raw==null || raw.length()>16384)throw new IllegalArgumentException("Invalid catalog image");
  URI u=new URI(raw);String host=u.getHost()==null?"":u.getHost().toLowerCase(Locale.ROOT);int port=u.getPort();
  boolean cover=kind.equals("cover") && (host.equals("ehgt.org") || host.endsWith(".ehgt.org"));
  boolean page=kind.equals("page") && (host.equals("siam-cdn.net") || host.endsWith(".siam-cdn.net"));
  if(!"https".equals(u.getScheme()) || u.getUserInfo()!=null || u.getFragment()!=null || (port!=-1 && port!=443) || !(cover||page))throw new IllegalArgumentException("Invalid catalog image");
 }
 static void api(String path,String method) throws Exception {
  if(path.length()>(path.startsWith("/v1/mobile-catalog/")?16384:8192) || path.contains("\\") || path.contains("#") || path.contains("\r") || path.contains("\n"))throw new IllegalArgumentException("Unsupported API path");
  String p=path.split("\\?",2)[0];
  boolean get=p.equals("/v1/library/list-generation") || p.equals("/v1/library/classifications") || p.equals("/v1/library/assets") || p.equals("/v1/library/revisit") || p.equals("/v1/library/revisit/date") || p.matches("/v1/library/revisit/creator/[A-Za-z0-9_%.-]+/assets") || p.equals("/v1/captures/pending") || p.matches("/v1/captures/[A-Za-z0-9_-]+/download");
  get=get || p.equals("/v1/library/characters") || p.equals("/v1/library/characters/assets") || p.equals("/v1/library/characters/status");
  // HOME-DASH-001: read-only Home library counts.
  get=get || p.equals("/v1/library/summary");
  // HOME-DASH-001 Home documents the PC publishes: 발매 예정 (+ the wishlist intent command) and
  // 오늘의 AV 배우, plus the ticket for a Home cover blob. The snapshot PUTs, the AV-pick DELETE and
  // the intent log GET (`/wishlist/intents`) are publisher-only and stay unreachable.
  get=get || p.equals("/v1/home/upcoming") || p.equals("/v1/home/av-pick");
  // ARTIST-001: the read-only artist list and one artist by its id as a single encoded segment
  // (`/` as %2F); a segment of dots only is refused. The snapshot PUT is publisher-only.
  get=get || p.equals("/v1/library/artists") || (p.matches("/v1/library/artists/[A-Za-z0-9_%.~:-]{1,3072}") && !p.matches("/v1/library/artists/\\.+"));
  get=get || p.equals("/v1/assets/authority/status") || p.equals("/v1/assets/authority/baseline") || p.equals("/v1/assets/authority/changes");
  // Album authority reads remain narrowly allowlisted. The one write route is added
  // separately below with its first durable-outbox consumer.
  get=get || p.equals("/v1/sync/status") || p.equals("/v1/albums/baseline") || p.equals("/v1/albums/changes");
  // The authority-backed Album contents read is still GET-only.
  get=get || p.equals("/v1/albums/assets");
  // Classification authority reads. Exactly the two read routes.
  get=get || p.equals("/v1/classifications/authority/baseline") || p.equals("/v1/classifications/authority/changes");
  // The Classification assignment command: one desired-state write per Asset, and nothing
  // else. The authority's structural commands travel on the *same* server route, but
  // `ClassificationAssignmentOutbox` constructs `setAssetClassification` internally and the
  // server requires the publisher role for every other command, so Android cannot reach a
  // structural mutation through this path. Activate stays absent from every allowlist.
  boolean classificationPut=p.equals("/v1/classifications/authority/commands");
  boolean post=p.equals("/v1/library/media-tickets") || p.matches("/v1/library/assets/[A-Za-z0-9_-]+/media-ticket");
  // HOME-DASH-001: the wishlist intent command and the Home cover ticket (see the Home GETs above).
  post=post || p.equals("/v1/home/upcoming/wishlist") || p.matches("/v1/home/covers/[a-f0-9]{64}/media-ticket");
  get=get || p.equals("/v1/collections") || (p.matches("/v1/collections/[A-Za-z0-9_-]{1,128}") && !p.equals("/v1/collections/personal-edits"));
  get=get || p.equals("/v1/mobile-catalog/status") || p.equals("/v1/mobile-catalog/search") || p.equals("/v1/mobile-catalog/suggestions") || p.equals("/v1/mobile-catalog/count") || p.matches("/v1/mobile-catalog/works/kHentai/[1-9][0-9]{0,18}") || p.matches("/v1/mobile-catalog/works/kHentai/[1-9][0-9]{0,18}/reader") || p.matches("/v1/mobile-catalog/groups/kHentai/[A-Za-z0-9_-]{1,128}/editions");
  post=post || p.matches("/v1/collections/[A-Za-z0-9_-]{1,128}/artworks/[A-Za-z0-9_-]{1,128}/media-ticket");
  // Personal Collection edits (rating, Showcase, memo): only the client command. The edit
  // log is a publisher read and stays unreachable from here.
  post=post || p.equals("/v1/collections/personal-edits");
  // Manga release notifications (신간 알림): the unread list read and the acknowledge (확인)
  // command, and nothing else. The unread upload PUT and the read-log GET are publisher-only
  // and stay unreachable: `/releases/unread` and `/releases/reads` are two segments deep, so
  // the single-segment Collection read above does not match them either.
  get=get || p.equals("/v1/collections/releases");
  post=post || p.equals("/v1/collections/releases/acknowledge");
  // Collection bindings (MangaDex / Kakao 연결): the capability status, the two provider
  // searches, and filing/reading bind requests, and nothing else. The request log GET and the
  // per-request result POST are publisher-only (the PC applies the choice) and stay unreachable:
  // `/bindings/log` and `/bindings/requests/{id}/result` match none of these exact paths.
  get=get || p.equals("/v1/collections/bindings/status") || p.equals("/v1/collections/bindings/search/mangadex") || p.equals("/v1/collections/bindings/search/kakao") || p.equals("/v1/collections/bindings/requests");
  post=post || p.equals("/v1/collections/bindings/requests");
  get=get || p.equals("/v1/mobile-catalog/refresh");
  post=post || p.equals("/v1/mobile-catalog/refresh");
  // The manual character exclusion accepted for this device: one named Asset in one named
  // character, and nothing else. Only this exact POST is added. The exclusion *log* is a
  // publisher read of every correction in the library, and the publication and structural
  // character routes stay publisher-only, so none of them may be reached from here: they
  // remain absent from the allowlist and the malformed variants below are rejected.
  post=post || p.equals("/v1/library/characters/exclusions");
  // Mobile character review: the candidate feed read and the decision command, and nothing
  // else. The feed PUT and the decision log GET are publisher-only and stay unreachable.
  get=get || p.equals("/v1/library/characters/review");
  post=post || p.equals("/v1/library/characters/review/decisions");
  // Mobile similarity review: the pair queue read and the decision command, and nothing
  // else. The feed PUT and the decision log GET are publisher-only and stay unreachable.
  get=get || p.equals("/v1/library/similarity/review");
  post=post || p.equals("/v1/library/similarity/review/decisions");
  // Catalog duplicate-edition review: the candidate list read and the decision command, and
  // nothing else. The candidate PUT and the decision log GET are publisher-only.
  get=get || p.equals("/v1/mobile-catalog/duplicates");
  post=post || p.equals("/v1/mobile-catalog/duplicates/decisions");
  // The catalog bookmark command: one desired-state write per work identity, and
  // nothing else. The id charset excludes `/`, `.`, `%` and `?`, so the segment
  // cannot traverse or re-encode into a different entity.
  boolean bookmarkPut=p.matches("/v1/mobile-catalog/bookmarks/(kHentai|heliotrope)/[0-9A-Za-z_-]{1,64}");
  boolean albumPut=p.equals("/v1/albums/commands");
  // Mobile Library Trash: the trash read, and the Asset lifecycle command route written by
  // `AssetLifecycleOutbox`, which constructs `trashAsset`/`restoreAsset` only. The server
  // requires the publisher role for `tombstoneAsset`, so emptying the trash stays on the PC.
  // Trash thumbnails use the existing ticket POSTs with `?lifecycle=trash` (queries are
  // stripped above and grant no other target). Activation stays absent.
  get=get || p.equals("/v1/library/trash");
  boolean lifecyclePut=p.equals("/v1/assets/authority/commands");
  get=get || p.matches("/v1/notes/[a-f0-9]{64}");
  // File exchange (보내기/받기): exactly the device, inbox/outbox and per-transfer routes the
  // client uses, each with its one method. Ids are lowercase UUIDs, so no segment can
  // traverse or re-encode. Unregistering a device stays unreachable.
  String exchangeId="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  get=get || p.equals("/v1/exchange/devices") || p.equals("/v1/exchange/inbox") || p.equals("/v1/exchange/outbox");
  post=post || p.equals("/v1/exchange/transfers") || p.matches("/v1/exchange/transfers/"+exchangeId+"/(complete|ticket|ack)");
  boolean exchangePut=p.matches("/v1/exchange/devices/"+exchangeId);
  boolean delete=p.matches("/v1/exchange/transfers/"+exchangeId);
  boolean put=bookmarkPut || albumPut || classificationPut || lifecyclePut || exchangePut || p.matches("/v1/notes/[a-f0-9]{64}/[a-f0-9-]{32,64}");
  if(!(method.equals("PUT") && put) && !(method.equals("GET") && get) && !(method.equals("POST") && post) && !(method.equals("DELETE") && delete))throw new IllegalArgumentException("Unsupported read operation");
 }
}
