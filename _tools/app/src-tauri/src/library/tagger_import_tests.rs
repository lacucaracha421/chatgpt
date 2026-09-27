use crate::library::{
    auto_tags::{AutoTagEdit, AutoTagSource},
    characters::tests::Fixture,
};
use rusqlite::{params, Connection};

#[test]
fn tagger_import_replaces_both_sources_keeps_edits_and_rolls_back_invalid_extension() {
    let f = Fixture::new();
    let t = f.ready("A");
    let path = f.temp.path().join("tags.sqlite");
    let c = Connection::open(&path).unwrap();
    c.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
        INSERT INTO meta VALUES('format','lakomics-auto-tags'),('version','1'),('model','pixai-v1.0'),('tagger_review_version','1');
        CREATE TABLE vocabulary(tag TEXT PRIMARY KEY,category TEXT);
        INSERT INTO vocabulary VALUES('alice','character'),('series','copyright'),('artist','artist'),('hair','general');
        CREATE TABLE asset_tags(asset_id TEXT,tag TEXT,score REAL);
        INSERT INTO asset_tags VALUES('asset-5','alice',0.2),('asset-5','series',0.2),('asset-5','artist',0.2),('asset-5','hair',0.9),('absent','hair',0.8);
        CREATE TABLE character_scores(asset_id TEXT,source TEXT,tag TEXT,score REAL);
        INSERT INTO character_scores VALUES('asset-5','pixai','alice',0.2),('asset-5','canary','alice',0.15);
        CREATE TABLE tagger_assets(asset_id TEXT,source TEXT);
        INSERT INTO tagger_assets VALUES('asset-5','pixai'),('asset-5','canary'),('asset-6','pixai'),('asset-6','canary'),('absent','canary');
        CREATE TABLE tagger_vocabulary(source TEXT,tag TEXT);
        INSERT INTO tagger_vocabulary VALUES('pixai','alice'),('canary','alice');
        CREATE TABLE target_tags(target_id TEXT,tag TEXT);").unwrap();
    c.execute("INSERT INTO target_tags VALUES(?1,'alice')", [&t.id])
        .unwrap();
    c.execute(
        "INSERT INTO target_tags VALUES('other-library-target','alice')",
        [],
    )
    .unwrap();
    let summary = f.library.import_auto_tags(&path).unwrap();
    assert_eq!(summary.skipped_assets, 1);
    f.library
        .edit_asset_auto_tag("asset-5", "hair", AutoTagEdit::Remove)
        .unwrap();
    f.library
        .edit_asset_auto_tag("asset-6", "artist", AutoTagEdit::Add)
        .unwrap();
    c.execute("UPDATE character_scores SET score=0.9", [])
        .unwrap();
    f.library.import_auto_tags(&path).unwrap();
    let db = f.library.connection().unwrap();
    for (table, count) in [
        ("asset_tagger_character_scores", 2),
        ("asset_tagger_coverage", 4),
        ("character_target_tagger_tags", 1),
        ("tagger_character_vocabulary", 2),
    ] {
        assert_eq!(
            db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            count
        );
    }
    for (tag, category) in [
        ("alice", "character"),
        ("series", "copyright"),
        ("artist", "artist"),
    ] {
        assert_eq!(
            db.query_row(
                "SELECT category FROM auto_tag_vocabulary WHERE tag=?1",
                [tag],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            category
        );
    }
    drop(db);
    assert!(!f
        .library
        .asset_auto_tags("asset-5")
        .unwrap()
        .tags
        .iter()
        .any(|t| t.tag == "hair"));
    assert!(f
        .library
        .asset_auto_tags("asset-6")
        .unwrap()
        .tags
        .iter()
        .any(|t| t.tag == "artist" && t.source == AutoTagSource::Added));
    // Missing coverage/vocabulary is not allowed to turn into silent zero evidence.
    c.execute("DELETE FROM tagger_assets WHERE source='canary'", [])
        .unwrap();
    assert!(f.library.import_auto_tags(&path).is_err());
    assert_eq!(f.library.connection().unwrap().query_row("SELECT score FROM asset_tagger_character_scores WHERE asset_id='asset-5' AND source='canary'",[],|r|r.get::<_,f64>(0)).unwrap(),0.9);
    // A v0.9 import replaces raw review evidence as well, with no stale canary left.
    c.execute("DELETE FROM meta WHERE key='tagger_review_version'", [])
        .unwrap();
    c.execute("UPDATE meta SET value='pixai-v0.9' WHERE key='model'", [])
        .unwrap();
    f.library.import_auto_tags(&path).unwrap();
    assert_eq!(
        f.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM asset_tagger_character_scores",
                params![],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert!(!f
        .library
        .asset_auto_tags("asset-5")
        .unwrap()
        .tags
        .iter()
        .any(|t| t.tag == "hair"));
}
