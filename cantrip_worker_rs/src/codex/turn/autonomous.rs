//! Execute a Core-requested Goal attempt through the canonical operation lane.
use super::*;
use crate::codex::{
    managed::WeakRuntime, preparation::native::LoadedThread, private_inference::GoalAttempt,
};
use crate::{mcp::bindings::Activation, metadata::Guard, native_items::concat, routing::Registry};
use cantrip_history::projection::Work;
use std::path::Path;

pub(in crate::codex) type Activate =
    Arc<dyn Fn(&Value) -> Result<Option<Activation>> + Send + Sync>;

pub(in crate::codex) struct Runner {
    pub runtime: WeakRuntime,
    pub thread: LoadedThread,
    pub session: Value,
    pub bound: (JsString, Value),
    pub cwd: JsString,
    pub model: Value,
    pub provider: Value,
    pub permission: Arc<Mutex<Value>>,
    pub activate: Activate,
}

#[derive(Clone)]
pub(crate) struct Autonomous {
    encryption: Arc<Service>,
    active: Sessions,
    receipts: receipt::Client,
    history: History,
    routing: Arc<Registry>,
    recoveries: goal_recovery::Observations,
    computer_use: computer_use::Desktop,
}

impl Turns {
    pub(crate) fn autonomous(&self, routing: Arc<Registry>) -> Autonomous {
        Autonomous {
            encryption: self.encryption.clone(),
            active: self.active.clone(),
            receipts: self.receipts.clone(),
            history: self.history.clone(),
            routing,
            recoveries: self.goal_recoveries.clone(),
            computer_use: self.computer_use.clone(),
        }
    }
}

impl Autonomous {
    pub(in crate::codex) fn producer(
        &self,
        runner: Runner,
    ) -> impl Fn(GoalAttempt) -> Work<()> + use<> {
        let this = self.clone();
        let runner = Arc::new(runner);
        move |attempt| {
            let this = this.clone();
            let runner = runner.clone();
            Box::pin(async move { this.run(runner, attempt).await })
        }
    }

