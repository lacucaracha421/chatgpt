package com.lakomics.mobile;
import org.json.*;

/**
 * Android-side catalog bookmark command — the B7 counterpart of the PC B6 send
 * path.
 *
 * Protocol semantics are shared with B6 and B4; only placement differs. The
 * durable intent lives in the web layer's storage, because that is where the
 * user's action and the visible state commit together. What stays here is the one
 * conversion the native boundary must not guess at: the server's
 * `revisionConflict` body, which carries the authoritative state a client must
 * re-base onto rather than silently dropping the user's intent.
 *
 * This class never invents an operation id. The caller passes the durable one, so
 * a retry after a lost response stays the same logical mutation.
 */
final class BookmarkCommand {
 /** Exactly the command keys the B4 route validates; it rejects any extras. */
 static final String[] COMMAND_KEYS={"libraryId","epoch","contractVersion","operationId","expectedRevision","desiredState"};

 private BookmarkCommand(){}

 /** The authoritative state a `revisionConflict` response reports, or null. */
 static final class Conflict {
  final long revision;final boolean desired;
  Conflict(long r,boolean d){revision=r;desired=d;}
 }

 /**
  * Read the conflict detail from a rejected response body.
  *
  * The server checks an existing receipt *before* it compares revisions, and it
  * records acceptance and that receipt atomically. A conflict therefore proves no
  * receipt exists for this operation id, which is what lets the client re-base
  * the same operation instead of allocating a new one and risking a duplicate
  * logical write.
  */
 static Conflict conflict(JSONObject body){
  if(body==null)return null;
  JSONObject detail=body.optJSONObject("detail");
  if(detail==null)detail=body;
  if(!"revisionConflict".equals(detail.optString("code")))return null;
  JSONObject current=detail.optJSONObject("current");
  if(current==null)return null;
  return new Conflict(current.optLong("entityRevision",0),current.optBoolean("desiredState",false));
 }

 /** The route path for one work identity, using the server's exact-text id. */
 static String path(String provider,String providerWorkId){return "/v1/mobile-catalog/bookmarks/"+provider+"/"+providerWorkId;}

 /** Build the exact B4 command body from a client intent. */
 static JSONObject body(JSONObject intent)throws JSONException{
  JSONObject command=new JSONObject();
  for(String key:COMMAND_KEYS)command.put(key,intent.get(key));
  return command;
 }

 /** Reject an intent that cannot produce a valid command, before it becomes traffic. */
 static void validate(JSONObject intent)throws JSONException{
  if(!intent.getString("libraryId").matches("[0-9a-f]{32}"))throw new IllegalArgumentException("Invalid library identity");
  if(intent.getInt("epoch")<1)throw new IllegalArgumentException("Invalid epoch");
  if(intent.optInt("contractVersion")!=1)throw new UnsupportedOperationException();
  if(!intent.getString("operationId").matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))throw new IllegalArgumentException("Invalid operation id");
  if(intent.getInt("expectedRevision")<0)throw new IllegalArgumentException("Invalid expected revision");
 }
}
