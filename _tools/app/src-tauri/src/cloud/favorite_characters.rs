//! Server-owned favourite characters, using the shared folder pins transport pattern.
use super::{bearer, map_registration_error, read_json_bounded, CloudClient};
use crate::library::error::LibraryError;
use serde::{Deserialize, Deserializer, Serialize};

const PATH: &str = "/v1/library/favorite-characters";
const MAX_ENTRIES: usize = 300;
const MAX_COMMANDS: usize = 20;
// Allow all 300 entries at the field limits, including JSON string escaping.
const LIMIT: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FavoriteCharacters {
    pub(crate) version: u8,
    pub(crate) revision: u64,
    pub(crate) entries: Vec<FavoriteEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FavoriteEntry {
    pub(crate) character_id: String,
    pub(crate) cover_asset_id: Option<String>,
    pub(crate) cover_y: f64,
    pub(crate) profile: FavoriteProfile,
    pub(crate) work_ids: Vec<String>,
    pub(crate) extra_works: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FavoriteProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) original_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) birth_month: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) birth_day: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) height_cm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) voice_actor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) affiliation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) memo: Option<String>,
}

// Called only for present keys: preserve explicit null for the nullable cover,
// and reject null for fields whose contract requires a number, object or list.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FavoriteSet {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub(crate) cover_asset_id: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub(crate) cover_y: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub(crate) profile: Option<FavoriteProfile>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub(crate) work_ids: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub(crate) extra_works: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum FavoriteCommand {
    Add { ids: Vec<String> },
    Remove { ids: Vec<String> },
    Order { ids: Vec<String> },
    Update { id: String, set: FavoriteSet },
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_work_ids(ids: &[String]) -> bool {
    ids.len() <= 30
        && ids.iter().all(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b':' | b'.' | b'-')
                })
        })
}

fn valid_extra_works(works: &[String]) -> bool {
    works.len() <= 30 && works.iter().all(|name| name.chars().count() <= 120)
}

fn valid_profile(profile: &FavoriteProfile) -> bool {
    let birthday = match (profile.birth_month, profile.birth_day) {
        (None, None) => true,
        (Some(month), Some(day)) => (1..=12).contains(&month) && (1..=31).contains(&day),
        _ => false,
    };
    birthday
        && [
            &profile.original_name,
            &profile.voice_actor,
            &profile.affiliation,
        ]
        .iter()
        .all(|value| {
            value
                .as_ref()
                .map_or(true, |value| value.chars().count() <= 120)
        })
        && profile
            .memo
            .as_ref()
            .map_or(true, |value| value.chars().count() <= 2000)
        && profile
            .height_cm
            .map_or(true, |value| (30.0..=300.0).contains(&value))
}

fn valid_set(set: &FavoriteSet) -> bool {
    set.cover_asset_id
        .as_ref()
        .map_or(true, |value| value.as_ref().map_or(true, |id| valid_id(id)))
        && set
            .cover_y
            .map_or(true, |value| (0.0..=100.0).contains(&value))
        && set.profile.as_ref().map_or(true, valid_profile)
        && set
            .work_ids
            .as_ref()
            .map_or(true, |ids| valid_work_ids(ids))
        && set
            .extra_works
            .as_ref()
            .map_or(true, |works| valid_extra_works(works))
}

pub(crate) fn command_body(
    commands: &[FavoriteCommand],
) -> Result<serde_json::Value, LibraryError> {
    if commands.is_empty()
        || commands.len() > MAX_COMMANDS
        || commands.iter().any(|command| !match command {
            FavoriteCommand::Add { ids }
            | FavoriteCommand::Remove { ids }
            | FavoriteCommand::Order { ids } => {
                ids.len() <= MAX_ENTRIES && ids.iter().all(|id| valid_id(id))
            }
            FavoriteCommand::Update { id, set } => valid_id(id) && valid_set(set),
        })
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(serde_json::json!({ "commands": commands }))
}

