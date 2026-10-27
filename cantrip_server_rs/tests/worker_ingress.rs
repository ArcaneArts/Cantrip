use cantrip_server::{
    wire::Value,
    workers::bridge::{
        Continuity, EventHandler, NotificationHandler, NotificationSubscription, Outgoing, Peer,
        WorkerBridge,
    },
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc};

fn peer(bridge: &WorkerBridge, worker: &str) -> (Arc<Peer>, mpsc::UnboundedReceiver<Outgoing>) {
    let (peer, output) = Peer::new(Continuity {
        owner: "fixture-owner".into(),
        credential: "fixture-credential".into(),
        process_generation: "fixture-process".into(),
    });
    assert!(bridge.attach(worker, peer.clone(), None));
    (peer, output)
}
fn notification(revision: u64) -> String {
    serde_json::json!({"kind":"notification","notification":{
        "type":"chat.thread.changed","threadId":"fixture-thread","revision":revision,"changes":["turn"]
    }}).to_string()
}
fn event(request: &str, question: serde_json::Value) -> String {
    serde_json::json!({"kind":"event","requestId":request,"event":{
        "type":"agent.plan.question-resolved","questionId":question,"unknownFixture":true
    }})
    .to_string()
}

#[tokio::test(start_paused = true)]
async fn ingress_validates_and_normalizes_events_before_ordered_completion() {
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let (peer, mut output) = peer(&bridge, "worker");
    let gate = Arc::new(Semaphore::new(0));
    let received = Arc::new(Mutex::new(Vec::new()));
    let handler: EventHandler = {
        let gate = gate.clone();
        let received = received.clone();
        Arc::new(move |event| {
            let gate = gate.clone();
            let received = received.clone();
            Box::pin(async move {
                assert!(event.get("unknownFixture").is_none());
                let question = event["questionId"].as_str().unwrap().to_owned();
                received.lock().unwrap().push(question.clone());
                if question == "one" {
                    gate.acquire().await.unwrap().forget();
                }
                Ok(())
            })
        })
    };
    let pending = {
        let bridge = bridge.clone();
        tokio::spawn(async move {
            bridge.request("worker", Value::from_serialize(&serde_json::json!({
                "type":"worker.credential.rotate","credential":format!("ctwk_{}","A".repeat(43))
            })), Some(Duration::from_secs(60)), Some(handler)).await
        })
    };
    let Some(Outgoing::Text(request)) = output.recv().await else {
        panic!("request not dispatched")
    };
    let request: serde_json::Value = serde_json::from_str(&request).unwrap();
    let id = request["requestId"].as_str().unwrap();
    bridge.receive("worker", &peer, "{");
    bridge.receive("worker", &peer, &event(id, serde_json::Value::Null));
    bridge.receive("worker", &peer, &event(id, "one".into()));
    bridge.receive("worker", &peer, &event(id, "two".into()));
    bridge.receive(
        "worker",
        &peer,
        &serde_json::json!({
            "kind":"response","requestId":id,"ok":true,"result":{"retained":true}
        })
        .to_string(),
    );
    tokio::task::yield_now().await;
    assert_eq!(*received.lock().unwrap(), vec!["one"]);
    assert_eq!(bridge.stats().active_requests, 0);
    tokio::time::advance(Duration::from_secs(61)).await;
    assert!(!pending.is_finished());
    gate.add_permits(1);
    assert_eq!(pending.await.unwrap().unwrap().unwrap()["retained"], true);
    assert_eq!(*received.lock().unwrap(), vec!["one", "two"]);
    assert_eq!(bridge.stats().succeeded_requests, 1);
    bridge.close();
}

#[tokio::test(start_paused = true)]
async fn notifications_are_validated_scoped_and_retained_across_reconnect() {
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let (first, _first_output) = peer(&bridge, "worker");
    let (other, _other_output) = peer(&bridge, "other");
    let received = Arc::new(Mutex::new(Vec::new()));
    let handler: NotificationHandler = {
        let received = received.clone();
        Arc::new(move |value| {
            let received = received.clone();
            Box::pin(async move {
                received.lock().unwrap().push(value);
                Ok(())
            })
        })
    };
    let subscription = bridge.subscribe_notifications("worker", handler.clone());
    let duplicate = bridge.subscribe_notifications("worker", handler.clone());
    bridge.receive("other", &first, &notification(1));
    bridge.receive("other", &other, &notification(1));
    bridge.receive("worker", &first, &notification(0));
    assert!(received.lock().unwrap().is_empty());
    let normalized = serde_json::json!({"kind":"notification","notification":{
        "type":"chat.turn.outcome","chatId":"chat","clientMessageId":"message",
        "executionLaneId":"lane","worktreeId":"worktree","outcome":{"ok":false,"error":"failed"},
        "unknownFixture":true
    }})
    .to_string();
    bridge.receive("worker", &first, &normalized);
    {
        let received = received.lock().unwrap();
        assert_eq!(received.len(), 1);
        assert_eq!(received[0]["contextKind"], "project");
        assert!(received[0]["scratchRootId"].is_null());
        assert!(received[0].get("unknownFixture").is_none());
    }
    bridge.interrupted("worker", &first);
    let (second, _second_output) = peer(&bridge, "worker");
    bridge.receive("worker", &first, &notification(2));
    assert_eq!(received.lock().unwrap().len(), 1);
    bridge.receive("worker", &second, &notification(2));
    assert_eq!(received.lock().unwrap().len(), 2);
    drop(subscription);
    bridge.receive("worker", &second, &notification(3));
    assert_eq!(received.lock().unwrap().len(), 2);
    let replacement = bridge.subscribe_notifications("worker", handler);
    drop(duplicate);
    bridge.receive("worker", &second, &notification(4));
    assert_eq!(received.lock().unwrap().len(), 3);
    bridge.close();
    bridge.receive("worker", &second, &notification(5));
    assert_eq!(received.lock().unwrap().len(), 3);
    drop(replacement);
}

