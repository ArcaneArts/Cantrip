use super::*;
use crate::{
    codex::rpc_requests::{Ports, Requests},
    inference::{admission::Options, ownership},
};
use futures::FutureExt;
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

fn scope() -> ownership::Scope {
    ownership::Scope {
        server_id: "server".into(),
        owner_id: "owner".into(),
        worker_id: "worker".into(),
        worker_generation: uuid::Uuid::new_v4().to_string().into(),
    }
}

fn local() -> (Manager, Adapter) {
    let manager = Manager::new(Options::local(scope()));
    let adapter = Adapter::new(manager.clone(), None).unwrap();
    (manager, adapter)
}

fn provider() -> Value {
    json!({"id":"provider","maxConcurrentInference":1})
}

fn request(adapter: &Adapter, operation: &str) -> Acquire {
    let source = Source::claimed(operation.into(), None);
    let life = adapter.lifetime_for_source(&source).unwrap();
    Acquire::new(life, provider())
}

fn native(thread: &str, turn: &str, scope: &str, gate: &str) -> NativeRequest {
    let (_, signal) = Abort::new();
    NativeRequest {
        gate_attempt_id: gate.into(),
        confirm_ownership: Arc::new(|| Box::pin(async { Ok(json!(true)) })),
        goal_epoch: None,
        runner_generation: None,
        task_goal_cycle: None,
        on_task_goal_queued: None,
        on_task_goal_dispatch: None,
        thread_id: thread.into(),
        turn_id: turn.into(),
        scope_id: scope.into(),
        provider: provider(),
        signal,
        is_paused: None,
        root_thread_id: None,
        chat_id: None,
        project_id: None,
        independent: false,
    }
}

async fn within<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(6), work)
        .await
        .expect("inference boundary timed out")
}

#[tokio::test]
async fn exact_native_gate_borrows_root_until_private_finish_even_after_ui_completion() {
    let (manager, adapter) = local();
    let mut input = request(&adapter, "root");
    input.thread_id = Some("thread".into());
    input.chat_id = Some(json!("chat"));
    input.recovery = Some(json!({"messageId":"message"}));
    let root = within(adapter.acquire(input)).await.unwrap();
    root.dispatched().unwrap();

    let mut pending = native("thread", "turn", "physical-scope", "begin-1");
    let claims = Arc::new(AtomicUsize::new(0));
    let count = claims.clone();
    pending.confirm_ownership = Arc::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(json!(true)) })
    });
    within(adapter.enter_native(pending.clone())).await.unwrap();
    within(adapter.enter_native(pending.clone())).await.unwrap();
    assert_eq!(claims.load(Ordering::SeqCst), 1);
    pending.gate_attempt_id = "another-begin".into();
    assert!(adapter.enter_native(pending).await.is_err());

    adapter
        .observe(
            "turn/completed",
            &json!({"threadId":"thread","turn":json!({"id":"turn","status":"completed"})}),
        )
        .unwrap();
    adapter.observation_lost().unwrap();
    adapter
        .reject_native_begin(
            &"thread".into(),
            &"turn".into(),
            &"physical-scope".into(),
            &"another-begin".into(),
            None,
        )
        .unwrap();
    let mut independent = native("thread", "turn", "independent", "child-begin");
    independent.independent = true;
    let mut child = adapter.enter_native(independent);
    assert!(child.as_mut().now_or_never().is_none());
    assert_eq!(root.ticket.status()["state"], "running");
    assert!(root.settled().now_or_never().is_none());

    adapter
        .finish_native(
            &"thread".into(),
            &"turn".into(),
            &"physical-scope".into(),
            true,
        )
        .unwrap();
    within(root.settled()).await.unwrap();
    assert_eq!(
        root.failure_evidence()["disposition"],
        "model-failed-before-output"
    );
    within(child).await.unwrap();
    adapter
        .finish_native(
            &"thread".into(),
            &"turn".into(),
            &"independent".into(),
            false,
        )
        .unwrap();
    within(adapter.process_exited()).await.unwrap();
    within(manager.close()).await.unwrap();
}

