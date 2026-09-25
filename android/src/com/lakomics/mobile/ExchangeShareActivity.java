package com.lakomics.mobile;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * "Share to Lakomics": a compact sheet (target PC, file count, total size, 보내기) that
 * uploads the shared files through {@link ExchangeService}.
 *
 * The sending app's read grant is reliable only while this activity lives, so the upload is
 * started here and the sheet stays open with visible progress until every file is on the
 * server; it then closes itself. Nothing continues after the process is gone.
 */
public final class ExchangeShareActivity extends Activity {
    private static final int TEXT = Color.rgb(221, 220, 206), MUTED = Color.rgb(150, 150, 140), ACCENT = Color.rgb(212, 255, 74),
            SURFACE = Color.rgb(28, 29, 30), DANGER = Color.rgb(255, 120, 110);
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final List<Uri> uris = new ArrayList<>();
    private final List<String> targets = new ArrayList<>();
    private ExchangeService exchange;
    private TextView summary, status;
    private Spinner target;
    private ProgressBar progress;
    private Button send;
    private volatile String batch;
    private boolean destroyed;
    private final ExchangeService.Listener listener = (name, detail) -> {
        if (ExchangeService.EVENT.equals(name)) runOnUiThread(() -> show(detail));
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        exchange = ExchangeService.get(this);
        collect(getIntent());
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        sheet.setPadding(pad, pad, pad, pad);
        GradientDrawable background = new GradientDrawable();
        background.setColor(SURFACE);
        background.setCornerRadius(dp(12));
        sheet.setBackground(background);
        TextView title = text("PC로 보내기", 18, TEXT);
        sheet.addView(title);
        summary = text("파일 " + uris.size() + "개 · 크기 확인 중", 14, MUTED);
        summary.setPadding(0, dp(6), 0, dp(12));
        sheet.addView(summary);
        TextView label = text("받는 기기", 13, MUTED);
        sheet.addView(label);
        target = new Spinner(this);
        target.setMinimumHeight(dp(48));
        sheet.addView(target);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(1000);
        progress.setVisibility(View.GONE);
        sheet.addView(progress);
        status = text("", 14, MUTED);
        status.setPadding(0, dp(8), 0, dp(8));
        sheet.addView(status);
        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.END);
        Button close = new Button(this);
        close.setText("닫기");
        close.setOnClickListener(v -> finish());
        send = new Button(this);
        send.setText("보내기");
        send.setEnabled(false);
        send.setOnClickListener(v -> start());
        actions.addView(close);
        actions.addView(send);
        sheet.addView(actions);
        setContentView(sheet);
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT));
        if (getWindow() != null) getWindow().setLayout(Math.min(getResources().getDisplayMetrics().widthPixels - dp(32), dp(520)), WindowManager.LayoutParams.WRAP_CONTENT);
        if (uris.isEmpty()) { status.setText("보낼 파일이 없습니다."); return; }
        status.setText("받는 기기를 확인하는 중…");
        // Provider queries can be slow (another app's process); keep them off the UI thread.
        worker.execute(() -> { String text = summaryText(); runOnUiThread(() -> { if (!destroyed) summary.setText(text); }); });
        worker.execute(this::loadDevices);
    }

    @Override protected void onResume() { super.onResume(); exchange.setForeground(true); exchange.addListener(listener); }
    @Override protected void onPause() { exchange.removeListener(listener); exchange.setForeground(false); super.onPause(); }
    @Override protected void onDestroy() { destroyed = true; worker.shutdownNow(); super.onDestroy(); }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private void collect(Intent intent) {
        if (intent == null) return;
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri single = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (single != null) uris.add(single);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) for (Uri uri : many) if (uri != null) uris.add(uri);
        }
        if (uris.isEmpty() && intent.getClipData() != null)
            for (int i = 0; i < intent.getClipData().getItemCount(); i++) {
                Uri uri = intent.getClipData().getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
        // Only content the sender granted (a file:// path would bypass that grant), and never
        // this app's own providers, which the upload would read with Lakomics' identity.
        uris.removeIf(uri -> {
            String owner = null;
            try {
                android.content.pm.ProviderInfo provider = uri.getAuthority() == null ? null : getPackageManager().resolveContentProvider(uri.getAuthority(), 0);
                if (provider != null) owner = provider.packageName;
            } catch (RuntimeException ignored) {}
            return !ExchangeTransfer.shareable(uri.getScheme(), uri.getAuthority(), getPackageName(), owner);
        });
    }

    private String summaryText() {
        long total = 0;
        boolean unknown = false;
        for (Uri uri : uris) {
            long size = -1;
            try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) size = cursor.getLong(0);
            } catch (RuntimeException ignored) {}
            if (size < 0) unknown = true; else total += size;
        }
        return "파일 " + uris.size() + "개 · " + (unknown && total == 0 ? "크기 확인 중" : bytes(total) + (unknown ? "+" : ""));
    }

    static String bytes(long value) {
        if (value <= 0) return "0 B";
        String[] units = {"B", "KB", "MB", "GB", "TB"};
        double size = value;
        int unit = 0;
        while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
        return unit == 0 ? value + " B" : String.format(Locale.ROOT, size >= 100 ? "%.0f %s" : "%.1f %s", size, units[unit]);
    }

    private void loadDevices() {
        try {
            JSONObject state = exchange.refreshNow();
            runOnUiThread(() -> devices(state));
        } catch (Exception e) {
            String code = ExchangeService.failureCode(e);
            runOnUiThread(() -> { if (!destroyed) fail(message(code)); });
        }
    }

    private void devices(JSONObject state) {
        if (destroyed) return;
        String code = state.optString("code");
        if (!code.isEmpty()) { fail(message(code)); return; }
        JSONArray devices = state.optJSONArray("devices");
        List<String> names = new ArrayList<>();
        targets.clear();
        if (devices != null) for (int i = 0; i < devices.length(); i++) {
            JSONObject device = devices.optJSONObject(i);
            if (device == null) continue;
            targets.add(device.optString("deviceId"));
            names.add(device.optString("name") + ("pc".equals(device.optString("kind")) ? " (PC)" : ""));
        }
        if (targets.isEmpty()) { fail("등록된 PC가 없습니다. PC의 Lakomics에서 보내기/받기를 한 번 열어 주세요."); return; }
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, names);
        target.setAdapter(adapter);
        status.setText("");
        send.setEnabled(true);
    }

    private void start() {
        int index = target.getSelectedItemPosition();
        if (index < 0 || index >= targets.size()) return;
        String to = targets.get(index);
        send.setEnabled(false);
        target.setEnabled(false);
        status.setTextColor(MUTED);
        status.setText("보낼 준비 중…");
        progress.setVisibility(View.VISIBLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        worker.execute(() -> {
            try {
                JSONObject result = exchange.send(uris, to, false);
                batch = result.getString("batchId");
                JSONObject state = exchange.snapshot();
                runOnUiThread(() -> show(state));
            } catch (ExchangeService.UserError e) {
                runOnUiThread(() -> fail(e.getMessage()));
            } catch (Exception e) {
                runOnUiThread(() -> fail("보내기를 시작하지 못했습니다."));
            }
        });
    }

    /** Aggregate this batch's rows into one progress line. */
    private void show(JSONObject state) {
        String id = batch;
        if (destroyed || id == null || state == null) return;
        JSONArray rows = state.optJSONArray("outgoing");
        if (rows == null) return;
        long total = 0, done = 0;
        int count = 0, finished = 0, failed = 0;
        String failure = "";
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null || !id.equals(row.optString("batchId"))) continue;
            count++;
            String rowState = row.optString("state");
            long size = Math.max(0, row.optLong("sizeBytes"));
            total += size;
            if (Arrays.asList("ready", "delivered").contains(rowState)) { finished++; done += size; }
            else if ("uploading".equals(rowState)) done += Math.min(size, row.optLong("bytes"));
            else if ("failed".equals(rowState)) {
                failed++;
                failure = message(row.optString("code"));
            }
        }
        if (count == 0) return;
        progress.setProgress(total > 0 ? (int) (done * 1000 / total) : 0);
        if (finished == count) {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            status.setTextColor(ACCENT);
            status.setText("보냈습니다. PC가 받으면 서버에서 삭제됩니다.");
            status.postDelayed(() -> { if (!destroyed) finish(); }, 1500);
        } else if (failed > 0 && failed + finished == count) {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            status.setTextColor(DANGER);
            status.setText(failed + "개를 보내지 못했습니다: " + failure + "\nLakomics의 보내기/받기 화면에서 다시 시도할 수 있습니다.");
        } else {
            status.setTextColor(MUTED);
            status.setText((finished + 1) + " / " + count + " 업로드 중 · " + bytes(done) + " / " + bytes(total) + (failed > 0 ? " · 재시도 대기 " + failed : ""));
        }
    }

    private void fail(String message) {
        progress.setVisibility(View.GONE);
        status.setTextColor(DANGER);
        status.setText(message);
        send.setEnabled(false);
    }

    /** The same wording as the in-app screen, for the codes a share can meet. */
    static String message(String code) {
        switch (code == null ? "" : code) {
            case "notConfigured": return "먼저 Lakomics 앱에서 서버를 연결해 주세요.";
            case "tokenMissing": case "exchangeDeviceTokenRequired":
                return "이 기기 전용 토큰이 필요합니다. Lakomics의 보내기/받기 화면에서 입력해 주세요.";
            case "tokenInvalid": case "tokenForbidden": case "exchangeDeviceForbidden":
                return "이 기기의 보내기/받기 토큰을 확인해 주세요.";
            case "unavailable": return "서버가 아직 파일 보내기/받기를 지원하지 않습니다.";
            case "fileTooLarge": return "파일이 너무 큼 (최대 2GB)";
            case "quotaExceeded": return "보관 한도 초과";
            case "batchTooLarge": return "한 번에 최대 100개까지 보낼 수 있음";
            case "targetDeviceUnknown": return "받는 기기가 등록 해제됨";
            case "sourceUnavailable": return "원본 파일을 읽을 수 없음";
            case "network": case "server": case "storageUnavailable": return "서버에 연결할 수 없음 — 자동 재시도";
            default: return "보내지 못했습니다";
        }
    }
}
