//! Passive native observations cannot retire an admitted command's activation.
use super::{Repository, admit::text, context};
use crate::{
    chats::execution_lanes,
    wire::{Value, value::json},
};
use anyhow::Result;

impl Repository {
    pub async fn reconcile_thread_observation(
        &self,
        owner: &str,
        expected: &Value,
        status: &str,
    ) -> Result<Value> {
        let (owner, expected, status) = (owner.to_owned(), expected.clone(), status.to_owned());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let chat = text(&expected["chatId"])?;
                    context::lock_chat(tx, &owner, &chat).await?;
                    let current = context::execution(tx, &owner, &chat).await?;
                    let unchanged = json!({"applied":false,"execution":expected});
                    let Some(current) = current else {
                        return Ok(unchanged);
                    };
                    if current["contextKind"] != "project"
                        || [
                            "contextKind",
                            "workerId",
                            "worktreeId",
                            "threadId",
                            "modelRouteId",
                            "providerAccountId",
                            "executionLaneId",
                        ]
                        .iter()
                        .any(|key| current[*key] != expected[*key])
                    {
                        return Ok(unchanged);
                    }
                    let activations = tx
                        .query(
                            "SELECT active FROM native_command_activations WHERE chat_id=$1",
                            &[&chat],
                        )
                        .await?;
                    if activations
                        .first()
                        .map(|row| row.get::<bool>(0))
                        .transpose()?
                        .unwrap_or(false)
                    {
                        return Ok(unchanged);
                    }
                    if status == "running" && current["executionLaneId"].is_null() {
                        return Ok(
                            match execution_lanes::start_in_transaction(
                                tx,
                                &owner,
                                &chat,
                                "agent",
                                "Linked Codex console turn",
                            )
                            .await?
                            {
                                Some(execution) => json!({"applied":true,"execution":execution}),
                                None => unchanged,
                            },
                        );
                    }
                    if !current["executionLaneId"].is_null() && status != "running" {
                        let applied = execution_lanes::finish_in_transaction(
                            tx,
                            &chat,
                            &text(&current["executionLaneId"])?,
                            &status,
                            &Value::Null,
                        )
                        .await?;
                        return Ok(json!({"applied":applied,"execution":current}));
                    }
                    tx.query(
                        "UPDATE chats SET status=$3,updated_at=$4 WHERE id=$1 AND owner_id=$2",
                        &[&chat, &owner, &status, &crate::auth::now()],
                    )
                    .await?;
                    Ok(json!({"applied":true,"execution":current}))
                })
            })
            .await
    }
}
