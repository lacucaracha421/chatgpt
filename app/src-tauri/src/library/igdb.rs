use std::{
    io::Read,
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::TimeZone;
use serde::Deserialize;

use super::{
    error::LibraryError,
    models::{IgdbCredentials, IgdbImageRef, IgdbRemoteGame},
};

const TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";
const GAMES_URL: &str = "https://api.igdb.com/v4/games";
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IgdbImageSize {
    CoverBig,
    Hd1080p,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedIgdbToken {
    pub access_token: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Default)]
pub struct IgdbTokenCache {
    inner: Arc<Mutex<Option<CachedIgdbToken>>>,
}

impl IgdbTokenCache {
    pub(crate) fn clear(&self) {
        *self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }
    fn valid(&self) -> Option<CachedIgdbToken> {
        let token = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        (token.expires_at > chrono::Utc::now().timestamp()).then_some(token)
    }
    fn store(&self, token: CachedIgdbToken) {
        *self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(token);
    }
}

pub struct IgdbClient {
    agent: ureq::Agent,
    token_cache: IgdbTokenCache,
}

impl Default for IgdbClient {
    fn default() -> Self {
        Self::with_cache(IgdbTokenCache::default())
    }
}

impl IgdbClient {
    pub fn new() -> Self {
        Self::default()
    }
    pub(crate) fn with_cache(token_cache: IgdbTokenCache) -> Self {
        Self {
            agent: ureq::Agent::config_builder()
                .https_only(true)
                .max_redirects(0)
                .timeout_global(Some(Duration::from_secs(20)))
                .build()
                .into(),
            token_cache,
        }
    }
    pub fn search(
        &self,
        credentials: &IgdbCredentials,
        query: &str,
    ) -> Result<Vec<IgdbRemoteGame>, LibraryError> {
        let query = query.trim();
        if query.is_empty() {
            return Err(LibraryError::IgdbInvalidRequest);
        }
        self.request_games(credentials, &search_body(query))
            .and_then(|json| parse_games(&json))
    }
    pub fn game(
        &self,
        credentials: &IgdbCredentials,
        game_id: i64,
    ) -> Result<IgdbRemoteGame, LibraryError> {
        if game_id <= 0 {
            return Err(LibraryError::IgdbInvalidRequest);
        }
        let mut games = parse_games(&self.request_games(credentials, &game_body(game_id))?)?;
        games.pop().ok_or(LibraryError::IgdbNotFound)
    }
    pub fn image_url(image_id: &str, size: IgdbImageSize) -> Result<String, LibraryError> {
        image_url(image_id, size)
    }
    fn request_games(
        &self,
        credentials: &IgdbCredentials,
        body: &str,
    ) -> Result<String, LibraryError> {
        let token = self.token(credentials)?;
        match self.request_with_token(&token, credentials, body) {
            Err(LibraryError::IgdbUnauthorized) => {
                self.token_cache.clear();
                let token = self.token(credentials)?;
                self.request_with_token(&token, credentials, body)
            }
            result => result,
        }
    }
    fn token(&self, credentials: &IgdbCredentials) -> Result<String, LibraryError> {
        if credentials.client_id.trim().is_empty() || credentials.client_secret.trim().is_empty() {
            return Err(LibraryError::InvalidIgdbCredential);
        }
        if let Some(token) = self.token_cache.valid() {
            return Ok(token.access_token);
        }
        let form = format!(
            "client_id={}&client_secret={}&grant_type=client_credentials",
            encode_form(&credentials.client_id),
            encode_form(&credentials.client_secret)
        );
        let mut response = self
            .agent
            .post(TOKEN_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .send(form)
            .map_err(map_ureq_error)?;
        let token = parse_token(&read_body(&mut response)?)?;
        self.token_cache.store(token.clone());
        Ok(token.access_token)
    }
    fn request_with_token(
        &self,
        token: &str,
        credentials: &IgdbCredentials,
        body: &str,
    ) -> Result<String, LibraryError> {
        let mut response = self
            .agent
            .post(GAMES_URL)
            .header("Client-ID", credentials.client_id.trim())
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "text/plain")
            .send(body.to_owned())
            .map_err(map_ureq_error)?;
        read_body(&mut response)
    }
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
}
#[derive(Debug, Deserialize)]
struct RawGame {
    id: i64,
    name: String,
    summary: Option<String>,
    first_release_date: Option<i64>,
    genres: Option<Vec<RawName>>,
    platforms: Option<Vec<RawName>>,
    release_dates: Option<Vec<RawReleaseDate>>,
    involved_companies: Option<Vec<RawCompanyRole>>,
    cover: Option<RawImage>,
    artworks: Option<Vec<RawImage>>,
    screenshots: Option<Vec<RawImage>>,
}
#[derive(Debug, Deserialize)]
struct RawName {
    name: String,
}
#[derive(Debug, Deserialize)]
struct RawReleaseDate {
    date: Option<i64>,
    platform: Option<RawName>,
}
#[derive(Debug, Deserialize)]
struct RawCompanyRole {
    developer: Option<bool>,
    publisher: Option<bool>,
    company: Option<RawName>,
}
#[derive(Debug, Deserialize)]
struct RawImage {
    image_id: String,
    width: Option<u32>,
    height: Option<u32>,
}

fn parse_token(json: &str) -> Result<CachedIgdbToken, LibraryError> {
    let value: TokenResponse =
        serde_json::from_str(json).map_err(|_| LibraryError::IgdbInvalidResponse)?;
    if value.access_token.trim().is_empty() || value.expires_in <= 0 {
        return Err(LibraryError::IgdbInvalidResponse);
    }
    Ok(CachedIgdbToken {
        access_token: value.access_token,
        expires_at: chrono::Utc::now()
            .timestamp()
            .saturating_add(value.expires_in)
            .saturating_sub(60),
    })
}

fn parse_games(json: &str) -> Result<Vec<IgdbRemoteGame>, LibraryError> {
    let values: Vec<serde_json::Value> =
        serde_json::from_str(json).map_err(|_| LibraryError::IgdbInvalidResponse)?;
    values
        .iter()
        .map(|value| {
            normalize_game(
                &serde_json::to_string(value).map_err(|_| LibraryError::IgdbInvalidResponse)?,
            )
        })
        .collect()
}

fn normalize_game(json: &str) -> Result<IgdbRemoteGame, LibraryError> {
    let raw: RawGame = serde_json::from_str(json).map_err(|_| LibraryError::IgdbInvalidResponse)?;
    if raw.id <= 0 || raw.name.trim().is_empty() {
        return Err(LibraryError::IgdbInvalidResponse);
    }
    let release_date = raw
        .release_dates
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|release| release.date)
        .chain(raw.first_release_date)
        .filter_map(format_date)
        .min();
    let platforms = raw
        .release_dates
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|release| {
            release
                .platform
                .as_ref()
                .map(|platform| platform.name.trim())
        })
        .chain(
            raw.platforms
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|platform| platform.name.trim()),
        )
        .filter(|name| !name.is_empty())
        .fold(Vec::new(), |mut names: Vec<String>, name| {
            if !names.iter().any(|existing| existing == name) {
                names.push(name.to_owned());
            }
            names
        });
    let companies = raw.involved_companies.unwrap_or_default();
    Ok(IgdbRemoteGame {
        id: raw.id,
        name: raw.name,
        summary: non_empty(raw.summary),
        release_date,
        genres: raw
            .genres
            .unwrap_or_default()
            .into_iter()
            .filter_map(|genre| non_empty(Some(genre.name)))
            .collect(),
        platforms,
        developer: company_names(&companies, true),
        publisher: company_names(&companies, false),
        cover: raw.cover.map(image_ref),
        artworks: raw
            .artworks
            .unwrap_or_default()
            .into_iter()
            .map(image_ref)
            .collect(),
        screenshots: raw
            .screenshots
            .unwrap_or_default()
            .into_iter()
            .map(image_ref)
            .collect(),
        snapshot_json: json.to_owned(),
    })
}

