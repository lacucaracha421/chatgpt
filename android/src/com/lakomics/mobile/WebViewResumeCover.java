package com.lakomics.mobile;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewTreeObserver;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.ImageView;
import java.util.function.BooleanSupplier;

/** One memory-only viewport, covering re-raster after a background pause. Main thread only. */
final class WebViewResumeCover {
    private final ImageView overlay;
    private final BooleanSupplier allowed;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Bitmap snapshot;
    private WebView drawing;
    private ViewTreeObserver.OnDrawListener nextDraw;
    private long epoch;
    private final Runnable timeout = this::clear;

    WebViewResumeCover(FrameLayout host, BooleanSupplier allowed) {
        this.allowed = allowed;
        overlay = new ImageView(host.getContext());
        overlay.setScaleType(ImageView.ScaleType.FIT_XY);
        overlay.setVisibility(View.GONE);
        overlay.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        // A stale frame cannot accept input while the real page catches up.
        overlay.setClickable(true);
        host.addView(overlay);
    }

    void pause(WebView web) {
        cancelWait();
        if (!allowed.getAsBoolean() || web == null) { clear(); return; }
        // A quick second pause during restoration must not capture an unpainted WebView.
        if (snapshot != null) return;
        int width = web.getWidth(), height = web.getHeight();
        if (width <= 0 || height <= 0) return;
        Bitmap candidate = null;
        try {
            candidate = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            web.draw(new Canvas(candidate));
            if (!allowed.getAsBoolean()) { candidate.recycle(); return; }
            snapshot = candidate;
            FrameLayout.LayoutParams bounds = new FrameLayout.LayoutParams(width, height);
            bounds.leftMargin = web.getLeft(); bounds.topMargin = web.getTop();
            overlay.setLayoutParams(bounds);
            overlay.setImageBitmap(snapshot);
            // Attach before the next resume's first window frame, with no fade.
            overlay.setVisibility(View.VISIBLE);
        } catch (RuntimeException | OutOfMemoryError failure) {
            if (candidate != null && candidate != snapshot) candidate.recycle();
            clear();
        }
    }

    void resume(WebView web) {
        cancelWait();
        if (!allowed.getAsBoolean() || snapshot == null || web == null
                || snapshot.getWidth() != web.getWidth() || snapshot.getHeight() != web.getHeight()) {
            clear(); return;
        }
        final long request = epoch;
        handler.postDelayed(timeout, 600);
        try {
            web.postVisualStateCallback(request, new WebView.VisualStateCallback() {
                @Override public void onComplete(long id) {
                    if (request != epoch || snapshot == null) return;
                    if (!allowed.getAsBoolean()) { clear(); return; }
                    // The callback promises the NEXT draw, not a frame already on screen.
                    drawing = web;
                    nextDraw = () -> web.postOnAnimation(() -> {
                        if (request == epoch) clear();
                    });
                    web.getViewTreeObserver().addOnDrawListener(nextDraw);
                    web.invalidate();
                }
            });
        } catch (RuntimeException failure) { clear(); }
    }

    private void cancelWait() {
        epoch++;
        handler.removeCallbacks(timeout);
        if (drawing != null && nextDraw != null && drawing.getViewTreeObserver().isAlive())
            drawing.getViewTreeObserver().removeOnDrawListener(nextDraw);
        drawing = null; nextDraw = null;
    }

    void clear() {
        cancelWait();
        overlay.setVisibility(View.GONE);
        overlay.setImageDrawable(null);
        // Let the render thread release any bitmap it is still using; never persist it.
        snapshot = null;
    }
}
