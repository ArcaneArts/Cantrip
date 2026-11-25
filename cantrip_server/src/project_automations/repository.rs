use super::{
    queries::{one, run},
    schedule,
};
use crate::{
    database::{Database, Executor},
    native_commands::{receipt, transaction::TransactionRepository},
    settings::parse_response,
    wire::{self, JsString, Value, value::json},
};
use anyhow::{Context, Result, ensure};
use std::sync::Arc;

#[derive(Debug)]
pub struct Conflict(pub &'static str);
impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Conflict {}
fn conflict<T>(message: &'static str) -> Result<T> {
    Err(Conflict(message).into())
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn date(ms: Option<i64>) -> Result<Value> {
    ms.map(|ms| {
        wire::date_iso_milliseconds(ms)
            .map(|s| json!(s))
            .context("Invalid time value")
    })
    .transpose()
    .map(|v| v.unwrap_or(Value::Null))
}
fn milliseconds(value: &Value) -> Result<i64> {
    value
        .as_js_string()
        .and_then(wire::date_milliseconds)
        .context("Invalid time value")
}
fn number(value: &Value) -> Result<i64> {
    value
        .as_f64()
        .map(|n| n as i64)
        .context("Automation integer")
}
fn string(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Automation string")?
        .lossy()
        .into_owned())
}
fn wire(row: &Value, worker: &Value) -> Result<Value> {
    let content = json!({"protectedName":row["protected_name"],"protectedPrompt":row["protected_prompt"],"protectedCondition":row["protected_condition"]});
    let value = json!({"id":row["id"],"projectId":row["project_id"],"chatId":row["chat_id"],"workerId":worker,"content":content,"schedule":row["schedule"],"enabled":row["enabled"],"revision":row["revision"],"nextRunAt":if row["next_run_at"].is_null(){Value::Null}else{receipt::iso(&row["next_run_at"])?},"lastRunAt":if row["last_run_at"].is_null(){Value::Null}else{receipt::iso(&row["last_run_at"])?},"lastStatus":row["last_status"],"lastError":row["last_error"],"createdAt":receipt::iso(&row["created_at"])?,"updatedAt":receipt::iso(&row["updated_at"])?});
    let schema = if row["project_id"].is_null() {
        "councilAutomationWireSchema"
    } else {
        "projectAutomationWireSchema"
    };
    parse_response(schema, Some(&value))
}
fn run_wire(row: Value) -> Result<Value> {
    parse_response(
        "automationRunWireSchema",
        Some(&json!({
            "id":row["id"],"automationId":row["automation_id"],"chatId":row["chat_id"],
            "scheduledFor":receipt::iso(&row["scheduled_for"])?,"status":row["status"],
            "error":row["error_message"],"protectedName":row["protected_name"],"protectedPrompt":row["protected_prompt"],
        })),
    )
}
fn next(enabled: bool, schedule: &Value, now: i64) -> Result<Option<i64>> {
    if !enabled {
        return Ok(None);
    }
    let result = schedule::first(schedule, now)?;
    if result.is_none() {
        return conflict("This schedule has no future occurrence.");
    }
    Ok(result)
}
#[derive(Clone)]
pub struct Repository {
    database: Arc<Database>,
}
pub struct DispatchLease {
    pub automation: Value,
    pub dispatch_instance_id: String,
    pub fencing_token: i64,
    pub lease_token: String,
    pub next_run_at: Option<i64>,
    pub run_id: String,
    pub reasoning_effort: Value,
    pub scheduled_for: i64,
}
impl DispatchLease {
    fn finish_values(&self, status: &str, error: Option<&JsString>, at: i64) -> Result<Value> {
        // Match the persisted error limit in UTF-16 code units.
        let error = error.map(|s| JsString::new(s.units()[..s.units().len().min(5000)].to_vec()));
        Ok(
            json!({"id":self.automation["id"],"revision":self.automation["revision"],"runId":self.run_id,"instance":self.dispatch_instance_id,"leaseToken":self.lease_token,"fence":self.fencing_token,"status":status,"error":error,"now":date(Some(at))?,"expected":date(Some(self.scheduled_for))?,"nextRunAt":date(self.next_run_at)?}),
        )
    }
}
async fn finish_dispatch(ex: Executor<'_, '_>, values: &Value) -> Result<bool> {
    if one(ex, "finish-run", values).await?.is_none() {
        return Ok(false);
    }
    run(ex, "finish-automation", values).await?;
    Ok(true)
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    async fn target(
        &self,
        owner: &str,
        project: Option<&str>,
        chat: &Value,
    ) -> Result<Option<Value>> {
        one(
            Executor::Database(&self.database),
            if project.is_some() {
                "target"
            } else {
                "target-council"
            },
            &json!({"owner":owner,"project":project,"chat":chat}),
        )
        .await
    }
    pub async fn create(&self, owner: &str, project: &str, input: &Value) -> Result<Option<Value>> {
        self.create_target(owner, Some(project), input).await
    }
    pub async fn create_council(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        if input["chatId"] != chat {
            return conflict("The routine target does not match this Council agent.");
        }
        self.create_target(owner, None, input).await
    }
    async fn create_target(
        &self,
        owner: &str,
        project: Option<&str>,
        input: &Value,
    ) -> Result<Option<Value>> {
        let input = parse_response("encryptedProjectAutomationCreateSchema", Some(input))?;
        let Some(target) = self.target(owner, project, &input["chatId"]).await? else {
            return Ok(None);
        };
        let at = now();
        let next_run = next(input["enabled"] == true, &input["schedule"], at)?;
        let values = json!({"id":input["id"],"owner":owner,"project":project,"chat":input["chatId"],"protectedName":input["content"]["protectedName"],"protectedPrompt":input["content"]["protectedPrompt"],"protectedCondition":input["content"]["protectedCondition"],"schedule":input["schedule"],"enabled":input["enabled"],"nextRunAt":date(next_run)?,"now":date(Some(at))?});
        let row = one(Executor::Database(&self.database), "create", &values)
            .await?
            .context("Automation insert returned no row")?;
        wire(&row, &target["worker_id"]).map(Some)
    }
    pub async fn list(&self, owner: &str, project: &str) -> Result<Value> {
        let rows = run(
            Executor::Database(&self.database),
            "list",
            &json!({"owner":owner,"project":project}),
        )
        .await?;
        let list = Value::Array(
            rows.iter()
                .map(|row| wire(row, &row["worker_id"]))
                .collect::<Result<Vec<_>>>()?,
        );
        parse_response("projectAutomationWireListSchema", Some(&list))
    }
    pub async fn list_council(&self, owner: &str, chat: &str) -> Result<Value> {
        let rows = run(
            Executor::Database(&self.database),
            "list-council",
            &json!({"owner":owner,"chat":chat}),
        )
        .await?;
        let list = Value::Array(
            rows.iter()
                .map(|row| wire(row, &row["worker_id"]))
                .collect::<Result<Vec<_>>>()?,
        );
        parse_response("councilAutomationWireListSchema", Some(&list))
    }
    pub async fn list_council_runs(
        &self,
        owner: &str,
        chat: &str,
        automation: &str,
    ) -> Result<Value> {
        let rows = self
            .database
            .query(
                r#"SELECT to_jsonb(r)::text
               FROM project_automation_runs r
               JOIN council_agents a ON a.chat_id=r.chat_id AND a.owner_id=r.owner_id
               WHERE r.owner_id=$1 AND r.chat_id=$2 AND r.automation_id=$3 AND r.project_id IS NULL
               ORDER BY r.scheduled_for DESC LIMIT 30"#,
                &[&owner, &chat, &automation],
            )
            .await?;
        let list = Value::Array(
            rows.iter()
                .map(|row| run_wire(serde_json::from_str(row.get::<&str>(0)?)?))
                .collect::<Result<Vec<_>>>()?,
        );
        parse_response("councilAutomationRunWireListSchema", Some(&list))
    }
    pub async fn get_run(&self, owner: &str, automation: &str, id: &str) -> Result<Option<Value>> {
        let row = self
            .database
            .query(
                "SELECT to_jsonb(r)::text FROM project_automation_runs r
               WHERE r.owner_id=$1 AND r.automation_id=$2 AND r.id=$3
                 AND r.protected_prompt IS NOT NULL AND r.protected_name IS NOT NULL",
                &[&owner, &automation, &id],
            )
            .await?;
        row.first()
            .map(|row| run_wire(serde_json::from_str(row.get::<&str>(0)?)?))
            .transpose()
    }
    pub async fn list_for_worker(&self, owner: &str, worker: &str) -> Result<Value> {
        let rows = run(
            Executor::Database(&self.database),
            "list-worker",
            &json!({"owner":owner,"worker":worker,"enabled":true}),
        )
        .await?;
        let list = Value::Array(
            rows.iter()
                .map(|row| wire(row, &json!(worker)))
                .collect::<Result<Vec<_>>>()?,
        );
        parse_response("workerAutomationWireListSchema", Some(&list))
    }
    pub async fn get(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        one(
            Executor::Database(&self.database),
            "get",
            &json!({"owner":owner,"id":id}),
        )
        .await?
        .map(|row| wire(&row, &row["worker_id"]))
        .transpose()
    }
    pub async fn update(&self, owner: &str, id: &str, input: &Value) -> Result<Option<Value>> {
        let input = parse_response("encryptedProjectAutomationUpdateSchema", Some(input))?;
        let Some(current) = self.get(owner, id).await? else {
            return Ok(None);
        };
        let chat = input.get("chatId").unwrap_or(&current["chatId"]);
        let Some(target) = self
            .target(owner, current["projectId"].as_str(), chat)
            .await?
        else {
            return conflict("The target chat does not belong to this project.");
        };
        let enabled = input.get("enabled").unwrap_or(&current["enabled"]) == &Value::Bool(true);
        let schedule = input.get("schedule").unwrap_or(&current["schedule"]);
        let refresh = input.get("schedule").is_some()
            || input.get("chatId").is_some()
            || input["enabled"] == true && current["enabled"] == false;
        let next_run = if !enabled {
            None
        } else if refresh || current["nextRunAt"].is_null() {
            next(true, schedule, now())?
        } else {
            Some(milliseconds(&current["nextRunAt"])?)
        };
        let mut values = json!({"id":id,"owner":owner,"chat":chat,"schedule":schedule,"enabled":enabled,"revision":current["revision"],"newRevision":number(&current["revision"])?+1,"nextRunAt":date(next_run)?,"now":date(Some(now()))?});
        let mut mask = 0;
        for (i, key) in ["protectedName", "protectedPrompt", "protectedCondition"]
            .iter()
            .enumerate()
        {
            if let Some(value) = input.get("content").and_then(|v| v.get(key)) {
                mask |= 1 << i;
                values[*key] = value.clone();
            }
        }
        one(
            Executor::Database(&self.database),
            &format!("update-{mask}"),
            &values,
        )
        .await?
        .map(|row| wire(&row, &target["worker_id"]))
        .transpose()
    }
    pub async fn delete(&self, owner: &str, id: &str) -> Result<bool> {
        Ok(one(
            Executor::Database(&self.database),
            "delete",
            &json!({"id":id,"owner":owner}),
        )
        .await?
        .is_some())
    }
    pub async fn claim_due(
        &self,
        owner: &str,
        worker: &str,
        id: &str,
        input: &Value,
        instance: &str,
        ttl_ms: i64,
    ) -> Result<Option<DispatchLease>> {
        self.claim_due_at(owner, worker, id, input, instance, ttl_ms, now())
            .await
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn claim_due_at(
        &self,
        owner: &str,
        worker: &str,
        id: &str,
        input: &Value,
        instance: &str,
        ttl_ms: i64,
        at: i64,
    ) -> Result<Option<DispatchLease>> {
        let (owner, worker, id, input, instance) = (
            owner.to_owned(),
            worker.to_owned(),
            id.to_owned(),
            input.clone(),
            instance.to_owned(),
        );
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let ex = Executor::Transaction(tx);
                    let mut values = json!({"owner":owner,"id":id});
                    let Some(row) = one(ex, "claim-automation", &values).await? else {
                        return Ok(None);
                    };
                    if row["worker_id"] != worker
                        || row["enabled"] != true
                        || row["revision"] != input["revision"]
                        || row["next_run_at"].is_null()
                    {
                        return Ok(None);
                    }
                    let expected = milliseconds(&row["next_run_at"])?;
                    if date(Some(expected))? != input["scheduledFor"] || expected > at + 30_000 {
                        return Ok(None);
                    }
                    let next_run_at = schedule::next(&row["schedule"], at.max(expected))?;
                    values["expected"] = date(Some(expected))?;
                    let existing = one(ex, "claim-existing", &values).await?;
                    if let Some(run) = &existing
                        && (run["status"] != "dispatching"
                            || milliseconds(&run["lease_expires_at"])? > at)
                    {
                        return Ok(None);
                    }
                    let lease_token = uuid::Uuid::new_v4().to_string();
                    values["instance"] = json!(instance);
                    values["leaseToken"] = json!(lease_token);
                    values["expires"] = date(Some(at + ttl_ms))?;
                    values["now"] = date(Some(at))?;
                    values["revision"] = row["revision"].clone();
                    let run = if let Some(existing) = existing {
                        values["runId"] = existing["id"].clone();
                        values["oldFence"] = existing["fencing_token"].clone();
                        values["fence"] = json!(number(&existing["fencing_token"])? + 1);
                        values["attempt"] = json!(number(&existing["attempt_count"])? + 1);
                        one(ex, "claim-renew", &values).await?
                    } else {
                        values["newRunId"] = json!(uuid::Uuid::new_v4().to_string());
                        values["project"] = row["project_id"].clone();
                        values["chat"] = row["chat_id"].clone();
                        values["worker"] = json!(worker);
                        values["reasoningEffort"] = row["reasoning_effort"].clone();
                        values["protectedName"] = row["protected_name"].clone();
                        values["protectedPrompt"] = row["protected_prompt"].clone();
                        one(ex, "claim-insert", &values).await?
                    };
                    let Some(run) = run else {
                        return Ok(None);
                    };
                    let Some(updated) = one(ex, "claim-mark", &values).await? else {
                        return conflict(
                            "The automation changed while its occurrence was claimed.",
                        );
                    };
                    let mut automation = wire(&updated, &row["worker_id"])?;
                    if automation["projectId"].is_null() {
                        automation["content"]["protectedName"] = run["protected_name"].clone();
                        automation["content"]["protectedPrompt"] = run["protected_prompt"].clone();
                    }
                    Ok(Some(DispatchLease {
                        automation,
                        dispatch_instance_id: instance,
                        fencing_token: number(&run["fencing_token"])?,
                        lease_token,
                        next_run_at,
                        run_id: string(&run["id"])?,
                        reasoning_effort: run["reasoning_effort"].clone(),
                        scheduled_for: expected,
                    }))
                })
            })
            .await
    }
    pub async fn admitted_dispatch_status(
        &self,
        owner: &str,
        chat: &str,
        key: &str,
    ) -> Result<Option<String>> {
        let rows = self
            .database
            .query(
                "SELECT CASE
                    WHEN EXISTS (SELECT 1 FROM queued_prompts q
                        WHERE q.chat_id=c.id AND q.idempotency_key=$3) THEN 'queued'
                    WHEN EXISTS (SELECT 1 FROM chat_messages m
                        WHERE m.chat_id=c.id AND m.idempotency_key=$3) THEN 'started'
                 END
                 FROM chats c
                 WHERE c.id=$2 AND c.experience='agent' AND (
                    EXISTS (SELECT 1 FROM projects p WHERE p.id=c.project_id AND p.owner_id=$1)
                    OR EXISTS (SELECT 1 FROM council_agents a WHERE a.chat_id=c.id AND a.owner_id=$1)
                 )",
                &[&owner, &chat, &key],
            )
            .await?;
        rows.first()
            .map(|row| row.get::<Option<String>>(0))
            .transpose()
            .map(Option::flatten)
    }
    pub async fn finish_dispatch(
        &self,
        lease: &DispatchLease,
        status: &str,
        error: Option<&JsString>,
    ) -> Result<bool> {
        self.finish_dispatch_at(lease, status, error, now()).await
    }
    pub async fn finish_dispatch_at(
        &self,
        lease: &DispatchLease,
        status: &str,
        error: Option<&JsString>,
        at: i64,
    ) -> Result<bool> {
        let values = lease.finish_values(status, error, at)?;
        self.database
            .transaction(|tx| {
                Box::pin(async move { finish_dispatch(Executor::Transaction(tx), &values).await })
            })
            .await
    }
    pub async fn admit_council_dispatch(
        &self,
        owner: &str,
        worker: &str,
        lease: &DispatchLease,
        prompt: &Value,
    ) -> Result<bool> {
        let values = lease.finish_values("queued", None, now())?;
        let (owner, worker, chat, automation, revision, prompt) = (
            owner.to_owned(),
            worker.to_owned(),
            string(&lease.automation["chatId"])?,
            string(&lease.automation["id"])?,
            number(&lease.automation["revision"])?,
            prompt.clone(),
        );
        self.database
            .transaction(move |tx| {
                Box::pin(async move {
                    // Commit the scheduler receipt and the durable queue insertion together.
                    let current = tx.query(
                "SELECT id FROM project_automations WHERE id=$1 AND owner_id=$2 AND chat_id=$3
                  AND project_id IS NULL AND revision=$4::bigint AND enabled FOR UPDATE",
                &[&automation, &owner, &chat, &revision],
            ).await?;
                    if current.is_empty()
                        || !finish_dispatch(Executor::Transaction(tx), &values).await?
                    {
                        return Ok(false);
                    }
                    tx.query(
                        "SELECT id FROM chats WHERE owner_id=$1 AND id=$2 FOR UPDATE",
                        &[&owner, &chat],
                    )
                    .await?;
                    let repository = TransactionRepository::new(tx);
                    let current = repository
                        .execution_context(&owner, &chat)
                        .await?
                        .filter(|context| {
                            context.get("councilAgent").is_some() && context["workerId"] == worker
                        })
                        .context("The Council routine target moved before admission.")?;
                    let queued = repository
                        .add_gui_prompt(
                            &owner,
                            &current,
                            &prompt,
                            &json!({"operationId":prompt["idempotencyKey"],"resumeAutonomy":false}),
                        )
                        .await?;
                    ensure!(
                        !queued["acceptedItem"].is_null(),
                        "Council could not add the routine input."
                    );
                    Ok(true)
                })
            })
            .await
    }
}
