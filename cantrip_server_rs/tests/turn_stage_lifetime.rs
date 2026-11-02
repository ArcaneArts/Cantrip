use cantrip_server::{
    chats::turn_runtime::stages::{Observer, Operations, TaskLaunchStageTimeout},
    operations::logging::LogCall,
    wire::Value,
};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

fn observer(operations: Arc<Operations>, options: &str) -> (Observer, Arc<Mutex<Vec<LogCall>>>) {
    let logs = Arc::new(Mutex::new(Vec::new()));
    let output = logs.clone();
    (
        Observer::new(
            operations,
            &serde_json::from_str("{\"chatId\":\"task\"}").unwrap(),
            &serde_json::from_str(options).unwrap(),
            Arc::new(move |call| output.lock().unwrap().push(call)),
            Arc::new(|| 0),
        ),
        logs,
    )
}

#[tokio::test(start_paused = true)]
async fn deadline_keeps_the_actual_operation_owned_until_it_settles() {
    let operations = Arc::new(Operations::default());
    let (observer, logs) = observer(
        operations.clone(),
        r#"{"taskDispatchLease":{"cycleId":"cycle","operationId":"operation"},"preflightWorkerCommandTimeoutMs":10}"#,
    );
    let (started, ready) = oneshot::channel();
    let (release, held) = oneshot::channel();
    let (committed, observed) = oneshot::channel();
    let task = tokio::spawn(async move {
        observer
            .run("mark-dispatch-running", async move {
                let _ = started.send(());
                held.await?;
                let _ = committed.send("late actual result");
                Ok(Value::Null)
            })
            .await
    });
    ready.await.unwrap();
    tokio::time::advance(std::time::Duration::from_millis(11)).await;
    let error = task.await.unwrap().unwrap_err();
    let timeout = error.downcast_ref::<TaskLaunchStageTimeout>().unwrap();
    assert_eq!(timeout.stage, "begin-turn");
    assert_eq!(timeout.timeout_ms, 10.0);
    assert_eq!(
        error.to_string(),
        "Scheduled Task launch timed out during begin-turn after 10ms."
    );
    let drained = operations.drained();
    tokio::pin!(drained);
    assert!(futures::poll!(drained.as_mut()).is_pending());
    release.send(()).unwrap();
    assert_eq!(observed.await.unwrap(), "late actual result");
    drained.await;
    let logs = logs.lock().unwrap();
    assert_eq!(logs.len(), 2);
    assert_eq!(logs[0].context["status"], "started");
    assert_eq!(logs[1].context["status"], "failed");
    assert_eq!(logs[1].context["errorClass"], "TaskLaunchStageTimeoutError");
    assert_eq!(logs[1].context["stage"], "mark-dispatch-running");
}

#[tokio::test]
async fn caller_disconnect_does_not_cancel_completion_or_stage_logging() {
    let operations = Arc::new(Operations::default());
    let (observer, logs) = observer(
        operations.clone(),
        r#"{"taskDispatchLease":{"cycleId":"cycle","operationId":"operation"}}"#,
    );
    let (started, ready) = oneshot::channel();
    let (release, held) = oneshot::channel();
    let (committed, observed) = oneshot::channel();
    let caller = tokio::spawn(async move {
        observer
            .run("append-task-message", async move {
                let _ = started.send(());
                held.await?;
                let _ = committed.send(());
                Ok(Value::Null)
            })
            .await
    });
    ready.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    observed.await.unwrap();
    operations.drained().await;
    let logs = logs.lock().unwrap();
    assert_eq!(logs.len(), 2);
    assert_eq!(logs[1].context["status"], "completed");
}

#[tokio::test(start_paused = true)]
async fn interactive_turn_has_no_task_deadline_or_task_logs() {
    let operations = Arc::new(Operations::default());
    let (observer, logs) = observer(
        operations.clone(),
        r#"{"preflightWorkerCommandTimeoutMs":1}"#,
    );
    let (started, ready) = oneshot::channel();
    let (release, held) = oneshot::channel();
    let task = tokio::spawn(async move {
        observer
            .run("resolve-model", async move {
                let _ = started.send(());
                held.await?;
                Ok(Value::Bool(true))
            })
            .await
    });
    ready.await.unwrap();
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    assert!(!task.is_finished());
    release.send(()).unwrap();
    assert_eq!(task.await.unwrap().unwrap(), Value::Bool(true));
    operations.drained().await;
    assert!(logs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn worker_contract_failure_keeps_its_source_error_class() {
    let operations = Arc::new(Operations::default());
    let (observer, logs) = observer(
        operations.clone(),
        r#"{"taskDispatchLease":{"cycleId":"cycle","operationId":"operation"}}"#,
    );
    let error = cantrip_server::workers::bridge::CommandError {
        message: "Invalid worker contract".into(),
        code: None,
        unavailable: false,
        request_id: None,
        encoding_error: Some(cantrip_server::wire::ValidationError::Invalid(vec![]).into()),
    };
    assert!(
        observer
            .run("resolve-model-routes", async move {
                Err::<Value, _>(error.into())
            })
            .await
            .is_err()
    );
    operations.drained().await;
    let logs = logs.lock().unwrap();
    assert_eq!(logs[1].context["errorClass"], "ZodError");
    assert_eq!(logs[1].context["err"]["name"], "ZodError");
}
