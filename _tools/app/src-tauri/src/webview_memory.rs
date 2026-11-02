#[cfg(windows)]
pub(crate) fn set_hidden(app: &tauri::AppHandle, hidden: bool) {
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.with_webview(move |webview| unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let Ok(core) = core.cast::<ICoreWebView2_19>() else {
                return;
            };
            // Let Chromium drop caches while the main window is hidden or minimized.
            let level = if hidden {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            };
            let _ = core.SetMemoryUsageTargetLevel(level);
        });
    }
}

#[cfg(not(windows))]
pub(crate) fn set_hidden(_app: &tauri::AppHandle, _hidden: bool) {}
