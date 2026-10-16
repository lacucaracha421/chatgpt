    //! The guard's *enforcement*, complementing `dev_guard`'s policy tests.
    //!
    //! These drive the real migration entry point, so they would fail if the policy were
    //! ever computed correctly but not consulted before migrating.
    use super::*;

    /// Build a library at an older schema version, as a real pre-migration library is.
    ///
    /// Uses the module's own `historical_schema` so the database is a genuine historical
    /// schema rather than today's schema with a stamped-back version: stamping alone would
    /// leave later tables present and the migration would then re-apply them.
    fn library_at_version(root: &Path, version: i64) {
        std::fs::create_dir_all(root).unwrap();
        // The pre-migration snapshot is written into `backups/`, exactly as the real
        // Library layout provides it.
        std::fs::create_dir_all(root.join("backups")).unwrap();
        let mut connection = open_database(&root.join("library.sqlite")).unwrap();
        super::tests::historical_schema(&mut connection, version as usize);
    }

    fn version_of(root: &Path) -> i64 {
        open_database(&root.join("library.sqlite"))
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }

    /// The production-damaging shape: a dev build, an existing older library, no opt-in.
    #[test]
    fn a_dev_build_refuses_to_migrate_an_undeclared_library_and_leaves_it_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        library_at_version(&root, SCHEMA_VERSION - 1);

        let error = initialize_database_with_dev_policy(&root.join("library.sqlite"), true, None)
            .unwrap_err();
        assert!(
            matches!(
                error,
                LibraryError::DevelopmentMigrationBlocked {
                    existing_version,
                    schema_version,
                    ..
                } if existing_version == SCHEMA_VERSION - 1 && schema_version == SCHEMA_VERSION
            ),
            "{error}"
        );
        // The refusal must be inert: a guard that blocks *after* migrating is worthless.
        assert_eq!(version_of(&root), SCHEMA_VERSION - 1);
    }

    /// A release build migrates normally: the guard must not break real upgrades.
    #[test]
    fn a_release_build_still_migrates_an_existing_library() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        library_at_version(&root, SCHEMA_VERSION - 1);

        initialize_database_with_dev_policy(&root.join("library.sqlite"), false, None).unwrap();
        assert_eq!(version_of(&root), SCHEMA_VERSION);
    }

    #[test]
    fn migration_prunes_history_only_after_a_verified_snapshot() {
        for fail_verification in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("library");
            library_at_version(&root, SCHEMA_VERSION - 1);
            let directory = root.join("backups");
            let old = (1..=4)
                .map(|day| {
                    let path = directory.join(format!(
                        "pre-migration-200008{day:02}-120000-v1-550e8400-e29b-41d4-a716-446655440000.sqlite"
                    ));
                    std::fs::write(&path, b"history").unwrap();
                    path
                })
                .collect::<Vec<_>>();
            let history = old.clone();
            let snapshot_directory = directory.clone();
            backup::set_before_verify_hook(move || {
                assert!(history.iter().all(|path| path.exists()));
                if fail_verification {
                    let new = std::fs::read_dir(snapshot_directory)
                        .unwrap()
                        .map(|entry| entry.unwrap().path())
                        .find(|path| !history.contains(path))
                        .unwrap();
                    std::fs::write(new, b"corrupt").unwrap();
                }
            });

            let result = initialize_database_with_dev_policy(
                &root.join("library.sqlite"), false, None,
            );

            let snapshots = std::fs::read_dir(directory)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            if fail_verification {
                assert!(result.is_err());
                assert_eq!(version_of(&root), SCHEMA_VERSION - 1);
                assert_eq!(snapshots.len(), old.len());
                for path in old {
                    assert_eq!(std::fs::read(path).unwrap(), b"history");
                }
            } else {
                assert!(result.is_ok());
                assert_eq!(version_of(&root), SCHEMA_VERSION);
                assert_eq!(snapshots.len(), 3);
                assert!(!old[0].exists());
                assert!(!old[1].exists());
                assert!(old[2].exists());
                assert!(old[3].exists());
                let new = snapshots.iter().find(|path| !old.contains(path)).unwrap();
                let snapshot = open_database(new).unwrap();
                assert_eq!(snapshot.pragma_query_value(None, "user_version", |row| {
                    row.get::<_, i64>(0)
                }).unwrap(), SCHEMA_VERSION - 1);
                assert_eq!(snapshot.pragma_query_value(None, "quick_check", |row| {
                    row.get::<_, String>(0)
                }).unwrap(), "ok");
            }
        }
    }

    /// Marking the library is the durable opt-in, and it must actually unblock.
    #[test]
    fn a_declared_development_library_migrates_in_a_dev_build() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        library_at_version(&root, SCHEMA_VERSION - 1);
        std::fs::write(
            root.join(super::super::dev_guard::DEV_LIBRARY_MARKER),
            b"dev\n",
        )
        .unwrap();

        initialize_database_with_dev_policy(&root.join("library.sqlite"), true, None).unwrap();
        assert_eq!(version_of(&root), SCHEMA_VERSION);
    }

    /// The per-run environment opt-in must also unblock, for a one-off unmarked migration.
    #[test]
    fn the_environment_opt_in_migrates_in_a_dev_build() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        library_at_version(&root, SCHEMA_VERSION - 1);

        initialize_database_with_dev_policy(&root.join("library.sqlite"), true, Some("1")).unwrap();
        assert_eq!(version_of(&root), SCHEMA_VERSION);
    }

    /// Creating a library must not be blocked: dev and tests do this constantly, and no
    /// existing data is at risk.
    #[test]
    fn creating_a_new_library_is_never_blocked_in_a_dev_build() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        std::fs::create_dir_all(&root).unwrap();

        initialize_database_with_dev_policy(&root.join("library.sqlite"), true, None).unwrap();
        assert_eq!(version_of(&root), SCHEMA_VERSION);
    }

    /// A database newer than this build must be a hard error, never a migration or a
    /// write. This is the cross-branch case: a library migrated by a branch that had a
    /// later schema must not be silently rewritten by an older build.
    #[test]
    fn a_newer_database_is_refused_rather_than_touched() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        library_at_version(&root, SCHEMA_VERSION - 1);
        let path = root.join("library.sqlite");
        {
            let connection = open_database(&path).unwrap();
            connection
                .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
                .unwrap();
        }
        let error = initialize_database_with_dev_policy(&path, false, None).unwrap_err();
        assert!(
            matches!(error, LibraryError::UnsupportedSchema(version) if version == SCHEMA_VERSION + 1),
            "{error}"
        );
        // The version must be untouched: a refusal that already rewrote the file would
        // defeat the point.
        assert_eq!(version_of(&root), SCHEMA_VERSION + 1);
    }

    /// A current library needs no decision, so a dev build opens it normally.
    #[test]
    fn an_already_current_library_opens_in_a_dev_build() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        library_at_version(&root, SCHEMA_VERSION);

        initialize_database_with_dev_policy(&root.join("library.sqlite"), true, None).unwrap();
        assert_eq!(version_of(&root), SCHEMA_VERSION);
    }
