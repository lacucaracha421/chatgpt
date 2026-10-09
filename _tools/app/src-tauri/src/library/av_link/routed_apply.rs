//! Applying a server inbox candidate through the Collections authority outbox.
//!
//! The chosen work, artwork, person and operation ids are fixed once, before anything is
//! sent, and kept in a durable progress row. The commands themselves are queued in ONE local
//! transaction (`enqueue_av_inbox_apply`), so after a crash the outbox simply continues; only
//! the final `POST /{id}/applied` acknowledgement is retried, and choices are never reapplied.
use super::{
    models::*,
    provider::normalize_code,
    routed::{note_json, parse_detail, server_json, InboxServer, ProgressMap},
    *,
};
use crate::library::collection_authority::{
    enqueue_av_inbox_apply, AvInboxCreditPlan, AvInboxPlan, AvInboxSurfacePlan,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Mutex};

const APPLY_PREFIX: &str = "avInbox:apply:";
/// Acknowledgement refusals that mean "the server does not know our work yet".
const ACK_GIVE_UP: i64 = 6;
const DONE_KEEP_DAYS: i64 = 7;
/// Items being applied right now (library root + inbox id): keeps the tick from resuming a
/// row whose user-initiated apply is still talking to the server.
static APPLYING: Mutex<std::collections::BTreeSet<String>> =
    Mutex::new(std::collections::BTreeSet::new());
struct ApplyGuard(String);
impl ApplyGuard {
    fn claim(key: String) -> Option<Self> {
        APPLYING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.clone())
            .then_some(Self(key))
    }
}
impl Drop for ApplyGuard {
    fn drop(&mut self) {
        APPLYING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.0);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Progress {
    pub inbox_id: String,
    pub code: String,
    /// `preparing` (plan fixed, nothing queued) -> `queued` (all commands in the outbox)
    /// -> `acking` (every command accepted) -> `done`; `blocked`/`failed` stop the sequence.
    pub state: String,
    pub plan: AvInboxPlan,
    pub split: Split,
    /// The cover-set revision the user saw, for an existing destination.
    #[serde(default)]
    pub expected_revision: Option<String>,
    #[serde(default)]
    pub operations: Vec<String>,
    #[serde(default)]
    pub ack_attempts: i64,
    #[serde(default)]
    pub prepare_attempts: u32,
    #[serde(default)]
    pub prepare_retry_at: i64,
    #[serde(default)]
    pub ack_retry_at: i64,
    #[serde(default)]
    pub error: Option<String>,
    pub updated_at: String,
}

pub(super) fn progress_key(id: &str) -> String {
    format!("{APPLY_PREFIX}{id}")
}
pub(super) fn read_progress(c: &Connection, id: &str) -> Result<Option<Progress>, AvError> {
    note_json(c, &progress_key(id))
}
/// Compare-and-set prevents a stale reader from replacing a newer apply sequence.
pub(super) fn write_progress(
    c: &Connection,
    expected: Option<&Progress>,
    progress: &mut Progress,
) -> Result<(), AvError> {
    progress.updated_at = chrono::Utc::now().to_rfc3339();
    let value = serde_json::to_string(progress).map_err(|_| AvError::Invalid)?;
    let changed = match expected {
        None => c.execute(
            "INSERT OR IGNORE INTO notes_state(key,value) VALUES(?1,?2)",
            params![progress_key(&progress.inbox_id), value],
        )?,
        Some(prior) => c.execute(
            "UPDATE notes_state SET value=?2 WHERE key=?1 AND json_extract(value,'$.state')=?3 AND json_extract(value,'$.updatedAt')=?4 AND coalesce(json_extract(value,'$.operations'),'[]')=?5",
            params![progress_key(&progress.inbox_id), value, prior.state, prior.updated_at,
                serde_json::to_string(&prior.operations).map_err(|_| AvError::Invalid)?],
        )?,
    };
    if changed != 1 {
        return Err(AvError::Stale);
    }
    Ok(())
}
pub(super) fn discard_progress(c: &Connection, prior: &Progress) -> Result<(), AvError> {
    let changed = c.execute(
        "DELETE FROM notes_state WHERE key=?1 AND json_extract(value,'$.state')=?2 AND json_extract(value,'$.updatedAt')=?3 AND coalesce(json_extract(value,'$.operations'),'[]')=?4",
        params![progress_key(&prior.inbox_id), prior.state, prior.updated_at,
            serde_json::to_string(&prior.operations).map_err(|_| AvError::Invalid)?],
    )?;
    if changed != 1 {
        return Err(AvError::Stale);
    }
    Ok(())
}
pub(super) fn all_progress(c: &Connection) -> Result<ProgressMap, AvError> {
    let rows = c
        .prepare("SELECT value FROM notes_state WHERE key LIKE 'avInbox:apply:%'")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .iter()
        .filter_map(|raw| serde_json::from_str::<Progress>(raw).ok())
        .map(|p| (p.inbox_id.clone(), p))
        .collect::<BTreeMap<_, _>>())
}

