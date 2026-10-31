use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    native_commands::{CommandError, Repository},
    wire::Value,
};
use futures::FutureExt;
use std::sync::Arc;
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Event fixture identity")?
        .lossy()
        .into_owned())
}
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let repository = Repository::new(database);
    let owner = text(&input["owner"])?;
    let input = input.clone();
    let worker = input["worker"].clone();
    let operation = text(&input["operation"])?;
    let generation = text(&input["generation"])?;
    let apply_owner = owner.clone();
    repository
        .with_event_context(
            &owner,
            &worker,
            &operation,
            &generation,
            move |context, transaction| {
                Box::pin(async move {
                    if input["action"] == "context" {
                        return Ok(context);
                    }
                    if input["action"]
                        .as_str()
                        .is_some_and(|s| s.starts_with("interaction"))
                    {
                        let repo = transaction.interactions();
                        let saved = if input["action"] == "interaction-terminal" {
                            repo.terminalize(
                                &text(&input["key"])?,
                                &text(&context["chatId"])?,
                                &text(&input["worker"])?,
                                &text(&input["status"])?,
                                input.get("resolution"),
                            )
                            .boxed()
                            .await?
                            .unwrap_or(Value::Null)
                        } else {
                            repo.record(&input["interaction"], true).boxed().await?
                        };
                        if let Some(plan) = input.get("plan") {
                            transaction
                                .update_encrypted_plan(&text(&context["chatId"])?, plan)
                                .await?;
                        }
                        if input["action"] == "interaction-rollback" {
                            return Err(CommandError::new(
                                "fixture-native-event-rollback",
                                None,
                                409,
                            )
                            .into());
                        }
                        return Ok(Value::object([("context", context), ("saved", saved)]));
                    }
                    let attribution = if context["contextKind"] == "standalone" {
                        Value::object([
                            ("contextKind", Value::String("standalone".into())),
                            ("executionLaneId", context["executionLaneId"].clone()),
                            ("scratchRootId", context["scratchRootId"].clone()),
                            ("worktreeId", Value::Null),
                        ])
                    } else {
                        Value::object([
                            ("contextKind", Value::String("project".into())),
                            ("executionLaneId", context["executionLaneId"].clone()),
                            ("worktreeId", context["worktreeId"].clone()),
                            ("scratchRootId", Value::Null),
                        ])
                    };
                    let chat = text(&context["chatId"])?;
                    let mut nested = false;
                    let saved = if input["action"] == "task" {
                        transaction
                            .upsert_task_message(
                                &apply_owner,
                                &chat,
                                &input["message"],
                                Some(&attribution),
                            )
                            .boxed()
                            .await?
                    } else if input["action"] == "nested-error" {
                        nested = transaction
                            .upsert_encrypted_message(
                                &apply_owner,
                                &chat,
                                &input["message"],
                                Some(&attribution),
                            )
                            .boxed()
                            .await
                            .is_err();
                        None
                    } else {
                        transaction
                            .upsert_encrypted_message(
                                &apply_owner,
                                &chat,
                                &input["message"],
                                Some(&attribution),
                            )
                            .boxed()
                            .await?
                    };
                    if let Some(plan) = input.get("plan") {
                        transaction.update_encrypted_plan(&chat, plan).await?;
                    }
                    if input["action"] == "rollback" {
                        return Err(
                            CommandError::new("fixture-native-event-rollback", None, 409).into(),
                        );
                    }
                    Ok(Value::object([
                        ("context", context),
                        ("saved", saved.unwrap_or(Value::Null)),
                        ("nestedRejected", Value::Bool(nested)),
                    ]))
                })
            },
        )
        .boxed()
        .await
}
