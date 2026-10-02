//! Durable thumbnail operation identities and exact replication commit replays.
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{client::CloudClient, models::ReplicationCommitRequest};
use crate::library::error::LibraryError;

pub(super) const MAX_BYTES: usize = 2 * 1024 * 1024;

pub(super) fn digest(bytes: &[u8]) -> String {
    super::sync::hex_digest(&Sha256::digest(bytes))
}

#[derive(Debug)]
pub(super) enum UploadError {
    UnknownRoute,
    Renew,
    Failed(LibraryError),
}
impl From<LibraryError> for UploadError {
    fn from(error: LibraryError) -> Self {
        Self::Failed(error)
    }
}
impl UploadError {
    pub(super) fn library(self) -> LibraryError {
        match self {
            Self::Failed(error) => error,
            Self::Renew => LibraryError::CloudReplicationCommitRejected(409),
            Self::UnknownRoute => LibraryError::CloudReplicationPrepareRejected(404),
        }
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct PreparedThumbnail {
    pub asset_id: String,
    pub upload_id: String,
    pub thumbnail_key: String,
    pub upload_url: Option<String>,
    pub required_headers: std::collections::BTreeMap<String, String>,
    pub committed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Operation {
    pub operation_id: String,
    pub sha256: String,
    pub size_bytes: usize,
    pub commit: Option<ReplicationCommitRequest>,
}

// Separate resumable transfer state, scoped to the configured server and work item.
// No schema change to the canonical library or credentials in the journal.
pub(super) struct Journal {
    connection: Connection,
    scope: String,
}
impl Journal {
    pub(super) fn open(root: &Path, server: &str, work: &str) -> Result<Self, LibraryError> {
        let directory = root.join(".cache/cloud-thumbnail-uploads");
        std::fs::create_dir_all(&directory).map_err(|source| LibraryError::CreateDirectory {
            path: directory.clone(),
            source,
        })?;
        let connection = Connection::open(directory.join("operations.sqlite"))?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS operations (scope TEXT PRIMARY KEY, body TEXT NOT NULL)",
        )?;
        Ok(Self {
            connection,
            scope: digest(format!("{server}\n{work}").as_bytes()),
        })
    }

    pub(super) fn load(&self) -> Result<Option<Operation>, LibraryError> {
        let body: Option<String> = self
            .connection
            .query_row(
                "SELECT body FROM operations WHERE scope=?1",
                [&self.scope],
                |row| row.get(0),
            )
            .optional()?;
        body.map(|body| serde_json::from_str(&body).map_err(|_| LibraryError::InvalidCloudResponse))
            .transpose()
    }

    pub(super) fn save(&self, operation: &Operation) -> Result<(), LibraryError> {
        let body =
            serde_json::to_string(operation).map_err(|_| LibraryError::InvalidCloudResponse)?;
        self.connection.execute("INSERT INTO operations VALUES (?1,?2) ON CONFLICT(scope) DO UPDATE SET body=excluded.body", params![self.scope, body])?;
        Ok(())
    }

    pub(super) fn clear(&self) -> Result<(), LibraryError> {
        self.connection
            .execute("DELETE FROM operations WHERE scope=?1", [&self.scope])?;
        Ok(())
    }

    fn for_bytes(&self, bytes: &[u8]) -> Result<Operation, LibraryError> {
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return Err(LibraryError::CloudThumbnailUnavailable);
        }
        let sha256 = digest(bytes);
        if let Some(prior) = self.load()? {
            if prior.sha256 == sha256 && prior.size_bytes == bytes.len() {
                return Ok(prior);
            }
            // A potentially committed replication body must be reconciled before replacing it.
            if prior.commit.is_some() {
                return Err(LibraryError::InvalidCloudResponse);
            }
        }
        let operation = Operation {
            operation_id: uuid::Uuid::new_v4().to_string(),
            sha256,
            size_bytes: bytes.len(),
            commit: None,
        };
        self.save(&operation)?;
        Ok(operation)
    }

    pub(super) fn handle_error(&self, error: UploadError) -> LibraryError {
        if matches!(error, UploadError::Renew) {
            if let Err(error) = self.clear() {
                return error;
            }
        }
        error.library()
    }
}

pub(super) enum Thumbnail {
    Upload(String),
    Legacy(super::models::ReplicationVariantPayload),
}

pub(super) fn upload(
    client: &CloudClient,
    journal: &Journal,
    asset_id: &str,
    bytes: Vec<u8>,
    token: &str,
) -> Result<Thumbnail, LibraryError> {
    let operation = journal.for_bytes(&bytes)?;
    let prepared = client.prepare_thumbnail(asset_id, &operation, token);
    match prepared {
        Ok(prepared) => {
            if prepared.asset_id != asset_id
                || prepared.upload_id.is_empty()
                || prepared.thumbnail_key
                    != format!("derived/library-thumbnails/v1/{}.webp", operation.sha256)
            {
                return Err(LibraryError::InvalidCloudResponse);
            }
            if !prepared.committed {
                client.put_thumbnail(&prepared, &bytes)?;
            }
            Ok(Thumbnail::Upload(prepared.upload_id))
        }
        Err(UploadError::UnknownRoute) => {
            let object_key = format!("library/{asset_id}/thumbnail");
            client.upload_replication_variant(&object_key, "image/webp", bytes, token)?;
            Ok(Thumbnail::Legacy(
                super::models::ReplicationVariantPayload {
                    object_key,
                    content_type: "image/webp".into(),
                    size_bytes: operation.size_bytes as u64,
                    sha256: Some(operation.sha256),
                },
            ))
        }
        Err(error) => Err(journal.handle_error(error)),
    }
}

pub(super) fn commit_replication(
    client: &CloudClient,
    journal: &Journal,
    request: &ReplicationCommitRequest,
    token: &str,
) -> Result<(), LibraryError> {
    // Persist the entire context, not just its ID: the server binds the session to it.
    let mut operation = journal.load()?.unwrap_or(Operation {
        operation_id: uuid::Uuid::new_v4().to_string(),
        sha256: String::new(),
        size_bytes: 0,
        commit: None,
    });
    operation.commit = Some(request.clone());
    journal.save(&operation)?;
    client
        .commit_thumbnail_replication(request, token)
        .map_err(|error| journal.handle_error(error))?;
    journal.clear()
}

pub(super) fn refresh(
    client: &CloudClient,
    journal: &Journal,
    asset_id: &str,
    bytes: Vec<u8>,
    token: &str,
) -> Result<(), LibraryError> {
    if let Thumbnail::Upload(upload_id) = upload(client, journal, asset_id, bytes, token)? {
        client
            .commit_thumbnail(asset_id, &upload_id, token)
            .map_err(|error| journal.handle_error(error))?;
    }
    journal.clear()
}
