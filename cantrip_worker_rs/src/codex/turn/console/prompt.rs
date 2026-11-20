//! A console submission is a normal Core-owned execution. The view waits for
//! the native acceptance; the worker retains the operation until settlement.
use super::{View, gateway::fault};
use crate::codex::turn::{
    Active, Owner, Phase, RPC_TIMEOUT, autonomous::same_workspace, control, id, interactions,
    output, protected, queued, receipt::Receipt,
};
use crate::{
    chat_content::{Scope, queue},
    codex::{admission::Acquire, rpc_requests::Failure},
    history::managed::sources,
    inference::admission::Source,
    metadata::{Abort, Signal},
    native_items::concat,
};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_history::{content::Encryption, projection::Work};
use cantrip_wire::{Value, value::json};
use std::sync::{Arc, Mutex, OnceLock, atomic::AtomicBool};
use tokio::sync::{oneshot, watch};

pub(super) fn start(view: Arc<View>, session: Value, frame: Value, open: Signal) -> Work<Value> {
    let (send, receive) = oneshot::channel();
    tokio::spawn(async move {
        let mut reply = Reply {
            id: frame["id"].clone(),
            send: Some(send),
        };
        if let Err(error) = run(&view, session, frame, open, &mut reply).await {
            reply.send(fault(&reply.id, -32001, &error.to_string()));
        }
    });
    Box::pin(async move {
        receive
            .await
            .context("The worker lost the native console receipt.")
    })
}

struct Reply {
    id: Value,
    send: Option<oneshot::Sender<Value>>,
}

impl Reply {
    fn send(&mut self, frame: Value) {
        if let Some(reply) = self.send.take() {
            let _ = reply.send(frame);
        }
    }
}

async fn run(
    view: &View,
    session: Value,
    mut frame: Value,
    open: Signal,
    reply: &mut Reply,
) -> Result<()> {
    open.check()?;
    view.assert_current()?;
    let scope = Scope::new(view.turns.encryption.clone())?;
    ensure!(
        scope.owner == view.prepared.bound.0
            && view.prepared.bound.1.as_js_string() == Some(&scope.server),
        "The managed console owner changed."
    );
    let operation = uuid::Uuid::new_v4().to_string();
    let (mut params, mode) = normalize(view, &frame["params"]).await?;
    let retained = queue::retain_console(
        &scope,
        &view.turns.attachments,
        &view.chat,
        &operation,
        &mut params,
        &view.command,
        mode,
        &view.local_directory,
    )
    .await?;
    frame["params"] = params;
    frame["params"]["clientUserMessageId"] =
        retained["prompt"]["nativeClientUserMessageId"].clone();
    open.check()?;
    view.assert_current()?;
    let (receipt, grant) = view
        .turns
        .receipts
        .admit_console_turn(
            scope,
            session,
            &operation,
            &frame,
            &view.permission(),
            &retained,
        )
        .await?;
    let mut sent = false;
    let result = execute(
        view,
        &receipt,
        &grant,
        frame["params"].clone(),
        open,
        reply,
        &mut sent,
    )
    .await;
    if result.is_err() && !sent {
        // The durable input already exists on Core. Settle this attempt as
        // never dispatched so Core can recover the retained prompt.
        receipt.not_started().await?;
    }
    result
}

