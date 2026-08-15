use chrono::DateTime;
use rusqlite::params;

use super::{
    error::LibraryError,
    models::{AssetMetadataPatch, AssetSummary},
    Library,
};

pub(crate) struct NormalizedSourceMetadata {
    pub published_at: Option<String>,
    pub creator_name: Option<String>,
    pub creator_handle: Option<String>,
    pub creator_url: Option<String>,
}

pub(crate) fn normalize_source_metadata(
    published_at: Option<String>,
    creator_name: Option<String>,
    creator_handle: Option<String>,
    creator_url: Option<String>,
) -> Result<NormalizedSourceMetadata, LibraryError> {
    let published_at = optional_text(published_at);
    if published_at
        .as_deref()
        .is_some_and(|value| DateTime::parse_from_rfc3339(value).is_err())
    {
        return Err(LibraryError::InvalidSourcePublishedAt);
    }
    let creator_url = optional_text(creator_url);
    if creator_url
        .as_deref()
        .is_some_and(|value| !valid_http_url(value))
    {
        return Err(LibraryError::InvalidCreatorUrl);
    }
    Ok(NormalizedSourceMetadata {
        published_at,
        creator_name: optional_text(creator_name),
        creator_handle: optional_text(creator_handle),
        creator_url,
    })
}

impl Library {
    pub fn update_asset_metadata(
        &self,
        request: AssetMetadataPatch,
    ) -> Result<AssetSummary, LibraryError> {
        let metadata = normalize_source_metadata(
            request.source_published_at,
            request.creator_name,
            request.creator_handle,
            request.creator_url,
        )?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE assets
                SET source_published_at = ?2, creator_name = ?3,
                    creator_handle = ?4, creator_url = ?5
              WHERE id = ?1 AND status = 'normal'",
            params![
                request.asset_id,
                metadata.published_at,
                metadata.creator_name,
                metadata.creator_handle,
                metadata.creator_url,
            ],
        )?;
        if changed == 0 {
            return Err(LibraryError::AssetNotFound);
        }
        transaction.commit()?;
        drop(connection);
        self.get_asset(&request.asset_id)
    }
}

fn optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_owned())
    })
}

fn valid_http_url(value: &str) -> bool {
    url::Url::parse(value)
        .ok()
        .is_some_and(|url| matches!(url.scheme(), "http" | "https"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_and_clears_editable_source_metadata() {
        let library = fixture();
        let updated = library
            .update_asset_metadata(AssetMetadataPatch {
                asset_id: "asset-1".into(),
                source_published_at: Some("2026-08-01T10:20:30Z".into()),
                creator_name: Some("  Example Artist  ".into()),
                creator_handle: Some("  example  ".into()),
                creator_url: Some("https://x.com/example".into()),
            })
            .unwrap();
        assert_eq!(updated.creator_name.as_deref(), Some("Example Artist"));
        assert_eq!(updated.creator_handle.as_deref(), Some("example"));

        let cleared = library
            .update_asset_metadata(AssetMetadataPatch {
                asset_id: "asset-1".into(),
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
            })
            .unwrap();
        assert_eq!(cleared.source_published_at, None);
        assert_eq!(cleared.creator_name, None);
        assert_eq!(cleared.creator_handle, None);
        assert_eq!(cleared.creator_url, None);
    }

    #[test]
    fn rejects_invalid_source_metadata_and_missing_assets() {
        let library = fixture();
        let bad_time = library
            .update_asset_metadata(AssetMetadataPatch {
                asset_id: "asset-1".into(),
                source_published_at: Some("not-a-time".into()),
                creator_name: None,
                creator_handle: None,
                creator_url: None,
            })
            .unwrap_err();
        assert!(matches!(bad_time, LibraryError::InvalidSourcePublishedAt));

        let bad_url = library
            .update_asset_metadata(AssetMetadataPatch {
                asset_id: "asset-1".into(),
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: Some("javascript:alert(1)".into()),
            })
            .unwrap_err();
        assert!(matches!(bad_url, LibraryError::InvalidCreatorUrl));

        let missing = library
            .update_asset_metadata(AssetMetadataPatch {
                asset_id: "missing".into(),
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
            })
            .unwrap_err();
        assert!(matches!(missing, LibraryError::AssetNotFound));
    }

    #[test]
    fn invalid_patch_does_not_partially_update_the_asset() {
        let library = fixture();
        library
            .update_asset_metadata(AssetMetadataPatch {
                asset_id: "asset-1".into(),
                source_published_at: None,
                creator_name: Some("Original".into()),
                creator_handle: None,
                creator_url: Some("https://example.com/creator".into()),
            })
            .unwrap();

        let result = library.update_asset_metadata(AssetMetadataPatch {
            asset_id: "asset-1".into(),
            source_published_at: None,
            creator_name: Some("Changed".into()),
            creator_handle: None,
            creator_url: Some("javascript:alert(1)".into()),
        });

        assert!(matches!(result, Err(LibraryError::InvalidCreatorUrl)));
        let unchanged = library.get_asset("asset-1").unwrap();
        assert_eq!(unchanged.creator_name.as_deref(), Some("Original"));
        assert_eq!(
            unchanged.creator_url.as_deref(),
            Some("https://example.com/creator")
        );
    }

    fn fixture() -> Library {
        let root = tempfile::tempdir().unwrap().keep();
        let library = Library::open(root).unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (?1, ?2, 'image', ?3, ?4, ?5, 1, 1, 1, ?6)",
                params![
                    "asset-1", "hash-1", "one.png", "assets/one.png",
                    "thumbnails/one.webp", "2026-08-15T00:00:00Z",
                ],
            )
            .unwrap();
        library
    }
}
