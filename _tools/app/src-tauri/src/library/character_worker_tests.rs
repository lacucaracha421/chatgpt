use super::*;

#[test]
fn augmentation_settings_keep_the_selected_model_when_disabled() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    let script = temp.path().join("worker.py");
    let python_path = temp.path().join("python");
    let model = temp.path().join("model.onnx");
    for path in [&script, &python_path, &model] {
        std::fs::write(path, b"fixture").unwrap();
    }
    let config = RuntimeConfig {
        python: python_path,
        script: script.clone(),
        models: temp.path().to_owned(),
        augmentation_model: Some(model.clone()),
    };
    // Legacy JSON with a model path remains enabled until explicitly disabled.
    std::fs::write(&settings, serde_json::to_vec(&config).unwrap()).unwrap();
    let legacy: SavedRuntime = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    assert!(!legacy.augmentation_disabled);
    assert_eq!(legacy.effective().augmentation_model, Some(model.clone()));
    let status = RuntimeConfig::update_augmentation(script.clone(), &settings, false).unwrap();
    assert!(!status.enabled);
    assert_eq!(status.model_name.as_deref(), Some("model.onnx"));
    assert!(
        !status.model_ready,
        "a model filename is not proof of valid weights"
    );
    let saved: SavedRuntime = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    assert_eq!(saved.runtime.augmentation_model, Some(model));
    assert_eq!(saved.runtime.python, config.python);
    assert!(saved.effective().augmentation_model.is_none());
    assert!(RuntimeConfig::configured(script, &settings)
        .unwrap()
        .augmentation_model
        .is_none());
}

#[test]
fn invalid_augmentation_model_does_not_overwrite_settings() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    let script = temp.path().join("worker.py");
    let model = temp.path().join("augmentation").join("model_feat.onnx");
    std::fs::write(&script, b"fixture").unwrap();
    let config = RuntimeConfig {
        python: script.clone(),
        script: script.clone(),
        models: temp.path().to_owned(),
        augmentation_model: None,
    };
    let before = serde_json::to_vec(&config).unwrap();
    std::fs::write(&settings, &before).unwrap();
    assert!(RuntimeConfig::update_augmentation(script.clone(), &settings, true).is_err());
    assert_eq!(std::fs::read(&settings).unwrap(), before);
    std::fs::create_dir(model.parent().unwrap()).unwrap();
    std::fs::write(&model, b"not S36").unwrap();
    assert!(RuntimeConfig::update_augmentation(script, &settings, true).is_err());
    assert_eq!(std::fs::read(&settings).unwrap(), before);
}

#[test]
fn preconnected_model_is_resolved_without_enabling_legacy_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    let script = temp.path().join("worker.py");
    let model = temp.path().join("augmentation").join("model_feat.onnx");
    std::fs::create_dir(model.parent().unwrap()).unwrap();
    std::fs::write(&model, b"fixture").unwrap();
    std::fs::write(&script, b"fixture").unwrap();
    let config = RuntimeConfig {
        python: script.clone(),
        script: script.clone(),
        models: temp.path().to_owned(),
        augmentation_model: None,
    };
    let before = serde_json::to_vec(&config).unwrap();
    std::fs::write(&settings, &before).unwrap();
    let mut saved = RuntimeConfig::load(script.clone(), &settings).unwrap();
    assert_eq!(saved.runtime.augmentation_model, Some(model.clone()));
    assert!(saved.augmentation_disabled);
    assert!(saved.effective().augmentation_model.is_none());
    assert!(
        !RuntimeConfig::augmentation_settings(script.clone(), &settings)
            .unwrap()
            .enabled
    );
    assert_eq!(std::fs::read(&settings).unwrap(), before);
    saved.augmentation_disabled = false;
    assert_eq!(saved.effective().augmentation_model, Some(model.clone()));
    let status = RuntimeConfig::update_augmentation(script.clone(), &settings, false).unwrap();
    assert!(!status.enabled);
    let reloaded = RuntimeConfig::load(script, &settings).unwrap();
    assert_eq!(reloaded.runtime.augmentation_model, Some(model));
    assert!(reloaded.effective().augmentation_model.is_none());
}

#[test]
fn augmentation_model_validation_agrees_with_the_python_pin() {
    assert!(
        include_str!("../../../character-runtime/character_encoder.py")
            .contains("484ad463f569ab95308cf47e91ba358b01c40bc53289b90b950b94fcde7f2628")
    );
    assert!(check_augmentation_model(Path::new("relative.onnx")).is_err());
}

#[test]
fn failed_augmentation_model_verification_is_not_cached() {
    let temp = tempfile::tempdir().unwrap();
    let model = temp.path().join("model.onnx");
    std::fs::write(&model, b"invalid weights").unwrap();
    for _ in 0..2 {
        assert!(matches!(check_augmentation_model(&model), Err(Error::Invalid(message))
            if message == "설치된 보완 모델이 지원하는 S36 파일과 다릅니다. 보완 모델 설치를 확인해 주세요."));
    }
    std::fs::write(&model, b"changed invalid weights").unwrap();
    assert!(check_augmentation_model(&model).is_err());
}

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
            augmentation_model: None,
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
