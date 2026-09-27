use super::{av_models::*, Library};
use chrono::NaiveDate;
use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvHomeWork {
    pub collection_id: String,
    pub product_code: Option<String>,
    pub title: String,
    pub release_date: Option<String>,
    pub front_artwork_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvHomePerformer {
    pub id: String,
    pub display_name: String,
    pub original_name: Option<String>,
    pub portrait: Option<AvPortrait>,
    pub known_works: i64,
    pub owned_works: i64,
    pub latest_work: AvHomeWork,
    pub recent_owned_works: Vec<AvHomeWork>,
}

pub(crate) fn require_av(connection: &Connection, id: &str) -> Result<(), AvError> {
    let valid: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1 AND type='av')",
        [id],
        |r| r.get(0),
    )?;
    if valid {
        Ok(())
    } else {
        Err(AvError::Invalid)
    }
}
pub(super) fn text(value: Option<String>, max: usize) -> Result<Option<String>, AvError> {
    let value = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    if value.as_ref().is_some_and(|v| v.chars().count() > max) {
        return Err(AvError::Invalid);
    }
    Ok(value)
}
pub(crate) fn details(connection: &Connection, id: &str) -> Result<AvDetails, AvError> {
    require_av(connection, id)?;
    let mut value = connection.query_row("SELECT d.product_code,NULLIF(TRIM(d.label),''),NULLIF(TRIM(d.series),''),COALESCE(d.revision,0),d.title_ja,COALESCE(NULLIF(TRIM(d.release_date),''),NULLIF(TRIM(c.release_date),'')),NULLIF(TRIM(d.maker),''),d.genres_json FROM collections c LEFT JOIN collection_av_details d ON d.collection_id=c.id WHERE c.id=?1", [id], |r| Ok(AvDetails {
        collection_id: id.into(), product_code: r.get(0)?, label: r.get(1)?, series: r.get(2)?, revision: r.get(3)?, people: vec![],
        title_ja: r.get(4)?, release_date: r.get(5)?, maker: r.get(6)?, genres: r.get::<_,Option<String>>(7)?.and_then(|v|serde_json::from_str(&v).ok()).unwrap_or_default(), maker_count:0,label_count:0,series_count:0,
    }))?;
    for (column, name, count) in [
        ("maker", &value.maker, &mut value.maker_count),
        ("label", &value.label, &mut value.label_count),
        ("series", &value.series, &mut value.series_count),
    ] {
        if let Some(name) = name {
            *count = connection.query_row(&format!("SELECT COUNT(*) FROM collection_av_details d JOIN collections c ON c.id=d.collection_id AND c.type='av' WHERE TRIM(d.{column})=?1"), [name], |r|r.get(0))?;
        }
    }
    value.people = connection.prepare("SELECT p.id,p.display_name,r.role,r.sort_order,r.credit_name,p.name_ja,(SELECT COUNT(DISTINCT cr.collection_id) FROM collection_person_relations cr JOIN collections c ON c.id=cr.collection_id AND c.type='av' WHERE cr.person_id=p.id) FROM collection_person_relations r JOIN collection_people p ON p.id=r.person_id WHERE r.collection_id=?1 ORDER BY CASE r.role WHEN 'performer' THEN 0 ELSE 1 END,r.sort_order,p.id")?.query_map([id], |r| Ok(AvPersonCredit {
        id: r.get(0)?, display_name: r.get(1)?, role: if r.get::<_, String>(2)? == "performer" { AvPersonRole::Performer } else { AvPersonRole::Director }, order: r.get(3)?, credit_name: r.get(4)?, name_ja:r.get(5)?,work_count:r.get(6)?,portrait:None,
    }))?.collect::<Result<Vec<_>,_>>()?;
    for person in &mut value.people {
        person.portrait = super::av_portrait::portrait(connection, &person.id)?;
    }
    Ok(value)
}
impl Library {
    /// A stable daily pick from performers attached to at least one local AV Collection.
    pub fn home_av_performer(
        &self,
        local_date: NaiveDate,
    ) -> Result<Option<AvHomePerformer>, AvError> {
        let connection = self.connection()?;
        let mut people = connection
            .prepare(
                "SELECT p.id,p.display_name,NULLIF(TRIM(p.name_ja),''),
                        COUNT(DISTINCT r.collection_id),
                        COUNT(DISTINCT CASE WHEN c.type='av' THEN r.collection_id END)
                 FROM collection_people p
                 JOIN collection_person_relations r ON r.person_id=p.id AND r.role='performer'
                 JOIN collections c ON c.id=r.collection_id
                 GROUP BY p.id,p.display_name,p.name_ja
                 HAVING COUNT(DISTINCT CASE WHEN c.type='av' THEN r.collection_id END)>0",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if people.is_empty() {
            return Ok(None);
        }
        people.sort_by(|left, right| {
            Sha256::digest(left.0.as_bytes())
                .cmp(&Sha256::digest(right.0.as_bytes()))
                .then_with(|| left.0.cmp(&right.0))
        });
        let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).expect("valid Unix epoch");
        let index = local_date
            .signed_duration_since(epoch)
            .num_days()
            .rem_euclid(people.len() as i64) as usize;
        let (id, display_name, original_name, known_works, owned_works) = people.swap_remove(index);
        let recent_owned_works = connection
            .prepare(
                "SELECT c.id,NULLIF(TRIM(d.product_code),''),
                        COALESCE(NULLIF(TRIM(d.title_ja),''),NULLIF(TRIM(c.original_title),''),c.name),
                        COALESCE(NULLIF(TRIM(d.release_date),''),NULLIF(TRIM(c.release_date),'')),
                        (SELECT artwork.id FROM collection_work_artworks artwork
                         WHERE artwork.collection_id=c.id AND artwork.kind='cover' AND artwork.selected=1
                         ORDER BY artwork.id LIMIT 1)
                 FROM collection_person_relations r
                 JOIN collections c ON c.id=r.collection_id AND c.type='av'
                 LEFT JOIN collection_av_details d ON d.collection_id=c.id
                 WHERE r.person_id=?1 AND r.role='performer'
                 ORDER BY COALESCE(NULLIF(TRIM(d.release_date),''),NULLIF(TRIM(c.release_date),''),'') DESC,
                          c.created_at DESC,c.id
                 LIMIT 3",
            )?
            .query_map([&id], |row| {
                Ok(AvHomeWork {
                    collection_id: row.get(0)?,
                    product_code: row.get(1)?,
                    title: row.get(2)?,
                    release_date: row.get(3)?,
                    front_artwork_id: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let Some(latest_work) = recent_owned_works.first().cloned() else {
            return Ok(None);
        };
        let original_name = original_name.filter(|name| name != &display_name);
        let portrait = super::av_portrait::portrait(&connection, &id)?;
        Ok(Some(AvHomePerformer {
            portrait,
            id,
            display_name,
            original_name,
            known_works,
            owned_works,
            latest_work,
            recent_owned_works,
        }))
    }

    pub fn get_av_details(&self, id: &str) -> Result<AvDetails, AvError> {
        details(&*self.connection()?, id)
    }
    pub fn search_av_people(&self, query: &str) -> Result<Vec<AvPerson>, AvError> {
        let query = text(Some(query.into()), 120)?.unwrap_or_default();
        if query.is_empty() {
            return Ok(vec![]);
        }
        let pattern = format!(
            "%{}%",
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let connection = self.connection()?;
        let result = connection.prepare("SELECT id,display_name FROM collection_people WHERE display_name LIKE ?1 ESCAPE '\\' ORDER BY display_name,id LIMIT 20")?.query_map([pattern], |r| Ok(AvPerson { id:r.get(0)?, display_name:r.get(1)? }))?.collect::<Result<Vec<_>,_>>()?;
        Ok(result)
    }
    pub fn save_av_details(&self, id: &str, input: SaveAvDetails) -> Result<AvDetails, AvError> {
        if input.expected_revision < 0 || input.people.len() > 100 {
            return Err(AvError::Invalid);
        }
        let product_code = text(input.product_code, 120)?;
        let label = text(input.label, 240)?;
        let series = text(input.series, 240)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let previous = details(&transaction, id)?;
        if previous.revision != input.expected_revision {
            return Err(AvError::Stale);
        }
        let now = chrono::Utc::now().to_rfc3339();
        let mut seen = BTreeSet::new();
        let mut people = Vec::new();
        for item in input.people {
            let person_id = match item.person {
                AvPersonChoice::Existing { id } => {
                    let exists: bool = transaction.query_row(
                        "SELECT EXISTS(SELECT 1 FROM collection_people WHERE id=?1)",
                        [&id],
                        |r| r.get(0),
                    )?;
                    if !exists {
                        return Err(AvError::Invalid);
                    }
                    id
                }
                AvPersonChoice::New { display_name } => {
                    let display_name = text(Some(display_name), 120)?.ok_or(AvError::Invalid)?;
                    let id = uuid::Uuid::new_v4().to_string();
                    transaction.execute("INSERT INTO collection_people(id,display_name,created_at,updated_at) VALUES(?1,?2,?3,?3)",params![id,display_name,now])?;
                    id
                }
            };
            if !seen.insert((person_id.clone(), item.role.clone())) {
                return Err(AvError::Invalid);
            }
            people.push((person_id, item.role, text(item.credit_name, 120)?));
        }
        transaction.execute(
            "DELETE FROM collection_person_relations WHERE collection_id=?1",
            [id],
        )?;
        let mut orders = [0, 0];
        for (person, role, credit) in people {
            let index = if role == AvPersonRole::Performer {
                0
            } else {
                1
            };
            transaction.execute("INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order,credit_name) VALUES(?1,?2,?3,?4,?5)", params![id,person,role.as_str(),orders[index],credit])?;
            orders[index] += 1;
        }
        transaction.execute("INSERT INTO collection_av_details(collection_id,product_code,label,series,revision) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(collection_id) DO UPDATE SET product_code=excluded.product_code,label=excluded.label,series=excluded.series,revision=excluded.revision",params![id,product_code,label,series,previous.revision+1])?;
        transaction.execute(
            "UPDATE collections SET updated_at=?1 WHERE id=?2",
            params![now, id],
        )?;
        let result = details(&transaction, id)?;
        transaction.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
#[path = "av_collection_tests.rs"]
mod tests;
