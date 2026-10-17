//! Shared folder pins ("폴더 고정"): the ordered list the PC sidebar and the tablet both edit.
//! The server owns the list and merges per-id commands (`server/lakomics-api/folder_pins.py`);
//! the PC keeps its local preference as a cache and sends its edits as commands.
use super::{bearer, map_registration_error, read_json_bounded, CloudClient};
use crate::library::error::LibraryError;
use serde::{Deserialize, Serialize};

const PATH: &str = "/v1/library/folder-pins";
const MAX_PINS: usize = 300;
const MAX_COMMANDS: usize = 20;
const LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderPins {
    pub(crate) version: u8,
    pub(crate) revision: u64,
    pub(crate) pinned_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PinCommand {
    pub(crate) op: String,
    pub(crate) ids: Vec<String>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_ids(ids: &[String]) -> bool {
    ids.len() <= MAX_PINS && ids.iter().all(|id| valid_id(id))
}

/// The request body, refused here when it is not something the server would accept.
pub(crate) fn command_body(commands: &[PinCommand]) -> Result<serde_json::Value, LibraryError> {
    if commands.is_empty()
        || commands.len() > MAX_COMMANDS
        || commands.iter().any(|command| {
            !matches!(command.op.as_str(), "add" | "remove" | "order") || !valid_ids(&command.ids)
        })
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(serde_json::json!({ "commands": commands }))
}

fn checked(pins: FolderPins) -> Result<FolderPins, LibraryError> {
    if pins.version != 1 || !valid_ids(&pins.pinned_ids) {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(pins)
}

impl CloudClient {
    pub(crate) fn folder_pins(&self, token: &str) -> Result<FolderPins, LibraryError> {
        let mut response = self
            .agent
            .get(self.endpoint(PATH)?)
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(map_registration_error)?;
        checked(read_json_bounded(&mut response, LIMIT)?)
    }

    pub(crate) fn change_folder_pins(
        &self,
        commands: &[PinCommand],
        token: &str,
    ) -> Result<FolderPins, LibraryError> {
        let _send = self.send_permit()?;
        let body = serde_json::to_vec(&command_body(commands)?)
            .map_err(|_| LibraryError::InvalidCloudResponse)?;
        let mut response = self
            .agent
            .post(self.endpoint(PATH)?)
            .header("Authorization", bearer(token)?)
            .content_type("application/json")
            .send(&body)
            .map_err(map_registration_error)?;
        checked(read_json_bounded(&mut response, LIMIT)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(op: &str, ids: &[&str]) -> PinCommand {
        PinCommand {
            op: op.into(),
            ids: ids.iter().map(|id| (*id).into()).collect(),
        }
    }

    #[test]
    fn commands_are_sent_as_the_server_expects_and_unusable_ones_are_refused() {
        let body =
            command_body(&[command("add", &["a-1", "b_2"]), command("remove", &["c"])]).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"commands": [
                {"op": "add", "ids": ["a-1", "b_2"]},
                {"op": "remove", "ids": ["c"]}]})
        );
        assert!(command_body(&[]).is_err());
        assert!(command_body(&[command("clear", &[])]).is_err());
        assert!(command_body(&[command("add", &["../x"])]).is_err());
    }

    #[test]
    fn the_reply_uses_camel_case_and_must_be_version_one() {
        let ok: FolderPins =
            serde_json::from_str(r#"{"version":1,"revision":4,"pinnedIds":["a","b"]}"#).unwrap();
        assert_eq!(checked(ok.clone()).unwrap().pinned_ids, ["a", "b"]);
        assert!(checked(FolderPins { version: 2, ..ok }).is_err());
    }
}
