use std::{io::Read, time::Duration};

use serde::{Deserialize, Serialize};
use url::Url;

use super::{
    error::LibraryError,
    models::{TmdbCredentials, TmdbImageRef, TmdbRemoteMovie, TmdbSearchResult},
    work_artwork::MAX_WORK_ARTWORK_BYTES,
};

const API_ORIGIN: &str = "https://api.themoviedb.org/3";
const IMAGE_ORIGIN: &str = "https://image.tmdb.org/t/p";
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const SEARCH_LIMIT: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TmdbImageSize {
    W500,
    W1280,
    Original,
}

impl TmdbImageSize {
    fn as_str(self) -> &'static str {
        match self {
            Self::W500 => "w500",
            Self::W1280 => "w1280",
            Self::Original => "original",
        }
    }
}

pub struct TmdbClient {
    agent: ureq::Agent,
}

impl Default for TmdbClient {
    fn default() -> Self {
        Self::new()
    }
}

impl TmdbClient {
    pub fn new() -> Self {
        Self {
            agent: ureq::Agent::config_builder()
                .https_only(true)
                .max_redirects(0)
                .timeout_global(Some(REQUEST_TIMEOUT))
                .build()
                .into(),
        }
    }

    pub fn search(
        &self,
        credentials: &TmdbCredentials,
        query: &str,
    ) -> Result<Vec<TmdbSearchResult>, LibraryError> {
        let token = trimmed_token(credentials)?;
        let url = search_url(query)?;
        let mut response = self.get(&url, &token)?;
        parse_search(&read_body(&mut response)?)
    }

    pub fn movie(
        &self,
        credentials: &TmdbCredentials,
        movie_id: i64,
    ) -> Result<TmdbRemoteMovie, LibraryError> {
        validate_movie_id(movie_id)?;
        let token = trimmed_token(credentials)?;
        let korean_url = movie_url(movie_id, "ko-KR");
        let mut response = self.get(&korean_url, &token)?;
        let korean_json = read_body(&mut response)?;
        let mut korean = parse_raw_movie(&korean_json)?;
        if korean.id != movie_id {
            return Err(LibraryError::InvalidTmdbIdentity);
        }

        let english = if text_is_blank(korean.title.as_deref())
            || text_is_blank(korean.overview.as_deref())
        {
            let english_url = movie_url(movie_id, "en-US");
            let mut response = self.get(&english_url, &token)?;
            let english = parse_raw_movie(&read_body(&mut response)?)?;
            if english.id != movie_id {
                return Err(LibraryError::InvalidTmdbIdentity);
            }
            Some(english)
        } else {
            None
        };
        if let Some(english) = english {
            merge_raw_movie(&mut korean, english);
        }
        normalize_raw_movie(korean)
    }

    pub(crate) fn download_original(&self, file_path: &str) -> Result<Vec<u8>, LibraryError> {
        let url = Self::image_url(file_path, TmdbImageSize::Original)?;
        let mut response = self.agent.get(&url).call().map_err(map_ureq_error)?;
        read_bytes(&mut response, MAX_WORK_ARTWORK_BYTES)
    }

    pub fn image_url(file_path: &str, size: TmdbImageSize) -> Result<String, LibraryError> {
        image_url(file_path, size)
    }

    fn get(
        &self,
        url: &Url,
        token: &str,
    ) -> Result<ureq::http::Response<ureq::Body>, LibraryError> {
        self.agent
            .get(url.as_str())
            .header("Authorization", format!("Bearer {token}"))
            .call()
            .map_err(map_ureq_error)
    }
}

#[derive(Debug, Deserialize)]
struct RawSearchResponse {
    #[serde(default)]
    results: Vec<RawSearchMovie>,
}

