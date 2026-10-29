//! Development-only driver of the native authority, with controlled worker acknowledgments.
use anyhow::{Context, Result};
use cantrip_server::{
    wire::Value,
    worker_links::{Coordinator, Options, ResourceScope, RevocationScope, WorkerRequest},
};
use futures::FutureExt;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt},
    sync::oneshot,
};

macro_rules! js {
    ({$($key:literal:$value:expr),*$(,)?}) => { Value::object([$(( $key, Value::from_serialize(&$value) )),*]) };
}
fn json(value: impl serde::Serialize) -> Value {
    Value::from_serialize(&value)
}
fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_owned()
}
#[derive(Default)]
struct Driver {
    logs: Vec<Value>,
    commands: Vec<Value>,
    behavior: HashMap<String, Value>,
    held: HashMap<String, Vec<oneshot::Sender<Value>>>,
    generation: Value,
    server: Value,
}
fn resolve(value: &Value, saved: &HashMap<String, Value>) -> Value {
    match value {
        Value::String(v) if v.as_str().is_some_and(|s| s.starts_with('@')) => {
            let mut parts = v.as_str().unwrap()[1..].split('.');
            let mut value = saved
                .get(parts.next().unwrap())
                .expect("saved fixture value")
                .clone();
            for field in parts {
                value = value[field].clone();
            }
            value
        }
        Value::Array(v) => Value::Array(v.iter().map(|v| resolve(v, saved)).collect()),
        Value::Object(v) => Value::Object(
            v.iter()
                .map(|(k, v)| (k.clone(), resolve(v, saved)))
                .collect(),
        ),
        _ => value.clone(),
    }
}
async fn call(c: Arc<Coordinator>, r: Value) -> Value {
    let result: Result<Value> = async {
        Ok(match r["method"].as_str().context("Fixture method")? {
            "open" => c.open_session(r["input"].clone()).await?,
            "issue" => c.issue_grant(r["input"].clone()).await?,
            "renew" => {
                c.renew_session(&s(&r, "session"), r["duration"].as_f64())
                    .await?
            }
            "route" => {
                c.replace_route(&s(&r, "session"), r["route"].clone())
                    .await?
            }
            "renewGrant" => {
                c.renew_grant(&s(&r, "session"), &s(&r, "grant"), r["duration"].as_f64())
                    .await?
            }
            "revokeGrant" => json(
                c.revoke_grant(
                    &s(&r, "session"),
                    &s(&r, "grant"),
                    r["reason"].as_str().unwrap_or("released"),
                )
                .await,
            ),
            "revokeSession" => json(
                c.revoke_session(
                    &s(&r, "session"),
                    r["reason"].as_str().unwrap_or("released"),
                )
                .await,
            ),
            "openPeer" => {
                c.open_peer(
                    &s(&r, "session"),
                    r["route"].clone(),
                    r["generation"].clone(),
                )
                .await?
            }
            "signal" => {
                c.signal_peer(r["input"].clone()).await?;
                Value::Null
            }
            "mailbox" => {
                c.read_peer_mailbox(&s(&r, "session"), &s(&r, "peer"), r["input"].clone())?
            }
            "notify" => {
                c.receive_notification(r["worker"].clone(), r["input"].clone())
                    .await;
                Value::Null
            }
            "scope" => {
                let scope = match r["scope"].as_str().unwrap() {
                    "owner" => RevocationScope::Owner(r["owner"].clone()),
                    "account" => RevocationScope::AccountSession(r["account"].clone()),
                    _ => RevocationScope::Resource(Box::new(ResourceScope {
                        owner: r["owner"].clone(),
                        kind: r["kind"].clone(),
                        resource: r["resource"].clone(),
                        attachment: r.get("attachment").cloned(),
                    })),
                };
                json(
                    c.revoke_scope(scope, r["reason"].as_str().unwrap_or("resource-stopped"))
                        .await,
                )
            }
            "offline" => json(
                c.revoke_worker(
                    &r["worker"],
                    r.get("generation"),
                    r["reason"].as_str().unwrap_or("worker-disconnected"),
                )
                .await,
            ),
            "sweep" => json(c.sweep_expired().await),
            "stats" => c.stats(),
            "authorize" => c
                .session_for_authorization(&s(&r, "session"), &r["owner"], &r["account"])
                .unwrap_or(Value::Null),
            "configuration" => c.peer_configuration()?,
            "close" => {
                c.close().await;
                Value::Null
            }
            _ => anyhow::bail!("Unknown coordinator method"),
        })
    }
    .await;
    match result {
        Ok(value) => js!({"value":value,"rejected":false}),
        Err(error) => json(
            serde_json::json!({"rejected":true,"unavailable":error.downcast_ref::<cantrip_server::worker_links::Error>().is_some_and(|e|matches!(e,cantrip_server::worker_links::Error::Unavailable(_))),"error":error.to_string()}),
        ),
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let driver = Arc::new(Mutex::new(Driver::default()));
    let now = Arc::new(AtomicI64::new(0));
    let mut coordinator = None;
    let mut saved = HashMap::new();
    let mut pending = HashMap::new();
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let request: Value = serde_json::from_str(&line)?;
        let request = resolve(&request, &saved);
        let result = match request["op"].as_str().unwrap() {
            "init" => {
                now.store(request["now"].as_f64().unwrap() as i64, Ordering::Release);
                {
                    let mut d = driver.lock().unwrap();
                    d.server = request["serverId"].clone();
                    d.generation = request["workerGeneration"].clone();
                }
                let (state, clock) = (driver.clone(), now.clone());
                let workers: WorkerRequest = Arc::new(move |worker, command, owner| {
                    let state = state.clone();
                    async move {
                        let (behavior,wait,identity)={
                            let mut d=state.lock().unwrap();let kind=s(&command,"type");let behavior=d.behavior.get(&kind).cloned().unwrap_or(Value::Null);
                            d.commands.push(js!({"worker":worker,"command":command,"owner":owner,"timeoutMs":5000}));
                            let wait=if behavior["hold"]==true{let(send,receive)=oneshot::channel();d.held.entry(kind).or_default().push(send);Some(receive)}else{None};
                            let identity=js!({"serverId":d.server,"ownerId":owner,"workerId":worker,"workerProcessGeneration":d.generation});(behavior,wait,identity)
                        };
                        let outcome=if let Some(wait)=wait{wait.await.context("Fixture acknowledgment ended")?}else{behavior};
                        if let Some(error)=outcome.get("error"){anyhow::bail!("{}",error.as_str().unwrap())}
                        Ok(outcome.get("response").cloned().unwrap_or_else(||if command["type"]=="worker-link.identity.resolve"{identity}else{js!({"accepted":true})}))
                    }.boxed()
                });
                let mut options =
                    Options::new(s(&request, "serverId"), s(&request, "serverGeneration"));
                {
                    let captured = driver.clone();
                    options.logger = Arc::new(move |call| {
                        captured.lock().unwrap().logs.push(
                            js!({"level":call.level,"message":call.message,"context":call.context}),
                        )
                    });
                }
                options.now = Arc::new(move || clock.load(Ordering::Acquire));
                options.peer_configuration = request.get("configuration").cloned();
                if let Some(v) = request["sessionLeaseMs"].as_f64() {
                    options.session_lease_ms = v
                }
                if let Some(v) = request["sessionLifetimeMs"].as_f64() {
                    options.session_lifetime_ms = v
                }
                if let Some(v) = request["maxActiveSessions"].as_f64() {
                    options.max_active_sessions = v as usize
                }
                coordinator = Some(Coordinator::new(workers, options));
                Value::Null
            }
            "behavior" => {
                let mut d = driver.lock().unwrap();
                if request["value"].is_null() {
                    d.behavior.remove(&s(&request, "command"));
                } else {
                    d.behavior
                        .insert(s(&request, "command"), request["value"].clone());
                }
                Value::Null
            }
            "generation" => {
                driver.lock().unwrap().generation = request["value"].clone();
                Value::Null
            }
            "clock" => {
                now.store(request["value"].as_f64().unwrap() as i64, Ordering::Release);
                Value::Null
            }
            "commands" => Value::Array(driver.lock().unwrap().commands.clone()),
            "logs" => Value::Array(driver.lock().unwrap().logs.clone()),
            "held" => {
                let d = driver.lock().unwrap();
                json(d.held.get(&s(&request, "command")).map_or(0, Vec::len))
            }
            "release" => {
                let waiters = driver
                    .lock()
                    .unwrap()
                    .held
                    .remove(&s(&request, "command"))
                    .unwrap_or_default();
                let count = waiters.len();
                for waiter in waiters {
                    let _ = waiter.send(request["value"].clone());
                }
                json(count)
            }
            "spawn" => {
                let c = coordinator.as_ref().unwrap().clone();
                pending.insert(
                    s(&request, "name"),
                    tokio::spawn(call(c, request["call"].clone())),
                );
                Value::Null
            }
            "await" => pending.remove(&s(&request, "name")).unwrap().await?,
            "call" => {
                call(
                    coordinator.as_ref().unwrap().clone(),
                    request["call"].clone(),
                )
                .await
            }
            _ => anyhow::bail!("Unknown fixture operation"),
        };
        if let Some(name) = request["save"].as_str() {
            saved.insert(name.to_owned(), result["value"].clone());
        }
        output
            .write_all((result.stringify() + "\n").as_bytes())
            .await?;
        output.flush().await?;
    }
    Ok(())
}
