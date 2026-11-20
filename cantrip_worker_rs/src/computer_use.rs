//! The worker's connection to the native evaluator for one authorized turn.
use crate::{
    desktop_inventory::process::Process,
    metadata::{Abort, Signal},
};
use anyhow::{Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    ffi::OsString,
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::task::JoinHandle;

pub use crate::desktop_inventory::preview::{
    DesktopTurn, HostAction, HostActivity, HostEvaluation, HostSnapshot, Previews as Desktop,
};
pub use crate::desktop_inventory::process::NativeError;

/// Keep policy diagnostics and protected action data out of the evaluator's errors.
pub struct HostError(&'static str);

impl HostError {
    pub fn new(code: &str) -> Self {
        match code {
            "cancelled" => Self("cancelled"),
            "permission-denied" => Self("permission-denied"),
            "denied" => Self("denied"),
            "expired" => Self("expired"),
            "publication-failed" => Self("publication-failed"),
            "unsupported" => Self("unsupported"),
            "script-action" => Self("script-action"),
            "ownership-mismatch" => Self("ownership-mismatch"),
            "capacity" => Self("capacity"),
            "session-not-found" => Self("session-not-found"),
            "target-not-found" => Self("target-not-found"),
            "stale-target" => Self("stale-target"),
            "stale-element" => Self("stale-element"),
            "control-not-found" => Self("control-not-found"),
            "control-ambiguous" => Self("control-ambiguous"),
            "control-inspection-incomplete" => Self("control-inspection-incomplete"),
            "input-unknown" => Self("input-unknown"),
            "input-failed" => Self("input-failed"),
            "capture-failed" => Self("capture-failed"),
            "capture-inventory-timeout" => Self("capture-inventory-timeout"),
            "capture-image-timeout" => Self("capture-image-timeout"),
            _ => Self("invalid-request"),
        }
    }

    pub(crate) fn outcome(self) -> Value {
        // The helper accepts the native error vocabulary. Keep the richer
        // approval result on the worker for protected activity.
        let code = match self.code() {
            "denied" | "expired" | "publication-failed" => "permission-denied",
            code => code,
        };
        json!({"status":"error","error":json!({"code":code,"message":"Computer-use host action failed."})})
    }

    pub(crate) fn code(&self) -> &'static str {
        self.0
    }
}

/// A dedicated evaluator keeps QuickJS state scoped to the turn. Host actions
/// run on the owning service, which checks authorization before touching any
/// desktop or guest. No other lease shares this process pipe.
pub struct Javascript {
    binary: PathBuf,
    args: Vec<OsString>,
    binding: Value,
    turn: Signal,
    process: Arc<Mutex<Option<Process>>>,
    retirement: Option<JoinHandle<()>>,
}

struct CancelHost(Abort);

impl Drop for CancelHost {
    fn drop(&mut self) {
        self.0
            .abort(anyhow::anyhow!("Computer-use evaluation ended."));
    }
}

impl Javascript {
    pub fn new(binary: PathBuf, args: Vec<OsString>, binding: Value, turn: Signal) -> Result<Self> {
        let binding = cantrip_protocol::parse_property("cuaSessionSchema", "binding", &binding)
            .map_err(cantrip_protocol::response::response_error)?;
        ensure!(
            binding["threadId"].is_string() && binding["turnId"].is_string(),
            "Computer use requires an observed native thread and turn."
        );
        Ok(Self {
            binary,
            args,
            binding,
            turn,
            process: Arc::new(Mutex::new(None)),
            retirement: None,
        })
    }

    pub(crate) fn binding(&self) -> &Value {
        &self.binding
    }

    pub(crate) fn turn(&self) -> Signal {
        self.turn.clone()
    }

    /// The execution owner supplies the time budget and authorizes every host
    /// action. The action signal lasts through this evaluation; turn-owned
    /// observations and attachments use the separate turn signal.
    pub async fn evaluate<F: Future<Output = Result<Value, HostError>>>(
        &mut self,
        source: &JsString,
        wall_timeout_ms: u64,
        request: Signal,
        host: impl FnMut(Value, Signal) -> F,
    ) -> Result<Value> {
        let (cancel, action) = Abort::new();
        let _cancel_host = CancelHost(cancel);
        let signal = Signal::any(vec![request, self.turn.clone(), action]);
        signal.check()?;
        let mut process = match self.process.lock().unwrap().take() {
            Some(process) => process,
            None => Process::spawn(self.binary.as_os_str(), &self.args)?,
        };
        let operation = json!({
            "operation":"javascript.evaluate","binding":self.binding,
            "source":source,"wallTimeoutMs":wall_timeout_ms,
        });
        let result = tokio::select! {
            biased;
            reason = signal.cancelled() => Err(reason.into()),
            result = process.javascript(operation, &signal, host) => result,
        };
        // Incomplete framing, cancellation and caller abandonment all retire
        // the owned helper. A complete native error is safe to leave on the pipe.
        // The native engine clears failing scripts itself. Never replay a call.
        if result.is_ok()
            || result
                .as_ref()
                .is_err_and(|error| error.is::<NativeError>())
        {
            let mut idle = self.process.lock().unwrap();
            signal.check()?;
            *idle = Some(process);
            if self.retirement.is_none() {
                let held = Arc::clone(&self.process);
                let turn = self.turn.clone();
                self.retirement = Some(tokio::spawn(async move {
                    turn.cancelled().await;
                    let idle = held.lock().unwrap().take();
                    if let Some(process) = idle {
                        process.close().await;
                    }
                }));
            }
        }
        result
    }

    pub async fn reset(&mut self) -> Result<()> {
        let Some(mut process) = self.process.lock().unwrap().take() else {
            return Ok(());
        };
        let operation = json!({"operation":"javascript.reset","binding":self.binding});
        let result =
            tokio::time::timeout(Duration::from_secs(15), process.request(operation)).await;
        process.close().await;
        ensure!(
            result?? == json!({"reset":true}),
            "Invalid computer-use reset result."
        );
        Ok(())
    }
}

impl Drop for Javascript {
    fn drop(&mut self) {
        if let Some(retirement) = &self.retirement {
            retirement.abort();
        }
        self.process.lock().unwrap().take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::{pending, ready};
    use tokio::{sync::oneshot, time::timeout};

    #[tokio::test]
    #[ignore = "requires the local cantrip-cua executable in CANTRIP_TEST_RUST_CUA_BIN"]
    async fn worker_evaluator_preserves_state_and_retires_cancelled_native_calls() -> Result<()> {
        let binary = std::env::var_os("CANTRIP_TEST_RUST_CUA_BIN")
            .map(PathBuf::from)
            .expect("Set CANTRIP_TEST_RUST_CUA_BIN to the native helper executable.");
        let (retire, turn) = Abort::new();
        let (_, live) = Abort::new();
        let mut engine = Javascript::new(
            binary,
            vec!["--backend".into(), "fake".into()],
            json!({"sessionId":"fixture-session","workerId":"worker","chatId":"chat",
                "threadId":"thread","turnId":"turn","taskId":Value::Null}),
            turn,
        )?;
        let fail_unexpected =
            |_: Value, _: Signal| -> std::future::Ready<Result<Value, HostError>> {
                panic!("the script did not request a host action")
            };

        engine.reset().await?;
        assert!(engine.process.lock().unwrap().is_none());
        let mut actions = Vec::new();
        let result = engine
            .evaluate(
                &"let value = (await cua.getState()).answer; value += (await cua.targets()).count; value".into(),
                0,
                live.clone(),
                |action, signal| {
                    signal.check().unwrap();
                    let result = match action["operation"].as_str() {
                        Some("state") => json!({"answer":40}),
                        Some("targets") => json!({"count":2}),
                        _ => panic!("unexpected host action"),
                    };
                    actions.push(action);
                    ready(Ok(result))
                },
            )
            .await?;
        assert_eq!(
            actions,
            [json!({"operation":"state"}), json!({"operation":"targets"})]
        );
        assert_eq!(result, 42);
        assert_eq!(
            engine
                .evaluate(&"value".into(), 0, live.clone(), fail_unexpected)
                .await?,
            42
        );

        let denied = engine
            .evaluate(&"await cua.getState()".into(), 0, live.clone(), |_, _| {
                ready(Err(HostError::new("permission-denied")))
            })
            .await
            .unwrap_err();
        assert_eq!(
            denied.downcast_ref::<NativeError>().unwrap().code(),
            "permission-denied"
        );

        engine.reset().await?;
        assert_eq!(
            engine
                .evaluate(&"typeof value".into(), 0, live.clone(), fail_unexpected)
                .await?,
            "undefined"
        );

        let (cancel, request) = Abort::new();
        let (started, wait) = oneshot::channel();
        let mut started = Some(started);
        let hold = "let abandoned = 17; await cua.getState()".into();
        let call = engine.evaluate(&hold, 0, request, |_, signal| {
            started.take().unwrap().send(signal).ok();
            pending()
        });
        let cancel_when_started = async {
            let host = wait.await.unwrap();
            cancel.abort(anyhow::anyhow!("Fixture cancelled the broker call."));
            host.cancelled().await;
        };
        let (call, _) = timeout(Duration::from_secs(5), async {
            tokio::join!(call, cancel_when_started)
        })
        .await?;
        assert_eq!(
            call.unwrap_err().to_string(),
            "Fixture cancelled the broker call."
        );
        assert!(engine.process.lock().unwrap().is_none());
        assert_eq!(
            engine
                .evaluate(&"typeof abandoned".into(), 0, live.clone(), fail_unexpected)
                .await?,
            "undefined"
        );

        let stuck_source = "await cua.getState()".into();
        let mut waiting_host = None;
        let stuck = engine.evaluate(&stuck_source, 100, live.clone(), |_, signal| {
            waiting_host = Some(signal);
            pending()
        });
        let timed_out = timeout(Duration::from_secs(5), stuck).await?.unwrap_err();
        assert_eq!(
            timed_out.downcast_ref::<NativeError>().unwrap().code(),
            "capacity"
        );
        assert!(waiting_host.unwrap().check().is_err());
        assert!(engine.process.lock().unwrap().is_some());

        retire.abort(anyhow::anyhow!("Fixture retired the turn."));
        timeout(Duration::from_secs(5), engine.retirement.take().unwrap()).await??;
        assert!(engine.process.lock().unwrap().is_none());
        let after = engine
            .evaluate(&"2+2".into(), 0, live, fail_unexpected)
            .await
            .unwrap_err();
        assert_eq!(after.to_string(), "Fixture retired the turn.");
        assert!(engine.process.lock().unwrap().is_none());
        Ok(())
    }
}
