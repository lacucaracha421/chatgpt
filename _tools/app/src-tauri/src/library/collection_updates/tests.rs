use super::*;
fn library() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    (temp, library)
}
fn binding(library: &Library, id: &str, provider: &str) {
    library.connection().unwrap().execute("INSERT OR IGNORE INTO collections(id,name,type,created_at,updated_at) VALUES(?1,?1,'manga','t','t')",[id]).unwrap();
    library.connection().unwrap().execute("INSERT INTO collection_external_bindings(collection_id,provider,external_id,created_at,updated_at) VALUES(?1,?2,?1,'t','t')",params![id,provider]).unwrap();
}
fn synced(library: &Library, id: &str, provider: &str) -> Result<(), LibraryError> {
    library.connection()?.execute("UPDATE collection_external_bindings SET last_synced_at=?3 WHERE collection_id=?1 AND provider=?2",params![id,provider,chrono::Utc::now().to_rfc3339()])?;
    Ok(())
}
#[test]
fn daily_batches_update_unwatched_works_and_resume_without_rechecking() {
    let (_temp, library) = library();
    for n in 0..18 {
        binding(&library, &format!("m{n:02}"), "kakao");
    }
    let first = library
        .run_collection_updates_with("kakao", |id| synced(&library, id, "kakao"))
        .unwrap();
    assert_eq!((first.checked, first.remaining), (8, 10));
    let second = library
        .run_collection_updates_with("kakao", |id| synced(&library, id, "kakao"))
        .unwrap();
    assert_eq!((second.checked, second.remaining), (16, 2));
    let third = library
        .run_collection_updates_with("kakao", |id| synced(&library, id, "kakao"))
        .unwrap();
    assert_eq!((third.checked, third.remaining), (18, 0));
    library
        .run_collection_updates_with("kakao", |_| panic!("not due"))
        .unwrap();
    assert!(library.list_release_inbox().unwrap().is_empty());
}
#[test]
fn rate_limit_cools_down_one_provider_and_other_provider_can_continue() {
    let (_temp, library) = library();
    binding(&library, "m", "mangadex");
    binding(&library, "k", "kakao");
    let failed = library
        .run_collection_updates_with("mangadex", |_| Err(LibraryError::MangaDexRateLimited))
        .unwrap();
    assert!(failed.retry_at.is_some());
    assert_eq!(failed.remaining, 1);
    library
        .run_collection_updates_with("mangadex", |_| panic!("cooldown"))
        .unwrap();
    assert_eq!(
        library
            .run_collection_updates_with("kakao", |id| synced(&library, id, "kakao"))
            .unwrap()
            .checked,
        1
    );
}
#[test]
fn temporary_failure_retries_promptly_and_resumes_completed_progress() {
    let (_temp, library) = library();
    binding(&library, "a", "mangadex");
    binding(&library, "b", "mangadex");
    let failed = library
        .run_collection_updates_with("mangadex", |id| {
            if id == "a" {
                synced(&library, id, "mangadex")
            } else {
                Err(LibraryError::MangaDexUnavailable)
            }
        })
        .unwrap();
    assert_eq!((failed.checked, failed.remaining), (1, 1));
    let retry = chrono::DateTime::parse_from_rfc3339(failed.retry_at.as_ref().unwrap()).unwrap();
    assert!(
        retry
            .signed_duration_since(chrono::Utc::now())
            .num_seconds()
            <= 5,
        "temporary failure should not wait one hour"
    );
    library
        .run_collection_updates_with("mangadex", |_| panic!("retry must respect deadline"))
        .unwrap();
    let mut expired = failed;
    expired.retry_at = Some((chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339());
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE collection_update_status SET status_json=?1 WHERE provider='mangadex'",
            [serde_json::to_string(&expired).unwrap()],
        )
        .unwrap();
    let recovered = library
        .run_collection_updates_with("mangadex", |id| {
            assert_eq!(id, "b", "successful work must not repeat");
            synced(&library, id, "mangadex")
        })
        .unwrap();
    assert_eq!((recovered.checked, recovered.remaining), (2, 0));
    assert!(recovered.retry_at.is_none());
    assert!(recovered.stop_reason.is_none());
}

