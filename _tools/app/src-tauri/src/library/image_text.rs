//! Optional image translations are a local cache, independent of asset revisions.
use super::{error::LibraryError, Library};
use crate::cloud::client::CloudClient;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageTextBox {
    pub x0: u16,
    pub y0: u16,
    pub x1: u16,
    pub y1: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageTextLine {
    pub original: String,
    pub korean: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#box: Option<ImageTextBox>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetImageText {
    pub lines: Vec<ImageTextLine>,
    pub digest: String,
}

/// Keep up to 60 valid lines; invalid boxes lose only their coordinates.
pub(crate) fn validate(value: &Value) -> Option<AssetImageText> {
    let input = value.as_array()?;
    let mut lines = Vec::new();
    let mut dropped = false;
    for line in input {
        let strings = line["original"].as_str().zip(line["korean"].as_str());
        let Some((original, korean)) = strings else {
            dropped = true;
            continue;
        };
        let (original, korean) = (original.trim(), korean.trim());
        if korean.is_empty() || original.chars().count() > 800 || korean.chars().count() > 800 {
            dropped = true;
            continue;
        }
        let box_value = &line["box"];
        let coordinate = |key: &str| {
            box_value[key]
                .as_u64()
                .filter(|v| *v <= 1000)
                .map(|v| v as u16)
        };
        let bounds = (|| {
            let bounds = ImageTextBox {
                x0: coordinate("x0")?,
                y0: coordinate("y0")?,
                x1: coordinate("x1")?,
                y1: coordinate("y1")?,
            };
            (bounds.x0 < bounds.x1 && bounds.y0 < bounds.y1).then_some(bounds)
        })();
        dropped |= !box_value.is_null() && bounds.is_none();
        lines.push(ImageTextLine {
            original: original.into(),
            korean: korean.into(),
            r#box: bounds,
        });
        if lines.len() == 60 {
            break;
        }
    }
    if dropped {
        eprintln!("image text: dropped invalid lines or boxes");
    }
    if lines.is_empty() {
        return None;
    }
    let payload = canonical_payload(&lines);
    Some(AssetImageText {
        lines,
        digest: Sha256::digest(payload.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    })
}

fn canonical_payload(lines: &[ImageTextLine]) -> String {
    // Explicit sorted maps also work if serde_json's preserve_order feature is enabled.
    let rows: Vec<_> = lines
        .iter()
        .map(|line| {
            let mut row = std::collections::BTreeMap::new();
            if let Some(bounds) = &line.r#box {
                let coordinates = std::collections::BTreeMap::from([
                    ("x0", bounds.x0),
                    ("x1", bounds.x1),
                    ("y0", bounds.y0),
                    ("y1", bounds.y1),
                ]);
                row.insert(
                    "box",
                    serde_json::to_value(coordinates).expect("integer coordinates"),
                );
            }
            row.insert("korean", Value::String(line.korean.clone()));
            row.insert("original", Value::String(line.original.clone()));
            row
        })
        .collect();
    serde_json::to_string(&rows).expect("image text contains only strings and integers")
}

impl Library {
    pub fn asset_image_text(&self, asset_id: &str) -> Result<Option<AssetImageText>, LibraryError> {
        let row: Option<(String, String)> = self
            .connection()?
            .query_row(
                "SELECT payload,digest FROM asset_image_text WHERE asset_id=?1",
                [asset_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        row.map(|(payload, digest)| {
            let lines =
                serde_json::from_str(&payload).map_err(|_| LibraryError::InvalidCloudResponse)?;
            Ok(AssetImageText { lines, digest })
        })
        .transpose()
    }

    pub(crate) fn store_asset_image_text(
        &self,
        asset_id: &str,
        text: &AssetImageText,
    ) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "INSERT INTO asset_image_text(asset_id,payload,digest,updated_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(asset_id) DO UPDATE SET payload=excluded.payload,digest=excluded.digest,
             updated_at=excluded.updated_at WHERE asset_image_text.digest<>excluded.digest",
            params![
                asset_id,
                canonical_payload(&text.lines),
                text.digest,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub(crate) fn store_capture_image_text(&self, asset_id: &str, raw: Option<&Value>) {
        let Some(raw) = raw else { return };
        let Some(text) = validate(raw) else {
            eprintln!("cloud capture image text {asset_id}: dropping invalid text");
            return;
        };
        if let Err(error) = self.store_asset_image_text(asset_id, &text) {
            eprintln!("cloud capture image text {asset_id}: {error}");
        }
    }

    pub(crate) fn refresh_asset_image_text_with(
        &self,
        asset_id: &str,
        client: &CloudClient,
        token: &str,
    ) -> Result<Option<AssetImageText>, LibraryError> {
        // Never hold the SQLite connection while waiting for the network.
        match client.get_asset_image_text(asset_id, token)? {
            Some(text) => {
                self.store_asset_image_text(asset_id, &text)?;
                Ok(Some(text))
            }
            None => {
                self.connection()?
                    .execute("DELETE FROM asset_image_text WHERE asset_id=?1", [asset_id])?;
                Ok(None)
            }
        }
    }

    pub fn refresh_asset_image_text(
        &self,
        asset_id: &str,
    ) -> Result<Option<AssetImageText>, LibraryError> {
        let config = self.cloud_sync_config()?;
        let Some(base) = config.api_base_url else {
            return self.asset_image_text(asset_id);
        };
        let token = match super::credential::read_cloud_api_token_os() {
            Ok(token) => token,
            Err(LibraryError::CloudCredentialNotConfigured) => {
                return self.asset_image_text(asset_id)
            }
            Err(error) => return Err(error),
        };
        self.refresh_asset_image_text_with(asset_id, &self.cloud_client(&base)?, token.expose())
    }
}

#[cfg(test)]
#[path = "image_text_tests.rs"]
mod tests;