#[derive(Debug, Deserialize)]
struct RawSearchMovie {
    id: i64,
    title: Option<String>,
    original_title: Option<String>,
    release_date: Option<String>,
    poster_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawMovie {
    id: i64,
    title: Option<String>,
    original_title: Option<String>,
    #[allow(dead_code)]
    original_language: Option<String>,
    overview: Option<String>,
    release_date: Option<String>,
    runtime: Option<i64>,
    vote_average: Option<f64>,
    vote_count: Option<i64>,
    #[serde(default)]
    genres: Vec<RawName>,
    poster_path: Option<String>,
    backdrop_path: Option<String>,
    #[serde(default)]
    production_companies: Vec<RawName>,
    credits: Option<RawCredits>,
    images: Option<RawImages>,
}

#[derive(Debug, Deserialize)]
struct RawName {
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawCredits {
    #[serde(default)]
    crew: Vec<RawCrewMember>,
}

#[derive(Debug, Deserialize)]
struct RawCrewMember {
    job: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawImages {
    #[serde(default)]
    posters: Vec<RawImage>,
    #[serde(default)]
    backdrops: Vec<RawImage>,
}

#[derive(Debug, Deserialize)]
struct RawImage {
    file_path: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Serialize)]
struct TmdbSnapshot<'a> {
    id: i64,
    title: &'a str,
    original_title: Option<&'a str>,
    overview: Option<&'a str>,
    release_date: Option<&'a str>,
    runtime_minutes: Option<i64>,
    genres: &'a [String],
    directors: &'a [String],
    production_companies: &'a [String],
    external_score: Option<i64>,
    poster_path: Option<&'a str>,
    backdrop_path: Option<&'a str>,
    posters: &'a [TmdbImageRef],
    backdrops: &'a [TmdbImageRef],
}

fn trimmed_token(credentials: &TmdbCredentials) -> Result<String, LibraryError> {
    let token = credentials.read_access_token.trim();
    if token.is_empty() {
        return Err(LibraryError::InvalidTmdbCredentialValue);
    }
    Ok(token.to_owned())
}

fn validate_movie_id(movie_id: i64) -> Result<(), LibraryError> {
    (movie_id > 0)
        .then_some(())
        .ok_or(LibraryError::InvalidTmdbIdentity)
}

fn search_url(query: &str) -> Result<Url, LibraryError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(LibraryError::TmdbInvalidResponse);
    }
    let mut url = Url::parse(&format!("{API_ORIGIN}/search/movie"))
        .map_err(|_| LibraryError::TmdbInvalidResponse)?;
    url.query_pairs_mut()
        .append_pair("query", query)
        .append_pair("language", "ko-KR")
        .append_pair("include_adult", "false")
        .append_pair("page", "1");
    Ok(url)
}

fn movie_url(movie_id: i64, language: &str) -> Url {
    let mut url = Url::parse(&format!("{API_ORIGIN}/movie/{movie_id}"))
        .expect("TMDB API origin is a compile-time-valid URL");
    url.query_pairs_mut()
        .append_pair("append_to_response", "credits,images")
        .append_pair("language", language)
        .append_pair("include_image_language", "ko,null,en");
    url
}

fn parse_search(json: &str) -> Result<Vec<TmdbSearchResult>, LibraryError> {
    let response: RawSearchResponse =
        serde_json::from_str(json).map_err(|_| LibraryError::TmdbInvalidResponse)?;
    response
        .results
        .into_iter()
        .take(SEARCH_LIMIT)
        .map(normalize_search_result)
        .collect()
}

fn normalize_search_result(raw: RawSearchMovie) -> Result<TmdbSearchResult, LibraryError> {
    validate_movie_id(raw.id)?;
    let original_title = non_empty(raw.original_title);
    let title = non_empty(raw.title)
        .or_else(|| original_title.clone())
        .ok_or(LibraryError::TmdbInvalidResponse)?;
    let original_title = original_title.filter(|original| original != &title);
    let poster_path = checked_optional_path(raw.poster_path)?;
    Ok(TmdbSearchResult {
        movie_id: raw.id,
        title,
        original_title,
        release_date: non_empty(raw.release_date),
        poster_path,
    })
}

