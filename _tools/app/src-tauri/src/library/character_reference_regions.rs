//! Explicit reference regions and bounded, source-validated inspection.
use super::{character_sources::Source, character_worker::{RuntimeConfig, BASELINE},
    characters::{Error, Result, Target}, Library};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, sync::{Arc, atomic::AtomicBool}};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegionBinding {
    pub content_hash: String,
    pub baseline_fingerprint: String,
    pub bounds: [u32; 4],
}
pub type RegionBindings = BTreeMap<String, RegionBinding>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceInspection {
    pub asset_id: String,
    pub content_hash: String,
    pub baseline_fingerprint: String,
    pub width: u32,
    pub height: u32,
    pub boxes: Vec<[u32; 4]>,
    /// An explicit stored choice, or the single unambiguous detection.
    pub selected_index: Option<usize>,
    pub suggested_index: Option<usize>,
    pub state: String,
    /// The common person the worker inferred on its own. Workers predating common-reference
    /// identity selection omit this key and mean `None`.
    #[serde(default)]
    pub automatic_index: Option<usize>,
}

/// Every region state the worker may report. `single`, `selected`, and `automatic` supply a
/// usable reference; `needs_region`, `no_region`, and `stale_region` describe an image the
/// detector could not resolve. Which of these counts as usable is a presentation decision
/// owned by the caller, so this validator only rejects states outside the protocol.
const INSPECTION_STATES: [&str; 6] = ["single","selected","automatic","needs_region","no_region","stale_region"];

/// Inspection is read-only and accepts one to twenty-five distinct images.
pub fn validate_inspection_ids(ids: &[String]) -> Result<()> {
    if ids.is_empty() || ids.len() > 25 || ids.iter().collect::<BTreeSet<_>>().len()!=ids.len() {
        return Err(Error::Invalid("인물 확인은 1~25장을 선택해 주세요."));
    }
    Ok(())
}

/// Draft regions may only describe images the caller is actually editing.
pub fn validate_region_ids(allowed: &[String], regions: &RegionBindings) -> Result<()> {
    if regions.len() > 25 || regions.keys().any(|id| !allowed.contains(id)) {
        return Err(Error::Invalid("선택한 레퍼런스의 인물 영역만 저장할 수 있습니다."));
    }
    Ok(())
}

/// Draft overrides replace the stored choice for exactly the requested images; an image
/// outside the request is rejected rather than silently ignored. Nothing is written back.
fn merged_regions(requested: &[String], stored: RegionBindings, overrides: Option<&RegionBindings>) -> Result<RegionBindings> {
    let Some(overrides) = overrides else { return Ok(stored); };
    if overrides.keys().any(|id| !requested.contains(id)) {
        return Err(Error::Invalid("요청한 레퍼런스의 인물 영역만 확인할 수 있습니다."));
    }
    let mut merged = stored;
    for (id, region) in overrides {
        merged.insert(id.clone(), region.clone());
    }
    Ok(merged)
}

