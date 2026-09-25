use super::*;
use crate::cloud::collection_releases::{chunk_uploads, ReleaseUpload};
use crate::library::collection_personal_edits::tests::configure;
use serde_json::{json, Value};

type Seen = Vec<(String, Option<String>, String)>;

/// A local server answering each request with `handler(url, body)`; returns what it saw.
fn serve(
    count: usize,
    handler: impl Fn(&str, &str) -> (u16, String) + Send + 'static,
) -> (String, std::thread::JoinHandle<Seen>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr());
    let handle = std::thread::spawn(move || {
        let mut seen = Vec::new();
        for _ in 0..count {
            let mut request = server
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .expect("request");
            let authorization = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("Authorization"))
                .map(|h| h.value.to_string());
            let mut body = String::new();
            std::io::Read::read_to_string(request.as_reader(), &mut body).unwrap();
            let url = request.url().to_string();
            let (status, reply) = handler(&url, &body);
            seen.push((url, authorization, body));
            request
                .respond(tiny_http::Response::from_string(reply).with_status_code(status))
                .unwrap();
        }
        seen
    });
    (base, handle)
}

/// The server's reply to an upload chunk, echoing it, with these ids already read.
fn accept(body: &str, already_read: &[&str]) -> (u16, String) {
    let upload: Value = serde_json::from_str(body).unwrap();
    let ids: Vec<&str> = upload["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["eventId"].as_str().unwrap())
        .collect();
    let read: Vec<&&str> = already_read.iter().filter(|id| ids.contains(id)).collect();
    (
        200,
        json!({"version":1,"operationId":upload["operationId"],"generation":upload["generation"],
            "final":upload["final"],"items":ids.len(),"changed":ids.len(),"retired":0,
            "alreadyRead":read,"revision":1})
        .to_string(),
    )
}

fn fixture() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    library
        .connection()
        .unwrap()
        .execute_batch(
            "INSERT INTO collections(id,name,type,created_at,updated_at) VALUES
             ('m','원피스','manga','2026','2026'),('n','Naruto','manga','2026','2026'),
             ('av','AV','av','2026','2026');
             INSERT INTO release_watch_events(id,collection_id,event_kind,volume_number,previous_value,current_value,detected_at,read_at,provider) VALUES
             ('e1','m','new_volume',108,NULL,'2026-10-01','2026-09-20T01:02:03.123456789+00:00',NULL,'kakao'),
             ('e2','m','release_date_changed',109,'2026-11-01','2026-11-15','2026-09-21T00:00:00+09:00',NULL,'aladin'),
             ('e3','n','release_status_changed',72,'upcoming','released','2026-09-22T00:00:00Z',NULL,'mangadex'),
             ('read','n','new_volume',71,NULL,NULL,'2026-09-19T00:00:00Z','2026-09-19T01:00:00Z','kakao'),
             ('hidden','av','new_volume',1,NULL,NULL,'2026-09-23T00:00:00Z',NULL,'kakao');",
        )
        .unwrap();
    (temp, library)
}

