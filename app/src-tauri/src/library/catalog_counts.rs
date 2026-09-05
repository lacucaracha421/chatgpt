//! Tiny persistent derived state for empty-text, All-scope default browsing.
use super::{
    catalog_groups::ALGORITHM, catalog_visibility::append_visibility_predicates,
    error::LibraryError, models::CatalogLanguage,
};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
const PROVIDER: &str = "kHentai";
const COUNT_RULE_VERSION: i64 = 1;
const REVEAL_POLICY: &str = "reveal-independent-v1";
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CountContext {
    pub(super) source_revision: String,
    pub(super) generation: i64,
    pub(super) policy_identity: String,
}
#[derive(Debug, PartialEq)]
pub(super) struct PreparedCounts {
    context: CountContext,
    counts: [u64; 6],
}
fn hash(parts: impl IntoIterator<Item = String>) -> String {
    let mut h = Sha256::new();
    for s in parts {
        h.update((s.len() as u64).to_le_bytes());
        h.update(s.as_bytes());
    }
    h.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
/// Reads actual policy content in canonical order; timestamps are intentionally irrelevant.
pub(super) fn read_context(c: &Connection) -> Result<Option<CountContext>, LibraryError> {
    let source: Option<String> = c
        .query_row(
            "SELECT Value FROM catalog.CrawlState WHERE Key='lakomics.catalog.contentRevision'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let Some(source) = source.filter(|s| !s.trim().is_empty() && s != "legacy") else {
        return Ok(None);
    };
    let state=c.query_row("SELECT source_revision,generation,last_error FROM online_catalog_group_state WHERE provider=?1",[PROVIDER],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?))).optional();
    let Ok(Some((revision, generation, None))) = state else {
        return Ok(None);
    };
    if revision != format!("{ALGORITHM}:{source}") || generation <= 0 {
        return Ok(None);
    }
    let mut parts = vec!["visibility-v1".to_owned()];
    {
        let mut s =
            c.prepare("SELECT category FROM online_catalog_hidden_categories ORDER BY category")?;
        for x in s.query_map([], |r| r.get::<_, i64>(0))? {
            parts.push(format!("category:{}", x?));
        }
    }
    {
        let mut s = c.prepare(
            "SELECT namespace,value FROM online_catalog_blocked_tags ORDER BY namespace,value",
        )?;
        for x in s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (n, v) = x?;
            parts.extend(["tag".into(), n, v]);
        }
    }
    Ok(Some(CountContext {
        source_revision: revision,
        generation,
        policy_identity: hash(parts),
    }))
}
fn integrity(context: &CountContext, language: &str, reveal: bool, count: u64) -> String {
    hash([
        PROVIDER.into(),
        language.into(),
        reveal.to_string(),
        context.source_revision.clone(),
        context.generation.to_string(),
        COUNT_RULE_VERSION.to_string(),
        if reveal {
            REVEAL_POLICY.into()
        } else {
            context.policy_identity.clone()
        },
        count.to_string(),
    ])
}
pub(super) fn lookup(
    c: &Connection,
    language: Option<CatalogLanguage>,
    reveal: bool,
) -> Result<Option<u64>, LibraryError> {
    // Validity and the scalar must come from one snapshot, including standalone
    // callers. Reuse an existing page/request transaction without nesting it.
    if c.is_autocommit() {
        let snapshot = c.unchecked_transaction()?;
        return lookup(&snapshot, language, reveal);
    }
    let Some(context) = read_context(c)? else {
        return Ok(None);
    };
    let language = language.map(CatalogLanguage::as_tag).unwrap_or("all");
    let row=c.query_row("SELECT exact_count,integrity_hash FROM online_catalog_prepared_counts WHERE provider=?1 AND language=?2 AND reveal=?3 AND source_revision=?4 AND generation=?5 AND count_rule_version=?6 AND policy_identity=?7",params![PROVIDER,language,reveal,context.source_revision,context.generation,COUNT_RULE_VERSION,if reveal{REVEAL_POLICY}else{&context.policy_identity}],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).optional();
    // Derived state is disposable, including malformed values or a missing table.
    Ok(match row {
        Ok(Some((count, checksum)))
            if count >= 0 && checksum == integrity(&context, language, reveal, count as u64) =>
        {
            Some(count as u64)
        }
        _ => None,
    })
}
/// Caller must hold a fixed read transaction. This function never writes.
pub(super) fn compute(c: &Connection) -> Result<Option<PreparedCounts>, LibraryError> {
    let Some(context) = read_context(c)? else {
        return Ok(None);
    };
    if c.is_autocommit() {
        return Err(LibraryError::Database(rusqlite::Error::InvalidQuery));
    }
    let mut groups = HashMap::<String, usize>::new();
    let mut members = HashMap::<i64, usize>::new();
    {
        let mut s = c.prepare(
            "SELECT catalog_work_id,group_id FROM online_catalog_group_members WHERE provider=?1",
        )?;
        for row in s.query_map([PROVIDER], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })? {
            let (id, gid) = row?;
            let n = groups.len();
            let index = *groups.entry(gid).or_insert(n);
            members.insert(id, index);
        }
    }
    let mut visibility = vec![];
    append_visibility_predicates(c, &mut visibility)?;
    let visibility = if visibility.is_empty() {
        "1".into()
    } else {
        visibility.join(" AND ")
    };
    // Language and visibility are combined on EACH work before any group-level OR.
    let sql=format!("SELECT work.Id, CASE WHEN work.Expunged=0 THEN (1 + 2*EXISTS(SELECT 1 FROM catalog.Tags t WHERE t.WorkId=work.Id AND t.Namespace='language' AND t.Value='korean') + 4*EXISTS(SELECT 1 FROM catalog.Tags t WHERE t.WorkId=work.Id AND t.Namespace='language' AND t.Value='japanese')) * CASE WHEN {visibility} THEN 9 ELSE 1 END ELSE 0 END FROM catalog.Works work NOT INDEXED");
    let mut flags = vec![0u8; groups.len()];
    let mut seen = 0usize;
    {
        let mut s = c.prepare(&sql)?;
        for row in s.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, u8>(1)?)))? {
            let (id, mask) = row?;
            let Some(&g) = members.get(&id) else {
                return Ok(None);
            };
            flags[g] |= mask;
            seen += 1;
        }
    }
    if seen != members.len() {
        return Ok(None);
    }
    let mut counts = [0; 6];
    for flags in flags {
        for (bit, count) in counts.iter_mut().enumerate() {
            *count += u64::from(flags & (1 << bit) != 0);
        }
    }
    Ok(Some(PreparedCounts { context, counts }))
}
/// Caller drops the preparation snapshot, then opens a NEW publication transaction.
/// Savepoint rollback makes partial six-row publication impossible, even on failure.
pub(super) fn publish(c: &Connection, p: &PreparedCounts) -> Result<bool, LibraryError> {
    if c.is_autocommit() {
        return Err(LibraryError::Database(rusqlite::Error::InvalidQuery));
    }
    if read_context(c)?.as_ref() != Some(&p.context) {
        return Ok(false);
    }
    c.execute_batch("SAVEPOINT catalog_count_publish")?;
    let result = (|| -> Result<(), LibraryError> {
        for (bit, count) in p.counts.iter().copied().enumerate() {
            let language = ["all", "korean", "japanese"][bit % 3];
            let reveal = bit < 3;
            c.execute("INSERT OR REPLACE INTO online_catalog_prepared_counts(provider,language,reveal,source_revision,generation,count_rule_version,policy_identity,exact_count,integrity_hash) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![PROVIDER,language,reveal,p.context.source_revision,p.context.generation,COUNT_RULE_VERSION,if reveal{REVEAL_POLICY}else{&p.context.policy_identity},i64::try_from(count).map_err(|_| LibraryError::Database(rusqlite::Error::InvalidQuery))?,integrity(&p.context,language,reveal,count)])?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        c.execute_batch("ROLLBACK TO catalog_count_publish; RELEASE catalog_count_publish")?;
        return Err(error);
    }
    c.execute_batch("RELEASE catalog_count_publish")?;
    Ok(true)
}
#[cfg(test)]
#[path = "catalog_counts_tests.rs"]
mod tests;
