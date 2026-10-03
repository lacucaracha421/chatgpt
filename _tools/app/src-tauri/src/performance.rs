//! Machine-local budgets, fixed for the lifetime of the desktop process.
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Profile {
    #[default]
    Laptop,
    Main,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Budgets {
    pub similarity_workers: usize,
    pub similarity_auto_assets: usize,
    pub media_slots: [usize; 3],
    pub preview_cache_bytes: usize,
    pub s36_intra_threads: usize,
    pub s36_inter_threads: usize,
    pub reference_cache_bytes: usize,
    pub inbox_success_seconds: u64,
    pub live_book_fps: u32,
}

impl Profile {
    pub(crate) const fn budgets(self) -> Budgets {
        let main = matches!(self, Self::Main);
        Budgets {
            similarity_workers: if main { 4 } else { 2 },
            similarity_auto_assets: if main { 32 } else { 16 },
            media_slots: if main { [4, 4, 2] } else { [2, 2, 2] },
            preview_cache_bytes: if main { 128 * 1024 * 1024 } else { 64 * 1024 * 1024 },
            s36_intra_threads: if main { 4 } else { 2 },
            s36_inter_threads: 1,
            reference_cache_bytes: if main { 128 * 1024 * 1024 } else { 64 * 1024 * 1024 },
            inbox_success_seconds: if main { 300 } else { 3600 },
            live_book_fps: if main { 60 } else { 30 },
        }
    }
}
impl Budgets {
    pub(crate) fn indexing_workers(self, available: usize) -> usize {
        self.similarity_workers.min(available.max(1))
    }
}

static ACTIVE: OnceLock<Profile> = OnceLock::new();
pub(crate) fn budgets() -> Budgets {
    ACTIVE.get().copied().unwrap_or_default().budgets()
}
pub(crate) fn setup(path: &std::path::Path) -> Result<(), crate::library::error::LibraryError> {
    let profile = crate::library::machine_settings::performance(path)?;
    let _ = ACTIVE.set(profile);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    selected: Profile,
    active: Profile,
    budgets: Budgets,
}
#[tauri::command]
pub(crate) fn performance_profile(app: tauri::AppHandle, profile: Option<Profile>) -> Result<Status, String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("library-machine.json");
    if let Some(profile) = profile {
        crate::library::machine_settings::set_performance(&path, profile).map_err(|e| e.to_string())?;
    }
    Ok(Status {
        selected: crate::library::machine_settings::performance(&path).map_err(|e| e.to_string())?,
        active: ACTIVE.get().copied().unwrap_or_default(),
        budgets: budgets(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn laptop_matches_existing_limits_and_main_only_changes_local_budgets() {
        let laptop = Profile::Laptop.budgets();
        assert_eq!(laptop, Budgets {
            similarity_workers: 2, similarity_auto_assets: 16, media_slots: [2, 2, 2],
            preview_cache_bytes: 64 * 1024 * 1024, s36_intra_threads: 2, s36_inter_threads: 1,
            reference_cache_bytes: 64 * 1024 * 1024, inbox_success_seconds: 3600, live_book_fps: 30,
        });
        assert_eq!(Profile::Main.budgets(), Budgets {
            similarity_workers: 4, similarity_auto_assets: 32, media_slots: [4, 4, 2],
            preview_cache_bytes: 128 * 1024 * 1024, s36_intra_threads: 4, s36_inter_threads: 1,
            reference_cache_bytes: 128 * 1024 * 1024, inbox_success_seconds: 300, live_book_fps: 60,
        });
        for profile in [Profile::Laptop, Profile::Main] {
            let budgets = profile.budgets();
            assert_eq!(budgets.indexing_workers(0), 1);
            assert_eq!(budgets.indexing_workers(1), 1);
            assert_eq!(budgets.indexing_workers(3), budgets.similarity_workers.min(3));
            assert_eq!(budgets.indexing_workers(12), budgets.similarity_workers);
        }
    }
}
