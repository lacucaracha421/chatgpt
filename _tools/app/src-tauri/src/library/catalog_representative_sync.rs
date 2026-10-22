//! Representative editions chosen on the tablet (parity U23; server contract
//! `server/lakomics-api/catalog_representatives.py`).
//!
//! The server has already republished the tablet's choice for mobile readers. This PC reads
//! the unacknowledged choices, applies each one like `CatalogEditionsDialog` does, and
//! acknowledges them, so its own catalog shows the choice and its next catalog publication
//! carries it. A choice for a group this catalog does not have yet is skipped (the server
//! refresh can know works the PC has not crawled). Runs in the catalog duplicate pass and,
//! unconditionally, before a manual catalog publication exports its user snapshot.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use super::{
    catalog_provider::CatalogProvider, error::LibraryError,
    models::CatalogGroupRepresentativeQuery, Library,
};
use crate::cloud::client::{CatalogRepresentativeChoice, CloudClient};

const PAGE_LIMIT: i64 = 100;
const MAX_PAGES: usize = 5;

/// Last acknowledged log position per endpoint, for the status-head gate. Memory only: after
/// a restart the first pass simply reads the (normally empty) pending list once.
static CURSORS: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(Default::default);

fn cursor(endpoint: &str) -> Option<i64> {
    CURSORS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(endpoint)
        .copied()
}

fn remember(endpoint: &str, sequence: i64) {
    CURSORS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(endpoint.to_owned(), sequence);
}

impl Library {
    /// Receive, apply and acknowledge pending tablet choices. `force` skips the status-head
    /// gate (the publication path must never miss a choice). Returns whether any applied.
    pub(crate) fn receive_catalog_representatives(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        endpoint: &str,
        force: bool,
    ) -> Result<bool, LibraryError> {
        use crate::cloud::status_watch::{log_due, unix_now, LogKind, LogPosition};
        if !force
            && !log_due(
                endpoint,
                LogKind::CatalogRepresentatives,
                LogPosition::cursor(cursor(endpoint)),
                None,
                unix_now(),
            )
        {
            return Ok(false);
        }
        let mut changed = false;
        for _ in 0..MAX_PAGES {
            let Some(page) = client.catalog_representatives_pending(publisher_token, PAGE_LIMIT)?
            else {
                return Ok(changed); // an older server without the route
            };
            let Some(last) = page.items.last().map(|item| item.sequence) else {
                remember(endpoint, page.last_sequence);
                break;
            };
            changed |= self.apply_catalog_representative_choices(&page.items)?;
            client.acknowledge_catalog_representatives(publisher_token, last)?;
            if !page.has_more {
                remember(endpoint, page.last_sequence);
                break;
            }
        }
        Ok(changed)
    }

    /// Apply choices in log order, so the latest choice for a group wins. Stops at the first
    /// error other than an unknown group, leaving the page unacknowledged for a retry.
    pub(crate) fn apply_catalog_representative_choices(
        &self,
        items: &[CatalogRepresentativeChoice],
    ) -> Result<bool, LibraryError> {
        let mut changed = false;
        for item in items {
            match self.set_catalog_group_representative(CatalogGroupRepresentativeQuery {
                provider: CatalogProvider::KHentai,
                group_id: item.group_id.clone(),
                selected_provider_work_id: item.selected_provider_work_id.clone(),
            }) {
                Ok(()) => changed = true,
                Err(LibraryError::OnlineCatalogWorkNotFound) => {
                    eprintln!("catalog representatives: a tablet choice names a group or edition this catalog lacks; skipped");
                }
                Err(error) => return Err(error),
            }
        }
        Ok(changed)
    }
}
