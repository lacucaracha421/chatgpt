//! User-triggered catalog publication. No automatic work or source writes.
use crate::library::{credential,error::LibraryError,Library};
use super::client::CloudClient;
#[derive(Debug,serde::Serialize)]
#[serde(rename_all="camelCase")]
pub struct MobileCatalogPublishResult { pub publication_revision:String,pub published_at:String,pub works:u64,pub bytes:u64 }
impl Library {
    pub(crate) fn push_cloud_catalog(&self)->Result<MobileCatalogPublishResult,LibraryError>{
        let config=self.cloud_sync_config()?;
        let client=CloudClient::new(config.api_base_url.as_deref().ok_or(LibraryError::InvalidCloudSyncConfig)?)?;
        let token=credential::read_cloud_api_token_os()?;
        let base=client.mobile_catalog_revision(&token)?;
        let snapshot=self.export_mobile_catalog_snapshot()?;
        client.upload_mobile_catalog(&snapshot.content_digest,snapshot.file.try_clone().map_err(|_|LibraryError::InvalidOnlineCatalog)?,&token)?;
        let result=client.publish_mobile_catalog(&serde_json::json!({"version":1,"baseRevision":base,"contentDigest":snapshot.content_digest,"userSnapshot":snapshot.users}),&token)?;
        Ok(MobileCatalogPublishResult {publication_revision:result.0,published_at:result.1,works:snapshot.works,bytes:snapshot.bytes})
    }
}
