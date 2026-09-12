use super::*;

fn python() -> PathBuf {
    std::env::var_os("LAKOMICS_CHARACTER_TEST_PYTHON")
        .expect("set explicit test Python executable")
        .into()
}

#[test]
#[ignore = "requires LAKOMICS_CHARACTER_TEST_PYTHON; only a TEMP fake worker"]
fn child_cancellation_deadline_exit_and_oversized_output_are_bounded() {
    for mode in [
        "cancel",
        "deadline",
        "exit",
        "oversized",
        "malformed",
        "blocked_input",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("fake.py");
        std::fs::write(
            &script,
            match mode {
                "exit" => "raise SystemExit(7)",
                "oversized" => "print('x' * 300000, flush=True)",
                "malformed" => "print('not-json', flush=True)",
                _ => "import time; time.sleep(30)",
            },
        )
        .unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let config = RuntimeConfig {
            python: python(),
            script,
            models: temp.path().into(),
        };
        let mut worker = Worker::start(&config, temp.path(), cancel.clone()).unwrap();
        if mode == "blocked_input" {
            worker
                .send(&serde_json::json!({"payload":"x".repeat(100000)}))
                .unwrap();
        }
        if mode == "cancel" || mode == "blocked_input" {
            cancel.store(true, Ordering::Release);
        }
        let started = Instant::now();
        assert!(
            worker.receive_until(Duration::from_millis(300)).is_err(),
            "{mode}"
        );
        worker.child.kill().unwrap();
        assert!(worker.child.wait().unwrap().code() != Some(0));
        drop(worker);
        assert!(started.elapsed() < Duration::from_secs(3), "{mode}");
    }
}

#[test]
fn delta_request_serializes_exact_protocol_and_rejects_invalid_additions() {
    let old = serde_json::json!({"contentHash":"query","referenceHashes":["a","b","c","d","e"]});
    let refs = vec![serde_json::json!({"path":"/tmp/ref.png","hash":"new"})];
    let request = delta_compare_request("asset", "query", &old, &refs).unwrap();
    assert_eq!(request["type"], "compare_delta");
    assert_eq!(request["assetId"], "asset");
    assert_eq!(request["hash"], "query");
    assert_eq!(request["oldEvidence"], old);
    assert_eq!(request["addedReferences"], serde_json::json!(refs));
    assert!(delta_compare_request("asset", "query", &old, &[]).is_err());
    let too_many = (0..21)
        .map(|index| serde_json::json!({"path":format!("/{index}"),"hash":format!("{index}")}))
        .collect::<Vec<_>>();
    assert!(delta_compare_request("asset", "query", &old, &too_many).is_err());
    let duplicate = vec![
        serde_json::json!({"path":"/a","hash":"same"}),
        serde_json::json!({"path":"/b","hash":"same"}),
    ];
    assert!(delta_compare_request("asset", "query", &old, &duplicate).is_err());
}
