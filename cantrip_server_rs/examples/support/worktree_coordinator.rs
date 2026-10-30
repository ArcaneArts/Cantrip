//! Controlled worker replies around the actual native coordinator and database.
use anyhow::{Context, Result};
use cantrip_server::{
    config::{Environment, ServerConfig},
    database::Database,
    projects::{
        coordinator::Coordinator,
        worktrees::{MutationError, Service},
    },
    relay::RelayQuotas,
    wire::Value,
    workers::{
        bridge::{BridgeStats, CommandError, EventHandler, WorkerBridge},
        command_bus::{CommandDelegate, CommandLimits, CommandOutcome, LimitedCommandBus},
    },
};
use futures::{FutureExt, future::BoxFuture};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

macro_rules! json {
    ($($tokens:tt)*) => {Value::from_serialize(&serde_json::json!($($tokens)*))};
}
struct Worker {
    database: Arc<Database>,
    replies: Mutex<VecDeque<Value>>,
    trace: Arc<Mutex<Vec<Value>>>,
}
impl CommandDelegate for Worker {
    fn stats(&self) -> BridgeStats {
        BridgeStats {
            active_requests: 0,
            connected_workers: 1,
            failed_requests: 0,
            routed_requests: 0,
            succeeded_requests: 0,
        }
    }
    fn is_connected(&self, _: &str) -> bool {
        true
    }
    fn request(
        self: Arc<Self>,
        _owner: String,
        worker: String,
        command: Value,
        _timeout: Option<Duration>,
        _event: Option<EventHandler>,
    ) -> BoxFuture<'static, CommandOutcome> {
        self.trace
            .lock()
            .unwrap()
            .push(json!({"worker":worker,"command":command}));
        let reply = self.replies.lock().unwrap().pop_front();
        async move {
            let error = |message: String| CommandError {
                message: message.into(),
                code: None,
                unavailable: false,
                request_id: None,
                encoding_error: None,
            };
            let reply = reply.ok_or_else(|| error("Unexpected worker request".into()))?;
            if let Some(sql) = reply["sql"].as_str() {
                self.database
                    .execute(sql)
                    .await
                    .map_err(|e| error(e.to_string()))?;
            }
            if let Some(message) = reply["error"].as_str() {
                return Err(error(message.to_owned()));
            }
            Ok(reply.get("value").cloned())
        }
        .boxed()
    }
}
pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let owner = request["owner"]
        .as_str()
        .context("Coordinator owner")?
        .to_owned();
    let project = request["project"]
        .as_str()
        .context("Coordinator project")?
        .to_owned();
    let trace = Arc::new(Mutex::new(Vec::new()));
    let worker = Arc::new(Worker {
        database: database.clone(),
        replies: Mutex::new(
            request["replies"]
                .as_array()
                .context("Worker replies")?
                .clone()
                .into(),
        ),
        trace: trace.clone(),
    });
    let config = ServerConfig::read(
        &Environment::from([
            ("CANTRIP_AUTH_MODE".into(), "none".into()),
            ("CANTRIP_WORKER_TOKEN".into(), "fixture-only-token".into()),
        ]),
        &std::env::current_dir()?,
    )?;
    let resolver_owner = owner.clone();
    let commands = LimitedCommandBus::with_parts(
        worker,
        RelayQuotas::new(&config),
        CommandLimits {
            account_concurrency: 100,
            account_rate_per_minute: 1000,
            worker_concurrency: 100,
            worker_rate_per_minute: 1000,
        },
        Arc::new(move |_| {
            let owner = resolver_owner.clone();
            async move { Ok(Some(owner)) }.boxed()
        }),
        Arc::new(|| chrono::Utc::now().timestamp_millis()),
    );
    let changed = trace.clone();
    let coordinator = Coordinator::new(Arc::new(move |_, project| {
        changed.lock().unwrap().push(json!({"changed":project}))
    }));
    let service = Service::new(
        database,
        WorkerBridge::new(Duration::from_secs(15)),
        commands,
        coordinator.clone(),
    );
    let result = match request["action"].as_str() {
        Some("create") => {
            service
                .create(owner, project, request["input"].clone())
                .await
        }
        Some("reconcile") => service
            .reconcile(owner, project)
            .await
            .map(|v| v.map(Value::Array)),
        Some("checkout") => {
            service
                .checkout_pull_request(
                    owner,
                    project,
                    request["sourceWorktreeId"]
                        .as_str()
                        .context("Checkout source")?
                        .to_owned(),
                    request["repository"].clone(),
                    request["number"].clone(),
                )
                .await
        }
        _ => anyhow::bail!("Unknown coordinator action"),
    };
    coordinator.drain().await;
    let trace = trace.lock().unwrap().clone();
    Ok(match result {
        Ok(value) => json!({"value":value,"trace":trace}),
        Err(error) => {
            json!({"error":error.downcast_ref::<MutationError>().map(|e|e.failure.clone()).unwrap_or_else(||json!({"message":error.to_string()})),"trace":trace})
        }
    })
}
