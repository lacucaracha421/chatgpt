use super::{catalog_group_query, catalog_provider::CatalogProvider, models::*, Library};
use serde_json::{json,Value};

#[test]
fn mobile_catalog_shared_python_parity_fixture_uses_real_group_query() {
    let data:Value=serde_json::from_str(include_str!("../../../../../tests/fixtures/mobile-catalog-v1.json")).unwrap();
    let temp=tempfile::tempdir().unwrap();
    let library=Library::open(temp.path()).unwrap();
    let connection=library.connection().unwrap();
    connection.execute_batch(data["setup"].as_str().unwrap()).unwrap();
    for case in data["queries"].as_array().unwrap(){
        let language=match case["language"].as_str().unwrap(){"korean"=>Some(CatalogLanguage::Korean),"japanese"=>Some(CatalogLanguage::Japanese),_=>None};
        let mut query=CatalogSearchQuery {provider:CatalogProvider::KHentai,language,reveal_blocked:case["revealBlocked"].as_bool().unwrap(),text:case["text"].as_str().unwrap().into(),sort:CatalogSort::Latest,scope:if case["scope"]=="bookmarked"{CatalogScope::Bookmarked}else{CatalogScope::All},page:0,page_size:40};
        let (rows,count)=catalog_group_query::select_groups(&connection,&query).unwrap();
        let actual:Vec<_>=rows.iter().map(|r|json!([r.group_id,r.representative_id,r.version_count,r.has_bookmarked_version])).collect();
        assert_eq!(json!(actual),case["expected"],"case {case}");
        assert_eq!(count,actual.len() as u64);
        for sort in [CatalogSort::Latest,CatalogSort::Views,CatalogSort::HotDay,CatalogSort::HotWeek,CatalogSort::HotMonth]{
            query.sort=sort;query.page=0;query.page_size=1;
            let (_,sort_count)=catalog_group_query::select_groups(&connection,&query).unwrap();
            let mut ids=Vec::new();
            for page in 0..sort_count+1 {query.page=page as u32;let(rows,n)=catalog_group_query::select_groups(&connection,&query).unwrap();assert_eq!(n,sort_count);ids.extend(rows.into_iter().map(|r|r.group_id));}
            ids.sort();ids.dedup();assert_eq!(ids.len() as u64,sort_count);
        }
    }
    for text in data["invalid"].as_array().unwrap(){assert!(super::catalog_query::parse(text.as_str().unwrap()).is_err());}
}

#[test]
fn mobile_catalog_export_reads_existing_preparation_without_source_writes() {
    use std::io::Read;
    let data:Value=serde_json::from_str(include_str!("../../../../../tests/fixtures/mobile-catalog-v1.json")).unwrap();
    let temp=tempfile::tempdir().unwrap();
    let library=Library::open(temp.path()).unwrap();
    std::fs::create_dir_all(temp.path().join("catalogs")).unwrap();
    {
        let connection=library.connection().unwrap();
        connection.execute("ATTACH DATABASE ? AS catalog",[temp.path().join("catalogs/kdata.db").to_string_lossy().as_ref()]).unwrap();
        connection.execute_batch(data["setup"].as_str().unwrap().strip_prefix("ATTACH ':memory:' AS catalog;").unwrap()).unwrap();
        connection.execute_batch("UPDATE catalog.Works SET Rating=4.5 WHERE Id=1; INSERT INTO catalog.CrawlState VALUES('lakomics.catalog.contentRevision','fixture-export'); INSERT INTO online_catalog_group_state VALUES('kHentai','strong-lineage-v1+review-v1:fixture-export',1,'now',NULL);").unwrap();
    }
    let before=std::fs::read(temp.path().join("catalogs/kdata.db")).unwrap();
    let users_before=super::mobile_catalog::user_snapshot(&library.connection().unwrap()).unwrap();
    let events = std::sync::Mutex::new(Vec::new());
    let mut exported=library.export_mobile_catalog_snapshot_with_progress(&|event| events.lock().unwrap().push(event)).unwrap();
    let events = events.into_inner().unwrap();
    assert_eq!(events.last().unwrap().total, Some(events.last().unwrap().completed));
    assert_eq!(events.last().unwrap().phase, "preparing");
    let mut output=String::new();exported.file.read_to_string(&mut output).unwrap();
    let records:Vec<Value>=output.lines().map(|s|serde_json::from_str(s).unwrap()).collect();
    assert_eq!(records[0]["value"]["counts"]["work"],7);
    assert_eq!(records.iter().filter(|r|r["kind"]=="member").count(),7);
    assert_eq!(records.iter().find(|r|r["kind"]=="work"&&r["value"]["Id"]==1).unwrap()["value"]["Rating"],json!(4.5));
    assert_eq!(exported.users,users_before);
    assert_eq!(super::mobile_catalog::user_snapshot(&library.connection().unwrap()).unwrap(),users_before);
    assert_eq!(std::fs::read(temp.path().join("catalogs/kdata.db")).unwrap(),before);
    assert!(!output.contains("library.sqlite"));
    // Optional isolated cross-runtime handoff, never a source or production path.
    if let Some(path)=std::env::var_os("LAKOMICS_CATALOG_TEST_EXPORT") {
        let destination=std::path::PathBuf::from(path);
        assert!(destination.is_dir());
        std::fs::write(destination.join("catalog.ndjson"),output).unwrap();
        std::fs::write(destination.join("users.json"),serde_json::to_vec(&exported.users).unwrap()).unwrap();
        std::fs::write(destination.join("digest.txt"),exported.content_digest).unwrap();
    }
}
