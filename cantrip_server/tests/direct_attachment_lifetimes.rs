use anyhow::Result;
use cantrip_server::{
    direct_attachments::{Coordinator, Options, PrepareInput},
    wire::Value,
};
use futures::FutureExt;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch};
fn json(v: impl serde::Serialize) -> Value {
    Value::from_serialize(&v)
}
fn input(tunnel: bool) -> Value {
    json(
        serde_json::json!({"ownerId":"owner","authSessionId":"account","attachmentId":"attachment","resourceId":"resource","resourceKind":if tunnel{"tunnel"}else{"worker-link"},"channels":[if tunnel{"tunnel-data"}else{"worker-link"}],"worker":{"workerId":"worker","online":true,"directBroker":{"available":true,"leaseRenewal":true,"protocol":"ws-v1","loopbackHost":"127.0.0.1","loopbackPort":43123,"instanceId":"55555555-5555-4555-8555-555555555555","publicKey":"a".repeat(43),"fingerprint":"b".repeat(64)}}}),
    )
}
async fn prepare(core: &Arc<Coordinator>, input: Value) -> Result<Value> {
    let lease = core.acquire_preparation(input.clone()).unwrap();
    let result = core
        .prepare(PrepareInput {
            value: input,
            lease: lease.clone(),
        })
        .await;
    core.release_preparation(&lease);
    result
}
fn authorization() -> Value {
    json(
        serde_json::json!({"ownerId":"owner","authSessionId":"account","attachmentId":"attachment"}),
    )
}
#[tokio::test]
async fn actual_expiry_keeps_the_worker_revoke_alive_until_acknowledgment() -> Result<()> {
    let (started, mut requests) = mpsc::unbounded_channel();
    let (done, mut completed) = mpsc::unbounded_channel();
    let (gate, _) = watch::channel(false);
    let gate = Arc::new(gate);
    let release = gate.clone();
    let core = Coordinator::new(
        Arc::new(move |_, command, _| {
            let (started, done, gate) = (started.clone(), done.clone(), gate.clone());
            async move {
            if command["type"]=="direct.capability.prepare" {return Ok(json(serde_json::json!({"accepted":true,"capabilityId":command["binding"]["capabilityId"]})));}
            started.send(())?;let mut waiting=gate.subscribe();while !*waiting.borrow_and_update(){waiting.changed().await?;}done.send(())?;Ok(Value::Null)
        }.boxed()
        }),
        Options {
            connected: Arc::new(|_| true),
            logger: Arc::new(|_| {}),
            ..Default::default()
        },
    );
    let mut request = input(false);
    request["leaseExpiresAt"] = json(crate_iso(chrono::Utc::now().timestamp_millis() + 2000));
    let ticket = prepare(&core, request).await?;
    let capability = ticket["binding"]["capabilityId"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(10), requests.recv())
        .await?
        .expect("Expiry delivered an actual worker revoke");
    assert!(!core.matches(capability, &authorization()));
    assert!(completed.try_recv().is_err());
    let mut draining = Box::pin(core.drained());
    assert!(draining.as_mut().now_or_never().is_none());
    release.send(true)?;
    tokio::time::timeout(Duration::from_secs(5), completed.recv())
        .await?
        .expect("Timer revoke survived until its worker acknowledgment");
    core.close().await;
    tokio::time::timeout(Duration::from_secs(5), draining).await?;
    Ok(())
}
fn crate_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
#[tokio::test]
async fn shutdown_waits_for_renewed_and_finalized_tunnel_persistence() -> Result<()> {
    let now = Arc::new(AtomicI64::new(1793145600000));
    let clock = now.clone();
    let (events, mut observed) = mpsc::unbounded_channel();
    let (gate, _) = watch::channel(false);
    let release = gate.clone();
    let logs = Arc::new(Mutex::new(Vec::new()));
    let captured = logs.clone();
    let core = Coordinator::new(
        Arc::new(|_, command, _| {
            async move {
        Ok(if command["type"]=="direct.capability.prepare" {json(serde_json::json!({"accepted":true,"capabilityId":command["binding"]["capabilityId"]}))}
            else if command["type"]=="direct.capability.renew" {json(serde_json::json!({"renewed":true,"leaseExpiresAt":command["leaseExpiresAt"]}))}else{Value::Null})
    }.boxed()
        }),
        Options {
            now: Arc::new(move || clock.load(Ordering::SeqCst)),
            connected: Arc::new(|_| true),
            automatic_expiry: false,
            logger: Arc::new(move |call| captured.lock().unwrap().push(call.context)),
            observer: Some(Arc::new(move |kind, _| {
                let (events, mut waiting) = (events.clone(), gate.subscribe());
                async move {
                    events.send(kind)?;
                    while !*waiting.borrow_and_update() {
                        waiting.changed().await?;
                    }
                    anyhow::bail!("private persistence details")
                }
                .boxed()
            })),
            ..Default::default()
        },
    );
    let mut request = input(true);
    request["tunnelRoute"] = json(
        serde_json::json!({"tunnelId":"resource","attachmentId":"attachment","sourceEndpointId":"client","destinationEndpointId":"worker","target":{"kind":"tcp","host":"127.0.0.1","port":43124}}),
    );
    let ticket = prepare(&core, request).await?;
    let capability = ticket["binding"]["capabilityId"].as_str().unwrap();
    let auth = authorization();
    assert!(core.activate(capability, &auth, "completed"));
    now.fetch_add(10000, Ordering::SeqCst);
    assert_eq!(core.renew(capability, &auth).await?["renewed"], true);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), observed.recv()).await?,
        Some("renewed")
    );
    let service = core.clone();
    let closing = tokio::spawn(async move {
        service.close().await;
    });
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), observed.recv()).await?,
        Some("finalized")
    );
    assert!(!closing.is_finished());
    assert!(!core.matches(capability, &auth));
    release.send(true)?;
    tokio::time::timeout(Duration::from_secs(5), closing).await??;
    let logs = logs.lock().unwrap();
    assert_eq!(
        logs.iter()
            .filter(|e| e["event"] == "direct_attachment.lease-persistence.failed")
            .count(),
        2
    );
    assert!(
        !Value::Array(logs.clone())
            .stringify()
            .contains("private persistence details")
    );
    Ok(())
}
