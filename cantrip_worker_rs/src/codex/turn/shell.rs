//! Core-owned queued shell executions. The native RPC only acknowledges the
//! request. Its turn and terminal result arrive through the runtime observer.
use super::{
    Active, Owner, Phase, RPC_TIMEOUT, Turns, autonomous::same_workspace, control, id, output,
};
use crate::{
    chat_content::Scope,
    codex::{
        admission::Acquire,
        preparation::{Intent, command::native_session},
        rpc_requests::Failure,
    },
    history::managed::sources,
    inference::admission::Source,
    metadata::{Abort, Signal},
    native_items::concat,
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, value::json};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{oneshot, watch};

pub(in crate::codex) const METHOD: &str = "thread/shellCommand";

impl Turns {
    pub(in crate::codex) async fn run_queued_shell(
        &self,
        command: &Value,
        scope: Scope,
        program: JsString,
        acknowledge: impl FnOnce(&Value) + Send,
    ) -> Result<Value> {
        // This native method deliberately runs outside the thread sandbox.
        // Match the Node policy's two full-access selectors. Core rechecks
        // this exact managed profile at dispatch.
        if !matches!(
            command["permissionProfileId"].as_str(),
            Some(":yolo" | ":danger-full-access")
        ) {
            bail!(
                "This native command runs without a sandbox and requires an authorized full-access profile."
            );
        }
        let key = self.key(command)?;
        let thread = id(&command["threadId"], "queued shell thread")?;
        if command["session"]["chatId"].as_js_string() != Some(&key.2) {
            bail!("The queued shell command belongs to another managed conversation.");
        }
        let prepared = self.preparation.prepare(command, Intent::Preserve).await?;
        let runtime = &prepared.runtime;
        if prepared.thread.id() != &thread || scope.owner != key.0 || scope.server != key.1 {
            bail!("The queued shell command lost its prepared managed thread.");
        }
        let session = native_session(command, runtime, &thread);
        let params = json!({"threadId":thread,"command":program});
        let (receipt, _, grant) = self
            .receipts
            .admit_command(scope, session, METHOD, &params, command, Value::Null)
            .await?;
        let root = receipt.operation();
        let mut sent = false;
        let result = async {
            let execution = &grant["execution"];
            let session = receipt.session();
            let placement = if session["contextKind"] == "standalone" { "scratchRootId" } else { "worktreeId" };
            if execution["chatId"] != session["chatId"]
                || execution["contextKind"] != session["contextKind"]
                || execution["projectId"] != session["projectId"]
                || execution[placement] != session["placementId"]
                || execution["threadId"] != session["threadId"]
                || execution["executionLaneId"] != root.lane
                || execution["modelRouteId"] != session["modelRouteId"]
                || execution["providerAccountId"] != session["providerAccountId"]
                || grant["receipt"]["logicalOperationId"].as_js_string() != Some(&root.operation)
            {
                bail!("Core returned a different queued shell execution scope.");
            }
            let cwd = self.preparation.resolve_routing(&json!({"cwd": execution["cwd"]})).await?;
            same_workspace(&id(&command["cwd"], "queued shell workspace")?, &cwd["cwd"]).await?;
            let (abort, signal) = Abort::new();
            let active = Arc::new(Active {
                root: Some(root.clone()),
                control: OnceLock::from(control::Binding::new(
                    session.clone(), command["permissionProfileId"].clone(), prepared.thread.version()
                )),
                // Like the managed Node shell observer, release the local
                // owner after physical settlement. Core owns logical closure.
                logical_finished: AtomicBool::new(false),
                preparation: abort,
                phase: Mutex::new(Phase::Preparing(Some(thread.clone()))),
                changed: watch::channel(0).0,
            });
            let (subscription, mut events, _) = output::subscribe(&runtime.history(), &thread)?;
            let reserved = {
                let mut sessions = self.active.lock().unwrap();
                if sessions.active.contains_key(&key) || sessions.restoring.contains_key(&key) || sessions.cancelled.contains(&(
                    key.clone(), root.operation.clone(), root.generation.clone()
                )) {
                    false
                } else {
                    sessions.active.insert(key.clone(), active.clone());
                    true
                }
            };
            if !reserved {
                subscription.close();
                bail!("This chat already has an active or cancelled native execution.");
            }
            let _owner = Owner {
                sessions: self.active.clone(), key: key.clone(), active: active.clone(),
            };
            let transport = subscription.signal();
            let source = Source::claimed(root.generation.clone(), Some(Signal::any(vec![signal.clone(), transport.clone()])));
            let adapter = runtime.admission();
            let execution_result = async {
                let mut request = Acquire::new(adapter.lifetime_for_source(&source)?, command["provider"].clone());
                request.purpose = Some("turn".into());
                request.chat_id = Some(json!(key.2));
                request.project_id = session.get("projectId").filter(|value| !value.is_null()).cloned();
                request.thread_id = Some(thread.clone());
                request.signal = Some(source.signal());
                request.recovery_key = Some(json!(concat(&["native-command:".into(), root.operation.clone()])));
                request.recovery = Some(json!({
                    "commandId":root.operation,"commandGeneration":root.generation,"threadId":thread,
                }));
                let execution = adapter.acquire(request).await?;
                let outcome = async {
                    execution.bind_thread(thread.clone())?;
                    execution.seal_input_dispatch().await?;
                    let _mcp = self.preparation.activate(&prepared, &root.lane)?;
                    if session["contextKind"] == "project" {
                        self.history.bind(sources::Input {
                            chat_id: key.2.clone(), thread_id: thread.clone(), runtime: runtime.history(),
                            provenance: Some(json!({
                                "kind":"command","operationId":root.operation,"operationGeneration":root.generation,
                            })),
                        })?;
                    }
                    receipt.dispatch().await?;
                    prepared.thread.assert_current(runtime)?;
                    receipt.scope().identity()?;
                    active.dispatch(&signal, thread.clone())?;
                    execution.dispatched()?;
                    sent = true;
                    let reply = runtime.request(METHOD.into(), Some(params), Some(RPC_TIMEOUT), None).await;
                    let native = match reply {
                        Ok(Some(reply)) if reply.is_object() => Ok(reply),
                        Err(error) => {
                            if let Some(native) = error.downcast_ref::<Failure>().and_then(|failure| failure.native_error.as_ref()) {
                                execution.rejected()?;
                                execution.settled().await?;
                                receipt.reject_start(native, "failed").await?;
                                bail!("Codex rejected the queued shell command.");
                            }
                            Err(error)
                        }
                        Ok(_) => Err(anyhow!("Codex did not acknowledge the queued shell command.")),
                    };
                    let (started, observed) = oneshot::channel();
                    let bind = async {
                        let started = started;
                        let turn = output::started(&mut events, &transport).await?;
                        let bound = execution.bind_turn(turn.clone());
                        active.set(Phase::Running { runtime:runtime.clone(), thread:thread.clone(), turn:turn.clone() });
                        let _ = started.send(turn.clone());
                        let emit = Arc::new(|_: Value| Ok(())) as super::Emit;
                        let terminal = output::collect(&mut events, &transport, &thread, &turn, &emit).await;
                        active.set(Phase::Terminal);
                        bound?;
                        terminal.map(|terminal| (turn, terminal))
                    };
                    let accept = async {
                        let result = async {
                            match &native {
                                Ok(reply) => {
                                    receipt.applied(&json!({"result":reply}), None).await?;
                                    acknowledge(reply);
                                }
                                Err(_) => receipt.uncertain().await?,
                            }
                            let turn = observed.await.context("Codex did not identify the queued shell turn.")?;
                            receipt.observed(&turn, None).await
                        }.await;
                        active.control.get().unwrap().published(result.is_ok());
                        result
                    };
                    let (terminal, accepted) = tokio::join!(bind, accept);
                    if transport.check().is_err() {
                        runtime.retired().await?;
                    }
                    execution.settled().await?;
                    let (turn, terminal) = terminal?;
                    accepted?;
                    let value = match terminal.status {
                        "completed" => terminal.result?,
                        "interrupted" => json!({"interrupted":true}),
                        _ => json!({"failed":true}),
                    };
                    receipt.finish_native(&turn, terminal.status, &value).await?;
                    native
                }.await;
                execution.not_dispatched()?;
                outcome
            }.await;
            source.close();
            subscription.close();
            active.logical_finished.store(true, Ordering::Relaxed);
            execution_result
        }.await;
        if !sent && result.is_err() {
            receipt.not_started().await?;
        }
        result
    }
}
