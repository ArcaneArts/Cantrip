use super::Settlement;
use crate::{
    database::Transaction,
    native_commands::{
        admit::{raw_one, reject, text},
        queue, queued_prompt,
    },
    wire::{self, Value, coercion::truthy},
};
use anyhow::{Context, Result};
impl Settlement<'_> {
    pub(super) async fn deferred(&self, tx: &Transaction<'_>) -> Result<()> {
        let input = self.input;
        if !truthy(input.get("deferred")) {
            return Ok(());
        }
        let row = &self.row;
        let current = &self.current;
        let deferred = &input["deferred"];
        let chat = text(&row["chat_id"])?;
        let operation = text(&row["operation_id"])?;
        let generation = text(&row["operation_generation"])?;
        let active = raw_one(
            tx,
            "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
            &[&chat],
        )
        .await?
        .unwrap_or(Value::Null);
        let identity = &row["identity"];
        if input["status"] != "rejected"
            || !truthy(input.get("executionComplete"))
            || truthy(input.get("decline"))
            || truthy(input.get("reconciliation"))
            || truthy(input.get("terminalResult"))
            || (current["status"] != "dispatched" && !self.missing)
            || [
                "result_digest",
                "protected_result",
                "terminal_result_digest",
                "protected_terminal_result",
                "terminal_evidence",
            ]
            .iter()
            .any(|field| truthy(current.get(field)))
            || !truthy(input.get("protectedResult"))
            || !truthy(input.get("resultDigest"))
            || row["method"] != "turn/start"
            || row["kind"] != "start"
            || (active.get("generation") == row.get("activation_generation")
                && (truthy(active.get("native_turn_id"))
                    || active.get("runtime_generation") != deferred.get("runtimeGeneration")))
            || wire::property(Some(identity), "threadId")? != deferred.get("threadId")
            || wire::property(Some(identity), "runtimeGeneration")?
                != deferred.get("runtimeGeneration")
        {
            return reject("stale-native-deferral");
        }
        if !tx
            .query(
                "SELECT operation_id FROM native_command_turns WHERE operation_id=$1",
                &[&operation],
            )
            .await?
            .is_empty()
        {
            return reject("stale-native-deferral");
        }
        let claim=raw_one(tx,"SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE operation_id=$1 AND operation_generation=$2",&[&operation,&generation]).await?;
        if claim
            .as_ref()
            .is_some_and(|c| c["status"] == "consumed" || truthy(c.get("native_turn_id")))
        {
            return reject("stale-native-deferral");
        }
        if truthy(deferred.get("retainedPrompt")) {
            let prompt = &deferred["retainedPrompt"];
            let root_id = row
                .get("logical_operation_id")
                .filter(|v| !v.is_null())
                .unwrap_or(&row["operation_id"]);
            let root=raw_one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND owner_id=$2 AND chat_id=$3",&[&text(root_id)?,&self.owner,&chat]).await?.unwrap_or(Value::Null);
            let gui = row["origin"] == "gui"
                && truthy(root.get("logical_client_message_id"))
                && prompt["pendingMessage"].get("id") == root.get("logical_client_message_id")
                && (prompt.get("nativeClientUserMessageId")
                    == root.get("logical_client_message_id")
                    || prompt["nativeClientUserMessageId"]
                        == format!("cantrip:{}", text(&root["logical_client_message_id"])?)
                            .as_str())
                && prompt["pendingMessage"]["protectedContent"].get("envelope")
                    == root.get("protected_payload");
            let terminal = row["origin"] == "terminal"
                && truthy(prompt.get("nativeClientUserMessageId"))
                && (!truthy(wire::property(
                    row.get("intent"),
                    "nativeClientUserMessageId",
                )?) || prompt.get("nativeClientUserMessageId")
                    == wire::property(row.get("intent"), "nativeClientUserMessageId")?);
            let attachments = deferred["attachments"]
                .as_array()
                .context("Native deferral attachments")?;
            let ids = Value::Array(attachments.iter().map(|a| a["id"].clone()).collect());
            if claim.is_some()
                || (!gui && !terminal)
                || prompt["pendingMessage"]["classification"]["role"] != "user"
                || prompt["executionMethod"] != "turn/start"
                || prompt["nativeAction"] != "literal"
                || !truthy(prompt.get("protectedNativeInput"))
                || attachments
                    .iter()
                    .any(|a| a.get("chatId") != row.get("chat_id"))
                || prompt["classification"].get("attachmentIds") != Some(&ids)
            {
                return reject("invalid-deferred-prompt");
            }
            let retained =
                queued_prompt::create(tx, self.owner, &chat, prompt, &deferred["attachments"])
                    .await?;
            if !retained.as_ref().is_some_and(|retained| {
                [
                    "id",
                    "pendingMessage",
                    "protectedContent",
                    "protectedNativeInput",
                ]
                .iter()
                .all(|field| retained.get(field) == prompt.get(field))
            }) {
                return reject("deferred-prompt-conflict");
            }
            tx.query(
                "INSERT INTO managed_queue_states(chat_id) VALUES($1) ON CONFLICT DO NOTHING",
                &[&chat],
            )
            .await?;
            queue::changed(tx, &chat).await?;
        } else if matches!(row["origin"].as_str(), Some("gui" | "terminal")) && claim.is_none() {
            return reject("deferred-prompt-required");
        }
        Ok(())
    }
}