fn parse_raw_movie(json: &str) -> Result<RawMovie, LibraryError> {
    serde_json::from_str(json).map_err(|_| LibraryError::TmdbInvalidResponse)
}

fn normalize_movie(json: &str) -> Result<TmdbRemoteMovie, LibraryError> {
    normalize_raw_movie(parse_raw_movie(json)?)
}

fn normalize_raw_movie(raw: RawMovie) -> Result<TmdbRemoteMovie, LibraryError> {
    if raw.id <= 0 {
        return Err(LibraryError::TmdbInvalidResponse);
    }
    let original_title = non_empty(raw.original_title);
    let title = non_empty(raw.title)
        .or_else(|| original_title.clone())
        .ok_or(LibraryError::TmdbInvalidResponse)?;
    let original_title = original_title.filter(|original| original != &title);
    let overview = non_empty(raw.overview);
    let release_date = non_empty(raw.release_date);
    let poster_path = checked_optional_path(raw.poster_path)?;
    let backdrop_path = checked_optional_path(raw.backdrop_path)?;
    let images = raw.images.unwrap_or(RawImages {
        posters: Vec::new(),
        backdrops: Vec::new(),
    });
    let mut posters = normalize_images(images.posters)?;
    let mut backdrops = normalize_images(images.backdrops)?;
    add_primary_image(&mut posters, poster_path.as_deref(), None, None);
    add_primary_image(&mut backdrops, backdrop_path.as_deref(), None, None);

    let directors = raw
        .credits
        .map(|credits| {
            credits
                .crew
                .into_iter()
                .filter(|crew| crew.job.as_deref() == Some("Director"))
                .filter_map(|crew| non_empty(crew.name))
                .fold(Vec::new(), push_unique_limited)
        })
        .unwrap_or_default();
    let production_companies = raw
        .production_companies
        .into_iter()
        .filter_map(|company| non_empty(company.name))
        .fold(Vec::new(), push_unique_limited);
    let genres = raw
        .genres
        .into_iter()
        .filter_map(|genre| non_empty(genre.name))
        .fold(Vec::new(), push_unique);
    let external_score = match (raw.vote_average, raw.vote_count) {
        (Some(score), Some(votes)) if votes > 0 && score.is_finite() && score >= 0.0 => {
            Some((score * 10.0).round() as i64)
        }
        _ => None,
    };
    let runtime_minutes = raw.runtime.filter(|runtime| *runtime > 0);
    let mut movie = TmdbRemoteMovie {
        id: raw.id,
        title,
        original_title,
        overview,
        release_date,
        runtime_minutes,
        genres,
        directors,
        production_companies,
        external_score,
        poster_path,
        backdrop_path,
        posters,
        backdrops,
        snapshot_json: String::new(),
    };
    movie.snapshot_json = serde_json::to_string(&TmdbSnapshot {
        id: movie.id,
        title: &movie.title,
        original_title: movie.original_title.as_deref(),
        overview: movie.overview.as_deref(),
        release_date: movie.release_date.as_deref(),
        runtime_minutes: movie.runtime_minutes,
        genres: &movie.genres,
        directors: &movie.directors,
        production_companies: &movie.production_companies,
        external_score: movie.external_score,
        poster_path: movie.poster_path.as_deref(),
        backdrop_path: movie.backdrop_path.as_deref(),
        posters: &movie.posters,
        backdrops: &movie.backdrops,
    })
    .map_err(|_| LibraryError::TmdbInvalidResponse)?;
    Ok(movie)
}

