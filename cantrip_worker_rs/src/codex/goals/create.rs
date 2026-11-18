//! Prepare the selected thread and apply an ordinary Chat Goal.
use super::*;
use crate::codex::{
    preparation::command::{LiveThread, native_session},
    turn::Turns,
};
use crate::native_items::concat;

impl Goals {
    pub(super) async fn create_chat(
        &self,
        command: &Value,
        turns: &Turns,
        objective: &JsString,
    ) -> Result<Value> {
        if command["osExecution"].is_object() || command["session"]["osExecution"].is_object() {
            bail!("Native creation of an OS-hosted Goal is unavailable.");
        }
        let bound = self.encryption.bound_identity()?;
        let command = self.preparation.resolve_routing(command).await?;
        let (thread, owner) = self.chat_goal_thread(&command, &bound).await?;
        self.watch_project(&command, &bound, &thread, &owner.runtime);
        let observed = rpc(
            &owner.runtime,
            "thread/goal/get",
            json!({"threadId":thread}),
        )
        .await?;
        if verify_goal(&thread, &observed)?["status"] == "complete" {
            let mut clear = command.clone();
            if let Some(operation) = command["operationId"].as_js_string() {
                clear["operationId"] = json!(concat(&[operation.clone(), ":clear".into()]));
            }
            let clear = self
                .apply_mutation(
                    &clear,
                    turns,
                    &bound,
                    owner.clone(),
                    "thread/goal/clear",
                    json!({"threadId":thread}),
                )
                .await?;
            if checked("chatGoalClearSchema", &clear)?["cleared"] != true {
                bail!("Could not replace the completed Codex Goal.");
            }
        }

        let reply = self
            .apply_mutation(
                &command,
                turns,
                &bound,
                owner,
                "thread/goal/set",
                json!({
                    "threadId":thread,"objective":objective.trim(),"status":"active",
                    "tokenBudget":command["tokenBudget"],
                }),
            )
            .await?;
        let goal = verify_goal(&thread, &reply)?;
        if goal.is_null() {
            bail!("Codex did not create the Goal.");
        }
        Ok(json!({"goal":goal}))
    }

    pub(super) async fn chat_goal_thread(
        &self,
        command: &Value,
        bound: &(JsString, Value),
    ) -> Result<(JsString, LiveThread)> {
        let chat = command["chatId"]
            .as_js_string()
            .context("Missing Goal chat.")?;
        let managed = command["session"].is_object();
        if managed && command["session"]["chatId"].as_js_string() != Some(chat) {
            bail!("The Goal belongs to another managed conversation.");
        }
        if let Some(thread) = command["threadId"].as_js_string()
            && let Some(owner) = self.preparation.live_thread(chat, thread, bound)
            && (!managed
                || (command["session"].get("heldSuspension").is_none()
                    && command["session"]["computerUseEnabled"] != true
                    && owner.session.as_ref()
                        == Some(&native_session(command, &owner.runtime, thread))))
        {
            return Ok((thread.clone(), owner));
        }
        if managed {
            let mut prepare = command.clone();
            if prepare["planMode"].is_null() {
                prepare["planMode"] = json!("default");
            }
            if prepare["mcpServers"].is_null() {
                prepare["mcpServers"] = json!(Vec::<Value>::new());
            }
            let prepared = self.preparation.prepare(&prepare, Intent::Preserve).await?;
            let thread = prepared.thread.id().clone();
            let session = native_session(&prepare, &prepared.runtime, &thread);
            return Ok((
                thread,
                LiveThread {
                    runtime: prepared.runtime,
                    session: Some(session),
                },
            ));
        }
        let (runtime, model_provider) = self.observation.open_target(command, bound).await?;
        // Core will submit the canonical turn separately on this path. Keep
        // an existing saved thread unloaded until that execution is admitted.
        let thread = if let Some(thread) = command["threadId"].as_js_string() {
            thread.clone()
        } else {
            self.preparation
                .start_host_goal(command, &runtime, model_provider)
                .await?
        };
        Ok((
            thread,
            LiveThread {
                runtime,
                session: None,
            },
        ))
    }
}
