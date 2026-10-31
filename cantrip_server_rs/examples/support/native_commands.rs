use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    native_commands::{Repository, context},
    wire::Value,
};
use futures::{FutureExt, future::BoxFuture};
use std::sync::Arc;

// A synchronous selector drops its construction frame before polling the chosen
// operation. The former umbrella async match retained 214064 bytes on Windows,
// pushing real nested lane admission beyond the fixture's 1 MiB thread stack.
pub fn run(database: Arc<Database>, input: &Value) -> BoxFuture<'_, Result<Value>> {
    if input["op"] == "native-command-interaction" {
        return super::agent_interactions::run(database, input).boxed();
    }
    if input["op"] == "native-command-event-context" {
        return super::native_events::run(database, input).boxed();
    }
    let operation = input["op"].as_str().unwrap_or("");
    if operation.starts_with("native-command-managed-queue-") {
        return super::managed_queue::run(database, input).boxed();
    }
    if operation.starts_with("native-command-prompt-") {
        return super::queued_prompts::run(database, input).boxed();
    }
    if operation.starts_with("native-command-lane-") {
        return super::execution_lanes::run(database, input).boxed();
    }
    if operation.starts_with("native-command-settings-") {
        return super::native_settings::run(database, input).boxed();
    }
    if operation.starts_with("native-command-logical-")
        || operation.starts_with("native-command-observed-")
    {
        return super::native_logical::run(database, input).boxed();
    }
    async move {
        let owner = input["owner"].as_str().context("Command fixture owner")?;
        let worker = input["worker"].as_str().unwrap_or("");
        let operation = input["operation"].as_str().unwrap_or("");
        execute(database, input, owner, worker, operation).await
    }
    .boxed()
}

fn execute<'a>(
    database: Arc<Database>,
    input: &'a Value,
    owner: &'a str,
    worker: &'a str,
    operation: &'a str,
) -> BoxFuture<'a, Result<Value>> {
    let repository = Repository::new(database.clone());
    match input["op"].as_str() {
        Some("native-command-recovery-context") => async move {
            Ok(repository
                .recovery_context(owner, input["chat"].as_str().context("Recovery chat")?)
                .await?
                .unwrap_or(Value::Null))
        }
        .boxed(),
        Some("native-command-recover") => async move {
            Ok(Value::from_serialize(
                &repository
                    .recover_execution(owner, worker, &input["expected"], &input["observed"])
                    .await?,
            ))
        }
        .boxed(),
        Some("native-command-settle") => {
            async move { repository.settle(owner, &input["input"]).await }.boxed()
        }
        Some("native-command-evidence") => async move {
            repository
                .record_settings_evidence(owner, &input["input"])
                .await
        }
        .boxed(),
        Some("native-command-stop-autonomy") => async move {
            Ok(Value::from_serialize(
                &repository
                    .stop_autonomy(
                        owner,
                        input["chat"].as_str().context("Control chat")?,
                        input["expected"].as_str(),
                    )
                    .await?,
            ))
        }
        .boxed(),
        Some("native-command-resume-autonomy") => async move {
            repository
                .resume_autonomy(owner, input["chat"].as_str().context("Control chat")?)
                .await?;
            Ok(Value::Null)
        }
        .boxed(),
        Some("native-command-cancel-preparing") => async move {
            Ok(repository
                .cancel_preparing(
                    owner,
                    input["chat"].as_str().context("Control chat")?,
                    input["generation"].as_str().context("Control generation")?,
                )
                .await?
                .unwrap_or(Value::Null))
        }
        .boxed(),
        Some("native-command-control-context") => async move {
            repository
                .control_context(owner, input["chat"].as_str().context("Control chat")?)
                .await
        }
        .boxed(),
        Some("native-command-finish-execution") => async move {
            Ok(Value::from_serialize(
                &repository
                    .finish_execution(
                        owner,
                        worker,
                        operation,
                        input["generation"].as_str().context("Control generation")?,
                        input["status"].as_str().context("Control status")?,
                    )
                    .await?,
            ))
        }
        .boxed(),
        Some("native-command-dispatch") => {
            async move { repository.dispatch(owner, &input["input"]).await }.boxed()
        }
        Some("native-command-register-pending") => async move {
            repository.register_pending(owner, &input["input"]).await?;
            Ok(Value::Null)
        }
        .boxed(),
        Some("native-command-bind-preparation") => {
            async move { repository.bind_preparation(owner, &input["input"]).await }.boxed()
        }
        Some("native-command-existing-admission" | "native-command-admit") => async move {
            repository
                .admit(
                    owner,
                    &input["input"],
                    input.get("options").unwrap_or(&Value::Null),
                )
                .await
        }
        .boxed(),
        Some("native-command-lookup") => async move {
            Ok(repository
                .lookup(owner, worker, operation)
                .await?
                .unwrap_or(Value::Null))
        }
        .boxed(),
        Some("native-command-get") => async move {
            repository
                .get(
                    owner,
                    worker,
                    operation,
                    input["generation"].as_str().context("Command generation")?,
                )
                .await
        }
        .boxed(),
        Some("native-command-context" | "native-command-locked-context") => async move {
            let chat = input["chat"]
                .as_str()
                .context("Command fixture Chat")?
                .to_owned();
            let owner = owner.to_owned();
            let locked = input["op"] == "native-command-locked-context";
            database
                .transaction(|tx| {
                    Box::pin(async move {
                        if locked {
                            context::lock_chat(tx, &owner, &chat).await?;
                        }
                        Ok(context::execution(tx, &owner, &chat)
                            .await?
                            .unwrap_or(Value::Null))
                    })
                })
                .await
        }
        .boxed(),
        _ => async move {
            input["op"].as_str().context("Command fixture operation")?;
            anyhow::bail!("Unknown native command fixture operation")
        }
        .boxed(),
    }
}
