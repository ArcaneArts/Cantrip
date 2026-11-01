use super::*;
use crate::chats::{live_mutations::MessageOptions, message_queries::MessageKind};
impl EventSink {
    pub(super) async fn write(
        &self,
        message: &Value,
        kind: MessageKind,
        upsert: bool,
    ) -> Result<Option<Value>> {
        self.dependencies
            .live
            .write_message(
                &self.turn.owner,
                &text(&self.turn.execution["chatId"])?,
                message,
                MessageOptions {
                    attribution: Some(&self.turn.attribution),
                    kind,
                    upsert,
                    routing: if matches!(kind, MessageKind::Task) {
                        Some(&self.turn.execution)
                    } else {
                        None
                    },
                },
            )
            .await
    }
    pub(super) async fn message(
        &self,
        event: &Value,
        identity: &Value,
        state: &mut AttemptState,
        at: i64,
    ) -> Result<()> {
        match event["type"].as_str() {
            Some("agent.protected-task-message" | "agent.protected-message") => {
                let task = event["type"] == "agent.protected-task-message";
                if task && self.turn.task_relay.is_none() && self.turn.encrypted_task.is_none() {
                    bail!("Received a protected Task event for a non-Task turn.");
                }
                self.protected_telemetry(event, state, at).await?;
                if self
                    .write(
                        &event["message"],
                        if task {
                            MessageKind::Task
                        } else {
                            MessageKind::Encrypted
                        },
                        true,
                    )
                    .await?
                    .is_none()
                {
                    bail!(if task {
                        "Encrypted Task message was rejected."
                    } else {
                        "Encrypted Chat message was rejected."
                    });
                }
            }
            Some("agent.message") => {
                let message = &event["message"];
                let turn = message["correlation"].get("turnId");
                state.behavior_turn = nullish(turn, &state.behavior_turn).clone();
                let final_answer =
                    message["phase"] != "commentary" && !truthy(message.get("streaming"));
                if !message["text"]
                    .as_js_string()
                    .context("Message text")?
                    .trim()
                    .is_empty()
                {
                    state.tracker.mark_visible(final_answer, at);
                }
                if truthy(self.turn.options.get("structuredResult"))
                    && message["phase"] != "commentary"
                {
                    return Ok(());
                }
                let mut content =
                    json!({"type":"text","text":message["text"],"sourceEvent":identity});
                for key in ["phase", "correlation"] {
                    if let Some(v) = message.get(key) {
                        content[key] = v.clone();
                    }
                }
                if truthy(message.get("streaming")) {
                    content["streaming"] = json!(true);
                }
                self.write(&json!({"role":"assistant","content":Value::Array(vec![content]),"idempotencyKey":identifier(&[&json!("agent-message:"),nullish(turn,&self.turn.user_message["id"]),&json!(":"),&message["id"]])}),MessageKind::Plain,true).await?;
                if final_answer {
                    state.finals.record(turn, &message["text"])?;
                }
            }
            Some("agent.checkpoint") => {
                if truthy(self.turn.options.get("structuredResult"))
                    || event["text"]
                        .as_js_string()
                        .context("Checkpoint text")?
                        .trim()
                        .is_empty()
                    || event["turnId"]
                        .as_js_string()
                        .is_some_and(|v| state.finals.turns.contains(v))
                {
                    return Ok(());
                }
                state.behavior_turn = event["turnId"].clone();
                state.tracker.mark_visible(true, at);
                self.write(&json!({"role":"assistant","content":Value::Array(vec![json!({"type":"text","text":event["text"],"phase":"final_answer"})]),"idempotencyKey":identifier(&[&json!("goal-checkpoint:"),&self.turn.user_message["id"],&json!(":"),&event["turnId"]])}),MessageKind::Plain,true).await?;
            }
            Some("agent.plan.protected") => {
                if self.turn.encrypted_chat.is_none() {
                    bail!("Received protected Plan Mode state for a non-chat-encrypted turn.");
                }
                self.dependencies
                    .live
                    .update_plan(
                        &self.turn.owner,
                        &text(&self.turn.execution["chatId"])?,
                        &event["state"],
                    )
                    .await?;
            }
            Some("agent.plan.updated") => bail!("Worker emitted plaintext Plan Mode state."),
            Some("agent.plan.question") => bail!("Worker emitted a plaintext Plan Mode question."),
            Some("agent.plan.question-resolved") => {
                bail!("Worker emitted a plaintext Plan Mode resolution.")
            }
            Some("agent.activity") => {
                let activity = &event["activity"];
                self.activity_telemetry(activity, state, at).await?;
                let key = if activity["type"] == "worktree" {
                    activity["id"].clone()
                } else {
                    identifier(&[
                        &json!("activity:"),
                        &self.turn.user_message["id"],
                        &json!(":"),
                        &activity["id"],
                    ])
                };
                self.write(&json!({"role":"assistant","content":Value::Array(vec![json!({"type":"activity","activity":activity,"sourceEvent":identity})]),"idempotencyKey":key}),MessageKind::Plain,true).await?;
            }
            _ => {}
        }
        Ok(())
    }
}