    async fn run(&self, runner: Arc<Runner>, attempt: GoalAttempt) -> Result<()> {
        let runtime = runner
            .runtime
            .upgrade()
            .context("The native Goal runtime has closed.")?;
        let thread = &attempt.key.thread_id;
        let turn = &attempt.key.turn_id;
        let mut session = runner.session.clone();
        session["connectionId"] = json!(concat(&[
            "autonomous:".into(),
            attempt.key.runner_generation.clone()
        ]));
        let chat = id(&session["chatId"], "autonomous chat")?;
        let scope = Scope::new(self.encryption.clone())?;
        let key = (scope.owner.clone(), scope.server.clone(), chat.clone());
        if thread != runner.thread.id()
            || session["runtimeGeneration"] != runtime.generation()
            || runner.bound.0 != scope.owner
            || runner.bound.1.as_js_string() != Some(&scope.server)
        {
            bail!("The native Goal does not match its prepared session.");
        }
        let gate = runtime
            .inference_router()
            .goal_mutations(thread)
            .context("The Goal runner has retired.")?;
        let observe_cua = output::ComputerUseObserver::default();
        let (subscription, mut events, _) = output::subscribe_with_context(
            &runtime.history(),
            thread,
            None,
            Some(observe_cua.clone()),
        )?;
        let transport = subscription.signal();
        let admission_signal = Signal::any(
            [transport.clone()]
                .into_iter()
                .chain(attempt.resource_signal.clone())
                .collect(),
        );

        let permission;
        let (receipt, granted, owner, signal, recovery) = {
            self.released(&key, &admission_signal).await?;
            let _mutations = gate.lock().await;
            admission_signal.check()?;
            runner.thread.assert_current(&runtime)?;
            permission = runner.permission.lock().unwrap().clone();
            authorize_settings(
                &runner,
                &permission,
                &attempt.request["input"]["threadSettings"],
            )
            .await?;
            let queue = self.receipts.queue_snapshot(&scope, &session).await?;
            if queue["paused"] == true {
                bail!("Managed autonomy is paused.");
            }
            let recovery = &queue["goalRecovery"];
            if recovery.is_object()
                && (recovery["source"]["threadId"].as_js_string() != Some(thread)
                    || recovery["source"]["goalEpoch"] != attempt.request["goalEpoch"]
                    || recovery
                        .get("providerId")
                        .is_some_and(|provider| provider != &runner.provider["id"]))
            {
                bail!("The native producer belongs to another Goal recovery.");
            }
            let (receipt, grant) = self
                .receipts
                .admit_autonomous(scope, session, &attempt.request, &permission, &queue)
                .await?;
            let root = receipt.operation().clone();
            let (abort, signal) = Abort::new();
            let active = Arc::new(Active {
                context: OnceLock::new(),
                root: Some(root),
                project: runner.session["projectId"].as_js_string().cloned(),
                control: OnceLock::new(),
                queued_inference: OnceLock::new(),
                task: OnceLock::new(),
                task_input: None,
                logical_finished: AtomicBool::new(true),
                preparation: abort,
                phase: Mutex::new(Phase::Preparing(Some(thread.clone()))),
                changed: watch::channel(0).0,
            });
            let _ = active.control.set(control::Binding::new(
                receipt.session().clone(),
                permission.clone(),
                runner.thread.version(),
                &json!({"model":runner.model,"provider":runner.provider}),
            ));
            let accepted = {
                let mut state = self.active.lock().unwrap();
                if !state.restoring.contains_key(&key)
                    && !state.stopping.contains_key(&key)
                    && let std::collections::hash_map::Entry::Vacant(entry) =
                        state.active.entry(key.clone())
                {
                    entry.insert(active.clone());
                    true
                } else {
                    false
                }
            };
            if !accepted {
                receipt.not_started().await?;
                bail!("Another execution already owns this Goal chat.");
            }
            let owner = Owner {
                sessions: self.active.clone(),
                key,
                active,
            };
            (
                receipt,
                grant,
                owner,
                Signal::any(vec![signal, admission_signal]),
                recovery.clone(),
            )
        };
        let execution = &granted["execution"];
        let admission = async {
            if execution["chatId"] != json!(chat)
                || execution["threadId"] != json!(thread)
                || execution["executionLaneId"] != receipt.operation().lane
                || execution["modelRouteId"] != receipt.session()["modelRouteId"]
                || execution["providerAccountId"] != receipt.session()["providerAccountId"]
            {
                bail!("Core returned a different managed Goal execution scope.");
            }
            let placement = self
                .routing
                .resolve(&json!({"cwd":execution["cwd"]}))
                .await?;
            same_workspace(&runner.cwd, &placement["cwd"]).await?;
            signal.check()
        }
        .await;
        if let Err(error) = admission {
            receipt.not_started().await?;
            return Err(error);
        }

        let root = receipt.operation();
        let source = Source::claimed(root.generation.clone(), Some(signal.clone()));
        let adapter = runtime.admission();
        owner.active.queued_inference.get_or_init(|| {
            handoff::withdrawal::QueuedInference::new(adapter.clone(), source.clone())
        });
        let observation = recovery.is_object().then(|| {
            self.recoveries
                .observe(&owner.key, &recovery, runtime.generation())
        });
        let outcome = async {
            let mut request = Acquire::new(adapter.lifetime_for_source(&source)?, runner.provider.clone());
            request.purpose = Some("turn".into());
            request.chat_id = Some(json!(chat));
            request.project_id = Some(receipt.session()["projectId"].clone());
            request.thread_id = Some(thread.clone());
            request.expected_turn_id = Some(turn.clone());
            request.signal = Some(source.signal());
            request.recovery_key = Some(json!(concat(&["native-command:".into(),root.operation.clone()])));
            request.recovery = Some(json!({
                "commandId":root.operation,"commandGeneration":root.generation,
                "threadId":thread,"turnId":turn,
                "autonomousGoal":json!({"goalEpoch":attempt.request["goalEpoch"],"orderEpoch":goal_recovery::order_epoch(&recovery)}),
            }));
            if let Some(observation) = observation.clone() {
                let admission = json!({
                    "operationId":root.operation,"operationGeneration":root.generation,
                    "workerGeneration":self.receipts.worker_generation(),
                });
                request.on_queued = Some(Arc::new(move || {
                    observation.queued(admission.clone());
                    Box::pin(async { Ok(()) })
                }));
            }
            let execution = adapter.acquire(request).await?;
            let result = async {
                execution.bind_thread(thread.clone())?;
                execution.bind_turn(turn.clone())?;
                execution.seal_input_dispatch().await?;
                let mcp = (runner.activate)(&root.lane)?;
                let scope = Scope::new(self.encryption.clone())?;
                if scope.owner != owner.key.0 || scope.server != owner.key.1 {
                    bail!("The worker binding changed before Goal dispatch.");
                }
                let identity = self.history.capture_outputs(
                    sources::Input {
                        chat_id: chat.clone(), thread_id: thread.clone(), runtime: runtime.history(),
                        provenance: Some(json!({"kind":"command","operationId":root.operation,"operationGeneration":root.generation})),
                    },
                    transport.clone(),
                );
                let protection = protected::Protected::for_native_output(scope, json!(chat));
                let (emit, published, delivery_signal) =
                    protection.publish_receipt(Some(identity), self.receipts.clone(), root.clone());
                let authority = &granted["computerUseAuthority"];
                let cua = if authority.is_null() {
                    None
                } else {
                    let activation = mcp.as_ref().context("The autonomous computer-use MCP attachment is unavailable.")?;
                    let epoch = self.computer_use.previews.current_epoch();
                    let lifetime = computer_use::Turn::new(
                        self.computer_use.clone(), epoch, &runtime, thread.clone(), emit.clone(),
                        Some(protection), Signal::any(vec![signal.clone(), delivery_signal]),
                    );
                    lifetime.0.register(activation, authority)?;
                    let _ = observe_cua.set(Arc::downgrade(&lifetime.0));
                    Some(lifetime)
                };
                let mut native_interactions = runtime.interaction_requests(thread, true)?;
                native_interactions.bind_turn(turn)?;
                let binding = owner.active.control.get().unwrap();

                receipt.dispatch().await?;
                signal.check()?;
                runner.thread.assert_current(&runtime)?;
                owner.active.dispatch(&signal, thread.clone())?;
                execution.dispatched()?;
                if let Some(cua) = &cua {
                    cua.0.dispatched();
                }
                let allowed = match attempt.allow(&root.generation).await {
                    Ok(allowed) => Ok(allowed),
                    Err(error) if !attempt.forwarded() => {
                        execution.rejected()?;
                        return Err(error);
                    }
                    Err(error) => Err(error),
                };
                owner.active.set(Phase::Running { runtime: runtime.clone(), thread: thread.clone(), turn: turn.clone() });
                let acceptance = async {
                    let result = match allowed {
                        Ok(ref result) => receipt.admitted_goal(result).await,
                        Err(_) => receipt.uncertain().await,
                    };
                    binding.published(result.is_ok());
                    result
                };
                let terminal = async {
                    let collecting = async {
                        tokio::select! {
                            biased;
                            result = output::collect(&mut events, &transport, thread, turn, &emit) => result.map(Some),
                            declined = attempt.declined() => declined.map(|()| None),
                        }
                    };
                    let result = interactions::Turn {
                        runtime: &runtime, receipt: &receipt, thread, turn,
                        thread_version: binding.thread_version, encryption: &self.encryption,
                        emit: &emit, protected: true,
                    }.observe(binding, &mut native_interactions.events, collecting).await;
                    drop(native_interactions);
                    drop(emit);
                    owner.active.set(Phase::Terminal);
                    result
                };
                let (terminal, accepted) = tokio::join!(terminal, acceptance);
                let cua_finished = if let Some(cua) = &cua {
                    cua.0.finish().await
                } else {
                    Ok(())
                };
                drop(mcp);
                drop(cua);
                if transport.check().is_err() {
                    runtime.retired().await?;
                }
                if matches!(terminal, Ok(None)) {
                    execution.rejected()?;
                }
                execution.settled().await?;
                let terminal = terminal?;
                accepted?;
                cua_finished?;
                published.await?;
                let Some(terminal) = terminal else {
                    return receipt.goal_declined(&attempt.key).await;
                };
                let result = match terminal.status {
                    "completed" => terminal.result?,
                    "interrupted" => json!({"interrupted":true}),
                    _ => json!({"failed":true}),
                };
                receipt.finish_native(turn, terminal.status, &result).await
            }.await;
            execution.not_dispatched()?;
            result
        }.await;
        source.close();
        if outcome.is_err() && !attempt.forwarded() {
            if let Some(deferred) = owner.active.finish_withdrawal(&runtime, &signal).await {
                return Err(deferred);
            }
            receipt.not_started().await?;
        }
        subscription.close();
        outcome
    }

