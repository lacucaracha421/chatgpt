WITH RECURSIVE
scope(series_id,id) AS (
 SELECT classification_id,classification_id FROM character_series
 UNION SELECT s.series_id,c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id
),
pairs AS MATERIALIZED (
 SELECT s.tag,s.asset_id,
 MAX(CASE WHEN s.source='pixai' THEN s.score ELSE 0 END) AS pixai,
 MAX(CASE WHEN s.source='canary' THEN s.score ELSE 0 END) AS canary
 FROM asset_tagger_character_scores s
 JOIN assets a ON a.id=s.asset_id AND a.status='normal' AND a.media_kind='image'
 WHERE s.score>=0.85
 AND EXISTS(SELECT 1 FROM tagger_character_vocabulary v WHERE v.source=s.source AND v.tag=s.tag)
 AND NOT EXISTS(SELECT 1 FROM character_target_tagger_tags t WHERE t.tag=s.tag)
 AND NOT EXISTS(SELECT 1 FROM character_suggestion_ignored_tags i WHERE i.tag=s.tag)
 GROUP BY s.tag,s.asset_id
),
ranked AS (
 SELECT *,ROW_NUMBER() OVER(PARTITION BY tag ORDER BY MAX(pixai,canary) DESC,asset_id) AS rank FROM pairs
),
counts AS (
 SELECT tag,COUNT(*) AS images,SUM(pixai>=0.85 AND canary>=0.85) AS both_count,
 SUM(pixai>=0.85) AS pixai_count,SUM(canary>=0.85) AS canary_count,
 json_group_array(asset_id) FILTER(WHERE rank<=4) AS samples
 FROM ranked GROUP BY tag HAVING COUNT(*)>=?1
),
folder_counts AS (
 SELECT p.tag,s.series_id,COUNT(DISTINCT p.asset_id) AS inside_count
 FROM pairs p JOIN asset_classifications ac ON ac.asset_id=p.asset_id
 JOIN scope s ON s.id=ac.classification_id
 GROUP BY p.tag,s.series_id
),
folders AS (
 SELECT *,ROW_NUMBER() OVER(PARTITION BY tag ORDER BY inside_count DESC,series_id) AS rank FROM folder_counts
)
SELECT c.tag,c.images,c.both_count,c.pixai_count,c.canary_count,c.samples,
 f.series_id,e.name,COALESCE(f.inside_count,0)
 FROM counts c LEFT JOIN folders f ON f.tag=c.tag AND f.rank=1
 LEFT JOIN classification_entries e ON e.id=f.series_id
 ORDER BY c.images DESC,c.tag
