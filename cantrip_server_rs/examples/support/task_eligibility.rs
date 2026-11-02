//! Actual eligibility/routing/repositories with named catalog/connection peers.
use anyhow::{Context, Result};
use cantrip_server::{
    chats::{Repository as Chats, routing::ModelRouting},
    database::Database,
    operations::logging::{LogCall, Logger},
    task_dispatch,
    task_scheduling::{
        Repository,
        eligibility::{PREFLIGHT_TIMEOUT_MS, Service},
    },
    wire::Value,
};
use futures::FutureExt;
use std::sync::{Arc, Mutex};
macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?})=>{Value::object([$(( $key,Value::from_serialize(&$value))),*])};
    ($value:expr)=>{Value::from_serialize(&$value)};
}
fn text(v: &Value) -> Result<&str> {
    v.as_str().context("Eligibility fixture text")
}
fn merge(value: &mut Value, changes: Option<&Value>) {
    if let Some(fields) = changes.and_then(Value::as_object) {
        for (key, value2) in fields {
            if let Value::Object(object) = value {
                object.insert(key.clone(), value2.clone());
            }
        }
    }
}
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let request = Arc::new(input.clone());
    let owner = text(&input["owner"])?;
    let logs = Arc::new(Mutex::new(Vec::new()));
    let hydration = Arc::new(Mutex::new((0, 0)));
    let logger: Logger = {
        let logs = logs.clone();
        Arc::new(move |call: LogCall| {
            if !call.context["event"]
                .as_str()
                .is_some_and(|s| s.starts_with("task.scheduler."))
            {
                return;
            }
            let mut fields = call.context;
            let error = fields["err"].clone();
            if let Value::Object(o) = &mut fields {
                o.shift_remove("err");
            }
            fields["message"] = json!(call.message);
            fields["level"] = json!(call.level);
            fields["error"] = json!(!error.is_null());
            fields["errorMessage"] = error["message"].clone();
            fields["errorClass"] = error["name"].clone();
            logs.lock().unwrap().push(fields);
        })
    };
    let connected: cantrip_server::chats::routing::Connected = {
        let request = request.clone();
        let checks = std::sync::atomic::AtomicU64::new(0);
        Arc::new(move |worker| {
            request["disconnectAfterChecks"]
                .as_u64()
                .is_none_or(|limit| {
                    checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < limit
                })
                && request["connected"] != false
                && !request["disconnectedWorkers"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&json!(worker)))
        })
    };
    let routing = ModelRouting::with_logger(
        database.clone(),
        connected.clone(),
        {
            let (request, hydration, database) =
                (request.clone(), hydration.clone(), database.clone());
            Arc::new(move |_, _| {
                let (request, hydration, database) =
                    (request.clone(), hydration.clone(), database.clone());
                async move {
                    hydration.lock().unwrap().0 += 1;
                    let result: Result<bool> = async {
                        if let Some(ms) = request["hydrateDelayMs"].as_u64() {
                            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                        }
                        if let Some(sql) = request["hydrateSql"].as_str() {
                            database.query(sql, &[]).await?;
                        }
                        anyhow::ensure!(
                            request["failHydrate"] != true,
                            "Controlled eligibility catalog failure"
                        );
                        Ok(request["catalogChanged"] == true)
                    }
                    .await;
                    hydration.lock().unwrap().1 += 1;
                    result
                }
                .boxed()
            })
        },
        Arc::new(|| chrono::Utc::now().timestamp_millis() as f64),
        logger.clone(),
    );
    for entry in input["cooldowns"].as_array().into_iter().flatten() {
        let entry = entry.as_array().context("Cooldown entry")?;
        routing.set_cooldown_key(
            entry[0].as_js_string().context("Cooldown key")?.clone(),
            entry[1].as_f64(),
        );
    }
    let service = Service::with_dependencies(
        database.clone(),
        routing,
        connected,
        logger,
        input["timeoutMs"].as_f64().unwrap_or(PREFLIGHT_TIMEOUT_MS),
    );
    let result:Result<Value>=async{
        let resume=matches!(input["action"].as_str(),Some("resume"|"prepare-resume"));
        let(prepared,resume_resolver)=if resume{(None,Some(service.prepare_resume(owner.into()).await?))}else{(Some(service.prepare_dispatch(owner.into()).await?),None)};
        if let Some(sql)=input["afterPrepareSql"].as_str(){database.query(sql,&[]).await?;}
        let repository=task_dispatch::Repository::new(database.clone());
        let cycles=repository.list(owner).await?;let workers=Repository::new(database.clone()).list_workers(owner).await?;let chats=Chats::new(database.clone());let mut resolutions=Vec::new();
        for cycle in cycles.as_array().context("Eligibility fixture cycles")?{
            if let Some(resolve)=&resume_resolver{let mut probe=cycle.clone();merge(&mut probe,input.get("resumeProbeChanges"));resolutions.push(json!({"cycleId":cycle["id"],"resolution":resolve(probe).await?}));}
            else{let context=chats.execution_context(owner,text(&cycle["chatId"])?).await?.unwrap_or(Value::Null);
                for worker in workers.as_array().context("Eligibility fixture workers")?{
                    let mut probe=json!({"cycle":cycle,"taskWorker":worker,"projectId":context["projectId"],"physicalWorkerId":context["workerId"],"worktreeId":context["worktreeId"]});merge(&mut probe,input.get("probeChanges"));
                    let prepared=prepared.as_ref().unwrap();let resolution=prepared.resolve(&probe);
                    let mut runtime_cycle=cycle.clone();runtime_cycle["selectedTaskWorkerId"]=worker["id"].clone();runtime_cycle["modelRouteId"]=resolution["modelRouteId"].clone();runtime_cycle["providerAccountId"]=resolution["providerAccountId"].clone();merge(&mut runtime_cycle,input.get("runtimeProbeChanges"));
                    resolutions.push(json!({"cycleId":cycle["id"],"taskWorkerId":worker["id"],"resolution":resolution,"runtime":prepared.runtime_for_claim(&json!({"cycle":runtime_cycle}))}));
                }
            }
        }
        let(mut value,mut runtime)=(Value::Null,Value::Null);
        if input["action"]=="claim"{let prepared=prepared.as_ref().unwrap();value=repository.claim_next(owner,input["leaseOwner"].as_str().unwrap_or(""),prepared.resolver(),&input["options"]).await?.unwrap_or(Value::Null);if !value.is_null(){runtime=prepared.runtime_for_claim(&value).unwrap_or(Value::Null);}}
        else if input["action"]=="resume"{value=repository.resume_next_paused(owner,input["leaseOwner"].as_str().unwrap_or(""),resume_resolver.unwrap(),&input["options"]).await?.unwrap_or(Value::Null);}
        Ok(json!({"value":value,"runtime":runtime,"resolutions":resolutions}))
    }.await;
    service.drained().await;
    let mut result = result?;
    let counts = *hydration.lock().unwrap();
    result["hydration"] = json!({"started":counts.0,"finished":counts.1});
    result["logs"] = Value::Array(logs.lock().unwrap().clone());
    Ok(result)
}
