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
}

impl Turns {
    pub(crate) fn autonomous(&self, routing: Arc<Registry>) -> Autonomous {
        Autonomous {
            encryption: self.encryption.clone(),
            active: self.active.clone(),
            receipts: self.receipts.clone(),
            history: self.history.clone(),
            routing,
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
        let (subscription, mut events, _) = output::subscribe(&runtime.history(), thread)?;
        let transport = subscription.signal();
        let admission_signal = Signal::any(
            [transport.clone()]
                .into_iter()
                .chain(attempt.resource_signal.clone())
                .collect(),
        );

        let permission;
        let (receipt, granted, owner, signal) = {
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
            if !queue["goalRecovery"].is_null() {
                bail!("This managed Goal needs its saved recovery admission.");
            }
            let (receipt, grant) = self
                .receipts
                .admit_autonomous(scope, session, &attempt.request, &permission, &queue)
                .await?;
            let root = receipt.operation().clone();
            let (abort, signal) = Abort::new();
            let active = Arc::new(Active {
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
            )
        };
        let execution = &granted["execution"];
        let admission = async {
            if !granted["computerUseAuthority"].is_null()
                || execution["chatId"] != json!(chat)
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
                "autonomousGoal":json!({"goalEpoch":attempt.request["goalEpoch"],"orderEpoch":0}),
            }));
            let execution = adapter.acquire(request).await?;
            let result = async {
                execution.bind_thread(thread.clone())?;
                execution.bind_turn(turn.clone())?;
                execution.seal_input_dispatch().await?;
                let _mcp = (runner.activate)(&root.lane)?;
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
                let publisher = protection.clone();
                let client = self.receipts.clone();
                let operation = root.clone();
                let (emit, published) = protection.publish_canonical_with(identity, move |event| {
                    let (client, operation, publisher) = (client.clone(), operation.clone(), publisher.clone());
                    async move { client.event(publisher.scope(), &operation, event).await }
                });

                receipt.dispatch().await?;
                signal.check()?;
                runner.thread.assert_current(&runtime)?;
                owner.active.dispatch(&signal, thread.clone())?;
                execution.dispatched()?;
                let allowed = match attempt.allow(&root.generation).await {
                    Ok(allowed) => Ok(allowed),
                    Err(error) if !attempt.forwarded() => {
                        execution.rejected()?;
                        return Err(error);
                    }
                    Err(error) => Err(error),
                };
                let _ = owner.active.control.set(control::Binding::new(
                    receipt.session().clone(), permission.clone(), runner.thread.version(),
                ));
                owner.active.set(Phase::Running { runtime: runtime.clone(), thread: thread.clone(), turn: turn.clone() });
                let acceptance = async {
                    let result = match allowed {
                        Ok(ref result) => receipt.admitted_goal(result).await,
                        Err(_) => receipt.uncertain().await,
                    };
                    owner.active.control.get().unwrap().published(result.is_ok());
                    result
                };
                let terminal = async {
                    let result = tokio::select! {
                        biased;
                        result = output::collect(&mut events, &transport, thread, turn, &emit) => result.map(Some),
                        declined = attempt.declined() => declined.map(|()| None),
                    };
                    drop(emit);
                    owner.active.set(Phase::Terminal);
                    result
                };
                let (terminal, accepted) = tokio::join!(terminal, acceptance);
                if transport.check().is_err() {
                    runtime.retired().await?;
                }
                if matches!(terminal, Ok(None)) {
                    execution.rejected()?;
                }
                execution.settled().await?;
                let terminal = terminal?;
                accepted?;
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
        subscription.close();
        if outcome.is_err() && !attempt.forwarded() {
            receipt.not_started().await?;
        }
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
