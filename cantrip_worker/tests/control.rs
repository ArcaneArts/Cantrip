use cantrip_wire::{Value, value::json};
use cantrip_worker::{
    connection::{Handshake, Negotiation, Outbound, reconnect_delay},
    logging::{Logs, archive_options},
};

fn envelope(state: &str, generation: &str, issuer: &str) -> Value {
    json!({"kind":"connection","state":state,"protocolVersion":2,"connectionGeneration":generation,"serverControlPlaneGeneration":issuer})
}
#[test]
fn protocol_readiness_requires_pending_identity_and_matching_issuer() {
    let generation = "11111111-1111-4111-8111-111111111111";
    let issuer = "22222222-2222-4222-8222-222222222222";
    let mut state = Handshake::opened(Some("cantrip-worker-auth-ready-v2"));
    assert!(!state.legacy_request());
    assert!(matches!(
        state.envelope(&envelope("ready", generation, issuer), generation),
        Negotiation::Close(_)
    ));
    assert_eq!(
        state.envelope(&envelope("pending", generation, issuer), generation),
        Negotiation::Pending
    );
    assert!(matches!(
        state.envelope(&envelope("ready", issuer, issuer), generation),
        Negotiation::Close(_)
    ));
    assert!(matches!(
        state.envelope(&envelope("ready", generation, generation), generation),
        Negotiation::Close(_)
    ));
    assert_eq!(
        state.envelope(&envelope("ready", generation, issuer), generation),
        Negotiation::Ready(Some(issuer.into()))
    );
    assert!(state.ready);
}
#[test]
fn legacy_readiness_and_invalid_connection_frames_remain_distinct() {
    assert!(Handshake::opened(Some("cantrip-worker-legacy")).ready);
    let mut no_protocol = Handshake::opened(None);
    assert!(!no_protocol.ready);
    assert_eq!(
        no_protocol.envelope(&json!({"kind":"request"}), "generation"),
        Negotiation::Other
    );
    assert!(matches!(
        no_protocol.envelope(&json!({"kind":"connection"}), "generation"),
        Negotiation::Close(_)
    ));
    assert!(no_protocol.legacy_request());
}
#[test]
fn reconnect_jitter_retains_existing_cap_and_attempt_reset_behavior() {
    assert_eq!(reconnect_delay(1000, 0, 0.).as_millis(), 750);
    assert_eq!(reconnect_delay(1000, 1, 1.).as_millis(), 1000);
    assert_eq!(reconnect_delay(1000, 2, 0.).as_millis(), 1500);
    assert_eq!(reconnect_delay(1000, 100, 1.).as_millis(), 15000);
    assert_eq!(reconnect_delay(0, 100, 0.).as_millis(), 1);
}
#[test]
fn closed_transport_rejects_new_results_and_offline_oversize_is_dropped() {
    let queue = Outbound::default();
    assert!(!queue.send(json!({"kind":"response","requestId":"huge","ok":true,"result":"x".repeat(8*1024*1024)})).unwrap());
    assert!(
        queue
            .send(json!({"kind":"response","requestId":"small","ok":true,"result":Value::Null}))
            .unwrap()
    );
    queue.close();
    assert!(
        !queue
            .send(json!({"kind":"response","requestId":"late","ok":true,"result":Value::Null}))
            .unwrap()
    );
}
#[tokio::test]
async fn subscriptions_share_private_buffer_cursor_and_restart_preserves_history() {
    let data = tempfile::tempdir().unwrap();
    let environment = [("NO_COLOR".into(), "1".into())].into_iter().collect();
    let logs = Logs::initialize(data.path(), &environment, data.path()).await;
    let mut reader = logs.subscribe();
    logs.event("trace","Captured below console threshold",json!({"event":"worker.test","token":"ctwk_synthetic-secret","privatePath":"/private/synthetic-secret"}));
    let first = reader.recv().await.unwrap();
    assert!(!first.stringify().contains("synthetic-secret"));
    let snapshot = logs.read(&json!({})).unwrap();
    assert_eq!(snapshot["records"].as_array().unwrap()[0], first);
    logs.close().await;
    assert!(reader.recv().await.is_none());
    logs.reopen(data.path(), &environment, data.path()).await;
    let mut next = logs.subscribe();
    logs.event(
        "info",
        "New runtime",
        json!({"event":"worker.test.restarted"}),
    );
    let second = next.recv().await.unwrap();
    assert!(second["cursor"].as_u64() > first["cursor"].as_u64());
    assert_eq!(
        logs.read(&json!({})).unwrap()["records"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    logs.close().await;
}
#[test]
fn worker_archive_overrides_preserve_root_and_legacy_file_policy() {
    let data = std::path::Path::new("/data/worker");
    let cwd = std::path::Path::new("/cwd");
    let environment = [("CANTRIP_SERVICE_LOG_FILE".into(), "/".into())]
        .into_iter()
        .collect();
    let options = archive_options(data, &environment, cwd);
    assert_eq!(options.directory, std::path::Path::new("/"));
    assert_eq!(options.source, "worker");
}

#[test]
fn hostname_failure_cannot_block_an_explicit_identity() {
    use cantrip_worker::config::{Host, read_with_hostname};
    let root = tempfile::tempdir().unwrap();
    let host = Host {
        cwd: root.path(),
        worker_root: root.path(),
        platform: "darwin",
        architecture: "arm64",
        hostname: "",
    };
    let mut environment = [
        (
            "CANTRIP_WORKER_DATA_DIR".into(),
            root.path().to_string_lossy().into_owned(),
        ),
        (
            "CANTRIP_WORKER_CREDENTIAL".into(),
            format!("ctwk_{}", "a".repeat(43)),
        ),
        ("CANTRIP_WORKER_ID".into(), "explicit-worker".into()),
    ]
    .into_iter()
    .collect();
    let result =
        read_with_hostname(&environment, &host, || panic!("unneeded hostname lookup")).unwrap();
    assert_eq!(result.worker_id, "explicit-worker".into());
    environment.remove("CANTRIP_WORKER_CREDENTIAL");
    environment.remove("CANTRIP_WORKER_ID");
    environment.insert("CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP".into(), "true".into());
    assert!(
        read_with_hostname(&environment, &host, || anyhow::bail!(
            "hostname unavailable"
        ))
        .is_err()
    );
}
