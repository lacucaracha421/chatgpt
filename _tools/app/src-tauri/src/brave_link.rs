//! Opens an AV work's Jable page in Brave (user request 2026-10-17). The page is fixed to
//! `https://jp.jable.tv/videos/<code>/`, so the command cannot open anything else; without Brave
//! (or off Windows) the default browser opens it instead.

use std::path::{Path, PathBuf};

const URL_PREFIX: &str = "https://jp.jable.tv/videos/";
const MAX_CODE_LEN: usize = 64;

/// The URL when it is exactly a Jable video page for a product code (`[a-z0-9-]+`), else `None`.
fn validated_url(url: &str) -> Option<&str> {
    let code = url.strip_prefix(URL_PREFIX)?.strip_suffix('/')?;
    let plain = !code.is_empty()
        && code.len() <= MAX_CODE_LEN
        && !code.starts_with('-')
        && !code.ends_with('-')
        && code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    plain.then_some(url)
}

/// The `brave.exe` path from `reg query ... /ve` output (the line holding the REG_SZ or
/// REG_EXPAND_SZ value; the "(Default)" label is localized, so it is not matched).
#[cfg_attr(not(windows), allow(dead_code))]
fn registered_path(reg_output: &str) -> Option<PathBuf> {
    reg_output.lines().find_map(|line| {
        let (_, value) = ["REG_EXPAND_SZ", "REG_SZ"]
            .iter()
            .find_map(|kind| line.split_once(kind))?;
        let path = value.trim().trim_matches('"');
        path.to_ascii_lowercase()
            .ends_with("brave.exe")
            .then(|| PathBuf::from(path))
    })
}

/// Where Brave lives when the registry does not say: the per-machine and per-user defaults.
#[cfg_attr(not(windows), allow(dead_code))]
fn default_paths(
    program_files: Option<&Path>,
    program_files_x86: Option<&Path>,
    local_app_data: Option<&Path>,
) -> Vec<PathBuf> {
    let tail = Path::new("BraveSoftware")
        .join("Brave-Browser")
        .join("Application")
        .join("brave.exe");
    [program_files, program_files_x86, local_app_data]
        .into_iter()
        .flatten()
        .map(|root| root.join(&tail))
        .collect()
}

#[cfg(windows)]
fn find_brave() -> Option<PathBuf> {
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
    };
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const APP_PATHS: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\brave.exe";
    let system = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    let reg = PathBuf::from(system).join("System32").join("reg.exe");
    let registered = ["HKLM", "HKCU"].iter().find_map(|hive| {
        let output = Command::new(&reg)
            .args(["query", &format!(r"{hive}\{APP_PATHS}"), "/ve"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| registered_path(&String::from_utf8_lossy(&output.stdout)))
            .flatten()
    });
    let env_path = |name: &str| std::env::var_os(name).map(PathBuf::from);
    registered
        .into_iter()
        .chain(default_paths(
            env_path("ProgramFiles").as_deref(),
            env_path("ProgramFiles(x86)").as_deref(),
            env_path("LOCALAPPDATA").as_deref(),
        ))
        .find(|path| path.is_file())
}

#[cfg(not(windows))]
fn find_brave() -> Option<PathBuf> {
    None
}

#[tauri::command]
pub(crate) async fn open_in_brave(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = validated_url(&url)
        .ok_or_else(|| "열 수 없는 주소입니다.".to_owned())?
        .to_owned();
    let brave = tauri::async_runtime::spawn_blocking(find_brave)
        .await
        .map_err(|_| "브라우저를 열지 못했습니다.".to_owned())?;
    if let Some(brave) = brave {
        // The URL is one argument of its own, never part of a shell line.
        if std::process::Command::new(brave).arg(&url).spawn().is_ok() {
            return Ok(());
        }
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "브라우저를 열지 못했습니다.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_a_jable_video_page_for_a_plain_code() {
        assert!(validated_url("https://jp.jable.tv/videos/fsdss-456/").is_some());
        assert!(validated_url("https://jp.jable.tv/videos/abc123/").is_some());
        for bad in [
            "",
            "https://jp.jable.tv/videos//",
            "https://jp.jable.tv/videos/fsdss-456",
            "https://jp.jable.tv/videos/FSDSS-456/",
            "https://jp.jable.tv/videos/fsdss-456/?a=1",
            "https://jp.jable.tv/videos/fsdss-456/#x",
            "https://jp.jable.tv/videos/fs dss/",
            "https://jp.jable.tv/videos/../admin/",
            "https://jp.jable.tv/videos/a/b/",
            "https://jp.jable.tv/videos/-ab/",
            "http://jp.jable.tv/videos/fsdss-456/",
            "https://jp.jable.tv.evil.test/videos/fsdss-456/",
            "https://jp.jable.tv@evil.test/videos/fsdss-456/",
            "https://www.jable.tv/videos/fsdss-456/",
            "file:///C:/Windows/System32/calc.exe",
        ] {
            assert!(validated_url(bad).is_none(), "{bad}");
        }
        assert!(validated_url(&format!("{URL_PREFIX}{}/", "a".repeat(65))).is_none());
    }

    #[test]
    fn reads_brave_from_a_localized_registry_listing() {
        let english = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\brave.exe\r\n    (Default)    REG_SZ    C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe\r\n";
        let korean = english.replace("(Default)", "(기본값)");
        let expected =
            PathBuf::from(r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe");
        assert_eq!(registered_path(english), Some(expected.clone()));
        assert_eq!(registered_path(&korean), Some(expected));
        assert_eq!(
            registered_path("    (Default)    REG_EXPAND_SZ    \"C:\\Brave\\BRAVE.EXE\"\r\n"),
            Some(PathBuf::from(r"C:\Brave\BRAVE.EXE"))
        );
    }

    #[test]
    fn ignores_a_registry_value_that_is_not_brave() {
        assert_eq!(
            registered_path("    (Default)    REG_SZ    C:\\Tools\\other.exe\r\n"),
            None
        );
        assert_eq!(
            registered_path("ERROR: The system was unable to find the specified registry key"),
            None
        );
        assert_eq!(registered_path(""), None);
    }

    #[test]
    fn lists_the_default_install_folders_in_order_and_skips_unset_ones() {
        let paths = default_paths(Some(Path::new("PF")), None, Some(Path::new("LOCAL")));
        let tail = Path::new("BraveSoftware")
            .join("Brave-Browser")
            .join("Application")
            .join("brave.exe");
        assert_eq!(
            paths,
            vec![Path::new("PF").join(&tail), Path::new("LOCAL").join(&tail)]
        );
        assert!(default_paths(None, None, None).is_empty());
    }
}