fn merge_raw_movie(primary: &mut RawMovie, fallback: RawMovie) {
    if text_is_blank(primary.title.as_deref()) {
        primary.title = fallback.title;
    }
    if text_is_blank(primary.overview.as_deref()) {
        primary.overview = fallback.overview;
    }
    if primary
        .original_title
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
    {
        primary.original_title = fallback.original_title;
    }
    if primary
        .release_date
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
    {
        primary.release_date = fallback.release_date;
    }
    if primary.runtime.is_none() {
        primary.runtime = fallback.runtime;
    }
    if primary.vote_average.is_none() {
        primary.vote_average = fallback.vote_average;
    }
    if primary.vote_count.is_none() {
        primary.vote_count = fallback.vote_count;
    }
    if primary.genres.is_empty() {
        primary.genres = fallback.genres;
    }
    if primary.production_companies.is_empty() {
        primary.production_companies = fallback.production_companies;
    }
    if primary.credits.is_none() {
        primary.credits = fallback.credits;
    }
    if primary.poster_path.is_none() {
        primary.poster_path = fallback.poster_path;
    }
    if primary.backdrop_path.is_none() {
        primary.backdrop_path = fallback.backdrop_path;
    }
    if primary.images.is_none() {
        primary.images = fallback.images;
    }
}

fn normalize_images(images: Vec<RawImage>) -> Result<Vec<TmdbImageRef>, LibraryError> {
    images
        .into_iter()
        .filter_map(|image| {
            let file_path = image.file_path?;
            Some((file_path, image.width, image.height))
        })
        .map(|(file_path, width, height)| {
            validate_image_path(&file_path)?;
            Ok(TmdbImageRef {
                file_path,
                width,
                height,
            })
        })
        .collect()
}

fn add_primary_image(
    images: &mut Vec<TmdbImageRef>,
    file_path: Option<&str>,
    width: Option<u32>,
    height: Option<u32>,
) {
    if let Some(file_path) = file_path {
        if !images.iter().any(|image| image.file_path == file_path) {
            images.insert(
                0,
                TmdbImageRef {
                    file_path: file_path.to_owned(),
                    width,
                    height,
                },
            );
        }
    }
}

fn validate_image_path(file_path: &str) -> Result<(), LibraryError> {
    let Some(file_name) = file_path.strip_prefix('/') else {
        return Err(LibraryError::TmdbInvalidImagePath);
    };
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains("..")
        || file_name.contains('?')
        || file_name.contains('#')
        || file_name.contains(':')
    {
        return Err(LibraryError::TmdbInvalidImagePath);
    }
    let Some((stem, extension)) = file_name.rsplit_once('.') else {
        return Err(LibraryError::TmdbInvalidImagePath);
    };
    if stem.is_empty()
        || !stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        || !matches!(extension, "jpg" | "jpeg" | "png" | "webp")
    {
        return Err(LibraryError::TmdbInvalidImagePath);
    }
    Ok(())
}

fn checked_optional_path(path: Option<String>) -> Result<Option<String>, LibraryError> {
    path.map(|path| {
        validate_image_path(&path)?;
        Ok(path)
    })
    .transpose()
}

fn image_url(file_path: &str, size: TmdbImageSize) -> Result<String, LibraryError> {
    validate_image_path(file_path)?;
    Ok(format!(
        "{IMAGE_ORIGIN}/{}/{}",
        size.as_str(),
        &file_path[1..]
    ))
}

fn map_ureq_error(error: ureq::Error) -> LibraryError {
    match error {
        ureq::Error::StatusCode(status) => map_http_status(status),
        ureq::Error::Timeout(_) => LibraryError::TmdbTimedOut,
        _ => LibraryError::TmdbUnavailable,
    }
}

fn map_http_status(status: u16) -> LibraryError {
    match status {
        401 | 403 => LibraryError::TmdbUnauthorized,
        404 => LibraryError::TmdbNotFound,
        429 => LibraryError::TmdbRateLimited,
        500..=599 => LibraryError::TmdbUnavailable,
        _ => LibraryError::TmdbInvalidResponse,
    }
}

fn read_body(response: &mut ureq::http::Response<ureq::Body>) -> Result<String, LibraryError> {
    String::from_utf8(read_bytes(response, MAX_JSON_BYTES)?)
        .map_err(|_| LibraryError::TmdbInvalidResponse)
}

