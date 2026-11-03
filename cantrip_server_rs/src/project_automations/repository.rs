use super::{
    queries::{one, run},
    schedule,
};
use crate::{
    database::{Database, Executor},
    native_commands::receipt,
    settings::parse_response,
    wire::{self, JsString, Value, value::json},
};
use anyhow::{Context, Result};
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
    parse_response("projectAutomationWireSchema", Some(&value))
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
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    async fn target(&self, owner: &str, project: &str, chat: &Value) -> Result<Option<Value>> {
        one(
            Executor::Database(&self.database),
            "target",
            &json!({"owner":owner,"project":project,"chat":chat}),
        )
        .await
    }
    pub async fn create(&self, owner: &str, project: &str, input: &Value) -> Result<Option<Value>> {
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
        parse_response("projectAutomationWireListSchema", Some(&list))
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
            .target(owner, string(&current["projectId"])?.as_str(), chat)
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
                    Ok(Some(DispatchLease {
                        automation: wire(&updated, &row["worker_id"])?,
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
        // Source slices UTF-16 before its text driver replaces a trailing lone
        // surrogate. Preserve that order; JSONB must not receive a lone unit.
        let error = error.map(|s| JsString::new(s.units()[..s.units().len().min(5000)].to_vec()));
        let values = json!({"id":lease.automation["id"],"revision":lease.automation["revision"],"runId":lease.run_id,"instance":lease.dispatch_instance_id,"leaseToken":lease.lease_token,"fence":lease.fencing_token,"status":status,"error":error,"now":date(Some(at))?,"expected":date(Some(lease.scheduled_for))?,"nextRunAt":date(lease.next_run_at)?});
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let ex = Executor::Transaction(tx);
                    if one(ex, "finish-run", &values).await?.is_none() {
                        return Ok(false);
                    }
                    run(ex, "finish-automation", &values).await?;
                    Ok(true)
                })
            })
            .await
    }
}
