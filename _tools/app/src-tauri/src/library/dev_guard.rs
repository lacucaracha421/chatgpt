//! Development-build guard against silently migrating a real library.
//!
//! # The incident this exists for
//!
//! A `cargo tauri dev` watcher had the active production library open. When the source
//! tree gained a new migration, the watcher rebuilt, restarted the app, and the app
//! migrated the production database during startup — with no operator decision anywhere
//! in the chain. The only thing that had prevented it earlier was that no one had added
//! a migration while that watcher happened to be running.
//!
//! Relying on the operator to remember which library a watcher has open is not a control.
//! This module is: a development build refuses to migrate a library that is not declared
//! as a development library, and the refusal is a normal error the operator can read.
//!
//! # What is and is not guarded
//!
//! Guarded: a **development build** migrating an **existing** database forward. That is
//! exactly the shape that damaged production — the tree changed, so the schema version
//! advanced, so the next app start rewrote a database someone cared about.
//!
//! Not guarded:
//!
//! * **Release builds.** Shipping a release that needs a migration is the intended path;
//!   blocking it would break real upgrades.
//! * **Creating a new library** (`user_version` 0). There is no existing data to
//!   protect, and dev and tests create libraries constantly.
//! * **An already-current database.** No migration is pending, so there is nothing to
//!   decide.
//!
//! # Opting in
//!
//! A library is declared a development library by a marker file in its root
//! ([`DEV_LIBRARY_MARKER`]). The marker is per-library and durable, so a genuine dev
//! library keeps working without per-run friction while a production library stays
//! protected until someone deliberately marks it. [`ALLOW_ENV`] is the per-run escape
//! hatch for a one-off migration of a library that has not been marked.

use std::path::Path;

/// Marker file that declares a library root as a development library.
///
/// Presence means "migrating this library from a development build is expected", so the
/// guard steps aside. It is deliberately a file inside the library rather than a global
/// setting: the decision belongs to the library being migrated, not to the machine.
pub(crate) const DEV_LIBRARY_MARKER: &str = ".lakomics-dev-library";

/// Environment variable that opts a single run in, for a library that is not marked.
///
/// Required to be set to a non-empty value other than `0`/`false`, so an inherited empty
/// variable cannot silently enable it.
pub(crate) const ALLOW_ENV: &str = "LAKOMICS_ALLOW_DEV_MIGRATION";

/// Why a development build may not migrate this library.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DevMigrationDecision {
    /// Proceed: not a development build, nothing to migrate, or explicitly allowed.
    Allowed(AllowReason),
    /// Refuse: a development build would migrate an undeclared library.
    Blocked,
}

/// Why the migration was allowed, so callers and tests can name the specific rule that
/// applied instead of only observing "it did not block".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AllowReason {
    /// A release build. Production upgrades are the intended path.
    ReleaseBuild,
    /// No schema is being applied, so no decision is needed.
    NoMigrationPending,
    /// Creating a library that does not exist yet: there is no data to protect.
    NewLibrary,
    /// The library root declares itself a development library.
    DeclaredDevLibrary,
    /// The operator opted this run in through the environment.
    EnvironmentOptIn,
}

/// Decide whether a development build may migrate `existing_version` to `schema_version`.
///
/// A pure function of its inputs — no environment read, no filesystem write — so the
/// whole policy is exercised directly by tests. The call site supplies the environment
/// value and whether the marker exists, which keeps the one unavoidable side effect
/// (reading the marker and the variable) outside the rules being tested.
pub(crate) fn dev_migration_decision(
    dev_build: bool,
    existing_version: i64,
    schema_version: i64,
    declared_dev_library: bool,
    environment_opt_in: bool,
) -> DevMigrationDecision {
    // A release build is never blocked: shipping migrations is how upgrades work.
    if !dev_build {
        return DevMigrationDecision::Allowed(AllowReason::ReleaseBuild);
    }
    // Nothing is being applied, so there is nothing to decide.
    if existing_version >= schema_version {
        return DevMigrationDecision::Allowed(AllowReason::NoMigrationPending);
    }
    // `user_version` 0 is a library being created. Guarding it would block every fresh
    // dev and test library while protecting no existing data.
    if existing_version == 0 {
        return DevMigrationDecision::Allowed(AllowReason::NewLibrary);
    }
    if declared_dev_library {
        return DevMigrationDecision::Allowed(AllowReason::DeclaredDevLibrary);
    }
    if environment_opt_in {
        return DevMigrationDecision::Allowed(AllowReason::EnvironmentOptIn);
    }
    DevMigrationDecision::Blocked
}

