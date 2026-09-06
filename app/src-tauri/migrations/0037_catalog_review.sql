-- Rebuildable suggestions are separate from authoritative anchor decisions.
CREATE TABLE online_catalog_review_candidates (
    left_anchor TEXT NOT NULL,
    right_anchor TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    evidence TEXT NOT NULL,
    PRIMARY KEY(left_anchor, right_anchor),
    CHECK(left_anchor < right_anchor)
) WITHOUT ROWID;
CREATE TABLE online_catalog_review_decisions (
    left_anchor TEXT NOT NULL,
    right_anchor TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('confirm','falsePositive','split')),
    evidence TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    PRIMARY KEY(left_anchor, right_anchor),
    CHECK(left_anchor < right_anchor)
) WITHOUT ROWID;
-- These tables are intentionally kHentai-only. Anchors use 007A provider-work
-- identities; no foreign keys to replaceable catalog or derived membership.
PRAGMA user_version = 37;
