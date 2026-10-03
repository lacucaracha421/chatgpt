// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // GTK3 IBus defaults to asynchronous commits. Finish pending composition
    // before WebKit changes the focused field, so its last syllable cannot
    // arrive in the next input. Set this before GTK or worker threads start,
    // and respect an explicitly configured input-method mode.
    #[cfg(target_os = "linux")]
    if std::env::var_os("IBUS_ENABLE_SYNC_MODE").is_none() {
        std::env::set_var("IBUS_ENABLE_SYNC_MODE", "1");
    }
    // WebKitGTK's DMA-BUF renderer aborts on the NVIDIA proprietary driver under
    // Wayland (Gdk "Error 71 dispatching to Wayland display"). Use the fallback
    // renderer only there, and respect an explicitly configured value.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::path::Path::new("/proc/driver/nvidia/version").exists()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    app_lib::run()
}