fn unread(library: &Library) -> Vec<String> {
    library
        .connection()
        .unwrap()
        .prepare("SELECT id FROM release_watch_events WHERE read_at IS NULL ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn event(id: usize) -> ReleaseEvent {
    ReleaseEvent {
        event_id: format!("e{id}"),
        collection_id: "m".into(),
        collection_name: "M".into(),
        provider: "kakao".into(),
        kind: "new_volume".into(),
        volume_number: 1,
        previous_value: None,
        current_value: None,
        detected_at: "2026-09-25T00:00:00.000Z".into(),
    }
}

#[test]
fn the_unread_set_has_all_three_kinds_newest_first_in_server_form() {
    let (_temp, library) = fixture();
    let (items, fingerprint) = unread_set(&library.connection().unwrap()).unwrap();
    let ids: Vec<&str> = items.iter().map(|i| i.event_id.as_str()).collect();
    // Read events and AV Collections (never published) are left out.
    assert_eq!(ids, ["e3", "e2", "e1"]);
    assert_eq!(items[2].detected_at, "2026-09-20T01:02:03.123Z");
    assert_eq!(items[1].detected_at, "2026-09-20T15:00:00.000Z");
    assert_eq!(items[2].collection_name, "원피스");
    assert_eq!(items[0].kind, "release_status_changed");
    let value = serde_json::to_value(&items[2]).unwrap();
    assert_eq!(
        value,
        json!({"eventId":"e1","collectionId":"m","collectionName":"원피스","provider":"kakao",
            "kind":"new_volume","volumeNumber":108,"previousValue":null,"currentValue":"2026-10-01",
            "detectedAt":"2026-09-20T01:02:03.123Z"})
    );
    // A local 확인 changes the fingerprint.
    library
        .acknowledge_release_events("n", vec!["e3".into()])
        .unwrap();
    assert_ne!(
        unread_set(&library.connection().unwrap()).unwrap().1,
        fingerprint
    );
}

#[test]
fn chunks_share_one_generation_and_only_the_last_is_final() {
    let chunks = chunk_uploads((0..1201).map(event).collect(), 1_790_000_000_000).unwrap();
    assert_eq!(
        chunks.iter().map(|c| c.items.len()).collect::<Vec<_>>(),
        [500, 500, 201]
    );
    assert!(chunks
        .iter()
        .all(|c| c.generation == "1790000000000" && c.version == 1));
    assert_eq!(
        chunks.iter().map(|c| c.is_final).collect::<Vec<_>>(),
        [false, false, true]
    );
    let ids: std::collections::HashSet<_> = chunks.iter().map(|c| &c.operation_id).collect();
    assert_eq!(ids.len(), 3);
    assert!(chunks
        .iter()
        .all(|c| crate::cloud::catalog_duplicates::valid_operation_id(&c.operation_id)));
    // An empty unread set is one empty final chunk.
    let empty = chunk_uploads(Vec::new(), 5).unwrap();
    assert_eq!(empty.len(), 1);
    assert!(empty[0].is_final && empty[0].items.is_empty());
    let body: Value = serde_json::to_value(&empty[0]).unwrap();
    assert_eq!(body["final"], true);
    assert_eq!(body["generation"], "5");
    assert!(chunk_uploads(Vec::new(), 0).is_err());
}

#[test]
fn upload_sends_the_set_acknowledges_already_read_and_then_skips_when_unchanged() {
    let (_temp, library) = fixture();
    let (base, handle) = serve(2, |url, body| {
        assert_eq!(url, "/v1/collections/releases/unread");
        accept(body, &["e2"])
    });
    configure(&library, &base);
    let client = CloudClient::new(&base).unwrap();
    let started = chrono::Utc::now().timestamp_millis();
    library
        .upload_due_collection_releases(&client, "publisher", &base)
        .unwrap();
    // The mobile 확인 that raced the upload is applied locally at once.
    assert_eq!(unread(&library), ["e1", "e3", "hidden"]);
    let first = library.collection_release_sync_state(&base).unwrap();
    assert_eq!(first.retry_after, 0);
    assert!(!first.full_upload);
    // The uploaded fingerprint describes the uploaded set, so the local ack makes the next
    // pass upload again (retiring the read event on the server) with a higher generation.
    library
        .upload_due_collection_releases(&client, "publisher", &base)
        .unwrap();
    let seen = handle.join().unwrap();
    assert_eq!(seen[0].1.as_deref(), Some("Bearer publisher"));
    let upload: ReleaseUpload = serde_json::from_str(&seen[0].2).unwrap();
    assert!(upload.is_final);
    assert_eq!(upload.items.len(), 3);
    let generation: i64 = upload.generation.parse().unwrap();
    assert!(generation >= started && !upload.generation.starts_with('0'));
    assert_eq!(first.generation, generation);
    let second: ReleaseUpload = serde_json::from_str(&seen[1].2).unwrap();
    assert_eq!(second.items.len(), 2);
    assert!(second.generation.parse::<i64>().unwrap() > generation);
    // Unchanged: no request at all (the endpoint is unreachable).
    let offline = CloudClient::new("http://127.0.0.1:9").unwrap();
    library
        .upload_due_collection_releases(&offline, "publisher", &base)
        .unwrap();
}

#[test]
fn a_clock_behind_the_last_generation_and_a_stale_generation_still_move_forward() {
    let (_temp, library) = fixture();
    let future = chrono::Utc::now().timestamp_millis() + 10_000_000;
    let server = future + 5_000;
    let (base, handle) = serve(3, move |url, body| {
        if url.starts_with("/v1/collections/releases?limit=1") {
            return (
                200,
                json!({"version":1,"generation":server.to_string(),"items":[]}).to_string(),
            );
        }
        let upload: Value = serde_json::from_str(body).unwrap();
        let generation: i64 = upload["generation"].as_str().unwrap().parse().unwrap();
        if generation < server {
            (
                409,
                json!({"detail":{"code":"releaseGenerationStale","message":"x"}}).to_string(),
            )
        } else {
            accept(body, &[])
        }
    });
    library
        .update_release_sync_state(&base, |s| s.generation = future)
        .unwrap();
    let client = CloudClient::new(&base).unwrap();
    library
        .upload_due_collection_releases(&client, "publisher", &base)
        .unwrap();
    let seen = handle.join().unwrap();
    let generation = |index: usize| -> i64 {
        serde_json::from_str::<Value>(&seen[index].2).unwrap()["generation"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap()
    };
    assert_eq!(
        generation(0),
        future + 1,
        "strictly above the last one used"
    );
    assert_eq!(
        generation(2),
        server + 1,
        "restarted above the server's generation"
    );
    assert_eq!(
        library
            .collection_release_sync_state(&base)
            .unwrap()
            .generation,
        server + 1
    );
}

#[test]
fn a_lost_chunk_is_resent_with_the_identical_body() {
    let (_temp, library) = fixture();
    // The first connection is closed without a reply (a lost response).
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        use std::io::{BufRead, Read, Write};
        let mut bodies = Vec::new();
        for attempt in 0..2 {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream);
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse().unwrap();
                    }
                }
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let body = String::from_utf8(body).unwrap();
            bodies.push(body.clone());
            if attempt == 1 {
                let (_, reply) = accept(&body, &[]);
                let mut stream = reader.into_inner();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                )
                .unwrap();
            }
        }
        bodies
    });
    let client = CloudClient::new(&base).unwrap();
    library
        .upload_due_collection_releases(&client, "publisher", &base)
        .unwrap();
    let bodies = handle.join().unwrap();
    assert_eq!(bodies[0], bodies[1]);
    assert!(library
        .collection_release_sync_state(&base)
        .unwrap()
        .uploaded
        .is_some());
}

