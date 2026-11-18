//! Read the native thread under the existing worker's storage and provider route.
mod home;
mod provider;

use super::{
    catalog::auth::Auth,
    managed::{Launch, Worker},
    private_inference::{Context, Hooks},
};
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
        let (owner, server) = self.encryption.bound_identity()?;
        let command = self.routing.resolve(command).await?;
        let thread = field(&command, "threadId")?;
        let chat = field(&command, "chatId")?;
        let provider = open_runtime_provider(&self.encryption, &command["provider"])?;
        let scope = json!({"serverId":server,"ownerId":owner,"workerId":self.worker});
        let execution = command["executionProfile"].as_str().unwrap_or("ide");
        let mut profile = home::profile(
            &self.data,
            &scope,
            thread,
            chat,
            &provider,
            execution,
            self.skill_root.clone(),
        )
        .await?;
        let portable = provider::configure(&mut profile, &provider)?;
        let server_id = server.as_js_string().cloned().ok_or_else(|| {
            anyhow!("Worker encryption has not verified the logical server identity.")
        })?;
        let runtime = self
            .codex
            .launch_in_scope(
                Launch {
                    profile,
                    private_inference: Hooks {
                        overlay: Arc::new(|_| Context::default()),
                        provider: Arc::new(move || Some(provider.clone())),
                        before_inference: None,
                    },
                    on_revoked: None,
                    prepare_home: None,
                    external_auth: portable
                        .map(|account| Arc::new(Auth::new(account, self.access.clone())) as _),
                    observe: Arc::new(|_| Ok(())),
                },
                Some((server_id, owner.clone())),
            )
            .await?;
        let snapshot = runtime.read_history(thread).await?;
        if self.encryption.bound_identity()? != (owner, server) {
            bail!("The worker binding changed during native observation.");
        }
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
