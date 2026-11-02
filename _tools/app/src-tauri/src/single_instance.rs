#[cfg(windows)]
mod windows {
    use std::ptr::null;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0},
        System::Threading::{CreateEventW, CreateMutexW, SetEvent, WaitForSingleObject, INFINITE},
        UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY},
    };

    #[cfg(debug_assertions)]
    const MUTEX_NAME: &str = "Local\\Lakomics-single-instance-dev";
    #[cfg(not(debug_assertions))]
    const MUTEX_NAME: &str = "Local\\Lakomics-single-instance";
    #[cfg(debug_assertions)]
    const EVENT_NAME: &str = "Local\\Lakomics-open-dev";
    #[cfg(not(debug_assertions))]
    const EVENT_NAME: &str = "Local\\Lakomics-open";

    pub(crate) fn claim() -> Option<usize> {
        let mutex_name: Vec<u16> = MUTEX_NAME.encode_utf16().chain(Some(0)).collect();
        let event_name: Vec<u16> = EVENT_NAME.encode_utf16().chain(Some(0)).collect();
        unsafe {
            let mutex = CreateMutexW(null(), 0, mutex_name.as_ptr());
            if mutex.is_null() {
                return None;
            }
            let already_running = GetLastError() == ERROR_ALREADY_EXISTS;
            if already_running {
                AllowSetForegroundWindow(ASFW_ANY);
                let event = CreateEventW(null(), 0, 0, event_name.as_ptr());
                if !event.is_null() {
                    SetEvent(event);
                    CloseHandle(event);
                }
                CloseHandle(mutex);
                std::process::exit(0);
            }
            let event = CreateEventW(null(), 0, 0, event_name.as_ptr());
            if event.is_null() {
                CloseHandle(mutex);
                return None;
            }
            // Keep the mutex alive until process exit. Move the event to the listener.
            Some(event as usize)
        }
    }

    pub(crate) fn listen(event: Option<usize>, app: &tauri::AppHandle) {
        let Some(event) = event else { return };
        let app = app.clone();
        if std::thread::Builder::new()
            .name("single-instance".into())
            .spawn(move || unsafe {
                let event = event as HANDLE;
                while WaitForSingleObject(event, INFINITE) == WAIT_OBJECT_0 {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || crate::workload::open(&handle));
                }
                CloseHandle(event);
            })
            .is_err()
        {
            unsafe { CloseHandle(event as HANDLE) };
        }
    }
}

#[cfg(windows)]
pub(crate) use windows::{claim, listen};

#[cfg(not(windows))]
pub(crate) fn claim() -> Option<usize> {
    None
}

#[cfg(not(windows))]
pub(crate) fn listen(_: Option<usize>, _: &tauri::AppHandle) {}
