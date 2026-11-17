use cantrip_wire::{Value, value::json};
use cantrip_worker::{
    routing::Registry,
    workspace::{self, Limits, Scope},
};
use std::time::Duration;
#[tokio::test]
async fn routing_records_reopen_with_stable_field_scoped_tokens_and_private_writes() {
    let directory = tempfile::tempdir().unwrap();
    let registry = Registry::new(directory.path());
    let values =
        json!({"path":"/fixture/私密","displayPath":"/fixture/私密","warnings":vec!["one","two"]});
    let protected = registry.protect_metadata(&values).await.unwrap();
    assert_ne!(protected["path"], protected["displayPath"]);
    assert_eq!(registry.protect_metadata(&values).await.unwrap(), protected);
    let reopened = Registry::new(directory.path());
    assert_eq!(reopened.resolve_metadata(&protected).await.unwrap(), values);
    let reference = json!(format!(
        "refs/heads/{}",
        protected["path"].as_str().unwrap()
    ));
    assert_eq!(
        reopened.resolve(&reference).await.unwrap(),
        "refs/heads//fixture/私密"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(directory.path().join("repository-routing.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
#[tokio::test]
async fn invalid_registry_is_not_replaced_and_failed_load_stays_failed() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("repository-routing.json");
    let token = format!("ctrr_{}", "A".repeat(43));
    let record = json!({"field":"path","token":token,"value":"/fixture"});
    let data = json!({"version":1,"records":vec![record.clone(),record]}).stringify();
    std::fs::write(&path, &data).unwrap();
    let registry = Registry::new(directory.path());
    assert!(registry.resolve(&json!(token)).await.is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), data);
    std::fs::write(&path, "{\"version\":1,\"records\":[]}").unwrap();
    assert!(registry.resolve(&Value::Null).await.is_err());
    assert_eq!(
        Registry::new(directory.path())
            .resolve(&Value::Null)
            .await
            .unwrap(),
        Value::Null
    );
}
#[tokio::test]
async fn actual_git_discovery_stops_at_repository_boundaries_and_checks_import_fingerprint() {
    let directory = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(directory.path()).unwrap();
    for path in [
        root.join("project"),
        root.join("project/nested"),
        root.join("deep/another"),
    ] {
        std::fs::create_dir_all(&path).unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["init", "--quiet"])
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
    }
    let mut progress = Vec::new();
    let scope = Scope::default();
    let result = workspace::discover(
        &root.to_str().unwrap().into(),
        &Limits::default(),
        &scope,
        |update| progress.push(update),
    )
    .await
    .unwrap();
    assert_eq!(result["candidates"].as_array().unwrap().len(), 2);
    assert_eq!(progress.first().unwrap()["counts"]["scannedDirectories"], 0);
    assert_eq!(progress.last().unwrap()["counts"]["candidates"], 2);
    let candidate = &result["candidates"].as_array().unwrap()[0];
    let mut validation = json!({"candidateId":"11111111-1111-4111-8111-111111111111","attempt":1,"rootPath":root.to_str().unwrap(),"path":candidate["canonicalPath"],"expectedRepositoryFingerprint":candidate["repositoryFingerprint"]});
    assert_eq!(
        workspace::validate_import(&validation, &scope)
            .await
            .unwrap()["head"],
        Value::Null
    );
    validation["expectedRepositoryFingerprint"] = json!("0".repeat(64));
    assert_eq!(
        workspace::validate_import(&validation, &scope)
            .await
            .unwrap_err()
            .downcast_ref::<workspace::WorkspaceError>()
            .unwrap()
            .code,
        "repository-changed"
    );
}
#[cfg(unix)]
#[tokio::test]
async fn subprocess_buffers_deadlines_and_runtime_stop_are_owned() {
    let scope = Scope::default();
    let output = scope
        .run(
            "/bin/sh".as_ref(),
            &["-c".into(), "printf hello; printf diagnostic >&2".into()],
            1024,
            1000,
        )
        .await
        .unwrap();
    assert_eq!(output, "hello");
    assert!(
        scope
            .run(
                "/bin/sh".as_ref(),
                &["-c".into(), "printf '%2048s' x".into()],
                1024,
                1000
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("output")
    );
    let began = std::time::Instant::now();
    assert!(
        scope
            .run(
                "/bin/sh".as_ref(),
                &["-c".into(), "sleep 30".into()],
                1024,
                25
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("timed out")
    );
    assert!(began.elapsed() < Duration::from_secs(2));
    let (stop, receive) = tokio::sync::watch::channel(false);
    let scope = Scope::with_stop(receive);
    let job = tokio::spawn(async move {
        scope
            .run(
                "/bin/sh".as_ref(),
                &["-c".into(), "sleep 30".into()],
                1024,
                5000,
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(25)).await;
    stop.send_replace(true);
    assert!(
        job.await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("stopped")
    );
}
