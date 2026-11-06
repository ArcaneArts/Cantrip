use cantrip_server::{
    wire::Value,
    workers::{
        bridge::{Continuity, Outgoing, Peer, WorkerBridge},
        command_bus::CommandDelegate,
        transport::WorkerTransport,
    },
};
use std::{sync::Arc, time::Duration};

fn peer() -> (Arc<Peer>, tokio::sync::mpsc::UnboundedReceiver<Outgoing>) {
    Peer::new(Continuity {
        owner: "owner".into(),
        credential: "credential".into(),
        process_generation: "process".into(),
    })
}

#[tokio::test]
async fn attachment_and_shutdown_start_even_when_the_caller_drops_the_future() {
    let transport: Arc<dyn WorkerTransport> = WorkerBridge::new(Duration::from_secs(15));
    let (peer, mut output) = peer();
    let attached = transport.attach_worker(
        "worker".into(),
        peer.clone(),
        Some("owner".into()),
        Some("ready".into()),
    );
    assert!(transport.is_connected("worker"));
    assert_eq!(
        transport.connection_identity("worker"),
        Some(peer.identity.clone())
    );
    assert!(matches!(output.try_recv().unwrap(), Outgoing::Text(_)));
    drop(attached);
    let closed = transport.shutdown();
    assert!(!transport.is_connected("worker"));
    assert!(!peer.is_open());
    drop(closed);
}

#[tokio::test]
async fn the_transport_upcasts_to_the_command_bus_delegate_without_changing_correlation() {
    let transport: Arc<dyn WorkerTransport> = WorkerBridge::new(Duration::from_secs(15));
    let (peer, mut output) = peer();
    assert!(
        transport
            .attach_worker("worker".into(), peer.clone(), Some("owner".into()), None)
            .await
            .unwrap()
    );
    let delegate: Arc<dyn CommandDelegate> = transport.clone();
    let result = tokio::spawn(delegate.request(
        "owner".into(),
        "worker".into(),
        Value::from_serialize(&serde_json::json!({"type":"worker.version"})),
        Some(Duration::from_secs(30)),
        None,
    ));
    let Outgoing::Text(mut text) = output.recv().await.unwrap() else {
        panic!("worker request")
    };
    let request: serde_json::Value = serde_json::from_str(&text.take()).unwrap();
    assert_eq!(request["command"]["type"], "worker.version");
    transport.local().receive(
        "worker",
        &peer,
        &serde_json::json!({
            "kind":"response", "requestId":request["requestId"],
            "ok":true, "result":{"correlated":true},
        })
        .to_string(),
    );
    assert_eq!(result.await.unwrap().unwrap().unwrap()["correlated"], true);
    assert_eq!(transport.stats().active_requests, 0);
    assert_eq!(transport.stats().succeeded_requests, 1);
    transport.shutdown().await.unwrap();
}