async fn normalize(view: &View, requested: &Value) -> Result<(Value, &'static str)> {
    let thread = view.prepared.thread.id();
    ensure!(
        requested["threadId"].as_js_string() == Some(thread),
        "The console prompt belongs to another native thread."
    );
    if !requested["cwd"].is_null() {
        same_workspace(&view.cwd, &requested["cwd"]).await?;
    }
    if !requested["runtimeWorkspaceRoots"].is_null() {
        let roots = requested["runtimeWorkspaceRoots"]
            .as_array()
            .context("Invalid console workspace roots.")?;
        ensure!(
            roots.len() == 1,
            "A console prompt must use its prepared workspace."
        );
        same_workspace(&view.cwd, &roots[0]).await?;
    }
    if !requested["environments"].is_null() {
        let allowed = view
            .prepared
            .environment
            .as_ref()
            .map(|environment| json!(vec![environment.selection.clone()]))
            .unwrap_or(Value::Null);
        ensure!(
            requested["environments"] == allowed,
            "The console prompt cannot change its environment."
        );
    }
    // Let the selected thread supply provider, permissions and collaboration
    // settings. Explicit changes have their own managed commands.
    let checked = view
        .prepared
        .runtime
        .request(
            "thread/settings/read".into(),
            Some(json!({"threadId":thread})),
            Some(RPC_TIMEOUT),
            None,
        )
        .await?
        .context("The console's native settings were not returned.")?;
    ensure!(
        checked["threadId"].as_js_string() == Some(thread),
        "The console settings belong to another native thread."
    );
    let settings = &checked["threadSettings"];
    let permission = view.permission();
    let expected_permission = if permission == ":yolo" {
        json!(":danger-full-access")
    } else {
        permission
    };
    ensure!(
        settings["activePermissionProfile"]["id"].is_null()
            || settings["activePermissionProfile"]["id"] == expected_permission,
        "The native permission profile changed before the console turn."
    );
    ensure!(
        requested["model"].is_null()
            || requested["model"] == settings["model"]
            || requested["model"] == view.command["model"]["name"],
        "Change the managed model before submitting with a different model."
    );
    for key in [
        "parentTurnId",
        "rootTurnId",
        "toolOutput",
        "disabledPluginIds",
        "additionalContext",
        "cyberAccessProgram",
        "responsesapiClientMetadata",
        "responsesapiClientMetadataPatch",
    ] {
        ensure!(
            requested[key].is_null(),
            "The console prompt cannot override {key}."
        );
    }

    let mut params = json!({
        "threadId":thread, "input":requested["input"],
        "cwd":view.cwd, "runtimeWorkspaceRoots":vec![view.cwd.clone()],
    });
    for key in [
        "turnTrigger",
        "clientUserMessageId",
        "outputSchema",
        "serviceTierForTurn",
    ] {
        if let Some(value) = requested.get(key).filter(|value| !value.is_null()) {
            params[key] = value.clone();
        }
    }
    let mode = if settings["collaborationMode"]["mode"] == "plan" {
        "plan"
    } else {
        "default"
    };
    Ok((params, mode))
}

