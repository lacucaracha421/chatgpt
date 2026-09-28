//! AV's mobile projection contains text and cover crops only, never downloaded portraits or StashDB profiles.
use super::ReplicaCollection;
use crate::library::{error::LibraryError, models::CollectionType};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::collections::BTreeSet;

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
    role: String,
    order: i64,
    portrait_crop: Option<AvPortraitCrop>,
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

pub(super) fn committed_av(
    db: &Connection,
    id: &str,
    covers: &BTreeSet<String>,
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
                crop.artwork_id, crop.x, crop.y, crop.w, crop.h
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
                role: r.get(3)?,
                order: r.get(4)?,
                portrait_crop,
            })
        })?
        .collect::<Result<_, _>>()?;
    if info.people.len() > 64 || info.genres.len() > 64 {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(info)
}
