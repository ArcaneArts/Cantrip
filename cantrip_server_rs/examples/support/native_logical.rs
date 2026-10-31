use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    native_commands::{Repository, context, turns},
    wire::Value,
};
use futures::FutureExt;
use std::sync::Arc;
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let repository = Repository::new(database.clone());
    let owner = input["owner"].as_str().context("Command fixture owner")?;
    let worker = input["worker"].as_str().unwrap_or("");
    let operation = input["operation"].as_str().unwrap_or("");
    Ok(
        match input["op"].as_str().context("Logical fixture operation")? {
            "native-command-observed-turn" | "native-command-observed-input" => {
                let (owner, worker, operation, generation) = (
                    owner.to_owned(),
                    worker.to_owned(),
                    operation.to_owned(),
                    input["generation"]
                        .as_str()
                        .context("Observed generation")?
                        .to_owned(),
                );
                let is_input = input["op"] == "native-command-observed-input";
                let backfill = input.get("backfill") != Some(&Value::Bool(false));
                database
                    .transaction(|tx| {
                        Box::pin(async move {
                            let row = context::read(
                                cantrip_server::database::Executor::Transaction(tx),
                                &owner,
                                &worker,
                                &operation,
                                &generation,
                            )
                            .boxed()
                            .await?;
                            Ok(if is_input {
                                turns::find_observed_input(tx, &row).boxed().await?
                            } else {
                                turns::find_observed_command(tx, &row, backfill)
                                    .boxed()
                                    .await?
                            }
                            .unwrap_or(Value::Null))
                        })
                    })
                    .boxed()
                    .await?
            }
            "native-command-logical-continue" => {
                repository
                    .continue_execution(owner, &input["input"])
                    .boxed()
                    .await?
            }
            "native-command-logical-root" => repository
                .logical_gui_outcome_root(owner, worker, &input["input"])
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "native-command-logical-finish" => Value::Bool(
                repository
                    .finish_logical_gui(
                        owner,
                        worker,
                        operation,
                        input["generation"].as_str().context("Logical generation")?,
                        input["status"].as_str().context("Logical status")?,
                    )
                    .boxed()
                    .await?,
            ),
            "native-command-logical-deferred" => Value::Bool(
                repository
                    .has_deferred_logical_gui(
                        owner,
                        worker,
                        operation,
                        input["generation"].as_str().context("Logical generation")?,
                    )
                    .boxed()
                    .await?,
            ),
            "native-command-logical-pending" => Value::Array(
                repository
                    .list_pending_logical_completions(input.get("limit").and_then(Value::as_f64))
                    .boxed()
                    .await?,
            ),
            "native-command-logical-get" => repository
                .get_logical_completion(
                    owner,
                    worker,
                    input["chat"].as_str().context("Logical chat")?,
                    operation,
                    input["generation"].as_str().context("Logical generation")?,
                )
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "native-command-logical-ack" => Value::Bool(
                repository
                    .acknowledge_logical_completion(
                        owner,
                        worker,
                        input["chat"].as_str().context("Logical chat")?,
                        operation,
                        input["generation"].as_str().context("Logical generation")?,
                    )
                    .boxed()
                    .await?,
            ),
            "native-command-logical-defer" => Value::Bool(
                repository
                    .defer_logical_completion(
                        owner,
                        worker,
                        input["chat"].as_str().context("Logical chat")?,
                        operation,
                        input["generation"].as_str().context("Logical generation")?,
                        &input["nextAttemptAt"],
                    )
                    .boxed()
                    .await?,
            ),
            _ => anyhow::bail!("Unknown logical fixture operation"),
        },
    )
}
