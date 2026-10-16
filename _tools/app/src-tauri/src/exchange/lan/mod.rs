//! Direct exchange protocol v1 (TRANSFER-001).
//!
//! TCP 53318, TLS 1.3 only, ECDSA P-256 self-signed certificates. Mutual
//! authentication pins lowercase SHA-256 of certificate DER: receivers trust only
//! cached live non-self devices; senders pin the target. No hostname/validity checks.
//! Routes under `/api/lakomics/lan/v1`, JSON <=16 KiB:
//! * GET /info -> {protocol:1, deviceId, name, kind, receiving, maxFileBytes}.
//! * POST /prepare-upload {transferId,batchId,fromDevice,fileName,sizeBytes,sha256,
//!   contentTypeHint?} -> {state:"upload",offset} or {state:"saved"}, idempotent.
//!   Errors: deviceMismatch 403, invalidRequest 422, fileTooLarge 413, busy 409,
//!   notReceiving 503. fromDevice must match the authenticated certificate.
//! * PUT /upload?transferId=&offset= requires Content-Length=size-offset; no chunked
//!   encoding. Returns {state:"saved"} only after a durable receipt. Errors:
//!   offsetMismatch 409 {offset}, digestMismatch 422 (delete part), cancelled 410.
//! * POST /cancel {transferId}. Error JSON is {error:"<code>", ...}.
//! One transferId spans LAN, Tailscale and server fallback for receipt deduplication.
//! S2 receives directly using the shared durable publication pipeline.

pub(super) mod addresses;
mod http;
pub(super) mod identity;
pub(super) mod server;
pub(super) mod sink;
mod tls;
use super::client::Device;
use serde::{Deserialize, Serialize};
pub(super) const PORT: u16 = 53318;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanAddress {
    pub kind: String,
    pub ip: std::net::Ipv4Addr,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanReport {
    pub cert_sha256: String,
    pub port: u16,
    pub addresses: Vec<LanAddress>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanInfo {
    #[serde(flatten)]
    pub report: LanReport,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct LanPeer {
    pub device_id: String,
    pub name: String,
    #[serde(flatten)]
    pub report: LanReport,
}

pub(super) fn peers(devices: &[Device], self_id: &str) -> Vec<LanPeer> {
    devices
        .iter()
        .filter(|device| !device.is_self && device.device_id != self_id)
        .filter_map(|device| {
            device.lan.as_ref().map(|lan| LanPeer {
                device_id: device.device_id.clone(),
                name: device.name.clone(),
                report: lan.report.clone(),
            })
        })
        .collect()
}