enum Operations {
    Pending,
    Accepted,
    Blocked,
    Failed,
}
fn operations_state(c: &Connection, operations: &[String]) -> Result<Operations, AvError> {
    let mut all_accepted = true;
    let mut blocked = false;
    for operation in operations {
        let state: Option<String> = c
            .query_row(
                "SELECT state FROM collection_authority_outbox WHERE operation_id=?1",
                [operation],
                |r| r.get(0),
            )
            .optional()?;
        match state.as_deref() {
            Some("accepted") => {}
            Some("pending") => all_accepted = false,
            Some("blocked") => {
                blocked = true;
                all_accepted = false;
            }
            // Refused (or vanished): the sequence cannot complete on its own.
            _ => return Ok(Operations::Failed),
        }
    }
    Ok(if all_accepted {
        Operations::Accepted
    } else if blocked {
        Operations::Blocked
    } else {
        Operations::Pending
    })
}

fn transient(error: &AvError) -> bool {
    matches!(
        error,
        AvError::Library(
            LibraryError::CloudRequestUnavailable | LibraryError::CloudRequestTimedOut
        ) | AvError::Inbox("av_inbox_busy" | "av_inbox_unavailable", _)
    )
}

fn trimmed(value: &str) -> Value {
    let value = value.trim();
    if value.is_empty() {
        Value::Null
    } else {
        json!(value)
    }
}

impl Library {
    pub(crate) fn apply_av_link_routed(
        &self,
        id: &str,
        request: ApplyRequest,
    ) -> Result<ApplyResult, AvError> {
        self.apply_av_link_routed_with(&self.av_inbox_session()?, id, request)
    }

    pub(crate) fn apply_av_link_routed_with(
        &self,
        server: &impl InboxServer,
        id: &str,
        request: ApplyRequest,
    ) -> Result<ApplyResult, AvError> {
        uuid::Uuid::parse_str(id).map_err(|_| AvError::Invalid)?;
        apply::validate_fields(&request.fields)?;
        if request.performers.len() + request.directors.len() > 100
            || request.collection_id.is_some() == request.new_collection_name.is_some()
        {
            return Err(AvError::Invalid);
        }
        let _lane = ApplyGuard::claim(format!("{}|{id}", self.root().display())).ok_or(
            AvError::Inbox("av_inbox_applying", "이미 적용 중인 품번이에요."),
        )?;
        let mut salvage: Option<String> = None;
        {
            let c = self.connection()?;
            if let Some(progress) = read_progress(&c, id)? {
                match progress.state.as_str() {
                    "failed" | "preparing" => {
                        if progress.plan.is_new {
                            let created = progress.operations.first().is_some_and(|op| {
                                c.query_row(
                                    "SELECT state='accepted' FROM collection_authority_outbox WHERE operation_id=?1",
                                    [op],
                                    |r| r.get::<_, bool>(0),
                                )
                                .unwrap_or(false)
                            });
                            if created {
                                salvage = Some(progress.plan.work_id.clone());
                            }
                        }
                        discard_progress(&c, &progress)?
                    }
                    _ => {
                        return Err(AvError::Inbox(
                            "av_inbox_applying",
                            "이미 적용 중인 품번이에요.",
                        ))
                    }
                }
            }
        }
        let detail = server_json(server.request(
            "GET",
            &format!("/v1/av-inbox/{id}"),
            None,
            super::routed::MAX_LIST_BYTES * 3,
        )?)?;
        let parsed = parse_detail(&detail)?;
        let code = parsed.inbox["normalizedCode"]
            .as_str()
            .ok_or(AvError::Invalid)?
            .to_owned();
        let mut progress = self.build_progress(id, &request, &parsed, &code, salvage.as_deref())?;
        write_progress(&*self.connection()?, None, &mut progress)?;
        let work = progress.plan.work_id.clone();
        match self.prepare_and_queue(server, progress) {
            Ok(_) => {}
            Err(error) => {
                // Nothing was queued: the user can change the choice and apply again.
                let c = self.connection()?;
                if let Some(prior) = read_progress(&c, id)? {
                    if prior.state == "preparing" && prior.operations.is_empty() {
                        discard_progress(&c, &prior)?;
                    }
                }
                return Err(error);
            }
        }
        let c = self.connection()?;
        Ok(ApplyResult {
            covers: super::super::av_artwork::cover_set(&c, &work)?,
            collection_id: work,
        })
    }

