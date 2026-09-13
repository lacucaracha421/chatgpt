//! Explicit read-only projection. Never prepares, migrates, imports or crawls.
use std::{collections::BTreeMap, fs::File, io::{BufWriter, Read, Write}, path::Path};
use rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use super::{catalog_counts, error::LibraryError, Library};

pub(crate) const MAX_CONTENT: u64 = 512 * 1024 * 1024;
pub(crate) const MAX_USERS: usize = 8 * 1024 * 1024;
pub(crate) struct Snapshot {
    pub file: File,
    pub content_digest: String,
    pub users: Value,
    pub works: u64,
    pub bytes: u64,
    _temporary: tempfile::TempDir,
}
fn invalid<T>(_: T) -> LibraryError { LibraryError::InvalidOnlineCatalog }
pub(crate) fn hash_json(value: &Value) -> Result<String, LibraryError> {
    Ok(Sha256::digest(serde_json::to_vec(value).map_err(invalid)?).iter().map(|byte|format!("{byte:02x}")).collect())
}
fn value(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Value> {
    Ok(match row.get_ref(index)? {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(v) => json!(v),
        ValueRef::Real(v) => json!(v),
        ValueRef::Text(v) => Value::String(std::str::from_utf8(v).map_err(|_|rusqlite::Error::InvalidQuery)?.to_owned()),
        ValueRef::Blob(_) => return Err(rusqlite::Error::InvalidQuery),
    })
}
fn arrays(connection: &Connection, sql: &str) -> Result<Vec<Value>, LibraryError> {
    let mut statement = connection.prepare(sql)?;
    let columns = statement.column_count();
    let mut rows = statement.query([])?;
    let mut result = Vec::new();
    let mut bytes = 0usize;
    while let Some(row) = rows.next()? {
        let data = Value::Array((0..columns).map(|n| value(row,n)).collect::<Result<_,_>>()?);
        bytes += serde_json::to_vec(&data).map_err(invalid)?.len();
        if bytes > MAX_USERS { return Err(LibraryError::InvalidOnlineCatalog); }
        result.push(data);
    }
    result.sort_by_cached_key(Value::to_string);
    Ok(result)
}
pub(super) fn user_snapshot(connection: &Connection) -> Result<Value, LibraryError> {
    let decisions = arrays(connection,"SELECT left_anchor,right_anchor,decision,evidence,reviewed_at,'kHentai' FROM online_catalog_review_decisions")?;
    let result = json!({
        "bookmarks":arrays(connection,"SELECT provider,work_id,created_at FROM online_catalog_bookmarks")?,
        "hiddenCategories":arrays(connection,"SELECT category,created_at FROM online_catalog_hidden_categories")?,
        "blockedTags":arrays(connection,"SELECT namespace,value,created_at FROM online_catalog_blocked_tags")?,
        "preferences":arrays(connection,"SELECT provider,anchor_work_id,selected_work_id,edit_revision FROM online_catalog_group_preferences")?,
        "decisionRevision":hash_json(&json!(decisions))?, "decisions":decisions,
    });
    if serde_json::to_vec(&result).map_err(invalid)?.len()>MAX_USERS { return Err(LibraryError::InvalidOnlineCatalog); }
    Ok(result)
}
fn write_record(out: &mut BufWriter<File>, kind: &str, data: Value, bytes: &mut u64) -> Result<(), LibraryError> {
    let mut line = serde_json::to_vec(&json!({"kind":kind,"value":data})).map_err(invalid)?;
    line.push(b'\n');
    *bytes += line.len() as u64;
    if line.len()>1024*1024 || *bytes>MAX_CONTENT { return Err(LibraryError::InvalidOnlineCatalog); }
    out.write_all(&line).map_err(invalid)
}
impl Library {
    pub(crate) fn export_mobile_catalog_snapshot_with_progress(&self, progress: crate::cloud::publication::Reporter<'_>) -> Result<Snapshot,LibraryError> {
        use crate::cloud::publication::report;
        report(progress, "preparing", 0, None, "items");
        let mut reader = self.catalog_read_connection()?;
        let tx = reader.transaction()?;
        let context = catalog_counts::read_context(&tx)?.ok_or(LibraryError::InvalidOnlineCatalog)?;
        let users = user_snapshot(&tx)?;
        let translations = read_translations(&self.root().join("catalogs/tag-ko.json"),&tx)?;
        let tables = [
            ("work","catalog.Works","Id,Title,TitleJpn,Category,Uploader,Posted,Updated,FileCount,FileSize,Rating,Views,Thumb,Expunged","Id"),
            ("tag","catalog.Tags","WorkId,Namespace,Value","WorkId,Namespace,Value"),
            ("member","online_catalog_group_members","provider,work_id,catalog_work_id,group_id,thumbnail_valid,completeness,lineage_terminal","provider,work_id"),
            ("handle","online_catalog_group_handles","provider,anchor_work_id,group_id,sequence","provider,anchor_work_id"),
        ];
        let mut counts = BTreeMap::new();
        for (kind,table,_,_) in tables { counts.insert(kind,tx.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|r|r.get::<_,i64>(0))?.max(0) as u64); }
        counts.insert("translation", translations.len() as u64);
        let total = counts.values().sum();
        let mut completed = 0u64;
        report(progress, "preparing", 0, Some(total), "items");
        let source_revision: String = tx.query_row("SELECT Value FROM catalog.CrawlState WHERE Key='lakomics.catalog.contentRevision'",[],|r|r.get(0))?;
        let temporary = tempfile::tempdir().map_err(invalid)?;
        let path = temporary.path().join("catalog.ndjson");
        let mut out = BufWriter::new(File::create(&path).map_err(invalid)?);
        let mut bytes = 0;
        write_record(&mut out,"manifest",json!({"contractVersion":1,"schemaVersion":1,"sourceRevision":source_revision,"groupGeneration":context.generation,"groupDecisionRevision":users["decisionRevision"],"counts":counts}),&mut bytes)?;
        for (kind,table,columns,order) in tables {
            let mut statement = tx.prepare(&format!("SELECT {columns} FROM {table} ORDER BY {order}"))?;
            let names: Vec<_> = columns.split(',').collect();
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let mut data = serde_json::Map::new();
                for (index,name) in names.iter().enumerate() { data.insert((*name).to_owned(),value(row,index)?); }
                write_record(&mut out,kind,Value::Object(data),&mut bytes)?;
                completed += 1;
                if completed % 10000 == 0 { report(progress, "preparing", completed, Some(total), "items"); }
            }
        }
        for data in translations { write_record(&mut out,"translation",data,&mut bytes)?; }
        report(progress, "preparing", total, Some(total), "items");
        out.flush().map_err(invalid)?;
        drop(out); drop(tx); drop(reader);
        let mut file = File::open(&path).map_err(invalid)?;
        let mut hash = Sha256::new(); let mut buffer = [0u8;32768];
        loop { let n=file.read(&mut buffer).map_err(invalid)?; if n==0 {break;} hash.update(&buffer[..n]); }
        Ok(Snapshot { file:File::open(path).map_err(invalid)?,content_digest:hash.finalize().iter().map(|byte|format!("{byte:02x}")).collect(), users,works:counts["work"],bytes,_temporary:temporary })
    }
}
fn read_translations(path: &Path, connection:&Connection) -> Result<Vec<Value>,LibraryError> {
    if !path.exists() { return Ok(Vec::new()); }
    let file=File::open(path).map_err(invalid)?;
    let mut bytes=Vec::new(); file.take(2*1024*1024+1).read_to_end(&mut bytes).map_err(invalid)?;
    if bytes.len()>2*1024*1024 { return Err(LibraryError::InvalidOnlineCatalog); }
    let translations:BTreeMap<String,String>=serde_json::from_slice(&bytes).map_err(invalid)?;
    let mut statement=connection.prepare("SELECT DISTINCT Namespace,Value FROM catalog.Tags ORDER BY Namespace,Value")?;
    let mut rows=statement.query([])?;
    let mut result=Vec::new();
    while let Some(row)=rows.next()? {
        let namespace:String=row.get(0)?;let value:String=row.get(1)?;
        if let Some(label)=super::online_catalog::translated_detail_tag(&translations,&namespace,&value){result.push(json!({"namespace":namespace,"value":value,"label":label}));}
    }
    Ok(result)
}

pub(crate) fn visibility_snapshot(connection:&Connection)->Result<Value,LibraryError>{
    Ok(json!({"hiddenCategories":arrays(connection,"SELECT category,created_at FROM online_catalog_hidden_categories")?,"blockedTags":arrays(connection,"SELECT namespace,value,created_at FROM online_catalog_blocked_tags")?}))
}
