use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
const GENERATION: &str = "00000000-0000-4000-8000-000000000001";
fn identity(operation: &str) -> Value {
    json!({"operationId":operation,"providerId":"fixture","runtimeGeneration":GENERATION,
        "recoveryKey":Value::Null,"recovery":Value::Null,"chatId":Value::Null,"projectId":Value::Null})
}
#[tokio::test]
async fn accepted_writes_keep_fifo_across_reentrant_batches_and_abandoned_waiters() {
    let slot = Arc::new(Mutex::new(None::<Journal>));
    let hook = slot.clone();
    let injected = AtomicBool::new(false);
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let journal = Journal::new(
        GENERATION.into(),
        Arc::new(move |command| {
            if !injected.swap(true, Ordering::SeqCst) {
                let journal = hook.lock().unwrap().clone().unwrap();
                drop(journal.enqueue("reentrant".into(), identity("33")));
            }
            let (release, response) = oneshot::channel();
            send.send((command, release)).unwrap();
            cantrip_transport::lifecycle::owned(async move { Ok(response.await?) })
        }),
    );
    *slot.lock().unwrap() = Some(journal.clone());
    for i in 0..33 {
        drop(journal.enqueue(format!("key-{i}"), identity(&i.to_string())));
    }
    let mut flushed = journal.flush();
    assert!(flushed.as_mut().now_or_never().is_none());
    let mut order = Vec::new();
    for expected in [32, 1, 1] {
        let (command, release) = receive.recv().await.unwrap();
        let items = command["commands"].as_array().unwrap();
        assert_eq!(items.len(), expected);
        assert!(items.iter().map(|v| v.stringify().len() + 1).sum::<usize>() <= 60_001);
        order.extend(items.iter().map(|v| v["identity"]["operationId"].clone()));
        assert!(flushed.as_mut().now_or_never().is_none());
        // Individual negative acknowledgements settle writes too; abandonment
        // never bypasses the matching keeper response or blocks shutdown.
        release
            .send(Some(Value::Array(
                items.iter().map(|_| json!({"ok":false})).collect(),
            )))
            .unwrap();
    }
    flushed.await.unwrap();
    assert_eq!(
        order,
        (0..34).map(|i| json!(i.to_string())).collect::<Vec<_>>()
    );
    slot.lock().unwrap().take();
}
#[tokio::test]
async fn initialization_shares_the_read_and_retries_a_rejected_snapshot() {
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let journal = Journal::new(
        GENERATION.into(),
        Arc::new(move |command| {
            assert_eq!(command["action"], json!("snapshot"));
            let (release, response) = oneshot::channel();
            send.send(release).unwrap();
            cantrip_transport::lifecycle::owned(async move { Ok(response.await?) })
        }),
    );
    let one = journal.initialize();
    let two = journal.initialize();
    let release = receive.recv().await.unwrap();
    assert!(receive.try_recv().is_err());
    release
        .send(Some(
            json!({"version":1,"revision":0,"operations":Value::Object(Default::default()),"unexpected":true}),
        ))
        .unwrap();
    assert!(one.await.is_err());
    assert!(two.await.is_err());
    let retry = journal.initialize();
    receive
        .recv()
        .await
        .unwrap()
        .send(Some(
            json!({"version":1,"revision":0,"operations":Value::Object(Default::default())}),
        ))
        .unwrap();
    retry.await.unwrap();
    assert!(journal.recovery_snapshot().is_empty());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flush_joins_release_cache_updates_after_the_caller_drops_its_waiter() {
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let journal = Journal::new(
        GENERATION.into(),
        Arc::new(move |command| {
            assert_eq!(command["action"], json!("batch"));
            let (release, response) = oneshot::channel();
            send.send(release).unwrap();
            cantrip_transport::lifecycle::owned(async move { Ok(response.await?) })
        }),
    );
    let key = "a".repeat(64);
    let mut source = identity("goal-operation");
    source["recovery"] = json!({"commandId":"c","commandGeneration":"g","threadId":"t","turnId":"u","autonomousGoal":json!({"goalEpoch":"epoch","orderEpoch":0})});
    let record = json!({"key":key,"identity":source,"workerGeneration":GENERATION,
        "state":"released","order":1,"revision":2,"everGranted":true,"outcome":"never-started"});
    drop(journal.release(key, "never-started".into()));
    let mut flushed = journal.flush();
    assert!(flushed.as_mut().now_or_never().is_none());
    receive
        .recv()
        .await
        .unwrap()
        .send(Some(json!([json!({"ok":true,"result":record.clone()})])))
        .unwrap();
    flushed.await.unwrap();
    assert_eq!(journal.recovery_snapshot(), vec![record]);
}