#[tokio::test(start_paused = true)]
async fn notification_prefixes_are_ordered_and_async_listeners_complete_independently() {
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let (peer, _output) = peer(&bridge, "worker");
    let gate = Arc::new(Semaphore::new(0));
    let log = Arc::new(Mutex::new(Vec::new()));
    let (complete, mut completion) = mpsc::unbounded_channel();
    let first: NotificationHandler = {
        let log = log.clone();
        let gate = gate.clone();
        Arc::new(move |value| {
            let log = log.clone();
            let gate = gate.clone();
            let complete = complete.clone();
            Box::pin(async move {
                let revision = value["revision"].as_u64().unwrap();
                log.lock().unwrap().push(format!("first:{revision}"));
                gate.acquire().await.unwrap().forget();
                let _ = complete.send(revision);
                Ok(())
            })
        })
    };
    let second: NotificationHandler = {
        let log = log.clone();
        Arc::new(move |value| {
            let log = log.clone();
            Box::pin(async move {
                log.lock()
                    .unwrap()
                    .push(format!("second:{}", value["revision"]));
                tokio::task::yield_now().await;
                anyhow::bail!("controlled notification listener rejection")
            })
        })
    };
    let _first = bridge.subscribe_notifications("worker", first);
    let _second = bridge.subscribe_notifications("worker", second);
    bridge.receive("worker", &peer, &notification(1));
    bridge.receive("worker", &peer, &notification(2));
    assert_eq!(
        *log.lock().unwrap(),
        vec!["first:1", "second:1", "first:2", "second:2"]
    );
    gate.add_permits(2);
    let mut revisions = vec![
        tokio::time::timeout(Duration::from_secs(1), completion.recv())
            .await
            .unwrap()
            .unwrap(),
        tokio::time::timeout(Duration::from_secs(1), completion.recv())
            .await
            .unwrap()
            .unwrap(),
    ];
    revisions.sort();
    assert_eq!(revisions, vec![1, 2]);
    bridge.close();
}

#[tokio::test]
async fn notification_callbacks_can_remove_and_append_listeners_during_delivery() {
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let (peer, _output) = peer(&bridge, "worker");
    let log = Arc::new(Mutex::new(Vec::new()));
    let removed: Arc<Mutex<Option<NotificationSubscription>>> = Arc::new(Mutex::new(None));
    let added: Arc<Mutex<Option<NotificationSubscription>>> = Arc::new(Mutex::new(None));
    let final_handler: NotificationHandler = {
        let log = log.clone();
        Arc::new(move |_| {
            let log = log.clone();
            Box::pin(async move {
                log.lock().unwrap().push("appended");
                Ok(())
            })
        })
    };
    let first: NotificationHandler = {
        let weak = Arc::downgrade(&bridge);
        let log = log.clone();
        let removed = removed.clone();
        let added = added.clone();
        Arc::new(move |_| {
            let weak = weak.clone();
            let log = log.clone();
            let removed = removed.clone();
            let added = added.clone();
            let final_handler = final_handler.clone();
            Box::pin(async move {
                log.lock().unwrap().push("first");
                let subscription = removed.lock().unwrap().take();
                drop(subscription);
                let needs_add = added.lock().unwrap().is_none();
                if needs_add {
                    *added.lock().unwrap() = Some(
                        weak.upgrade()
                            .unwrap()
                            .subscribe_notifications("worker", final_handler),
                    );
                }
                Ok(())
            })
        })
    };
    let _first = bridge.subscribe_notifications("worker", first);
    let skipped: NotificationHandler = {
        let log = log.clone();
        Arc::new(move |_| {
            let log = log.clone();
            Box::pin(async move {
                log.lock().unwrap().push("removed");
                Ok(())
            })
        })
    };
    *removed.lock().unwrap() = Some(bridge.subscribe_notifications("worker", skipped));
    bridge.receive("worker", &peer, &notification(1));
    assert_eq!(*log.lock().unwrap(), vec!["first", "appended"]);
    bridge.close();
}
