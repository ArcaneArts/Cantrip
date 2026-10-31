use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    native_commands::{Repository, context},
    wire::Value,
};
use futures::FutureExt;
use std::sync::Arc;

pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    if input["op"] == "native-command-interaction" {
        return super::agent_interactions::run(database, input)
            .boxed()
            .await;
    }
    if input["op"] == "native-command-event-context" {
        return super::native_events::run(database, input).boxed().await;
    }
    if input["op"]
        .as_str()
        .is_some_and(|op| op.starts_with("native-command-managed-queue-"))
    {
        return super::managed_queue::run(database, input).boxed().await;
    }
    if input["op"]
        .as_str()
        .is_some_and(|op| op.starts_with("native-command-prompt-"))
    {
        return super::queued_prompts::run(database, input).boxed().await;
    }
    if input["op"]
        .as_str()
        .is_some_and(|op| op.starts_with("native-command-lane-"))
    {
        return super::execution_lanes::run(database, input).boxed().await;
    }
    if input["op"]
        .as_str()
        .is_some_and(|op| op.starts_with("native-command-settings-"))
    {
        return super::native_settings::run(database, input).boxed().await;
    }
    if input["op"].as_str().is_some_and(|op| {
        op.starts_with("native-command-logical-") || op.starts_with("native-command-observed-")
    }) {
        return super::native_logical::run(database, input).boxed().await;
    }
    let repository = Repository::new(database.clone());
    let owner = input["owner"].as_str().context("Command fixture owner")?;
    let worker = input["worker"].as_str().unwrap_or("");
    let operation = input["operation"].as_str().unwrap_or("");
    Ok(
        match input["op"].as_str().context("Command fixture operation")? {
            "native-command-recovery-context" => repository
                .recovery_context(owner, input["chat"].as_str().context("Recovery chat")?)
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "native-command-recover" => Value::from_serialize(
                &repository
                    .recover_execution(owner, worker, &input["expected"], &input["observed"])
                    .boxed()
                    .await?,
            ),
            "native-command-settle" => repository.settle(owner, &input["input"]).boxed().await?,
            "native-command-evidence" => {
                repository
                    .record_settings_evidence(owner, &input["input"])
                    .boxed()
                    .await?
            }
            "native-command-stop-autonomy" => Value::from_serialize(
                &repository
                    .stop_autonomy(
                        owner,
                        input["chat"].as_str().context("Control chat")?,
                        input["expected"].as_str(),
                    )
                    .await?,
            ),
            "native-command-resume-autonomy" => {
                repository
                    .resume_autonomy(owner, input["chat"].as_str().context("Control chat")?)
                    .await?;
                Value::Null
            }
            "native-command-cancel-preparing" => repository
                .cancel_preparing(
                    owner,
                    input["chat"].as_str().context("Control chat")?,
                    input["generation"].as_str().context("Control generation")?,
                )
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "native-command-control-context" => {
                repository
                    .control_context(owner, input["chat"].as_str().context("Control chat")?)
                    .await?
            }
            "native-command-finish-execution" => Value::from_serialize(
                &repository
                    .finish_execution(
                        owner,
                        worker,
                        operation,
                        input["generation"].as_str().context("Control generation")?,
                        input["status"].as_str().context("Control status")?,
                    )
                    .boxed()
                    .await?,
            ),
            "native-command-dispatch" => {
                repository.dispatch(owner, &input["input"]).boxed().await?
            }
            "native-command-register-pending" => {
                repository.register_pending(owner, &input["input"]).await?;
                Value::Null
            }
            "native-command-bind-preparation" => {
                repository.bind_preparation(owner, &input["input"]).await?
            }
            "native-command-existing-admission" => {
                repository
                    .admit(
                        owner,
                        &input["input"],
                        input.get("options").unwrap_or(&Value::Null),
                    )
                    .boxed()
                    .await?
            }
            "native-command-admit" => {
                repository
                    .admit(
                        owner,
                        &input["input"],
                        input.get("options").unwrap_or(&Value::Null),
                    )
                    .boxed()
                    .await?
            }
            "native-command-lookup" => repository
                .lookup(owner, worker, operation)
                .await?
                .unwrap_or(Value::Null),
            "native-command-get" => {
                repository
                    .get(
                        owner,
                        worker,
                        operation,
                        input["generation"].as_str().context("Command generation")?,
                    )
                    .await?
            }
            "native-command-context" | "native-command-locked-context" => {
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
                    .await?
            }
            _ => anyhow::bail!("Unknown native command fixture operation"),
        },
    )
}
