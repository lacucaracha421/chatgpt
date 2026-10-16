//! Adapter to the existing incoming list, cancellation flags and durable landing pipeline.
use super::super::*;
use super::{
    http::Reply,
    server::{LanSink, Prepare},
    LanPeer,
};
use serde_json::json;
use std::{collections::HashMap, fs::OpenOptions, io::Write};

struct Session {
    request: Prepare,
    item: InboxItem,
    via: String,
    cancel: Arc<AtomicBool>,
    uploading: Mutex<()>,
}
pub(in crate::exchange) struct DirectSink {
    ready: Box<dyn Fn() -> Result<Ready, Reply> + Send + Sync>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}
type Ready = (Arc<crate::library::sync_hold::Gate>, PathBuf, PathBuf);
impl DirectSink {
    pub(in crate::exchange) fn new(app: AppHandle) -> Self {
        Self {
            ready: Box::new(move || {
                let context = context(&app).map_err(|_| Reply::error(503, "notReceiving"))?;
                let parts = lock()
                    .lan_parts
                    .clone()
                    .ok_or_else(|| Reply::error(503, "notReceiving"))?;
                let dir = save_dir(&app).ok_or_else(|| Reply::error(503, "notReceiving"))?;
                Ok((context.client.gate, parts, dir))
            }),
            sessions: Mutex::new(HashMap::new()),
        }
    }
    fn session(&self, peer: &LanPeer, id: &str) -> Result<Arc<Session>, Reply> {
        if lock().lan_cancelled.contains(id) {
            return Err(Reply::error(410, "cancelled"));
        }
        let session = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .cloned()
            .ok_or_else(|| Reply::error(422, "invalidRequest"))?;
        if session.request.from_device != peer.device_id {
            return Err(Reply::error(403, "deviceMismatch"));
        }
        if session.cancel.load(Ordering::Acquire) {
            return Err(Reply::error(410, "cancelled"));
        }
        Ok(session)
    }
    /// A finished or cancelled transfer needs no session: a repeated prepare is answered
    /// from the receipt ledger or the cancelled set.
    fn forget(&self, id: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(id);
    }
    fn ready(&self) -> Result<(Arc<crate::library::sync_hold::Gate>, PathBuf, PathBuf), Reply> {
        (self.ready)()
    }
}
fn local_error(error: ApiError) -> Reply {
    match error {
        ApiError::Corrupt => Reply::error(422, "digestMismatch"),
        ApiError::Cancelled => Reply::error(410, "cancelled"),
        _ => Reply::error(503, "notReceiving"),
    }
}
fn saved() -> Reply {
    Reply::ok(json!({"state":"saved"}))
}
fn matches_receipt(row: &Received, request: &Prepare) -> bool {
    row.from_device.as_deref() == Some(&request.from_device)
        && row.batch_id.as_deref() == Some(&request.batch_id)
        && row.size_bytes == request.size_bytes
        && row.sha256 == request.sha256
}
impl LanSink for DirectSink {
    fn peer(&self, pin: &str) -> Option<LanPeer> {
        let state = lock();
        state
            .stored
            .peers
            .iter()
            .find(|peer| peer.device_id != state.stored.device_id && peer.report.cert_sha256 == pin)
            .cloned()
    }
    fn info(&self) -> serde_json::Value {
        let receiving = self.ready().is_ok_and(|(gate, _, _)| !gate.held());
        let state = lock();
        json!({"protocol":1,"deviceId":state.stored.device_id,"name":state.self_name.clone().unwrap_or_else(device_name),"kind":"pc","receiving":receiving,"maxFileBytes":MAX_FILE_BYTES})
    }
    fn prepare(&self, peer: &LanPeer, request: Prepare, via: &str) -> Reply {
        let (gate, parts, dir) = match self.ready() {
            Ok(value) => value,
            Err(reply) => return reply,
        };
        let _permit = match gate.permit() {
            Ok(permit) => permit,
            Err(_) => return Reply::error(503, "notReceiving"),
        };
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut state = lock();
        if state.lan_cancelled.contains(&request.transfer_id) {
            return Reply::error(410, "cancelled");
        }
        if state
            .incoming
            .iter()
            .any(|row| row.item.transfer_id == request.transfer_id && !row.direct)
        {
            return Reply::error(409, "busy");
        }
        if let Some(row) = state.stored.ledger(&request.transfer_id).cloned() {
            if !matches_receipt(&row, &request) {
                return Reply::error(422, "invalidRequest");
            }
            if !row.publishing {
                return saved();
            }
            drop(state);
            if journaled(&row) == Journaled::Published {
                files::mark_downloaded(&row.path);
                let mut state = lock();
                let State { path, stored, .. } = &mut *state;
                return match record_receipt(stored, path.as_deref(), &request.transfer_id) {
                    Ok(()) => {
                        drop(state);
                        emit();
                        saved()
                    }
                    Err(_) => Reply::error(503, "notReceiving"),
                };
            }
            state = lock();
        }
        let session = if let Some(session) = sessions.get(&request.transfer_id) {
            if session.request != request {
                return Reply::error(422, "invalidRequest");
            }
            if !state
                .incoming
                .iter()
                .any(|row| row.item.transfer_id == request.transfer_id)
            {
                state.incoming.push(Incoming {
                    direct: true,
                    direct_active: false,
                    item: session.item.clone(),
                    done: 0,
                    failed: None,
                    cancel: session.cancel.clone(),
                });
            }
            session.clone()
        } else {
            let item = InboxItem {
                transfer_id: request.transfer_id.clone(),
                batch_id: Some(request.batch_id.clone()),
                from_device: Some(peer.device_id.clone()),
                from_name: Some(peer.name.clone()),
                created_at: Some(now_rfc3339()),
                file_name: request.file_name.clone(),
                size_bytes: request.size_bytes,
                sha256: request.sha256.clone(),
            };
            let session = Arc::new(Session {
                request: request.clone(),
                item: item.clone(),
                via: via.into(),
                cancel: Arc::new(AtomicBool::new(false)),
                uploading: Mutex::new(()),
            });
            state.incoming.push(Incoming {
                direct: true,
                direct_active: false,
                item,
                done: 0,
                failed: None,
                cancel: session.cancel.clone(),
            });
            sessions.insert(request.transfer_id.clone(), session.clone());
            session
        };
        drop(state);
        drop(sessions);
        let Ok(_upload) = session.uploading.try_lock() else {
            return Reply::error(409, "busy");
        };
        if let Err(_) = fs::create_dir_all(&parts).and_then(|_| fs::create_dir_all(&dir)) {
            return Reply::error(503, "notReceiving");
        }
        let part = files::part_path(
            &parts,
            &uuid::Uuid::parse_str(&request.transfer_id).unwrap(),
        );
        let mut offset = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if offset > request.size_bytes {
            if fs::remove_file(&part).is_err() {
                return Reply::error(503, "notReceiving");
            }
            offset = 0;
        }
        emit();
        Reply::ok(json!({"state":"upload","offset":offset.min(request.size_bytes)}))
    }
    fn upload(
        &self,
        peer: &LanPeer,
        id: &str,
        offset: u64,
        length: u64,
        body: &mut dyn Read,
    ) -> Reply {
        let session = match self.session(peer, id) {
            Ok(s) => s,
            Err(r) => return r,
        };
        let Ok(_upload) = session.uploading.try_lock() else {
            return Reply::error(409, "busy");
        };
        let (gate, parts, dir) = match self.ready() {
            Ok(value) => value,
            Err(reply) => return reply,
        };
        let _permit = match gate.permit() {
            Ok(p) => p,
            Err(_) => return Reply::error(503, "notReceiving"),
        };
        let ledger = {
            let mut state = lock();
            let ledger = state.stored.ledger(id).cloned();
            if ledger.as_ref().is_some_and(|row| !row.publishing) {
                return saved();
            }
            if let Some(row) = state
                .incoming
                .iter_mut()
                .find(|row| row.item.transfer_id == id)
            {
                if !row.direct {
                    return Reply::error(409, "busy");
                }
                row.direct_active = true;
            } else {
                state.incoming.push(Incoming {
                    direct: true,
                    direct_active: true,
                    item: session.item.clone(),
                    done: offset,
                    failed: None,
                    cancel: session.cancel.clone(),
                });
            }
            ledger
        };
        // A paused direct transfer may fall back to the server. Only an active body
        // owns the id; release that ownership on every return (including disconnect).
        struct Active<'a>(&'a str);
        impl Drop for Active<'_> {
            fn drop(&mut self) {
                if let Some(row) = lock()
                    .incoming
                    .iter_mut()
                    .find(|row| row.item.transfer_id == self.0 && row.direct)
                {
                    row.direct_active = false;
                }
            }
        }
        let _active = Active(id);
        let resume_at = ledger.filter(|row| row.publishing).map(|row| row.path);
        let part = files::part_path(&parts, &uuid::Uuid::parse_str(id).unwrap());
        let actual = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if offset != actual {
            return Reply(409, json!({"error":"offsetMismatch","offset":actual}));
        }
        if session.item.size_bytes.checked_sub(offset) != Some(length) {
            return Reply::error(422, "invalidRequest");
        }
        let result = (|| -> Result<(), ApiError> {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&part)
                .map_err(ApiError::Local)?;
            let mut done = offset;
            let mut buffer = [0; 64 * 1024];
            while done < session.item.size_bytes {
                if session.cancel.load(Ordering::Acquire) {
                    return Err(ApiError::Cancelled);
                }
                let count = (session.item.size_bytes - done).min(buffer.len() as u64) as usize;
                let n = body.read(&mut buffer[..count]).map_err(ApiError::Local)?;
                if n == 0 {
                    return Err(ApiError::Local(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "upload interrupted",
                    )));
                }
                file.write_all(&buffer[..n]).map_err(ApiError::Local)?;
                done += n as u64;
                if let Some(row) = lock()
                    .incoming
                    .iter_mut()
                    .find(|row| row.item.transfer_id == id)
                {
                    row.done = done;
                }
                emit_progress();
            }
            file.sync_all().map_err(ApiError::Local)?;
            drop(file);
            land(
                &session.item,
                &part,
                &dir,
                resume_at,
                &session.cancel,
                Some(&session.via),
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.forget(id);
                remove_incoming(id);
                emit();
                saved()
            }
            Err(error) => {
                if session.cancel.load(Ordering::Acquire) {
                    let _ = fs::remove_file(&part);
                    self.forget(id);
                    remove_incoming(id);
                    emit();
                    return Reply::error(410, "cancelled");
                }
                local_error(error)
            }
        }
    }
    fn cancel(&self, peer: &LanPeer, id: &str) -> Reply {
        let session = match self.session(peer, id) {
            Ok(s) => s,
            Err(r) => return r,
        };
        session.cancel.store(true, Ordering::Release);
        lock().lan_cancelled.insert(id.into());
        if let Ok(_upload) = session.uploading.try_lock() {
            if let Some(parts) = lock().lan_parts.clone() {
                let _ = fs::remove_file(files::part_path(
                    &parts,
                    &uuid::Uuid::parse_str(id).unwrap(),
                ));
            }
        }
        self.forget(id);
        remove_incoming(id);
        emit();
        Reply::ok(json!({"state":"cancelled"}))
    }
}

