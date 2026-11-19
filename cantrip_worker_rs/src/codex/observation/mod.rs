//! Read the native thread under the existing worker's storage and provider route.
pub(super) mod home;
pub(super) mod provider;
pub(crate) use provider::normalize_base_url;

use super::managed::{Runtime, Worker};
use crate::{
    encryption::Service, http::checked, protected_secrets::open_runtime_provider,
    provider_access::Access, routing::Registry,
};
use anyhow::{Result, anyhow, bail};
use cantrip_wire::{JsString, Value, value::json};
use std::{path::PathBuf, sync::Arc};

#[derive(Clone)]
pub(crate) struct Observer {
    codex: Worker,
    access: Access,
    encryption: Arc<Service>,
    routing: Arc<Registry>,
    data: PathBuf,
    skill_root: Option<PathBuf>,
    worker: JsString,
}

impl Observer {
    pub(crate) fn new(
        codex: Worker,
        access: Access,
        encryption: Arc<Service>,
        routing: Arc<Registry>,
        data: PathBuf,
        skill_root: Option<PathBuf>,
        worker: JsString,
    ) -> Self {
        Self {
            codex,
            access,
            encryption,
            routing,
            data,
            skill_root,
            worker,
        }
    }

    pub(crate) async fn sync(&self, command: &Value) -> Result<Value> {
        let binding = self.encryption.bound_identity()?;
        let thread = field(command, "threadId")?;
        let runtime = self.open_runtime(command, &binding).await?;
        let snapshot = runtime.read_history(thread).await?;
        self.assert_bound(&binding)?;
        let status = status(&snapshot["thread"]);
        // A cold observer has no attached external-console baseline. Never
        // re-emit native messages already owned by history or import.
        checked(
            "agentThreadSyncSchema",
            &json!({
                "threadId":thread,"status":status,"statusSource":"native-thread","turns":Vec::<Value>::new()
            }),
        )
    }

    /// Start the selected storage transport without loading or changing a conversation.
    pub(super) async fn open_runtime(
        &self,
        command: &Value,
        binding: &(JsString, Value),
    ) -> Result<Runtime> {
        field(command, "threadId")?;
        Ok(self.open_target(command, binding).await?.0)
    }

    pub(super) async fn open_target(
        &self,
        command: &Value,
        binding: &(JsString, Value),
    ) -> Result<(Runtime, &'static str)> {
        self.assert_bound(binding)?;
        let (owner, server) = binding;
        let command = self.routing.resolve(command).await?;
        let chat = field(&command, "chatId")?;
        let provider = open_runtime_provider(&self.encryption, &command["provider"])?;
        let model_provider = provider::model_provider(&provider);
        let scope = json!({"serverId":server,"ownerId":owner,"workerId":self.worker});
        let execution = command["executionProfile"].as_str().unwrap_or_else(|| {
            if command["session"]["contextKind"] == "standalone" {
                "standalone-chat"
            } else {
                "ide"
            }
        });
        let profile = home::profile(
            &self.data,
            &scope,
            home::Source::Current(command["threadId"].as_js_string()),
            chat,
            &provider,
            execution,
            self.skill_root.clone(),
            None,
        )
        .await?;
        let server_id = server.as_js_string().cloned().ok_or_else(|| {
            anyhow!("Worker encryption has not verified the logical server identity.")
        })?;
        let runtime = self
            .codex
            .launch_in_scope(
                provider::launch(profile, provider, self.access.clone())?,
                Some((server_id, owner.clone())),
            )
            .await?;
        self.assert_bound(binding)?;
        Ok((runtime, model_provider))
    }

    fn assert_bound(&self, binding: &(JsString, Value)) -> Result<()> {
        if &self.encryption.bound_identity()? != binding {
            bail!("The worker binding changed during native observation.");
        }
        Ok(())
    }
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a JsString> {
    value[key]
        .as_js_string()
        .ok_or_else(|| anyhow!("Missing {key} in native observation."))
}

fn status(thread: &Value) -> &'static str {
    match thread["status"]["type"].as_str() {
        Some("active") => "running",
        Some("systemError") => "failed",
        _ if thread["turns"]
            .as_array()
            .and_then(|turns| turns.last())
            .is_some_and(|turn| turn["status"] == "failed") =>
        {
            "failed"
        }
        _ => "idle",
    }
}
