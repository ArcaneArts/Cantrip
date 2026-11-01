//! Controlled worker transfer around the actual coordinator and durable writers.
use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    native_handoffs::{Repository, service::Service},
    relay::RelayQuotas,
    wire::Value,
    workers::{
        bridge::{BridgeStats, CommandError as WorkerError, EventHandler},
        command_bus::{CommandDelegate, CommandLimits, CommandOutcome, LimitedCommandBus},
    },
};
use futures::{FutureExt, future::BoxFuture};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?})=>{Value::object([$(( $key,Value::from_serialize(&$value))),*])};
    ($value:expr)=>{Value::from_serialize(&$value)};
}
#[derive(Default)]
pub(super) struct Gate {
    pub reached: tokio::sync::Notify,
    pub release: tokio::sync::Notify,
}
pub(super) struct ControlledWorker {
    database: Arc<Database>,
    input: Value,
    pub commands: Mutex<Vec<Value>>,
    pub configurations: Mutex<Vec<Value>>,
    gate: Option<Arc<Gate>>,
}
impl CommandDelegate for ControlledWorker {
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
        owner: String,
        worker: String,
        command: Value,
        timeout: Option<Duration>,
        _: Option<EventHandler>,
    ) -> BoxFuture<'static, CommandOutcome> {
        async move {
            self.commands.lock().unwrap().push(json!({"owner":owner,"worker":worker,"command":command,"timeoutMs":timeout.map(|d|d.as_millis()as u64)}));
            if let Some(gate) = &self.gate {
                gate.reached.notify_one();
                gate.release.notified().await;
            }
            let result:Result<()>=async {
                anyhow::ensure!(command["type"]=="chat.runtime.handoff","Unexpected handoff service worker command");
                anyhow::ensure!(self.input["mode"]!="fail","private-worker-handoff-failure");
                if self.input["mode"]=="complete" {
                    let repo=Repository::new(self.database.clone());let operation=command["operationId"].as_str().context("Handoff operation")?;
                    if self.input["checkConfiguration"] == true {
                        for side in ["source", "destination"] {
                            let config = super::native_handoffs::run(self.database.clone(), &json!({"owner":owner,"chat":command["chatId"],"worker":worker,"operation":operation,"action":"configuration","side":side})).await?;
                            self.configurations.lock().unwrap().push(json!({"side":side,"accountId":config["configuration"]["provider"]["accountId"],"home":config["configuration"]["provider"]["credentialHomeKey"],"route":config["configuration"]["model"]["routeId"],"thread":config["configuration"]["threadId"]}));
                        }
                    }
                    if command["intent"]=="cancel"{repo.finish(&owner,&worker,operation,"cancelled").await?;}else{
                        repo.prepared(&owner,&worker,operation,&self.input["prepared"],None,None).await?;
                        repo.commit(&owner,&worker,operation).await?;
                        repo.finish(&owner,&worker,operation,"completed").await?;
                    }
                }
                Ok(())
            }.await;
            result.map(|_|Some(Value::Null)).map_err(|e|WorkerError{message:e.to_string().into(),code:None,unavailable:false,request_id:None,encoding_error:None})
        }.boxed()
    }
}
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let owner = input["owner"].as_str().context("Handoff service owner")?;
    let chat = input["chat"].as_str().unwrap_or("chat");
    let operation = input["operation"]
        .as_str()
        .context("Handoff service operation")?;
    let Fixture {
        service,
        commands,
        worker,
        events,
    } = fixture(database.clone(), input, owner, None);
    let reply = match input["method"].as_str().unwrap_or("start") {
        "start" => service.start(owner, chat, &input["input"]).await?,
        "wait" => service
            .begin_and_wait(owner, chat, &input["input"])
            .await
            .map_err(cantrip_server::operations::shared_failure::owned)?,
        "retry" => service
            .retry(owner, chat, operation)
            .await?
            .unwrap_or(Value::Null),
        "cancel" => service.cancel(owner, chat, operation).await?,
        "reconnect" => {
            let barriers = service.worker_connected(owner, "alpha").await?;
            for result in futures::future::join_all(barriers.into_values()).await {
                result.map_err(cantrip_server::operations::shared_failure::owned)?;
            }
            Value::Null
        }
        _ => anyhow::bail!("Unknown handoff service fixture method"),
    };
    service.drained().await;
    commands.drained().await;
    let state = Repository::new(database)
        .get(owner, chat, operation)
        .await?;
    Ok(
        json!({"reply":reply,"state":state,"events":Value::Array(events.lock().unwrap().clone()),"commands":Value::Array(worker.commands.lock().unwrap().clone())}),
    )
}
pub(super) struct Fixture {
    pub service: Arc<Service>,
    pub commands: Arc<LimitedCommandBus>,
    pub worker: Arc<ControlledWorker>,
    pub events: Arc<Mutex<Vec<Value>>>,
}
pub(super) fn fixture(
    database: Arc<Database>,
    input: &Value,
    owner: &str,
    gate: Option<Arc<Gate>>,
) -> Fixture {
    let worker = Arc::new(ControlledWorker {
        database: database.clone(),
        input: input.clone(),
        commands: Mutex::new(Vec::new()),
        configurations: Mutex::new(Vec::new()),
        gate,
    });
    let events = Arc::new(Mutex::new(Vec::new()));
    let principal = owner.to_owned();
    let commands = LimitedCommandBus::with_parts(
        worker.clone(),
        RelayQuotas::with_limits(64 << 20, 64 << 20, 64 << 20, 64 << 20, 100, 100),
        CommandLimits {
            account_concurrency: 100,
            account_rate_per_minute: 10000,
            worker_concurrency: 100,
            worker_rate_per_minute: 10000,
        },
        Arc::new(move |_| {
            let owner = principal.clone();
            async move { Ok(Some(owner)) }.boxed()
        }),
        Arc::new(|| 0),
    );
    let service = Service::new(database.clone(), commands.clone(), {
        let events = events.clone();
        Arc::new(move |owner, chat| {
            events
                .lock()
                .unwrap()
                .push(json!({"owner":owner,"chat":chat,"resource":"chat"}));
        })
    });
    Fixture {
        service,
        commands,
        worker,
        events,
    }
}
