//! Preparation for protected project repository operations. Content remains
//! opaque; only owned execution bindings and configured runtimes are resolved.
use super::targets::TargetRepository;
use crate::{
    chats::{Repository as ChatRepository, routing::ModelRouting},
    database::Database,
    settings::repository::SettingsRepository,
    wire::{Value, coercion::truthy, value::json},
    workers::bridge::WorkerBridge,
};
use anyhow::{Context, Result};
use std::sync::Arc;

pub fn publish(live: &crate::live::LiveService, owner: &str, project: &str, resource: &str) {
    if let Err(error) = live.publish_event(json!({"ownerId":owner,
        "scope":json!({"kind":"project","projectId":project}),"resource":resource,
        "action":"invalidated","entityId":Value::Null,"revision":Value::Null,"payload":Value::Null})) {
        use crate::operations::logging::{self, LogCall};
        (logging::server_logger())(LogCall::event("error", "Could not publish application live invalidation",
            json!({"err":json!({"message":error.to_string()}),"resource":resource})));
    }
}

#[derive(Debug)]
pub struct Rejection {
    pub status: u16,
    pub message: &'static str,
}
impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for Rejection {}
fn reject<T>(status: u16, message: &'static str) -> Result<T> {
    Err(Rejection { status, message }.into())
}

pub struct ExecutionContext {
    pub worker: String,
    context: Value,
    peer: Option<Value>,
    github: Option<Value>,
}
pub struct Prepared {
    pub worker: String,
    pub command: Value,
    pub agent_runtimes: Vec<Value>,
}

/// These lookups intentionally precede the route's worker-error boundary, as
/// they do in Source. Model preparation below belongs inside that boundary.
pub async fn context(
    database: Arc<Database>,
    bridge: &WorkerBridge,
    owner: &str,
    project: &str,
    worktree: &str,
    input: &Value,
) -> Result<ExecutionContext> {
    let repository = TargetRepository::new(database);
    let Some(context) = repository
        .worktree_context(owner, project, worktree)
        .await?
    else {
        return reject(404, "Worktree not found.");
    };
    let peer = if truthy(input.get("peerWorktreeId")) {
        let peer = repository
            .worktree_context(
                owner,
                project,
                input["peerWorktreeId"]
                    .as_str()
                    .context("Peer worktree identity")?,
            )
            .await?;
        if peer.is_none() {
            return reject(404, "Peer worktree not found.");
        }
        peer
    } else {
        None
    };
    if let Some(peer) = &peer
        && (peer["worktree"]["id"] == context["worktree"]["id"]
            || peer["projectSourceId"] != context["projectSourceId"]
            || peer["workerId"] != context["workerId"])
    {
        return reject(
            409,
            "Peer repository operations require two distinct worktrees from the same project source and worker.",
        );
    }
    let worker = context["workerId"]
        .as_str()
        .context("Project worker identity")?
        .to_owned();
    if !bridge.is_connected(&worker) {
        return reject(503, "Project worker is offline.");
    }
    let github = repository
        .github_context(owner, project, Some(&worker))
        .await?;
    Ok(ExecutionContext {
        worker,
        context,
        peer,
        github,
    })
}

pub async fn prepare(
    database: Arc<Database>,
    routing: &ModelRouting,
    server: &str,
    owner: &str,
    binding: ExecutionContext,
    input: &Value,
) -> Result<Prepared> {
    let agent = truthy(input.get("agent"));
    let model = if agent {
        match input.get("modelId").filter(|value| !value.is_null()) {
            Some(model) => model.clone(),
            None => Value::from_serialize(
                &SettingsRepository::new(database.clone())
                    .get_user_settings(owner)
                    .await?["defaultModelId"],
            ),
        }
    } else {
        Value::Null
    };
    if agent && !truthy(Some(&model)) {
        return reject(
            409,
            "Choose a model or configure a default model before using repository agent assistance.",
        );
    }
    let runtimes = if truthy(Some(&model)) {
        routing
            .available_runtimes(
                owner,
                &binding.context,
                model.as_str().context("Repository agent model")?,
            )
            .await?
    } else {
        Vec::new()
    };
    let project = binding.context["projectId"]
        .as_str()
        .context("Project identity")?;
    let mcp = if agent {
        ChatRepository::new(database)
            .effective_mcp_servers(owner, Some(project), &binding.worker, "ide")
            .await?
    } else {
        Vec::new()
    };
    let peer = binding.peer.as_ref().map_or(
        Value::Null,
        |peer| json!({"id":peer["worktree"]["id"],"cwd":peer["worktree"]["path"]}),
    );
    let repository = binding
        .github
        .as_ref()
        .filter(|github| github["workerId"] == binding.worker.as_str())
        .map_or(Value::Null, |github| github["nameWithOwner"].clone());
    let mut command = json!({"type":"repository.operation","serverId":server,
        "projectId":project,"worktreeId":binding.context["worktree"]["id"],
        "cwd":binding.context["worktree"]["path"],"peerWorktree":peer,
        "sourcePath":binding.context["sourcePath"],"repository":repository});
    for (key, value) in input
        .as_object()
        .context("Validated repository operation")?
        .iter()
    {
        // Source overwrites modelId after spreading the validated request and
        // omits it entirely for non-agent operations.
        if key.as_str() != Some("modelId") {
            command[key.as_str().context("Validated request field name")?] = value.clone();
        }
    }
    if !model.is_null() {
        command["modelId"] = model;
    }
    command["agentRuntimes"] = Value::Array(runtimes.iter().map(|runtime|
        json!({"routeId":runtime["routeId"],"model":runtime["model"],"provider":runtime["provider"]})).collect());
    command["mcpServers"] = Value::Array(mcp);
    command["routingPurpose"] = json!("repository");
    Ok(Prepared {
        worker: binding.worker,
        command,
        agent_runtimes: runtimes,
    })
}
