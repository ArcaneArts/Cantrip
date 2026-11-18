//! Native Goal commands and authenticated Task projection.
mod context;
mod projection;
mod read;

use super::{
    managed::Runtime,
    observation::Observer,
    preparation::{
        Intent,
        command::{Ensurer, Prepared},
    },
};
use crate::{
    encryption::{BoundComponentKey, Service},
    http::checked,
    native_items::join,
};
use anyhow::{Context, Result, bail};
use cantrip_crypto::content::{Communication, decrypt_communication};
use cantrip_wire::{JsString, Value, value::json};
use std::{sync::Arc, time::Duration};

pub(crate) const CREATE: &str = "chat.goal.create";
pub(crate) const GET: &str = "chat.goal.get";

#[derive(Clone)]
pub(crate) struct Goals {
    preparation: Ensurer,
    observation: Observer,
    encryption: Arc<Service>,
}

impl Goals {
    pub(crate) fn new(
        preparation: Ensurer,
        observation: Observer,
        encryption: Arc<Service>,
    ) -> Self {
        Self {
            preparation,
            observation,
            encryption,
        }
    }

    pub(crate) async fn create(&self, command: &Value) -> Result<Value> {
        if !command["objective"].is_object() || !command["taskContext"].is_object() {
            bail!("This native Goal command requires an encrypted Task.");
        }
        let (binding, scope, current) = self.open_task(command)?;
        let created = self.create_owned(command, &binding, &scope).await;
        self.assert_bound(&binding)?;
        match created {
            Ok(goal) => projection::started(
                &binding.component.key,
                &scope,
                &current,
                &command["taskContext"],
                &goal,
            ),
            Err(error) => projection::failed(
                &binding.component.key,
                &scope,
                current,
                command["taskContext"]["message"]["kind"] == "resume",
                &error,
            ),
        }
    }

    fn open_task(&self, command: &Value) -> Result<(BoundComponentKey, Value, Value)> {
        let binding = self.encryption.bound_component("task-content", None)?;
        let chat = &command["chatId"];
        let scope = json!({"ownerId":binding.owner_id,"keyRevision":binding.component.key_revision,"chatId":chat});
        let task = &command["taskContext"]["task"];
        let current = decrypt_communication(
            Communication::Task,
            &binding.component.key,
            &scope,
            &task["protectedContent"],
            task.get("classification"),
        )?;
        Ok((binding, scope, current))
    }

