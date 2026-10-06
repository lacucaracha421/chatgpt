//! PC-only StashDB metadata. HTTP never runs while a connection or state guard is held.
use super::{
    av_link::provider::HttpClient, av_models::AvError, av_portrait::require_person, Library,
};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

const ENDPOINT: &str = "https://stashdb.org/graphql";
const MAX_JSON: usize = 1024 * 1024;
const FIELDS: &str = "id name aliases disambiguation gender birth_date career_start_year career_end_year height breast_type cup_size band_size waist_size hip_size urls { url site { name } } images { id url width height }";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvPerformerProfile {
    pub person_id: String,
    pub source: String,
    pub status: String,
    pub stashdb_id: Option<String>,
    pub name: Option<String>,
    pub aliases: Vec<String>,
    pub birth_date: Option<String>,
    pub height_cm: Option<i64>,
    pub band_in: Option<i64>,
    pub waist_in: Option<i64>,
    pub hip_in: Option<i64>,
    pub cup: Option<String>,
    pub breast_type: Option<String>,
    pub career_start: Option<i64>,
    pub career_end: Option<i64>,
    pub urls: Vec<ProfileUrl>,
    pub images: Vec<ProfileImage>,
    pub candidates: Vec<ProfileCandidate>,
    pub fetched_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileUrl {
    pub url: String,
    pub site: ProfileSite,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileSite {
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileImage {
    pub id: String,
    pub url: String,
    pub width: u32,
    pub height: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCandidate {
    pub stashdb_id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub birth_date: Option<String>,
    pub image_url: Option<String>,
}
#[derive(Deserialize)]
struct Performer {
    id: String,
    name: String,
    #[serde(default)]
    aliases: Vec<String>,
    gender: Option<String>,
    birth_date: Option<String>,
    height: Option<i64>,
    band_size: Option<i64>,
    waist_size: Option<i64>,
    hip_size: Option<i64>,
    cup_size: Option<String>,
    breast_type: Option<String>,
    career_start_year: Option<i64>,
    career_end_year: Option<i64>,
    #[serde(default)]
    urls: Vec<ProfileUrl>,
    #[serde(default)]
    images: Vec<ProfileImage>,
}

// A later choose/clear/dismiss supersedes an in-flight refresh, including across windows.
#[derive(Clone, Default)]
pub(crate) struct AvProfileState(Arc<Mutex<HashMap<(PathBuf, String), uuid::Uuid>>>);
struct RequestGeneration {
    state: AvProfileState,
    key: (PathBuf, String),
    id: uuid::Uuid,
}
impl AvProfileState {
    fn begin(&self, lib: &Library, person: &str) -> RequestGeneration {
        let key = (lib.root().to_path_buf(), person.to_owned());
        let id = uuid::Uuid::new_v4();
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.clone(), id);
        RequestGeneration {
            state: self.clone(),
            key,
            id,
        }
    }
}
impl RequestGeneration {
    fn apply<T>(&self, action: impl FnOnce() -> Result<T, AvError>) -> Result<T, AvError> {
        let pending = self
            .state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending.get(&self.key) != Some(&self.id) {
            return Err(AvError::Stale);
        }
        action()
    }
}
impl Drop for RequestGeneration {
    fn drop(&mut self) {
        let mut pending = self
            .state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending.get(&self.key) == Some(&self.id) {
            pending.remove(&self.key);
        }
    }
}
fn empty(person: &str, status: &str) -> AvPerformerProfile {
    AvPerformerProfile {
        person_id: person.into(),
        source: "stashdb".into(),
        status: status.into(),
        stashdb_id: None,
        name: None,
        aliases: vec![],
        birth_date: None,
        height_cm: None,
        band_in: None,
        waist_in: None,
        hip_in: None,
        cup: None,
        breast_type: None,
        career_start: None,
        career_end: None,
        urls: vec![],
        images: vec![],
        candidates: vec![],
        fetched_at: Utc::now().to_rfc3339(),
    }
}
fn normalize(name: &str) -> String {
    name.chars()
        .map(|c| {
            if ('\u{ff01}'..='\u{ff5e}').contains(&c) {
                char::from_u32(c as u32 - 0xfee0).unwrap_or(c)
            } else {
                c
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
pub(super) fn safe_url(raw: &str) -> bool {
    url::Url::parse(raw).is_ok_and(|u| {
        matches!(u.scheme(), "http" | "https")
            && u.host_str().is_some()
            && u.username().is_empty()
            && u.password().is_none()
            && raw.len() <= 4096
    })
}
fn valid_date(date: &str) -> bool {
    match date.len() {
        4 => date
            .parse::<i32>()
            .is_ok_and(|y| (1900..=2200).contains(&y)),
        7 => chrono::NaiveDate::parse_from_str(&format!("{date}-01"), "%Y-%m-%d").is_ok(),
        10 => chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok(),
        _ => false,
    }
}
impl Performer {
    fn validate(mut self) -> Result<Self, AvError> {
        if self.id.is_empty()
            || self.id.len() > 128
            || self.name.trim().is_empty()
            || self.name.len() > 500
            || self.aliases.len() > 100
            || self.aliases.iter().any(|a| a.len() > 500)
        {
            return Err(AvError::Invalid);
        }
        self.birth_date = self.birth_date.filter(|d| valid_date(d));
        self.height = self.height.filter(|v| (1..=300).contains(v));
        self.band_size = self.band_size.filter(|v| (1..=200).contains(v));
        self.waist_size = self.waist_size.filter(|v| (1..=200).contains(v));
        self.hip_size = self.hip_size.filter(|v| (1..=200).contains(v));
        self.cup_size = self
            .cup_size
            .filter(|v| !v.trim().is_empty() && v.len() <= 20);
        self.breast_type = self
            .breast_type
            .filter(|v| matches!(v.as_str(), "NATURAL" | "FAKE" | "NA"));
        self.career_start_year = self.career_start_year.filter(|v| (1900..=2200).contains(v));
        self.career_end_year = self.career_end_year.filter(|v| {
            (1900..=2200).contains(v) && self.career_start_year.is_none_or(|s| *v >= s)
        });
        self.urls
            .retain(|u| safe_url(&u.url) && u.site.name.len() <= 200);
        self.urls.truncate(100);
        self.images.retain(|i| {
            !i.id.is_empty() && i.id.len() <= 128 && safe_url(&i.url) && i.width > 0 && i.height > 0
        });
        self.images.truncate(500);
        Ok(self)
    }
    fn eligible(&self) -> bool {
        self.gender.as_deref().is_none_or(|g| g == "FEMALE")
    }
    fn candidate(&self) -> ProfileCandidate {
        ProfileCandidate {
            stashdb_id: self.id.clone(),
            name: self.name.clone(),
            aliases: self.aliases.clone(),
            birth_date: self.birth_date.clone(),
            image_url: self.images.first().map(|i| i.url.clone()),
        }
    }
    fn matched(self, person: &str) -> AvPerformerProfile {
        AvPerformerProfile {
            stashdb_id: Some(self.id),
            name: Some(self.name),
            aliases: self.aliases,
            birth_date: self.birth_date,
            height_cm: self.height,
            band_in: self.band_size,
            waist_in: self.waist_size,
            hip_in: self.hip_size,
            cup: self.cup_size,
            breast_type: self.breast_type,
            career_start: self.career_start_year,
            career_end: self.career_end_year,
            urls: self.urls,
            images: self.images,
            ..empty(person, "matched")
        }
    }
}
fn classify(
    person: &str,
    names: &[String],
    results: Vec<Performer>,
    chooser: bool,
) -> AvPerformerProfile {
    let mut results: Vec<_> = results.into_iter().filter(Performer::eligible).collect();
    let mut seen = std::collections::HashSet::new();
    results.retain(|p| seen.insert(p.id.clone()));
    let names: Vec<_> = names
        .iter()
        .map(|n| normalize(n))
        .filter(|n| !n.is_empty())
        .collect();
    let exact: Vec<_> = results
        .iter()
        .enumerate()
        .filter(|(_, p)| {
            std::iter::once(&p.name)
                .chain(&p.aliases)
                .any(|n| names.contains(&normalize(n)))
        })
        .map(|(i, _)| i)
        .collect();
    if !chooser && exact.len() == 1 {
        return results.remove(exact[0]).matched(person);
    }
    let mut profile = empty(
        person,
        if results.is_empty() {
            "none"
        } else {
            "ambiguous"
        },
    );
    profile.candidates = results.iter().take(5).map(Performer::candidate).collect();
    profile
}
fn request(
    http: &impl HttpClient,
    key: &str,
    query: String,
    variables: Value,
    field: &str,
) -> Result<Value, AvError> {
    let body = serde_json::to_vec(&json!({ "query": query, "variables": variables }))
        .map_err(|_| AvError::Invalid)?;
    // Errors and response bodies are never forwarded: GraphQL errors can echo request data.
    let response = http
        .post_json(ENDPOINT, key, &body, MAX_JSON)
        .map_err(|_| AvError::Invalid)?;
    if response.status != 200 || response.bytes.len() > MAX_JSON {
        return Err(AvError::Invalid);
    }
    let mut value: Value = serde_json::from_slice(&response.bytes).map_err(|_| AvError::Invalid)?;
    if value
        .get("errors")
        .is_some_and(|errors| !errors.is_null() && errors.as_array().is_none_or(|v| !v.is_empty()))
    {
        return Err(AvError::Invalid);
    }
    value
        .get_mut("data")
        .and_then(|d| d.get_mut(field))
        .map(Value::take)
        .ok_or(AvError::Invalid)
}
fn json_text(value: &impl Serialize) -> Result<String, AvError> {
    serde_json::to_string(value).map_err(|_| AvError::Invalid)
}
fn save(c: &Connection, p: &AvPerformerProfile) -> Result<(), AvError> {
    // Profiles are shared person data without an authority command yet (1B §4).
    super::collection_authority::fence_collection_operation(c)?;
    require_person(c, &p.person_id)?;
    c.execute("INSERT OR REPLACE INTO collection_person_profiles
        (person_id,source,status,stashdb_id,name,aliases_json,birth_date,height_cm,band_in,waist_in,hip_in,cup,breast_type,career_start,career_end,urls_json,images_json,candidates_json,fetched_at)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)", params![
        p.person_id,p.source,p.status,p.stashdb_id,p.name,json_text(&p.aliases)?,p.birth_date,p.height_cm,
        p.band_in,p.waist_in,p.hip_in,p.cup,p.breast_type,p.career_start,p.career_end,
        json_text(&p.urls)?,json_text(&p.images)?,json_text(&p.candidates)?,p.fetched_at])?;
    Ok(())
}
fn array<T: serde::de::DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<T> {
    let text: String = row.get(index)?;
    serde_json::from_str(&text).map_err(|_| rusqlite::Error::InvalidQuery)
}
impl Library {
    pub fn get_av_performer_profile(
        &self,
        person: &str,
    ) -> Result<Option<AvPerformerProfile>, AvError> {
        let c = self.connection()?;
        require_person(&c, person)?;
        Ok(c.query_row("SELECT source,status,stashdb_id,name,aliases_json,birth_date,height_cm,band_in,waist_in,hip_in,cup,breast_type,career_start,career_end,urls_json,images_json,candidates_json,fetched_at FROM collection_person_profiles WHERE person_id=?1", [person], |r| Ok(AvPerformerProfile {
            person_id: person.into(),source:r.get(0)?,status:r.get(1)?,stashdb_id:r.get(2)?,name:r.get(3)?,
            aliases:array(r,4)?,birth_date:r.get(5)?,height_cm:r.get(6)?,band_in:r.get(7)?,waist_in:r.get(8)?,hip_in:r.get(9)?,cup:r.get(10)?,breast_type:r.get(11)?,career_start:r.get(12)?,career_end:r.get(13)?,urls:array(r,14)?,images:array(r,15)?,candidates:array(r,16)?,fetched_at:r.get(17)?,
        })).optional()?)
    }
    pub(crate) fn refresh_av_performer_profile_with(
        &self,
        person: &str,
        force: bool,
        state: &AvProfileState,
        http: &impl HttpClient,
        key: Option<&str>,
    ) -> Result<Option<AvPerformerProfile>, AvError> {
        let generation = state.begin(self, person);
        let old = self.get_av_performer_profile(person)?;
        let Some(key) = key else {
            return Ok(old);
        };
        {
            let c = self.connection()?;
            if super::collection_authority::collection_authority_active(&c)? {
                // Opening a performer page refreshes automatically: keep the stored
                // profile quietly. Only an explicit refresh reports the fence.
                if !force {
                    return Ok(old);
                }
                super::collection_authority::fence_collection_operation(&c)?;
            }
        }
        if !force
            && old.as_ref().is_some_and(|p| {
                DateTime::parse_from_rfc3339(&p.fetched_at).is_ok_and(|d| {
                    let age = Utc::now().signed_duration_since(d);
                    age >= Duration::zero() && age < Duration::days(30)
                })
            })
        {
            return Ok(old);
        }
        let new = self.search_stashdb(person, http, key, false)?;
        generation.apply(|| {
            save(&*self.connection()?, &new)?;
            Ok(Some(new))
        })
    }
    fn search_stashdb(
        &self,
        person: &str,
        http: &impl HttpClient,
        key: &str,
        chooser: bool,
    ) -> Result<AvPerformerProfile, AvError> {
        let (display, ja): (String, Option<String>) = {
            let c = self.connection()?;
            require_person(&c, person)?;
            c.query_row(
                "SELECT display_name,name_ja FROM collection_people WHERE id=?1",
                [person],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?
        };
        let term = ja
            .as_deref()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or(&display);
        let value = request(
            http,
            key,
            format!("query($t:String!){{searchPerformer(term:$t,limit:5){{{FIELDS}}}}}"),
            json!({"t":term}),
            "searchPerformer",
        )?;
        let performers: Vec<Performer> =
            serde_json::from_value(value).map_err(|_| AvError::Invalid)?;
        let performers = performers
            .into_iter()
            .take(5)
            .map(Performer::validate)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(classify(
            person,
            &[display, ja.unwrap_or_default()],
            performers,
            chooser,
        ))
    }
    pub(crate) fn search_av_performer_profile_with(
        &self,
        person: &str,
        http: &impl HttpClient,
        key: Option<&str>,
    ) -> Result<AvPerformerProfile, AvError> {
        // The chooser leads only to a fenced save; report it before contacting StashDB.
        super::collection_authority::fence_collection_operation(&*self.connection()?)?;
        self.search_stashdb(person, http, key.ok_or(AvError::Invalid)?, true)
    }
    pub(crate) fn choose_av_performer_profile_with(
        &self,
        person: &str,
        id: &str,
        state: &AvProfileState,
        http: &impl HttpClient,
        key: Option<&str>,
    ) -> Result<AvPerformerProfile, AvError> {
        let generation = state.begin(self, person);
        super::collection_authority::fence_collection_operation(&*self.connection()?)?;
        require_person(&*self.connection()?, person)?;
        if id.is_empty() || id.len() > 128 {
            return Err(AvError::Invalid);
        }
        let value = request(
            http,
            key.ok_or(AvError::Invalid)?,
            format!("query($id:ID!){{findPerformer(id:$id){{{FIELDS}}}}}"),
            json!({"id":id}),
            "findPerformer",
        )?;
        let performer = serde_json::from_value::<Performer>(value)
            .map_err(|_| AvError::Invalid)?
            .validate()?;
        if performer.id != id || !performer.eligible() {
            return Err(AvError::Invalid);
        }
        let profile = performer.matched(person);
        generation.apply(|| {
            save(&*self.connection()?, &profile)?;
            Ok(profile)
        })
    }
    pub(crate) fn dismiss_av_performer_profile(
        &self,
        person: &str,
        state: &AvProfileState,
    ) -> Result<AvPerformerProfile, AvError> {
        let generation = state.begin(self, person);
        super::collection_authority::fence_collection_operation(&*self.connection()?)?;
        let profile = empty(person, "none");
        generation.apply(|| {
            save(&*self.connection()?, &profile)?;
            Ok(profile)
        })
    }
    pub(crate) fn clear_av_performer_profile(
        &self,
        person: &str,
        state: &AvProfileState,
    ) -> Result<(), AvError> {
        let generation = state.begin(self, person);
        generation.apply(|| {
            let c = self.connection()?;
            super::collection_authority::fence_collection_operation(&c)?;
            require_person(&c, person)?;
            c.execute(
                "DELETE FROM collection_person_profiles WHERE person_id=?1",
                [person],
            )?;
            Ok(())
        })
    }
}
#[cfg(test)]
#[path = "av_stashdb_tests.rs"]
mod tests;
