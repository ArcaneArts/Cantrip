//! Edit and resend remove the native suffix before Core replaces canonical rows.
use super::{Intent, RPC_TIMEOUT, Runtime, Scope, Turns, checked, id, receipt};
use crate::codex::{observation::Observer, preparation::command::native_session};
use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{JsString, Value, value::json};

pub(crate) const COMMAND: &str = "chat.turn.rollback";
pub(super) const METHOD: &str = "thread/revert";

impl Turns {
    pub(crate) async fn rollback(&self, command: &Value, observation: &Observer) -> Result<Value> {
        let key = self.key(command)?;
        let binding = (key.0.clone(), json!(key.1));
        let thread = id(&command["threadId"], "rollback thread")?;
        let message = id(&command["clientMessageId"], "rollback message")?;
        if self
            .active
            .lock()
            .unwrap()
            .active
            .get(&key)
            .is_some_and(|active| {
                matches!(
                    *active.phase.lock().unwrap(),
                    super::Phase::Preparing(_)
                        | super::Phase::Sending(_)
                        | super::Phase::Running { .. }
                )
            })
        {
            bail!("Codex thread {thread} already has an active turn.");
        }

        let (runtime, session) = if command["session"].is_object() {
            ensure!(
                command["session"]["chatId"] == command["chatId"],
                "The rollback session belongs to a different chat."
            );
            let prepared = self.preparation.prepare(command, Intent::Preserve).await?;
            ensure!(
                prepared.thread.id() == &thread && prepared.bound == binding,
                "The worker binding or native thread changed before rollback."
            );
            prepared.thread.assert_current(&prepared.runtime)?;
            let session = native_session(command, &prepared.runtime, &thread);
            (prepared.runtime, Some(session))
        } else if let Some(live) = self.preparation.live_thread(&key.2, &thread, &binding) {
            (live.runtime, live.session)
        } else {
            let runtime = observation.open_runtime(command, &binding).await?;
            let result = rpc(&runtime, "thread/resume", json!({"threadId":thread})).await?;
            assert_thread(&result, &thread)?;
            (runtime, None)
        };

        let history = runtime.read_history(&thread).await?;
        if history["thread"]["status"]["type"] == "active" {
            bail!("Codex thread {thread} already has an active turn.");
        }
        let boundary = rollback_boundary(&history["thread"]["turns"], &message)
            .context("The latest Cantrip message could not be matched to its Codex turn.")?;
        let params = json!({"threadId":thread,"beforeTurnId":boundary});
        ensure!(
            self.key(command)? == key,
            "The worker binding changed before rollback."
        );

        let reverted = match session {
            Some(mut session) => {
                // The root is reserved for the subsequent turn/start. Bind its
                // preparation before admitting the independent history mutation.
                if command["session"].is_object()
                    && let Some(root) = receipt::Operation::for_gui_preparation(command)?
                {
                    let mut admission = command.clone();
                    let target = &command["session"];
                    admission["contextKind"] = target["contextKind"].clone();
                    admission["policyProjectId"] = target["projectId"].clone();
                    admission["worktreeId"] = target["worktreeId"].clone();
                    admission["scratchRootId"] = target["scratchRootId"].clone();
                    let receipt = receipt::Receipt::new(
                        &self.receipts,
                        &root,
                        &admission,
                        &runtime,
                        &thread,
                        Scope::new(self.encryption.clone())?,
                        &key,
                    )?;
                    receipt.prepare().await?;
                    session = receipt.session().clone();
                }
                self.native_mutation(&runtime, &binding, command, session, METHOD, params)
                    .await?
            }
            None => rpc(&runtime, METHOD, params).await?,
        };
        assert_thread(&reverted, &thread)?;
        ensure!(
            self.key(command)? == key,
            "The worker binding changed during rollback."
        );
        self.preparation
            .rotate_reverted_runner(&key.2, &binding, &runtime, &thread);
        checked(
            "chatTurnRollbackAcceptedSchema",
            &json!({"rolledBack":true}),
        )
    }
}

fn rollback_boundary<'a>(turns: &'a Value, message: &JsString) -> Option<&'a JsString> {
    let native = crate::native_items::concat(&["cantrip:".into(), message.clone()]);
    turns.as_array()?.iter().find_map(|turn| {
        turn["items"]
            .as_array()?
            .iter()
            .any(|item| {
                item["type"] == "userMessage" && item["clientId"].as_js_string() == Some(&native)
            })
            .then(|| turn["id"].as_js_string())
            .flatten()
    })
}

fn assert_thread(result: &Value, thread: &JsString) -> Result<()> {
    ensure!(
        result["thread"]["id"].as_js_string() == Some(thread),
        "Codex returned a different native thread during rollback."
    );
    Ok(())
}

async fn rpc(runtime: &Runtime, method: &str, params: Value) -> Result<Value> {
    runtime
        .request(method.into(), Some(params), Some(RPC_TIMEOUT), None)
        .await?
        .with_context(|| format!("Codex did not return a {method} result."))
}
