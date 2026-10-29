//! One exact console launch path: resolve, ensure, then bind before spawning.
use super::{Repository, RuntimeUpdate, routing::ModelRouting};
use crate::{
    database::Database,
    wire::{Value, coercion::truthy, value::json},
    workers::command_bus::{LimitedCommandBus, RequestTimeout},
};
use anyhow::{Context, Result, bail};
use futures::future::BoxFuture;
use std::sync::Arc;

pub type EnsureRequest =
    Arc<dyn Fn(String, String, Value) -> BoxFuture<'static, Result<Option<Value>>> + Send + Sync>;
pub struct ManagedConsole {
    repository: Repository,
    routing: Arc<ModelRouting>,
    request: EnsureRequest,
}
fn selected<'a>(value: Option<&'a Value>, fallback: &'a Value) -> &'a Value {
    value.filter(|v| !v.is_null()).unwrap_or(fallback)
}
pub fn permission_profile(context: &Value) -> Value {
    let default = selected(
        context.get("defaultPermissionProfileId"),
        &json!(":workspace"),
    )
    .clone();
    let policy = context
        .get("nativePermissionPolicy")
        .filter(|v| !v.is_null());
    let selected_id = selected(
        policy.and_then(|v| v.get("resolvedSelectedId")),
        selected(context.get("permissionProfileId"), &default),
    );
    let forced =
        truthy(context.get("isPrimary")) && context["worktreePolicy"] == "required-for-writes";
    let effective = if forced {
        json!(":read-only")
    } else {
        selected(policy.and_then(|v| v.get("effectiveId")), selected_id).clone()
    };
    let uses_default = if truthy(policy) {
        policy.unwrap().get("selectedId") == Some(&Value::Null)
    } else {
        context.get("permissionProfileId") == Some(&Value::Null)
    };
    json!({"selectedId":selected_id,"effectiveId":effective,"defaultId":default,"usesDefault":uses_default,"forcedByWorktreePolicy":forced})
}
pub fn session_context(context: &Value) -> Option<Value> {
    (context["experience"]=="agent" && context["contextKind"]=="project").then(||json!({
        "chatId":context["chatId"],"computerUseEnabled":context["computerUseEnabled"]==true,
        "contextKind":"project","projectId":context["projectId"],"worktreeId":context["worktreeId"],"rootKind":context["rootKind"],"scratchRootId":Value::Null
    }))
}
fn text(value: &Value, key: &str) -> Result<String> {
    Ok(value[key]
        .as_js_string()
        .context("Managed console text")?
        .lossy()
        .into_owned())
}
impl ManagedConsole {
    pub fn new(
        database: Arc<Database>,
        routing: Arc<ModelRouting>,
        commands: Arc<LimitedCommandBus>,
    ) -> Arc<Self> {
        Self::with_request(
            database,
            routing,
            Arc::new(move |_owner, worker, command| {
                let commands = commands.clone();
                Box::pin(async move {
                    Ok(commands
                        .request_with_timeout(&worker, command, RequestTimeout::Disabled, None)
                        .await?)
                })
            }),
        )
    }
    pub fn with_request(
        database: Arc<Database>,
        routing: Arc<ModelRouting>,
        request: EnsureRequest,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository: Repository::new(database),
            routing,
            request,
        })
    }
    pub async fn prepare_launch(
        &self,
        owner: &str,
        context: &Value,
        runtime: &Value,
    ) -> Result<Value> {
        if context["contextKind"] == "standalone" {
            bail!("Standalone Chats do not support linked Codex consoles.");
        }
        let mut configuration = context["modelConfiguration"].clone();
        configuration["modelId"] = runtime["model"]["id"].clone();
        configuration["reasoningEffort"] = context["reasoningEffort"].clone();
        let configuration =
            crate::settings::parse_response("modelConfigurationSchema", Some(&configuration))?;
        let pairs = self
            .routing
            .route_pairs(
                owner,
                context,
                &configuration,
                Some(std::slice::from_ref(runtime)),
            )
            .await?;
        let pair = pairs
            .first()
            .context("No provider route is currently available.")?;
        let root = &pair["root"]["runtime"];
        let child = &pair["subagent"]["runtime"];
        let subagent = if truthy(Some(child)) {
            json!({"model":child["model"],"provider":child["provider"]})
        } else {
            Value::Null
        };
        let worker = text(context, "workerId")?;
        let mcp = self
            .repository
            .effective_mcp_servers(owner, context["projectId"].as_str(), &worker, "ide")
            .await?;
        let mut fields = json!({"model":root["model"],"provider":root["provider"],"subagentDefaults":subagent,"planMode":context["planMode"],"permissionProfileId":permission_profile(context)["effectiveId"],"mcpServers":mcp});
        if let Some(session) = session_context(context) {
            fields["session"] = session;
        }
        let mut thread = context["threadId"].clone();
        if !truthy(Some(&thread)) {
            let mut command = fields.clone();
            command["type"] = json!("chat.thread.ensure");
            command["cwd"] = context["cwd"].clone();
            command["threadId"] = Value::Null;
            let result = (self.request)(owner.to_owned(), worker.clone(), command).await?;
            let returned = super::context::property(result.as_ref(), "threadId")?;
            if returned
                .and_then(Value::as_js_string)
                .is_none_or(|v| v.is_empty())
            {
                bail!("Codex did not return a console thread.");
            }
            thread = returned.unwrap().clone();
            let chat = text(context, "chatId")?;
            self.repository
                .select_model(owner, &chat, &text(&root["model"], "id")?, None)
                .await?;
            // Keep the two source transactions distinct. A canonical binding
            // failure must prevent terminal.open after model selection commits.
            self.repository
                .update_runtime(RuntimeUpdate {
                    chat,
                    worker: worker.clone(),
                    worktree: context["worktreeId"].as_str().map(str::to_owned),
                    thread: thread
                        .as_js_string()
                        .map(|value| value.lossy().into_owned()),
                    route: text(root, "routeId")?,
                    status: "ready".into(),
                    provider_account: root["provider"]
                        .get("accountId")
                        .map(|v| v.as_str().map(str::to_owned)),
                    scratch_root: None,
                })
                .await?;
        }
        fields["type"] = json!("codex");
        fields["threadId"] = thread;
        Ok(fields)
    }
}