#[tokio::test]
async fn paused_native_input_uses_the_replacement_permission() {
    let (manager, adapter) = local();
    let mut input = request(&adapter, "owner");
    input.chat_id = Some(json!("chat"));
    let owner = within(adapter.acquire(input.clone())).await.unwrap();
    let duplicate = within(adapter.acquire(input.clone())).await.unwrap();
    assert!(Arc::ptr_eq(&owner.operation, &duplicate.operation));
    input.project_id = Some(json!("another-project"));
    assert!(adapter.acquire(input).await.is_err());

    adapter.set_chat_paused(&"chat".into(), true).unwrap();
    within(adapter.confirm_chat_hold(&"chat".into()))
        .await
        .unwrap();
    let mut seal = owner.seal_input_dispatch();
    assert!(seal.as_mut().now_or_never().is_none());
    adapter.set_chat_paused(&"chat".into(), false).unwrap();
    within(seal).await.unwrap();
    owner.dispatched().unwrap();
    within(adapter.process_exited()).await.unwrap();
    within(owner.settled()).await.unwrap();
    within(manager.close()).await.unwrap();
}

#[tokio::test]
async fn actual_rpc_correlation_releases_preparation_only_on_late_reply() {
    let (manager, adapter) = local();
    let owner = within(adapter.acquire(request(&adapter, "prepared")))
        .await
        .unwrap();
    let (outgoing, mut frames) = mpsc::unbounded_channel();
    let requests = Requests::new(Ports {
        send: Arc::new(move |frame| {
            outgoing.send(frame)?;
            Ok(())
        }),
        record: Arc::new(|_, _| {}),
        policy: Default::default(),
        runtime_id: None,
        logs: None,
    });
    let peer = requests.clone();
    let (timed_out, timeout_seen) = oneshot::channel();
    let mut preparing = owner.prepare::<()>("provider".into(), move |scope| {
        Box::pin(async move {
            scope.before_send()?;
            let observation = peer
                .request(
                    "cantrip/inference".into(),
                    None,
                    Some(Duration::from_millis(5)),
                    Some(Arc::new(scope)),
                )
                .await;
            let error = observation.unwrap_err();
            assert!(error.to_string().contains("timed out"));
            timed_out.send(()).unwrap();
            Err(error)
        })
    });
    let frame = within(frames.recv()).await.unwrap();
    within(timeout_seen).await.unwrap();
    assert!(preparing.as_mut().now_or_never().is_none());
    assert!(owner.seal_input_dispatch().await.is_err());
    let reply = json!({"id":frame["id"],"result":json!({})});
    assert!(requests.handle_response(&reply, &requests.diagnostic_payload(&reply)));
    assert!(
        within(preparing)
            .await
            .unwrap_err()
            .to_string()
            .contains("timed out")
    );
    within(owner.seal_input_dispatch()).await.unwrap();
    owner.not_dispatched().unwrap();
    within(owner.settled()).await.unwrap();
    within(adapter.process_exited()).await.unwrap();
    within(manager.close()).await.unwrap();
}

#[tokio::test]
async fn source_drop_is_distinct_from_explicit_release() {
    let dropped = Source::claimed("dropped".into(), None);
    let mut release = dropped.released();
    drop(dropped);
    assert!(release.as_mut().now_or_never().is_none());

    let owned = Source::claimed("owned".into(), None);
    let mut release = owned.released();
    assert!(release.as_mut().now_or_never().is_none());
    owned.close();
    within(release).await.unwrap();
}

