use cantrip_server::{
    wire::{JsString, Value},
    workers::bridge::{CommandError, Continuity, EventHandler, Outgoing, Peer, WorkerBridge},
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc};

fn identity() -> Continuity {
    Continuity {
        owner: "owner".into(),
        credential: "credential".into(),
        process_generation: "process".into(),
    }
}
fn command() -> Value {
    Value::from_serialize(
        &serde_json::json!({"type":"worker.credential.rotate","credential":format!("ctwk_{}","A".repeat(43))}),
    )
}
fn connect(
    bridge: &WorkerBridge,
    identity: Continuity,
) -> (Arc<Peer>, mpsc::UnboundedReceiver<Outgoing>) {
    let (peer, rx) = Peer::new(identity);
    assert!(bridge.attach("worker", peer.clone(), Some("ready".into())));
    (peer, rx)
}
async fn text(rx: &mut mpsc::UnboundedReceiver<Outgoing>) -> String {
    match rx.recv().await.unwrap() {
        Outgoing::Text(text) => text,
        _ => panic!("Expected control text"),
    }
}
fn ok(id: &str) -> Value {
    Value::from_serialize(
        &serde_json::json!({"kind":"response","requestId":id,"ok":true,"result":{"fixture":true}}),
    )
}
async fn request(
    bridge: &Arc<WorkerBridge>,
    rx: &mut mpsc::UnboundedReceiver<Outgoing>,
    handler: Option<EventHandler>,
) -> (
    String,
    tokio::task::JoinHandle<Result<Option<Value>, CommandError>>,
) {
    let bridge = bridge.clone();
    let result = tokio::spawn(async move {
        bridge
            .request("worker", command(), Some(Duration::from_secs(600)), handler)
            .await
    });
    let message: Value = serde_json::from_str(&text(rx).await).unwrap();
    assert_eq!(message["kind"], "request");
    assert_eq!(message["command"], command());
    let id = message["requestId"].as_str().unwrap();
    assert_eq!(uuid::Uuid::parse_str(id).unwrap().get_version_num(), 4);
    (id.into(), result)
}
#[tokio::test(start_paused = true)]
async fn readiness_events_response_order_and_cleared_deadline() {
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let (peer, mut rx) = connect(&bridge, identity());
    assert_eq!(text(&mut rx).await, "ready");
    let gate = Arc::new(Semaphore::new(0));
    let events = Arc::new(Mutex::new(Vec::new()));
    let handler: EventHandler = {
        let gate = gate.clone();
        let events = events.clone();
        Arc::new(move |event| {
            let gate = gate.clone();
            let events = events.clone();
            Box::pin(async move {
                let value = event.as_i64().unwrap();
                events.lock().unwrap().push(value);
                if value == 1 {
                    gate.acquire().await.unwrap().forget();
                }
                Ok(())
            })
        })
    };
    let (id, result) = request(&bridge, &mut rx, Some(handler)).await;
    bridge.event("worker", &peer, &id, Value::Number(1.0));
    bridge.event("worker", &peer, &id, Value::Number(2.0));
    bridge.response("worker", &peer, &ok(&id));
    tokio::task::yield_now().await;
    assert!(!result.is_finished());
    assert_eq!(bridge.stats().active_requests, 0);
    tokio::time::advance(Duration::from_secs(601)).await;
    assert!(!result.is_finished());
    gate.add_permits(1);
    assert_eq!(result.await.unwrap().unwrap().unwrap()["fixture"], true);
    assert_eq!(*events.lock().unwrap(), vec![1, 2]);
    assert_eq!(bridge.stats().succeeded_requests, 1);
    assert_eq!(bridge.stats().failed_requests, 0);
    bridge.close();
}
#[tokio::test(start_paused = true)]
async fn reconnect_preserves_pending_without_replaying_commands_and_ignores_stale_socket() {
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let (first, mut rx) = connect(&bridge, identity());
    assert_eq!(text(&mut rx).await, "ready");
    let (id, result) = request(&bridge, &mut rx, None).await;
    bridge.interrupted("worker", &first);
    assert!(!bridge.is_connected("worker"));
    tokio::time::advance(Duration::from_secs(10)).await;
    let (second, mut output) = connect(&bridge, identity());
    assert_eq!(text(&mut output).await, "ready");
    assert!(output.try_recv().is_err());
    bridge.response("worker", &first, &ok(&id));
    assert!(!result.is_finished());
    bridge.response("different-worker", &second, &ok(&id));
    assert!(!result.is_finished());
    bridge.response("worker", &second, &ok(&id));
    assert!(result.await.unwrap().is_ok());
    bridge.close();
}
#[tokio::test(start_paused = true)]
async fn identity_fencing_grace_expiry_and_shutdown_close_reject_pending() {
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let (first, mut rx) = connect(&bridge, identity());
    assert_eq!(text(&mut rx).await, "ready");
    let (_, result) = request(&bridge, &mut rx, None).await;
    let mut changed = identity();
    changed.process_generation = "next-process".into();
    let (second, mut output) = connect(&bridge, changed);
    assert_eq!(text(&mut output).await, "ready");
    let error = result.await.unwrap().unwrap_err();
    assert!(error.unavailable);
    assert_eq!(
        error.message.as_str(),
        Some("Worker worker continuity identity changed.")
    );
    assert!(!first.is_open());
    assert!(matches!(rx.recv().await, Some(Outgoing::Close(1008, _))));
    let (_, result) = request(&bridge, &mut output, None).await;
    bridge.interrupted("worker", &second);
    tokio::time::advance(Duration::from_secs(16)).await;
    assert_eq!(
        result.await.unwrap().unwrap_err().message.as_str(),
        Some("Worker worker disconnected.")
    );
    assert_eq!(bridge.stats().active_requests, 0);
    let (_, mut output) = connect(&bridge, identity());
    assert_eq!(text(&mut output).await, "ready");
    let (_, result) = request(&bridge, &mut output, None).await;
    bridge.close();
    assert_eq!(
        result.await.unwrap().unwrap_err().message.as_str(),
        Some("Server is shutting down.")
    );
    assert!(matches!(
        output.recv().await,
        Some(Outgoing::Close(1001, _))
    ));
    assert_eq!(bridge.stats().failed_requests, 3);
}
#[tokio::test(start_paused = true)]
async fn deadline_cleans_up_actor_and_late_response_cannot_complete_twice() {
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let (peer, mut rx) = connect(&bridge, identity());
    assert_eq!(text(&mut rx).await, "ready");
    let handler: EventHandler = Arc::new(|_| Box::pin(async { Ok(()) }));
    let (id, result) = request(&bridge, &mut rx, Some(handler.clone())).await;
    tokio::time::advance(Duration::from_secs(601)).await;
    let error = result.await.unwrap().unwrap_err();
    assert_eq!(error.code.as_deref(), Some("worker-command-timeout"));
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert_eq!(Arc::strong_count(&handler), 1);
    bridge.response("worker", &peer, &ok(&id));
    assert_eq!(bridge.stats().succeeded_requests, 0);
    assert_eq!(bridge.stats().failed_requests, 1);
    bridge.close();
}
#[tokio::test(start_paused = true)]
async fn callback_failure_and_missing_result_preserve_javascript_semantics() {
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let (peer, mut rx) = connect(&bridge, identity());
    assert_eq!(text(&mut rx).await, "ready");
    let handler: EventHandler = Arc::new(|_| {
        Box::pin(async {
            Err(CommandError {
                message: JsString::new(vec![0xd800]),
                code: None,
                unavailable: false,
                encoding_error: None,
            })
        })
    });
    let (id, result) = request(&bridge, &mut rx, Some(handler)).await;
    bridge.event("worker", &peer, &id, Value::Null);
    bridge.response("worker", &peer, &ok(&id));
    let error = result.await.unwrap().unwrap_err();
    assert_eq!(error.message.units(), &[0xd800]);
    assert_eq!(bridge.stats().failed_requests, 1);
    let (id, result) = request(&bridge, &mut rx, None).await;
    bridge.response(
        "worker",
        &peer,
        &Value::from_serialize(&serde_json::json!({"kind":"response","requestId":id,"ok":true})),
    );
    tokio::task::yield_now().await;
    assert!(
        !result.is_finished(),
        "The actual response schema rejects a missing required result"
    );
    bridge.response(
        "worker",
        &peer,
        &Value::from_serialize(
            &serde_json::json!({"kind":"response","requestId":id,"ok":true,"result":null}),
        ),
    );
    assert_eq!(result.await.unwrap().unwrap(), Some(Value::Null));
    bridge.close();
}
