use super::{Authorized, Inner, now};
use crate::{
    encryption::{BoundComponentKey, Service},
    http::checked,
    task_content,
};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::content::{Communication, decrypt_private_label, encrypt_private_label};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::time::{Instant, sleep, sleep_until};

impl Inner {
    pub(super) async fn task(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let encryption = self
            .encryption
            .as_deref()
            .context("Task encryption is unavailable.")?;
        let binding = &authorization.active.binding;
        ensure!(
            binding["contextKind"] == "project"
                && encryption.bound_identity()?.0 == authorization.identity.0,
            "Task tools require the current project's authorized worker."
        );
        let tool = crate::mcp::bindings::TASK_TOOLS
            .iter()
            .find(|(candidate, _)| *candidate == operation)
            .map(|(_, tool)| *tool)
            .context("Unsupported Cantrip MCP Task operation.")?;
        let input = mcp_host::parse(&format!("mcpStdioInput/{tool}"), call.get("arguments"))
            .map_err(response_error)?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let mut response = match operation {
            "task.create" => {
                let arguments = create_task(encryption, authorization, &input)?;
                let mut response = self
                    .relay_task(authorization, operation, &arguments, &request_id)
                    .await?;
                response["data"]["taskId"] = arguments["task"]["chatId"].clone();
                response["data"]["operationId"] = input["operationId"].clone();
                response
            }
            "task.wait" => {
                self.wait_for_tasks(authorization, &input, &request_id)
                    .await?
            }
            _ => {
                self.relay_task(authorization, operation, &input, &request_id)
                    .await?
            }
        };

        verify_identity(self, authorization)?;
        open_titles(encryption, authorization, &mut response["data"])?;
        mcp_host::parse(&format!("mcpStdioOutput/{tool}"), Some(&response)).map_err(response_error)
    }

    async fn relay_task(
        &self,
        authorization: &Authorized,
        operation: &str,
        arguments: &Value,
        request_id: &str,
    ) -> Result<Value> {
        let mut result = self
            .relay_project(
                authorization,
                json!({"operation":operation,"arguments":arguments}),
                request_id,
            )
            .await?;
        result["data"] = checked("agentTaskStatusWireSchema", &result["data"])?;
        Ok(result)
    }