#[tokio::test]
#[ignore = "requires the existing bundled Codex keeper; set CANTRIP_TEST_CODEX"]
async fn real_keeper_private_goal_withdrawal_preserves_the_exact_acknowledgement() {
    let binary = std::path::PathBuf::from(std::env::var_os("CANTRIP_TEST_CODEX").unwrap());
    let data = tempfile::tempdir().unwrap();
    let scope = scope();
    let mut options = Options::local(scope.clone());
    let environment = std::env::vars().collect();
    options.ownership = Some(Arc::new(ownership::Owner::new(
        binary,
        data.path(),
        scope,
        ownership::Options::local(data.path().into(), environment),
    )));
    let manager = Manager::new(options);
    let adapter = Adapter::new(manager.clone(), None).unwrap();
    within(adapter.prepare_native_launch()).await.unwrap();
    let uuid = || JsString::from(uuid::Uuid::new_v4().to_string());
    let thread = uuid();
    let turn = uuid();
    let scope = uuid();
    let gate = uuid();
    let epoch = uuid();
    let cycle = uuid();
    let chat = uuid();
    let mut input = native(
        thread.as_str().unwrap(),
        turn.as_str().unwrap(),
        scope.as_str().unwrap(),
        gate.as_str().unwrap(),
    );
    input.goal_epoch = Some(epoch.clone());
    let runner = uuid();
    input.runner_generation = Some(runner.clone());
    input.root_thread_id = Some(thread.clone());
    input.chat_id = Some(json!(chat));
    input.task_goal_cycle = Some(
        json!({"cycleId":cycle,"modelRouteId":uuid(),"providerAccountId":Value::Null,"orderEpoch":3}),
    );
    input.confirm_ownership = Arc::new(move || {
        let claim = json!({"claimed":true,"goalEpoch":epoch,"inferenceOnly":true});
        Box::pin(async move { Ok(claim) })
    });
    let (captured, capture) = oneshot::channel();
    let captured = Mutex::new(Some(captured));
    let (continue_dispatch, continuing) = oneshot::channel();
    let continuing = Mutex::new(Some(continuing));
    input.on_task_goal_dispatch = Some(Arc::new(move |_, _, recovery, source, _| {
        assert!(recovery.is_null());
        captured
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(source)
            .unwrap();
        let continuing = continuing.lock().unwrap().take().unwrap();
        Box::pin(async move {
            continuing.await?;
            Ok(())
        })
    }));
    let native = adapter.enter_native(input);
    let record = within(capture).await.unwrap();
    let independently_captured =
        within(adapter.capture_task_goal_source(chat, thread.clone(), cycle))
            .await
            .unwrap();
    assert_eq!(record["key"], independently_captured["key"]);
    let mut stale = record.clone();
    stale["identity"]["recovery"]["taskGoalCycle"]["gateAttemptId"] = json!(uuid());
    let withdrawal = Withdrawal::new();
    assert!(
        adapter
            .withdraw_task_goal_source(&stale, withdrawal.clone())
            .is_err()
    );
    let proof = within(
        adapter
            .withdraw_task_goal_source(&record, withdrawal.clone())
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(proof["outcome"], "never-started");
    continue_dispatch.send(()).unwrap();
    let refused = within(native).await.unwrap_err();
    let actual = Withdrawal::in_error(&refused).expect("original typed withdrawal");
    let mut acknowledgement = actual.wait(None);
    assert!(acknowledgement.as_mut().now_or_never().is_none());
    withdrawal.acknowledge();
    within(acknowledgement).await.unwrap();
    adapter
        .reject_native_begin(&thread, &turn, &scope, &gate, Some(&runner))
        .unwrap();
    within(adapter.process_exited()).await.unwrap();
    within(manager.close()).await.unwrap();
}

#[tokio::test]
async fn pre_acquisition_preparation_does_not_reserve_response_capacity() {
    let (manager, adapter) = local();
    let mut input = request(&adapter, "response");
    input.chat_id = Some(json!("chat"));
    let (entered, entry) = oneshot::channel();
    let (cancelled, cancellation) = oneshot::channel();
    let (teardown, settled) = oneshot::channel();
    let mut preparation = adapter.prepare_before_acquire(input.clone(), move |signal| {
        Box::pin(async move {
            entered.send(()).unwrap();
            signal.cancelled().await;
            cancelled.send(()).unwrap();
            settled.await?;
            Ok(())
        })
    });
    within(entry).await.unwrap();
    assert!(adapter.acquire(input.clone()).await.is_err());
    let unrelated = within(adapter.acquire(request(&adapter, "other")))
        .await
        .unwrap();

    assert!(adapter.cancel_waiting(&"chat".into()).unwrap());
    within(cancellation).await.unwrap();
    assert!(preparation.as_mut().now_or_never().is_none());
    teardown.send(()).unwrap();
    assert!(
        within(preparation)
            .await
            .unwrap_err()
            .to_string()
            .contains("interrupted before response admission")
    );
    assert!(adapter.acquire(input).await.is_err());

    unrelated.not_dispatched().unwrap();
    within(adapter.process_exited()).await.unwrap();
    within(manager.close()).await.unwrap();
}
