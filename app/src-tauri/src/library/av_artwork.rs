use std::{fs::File, io::{Cursor, Read}, path::Path};
use image::ImageFormat;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use super::{av_collection::require_av, av_models::*, work_artwork::{PreparedWorkArtwork, MAX_WORK_ARTWORK_BYTES}, Library};

const MAX_AV_ARTWORK_PIXELS: u64 = 16_000_000;
const PREVIEW_BOUND: u32 = 360;
fn read_image(path: &str) -> Result<(Vec<u8>, ImageFormat, u32, u32), AvError> {
    let file = File::open(Path::new(path)).map_err(|_| AvError::Image)?;
    if !file.metadata().map_err(|_|AvError::Image)?.is_file() { return Err(AvError::Image); }
    let mut bytes = Vec::new();
    file.take(MAX_WORK_ARTWORK_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_|AvError::Image)?;
    if bytes.is_empty() || bytes.len() > MAX_WORK_ARTWORK_BYTES { return Err(AvError::Image); }
    let format = image::guess_format(&bytes).map_err(|_|AvError::Image)?;
    if !matches!(format,ImageFormat::Jpeg|ImageFormat::Png|ImageFormat::WebP) { return Err(AvError::Image); }
    let (width,height) = image::ImageReader::with_format(Cursor::new(&bytes),format).into_dimensions().map_err(|_|AvError::Image)?;
    if width == 0 || height == 0 || u64::from(width)*u64::from(height)>MAX_AV_ARTWORK_PIXELS { return Err(AvError::Image); }
    Ok((bytes,format,width,height))
}
fn digest(bytes: &[u8]) -> String { Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect() }
fn cover_set(connection: &Connection,id: &str) -> Result<AvCoverSet, AvError> {
    require_av(connection,id)?;
    let updated: String = connection.query_row("SELECT updated_at FROM collections WHERE id=?1",[id],|r|r.get(0))?;
    let mut set = AvCoverSet { front_id:None,spine_id:None,back_id:None,revision:String::new() };
    let mut statement = connection.prepare("SELECT id,kind FROM collection_work_artworks WHERE collection_id=?1 AND selected=1 AND kind IN ('cover','spine','back')")?;
    for row in statement.query_map([id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))? {
        let (id,kind) = row?;
        match kind.as_str() { "cover"=>set.front_id=Some(id),"spine"=>set.spine_id=Some(id),"back"=>set.back_id=Some(id),_=>{} }
    }
    set.revision = digest(serde_json::to_string(&(&set.front_id,&set.spine_id,&set.back_id,updated)).map_err(|_|AvError::Invalid)?.as_bytes());
    Ok(set)
}
impl Library {
    pub fn preview_av_artwork(&self,path: &str,surface: CoverSurface) -> Result<LocalArtworkPreview, AvError> {
        let (bytes,format,width,height) = read_image(path)?;
        let decoded = image::load_from_memory_with_format(&bytes,format).map_err(|_|AvError::Image)?;
        let mut thumbnail = Cursor::new(Vec::new());
        decoded.thumbnail(PREVIEW_BOUND,PREVIEW_BOUND).write_to(&mut thumbnail,ImageFormat::Png).map_err(|_|AvError::Image)?;
        Ok(LocalArtworkPreview { path:path.into(),surface,sha256:digest(&bytes),width,height,mime_type:format.to_mime_type().into(),thumbnail_bytes:thumbnail.into_inner() })
    }
    pub fn get_av_cover_set(&self,id: &str) -> Result<AvCoverSet,AvError> { cover_set(&*self.connection()?,id) }
    pub fn apply_av_artwork(&self,id: &str,input: ApplyAvArtwork) -> Result<AvCoverSet,AvError> {
        if self.get_av_cover_set(id)?.revision != input.expected_revision { return Err(AvError::Stale); }
        let decisions = [(CoverSurface::Front,input.front),(CoverSurface::Spine,input.spine),(CoverSurface::Back,input.back)];
        let mut prepared: Vec<Option<PreparedWorkArtwork>> = Vec::new();
        for (_,decision) in &decisions {
            let artwork = if let ArtworkDecision::Local {path,sha256} = decision {
                let (bytes,_,_,_) = read_image(path)?;
                if digest(&bytes) != *sha256 { return Err(AvError::Image); }
                Some(self.prepare_work_artwork(id,&bytes)?)
            } else { None };
            prepared.push(artwork);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        if cover_set(&transaction,id)?.revision != input.expected_revision { return Err(AvError::Stale); }
        let mut committed = [false;3];
        for (index,(surface,decision)) in decisions.iter().enumerate() {
            match decision {
                ArtworkDecision::Keep => {},
                ArtworkDecision::Clear => Self::clear_work_artwork_kind_in_transaction(&transaction,id,surface.kind())?,
                ArtworkDecision::Local {sha256,..} => {
                    let key = format!("{}/{sha256}",surface.kind().as_str());
                    let existing: Option<String> = transaction.query_row("SELECT id FROM collection_work_artworks WHERE collection_id=?1 AND provider='local-manual' AND provider_image_id=?2 AND kind=?3",params![id,key,surface.kind().as_str()],|r|r.get(0)).optional()?;
                    if let Some(existing) = existing {
                        Self::select_work_artwork_kind_in_transaction(&transaction,id,&existing,surface.kind())?;
                    } else {
                        Self::insert_work_artwork_in_transaction(&transaction,id,"local-manual",&key,surface.kind(),None,prepared[index].as_ref().ok_or(AvError::Image)?)?;
                        committed[index] = true;
                    }
                },
            }
        }
        transaction.execute("UPDATE collections SET updated_at=?1 WHERE id=?2",params![chrono::Utc::now().to_rfc3339(),id])?;
        let result = cover_set(&transaction,id)?;
        transaction.commit()?;
        for (index,item) in prepared.into_iter().enumerate() { if let Some(item) = item { if committed[index] { item.commit(); } } }
        Ok(result)
    }
}
#[cfg(test)]
#[path = "av_artwork_tests.rs"]
mod tests;
