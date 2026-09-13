use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::library::error::LibraryError;

const MPV_ARGS: [&str; 9] = [
    "--no-config",
    "--load-scripts=no",
    "--access-references=no",
    "--autoload-files=no",
    "--resume-playback=no",
    "--save-position-on-quit=no",
    "--save-watch-history=no",
    "--terminal=no",
    "--idle=no",
];

pub(super) fn launch(root: &Path, source: &Path) -> Result<(), LibraryError> {
    let source = canonical_vault_media(root, source)?;
    let executable = mpv_path().ok_or(LibraryError::MediaPlayerUnavailable)?;
    let mut command = Command::new(executable);
    command
        .args(MPV_ARGS)
        .arg("--")
        .arg(source)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| LibraryError::MediaPlayerLaunchFailed)?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn canonical_vault_media(root: &Path, source: &Path) -> Result<PathBuf, LibraryError> {
    let root = fs::canonicalize(root).map_err(|_| LibraryError::MediaNotFound)?;
    let metadata = fs::symlink_metadata(source).map_err(|_| LibraryError::MediaNotFound)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(LibraryError::UnsafeMediaPath);
    }
    let source = fs::canonicalize(source).map_err(|_| LibraryError::MediaNotFound)?;
    if source == root || !source.starts_with(&root) {
        return Err(LibraryError::UnsafeMediaPath);
    }
    Ok(source)
}

fn mpv_path() -> Option<PathBuf> {
    let executable = if cfg!(windows) { "mpv.exe" } else { "mpv" };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(executable))
        .find(|path| executable_file(path))
}

#[cfg(windows)]
fn executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(target_os = "linux")]
fn executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(test)]
mod tests {
    use super::{canonical_vault_media, MPV_ARGS};

    #[test]
    fn player_arguments_disable_user_state_and_external_references() {
        assert!(MPV_ARGS.contains(&"--no-config"));
        assert!(MPV_ARGS.contains(&"--load-scripts=no"));
        assert!(MPV_ARGS.contains(&"--access-references=no"));
        assert!(MPV_ARGS.contains(&"--autoload-files=no"));
        assert!(MPV_ARGS.contains(&"--resume-playback=no"));
        assert!(MPV_ARGS.contains(&"--save-position-on-quit=no"));
        assert!(MPV_ARGS.contains(&"--save-watch-history=no"));
        assert!(!MPV_ARGS.iter().any(|value| value.contains("input-ipc")));
    }

    #[test]
    fn canonical_media_must_stay_inside_the_vault() {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        std::fs::create_dir(&vault).unwrap();
        let inside = vault.join("clip.mp4");
        let outside = temp.path().join("outside.mp4");
        std::fs::write(&inside, b"inside").unwrap();
        std::fs::write(&outside, b"outside").unwrap();

        assert_eq!(
            canonical_vault_media(&vault, &inside).unwrap(),
            inside.canonicalize().unwrap()
        );
        assert!(canonical_vault_media(&vault, &outside).is_err());
    }
}
