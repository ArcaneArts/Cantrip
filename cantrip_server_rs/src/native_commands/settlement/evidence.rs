use super::Settlement;
use crate::{
    database::Transaction,
    native_commands::admit::{raw_one, reject, text},
    wire::{JsString, Value, coercion::truthy},
};
use anyhow::{Context, Result};
impl Settlement<'_> {
    pub(super) async fn evidence(&self, tx: &Transaction<'_>) -> Result<()> {
        let input = self.input;
        let row = &self.row;
        let chat = text(&row["chat_id"])?;
        if truthy(input.get("decline")) {
            let active = raw_one(
                tx,
                "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
                &[&chat],
            )
            .await?
            .unwrap_or(Value::Null);
            let decline = &input["decline"];
            let mut proposed = "native:".encode_utf16().collect::<Vec<_>>();
            proposed.extend(
                decline["runnerGeneration"]
                    .as_js_string()
                    .context("Native runner generation")?
                    .units(),
            );
            proposed.push(b':' as u16);
            proposed.extend(
                decline["attemptId"]
                    .as_js_string()
                    .context("Native attempt identity")?
                    .units(),
            );
            if input["status"] != "rejected"
                || !truthy(input.get("executionComplete"))
                || truthy(input.get("reconciliation"))
                || row["origin"] != "autonomous"
                || row["kind"] != "start"
                || row["operation_id"] != Value::String(JsString::new(proposed))
                || !truthy(active.get("active"))
                || active.get("generation") != row.get("activation_generation")
                || active.get("runtime_generation") != decline.get("runtimeGeneration")
                || active.get("native_turn_id") != decline.get("nativeTurnId")
            {
                return reject("stale-native-evidence");
            }
        }
        if truthy(input.get("reconciliation")) {
            let active = raw_one(
                tx,
                "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
                &[&chat],
            )
            .await?
            .unwrap_or(Value::Null);
            let evidence = &input["reconciliation"];
            if row["kind"] != "start"
                || !truthy(active.get("active"))
                || active.get("generation") != row.get("activation_generation")
                || active.get("runtime_generation") != evidence.get("runtimeGeneration")
                || (truthy(active.get("native_turn_id"))
                    && active.get("native_turn_id") != evidence.get("nativeTurnId"))
            {
                return reject("stale-native-evidence");
            }
            tx.query(
                "UPDATE native_command_activations SET native_turn_id=$1 WHERE chat_id=$2",
                &[&text(&evidence["nativeTurnId"])?, &chat],
            )
            .await?;
        }
        Ok(())
    }
    pub(super) fn transition(&self, goal: bool) -> Result<()> {
        let current = &self.current;
        let input = self.input;
        if current["status"] == "rejected" && current.get("status") != input.get("status") {
            return reject("receipt-conflict");
        }
        if current["status"] == "uncertain"
            && input["status"] != "uncertain"
            && !(input["status"] == "applied" && (truthy(input.get("reconciliation")) || goal))
            && !(input["status"] == "rejected"
                && (truthy(input.get("decline")) || truthy(input.get("deferred"))))
        {
            return reject("native-evidence-required");
        }
        if current["status"] == "accepted" && input["status"] == "applied" {
            return reject("operation-not-dispatched");
        }
        if current["status"] == "applied" && input["status"] != "applied" {
            return reject("receipt-conflict");
        }
        if truthy(current.get("result_digest"))
            && truthy(input.get("resultDigest"))
            && current.get("result_digest") != input.get("resultDigest")
        {
            return reject("receipt-conflict");
        }
        if truthy(current.get("terminal_result_digest"))
            && truthy(input["terminalResult"].get("resultDigest"))
            && current.get("terminal_result_digest") != input["terminalResult"].get("resultDigest")
        {
            return reject("receipt-conflict");
        }
        Ok(())
    }
}
