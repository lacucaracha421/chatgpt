use rusqlite::{params, OptionalExtension};

use super::{error::LibraryError, models::AssetSummary, query::asset_summary_from_row, Library};

#[derive(Debug, Clone, PartialEq, Eq)]
enum SourceGroupKey {
    XStatus(String),
}

impl Library {
    pub fn list_source_group_assets(
        &self,
        asset_id: &str,
    ) -> Result<Vec<AssetSummary>, LibraryError> {
        let connection = self.connection()?;
        let source_url = connection
            .query_row(
                "SELECT source_url FROM assets WHERE id = ?1 AND status = 'normal'",
                [asset_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let Some(source_url) = source_url else {
            return Ok(Vec::new());
        };
        let Some(group_key) = source_group_key(&source_url) else {
            return Ok(Vec::new());
        };
        let SourceGroupKey::XStatus(post_id) = &group_key;
        let candidate_pattern = format!("%/status/{post_id}%");
        let mut statement = connection.prepare(
            "SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, asset.favorite, asset.source_url,
             asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count,
             asset.source_published_at, asset.creator_name, asset.creator_handle, asset.creator_url,
             asset.import_source, asset.import_batch_id, asset.original_modified_at
             FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id
             WHERE asset.status = 'normal' AND asset.source_url LIKE ?1
             ORDER BY asset.collected_at ASC, asset.id ASC",
        )?;
        let rows = statement.query_map(params![candidate_pattern], asset_summary_from_row)?;
        let mut assets = Vec::new();
        for row in rows {
            let asset = row?;
            if asset
                .source_url
                .as_deref()
                .and_then(source_group_key)
                .as_ref()
                == Some(&group_key)
            {
                assets.push(asset);
            }
        }
        Ok(assets)
    }
}

fn source_group_key(value: &str) -> Option<SourceGroupKey> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https" || !matches!(url.host_str(), Some("x.com" | "twitter.com")) {
        return None;
    }
    let mut segments = url.path_segments()?;
    let handle = segments.next()?;
    if handle.is_empty() || segments.next()? != "status" {
        return None;
    }
    let post_id = segments.next()?;
    if post_id.is_empty() || !post_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(SourceGroupKey::XStatus(post_id.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_image(library: &Library, id: &str, source_url: &str, collected_at: &str) {
        library.connection().unwrap().execute(
            "INSERT INTO assets (id, content_hash, media_kind, original_name, relative_path, thumbnail_relative_path, byte_size, width, height, source_url, collected_at, favorite, status) VALUES (?1, ?2, 'image', ?3, ?4, ?5, 1, 1, 1, ?6, ?7, 0, 'normal')",
            params![id, format!("hash-{id}"), format!("{id}.png"), format!("assets/{id}.png"), format!("thumbs/{id}.webp"), source_url, collected_at],
        ).unwrap();
    }

    #[test]
    fn groups_x_media_by_status_id_across_hosts_and_media_suffixes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_image(
            &library,
            "a",
            "https://x.com/artist/status/123/photo/1",
            "2026-09-01T00:00:00Z",
        );
        insert_image(
            &library,
            "b",
            "https://twitter.com/artist/status/123/photo/2",
            "2026-09-01T00:00:01Z",
        );
        insert_image(
            &library,
            "other",
            "https://x.com/artist/status/1234/photo/1",
            "2026-09-01T00:00:02Z",
        );
        insert_image(
            &library,
            "web",
            "https://example.com/status/123",
            "2026-09-01T00:00:03Z",
        );

        let group = library.list_source_group_assets("a").unwrap();
        assert_eq!(
            group
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert!(library.list_source_group_assets("web").unwrap().is_empty());
    }
}
