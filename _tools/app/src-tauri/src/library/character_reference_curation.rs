//! Bounded semantic curation of explicitly confirmed images.
use super::{Library, character_sources::Source, character_worker::RuntimeConfig,
    character_reference_candidates::{ReferenceCandidateSet, reference_set_hash},
    character_reference_regions::RegionBinding, characters::{Error, Result}};
use rusqlite::{Connection, params};
use serde_json::json;
use std::sync::{Arc, atomic::AtomicBool};

fn fingerprint(c: &Connection, id: &str) -> Result<Option<[u8; 32]>> {
    let (bytes,quality): (Option<Vec<u8>>, Option<i64>) = c.query_row(
        "SELECT perceptual_hash,perceptual_hash_quality FROM assets WHERE id=?1", [id], |r|Ok((r.get(0)?,r.get(1)?)))?;
    Ok(bytes.filter(|v| matches!(v.len(),32|64) && quality.unwrap_or(0)>=50)
        .and_then(|v| v[..32].try_into().ok()))
}

impl Library {
    pub fn semantic_reference_candidates(&self, target_id: &str, limit: usize, config: &RuntimeConfig) -> Result<ReferenceCandidateSet> {
        let mut page = self.reference_candidates_pool(target_id,limit,true)?;
        let target = self.get_character_target(target_id)?;
        if target.revision!=page.target_revision {return Err(Error::Stale);}
        let series = target.series_classification_id.as_deref().ok_or(Error::Stale)?;
        let capacity = limit.min(25usize.saturating_sub(target.references.len()+target.learned_references.len()));
        if capacity==0 {page.items.clear();page.suggested_asset_ids.clear();page.method="ccip_core".into();return Ok(page);}
        let mut inputs = Vec::new();
        let mut anchor_inputs = Vec::new();
        let mut seen = Vec::<[u8;32]>::new();
        {
            let c = self.connection()?;
            for reference in target.usable_references() {
                let id=reference.asset_id.as_ref().ok_or(Error::Stale)?;
                let (hash,path)=super::characters::scoped_image(&c,series,id)?;
                if hash!=reference.asset_hash {return Err(Error::Stale);}
                anchor_inputs.push((id.clone(),hash,path,reference.region.clone()));
                if let Some(fp)=fingerprint(&c,id)? {seen.push(fp);}
            }
            for id in &page.suggested_asset_ids {
                if let Some(fp)=fingerprint(&c,id)? {
                    // Conservative duplicate suppression belongs only to suggestions.
                    if seen.iter().any(|other| super::image_fingerprint::hamming_distance(&fp,other)<=16) {continue;}
                    seen.push(fp);
                }
                let (hash,path)=super::characters::scoped_image(&c,series,id)?;
                inputs.push((id.clone(),hash,path,None::<RegionBinding>));
            }
        }
        let sources=inputs.iter().chain(&anchor_inputs).map(|(_,hash,path,_)| Source::capture(self,path,hash)).collect::<Result<Vec<_>>>()?;
        let wire=inputs.iter().chain(&anchor_inputs).zip(&sources).map(|((id,hash,_,region),source)|
            json!({"assetId":id,"hash":hash,"path":source.path(),"region":region})).collect::<Vec<_>>();
        let result=self.character_worker_pool.with(config,&self.root.join(".cache/characters"),Arc::new(AtomicBool::new(false)),true,|worker,_| {
            worker.send(&json!({"type":"curate_references","candidates":&wire[..inputs.len()],"anchors":&wire[inputs.len()..],"limit":capacity}))?;
            worker.receive()
        })?;
        if result["type"]!="references_curated" {return Err(Error::Worker(result["error"].as_str().unwrap_or("레퍼런스 추천 분석에 실패했습니다.").into()));}
        let selected=result["selected"].as_array().ok_or(Error::Stale)?;
        if selected.len()>capacity {return Err(Error::Stale);}
        let mut ids=Vec::new();
        let mut regions=super::character_reference_regions::RegionBindings::new();
        for row in selected {
            let id=row["assetId"].as_str().ok_or(Error::Stale)?;
            let (_,hash,_,_)=inputs.iter().find(|(candidate,_,_,_)|candidate==id).ok_or(Error::Stale)?;
            let region:RegionBinding=serde_json::from_value(row["region"].clone())?;
            if &region.content_hash!=hash || region.baseline_fingerprint!=super::character_worker::BASELINE
                || regions.contains_key(id) {return Err(Error::Stale);}
            ids.push(id.to_owned());regions.insert(id.to_owned(),region);
        }
        for source in &sources {source.verify(self)?;}
        let c=self.connection()?;
        let current=self.read_character_target(&c,target_id)?;
        if current.revision!=page.target_revision || reference_set_hash(&current)?!=page.reference_set_hash {return Err(Error::Stale);}
        for id in &ids {
            super::character_hub::validate_character_selection(&c,series,Some(target_id),id)?;
            let manual:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM character_relations r JOIN character_decisions d ON d.sequence=r.sequence WHERE r.target_id=?1 AND r.asset_id=?2 AND d.origin='manual' AND d.decision='accepted')",params![target_id,id],|r|r.get(0))?;
            if !manual || super::characters::scoped_image(&c,series,id)?.0!=regions[id].content_hash {return Err(Error::Stale);}
        }
        page.items=super::query::asset_summaries_by_ids(&c,&ids)?;
        page.suggested_asset_ids=ids;page.regions=regions;page.method="ccip_core".into();
        Ok(page)
    }
}