    pub(super) fn build_progress(
        &self,
        id: &str,
        request: &ApplyRequest,
        parsed: &super::routed::ServerCandidate,
        code: &str,
        salvage: Option<&str>,
    ) -> Result<Progress, AvError> {
        let c = self.connection()?;
        // A refused earlier attempt may already have created the work: continue with it
        // instead of creating a second one.
        let target = request.collection_id.as_deref().or(salvage.filter(|work| {
            c.query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1 AND type='av')",
                [work],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false)
        }));
        let (work_id, is_new, name) = match target {
            Some(target) => {
                super::super::av_collection::require_av(&c, target)?;
                (target.to_owned(), false, String::new())
            }
            None => {
                let requested = request.new_collection_name.as_deref().unwrap_or("").trim();
                let name = if requested.is_empty() {
                    code
                } else {
                    requested
                };
                (uuid::Uuid::new_v4().to_string(), true, name.to_owned())
            }
        };
        let mut fields = json!({});
        for (key, value) in [
            ("titleJa", &request.fields.title_ja),
            ("releaseDate", &request.fields.release_date),
            ("maker", &request.fields.maker),
            ("label", &request.fields.label),
            ("series", &request.fields.series),
        ] {
            if let Some(value) = value {
                fields[key] = trimmed(value);
            }
        }
        if let Some(genres) = &request.fields.genres {
            fields["genres"] = json!(genres.iter().map(|g| g.trim()).collect::<Vec<_>>());
        }
        // The server acknowledges only a work that carries this code.
        let stored: Option<String> = if is_new {
            None
        } else {
            c.query_row(
                "SELECT product_code FROM collection_av_details WHERE collection_id=?1",
                [&work_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten()
        };
        match stored.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            None => fields["productCode"] = json!(code),
            Some(raw) if normalize_code(raw).as_deref() == Some(code) => {}
            Some(_) => return Err(AvError::Inbox(
                "av_inbox_code_mismatch",
                "품번이 다른 컬렉션에는 연결할 수 없어요. 새 컬렉션을 만들거나 품번을 고쳐 주세요.",
            )),
        }
        let expected_revision = if is_new {
            None
        } else if request.collection_id.is_some() {
            Some(request.expected_revision.clone().ok_or(AvError::Invalid)?)
        } else {
            Some(super::super::av_artwork::cover_set(&c, &work_id)?.revision)
        };
        let any_candidate = [
            request.surfaces.front,
            request.surfaces.spine,
            request.surfaces.back,
        ]
        .contains(&SurfaceChoice::Candidate);
        if any_candidate && (request.split.x1 > request.split.x2 || request.split.x2 > parsed.width)
        {
            return Err(AvError::Invalid);
        }
        let mut surfaces = Vec::new();
        for (surface, choice) in [
            ("front", request.surfaces.front),
            ("spine", request.surfaces.spine),
            ("back", request.surfaces.back),
        ] {
            match choice {
                SurfaceChoice::Keep => {}
                SurfaceChoice::Clear => surfaces.push(AvInboxSurfacePlan {
                    surface: surface.into(),
                    action: "clear".into(),
                    artwork_id: None,
                    manifest: None,
                }),
                SurfaceChoice::Candidate => surfaces.push(AvInboxSurfacePlan {
                    surface: surface.into(),
                    action: "candidate".into(),
                    artwork_id: Some(uuid::Uuid::new_v4().to_string()),
                    manifest: None,
                }),
            }
        }
        let mut created: BTreeMap<String, String> = BTreeMap::new();
        let mut credits = Vec::new();
        for (role, choices, allowed) in [
            (
                "performer",
                &request.performers,
                parsed
                    .movie
                    .actresses
                    .iter()
                    .map(|p| p.name.as_str())
                    .collect::<Vec<_>>(),
            ),
            (
                "director",
                &request.directors,
                parsed.movie.directors.iter().map(String::as_str).collect(),
            ),
        ] {
            let mut seen_names = std::collections::BTreeSet::new();
            let mut seen_people = std::collections::BTreeSet::new();
            for choice in choices {
                let name = choice.name_ja();
                if !allowed.contains(&name) || !seen_names.insert(name.to_owned()) {
                    return Err(AvError::Invalid);
                }
                let (person_id, display_name) = match choice {
                    PersonChoice::Link { person_id, .. } => {
                        let known: bool = c.query_row(
                            "SELECT EXISTS(SELECT 1 FROM collection_people WHERE id=?1)",
                            [person_id],
                            |r| r.get(0),
                        )?;
                        if !known {
                            return Err(AvError::Invalid);
                        }
                        (person_id.clone(), None)
                    }
                    PersonChoice::New { display_name, .. } => {
                        let display_name = display_name.trim();
                        if display_name.is_empty() || display_name.chars().count() > 120 {
                            return Err(AvError::Invalid);
                        }
                        let id = created
                            .entry(name.to_owned())
                            .or_insert_with(|| uuid::Uuid::new_v4().to_string())
                            .clone();
                        (id, Some(display_name.to_owned()))
                    }
                };
                if !seen_people.insert(person_id.clone()) {
                    return Err(AvError::Invalid);
                }
                credits.push(AvInboxCreditPlan {
                    role: role.into(),
                    name_ja: name.into(),
                    person_id,
                    display_name,
                });
            }
        }
        Ok(Progress {
            inbox_id: id.into(),
            code: code.into(),
            state: "preparing".into(),
            plan: AvInboxPlan {
                work_id,
                is_new,
                name,
                fields,
                surfaces,
                credits,
            },
            split: request.split.clone(),
            expected_revision,
            operations: vec![],
            ack_attempts: 0,
            prepare_attempts: 0,
            prepare_retry_at: 0,
            ack_retry_at: 0,
            error: None,
            updated_at: String::new(),
        })
    }

    /// Prepare server artwork once, then queue every command in one transaction.
    fn prepare_and_queue(
        &self,
        server: &impl InboxServer,
        mut progress: Progress,
    ) -> Result<Progress, AvError> {
        let prior = progress.clone();
        let wanted: Vec<&str> = progress
            .plan
            .surfaces
            .iter()
            .filter(|s| s.action == "candidate" && s.manifest.is_none())
            .map(|s| s.surface.as_str())
            .collect();
        if !wanted.is_empty() {
            let body = json!({"x1":progress.split.x1,"x2":progress.split.x2,"surfaces":wanted});
            let answer = server_json(server.request(
                "POST",
                &format!("/v1/av-inbox/{}/artwork", progress.inbox_id),
                Some(&body),
                super::routed::MAX_LIST_BYTES,
            )?)?;
            let items = answer["items"].as_array().ok_or(AvError::Invalid)?;
            if items.len() != wanted.len() {
                return Err(AvError::Invalid);
            }
            for surface in &mut progress.plan.surfaces {
                if surface.action != "candidate" || surface.manifest.is_some() {
                    continue;
                }
                let item = items
                    .iter()
                    .find(|item| item["surface"] == surface.surface.as_str())
                    .ok_or(AvError::Invalid)?;
                surface.manifest = Some(item.clone());
            }
            write_progress(&*self.connection()?, Some(&prior), &mut progress)?;
        }
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let current = read_progress(&tx, &progress.inbox_id)?.ok_or(AvError::Stale)?;
        if current.state != "preparing" || !current.operations.is_empty() {
            return Err(AvError::Stale);
        }
        progress = current.clone();
        if let Some(expected) = &progress.expected_revision {
            let revision =
                super::super::av_artwork::cover_set(&tx, &progress.plan.work_id)?.revision;
            if &revision != expected {
                return Err(AvError::Stale);
            }
        }
        progress.operations = enqueue_av_inbox_apply(&tx, &progress.inbox_id, &progress.plan)?;
        progress.state = "queued".into();
        write_progress(&tx, Some(&current), &mut progress)?;
        tx.commit()?;
        Ok(progress)
    }

    /// One pass over unfinished applies: resume a crashed preparation, follow the outbox,
    /// and acknowledge to the server once every command is accepted. Never reapplies.
    pub(crate) fn resume_av_inbox_applies(
        &self,
        server: &impl InboxServer,
        now: i64,
    ) -> Result<(), AvError> {
        let rows = all_progress(&*self.connection()?)?;
        self.resume_av_inbox_rows(server, now, rows)?;
        self.prune_av_inbox_progress()
    }

    // The snapshot only identifies rows to visit. Ownership must precede reading state.
    pub(super) fn resume_av_inbox_rows(
        &self,
        server: &impl InboxServer,
        now: i64,
        rows: ProgressMap,
    ) -> Result<(), AvError> {
        for id in rows.keys() {
            let Some(_lane) = ApplyGuard::claim(format!("{}|{id}", self.root().display())) else {
                continue;
            };
            let Some(progress) = read_progress(&*self.connection()?, id)? else {
                continue;
            };
            match progress.state.as_str() {
                "preparing"
                    if progress.operations.is_empty() && progress.prepare_retry_at <= now =>
                {
                    if let Err(error) = self.prepare_and_queue(server, progress) {
                        // Preparation may have saved a manifest. Never write from the snapshot.
                        let c = self.connection()?;
                        let Some(prior) = read_progress(&c, id)? else {
                            continue;
                        };
                        if prior.state != "preparing" || !prior.operations.is_empty() {
                            continue;
                        }
                        let mut next = prior.clone();
                        if transient(&error) {
                            next.prepare_retry_at =
                                now + (15_i64 << next.prepare_attempts.min(5)).min(300);
                            next.prepare_attempts = next.prepare_attempts.saturating_add(1);
                        } else {
                            next.state = "failed".into();
                            next.error = Some("resumeRefused".into());
                            eprintln!("av-inbox: resumed apply for {id} was refused");
                        }
                        write_progress(&c, Some(&prior), &mut next)?;
                    }
                }
                "queued" | "blocked" | "acking" => self.follow_apply(server, progress, now)?,
                _ => {}
            }
        }
        Ok(())
    }

    fn follow_apply(
        &self,
        server: &impl InboxServer,
        mut progress: Progress,
        now: i64,
    ) -> Result<(), AvError> {
        let state = operations_state(&*self.connection()?, &progress.operations)?;
        let next = match state {
            Operations::Failed => "failed",
            Operations::Blocked => "blocked",
            Operations::Pending => "queued",
            Operations::Accepted => "acking",
        };
        if next != progress.state {
            let prior = progress.clone();
            progress.state = next.into();
            if next == "failed" {
                progress.error = Some("commandRefused".into());
            }
            write_progress(&*self.connection()?, Some(&prior), &mut progress)?;
        }
        if next != "acking" || progress.ack_retry_at > now {
            return Ok(());
        }
        let id = progress.inbox_id.clone();
        let body = json!({"workId": progress.plan.work_id});
        let response = match server.request(
            "POST",
            &format!("/v1/av-inbox/{id}/applied"),
            Some(&body),
            super::routed::MAX_LIST_BYTES * 3,
        ) {
            Ok(response) => response,
            Err(error) => {
                self.schedule_ack_retry(&mut progress, now, false)?;
                return if matches!(error, AvError::Library(LibraryError::CloudUnauthorized)) {
                    Err(error)
                } else {
                    Ok(())
                };
            }
        };
        match response.status {
            200 => self.finish_apply(progress),
            401 | 403 => Err(LibraryError::CloudUnauthorized.into()),
            404 => self.schedule_ack_retry(&mut progress, now, false),
            409 => {
                let code = super::routed::refusal_code_of(&response.bytes);
                match code.as_deref() {
                    // Applied elsewhere or no longer a candidate: nothing is left to acknowledge.
                    Some("avInboxStateConflict" | "avInboxCandidateUnavailable") => {
                        self.finish_apply(progress)
                    }
                    _ => self.schedule_ack_retry(&mut progress, now, true),
                }
            }
            _ => self.schedule_ack_retry(&mut progress, now, false),
        }
    }

    fn schedule_ack_retry(
        &self,
        progress: &mut Progress,
        now: i64,
        counts_toward_failure: bool,
    ) -> Result<(), AvError> {
        let prior = progress.clone();
        if counts_toward_failure {
            progress.ack_attempts += 1;
        }
        progress.ack_retry_at = now + (15_i64 << progress.ack_attempts.clamp(0, 6)).min(600);
        if progress.ack_attempts >= ACK_GIVE_UP {
            // The server never saw a matching work; let the user look at the item again.
            progress.state = "failed".into();
            progress.error = Some("avInboxWorkMismatch".into());
        }
        write_progress(&*self.connection()?, Some(&prior), progress)
    }

    fn finish_apply(&self, mut progress: Progress) -> Result<(), AvError> {
        let prior = progress.clone();
        progress.state = "done".into();
        let c = self.connection()?;
        write_progress(&c, Some(&prior), &mut progress)?;
        c.execute(
            "DELETE FROM notes_state WHERE key=?1",
            [format!("avInbox:item:{}", progress.inbox_id)],
        )?;
        Ok(())
    }

    fn prune_av_inbox_progress(&self) -> Result<(), AvError> {
        let c = self.connection()?;
        let cutoff = chrono::Utc::now() - chrono::Duration::days(DONE_KEEP_DAYS);
        for (id, progress) in all_progress(&c)? {
            let old = chrono::DateTime::parse_from_rfc3339(&progress.updated_at)
                .is_ok_and(|at| at < cutoff);
            if progress.state == "done" && old {
                discard_progress(&c, &progress)?;
                c.execute(
                    "DELETE FROM notes_state WHERE key LIKE 'avInbox:op:%' AND value=?1",
                    [&id],
                )?;
            }
        }
        Ok(())
    }
}

/// When an unfinished apply or the server cycle next needs the tick.
pub(super) fn routed_due_at(c: &Connection, restricted: bool) -> Result<Option<i64>, AvError> {
    let now = chrono::Utc::now().timestamp();
    let mut due = vec![Library::mirror_due_at(c, restricted)?];
    if let Some(migration) = Library::migration_due_at(c)? {
        due.push(migration);
    }
    for progress in all_progress(c)?.values() {
        due.push(match progress.state.as_str() {
            "preparing" => progress.prepare_retry_at,
            "queued" => match operations_state(c, &progress.operations)? {
                Operations::Pending => now + 5,
                _ => 0,
            },
            // A blocked head waits for the user; look again only occasionally.
            "blocked" => match operations_state(c, &progress.operations)? {
                Operations::Blocked => now + 30,
                _ => 0,
            },
            "acking" => progress.ack_retry_at,
            _ => continue,
        });
    }
    Ok(due.into_iter().min())
}
