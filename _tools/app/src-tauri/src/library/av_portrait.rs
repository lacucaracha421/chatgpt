use super::{
    av_artwork::cover_set,
    av_detail::{solo_work, RELEASE},
    av_link::provider::HttpClient,
    av_models::*,
    Library,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::Cursor,
    path::PathBuf,
    sync::{Arc, Mutex},
};

const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_JSON_BYTES: usize = 1024 * 1024;
#[derive(Clone)]
struct CommonsImage {
    preview: AvCommonsPreview,
    bytes: Vec<u8>,
    mime: String,
    width: u32,
    height: u32,
}
enum PendingImage {
    Commons(CommonsImage),
    Stashdb(StashdbImage),
}
struct StashdbImage {
    preview: AvStashdbPreview,
    bytes: Vec<u8>,
    image_id: String,
}
struct Pending {
    generation: uuid::Uuid,
    image: Option<PendingImage>,
}
/// Library-qualified keys prevent a preview from being used after switching libraries.
#[derive(Clone, Default)]
pub(crate) struct AvPortraitState(Arc<Mutex<HashMap<(PathBuf, String), Pending>>>);
impl AvPortraitState {
    pub(crate) fn discard(&self, library: &Library, person: &str) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&(library.root().to_path_buf(), person.into()));
    }
}
pub(super) fn require_person(c: &Connection, id: &str) -> Result<(), AvError> {
    if c.query_row(
        "SELECT EXISTS(SELECT 1 FROM collection_people WHERE id=?1)",
        [id],
        |r| r.get::<_, bool>(0),
    )? {
        Ok(())
    } else {
        Err(AvError::Invalid)
    }
}
fn data_url(mime: &str, bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = format!("data:{mime};base64,");
    output.reserve(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let bits = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        output.push(ALPHABET[((bits >> 18) & 63) as usize] as char);
        output.push(ALPHABET[((bits >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[((bits >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(bits & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}
pub(super) fn portrait(c: &Connection, person: &str) -> Result<Option<AvPortrait>, AvError> {
    let kind: Option<String> = c
        .query_row(
            "SELECT kind FROM collection_person_portraits WHERE person_id=?1",
            [person],
            |r| r.get(0),
        )
        .optional()?;
    match kind.as_deref() {
        Some("crop") => {
            let crop=c.query_row("SELECT a.id,a.collection_id,p.x,p.y,p.w,p.h FROM collection_person_portraits p JOIN collection_work_artworks a ON a.id=p.artwork_id AND a.selected=1 AND a.kind='cover' JOIN collections c ON c.id=a.collection_id AND c.type='av' WHERE p.person_id=?1",[person],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,AvPortraitRect{x:r.get(2)?,y:r.get(3)?,w:r.get(4)?,h:r.get(5)?}))).optional()?;
            crop.map(|(artwork_id,collection,rect)| Ok(AvPortrait::Crop{artwork_id,revision:cover_set(c,&collection)?.revision,rect})).transpose()
        }
        Some("stashdb") => Ok(Some(AvPortrait::Stashdb { preview: c.query_row(
            "SELECT image_bytes,width,height,source_url FROM collection_person_portraits WHERE person_id=?1", [person],
            |r| Ok(AvStashdbPreview { data_url: data_url("image/jpeg", &r.get::<_, Vec<u8>>(0)?), width: r.get(1)?, height: r.get(2)?, source_url: r.get(3)? })
        )? })),
        Some("commons") => Ok(Some(AvPortrait::Commons {preview:c.query_row("SELECT image_bytes,mime,file_name,author,license,license_url,source_url FROM collection_person_portraits WHERE person_id=?1",[person],|r|Ok(AvCommonsPreview{data_url:data_url(&r.get::<_,String>(1)?,&r.get::<_,Vec<u8>>(0)?),file_name:r.get(2)?,author:r.get(3)?,license:r.get(4)?,license_url:r.get(5)?,source_url:r.get(6)?}))?})),
        _ => Ok(None),
    }
}
impl Library {
    pub fn list_av_portrait_sources(&self, person: &str) -> Result<Vec<AvPortraitSource>, AvError> {
        let c = self.connection()?;
        require_person(&c, person)?;
        let mut items=c.prepare(&format!("SELECT c.id,c.name,d.product_code,a.id,a.width,a.height FROM collections c JOIN collection_work_artworks a ON a.collection_id=c.id AND a.kind='cover' AND a.selected=1 LEFT JOIN collection_av_details d ON d.collection_id=c.id WHERE c.type='av' AND EXISTS(SELECT 1 FROM collection_person_relations r WHERE r.collection_id=c.id AND r.person_id=?1 AND r.role='performer') ORDER BY {RELEASE} IS NULL,{RELEASE} DESC,c.id"))?.query_map([person],|r|Ok(AvPortraitSource{collection_id:r.get(0)?,name:r.get(1)?,product_code:r.get(2)?,artwork_id:r.get(3)?,width:r.get(4)?,height:r.get(5)?,revision:String::new(),solo:false}))?.collect::<Result<Vec<_>,_>>()?;
        for item in &mut items {
            item.revision = cover_set(&c, &item.collection_id)?.revision;
            item.solo = solo_work(&c, &item.collection_id)?;
        }
        items.sort_by_key(|item| !item.solo);
        Ok(items)
    }
    pub fn set_av_portrait_crop(
        &self,
        person: &str,
        artwork: &str,
        rect: AvPortraitRect,
    ) -> Result<AvPortrait, AvError> {
        if ![rect.x, rect.y, rect.w, rect.h]
            .iter()
            .all(|v| v.is_finite())
            || rect.x < 0.0
            || rect.y < 0.0
            || rect.w <= 0.02
            || rect.h <= 0.02
            || rect.x + rect.w > 1.000001
            || rect.y + rect.h > 1.000001
        {
            return Err(AvError::Invalid);
        }
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        require_person(&tx, person)?;
        let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM collection_work_artworks a JOIN collections c ON c.id=a.collection_id AND c.type='av' WHERE a.id=?1 AND a.kind='cover' AND a.selected=1 AND EXISTS(SELECT 1 FROM collection_person_relations r WHERE r.collection_id=c.id AND r.person_id=?2))",params![artwork,person],|r|r.get(0))?;
        if !valid {
            return Err(AvError::Invalid);
        }
        tx.execute(
            "DELETE FROM collection_person_portraits WHERE person_id=?1",
            [person],
        )?;
        tx.execute("INSERT INTO collection_person_portraits(person_id,kind,artwork_id,x,y,w,h,updated_at) VALUES(?1,'crop',?2,?3,?4,?5,?6,?7)",params![person,artwork,rect.x,rect.y,rect.w,rect.h,chrono::Utc::now().to_rfc3339()])?;
        let result = portrait(&tx, person)?.ok_or(AvError::Invalid)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn clear_av_portrait(&self, person: &str) -> Result<(), AvError> {
        let c = self.connection()?;
        require_person(&c, person)?;
        c.execute(
            "DELETE FROM collection_person_portraits WHERE person_id=?1",
            [person],
        )?;
        Ok(())
    }
    pub(crate) fn preview_av_commons_portrait_with(
        &self,
        person: &str,
        state: &AvPortraitState,
        http: &impl HttpClient,
    ) -> Result<Option<AvCommonsPreview>, AvError> {
        let qid: Option<String> = {
            let c = self.connection()?;
            require_person(&c, person)?;
            c.query_row(
                "SELECT wikidata_id FROM collection_people WHERE id=?1",
                [person],
                |r| r.get(0),
            )?
        };
        let key = (self.root().to_path_buf(), person.to_owned());
        let generation = uuid::Uuid::new_v4();
        state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                key.clone(),
                Pending {
                    generation,
                    image: None,
                },
            );
        // All DB guards and the pending-state mutex have been released before HTTP.
        let result = qid
            .as_deref()
            .map(|qid| fetch_commons(http, qid))
            .transpose()
            .map(Option::flatten);
        let mut pending = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending.get(&key).is_none_or(|p| p.generation != generation) {
            return Err(AvError::Stale);
        }
        match result {
            Ok(Some(image)) => {
                let preview = image.preview.clone();
                pending.get_mut(&key).unwrap().image = Some(PendingImage::Commons(image));
                Ok(Some(preview))
            }
            Ok(None) => {
                pending.remove(&key);
                Ok(None)
            }
            Err(e) => {
                pending.remove(&key);
                Err(e)
            }
        }
    }
    pub(crate) fn use_av_commons_portrait(
        &self,
        person: &str,
        state: &AvPortraitState,
    ) -> Result<AvPortrait, AvError> {
        let mut pending = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        require_person(&tx, person)?;
        let key = (self.root().to_path_buf(), person.to_owned());
        let Some(PendingImage::Commons(image)) = pending.get(&key).and_then(|p| p.image.as_ref())
        else {
            return Err(AvError::Invalid);
        };
        tx.execute(
            "DELETE FROM collection_person_portraits WHERE person_id=?1",
            [person],
        )?;
        tx.execute("INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,author,license,license_url,source_url,updated_at) VALUES(?1,'commons',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![person,image.bytes,image.mime,image.width,image.height,image.preview.file_name,image.preview.author,image.preview.license,image.preview.license_url,image.preview.source_url,chrono::Utc::now().to_rfc3339()])?;
        let result = AvPortrait::Commons {
            preview: image.preview.clone(),
        };
        tx.commit()?;
        pending.remove(&key);
        Ok(result)
    }
}
impl Library {
    pub(crate) fn preview_av_stashdb_portrait_with(
        &self,
        person: &str,
        image_id: &str,
        state: &AvPortraitState,
        http: &impl HttpClient,
    ) -> Result<AvStashdbPreview, AvError> {
        let key = (self.root().to_path_buf(), person.to_owned());
        let generation = uuid::Uuid::new_v4();
        state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                key.clone(),
                Pending {
                    generation,
                    image: None,
                },
            );
        let result = (|| {
            let profile = self
                .get_av_performer_profile(person)?
                .filter(|p| p.status == "matched")
                .ok_or(AvError::Invalid)?;
            let image = profile
                .images
                .into_iter()
                .find(|i| i.id == image_id)
                .ok_or(AvError::Invalid)?;
            let url = url::Url::parse(&image.url).map_err(|_| AvError::Image)?;
            // StashDB serves its uploaded images itself. Do not turn metadata into arbitrary HTTP access.
            if url.scheme() != "https"
                || url.host_str() != Some("stashdb.org")
                || url.port().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(AvError::Image);
            }
            const LIMIT: usize = 15 * 1024 * 1024;
            // No connection or state guard is live during this unauthenticated download.
            let response = http
                .get(url.as_str(), None, LIMIT)
                .map_err(|_| AvError::Image)?;
            if response.status != 200 || response.bytes.is_empty() || response.bytes.len() > LIMIT {
                return Err(AvError::Image);
            }
            let format = image::guess_format(&response.bytes).map_err(|_| AvError::Image)?;
            if !matches!(
                format,
                image::ImageFormat::Jpeg | image::ImageFormat::Png | image::ImageFormat::WebP
            ) {
                return Err(AvError::Image);
            }
            let (w, h) = image::ImageReader::with_format(Cursor::new(&response.bytes), format)
                .into_dimensions()
                .map_err(|_| AvError::Image)?;
            if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 32_000_000 {
                return Err(AvError::Image);
            }
            let decoded = image::load_from_memory_with_format(&response.bytes, format)
                .map_err(|_| AvError::Image)?;
            let resized = if w > 1600 || h > 1600 {
                decoded.resize(1600, 1600, image::imageops::FilterType::Lanczos3)
            } else {
                decoded
            };
            let rgb = resized.to_rgb8();
            let mut bytes = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 88)
                .encode_image(&rgb)
                .map_err(|_| AvError::Image)?;
            let preview = AvStashdbPreview {
                data_url: data_url("image/jpeg", &bytes),
                width: rgb.width(),
                height: rgb.height(),
                source_url: image.url,
            };
            Ok(StashdbImage {
                preview,
                bytes,
                image_id: image_id.into(),
            })
        })();
        let mut pending = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending.get(&key).is_none_or(|p| p.generation != generation) {
            return Err(AvError::Stale);
        }
        match result {
            Ok(image) => {
                let preview = image.preview.clone();
                pending.get_mut(&key).unwrap().image = Some(PendingImage::Stashdb(image));
                Ok(preview)
            }
            Err(error) => {
                pending.remove(&key);
                Err(error)
            }
        }
    }
    pub(crate) fn use_av_stashdb_portrait(
        &self,
        person: &str,
        state: &AvPortraitState,
    ) -> Result<AvPortrait, AvError> {
        let mut pending = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let key = (self.root().to_path_buf(), person.to_owned());
        let Some(PendingImage::Stashdb(image)) = pending.get(&key).and_then(|p| p.image.as_ref())
        else {
            return Err(AvError::Invalid);
        };
        let profile = self
            .get_av_performer_profile(person)?
            .ok_or(AvError::Stale)?;
        if profile.status != "matched"
            || !profile
                .images
                .iter()
                .any(|i| i.id == image.image_id && i.url == image.preview.source_url)
        {
            return Err(AvError::Stale);
        }
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        require_person(&tx, person)?;
        tx.execute(
            "DELETE FROM collection_person_portraits WHERE person_id=?1",
            [person],
        )?;
        tx.execute("INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,source_url,updated_at) VALUES(?1,'stashdb',?2,'image/jpeg',?3,?4,?5,?6,?7)", params![person,image.bytes,image.preview.width,image.preview.height,image.image_id,image.preview.source_url,chrono::Utc::now().to_rfc3339()])?;
        let result = AvPortrait::Stashdb {
            preview: image.preview.clone(),
        };
        tx.commit()?;
        pending.remove(&key);
        Ok(result)
    }
}

fn fetch_json(http: &impl HttpClient, url: &str) -> Result<Value, AvError> {
    let response = http.get(url, None, MAX_JSON_BYTES)?;
    if response.status != 200 || response.bytes.len() > MAX_JSON_BYTES {
        return Err(AvError::Invalid);
    }
    serde_json::from_slice(&response.bytes).map_err(|_| AvError::Invalid)
}
fn metadata(info: &Value, name: &str) -> Option<String> {
    info.get("extmetadata")?
        .get(name)?
        .get("value")?
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}
fn strip_html(value: &str) -> String {
    let mut tag = false;
    let mut plain = String::new();
    for ch in value.chars() {
        match ch {
            '<' => tag = true,
            '>' => tag = false,
            _ if !tag => plain.push(ch),
            _ => {}
        }
    }
    plain
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .trim()
        .to_owned()
}
fn fetch_commons(http: &impl HttpClient, qid: &str) -> Result<Option<CommonsImage>, AvError> {
    if qid.len() < 2 || !qid.starts_with('Q') || !qid[1..].bytes().all(|c| c.is_ascii_digit()) {
        return Err(AvError::Invalid);
    }
    let entity = fetch_json(
        http,
        &format!("https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"),
    )?;
    let Some(file) = entity
        .pointer(&format!(
            "/entities/{qid}/claims/P18/0/mainsnak/datavalue/value"
        ))
        .and_then(Value::as_str)
    else {
        return Ok(None);
    };
    if file.trim().is_empty() || file.len() > 1024 {
        return Err(AvError::Invalid);
    }
    let mut url = url::Url::parse("https://commons.wikimedia.org/w/api.php").unwrap();
    url.query_pairs_mut()
        .append_pair("action", "query")
        .append_pair("titles", &format!("File:{file}"))
        .append_pair("prop", "imageinfo")
        .append_pair("iiprop", "url|extmetadata|mime|size")
        .append_pair("iiurlwidth", "640")
        .append_pair("format", "json");
    let json = fetch_json(http, url.as_str())?;
    let info = json
        .pointer("/query/pages")
        .and_then(Value::as_object)
        .and_then(|pages| pages.values().find_map(|page| page.pointer("/imageinfo/0")))
        .ok_or(AvError::Invalid)?;
    let thumb = info
        .get("thumburl")
        .and_then(Value::as_str)
        .ok_or(AvError::Invalid)?;
    let thumb = url::Url::parse(thumb).map_err(|_| AvError::Invalid)?;
    if thumb.scheme() != "https"
        || thumb.host_str() != Some("upload.wikimedia.org")
        || thumb.port().is_some()
        || !thumb.username().is_empty()
        || thumb.password().is_some()
    {
        return Err(AvError::Invalid);
    }
    let source_url = info
        .get("descriptionurl")
        .and_then(Value::as_str)
        .ok_or(AvError::Invalid)?
        .to_owned();
    let response = http.get(thumb.as_str(), None, MAX_IMAGE_BYTES)?;
    if response.status != 200 || response.bytes.is_empty() || response.bytes.len() > MAX_IMAGE_BYTES
    {
        return Err(AvError::Image);
    }
    let format = image::guess_format(&response.bytes).map_err(|_| AvError::Image)?;
    if !matches!(
        format,
        image::ImageFormat::Jpeg | image::ImageFormat::Png | image::ImageFormat::WebP
    ) {
        return Err(AvError::Image);
    }
    let (width, height) = image::ImageReader::with_format(Cursor::new(&response.bytes), format)
        .into_dimensions()
        .map_err(|_| AvError::Image)?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16_000_000 {
        return Err(AvError::Image);
    }
    image::load_from_memory_with_format(&response.bytes, format).map_err(|_| AvError::Image)?;
    let mime = format.to_mime_type().to_owned();
    let preview = AvCommonsPreview {
        data_url: data_url(&mime, &response.bytes),
        file_name: file.into(),
        author: metadata(info, "Artist")
            .map(|a| strip_html(&a))
            .filter(|a| !a.is_empty()),
        license: metadata(info, "LicenseShortName"),
        license_url: metadata(info, "LicenseUrl"),
        source_url,
    };
    Ok(Some(CommonsImage {
        preview,
        bytes: response.bytes,
        mime,
        width,
        height,
    }))
}
#[cfg(test)]
#[path = "av_portrait_tests.rs"]
mod tests;