#[test]
fn malformed_work_does_not_starve_later_works_or_spin() {
    let (_temp, library) = library();
    binding(&library, "a", "mangadex");
    binding(&library, "b", "mangadex");
    let result = library
        .run_collection_updates_with("mangadex", |id| {
            if id == "a" {
                Err(LibraryError::InvalidMangaDexResponse)
            } else {
                synced(&library, id, "mangadex")
            }
        })
        .unwrap();
    assert_eq!((result.checked, result.failed, result.remaining), (1, 1, 0));
    library
        .run_collection_updates_with("mangadex", |_| panic!("not due"))
        .unwrap();
}
fn cover(volume: &str) -> MangaDexCoverCandidate {
    MangaDexCoverCandidate {
        cover_id: format!("cover-{volume}"),
        file_name: format!("{volume}.jpg"),
        volume: Some(volume.into()),
        language: Some("ja".into()),
    }
}
#[test]
fn mangadex_baseline_is_quiet_and_new_volumes_are_provider_specific_and_monotonic() {
    let (_temp, library) = library();
    binding(&library, "m", "mangadex");
    let mut connection = library.connection().unwrap();
    for covers in [
        vec![cover("1")],
        vec![cover("1"), cover("2")],
        vec![cover("1")],
        vec![cover("1"), cover("2")],
    ] {
        let tx = connection.transaction().unwrap();
        reconcile_mangadex_volumes(&tx, "m", "md", &covers).unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM collection_volumes WHERE collection_id='m'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
    drop(connection);
    let inbox = library.list_release_inbox().unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].provider, "mangadex");
    assert_eq!(inbox[0].event.volume_number, 2);
}
#[test]
fn explicit_zero_is_distinct_from_never_entered() {
    let (_temp, library) = library();
    binding(&library, "m", "kakao");
    assert!(library.list_ownership_tracking("m").unwrap().is_empty());
    library.set_owned_volume_count("m", 0, 0).unwrap();
    assert_eq!(library.list_ownership_tracking("m").unwrap(), vec![0]);
    assert!(library.list_volume_ownership("m").unwrap().is_empty());
}

/// Opt-in, read-only provider timing. Uses public sample titles and the configured
/// Kakao credential. Never opens or migrates a library; never prints key bytes.
#[test]
#[ignore = "requires network and optional OS Kakao credential"]
fn live_provider_latency_sample() {
    for (name, id) in [("Dungeon Meshi", "d1a9fdeb-f713-407f-960c-8326b586e6fd")] {
        for sample in 1..=3 {
            let before = provider_requests::metrics();
            let start = Instant::now();
            let result = super::super::mangadex::fetch_work(id);
            let after = provider_requests::metrics();
            println!("mangadex {name} sample={sample} ok={} elapsed_ms={} requests={} network_ms={} throttle_ms={} covers={}",result.is_ok(),start.elapsed().as_millis(),after.requests-before.requests,after.network_ms-before.network_ms,after.throttle_ms-before.throttle_ms,result.as_ref().map(|work|work.preview.covers.len()).unwrap_or(0));
            if let Err(error) = result {
                println!("mangadex failure={:?}", stop_reason(&error));
                break;
            }
        }
    }
    match super::super::credential::read_kakao_key() {
        Ok(key) => {
            for query in ["던전밥", "원피스", "명탐정 코난"] {
                let before = provider_requests::metrics();
                let start = Instant::now();
                let result = super::super::kakao_books::search(&key, query);
                let after = provider_requests::metrics();
                println!("kakao query={query} ok={} elapsed_ms={} requests={} network_ms={} throttle_ms={} volumes={}",result.is_ok(),start.elapsed().as_millis(),after.requests-before.requests,after.network_ms-before.network_ms,after.throttle_ms-before.throttle_ms,result.as_ref().map(Vec::len).unwrap_or(0));
                if let Err(error) = result {
                    println!("kakao failure={:?}", stop_reason(&error));
                    break;
                }
            }
        }
        Err(_) => println!(
            "kakao latency unverified: configured credential unavailable to this test process"
        ),
    }
}

#[test]
fn migration_preserves_existing_counts_and_unread_events() {
    let temp = tempfile::tempdir().unwrap();
    let mut connection = rusqlite::Connection::open(temp.path().join("library.sqlite")).unwrap();
    let mut migrations =
        std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|p| p.extension().is_some_and(|ext| ext == "sql"))
            .collect::<Vec<_>>();
    migrations.sort();
    let tx = connection.transaction().unwrap();
    for path in migrations.iter().take(72) {
        tx.execute_batch(&std::fs::read_to_string(path).unwrap())
            .unwrap();
    }
    tx.execute_batch("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('m','Manga','manga','t','t'); INSERT INTO collection_volume_ownership VALUES('m',1,0,1,0); INSERT INTO release_watch_events(id,collection_id,event_kind,volume_number,detected_at) VALUES('old','m','new_volume',2,'t');").unwrap();
    tx.commit().unwrap();
    drop(connection);
    let library = Library::open(temp.path()).unwrap();
    assert_eq!(library.list_ownership_tracking("m").unwrap(), vec![0]);
    assert_eq!(library.list_volume_ownership("m").unwrap().len(), 1);
    assert_eq!(library.list_release_inbox().unwrap()[0].event.id, "old");
}