async fn execute(
    view: &View,
    receipt: &Receipt<'_>,
    grant: &Value,
    params: Value,
    open: Signal,
    reply: &mut Reply,
    sent: &mut bool,
) -> Result<()> {
    let root = receipt.operation();
    let session = receipt.session();
    let execution = &grant["execution"];
    let thread = view.prepared.thread.id();
    let runtime = &view.prepared.runtime;
    let turns = &view.turns;
    let key = (
        receipt.scope().owner.clone(),
        receipt.scope().server.clone(),
        view.chat.clone(),
    );
    let placement = if session["contextKind"] == "standalone" {
        "scratchRootId"
    } else {
        "worktreeId"
    };
    // Core returns the stored selection alongside the effective policy.
    let permission =
        if execution["isPrimary"] == true && execution["worktreePolicy"] == "required-for-writes" {
            json!(":read-only")
        } else {
            [
                &execution["nativePermissionPolicy"]["effectiveId"],
                &execution["nativePermissionPolicy"]["resolvedSelectedId"],
                &execution["permissionProfileId"],
                &execution["defaultPermissionProfileId"],
            ]
            .into_iter()
            .find(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| json!(":workspace"))
        };
    ensure!(
        grant["computerUseAuthority"].is_null()
            && [
                "chatId",
                "threadId",
                "modelRouteId",
                "providerAccountId",
                "contextKind",
                "projectId"
            ]
            .iter()
            .all(|field| session[*field] == execution[*field])
            && session["placementId"] == execution[placement]
            && execution["executionLaneId"] == root.lane
            && permission == view.permission()
            && execution["workerId"].as_js_string() == Some(turns.encryption.worker_id()),
        "Core returned a different native console execution."
    );
    let cwd = turns
        .preparation
        .resolve_routing(&json!({"cwd":execution["cwd"]}))
        .await?;
    same_workspace(&view.cwd, &cwd["cwd"]).await?;
    open.check()?;
    view.assert_current()?;
    let (abort, signal) = Abort::new();
    let active = Arc::new(Active {
        context: OnceLock::new(),
        root: Some(root.clone()),
        project: session["projectId"].as_js_string().cloned(),
        control: OnceLock::from(control::Binding::new(
            session.clone(),
            view.permission(),
            view.prepared.thread.version(),
            &view.command,
        )),
        queued_inference: OnceLock::new(),
        task: OnceLock::new(),
        task_input: None,
        logical_finished: AtomicBool::new(true),
        preparation: abort,
        phase: Mutex::new(Phase::Preparing(Some(thread.clone()))),
        changed: watch::channel(0).0,
    });
    {
        let mut owners = turns.active.lock().unwrap();
        ensure!(
            !owners.active.contains_key(&key)
                && !owners.stopping.contains_key(&key)
                && !owners.restoring.contains_key(&key)
                && !owners.cancelled.contains(&(
                    key.clone(),
                    root.operation.clone(),
                    root.generation.clone()
                )),
            "The console chat already has an active or cancelled native execution."
        );
        owners.active.insert(key.clone(), active.clone());
    }
    let _owner = Owner {
        sessions: turns.active.clone(),
        key,
        active: active.clone(),
    };
    let (subscription, mut events, _) = output::subscribe(&runtime.history(), thread)?;
    let transport = subscription.signal();
    let source = Source::claimed(
        root.generation.clone(),
        Some(Signal::any(vec![signal.clone(), transport.clone()])),
    );
    let result = async {
        let adapter = runtime.admission();
        let mut request = Acquire::new(adapter.lifetime_for_source(&source)?, view.command["provider"].clone());
        request.purpose = Some("turn".into());
        request.chat_id = Some(json!(view.chat));
        request.project_id = session.get("projectId").filter(|value| !value.is_null()).cloned();
        request.thread_id = Some(thread.clone());
        request.signal = Some(source.signal());
        request.recovery_key = Some(json!(concat(&["native-command:".into(), root.operation.clone()])));
        request.recovery = Some(json!({
            "commandId":root.operation, "commandGeneration":root.generation,
            "threadId":thread, "messageId":params["clientUserMessageId"],
        }));
        let acquire = adapter.acquire(request);
        tokio::pin!(acquire);
        let granted = tokio::select! {
            biased;
            error = open.cancelled() => {
                active.preparation.abort(anyhow!("The console closed before native dispatch."));
                if let Ok(execution) = acquire.await {
                    execution.not_dispatched()?;
                }
                return Err(error.into());
            }
            result = &mut acquire => result?,
        };
        let result = async {
            granted.bind_thread(thread.clone())?;
            granted.seal_input_dispatch().await?;
            let _mcp = turns.preparation.activate(&view.prepared, &root.lane)?;
            let protection = protected::Protected::for_native_output(Scope::new(turns.encryption.clone())?, json!(view.chat));
            ensure!(protection.scope().identity()? == receipt.scope().identity()?, "The console worker identity changed.");
            let canonical = (session["contextKind"] == "project").then(|| turns.history.capture_outputs(
                sources::Input {
                    chat_id: view.chat.clone(), thread_id: thread.clone(), runtime: runtime.history(),
                    provenance: Some(json!({"kind":"command","operationId":root.operation,"operationGeneration":root.generation})),
                }, transport.clone(),
            ));
            open.check()?;
            view.assert_current()?;
            receipt.dispatch().await?;
            open.check()?;
            view.assert_current()?;
            let mut native_interactions = runtime.interaction_requests(
                thread, session["contextKind"] == "project" && view.prepared.environment.is_none())?;
            active.dispatch(&signal, thread.clone())?;
            granted.dispatched()?;
            *sent = true;
            let native = runtime.request("turn/start".into(), Some(params.clone()), Some(RPC_TIMEOUT), None).await;
            let native = match native {
                Ok(Some(value)) if value["turn"]["id"].is_string() => Some(value),
                Err(error) if error.downcast_ref::<Failure>().is_some_and(|failure| failure.native_error.is_some()) => {
                    granted.rejected()?;
                    granted.settled().await?;
                    let mut fault = error.downcast_ref::<Failure>().unwrap().native_error.clone().unwrap();
                    if queued::deferred(&fault) {
                        drop(native_interactions);
                        drop(_mcp);
                        drop(_owner);
                        let acknowledged = receipt.defer_queue_input(&fault, None).await?;
                        fault["data"]["clientUserMessageId"] = params["clientUserMessageId"].clone();
                        if acknowledged {
                            fault["data"]["queueRetention"] = json!("retained");
                            fault["data"]["queueRetained"] = json!(true);
                        } else {
                            fault["data"]["queueRetention"] = json!("uncertain");
                        }
                    } else {
                        receipt.reject_start(&fault, "failed").await?;
                    }
                    reply.send(json!({"id":reply.id,"error":fault}));
                    return Ok(());
                }
                _ => {
                    receipt.uncertain().await?;
                    reply.send(fault(&reply.id, -32001, "The native start acknowledgement is uncertain."));
                    None
                }
            };
            let turn = match &native {
                Some(value) => id(&value["turn"]["id"], "console native turn")?,
                None => output::started(&mut events, &transport).await?,
            };
            native_interactions.bind_turn(&turn)?;
            granted.bind_turn(turn.clone())?;
            active.set(Phase::Running { runtime:runtime.clone(), thread:thread.clone(), turn:turn.clone() });
            let applied = async {
                let result = match &native {
                    Some(value) => receipt.applied(&json!({"result":value}), Some(&turn)).await,
                    None => receipt.observed(&turn, None).await,
                };
                active.control.get().unwrap().published(result.is_ok());
                result?;
                if let Some(value) = native.as_ref() {
                    reply.send(json!({"id":reply.id,"result":value}));
                }
                Ok::<(), anyhow::Error>(())
            };
            let publisher = protection.clone();
            let client = turns.receipts.clone();
            let operation = root.clone();
            let (emit, published) = protection.publish_with(canonical, move |event| {
                let (client, operation, publisher) = (client.clone(), operation.clone(), publisher.clone());
                async move { client.event(publisher.scope(), &operation, event).await }
            });
            let terminal = async {
                let binding = active.control.get().unwrap();
                let collecting = output::collect(&mut events, &transport, thread, &turn, &emit);
                let outcome = interactions::Turn {
                    runtime, receipt, thread, turn: &turn, thread_version: binding.thread_version,
                    encryption: &turns.encryption, emit: &emit, protected: true,
                }.observe(binding, &mut native_interactions.events, collecting).await;
                drop(native_interactions);
                active.set(Phase::Terminal);
                drop(emit);
                outcome
            };
            let (terminal, applied) = tokio::join!(terminal, applied);
            if transport.check().is_err() {
                runtime.retired().await?;
            }
            granted.settled().await?;
            let terminal = terminal?;
            applied?;
            published.await?;
            let contents = match terminal.status {
                "completed" => terminal.result?,
                "interrupted" => json!({"interrupted":true}),
                _ => json!({"failed":true}),
            };
            receipt.finish_native(&turn, terminal.status, &contents).await
        }.await;
        granted.not_dispatched()?;
        result
    }.await;
    source.close();
    subscription.close();
    result
}
