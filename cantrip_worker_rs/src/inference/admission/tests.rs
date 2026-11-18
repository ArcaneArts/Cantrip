use super::*;
use futures::FutureExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::oneshot;
fn manager() -> Manager {
    Manager::new(Options::local(super::super::ownership::Scope {
        server_id: "server".into(),
        owner_id: "owner".into(),
        worker_id: "worker".into(),
        worker_generation: uuid::Uuid::new_v4().to_string().into(),
    }))
}
fn request(runtime: &Runtime, operation: &str) -> Ticket {
    runtime
        .request(Request::new(
            runtime.create_operation_lifetime(operation.into()).unwrap(),
            "provider".into(),
        ))
        .unwrap()
}
fn limited(manager: &Manager) {
    manager
        .configure(json!({"providerId":"provider","maxConcurrentInference":1,"inferenceCatalogCreatedRevision":0}))
        .unwrap();
}
#[test]
fn shared_failure_keeps_typed_admission_refusal_and_utf16_message() {
    let message = JsString::new(vec![0xd800, 0x61]);
    let failure = Failure::new(crate::error::WireError(message.clone()).into());
    let nested = Failure::new(failure.into());
    assert_eq!(crate::error::message(&nested.error()), message);
    let failure = Failure::new(unused("exact unused source refused"));
    let error = failure.error();
    assert!(
        error
            .downcast_ref::<AdmissionError>()
            .unwrap()
            .unstarted_unavailable
    );
}
#[tokio::test]
async fn running_cancellation_and_provider_replacement_retain_capacity_until_settlement() {
    let manager = manager();
    limited(&manager);
    let runtime = manager.create_runtime().unwrap();
    let a = request(&runtime, "a");
    let lease = a.ready().await.unwrap();
    lease.start().unwrap();
    let b = request(&runtime, "b");
    a.cancel(None);
    assert_eq!(a.status()["state"], json!("cancelling"));
    assert_eq!(b.status()["state"], json!("waiting"));
    assert!(b.ready().now_or_never().is_none());
    lease.settle(Outcome::Interrupted).unwrap();
    let b_lease = b.ready().await.unwrap();
    b_lease.start().unwrap();
    manager
        .configure_catalog(json!({"catalogRevision":1,"configurations":Vec::<Value>::new()}))
        .unwrap();
    assert_eq!(b.status()["state"], json!("running"));
    assert!(!manager.configure(json!({"providerId":"provider"})).unwrap());
    manager.configure(json!({"providerId":"provider","maxConcurrentInference":1,"inferenceCatalogCreatedRevision":2})).unwrap();
    let c = request(&runtime, "c");
    assert_eq!(c.status()["state"], json!("waiting"));
    b_lease.settle(Outcome::Completed).unwrap();
    c.ready()
        .await
        .unwrap()
        .settle(Outcome::NeverStarted)
        .unwrap();
    manager.close().await.unwrap();
}
#[tokio::test]
async fn canonical_lifetime_retains_exact_redelivery_after_release_and_refuses_changed_identity() {
    let manager = manager();
    let runtime = manager.create_runtime().unwrap();
    let lifetime = runtime.create_operation_lifetime("one".into()).unwrap();
    let input = Request::new(lifetime.clone(), "provider".into());
    let ticket = runtime.request(input.clone()).unwrap();
    ticket
        .ready()
        .await
        .unwrap()
        .settle(Outcome::NeverStarted)
        .unwrap();
    lifetime.close();
    let repeated = runtime.request(input.clone()).unwrap();
    assert_eq!(ticket.id, repeated.id);
    assert_eq!(repeated.status()["state"], json!("released"));
    assert!(repeated.ready().await.unwrap().start().is_err());
    let mut changed = input;
    changed.chat_id = Some(Value::Null);
    assert!(runtime.request(changed).is_err());
    let other = manager.create_runtime().unwrap();
    assert!(
        other
            .request(Request::new(lifetime, "provider".into()))
            .is_err()
    );
    manager.close().await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_redelivery_joins_one_callback_and_shutdown_waits_for_actual_teardown() {
    let manager = manager();
    limited(&manager);
    let source = Source::claimed("direct".into(), None);
    let (entered, started) = oneshot::channel();
    let (finish, cleanup) = oneshot::channel();
    let calls = Arc::new(AtomicUsize::new(0));
    let executed = calls.clone();
    let input = DirectRequest::new(source, "provider".into());
    let first = manager.run_direct(input.clone(), move |signal| {
        Box::pin(async move {
            executed.fetch_add(1, Ordering::SeqCst);
            entered
                .send(signal)
                .unwrap_or_else(|_| panic!("missing observer"));
            cleanup.await?;
            Ok(7u64)
        })
    });
    let observed = started.await.unwrap();
    let second = manager.run_direct::<u64>(input, |_| {
        Box::pin(async { bail!("duplicate callback executed") })
    });
    let mut closing = manager.close();
    assert!(closing.as_mut().now_or_never().is_none());
    tokio::time::timeout(Duration::from_secs(3), observed.cancelled())
        .await
        .unwrap();
    assert!(observed.check().is_err());
    assert_eq!(
        manager.snapshot()["pools"].as_array().unwrap()[0]["activeCount"],
        json!(1)
    );
    finish.send(()).unwrap();
    assert!(first.await.is_err());
    assert!(second.await.is_err());
    closing.await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_retirement_joins_abandoned_preparation_children_before_releasing_capacity() {
    let manager = manager();
    limited(&manager);
    let runtime = manager.create_runtime().unwrap();
    let native = request(&runtime, "native");
    let lease = native.ready().await.unwrap();
    let next_runtime = manager.create_runtime().unwrap();
    let next = request(&next_runtime, "next");
    let (entered, started) = oneshot::channel();
    let (finish, cleanup) = oneshot::channel();
    let child_manager = manager.clone();
    let preparation = manager.with_preparation(
        lease.clone(),
        PreparationOwner {
            assert_current: Arc::new(|| Ok(())),
            started: Arc::new(|| Ok(())),
        },
        move |context| {
            let mut request =
                DirectRequest::new(Source::claimed("child".into(), None), "provider".into());
            request.preparation = Some(context);
            drop(child_manager.run_direct(request, move |signal| {
                Box::pin(async move {
                    entered
                        .send(signal)
                        .unwrap_or_else(|_| panic!("missing observer"));
                    cleanup.await?;
                    Ok(())
                })
            }));
            Box::pin(async { Ok(()) })
        },
    );
    let child_signal = started.await.unwrap();
    assert!(
        lease
            .bind_native(json!({"threadId":"t","turnId":"u","scopeId":"s"}))
            .is_err()
    );
    let mut retired = runtime.exited();
    assert!(retired.as_mut().now_or_never().is_none());
    tokio::time::timeout(Duration::from_secs(3), child_signal.cancelled())
        .await
        .unwrap();
    assert!(child_signal.check().is_err());
    assert_eq!(native.status()["state"], json!("cancelling"));
    assert_eq!(next.status()["state"], json!("waiting"));
    finish.send(()).unwrap();
    assert!(preparation.await.is_err());
    retired.await.unwrap();
    next.ready()
        .await
        .unwrap()
        .settle(Outcome::NeverStarted)
        .unwrap();
    manager.close().await.unwrap();
}