fn company_names(companies: &[RawCompanyRole], developer: bool) -> Option<String> {
    let mut names = Vec::new();
    for role in companies {
        let selected = if developer {
            role.developer.unwrap_or(false)
        } else {
            role.publisher.unwrap_or(false)
        };
        if selected {
            if let Some(company) = role
                .company
                .as_ref()
                .and_then(|company| non_empty(Some(company.name.clone())))
            {
                if !names.contains(&company) {
                    names.push(company);
                }
            }
        }
    }
    (!names.is_empty()).then(|| names.join(" · "))
}
fn image_ref(image: RawImage) -> IgdbImageRef {
    IgdbImageRef {
        image_id: image.image_id,
        width: image.width,
        height: image.height,
    }
}
fn format_date(timestamp: i64) -> Option<String> {
    chrono::Utc
        .timestamp_opt(timestamp, 0)
        .single()
        .map(|date| date.format("%Y-%m-%d").to_string())
}
fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_owned())
    })
}
fn search_body(query: &str) -> String {
    format!("search \"{}\"; fields id,name,summary,first_release_date,genres.name,platforms.name,release_dates.date,release_dates.platform.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name,cover.image_id,cover.width,cover.height,artworks.image_id,artworks.width,artworks.height,screenshots.image_id,screenshots.width,screenshots.height; limit 20;", escape_query(query))
}
fn game_body(game_id: i64) -> String {
    format!("where id = {game_id}; fields id,name,summary,first_release_date,genres.name,platforms.name,release_dates.date,release_dates.platform.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name,cover.image_id,cover.width,cover.height,artworks.image_id,artworks.width,artworks.height,screenshots.image_id,screenshots.width,screenshots.height;")
}
fn escape_query(query: &str) -> String {
    query.replace('\\', "\\\\").replace('"', "\\\"")
}
fn validate_image_id(image_id: &str) -> Result<(), LibraryError> {
    if !image_id.is_empty()
        && image_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        Ok(())
    } else {
        Err(LibraryError::IgdbInvalidImageId)
    }
}
fn image_url(image_id: &str, size: IgdbImageSize) -> Result<String, LibraryError> {
    validate_image_id(image_id)?;
    let size = match size {
        IgdbImageSize::CoverBig => "t_cover_big",
        IgdbImageSize::Hd1080p => "t_1080p",
    };
    Ok(format!(
        "https://images.igdb.com/igdb/image/upload/{size}/{image_id}.jpg"
    ))
}
fn map_http_status(status: u16) -> LibraryError {
    match status {
        400 => LibraryError::IgdbInvalidRequest,
        401 | 403 => LibraryError::IgdbUnauthorized,
        404 => LibraryError::IgdbNotFound,
        429 => LibraryError::IgdbRateLimited,
        500..=599 => LibraryError::IgdbUnavailable,
        _ => LibraryError::IgdbInvalidResponse,
    }
}
fn map_ureq_error(error: ureq::Error) -> LibraryError {
    match error {
        ureq::Error::StatusCode(status) => map_http_status(status),
        ureq::Error::Timeout(_) => LibraryError::IgdbUnavailable,
        _ => LibraryError::IgdbUnavailable,
    }
}
fn read_body(response: &mut ureq::http::Response<ureq::Body>) -> Result<String, LibraryError> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((MAX_JSON_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| LibraryError::IgdbUnavailable)?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err(LibraryError::IgdbInvalidResponse);
    }
    String::from_utf8(bytes).map_err(|_| LibraryError::IgdbInvalidResponse)
}
fn encode_form(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{map_http_status, normalize_game, parse_token, IgdbImageSize, LibraryError};
    #[test]
    fn normalizes_game_with_earliest_release_and_all_platforms() {
        let json = r#"{"id":42,"name":"Example Game","summary":"A game.","genres":[{"name":"RPG"},{"name":"Action"}],"release_dates":[{"date":1704067200,"platform":{"name":"Windows"}},{"date":1672531200,"platform":{"name":"Dreamcast"}},{"date":1704067200,"platform":{"name":"Windows"}}],"involved_companies":[{"developer":true,"publisher":false,"company":{"name":"Dev Co"}},{"developer":false,"publisher":true,"company":{"name":"Pub Co"}}],"cover":{"image_id":"cover-id","width":264,"height":374},"artworks":[{"image_id":"hero-id","width":1920,"height":1080}],"screenshots":[{"image_id":"shot-id","width":1280,"height":720}]}"#;
        let game = normalize_game(json).unwrap();
        assert_eq!(game.release_date.as_deref(), Some("2023-01-01"));
        assert_eq!(game.platforms, vec!["Windows", "Dreamcast"]);
        assert_eq!(game.developer.as_deref(), Some("Dev Co"));
        assert_eq!(game.publisher.as_deref(), Some("Pub Co"));
        assert_eq!(game.cover.as_ref().unwrap().image_id, "cover-id");
        assert_eq!(game.artworks[0].image_id, "hero-id");
        assert_eq!(game.screenshots[0].image_id, "shot-id");
    }
    #[test]
    fn classifies_http_status_and_rejects_bad_images_or_tokens() {
        assert!(matches!(
            map_http_status(400),
            LibraryError::IgdbInvalidRequest
        ));
        assert!(matches!(
            map_http_status(401),
            LibraryError::IgdbUnauthorized
        ));
        assert!(matches!(map_http_status(404), LibraryError::IgdbNotFound));
        assert!(matches!(
            map_http_status(429),
            LibraryError::IgdbRateLimited
        ));
        assert!(matches!(
            map_http_status(503),
            LibraryError::IgdbUnavailable
        ));
        assert!(matches!(
            map_http_status(418),
            LibraryError::IgdbInvalidResponse
        ));
        assert!(super::validate_image_id("../secret").is_err());
        assert!(parse_token("{not-json").is_err());
        assert_eq!(
            super::image_url("abc_-12", IgdbImageSize::CoverBig).unwrap(),
            "https://images.igdb.com/igdb/image/upload/t_cover_big/abc_-12.jpg"
        );
    }
}
