use rusqlite::OptionalExtension;

use super::{error::LibraryError, models::RemoteReadingProgress, Library};

pub(crate) fn get_progress(
    library: &Library,
    provider: &str,
    work_id: &str,
) -> Result<Option<RemoteReadingProgress>, LibraryError> {
    validate_identity(provider, work_id)?;
    library
        .connection()?
        .query_row(
            "SELECT provider, work_id, last_page, page_count, last_read_at
             FROM remote_reading_progress WHERE provider = ?1 AND work_id = ?2",
            (provider, work_id),
            |row| {
                Ok(RemoteReadingProgress {
                    provider: row.get(0)?,
                    work_id: row.get(1)?,
                    last_page: row.get::<_, i64>(2)? as u32,
                    page_count: row.get::<_, i64>(3)? as u32,
                    last_read_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

pub(crate) fn save_progress(
    library: &Library,
    progress: &RemoteReadingProgress,
) -> Result<(), LibraryError> {
    validate_identity(&progress.provider, &progress.work_id)?;
    if progress.last_page == 0
        || progress.page_count == 0
        || progress.last_page > progress.page_count
    {
        return Err(LibraryError::InvalidRemoteReadingProgress);
    }
    library.connection()?.execute(
        "INSERT INTO remote_reading_progress
            (provider, work_id, last_page, page_count, last_read_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(provider, work_id) DO UPDATE SET
            last_page = excluded.last_page,
            page_count = excluded.page_count,
            last_read_at = excluded.last_read_at",
        rusqlite::params![
            progress.provider,
            progress.work_id,
            progress.last_page,
            progress.page_count,
            chrono::Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn validate_identity(provider: &str, work_id: &str) -> Result<(), LibraryError> {
    if provider != "kHentai" || work_id.parse::<u64>().ok().filter(|id| *id > 0).is_none() {
        return Err(LibraryError::InvalidRemoteReadingProgress);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{get_progress, save_progress};
    use crate::library::{models::RemoteReadingProgress, Library};

    #[test]
    fn progress_upsert_is_isolated_by_provider_and_work() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        save_progress(
            &library,
            &RemoteReadingProgress {
                provider: "kHentai".into(),
                work_id: "42".into(),
                last_page: 2,
                page_count: 10,
                last_read_at: String::new(),
            },
        )
        .unwrap();
        save_progress(
            &library,
            &RemoteReadingProgress {
                provider: "kHentai".into(),
                work_id: "43".into(),
                last_page: 4,
                page_count: 8,
                last_read_at: String::new(),
            },
        )
        .unwrap();
        save_progress(
            &library,
            &RemoteReadingProgress {
                provider: "kHentai".into(),
                work_id: "42".into(),
                last_page: 7,
                page_count: 10,
                last_read_at: String::new(),
            },
        )
        .unwrap();

        assert_eq!(
            get_progress(&library, "kHentai", "42")
                .unwrap()
                .unwrap()
                .last_page,
            7
        );
        assert_eq!(
            get_progress(&library, "kHentai", "43")
                .unwrap()
                .unwrap()
                .last_page,
            4
        );
    }

    #[test]
    fn progress_rejects_invalid_page_ranges_and_provider() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        for progress in [
            RemoteReadingProgress {
                provider: "hitomi".into(),
                work_id: "42".into(),
                last_page: 1,
                page_count: 1,
                last_read_at: String::new(),
            },
            RemoteReadingProgress {
                provider: "kHentai".into(),
                work_id: "42".into(),
                last_page: 0,
                page_count: 1,
                last_read_at: String::new(),
            },
            RemoteReadingProgress {
                provider: "kHentai".into(),
                work_id: "42".into(),
                last_page: 2,
                page_count: 1,
                last_read_at: String::new(),
            },
        ] {
            assert!(save_progress(&library, &progress).is_err());
        }
    }
}
