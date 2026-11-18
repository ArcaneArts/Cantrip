//! Worker command preparation joins authenticated scope, the durable association,
//! and the native thread. It also installs the idle MCP attachment.
mod profile;

use super::{Coordinator, Identity, Input, Intent, Target, native};
use crate::{
    codex::{
        managed::{Runtime, Worker},
        observation::{home, provider},
    },
    config::Config,
    encryption::Service,
    http::checked,
    mcp::bindings::{Activation, Broker, Server},
    protected_secrets::{open_mcp_servers, open_runtime_provider},
    provider_access::Access,
    routing::Registry,
};
use anyhow::{Context, Result, bail};
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use std::{
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
    admission: Option<Value>,
    bound: (JsString, Value),
}

#[derive(Clone)]
pub(crate) struct Ensurer(Arc<Inner>);

struct Inner {
    codex: Worker,
    access: Access,
    settings: Arc<Mutex<Config>>,
    encryption: Arc<Service>,
    routing: Arc<Registry>,
    data: PathBuf,
    skills: Option<PathBuf>,
    worker: JsString,
    preparation: Coordinator,
    broker: OnceCell<Broker>,
    permission_profiles: bool,
}

impl Ensurer {
    pub(crate) fn new(
        codex: Worker,
        access: Access,
        settings: Arc<Mutex<Config>>,
        encryption: Arc<Service>,
        routing: Arc<Registry>,
        skills: Option<PathBuf>,
        codex_compatibility: &Value,
    ) -> Self {
        let (data, worker) = {
            let config = settings.lock().unwrap();
            (config.data_directory.clone(), config.worker_id.clone())
        };
        let preparation = Coordinator::new(&data);
        let permission_profiles = codex_compatibility["initialize"]["experimentalApi"] == true
            && codex_compatibility["methods"]["permissionProfile/list"] == "available";
        Self(Arc::new(Inner {
            codex,
            access,
            settings,
            encryption,
            routing,
            data,
            skills,
            worker,
            preparation,
            broker: OnceCell::new(),
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

    pub(crate) async fn prepare(&self, incoming: &Value, intent: Intent) -> Result<Prepared> {
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
        if session.get("osExecution").is_some() || session.get("heldSuspension").is_some() {
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
        let identity = Identity {
            server_id: logical_server.clone(),
            owner_id: owner.clone(),
            worker_id: self.0.worker.clone(),
            chat_id: chat.clone(),
            placement_id: field(session, placement)?,
            project_id: session["projectId"].as_js_string().cloned(),
            context_kind,
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
                    let profile = home::profile(
                        &this.0.data, &scope, selection.thread_id.as_ref(), &chat,
                        &provider, execution, this.0.skills.clone(),
                    ).await?;
                    this.assert_bound(&bound)?;
                    let codex_home = profile.codex_home.clone();
                    let model_provider = provider::model_provider(&provider);
                    let runtime = this.0.codex.launch_in_scope(
                        provider::launch(profile, provider, this.0.access.clone())?,
                        Some((logical_server, bound.0.clone())),
                    ).await?;
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
                            "allowedOperations": vec!["context.get", "tool.help"],
                        });
                        let attachment = broker.prepare(admission.clone(), legacy_root).await?;
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
                    let configuration = profile::configuration(
                        &command, &cwd, mcp, runner.clone(), model_provider, standalone,
                        this.0.permission_profiles,
                    ).await?;
                    this.assert_bound(&bound)?;
                    let loaded = native::load(&runtime, &selection, &configuration, &identify).await?;
                    native::configure(&runtime, &loaded, selection.intent, &configuration).await?;
                    if selection.intent == Intent::Configure {
                        profile::apply_plan_mode(&runtime, &loaded, &command).await?;
                    }
                    if let Some(message) = first_message {
                        runtime.inference_router().reserve_task_first_input(loaded.id().clone(), runner.clone(), message.clone());
                        profile::apply_goal_permissions(&runtime, &loaded, &command, this.0.permission_profiles).await?;
                    }
                    loaded.assert_current(&runtime)?;
                    this.assert_bound(&bound)?;
                    let thread_id = loaded.id().clone();
                    *prepared.lock().unwrap() = Some(Prepared { runtime, thread: loaded, codex_home, runner_generation: runner, admission, bound });
                    Ok(thread_id)
                })
            }),
        }).await?;
        self.assert_bound(&bound)?;
        let result = prepared
            .lock()
            .unwrap()
            .take()
            .context("Managed thread ownership was lost.")?;
        Ok(result)
    }

    pub(crate) fn activate(&self, prepared: &Prepared, lane: &Value) -> Result<Option<Activation>> {
        self.assert_bound(&prepared.bound)?;
        prepared.thread.assert_current(&prepared.runtime)?;
        self.0
            .activate(&prepared.bound, prepared.admission.as_ref(), lane)
    }

    pub(in crate::codex) fn cycle_activation(&self, prepared: &Prepared, lane: &Value) -> Activate {
        let ensurer = Arc::downgrade(&self.0);
        let identity = prepared.bound.clone();
        let admission = prepared.admission.clone();
        let lane = lane.clone();
        Arc::new(move || {
            ensurer
                .upgrade()
                .context("The managed MCP broker has closed.")?
                .activate(&identity, admission.as_ref(), &lane)
        })
    }

    pub(crate) fn identity(&self) -> Result<(JsString, Value)> {
        Ok(self.0.encryption.bound_identity()?)
    }

    pub(crate) fn supports_permission_profiles(&self) -> bool {
        self.0.permission_profiles
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
        self.broker
            .get()
            .context("Cantrip MCP attachment was not prepared.")?
            .activate(&admission)?
            .context("Cantrip MCP attachment no longer matches the admitted turn.")
            .map(Some)
    }
}
