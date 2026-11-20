use super::{Ensurer, field, home, native::LoadedThread, profile, provider};
use crate::{
    codex::{managed::Runtime, relocation::transcript, rpc_requests::Failure},
    filesystem::{Scope, paths},
    protected_secrets::{open_mcp_servers, open_runtime_provider},
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{JsString, Value, value::json};
use regress::Regex;
use std::{collections::HashSet, sync::LazyLock, time::Duration};

const RPC_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_BATCH_SIZE: usize = 1_000_000;
const MAX_BATCH_ITEMS: usize = 100;

impl Ensurer {
    pub(crate) async fn has_hydrated_thread(
        &self,
        command: &Value,
        binding: &(JsString, Value),
        thread: &JsString,
    ) -> Result<bool> {
        let chat = field(command, "chatId")?;
        let provider = open_runtime_provider(&self.0.encryption, &command["provider"])?;
        let runtime = self
            .relocation_runtime(command, &provider, Some(&chat), Some(thread), binding)
            .await?;
        let result = rpc(
            &runtime,
            "thread/read",
            json!({"threadId":thread,"includeTurns":false}),
        )
        .await;
        self.assert_bound(binding)?;
        match result {
            Ok(result) => {
                ensure!(
                    result["thread"]["id"].as_js_string() == Some(thread),
                    "Codex returned a different hydrated thread."
                );
                Ok(true)
            }
            // A failed placement can discard the hydrated thread while the
            // receipt still records the completed upload. Retry from the
            // original immutable transcript when Codex reports its absence.
            Err(error) if missing_thread(&error) => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn hydrate_relocation(
        &self,
        command: &Value,
        transcript: &transcript::Opened,
        binding: &(JsString, Value),
        abandoned: Option<&JsString>,
        on_started: impl FnOnce(&JsString) -> Result<()>,
        scope: &Scope,
    ) -> Result<JsString> {
        let cwd = field(command, "cwd")?;
        let chat = field(command, "chatId")?;
        let messages = transcript.payload["messages"]
            .as_array()
            .context("Missing canonical messages.")?;
        let required = required_skills(
            command,
            if transcript.encrypted {
                Some(messages.as_slice())
            } else {
                None
            },
        )?;
        let mcp = profile::external_servers(
            open_mcp_servers(
                &self.0.encryption,
                command["mcpServers"]
                    .as_array()
                    .context("Missing relocation MCP configuration.")?,
            )?,
            false,
        )?;
        let provider = open_runtime_provider(&self.0.encryption, &command["provider"])?;
        let configuration = profile::configuration(
            command,
            &cwd,
            mcp,
            None,
            provider::model_provider(&provider),
            false,
            true,
            None,
        )
        .await?;

        let runtime = self
            .relocation_runtime(command, &provider, Some(&chat), None, binding)
            .await?;
        verify_skills(&runtime, &cwd, &required).await?;
        scope.check()?;
        self.assert_bound(binding)?;
        if let Some(thread) = abandoned {
            discard(&runtime, thread).await?;
        }
        // thread/start applies the requested permission profile in the native
        // runtime. A rejected profile is reported by the actual operation.
        let result = rpc(&runtime, "thread/start", configuration.start).await?;
        let id = field(&result["thread"], "id")?;
        if let Err(error) = on_started(&id) {
            let _ = discard(&runtime, &id).await;
            return Err(error);
        }
        let thread = LoadedThread::observe(&runtime, &id);
        inject(&runtime, &thread, messages, scope).await?;
        scope.check()?;
        self.assert_bound(binding)?;
        profile::apply_plan_mode(&runtime, &thread, &command["planMode"], &command["model"])
            .await?;
        let verified = runtime.read_history(&id).await?;
        ensure!(
            verified["thread"]["id"].as_js_string() == Some(&id),
            "The managed Codex thread could not be read after hydration."
        );
        thread.assert_current(&runtime)?;
        self.assert_bound(binding)?;
        Ok(id)
    }

    async fn relocation_runtime(
        &self,
        command: &Value,
        provider: &Value,
        chat: Option<&JsString>,
        thread: Option<&JsString>,
        binding: &(JsString, Value),
    ) -> Result<Runtime> {
        self.assert_bound(binding)?;
        let server = binding
            .1
            .as_js_string()
            .cloned()
            .context("Unverified worker server identity.")?;
        let profile = home::profile(
            &self.0.data,
            &json!({"ownerId":binding.0,"serverId":binding.1,"workerId":self.0.worker}),
            home::Source::Current(thread),
            chat,
            provider,
            "ide",
            self.0.skills.clone(),
            None,
        )
        .await?;
        let launch = provider::launch(
            profile,
            provider.clone(),
            self.0.access.clone(),
            &command["model"],
            &Value::Null,
        )?;
        let runtime = self
            .0
            .codex
            .launch_in_scope(launch, Some((server, binding.0.clone())))
            .await?;
        runtime
            .synchronize_models(&command["model"], &Value::Null)
            .await?;
        self.assert_bound(binding)?;
        Ok(runtime)
    }

    pub(crate) async fn release_relocation(&self, command: &Value) -> Result<Value> {
        let Some(id) = command["threadId"].as_js_string() else {
            return Ok(json!({"released":false}));
        };
        let binding = self.0.encryption.bound_identity()?;
        let attached = {
            let owners = self.0.live_threads.lock().unwrap();
            owners.values().find_map(|owner| {
                if owner.bound != binding || owner.thread.id() != id {
                    return None;
                }
                let runtime = owner.runtime.upgrade()?;
                owner.thread.assert_current(&runtime).ok()?;
                Some(runtime)
            })
        };
        let runtime = match attached {
            Some(runtime) => runtime,
            None => {
                let provider = open_runtime_provider(&self.0.encryption, &command["provider"])?;
                self.relocation_runtime(command, &provider, None, Some(id), &binding)
                    .await?
            }
        };
        self.assert_bound(&binding)?;
        if command["discard"] == true {
            discard(&runtime, id).await?;
        } else {
            match runtime.read_history(id).await {
                Ok(snapshot) if snapshot["thread"]["status"]["type"] == "active" => {
                    bail!("Codex thread {id} still has an active turn.");
                }
                Ok(_) => {
                    ignore_missing(
                        rpc(&runtime, "thread/unsubscribe", json!({"threadId":id})).await,
                    )?;
                }
                Err(error) => ignore_missing(Err(error))?,
            }
        }
        self.assert_bound(&binding)?;
        self.0.live_threads.lock().unwrap().retain(|_, owner| {
            owner.bound != binding
                || owner.thread.id() != id
                || owner
                    .runtime
                    .upgrade()
                    .is_some_and(|owner| owner.generation() != runtime.generation())
        });
        Ok(json!({"released":true}))
    }
}

fn required_skills(command: &Value, messages: Option<&[Value]>) -> Result<HashSet<JsString>> {
    static MENTION: LazyLock<Regex> = LazyLock::new(|| {
        Regex::with_flags(r"(?:^|[^A-Za-z0-9_$])\$([A-Za-z0-9][A-Za-z0-9_.:-]*)", "u").unwrap()
    });
    let requested = command["requiredSkillNames"]
        .as_array()
        .context("Missing relocation skills.")?;
    let Some(messages) = messages else {
        return Ok(requested
            .iter()
            .filter_map(Value::as_js_string)
            .cloned()
            .collect());
    };
    let mut names = HashSet::new();
    // Encrypted transcripts are opened only on the destination. Core cannot
    // inventory the skill mentions when it creates the immutable snapshot.
    for item in messages
        .iter()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
    {
        if item["type"] == "text"
            && let Some(text) = item["text"].as_js_string()
        {
            for found in MENTION.find_from_utf16(text.units(), 0) {
                let range = found.group(1).unwrap();
                names.insert(JsString::new(text.units()[range].to_vec()));
            }
        }
    }
    ensure!(
        names.len() <= 64,
        "The canonical transcript references too many skills."
    );
    Ok(names)
}

async fn verify_skills(
    runtime: &Runtime,
    cwd: &JsString,
    required: &HashSet<JsString>,
) -> Result<()> {
    if required.is_empty() {
        return Ok(());
    }
    let response = rpc(
        runtime,
        "skills/list",
        json!({"cwds":vec![cwd],"forceReload":true}),
    )
    .await?;
    let expected = paths::resolve(&paths::native(cwd))?;
    let group = response["data"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|group| {
            group["cwd"]
                .as_js_string()
                .and_then(|cwd| paths::resolve(&paths::native(cwd)).ok())
                .is_some_and(|cwd| paths::equal(&cwd, &expected))
        });
    let available = group
        .and_then(|group| group["skills"].as_array())
        .into_iter()
        .flatten()
        .filter(|skill| skill["enabled"] != false)
        .filter_map(|skill| skill["name"].as_js_string().map(JsString::trim))
        .collect::<HashSet<_>>();
    let mut missing = required.difference(&available).cloned().collect::<Vec<_>>();
    missing.sort_by(|a, b| a.units().cmp(b.units()));
    ensure!(
        missing.is_empty(),
        "Required skills are unavailable on the target worker: {}.",
        crate::native_items::join(missing, ", ")
    );
    Ok(())
}

async fn inject(
    runtime: &Runtime,
    thread: &LoadedThread,
    messages: &[Value],
    scope: &Scope,
) -> Result<()> {
    let mut batch = Vec::new();
    let mut size = 0;
    for message in messages {
        scope.check()?;
        let (item, _) = transcript::response_item(message)?;
        let bytes = item.stringify().len();
        if !batch.is_empty() && (batch.len() == MAX_BATCH_ITEMS || size + bytes > MAX_BATCH_SIZE) {
            inject_batch(runtime, thread, std::mem::take(&mut batch), scope).await?;
            size = 0;
        }
        batch.push(item);
        size += bytes;
    }
    if !batch.is_empty() {
        inject_batch(runtime, thread, batch, scope).await?;
    }
    Ok(())
}

async fn inject_batch(
    runtime: &Runtime,
    thread: &LoadedThread,
    items: Vec<Value>,
    scope: &Scope,
) -> Result<()> {
    scope.check()?;
    thread.assert_current(runtime)?;
    rpc(
        runtime,
        "thread/inject_items",
        json!({"threadId":thread.id(),"items":items}),
    )
    .await?;
    thread.assert_current(runtime)?;
    Ok(())
}

async fn discard(runtime: &Runtime, id: &JsString) -> Result<()> {
    let removed = rpc(runtime, "thread/delete", json!({"threadId":id})).await;
    if removed
        .as_ref()
        .err()
        .and_then(native_error)
        .is_some_and(|err| err["code"].as_i64() == Some(-32601))
    {
        return ignore_missing(rpc(runtime, "thread/unsubscribe", json!({"threadId":id})).await);
    }
    ignore_missing(removed)
}

fn native_error(error: &anyhow::Error) -> Option<&Value> {
    error.downcast_ref::<Failure>()?.native_error.as_ref()
}

fn ignore_missing(result: Result<Value>) -> Result<()> {
    match result {
        Ok(_) => Ok(()),
        Err(error) if missing_thread(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

fn missing_thread(error: &anyhow::Error) -> bool {
    let message = native_error(error)
        .and_then(|raw| raw["message"].as_str())
        .unwrap_or_default()
        .to_lowercase();
    [
        "thread not found",
        "not loaded",
        "unknown thread",
        "no rollout found",
        "no thread found",
    ]
    .iter()
    .any(|reason| message.contains(reason))
}

async fn rpc(runtime: &Runtime, method: &str, params: Value) -> Result<Value> {
    runtime
        .request(method.into(), Some(params), Some(RPC_TIMEOUT), None)
        .await?
        .with_context(|| format!("Codex did not return a {method} result."))
}
