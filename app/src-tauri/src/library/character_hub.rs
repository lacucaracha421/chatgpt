//! Presentation and date-ordered navigation for registered series and characters.
use super::{
    characters::{Error, Result},
    models::AssetSummary,
    Library,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub classification_id: String,
    pub hero_asset_id: Option<String>,
    pub auto_classify: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseQuery {
    pub series_id: String,
    pub target_id: Option<String>,
    #[serde(default)]
    pub reference_target_id: Option<String>,
    pub after: Option<String>,
    pub limit: usize,
    #[serde(default)]
    pub all: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowsePage {
    pub items: Vec<AssetSummary>,
    pub next_cursor: Option<String>,
    pub total_count: u64,
}

pub(super) fn validate_art(connection: &Connection, id: &str) -> Result<()> {
    if !connection.query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1 AND status='normal' AND media_kind='image')", [id], |r| r.get::<_, bool>(0))? {
        return Err(Error::Invalid("정상 이미지에서 대표 이미지를 선택해 주세요."));
    }
    Ok(())
}
impl Library {
    pub fn character_series(&self) -> Result<Vec<Series>> {
        let connection = self.connection()?;
        let mut query = connection.prepare("SELECT classification_id,(SELECT a.id FROM assets a WHERE a.id=hero_asset_id AND a.status='normal'),auto_classify FROM character_series ORDER BY classification_id")?;
        let result = query
            .query_map([], |r| {
                Ok(Series {
                    classification_id: r.get(0)?,
                    hero_asset_id: r.get(1)?,
                    auto_classify: r.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(result)
    }
    pub fn save_character_series(&self, request: Series) -> Result<Series> {
        let connection = self.connection()?;
        if let Some(id) = &request.hero_asset_id {
            validate_art(&connection, id)?;
        }
        connection.execute("INSERT INTO character_series(classification_id,hero_asset_id,auto_classify) VALUES(?1,?2,?3)
          ON CONFLICT(classification_id) DO UPDATE SET hero_asset_id=excluded.hero_asset_id,auto_classify=excluded.auto_classify",
          params![request.classification_id,request.hero_asset_id,request.auto_classify])?;
        Ok(request)
    }
    pub fn browse_character_assets(&self, query: BrowseQuery) -> Result<BrowsePage> {
        if !(1..=200).contains(&query.limit) {
            return Err(Error::Invalid("조회 개수가 올바르지 않습니다."));
        }
        if let Some(id) = query.reference_target_id.as_ref().or(query.target_id.as_ref()).filter(|id| !id.is_empty()) {
            if self
                .get_character_target(id)?
                .series_classification_id
                .as_deref()
                != Some(query.series_id.as_str())
            {
                return Err(Error::Stale);
            }
        }
        let cursor: Option<(String, String)> = query
            .after
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?;
        let (ids, total) = {
            let connection = self.connection()?;
            let gallery_scope = "WITH RECURSIVE scope(id) AS (SELECT id FROM classification_entries WHERE id=?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id),
              ancestors(id,parent_id) AS (SELECT id,parent_id FROM classification_entries WHERE id=?1 UNION ALL SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id)
              SELECT a.id,a.collected_at FROM assets a WHERE a.status='normal'
              AND (EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope)) OR (?2 IS NOT NULL AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM ancestors WHERE parent_id IS NULL)) AND EXISTS(SELECT 1 FROM character_relations r WHERE r.asset_id=a.id AND r.target_id=?2)))
              AND ((?2 IS NOT NULL AND (EXISTS(SELECT 1 FROM character_relations r WHERE r.asset_id=a.id AND r.target_id=?2)
                OR EXISTS(SELECT 1 FROM character_references r WHERE r.asset_id=a.id AND r.target_id=?2)))
                OR (?2 IS NULL AND (?3 OR (NOT EXISTS(SELECT 1 FROM character_relations r JOIN character_targets t ON t.id=r.target_id WHERE r.asset_id=a.id AND t.series_classification_id=?1)
                AND NOT EXISTS(SELECT 1 FROM character_references r JOIN character_targets t ON t.id=r.target_id WHERE r.asset_id=a.id AND t.series_classification_id=?1)))))";
            let reference_scope = "WITH RECURSIVE scope(id) AS (SELECT id FROM classification_entries WHERE id=?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id)
              SELECT a.id,a.collected_at FROM assets a WHERE a.status='normal' AND a.media_kind='image'
              AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope))
              AND NOT EXISTS(SELECT 1 FROM character_relations r WHERE r.asset_id=a.id AND r.target_id<>?2)
              AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.asset_id=a.id AND r.target_id<>?2)
              AND (?3 OR (NOT EXISTS(SELECT 1 FROM character_relations r WHERE r.asset_id=a.id)
              AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.asset_id=a.id)))";
            let scope = if query.reference_target_id.is_some() { reference_scope } else { gallery_scope };
            let target_id = query.reference_target_id.as_ref().or(query.target_id.as_ref());
            let all = query.all;
            let total: i64 = connection.query_row(
                &format!("SELECT COUNT(*) FROM ({scope})"),
                params![query.series_id, target_id, all],
                |r| r.get(0),
            )?;
            let sql = format!("{scope} AND (?4 IS NULL OR (a.collected_at,a.id)<(?4,?5)) ORDER BY a.collected_at DESC,a.id DESC LIMIT ?6");
            let mut statement = connection.prepare(&sql)?;
            let ids = statement
                .query_map(
                    params![
                        query.series_id,
                        target_id,
                        all,
                        cursor.as_ref().map(|c| &c.0),
                        cursor.as_ref().map(|c| &c.1),
                        (query.limit + 1) as i64
                    ],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            (ids, total)
        };
        let next_cursor = if ids.len() > query.limit {
            let last = &ids[query.limit - 1];
            Some(serde_json::to_string(&(&last.1, &last.0))?)
        } else {
            None
        };
        let items = ids
            .iter()
            .take(query.limit)
            .map(|(id, _)| self.get_asset(id).map_err(Error::from))
            .collect::<Result<Vec<_>>>()?;
        Ok(BrowsePage {
            items,
            next_cursor,
            total_count: total as u64,
        })
    }
}

