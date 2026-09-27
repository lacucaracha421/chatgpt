use super::models::*;
use crate::library::{av_models::AvError, error::LibraryError};
use image::{DynamicImage, ImageFormat};
use regex::Regex;
use std::{
    io::{Cursor, Read},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

pub(super) const MAX_JACKET_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAX_JSON_BYTES: usize = 1024 * 1024;
const USER_AGENT: &str = "Lakomics/0.2 (personal media library; personal use)";
static LIBREDMM: Mutex<Option<Instant>> = Mutex::new(None);
static WIKIDATA: Mutex<Option<Instant>> = Mutex::new(None);

pub(crate) struct HttpResponse {
    pub status: u16,
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
}
/// Every request, including the authenticated feed and jacket download, uses this boundary.
pub(crate) trait HttpClient {
    fn get(
        &self,
        url: &str,
        token: Option<&str>,
        limit: usize,
    ) -> Result<HttpResponse, LibraryError>;
}
pub(crate) struct NetworkClient {
    agent: ureq::Agent,
}
impl NetworkClient {
    pub fn new() -> Self {
        Self {
            agent: crate::http_agent::agent(
                ureq::Agent::config_builder()
                    .max_redirects(0)
                    .http_status_as_error(false)
                    .timeout_global(Some(Duration::from_secs(30)))
                    .build(),
            ),
        }
    }
}
fn pace(lock: &Mutex<Option<Instant>>, seconds: u64) {
    let mut previous = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(last) = *previous {
        std::thread::sleep(Duration::from_secs(seconds).saturating_sub(last.elapsed()));
    }
    *previous = Some(Instant::now());
}
impl HttpClient for NetworkClient {
    fn get(
        &self,
        url: &str,
        token: Option<&str>,
        limit: usize,
    ) -> Result<HttpResponse, LibraryError> {
        let host = url::Url::parse(url).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if host.host_str() == Some("www.libredmm.com") {
            pace(&LIBREDMM, 2);
        }
        if host.host_str() == Some("query.wikidata.org") {
            pace(&WIKIDATA, 1);
        }
        let mut request = self.agent.get(url).header("User-Agent", USER_AGENT);
        if let Some(token) = token {
            request = request.header("Authorization", format!("Bearer {}", token.trim()));
        }
        let mut response = request
            .call()
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        let status = response.status().as_u16();
        if matches!(status, 401 | 403) && token.is_some() {
            return Err(LibraryError::CloudUnauthorized);
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        if bytes.len() > limit {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(HttpResponse {
            status,
            bytes,
            content_type,
        })
    }
}

pub fn normalize_code(input: &str) -> Option<String> {
    static FC2: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^FC2[-_ ]?PPV[-_ ]?([0-9]+)$").unwrap());
    static AMATEUR: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^([0-9]+(?:LUXU|GANA|MAAN|ARA|MIUM|PRESTIGE))[-_ ]?([0-9]+)$").unwrap()
    });
    static STANDARD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:H_[0-9]+|[0-9]+|K9)?([A-Z]+)[-_ ]?([0-9]+)(?:R|BOD|TK)?$").unwrap()
    });
    let code = input.trim().to_ascii_uppercase();
    if code.len() > 40 {
        return None;
    }
    let (label, digits, explicit) = if let Some(c) = FC2.captures(&code) {
        ("FC2-PPV".to_owned(), c[1].to_owned(), code.contains('-'))
    } else if let Some(c) = AMATEUR.captures(&code) {
        (c[1].to_owned(), c[2].to_owned(), code.contains('-'))
    } else if let Some(c) = STANDARD.captures(&code) {
        (c[1].to_owned(), c[2].to_owned(), code.contains('-'))
    } else {
        return None;
    };
    // Explicit display codes retain longer serials. Compact CIDs use zero padding.
    let digits = if explicit {
        digits.as_str()
    } else {
        digits.trim_start_matches('0')
    };
    let digits = if digits.is_empty() { "0" } else { digits };
    Some(format!("{label}-{digits:0>3}"))
}
pub fn default_split(width: u32, height: u32) -> DefaultSplit {
    let is_wrap = width as f64 / height.max(1) as f64 >= 1.2;
    let (x1, x2) = if is_wrap {
        let side = ((height as f64 * 0.703).round() as u32).min(width / 2);
        (side, width - side)
    } else {
        (0, 0)
    };
    let fraction = (x2 - x1) as f64 / width.max(1) as f64;
    DefaultSplit {
        split: Split { x1, x2 },
        is_wrap,
        use_spine: is_wrap && (0.01..=0.12).contains(&fraction),
    }
}
pub(super) fn parse_movie(bytes: &[u8], code: &str) -> Result<Movie, AvError> {
    if bytes.len() > MAX_JSON_BYTES {
        return Err(AvError::Invalid);
    }
    let movie: Movie = serde_json::from_slice(bytes).map_err(|_| AvError::Invalid)?;
    if normalize_code(&movie.normalized_id).as_deref() != Some(code)
        || movie.title.is_empty()
        || movie.title.chars().count() > 4000
        || movie.actresses.len() + movie.directors.len() > 100
        || movie
            .actresses
            .iter()
            .map(|p| p.name.as_str())
            .chain(movie.directors.iter().map(String::as_str))
            .any(|n| n.trim().is_empty() || n.chars().count() > 120)
    {
        return Err(AvError::Invalid);
    }
    release_date(&movie)?;
    Ok(movie)
}
pub(super) fn release_date(movie: &Movie) -> Result<Option<String>, AvError> {
    movie
        .date
        .as_ref()
        .map(|date| {
            let parsed =
                chrono::DateTime::parse_from_rfc3339(date).map_err(|_| AvError::Invalid)?;
            Ok(parsed
                .with_timezone(&chrono::FixedOffset::east_opt(9 * 3600).unwrap())
                .format("%Y-%m-%d")
                .to_string())
        })
        .transpose()
}
pub(super) fn movie_fields(movie: &Movie) -> Result<Fields, AvError> {
    Ok(Fields {
        title_ja: Some(movie.title.clone()),
        release_date: release_date(movie)?,
        maker: (!movie.makers.is_empty()).then(|| movie.makers.join(", ")),
        label: (!movie.labels.is_empty()).then(|| movie.labels.join(", ")),
        series: (!movie.series.is_empty()).then(|| movie.series.join(", ")),
        genres: Some(movie.genres.clone()),
    })
}
pub(super) fn jacket_url(raw: &str) -> Result<url::Url, AvError> {
    let mut url = url::Url::parse(raw).map_err(|_| AvError::Image)?;
    // Only known provider image hosts, no arbitrary local/private endpoints or credentials.
    if !matches!(
        url.host_str(),
        Some("pics.dmm.co.jp" | "awsimgsrc.dmm.co.jp" | "image.mgstage.com")
    ) || !matches!(url.scheme(), "http" | "https")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AvError::Image);
    }
    url.set_scheme("https").map_err(|_| AvError::Image)?;
    Ok(url)
}
pub(super) fn decode_jacket(bytes: &[u8]) -> Result<(DynamicImage, ImageFormat), AvError> {
    if bytes.is_empty() || bytes.len() > MAX_JACKET_BYTES {
        return Err(AvError::Image);
    }
    let format = image::guess_format(bytes).map_err(|_| AvError::Image)?;
    if !matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP
    ) {
        return Err(AvError::Image);
    }
    let (w, h) = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| AvError::Image)?;
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 16_000_000 {
        return Err(AvError::Image);
    }
    Ok((
        image::load_from_memory_with_format(bytes, format).map_err(|_| AvError::Image)?,
        format,
    ))
}

