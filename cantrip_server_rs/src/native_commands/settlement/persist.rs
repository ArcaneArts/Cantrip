use super::Settlement;
use crate::{
    chats::execution_lanes,
    database::Transaction,
    native_commands::{
        admit::{optional, raw_one, text},
        receipt,
    },
    wire::{Value, coercion::truthy},
};
use anyhow::{Context, Result};
use futures::FutureExt;
fn encoded(value: &Value) -> Option<String> {
    (!value.is_null()).then(|| value.stringify())
}
fn coalesce<'a>(left: Option<&'a Value>, right: &'a Value) -> &'a Value {
    left.filter(|v| !v.is_null()).unwrap_or(right)
}
impl Settlement<'_> {
    pub(super) async fn persist(&self, tx: &Transaction<'_>) -> Result<Value> {
        let current = &self.current;
        let input = self.input;
        let status = text(&input["status"])?;
        let digest = optional(coalesce(
            input.get("resultDigest"),
            &current["result_digest"],
        ))?;
        let result = encoded(coalesce(
            current.get("protected_result"),
            &input["protectedResult"],
        ));
        let terminal_digest = optional(coalesce(
            input["terminalResult"].get("resultDigest"),
            &current["terminal_result_digest"],
        ))?;
        let terminal_result = encoded(coalesce(
            current.get("protected_terminal_result"),
            &input["terminalResult"]["protectedResult"],
        ));
        let terminal = encoded(if truthy(input.get("executionComplete")) {
            &self.terminal
        } else {
            &current["terminal_evidence"]
        });
        let completed = if truthy(input.get("executionComplete")) {
            Some(crate::auth::iso(crate::auth::now()))
        } else if current["execution_completed_at"].is_null() {
            None
        } else {
            Some(text(&receipt::iso(&current["execution_completed_at"])?)?)
        };
        let code = if truthy(input.get("deferred")) {
            Some("native-settings-pending".to_owned())
        } else {
            optional(coalesce(
                input.get("rejectionCode"),
                &current["rejection_code"],
            ))?
        };
        let now = crate::auth::now();
        let operation = text(&self.row["operation_id"])?;
        raw_one(tx,"UPDATE native_commands SET status=$1,result_digest=$2,protected_result=$3::text::jsonb,terminal_result_digest=$4,protected_terminal_result=$5::text::jsonb,terminal_evidence=$6::text::jsonb,execution_completed_at=$7::text::timestamptz,rejection_code=$8,updated_at=$9 WHERE operation_id=$10 RETURNING to_jsonb(native_commands)::text",&[&status,&digest,&result,&terminal_digest,&terminal_result,&terminal,&completed,&code,&now,&operation]).await?.context("Database returned no row after settling native command.")
    }
    pub(super) async fn finish(&self, tx: &Transaction<'_>) -> Result<()> {
        let row = &self.row;
        let input = self.input;
        if !(truthy(input.get("executionComplete"))
            && row["kind"] == "start"
            && truthy(row.get("activation_generation"))
            && truthy(row.get("execution_lane_id")))
        {
            return Ok(());
        }
        let chat = text(&row["chat_id"])?;
        let active = raw_one(
            tx,
            "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
            &[&chat],
        )
        .await?
        .unwrap_or(Value::Null);
        if truthy(active.get("active"))
            && active.get("generation") == row.get("activation_generation")
        {
            let status = if truthy(input.get("deferred")) {
                "idle".into()
            } else {
                input
                    .get("executionStatus")
                    .filter(|v| !v.is_null())
                    .map(text)
                    .transpose()?
                    .unwrap_or_else(|| {
                        if input["status"] == "applied" {
                            "idle".into()
                        } else {
                            "failed".into()
                        }
                    })
            };
            execution_lanes::finish_in_transaction(
                tx,
                &chat,
                &text(&row["execution_lane_id"])?,
                &status,
                &Value::Null,
            )
            .boxed()
            .await?;
            tx.query(
                "UPDATE native_command_activations SET active=false WHERE chat_id=$1",
                &[&chat],
            )
            .await?;
        } else if truthy(input.get("deferred"))
            && active.get("generation") == row.get("activation_generation")
        {
            let now = crate::auth::now();
            tx.query("UPDATE chats SET status='idle',updated_at=$1 WHERE id=$2 AND status='failed' AND NOT EXISTS(SELECT 1 FROM chat_execution_lanes l WHERE l.chat_id=$2 AND l.state='active')",&[&now,&chat]).await?;
        }
        Ok(())
    }
}
