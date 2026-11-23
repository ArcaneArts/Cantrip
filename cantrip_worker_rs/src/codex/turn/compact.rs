//! The public compact command acknowledges the native start while its turn
//! remains under the usual Core and worker execution ownership.
use super::{RPC_TIMEOUT, Runtime, Turns, checked, id};
use crate::{chat_content::Scope, codex::observation::Observer};
use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{JsString, Value, value::json};

pub(crate) const COMMAND: &str = "chat.compact";
pub(super) const METHOD: &str = "thread/compact/start";

impl Turns {
    pub(crate) async fn compact(
        &self,
        command: &Value,
        observation: &Observer,
        acknowledge: impl FnOnce(Value) + Send,
    ) -> Result<Value> {
        let key = self.key(command)?;
        let bound = (key.0.clone(), json!(key.1));
        let thread = id(&command["threadId"], "compaction thread")?;
        let command = self.preparation.resolve_routing(command).await?;
        let params = json!({"threadId":thread});
        let accepted = checked("chatCompactAcceptedSchema", &json!({"accepted":true}))?;
        let live = self.preparation.live_thread(&key.2, &thread, &bound);
        if command["session"].is_object()
            || live.as_ref().is_some_and(|live| live.session.is_some())
        {
            self.run_acknowledged_start(
                &command,
                Scope::new(self.encryption.clone())?,
                METHOD,
                params,
                |_| acknowledge(accepted.clone()),
            )
            .await?;
        } else {
            let runtime = if let Some(live) = live {
                live.runtime
            } else {
                let runtime = observation.open_runtime(&command, &bound).await?;
                let loaded = request(&runtime, "thread/resume", json!({"threadId":thread})).await?;
                ensure!(
                    loaded["thread"]["id"].as_js_string() == Some(&thread),
                    "Codex resumed a different compaction thread."
                );
                runtime
            };
            ensure_idle(&runtime, &thread).await?;
            ensure!(
                self.key(&command)? == key,
                "The compaction worker binding changed."
            );
            ensure!(
                request(&runtime, METHOD, params).await?.is_object(),
                "Codex did not acknowledge compaction."
            );
        }

        Ok(accepted)
    }
}

pub(super) async fn ensure_idle(runtime: &Runtime, thread: &JsString) -> Result<()> {
    let observed = request(
        runtime,
        "thread/read",
        json!({"threadId":thread,"includeTurns":false}),
    )
    .await?;
    ensure!(
        observed["thread"]["id"].as_js_string() == Some(thread),
        "Codex returned a different compaction thread."
    );
    if observed["thread"]["status"]["type"] == "active" {
        bail!("Codex thread {thread} already has an active turn.");
    }
    Ok(())
}

async fn request(runtime: &Runtime, method: &str, params: Value) -> Result<Value> {
    runtime
        .request(method.into(), Some(params), Some(RPC_TIMEOUT), None)
        .await?
        .with_context(|| format!("Codex did not return a {method} result."))
}
