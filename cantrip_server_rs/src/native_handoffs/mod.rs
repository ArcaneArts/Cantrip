//! Durable provider transfers share the canonical Chat lock with admission,
//! queue claims and settings. The owning worker performs native file operations.
mod commit;
mod configuration;
mod guards;
mod inventory;
mod prepared;
mod reads;
mod recover;
pub mod service;
use crate::{
    database::{Database, Executor, Parameters, Transaction},
    native_commands::{
        CommandError, context, managed_queue::deep_equal, receipt, settings_persistence,
        settings_state,
    },
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
use futures::FutureExt;
use postgres_types::ToSql;
use std::sync::{Arc, OnceLock};
#[derive(Clone)]
pub struct Repository {
    database: Arc<Database>,
}
enum Change {
    Cancel,
    Prepared {
        value: Value,
        runtime: Value,
        epoch: Value,
    },
    Commit,
    Recover {
        side: String,
        expected: Value,
        value: Value,
    },
    Finish(String),
    Failure(String),
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Runtime handoff identity")?
        .lossy()
        .into_owned())
}
fn optional(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        text(value).map(Some)
    }
}
fn parse(name: &str, value: &Value) -> Result<Value> {
    crate::settings::parse_response(name, Some(value))
}
fn reject<T>(code: &str) -> Result<T> {
    Err(CommandError::new(code, None, 409).into())
}
fn active(row: &Value) -> bool {
    matches!(
        row["phase"].as_str(),
        Some("preparing" | "prepared" | "committed")
    )
}
async fn one(ex: Executor<'_, '_>, sql: &str, params: Parameters<'_>) -> Result<Option<Value>> {
    ex.query(sql, params)
        .await?
        .first()
        .map(|r| Ok(serde_json::from_str(&r.get::<String>(0)?)?))
        .transpose()
}
fn wire(row: &Value) -> Result<Value> {
    let mut result = Value::object([] as [(&str, Value); 0]);
    for (key, column) in [
        ("operationId", "operation_id"),
        ("chatId", "chat_id"),
        ("workerId", "worker_id"),
        ("phase", "phase"),
        ("cancelRequested", "cancel_requested"),
        ("source", "source"),
        ("binding", "binding"),
        ("retiredRuntimeGenerations", "retired_runtime_generations"),
        ("retiredNativeEpochs", "retired_native_epochs"),
        ("targetModelRouteId", "target_model_route_id"),
        ("targetProviderAccountId", "target_provider_account_id"),
        ("prepared", "prepared"),
        ("errorCode", "error_code"),
    ] {
        result[key] = row[column].clone();
    }
    result["createdAt"] = receipt::iso(&row["created_at"])?;
    result["updatedAt"] = receipt::iso(&row["updated_at"])?;
    parse("nativeRuntimeHandoffStateSchema", &result)
}
fn same_snapshot(a: &Value, b: &Value) -> bool {
    a.get("contentFingerprint") == b.get("contentFingerprint")
        && a["protectedContent"].get("keyRevision") == b["protectedContent"].get("keyRevision")
        && deep_equal(&a["context"], &b["context"])
        && match (a.get("modelAttribution"), b.get("modelAttribution")) {
            (Some(a), Some(b)) => deep_equal(a, b),
            (None, None) => true,
            _ => false,
        }
}
fn retired_epoch(row: &Value, runtime: &Value, epoch: &Value) -> bool {
    row["retired_native_epochs"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|e| e.get("runtimeGeneration") == Some(runtime) && e.get("nativeEpoch") == Some(epoch))
}
fn retire_epoch(row: &Value, runtime: &Value, epoch: &Value) -> Value {
    let mut epochs = row["retired_native_epochs"]
        .as_array()
        .expect("Stored retired epochs")
        .clone();
    if !retired_epoch(row, runtime, epoch) {
        epochs.push(json!({"runtimeGeneration":runtime,"nativeEpoch":epoch}));
    }
    Value::Array(epochs)
}
fn retire_runtime(row: &Value, runtime: &Value) -> Value {
    let mut values = row["retired_runtime_generations"]
        .as_array()
        .expect("Stored retired runtimes")
        .clone();
    // Set construction also removes any duplicates in an older stored receipt.
    values.push(runtime.clone());
    let mut unique = Vec::new();
    for value in values {
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    Value::Array(unique)
}
async fn update(tx: &Transaction<'_>, row: &Value, patch: Value) -> Result<Value> {
    let mut assignments = Vec::new();
    let mut parameters: Vec<Box<dyn ToSql + Send + Sync>> = Vec::new();
    for (key, column, kind) in [
        ("phase", "phase", "text"),
        ("cancelRequested", "cancel_requested", "bool"),
        ("binding", "binding", "json"),
        ("prepared", "prepared", "json"),
        (
            "retiredRuntimeGenerations",
            "retired_runtime_generations",
            "json",
        ),
        ("retiredNativeEpochs", "retired_native_epochs", "json"),
        ("errorCode", "error_code", "text"),
    ] {
        let Some(value) = patch.get(key) else {
            continue;
        };
        match kind {
            "json" => parameters.push(Box::new(value.stringify())),
            "bool" => parameters.push(Box::new(
                value.as_bool().context("Runtime handoff cancellation")?,
            )),
            _ => parameters.push(Box::new(optional(value)?)),
        };
        assignments.push(format!(
            "{column}=${}{}",
            parameters.len(),
            if kind == "json" { "::text::jsonb" } else { "" }
        ));
    }
    parameters.push(Box::new(crate::auth::now()));
    assignments.push(format!("updated_at=${}", parameters.len()));
    parameters.push(Box::new(text(&row["operation_id"])?));
    let sql = format!(
        "UPDATE native_runtime_handoffs SET {} WHERE operation_id=${} RETURNING to_jsonb(native_runtime_handoffs)::text",
        assignments.join(","),
        parameters.len()
    );
    let refs = parameters
        .iter()
        .map(|p| p.as_ref() as &(dyn ToSql + Sync))
        .collect::<Vec<_>>();
    one(Executor::Transaction(tx), &sql, &refs)
        .await?
        .context("Runtime handoff update returned no row")
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    async fn mutate(
        &self,
        owner: &str,
        worker: &str,
        operation: &str,
        change: Change,
    ) -> Result<Value> {
        let Some(found)=one(Executor::Database(&self.database),"SELECT to_jsonb(h)::text FROM native_runtime_handoffs h WHERE operation_id=$1 AND owner_id=$2 AND worker_id=$3",&[&operation,&owner,&worker]).await?else{return reject("handoff-not-found")};
        let (owner, worker, operation) =
            (owner.to_owned(), worker.to_owned(), operation.to_owned());
        self.database.transaction(|tx|Box::pin(async move{
            context::lock_chat(tx,&owner,&text(&found["chat_id"])?).await?;
            let row=one(Executor::Transaction(tx),"SELECT to_jsonb(h)::text FROM native_runtime_handoffs h WHERE operation_id=$1",&[&operation]).await?;
            let Some(row)=row.filter(|r|r["owner_id"]==owner&&r["worker_id"]==worker)else{return reject("handoff-not-found")};
            let changed=match change {
                Change::Cancel=>{
                    if row["phase"]=="cancelled"{row}else if matches!(row["phase"].as_str(),Some("committed"|"completed")){return reject("handoff-already-committed")}else if row["cancel_requested"]==true{row}else{update(tx,&row,json!({"cancelRequested":true,"errorCode":Value::Null})).await?}
                },
                Change::Prepared{value,runtime,epoch}=>prepared::apply(tx,&owner,&worker,row,value,&runtime,&epoch).boxed().await?,
                Change::Commit=>commit::apply(tx,&owner,&worker,row).boxed().await?,
                Change::Recover{side,expected,value}=>recover::apply(tx,&owner,&worker,row,&side,&expected,value).boxed().await?,
                Change::Finish(outcome)=>commit::finish(tx,row,&outcome).await?,
                Change::Failure(error)=>if active(&row){update(tx,&row,json!({"errorCode":error})).await?}else{row},
            };
            wire(&changed)
        })).await
    }
    pub async fn request_cancellation(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
    ) -> Result<Value> {
        let state = self.get(owner, chat, operation).await?;
        let Some(state) = state else {
            return reject("handoff-not-found");
        };
        self.mutate(owner, &text(&state["workerId"])?, operation, Change::Cancel)
            .await
    }
    pub async fn prepared(
        &self,
        owner: &str,
        worker: &str,
        operation: &str,
        value: &Value,
        runtime: Option<&Value>,
        epoch: Option<&Value>,
    ) -> Result<Value> {
        let value = parse("nativeRuntimeHandoffPreparedSchema", value)?;
        self.mutate(
            owner,
            worker,
            operation,
            Change::Prepared {
                value,
                runtime: runtime.cloned().unwrap_or(Value::Null),
                epoch: epoch.cloned().unwrap_or(Value::Null),
            },
        )
        .await
    }
    pub async fn commit(&self, owner: &str, worker: &str, operation: &str) -> Result<Value> {
        self.mutate(owner, worker, operation, Change::Commit).await
    }
    pub async fn recover(
        &self,
        owner: &str,
        worker: &str,
        operation: &str,
        side: &str,
        expected: &Value,
        value: &Value,
    ) -> Result<Value> {
        let value = parse("nativeRuntimeHandoffPreparedSchema", value)?;
        self.mutate(
            owner,
            worker,
            operation,
            Change::Recover {
                side: side.into(),
                expected: expected.clone(),
                value,
            },
        )
        .await
    }
    pub async fn finish(
        &self,
        owner: &str,
        worker: &str,
        operation: &str,
        outcome: &str,
    ) -> Result<Value> {
        self.mutate(owner, worker, operation, Change::Finish(outcome.into()))
            .await
    }
    pub async fn failure(
        &self,
        owner: &str,
        worker: &str,
        operation: &str,
        error: &str,
    ) -> Result<Value> {
        static PATTERN: OnceLock<regress::Regex> = OnceLock::new();
        let units = error.encode_utf16().collect::<Vec<_>>();
        if PATTERN
            .get_or_init(|| regress::Regex::new("^[a-z0-9-]{1,100}$").unwrap())
            .find_from_ucs2(&units, 0)
            .next()
            .is_none()
        {
            return reject("invalid-handoff-error");
        }
        self.mutate(owner, worker, operation, Change::Failure(error.into()))
            .await
    }
}