// A character only analyzes its registered series subtree.
pub(super) fn candidate_image(
    connection: &Connection,
    series: &str,
    id: &str,
) -> Result<(String, String)> {
    candidate_image_mode(connection, series, id, false)
}

pub(super) fn candidate_image_mode(
    connection: &Connection, series: &str, id: &str, automatic: bool,
) -> Result<(String, String)> {
    candidate_media_mode(connection, series, id, automatic, false)
}

// Direct human assignment accepts videos; recognition and references stay image-only.
pub(super) fn candidate_media_mode(
    connection: &Connection, series: &str, id: &str, automatic: bool, allow_video: bool,
) -> Result<(String, String)> {
    connection.query_row("WITH RECURSIVE scope(id) AS (SELECT id FROM classification_entries WHERE id=?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id),
      ancestors(id,parent_id) AS (SELECT id,parent_id FROM classification_entries WHERE id=?1 UNION ALL
      SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id)
      SELECT a.content_hash,a.relative_path FROM assets a WHERE a.id=?2 AND a.status='normal' AND (a.media_kind='image' OR (?4 AND a.media_kind='video'))
      AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND (ac.classification_id IN (SELECT id FROM scope) OR (?3 AND ac.classification_id IN (SELECT id FROM ancestors WHERE parent_id IS NULL))))",
      params![series,id,automatic,allow_video], |r| Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or(Error::Invalid("시리즈 폴더 안의 지원되는 자산을 선택해 주세요."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::characters::{tests::Fixture, DecisionKind, DecisionRequest, TargetDraft};
    #[test]
    fn presentation_preserves_recognition_and_gallery_pages_real_relations() {
        let f = Fixture::new();
        let target = f.ready("A");
        let saved = f
            .library
            .save_character_target(TargetDraft {
                id: Some(target.id.clone()),
                expected_revision: Some(target.revision),
                series_classification_id: target.series_classification_id.clone(),
                linked_classification_id: target.linked_classification_id.clone(),
                display_name: target.display_name.clone(),
                enabled: true,
                description: "설명".into(),
                thumbnail_asset_id: Some("asset-5".into()),
            })
            .unwrap();
        assert_eq!(saved.fingerprint, target.fingerprint);
        assert_eq!(saved.description, "설명");
        assert_eq!(saved.thumbnail_asset_id.as_deref(), Some("asset-5"));
        let query = |target_id, after| BrowseQuery {
            reference_target_id: None,
            series_id: f.series.clone(),
            target_id,
            after,
            limit: 2,
            all: false,
        };
        let unassigned = f
            .library
            .browse_character_assets(query(None, None))
            .unwrap();
        assert_eq!(unassigned.total_count, 1);
        assert_eq!(unassigned.items[0].id, "asset-5");
        let first = f
            .library
            .browse_character_assets(query(Some(target.id.clone()), None))
            .unwrap();
        assert_eq!(first.total_count, 5);
        assert_eq!(first.items.len(), 2);
        let second = f
            .library
            .browse_character_assets(query(Some(target.id.clone()), first.next_cursor))
            .unwrap();
        assert!(first
            .items
            .iter()
            .all(|a| second.items.iter().all(|b| a.id != b.id)));
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint,
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        assert_eq!(
            f.library
                .browse_character_assets(query(None, None))
                .unwrap()
                .total_count,
            0
        );
        assert_eq!(
            f.library
                .browse_character_assets(query(Some(target.id), None))
                .unwrap()
                .total_count,
            6
        );
        f.library
            .save_character_series(Series {
                classification_id: f.series.clone(),
                hero_asset_id: Some("asset-5".into()),
                auto_classify: true,
            })
            .unwrap();
        f.library
            .connection()
            .unwrap()
            .execute("UPDATE assets SET status='trash' WHERE id='asset-5'", [])
            .unwrap();
        assert!(f.library.character_series().unwrap()[0]
            .hero_asset_id
            .is_none());
        assert!(f
            .library
            .get_character_target(&saved.id)
            .unwrap()
            .thumbnail_asset_id
            .is_none());
    }
    #[test]
    fn ancestor_and_other_series_images_are_not_eligible() {
        let f = Fixture::new();
        let root: String = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT parent_id FROM classification_entries WHERE id=?1",
                [&f.series],
                |r| r.get(0),
            )
            .unwrap();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",
                [root],
            )
            .unwrap();
        assert!(candidate_image(&f.library.connection().unwrap(), &f.series, "asset-6").is_err());
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",
                [&f.outside],
            )
            .unwrap();
        assert!(candidate_image(&f.library.connection().unwrap(), &f.series, "asset-6").is_err());
    }
    #[test]
    fn reference_picker_excludes_other_characters_before_pagination() {
        let f = Fixture::new();
        let a = f.ready("Towa");
        let b = f.ready("New character");
        let b = f.library.replace_character_references(&b.id, b.revision, &[]).unwrap();
        f.library.record_character_decisions(DecisionRequest {
            target_id: a.id.clone(), expected_fingerprint: a.fingerprint.clone(),
            asset_ids: vec!["asset-5".into()], decision: DecisionKind::Accepted,
            baseline_fingerprint: None, scan_id: None,
        }).unwrap();
        f.library.connection().unwrap().execute("UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'", [&f.series]).unwrap();
        let query = |id: &str, after| BrowseQuery {
            series_id: f.series.clone(), target_id: None, reference_target_id: Some(id.into()),
            after, limit: 2, all: true,
        };
        let new = f.library.browse_character_assets(query(&b.id, None)).unwrap();
        assert_eq!(new.total_count, 1);
        assert_eq!(new.items[0].id, "asset-6");
        assert!(new.next_cursor.is_none());
        let own = f.library.browse_character_assets(query(&a.id, None)).unwrap();
        assert_eq!(own.total_count, 7);
        let unclassified = f.library.browse_character_assets(BrowseQuery { all: false, ..query(&a.id, None) }).unwrap();
        assert_eq!(unclassified.total_count, 1);
        let unsaved = f.library.browse_character_assets(query("", None)).unwrap();
        assert_eq!(unsaved.total_count, 1);
        let connection = f.library.connection().unwrap();
        assert!(validate_character_selection(&connection, &f.series, Some(&b.id), "asset-5").is_err());
        assert!(validate_character_selection(&connection, &f.series, None, "asset-0").is_err());
        assert!(validate_character_selection(&connection, &f.series, Some(&a.id), "asset-5").is_ok());
        assert!(validate_character_selection(&connection, &f.series, None, "asset-6").is_ok());
        drop(connection);
        assert!(f.library.replace_character_references_selection(&b.id, b.revision, &["asset-5".into()], true).is_err());
        assert!(f.library.get_character_target(&b.id).unwrap().references.is_empty());
        assert!(f.library.save_character_target_selection(super::super::characters::TargetDraft {
            id: None, expected_revision: None, series_classification_id: Some(f.series.clone()),
            linked_classification_id: None, display_name: "Unsaved".into(), description: String::new(),
            thumbnail_asset_id: Some("asset-5".into()), enabled: true,
        }, true).is_err());

        assert_eq!(own.items.len(), 2);
        assert!(own.next_cursor.is_some());
        let next = f.library.browse_character_assets(query(&a.id, own.next_cursor)).unwrap();
        assert!(next.items.iter().all(|i| own.items.iter().all(|o| o.id != i.id)));
    }

}

// The same eligibility rule protects thumbnail/reference saves if a concurrent decision changes ownership.
pub(super) fn validate_character_selection(connection: &Connection, series: &str, target: Option<&str>, asset: &str) -> Result<()> {
    super::characters::scoped_image(connection,series,asset)?;
    let excluded: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM character_relations WHERE asset_id=?1 AND (?2 IS NULL OR target_id<>?2)) OR EXISTS(SELECT 1 FROM character_references WHERE asset_id=?1 AND (?2 IS NULL OR target_id<>?2))", params![asset,target], |r| r.get(0))?;
    if excluded { return Err(Error::Invalid("다른 캐릭터에 등록된 이미지입니다. 선택을 다시 확인해 주세요.")); }
    Ok(())
}
