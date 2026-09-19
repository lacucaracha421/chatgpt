package com.lakomics.mobile;
import java.util.*;
import java.util.concurrent.locks.ReentrantLock;

/** Deterministic lifecycle replay and expired-history recovery, no Android runtime. */
public final class AssetReplicaTest {
 static final String LIB="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
 static int assertions=0;
 static void check(boolean value){assertions++;if(!value)throw new AssertionError("Assertion "+assertions);}
 static class Db implements AssetReplica.Storage {
  AssetReplica.Snapshot snapshot;String scope;
  public AssetReplica.Snapshot readAssets(String s){return s.equals(scope)?snapshot:null;}
  public void replaceAssets(String s,AssetReplica.Snapshot p){scope=s;snapshot=p;}
  public void clearAssets(){snapshot=null;scope=null;}
 }
 static class Server implements AlbumReplica.Transport {
  long cursor=0;String life="normal";boolean expired=false,gap=false,badBaseline=false;
  public String get(String path) throws Exception {
   if(path.equals("/v1/sync/status"))return "{\"protocolVersion\":1,\"active\":true,\"libraryId\":\""+LIB+"\",\"domains\":[{\"domain\":\"assets\",\"libraryId\":\""+LIB+"\",\"epoch\":1,\"contractVersion\":1,\"cursor\":"+cursor+"}]}";
   String envelope="\"libraryId\":\""+LIB+"\",\"epoch\":1,\"contractVersion\":1,\"cursor\":"+cursor;
   String projection="{\"assetId\":\"asset-a\",\"lifecycle\":\""+life+"\",\"entityRevision\":"+(cursor+1)+",\"sha256\":null,\"sizeBytes\":1}";
   if(path.contains("baseline"))return "{"+envelope+",\"items\":["+projection+"],\"hasMore\":"+badBaseline+",\"nextAfter\":null}";
   if(expired)throw new AlbumReplica.HttpFailure(409,"{\"detail\":{\"code\":\"cursorExpired\"}}");
   long after=Long.parseLong(path.split("&after=")[1].split("&")[0]);
   String changes=after==cursor?"":"{\"sequence\":"+(gap?cursor+1:cursor)+",\"assetId\":\"asset-a\",\"asset\":"+projection+"}";
   return "{"+envelope+",\"items\":["+changes+"],\"nextAfter\":"+cursor+",\"hasMore\":false}";
  }
 }
 public static void main(String[] args)throws Exception {
  Db db=new Db();Server server=new Server();AssetReplica engine=new AssetReplica(server,db,new ReentrantLock());
  check(engine.sync("account"));check(db.snapshot.rows.get("asset-a").get("lifecycle").equals("normal"));
  check(!engine.sync("account"));
  server.cursor=1;server.life="trash";check(engine.sync("account"));check(db.snapshot.rows.get("asset-a").get("lifecycle").equals("trash"));
  server.cursor=2;server.life="normal";check(engine.sync("account"));check(db.snapshot.rows.containsKey("asset-a"));
  server.cursor=3;server.life="tombstoned";server.expired=true;check(engine.sync("account"));check(db.snapshot.rows.get("asset-a").get("lifecycle").equals("tombstoned"));check(db.snapshot.cursor==3);
  server.cursor=4;server.life="normal";server.expired=false;
  try{engine.sync("account");throw new AssertionError("Resurrection accepted");}catch(IllegalArgumentException expected){check(db.snapshot.cursor==3);}
  db.clearAssets();server.badBaseline=true;
  try{engine.sync("account");throw new AssertionError("Partial baseline installed");}catch(IllegalArgumentException expected){check(db.snapshot==null);}
  server.badBaseline=false;server.expired=false;server.life="normal";check(engine.sync("account"));
  server.cursor=5;server.gap=true;
  try{engine.sync("account");throw new AssertionError("Gap accepted");}catch(IllegalArgumentException expected){check(db.snapshot.cursor==4);}
  check(db.readAssets("another-account")==null);
  NetworkPolicy.api("/v1/assets/authority/baseline?libraryId="+LIB,"GET");
  try{NetworkPolicy.api("/v1/assets/authority/activate","POST");throw new AssertionError("Activate accepted");}catch(IllegalArgumentException expected){check(true);}
  System.out.println("AssetReplicaTest: "+assertions+" assertions passed");
 }
}
