use std::collections::BTreeSet;
use rusqlite::{params, Connection, OptionalExtension};
use super::{av_models::*, Library};

pub(crate) fn require_av(connection: &Connection, id: &str) -> Result<(), AvError> {
    let valid: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1 AND type='av')", [id], |r| r.get(0))?;
    if valid { Ok(()) } else { Err(AvError::Invalid) }
}
fn text(value: Option<String>, max: usize) -> Result<Option<String>, AvError> {
    let value = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    if value.as_ref().is_some_and(|v| v.chars().count() > max) { return Err(AvError::Invalid); }
    Ok(value)
}
fn details(connection: &Connection, id: &str) -> Result<AvDetails, AvError> {
    require_av(connection, id)?;
    let mut value = connection.query_row("SELECT product_code,label,series,revision FROM collection_av_details WHERE collection_id=?1", [id], |r| Ok(AvDetails {
        collection_id: id.into(), product_code: r.get(0)?, label: r.get(1)?, series: r.get(2)?, revision: r.get(3)?, people: vec![],
    })).optional()?.unwrap_or(AvDetails { collection_id: id.into(), product_code: None, label: None, series: None, revision: 0, people: vec![] });
    value.people = connection.prepare("SELECT p.id,p.display_name,r.role,r.sort_order,r.credit_name FROM collection_person_relations r JOIN collection_people p ON p.id=r.person_id WHERE r.collection_id=?1 ORDER BY CASE r.role WHEN 'performer' THEN 0 ELSE 1 END,r.sort_order,p.id")?.query_map([id], |r| Ok(AvPersonCredit {
        id: r.get(0)?, display_name: r.get(1)?, role: if r.get::<_, String>(2)? == "performer" { AvPersonRole::Performer } else { AvPersonRole::Director }, order: r.get(3)?, credit_name: r.get(4)?,
    }))?.collect::<Result<Vec<_>,_>>()?;
    Ok(value)
}
impl Library {
    pub fn get_av_details(&self, id: &str) -> Result<AvDetails, AvError> { details(&*self.connection()?, id) }
    pub fn search_av_people(&self, query: &str) -> Result<Vec<AvPerson>, AvError> {
        let query = text(Some(query.into()), 120)?.unwrap_or_default();
        if query.is_empty() { return Ok(vec![]); }
        let pattern = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let connection = self.connection()?;
        let result = connection.prepare("SELECT id,display_name FROM collection_people WHERE display_name LIKE ?1 ESCAPE '\\' ORDER BY display_name,id LIMIT 20")?.query_map([pattern], |r| Ok(AvPerson { id:r.get(0)?, display_name:r.get(1)? }))?.collect::<Result<Vec<_>,_>>()?;
        Ok(result)
    }
    pub fn save_av_details(&self, id: &str, input: SaveAvDetails) -> Result<AvDetails, AvError> {
        if input.expected_revision < 0 || input.people.len() > 100 { return Err(AvError::Invalid); }
        let product_code = text(input.product_code,120)?;
        let label = text(input.label,240)?;
        let series = text(input.series,240)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let previous = details(&transaction,id)?;
        if previous.revision != input.expected_revision { return Err(AvError::Stale); }
        let now = chrono::Utc::now().to_rfc3339();
        let mut seen = BTreeSet::new();
        let mut people = Vec::new();
        for item in input.people {
            let person_id = match item.person {
                AvPersonChoice::Existing { id } => {
                    let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM collection_people WHERE id=?1)",[&id],|r|r.get(0))?;
                    if !exists { return Err(AvError::Invalid); } id
                },
                AvPersonChoice::New { display_name } => {
                    let display_name = text(Some(display_name),120)?.ok_or(AvError::Invalid)?;
                    let id = uuid::Uuid::new_v4().to_string();
                    transaction.execute("INSERT INTO collection_people(id,display_name,created_at,updated_at) VALUES(?1,?2,?3,?3)",params![id,display_name,now])?;
                    id
                },
            };
            if !seen.insert((person_id.clone(),item.role.clone())) { return Err(AvError::Invalid); }
            people.push((person_id,item.role,text(item.credit_name,120)?));
        }
        transaction.execute("DELETE FROM collection_person_relations WHERE collection_id=?1",[id])?;
        let mut orders = [0,0];
        for (person,role,credit) in people {
            let index = if role == AvPersonRole::Performer {0} else {1};
            transaction.execute("INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order,credit_name) VALUES(?1,?2,?3,?4,?5)", params![id,person,role.as_str(),orders[index],credit])?;
            orders[index] += 1;
        }
        transaction.execute("INSERT INTO collection_av_details(collection_id,product_code,label,series,revision) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(collection_id) DO UPDATE SET product_code=excluded.product_code,label=excluded.label,series=excluded.series,revision=excluded.revision",params![id,product_code,label,series,previous.revision+1])?;
        transaction.execute("UPDATE collections SET updated_at=?1 WHERE id=?2",params![now,id])?;
        let result = details(&transaction,id)?;
        transaction.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
#[path = "av_collection_tests.rs"]
mod tests;