    async fn wait_for_tasks(
        &self,
        authorization: &Authorized,
        input: &Value,
        request_id: &str,
    ) -> Result<Value> {
        let mut ids = Vec::new();
        for task in input["taskIds"].as_array().unwrap() {
            if !ids.contains(task) {
                ids.push(task.clone());
            }
        }
        ensure!(
            !ids.contains(&authorization.active.binding["chatId"]),
            "A task cannot wait for itself."
        );
        let count = ids.len();
        let query = json!({"taskIds":ids});
        let mode = &input["mode"];
        let start = Instant::now();
        let timeout = Duration::from_millis(input["timeoutMs"].as_u64().unwrap());
        let expires = start
            + Duration::from_millis(authorization.expires_at.saturating_sub(now()).max(0) as u64);
        let mut stopped = authorization.active.stopped.subscribe();
        let poll = async {
            loop {
                let mut response = self
                    .relay_task(authorization, "task.status", &query, request_id)
                    .await?;
                let data = &mut response["data"];
                let finished: Vec<_> = data["tasks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|task| task["terminal"] == true)
                    .map(|task| task["id"].clone())
                    .collect();
                let satisfied = if mode == "any" {
                    !finished.is_empty()
                } else {
                    finished.len() == count
                };
                let timed_out = !satisfied && !timeout.is_zero() && start.elapsed() >= timeout;
                let summary = if satisfied {
                    "Task wait finished."
                } else if timed_out {
                    "Task wait timed out."
                } else if !data["missingTaskIds"].as_array().unwrap().is_empty() {
                    "A requested task is unavailable."
                } else {
                    let interval = Duration::from_secs(1);
                    sleep(if timeout.is_zero() {
                        interval
                    } else {
                        interval.min(timeout.saturating_sub(start.elapsed()))
                    })
                    .await;
                    continue;
                };
                data["mode"] = mode.clone();
                data["satisfied"] = json!(satisfied);
                data["timedOut"] = json!(timed_out);
                data["finishedTaskIds"] = json!(finished);
                response["summary"] = json!(summary);
                return Ok(response);
            }
        };
        tokio::select! {
            biased;
            _ = stopped.wait_for(|value| *value) => Err(anyhow!("Task wait stopped with its agent turn.")),
            _ = sleep_until(expires) => Err(anyhow!("Cantrip MCP binding has expired.")),
            result = poll => result,
        }
    }
}

fn verify_identity(service: &Inner, authorization: &Authorized) -> Result<()> {
    ensure!(
        (service.identity)().as_ref().ok() == Some(&authorization.identity),
        "The managed Task attachment was replaced."
    );
    Ok(())
}

fn verify_grant(grant: &BoundComponentKey, authorization: &Authorized) -> Result<()> {
    ensure!(
        grant.owner_id == authorization.identity.0
            && grant.server_id.as_js_string() == Some(&authorization.identity.1),
        "The worker binding changed during protected Task processing."
    );
    Ok(())
}

fn create_task(service: &Service, authorization: &Authorized, input: &Value) -> Result<Value> {
    let caller = authorization.active.binding["chatId"].as_str().unwrap();
    let operation_id = input["operationId"].as_str().unwrap();
    let digest: String = Sha256::digest(format!("agent-task:{caller}:{operation_id}"))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let id = format!(
        "{}-{}-5{}-a{}-{}",
        &digest[..8],
        &digest[8..12],
        &digest[13..16],
        &digest[17..20],
        &digest[20..32]
    );
    let content = checked(
        "taskProtectedContentSchema",
        &json!({
            "version":1,
            "classification":json!({
                "state":"draft","stableStateBeforeFailure":Value::Null,
                "activeOperationKind":Value::Null,"planAuthorship":"agent","planningRound":0,
                "hasPlan":false,"hasQuestions":false,"hasFinalPlan":false,"hasGoalPrompt":false,
                "lastError":Value::Null,
            }),
            "briefMarkdown":input["description"],"planMarkdown":Value::Null,
            "currentQuestions":Vec::<Value>::new(),"currentAnswers":Vec::<Value>::new(),
            "additionalDirection":"","finalPlanMarkdown":Value::Null,"goalPrompt":Value::Null,
            "lastError":Value::Null,
        }),
    )?;
    let label = input["title"].as_js_string().cloned().unwrap_or_else(|| {
        let description = input["description"].as_js_string().unwrap().units();
        let first = description.split(|unit| *unit == 10).next().unwrap();
        let first = first.strip_suffix(&[13]).unwrap_or(first);
        JsString::new(first.iter().take(100).copied().collect())
    });
    let title_grant = service.bound_component("private-surface-metadata", None)?;
    verify_grant(&title_grant, authorization)?;
    let title = encrypt_private_label(
        &title_grant.component.key,
        &json!({"ownerId":title_grant.owner_id,"keyRevision":title_grant.component.key_revision,"recordKind":"chat","rowId":id}),
        &json!(label),
    )?;
    let task_grant = service.bound_component("task-content", None)?;
    verify_grant(&task_grant, authorization)?;
    let task = task_content::opaque(
        Communication::Task,
        &task_grant.component.key,
        &json!({"ownerId":task_grant.owner_id,"keyRevision":task_grant.component.key_revision,"chatId":id}),
        &content,
    )?;
    checked(
        "agentTaskCreateWireSchema",
        &json!({
            "operationId":operation_id,
            "task":json!({"chatId":id,"planGoalEnabled":false,"autoTitle":false,"titleProtection":title,"task":task}),
        }),
    )
}

fn open_titles(service: &Service, authorization: &Authorized, data: &mut Value) -> Result<()> {
    let mut tasks = Vec::new();
    for record in data["tasks"].as_array().unwrap() {
        let mut record = record.as_object().unwrap().clone();
        let protection = record
            .shift_remove(&JsString::from("titleProtection"))
            .unwrap();
        let id = &record[&JsString::from("id")];
        let revision = protection["protectedLabel"]["keyRevision"]
            .as_u64()
            .unwrap();
        let mut title = json!(format!("Task {}", id.as_str().unwrap()));
        if let Ok(grant) = service.bound_component("private-surface-metadata", Some(revision)) {
            verify_grant(&grant, authorization)?;
            if let Ok(opened) = decrypt_private_label(
                &grant.component.key,
                &json!({"ownerId":grant.owner_id,"keyRevision":revision,"recordKind":"chat","rowId":id}),
                &protection,
            ) {
                title = opened;
            }
        }
        record.insert("title".into(), title);
        tasks.push(Value::Object(record));
    }
    data["tasks"] = json!(tasks);
    Ok(())
}