#[test]
fn repeated_failures_back_off_and_success_resets_the_retry_budget() {
    let (_temp, library) = library();
    binding(&library, "a", "mangadex");
    for (index, seconds) in [5, 30, 120, 600, 600].into_iter().enumerate() {
        let mut failed = library
            .run_collection_updates_with("mangadex", |_| Err(LibraryError::MangaDexUnavailable))
            .unwrap();
        assert_eq!(failed.consecutive_failures, index as u32 + 1);
        let retry =
            chrono::DateTime::parse_from_rfc3339(failed.retry_at.as_ref().unwrap()).unwrap();
        let delay = retry
            .signed_duration_since(chrono::Utc::now())
            .num_seconds();
        assert!((seconds - 1..=seconds).contains(&delay));
        failed.retry_at = Some((chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339());
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collection_update_status SET status_json=?1",
                [serde_json::to_string(&failed).unwrap()],
            )
            .unwrap();
    }
    let recovered = library
        .run_collection_updates_with("mangadex", |id| synced(&library, id, "mangadex"))
        .unwrap();
    assert_eq!(recovered.consecutive_failures, 0);
    assert!(recovered.last_failure.is_none());
}

#[test]
fn server_retry_deadline_and_safe_failure_details_survive_status_reload() {
    let (_temp, library) = library();
    binding(&library, "a", "mangadex");
    let result = library
        .run_collection_updates_with("mangadex", |_| {
            let mut headers = ureq::http::HeaderMap::new();
            headers.insert("retry-after", "180".parse().unwrap());
            provider_requests::record_failure(provider_requests::Failure::http(
                429, &headers, "covers",
            ));
            Err(LibraryError::MangaDexRateLimited)
        })
        .unwrap();
    let retry = chrono::DateTime::parse_from_rfc3339(result.retry_at.as_ref().unwrap()).unwrap();
    assert!(
        retry
            .signed_duration_since(chrono::Utc::now())
            .num_seconds()
            >= 179
    );
    let reloaded = library.collection_update_status("mangadex").unwrap();
    let failure = reloaded.last_failure.unwrap();
    assert_eq!(failure.collection_id, "a");
    assert_eq!(failure.request.http_status, Some(429));
    assert_eq!(failure.request.endpoint, "covers");
    library
        .run_collection_updates_with("mangadex", |_| panic!("server minimum wait must hold"))
        .unwrap();
}

#[test]
fn rejected_work_is_deferred_without_stopping_later_works() {
    let (_temp, library) = library();
    binding(&library, "a", "mangadex");
    binding(&library, "b", "mangadex");
    let result = library
        .run_collection_updates_with("mangadex", |id| {
            if id == "a" {
                provider_requests::record_failure(provider_requests::Failure::http(
                    400,
                    &ureq::http::HeaderMap::new(),
                    "detail",
                ));
                Err(LibraryError::MangaDexUnavailable)
            } else {
                synced(&library, id, "mangadex")
            }
        })
        .unwrap();
    assert_eq!((result.checked, result.failed, result.remaining), (1, 1, 0));
    assert!(result.stop_reason.is_none());
    assert_eq!(result.last_failure.unwrap().collection_id, "a");
    library
        .run_collection_updates_with("mangadex", |_| panic!("deferred work must not spin"))
        .unwrap();
}

#[test]
fn legacy_transport_cooldown_is_shortened_but_legacy_quota_wait_is_preserved() {
    let (_temp, library) = library();
    binding(&library, "a", "mangadex");
    let retry = (chrono::Utc::now() + chrono::Duration::minutes(50)).to_rfc3339();
    for reason in ["rate_limited", "unavailable"] {
        let mut value = serde_json::to_value(CollectionUpdateStatus {
            provider: "mangadex".into(),
            retry_at: Some(retry.clone()),
            ..Default::default()
        })
        .unwrap();
        value["stopReason"] = serde_json::json!(reason);
        value.as_object_mut().unwrap().remove("consecutiveFailures");
        value.as_object_mut().unwrap().remove("lastFailure");
        library.connection().unwrap().execute("INSERT OR REPLACE INTO collection_update_status(provider,status_json) VALUES('mangadex',?1)",[value.to_string()]).unwrap();
        let status = library.collection_update_status("mangadex").unwrap();
        let deadline =
            chrono::DateTime::parse_from_rfc3339(status.retry_at.as_ref().unwrap()).unwrap();
        assert_eq!(deadline > chrono::Utc::now(), reason == "rate_limited");
    }
}
