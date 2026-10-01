//! Desired-state pin delivery and a bounded full snapshot under the bookmark fence.
use super::{error::LibraryError, manga_index::MangaIndexIdentity, Library};
use crate::cloud::client::{CloudClient, SyncAuthorityDomain};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub(crate) const DOMAIN: &str = "manga-index-pins";
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PinState {
    #[serde(flatten)]
    pub identity: MangaIndexIdentity,
    pub desired_state: bool,
    pub entity_revision: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PinSnapshot {
    pub library_id: String,
    pub epoch: i64,
    pub contract_version: i64,
    pub revision: i64,
    pub items: Vec<PinState>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PinResult {
    pub library_id: String,
    pub epoch: i64,
    pub contract_version: i64,
    pub revision: i64,
    #[serde(flatten)]
    pub state: PinState,
}
pub(crate) enum PinReply {
    Applied(PinResult),
    Conflict(PinState),
}
#[derive(Clone, Debug)]
struct Intent {
    identity: MangaIndexIdentity,
    desired: bool,
    operation: String,
    epoch: i64,
    base_revision: i64,
    created: String,
}
#[derive(Default)]
pub(crate) struct PinSyncOutcome {
    pub changed: bool,
    pub sent: bool,
}

fn entries(c: &Connection) -> Result<Vec<Intent>, LibraryError> {
    let mut q = c.prepare("SELECT kind,namespace,value,label,desired_state,operation_id,epoch,base_revision,created_at FROM manga_index_pin_outbox ORDER BY created_at,operation_id")?;
    let rows = q
        .query_map([], |r| {
            Ok(Intent {
                identity: MangaIndexIdentity {
                    kind: r.get(0)?,
                    namespace: r.get(1)?,
                    value: r.get(2)?,
                    label: r.get(3)?,
                },
                desired: r.get(4)?,
                operation: r.get(5)?,
                epoch: r.get(6)?,
                base_revision: r.get(7)?,
                created: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
fn project(
    c: &Connection,
    row: &MangaIndexIdentity,
    desired: bool,
    created: &str,
) -> Result<(), LibraryError> {
    if desired {
        c.execute("INSERT INTO manga_index_pins VALUES(?1,?2,?3,?4,?5) ON CONFLICT(kind,namespace,value) DO UPDATE SET label=excluded.label,created_at=excluded.created_at", params![row.kind,row.namespace,row.value,row.label,created])?;
    } else {
        c.execute(
            "DELETE FROM manga_index_pins WHERE kind=?1 AND namespace=?2 AND value=?3",
            params![row.kind, row.namespace, row.value],
        )?;
    }
    Ok(())
}
fn overlay(c: &Connection) -> Result<(), LibraryError> {
    for intent in entries(c)? {
        project(c, &intent.identity, intent.desired, &intent.created)?;
    }
    Ok(())
}
fn record(c: &Connection, row: &PinState, epoch: i64) -> Result<(), LibraryError> {
    c.execute("INSERT INTO manga_index_pin_revisions VALUES(?1,?2,?3,?4,?5) ON CONFLICT(kind,namespace,value) DO UPDATE SET epoch=excluded.epoch,revision=excluded.revision WHERE epoch<>excluded.epoch OR revision<=excluded.revision", params![row.identity.kind,row.identity.namespace,row.identity.value,epoch,row.entity_revision])?;
    Ok(())
}
pub(super) fn enqueue(
    c: &Connection,
    row: &MangaIndexIdentity,
    desired: bool,
) -> Result<(), LibraryError> {
    let (epoch, base) = c.query_row("SELECT epoch,revision FROM manga_index_pin_revisions WHERE kind=?1 AND namespace=?2 AND value=?3", params![row.kind,row.namespace,row.value], |r| Ok((r.get::<_, i64>(0)?,r.get::<_, i64>(1)?))).optional()?.unwrap_or((0,0));
    let now = chrono::Utc::now().to_rfc3339();
    project(c, row, desired, &now)?;
    c.execute("INSERT INTO manga_index_pin_outbox VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(kind,namespace,value) DO UPDATE SET label=excluded.label,desired_state=excluded.desired_state,operation_id=excluded.operation_id,epoch=excluded.epoch,base_revision=excluded.base_revision,created_at=excluded.created_at", params![row.kind,row.namespace,row.value,row.label,desired,uuid::Uuid::new_v4().to_string(),epoch,base,now])?;
    super::authority_pass::note_local_work();
    Ok(())
}

fn validate_snapshot(
    snapshot: &PinSnapshot,
    library_id: &str,
    epoch: i64,
) -> Result<(), LibraryError> {
    if snapshot.library_id != library_id
        || snapshot.epoch != epoch
        || snapshot.contract_version != 1
        || snapshot.revision < 0
        || snapshot.items.len() > 4096
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    let mut seen = BTreeSet::new();
    for row in &snapshot.items {
        super::manga_index::validate_identity(&row.identity)
            .map_err(|_| LibraryError::InvalidCloudResponse)?;
        if row.entity_revision < 0
            || row.entity_revision > snapshot.revision
            || (row.desired_state && row.created_at.as_deref().is_none_or(str::is_empty))
            || !seen.insert((
                &row.identity.kind,
                &row.identity.namespace,
                &row.identity.value,
            ))
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
    }
    Ok(())
}
impl Library {
    fn apply_pin_snapshot(
        &self,
        snapshot: &PinSnapshot,
        library_id: &str,
        epoch: i64,
    ) -> Result<bool, LibraryError> {
        validate_snapshot(snapshot, library_id, epoch)?;
        let mut c = self.connection()?;
        let t = c.transaction()?;
        let previous: Option<(String, i64, i64)> = t
            .query_row(
                "SELECT library_id,epoch,revision FROM manga_index_pin_sync WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if previous
            .as_ref()
            .is_some_and(|(id, e, r)| id == library_id && *e == epoch && *r > snapshot.revision)
        {
            return Ok(false);
        }
        let before = pin_rows(&t)?;
        t.execute("DELETE FROM manga_index_pins", [])?;
        t.execute("DELETE FROM manga_index_pin_revisions", [])?;
        for row in &snapshot.items {
            record(&t, row, epoch)?;
            project(
                &t,
                &row.identity,
                row.desired_state,
                row.created_at.as_deref().unwrap_or(""),
            )?;
        }
        overlay(&t)?;
        let changed = before != pin_rows(&t)?;
        t.execute("INSERT INTO manga_index_pin_sync VALUES(1,?1,?2,?3) ON CONFLICT(singleton) DO UPDATE SET library_id=excluded.library_id,epoch=excluded.epoch,revision=excluded.revision",params![library_id,epoch,snapshot.revision])?;
        t.commit()?;
        Ok(changed)
    }
    pub(crate) fn sync_manga_index_pins_with(
        &self,
        client: &CloudClient,
        token: &str,
        domain: &SyncAuthorityDomain,
    ) -> Result<PinSyncOutcome, LibraryError> {
        self.sync_pins_using(
            domain,
            || client.manga_index_pin_snapshot(&domain.library_id, domain.epoch, token),
            |identity, command| client.manga_index_pin_command(identity, command, token),
        )
    }
    fn sync_pins_using(
        &self,
        domain: &SyncAuthorityDomain,
        mut read: impl FnMut() -> Result<PinSnapshot, LibraryError>,
        mut send: impl FnMut(&MangaIndexIdentity, &serde_json::Value) -> Result<PinReply, LibraryError>,
    ) -> Result<PinSyncOutcome, LibraryError> {
        if domain.library_id != self.library_id()? || domain.epoch < 1 {
            return Err(LibraryError::CatalogBookmarkAuthorityMismatch);
        }
        if domain.contract_version != 1 {
            return Err(LibraryError::CatalogBookmarkContractUnsupported);
        }
        let mut outcome = PinSyncOutcome::default();
        let current: Option<(i64,i64)> = self.connection()?.query_row("SELECT epoch,revision FROM manga_index_pin_sync WHERE singleton=1 AND library_id=?1",[&domain.library_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let pending = {
            let c = self.connection()?;
            entries(&c)?
        };
        if pending.is_empty() && current == Some((domain.epoch, domain.cursor)) {
            return Ok(outcome);
        }
        let snapshot = match read() {
            Ok(value) => value,
            Err(LibraryError::CatalogBookmarkSyncRejected(404 | 405)) => return Ok(outcome),
            Err(e) => return Err(e),
        };
        outcome.changed |= self.apply_pin_snapshot(&snapshot, &domain.library_id, domain.epoch)?;
        for mut intent in pending {
            if intent.epoch != domain.epoch {
                let old_operation = intent.operation.clone();
                intent.epoch = domain.epoch;
                intent.base_revision = snapshot
                    .items
                    .iter()
                    .find(|r| {
                        r.identity.kind == intent.identity.kind
                            && r.identity.namespace == intent.identity.namespace
                            && r.identity.value == intent.identity.value
                    })
                    .map_or(0, |r| r.entity_revision);
                intent.operation = uuid::Uuid::new_v4().to_string();
                self.connection()?.execute("UPDATE manga_index_pin_outbox SET epoch=?1,base_revision=?2,operation_id=?3 WHERE operation_id=?4",params![intent.epoch,intent.base_revision,intent.operation,old_operation])?;
            }
            for attempt in 0..2 {
                // A user action may supersede a queued intent while network IO is in flight.
                if !self.connection()?.query_row(
                    "SELECT EXISTS(SELECT 1 FROM manga_index_pin_outbox WHERE operation_id=?1)",
                    [&intent.operation],
                    |r| r.get::<_, bool>(0),
                )? {
                    break;
                }
                let command = serde_json::json!({"libraryId":domain.library_id,"epoch":intent.epoch,"contractVersion":1,"operationId":intent.operation,"expectedRevision":intent.base_revision,"desiredState":intent.desired,"value":intent.identity.value,"label":intent.identity.label});
                match send(&intent.identity, &command)? {
                    PinReply::Applied(result) => {
                        if result.library_id != domain.library_id
                            || result.epoch != domain.epoch
                            || result.contract_version != 1
                            || result.state.identity.kind != intent.identity.kind
                            || result.state.identity.namespace != intent.identity.namespace
                            || result.state.identity.value != intent.identity.value
                            || (intent.desired
                                && result.state.identity.label != intent.identity.label)
                            || result.state.desired_state != intent.desired
                            || result.state.entity_revision < intent.base_revision
                            || result.revision < result.state.entity_revision
                        {
                            return Err(LibraryError::InvalidCloudResponse);
                        }
                        self.confirm_pin_intent(&intent, &result.state)?;
                        outcome.sent = true;
                        break;
                    }
                    PinReply::Conflict(row) => {
                        if row.identity.kind != intent.identity.kind
                            || row.identity.namespace != intent.identity.namespace
                            || row.identity.value != intent.identity.value
                            || row.entity_revision < 0
                        {
                            return Err(LibraryError::InvalidCloudResponse);
                        }
                        if row.desired_state == intent.desired
                            && (!intent.desired || row.identity.label == intent.identity.label)
                        {
                            self.confirm_pin_intent(&intent, &row)?;
                            outcome.sent = true;
                            break;
                        }
                        let old = intent.operation.clone();
                        intent.operation = uuid::Uuid::new_v4().to_string();
                        intent.base_revision = row.entity_revision;
                        self.connection()?.execute("UPDATE manga_index_pin_outbox SET operation_id=?1,base_revision=?2 WHERE operation_id=?3",params![intent.operation,intent.base_revision,old])?;
                        if attempt == 1 {
                            break;
                        }
                    }
                }
            }
        }
        if outcome.sent {
            // A lost old acknowledgement may be older than a snapshot already read.
            // Always rematerialize the newest authority under any remaining intent.
            let latest = read()?;
            outcome.changed |=
                self.apply_pin_snapshot(&latest, &domain.library_id, domain.epoch)?;
            // Retiring a local overlay can change the UI even at an equal server cursor.
            outcome.changed = true;
        }
        Ok(outcome)
    }
    fn confirm_pin_intent(&self, intent: &Intent, row: &PinState) -> Result<(), LibraryError> {
        let mut c = self.connection()?;
        let t = c.transaction()?;
        record(&t, row, intent.epoch)?;
        t.execute(
            "DELETE FROM manga_index_pin_outbox WHERE operation_id=?1",
            [&intent.operation],
        )?;
        // The materialized table still includes the just-retired local overlay.
        // A failed final read must not leave an equal-cursor status skipping it
        // forever. Keep the adoption fence, but require a fresh snapshot next pass.
        t.execute(
            "UPDATE manga_index_pin_sync SET revision=-1 WHERE singleton=1",
            [],
        )?;
        t.commit()?;
        Ok(())
    }
}
fn pin_rows(c: &Connection) -> Result<Vec<(String, String, String, String, String)>, LibraryError> {
    let mut q = c.prepare(
        "SELECT kind,namespace,value,label,created_at FROM manga_index_pins ORDER BY kind,namespace,value",
    )?;
    let rows = q
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
#[cfg(test)]
#[path = "manga_index_sync_tests.rs"]
mod tests;
