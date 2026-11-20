//! Core-owned native executions whose start RPC only acknowledges the
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
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_history::content::Encryption;
use cantrip_wire::{Value, value::json};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{oneshot, watch};

impl Turns {
    pub(super) async fn run_acknowledged_start(
        &self,
        command: &Value,
        scope: Scope,
        method: &'static str,
        params: Value,
        acknowledge: impl FnOnce(&Value) + Send,
    ) -> Result<Value> {
        let key = self.key(command)?;
        let thread = id(&command["threadId"], "native start thread")?;
        let bound = (key.0.clone(), json!(key.1));
        ensure!(
            scope.owner == key.0 && scope.server == key.1,
            "The worker binding changed before the native start."
        );
        let prepared = if command["session"].is_object() {
            ensure!(
                command["session"]["chatId"].as_js_string() == Some(&key.2),
                "The native start belongs to another managed conversation."
            );
            let prepared = self.preparation.prepare(command, Intent::Preserve).await?;
            ensure!(
                prepared.bound == bound,
                "The native start lost its worker binding."
            );
            Some(prepared)
        } else {
            None
        };
        let (runtime, loaded, session) = if let Some(prepared) = &prepared {
            let runtime = prepared.runtime.clone();
            let session = native_session(command, &runtime, &thread);
            (runtime, prepared.thread.clone(), session)
        } else {
            let (loaded, live) = self
                .preparation
                .selected_live_owner(&key.2, &bound)
                .context("The native start has no prepared managed thread.")?;
            let session = live
                .session
                .context("The native start has no managed session.")?;
            ensure!(
                session["modelRouteId"] == command["model"]["routeId"]
                    && session["providerAccountId"] == command["provider"]["accountId"],
                "The native start no longer matches the live model route."
            );
            (live.runtime, loaded, session)
        };
        ensure!(
            loaded.id() == &thread,
            "The native start selected a different thread."
        );
        loaded.assert_current(&runtime)?;
        if method == super::compact::METHOD {
            super::compact::ensure_idle(&runtime, &thread).await?;
        }
        let (receipt, _, grant) = self
            .receipts
            .admit_command(scope, session, method, &params, command, Value::Null)
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
                bail!("Core returned a different native execution scope.");
            }
            let cwd = self.preparation.resolve_routing(&json!({"cwd": execution["cwd"]})).await?;
            same_workspace(&id(&command["cwd"], "native start workspace")?, &cwd["cwd"]).await?;
            let (abort, signal) = Abort::new();
            let active = Arc::new(Active {
                root: Some(root.clone()),
                project: session["projectId"].as_js_string().cloned(),
                control: OnceLock::from(control::Binding::new(
                    session.clone(), command["permissionProfileId"].clone(), loaded.version()
                )),
                queued_inference: OnceLock::new(),
                task: OnceLock::new(),
                task_input: None,
                // Release the local owner after physical settlement. Core
                // owns logical closure.
                logical_finished: AtomicBool::new(false),
                preparation: abort,
                phase: Mutex::new(Phase::Preparing(Some(thread.clone()))),
                changed: watch::channel(0).0,
            });
            let (subscription, mut events, _) = output::subscribe(&runtime.history(), &thread)?;
            let reserved = {
                let mut sessions = self.active.lock().unwrap();
                if sessions.active.contains_key(&key) || sessions.restoring.contains_key(&key) || sessions.stopping.contains_key(&key) || sessions.cancelled.contains(&(
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
                    let _mcp = prepared.as_ref()
                        .map(|prepared| self.preparation.activate(prepared, &root.lane))
                        .transpose()?
                        .flatten();
                    if session["contextKind"] == "project" {
                        self.history.bind(sources::Input {
                            chat_id: key.2.clone(), thread_id: thread.clone(), runtime: runtime.history(),
                            provenance: Some(json!({
                                "kind":"command","operationId":root.operation,"operationGeneration":root.generation,
                            })),
                        })?;
                    }
                    receipt.dispatch().await?;
                    loaded.assert_current(&runtime)?;
                    receipt.scope().identity()?;
                    active.dispatch(&signal, thread.clone())?;
                    execution.dispatched()?;
                    sent = true;
                    let reply = runtime.request(method.into(), Some(params), Some(RPC_TIMEOUT), None).await;
                    let native = match reply {
                        Ok(Some(reply)) if reply.is_object() => Ok(reply),
                        Err(error) => {
                            if let Some(native) = error.downcast_ref::<Failure>().and_then(|failure| failure.native_error.as_ref()) {
                                execution.rejected()?;
                                execution.settled().await?;
                                receipt.reject_start(native, "failed").await?;
                                if method == super::shell::METHOD {
                                    bail!("Codex rejected the queued shell command.");
                                }
                                return Err(error);
                            }
                            Err(error)
                        }
                        Ok(_) => Err(anyhow!("Codex did not acknowledge the native start.")),
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
                            let turn = observed.await.context("Codex did not identify the native turn.")?;
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
                    if terminal.status == "interrupted" {
                        self.preparation.renew_runner_on_next_prepare(&key.2, &bound, &runtime, &thread);
                    }
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
