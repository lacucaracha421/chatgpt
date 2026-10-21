//! Short-lived clipboard images used by the manual favourite cover importer.
use super::{background_task_error, CommandError};
use std::io::Write;
use tauri::{AppHandle, Manager};

const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;

fn image_extension(mime_type: &str, byte_size: usize) -> Result<&'static str, CommandError> {
    if byte_size == 0 || byte_size > MAX_IMAGE_BYTES {
        return Err(CommandError {
            code: "invalidClipboardImage",
            message: "이미지는 64 MiB 이하의 비어 있지 않은 파일이어야 합니다.".into(),
        });
    }
    match mime_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        "image/gif" => Ok("gif"),
        "image/avif" => Ok("avif"),
        "image/bmp" => Ok("bmp"),
        _ => Err(CommandError {
            code: "invalidClipboardImage",
            message: "지원하지 않는 클립보드 이미지 형식입니다.".into(),
        }),
    }
}

fn io_error(error: impl std::fmt::Display) -> CommandError {
    CommandError {
        code: "clipboardImageFile",
        message: format!("붙여넣기 임시 파일을 처리하지 못했습니다: {error}"),
    }
}

#[tauri::command]
pub async fn stage_clipboard_image(
    app: AppHandle,
    mime_type: String,
    bytes: Vec<u8>,
) -> Result<String, CommandError> {
    let extension = image_extension(&mime_type, bytes.len())?;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(io_error)?
        .join("clipboard-images");
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&directory).map_err(io_error)?;
        let mut file = tempfile::Builder::new()
            .prefix("cover-")
            .suffix(&format!(".{extension}"))
            .tempfile_in(directory)
            .map_err(io_error)?;
        file.write_all(&bytes).map_err(io_error)?;
        let (_, path) = file.keep().map_err(io_error)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| background_task_error())?
}

#[tauri::command]
pub async fn remove_clipboard_image(app: AppHandle, path: String) -> Result<(), CommandError> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(io_error)?
        .join("clipboard-images");
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::PathBuf::from(path);
        // Only files created in our staging directory may be removed by this command.
        let parent = path.parent().ok_or_else(|| io_error("invalid path"))?;
        if parent.canonicalize().map_err(io_error)? != directory.canonicalize().map_err(io_error)?
            || !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("cover-"))
        {
            return Err(io_error("invalid clipboard image path"));
        }
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(error)),
        }
    })
    .await
    .map_err(|_| background_task_error())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_image_validates_size_and_extension() {
        for (mime, extension) in [
            ("image/png", "png"),
            ("image/jpeg", "jpg"),
            ("image/webp", "webp"),
            ("image/gif", "gif"),
            ("image/avif", "avif"),
            ("image/bmp", "bmp"),
        ] {
            assert_eq!(image_extension(mime, MAX_IMAGE_BYTES).unwrap(), extension);
        }
        assert!(image_extension("image/svg+xml", 100).is_err());
        assert!(image_extension("image/png", MAX_IMAGE_BYTES + 1).is_err());
        assert!(image_extension("image/png", 0).is_err());
    }
}
