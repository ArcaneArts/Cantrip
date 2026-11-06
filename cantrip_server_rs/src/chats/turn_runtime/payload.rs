use super::{
    bootstrap::PreparedTurn,
    events::{EventSink, text},
};
use crate::{
    chats::{Repository, managed_console, runtime_telemetry::RuntimeTelemetry, turn_storage},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
use indexmap::IndexSet;
use std::sync::OnceLock;

pub fn mentioned_skills(text: &Value) -> Result<Vec<Value>> {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(r"(?:^|[^A-Za-z0-9_$])\$([A-Za-z0-9][A-Za-z0-9_.:-]*)").unwrap()
    });
    let text = text.as_js_string().context("Skill mention text")?.lossy();
    let mut names = IndexSet::new();
    for captures in pattern.captures_iter(&text) {
        names.insert(captures[1].to_owned());
    }
    Ok(names.into_iter().map(|s| json!(s)).collect())
}
pub fn preview_authority(turn: &PreparedTurn, server: &str) -> Result<Value> {
    let mut authority =
        crate::chats::computer_use_authority::preview(&turn.owner, server, &turn.execution)?;
    authority["executionLaneId"] = turn.execution["executionLaneId"].clone();
    Ok(authority)
}
impl EventSink {
    pub async fn command(&self, server: &str) -> Result<Value> {
        let t = &self.turn;
        let e = &t.execution;
        let runtime = self.runtime.lock().unwrap().clone();
        let thread = if RuntimeTelemetry::can_resume(e, &runtime) {
            e["threadId"].clone()
        } else {
            Value::Null
        };
        let requested = t
            .task_relay
            .as_ref()
            .map(|v| &v["prompt"])
            .or_else(|| t.options.get("workerPrompt").filter(|v| !v.is_null()))
            .or_else(|| t.input.get("text").filter(|v| truthy(Some(v))))
            .cloned()
            .unwrap_or_else(|| json!("Review the attached files and respond to the user."));
        let mut command = json!({"type":"chat.turn","executionProfile":if e["contextKind"]=="standalone" {"standalone-chat"}else if e.get("osExecution").is_some(){"cantrip-os"}else{"ide"},"contextKind":e["contextKind"],"chatId":e["chatId"],"clientMessageId":t.user_message["id"],"cwd":e["cwd"],"executionLaneId":e["executionLaneId"],"worktreeId":e["worktreeId"],"scratchRootId":e["scratchRootId"],"rootKind":e["rootKind"],"threadId":thread,"isPrimary":e["isPrimary"],"worktreeMode":e["worktreeMode"],"worktreePolicy":e["worktreePolicy"],"policyProjectId":e["projectId"],"policies":t.effective_policies,"standalonePolicies":t.standalone_policies,"model":runtime["model"],"provider":runtime["provider"],"permissionProfileId":managed_console::permission_profile(e)["effectiveId"],"planMode":t.turn_plan_mode,"mcpServers":t.mcp_servers,"automationPaused":e["automationPaused"]});
        if let Some(job) = t.options.get("initialLabel") {
            let mut state = self.turn_state.lock().unwrap();
            if !state.initial_label_sent {
                command["initialLabel"] = job.clone();
                state.initial_label_sent = true;
            }
        }
        if let Some(os) = e.get("osExecution") {
            command["osExecution"] = os.clone();
        }
        if let Some(receipt) = &t.native_receipt {
            command["nativeCommandReceipt"] = receipt.clone();
        }
        for key in [
            "protectedNativeInput",
            "nativeClientUserMessageId",
            "queuedPromptId",
            "taskDispatchLease",
        ] {
            if let Some(value) = t.options.get(key) {
                command[key] = value.clone();
            }
        }
        if e["computerUseEnabled"] == true {
            command["computerUseAuthority"] = preview_authority(t, server)?;
        }
        let (history, plan) = if let Some(encrypted) = &t.encrypted_chat {
            command["protectedPrompt"] = encrypted["userMessage"].clone();
            (
                t.protected_history.clone(),
                t.protected_plan.clone().unwrap_or(Value::Null),
            )
        } else if let Some(encrypted) = t.encrypted_task.as_ref().filter(|_| t.task_relay.is_none())
        {
            command["protectedTaskPrompt"] = encrypted["userMessage"].clone();
            (Vec::new(), Value::Null)
        } else {
            command["prompt"] = requested;
            (Vec::new(), Value::Null)
        };
        command["protectedHistory"] = Value::Array(history);
        command["protectedPlan"] = plan;
        command["attachments"] = Value::Array(
            t.attachments
                .iter()
                .map(turn_storage::attachment_summary)
                .collect(),
        );
        command["skillNames"] = Value::Array(
            if e["contextKind"] == "standalone"
                || truthy(t.options.get("structuredResult"))
                || t.encrypted_chat.is_some()
            {
                Vec::new()
            } else {
                mentioned_skills(&t.input["text"])?
            },
        );
        command["chatSkillAudienceKeys"] = Value::Array(if e["contextKind"] == "standalone" {
            Repository::new(self.dependencies.database.clone())
                .skill_audience_keys(
                    &t.owner,
                    &text(&e["workerId"])?,
                    &text(&runtime["provider"]["id"])?,
                )
                .await?
        } else {
            Vec::new()
        });
        command["subagentDefaults"] = if let Some(child) = self
            .subagent
            .as_ref()
            .filter(|_| e["contextKind"] == "project")
        {
            json!({"model":child["model"],"provider":child["provider"]})
        } else {
            Value::Null
        };
        if e["contextKind"] == "project"
            && t.attributed_worker.as_ref().is_some_and(|v| {
                v["codexRuntime"]["nativeSubagents"]["available"] == true
                    && v["codexRuntime"]["nativeSubagents"]["protocolVersion"] == 1
            })
        {
            command["subagentProtocolVersion"] = json!(1);
        }
        command["resultMode"] = if let Some(structured) = t
            .options
            .get("structuredResult")
            .filter(|v| truthy(Some(v)))
        {
            t.task_relay
                .as_ref()
                .map(|v| v["resultMode"].clone())
                .unwrap_or_else(
                    || json!({"kind":"structured","outputSchema":structured["outputSchema"]}),
                )
        } else if let Some(task) = t
            .encrypted_task
            .as_ref()
            .filter(|v| truthy(v.get("response")))
        {
            json!({"kind":"task-message-encrypted","messageId":task["response"]["id"],"idempotencyKey":task["response"]["idempotencyKey"]})
        } else if let Some(chat) = &t.encrypted_chat {
            json!({"kind":"chat-message-encrypted","messageId":chat["response"]["id"],"idempotencyKey":chat["response"]["idempotencyKey"]})
        } else {
            json!({"kind":"visible"})
        };
        if (t.task_relay.is_some()
            || (t.encrypted_task.is_some() && t.user_message["mode"] == "goal"))
            && truthy(t.options.get("taskDispatchLease"))
        {
            let lease = &t.options["taskDispatchLease"];
            let mut task_input = json!({
                "chatId":e["chatId"],"clientMessageId":t.user_message["id"],"workerId":e["workerId"],"worktreeId":e["worktreeId"],"executionLaneId":e["executionLaneId"],"executionLaneActivatedAt":e["executionLaneActivatedAt"],"providerId":runtime["provider"]["id"],"modelRouteId":runtime["routeId"],"providerAccountId":runtime["provider"]["accountId"],
                "dispatch":json!({"cycleId":lease["cycleId"],"operationId":lease["operationId"],"leaseOwner":lease["leaseOwner"],"fencingToken":lease["fencingToken"]})
            });
            if t.task_relay.is_none() {
                task_input["kind"] = json!("goal");
            }
            let tasks = crate::tasks::Repository::new(self.dependencies.database.clone());
            command["taskInferenceInput"] = if !t.options["taskResumption"].is_null() {
                command["taskResumption"] = t.options["taskResumption"].clone();
                command["automationPaused"] = json!(false);
                tasks.prepare_resumption_input(&t.owner, &json!({"resumption":t.options["taskResumption"],"lease":lease,"expectedInputRevision":t.options["expectedInputRevision"]})).await?
            } else {
                tasks
                    .prepare_inference_input_at_revision(
                        &t.owner,
                        &task_input,
                        t.options
                            .get("expectedInputRevision")
                            .filter(|revision| !revision.is_null())
                            .map(|revision| {
                                revision.as_i64().context("Task input control revision")
                            })
                            .transpose()?,
                    )
                    .await?
            };
            *self.task_input_operation.lock().unwrap() =
                Some(command["taskInferenceInput"]["operationId"].clone());
        }
        Ok(command)
    }
}
