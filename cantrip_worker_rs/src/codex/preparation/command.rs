//! Worker command preparation joins authenticated scope, the durable association,
//! and the native thread. It also installs the idle MCP attachment.
mod profile;
pub(in crate::codex) mod task_pause;
pub(in crate::codex) use profile::collaboration_mode;

use super::{
    Coordinator, Identify, Identity, Input, Intent, Selection, Target,
    native::{self, LoadedThread},
};
use crate::{
    codex::{
        managed::{Runtime, WeakRuntime, Worker},
        observation::{home, provider},
        revocation::{Resource, Target as RevocationTarget},
        suspension_store::{self, Opened, Store},
        task_pause::{Latch, Root},
        turn::autonomous::{Autonomous, Runner},
    },
    config::Config,
    encryption::{Service, ServiceError},
    http::checked,
    mcp::bindings::{Activation, Broker, Server},
    protected_secrets::{open_mcp_servers, open_runtime_provider},
    provider_access::Access,
    routing::Registry,
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use std::sync::OnceLock;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::OnceCell;

pub(crate) const COMMAND: &str = "chat.thread.ensure";
pub(in crate::codex) type Activate = Arc<dyn Fn() -> Result<Option<Activation>> + Send + Sync>;

pub(crate) struct Prepared {
    pub runtime: Runtime,
    pub thread: native::LoadedThread,
    pub codex_home: PathBuf,
    pub runner_generation: JsString,
    pub(in crate::codex) saved: Option<Opened>,
    admission: Option<Value>,
    bound: (JsString, Value),
}

enum TaskAttachment {
    Saved(Box<Opened>),
    StopWithoutLocalRecord(Value),
}

#[derive(Clone)]
pub(crate) struct Ensurer(Arc<Inner>);

struct ThreadOwner {
    runtime: WeakRuntime,
    thread: native::LoadedThread,
    bound: (JsString, Value),
    session: Option<Value>,
    task: Option<Root>,
}

#[derive(Clone)]
pub(in crate::codex) struct LiveThread {
    pub runtime: Runtime,
    pub session: Option<Value>,
}

struct Inner {
    codex: Worker,
    live_threads: Mutex<HashMap<JsString, ThreadOwner>>,
    task_pauses: Mutex<HashMap<task_pause::Key, Arc<Latch>>>,
    resources: Mutex<HashMap<task_pause::Key, Arc<Resource>>>,
    access: Access,
    settings: Arc<Mutex<Config>>,
    encryption: Arc<Service>,
    routing: Arc<Registry>,
    data: PathBuf,
    skills: Option<PathBuf>,
    worker: JsString,
    preparation: Coordinator,
    broker: OnceCell<Broker>,
    cli_contexts: crate::cli::Contexts,
    permission_profiles: bool,
    autonomous: OnceLock<Autonomous>,
}

impl Ensurer {
    pub(crate) fn new(
        codex: Worker,
        access: Access,
        settings: Arc<Mutex<Config>>,
        encryption: Arc<Service>,
        routing: Arc<Registry>,
        skills: Option<PathBuf>,
        cli_contexts: crate::cli::Contexts,
    ) -> Self {
        let (data, worker) = {
            let config = settings.lock().unwrap();
            (config.data_directory.clone(), config.worker_id.clone())
        };
        let preparation = Coordinator::new(&data);
        let codex_compatibility = codex.compatibility();
        let permission_profiles = codex_compatibility["initialize"]["experimentalApi"] == true
            && codex_compatibility["methods"]["permissionProfile/list"] == "available";
        Self(Arc::new(Inner {
            codex,
            live_threads: Mutex::default(),
            task_pauses: Mutex::default(),
            resources: Mutex::default(),
            access,
            settings,
            encryption,
            routing,
            data,
            skills,
            worker,
            preparation,
            broker: OnceCell::new(),
            cli_contexts,
            autonomous: OnceLock::new(),
            permission_profiles,
        }))
    }

    pub(crate) async fn execute(&self, incoming: &Value) -> Result<Value> {
        let prepared = self.prepare(incoming, Intent::Preserve).await?;
        let mut result = json!({"threadId": prepared.thread.id()});
        if let Some(turn) = incoming["recoveryTurnId"].as_js_string() {
            let snapshot = prepared.runtime.read_history(prepared.thread.id()).await?;
            prepared.thread.assert_current(&prepared.runtime)?;
            let status = snapshot["thread"]["turns"]
                .as_array()
                .and_then(|turns| {
                    turns
                        .iter()
                        .find(|entry| entry["id"].as_js_string() == Some(turn))
                })
                .map_or(Value::Null, |entry| entry["status"].clone());
            result["recovery"] = checked(
                "nativeTurnRecoveryObservationSchema",
                &json!({
                    "threadId": prepared.thread.id(), "runtimeGeneration": prepared.runtime.generation(),
                    "turnId": turn, "status": status,
                }),
            )?;
        }
        self.assert_bound(&prepared.bound)?;
        Ok(result)
    }

    pub(crate) fn configure_autonomous(&self, autonomous: Autonomous) -> Result<()> {
        self.0
            .autonomous
            .set(autonomous)
            .map_err(|_| anyhow::anyhow!("Native Goal producer is already configured."))
    }

    pub(crate) async fn prepare(&self, incoming: &Value, intent: Intent) -> Result<Prepared> {
        self.prepare_inner(incoming, intent, false, None).await
    }

    pub(in crate::codex) async fn prepare_held_stop(&self, incoming: &Value) -> Result<Prepared> {
        self.prepare_inner(incoming, Intent::Preserve, true, None)
            .await
    }

    pub(in crate::codex) async fn prepare_restored_task(
        &self,
        incoming: &Value,
        saved: Opened,
    ) -> Result<Prepared> {
        self.prepare_inner(
            incoming,
            Intent::Preserve,
            false,
            Some(TaskAttachment::Saved(Box::new(saved))),
        )
        .await
    }

    pub(in crate::codex) async fn prepare_task_stop(
        &self,
        incoming: &Value,
        saved: Option<Opened>,
        checkpoint: &Value,
    ) -> Result<Prepared> {
        let attachment = saved
            .map(|saved| TaskAttachment::Saved(Box::new(saved)))
            .unwrap_or_else(|| TaskAttachment::StopWithoutLocalRecord(checkpoint.clone()));
        self.prepare_inner(incoming, Intent::Preserve, true, Some(attachment))
            .await
    }

    pub(in crate::codex) fn revoke_resources(
        &self,
        bound: &(JsString, Value),
        target: &mut RevocationTarget,
    ) -> Result<()> {
        self.assert_bound(bound)?;
        let server = bound
            .1
            .as_js_string()
            .context("Missing resource server identity.")?;
        self.0
            .resources
            .lock()
            .unwrap()
            .retain(|(owner, logical_server, chat), resource| {
                if owner == &bound.0 && logical_server == server && resource.matches(target) {
                    resource.revoke();
                    target.chats.insert(chat.clone());
                    return false;
                }
                true
            });
        self.0
            .live_threads
            .lock()
            .unwrap()
            .retain(|chat, thread| &thread.bound != bound || !target.chats.contains(chat));
        self.0
            .task_pauses
            .lock()
            .unwrap()
            .retain(|(owner, logical_server, chat), _| {
                owner != &bound.0 || logical_server != server || !target.chats.contains(chat)
            });
        let broker = self.0.broker.get().map_or(Ok(()), |broker| {
            broker.revoke_owned((&bound.0, server), |claims| {
                target.matches(
                    claims["chatId"].as_js_string(),
                    claims["projectId"].as_js_string(),
                )
            })
        });
        self.0
            .codex
            .revoke_resources(&bound.0, server, target)
            .and(broker)
    }

    async fn prepare_inner(
        &self,
        incoming: &Value,
        intent: Intent,
        stopping: bool,
        restored_task: Option<TaskAttachment>,
    ) -> Result<Prepared> {
        let (owner, server) = self.0.encryption.bound_identity()?;
        let logical_server = server
            .as_js_string()
            .cloned()
            .context("Unverified worker server identity")?;
        let command = self.0.routing.resolve(incoming).await?;
        let session = &command["session"];
        if !session.is_object() {
            bail!("This native preparation requires the managed chat session from the server.");
        }
        if session.get("osExecution").is_some() {
            bail!("This managed thread must prepare in its recorded execution environment.");
        }
        if session["computerUseEnabled"] == true {
            bail!("Managed computer-use attachment is unavailable in the native worker.");
        }
        let standalone = session["contextKind"] == "standalone";
        let (context_kind, execution, placement) = if standalone {
            ("standalone", "standalone-chat", "scratchRootId")
        } else {
            ("project", "ide", "worktreeId")
        };
        let cwd = field(&command, "cwd")?;
        let chat = field(session, "chatId")?;
        let project = session["projectId"].as_js_string().cloned();
        let resource = {
            let mut resources = self.0.resources.lock().unwrap();
            let entry = resources
                .entry((owner.clone(), logical_server.clone(), chat.clone()))
                .or_insert_with(|| Arc::new(Resource::new(chat.clone(), project.clone())));
            if entry.project != project {
                *entry = Arc::new(Resource::new(chat.clone(), project.clone()));
            }
            entry.clone()
        };
        let identity = Identity {
            server_id: logical_server.clone(),
            owner_id: owner.clone(),
            worker_id: self.0.worker.clone(),
            chat_id: chat.clone(),
            placement_id: field(session, placement)?,
            project_id: project,
            context_kind,
        };
        let task_restoration = restored_task.is_some();
        let (held, native_stop) = match restored_task {
            Some(TaskAttachment::Saved(saved)) => (Some(*saved), None),
            Some(TaskAttachment::StopWithoutLocalRecord(checkpoint)) => (None, Some(checkpoint)),
            None => {
                let held = match session.get("heldSuspension") {
                    Some(expected) => {
                        if intent != Intent::Preserve || command["taskOwned"] == true {
                            bail!("This suspended thread must use its original execution.");
                        }
                        Some(self.open_held(&command, expected, placement).await?)
                    }
                    None => None,
                };
                (held, None)
            }
        };
        let provider = open_runtime_provider(&self.0.encryption, &command["provider"])?;
        if let Some(defaults) = command
            .get("subagentDefaults")
            .filter(|value| value.is_object())
        {
            open_runtime_provider(&self.0.encryption, &defaults["provider"])?;
        }
        let structured = command["structuredTask"] == true;
        let user_servers = if structured {
            Vec::new()
        } else {
            open_mcp_servers(
                &self.0.encryption,
                command["mcpServers"]
                    .as_array()
                    .context("Managed MCP configurations")?,
            )?
        };
        let target = Target {
            thread_id: command["threadId"].as_js_string().cloned(),
            cwd: cwd.clone(),
            execution_profile: execution,
            model_route_id: field(&command["model"], "routeId")?,
            provider_id: field(&provider, "id")?,
            provider_kind: field(&provider, "kind")?,
            provider_account_id: provider["accountId"].as_js_string().cloned(),
            credential_home_key: provider["credentialHomeKey"].as_js_string().cloned(),
            intent,
        };
        let bound = (owner.clone(), server.clone());
        let scope = json!({"serverId": server, "ownerId": owner, "workerId": self.0.worker});
        let prepared = Arc::new(Mutex::new(None));
        let this = self.clone();
        let retained_resource = resource.clone();
        self.0.preparation.prepare(Input {
            identity,
            target,
            unbound_reuse_key: None,
            replacement_settings: None,
            on_identified: None,
            on_prepared: None,
            prepare: Box::new({
                let bound = bound.clone();
                let prepared = prepared.clone();
                move |selection, identify| Box::pin(async move {
                    resource.signal.check()?;
                    if let Some(saved) = &held
                        && (selection.intent != Intent::Preserve
                            || selection.thread_id.as_ref() != saved.source["threadId"].as_js_string())
                    {
                        bail!("The saved suspension source belongs to a different native attachment.");
                    }
                    let model_provider = provider::model_provider(&provider);
                    let source = held.as_ref().map_or(home::Source::Current(selection.thread_id.as_ref()), home::Source::Held);
                    let profile = home::profile(
                        &this.0.data, &scope, source, &chat, &provider, execution, this.0.skills.clone(),
                    ).await?;
                    this.assert_bound(&bound)?;
                    let codex_home = profile.codex_home.clone();
                    let attached = held.as_ref().and_then(|saved| {
                        let expected = selection.thread_id.as_ref()?;
                        let (thread, live) = this.selected_live_owner(&chat, &bound)?;
                        if thread.id() != expected { return None; }
                        let session = live.session.as_ref()?;
                        (live.runtime.codex_home().as_os_str() == saved.home.as_os_str()
                            && ["contextKind", "projectId", "placementId", "modelRouteId", "providerAccountId"]
                                .iter().all(|field| session[*field] == saved.source[*field]))
                            .then_some((thread, live))
                    });
                    let runtime = match &attached {
                        Some((_, live)) => live.runtime.clone(),
                        None => this.0.codex.launch_in_scope(
                            provider::launch(profile, provider, this.0.access.clone())?,
                            Some((logical_server, bound.0.clone())),
                        ).await?,
                    };
                    resource.signal.check()?;
                    let session = &command["session"];
                    let mut mcp = profile::external_servers(user_servers);
                    let admission = if structured {
                        None
                    } else {
                        let broker = this.broker().await?;
                        let legacy_root = if standalone {
                            None
                        } else {
                            Some(this.0.routing.protect_metadata(&json!({"path":cwd})).await?["path"].clone())
                        };
                        let admission = json!({
                            "ownerId": bound.0, "workerId": this.0.worker, "chatId": chat,
                            "contextKind": context_kind, "projectId": session["projectId"],
                            "worktreeId": session["worktreeId"], "rootKind": session["rootKind"],
                            "scratchRootId": session["scratchRootId"],
                            "permissionProfileId": command["permissionProfileId"],
                            "allowedOperations": vec!["context.get", "tool.help", "web.read"],
                        });
                        let attachment = broker.prepare(admission.clone(), legacy_root).await?;
                        if let Err(error) = resource.signal.check() {
                            let binding = field(&attachment.connection, "bindingId")?;
                            broker.revoke(&binding)?;
                            return Err(error);
                        }
                        mcp["cantrip"] = attachment.codex_configuration(&std::env::current_exe()?)?;
                        Some(admission)
                    };
                    let runner: JsString = payload_digest(&json!([
                        json!(runtime.generation()), json!(chat), session[placement].clone()
                    ])).into();
                    let first_message = command["taskGoalFirstInput"].as_js_string();
                    if let (Some(message), Some(thread)) = (first_message, selection.thread_id.as_ref()) {
                        runtime.inference_router().reserve_task_first_input(thread.clone(), runner.clone(), message.clone());
                    }
                    let mut configuration = profile::configuration(
                        &command, &cwd, mcp, runner.clone(), model_provider, standalone,
                        this.0.permission_profiles,
                    ).await?;
                    this.assert_bound(&bound)?;
                    if let Some(saved) = &held {
                        configuration.expected_suspension = Some(saved.evidence["suspension"].clone());
                    } else {
                        configuration.expected_suspension = native_stop;
                    }
                    let delivery = this.0.codex.project_goals().filter(|_| !standalone && held.is_none() && !task_restoration);
                    let task = command["taskOwned"] == true;
                    let latch = task.then(|| this.task_latch(&bound, &chat)).transpose()?;
                    let task_root = |thread: &JsString, latch: &Arc<Latch>| Root {
                        runner: runner.clone(),
                        binding: json!({
                            "workerId":this.0.worker, "chatId":chat, "projectId":session["projectId"],
                            "worktreeId":session["worktreeId"], "threadId":thread, "cycleId":command["taskCycleId"],
                            "modelRouteId":command["model"]["routeId"], "providerAccountId":command["provider"]["accountId"],
                        }),
                        latch: latch.clone(),
                    };
                    let router = runtime.inference_router();
                    resource.signal.check()?;
                    if let Some(thread) = &selection.thread_id {
                        router.bind_resource(thread, &resource);
                    }
                    if let Some(latch) = &latch {
                        runtime.admission().set_chat_paused(&chat, latch.current().blocked)?;
                        if let Some(thread) = &selection.thread_id {
                            router.set_task_root(thread, Some(task_root(thread, latch)));
                        }
                    }
                    if task
                        && let (Some(delivery), Some(thread)) = (delivery, selection.thread_id.as_ref())
                    {
                        delivery.select(&bound, thread, runtime.generation(), &chat, true);
                    }
                    let loaded = if stopping && let Some((thread, _)) = attached {
                        // The authorized Stop uses native terminal history even
                        // if a previous Resume found unreadable checkpoint bytes.
                        thread.assert_current(&runtime)?;
                        identify(thread.id().clone()).await?;
                        thread
                    } else {
                        let loaded = native::load(&runtime, &selection, &configuration, &identify).await?;
                        router.bind_resource(loaded.id(), &resource);
                        resource.signal.check()?;
                        native::configure(&runtime, &loaded, selection.intent, &configuration).await?;
                        loaded
                    };
                    if selection.intent == Intent::Configure {
                        profile::apply_plan_mode(&runtime, &loaded, &command).await?;
                    }
                    if let Some(message) = first_message {
                        runtime.inference_router().reserve_task_first_input(loaded.id().clone(), runner.clone(), message.clone());
                    }
                    if first_message.is_some() || command["taskGoalPermissions"] == true {
                        profile::apply_goal_permissions(&runtime, &loaded, &command, this.0.permission_profiles).await?;
                    }
                    loaded.assert_current(&runtime)?;
                    this.assert_bound(&bound)?;
                    let thread_id = loaded.id().clone();
                    {
                        let mut owners = this.0.live_threads.lock().unwrap();
                        resource.signal.check()?;
                        if let Some(delivery) = delivery {
                            delivery.select(&bound, &thread_id, runtime.generation(), &chat, task);
                        }
                        let native_session = (!task).then(|| native_session(&command, &runtime, loaded.id()));
                        if let (Some(autonomous), Some(session)) = (this.0.autonomous.get(), native_session.as_ref())
                            && context_kind == "project"
                            && held.is_none()
                        {
                            let broker = Arc::downgrade(&this.0);
                            let authority = bound.clone();
                            let admission = admission.clone();
                            let thread = thread_id.clone();
                            let activate = Arc::new(move |lane: &Value| {
                                broker.upgrade().context("The managed MCP broker has closed.")?
                                    .activate(&authority, &thread, admission.as_ref(), lane)
                            });
                            runtime.inference_router().register_goal_producer(
                                thread_id.clone(), runner.clone(), Arc::new(autonomous.producer(Runner {
                                    runtime: runtime.downgrade(), thread: loaded.clone(), session: session.clone(),
                                    bound: bound.clone(), cwd: cwd.clone(), provider: command["provider"].clone(),
                                    permission: command["permissionProfileId"].clone(), activate,
                                })),
                            );
                        } else {
                            runtime.inference_router().remove_goal_producer(&thread_id);
                        }
                        let task = latch.as_ref().map(|latch| task_root(&thread_id, latch));
                        router.set_task_root(&thread_id, task.clone());
                        let owner = ThreadOwner {
                            runtime: runtime.downgrade(), thread: loaded.clone(), bound: bound.clone(),
                            session: native_session, task,
                        };
                        owners.insert(chat.clone(), owner);
                    }
                    if let Some(latch) = latch && !task_restoration {
                        this.sync_task_pause(&bound, &chat, &latch).await?;
                    }
                    *prepared.lock().unwrap() = Some(Prepared { runtime, thread: loaded, codex_home, runner_generation: runner, saved: held, admission, bound });
                    Ok(thread_id)
                })
            }),
        }).await?;
        retained_resource.signal.check()?;
        self.assert_bound(&bound)?;
        let result = prepared
            .lock()
            .unwrap()
            .take()
            .context("Managed thread ownership was lost.")?;
        Ok(result)
    }

    async fn open_held(
        &self,
        command: &Value,
        expected: &Value,
        placement: &str,
    ) -> Result<Opened> {
        let session = &command["session"];
        let source = json!({
            "chatId":session["chatId"],"threadId":command["threadId"],
            "contextKind":session["contextKind"],"projectId":session["projectId"],
            "placementId":session[placement],"modelRouteId":command["model"]["routeId"],
            "providerAccountId":command["provider"]["accountId"],
        });
        let store = Store::new(&self.0.data, self.0.encryption.clone());
        let id = expected["storageId"]
            .as_str()
            .context("Invalid native suspension locator.")?;
        let opened = store.open(id, &source).await.map_err(|error| {
            let message = if error.is::<ServiceError>() {
                "This suspended chat needs a current chat-content encryption grant."
            } else if suspension_store::missing(&error) {
                "The saved suspension source is missing from this worker."
            } else {
                "The saved suspension source could not be opened for this chat."
            };
            anyhow!(message)
        })?;
        // Version and fingerprint are diagnostic. Core decides whether it can
        // attach to the exact checkpoint under the current native runtime.
        if opened.evidence["storageId"] != expected["storageId"]
            || opened.evidence["suspension"] != expected["suspension"]
            || opened.source["threadId"] != expected["suspension"]["threadId"]
        {
            bail!("The saved suspension source belongs to a different native attachment.");
        }
        Ok(opened)
    }

    pub(in crate::codex) async fn detach_restored_task(
        &self,
        prepared: &Prepared,
        chat: &JsString,
    ) {
        if self.assert_bound(&prepared.bound).is_err() {
            return;
        }
        let request = {
            let mut owners = self.0.live_threads.lock().unwrap();
            if !owners.get(chat).is_some_and(|owner| {
                owner.bound == prepared.bound && owner.thread == prepared.thread
            }) || prepared.thread.assert_current(&prepared.runtime).is_err()
            {
                return;
            }
            owners.remove(chat);
            prepared
                .runtime
                .inference_router()
                .set_task_root(prepared.thread.id(), None);
            prepared.runtime.request(
                "thread/unsubscribe".into(),
                Some(json!({"threadId":prepared.thread.id()})),
                Some(std::time::Duration::from_secs(120)),
                None,
            )
        };
        let _ = request.await;
    }

    pub(crate) fn activate(&self, prepared: &Prepared, lane: &Value) -> Result<Option<Activation>> {
        self.assert_bound(&prepared.bound)?;
        prepared.thread.assert_current(&prepared.runtime)?;
        self.0.activate(
            &prepared.bound,
            prepared.thread.id(),
            prepared.admission.as_ref(),
            lane,
        )
    }

    pub(in crate::codex) fn cycle_activation(&self, prepared: &Prepared, lane: &Value) -> Activate {
        let ensurer = Arc::downgrade(&self.0);
        let identity = prepared.bound.clone();
        let thread = prepared.thread.id().clone();
        let admission = prepared.admission.clone();
        let lane = lane.clone();
        Arc::new(move || {
            ensurer
                .upgrade()
                .context("The managed MCP broker has closed.")?
                .activate(&identity, &thread, admission.as_ref(), &lane)
        })
    }

    /// Prefer the last prepared owner of this exact chat and native thread.
    /// A closed runtime falls back to a fresh, non-resuming metadata transport.
    pub(in crate::codex) fn live_thread(
        &self,
        chat: &JsString,
        thread: &JsString,
        bound: &(JsString, Value),
    ) -> Option<LiveThread> {
        let (selected, live) = self.selected_live_thread(chat, bound)?;
        (selected == *thread).then_some(live)
    }

    pub(in crate::codex) fn selected_live_thread(
        &self,
        chat: &JsString,
        bound: &(JsString, Value),
    ) -> Option<(JsString, LiveThread)> {
        self.selected_live_owner(chat, bound)
            .map(|(thread, live)| (thread.id().clone(), live))
    }

    fn selected_live_owner(
        &self,
        chat: &JsString,
        bound: &(JsString, Value),
    ) -> Option<(native::LoadedThread, LiveThread)> {
        let owners = self.0.live_threads.lock().unwrap();
        let owner = owners.get(chat)?;
        if &owner.bound != bound {
            return None;
        }
        let runtime = owner.runtime.upgrade()?;
        owner.thread.assert_current(&runtime).ok()?;
        Some((
            owner.thread.clone(),
            LiveThread {
                runtime,
                session: owner.session.clone(),
            },
        ))
    }

    pub(crate) fn identity(&self) -> Result<(JsString, Value)> {
        Ok(self.0.encryption.bound_identity()?)
    }

    pub(crate) fn supports_permission_profiles(&self) -> bool {
        self.0.permission_profiles
    }

    /// Start the native thread without granting authority to run its Goal.
    pub(in crate::codex) async fn start_host_goal(
        &self,
        command: &Value,
        runtime: &Runtime,
        model_provider: &str,
    ) -> Result<JsString> {
        let cwd = field(command, "cwd")?;
        let mut configuration = profile::configuration(
            command,
            &cwd,
            json!({}),
            runtime.generation().into(),
            model_provider,
            false,
            self.0.permission_profiles,
        )
        .await?;
        if let Some(overlay) = &mut configuration.managed_overlay {
            overlay["canonicalHistory"] = json!(false);
        }
        let identify: Identify = Arc::new(|_| Box::pin(async { Ok(()) }));
        let thread = native::load(
            runtime,
            &Selection {
                thread_id: None,
                intent: Intent::Preserve,
                replacement_settings: None,
            },
            &configuration,
            &identify,
        )
        .await?;
        Ok(thread.id().clone())
    }

    pub(in crate::codex) async fn label_runtime(
        &self,
        job: &Value,
        bound: &(JsString, Value),
    ) -> Result<Runtime> {
        self.assert_bound(bound)?;
        let owner = &bound.0;
        let server = bound
            .1
            .as_js_string()
            .context("Unverified worker server identity")?;
        let provider = open_runtime_provider(&self.0.encryption, &job["provider"])?;
        let scope = json!({"serverId":server,"ownerId":owner,"workerId":self.0.worker});
        let profile = home::profile(
            &self.0.data,
            &scope,
            home::Source::Current(None),
            &field(job, "chatId")?,
            &provider,
            "ide",
            self.0.skills.clone(),
        )
        .await?;
        self.assert_bound(bound)?;
        self.0
            .codex
            .launch_in_scope(
                provider::launch(profile, provider, self.0.access.clone())?,
                Some((server.clone(), owner.clone())),
            )
            .await
    }

    pub(crate) async fn resolve_routing(&self, incoming: &Value) -> Result<Value> {
        self.0.routing.resolve(incoming).await
    }

    fn assert_bound(&self, identity: &(JsString, Value)) -> Result<()> {
        if &self.0.encryption.bound_identity()? != identity {
            bail!("The worker binding changed during managed thread preparation.");
        }
        Ok(())
    }

    async fn broker(&self) -> Result<&Broker> {
        self.0
            .broker
            .get_or_try_init(|| async {
                let url = self.0.settings.lock().unwrap().server_url.clone();
                let settings = self.0.settings.clone();
                let server = Server::new(
                    &url,
                    Arc::new(move || Ok(settings.lock().unwrap().token.clone())),
                )?;
                let encryption = self.0.encryption.clone();
                Broker::start(
                    &self.0.data,
                    self.0.worker.clone(),
                    Arc::new(move || {
                        let (owner, server) = encryption.bound_identity()?;
                        Ok((
                            owner,
                            server
                                .as_js_string()
                                .cloned()
                                .context("Unverified worker server identity")?,
                        ))
                    }),
                    server,
                )
                .await
            })
            .await
    }

    pub(crate) async fn close(self) -> Result<()> {
        let inner = Arc::try_unwrap(self.0)
            .ok()
            .context("Managed preparations are still active")?;
        if let Some(broker) = inner.broker.into_inner() {
            broker.close().await?;
        }
        Ok(())
    }
}

fn field(object: &Value, field: &str) -> Result<JsString> {
    object[field]
        .as_js_string()
        .cloned()
        .with_context(|| format!("Managed thread preparation requires {field}"))
}

impl Inner {
    fn activate(
        &self,
        identity: &(JsString, Value),
        thread: &JsString,
        admission: Option<&Value>,
        lane: &Value,
    ) -> Result<Option<Activation>> {
        if &self.encryption.bound_identity()? != identity {
            bail!("The worker binding changed during managed MCP activation.");
        }
        let Some(mut admission) = admission.cloned() else {
            return Ok(None);
        };
        admission["executionLaneId"] = lane.clone();
        let activation = self
            .broker
            .get()
            .context("Cantrip MCP attachment was not prepared.")?
            .activate(&admission)?
            .context("Cantrip MCP attachment no longer matches the admitted turn.")?;
        self.cli_contexts
            .bind(thread, identity, &admission["chatId"], lane);
        Ok(Some(activation))
    }
}

pub(in crate::codex) fn native_session(
    command: &Value,
    runtime: &Runtime,
    thread: &JsString,
) -> Value {
    let target = &command["session"];
    let placement = if target["contextKind"] == "standalone" {
        &target["scratchRootId"]
    } else {
        &target["worktreeId"]
    };
    json!({
        "chatId":target["chatId"],"threadId":thread,"contextKind":target["contextKind"],
        "projectId":target["projectId"],"placementId":placement,
        "modelRouteId":command["model"]["routeId"],"providerAccountId":command["provider"]["accountId"],
        "runtimeGeneration":runtime.generation(),"connectionId":format!("gui:goal:{}",runtime.generation()),
    })
}
