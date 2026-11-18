use super::*;
use crate::{chat_content::Scope, codex::preparation::command::LiveThread, http::checked};

impl Goals {
    pub(crate) async fn get(&self, command: &Value) -> Result<Value> {
        if command["osExecution"].is_object() {
            bail!("Native observation of an OS-hosted Goal is unavailable.");
        }
        let bound = self.encryption.bound_identity()?;
        let thread = target_thread(command)?;
        let LiveThread { runtime, .. } = self.metadata_thread(command, &bound, thread).await?;
        let goal = verify_goal(
            thread,
            &rpc(&runtime, "thread/goal/get", json!({"threadId":thread})).await?,
        )?;
        let execution = if command["observeExecution"] == true {
            Some(execution_status(&runtime, thread).await?)
        } else {
            None
        };
        self.render(command, &bound, goal, execution)
    }

    pub(super) async fn metadata_thread(
        &self,
        command: &Value,
        bound: &(JsString, Value),
        thread: &JsString,
    ) -> Result<LiveThread> {
        let chat = command["chatId"]
            .as_js_string()
            .context("Missing Goal chat.")?;
        match self.preparation.live_thread(chat, thread, bound) {
            Some(live) => Ok(live),
            None => Ok(LiveThread {
                runtime: self.observation.open_runtime(command, bound).await?,
                session: None,
            }),
        }
    }

    pub(super) fn render(
        &self,
        command: &Value,
        bound: &(JsString, Value),
        goal: Value,
        execution: Option<&str>,
    ) -> Result<Value> {
        if &self.encryption.bound_identity()? != bound {
            bail!("The worker binding changed during Goal observation.");
        }
        if command["taskContext"].is_object() {
            let (binding, scope, current) = self.open_task(command)?;
            if binding.owner_id != bound.0 || binding.server_id != bound.1 {
                bail!("The worker binding changed during Goal observation.");
            }
            let mut context = command["taskContext"].clone();
            if let Some(status) = execution {
                context["chatStatus"] = json!(status);
                if status == "running" {
                    context["runtimeFailure"] = Value::Null;
                }
            }
            let mut projected =
                projection::started(&binding.component.key, &scope, &current, &context, &goal)?;
            if let Some(status) = execution {
                projected["execution"] = json!({"threadId":command["threadId"],"status":status});
            }
            self.assert_bound(&binding)?;
            checked("taskGoalWorkerResultSchema", &projected)
        } else if command["protectObjective"] == true {
            let mut goal = goal;
            if let Value::Object(fields) = &mut goal {
                let objective = fields
                    .shift_remove("objective")
                    .context("Missing Goal objective.")?;
                let scope = Scope::new(self.encryption.clone())?;
                if scope.owner != bound.0 || bound.1.as_js_string() != Some(&scope.server) {
                    bail!("The worker binding changed during Goal observation.");
                }
                let id = uuid::Uuid::new_v4().to_string();
                goal["protectedObjective"] = scope.protect(&json!({
                    "id":id, "role":"user", "mode":"goal", "reasoningEffort":Value::Null,
                    "idempotencyKey":format!("goal-snapshot:{id}"),
                    "content":[json!({"type":"text","text":objective})],
                }))?;
            }
            checked(
                "chatGoalWireResponseSchema",
                &json!({"kind":"chat-encrypted","goal":goal}),
            )
        } else {
            Ok(json!({"goal":goal}))
        }
    }
}

pub(super) fn target_thread(command: &Value) -> Result<&JsString> {
    command["threadId"]
        .as_js_string()
        .context("Missing Goal thread.")
}

async fn execution_status(runtime: &Runtime, thread: &JsString) -> Result<&'static str> {
    let snapshot = rpc(
        runtime,
        "thread/read",
        json!({"threadId":thread, "includeTurns":false}),
    )
    .await?;
    let observed = &snapshot["thread"];
    if observed["id"].as_js_string() != Some(thread) {
        bail!("Native execution observation belongs to another thread.");
    }
    match observed["status"]["type"].as_str() {
        Some("active") => Ok("running"),
        Some("idle" | "notLoaded") => Ok("idle"),
        Some("systemError") => Ok("failed"),
        _ => bail!("Native execution status could not be observed."),
    }
}