    async fn create_owned(
        &self,
        input: &Value,
        binding: &BoundComponentKey,
        scope: &Value,
    ) -> Result<Value> {
        let command = self.preparation.resolve_routing(input).await?;
        let goal = &command["objective"];
        let target = &command["taskRuntime"];
        if command["osExecution"].is_object()
            || target["computerUseEnabled"] == true
            || !target.is_object()
            || command["subagentDefaults"].is_object()
        {
            bail!("This managed Goal requires a native execution environment that is unavailable.");
        }
        let classification = &goal["classification"];
        let source_thread = &classification["threadId"];
        if classification["chatId"] != scope["chatId"] || classification["status"] != "active" {
            bail!("Encrypted Task Goal metadata is invalid.");
        }
        let mut context = scope.clone();
        context["threadId"] = source_thread.clone();
        let objective = decrypt_communication(
            Communication::TaskGoalObjective,
            &binding.component.key,
            &context,
            &goal["protectedObjective"],
            Some(classification),
        )?;
        let objective = objective["objective"]
            .as_js_string()
            .context("Missing Task Goal objective.")?;
        let start = &goal["startMessage"];
        context["messageId"] = start["id"].clone();
        let message = decrypt_communication(
            Communication::TaskMessage,
            &binding.component.key,
            &context,
            &start["protectedContent"],
            start.get("classification"),
        )?;
        let plan = join(
            message["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item["type"] == "text")
                .filter_map(|item| item["text"].as_js_string().cloned()),
            "\n",
        );
        if plan.trim().is_empty() {
            bail!("The Task implementation context is empty.");
        }
        let mut prepare = command.clone();
        let message = &prepare["taskContext"]["message"];
        prepare["taskGoalFirstInput"] = if message.is_null() {
            start["id"].clone()
        } else {
            message["id"].clone()
        };
        prepare["taskOwned"] = json!(true);
        if prepare["planMode"].is_null() {
            prepare["planMode"] = json!("default");
        }
        if prepare["mcpServers"].is_null() {
            prepare["mcpServers"] = json!(Vec::<Value>::new());
        }
        prepare["session"] = json!({
            "contextKind":"project","chatId":scope["chatId"],"projectId":target["projectId"],
            "worktreeId":target["worktreeId"],"rootKind":target["rootKind"],"scratchRootId":Value::Null,
            "computerUseEnabled":false,
        });
        self.assert_bound(binding)?;
        let prepared = self
            .preparation
            .prepare(&prepare, Intent::Configure)
            .await?;
        self.assert_bound(binding)?;
        let home = prepared.codex_home.clone();
        let chat = scope["chatId"].clone();
        let source_thread = source_thread.clone();
        let objective = objective.clone();
        let direction = tokio::task::spawn_blocking(move || {
            context::materialize(&home, &chat, &source_thread, &objective, &plan)
        })
        .await??;
        self.assert_bound(binding)?;
        let observed = native_goal(&prepared).await?;
        if observed["status"] == "active"
            && observed["objective"] == json!(direction)
            && observed["tokenBudget"] == prepare["tokenBudget"]
        {
            return Ok(observed);
        }
        if observed["status"] == "complete" {
            let cleared = checked(
                "chatGoalClearSchema",
                &request(
                    &prepared,
                    "thread/goal/clear",
                    json!({"threadId":prepared.thread.id()}),
                )
                .await?,
            )?;
            if cleared["cleared"] != true {
                bail!("Could not replace the completed Codex Goal.");
            }
        }
        self.assert_bound(binding)?;
        let result = request(&prepared, "thread/goal/set", json!({
            "threadId":prepared.thread.id(),"objective":direction,"status":"active","tokenBudget":prepare["tokenBudget"],
        })).await?;
        let goal = verify_goal(prepared.thread.id(), &result)?;
        if goal["status"] != "active" || goal["objective"] != json!(direction) {
            bail!("Codex did not apply the requested Goal.");
        }
        Ok(goal)
    }

    fn assert_bound(&self, binding: &BoundComponentKey) -> Result<()> {
        let (owner, server) = self.encryption.bound_identity()?;
        if owner != binding.owner_id || server != binding.server_id {
            bail!("The worker binding changed during Task Goal activation.");
        }
        Ok(())
    }
}

async fn native_goal(prepared: &Prepared) -> Result<Value> {
    let value = request(
        prepared,
        "thread/goal/get",
        json!({"threadId":prepared.thread.id()}),
    )
    .await?;
    verify_goal(prepared.thread.id(), &value)
}

fn verify_goal(thread: &JsString, value: &Value) -> Result<Value> {
    let result = checked("chatGoalResponseSchema", value)?;
    let goal = &result["goal"];
    if !goal.is_null() && goal["threadId"].as_js_string() != Some(thread) {
        bail!("Codex returned a Goal from another thread.");
    }
    Ok(goal.clone())
}

async fn request(prepared: &Prepared, method: &str, params: Value) -> Result<Value> {
    prepared.thread.assert_current(&prepared.runtime)?;
    let reply = rpc(&prepared.runtime, method, params).await?;
    prepared.thread.assert_current(&prepared.runtime)?;
    Ok(reply)
}

async fn rpc(runtime: &Runtime, method: &str, params: Value) -> Result<Value> {
    runtime
        .request(
            method.into(),
            Some(params),
            Some(Duration::from_secs(120)),
            None,
        )
        .await?
        .with_context(|| format!("Codex did not return a {method} result."))
}
