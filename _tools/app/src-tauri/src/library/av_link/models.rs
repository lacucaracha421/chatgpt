use crate::library::av_models::{AvCoverSet, AvPersonCredit};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub request_id: String,
    pub product_code: String,
    pub normalized_code: Option<String>,
    pub source_url: Option<String>,
    pub received_at: String,
    pub status: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub fetched_at: Option<String>,
    pub collection_id: Option<String>,
    pub collection_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedPage {
    pub items: Vec<FeedItem>,
    pub next_after: i64,
    pub has_more: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedItem {
    pub sequence: i64,
    pub request_id: String,
    pub product_code: String,
    pub source_url: Option<String>,
    pub received_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Actress {
    pub name: String,
    pub image_url: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Movie {
    pub normalized_id: String,
    pub title: String,
    pub date: Option<String>,
    #[serde(default)]
    pub makers: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default, deserialize_with = "series_names")]
    pub series: Vec<String>,
    #[serde(default)]
    pub actresses: Vec<Actress>,
    #[serde(default)]
    pub directors: Vec<String>,
    #[serde(default)]
    pub genres: Vec<String>,
    pub cover_image_url: String,
    pub thumbnail_image_url: Option<String>,
    pub volume: Option<serde_json::Value>,
}
fn series_names<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Series {
        One(String),
        Many(Vec<String>),
    }
    Ok(match Option::<Series>::deserialize(deserializer)? {
        Some(Series::One(name)) => vec![name],
        Some(Series::Many(names)) => names,
        None => vec![],
    })
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NameMapping {
    pub name_ja: String,
    pub name_ko: Option<String>,
    pub wikidata_id: Option<String>,
    pub fanza_actress_id: Option<String>,
}
impl NameMapping {
    pub fn japanese(name: &str) -> Self {
        Self {
            name_ja: name.into(),
            name_ko: None,
            wikidata_id: None,
            fanza_actress_id: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Split {
    pub x1: u32,
    pub x2: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultSplit {
    #[serde(flatten)]
    pub split: Split,
    pub is_wrap: bool,
    pub use_spine: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonMatch {
    #[serde(flatten)]
    pub mapping: NameMapping,
    pub person_id: Option<String>,
    pub display_name: Option<String>,
    pub match_by: Option<String>,
    pub already_linked: bool,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
// Metadata names deliberately follow the request contract, including title_ja.
#[serde(deny_unknown_fields)]
pub struct Fields {
    pub title_ja: Option<String>,
    pub release_date: Option<String>,
    pub maker: Option<String>,
    pub label: Option<String>,
    pub series: Option<String>,
    pub genres: Option<Vec<String>>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentCollection {
    pub collection_id: String,
    pub name: String,
    pub product_code: Option<String>,
    pub fields: Fields,
    pub covers: AvCoverSet,
    pub people: Vec<AvPersonCredit>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub inbox: InboxItem,
    pub metadata: Movie,
    pub fields: Fields,
    pub jacket_url: String,
    pub jacket_width: u32,
    pub jacket_height: u32,
    pub default_split: DefaultSplit,
    pub current: Option<CurrentCollection>,
    pub performers: Vec<PersonMatch>,
    pub directors: Vec<PersonMatch>,
}
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceChoice {
    Candidate,
    Keep,
    Clear,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Surfaces {
    pub front: SurfaceChoice,
    pub spine: SurfaceChoice,
    pub back: SurfaceChoice,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum PersonChoice {
    Link {
        name_ja: String,
        #[serde(rename = "personId")]
        person_id: String,
    },
    New {
        name_ja: String,
        #[serde(rename = "displayName")]
        display_name: String,
    },
}
impl PersonChoice {
    pub fn name_ja(&self) -> &str {
        match self {
            Self::Link { name_ja, .. } | Self::New { name_ja, .. } => name_ja,
        }
    }
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyRequest {
    pub collection_id: Option<String>,
    pub new_collection_name: Option<String>,
    pub expected_revision: Option<String>,
    pub split: Split,
    pub surfaces: Surfaces,
    pub fields: Fields,
    pub performers: Vec<PersonChoice>,
    pub directors: Vec<PersonChoice>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub collection_id: String,
    pub covers: AvCoverSet,
}