#[cfg(test)]
mod tests {
    use super::super::server::tests::{call, peer, request};
    use super::*;
    use sha2::{Digest, Sha256};
    fn prepare(peer: &LanPeer, data: &[u8]) -> Prepare {
        Prepare {
            transfer_id: uuid::Uuid::new_v4().to_string(),
            batch_id: uuid::Uuid::new_v4().to_string(),
            from_device: peer.device_id.clone(),
            file_name: "photo.txt".into(),
            size_bytes: data.len() as u64,
            sha256: Sha256::digest(data)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
            content_type_hint: None,
        }
    }
    fn prepare_bytes(p: &Prepare) -> Vec<u8> {
        json!({"transferId":p.transfer_id,"batchId":p.batch_id,"fromDevice":p.from_device,"fileName":p.file_name,"sizeBytes":p.size_bytes,"sha256":p.sha256}).to_string().into_bytes()
    }
    #[test]
    fn receiver_resume_cancel_digest_durable_receipt_and_server_isolation() {
        let temp = tempfile::tempdir().unwrap();
        let parts = temp.path().join("exchange-lan-parts");
        let dir = temp.path().join("Downloads");
        let path = temp.path().join(STATE_FILE);
        let peer = peer();
        {
            let mut state = lock();
            state.stored = Stored::default();
            state.stored.peers = vec![peer.clone()];
            state.path = Some(path.clone());
            state.lan_parts = Some(parts.clone());
            state.incoming.clear();
            state.lan_cancelled.clear();
        }
        let gate = Arc::new(crate::library::sync_hold::Gate::new(false));
        let sink = DirectSink {
            ready: Box::new({
                let parts = parts.clone();
                let dir = dir.clone();
                let gate = gate.clone();
                move || Ok((gate.clone(), parts.clone(), dir.clone()))
            }),
            sessions: Mutex::new(HashMap::new()),
        };
        let p = prepare(&peer, b"hello");
        let id = &p.transfer_id;
        let start = || {
            call(
                &sink,
                &peer,
                request("POST", "/prepare-upload", &prepare_bytes(&p)),
            )
        };
        assert_eq!(start(), (200, json!({"state":"upload","offset":0})));
        assert!(lock()
            .incoming
            .iter()
            .any(|row| row.direct && row.item.transfer_id == *id));
        // A dropped body keeps its exact prefix for the next prepare.
        let mut dropped = request(
            "PUT",
            &format!("/upload?transferId={id}&offset=0"),
            b"hello",
        );
        dropped.truncate(dropped.len() - 3);
        assert_eq!(call(&sink, &peer, dropped).0, 503);
        assert_eq!(start().1, json!({"state":"upload","offset":2}));
        assert_eq!(
            call(
                &sink,
                &peer,
                request(
                    "PUT",
                    &format!("/upload?transferId={id}&offset=0"),
                    b"hello"
                )
            ),
            (409, json!({"error":"offsetMismatch","offset":2}))
        );
        assert_eq!(
            call(
                &sink,
                &peer,
                request("PUT", &format!("/upload?transferId={id}&offset=2"), b"lo")
            )
            .0,
            422
        );
        assert_eq!(
            call(
                &sink,
                &peer,
                request("PUT", &format!("/upload?transferId={id}&offset=2"), b"llo")
            ),
            (200, json!({"state":"saved"}))
        );
        let stored = Stored::load(&path);
        let row = stored.ledger(id).unwrap();
        assert!(row.acked && !row.publishing);
        assert_eq!(row.via.as_deref(), Some("lan"));
        assert_eq!(fs::read(&row.path).unwrap(), b"hello");
        assert_eq!(start().1, json!({"state":"saved"}));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        assert!(sink.sessions.lock().unwrap().get(id).is_none());
        assert!(lock().incoming.is_empty());
        let bad = prepare(&peer, b"good");
        assert_eq!(sink.prepare(&peer, bad.clone(), "tailscale").0, 200);
        assert_eq!(
            sink.upload(&peer, &bad.transfer_id, 0, 4, &mut &b"evil"[..])
                .0,
            422
        );
        let bad_part = files::part_path(&parts, &uuid::Uuid::parse_str(&bad.transfer_id).unwrap());
        assert!(!bad_part.exists());
        assert_eq!(
            sink.prepare(&peer, bad.clone(), "lan").1,
            json!({"state":"upload","offset":0})
        );
        let stranger = super::super::server::tests::peer();
        assert_eq!(
            sink.upload(&stranger, &bad.transfer_id, 0, 4, &mut &b"good"[..])
                .0,
            403
        );
        assert_eq!(sink.cancel(&stranger, &bad.transfer_id).0, 403);
        assert_eq!(sink.cancel(&peer, &bad.transfer_id).0, 200);
        assert_eq!(sink.prepare(&peer, bad.clone(), "lan").0, 410);
        assert_eq!(
            sink.upload(&peer, &bad.transfer_id, 0, 4, &mut &b"good"[..])
                .0,
            410
        );
        // Existing UI cancellation uses this same flag and durable-in-session tombstone.
        let ui = prepare(&peer, b"ui");
        sink.prepare(&peer, ui.clone(), "lan");
        lock()
            .incoming
            .iter()
            .find(|row| row.item.transfer_id == ui.transfer_id)
            .unwrap()
            .cancel
            .store(true, Ordering::Release);
        lock().lan_cancelled.insert(ui.transfer_id.clone());
        assert_eq!(
            sink.upload(&peer, &ui.transfer_id, 0, 2, &mut &b"ui"[..]).0,
            410
        );
        let busy = prepare(&peer, b"busy");
        let mut item = sink
            .sessions
            .lock()
            .unwrap()
            .get(&ui.transfer_id)
            .unwrap()
            .item
            .clone();
        item.transfer_id = busy.transfer_id.clone();
        lock().incoming.push(Incoming {
            direct: false,
            direct_active: false,
            item,
            done: 0,
            failed: None,
            cancel: Arc::new(AtomicBool::new(false)),
        });
        assert_eq!(sink.prepare(&peer, busy, "lan").0, 409);
        // Server sweeping cannot touch the separate LAN part folder or via journals.
        let pending = prepare(&peer, b"later");
        sink.prepare(&peer, pending.clone(), "lan");
        let lan_part = files::part_path(
            &parts,
            &uuid::Uuid::parse_str(&pending.transfer_id).unwrap(),
        );
        fs::write(&lan_part, b"la").unwrap();
        let server_parts = temp.path().join(PARTS_FOLDER);
        fs::create_dir_all(&server_parts).unwrap();
        files::sweep_parts(&server_parts, Some(&HashSet::new()), Duration::ZERO);
        assert_eq!(fs::read(&lan_part).unwrap(), b"la");
        let pending_item = sink
            .sessions
            .lock()
            .unwrap()
            .get(&pending.transfer_id)
            .unwrap()
            .item
            .clone();
        {
            let mut state = lock();
            journal_destination(
                &mut state.stored,
                Some(&path),
                &pending_item,
                &dir.join("later.txt"),
                Some("lan"),
            )
            .unwrap();
        }
        assert!(server_abandoned(&lock().stored, &HashSet::new()).is_empty());
        assert!(sink.peer(&peer.report.cert_sha256).is_some());
        lock().stored.peers.clear();
        assert!(sink.peer(&peer.report.cert_sha256).is_none());
        lock().path = None;
        lock().incoming.clear();
        lock().stored = Stored::default();
        lock().lan_parts = None;
    }
}
