package com.lakomics.mobile;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Range rules of the native media proxy (`/media-stream/`), independent of Android and HTTP.
 *
 * The WebView's Range header is forwarded to storage unchanged in meaning; the storage reply
 * must describe exactly the bytes asked for (start, end and total size) before any byte is
 * handed to the media element. Only single `bytes=` ranges exist here: Chromium's media
 * loader never sends multi-range requests.
 */
final class MediaStreamRange {
 private MediaStreamRange(){}
 /** The storage reply does not match the request or the known object size. */
 static final class Mismatch extends IOException{Mismatch(String message){super(message);}}
 /** A syntactically unsupported Range header; the proxy answers 416. */
 static final class Unsupported extends Exception{Unsupported(){super("Unsupported range");}}

 /** One requested range: `first-last`, `first-` (last = -1) or a suffix `-suffix`. */
 static final class Request {
  final long first,last,suffix;
  private Request(long first,long last,long suffix){this.first=first;this.last=last;this.suffix=suffix;}
  static Request from(long first,long last){return new Request(first,last,-1);}
  boolean isSuffix(){return suffix>=0;}
  /** The header sent to storage for exactly this range. */
  String header(){return isSuffix()?"bytes=-"+suffix:"bytes="+first+"-"+(last<0?"":Long.toString(last));}
  /** Fixed log vocabulary: never offsets. */
  String kind(){return isSuffix()?"suffix":last<0?"open":"bounded";}
 }

 /** `null` means no Range header (a plain 200 request). */
 static Request parse(String header)throws Unsupported{
  if(header==null)return null;
  String value=header.trim();
  if(!value.matches("bytes=(?:[0-9]{1,18}-[0-9]{0,18}|-[0-9]{1,18})"))throw new Unsupported();
  String[] parts=value.substring(6).split("-",-1);
  try{
   if(parts[0].isEmpty()){long suffix=Long.parseLong(parts[1]);if(suffix==0)throw new Unsupported();return new Request(-1,-1,suffix);}
   long first=Long.parseLong(parts[0]),last=parts[1].isEmpty()?-1:Long.parseLong(parts[1]);
   if(last>=0&&last<first)throw new Unsupported();
   return new Request(first,last,-1);
  }catch(NumberFormatException e){throw new Unsupported();}
 }

 /** What one validated storage reply carries: object bytes [start, start+count) of `total`. */
 static final class Plan {
  final int status;final long start,count,total;
  Plan(int status,long start,long count,long total){this.status=status;this.start=start;this.count=count;this.total=total;}
  long end(){return start+count;}
  String reason(){return status==206?"Partial Content":"OK";}
  /** Response headers for the WebView; Content-Type travels as the response MIME type. */
  Map<String,String> headers(){
   Map<String,String> h=base();
   h.put("Content-Length",Long.toString(count));
   if(status==206)h.put("Content-Range","bytes "+start+"-"+(start+count-1)+"/"+total);
   return h;
  }
 }
 static Map<String,String> base(){
  Map<String,String> h=new LinkedHashMap<>();
  h.put("Cache-Control","no-store");h.put("X-Content-Type-Options","nosniff");h.put("Accept-Ranges","bytes");
  return h;
 }
 /** Headers of a 416 answer; `total` is unknown when not positive. */
 static Map<String,String> unsatisfiable(long total){Map<String,String> h=base();if(total>0)h.put("Content-Range","bytes */"+total);return h;}

 /** The object size in a `Content-Range: bytes * /N` (416) reply, or -1. */
 static long unsatisfiedTotal(String contentRange){
  if(contentRange==null)return -1;
  String value=contentRange.trim();
  if(!value.matches("bytes \\*/[0-9]{1,18}"))return -1;
  return Long.parseLong(value.substring(8));
 }

 /**
  * Validates a storage reply (status 200 or 206) against the request and the object size.
  *
  * @param expectedTotal the object size the ticket or an earlier reply named, or <= 0 when unknown
  * @return the plan to answer the WebView with; 206 for every ranged request, 200 otherwise
  */
 static Plan validate(Request request,int status,String contentRange,String contentLength,long expectedTotal)throws Mismatch{
  long length=length(contentLength);
  if(status==206){
   long[] span=span(contentRange);long start=span[0],last=span[1],total=span[2];
   if(expectedTotal>0&&total!=expectedTotal)throw new Mismatch("Object size changed");
   if(length>=0&&length!=last-start+1)throw new Mismatch("Content-Length does not match Content-Range");
   if(request==null){
    // No Range was sent, so only a reply covering the whole object is acceptable.
    if(start!=0||last!=total-1)throw new Mismatch("Partial reply to a full request");
    return new Plan(200,0,total,total);
   }
   long[] wanted=wanted(request,total);
   if(start!=wanted[0]||last!=wanted[1])throw new Mismatch("Content-Range does not match the request");
   return new Plan(206,start,last-start+1,total);
  }
  if(status==200){
   if(length<=0)throw new Mismatch("Missing Content-Length");
   if(expectedTotal>0&&length!=expectedTotal)throw new Mismatch("Object size changed");
   if(request==null)return new Plan(200,0,length,length);
   // Storage ignored the Range: acceptable only when the whole object was asked for.
   long[] wanted=wanted(request,length);
   if(wanted[0]!=0||wanted[1]!=length-1)throw new Mismatch("Range ignored by storage");
   return new Plan(206,0,length,length);
  }
  throw new Mismatch("Unexpected status");
 }
 /** [first, last] the request covers in an object of `total` bytes; unsatisfiable ranges are a mismatch. */
 static long[] wanted(Request request,long total)throws Mismatch{
  if(total<=0)throw new Mismatch("Empty object");
  if(request.isSuffix()){long count=Math.min(request.suffix,total);return new long[]{total-count,total-1};}
  if(request.first>=total)throw new Mismatch("Range starts past the object");
  return new long[]{request.first,request.last<0?total-1:Math.min(request.last,total-1)};
 }
 private static long length(String header)throws Mismatch{
  if(header==null)return -1;
  String value=header.trim();
  if(!value.matches("[0-9]{1,18}"))throw new Mismatch("Invalid Content-Length");
  return Long.parseLong(value);
 }
 /** `bytes a-b/total` with a known total; anything else is a mismatch. */
 private static long[] span(String header)throws Mismatch{
  if(header==null)throw new Mismatch("Missing Content-Range");
  String value=header.trim();
  if(!value.matches("bytes [0-9]{1,18}-[0-9]{1,18}/[0-9]{1,18}"))throw new Mismatch("Invalid Content-Range");
  int dash=value.indexOf('-'),slash=value.indexOf('/');
  long start=Long.parseLong(value.substring(6,dash)),last=Long.parseLong(value.substring(dash+1,slash)),total=Long.parseLong(value.substring(slash+1));
  if(last<start||last>=total)throw new Mismatch("Invalid Content-Range");
  return new long[]{start,last,total};
 }
}