#[test]
fn the_read_log_acknowledges_locally_and_an_expired_cursor_forces_a_complete_upload() {
    let (_temp, library) = fixture();
    let (base, handle) = serve(3, |url, body| {
        if url.starts_with("/v1/collections/releases/reads?after=3&") {
            return (
                409,
                json!({"detail":{"code":"releaseReadCursorExpired","message":"x","lastSequence":7}})
                    .to_string(),
            );
        }
        if url.starts_with("/v1/collections/releases/reads?after=7&") {
            return (200, json!({"version":1,"after":7,"lastSequence":9,"prunedThrough":5,
                "nextCursor":9,"hasMore":false,"items":[
                {"sequence":8,"operationId":"o","collectionId":"m","eventId":"e1","createdAt":"t"},
                {"sequence":9,"operationId":"o","collectionId":"m","eventId":"gone","createdAt":"t"}]})
                .to_string());
        }
        assert_eq!(url, "/v1/collections/releases/unread");
        accept(body, &[])
    });
    configure(&library, &base);
    // Pretend this set was uploaded already: only the recovery can force the upload.
    let fingerprint = unread_set(&library.connection().unwrap()).unwrap().1;
    library
        .update_release_sync_state(&base, |s| {
            s.read_cursor = 3;
            s.uploaded = Some(fingerprint);
            s.uploaded_at = unix_now();
        })
        .unwrap();
    let client = CloudClient::new(&base).unwrap();
    library
        .sync_collection_releases_with(&client, "publisher", &base)
        .unwrap();
    // A second pass within the minute neither polls nor uploads (nothing changed).
    library
        .sync_collection_releases_with(&client, "publisher", &base)
        .unwrap();
    assert_eq!(handle.join().unwrap().len(), 3);
    assert_eq!(unread(&library), ["e2", "e3", "hidden"]);
    let state = library.collection_release_sync_state(&base).unwrap();
    assert_eq!(state.read_cursor, 9);
    assert!(!state.full_upload);
}