fn checked(document: FavoriteCharacters) -> Result<FavoriteCharacters, LibraryError> {
    if document.version != 1
        || document.entries.len() > MAX_ENTRIES
        || document.entries.iter().any(|entry| {
            !valid_id(&entry.character_id)
                || !entry
                    .cover_asset_id
                    .as_ref()
                    .map_or(true, |id| valid_id(id))
                || !(0.0..=100.0).contains(&entry.cover_y)
                || !valid_profile(&entry.profile)
                || !valid_work_ids(&entry.work_ids)
                || !valid_extra_works(&entry.extra_works)
        })
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(document)
}

impl CloudClient {
    pub(crate) fn favorite_characters(
        &self,
        token: &str,
    ) -> Result<FavoriteCharacters, LibraryError> {
        let mut response = self
            .agent
            .get(self.endpoint(PATH)?)
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(map_registration_error)?;
        checked(read_json_bounded(&mut response, LIMIT)?)
    }

    pub(crate) fn change_favorite_characters(
        &self,
        commands: &[FavoriteCommand],
        token: &str,
    ) -> Result<FavoriteCharacters, LibraryError> {
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

    fn update(set: serde_json::Value) -> FavoriteCommand {
        serde_json::from_value(serde_json::json!({"op":"update", "id":"char_1", "set":set}))
            .unwrap()
    }

    #[test]
    fn update_preserves_omitted_cover_and_explicit_clear_on_round_trip() {
        for set in [
            serde_json::json!({}),
            serde_json::json!({"coverAssetId":null}),
            serde_json::json!({"coverAssetId":"asset-1"}),
        ] {
            let command = update(set.clone());
            let body = command_body(&[command.clone()]).unwrap();
            assert_eq!(body["commands"][0]["set"], set);
            assert_eq!(
                serde_json::from_value::<FavoriteCommand>(body["commands"][0].clone()).unwrap(),
                command
            );
        }
    }

    #[test]
    fn commands_validate_payloads_and_batch_limits() {
        let commands = vec![
            FavoriteCommand::Add {
                ids: vec!["char_1".into()],
            },
            FavoriteCommand::Remove { ids: vec![] },
            FavoriteCommand::Order {
                ids: vec!["char_1".into()],
            },
            update(serde_json::json!({
                "coverY":0, "profile":{"originalName":"名前", "birthMonth":12, "birthDay":31, "heightCm":170},
                "workIds":["collection:work.1"], "extraWorks":["Other work"]
            })),
        ];
        assert_eq!(
            command_body(&commands).unwrap()["commands"][0],
            serde_json::json!({"op":"add", "ids":["char_1"]})
        );
        assert!(command_body(&[]).is_err());
        assert!(command_body(&vec![commands[0].clone(); 21]).is_err());
        assert!(command_body(&[FavoriteCommand::Add {
            ids: vec!["char".into(); 301]
        }])
        .is_err());
        for set in [
            serde_json::json!({"coverY":101}),
            serde_json::json!({"profile":{"birthMonth":1}}),
            serde_json::json!({"workIds":["bad/id"]}),
            serde_json::json!({"extraWorks":["x".repeat(121)]}),
        ] {
            assert!(command_body(&[update(set)]).is_err());
        }
    }

    #[test]
    fn document_payload_uses_camel_case_and_profile_limits() {
        let document: FavoriteCharacters = serde_json::from_value(serde_json::json!({
            "version":1,"revision":4,"entries":[{"characterId":"char_1", "coverAssetId":null, "coverY":50,
                "profile":{"memo":"あ".repeat(2000)},"workIds":[],"extraWorks":[]}]
        })).unwrap();
        assert_eq!(checked(document.clone()).unwrap(), document);
        let mut invalid = document.clone();
        invalid.entries[0].profile.memo = Some("あ".repeat(2001));
        assert!(checked(invalid).is_err());
        assert!(checked(FavoriteCharacters {
            version: 2,
            ..document
        })
        .is_err());
    }
}
