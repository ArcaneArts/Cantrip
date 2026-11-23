use super::*;
use crate::{chat_content::Scope, codex::preparation::command::LiveThread, http::checked};

impl Goals {
    pub(crate) async fn get(&self, command: &Value) -> Result<Value> {
        if command["taskContext"].is_object() && command["osExecution"].is_object() {
            bail!("Native observation of an OS-hosted Task Goal is unavailable.");
        }
        let bound = self.encryption.bound_identity()?;
        let thread = target_thread(command)?;
        let LiveThread { runtime, .. } = self.metadata_thread(command, &bound, thread).await?;
        self.watch_project(command, &bound, thread, &runtime);
        let goal = verify_goal(
            thread,
            &rpc(&runtime, "thread/goal/get", json!({"threadId":thread})).await?,
        )?;
        let execution = if command["observeExecution"] == true {
            let task = &command["taskContext"];
            let paused = if task["automationPaused"] == true {
                self.preparation.capture_task_pause(
                    &bound,
                    command["chatId"]
                        .as_js_string()
                        .context("Missing Goal chat.")?,
                    thread,
                    &runtime,
                    &task["nativeCycle"],
                )
            } else {
                None
            };
            let (status, native_idle) = execution_status(&runtime, thread).await?;
            let mut observed = json!({"threadId":thread,"status":status});
            if native_idle && let Some(revision) = paused.and_then(|current| current()) {
                observed["pausedAndIdleRevision"] = json!(revision);
            }
            Some(observed)
        } else {
            None
        };
        if command["taskContext"].is_null()
            && let Some(server) = bound.1.as_js_string()
        {
            self.project
                .capture(server, &bound.0, thread, runtime.generation(), &goal)?;
        }
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
        let live = self
            .preparation
            .live_thread(chat, thread, bound)
            .filter(|_| !command["osExecution"].is_object());
        match live {
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
        execution: Option<Value>,
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
            if let Some(observed) = &execution {
                context["chatStatus"] = observed["status"].clone();
                if observed["status"] == "running" {
                    context["runtimeFailure"] = Value::Null;
                }
            }
            let mut projected =
                projection::started(&binding.component.key, &scope, &current, &context, &goal)?;
            if let Some(observed) = execution {
                projected["execution"] = observed;
            }
            self.assert_bound(&binding)?;
            checked("taskGoalWorkerResultSchema", &projected)
        } else if command["protectObjective"] == true {
            let scope = Scope::new(self.encryption.clone())?;
            if scope.owner != bound.0 || bound.1.as_js_string() != Some(&scope.server) {
                bail!("The worker binding changed during Goal observation.");
            }
            protect_chat_goal(&scope, goal)
        } else {
            Ok(json!({"goal":goal}))
        }
    }
}

pub(super) fn protect_chat_goal(scope: &Scope, mut goal: Value) -> Result<Value> {
    if let Value::Object(fields) = &mut goal {
        let objective = fields
            .shift_remove("objective")
            .context("Missing Goal objective.")?;
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
}

pub(super) fn target_thread(command: &Value) -> Result<&JsString> {
    command["threadId"]
        .as_js_string()
        .context("Missing Goal thread.")
}

async fn execution_status(runtime: &Runtime, thread: &JsString) -> Result<(&'static str, bool)> {
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
        Some("active") => Ok(("running", false)),
        Some("idle") => Ok(("idle", true)),
        Some("notLoaded") => Ok(("idle", false)),
        Some("systemError") => Ok(("failed", false)),
        _ => bail!("Native execution status could not be observed."),
    }
}
