use cantrip_server::{
    chats::recovery::scheduler::{Scheduler, key},
    wire::{JsString, Value},
};
use futures::FutureExt;
use std::time::Duration;
use tokio::{
    sync::{mpsc, oneshot},
    time::{Instant, advance},
};
fn turn() -> JsString {
    "turn".into()
}
#[tokio::test(start_paused = true)]
async fn recovery_deadline_starts_when_admitted_before_the_executor_polls_it() {
    let scheduler = Scheduler::new();
    let began = Instant::now();
    let (send, receive) = oneshot::channel();
    assert!(scheduler.schedule(turn(), move || {
        async move {
            send.send(Instant::now() - began).unwrap();
        }
        .boxed()
    }));
    advance(Duration::from_secs(2)).await;
    assert_eq!(receive.await.unwrap(), Duration::from_secs(2));
    scheduler.clear();
    scheduler.drained().await;
}
#[tokio::test(start_paused = true)]
async fn rescheduling_cancels_old_callback_and_preserves_the_new_deadline() {
    let scheduler = Scheduler::new();
    let (send, mut receive) = mpsc::unbounded_channel();
    let old = send.clone();
    scheduler.schedule(turn(), move || {
        async move {
            old.send("old").unwrap();
        }
        .boxed()
    });
    tokio::task::yield_now().await;
    advance(Duration::from_millis(500)).await;
    scheduler.schedule(turn(), move || {
        async move {
            send.send("new").unwrap();
        }
        .boxed()
    });
    tokio::task::yield_now().await;
    advance(Duration::from_millis(500)).await;
    assert!(receive.try_recv().is_err());
    advance(Duration::from_millis(500)).await;
    assert_eq!(receive.recv().await, Some("new"));
    assert!(receive.try_recv().is_err());
    scheduler.clear();
    scheduler.drained().await;
}
#[tokio::test(start_paused = true)]
async fn repeated_settlement_suppresses_pending_recovery_and_renews_retention() {
    let scheduler = Scheduler::new();
    let (send, mut receive) = mpsc::unbounded_channel();
    scheduler.schedule(turn(), move || {
        async move {
            send.send(()).unwrap();
        }
        .boxed()
    });
    scheduler.settle(&turn());
    tokio::task::yield_now().await;
    advance(Duration::from_secs(30)).await;
    scheduler.settle(&turn());
    tokio::task::yield_now().await;
    advance(Duration::from_secs(30)).await;
    assert!(!scheduler.schedule(turn(), || {
        async { panic!("settled outcome was replayed") }.boxed()
    }));
    assert!(receive.try_recv().is_err());
    advance(Duration::from_secs(31)).await;
    tokio::task::yield_now().await;
    assert!(scheduler.schedule(turn(), || async {}.boxed()));
    scheduler.clear();
}
#[tokio::test(start_paused = true)]
async fn clearing_timers_retains_an_already_admitted_recovery_through_drain() {
    let scheduler = Scheduler::new();
    let (start, started) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let (finish, finished) = oneshot::channel();
    scheduler.schedule(turn(), move || {
        async move {
            start.send(()).unwrap();
            released.await.unwrap();
            finish.send(()).unwrap();
        }
        .boxed()
    });
    tokio::task::yield_now().await;
    advance(Duration::from_secs(1)).await;
    started.await.unwrap();
    scheduler.clear();
    let drain = scheduler.drained();
    tokio::pin!(drain);
    assert!(
        tokio::time::timeout(Duration::ZERO, &mut drain)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    drain.await;
    finished.await.unwrap();
    assert!(scheduler.schedule(turn(), || async {}.boxed()));
    scheduler.clear();
}
#[test]
fn outcome_key_retains_exact_javascript_utf16_units() {
    let worker = Value::String(JsString::new(vec![0xd800]));
    let actual = key(
        &worker,
        &Value::String("chat".into()),
        &Value::String("message".into()),
    );
    let mut expected = vec![0xd800];
    expected.extend(":chat:message".encode_utf16());
    assert_eq!(actual.units(), expected);
}
