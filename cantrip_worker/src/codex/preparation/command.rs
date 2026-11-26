//! Worker command preparation joins authenticated scope, the durable association,
//! and the native thread. It also installs the idle MCP attachment.
pub(in crate::codex) mod chat_pause;
mod plan;
mod profile;
mod relocation;
pub(in crate::codex) mod task_pause;
pub(crate) use plan::{PLAN_GET, PLAN_SET};
pub(crate) use profile::PERMISSION_PROFILES;
pub(in crate::codex) use profile::collaboration_mode;

use super::{
    Coordinator, Identify, Identity, Input, Intent, Selection, Target,
    native::{self, LoadedThread},
};
use crate::{
    codegraph::Supervisor,
    codex::{
        guest_environment::Environment,
        managed::{Runtime, WeakRuntime, Worker},
        observation::{home, provider},
        provider_errors::surround,
        revocation::{Resource, Target as RevocationTarget},
        suspension_store::{self, Opened, Store},
        task_pause::{Latch, Root},
        turn::{
            autonomous::{Autonomous, Runner},
            console::import,
            settings::snapshot,
            thread_changes::Observation,
        },
    },
    config::Config,
    encryption::{Service, ServiceError},
    http::checked,
    mcp::bindings::{Activation, Broker, Server},
    protected_secrets::{open_mcp_servers, open_runtime_provider},
    provider_access::Access,
    routing::Registry,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use std::sync::OnceLock;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::OnceCell;

pub(crate) const COMMAND: &str = "chat.thread.ensure";
pub(in crate::codex) type Activate =
    Arc<dyn Fn(&Value) -> Result<Option<Activation>> + Send + Sync>;

pub(crate) struct Prepared {
    pub runtime: Runtime,
    pub thread: native::LoadedThread,
    pub codex_home: PathBuf,
    pub runner_generation: JsString,
    pub(in crate::codex) saved: Option<Opened>,
    pub(in crate::codex) environment: Option<Arc<Environment>>,
    admission: Option<Value>,
    pub(in crate::codex) bound: (JsString, Value),
    pub(in crate::codex) queue: Option<Arc<import::Import>>,
    pub(in crate::codex) permission: Arc<Mutex<Value>>,
}

enum TaskAttachment {
    Saved(Box<Opened>),
    StopWithoutLocalRecord(Value),
}

pub(in crate::codex) enum HandoffStage {
    Source,
    Destination {
        operation: String,
        transfer: Option<Value>,
    },
}

#[derive(Clone)]
pub(crate) struct Ensurer(Arc<Inner>);

struct ThreadOwner {
    runtime: WeakRuntime,
    thread: native::LoadedThread,
    bound: (JsString, Value),
    runner_base: JsString,
    runner: JsString,
    session: Option<Value>,
    model_route: Value,
    provider_id: Value,
    provider_account: Value,
    environment_id: Option<String>,
    task: Option<Root>,
    task_settings: Option<Arc<snapshot::Source>>,
    queue: Option<Arc<import::Binding>>,
    settings: Option<Arc<snapshot::Publisher>>,
    external_changes: Option<Observation>,
}

#[derive(Clone)]
pub(in crate::codex) struct LiveThread {
    pub runtime: Runtime,
    pub session: Option<Value>,
}

struct Inner {
    codex: Worker,
    live_threads: Mutex<HashMap<JsString, ThreadOwner>>,
    chat_pauses: Mutex<HashMap<task_pause::Key, Arc<chat_pause::Latch>>>,
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
    codegraph: Arc<Supervisor>,
    web: Arc<crate::managed_web::Runtimes>,
    browser_surfaces: Arc<crate::browser_surface::Manager>,
    cli_contexts: crate::cli::Contexts,
    permission_profiles: bool,
    autonomous: OnceLock<Autonomous>,
    queue_imports: OnceLock<import::Factory>,
    settings_publisher: OnceLock<snapshot::Factory>,
}

impl Ensurer {
    pub(in crate::codex) async fn standalone_skill_sources(
        &self,
        command: &Value,
    ) -> Result<crate::codex::skills::standalone::Sources> {
        crate::codex::skills::standalone::sources(
            &self.0.data,
            self.0.skills.as_deref(),
            &command["provider"],
            &command["chatSkillAudienceKeys"],
        )
        .await
    }

    pub(crate) fn new(
        codex: Worker,
        access: Access,
        settings: Arc<Mutex<Config>>,
        encryption: Arc<Service>,
        routing: Arc<Registry>,
        skills: Option<PathBuf>,
        cli_contexts: crate::cli::Contexts,
        web: Arc<crate::managed_web::Runtimes>,
        browser_surfaces: Arc<crate::browser_surface::Manager>,
        codegraph: Arc<Supervisor>,
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
            chat_pauses: Mutex::default(),
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
            codegraph,
            web,
            browser_surfaces,
            cli_contexts,
            autonomous: OnceLock::new(),
            queue_imports: OnceLock::new(),
            settings_publisher: OnceLock::new(),
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
            let mut observed = json!({
                    "threadId": prepared.thread.id(), "runtimeGeneration": prepared.runtime.generation(),
                    "turnId": turn, "status": status,
            });
            let steer = &incoming["recoverySteerInputs"];
            if let Some(clients) = steer["clientUserMessageIds"].as_array()
                && steer["priorRuntimeGeneration"].as_str() != Some(prepared.runtime.generation())
                && matches!(
                    status.as_str(),
                    Some("completed" | "failed" | "interrupted")
                )
            {
                let clients = clients
                    .iter()
                    .filter_map(|value| value.as_js_string().cloned())
                    .collect::<Vec<_>>();
                observed["observedInputs"] = json!(
                    crate::codex::turn::observed_inputs(
                        &prepared.runtime,
                        prepared.thread.id(),
                        turn,
                        &clients,
                    )
                    .await
                );
                prepared.thread.assert_current(&prepared.runtime)?;
            }
            result["recovery"] = checked("nativeTurnRecoveryObservationSchema", &observed)?;
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

    pub(in crate::codex) fn configure_queue_imports(&self, imports: import::Factory) -> Result<()> {
        self.0
            .queue_imports
            .set(imports)
            .map_err(|_| anyhow!("Native queue imports are already configured."))
    }

    pub(in crate::codex) fn configure_settings_publisher(
        &self,
        settings: snapshot::Factory,
    ) -> Result<()> {
        self.0
            .settings_publisher
            .set(settings)
            .map_err(|_| anyhow!("Native settings publication is already configured."))
    }

    pub(crate) fn settings_reconnect(&self) -> impl Fn() + use<> {
        let this = Arc::downgrade(&self.0);
        move || {
            if let Some(this) = this.upgrade() {
                for owner in this.live_threads.lock().unwrap().values() {
                    if let Some(settings) = &owner.settings {
                        settings.wake();
                    }
                }
            }
        }
    }

    pub(crate) async fn read_settings(
        &self,
        scope: &Value,
        signal: crate::metadata::Signal,
    ) -> Result<Value> {
        let scope = checked("nativeSettingsReadScopeSchema", scope)?;
        self.settings_source(&scope, false)?.read(signal).await
    }

    pub(in crate::codex) fn console_settings_source(
        &self,
        session: &Value,
    ) -> Result<Arc<snapshot::Source>> {
        let mut scope = session.clone();
        scope["workerId"] = json!(self.0.worker);
        self.settings_source(&scope, true)
    }

    pub(in crate::codex) fn settings_source(
        &self,
        scope: &Value,
        write: bool,
    ) -> Result<Arc<snapshot::Source>> {
        let chat = field(scope, "chatId")?;
        let identity = self.identity()?;
        self.0
            .live_threads
            .lock()
            .unwrap()
            .get(&chat)
            .filter(|owner| owner.bound == identity)
            .and_then(|owner| owner.settings.as_ref())
            .filter(|settings| {
                if write {
                    settings.source.binding_matches(scope)
                } else {
                    settings.source.matches_read(scope)
                }
            })
            .map(|settings| settings.source.clone())
            .with_context(|| {
                format!(
                    "The settings {} no longer refers to the current managed runtime.",
                    if write { "update" } else { "read" }
                )
            })
    }

    pub(in crate::codex) fn task_goal_source(
        &self,
        scope: &Value,
        cycle: &Value,
    ) -> Result<(native::LoadedThread, Root, Arc<snapshot::Source>)> {
        let chat = field(scope, "chatId")?;
        let identity = self.identity()?;
        let owners = self.0.live_threads.lock().unwrap();
        let matched = owners
            .get(&chat)
            .filter(|owner| owner.bound == identity)
            .and_then(|owner| Some((owner, owner.task.as_ref()?, owner.task_settings.as_ref()?)))
            .filter(|(_, root, settings)| {
                root.binding.get("cycleId") == Some(cycle) && settings.matches_exact_read(scope)
            });
        let (owner, root, settings) =
            matched.context("The Task Goal has no current native source.")?;
        Ok((owner.thread.clone(), root.clone(), settings.clone()))
    }

    pub(crate) async fn prepare(&self, incoming: &Value, intent: Intent) -> Result<Prepared> {
        self.prepare_inner(incoming, intent, false, None, None)
            .await
    }

    pub(in crate::codex) async fn prepare_handoff(
        &self,
        incoming: &Value,
        stage: HandoffStage,
    ) -> Result<Prepared> {
        self.prepare_inner(incoming, Intent::Preserve, false, None, Some(stage))
            .await
    }

    pub(in crate::codex) async fn prepare_held_stop(&self, incoming: &Value) -> Result<Prepared> {
        self.prepare_inner(incoming, Intent::Preserve, true, None, None)
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
            None,
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
        self.prepare_inner(incoming, Intent::Preserve, true, Some(attachment), None)
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
        self.0
            .chat_pauses
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
        stage: Option<HandoffStage>,
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
        let standalone = session["contextKind"] == "standalone";
        let (context_kind, execution, placement) = if standalone {
            ("standalone", "standalone-chat", "scratchRootId")
        } else {
            ("project", "ide", "worktreeId")
        };
        let cwd = field(&command, "cwd")?;
        let chat = field(session, "chatId")?;
        let project = session["projectId"].as_js_string().cloned();
        let change_plan = incoming["type"] == PLAN_SET;
        let command_type = incoming["type"].as_str();
        let suspension_control = matches!(
            command_type,
            Some(crate::codex::turn::RESUME | crate::codex::turn::STOP_SUSPENSION)
        );
        let can_attach_held = suspension_control || command_type == Some(COMMAND);
        let guest_allowed = match command_type {
            Some(
                COMMAND
                | PLAN_SET
                | crate::codex::turn::ROLLBACK
                | crate::codex::turn::COMPACT
                | crate::codex::turn::queue_wake::RESUME
                | crate::codex::turn::goal_recovery::COMMAND
                | crate::codex::turn::goal_recovery::CLAIM_COMMAND,
            ) => true,
            Some(
                crate::codex::goals::CREATE
                | crate::codex::goals::UPDATE
                | crate::codex::goals::CLEAR,
            ) => command["taskContext"].is_null(),
            Some(crate::codex::goals::QUEUE_EXECUTE) => matches!(
                command["executionMethod"].as_str(),
                Some(
                    "thread/goal/set" | "thread/goal/clear" | crate::codex::turn::settings::UPDATE
                )
            ),
            Some(crate::codex::turn::RUN) => session.get("osExecution").is_some(),
            _ => suspension_control,
        };
        if !guest_allowed && session.get("osExecution").is_some() {
            bail!(
                "This command requires guest execution support beyond native thread preparation."
            );
        }
        let scope = json!({"serverId": server, "ownerId": owner, "workerId": self.0.worker});
        let environment = Environment::capture(&self.0.data, &scope, session, &cwd)
            .await?
            .map(Arc::new);
        let guest = environment.is_some();
        if guest
            && (!guest_allowed
                || (stopping && !suspension_control)
                || (session.get("heldSuspension").is_some() && !can_attach_held)
                || restored_task.is_some()
                || command["taskOwned"] == true)
        {
            bail!(
                "This command requires guest execution support beyond native thread preparation."
            );
        }
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
                        if intent != Intent::Preserve || change_plan || command["taskOwned"] == true
                        {
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
        if let Some(saved) = &held
            && session.get("councilProviderCheckpointSource").is_some()
        {
            home::select_council_checkpoint(&self.0.data, &scope, &provider, saved).await?;
        }
        if let Some(defaults) = command
            .get("subagentDefaults")
            .filter(|value| value.is_object())
        {
            if (standalone && session["council"] != true) || guest {
                bail!("Custom subagents require a Host Project Chat or Council agent.");
            }
            let child = open_runtime_provider(&self.0.encryption, &defaults["provider"])?;
            if ["id", "kind", "accountId", "credentialHomeKey"]
                .iter()
                .any(|field| child[*field] != provider[*field])
            {
                bail!("Custom subagents must use the root model's provider identity.");
            }
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
        let mcp = profile::external_servers(user_servers, guest)?;
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
        let prepared = Arc::new(Mutex::new(None));
        let this = self.clone();
        let retained_resource = resource.clone();
        let staged = stage.is_some();
        let history_epoch = command["session"]["councilHistoryEpoch"]
            .as_js_string()
            .cloned();
        let input = Input {
            identity,
            target,
            unbound_reuse_key: history_epoch.clone(),
            replacement_settings: None,
            on_identified: None,
            on_prepared: None,
            prepare: Box::new({
                let bound = bound.clone();
                let prepared = prepared.clone();
                move |selection, identify| {
                    Box::pin(async move {
                        resource.signal.check()?;
                        if let Some(saved) = &held
                            && (selection.intent != Intent::Preserve
                                || selection.thread_id.as_ref()
                                    != saved.source["threadId"].as_js_string())
                        {
                            bail!(
                                "The saved suspension source belongs to a different native attachment."
                            );
                        }
                        let model_provider = provider::model_provider(&provider);
                        let source = if let Some(HandoffStage::Destination { operation, .. }) =
                            &stage
                        {
                            home::Source::Staged {
                                thread: selection.thread_id.as_ref().context("Handoff thread")?,
                                operation,
                            }
                        } else {
                            held.as_ref().map_or(
                                home::Source::Current(selection.thread_id.as_ref()),
                                home::Source::Held,
                            )
                        };
                        let mut profile = home::profile(
                            &this.0.data,
                            &scope,
                            source,
                            Some(&chat),
                            &provider,
                            execution,
                            this.0.skills.clone(),
                            environment.as_deref(),
                        )
                        .await?;
                        if command["session"]["council"] == true {
                            // Provider recovery can retire the process for this
                            // agent without interrupting other chats and agents.
                            let runner =
                                payload_digest(&json!([json!(chat), json!(history_epoch)]));
                            profile.id = surround("", &profile.id, &format!(":council:{runner}"));
                            // Keep the existing Council rollout location while
                            // adding the account's configured global skills.
                            profile.extra_skill_roots.extend(this.0.skills.clone());
                        }
                        this.assert_bound(&bound)?;
                        let codex_home = profile.codex_home.clone();
                        let attached = held.as_ref().and_then(|saved| {
                            let expected = selection.thread_id.as_ref()?;
                            let (thread, live) = this.selected_live_owner(&chat, &bound)?;
                            if thread.id() != expected {
                                return None;
                            }
                            let session = live.session.as_ref()?;
                            (live.runtime.codex_home().as_os_str() == saved.home.as_os_str()
                                && [
                                    "contextKind",
                                    "projectId",
                                    "placementId",
                                    "modelRouteId",
                                    "providerAccountId",
                                ]
                                .iter()
                                .all(|field| session[*field] == saved.source[*field]))
                            .then_some((thread, live))
                        });
                        let runtime = match &attached {
                            Some((_, live)) => live.runtime.clone(),
                            None => {
                                let mut launch = provider::launch(
                                    profile,
                                    provider,
                                    this.0.access.clone(),
                                    &command["model"],
                                    &command["subagentDefaults"]["model"],
                                )?;
                                if let Some(environment) = &environment {
                                    environment.configure_launch(&mut launch);
                                }
                                this.0
                                    .codex
                                    .launch_in_scope(
                                        launch,
                                        Some((logical_server, bound.0.clone())),
                                    )
                                    .await?
                            }
                        };
                        resource.signal.check()?;
                        if !stopping && held.is_none() {
                            runtime
                                .synchronize_models(
                                    &command["model"],
                                    &command["subagentDefaults"]["model"],
                                )
                                .await?;
                            resource.signal.check()?;
                            this.assert_bound(&bound)?;
                        }
                        let session = &command["session"];
                        let mut mcp = mcp;
                        if !structured
                            && !standalone
                            && !guest
                            && !stopping
                            && let Some(codegraph) = this
                                .0
                                .codegraph
                                .agent_mcp(&this.0.data, &cwd, Some(session))
                                .await
                        {
                            mcp["codegraph"] = codegraph;
                        }
                        resource.signal.check()?;
                        this.assert_bound(&bound)?;
                        let admission = if structured {
                            None
                        } else {
                            let broker = this.broker().await?;
                            let legacy_root = if standalone || guest {
                                None
                            } else {
                                Some(
                                    this.0
                                        .routing
                                        .protect_metadata(&json!({"path":cwd}))
                                        .await?["path"]
                                        .clone(),
                                )
                            };
                            let mut operations =
                                vec!["context.get", "tool.help", "web.read", "web.search"];
                            if standalone && session["council"] == true {
                                operations.extend(
                                    crate::mcp::bindings::COUNCIL_TOOLS
                                        .into_iter()
                                        .map(|(operation, _)| operation),
                                );
                            }
                            if !standalone {
                                operations.extend(["policy.list", "policy.read"]);
                                operations.extend(
                                    crate::mcp::bindings::CLIENT_TOOLS
                                        .into_iter()
                                        .map(|(operation, _)| operation),
                                );
                                operations.extend(
                                    crate::mcp::bindings::TARGET_TOOLS
                                        .into_iter()
                                        .map(|(operation, _)| operation),
                                );
                                operations.extend(
                                    crate::mcp::bindings::EXPLORER_TOOLS
                                        .into_iter()
                                        .map(|(operation, _)| operation),
                                );
                                operations.extend(
                                    crate::mcp::bindings::TERMINAL_TOOLS
                                        .into_iter()
                                        .map(|(operation, _)| operation),
                                );
                                operations.extend(
                                    crate::mcp::bindings::BROWSER_TOOLS
                                        .into_iter()
                                        .map(|(operation, _)| operation),
                                );
                                operations.extend(
                                    crate::mcp::bindings::ALERT_TOOLS
                                        .into_iter()
                                        .map(|(operation, _)| operation),
                                );
                                operations.extend(
                                    crate::mcp::bindings::TASK_TOOLS
                                        .into_iter()
                                        .map(|(operation, _)| operation)
                                        .filter(|operation| !guest || *operation != "task.create"),
                                );
                            }
                            if !standalone && command["taskOwned"] != true {
                                operations.push("context.compact");
                                operations.extend(
                                    crate::mcp::bindings::CHAT_TOOLS
                                        .into_iter()
                                        .map(|(operation, _)| operation),
                                );
                            }
                            if !standalone && !guest {
                                operations.extend(
                                    crate::mcp::bindings::RUN_READ_TOOLS
                                        .into_iter()
                                        .chain(crate::mcp::bindings::RUN_WRITE_TOOLS)
                                        .chain(crate::mcp::bindings::WORKTREE_READ_TOOLS)
                                        .chain(crate::mcp::bindings::WORKTREE_WRITE_TOOLS)
                                        .map(|(operation, _)| operation),
                                );
                            }
                            let admission = json!({
                                "ownerId": bound.0, "workerId": this.0.worker, "chatId": chat,
                                "contextKind": context_kind, "projectId": session["projectId"],
                                "worktreeId": session["worktreeId"], "rootKind": session["rootKind"],
                                "scratchRootId": session["scratchRootId"],
                                "permissionProfileId": command["permissionProfileId"],
                                "allowedOperations": operations.into_iter()
                                    .chain(crate::web::session::TOOLS.into_iter().map(|(operation, _)| operation))
                                    .collect::<Vec<_>>(),
                            });
                            let computer_use = session["computerUseEnabled"] == true;
                            let attachment = broker
                                .prepare_for_turn(admission.clone(), legacy_root, computer_use)
                                .await?;
                            if let Err(error) = resource.signal.check() {
                                let binding = field(&attachment.connection, "bindingId")?;
                                broker.revoke(&binding)?;
                                return Err(error);
                            }
                            mcp["cantrip"] = if guest {
                                runtime
                                    .remember_secret(field(&attachment.connection, "credential")?);
                                attachment.codex_http_configuration()
                            } else {
                                attachment.codex_configuration(&std::env::current_exe()?)?
                            };
                            if session["council"] == true {
                                mcp["cantrip"]["tools"] = json!({
                                    "council_memory_read":json!({"approval_mode":"approve"}),
                                    "council_memory_write":json!({"approval_mode":"approve"}),
                                    "council_history_search":json!({"approval_mode":"approve"}),
                                    "council_history_read":json!({"approval_mode":"approve"}),
                                    "council_message_post":json!({"approval_mode":"approve"}),
                                });
                            }
                            if computer_use {
                                mcp["cantrip_cua"] = attachment
                                    .computer_use_configuration(&std::env::current_exe()?, guest)?;
                            }
                            Some(admission)
                        };
                        let runner_base: JsString = payload_digest(&json!([
                            json!(runtime.generation()),
                            json!(chat),
                            session[placement].clone()
                        ]))
                        .into();
                        let runner = this
                            .0
                            .live_threads
                            .lock()
                            .unwrap()
                            .get(&chat)
                            .filter(|owner| {
                                owner.runner_base == runner_base
                                    && owner.bound == bound
                                    && selection.thread_id.as_ref() == Some(owner.thread.id())
                            })
                            .map_or_else(|| runner_base.clone(), |owner| owner.runner.clone());
                        let first_message = command["taskGoalFirstInput"].as_js_string();
                        if let (Some(message), Some(thread)) =
                            (first_message, selection.thread_id.as_ref())
                        {
                            runtime.inference_router().reserve_task_first_input(
                                thread.clone(),
                                runner.clone(),
                                message.clone(),
                            );
                        }
                        let mut configuration = profile::configuration(
                            &command,
                            &cwd,
                            mcp,
                            Some(runner.clone()),
                            model_provider,
                            standalone,
                            this.0.permission_profiles,
                            environment.as_deref(),
                        )
                        .await?;
                        this.assert_bound(&bound)?;
                        if let Some(saved) = &held {
                            configuration.expected_suspension =
                                Some(saved.evidence["suspension"].clone());
                        } else {
                            configuration.expected_suspension = native_stop;
                        }
                        let delivery = this.0.codex.project_goals().filter(|_| {
                            !staged && !standalone && held.is_none() && !task_restoration
                        });
                        let task = command["taskOwned"] == true;
                        let latch = task.then(|| this.task_latch(&bound, &chat)).transpose()?;
                        let chat_pause = !task && !staged && this.chat_paused(&bound, &chat);
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
                            runtime
                                .admission()
                                .set_chat_paused(&chat, latch.current().blocked)?;
                            if let Some(thread) = &selection.thread_id {
                                router.set_task_root(thread, Some(task_root(thread, latch)));
                            }
                        } else if chat_pause {
                            runtime.admission().set_chat_paused(&chat, true)?;
                        }
                        if task
                            && let (Some(delivery), Some(thread)) =
                                (delivery, selection.thread_id.as_ref())
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
                            let loaded = if let Some(HandoffStage::Destination {
                                transfer: Some(transfer),
                                ..
                            }) = &stage
                            {
                                native::load_import(
                                    &runtime,
                                    &selection,
                                    &configuration,
                                    &identify,
                                    transfer,
                                )
                                .await?
                            } else {
                                native::load(&runtime, &selection, &configuration, &identify)
                                    .await?
                            };
                            router.bind_resource(loaded.id(), &resource);
                            resource.signal.check()?;
                            native::configure(&runtime, &loaded, selection.intent, &configuration)
                                .await?;
                            loaded
                        };
                        if selection.intent == Intent::Configure || change_plan {
                            profile::apply_plan_mode(
                                &runtime,
                                &loaded,
                                &command["planMode"],
                                &command["model"],
                            )
                            .await?;
                        }
                        if let Some(message) = first_message {
                            runtime.inference_router().reserve_task_first_input(
                                loaded.id().clone(),
                                runner.clone(),
                                message.clone(),
                            );
                        }
                        // Council's shared default applies between turns while the
                        // existing native thread retains its history.
                        let council_turn = session["council"] == true
                            && command["type"] == "chat.turn"
                            && held.is_none()
                            && !stopping;
                        if council_turn
                            || first_message.is_some()
                            || command["taskGoalPermissions"] == true
                        {
                            profile::apply_execution_permissions(
                                &runtime,
                                &loaded,
                                &command,
                                this.0.permission_profiles,
                            )
                            .await?;
                        }
                        loaded.assert_current(&runtime)?;
                        this.assert_bound(&bound)?;
                        let thread_id = loaded.id().clone();
                        if !stopping {
                            runtime.bind_model_attribution(
                            &thread_id,
                            &command["model"],
                            &command["subagentDefaults"]["model"],
                            json!({
                                "workerId":this.0.worker, "providerId":command["provider"]["id"],
                                "providerAccountId":command["provider"]["accountId"],
                            }),
                        );
                        }
                        let mut result = Prepared {
                            runtime: runtime.clone(),
                            thread: loaded.clone(),
                            codex_home,
                            runner_generation: runner.clone(),
                            saved: held,
                            environment,
                            admission: admission.clone(),
                            bound: bound.clone(),
                            queue: None,
                            permission: Arc::new(Mutex::new(
                                command["permissionProfileId"].clone(),
                            )),
                        };
                        if !staged {
                            let mut owners = this.0.live_threads.lock().unwrap();
                            resource.signal.check()?;
                            if !task {
                                let paused = this.chat_paused(&bound, &chat);
                                if paused || chat_pause {
                                    runtime.admission().set_chat_paused(&chat, paused)?;
                                }
                            }
                            if let Some(delivery) = delivery {
                                delivery.select(
                                    &bound,
                                    &thread_id,
                                    runtime.generation(),
                                    &chat,
                                    task,
                                );
                            }
                            let native_session = native_session(&command, &runtime, loaded.id());
                            let goal_session = (!task).then(|| native_session.clone());
                            let queue = if !task
                                && !stopping
                                && result.saved.is_none()
                                && !task_restoration
                                && let Some(factory) = this.0.queue_imports.get()
                            {
                                let previous =
                                    owners.get(&chat).and_then(|owner| owner.queue.as_ref());
                                Some(factory.bind(&result, &command, previous)?)
                            } else {
                                None
                            };
                            result.queue = queue.as_ref().map(|binding| binding.import.clone());
                            let settings = if !task
                                && !stopping
                                && result.saved.is_none()
                                && !task_restoration
                                && let Some(factory) = this.0.settings_publisher.get()
                            {
                                let previous =
                                    owners.get(&chat).and_then(|owner| owner.settings.as_ref());
                                Some(factory.bind(
                                    &this.0.worker,
                                    &result,
                                    &native_session,
                                    &command,
                                    previous,
                                )?)
                            } else {
                                None
                            };
                            if let Some(settings) = &settings {
                                result.permission = settings.source.permission_state();
                            }
                            if let (Some(autonomous), Some(session)) =
                                (this.0.autonomous.get(), goal_session.as_ref())
                                && context_kind == "project"
                                && result.saved.is_none()
                            {
                                let broker = Arc::downgrade(&this.0);
                                let authority = bound.clone();
                                let admission = admission.clone();
                                let thread = thread_id.clone();
                                let activate = Arc::new(move |lane: &Value| {
                                    broker
                                        .upgrade()
                                        .context("The managed MCP broker has closed.")?
                                        .activate(
                                            &authority,
                                            Some(&thread),
                                            admission.as_ref(),
                                            lane,
                                        )
                                });
                                runtime.inference_router().register_goal_producer(
                                    thread_id.clone(),
                                    runner.clone(),
                                    Arc::new(autonomous.producer(Runner {
                                        runtime: runtime.downgrade(),
                                        thread: loaded.clone(),
                                        session: session.clone(),
                                        bound: bound.clone(),
                                        cwd: cwd.clone(),
                                        environment: result.environment.clone(),
                                        model: command["model"].clone(),
                                        provider: command["provider"].clone(),
                                        permission: result.permission.clone(),
                                        activate,
                                    })),
                                );
                            } else {
                                runtime.inference_router().remove_goal_producer(&thread_id);
                            }
                            let task = latch.as_ref().map(|latch| task_root(&thread_id, latch));
                            router.set_task_root(&thread_id, task.clone());
                            let task_settings = if task.is_some()
                                && !stopping
                                && let Some(factory) = this.0.settings_publisher.get()
                            {
                                Some(factory.source(
                                    &this.0.worker,
                                    &result,
                                    &native_session,
                                    &command,
                                    resource.signal.clone(),
                                )?)
                            } else {
                                None
                            };
                            let external_changes = if context_kind == "project" && task.is_none() {
                                owners
                                    .get_mut(&chat)
                                    .filter(|owner| owner.bound == bound && owner.thread == loaded)
                                    .and_then(|owner| owner.external_changes.take())
                            } else {
                                None
                            };
                            let owner = ThreadOwner {
                                runtime: runtime.downgrade(),
                                thread: loaded.clone(),
                                bound: bound.clone(),
                                runner_base,
                                runner,
                                session: goal_session,
                                task,
                                task_settings,
                                queue,
                                settings,
                                external_changes,
                                model_route: command["model"]["routeId"].clone(),
                                provider_id: command["provider"]["id"].clone(),
                                provider_account: command["provider"]["accountId"].clone(),
                                environment_id: result
                                    .environment
                                    .as_ref()
                                    .map(|guest| guest.id.clone()),
                            };
                            owners.insert(chat.clone(), owner);
                        }
                        if let Some(latch) = latch
                            && !staged
                            && !task_restoration
                        {
                            this.sync_task_pause(&bound, &chat, &latch).await?;
                        }
                        *prepared.lock().unwrap() = Some(result);
                        Ok(thread_id)
                    })
                }
            }),
        };
        if staged {
            (input.prepare)(
                super::Selection {
                    thread_id: input.target.thread_id,
                    intent,
                    replacement_settings: None,
                },
                Arc::new(|_| Box::pin(async { Ok(()) })),
            )
            .await?;
        } else {
            self.0.preparation.prepare(input).await?;
        }
        retained_resource.signal.check()?;
        self.assert_bound(&bound)?;
        let result = prepared
            .lock()
            .unwrap()
            .take()
            .context("Managed thread ownership was lost.")?;
        // An already bound thread may have persisted queue entries without
        // emitting a new event on this transport (for example after restart).
        if incoming["threadId"].as_js_string() == Some(result.thread.id())
            && let Some(import) = &result.queue
        {
            import.reconcile_on_prepare();
        }
        Ok(result)
    }

    async fn open_held(
        &self,
        command: &Value,
        expected: &Value,
        placement: &str,
    ) -> Result<Opened> {
        let session = &command["session"];
        let mut source = json!({
            "chatId":session["chatId"],"threadId":command["threadId"],
            "contextKind":session["contextKind"],"projectId":session["projectId"],
            "placementId":session[placement],"modelRouteId":command["model"]["routeId"],
            "providerAccountId":command["provider"]["accountId"],
        });
        if let Some(previous) = session.get("councilProviderCheckpointSource") {
            ensure!(
                session["council"] == true,
                "Only Council can restore a provider checkpoint."
            );
            source["modelRouteId"] = previous["modelRouteId"].clone();
            source["providerAccountId"] = previous["providerAccountId"].clone();
        }
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
            prepared.environment.is_none().then(|| prepared.thread.id()),
            prepared.admission.as_ref(),
            lane,
        )
    }

    pub(in crate::codex) fn cycle_activation(&self, prepared: &Prepared) -> Activate {
        let ensurer = Arc::downgrade(&self.0);
        let identity = prepared.bound.clone();
        let thread = prepared
            .environment
            .is_none()
            .then(|| prepared.thread.id().clone());
        let admission = prepared.admission.clone();
        Arc::new(move |lane| {
            ensurer
                .upgrade()
                .context("The managed MCP broker has closed.")?
                .activate(&identity, thread.as_ref(), admission.as_ref(), lane)
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

    pub(in crate::codex) fn selected_live_owner(
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

    /// Revert and interruption can close a managed gate without changing the
    /// thread ID. The next preparation installs a fresh gate for that owner.
    pub(in crate::codex) fn renew_runner_on_next_prepare(
        &self,
        chat: &JsString,
        bound: &(JsString, Value),
        runtime: &Runtime,
        thread: &JsString,
    ) {
        let mut owners = self.0.live_threads.lock().unwrap();
        if let Some(owner) = owners.get_mut(chat)
            && &owner.bound == bound
            && owner.thread.id() == thread
            && owner.thread.assert_current(runtime).is_ok()
            && owner.task.is_none()
        {
            owner.runner = uuid::Uuid::new_v4().to_string().into();
        }
    }

    pub(in crate::codex) fn assert_console(
        &self,
        chat: &JsString,
        prepared: &Prepared,
    ) -> Result<()> {
        self.assert_bound(&prepared.bound)?;
        prepared.thread.assert_current(&prepared.runtime)?;
        let selected = self.live_thread(chat, prepared.thread.id(), &prepared.bound);
        if selected
            .is_none_or(|selected| selected.runtime.generation() != prepared.runtime.generation())
        {
            bail!("The managed console belongs to a replaced native runtime.");
        }
        Ok(())
    }

    pub(in crate::codex) fn watch_external_changes(
        &self,
        chat: &JsString,
        prepared: &Prepared,
        start: impl FnOnce() -> Result<Observation>,
    ) -> Result<()> {
        self.assert_bound(&prepared.bound)?;
        let mut owners = self.0.live_threads.lock().unwrap();
        let owner = owners.get_mut(chat).filter(|owner| {
            owner.task.is_none()
                && owner.bound == prepared.bound
                && owner.thread == prepared.thread
                && owner
                    .session
                    .as_ref()
                    .is_some_and(|session| session["contextKind"] == "project")
        });
        if let Some(owner) = owner
            && owner.external_changes.is_none()
        {
            prepared.thread.assert_current(&prepared.runtime)?;
            owner.external_changes = Some(start()?);
        }
        Ok(())
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
        let mut mcp = json!({});
        if let Some(codegraph) = self.0.codegraph.agent_mcp(&self.0.data, &cwd, None).await {
            mcp["codegraph"] = codegraph;
        }
        let mut configuration = profile::configuration(
            command,
            &cwd,
            mcp,
            Some(runtime.generation().into()),
            model_provider,
            false,
            self.0.permission_profiles,
            None,
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
        let provider = open_runtime_provider(&self.0.encryption, &job["provider"])?;
        // Separate label inference uses the naming provider's local profile.
        // The label operation retains Chat authorization and result binding.
        self.helper_runtime(&job["model"], provider, bound).await
    }

    pub(in crate::codex) async fn helper_runtime(
        &self,
        model: &Value,
        provider: Value,
        bound: &(JsString, Value),
    ) -> Result<Runtime> {
        self.inspection_runtime(model, provider, bound, None, None)
            .await
            .map(|(runtime, _)| runtime)
    }

    pub(in crate::codex) fn customization_compatibility(&self) -> &Value {
        self.0.codex.compatibility()
    }

    pub(in crate::codex) async fn inspection_runtime(
        &self,
        model: &Value,
        provider: Value,
        bound: &(JsString, Value),
        workspace: Option<(&Value, &JsString)>,
        thread: Option<&JsString>,
    ) -> Result<(Runtime, Option<Arc<Environment>>)> {
        self.assert_bound(bound)?;
        let chat = workspace.and_then(|(scope, _)| scope["chatId"].as_js_string());
        let owner = &bound.0;
        let server = bound
            .1
            .as_js_string()
            .context("Unverified worker server identity")?;
        let scope = json!({"serverId":server,"ownerId":owner,"workerId":self.0.worker});
        let environment = if let (Some((customization, cwd)), Some(chat)) = (workspace, chat) {
            Environment::reopen(
                &self.0.data,
                &scope,
                chat,
                cwd,
                None,
                Some(&customization["projectId"]),
            )
            .await?
            .map(Arc::new)
        } else {
            None
        };
        self.assert_bound(bound)?;
        if let (Some(chat), Some(thread)) = (chat, thread) {
            let owners = self.0.live_threads.lock().unwrap();
            if let Some(live) = owners.get(chat)
                && live.bound == *bound
                && live.thread.id() == thread
                && live.provider_id == provider["id"]
                && live.provider_account == provider["accountId"]
                && live.environment_id.as_deref()
                    == environment.as_ref().map(|guest| guest.id.as_str())
                && let Some(runtime) = live.runtime.upgrade()
                && live.thread.assert_current(&runtime).is_ok()
            {
                return Ok((runtime, environment));
            }
        }
        let profile = home::profile(
            &self.0.data,
            &scope,
            home::Source::Current(thread),
            chat,
            &provider,
            "ide",
            self.0.skills.clone(),
            environment.as_deref(),
        )
        .await?;
        self.assert_bound(bound)?;
        let mut launch = provider::launch(
            profile,
            provider,
            self.0.access.clone(),
            model,
            &Value::Null,
        )?;
        if let Some(environment) = &environment {
            environment.configure_launch(&mut launch);
        }
        let runtime = self
            .0
            .codex
            .launch_in_scope(launch, Some((server.clone(), owner.clone())))
            .await?;
        runtime.synchronize_models(model, &Value::Null).await?;
        self.assert_bound(bound)?;
        Ok((runtime, environment))
    }

    pub(in crate::codex) async fn repository_draft_mcp(&self, command: &Value) -> Result<Value> {
        let servers = open_mcp_servers(
            &self.0.encryption,
            command["mcpServers"]
                .as_array()
                .context("Managed MCP configurations")?,
        )?;
        let mut mcp = profile::external_servers(servers, false)?;
        let admitted = json!({"projectId":command["projectId"],"worktreeId":command["worktreeId"],"rootKind":"git-worktree"});
        if let Some(codegraph) = self
            .0
            .codegraph
            .agent_mcp(&self.0.data, &field(command, "cwd")?, Some(&admitted))
            .await
        {
            mcp["codegraph"] = codegraph;
        }
        Ok(mcp)
    }

    pub(crate) async fn resolve_routing(&self, incoming: &Value) -> Result<Value> {
        self.0.routing.resolve(incoming).await
    }

    pub(crate) async fn search_council_history(&self, command: &Value) -> Result<Value> {
        self.broker().await?.search_council_history(command).await
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
                Broker::start_with_web(
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
                    Some(self.0.encryption.clone()),
                    Some(self.0.web.clone()),
                    Some(self.0.browser_surfaces.clone()),
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
        cli_thread: Option<&JsString>,
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
        if let Some(thread) = cli_thread {
            self.cli_contexts
                .bind(thread, identity, &admission["chatId"], lane);
        }
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
