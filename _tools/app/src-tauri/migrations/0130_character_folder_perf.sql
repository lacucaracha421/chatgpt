-- Bounded suggestion evidence and character-folder membership lookup.
CREATE INDEX tagger_scores_suggestion_threshold
ON asset_tagger_character_scores(score,tag,asset_id,source) WHERE score>=0.85;
CREATE INDEX character_target_tagger_tags_by_tag ON character_target_tagger_tags(tag);
CREATE INDEX character_targets_by_linked_classification
ON character_targets(linked_classification_id) WHERE linked_classification_id IS NOT NULL;
PRAGMA user_version = 130;
