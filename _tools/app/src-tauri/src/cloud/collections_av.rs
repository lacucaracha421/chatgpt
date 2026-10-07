//! AV's mobile projection contains text and cover crops. Performer records (memo,
//! favourite, StashDB profile text, portrait attribution) cross only under the `people`
//! replica feature; the chosen StashDB/Commons portrait bytes only under `portraitImage`,
//! uploaded as an artwork blob. StashDB image URLs and match candidates never cross.
use super::{blob_for, ArtworkBlob, ReplicaCollection};
use crate::library::{error::LibraryError, models::CollectionType};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

/// Server bound on the replica's top-level `people`.
pub(super) const MAX_PEOPLE: usize = 2000;
/// Server bound on an uploaded performer portrait (`portraitImage`).
pub(super) const MAX_PORTRAIT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AvInfo {
    product_code: Option<String>,
    title_ja: Option<String>,
    maker: Option<String>,
    label: Option<String>,
    series: Option<String>,
    genres: Vec<String>,
    release_date: Option<String>,
    people: Vec<AvPerson>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AvPerson {
    id: String,
    name: String,
    name_ja: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credit_name: Option<String>,
    role: String,
    order: i64,
    portrait_crop: Option<AvPortraitCrop>,
    /// Feature `portraitImage`; omitted otherwise, so older bodies stay byte-identical.
    #[serde(skip_serializing_if = "Option::is_none")]
    portrait_image: Option<AvPortraitImage>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct AvPortraitImage {
    sha256: String,
    size_bytes: u64,
    content_type: String,
    width: u32,
    height: u32,
}

/// Portrait descriptors of one snapshot by person id, each person's bytes hashed once.
/// `None` = no publishable image (crop, missing, oversized or not jpeg/png/webp).
pub(super) type PortraitImages = BTreeMap<String, Option<(AvPortraitImage, ArtworkBlob)>>;

/// The stored StashDB/Commons portrait bytes of `person`, when they are within `limit`.
/// The length is checked before the BLOB is read, so an oversized image is never loaded.
pub(super) fn portrait_bytes(
    db: &Connection,
    person: &str,
    limit: u64,
) -> Result<Option<(Vec<u8>, i64, i64)>, LibraryError> {
    const IMAGE: &str =
        "person_id=?1 AND kind IN ('stashdb','commons') AND image_bytes IS NOT NULL";
    let length: Option<i64> = db
        .query_row(
            &format!("SELECT length(image_bytes) FROM collection_person_portraits WHERE {IMAGE}"),
            [person],
            |r| r.get(0),
        )
        .optional()?;
    if !length.is_some_and(|length| length > 0 && length as u64 <= limit) {
        return Ok(None);
    }
    Ok(db
        .query_row(
            &format!(
                "SELECT image_bytes, width, height FROM collection_person_portraits WHERE {IMAGE}"
            ),
            [person],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .filter(|(bytes, _, _): &(Vec<u8>, i64, i64)| bytes.len() as u64 <= limit))
}

/// Upload-time re-read through a fresh read-only connection; the caller re-checks the hash.
pub(super) fn read_portrait_bytes(
    database: &Path,
    person: &str,
    limit: u64,
) -> Result<Option<Vec<u8>>, LibraryError> {
    let db = Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(portrait_bytes(&db, person, limit)?.map(|(bytes, _, _)| bytes))
}

fn portrait_image(
    db: &Connection,
    person: &str,
) -> Result<Option<(AvPortraitImage, ArtworkBlob)>, LibraryError> {
    let Some((bytes, width, height)) = portrait_bytes(db, person, MAX_PORTRAIT_BYTES)? else {
        return Ok(None);
    };
    // Sniffed, never re-encoded: the published hash is the stored bytes' hash.
    let Some(blob) = blob_for(&bytes)
        .ok()
        .filter(|blob| blob.content_type != "image/gif")
    else {
        return Ok(None);
    };
    let (Ok(width), Ok(height)) = (u32::try_from(width), u32::try_from(height)) else {
        return Ok(None);
    };
    if width == 0 || height == 0 {
        return Ok(None);
    }
    let image = AvPortraitImage {
        sha256: blob.sha256.clone(),
        size_bytes: blob.size_bytes,
        content_type: blob.content_type.clone(),
        width,
        height,
    };
    Ok(Some((image, blob)))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AvPortraitCrop {
    artwork_id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

pub(super) fn published_covers(collections: &[ReplicaCollection]) -> BTreeSet<String> {
    collections
        .iter()
        .filter(|c| c.summary.collection_type == CollectionType::Av)
        .flat_map(|c| &c.artworks)
        .filter(|a| {
            a.kind == "cover" && a.selected && (a.original.is_some() || a.thumbnail.is_some())
        })
        .map(|a| a.id.clone())
        .collect()
}

/// `portraits` is `Some` only with the `portraitImage` feature.
pub(super) fn committed_av(
    db: &Connection,
    id: &str,
    covers: &BTreeSet<String>,
    mut portraits: Option<&mut PortraitImages>,
    credit_names: bool,
) -> Result<AvInfo, LibraryError> {
    let row = db
        .query_row(
            "SELECT product_code, title_ja, maker, label, series, genres_json, release_date
             FROM collection_av_details WHERE collection_id=?1",
            [id],
            |r| {
                Ok((
                    AvInfo {
                        product_code: r.get(0)?,
                        title_ja: r.get(1)?,
                        maker: r.get(2)?,
                        label: r.get(3)?,
                        series: r.get(4)?,
                        release_date: r.get(6)?,
                        ..AvInfo::default()
                    },
                    r.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()?;
    let (mut info, genres) = row.unwrap_or_default();
    if let Some(genres) = genres {
        info.genres =
            serde_json::from_str(&genres).map_err(|_| LibraryError::InvalidCloudResponse)?;
    }
    // Select only crop coordinates. Commons BLOBs, URLs and attribution never enter
    // this projection, including when the same person appears in multiple works.
    let mut statement = db.prepare(
        "SELECT p.id, p.display_name, p.name_ja, r.role, r.sort_order,
                 crop.artwork_id, crop.x, crop.y, crop.w, crop.h, r.credit_name
         FROM collection_person_relations r JOIN collection_people p ON p.id=r.person_id
         LEFT JOIN collection_person_portraits crop ON crop.person_id=p.id AND crop.kind='crop'
         WHERE r.collection_id=?1 ORDER BY r.sort_order, r.role, p.id LIMIT 65",
    )?;
    info.people = statement
        .query_map([id], |r| {
            let artwork_id: Option<String> = r.get(5)?;
            let portrait_crop = match artwork_id.filter(|id| covers.contains(id)) {
                Some(artwork_id) => Some(AvPortraitCrop {
                    artwork_id,
                    x: r.get(6)?,
                    y: r.get(7)?,
                    w: r.get(8)?,
                    h: r.get(9)?,
                }),
                None => None,
            };
            Ok(AvPerson {
                id: r.get(0)?,
                name: r.get(1)?,
                name_ja: r.get(2)?,
                credit_name: if credit_names { r.get(10)? } else { None },
                role: r.get(3)?,
                order: r.get(4)?,
                portrait_crop,
                portrait_image: None,
            })
        })?
        .collect::<Result<_, _>>()?;
    if info.people.len() > 64 || info.genres.len() > 64 {
        return Err(LibraryError::InvalidCloudResponse);
    }
    if let Some(portraits) = portraits.as_deref_mut() {
        for person in &mut info.people {
            if !portraits.contains_key(&person.id) {
                portraits.insert(person.id.clone(), portrait_image(db, &person.id)?);
            }
            person.portrait_image = portraits[&person.id]
                .as_ref()
                .map(|(image, _)| image.clone());
        }
    }
    Ok(info)
}

/// `Person` of the replica's top-level `people` (feature `people`).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct PublishedPerson {
    id: String,
    memo: Option<String>,
    favorite: bool,
    profile: Option<PersonProfile>,
    portrait: Option<PersonPortrait>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PersonProfile {
    source: String,
    name: Option<String>,
    aliases: Vec<String>,
    birth_date: Option<String>,
    height_cm: Option<i64>,
    band_in: Option<i64>,
    waist_in: Option<i64>,
    hip_in: Option<i64>,
    cup: Option<String>,
    breast_type: Option<String>,
    career_start: Option<i64>,
    career_end: Option<i64>,
    urls: Vec<PersonUrl>,
}

#[derive(Debug, Serialize, PartialEq)]
struct PersonUrl {
    site: String,
    url: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PersonPortrait {
    source: &'static str,
    author: Option<String>,
    license: Option<String>,
    license_url: Option<String>,
    source_url: Option<String>,
}

/// Every person related to a published AV work, at most [`MAX_PEOPLE`]: favourites first,
/// then people with a memo, profile or portrait, then by id. A matched profile only;
/// `images_json`, `candidates_json` and portrait bytes are never selected.
pub(super) fn committed_people(
    db: &Connection,
    collections: &[ReplicaCollection],
) -> Result<Vec<PublishedPerson>, LibraryError> {
    let ids: BTreeSet<&str> = collections
        .iter()
        .filter_map(|c| c.av.as_ref())
        .flat_map(|av| &av.people)
        .map(|person| person.id.as_str())
        .collect();
    let mut statement = db.prepare(
        "SELECT p.memo, EXISTS(SELECT 1 FROM av_favorite_performers f WHERE f.person_id=p.id),
                prof.source, prof.name, prof.aliases_json, prof.birth_date, prof.height_cm,
                prof.band_in, prof.waist_in, prof.hip_in, prof.cup, prof.breast_type,
                prof.career_start, prof.career_end, prof.urls_json,
                portrait.kind, portrait.author, portrait.license, portrait.license_url, portrait.source_url
         FROM collection_people p
         LEFT JOIN collection_person_profiles prof ON prof.person_id=p.id AND prof.status='matched'
         LEFT JOIN collection_person_portraits portrait ON portrait.person_id=p.id
         WHERE p.id=?1",
    )?;
    let mut people = Vec::with_capacity(ids.len());
    for id in ids {
        let person = statement
            .query_row([id], |r| {
                let profile = match r.get::<_, Option<String>>(2)? {
                    Some(source) => Some(PersonProfile {
                        source,
                        name: r.get(3)?,
                        aliases: aliases(r.get::<_, Option<String>>(4)?.as_deref()),
                        birth_date: r.get(5)?,
                        height_cm: r.get(6)?,
                        band_in: r.get(7)?,
                        waist_in: r.get(8)?,
                        hip_in: r.get(9)?,
                        cup: r.get(10)?,
                        breast_type: r.get(11)?,
                        career_start: r.get(12)?,
                        career_end: r.get(13)?,
                        urls: urls(r.get::<_, Option<String>>(14)?.as_deref()),
                    }),
                    None => None,
                };
                let source = match r.get::<_, Option<String>>(15)?.as_deref() {
                    Some("crop") => Some("cover"),
                    Some("commons") => Some("commons"),
                    Some("stashdb") => Some("stashdb"),
                    _ => None,
                };
                let portrait = match source {
                    Some(source) => Some(PersonPortrait {
                        source,
                        author: r.get(16)?,
                        license: r.get(17)?,
                        license_url: r.get(18)?,
                        source_url: r.get(19)?,
                    }),
                    None => None,
                };
                Ok(PublishedPerson {
                    id: id.to_owned(),
                    memo: r.get(0)?,
                    favorite: r.get(1)?,
                    profile,
                    portrait,
                })
            })
            .optional()?;
        people.extend(person);
    }
    // Stable sort keeps id order within each group.
    people.sort_by_key(|p| {
        (
            !p.favorite,
            p.memo.is_none() && p.profile.is_none() && p.portrait.is_none(),
        )
    });
    people.truncate(MAX_PEOPLE);
    Ok(people)
}

/// StashDB aliases as stored (`["name", ...]`); anything else is dropped.
fn aliases(raw: Option<&str>) -> Vec<String> {
    raw.and_then(|raw| serde_json::from_str::<Vec<serde_json::Value>>(raw).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect()
}

/// StashDB links as stored (`[{"url", "site": {"name"}}]`), flattened to `{site, url}`.
fn urls(raw: Option<&str>) -> Vec<PersonUrl> {
    raw.and_then(|raw| serde_json::from_str::<Vec<serde_json::Value>>(raw).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| {
            Some(PersonUrl {
                site: value.get("site")?.get("name")?.as_str()?.to_owned(),
                url: value.get("url")?.as_str()?.to_owned(),
            })
        })
        .collect()
}
