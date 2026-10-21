use std::{
    fs, io,
    path::Path,
    time::{Duration, SystemTime},
};

/// Crash leftovers only: never walk subdirectories or follow a staging symlink.
pub(super) fn sweep(root: &Path) {
    if let Err(error) = sweep_at(root, SystemTime::now()) {
        eprintln!("import staging cleanup skipped: {error}");
    }
}

fn sweep_at(root: &Path, now: SystemTime) -> io::Result<()> {
    let assets = root.join("assets");
    if !fs::symlink_metadata(&assets)?.file_type().is_dir() {
        return Ok(());
    }
    let directory = assets.join(".staging");
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        let result = (|| -> io::Result<()> {
            let entry = entry?;
            let path = entry.path();
            if path.extension().is_none_or(|extension| extension != "part") {
                return Ok(());
            }
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_file()
                && now.duration_since(metadata.modified()?).unwrap_or_default()
                    > Duration::from_secs(24 * 60 * 60)
            {
                fs::remove_file(&path)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("import staging entry cleanup skipped: {error}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_import_staging_removes_only_old_part_files() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("assets/.staging");
        fs::create_dir_all(&directory).unwrap();
        let now = SystemTime::now();
        for name in ["old.part", "fresh.part", "keep.txt"] {
            let file = fs::File::create(directory.join(name)).unwrap();
            if name != "fresh.part" {
                file.set_modified(now - Duration::from_secs(25 * 60 * 60))
                    .unwrap();
            }
        }
        fs::create_dir(directory.join("nested.part")).unwrap();
        fs::write(directory.join("nested.part/old.part"), []).unwrap();
        let _library = super::super::Library::open(temp.path()).unwrap();
        assert!(!directory.join("old.part").exists());
        assert!(directory.join("fresh.part").exists());
        assert!(directory.join("keep.txt").exists());
        assert!(directory.join("nested.part/old.part").exists());
    }
}
