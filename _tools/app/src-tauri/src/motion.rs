//! Machine-local motion preference, read before creating the main WebView.
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::Manager;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Preference {
    #[default]
    System,
    Always,
}

static ACTIVE: OnceLock<Preference> = OnceLock::new();

// Calling additional_browser_args replaces Wry's defaults, including autoplay.
// Keep the defaults from the pinned Wry version when no explicit args are configured.
#[cfg(any(windows, test))]
const DEFAULT_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";
#[cfg(any(windows, test))]
const FORCE_MOTION: &str = "--force-prefers-no-reduced-motion";

#[cfg(any(windows, test))]
fn browser_args(existing: Option<&str>, preference: Preference) -> Option<String> {
    match preference {
        Preference::System => existing.map(str::to_owned),
        Preference::Always => Some(format!(
            "{} {FORCE_MOTION}",
            existing.unwrap_or(DEFAULT_BROWSER_ARGS)
        )),
    }
}

pub(crate) fn create_main_window(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path = app.path().app_config_dir()?.join("library-machine.json");
    // A broken settings file must never keep the app from opening.
    let preference = crate::library::machine_settings::motion(&path).unwrap_or_default();
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or("main window configuration is missing")?;
    let builder = tauri::WebviewWindowBuilder::from_config(app, config)?;
    #[cfg(windows)]
    let builder = match browser_args(config.additional_browser_args.as_deref(), preference) {
        Some(args) => builder.additional_browser_args(&args),
        None => builder,
    };
    // Linux/macOS use WebKit rather than Chromium: this Windows-only switch is
    // unsupported there, so their native reduced-motion preference is unchanged.
    let _ = ACTIVE.set(preference);
    builder.build()?;
    Ok(())
}

/// WebView2 windows share one browser process, so every later window must
/// start with the same arguments as the main window or its creation fails.
pub(crate) fn apply_browser_args<'a, R: tauri::Runtime, M: Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
    app: &tauri::AppHandle<R>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    #[cfg(windows)]
    {
        let existing = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .and_then(|window| window.additional_browser_args.clone());
        let preference = ACTIVE.get().copied().unwrap_or_default();
        if let Some(args) = browser_args(existing.as_deref(), preference) {
            return builder.additional_browser_args(&args);
        }
    }
    #[cfg(not(windows))]
    let _ = app;
    builder
}

#[derive(Serialize)]
pub(crate) struct Status {
    selected: Preference,
    active: Preference,
}

#[tauri::command]
pub(crate) fn motion_preference(
    app: tauri::AppHandle,
    preference: Option<Preference>,
) -> Result<Status, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("library-machine.json");
    if let Some(preference) = preference {
        crate::library::machine_settings::set_motion(&path, preference)
            .map_err(|error| error.to_string())?;
    }
    Ok(Status {
        selected: crate::library::machine_settings::motion(&path)
            .map_err(|error| error.to_string())?,
        active: ACTIVE.get().copied().unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn motion_switch_is_only_added_for_always_and_preserves_browser_args() {
        assert_eq!(browser_args(None, Preference::System), None);
        let existing = "--disable-features=Example --custom-argument=value";
        assert_eq!(
            browser_args(Some(existing), Preference::System).as_deref(),
            Some(existing)
        );
        assert_eq!(
            browser_args(Some(existing), Preference::Always).unwrap(),
            format!("{existing} {FORCE_MOTION}")
        );
        assert_eq!(
            browser_args(None, Preference::Always).unwrap(),
            format!("{DEFAULT_BROWSER_ARGS} {FORCE_MOTION}")
        );
    }
}
