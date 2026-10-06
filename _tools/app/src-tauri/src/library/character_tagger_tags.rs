//! User-owned unlink exclusions survive replacement of machine tag mappings.
use rusqlite::{params, Connection, TransactionBehavior};
use serde::Serialize;

use super::{
    characters::{Error, Result},
    Library,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedTag {
    pub tag: String,
    pub pending_recommendations: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagLinks {
    pub linked: Vec<LinkedTag>,
    pub excluded: Vec<String>,
}

// Candidates store aggregate scores, not a source tag. Reconstruct positive
// evidence from raw scores, retaining recommendations supported by other links.
// Suggestion merges also queue single-model recommendations, so either model's
// remaining positive evidence is sufficient to preserve a candidate.
// With no links left, no recommendation can still belong to this target.
// Vetoes are negative evidence and already-applied decisions are never undone.
const UNSUPPORTED: &str = "
 q.target_id=?1 AND q.reason='recommendation'
 AND (EXISTS(SELECT 1 FROM asset_tagger_character_scores s
             WHERE s.asset_id=q.asset_id AND s.tag=?2 AND s.score>=0.85)
      OR NOT EXISTS(SELECT 1 FROM character_target_tagger_tags m
                    WHERE m.target_id=?1 AND m.tag<>?2))
 AND NOT EXISTS(SELECT 1 FROM character_target_tagger_tags m
          JOIN asset_tagger_character_scores s ON s.tag=m.tag
          WHERE m.target_id=?1 AND m.tag<>?2 AND s.asset_id=q.asset_id
          AND s.score>=0.85)";

fn pending_count(c: &Connection, target: &str, tag: &str) -> Result<u64> {
    Ok(c.query_row(
        &format!("SELECT COUNT(*) FROM character_tagger_pending q WHERE {UNSUPPORTED}"),
        params![target, tag],
        |r| r.get::<_, i64>(0),
    )? as u64)
}

pub(super) fn explicitly_link(c: &Connection, target: &str, tag: &str) -> Result<()> {
    c.execute(
        "DELETE FROM character_target_tagger_tag_exclusions WHERE target_id=?1 AND tag=?2",
        params![target, tag],
    )?;
    c.execute(
        "INSERT OR IGNORE INTO character_target_tagger_tags(target_id,tag) VALUES(?1,?2)",
        params![target, tag],
    )?;
    Ok(())
}

impl Library {
    pub fn character_tagger_tags(&self, target_id: &str) -> Result<TagLinks> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        self.read_character_target(&tx, target_id)?;
        let tags = tx
            .prepare(
                "SELECT tag FROM character_target_tagger_tags WHERE target_id=?1 ORDER BY tag",
            )?
            .query_map([target_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let linked = tags
            .into_iter()
            .map(|tag| {
                Ok(LinkedTag {
                    pending_recommendations: pending_count(&tx, target_id, &tag)?,
                    tag,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let excluded = tx.prepare("SELECT tag FROM character_target_tagger_tag_exclusions WHERE target_id=?1 ORDER BY tag")?
            .query_map([target_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        tx.commit()?;
        Ok(TagLinks { linked, excluded })
    }

    pub fn unlink_character_tagger_tag(
        &self,
        target_id: &str,
        tag: &str,
        expected_pending: u64,
    ) -> Result<()> {
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.read_character_target(&tx, target_id)?;
        let linked: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM character_target_tagger_tags WHERE target_id=?1 AND tag=?2)", params![target_id, tag], |r| r.get(0))?;
        if !linked || pending_count(&tx, target_id, tag)? != expected_pending {
            return Err(Error::Stale);
        }
        tx.execute(
            &format!("DELETE FROM character_tagger_candidates AS q WHERE {UNSUPPORTED}"),
            params![target_id, tag],
        )?;
        tx.execute(
            "DELETE FROM character_target_tagger_tags WHERE target_id=?1 AND tag=?2",
            params![target_id, tag],
        )?;
        tx.execute("INSERT OR IGNORE INTO character_target_tagger_tag_exclusions(target_id,tag,created_at) VALUES(?1,?2,?3)", params![target_id, tag, chrono::Utc::now().to_rfc3339()])?;
        tx.commit()?;
        // WITHOUT ROWID: not reported by the update hook.
        self.character_changes.suggestion_inputs_changed();
        Ok(())
    }

    pub fn relink_character_tagger_tag(&self, target_id: &str, tag: &str) -> Result<()> {
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.read_character_target(&tx, target_id)?;
        let excluded: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM character_target_tagger_tag_exclusions WHERE target_id=?1 AND tag=?2)", params![target_id, tag], |r| r.get(0))?;
        if !excluded {
            return Err(Error::Stale);
        }
        explicitly_link(&tx, target_id, tag)?;
        tx.commit()?;
        self.character_changes.suggestion_inputs_changed();
        Ok(())
    }
}

#[cfg(test)]
#[path = "character_tagger_tags_tests.rs"]
mod tests;