/// Whether the environment value opts a run in.
///
/// Empty and the common false spellings do not, so an exported-but-empty variable cannot
/// be mistaken for consent.
pub(crate) fn environment_opt_in(value: Option<&str>) -> bool {
    match value {
        None => false,
        Some(value) => {
            let value = value.trim();
            !value.is_empty() && !value.eq_ignore_ascii_case("0") && !value.eq_ignore_ascii_case("false")
        }
    }
}

/// Whether `root` declares itself a development library.
pub(crate) fn is_declared_dev_library(root: &Path) -> bool {
    root.join(DEV_LIBRARY_MARKER).is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact production-damaging shape: a dev build, an existing older database.
    #[test]
    fn a_dev_build_cannot_migrate_an_undeclared_existing_library() {
        assert_eq!(
            dev_migration_decision(true, 86, 87, false, false),
            DevMigrationDecision::Blocked
        );
    }

    /// Release upgrades must keep working, or the guard breaks the product it protects.
    #[test]
    fn a_release_build_is_never_blocked() {
        assert_eq!(
            dev_migration_decision(false, 86, 87, false, false),
            DevMigrationDecision::Allowed(AllowReason::ReleaseBuild)
        );
    }

    #[test]
    fn creating_a_library_is_not_blocked() {
        // Dev and tests create fresh libraries constantly; there is no data to protect.
        assert_eq!(
            dev_migration_decision(true, 0, 87, false, false),
            DevMigrationDecision::Allowed(AllowReason::NewLibrary)
        );
    }

    #[test]
    fn an_already_current_library_is_not_blocked() {
        assert_eq!(
            dev_migration_decision(true, 87, 87, false, false),
            DevMigrationDecision::Allowed(AllowReason::NoMigrationPending)
        );
        // Older schema version than the database is also "nothing to apply".
        assert_eq!(
            dev_migration_decision(true, 90, 87, false, false),
            DevMigrationDecision::Allowed(AllowReason::NoMigrationPending)
        );
    }

    #[test]
    fn declaring_the_library_permits_a_dev_migration() {
        assert_eq!(
            dev_migration_decision(true, 86, 87, true, false),
            DevMigrationDecision::Allowed(AllowReason::DeclaredDevLibrary)
        );
    }

    #[test]
    fn the_environment_opts_a_single_run_in() {
        assert_eq!(
            dev_migration_decision(true, 86, 87, false, true),
            DevMigrationDecision::Allowed(AllowReason::EnvironmentOptIn)
        );
    }

    /// An exported-but-empty or false-valued variable is not consent.
    #[test]
    fn only_a_truthy_environment_value_is_opt_in() {
        assert!(!environment_opt_in(None));
        assert!(!environment_opt_in(Some("")));
        assert!(!environment_opt_in(Some("   ")));
        assert!(!environment_opt_in(Some("0")));
        assert!(!environment_opt_in(Some("false")));
        assert!(!environment_opt_in(Some("FALSE")));
        assert!(environment_opt_in(Some("1")));
        assert!(environment_opt_in(Some("yes")));
    }

    /// The marker makes a library a dev library; its absence does not.
    #[test]
    fn the_marker_file_declares_a_development_library() {
        let temp = tempfile::tempdir().unwrap();
        assert!(!is_declared_dev_library(temp.path()));
        std::fs::write(temp.path().join(DEV_LIBRARY_MARKER), b"dev\n").unwrap();
        assert!(is_declared_dev_library(temp.path()));
    }

    /// A directory named like the marker must not count, or a stray directory would
    /// silently disable the guard.
    #[test]
    fn a_directory_named_like_the_marker_does_not_declare_a_dev_library() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join(DEV_LIBRARY_MARKER)).unwrap();
        assert!(!is_declared_dev_library(temp.path()));
    }
}