pub(super) fn wikidata_url(names: &[String]) -> Result<String, AvError> {
    let values = names
        .iter()
        .map(|n| serde_json::to_string(n).map(|v| format!("{v}@ja")))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| AvError::Invalid)?
        .join(" ");
    let query=format!("SELECT DISTINCT ?name ?person ?ko ?fanza WHERE {{ VALUES ?name {{ {values} }} ?person (rdfs:label|skos:altLabel) ?name . ?person wdt:P31 wd:Q5 . OPTIONAL {{ ?person rdfs:label ?ko FILTER(LANG(?ko) = 'ko') }} OPTIONAL {{ ?person wdt:P9781 ?fanza }} }} LIMIT 1000");
    let mut url = url::Url::parse("https://query.wikidata.org/sparql").unwrap();
    url.query_pairs_mut()
        .append_pair("format", "json")
        .append_pair("query", &query);
    Ok(url.into())
}
pub(super) fn parse_names(bytes: &[u8], names: &[String]) -> Result<Vec<NameMapping>, AvError> {
    let json: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| AvError::Invalid)?;
    let bindings = json
        .pointer("/results/bindings")
        .and_then(|v| v.as_array())
        .ok_or(AvError::Invalid)?;
    Ok(names
        .iter()
        .map(|name| {
            let mut matches = std::collections::BTreeMap::new();
            for row in bindings {
                if row.pointer("/name/value").and_then(|v| v.as_str()) != Some(name) {
                    continue;
                }
                let Some(id) = row
                    .pointer("/person/value")
                    .and_then(|v| v.as_str())
                    .and_then(|v| {
                        v.strip_prefix("http://www.wikidata.org/entity/")
                            .or_else(|| v.strip_prefix("https://www.wikidata.org/entity/"))
                    })
                else {
                    continue;
                };
                if id.len() < 2
                    || !id.starts_with('Q')
                    || !id[1..].chars().all(|c| c.is_ascii_digit())
                {
                    continue;
                }
                let mut mapping = NameMapping::japanese(name);
                mapping.wikidata_id = Some(id.into());
                mapping.name_ko = row
                    .pointer("/ko/value")
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty() && v.chars().count() <= 120)
                    .map(str::to_owned);
                mapping.fanza_actress_id = row
                    .pointer("/fanza/value")
                    .and_then(|v| v.as_str())
                    .filter(|v| {
                        !v.is_empty() && v.len() <= 40 && v.chars().all(|c| c.is_ascii_digit())
                    })
                    .map(str::to_owned);
                matches.insert(id, mapping);
            }
            // Ambiguous Japanese names must remain unresolved, never silently pick a person.
            if matches.len() == 1 {
                matches.into_values().next().unwrap()
            } else {
                NameMapping::japanese(name)
            }
        })
        .collect())
}
