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
    if input["op"] == "native-command-task-queue" {
        return super::turn_execution::run(database, input).boxed();
    }
    if input["op"] == "native-command-task-eligibility" {
        return super::task_eligibility::run(database, input).boxed();
    }
    if input["op"] == "native-command-task-workers" {
        return super::task_workers::run(database, input).boxed();
    }
    if input["op"] == "native-command-task-retry" {
        return super::task_retries::run(database, input).boxed();
    }
    if input["op"] == "native-command-task-scheduler" {
        return super::task_scheduler::run(database, input).boxed();
    }
    if input["op"] == "native-command-task" {
        return super::tasks::run(database, input).boxed();
    }
    if input["op"] == "native-command-account-prepare" {
        return super::account_failover::run(database, input).boxed();
    }
    if input["op"] == "native-command-runtime-handoff" {
        return super::native_handoffs::run(database, input).boxed();
    }
    if input["op"] == "native-command-turn-execution"
        || input["op"] == "native-command-automatic-title"
        || input["op"] == "native-command-recovery"
        || input["op"] == "native-command-task-goal"
        || input["op"] == "native-command-task-automatic"
        || input["op"] == "native-command-task-claimed"
        || input["op"] == "native-command-task-background"
        || input["op"] == "native-command-turn-outcome"
        || input["op"] == "native-command-automation-pause"
    {
        return super::turn_execution::run(database, input).boxed();
    }
    if input["op"] == "native-command-turn-bootstrap" {
        return super::turn_bootstrap::run(database, input).boxed();
    }
    if input["op"] == "native-command-turn-live" {
        return super::turn_live::run(database, input).boxed();
    }
    if input["op"] == "native-command-task-lease" {
        return super::task_dispatch_lease::run(database, input).boxed();
    }
    if input["op"] == "native-command-gui-quota" {
        return super::runtime_quota::run(database, input).boxed();
    }
    if input["op"] == "native-command-gui-telemetry"
        && input["action"]
            .as_str()
            .is_some_and(|v| v.starts_with("runtime-"))
    {
        return super::runtime_telemetry::run(database, input).boxed();
    }
    if input["op"] == "native-command-gui-behavior" {
        return async move { super::turn_behavior::run(input) }.boxed();
    }
    if matches!(
        input["op"].as_str(),
        Some("native-command-gui-placement" | "native-command-gui-worktree")
    ) {
        return super::turn_placement::run(database, input).boxed();
    }
    if input["op"] == "native-command-receipt-handler" {
        return super::receipt_handler::run(database, input).boxed();
    }
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
        Some("native-command-gui-telemetry") => async move {
            let settings = cantrip_server::settings::repository::SettingsRepository::new(database);
            match input["action"].as_str() {
                Some("behavior") => {
                    settings
                        .record_model_behavior_observation(owner, &input["record"])
                        .await?
                }
                Some("usage") => settings.record_token_usage(owner, &input["record"]).await?,
                _ => anyhow::bail!("Unknown GUI telemetry fixture operation"),
            }
            Ok(Value::Null)
        }
        .boxed(),
        Some("native-command-gui-protect") => async move {
            let trace = Arc::new(std::sync::Mutex::new(None));
            let request = input.clone();
            let protection = cantrip_server::chats::protect_input::InputProtection::with_request({
                let trace = trace.clone();
                Arc::new(move |worker, command| {
                    let (trace, request) = (trace.clone(), request.clone());
                    async move {
                        *trace.lock().unwrap() = Some(Value::object([
                            ("worker", Value::from_serialize(&worker)),
                            ("command", command),
                        ]));
                        anyhow::ensure!(
                            request["failRequest"] != true,
                            "Controlled protection failure"
                        );
                        Ok(request.get("response").cloned())
                    }
                    .boxed()
                })
            });
            let empty = Value::object([] as [(&str, Value); 0]);
            let result = protection
                .protect(
                    worker,
                    input
                        .get("input")
                        .filter(|v| !v.is_null())
                        .unwrap_or(&empty),
                    input["attachments"]
                        .as_array()
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                    input.get("reasoningEffort"),
                    input.get("role"),
                )
                .await?;
            let mut output = trace
                .lock()
                .unwrap()
                .take()
                .context("Protection fixture request")?;
            output["result"] = result;
            Ok(output)
        }
        .boxed(),
        Some("native-command-gui-validate") => async move {
            let empty = Value::object([] as [(&str, Value); 0]);
            cantrip_server::chats::turn_configuration::validate(
                &input["context"],
                input
                    .get("input")
                    .filter(|v| !v.is_null())
                    .unwrap_or(&empty),
                input
                    .get("options")
                    .filter(|v| !v.is_null())
                    .unwrap_or(&empty),
            )?;
            Ok(Value::Null)
        }
        .boxed(),
        Some("native-command-gui-configuration") => async move {
            let empty = Value::object([] as [(&str, Value); 0]);
            cantrip_server::chats::turn_configuration::model_configuration(
                &input["context"],
                input
                    .get("input")
                    .filter(|v| !v.is_null())
                    .unwrap_or(&empty),
                input.get("model"),
            )
        }
        .boxed(),
        Some("native-command-gui-acquire") => async move {
            let context = if let Some(context) = input.get("context") {
                context.clone()
            } else {
                cantrip_server::chats::Repository::new(database.clone())
                    .execution_context(owner, input["chat"].as_str().context("GUI chat")?)
                    .await?
                    .context("GUI fixture context")?
            };
            cantrip_server::native_commands::runtime::gui_admission::GuiAdmission::new(database)
                .acquire(
                    owner,
                    &context,
                    input.get("options").unwrap_or(&Value::Null),
                    input.get("protectedInput"),
                )
                .await
        }
        .boxed(),
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
