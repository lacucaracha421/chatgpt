package com.lakomics.mobile;

import android.content.*;
import android.content.res.AssetFileDescriptor;
import android.database.MatrixCursor;
import android.graphics.Point;
import android.os.*;
import android.provider.CloudMediaProvider;
import android.provider.CloudMediaProviderContract;
import java.io.FileNotFoundException;
import java.util.*;

/** Android 13+ Photo Picker bridge; Android controls provider eligibility. */
public final class LibraryCloudProvider extends CloudMediaProvider {
    private static final String ALBUM=CloudMediaProviderContract.EXTRA_ALBUM_ID, GENERATION=CloudMediaProviderContract.EXTRA_SYNC_GENERATION,
        TOKEN=CloudMediaProviderContract.EXTRA_PAGE_TOKEN, PAGE=CloudMediaProviderContract.EXTRA_PAGE_SIZE;
    // Older modular Photo Picker versions use these optional filter keys.
    private static final String MIME="android.provider.extra.MIME_TYPE", SIZE="android.provider.extra.SIZE_LIMIT_BYTES";
    private static final String[] MEDIA_COLUMNS={"id","date_taken_millis","sync_generation","mime_type","standard_mime_type_extension","size_bytes","duration_millis","is_favorite","width","height","orientation"};
    @Override public boolean onCreate(){PickerLibrary.get(getContext());return true;}
    private PickerSnapshot snapshot(){return PickerLibrary.get(getContext()).current();}
    @Override public Bundle onGetMediaCollectionInfo(Bundle args){PickerSnapshot s=snapshot();Bundle b=new Bundle();b.putString("media_collection_id",s.collection);b.putLong("last_media_sync_generation",s.generation);b.putString("account_name","Lakomics");b.putParcelable("account_configuration_intent",new Intent(getContext(),MainActivity.class));return b;}
    private static Bundle args(Bundle b){return b==null?Bundle.EMPTY:b;}
    private static String[] mimes(Bundle b){String[] values=b.getStringArray(Intent.EXTRA_MIME_TYPES);String single=b.getString(MIME);return values!=null?values:single==null?null:new String[]{single};}
    private static String version(PickerSnapshot s,String kind,Bundle b){return s.collection+"/"+s.generation+"/"+kind+"/"+Objects.hash(b.getString(ALBUM),b.getLong(GENERATION,-1),Arrays.hashCode(mimes(b)),b.getLong(SIZE,0));}
    private static int count(Bundle b){int n=b.getInt(PAGE,500);return n<=0?500:Math.min(n,1000);}
    private static void attach(MatrixCursor c,PickerSnapshot s,Bundle request,String token,String... keys){Bundle b=new Bundle();b.putString(CloudMediaProviderContract.EXTRA_MEDIA_COLLECTION_ID,s.collection);ArrayList<String> honored=new ArrayList<>();for(String key:keys)if(request.containsKey(key))honored.add(key);b.putStringArrayList(ContentResolver.EXTRA_HONORED_ARGS,honored);if(token!=null)b.putString(TOKEN,token);c.setExtras(b);}
    @Override public MatrixCursor onQueryMedia(Bundle extras){
        Bundle b=args(extras);PickerSnapshot s=snapshot();List<PickerSnapshot.Media> rows=s.select(b.getString(ALBUM),b.getLong(GENERATION,-1),mimes(b),b.getLong(SIZE,0));
        String version=version(s,"media",b);int start=PickerSnapshot.offset(b.getString(TOKEN),version),end=Math.min(rows.size(),start+count(b));MatrixCursor c=new MatrixCursor(MEDIA_COLUMNS);
        for(int i=start;i<end;i++){PickerSnapshot.Media m=rows.get(i);c.addRow(new Object[]{m.id,m.date,m.generation,m.mime,0,m.size,m.duration,0,m.width,m.height,0});}
        attach(c,s,b,end<rows.size()?version+":"+end:null,ALBUM,GENERATION,TOKEN,PAGE,MIME,Intent.EXTRA_MIME_TYPES,SIZE);return c;
    }
    @Override public MatrixCursor onQueryDeletedMedia(Bundle extras){Bundle b=args(extras);PickerSnapshot s=snapshot();List<String> ids=new ArrayList<>();long after=b.getLong(GENERATION,-1);for(Map.Entry<String,Long> row:s.deleted.entrySet())if(row.getValue()>after)ids.add(row.getKey());String version=version(s,"deleted",b);int start=PickerSnapshot.offset(b.getString(TOKEN),version),end=Math.min(ids.size(),start+count(b));MatrixCursor c=new MatrixCursor(new String[]{"id"});for(int i=start;i<end;i++)c.addRow(new Object[]{ids.get(i)});attach(c,s,b,end<ids.size()?version+":"+end:null,GENERATION,TOKEN,PAGE);return c;}
    @Override public MatrixCursor onQueryAlbums(Bundle extras){
        Bundle b=args(extras);PickerSnapshot s=snapshot();Map<String,List<PickerSnapshot.Media>> groups=new HashMap<>();
        for(PickerSnapshot.Media m:s.select(null,-1,mimes(b),b.getLong(SIZE,0)))for(String id:m.albums)if(s.albums.containsKey(id))groups.computeIfAbsent(id,key->new ArrayList<>()).add(m);
        List<String> ids=new ArrayList<>(groups.keySet());ids.sort(Comparator.comparingLong((String id)->groups.get(id).get(0).date).reversed().thenComparing(id->id));
        String version=version(s,"albums",b);int start=PickerSnapshot.offset(b.getString(TOKEN),version),end=Math.min(ids.size(),start+count(b));
        MatrixCursor c=new MatrixCursor(new String[]{"id","date_taken_millis","display_name",CloudMediaProviderContract.AlbumColumns.MEDIA_COVER_ID,CloudMediaProviderContract.AlbumColumns.MEDIA_COUNT});
        for(int i=start;i<end;i++){String id=ids.get(i);List<PickerSnapshot.Media> members=groups.get(id);PickerSnapshot.Media cover=members.get(0);c.addRow(new Object[]{id,cover.date,s.albums.get(id),cover.id,members.size()});}
        // Album queries deliberately return the complete filtered album list, not a media-generation delta.
        attach(c,s,b,end<ids.size()?version+":"+end:null,TOKEN,PAGE,MIME,Intent.EXTRA_MIME_TYPES,SIZE);return c;
    }
    private ParcelFileDescriptor open(String id,String variant,CancellationSignal signal)throws FileNotFoundException {
        if(!snapshot().media.containsKey(id))throw new FileNotFoundException("Media is not in the current library");
        return MediaRepository.get(getContext()).open(id,variant,signal);
    }
    @Override public ParcelFileDescriptor onOpenMedia(String id,Bundle extras,CancellationSignal signal)throws FileNotFoundException{return open(id,"original",signal);}
    @Override public AssetFileDescriptor onOpenPreview(String id,Point size,Bundle extras,CancellationSignal signal)throws FileNotFoundException {
        // Without THUMBNAIL Android expects real media (in particular a playable video), not a JPEG poster.
        String variant=args(extras).getBoolean(CloudMediaProviderContract.EXTRA_PREVIEW_THUMBNAIL,false)?"thumbnail":"original";
        return new AssetFileDescriptor(open(id,variant,signal),0,AssetFileDescriptor.UNKNOWN_LENGTH);
    }
}
