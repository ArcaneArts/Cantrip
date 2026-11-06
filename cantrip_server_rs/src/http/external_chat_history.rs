//! Project-local external Codex discovery with durable import annotations.
use super::{
    account,
    middleware::{self, Context},
    settings::{error, output},
};
use crate::{
    auth::service::AuthService,
    chats::imports,
    projects::{repository::ProjectRepository, targets::TargetRepository},
    settings::parse_response,
    wire::{JsString, Value, coercion::truthy, value::json},
    workers::repository::WorkerRepository,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    response::Response,
    routing::get,
};
use indexmap::IndexMap;
use std::{collections::HashMap, sync::Arc, time::Duration};
fn truncated(value: &Value, limit: usize) -> Result<Value> {
    let value = value
        .as_js_string()
        .context("External history display field")?;
    Ok(Value::String(JsString::new(
        value.units()[..value.len().min(limit)].to_vec(),
    )))
}
fn suffix(value: &Value, tail: &str) -> Result<Value> {
    let mut units = value
        .as_js_string()
        .context("External history worker name")?
        .units()
        .to_vec();
    units.extend(tail.encode_utf16());
    Ok(Value::String(JsString::new(units)))
}
fn key(values: &[&Value]) -> Result<Vec<u16>> {
    let mut key = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            key.push(0);
        }
        key.extend(
            value
                .as_js_string()
                .context("External source identity")?
                .units(),
        );
    }
    Ok(key)
}
async fn discover(
    service: Arc<AuthService>,
    owner: String,
    project: String,
    query: Value,
) -> Result<Response> {
    let projects = ProjectRepository::new(service.repository.database.clone())?;
    let Some(replicas) = projects.replicas(&owner, &project).await? else {
        return Ok(error(404, "Project not found."));
    };
    if query
        .get("includeArchived")
        .is_some_and(|v| v != "true" && v != "false")
    {
        return Ok(error(400, "includeArchived must be true or false."));
    }
    let include_archived = query["includeArchived"] == "true";
    let workers = WorkerRepository::new(service.repository.database.clone());
    let targets = TargetRepository::new(service.repository.database.clone());
    let (workers, worktrees) = tokio::try_join!(
        workers.list_workers(&owner),
        targets.worktrees(&owner, &project)
    )?;
    let workers = workers
        .iter()
        .map(Value::from_serialize)
        .map(|w| {
            Ok((
                w["workerId"]
                    .as_str()
                    .context("Discovery worker identity")?
                    .to_owned(),
                w,
            ))
        })
        .collect::<Result<HashMap<_, _>>>()?;
    let mut groups = IndexMap::<String, Vec<Value>>::new();
    for replica in replicas {
        groups
            .entry(
                replica["workerId"]
                    .as_str()
                    .context("Replica worker identity")?
                    .to_owned(),
            )
            .or_default()
            .push(replica);
    }
    let mut candidates = groups.into_iter().collect::<Vec<_>>();
    let collator = crate::projects::placement::collator()?;
    candidates.sort_by(|(left, _), (right, _)| {
        let l = workers
            .get(left)
            .and_then(|w| w["name"].as_js_string())
            .map(JsString::units)
            .unwrap_or(&[]);
        let r = workers
            .get(right)
            .and_then(|w| w["name"].as_js_string())
            .map(JsString::units)
            .unwrap_or(&[]);
        let left_id = left.encode_utf16().collect::<Vec<_>>();
        let right_id = right.encode_utf16().collect::<Vec<_>>();
        collator
            .compare_utf16(
                if workers.contains_key(left) {
                    l
                } else {
                    &left_id
                },
                if workers.contains_key(right) {
                    r
                } else {
                    &right_id
                },
            )
            .then_with(|| collator.compare_utf16(&left_id, &right_id))
    });
    let fleet_truncated = candidates.len() > 64;
    let outcomes=futures::future::join_all(candidates.iter().take(64).map(|(worker_id,replicas)| {
        let service=&service;let worker=workers.get(worker_id);let worktrees=&worktrees;
        async move {
            let worker_name=truncated(worker.and_then(|w|w.get("name")).filter(|v|!v.is_null()).unwrap_or(&json!(worker_id)),200)?;
            let platform=truncated(worker.and_then(|w|w.get("platform")).filter(|v|!v.is_null()).unwrap_or(&json!("unknown")),100)?;
            let mut base=json!({"workerId":worker_id,"workerName":worker_name,"platform":platform});
            let result:Result<Value>=async {
                if !worker.is_some_and(|w|truthy(w.get("externalCodexHistory"))) {
                    return Ok(json!({"status":"unsupported","sources":Vec::<Value>::new(),"error":json!({"code":"capability-missing","message":suffix(&worker_name," does not support local Codex history discovery.")?})}));
                }
                if !worker.is_some_and(|w|truthy(w.get("online"))) || !service.workers.commands.is_connected(worker_id) {
                    return Ok(json!({"status":"offline","sources":Vec::<Value>::new(),"error":json!({"code":"worker-offline","message":suffix(&worker_name," is offline.")?})}));
                }
                let input=replicas.iter().map(|replica|json!({"projectReplicaId":replica["id"],"path":replica["path"],"repositoryFingerprint":replica["repositoryFingerprint"],"worktrees":worktrees.iter().filter(|w|w["projectSourceId"]==replica["id"]&&w["workerId"]==worker_id.as_str()).map(|w|json!({"worktreeId":w["id"],"path":w["path"],"isPrimary":w["isPrimary"]})).collect::<Vec<_>>()})).collect::<Vec<_>>();
                let result:Result<Value>=async {
                    let reply=service.workers.commands.request(worker_id,json!({"type":"external.chat-history.discover","includeArchived":include_archived,"targets":input}),Some(Duration::from_secs(20)),None).await?;
                    parse_response("externalChatDiscoveryWorkerResultSchema",reply.as_ref())
                }.await;
                match result {
                    Ok(result)=>Ok(json!({"status":"ok","sources":result["sources"],"error":Value::Null})),
                    Err(cause)=>{
                        let raw=Value::String(crate::settings::operation_error_message(&cause));let mut message=truncated(&raw,2000)?;
                        let unavailable=imports::worker_unavailable(&cause);let timed_out=message.as_js_string().context("Discovery error")?.lossy().to_lowercase().contains("timed out");
                        if message.as_js_string().is_some_and(JsString::is_empty) {
                            let mut units="Could not inspect Codex history on ".encode_utf16().collect::<Vec<_>>();
                            units.extend(worker_name.as_js_string().context("Discovery worker name")?.units());units.push(u16::from(b'.'));message=Value::String(JsString::new(units));
                        }
                        Ok(json!({"status":if unavailable {"offline"} else if timed_out {"timed-out"} else {"error"},"sources":Vec::<Value>::new(),"error":json!({"code":if unavailable {"worker-offline"} else if timed_out {"worker-timeout"} else {"worker-error"},"message":message})}))
                    }
                }
            }.await;
            let result=result?;
            for field in ["status","sources","error"] {base[field]=result[field].clone();}
            Ok::<_,anyhow::Error>(base)
        }
    })).await.into_iter().collect::<Result<Vec<_>>>()?;
    let ids = outcomes
        .iter()
        .map(|w| {
            w["workerId"]
                .as_str()
                .map(str::to_owned)
                .context("Discovery worker")
        })
        .collect::<Result<Vec<_>>>()?;
    let references = service
        .chat_imports
        .repository
        .source_references(&owner, &ids)
        .await?;
    let mut by_source = HashMap::new();
    for reference in references.as_array().context("Import references")? {
        by_source.insert(
            key(&[
                &reference["sourceKind"],
                &reference["sourceWorkerId"],
                &reference["sourceId"],
                &reference["sourceThreadId"],
            ])?,
            reference["reference"].clone(),
        );
    }
    let mut annotated = Vec::new();
    for mut worker in outcomes {
        let mut sources = Vec::new();
        for source in worker["sources"]
            .as_array()
            .context("External history sources")?
        {
            let mut copy = source.clone();
            let mut threads = Vec::new();
            for thread in source["threads"]
                .as_array()
                .context("External history threads")?
            {
                let mut copy = thread.clone();
                copy["existingImport"] = by_source
                    .get(&key(&[
                        &source["kind"],
                        &worker["workerId"],
                        &source["sourceId"],
                        &thread["sourceThreadId"],
                    ])?)
                    .cloned()
                    .unwrap_or(Value::Null);
                threads.push(copy);
            }
            copy["threads"] = Value::Array(threads);
            sources.push(copy);
        }
        worker["sources"] = Value::Array(sources);
        annotated.push(worker);
    }
    let truncated = fleet_truncated
        || annotated.iter().any(|w| {
            w["sources"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["truncated"] == true)
        });
    let partial = truncated
        || annotated.iter().any(|w| {
            w["status"] != "ok"
                || w["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|s| s["availability"] != "available")
        });
    output(
        200,
        "projectExternalChatDiscoverySchema",
        &json!({"projectId":project,"observedAt":crate::auth::iso(crate::auth::now()),"partial":partial,"truncated":truncated,"workers":annotated}),
    )
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let query = account::query(request.uri());
    let future = discover(service.clone(), owner, params["projectId"].clone(), query);
    match service.chat_imports.owned(future).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route(
        "/api/projects/{projectId}/external-chat-history",
        get(handle),
    )
}
