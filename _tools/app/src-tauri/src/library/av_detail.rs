use super::{
    av_artwork::cover_set,
    av_collection::{details, require_av, text},
    av_models::*,
    av_portrait::{portrait, require_person},
    Library,
};
use rusqlite::{params, Connection};

pub(super) const RELEASE: &str =
    "COALESCE(NULLIF(TRIM(d.release_date),''),NULLIF(TRIM(c.release_date),''))";
pub(super) fn work_card(c: &Connection, id: &str) -> Result<AvWorkCard, AvError> {
    let covers = cover_set(c, id)?;
    Ok(c.query_row(&format!("SELECT c.name,d.product_code,{RELEASE} FROM collections c LEFT JOIN collection_av_details d ON d.collection_id=c.id WHERE c.id=?1"), [id], |r| Ok(AvWorkCard {
        collection_id:id.into(),name:r.get(0)?,product_code:r.get(1)?,release_date:r.get(2)?,front_artwork_id:covers.front_id,spine_artwork_id:covers.spine_id,back_artwork_id:covers.back_id,cover_revision:covers.revision,
    }))?)
}
fn work_ids(
    c: &Connection,
    predicate: &str,
    value: &str,
    excluded: &str,
    ascending: bool,
) -> Result<Vec<String>, AvError> {
    let direction = if ascending { "ASC" } else { "DESC" };
    Ok(c.prepare(&format!("SELECT c.id FROM collections c LEFT JOIN collection_av_details d ON d.collection_id=c.id WHERE c.type='av' AND c.id<>?2 AND {predicate} ORDER BY {RELEASE} IS NULL,{RELEASE} {direction},c.id"))?.query_map(params![value,excluded], |r|r.get(0))?.collect::<Result<Vec<_>,_>>()?)
}
impl Library {
    pub fn get_av_related(&self, id: &str) -> Result<AvRelated, AvError> {
        let c = self.connection()?;
        require_av(&c, id)?;
        let detail = details(&c, id)?;
        let mut performers = Vec::new();
        for person in detail
            .people
            .into_iter()
            .filter(|p| p.role == AvPersonRole::Performer)
        {
            let ids = work_ids(&c,"EXISTS(SELECT 1 FROM collection_person_relations r WHERE r.collection_id=c.id AND r.person_id=?1 AND r.role='performer')",&person.id,id,false)?;
            performers.push(AvPerformerShelf {
                profile_metadata: person.profile_metadata.clone(),
                name_ja: person.name_ja.clone(),
                person_id: person.id,
                display_name: person.display_name,
                total: ids.len(),
                items: ids
                    .iter()
                    .take(12)
                    .map(|id| work_card(&c, id))
                    .collect::<Result<_, _>>()?,
            });
        }
        let series = if let Some(name) = detail.series {
            let ids = work_ids(&c, "TRIM(d.series)=?1", &name, "", true)?;
            if ids.len() <= 1 {
                None
            } else {
                let current = ids
                    .iter()
                    .position(|item| item == id)
                    .ok_or(AvError::Invalid)?;
                let start = current.saturating_sub(5).min(ids.len().saturating_sub(12));
                Some(AvSeriesShelf {
                    name,
                    total: ids.len(),
                    items: ids
                        .iter()
                        .skip(start)
                        .take(12)
                        .map(|item| {
                            Ok(AvSeriesWork {
                                work: work_card(&c, item)?,
                                current: item == id,
                            })
                        })
                        .collect::<Result<_, AvError>>()?,
                })
            }
        } else {
            None
        };
        let label = if let Some(name) = detail.label {
            let ids = work_ids(&c, "TRIM(d.label)=?1", &name, id, false)?;
            if ids.is_empty() {
                None
            } else {
                Some(AvLabelShelf {
                    name,
                    total: ids.len(),
                    items: ids
                        .iter()
                        .take(12)
                        .map(|id| work_card(&c, id))
                        .collect::<Result<_, _>>()?,
                })
            }
        } else {
            None
        };
        Ok(AvRelated {
            performers,
            series,
            label,
        })
    }
    pub fn get_av_performer(&self, id: &str) -> Result<AvPerformerPage, AvError> {
        performer_page(&*self.connection()?, id)
    }
    pub fn save_av_person_memo(
        &self,
        id: &str,
        memo: Option<String>,
    ) -> Result<AvPerformerPage, AvError> {
        let memo = text(memo, super::av_models::av_limit("personMemo"))?;
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let status = super::collection_authority::collection_write_status(&tx)?;
        require_person(&tx, id)?;
        if status.active {
            super::collection_authority::enqueue_person_changes(
                &tx,
                &status,
                id,
                serde_json::json!({"memo":memo}),
            )?;
        }
        tx.execute(
            "UPDATE collection_people SET memo=?2,updated_at=?3 WHERE id=?1",
            params![id, memo, chrono::Utc::now().to_rfc3339()],
        )?;
        let page = performer_page(&tx, id)?;
        tx.commit()?;
        Ok(page)
    }
}
fn performer_page(c: &Connection, id: &str) -> Result<AvPerformerPage, AvError> {
    require_person(c, id)?;
    let mut person = c.query_row("SELECT display_name,name_ja,wikidata_id,fanza_actress_id,memo FROM collection_people WHERE id=?1",[id],|r|Ok(AvPerformerPerson{profile_metadata:serde_json::json!({}),id:id.into(),display_name:r.get(0)?,name_ja:r.get(1)?,wikidata_id:r.get(2)?,fanza_actress_id:r.get(3)?,memo:r.get(4)?,portrait:None}))?;
    person.portrait = portrait(c, id)?;
    let metadata = super::collection_authority::PersonDisplayMetadata::read(c)?;
    person.profile_metadata = metadata.person(c,id)?;
    let predicate = "EXISTS(SELECT 1 FROM collection_person_relations r WHERE r.collection_id=c.id AND r.person_id=?1)";
    let ids = work_ids(c, predicate, id, "", false)?;
    let mut works = Vec::new();
    for collection in &ids {
        // One card per work: a performer/director credit uses its performer role.
        let performer:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM collection_person_relations WHERE collection_id=?1 AND person_id=?2 AND role='performer')",params![collection,id],|r|r.get(0))?;
        let solo = performer && solo_work(c, collection)?;
        works.push(AvPerformerWork {
            work: work_card(c, collection)?,
            role: if performer {
                AvPersonRole::Performer
            } else {
                AvPersonRole::Director
            },
            solo,
        });
    }
    let stats=c.query_row(&format!("SELECT COUNT(*),MIN({RELEASE}),MAX({RELEASE}),AVG(c.my_score) FROM collections c LEFT JOIN collection_av_details d ON d.collection_id=c.id WHERE c.type='av' AND {predicate}"),[id],|r|Ok(AvPerformerStats{work_count:r.get(0)?,first_release:r.get(1)?,last_release:r.get(2)?,average_score:r.get(3)?}))?;
    let mut co_performers=c.prepare("SELECT p.id,p.display_name,COUNT(DISTINCT r.collection_id) AS shared FROM collection_person_relations r JOIN collections c ON c.id=r.collection_id AND c.type='av' JOIN collection_people p ON p.id=r.person_id WHERE r.role='performer' AND r.person_id<>?1 AND EXISTS(SELECT 1 FROM collection_person_relations mine WHERE mine.collection_id=c.id AND mine.person_id=?1 AND mine.role='performer') GROUP BY p.id ORDER BY shared DESC,p.display_name,p.id LIMIT 8")?.query_map([id],|r|Ok(AvCoPerformer{profile_metadata:serde_json::json!({}),name_ja:None,id:r.get(0)?,display_name:r.get(1)?,count:r.get(2)?,portrait:None}))?.collect::<Result<Vec<_>,_>>()?;
    for p in &mut co_performers {
        p.portrait = portrait(c, &p.id)?;
        p.profile_metadata = metadata.person(c,&p.id)?;
        p.name_ja = c.query_row("SELECT name_ja FROM collection_people WHERE id=?1",[&p.id],|r|r.get(0))?;
    }
    let labels=c.prepare(&format!("SELECT TRIM(d.label),COUNT(*) AS total FROM collections c JOIN collection_av_details d ON d.collection_id=c.id WHERE c.type='av' AND NULLIF(TRIM(d.label),'') IS NOT NULL AND {predicate} GROUP BY TRIM(d.label) ORDER BY total DESC,TRIM(d.label)"))?.query_map([id],|r|Ok(AvLabelCount{name:r.get(0)?,count:r.get(1)?}))?.collect::<Result<Vec<_>,_>>()?;
    Ok(AvPerformerPage {
        person,
        stats,
        works,
        co_performers,
        labels,
    })
}
pub(super) fn solo_work(c: &Connection, id: &str) -> Result<bool, AvError> {
    Ok(c.query_row("SELECT COUNT(*)=1 FROM collection_person_relations WHERE collection_id=?1 AND role='performer'",[id],|r|r.get(0))?)
}
