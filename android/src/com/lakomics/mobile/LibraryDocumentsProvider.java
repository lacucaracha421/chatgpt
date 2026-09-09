package com.lakomics.mobile;
import android.content.*;
import android.database.*;
import android.net.Uri;
import android.os.*;
import android.graphics.Point;
import android.content.res.AssetFileDescriptor;
import android.provider.*;
import android.util.Base64;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
public final class LibraryDocumentsProvider extends DocumentsProvider {
 static final Object CONNECTION_LOCK=new Object();
 private static final Set<CancellationSignal> providerRequests=ConcurrentHashMap.newKeySet();
 private static final java.util.concurrent.atomic.AtomicInteger connectionChanges=new java.util.concurrent.atomic.AtomicInteger();
 static void beginConnectionChange(){connectionChanges.incrementAndGet();for(CancellationSignal s:providerRequests)s.cancel();}
 static void endConnectionChange(){connectionChanges.decrementAndGet();}
 private JSONObject api(String path,String method,JSONObject body,CancellationSignal cancel)throws Exception{
  CancellationSignal signal=cancel==null?new CancellationSignal():cancel;providerRequests.add(signal);
  try{if(connectionChanges.get()>0)throw new OperationCanceledException();signal.throwIfCanceled();return client.api(path,method,body,signal);}finally{providerRequests.remove(signal);}
 }
 static final String AUTHORITY="com.lakomics.mobile.documents", ROOT="root", ALL="all";
 private static final String[] DOC_COLUMNS={DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_FLAGS,DocumentsContract.Document.COLUMN_SIZE};
 private static final String[] ROOT_COLUMNS={DocumentsContract.Root.COLUMN_ROOT_ID,DocumentsContract.Root.COLUMN_DOCUMENT_ID,DocumentsContract.Root.COLUMN_TITLE,DocumentsContract.Root.COLUMN_FLAGS,DocumentsContract.Root.COLUMN_MIME_TYPES,DocumentsContract.Root.COLUMN_SUMMARY};
 private SecureSettings settings;private CloudClient client;private File metadata;private JSONArray classes=new JSONArray();private long classesAt=0,classesGeneration=-1;private static volatile long generation=0;
 @Override public boolean onCreate(){settings=new SecureSettings(getContext());client=new CloudClient(settings);metadata=new File(getContext().getCacheDir(),"document-metadata");metadata.mkdirs();return true;}
 static void reset(Context context){generation++;context.revokeUriPermission(Uri.parse("content://"+AUTHORITY),Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);for(String name:new String[]{"document-metadata","document-media"}){File dir=new File(context.getCacheDir(),name);File[] files=dir.listFiles();if(files!=null)for(File f:files)if(f.isFile())f.delete();}context.getContentResolver().notifyChange(DocumentsContract.buildRootsUri(AUTHORITY),null);context.getContentResolver().notifyChange(DocumentsContract.buildChildDocumentsUri(AUTHORITY,ROOT),null);}
 private boolean configured(){try{return settings.status().getBoolean("configured");}catch(Exception e){return false;}}
 @Override public Cursor queryRoots(String[] projection){MatrixCursor c=new MatrixCursor(projection==null?ROOT_COLUMNS:projection);if(configured()){Map<String,Object> values=new HashMap<>();values.put("root_id","library");values.put("document_id",ROOT);values.put("title","Lakomics");values.put("summary","Cloud Library · read only");values.put("flags",DocumentsContract.Root.FLAG_SUPPORTS_IS_CHILD);values.put("mime_types","image/*\nvideo/*");add(c,values);}c.setNotificationUri(getContext().getContentResolver(),DocumentsContract.buildRootsUri(AUTHORITY));return c;}
 private void add(MatrixCursor c,Map<String,Object> values){MatrixCursor.RowBuilder row=c.newRow();for(String col:c.getColumnNames())row.add(values.get(col));}
 private void directory(MatrixCursor c,String id,String name){Map<String,Object> v=new HashMap<>();v.put("document_id",id);v.put("_display_name",name);v.put("mime_type",DocumentsContract.Document.MIME_TYPE_DIR);v.put("flags",DocumentsContract.Document.FLAG_DIR_PREFERS_GRID|(id.startsWith("page:")?DocumentsContract.Document.FLAG_DIR_BLOCKS_OPEN_DOCUMENT_TREE:0));add(c,v);}
 private void asset(MatrixCursor c,JSONObject a)throws Exception{String id=a.getString("id");Map<String,Object> v=new HashMap<>();v.put("document_id","asset:"+id);String mime=a.optString("content_type","application/octet-stream");String ext=android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);v.put("_display_name",id+(ext==null?"":"."+ext));v.put("mime_type",mime);v.put("_size",a.optLong("size_bytes",0));v.put("flags",a.optBoolean("thumbnail_available")?DocumentsContract.Document.FLAG_SUPPORTS_THUMBNAIL:0);add(c,v);}
 private synchronized JSONArray classifications(CancellationSignal cancel)throws Exception{if(System.currentTimeMillis()-classesAt>60000 || classesGeneration!=generation){classes=api("/v1/library/classifications","GET",null,cancel).getJSONArray("items");classesAt=System.currentTimeMillis();classesGeneration=generation;}return classes;}
 private String nameFor(String id,CancellationSignal cancel)throws Exception{JSONArray a=classifications(cancel);for(int i=0;i<a.length();i++)if(a.getJSONObject(i).getString("id").equals(id))return a.getJSONObject(i).optString("name",id);throw new FileNotFoundException("Classification unavailable");}
 private File metaFile(String id)throws Exception{return new File(metadata,hash(id)+".json");}
 private void remember(JSONObject a)throws Exception{File f=metaFile(a.getString("id"));try(FileOutputStream out=new FileOutputStream(f)){out.write(a.toString().getBytes(StandardCharsets.UTF_8));}trim(metadata,8L*1024*1024,null);}
 private JSONObject recalled(String id)throws Exception{return recalled(id,null);}
 private JSONObject recalled(String id,CancellationSignal cancel)throws Exception{File f=metaFile(id);if(!f.isFile()){JSONObject ticket=api("/v1/library/assets/"+Uri.encode(id)+"/media-ticket","POST",new JSONObject().put("variant","original"),cancel);JSONObject a=new JSONObject().put("id",id).put("content_type",ticket.optString("content_type","application/octet-stream")).put("size_bytes",ticket.optLong("size_bytes",0)).put("thumbnail_available",false);remember(a);return a;}try(FileInputStream in=new FileInputStream(f)){ByteArrayOutputStream out=new ByteArrayOutputStream();CloudClient.copy(in,out,65536,null);return new JSONObject(out.toString("UTF-8"));}}
 @Override public Cursor queryDocument(String id,String[] projection)throws FileNotFoundException{MatrixCursor c=new MatrixCursor(projection==null?DOC_COLUMNS:projection);try{synchronized(CONNECTION_LOCK){if(!configured())throw new Exception();if(id.equals(ROOT))directory(c,id,"Lakomics");else if(id.equals(ALL))directory(c,id,"All assets");else if(id.startsWith("class:"))directory(c,id,nameFor(id.substring(6),null));else if(id.startsWith("page:"))directory(c,id,"More assets");else if(id.startsWith("asset:"))asset(c,recalled(id.substring(6)));else throw new Exception();}}catch(Exception e){throw missing();}return c;}
 @Override public Cursor queryChildDocuments(String parent,String[] projection,String sortOrder)throws FileNotFoundException{return children(parent,projection,new CancellationSignal());}
 @Override public Cursor queryChildDocuments(String parent,String[] projection,Bundle args)throws FileNotFoundException{return children(parent,projection,new CancellationSignal());}
 private Cursor children(String parent,String[] projection,CancellationSignal cancel)throws FileNotFoundException{
  MatrixCursor c=new MatrixCursor(projection==null?DOC_COLUMNS:projection);Uri notify=DocumentsContract.buildChildDocumentsUri(AUTHORITY,parent);c.setNotificationUri(getContext().getContentResolver(),notify);
  try{synchronized(CONNECTION_LOCK){cancel.throwIfCanceled();if(!configured())throw new Exception();String classId="",cursor="";
   if(parent.startsWith("page:")){JSONObject page=new JSONObject(new String(Base64.decode(parent.substring(5),Base64.URL_SAFE|Base64.NO_WRAP),StandardCharsets.UTF_8));classId=page.getString("classification");cursor=page.getString("cursor");}
   else if(parent.equals(ROOT) || parent.startsWith("class:") || parent.equals(ALL)){
    if(parent.startsWith("class:"))classId=parent.substring(6);
    if(parent.equals(ROOT))directory(c,ALL,"All assets");
    if(!parent.equals(ALL)){JSONArray list=classifications(cancel);for(int i=0;i<list.length();i++){JSONObject entry=list.getJSONObject(i);String ancestor=entry.isNull("parent_id")?"":entry.optString("parent_id","");if(ancestor.equals(classId))directory(c,"class:"+entry.getString("id"),entry.optString("name","Classification"));}}
    if(parent.equals(ROOT))return c;
   }else throw new Exception();
   String path="/v1/library/assets?limit=100"+(classId.isEmpty()?"":"&classification_id="+Uri.encode(classId))+(cursor.isEmpty()?"":"&cursor="+Uri.encode(cursor));JSONObject result=api(path,"GET",null,cancel);JSONArray items=result.getJSONArray("items");
   for(int i=0;i<items.length();i++){JSONObject a=items.getJSONObject(i);remember(a);asset(c,a);}
   if(!result.isNull("next_cursor") && !result.optString("next_cursor").isEmpty()){String p=new JSONObject().put("classification",classId).put("cursor",result.getString("next_cursor")).toString();directory(c,"page:"+Base64.encodeToString(p.getBytes(StandardCharsets.UTF_8),Base64.URL_SAFE|Base64.NO_WRAP),"More assets →");}
  }}catch(OperationCanceledException e){c.close();throw e;}catch(Exception e){Bundle extras=new Bundle();extras.putString(DocumentsContract.EXTRA_ERROR,"Cannot load cloud library. Open Lakomics to check your connection.");c.setExtras(extras);}return c;
 }
 @Override public boolean isChildDocument(String parent,String document){
  // A continuation can be navigated to pick files, but cannot widen a tree grant.
  if(parent.equals(document) || parent.startsWith("page:"))return false;
  try{synchronized(CONNECTION_LOCK){if(!configured())return false;
   // Cached gallery metadata is display-only; tree grants require current server evidence.
   if(parent.startsWith("class:") && document.startsWith("asset:"))return api("/v1/library/classifications/"+Uri.encode(parent.substring(6))+"/contains/"+Uri.encode(document.substring(6)),"GET",null,null).optBoolean("is_child",false);
   String pageClass=null;if(document.startsWith("page:"))pageClass=new JSONObject(new String(Base64.decode(document.substring(5),Base64.URL_SAFE|Base64.NO_WRAP),StandardCharsets.UTF_8)).getString("classification");
   Map<String,String> parents=new HashMap<>();List<String> memberships=new ArrayList<>();
   if(parent.startsWith("class:")){JSONArray list=api("/v1/library/classifications","GET",null,null).getJSONArray("items");for(int i=0;i<list.length();i++){JSONObject c=list.getJSONObject(i);parents.put(c.getString("id"),c.isNull("parent_id")?null:c.optString("parent_id",null));}
   }
   return DocumentTreePolicy.isChild(parent,document,pageClass,parents,memberships);
  }}catch(Exception e){return false;}
 }
 @Override public ParcelFileDescriptor openDocument(String id,String mode,CancellationSignal cancel)throws FileNotFoundException{if(!"r".equals(mode))throw new FileNotFoundException("Read only");return open(id,"original",cancel);}
 @Override public AssetFileDescriptor openDocumentThumbnail(String id,Point size,CancellationSignal cancel)throws FileNotFoundException{return new AssetFileDescriptor(open(id,"thumbnail",cancel),0,AssetFileDescriptor.UNKNOWN_LENGTH);}
 private ParcelFileDescriptor open(String document,String variant,CancellationSignal cancel)throws FileNotFoundException{
  if(!document.startsWith("asset:"))throw missing();
  return MediaRepository.get(getContext()).open(document.substring(6),variant,cancel);
 }
 private static String hash(String value)throws Exception{byte[] bytes=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));StringBuilder s=new StringBuilder();for(byte b:bytes)s.append(String.format(Locale.ROOT,"%02x",b&255));return s.toString();}
 private static void trim(File directory,long max,File retain){File[] files=directory.listFiles();if(files==null)return;Arrays.sort(files,Comparator.comparingLong(File::lastModified));long total=0;for(File f:files)total+=f.length();for(File f:files){if(total<=max)break;if(!f.equals(retain)){long n=f.length();if(f.delete())total-=n;}}}
 private static FileNotFoundException missing(){return new FileNotFoundException("Document unavailable; reconnect and browse its classification.");}
}
