use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    time::Duration,
};

use serde::Deserialize;
use url::Url;

use super::{
    error::LibraryError,
    models::{MangaDexCoverCandidate, MangaDexSearchResult, MangaDexWorkPreview},
};

const API_ORIGIN: &str = "https://api.mangadex.org";
const UPLOADS_ORIGIN: &str = "https://uploads.mangadex.org";
const SEARCH_LIMIT: usize = 20;
const COVER_LIMIT: usize = 100;
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const MAX_COVER_BYTES: usize = 32 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const LOCALE_PRIORITY: [&str; 4] = ["ko", "en", "ja-ro", "ja"];

pub(crate) struct MangaDexFetchedWork {
    pub preview: MangaDexWorkPreview,
    pub snapshot_json: String,
}

pub(crate) struct RemoteImage {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

#[derive(Deserialize)]
struct CollectionEnvelope<T> {
    result: String,
    data: Vec<T>,
}

#[derive(Deserialize)]
struct EntityEnvelope<T> {
    result: String,
    data: T,
}

#[derive(Deserialize)]
struct MangaData {
    id: String,
    attributes: MangaAttributes,
    #[serde(default)]
    relationships: Vec<Relationship>,
}

#[derive(Deserialize)]
struct MangaAttributes {
    #[serde(default)]
    title: BTreeMap<String, String>,
    #[serde(default, rename = "altTitles")]
    alt_titles: Vec<BTreeMap<String, String>>,
    #[serde(default)]
    description: BTreeMap<String, String>,
    year: Option<i64>,
    status: Option<String>,
    #[serde(default)]
    tags: Vec<TagData>,
}

#[derive(Deserialize)]
struct TagData {
    attributes: LocalizedName,
}

#[derive(Deserialize)]
struct LocalizedName {
    #[serde(default)]
    name: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct Relationship {
    id: String,
    #[serde(rename = "type")]
    relationship_type: String,
    attributes: Option<RelationshipAttributes>,
}

#[derive(Deserialize)]
struct RelationshipAttributes {
    name: Option<String>,
    #[serde(rename = "fileName")]
    file_name: Option<String>,
}

#[derive(Deserialize)]
struct CoverData {
    id: String,
    attributes: CoverAttributes,
    #[serde(default)]
    relationships: Vec<Relationship>,
}

#[derive(Deserialize)]
struct CoverAttributes {
    volume: Option<String>,
    #[serde(rename = "fileName")]
    file_name: String,
    locale: Option<String>,
}

pub(crate) fn validate_query(query: &str) -> Result<String, LibraryError> {
    let query = query.trim();
    if query.chars().count() < 2 {
        return Err(LibraryError::InvalidMangaDexQuery);
    }
    Ok(query.to_owned())
}

pub(crate) fn validate_cover_identity(manga_id: &str, file_name: &str) -> Result<(), LibraryError> {
    uuid::Uuid::parse_str(manga_id).map_err(|_| LibraryError::InvalidMangaDexIdentity)?;
    let valid_name = !file_name.is_empty()
        && file_name.len() <= 160
        && !file_name.contains("..")
        && file_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && matches!(
            file_name.rsplit_once('.').map(|(_, extension)| extension),
            Some("jpg" | "jpeg" | "png" | "webp")
        );
    if !valid_name {
        return Err(LibraryError::InvalidMangaDexIdentity);
    }
    Ok(())
}

pub(crate) fn search_url(query: &str) -> Result<Url, LibraryError> {
    let query = validate_query(query)?;
    let mut url = Url::parse(&format!("{API_ORIGIN}/manga"))
        .map_err(|_| LibraryError::InvalidMangaDexResponse)?;
    url.query_pairs_mut()
        .append_pair("title", &query)
        .append_pair("limit", &SEARCH_LIMIT.to_string())
        .append_pair("includes[]", "cover_art")
        .append_pair("includes[]", "author")
        .append_pair("includes[]", "artist");
    Ok(url)
}

pub(crate) fn cover_url(
    manga_id: &str,
    file_name: &str,
    preview: bool,
) -> Result<Url, LibraryError> {
    validate_cover_identity(manga_id, file_name)?;
    let suffix = if preview { ".256.jpg" } else { "" };
    Url::parse(&format!(
        "{UPLOADS_ORIGIN}/covers/{manga_id}/{file_name}{suffix}"
    ))
    .map_err(|_| LibraryError::InvalidMangaDexIdentity)
}

pub(crate) fn parse_search(json: &str) -> Result<Vec<MangaDexSearchResult>, LibraryError> {
    let envelope: CollectionEnvelope<MangaData> =
        serde_json::from_str(json).map_err(|_| LibraryError::InvalidMangaDexResponse)?;
    if envelope.result != "ok" {
        return Err(LibraryError::InvalidMangaDexResponse);
    }
    envelope
        .data
        .into_iter()
        .take(SEARCH_LIMIT)
        .map(map_search_result)
        .collect()
}

pub(crate) fn parse_work_preview(
    detail_json: &str,
    covers_json: &str,
) -> Result<MangaDexWorkPreview, LibraryError> {
    let detail: EntityEnvelope<MangaData> =
        serde_json::from_str(detail_json).map_err(|_| LibraryError::InvalidMangaDexResponse)?;
    let covers: CollectionEnvelope<CoverData> =
        serde_json::from_str(covers_json).map_err(|_| LibraryError::InvalidMangaDexResponse)?;
    if detail.result != "ok" || covers.result != "ok" {
        return Err(LibraryError::InvalidMangaDexResponse);
    }
    let genres = localized_tags(&detail.data.attributes.tags);
    let overview = localized_value(&detail.data.attributes.description);
    let result = map_search_result(detail.data)?;
    let covers = covers
        .data
        .into_iter()
        .filter(|cover| {
            cover.relationships.iter().any(|relationship| {
                relationship.relationship_type == "manga" && relationship.id == result.manga_id
            })
        })
        .take(COVER_LIMIT)
        .map(|cover| {
            validate_cover_identity(&result.manga_id, &cover.attributes.file_name)?;
            uuid::Uuid::parse_str(&cover.id).map_err(|_| LibraryError::InvalidMangaDexResponse)?;
            Ok(MangaDexCoverCandidate {
                cover_id: cover.id,
                file_name: cover.attributes.file_name,
                volume: cover.attributes.volume,
                language: cover.attributes.locale,
            })
        })
        .collect::<Result<Vec<_>, LibraryError>>()?;
    Ok(MangaDexWorkPreview {
        manga_id: result.manga_id,
        proposed_title: result.title,
        alternate_titles: result.alternate_titles,
        author: result.author,
        year: result.year,
        status: result.status,
        genres,
        overview,
        covers,
    })
}

pub(crate) fn search(query: &str) -> Result<Vec<MangaDexSearchResult>, LibraryError> {
    let url = search_url(query)?;
    let json = get_text(&url, MAX_JSON_BYTES)?;
    parse_search(&json)
}

pub(crate) fn fetch_work(manga_id: &str) -> Result<MangaDexFetchedWork, LibraryError> {
    let detail_url = detail_url(manga_id)?;
    let covers_url = covers_url(manga_id)?;
    let detail_json = get_text(&detail_url, MAX_JSON_BYTES)?;
    let covers_json = get_text(&covers_url, MAX_JSON_BYTES)?;
    let preview = parse_work_preview(&detail_json, &covers_json)?;
    let detail: serde_json::Value =
        serde_json::from_str(&detail_json).map_err(|_| LibraryError::InvalidMangaDexResponse)?;
    let covers: serde_json::Value =
        serde_json::from_str(&covers_json).map_err(|_| LibraryError::InvalidMangaDexResponse)?;
    let snapshot_json = serde_json::to_string(&serde_json::json!({
        "detail": detail,
        "covers": covers,
    }))
    .map_err(|_| LibraryError::InvalidMangaDexResponse)?;
    Ok(MangaDexFetchedWork {
        preview,
        snapshot_json,
    })
}

pub(crate) fn cover_preview(manga_id: &str, file_name: &str) -> Result<RemoteImage, LibraryError> {
    let bytes = get_bytes(&cover_url(manga_id, file_name, true)?, MAX_PREVIEW_BYTES)?;
    let format = image::guess_format(&bytes).map_err(|_| LibraryError::InvalidMangaDexResponse)?;
    let mime = match format {
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::WebP => "image/webp",
        _ => return Err(LibraryError::InvalidMangaDexResponse),
    };
    image::load_from_memory_with_format(&bytes, format)
        .map_err(|_| LibraryError::InvalidMangaDexResponse)?;
    Ok(RemoteImage { bytes, mime })
}

pub(crate) fn download_cover(manga_id: &str, file_name: &str) -> Result<Vec<u8>, LibraryError> {
    get_bytes(&cover_url(manga_id, file_name, false)?, MAX_COVER_BYTES)
}

fn detail_url(manga_id: &str) -> Result<Url, LibraryError> {
    uuid::Uuid::parse_str(manga_id).map_err(|_| LibraryError::InvalidMangaDexIdentity)?;
    let mut url = Url::parse(&format!("{API_ORIGIN}/manga/{manga_id}"))
        .map_err(|_| LibraryError::InvalidMangaDexIdentity)?;
    url.query_pairs_mut()
        .append_pair("includes[]", "cover_art")
        .append_pair("includes[]", "author")
        .append_pair("includes[]", "artist");
    Ok(url)
}

fn covers_url(manga_id: &str) -> Result<Url, LibraryError> {
    uuid::Uuid::parse_str(manga_id).map_err(|_| LibraryError::InvalidMangaDexIdentity)?;
    let mut url = Url::parse(&format!("{API_ORIGIN}/cover"))
        .map_err(|_| LibraryError::InvalidMangaDexIdentity)?;
    url.query_pairs_mut()
        .append_pair("manga[]", manga_id)
        .append_pair("limit", &COVER_LIMIT.to_string())
        .append_pair("order[volume]", "asc");
    Ok(url)
}

fn get_text(url: &Url, maximum_bytes: usize) -> Result<String, LibraryError> {
    String::from_utf8(get_bytes(url, maximum_bytes)?)
        .map_err(|_| LibraryError::InvalidMangaDexResponse)
}

fn get_bytes(url: &Url, maximum_bytes: usize) -> Result<Vec<u8>, LibraryError> {
    let config = ureq::Agent::config_builder()
        .https_only(true)
        .max_redirects(0)
        .timeout_global(Some(REQUEST_TIMEOUT))
        .build();
    let agent: ureq::Agent = config.into();
    let mut response = agent
        .get(url.as_str())
        .header(
            "User-Agent",
            format!("Lakomics/{}", env!("CARGO_PKG_VERSION")),
        )
        .call()
        .map_err(map_ureq_error)?;
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((maximum_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                LibraryError::MangaDexTimedOut
            } else {
                LibraryError::MangaDexUnavailable
            }
        })?;
    if bytes.len() > maximum_bytes {
        return Err(LibraryError::InvalidMangaDexResponse);
    }
    Ok(bytes)
}

fn map_ureq_error(error: ureq::Error) -> LibraryError {
    match error {
        ureq::Error::StatusCode(code) => map_status_code(code),
        ureq::Error::Timeout(_) => LibraryError::MangaDexTimedOut,
        _ => LibraryError::MangaDexUnavailable,
    }
}

fn map_status_code(code: u16) -> LibraryError {
    match code {
        404 => LibraryError::MangaDexNotFound,
        429 => LibraryError::MangaDexRateLimited,
        _ => LibraryError::MangaDexUnavailable,
    }
}

fn map_search_result(data: MangaData) -> Result<MangaDexSearchResult, LibraryError> {
    uuid::Uuid::parse_str(&data.id).map_err(|_| LibraryError::InvalidMangaDexResponse)?;
    let title = preferred_title(&data.attributes.title, &data.attributes.alt_titles)
        .ok_or(LibraryError::InvalidMangaDexResponse)?;
    let alternate_titles =
        alternate_titles(&title, &data.attributes.title, &data.attributes.alt_titles);
    let author = relationship_people(&data.relationships);
    let primary_cover_file_name = data
        .relationships
        .iter()
        .find(|relationship| relationship.relationship_type == "cover_art")
        .and_then(|relationship| relationship.attributes.as_ref())
        .and_then(|attributes| attributes.file_name.clone());
    if let Some(file_name) = &primary_cover_file_name {
        validate_cover_identity(&data.id, file_name)?;
    }
    Ok(MangaDexSearchResult {
        manga_id: data.id,
        title,
        alternate_titles,
        author,
        year: data.attributes.year,
        status: data.attributes.status,
        primary_cover_file_name,
    })
}

fn preferred_title(
    title: &BTreeMap<String, String>,
    alternates: &[BTreeMap<String, String>],
) -> Option<String> {
    LOCALE_PRIORITY.iter().find_map(|locale| {
        std::iter::once(title)
            .chain(alternates)
            .find_map(|values| nonempty(values.get(*locale)))
    })
}

fn alternate_titles(
    selected: &str,
    title: &BTreeMap<String, String>,
    alternates: &[BTreeMap<String, String>],
) -> Vec<String> {
    let mut seen = BTreeSet::from([selected.to_owned()]);
    std::iter::once(title)
        .chain(alternates)
        .flat_map(|values| values.values())
        .filter_map(|value| nonempty(Some(value)))
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn relationship_people(relationships: &[Relationship]) -> Option<String> {
    let mut seen = BTreeSet::new();
    let people = relationships
        .iter()
        .filter(|relationship| {
            matches!(relationship.relationship_type.as_str(), "author" | "artist")
        })
        .filter_map(|relationship| relationship.attributes.as_ref()?.name.as_ref())
        .filter_map(|name| nonempty(Some(name)))
        .filter(|name| seen.insert(name.clone()))
        .collect::<Vec<_>>();
    (!people.is_empty()).then(|| people.join(" · "))
}

fn localized_tags(tags: &[TagData]) -> Option<String> {
    let values = tags
        .iter()
        .filter_map(|tag| localized_value(&tag.attributes.name))
        .collect::<Vec<_>>();
    (!values.is_empty()).then(|| values.join(", "))
}

fn localized_value(values: &BTreeMap<String, String>) -> Option<String> {
    LOCALE_PRIORITY
        .iter()
        .find_map(|locale| nonempty(values.get(*locale)))
        .or_else(|| values.values().find_map(|value| nonempty(Some(value))))
}

fn nonempty(value: Option<&String>) -> Option<String> {
    value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::{
        cover_url, map_status_code, parse_search, parse_work_preview, search_url,
        validate_cover_identity, validate_query,
    };
    use crate::library::error::LibraryError;

    const MANGA_ID: &str = "d1a9fdeb-f713-407f-960c-8326b586e6fd";
    const COVER_FILE: &str = "a1b2c3d4-e5f6-47a8-9000-111122223333.jpg";

    #[test]
    fn parses_localized_search_values_without_duplicate_people_or_titles() {
        let results = parse_search(include_str!("fixtures/mangadex_search.json")).unwrap();

        assert_eq!(results.len(), 1);
        let result = &results[0];
        assert_eq!(result.manga_id, MANGA_ID);
        assert_eq!(result.title, "던전밥");
        assert_eq!(
            result.alternate_titles,
            vec!["Delicious in Dungeon", "Dungeon Meshi", "ダンジョン飯"]
        );
        assert_eq!(result.author.as_deref(), Some("Ryoko Kui"));
        assert_eq!(result.year, Some(2014));
        assert_eq!(result.status.as_deref(), Some("completed"));
        assert_eq!(result.primary_cover_file_name.as_deref(), Some(COVER_FILE));
    }

    #[test]
    fn combines_detail_and_cover_records_into_an_app_preview() {
        let preview = parse_work_preview(
            include_str!("fixtures/mangadex_detail.json"),
            include_str!("fixtures/mangadex_covers.json"),
        )
        .unwrap();

        assert_eq!(preview.manga_id, MANGA_ID);
        assert_eq!(preview.proposed_title, "던전밥");
        assert_eq!(preview.author.as_deref(), Some("Ryoko Kui"));
        assert_eq!(
            preview.overview.as_deref(),
            Some("던전을 탐험하며 마물을 요리하는 이야기.")
        );
        assert_eq!(preview.genres.as_deref(), Some("Fantasy, 모험"));
        assert_eq!(preview.covers.len(), 2);
        assert_eq!(
            preview.covers[0].cover_id,
            "11111111-1111-4111-8111-111111111111"
        );
        assert_eq!(preview.covers[1].language.as_deref(), Some("ko"));
    }

    #[test]
    fn provider_urls_are_fixed_and_inputs_are_validated() {
        assert_eq!(validate_query(" 던전 ").unwrap(), "던전");
        assert!(validate_query("a").is_err());
        assert!(validate_query("   ").is_err());
        assert!(validate_cover_identity(MANGA_ID, COVER_FILE).is_ok());
        assert!(validate_cover_identity("not-a-uuid", COVER_FILE).is_err());
        assert!(validate_cover_identity(MANGA_ID, "../cover.jpg").is_err());

        let search = search_url("던전 밥").unwrap();
        assert_eq!(search.scheme(), "https");
        assert_eq!(search.host_str(), Some("api.mangadex.org"));
        assert!(search
            .query_pairs()
            .any(|(key, value)| key == "title" && value == "던전 밥"));
        assert!(search
            .query_pairs()
            .any(|(key, value)| key == "limit" && value == "20"));
        let cover = cover_url(MANGA_ID, COVER_FILE, true).unwrap();
        assert_eq!(
            cover.as_str(),
            "https://uploads.mangadex.org/covers/d1a9fdeb-f713-407f-960c-8326b586e6fd/a1b2c3d4-e5f6-47a8-9000-111122223333.jpg.256.jpg"
        );
        assert!(matches!(
            map_status_code(429),
            LibraryError::MangaDexRateLimited
        ));
        assert!(matches!(
            map_status_code(404),
            LibraryError::MangaDexNotFound
        ));
        assert!(matches!(
            map_status_code(500),
            LibraryError::MangaDexUnavailable
        ));
    }

    #[test]
    fn rejects_a_provider_error_envelope_even_when_data_is_present() {
        assert!(matches!(
            parse_search(r#"{"result":"error","data":[]}"#),
            Err(LibraryError::InvalidMangaDexResponse)
        ));
    }
}
