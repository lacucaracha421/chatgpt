    use super::*;
    #[test]
    fn container_migration_133_to_134_preserves_folders_without_defaults() {
        let mut c=Connection::open_in_memory().unwrap();
        migrate_to_latest(&mut c,0).unwrap();
        c.execute_batch("DROP TRIGGER classification_container_top_level;
          DROP TRIGGER classification_container_move; DROP TRIGGER classification_container_empty;
          DROP TRIGGER classification_container_series; DROP TRIGGER classification_container_target;
          DROP TRIGGER classification_container_target_move; DROP TABLE classification_containers;
          PRAGMA user_version=133;
          INSERT INTO classification_entries(id,kind,name,created_at) VALUES('game','root','Games','now');").unwrap();
        migrate_to_latest(&mut c,133).unwrap();
        assert_eq!(c.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),SCHEMA_VERSION);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM classification_containers",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(c.query_row("SELECT name FROM classification_entries WHERE id='game'",[],|r|r.get::<_,String>(0)).unwrap(),"Games");
    }
