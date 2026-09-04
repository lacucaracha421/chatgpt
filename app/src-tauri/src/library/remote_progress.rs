use rusqlite::OptionalExtension;

use super::{
    catalog_provider::{CatalogProvider, CatalogWorkIdentity},
    error::LibraryError,
    models::RemoteReadingProgress,
    Library,
};

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
                    identity: CatalogWorkIdentity::new(
                        CatalogProvider::from_tag(row.get_ref(0)?.as_str()?)
                            .ok_or(rusqlite::Error::InvalidQuery)?,
                        row.get::<_, String>(1)?,
                    )
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
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
    validate_identity(
        progress.identity.provider.as_str(),
        &progress.identity.provider_work_id,
    )?;
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
            progress.identity.provider.as_str(),
            progress.identity.provider_work_id,
            progress.last_page,
            progress.page_count,
            chrono::Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn validate_identity(provider: &str, work_id: &str) -> Result<(), LibraryError> {
    // kHentai는 기존 VCK 식별자, heliotrope는 hitomi gallery id다. 두 id 공간은
    // 겹치지 않으므로 provider 태그로 격리된다.
    if super::catalog_provider::CatalogProvider::from_tag(provider).is_none()
        || work_id.trim().is_empty()
    {
        return Err(LibraryError::InvalidRemoteReadingProgress);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{get_progress, save_progress};
    use crate::library::{
        catalog_provider::{CatalogProvider, CatalogWorkIdentity},
        models::RemoteReadingProgress,
        Library,
    };

    fn progress(
        identity: CatalogWorkIdentity,
        last_page: u32,
        page_count: u32,
    ) -> RemoteReadingProgress {
        RemoteReadingProgress {
            identity,
            last_page,
            page_count,
            last_read_at: String::new(),
        }
    }

    #[test]
    fn progress_upsert_is_isolated_by_provider_and_work() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        save_progress(
            &library,
            &progress(CatalogWorkIdentity::khentai(42), 2, 10),
        )
        .unwrap();
        save_progress(
            &library,
            &progress(
                CatalogWorkIdentity::new(CatalogProvider::Heliotrope, "42").unwrap(),
                9,
                10,
            ),
        )
        .unwrap();
        save_progress(
            &library,
            &progress(CatalogWorkIdentity::khentai(43), 4, 8),
        )
        .unwrap();
        save_progress(
            &library,
            &progress(CatalogWorkIdentity::khentai(42), 7, 10),
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
        assert_eq!(
            get_progress(&library, "heliotrope", "42")
                .unwrap()
                .unwrap()
                .last_page,
            9
        );
    }

    #[test]
    fn progress_rejects_invalid_page_ranges_and_provider() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        for progress in [
            progress(
                CatalogWorkIdentity {
                    provider: CatalogProvider::KHentai,
                    provider_work_id: String::new(),
                },
                1,
                1,
            ),
            progress(CatalogWorkIdentity::khentai(42), 0, 1),
            progress(CatalogWorkIdentity::khentai(42), 2, 1),
        ] {
            assert!(save_progress(&library, &progress).is_err());
        }
    }
}
