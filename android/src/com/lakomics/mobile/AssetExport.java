package com.lakomics.mobile;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.OperationCanceledException;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * The viewer's explicit 저장/공유 of one Library original (U04).
 *
 * Both read the original through `MediaRepository.open`, the verified cache the Android file
 * picker already uses (512 MiB limit, ticket digest check). Saving publishes a copy to
 * MediaStore, hidden (IS_PENDING) until it is complete and removed when it is not. Sharing grants
 * the receiving app read access to this app's own document URI for that Asset only, after the
 * original is in the cache so the receiver does not wait on the network.
 */
final class AssetExport {
    private static final long IDLE_NANOS = TimeUnit.SECONDS.toNanos(30);
    private AssetExport() {}

    static JSONObject save(Context context, MediaRepository media, String assetId, String hint, CancellationSignal signal) throws Exception {
        if (Build.VERSION.SDK_INT < 29) throw new ExchangeService.UserError("이 Android 버전에서는 원본을 저장할 수 없습니다.");
        if (!AssetExportPolicy.assetId(assetId)) throw new IllegalArgumentException("Invalid asset id");
        String mime = AssetExportPolicy.mime(hint);
        AssetExportPolicy.Kind kind = AssetExportPolicy.kind(mime);
        ContentResolver resolver = context.getContentResolver();
        try (ParcelFileDescriptor original = open(media, assetId, signal); InputStream in = new FileInputStream(original.getFileDescriptor())) {
            Uri target;
            try {
                target = resolver.insert(collection(kind), values(assetId, mime, kind));
            } catch (IllegalArgumentException refused) {
                // MediaStore refuses a type its image/video collection does not accept; keep the file in Downloads instead.
                kind = AssetExportPolicy.Kind.FILE;
                target = resolver.insert(collection(kind), values(assetId, mime, kind));
            }
            if (target == null) throw new ExchangeService.UserError("기기 저장 공간에 저장하지 못했습니다.");
            boolean committed = false;
            try {
                try (OutputStream out = resolver.openOutputStream(target, "w")) {
                    if (out == null) throw new IOException("No output");
                    long size = original.getStatSize();
                    MediaTransfer.copyWhileProgressing(in, out, MediaRepository.MAX_ORIGINAL, size > 0 ? size : -1, IDLE_NANOS, signal::throwIfCanceled);
                }
                signal.throwIfCanceled();
                ContentValues ready = new ContentValues();
                ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
                if (resolver.update(target, ready, null, null) != 1) throw new IOException("Cannot publish");
                committed = true;
            } catch (IOException failure) {
                throw new ExchangeService.UserError("기기 저장 공간에 저장하지 못했습니다. 남은 공간을 확인해 주세요.");
            } finally {
                if (!committed) resolver.delete(target, null, null);
            }
        }
        return new JSONObject().put("folder", AssetExportPolicy.folderName(kind));
    }

    /** The chooser intent for one Asset's original; the caller starts it on the UI thread. */
    static Intent share(MediaRepository media, String assetId, String hint, CancellationSignal signal) throws Exception {
        if (!AssetExportPolicy.assetId(assetId)) throw new IllegalArgumentException("Invalid asset id");
        try (ParcelFileDescriptor ignored = open(media, assetId, signal)) {
            signal.throwIfCanceled();
        }
        Uri uri = DocumentsContract.buildDocumentUri(LibraryDocumentsProvider.AUTHORITY, "asset:" + assetId);
        Intent send = new Intent(Intent.ACTION_SEND).setType(AssetExportPolicy.mime(hint)).putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newRawUri(null, uri));
        return Intent.createChooser(send, null);
    }

    private static ParcelFileDescriptor open(MediaRepository media, String assetId, CancellationSignal signal) throws Exception {
        if (media == null) throw new ExchangeService.UserError("미디어 캐시를 사용할 수 없습니다. 앱을 다시 열어 주세요.");
        try {
            return media.open(assetId, "original", signal);
        } catch (OperationCanceledException canceled) {
            throw canceled;
        } catch (FileNotFoundException unavailable) {
            if (signal.isCanceled()) throw new OperationCanceledException();
            throw new ExchangeService.UserError("원본을 받지 못했습니다. 연결을 확인하고 다시 시도해 주세요. (512 MiB까지)");
        }
    }

    private static Uri collection(AssetExportPolicy.Kind kind) {
        switch (kind) {
            case IMAGE: return MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            case VIDEO: return MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            default: return MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        }
    }

    private static ContentValues values(String assetId, String mime, AssetExportPolicy.Kind kind) {
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, AssetExportPolicy.displayName(assetId, mime));
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, AssetExportPolicy.folder(kind));
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        return values;
    }
}
