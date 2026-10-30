use anyhow::{Context, Result};
use cantrip_server::{
    chats::{
        Repository, eligibility,
        managed_console::{self, ManagedConsole},
        routing::ModelRouting,
    },
    database::Database,
    operations::logging::Policy,
    wire::Value,
};
use std::sync::{Arc, Mutex};
macro_rules! json {
    ($($tokens:tt)*) => {Value::from_serialize(&serde_json::json!($($tokens)*))};
}
pub async fn run(
    database: Arc<Database>,
    request: &Value,
    trace: Arc<Mutex<Vec<Value>>>,
) -> Result<Value> {
    let owner = request["owner"].as_str().context("Console fixture owner")?;
    let op = request["op"].as_str().context("Console fixture op")?;
    if op == "console-credits" {
        return Ok(json!(eligibility::use_chatgpt_credits(&request["credits"])));
    }
    if op == "console-eligibility" {
        return Ok(eligibility::route_availability(
            &request["runtime"],
            request["availability"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            request["worker"].as_str().context("Fixture worker")?,
        ));
    }
    if op == "console-accounts" {
        return Ok(eligibility::account_routes(
            &request["runtime"],
            request["accounts"].as_array().context("Fixture accounts")?,
            request.get("preferred"),
        ));
    }
    let connected = request["connected"] != false;
    let now = request["now"]
        .as_f64()
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as f64);
    let hydrate_sql = request["hydrateSql"].as_str().map(str::to_owned);
    let routing = ModelRouting::with_logger(
        database.clone(),
        Arc::new(move |_| connected),
        {
            let (database, trace) = (database.clone(), trace.clone());
            Arc::new(move |owner, runtimes| {
                let (database, trace, sql) = (database.clone(), trace.clone(), hydrate_sql.clone());
                Box::pin(async move {
                    trace.lock().unwrap().push(json!({"type":"hydrate","owner":owner,"routes":runtimes.iter().map(|r|r["routeId"].clone()).collect::<Vec<_>>()}));
                    if let Some(sql) = sql {
                        database.execute(&sql).await?;
                        Ok(true)
                    } else {
                        Ok(false)
                    }
                })
            })
        },
        Arc::new(move || now),
        {
            let trace = trace.clone();
            Arc::new(move |call| {
                let mut event = json!({"type":"log","level":call.level,"message":call.message,"event":call.context});
                match call.policy {
                    Policy::Event => event["policy"] = json!("event"),
                    Policy::Sampled { key, every } => {
                        event["policy"] = json!("sampled");
                        event["key"] = Value::String(key);
                        event["every"] = every;
                    }
                    Policy::Repeated { key, options } => {
                        event["policy"] = json!("repeated");
                        event["key"] = Value::String(key);
                        if let Some(options) = options {
                            event["options"] = options;
                        }
                    }
                }
                trace.lock().unwrap().push(event);
            })
        },
    );
    if let Some(cooldowns) = request["cooldowns"].as_array() {
        for item in cooldowns {
            let item = item.as_array().context("Cooldown pair")?;
            routing.set_cooldown_key(
                item[0].as_js_string().context("Cooldown key")?.clone(),
                Some(item[1].as_f64().context("Cooldown instant")?),
            );
        }
    }
    let context = if let Some(context) = request.get("context") {
        context.clone()
    } else {
        Repository::new(database.clone())
            .execution_context(owner, request["chat"].as_str().context("Fixture chat")?)
            .await?
            .context("Fixture chat context")?
    };
    match op {
        "console-permission" => Ok(
            json!({"permission":managed_console::permission_profile(&context),"session":managed_console::session_context(&context)}),
        ),
        "console-model" => {
            routing
                .resolve_model_id(owner, &context, request.get("requested"))
                .await
        }
        "console-available" => Ok(Value::Array(
            routing
                .available_runtimes(
                    owner,
                    &context,
                    request["model"].as_str().context("Fixture model")?,
                )
                .await?,
        )),
        "console-context" => Ok(routing
            .runtime_for_context(owner, &context)
            .await?
            .unwrap_or(Value::Null)),
        "console-pairs" => Ok(Value::Array(
            routing
                .route_pairs(
                    owner,
                    &context,
                    &request["configuration"],
                    request
                        .get("roots")
                        .and_then(Value::as_array)
                        .map(Vec::as_slice),
                )
                .await?,
        )),
        "console-launch" => {
            let runtime = if let Some(runtime) = request.get("runtime") {
                runtime.clone()
            } else {
                routing
                    .runtime_for_context(owner, &context)
                    .await?
                    .context("Fixture console runtime")?
            };
            let request = request.clone();
            let console = ManagedConsole::with_request(
                database.clone(),
                routing,
                Arc::new(move |owner, worker, command| {
                    let (database, request, trace) =
                        (database.clone(), request.clone(), trace.clone());
                    Box::pin(async move {
                        trace.lock().unwrap().push(json!({"type":"ensure","worker":worker,"command":command,"options":json!({"ownerId":owner,"timeoutMs":Value::Null})}));
                        if let Some(sql) = request["ensureSql"].as_str() {
                            database.execute(sql).await?;
                        }
                        if let Some(error) = request["ensureError"].as_str() {
                            anyhow::bail!("{error}");
                        }
                        Ok(if request["ensureOmitted"] == true {
                            None
                        } else {
                            Some(
                                request.get("ensureResult").cloned().unwrap_or_else(
                                    || json!({"threadId":"fixture-console-thread"}),
                                ),
                            )
                        })
                    })
                }),
            );
            console.prepare_launch(owner, &context, &runtime).await
        }
        _ => anyhow::bail!("Unknown console fixture operation"),
    }
}
