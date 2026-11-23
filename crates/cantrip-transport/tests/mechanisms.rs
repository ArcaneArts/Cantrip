use cantrip_transport::{
    command_deadline::CommandDeadline,
    correlation::{Correlation, Delivery},
    lifecycle::owned,
    notifications::{NotificationHandler, Notifications},
    output::{Buffered, framed_size},
    peer::{Continuity, Outgoing, Peer},
};
use cantrip_wire::Value;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

#[test]
fn byte_reservations_survive_take_until_flush_or_abandonment() {
    let buffered = Buffered::default();
    let mut first = buffered.bounded("first", framed_size(4), 6).unwrap();
    assert_eq!(buffered.bytes(), 6);
    let crossing = buffered.bounded("crossing", 5, 6).unwrap();
    assert!(buffered.bounded("rejected", 1, 6).is_none());
    assert_eq!(first.take(), "first");
    assert_eq!(
        buffered.bytes(),
        11,
        "taking a write must not release its reservation before flushing"
    );
    drop(first);
    assert_eq!(buffered.bytes(), 5);
    drop(crossing);
    assert_eq!(buffered.bytes(), 0);
    let (peer, mut receiver) = Peer::new(Continuity {
        owner: "owner".into(),
        credential: "credential".into(),
        process_generation: "generation".into(),
    });
    assert!(peer.send_text("abc".into()));
    let queued = receiver.try_recv().unwrap();
    assert_eq!(peer.buffered_amount(), 5);
    drop(queued);
    peer.close_empty();
    let deadline = peer.close_deadline().unwrap();
    peer.close(1011, "later close");
    assert_eq!(peer.close_deadline(), Some(deadline));
    assert!(
        matches!(receiver.try_recv().unwrap(), Outgoing::Close(1005, reason) if reason.is_empty())
    );
    assert!(!peer.send_text("late".into()));
    assert_eq!(peer.buffered_amount(), 0);
}

#[tokio::test(start_paused = true)]
async fn waiting_pauses_deadlines_and_preparation_and_execution_keep_separate_budgets() {
    let mut deadline = CommandDeadline::new(Some(Duration::from_secs(10)));
    tokio::time::advance(Duration::from_secs(3)).await;
    assert!(deadline.observe(1, "waiting"));
    tokio::time::advance(Duration::from_secs(100)).await;
    assert_eq!(deadline.remaining(), None);
    assert!(!deadline.observe(1, "running"));
    assert!(!deadline.observe(2, "invalid"));
    assert!(deadline.observe(2, "preparing"));
    assert_eq!(deadline.remaining(), Some(Duration::from_secs(7)));
    assert!(deadline.observe(3, "running"));
    tokio::time::advance(Duration::from_secs(4)).await;
    assert!(deadline.observe(4, "waiting"));
    tokio::time::advance(Duration::from_secs(100)).await;
    assert!(deadline.observe(5, "running"));
    assert_eq!(deadline.remaining(), Some(Duration::from_secs(6)));
    tokio::time::advance(Duration::from_secs(7)).await;
    assert_eq!(deadline.remaining(), Some(Duration::ZERO));
    assert_eq!(CommandDeadline::new(None).remaining(), None);
}

#[tokio::test]
async fn completion_preserves_delivery_order_and_runs_cleanup_only_once() {
    let (correlation, response, mut delivery) = Correlation::<u32, u32>::channel();
    correlation.event(1);
    correlation.event(2);
    correlation.response(3);
    let cleaned = AtomicUsize::new(0);
    correlation.finish(3, |_| {
        cleaned.fetch_add(1, Ordering::SeqCst);
    });
    correlation.finish(4, |_| {
        cleaned.fetch_add(1, Ordering::SeqCst);
    });
    assert_eq!(response.await.unwrap(), 3);
    assert_eq!(cleaned.load(Ordering::SeqCst), 1);
    assert!(matches!(delivery.recv().await, Some(Delivery::Event(1))));
    assert!(matches!(delivery.recv().await, Some(Delivery::Event(2))));
    assert!(matches!(delivery.recv().await, Some(Delivery::Response(3))));
    assert!(matches!(delivery.recv().await, Some(Delivery::Finished)));
    assert!(delivery.try_recv().is_err());
    let (correlation, response, _) = Correlation::<(), ()>::channel();
    drop(response);
    correlation.finish((), |_| {
        cleaned.fetch_add(1, Ordering::SeqCst);
    });
    assert_eq!(
        cleaned.load(Ordering::SeqCst),
        2,
        "a dropped caller must not skip owned cleanup"
    );
}

#[tokio::test]
async fn eager_operations_continue_after_the_callers_future_is_dropped() {
    let calls = Arc::new(AtomicUsize::new(0));
    let target = calls.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    let (complete, completed) = tokio::sync::oneshot::channel();
    let result = owned(async move {
        target.fetch_add(1, Ordering::SeqCst);
        receive.await.unwrap();
        target.fetch_add(1, Ordering::SeqCst);
        let _ = complete.send(());
        Ok(())
    });
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    drop(result);
    send.send(()).unwrap();
    completed.await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn notification_prefixes_run_in_order_before_pending_listeners_continue() {
    let notifications = Arc::new(Notifications::default());
    let trace = Arc::new(Mutex::new(Vec::new()));
    let (send, receive) = tokio::sync::oneshot::channel();
    let receive = Arc::new(Mutex::new(Some(receive)));
    let (complete, completed) = tokio::sync::oneshot::channel();
    let complete = Arc::new(Mutex::new(Some(complete)));
    let first: NotificationHandler = {
        let (trace, receive, complete) = (trace.clone(), receive.clone(), complete.clone());
        Arc::new(move |_| {
            let (trace, receive, complete) = (
                trace.clone(),
                receive.lock().unwrap().take().unwrap(),
                complete.lock().unwrap().take().unwrap(),
            );
            Box::pin(async move {
                trace.lock().unwrap().push("first-prefix");
                receive.await.unwrap();
                trace.lock().unwrap().push("first-complete");
                let _ = complete.send(());
                Ok(())
            })
        })
    };
    let _first = notifications.subscribe("connection", first);
    let _second = notifications.subscribe("connection", {
        let trace = trace.clone();
        Arc::new(move |_| {
            let trace = trace.clone();
            Box::pin(async move {
                trace.lock().unwrap().push("second-prefix");
                anyhow::bail!("listener rejected")
            })
        })
    });
    let _third = notifications.subscribe_owned("connection", {
        let trace = trace.clone();
        Arc::new(move |owner, _| {
            assert_eq!(owner, "owner");
            let trace = trace.clone();
            Box::pin(async move {
                trace.lock().unwrap().push("third-prefix");
                Ok(())
            })
        })
    });
    Notifications::deliver(
        notifications.group("connection").unwrap(),
        "owner",
        Value::Null,
    );
    assert_eq!(
        *trace.lock().unwrap(),
        ["first-prefix", "second-prefix", "third-prefix"]
    );
    send.send(()).unwrap();
    completed.await.unwrap();
    assert_eq!(
        *trace.lock().unwrap(),
        [
            "first-prefix",
            "second-prefix",
            "third-prefix",
            "first-complete"
        ]
    );
}
