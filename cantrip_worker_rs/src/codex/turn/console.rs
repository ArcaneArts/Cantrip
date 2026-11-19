//! The managed TUI runs on the worker and attaches to Core's prepared thread.
//! Its sandbox, working directory and model execution remain app-server owned.
mod gateway;
mod prompt;
mod queue;
pub(crate) use gateway::Gateway;
pub(super) use queue::Views as QueueViews;

use super::{Key, Scope, Turns, id};
use crate::{
    codex::{
        managed::Profile,
        observation::provider,
        preparation::{
            Intent,
            command::{COMMAND, Prepared, native_session},
        },
    },
    protected_secrets::open_runtime_provider,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use std::{collections::HashMap, path::PathBuf, sync::Arc};

pub(crate) struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub environment: HashMap<String, String>,
    pub gateway: Gateway,
}

struct View {
    turns: Turns,
    prepared: Prepared,
    session: Value,
    chat: JsString,
    cwd: JsString,
    local_directory: PathBuf,
    permission: Value,
    command: Value,
    queue_key: Key,
    queue_state: Arc<queue::State>,
}

impl View {
    fn assert_current(&self) -> Result<()> {
        self.turns
            .preparation
            .assert_console(&self.chat, &self.prepared)
    }
}

impl Turns {
    pub(crate) async fn launch_console(
        &self,
        binary: PathBuf,
        mut command: Value,
        cwd: JsString,
        mut environment: HashMap<String, String>,
    ) -> Result<Launch> {
        let thread = id(&command["threadId"], "managed console thread")?;
        let chat = id(&command["session"]["chatId"], "managed console chat")?;
        command["type"] = json!(COMMAND);
        command["cwd"] = json!(cwd);
        for (key, default) in [
            ("planMode", json!("default")),
            ("permissionProfileId", json!(":workspace")),
            ("mcpServers", json!(Vec::<Value>::new())),
        ] {
            if command.get(key).is_none() {
                command[key] = default;
            }
        }
        let provider = open_runtime_provider(&self.encryption, &command["provider"])?;
        let prepared = self.preparation.prepare(&command, Intent::Preserve).await?;
        ensure!(
            prepared.thread.id() == &thread,
            "The managed console thread changed."
        );
        let session = native_session(&command, &prepared.runtime, &thread);

        let placement = cwd.clone();
        let cwd = if prepared.environment.is_some() {
            prepared.codex_home.clone()
        } else {
            crate::filesystem::paths::native(&cwd)
        };
        let codex_home = prepared
            .codex_home
            .to_str()
            .context("Managed console home must be Unicode.")?;
        environment.retain(|key, _| {
            !["CODEX_HOME", "CANTRIP_CODEX_ATTACH_THREAD_ID"]
                .iter()
                .any(|name| {
                    if cfg!(windows) {
                        key.eq_ignore_ascii_case(name)
                    } else {
                        key == name
                    }
                })
        });
        environment.insert("CODEX_HOME".into(), codex_home.into());
        environment.insert(
            "CANTRIP_CODEX_ATTACH_THREAD_ID".into(),
            thread.lossy().into_owned(),
        );

        let mut profile = Profile::new("console".into(), prepared.codex_home.clone());
        // Account authentication belongs to the running app-server. The TUI
        // needs only its local provider bootstrap configuration.
        provider::configure(&mut profile, &provider, false)?;
        environment.extend(profile.provider_environment);
        let queue_key = (
            prepared.bound.0.clone(),
            id(&prepared.bound.1, "managed console logical server")?,
            chat.clone(),
        );
        let queue_state = self.console_queues.watch(queue_key.clone());
        let view = Arc::new(View {
            turns: self.clone(),
            prepared,
            session,
            chat,
            cwd: placement,
            local_directory: cwd.clone(),
            permission: command["permissionProfileId"].clone(),
            command,
            queue_key,
            queue_state,
        });
        let gateway = Gateway::start(view).await?;
        let mut args = vec!["--remote".into(), gateway.url.clone()];
        for argument in profile.provider_arguments {
            args.extend(["-c".into(), argument]);
        }
        args.extend(["resume".into(), thread.lossy().into_owned()]);
        Ok(Launch {
            program: binary,
            args,
            cwd,
            environment,
            gateway,
        })
    }
}