    async fn released(&self, key: &Key, transport: &Signal) -> Result<()> {
        let wait = async {
            loop {
                let changed = self
                    .active
                    .lock()
                    .unwrap()
                    .active
                    .get(key)
                    .map(|root| root.changed.subscribe());
                let Some(mut changed) = changed else {
                    return Ok(());
                };
                changed.changed().await?;
            }
        };
        Guard::request(Some(transport.clone())).run(wait).await
    }
}

async fn authorize_settings(runner: &Runner, profile: &Value, settings: &Value) -> Result<()> {
    let permission = if profile == ":yolo" {
        json!(":danger-full-access")
    } else {
        profile.clone()
    };
    if !settings.is_object()
        || !settings["activePermissionProfile"].is_null()
            && (!settings["activePermissionProfile"].is_object()
                || settings["activePermissionProfile"]["id"] != permission)
        || [
            "config",
            "managedConfig",
            "baseInstructions",
            "developerInstructions",
            "windowsSandboxLevel",
            "sandboxPolicy",
            "sandbox",
            "path",
            "root",
            "directory",
            "searchDirectory",
            "sourcePath",
            "destinationPath",
            "paths",
            "roots",
            "searchDirectories",
        ]
        .iter()
        .any(|key| !settings[*key].is_null())
    {
        bail!("The native Goal settings exceed the managed execution scope.");
    }
    let allowed_profile = if profile == ":yolo" {
        json!({"type":"disabled"})
    } else {
        permission.clone()
    };
    for (name, allowed) in [
        (
            "approvalPolicy",
            json!(if profile == ":yolo" {
                "never"
            } else {
                "on-request"
            }),
        ),
        ("approvalsReviewer", json!("user")),
        ("permissions", permission),
        ("permissionProfile", allowed_profile),
        ("permissionProfileId", profile.clone()),
    ] {
        if !settings[name].is_null() && settings[name] != allowed {
            bail!("The native Goal differs from the authorized {name}.");
        }
    }
    let environments = &settings["environments"];
    if !environments.is_null() {
        if environments["environments"]
            .as_array()
            .is_none_or(|list| !list.is_empty())
        {
            bail!("The native Goal changes its managed placement.");
        }
        same_workspace(&runner.cwd, &environments["legacyFallbackCwd"]).await?;
    }
    if !settings["cwd"].is_null() {
        same_workspace(&runner.cwd, &settings["cwd"]).await?;
    }
    for key in ["runtimeWorkspaceRoots", "profileWorkspaceRoots"] {
        if !settings[key].is_null() {
            let Some([root]) = settings[key].as_array().map(Vec::as_slice) else {
                bail!("The native Goal changes the managed workspace roots.");
            };
            same_workspace(&runner.cwd, root).await?;
        }
    }
    Ok(())
}

pub(super) async fn same_workspace(expected: &JsString, actual: &Value) -> Result<()> {
    let expected = Path::new(expected.as_str().context("Managed execution workspace")?);
    let actual = Path::new(actual.as_str().context("Native execution workspace")?);
    if std::path::absolute(expected)? != std::path::absolute(actual)?
        && tokio::fs::canonicalize(expected).await? != tokio::fs::canonicalize(actual).await?
    {
        bail!("The native execution belongs to a different workspace.");
    }
    Ok(())
}