fn read_bytes(
    response: &mut ureq::http::Response<ureq::Body>,
    maximum_bytes: usize,
) -> Result<Vec<u8>, LibraryError> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((maximum_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                LibraryError::TmdbTimedOut
            } else {
                LibraryError::TmdbUnavailable
            }
        })?;
    if bytes.len() > maximum_bytes {
        return Err(LibraryError::TmdbInvalidResponse);
    }
    Ok(bytes)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_owned())
    })
}

fn text_is_blank(value: Option<&str>) -> bool {
    value.is_none_or(|value| value.trim().is_empty())
}

fn push_unique(mut values: Vec<String>, value: String) -> Vec<String> {
    if !values.contains(&value) {
        values.push(value);
    }
    values
}

fn push_unique_limited(mut values: Vec<String>, value: String) -> Vec<String> {
    if values.len() < 2 && !values.contains(&value) {
        values.push(value);
    }
    values
}

#[cfg(test)]
mod tests {
    use super::{map_http_status, normalize_movie, validate_image_path, TmdbImageSize};
    use crate::library::{error::LibraryError, models::TmdbCredentials};

    #[test]
    fn normalizes_movie_score_and_redacts_token() {
        let movie = normalize_movie(
            r#"{
                "id": 10494,
                "title": "퍼펙트 블루",
                "original_title": "Perfect Blue",
                "original_language": "ja",
                "overview": "아이돌 출신 배우의 심리 스릴러.",
                "release_date": "1997-07-25",
                "runtime": 81,
                "vote_average": 8.73,
                "vote_count": 120,
                "genres": [{"id": 16, "name": "애니메이션"}],
                "poster_path": "/poster_abc.jpg",
                "backdrop_path": "/backdrop_xyz.webp",
                "credits": {
                    "crew": [{"job": "Director", "name": "곤 사토시"}]
                },
                "production_companies": [
                    {"id": 1, "name": "매드하우스"},
                    {"id": 2, "name": "Rex Entertainment"}
                ],
                "images": {"posters": [], "backdrops": []}
            }"#,
        )
        .unwrap();
        let credentials = TmdbCredentials {
            read_access_token: "secret-token".into(),
        };

        assert_eq!(movie.external_score, Some(87));
        assert_eq!(movie.runtime_minutes, Some(81));
        assert_eq!(movie.directors, vec!["곤 사토시"]);
        assert_eq!(
            movie.production_companies,
            vec!["매드하우스", "Rex Entertainment"]
        );
        assert!(!format!("{:?}", credentials).contains("secret-token"));
    }

    #[test]
    fn validates_closed_tmdb_image_paths_and_builds_fixed_urls() {
        assert!(validate_image_path("/abc_-12.jpg").is_ok());
        for path in [
            "abc.jpg",
            "/../secret.jpg",
            "/folder/secret.jpg",
            "/secret.jpg?x=1",
            "/secret.jpg#fragment",
            "https://image.tmdb.org/t/p/original/secret.jpg",
            "/secret.gif",
            "/secret.bad.jpg",
        ] {
            assert!(validate_image_path(path).is_err(), "{path}");
        }
        assert_eq!(
            super::TmdbClient::image_url("/abc_-12.jpg", TmdbImageSize::W500).unwrap(),
            "https://image.tmdb.org/t/p/w500/abc_-12.jpg"
        );
    }

    #[test]
    fn maps_tmdb_statuses_and_timeouts_without_provider_details() {
        assert!(matches!(
            map_http_status(401),
            LibraryError::TmdbUnauthorized
        ));
        assert!(matches!(
            map_http_status(429),
            LibraryError::TmdbRateLimited
        ));
        assert!(matches!(map_http_status(404), LibraryError::TmdbNotFound));
        assert!(matches!(
            map_http_status(503),
            LibraryError::TmdbUnavailable
        ));
        assert!(matches!(
            super::map_ureq_error(ureq::Error::Timeout(ureq::Timeout::Global)),
            LibraryError::TmdbTimedOut
        ));
        assert!(!LibraryError::TmdbUnauthorized
            .to_string()
            .contains("api.themoviedb.org"));
    }
}