pub(super) fn read_regions(connection: &Connection, target: &str) -> Result<RegionBindings> {
    let mut statement = connection.prepare("SELECT asset_id,asset_hash,baseline_fingerprint,bounds_json FROM character_reference_regions WHERE target_id=?1")?;
    let rows = statement.query_map([target], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?;
    let mut result = BTreeMap::new();
    for row in rows {
        let (id, content_hash, baseline_fingerprint, bounds) = row?;
        result.insert(id, RegionBinding {content_hash, baseline_fingerprint, bounds:serde_json::from_str(&bounds)?});
    }
    Ok(result)
}

/// A binding must describe the current content of an in-scope image and stay inside the
/// decoded frame. Returns the hash so a caller never resolves the same image twice.
fn resolve_binding(connection: &Connection, series: &str, id: &str, region: &RegionBinding) -> Result<String> {
    let (hash, _) = super::characters::scoped_image(connection, series, id)?;
    if hash != region.content_hash || region.baseline_fingerprint != BASELINE {
        return Err(Error::Stale);
    }
    let b = region.bounds;
    let (width,height): (u32,u32) = connection.query_row("SELECT width,height FROM assets WHERE id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?)))?;
    // EXIF may swap axes; exact membership is additionally checked by the worker.
    if b[0] >= b[2] || b[1] >= b[3]
        || !((b[2] <= width && b[3] <= height) || (b[2] <= height && b[3] <= width)) {
        return Err(Error::Invalid("인물 영역이 이미지 범위를 벗어났습니다."));
    }
    Ok(hash)
}

pub(super) fn apply_regions(connection: &Connection, target: &Target, allowed: &[String], regions: &RegionBindings) -> Result<bool> {
    validate_region_ids(allowed, regions)?;
    let existing = read_regions(connection, &target.id)?;
    let mut changed = false;
    let series = target.series_classification_id.as_deref().ok_or(Error::Stale)?;
    for (id, region) in regions {
        let hash = resolve_binding(connection, series, id, region)?;
        if existing.get(id) == Some(region) { continue; }
        connection.execute("INSERT INTO character_reference_regions(target_id,asset_id,asset_hash,baseline_fingerprint,bounds_json) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(target_id,asset_id) DO UPDATE SET asset_hash=excluded.asset_hash,baseline_fingerprint=excluded.baseline_fingerprint,bounds_json=excluded.bounds_json",
            params![target.id,id,hash,region.baseline_fingerprint,serde_json::to_string(&region.bounds)?])?;
        changed = true;
    }
    Ok(changed)
}

pub(super) fn prune_regions(connection: &Connection, target: &str) -> Result<()> {
    connection.execute("DELETE FROM character_reference_regions WHERE target_id=?1
        AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=?1 AND r.asset_id=character_reference_regions.asset_id AND r.asset_hash=character_reference_regions.asset_hash)
        AND NOT EXISTS(SELECT 1 FROM character_learned_references r WHERE r.target_id=?1 AND r.asset_id=character_reference_regions.asset_id AND r.asset_hash=character_reference_regions.asset_hash)", [target])?;
    Ok(())
}

/// A worker response is only trusted after every field is re-derived from the request.
///
/// Every supported state is accepted, including the unresolved ones, because a partly
/// unresolved reference set is the normal case that manual verification exists to fix.
/// The state fixes the shape of one row:
///
/// * `selected` carries the crop the user bound, so it must name one.
/// * `single` is the one unambiguous detection, so it has exactly one box and index 0.
/// * `automatic` names the common person the worker inferred, and never a user's choice.
/// * `needs_region`, `no_region`, and `stale_region` resolve to no person at all.
///
/// `suggestedIndex` may mirror the automatic choice, because both name a crop of the same
/// detection list. An automatic result can therefore never satisfy a stored manual binding:
/// `verify_reference_region_selections` requires the bound bounds to be a member of `boxes`,
/// and only an explicit `selected` row resolves to the bounds the user bound.
fn validate_inspection_rows(expected: &[(String, String)], rows: &[ReferenceInspection]) -> Result<()> {
    if rows.len() != expected.len() { return Err(Error::Stale); }
    for ((id, hash), row) in expected.iter().zip(rows) {
        if !INSPECTION_STATES.iter().any(|state| *state == row.state) { return Err(Error::Stale); }
        if &row.asset_id != id || &row.content_hash != hash || row.baseline_fingerprint != BASELINE
            || row.width == 0 || row.height == 0 || row.boxes.len() > 8
            || row.boxes.iter().any(|b| b[0] >= b[2] || b[1] >= b[3] || b[2] > row.width || b[3] > row.height)
            || row.selected_index.is_some_and(|i| i >= row.boxes.len())
            || row.suggested_index.is_some_and(|i| i >= row.boxes.len())
            || row.automatic_index.is_some_and(|i| i >= row.boxes.len()) { return Err(Error::Stale); }
        let selected = matches!(row.state.as_str(), "selected" | "single");
        if selected != row.selected_index.is_some()
            || (row.state == "automatic") != row.automatic_index.is_some()
            || (row.state == "single" && (row.boxes.len() != 1 || row.selected_index != Some(0))) { return Err(Error::Stale); }
    }
    Ok(())
}

/// Evidence may use an older subset after strict additions, but not another person.
pub(super) fn selections_match(evidence: &Value, target: &Target) -> bool {
    let Some(hashes) = evidence["referenceHashes"].as_array() else { return false; };
    let selections = evidence["referenceSelections"].as_array();
    if selections.is_some_and(|s| s.len() != hashes.len()) { return false; }
    hashes.iter().enumerate().all(|(index, hash)| {
        let Some(reference) = target.usable_references().find(|r| hash.as_str() == Some(r.asset_hash.as_str())) else { return false; };
        let actual = selections.and_then(|s| s.get(index)).unwrap_or(&Value::Null);
        serde_json::to_value(&reference.region).is_ok_and(|expected| expected == *actual)
    })
}

impl Library {
    pub fn inspect_character_reference_regions(&self, series: &str, target_id: Option<&str>, ids: &[String], config: &RuntimeConfig) -> Result<Vec<ReferenceInspection>> {
        self.inspect_character_reference_regions_with_overrides(series,target_id,ids,None,config)
    }

    /// The same bounded inspection, but draft bindings replace the stored choice for the
    /// requested images only. Inspection never persists a region selection.
    pub fn inspect_character_reference_regions_with_overrides(&self, series: &str, target_id: Option<&str>, ids: &[String], overrides: Option<&RegionBindings>, config: &RuntimeConfig) -> Result<Vec<ReferenceInspection>> {
        validate_inspection_ids(ids)?;
        let (inputs, regions) = {
            let c = self.connection()?;
            let stored = if let Some(id) = target_id {
                let target = self.read_character_target(&c,id)?;
                if target.series_classification_id.as_deref()!=Some(series) {return Err(Error::Stale);}
                read_regions(&c,id)?
            } else {BTreeMap::new()};
            // Scope is checked here; whether a binding still matches the image is the
            // worker's call. A saved or draft binding whose content hash, baseline, or
            // bounds no longer match is reported as `stale_region` for that row instead of
            // failing the whole inspection, and is never replaced by a guessed person.
            let regions = merged_regions(ids,stored,overrides)?;
            let inputs = ids.iter().map(|id| {
                let (hash,path)=super::characters::scoped_image(&c,series,id)?;
                Ok((id.clone(),hash,path))
            }).collect::<Result<Vec<_>>>()?;
            (inputs,regions)
        };
        let sources = inputs.iter().map(|(_,hash,path)| Source::capture(self,path,hash)).collect::<Result<Vec<_>>>()?;
        let refs = inputs.iter().zip(&sources).map(|((id,hash,_),source)| json!({"assetId":id,"hash":hash,"path":source.path(),"region":regions.get(id)})).collect::<Vec<_>>();
        let value = self.character_worker_pool.with(config,&self.root.join(".cache/characters"),Arc::new(AtomicBool::new(false)),true,|worker,_| {
            worker.send(&json!({"type":"inspect_references","references":refs}))?;
            worker.receive()
        })?;
        if value["type"]!="references_inspected" {return Err(Error::Worker(value["error"].as_str().unwrap_or("인물 영역을 확인하지 못했습니다.").into()));}
        let rows:Vec<ReferenceInspection>=serde_json::from_value(value["items"].clone())?;
        let expected = inputs.iter().map(|(id,hash,_)| (id.clone(),hash.clone())).collect::<Vec<_>>();
        validate_inspection_rows(&expected, &rows)?;
        for ((id,hash,path),source) in inputs.iter().zip(&sources) {
            source.verify(self)?;
            let c=self.connection()?;
            if super::characters::scoped_image(&c,series,id)?!=(hash.clone(),path.clone()) {return Err(Error::Stale);}
        }
        Ok(rows)
    }

    pub fn verify_reference_region_selections(&self, series: &str, regions: &RegionBindings, config: &RuntimeConfig) -> Result<()> {
        if regions.is_empty() {return Ok(());}
        let ids=regions.keys().cloned().collect::<Vec<_>>();
        for row in self.inspect_character_reference_regions(series,None,&ids,config)? {
            let region=&regions[&row.asset_id];
            if row.content_hash!=region.content_hash || row.baseline_fingerprint!=region.baseline_fingerprint
                || !row.boxes.contains(&region.bounds) {return Err(Error::Stale);}
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "character_reference_regions_tests.rs"]
mod tests;
