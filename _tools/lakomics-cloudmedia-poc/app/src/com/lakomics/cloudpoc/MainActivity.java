package com.lakomics.cloudpoc;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Log;
import android.widget.Toast;

import java.io.InputStream;

public final class MainActivity extends Activity {
    private static final String TAG = "LakomicsPoC";
    private static final int REQUEST_PICK = 42;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
        intent.setType("image/*");
        startActivityForResult(intent, REQUEST_PICK);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_PICK || resultCode != RESULT_OK || data == null) {
            Log.i(TAG, "PICK_CANCELLED result=" + resultCode);
            finish();
            return;
        }
        Uri uri = data.getData();
        long total = 0;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) total += read;
            Log.i(TAG, "PICK_OK uri=" + uri + " bytes=" + total);
            Toast.makeText(this, "Lakomics PoC OK: " + total + " bytes", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Log.e(TAG, "PICK_READ_FAILED uri=" + uri, e);
            Toast.makeText(this, "PoC read failed: " + e, Toast.LENGTH_LONG).show();
        }
        finish();
    }
}
