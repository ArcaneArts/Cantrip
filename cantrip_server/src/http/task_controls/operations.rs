//! HTTP admission delegates to the concrete queue and retained-session recovery
//! actors, including their durable receipts, retry resets and scheduler wakeups.
use super::*;
use crate::{chats, wire::coercion::truthy, workers::command_bus::CommandFailure};

fn request_failure(cause: anyhow::Error, mutation: bool) -> Result<Response> {
    let cause = if mutation {
        match mutation_error(cause) {
            Ok(response) => return Ok(response),
            Err(cause) => cause,
        }
    } else {
        cause
    };
    if let Some(failure) = downcast_ref::<crate::projects::worktrees::MutationError>(&cause) {
        return output(
            if failure.failure["mutation"]["outcome"] == "notStarted" {
                404
            } else {
                502
            },
            "worktreeCreateMutationFailureSchema",
            &failure.failure,
        );
    }
    Ok(error(
        downcast_ref::<CommandFailure>(&cause).map_or(502, |failure| failure.status(502)),
        crate::settings::operation_error_message(&cause),
    ))
}

pub(super) async fn execute(
    service: Arc<AuthService>,
    owner: String,
    chat: String,
    path: String,
    body: Option<Value>,
) -> Result<Response> {
    let repository = tasks::Repository::new(service.repository.database.clone());
    let recovering = path.ends_with("/recover");
    let retrying = path.ends_with("/retry");
    let empty = Value::object([] as [(&str, Value); 0]);
    let input = if recovering {
        parse(
            "taskRecoveryStartSchema",
            Some(body.as_ref().filter(|v| !v.is_null()).unwrap_or(&empty)),
        )?
    } else {
        parse("taskOperationStartSchema", body.as_ref())?
    };
    let mut legacy_kind = None;
    let input = match input {
        Ok(input) => input,
        Err(plain_failure) if retrying => {
            match parse("taskEncryptedOperationStartSchema", body.as_ref())? {
                Ok(encrypted) => {
                    legacy_kind = Some(encrypted["operation"]["classification"]["kind"].clone());
                    json!({"operationId":encrypted["operation"]["operationId"],"rowVersion":encrypted["rowVersion"]})
                }
                Err(_) => return Ok(plain_failure),
            }
        }
        Err(response) => return Ok(response),
    };
    let context = chats::Repository::new(service.repository.database.clone())
        .execution_context(&owner, &chat)
        .await?;
    if !context
        .as_ref()
        .is_some_and(|context| context["experience"] == "task")
    {
        return Ok(error(404, "Task not found."));
    }
    let retries = tasks::retries::Repository::new(service.repository.database.clone());
    let result: Result<Response> = async {
        if recovering {
            let target = repository.get(&owner, &chat).await?.unwrap_or(Value::Null);
            if target["planGoalEnabled"] == true && target["dispatch"]["operationKind"] == "finalize" {
                retries.reset(&owner, &chat).await?;
            }
            if !service.execution.task_recovery.recover(&owner, &chat, true, false).await? {
                return Ok(error(409, "No retained implementation session was found. Use Retry implementation from the plan to start it."));
            }
            return output(200, "taskOpaqueSummarySchema", &repository.get(&owner, &chat).await?.unwrap_or(Value::Null));
        }
        if retrying {
            let mut task = repository.get(&owner, &chat).await?.unwrap_or(Value::Null);
            if task["state"] == "implementing" && truthy(task.get("hasFinalPlan")) && truthy(task.get("hasGoalPrompt")) {
                return output(202, "taskOpaqueSummarySchema", &task);
            }
            if task["state"] != "failed" || !truthy(task.get("lastError")) {
                return Ok(error(409, "This Task has no failed operation to retry."));
            }
            retries.reset(&owner, &chat).await?;
            if task["lastError"]["operationKind"] == "implementation" {
                return Ok(error(409, "Use the implementation Goal controls to resume or restart this Task."));
            }
            if legacy_kind.as_ref().is_some_and(|kind| kind != &task["lastError"]["operationKind"]) {
                return Ok(error(409, "The encrypted retry does not match the failed operation."));
            }
            task["rowVersion"] = input["rowVersion"].clone();
            return match service.execution.queue.retry(&owner, &task, Some(&input["operationId"]), false).await? {
                Some(task) => output(202, "taskOpaqueSummarySchema", &task),
                None => Ok(error(404, "Task not found.")),
            };
        }
        let kind = if path.ends_with("/start") { "direct" }
            else if path.ends_with("/plan") { "initial-plan" }
            else if path.ends_with("/continue") { "continue-plan" }
            else { "finalize" };
        match service.execution.queue.queue(&owner, &chat, &input, kind, false).await? {
            Some(task) => output(202, "taskOpaqueSummarySchema", &task),
            None => Ok(error(404, "Task not found.")),
        }
    }.await;
    match result {
        Ok(response) => Ok(response),
        Err(cause) => request_failure(cause, !recovering),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn recovery_keeps_worker_failure_status_for_a_typed_task_conflict() {
        for mutation in [false, true] {
            let response = request_failure(
                tasks::Conflict {
                    code: "stale-version",
                    message: "The Task changed in another client.",
                }
                .into(),
                mutation,
            )
            .unwrap();
            assert_eq!(response.status().as_u16(), if mutation { 409 } else { 502 });
            let body = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let expected = if mutation {
                serde_json::json!({"code":"stale-version","error":"The Task changed in another client."})
            } else {
                serde_json::json!({"error":"The Task changed in another client."})
            };
            assert_eq!(body, expected);
        }
    }
}