#[test]
fn the_complete_upload_after_recovery_is_sent_even_when_unchanged() {
    let (_temp, library) = fixture();
    let (base, handle) = serve(3, |url, body| {
        if url.starts_with("/v1/collections/releases/reads?after=3&") {
            return (
                409,
                json!({"detail":{"code":"releaseReadCursorExpired","message":"x","lastSequence":7}})
                    .to_string(),
            );
        }
        if url.starts_with("/v1/collections/releases/reads?after=7&") {
            return (
                200,
                json!({"version":1,"after":7,"lastSequence":7,"prunedThrough":7,
                "nextCursor":7,"hasMore":false,"items":[]})
                .to_string(),
            );
        }
        accept(body, &["e3"])
    });
    configure(&library, &base);
    let fingerprint = unread_set(&library.connection().unwrap()).unwrap().1;
    library
        .update_release_sync_state(&base, |s| {
            s.read_cursor = 3;
            s.uploaded = Some(fingerprint);
            s.uploaded_at = unix_now();
        })
        .unwrap();
    let client = CloudClient::new(&base).unwrap();
    library
        .sync_collection_releases_with(&client, "publisher", &base)
        .unwrap();
    let seen = handle.join().unwrap();
    assert_eq!(seen.len(), 3);
    assert_eq!(seen[2].0, "/v1/collections/releases/unread");
    // The `alreadyRead` reply covers the read event whose log entry was pruned.
    assert_eq!(unread(&library), ["e1", "e2", "hidden"]);
    let state = library.collection_release_sync_state(&base).unwrap();
    assert_eq!(state.read_cursor, 7);
    assert!(!state.full_upload);
}

#[test]
fn an_older_server_without_the_channel_is_left_alone_for_an_hour() {
    let (_temp, library) = fixture();
    let (base, handle) = serve(1, |_, _| (404, "{}".into()));
    configure(&library, &base);
    let client = CloudClient::new(&base).unwrap();
    library
        .sync_collection_releases_with(&client, "publisher", &base)
        .unwrap();
    handle.join().unwrap();
    let state = library.collection_release_sync_state(&base).unwrap();
    assert!(state.retry_after > unix_now() + 3500);
    assert!(state.last_polled > unix_now() + 3500);
    // No request within the hour (the server thread has exited).
    library
        .sync_collection_releases_with(&client, "publisher", &base)
        .unwrap();
}

#[test]
fn a_stale_read_page_never_moves_the_cursor_or_acknowledges() {
    let (_temp, library) = fixture();
    library
        .update_release_sync_state("x", |s| s.read_cursor = 5)
        .unwrap();
    let entry = ReadEntry {
        sequence: 4,
        operation_id: "o".into(),
        collection_id: "m".into(),
        event_id: "e1".into(),
        created_at: "t".into(),
    };
    assert_eq!(
        library
            .apply_collection_release_reads("x", 3, &[entry], 4)
            .unwrap(),
        0
    );
    assert_eq!(
        library
            .collection_release_sync_state("x")
            .unwrap()
            .read_cursor,
        5
    );
    assert!(unread(&library).contains(&"e1".to_string()));
}

#[test]
fn read_pages_are_validated() {
    use crate::cloud::collection_releases::{validate_read_page, ReadPage};
    let item = |sequence| ReadEntry {
        sequence,
        operation_id: "o".into(),
        collection_id: "m".into(),
        event_id: "e".into(),
        created_at: "t".into(),
    };
    let page = |after, next, items: Vec<ReadEntry>| ReadPage {
        version: 1,
        after,
        last_sequence: 10,
        next_cursor: next,
        has_more: false,
        items,
    };
    assert!(validate_read_page(&page(2, 4, vec![item(3), item(4)]), 2, 200).is_ok());
    assert!(validate_read_page(&page(2, 2, vec![]), 2, 200).is_ok());
    assert!(validate_read_page(&page(1, 4, vec![item(3), item(4)]), 2, 200).is_err());
    assert!(validate_read_page(&page(2, 4, vec![item(4), item(3)]), 2, 200).is_err());
    assert!(validate_read_page(&page(2, 3, vec![item(3), item(4)]), 2, 200).is_err());
    assert!(validate_read_page(&page(2, 2, vec![item(2)]), 2, 200).is_err());
    let mut more = page(2, 2, vec![]);
    more.has_more = true;
    assert!(validate_read_page(&more, 2, 200).is_err());
}
