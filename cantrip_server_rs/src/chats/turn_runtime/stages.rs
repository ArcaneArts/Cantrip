//! Task preflight deadlines stop waiting, never cancel an admitted operation.
use crate::{
    operations::logging::{self, LogCall, Logger},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, oneshot};

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
#[derive(Default)]
pub struct Operations {
    active: AtomicUsize,
    drained: Notify,
}
struct Active(Arc<Operations>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
        self.0.drained.notify_waiters();
    }
}
impl Operations {
    pub fn spawn<T, F>(self: &Arc<Self>, operation: F) -> oneshot::Receiver<Result<T>>
    where
        T: Send + 'static,
        F: Future<Output = Result<T>> + Send + 'static,
    {
        self.active.fetch_add(1, Ordering::SeqCst);
        let active = Active(self.clone());
        let (send, receive) = oneshot::channel();
        let operation = Box::pin(operation);
        tokio::spawn(async move {
            let _active = active;
            let _ = send.send(operation.await);
        });
        receive
    }
    pub fn run<T, F>(self: &Arc<Self>, operation: F) -> BoxFuture<'static, Result<T>>
    where
        T: Send + 'static,
        F: Future<Output = Result<T>> + Send + 'static,
    {
        let receive = self.spawn(operation);
        async move {
            receive
                .await
                .context("The owned turn operation stopped unexpectedly.")?
        }
        .boxed()
    }
    pub async fn drained(&self) {
        loop {
            let notified = self.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active.load(Ordering::SeqCst) == 0 {
                return;
            }
            notified.await;
        }
    }
    pub fn with_timeout<T, F>(
        self: &Arc<Self>,
        stage: &'static str,
        timeout_ms: f64,
        operation: F,
    ) -> BoxFuture<'static, Result<T>>
    where
        T: Send + 'static,
        F: Future<Output = Result<T>> + Send + 'static,
    {
        let mut receive = self.spawn(operation);
        async move {
            let delay=if !(1.0..=2_147_483_647.0).contains(&timeout_ms){1}else{timeout_ms.trunc() as u64};
            tokio::select! {biased;
                result=&mut receive=>result.context("The owned Task launch operation stopped unexpectedly.")?,
                _=tokio::time::sleep(Duration::from_millis(delay))=>Err(TaskLaunchStageTimeout{stage,timeout_ms}.into()),
            }
        }.boxed()
    }
}
#[derive(Debug)]
pub struct TaskLaunchStageTimeout {
    pub stage: &'static str,
    pub timeout_ms: f64,
}
impl std::fmt::Display for TaskLaunchStageTimeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Scheduled Task launch timed out during {} after {}ms.",
            self.stage,
            ryu_js::Buffer::new().format(self.timeout_ms)
        )
    }
}
impl std::error::Error for TaskLaunchStageTimeout {}

#[derive(Clone)]
pub struct Observer {
    operations: Arc<Operations>,
    context: Value,
    lease: Option<Value>,
    timeout: Option<f64>,
    logger: Logger,
    clock: Clock,
}
impl Observer {
    pub fn new(
        operations: Arc<Operations>,
        context: &Value,
        options: &Value,
        logger: Logger,
        clock: Clock,
    ) -> Self {
        Self {
            operations,
            context: context.clone(),
            lease: options
                .get("taskDispatchLease")
                .filter(|v| crate::wire::coercion::truthy(Some(v)))
                .cloned(),
            timeout: options
                .get("preflightWorkerCommandTimeoutMs")
                .filter(|v| !v.is_null())
                .and_then(Value::as_f64),
            logger,
            clock,
        }
    }
    fn log(&self, stage: &str, status: &str, started: i64, error: Option<&anyhow::Error>) {
        let lease = self.lease.as_ref().expect("Task observer lease");
        let mut context = json!({"event":"task.turn-bootstrap-stage","subsystem":"task-scheduler","operation":"bootstrap-turn","status":status,"chatId":self.context["chatId"],"cycleId":lease["cycleId"],"operationId":lease["operationId"],"serverVersion":crate::settings::quota::server_version(),"stage":stage,"phase":stage});
        if status != "started" {
            context["durationMs"] = json!((self.clock)() - started);
        }
        if let Some(error) = error {
            context["err"] = logging::error_details(error);
            context["errorClass"] = json!(if error.is::<TaskLaunchStageTimeout>() {
                "TaskLaunchStageTimeoutError"
            } else if let Some(error) =
                error.downcast_ref::<crate::chats::execution_lanes::LaneError>()
            {
                error.class_name()
            } else if error.is::<crate::task_dispatch::Conflict>() {
                "TaskDispatchConflictError"
            } else {
                context["err"]["name"].as_str().unwrap_or("Error")
            });
            context["err"]["name"] = context["errorClass"].clone();
        }
        (self.logger)(LogCall::event(
            if error.is_some() { "warn" } else { "info" },
            match status {
                "started" => "Scheduled Task turn bootstrap stage started",
                "completed" => "Scheduled Task turn bootstrap stage completed",
                _ => "Scheduled Task turn bootstrap stage failed",
            },
            context,
        ));
    }
    pub fn run<T, F>(&self, stage: &'static str, operation: F) -> BoxFuture<'static, Result<T>>
    where
        T: Send + 'static,
        F: Future<Output = Result<T>> + Send + 'static,
    {
        let observer = self.clone();
        let operation = Box::pin(operation);
        self.operations.run(async move {
            if observer.lease.is_none() {
                return operation.await;
            }
            let started = (observer.clock)();
            observer.log(stage, "started", started, None);
            let result = if let Some(timeout_ms) = observer.timeout {
                observer
                    .operations
                    .with_timeout("begin-turn", timeout_ms, operation)
                    .await
            } else {
                operation.await
            };
            observer.log(
                stage,
                if result.is_ok() {
                    "completed"
                } else {
                    "failed"
                },
                started,
                result.as_ref().err(),
            );
            result
        })
    }
}
