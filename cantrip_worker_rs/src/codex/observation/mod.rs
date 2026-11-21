//! Read the native thread under the existing worker's storage and provider route.
pub(super) mod home;
pub(super) mod provider;
pub(crate) use provider::normalize_base_url;

use super::{
    guest_environment::Environment,
    managed::{Runtime, Worker},
    preparation::command::Ensurer,
};
use crate::{
    encryption::Service, http::checked, protected_secrets::open_runtime_provider,
    provider_access::Access, routing::Registry,
};
use anyhow::{Result, anyhow, bail, ensure};
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

    pub(crate) async fn sync(&self, command: &Value, preparation: &Ensurer) -> Result<Value> {
        let binding = self.encryption.bound_identity()?;
        let command = self.routing.resolve(command).await?;
        self.assert_bound(&binding)?;
        let thread = field(&command, "threadId")?;
        let chat = field(&command, "chatId")?;
        let runtime = match preparation.live_thread(chat, thread, &binding) {
            Some(live) => live.runtime,
            None => self.open_resolved(&command, &binding).await?.0,
        };
        let snapshot = runtime.read_history(thread).await?;
        self.assert_bound(&binding)?;
        let status = status(&snapshot["thread"]);
        // Managed history owns message publication. Sync projects native status.
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
        let command = self.routing.resolve(command).await?;
        self.open_resolved(&command, binding).await
    }

    async fn open_resolved(
        &self,
        command: &Value,
        binding: &(JsString, Value),
    ) -> Result<(Runtime, &'static str)> {
        let (owner, server) = binding;
        let chat = field(command, "chatId")?;
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
        let environment = if command["type"] == "chat.sync"
            || (command["type"] == super::goals::GET && command["taskContext"].is_null())
        {
            Environment::reopen(
                &self.data,
                &scope,
                chat,
                field(command, "cwd")?,
                command.get("osExecution"),
            )
            .await?
            .map(Arc::new)
        } else {
            None
        };
        ensure!(
            environment.is_none() || execution == "ide",
            "The captured Linux runtime belongs to a Project Chat."
        );
        let profile = home::profile(
            &self.data,
            &scope,
            home::Source::Current(command["threadId"].as_js_string()),
            Some(chat),
            &provider,
            execution,
            self.skill_root.clone(),
            environment.as_deref(),
        )
        .await?;
        let server_id = server.as_js_string().cloned().ok_or_else(|| {
            anyhow!("Worker encryption has not verified the logical server identity.")
        })?;
        let mut launch = provider::launch(
            profile,
            provider,
            self.access.clone(),
            &command["model"],
            &Value::Null,
        )?;
        if let Some(environment) = &environment {
            environment.configure_launch(&mut launch);
        }
        let runtime = self
            .codex
            .launch_in_scope(launch, Some((server_id, owner.clone())))
            .await?;
        runtime
            .synchronize_models(&command["model"], &Value::Null)
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
