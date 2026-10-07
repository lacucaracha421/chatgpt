package com.lakomics.mobile;

import java.util.LinkedHashMap;
import java.util.Map;

/** Revision-scoped ticket misses, shared by visible artwork and background warming. */
final class CollectionArtworkRequests {
 interface Fetch<T> { T read(String variant) throws Exception; }
 interface Missing { boolean test(Exception error); }
 private static final class Entry {
  final Map<String,Exception> misses=new LinkedHashMap<>();
  volatile boolean thumbnailMissing;
 }
 private final Map<String,Entry> entries=new LinkedHashMap<>();
 private synchronized Entry entry(String key){
  Entry value=entries.get(key);
  if(value==null){value=new Entry();entries.put(key,value);}
  while(entries.size()>4096)entries.remove(entries.keySet().iterator().next());
  return value;
 }
 String variant(String key,String requested){
  Entry value=entry(key);
  return requested.equals("thumbnail")&&value.thumbnailMissing?"original":requested;
 }
 <T> T read(String key,String requested,Fetch<T> fetch,Missing missing)throws Exception{
  Entry value=entry(key);
  try{return readVariant(value,requested,fetch,missing);}
  catch(Exception error){
   if(!requested.equals("thumbnail")||!missing.test(error))throw error;
   return readVariant(value,"original",fetch,missing);
  }
 }
 private <T> T readVariant(Entry value,String variant,Fetch<T> fetch,Missing missing)throws Exception{
  synchronized(value){Exception remembered=value.misses.get(variant);if(remembered!=null)throw remembered;}
  // Do not hold a monitor through network work: native owns cancellable per-file locks.
  try{return fetch.read(variant);}
  catch(Exception error){if(missing.test(error))synchronized(value){value.misses.put(variant,error);if(variant.equals("thumbnail"))value.thumbnailMissing=true;}throw error;}
 }
 synchronized void clear(){entries.clear();}
}
