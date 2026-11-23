use cantrip_server::{
    wire::{ValidationError, Value},
    workers::bridge::{Continuity, Outgoing, Peer, WorkerBridge},
};
use std::time::Duration;

fn value(value: serde_json::Value) -> Value {
    Value::from_serialize(&value)
}

#[tokio::test(start_paused = true)]
async fn offline_rejection_precedes_schema_validation_and_admission() {
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let error = bridge
        .request(
            "offline",
            value(serde_json::json!({})),
            Some(Duration::from_secs(1)),
            None,
        )
        .await
        .unwrap_err();
    assert!(error.unavailable);
    assert!(error.encoding_error.is_none());
    assert_eq!(error.message.as_str(), Some("Worker offline is offline."));
    tokio::time::advance(Duration::from_secs(2)).await;
    let stats = bridge.stats();
    assert_eq!(
        (
            stats.active_requests,
            stats.routed_requests,
            stats.failed_requests
        ),
        (0, 0, 0)
    );
}

#[tokio::test(start_paused = true)]
async fn invalid_commands_have_no_frames_timers_or_request_metrics_and_valid_commands_normalize() {
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let (peer, mut output) = Peer::new(Continuity {
        owner: "owner".into(),
        credential: "credential".into(),
        process_generation: "process".into(),
    });
    assert!(bridge.attach("worker", peer.clone(), None));
    let invalid = value(serde_json::json!({"type":"worker.credential.rotate","credential":1}));
    let error = bridge
        .request("worker", invalid, Some(Duration::from_secs(1)), None)
        .await
        .unwrap_err();
    assert!(!error.unavailable);
    let Some(ValidationError::Invalid(issues)) = error.encoding_error.as_deref() else {
        panic!("Expected typed validation issues");
    };
    assert_eq!(issues.len(), 1);
    assert_eq!(
        issues[0]["path"],
        value(serde_json::json!(["command", "credential"]))
    );
    assert_eq!(issues[0]["code"], "invalid_type");
    assert!(output.try_recv().is_err());
    tokio::time::advance(Duration::from_secs(2)).await;
    let stats = bridge.stats();
    assert_eq!(
        (
            stats.active_requests,
            stats.routed_requests,
            stats.failed_requests
        ),
        (0, 0, 0)
    );

    let mut task = tokio::spawn({
        let bridge = bridge.clone();
        async move {
            bridge.request("worker", value(serde_json::json!({
            "type":"git.recovery.preview", "cwd":"fixture",
            "action":{"type":"createBranch","branch":" fixture ","target":" fixture ","unknownFixture":true},
            "unknownFixture":true
        })),Some(Duration::from_secs(1)),None).await
        }
    });
    let frame = tokio::select! {
        result = &mut task => panic!("Request finished before dispatch: {result:?}"),
        frame = output.recv() => frame,
    };
    let Some(Outgoing::Text(encoded)) = frame else {
        panic!("Expected normalized command");
    };
    let request: Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(request["command"]["action"]["branch"], "fixture");
    assert_eq!(request["command"]["action"]["target"], "fixture");
    assert!(request["command"].get("unknownFixture").is_none());
    assert!(request["command"]["action"].get("unknownFixture").is_none());
    bridge.receive("worker", &peer, &serde_json::json!({"kind":"response","requestId":request["requestId"].as_str().unwrap(),"ok":true,"result":null}).to_string());
    assert_eq!(task.await.unwrap().unwrap(), Some(Value::Null));
    tokio::time::advance(Duration::from_secs(2)).await;
    let stats = bridge.stats();
    assert_eq!(
        (
            stats.active_requests,
            stats.routed_requests,
            stats.failed_requests,
            stats.succeeded_requests
        ),
        (0, 1, 0, 1)
    );
    bridge.close();
}
