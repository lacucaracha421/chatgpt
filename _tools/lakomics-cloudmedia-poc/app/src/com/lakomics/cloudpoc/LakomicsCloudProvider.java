package com.lakomics.cloudpoc;

import android.content.ContentResolver;
import android.content.res.AssetFileDescriptor;
import android.database.MatrixCursor;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Point;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.CloudMediaProvider;
import android.provider.CloudMediaProviderContract;
import android.util.Log;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;

public final class LakomicsCloudProvider extends CloudMediaProvider {
    private static final String COLLECTION_ID = "lakomics-poc-collection-v2";
    private static final long SYNC_GENERATION = 2L;

    private static final String MEDIA_UPLOAD = "lakimics-poc-upload";
    private static final String MEDIA_BLUE = "lakomics-poc-blue";
    private static final String MEDIA_ARTIST = "lakomics-poc-artist";

    private static final String ALBUM_UPLOAD = "album-upload";
    private static final String ALBUM_BLUE = "album-blue";
    private static final String ALBUM_ARTIST = "album-artist";

    private File uploadFile;
    private File blueFile;
    private File artistFile;

    @Override
    public boolean onCreate() {
        try {
            ensureMediaFiles();
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    @Override
    public Bundle onGetMediaCollectionInfo(Bundle extras) {
        Bundle out = new Bundle();
        out.putString(CloudMediaProviderContract.MediaCollectionInfo.MEDIA_COLLECTION_ID, COLLECTION_ID);
        out.putLong(CloudMediaProviderContract.MediaCollectionInfo.LAST_MEDIA_SYNC_GENERATION, SYNC_GENERATION);
        out.putString(CloudMediaProviderContract.MediaCollectionInfo.ACCOUNT_NAME, "Lakomics PoC");
        if (extras != null && extras.containsKey(CloudMediaProviderContract.EXTRA_ALBUM_ID)) {
            out.putStringArrayList(ContentResolver.EXTRA_HONORED_ARGS,
                    new java.util.ArrayList<String>(java.util.Arrays.asList(
                            CloudMediaProviderContract.EXTRA_ALBUM_ID)));
        }
        Log.i("LakomicsCMP", "collection info incoming=" + extras + " outgoing=" + out);
        return out;
    }

    private static void attachCollectionExtras(MatrixCursor cursor, String... honoredArgs) {
        Bundle out = new Bundle();
        out.putString(CloudMediaProviderContract.EXTRA_MEDIA_COLLECTION_ID, COLLECTION_ID);
        if (honoredArgs != null && honoredArgs.length > 0) {
            out.putStringArrayList(ContentResolver.EXTRA_HONORED_ARGS,
                    new java.util.ArrayList<String>(java.util.Arrays.asList(honoredArgs)));
        }
        cursor.setExtras(out);
        Log.i("LakomicsCMP", "cursor extras=" + out + " honored=" + java.util.Arrays.toString(honoredArgs));
    }

    @Override
    public MatrixCursor onQueryMedia(Bundle extras) {
        String[] columns = new String[] {
            CloudMediaProviderContract.MediaColumns.ID,
            CloudMediaProviderContract.MediaColumns.DATE_TAKEN_MILLIS,
            CloudMediaProviderContract.MediaColumns.SYNC_GENERATION,
            CloudMediaProviderContract.MediaColumns.MIME_TYPE,
            CloudMediaProviderContract.MediaColumns.STANDARD_MIME_TYPE_EXTENSION,
            CloudMediaProviderContract.MediaColumns.SIZE_BYTES,
            CloudMediaProviderContract.MediaColumns.DURATION_MILLIS,
            CloudMediaProviderContract.MediaColumns.IS_FAVORITE,
            CloudMediaProviderContract.MediaColumns.WIDTH,
            CloudMediaProviderContract.MediaColumns.HEIGHT,
            CloudMediaProviderContract.MediaColumns.ORIENTATION,
            CloudMediaProviderContract.MediaColumns.MEDIA_STORE_URI
        };
        MatrixCursor cursor = new MatrixCursor(columns);
        String albumId = extras == null ? null :
                extras.getString(CloudMediaProviderContract.EXTRA_ALBUM_ID);
        Log.i("LakomicsCMP", "onQueryMedia incoming=" + extras + " albumId=" + albumId);
        try {
            ensureMediaFiles();
            if (albumId == null) {
                addMediaRow(cursor, MEDIA_UPLOAD, uploadFile, 30);
                addMediaRow(cursor, MEDIA_BLUE, blueFile, 20);
                addMediaRow(cursor, MEDIA_ARTIST, artistFile, 10);
            } else if (ALBUM_UPLOAD.equals(albumId)) {
                addMediaRow(cursor, MEDIA_UPLOAD, uploadFile, 30);
            } else if (ALBUM_BLUE.equals(albumId)) {
                addMediaRow(cursor, MEDIA_BLUE, blueFile, 20);
            } else if (ALBUM_ARTIST.equals(albumId)) {
                addMediaRow(cursor, MEDIA_ARTIST, artistFile, 10);
            }
        } catch (IOException ignored) { }
        if (albumId != null) {
            attachCollectionExtras(cursor, CloudMediaProviderContract.EXTRA_ALBUM_ID);
        } else {
            attachCollectionExtras(cursor);
        }
        return cursor;
    }

    private void addMediaRow(MatrixCursor cursor, String id, File file, long orderSeconds) {
        long date = System.currentTimeMillis() - orderSeconds * 1000L;
        cursor.addRow(new Object[] {
            id, date, SYNC_GENERATION, "image/png", 0,
            file.length(), 0L, 1, 768, 512, 0, null
        });
    }

    @Override
    public MatrixCursor onQueryDeletedMedia(Bundle extras) {
        MatrixCursor cursor = new MatrixCursor(new String[] {
            CloudMediaProviderContract.MediaColumns.ID
        });
        attachCollectionExtras(cursor);
        return cursor;
    }

    @Override
    public MatrixCursor onQueryAlbums(Bundle extras) {
        MatrixCursor cursor = new MatrixCursor(new String[] {
            CloudMediaProviderContract.AlbumColumns.ID,
            CloudMediaProviderContract.AlbumColumns.DATE_TAKEN_MILLIS,
            CloudMediaProviderContract.AlbumColumns.DISPLAY_NAME,
            CloudMediaProviderContract.AlbumColumns.MEDIA_COVER_ID,
            CloudMediaProviderContract.AlbumColumns.MEDIA_COUNT
        });
        long now = System.currentTimeMillis();
        cursor.addRow(new Object[] { ALBUM_UPLOAD, now, "업로드 후보", MEDIA_UPLOAD, 1L });
        cursor.addRow(new Object[] { ALBUM_BLUE, now - 1000, "게이 - 블루 아카이브", MEDIA_BLUE, 1L });
        cursor.addRow(new Object[] { ALBUM_ARTIST, now - 2000, "작가 - TEST", MEDIA_ARTIST, 1L });
        attachCollectionExtras(cursor);
        return cursor;
    }

    @Override
    public ParcelFileDescriptor onOpenMedia(
            String mediaId, Bundle extras, CancellationSignal signal) throws FileNotFoundException {
        File file = fileForMediaId(mediaId);
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public AssetFileDescriptor onOpenPreview(
            String mediaId, Point size, Bundle extras, CancellationSignal signal) throws FileNotFoundException {
        File file = fileForMediaId(mediaId);
        ParcelFileDescriptor pfd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
        return new AssetFileDescriptor(pfd, 0, file.length());
    }

    private File fileForMediaId(String mediaId) throws FileNotFoundException {
        try {
            ensureMediaFiles();
      } catch (IOException e) {
            FileNotFoundException out = new FileNotFoundException("Unable to create PoC media");
            out.initCause(e);
            throw out;
        }
        if (MEDIA_UPLOAD.equals(mediaId)) return uploadFile;
        if (MEDIA_BLUE.equals(mediaId)) return blueFile;
        if (MEDIA_ARTIST.equals(mediaId)) return artistFile;
        throw new FileNotFoundException("Unknown media id: " + mediaId);
    }

    private synchronized void ensureMediaFiles() throws IOException {
        if (uploadFile == null) uploadFile = new File(getContext().getCacheDir(), "upload-candidate.png");
        if (blueFile == null) blueFile = new File(getContext().getCacheDir(), "blue-archive.png");
        if (artistFile == null) artistFile = new File(getContext().getCacheDir(), "artist-test.png");
        ensureImage(uploadFile, "UPLOAD CANDIDATE", "album: upload");
        ensureImage(blueFile, "BLUE ARCHIVE", "album: game");
        ensureImage(artistFile, "ARTIST TEST", "album: artist");
    }

    private void ensureImage(File file, String title, String subtitle) throws IOException {
        if (file.exists() && file.length() > 0) return;

        Bitmap bitmap = Bitmap.createBitmap(768, 512, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(Color.rgb(24, 27, 32));

        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.rgb(221, 216, 202));
        canvas.drawRoundRect(64, 64, 704, 448, 36, 36, paint);
        paint.setColor(Color.rgb(45, 49, 56));
        paint.setTextAlign(Paint.Align.CENTER);
        paint.setTextSize(52f);
        paint.setFakeBoldText(true);
        canvas.drawText("LAKOMICS", 384, 205, paint);
        paint.setTextSize(42f);
        canvas.drawText(title, 384, 285, paint);
        paint.setTextSize(28f);
        paint.setFakeBoldText(false);
        canvas.drawText(subtitle, 384, 355, paint);

        try (FileOutputStream out = new FileOutputStream(file)) {
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                throw new IOException("PNG compression failed");
            }
        } finally {
            bitmap.recycle();
        }
    }
}
