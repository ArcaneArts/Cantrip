//! Development-only reference-comparison driver; no server runtime JS helper.
use anyhow::{Context, Result};
use cantrip_server::{
    direct_attachments::{
        ContractFailure, Coordinator, Options, PreparationLease, PrepareInput, Scope, Unavailable,
    },
    operations::logging::{Emitter, Logger},
    wire::Value,
    workers::bridge::CommandError,
};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicU16, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt},
    sync::oneshot,
};
macro_rules! js { ({$($key:literal:$value:expr),*$(,)?}) => { Value::object([$(( $key, Value::from_serialize(&$value) )),*]) }; }
fn text(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_owned()
}
fn resolve(v: &Value, saved: &HashMap<String, Value>, command: Option<&Value>) -> Value {
    match v {
        Value::String(s) if s.as_str().is_some_and(|s| s.starts_with('@')) => {
            let mut fields = s.as_str().unwrap()[1..].split('.');
            let name = fields.next().unwrap();
            let mut value = if name == "command" {
                command.expect("Controlled command").clone()
            } else {
                saved.get(name).expect("Saved direct fixture value").clone()
            };
            for field in fields {
                value = value[field].clone();
            }
            value
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(|v| resolve(v, saved, command)).collect())
        }
        Value::Object(fields) => Value::object(
            fields
                .iter()
                .map(|(key, v)| (key.clone(), resolve(v, saved, command))),
        ),
        _ => v.clone(),
    }
}
#[derive(Default)]
struct Control {
    saved: Mutex<HashMap<String, Value>>,
    behavior: Mutex<HashMap<String, Value>>,
    held: Mutex<HashMap<String, Vec<oneshot::Sender<Value>>>>,
    commands: Mutex<Vec<Value>>,
    logs: Mutex<Vec<Value>>,
    observers: Mutex<Vec<Value>>,
}
impl Control {
    async fn response(&self, kind: &str, command: Option<&Value>) -> Result<Value> {
        let mut spec = self
            .behavior
            .lock()
            .unwrap()
            .get(kind)
            .cloned()
            .unwrap_or(Value::Null);
        if spec["hold"] == true {
            let (send, receive) = oneshot::channel();
            self.held
                .lock()
                .unwrap()
                .entry(kind.into())
                .or_default()
                .push(send);
            spec = receive
                .await
                .context("Controlled direct request released")?;
        }
        tokio::task::yield_now().await;
        if spec["error"].as_str().is_some_and(|s| !s.is_empty()) {
            return Err(CommandError {
                message: spec["error"].as_js_string().unwrap().clone(),
                code: spec["code"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
                unavailable: spec["unavailable"] == true,
                encoding_error: None,
            }
            .into());
        }
        if let Some(response) = spec.get("response") {
            return Ok(resolve(response, &self.saved.lock().unwrap(), command));
        }
        Ok(match command {
            Some(command) if command["type"] == "direct.capability.prepare" => {
                js!({"accepted":true,"capabilityId":command["binding"]["capabilityId"]})
            }
            Some(command) if command["type"] == "direct.capability.renew" => {
                js!({"renewed":true,"leaseExpiresAt":command["leaseExpiresAt"]})
            }
            _ => Value::Null,
        })
    }
}
type Operation = Shared<BoxFuture<'static, Value>>;
struct Driver {
    core: Arc<Coordinator>,
    control: Arc<Control>,
    now: Arc<AtomicI64>,
    connected: Arc<AtomicBool>,
    leases: Mutex<HashMap<String, Arc<PreparationLease>>>,
    pending: Mutex<HashMap<String, Operation>>,
}
impl Driver {
    fn new(r: &Value) -> Arc<Self> {
        let control = Arc::new(Control::default());
        let now = Arc::new(AtomicI64::new(r["now"].as_f64().unwrap() as i64));
        let jitter = Arc::new(AtomicU16::new(r["jitter"].as_f64().unwrap_or(0.0) as u16));
        let connected = Arc::new(AtomicBool::new(true));
        let (clock, entropy, online) = (now.clone(), jitter.clone(), connected.clone());
        let c = control.clone();
        let workers = Arc::new(move |worker: Value, command: Value, owner: Option<Value>| {
            let control = c.clone();
            async move {
                control.commands.lock().unwrap().push(js!({"worker":worker,"command":command,"owner":owner.unwrap_or(Value::Null),"timeoutMs":5000}));
                control.response(command["type"].as_str().unwrap(),Some(&command)).await
            }.boxed()
        });
        let logs = control.clone();
        let logger: Logger = if r["policyLogger"] == true {
            let clock = now.clone();
            let emitter = Emitter::new(
                "server".into(),
                Arc::new(move || clock.load(Ordering::SeqCst) as f64),
                Arc::new(move |record| logs.logs.lock().unwrap().push(record)),
            );
            Arc::new(move |call| {
                emitter
                    .dispatch(call)
                    .expect("Direct fixture operational log")
            })
        } else {
            Arc::new(move |call| {
                logs.logs
                    .lock()
                    .unwrap()
                    .push(js!({"level":call.level,"event":call.context}))
            })
        };
        let observers = control.clone();
        let core = Coordinator::new(
            workers,
            Options {
                now: Arc::new(move || clock.load(Ordering::SeqCst)),
                jitter: Arc::new(move || Ok(entropy.load(Ordering::SeqCst))),
                connected: Arc::new(move |_| online.load(Ordering::SeqCst)),
                automatic_expiry: false,
                logger,
                observer: Some(Arc::new(move |kind, event| {
                    let control = observers.clone();
                    async move {
                        control
                            .observers
                            .lock()
                            .unwrap()
                            .push(js!({"kind":kind,"event":event}));
                        control.response(&format!("observer:{kind}"), None).await?;
                        Ok(())
                    }
                    .boxed()
                })),
            },
        );
        Arc::new(Self {
            core,
            control,
            now,
            connected,
            leases: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
        })
    }
    async fn call(self: Arc<Self>, r: Value) -> Value {
        let result = self.run(&r).await;
        match result {
            Ok(value) => {
                if let Some(save) = r["save"].as_str() {
                    self.control
                        .saved
                        .lock()
                        .unwrap()
                        .insert(save.into(), value.clone());
                }
                js!({"ok":value})
            }
            Err(cause) => {
                js!({"error":js!({"class":if cause.is::<Unavailable>(){"DirectAttachmentUnavailableError"}else if cause.is::<ContractFailure>(){"ZodError"}else{"Error"},"message":cause.to_string()})})
            }
        }
    }
    async fn run(&self, r: &Value) -> Result<Value> {
        let core = &self.core;
        let authorization = &r["authorization"];
        let capability = r["capability"].as_str().unwrap_or("");
        Ok(match r["method"].as_str().unwrap() {
            "prepare" => {
                let external = r.get("lease").is_some();
                let lease = if external {
                    self.leases
                        .lock()
                        .unwrap()
                        .get(r["lease"].as_str().unwrap())
                        .cloned()
                } else {
                    core.acquire_preparation(r["input"].clone())
                };
                let lease = lease.ok_or(Unavailable("The owning resource is being revoked."))?;
                let result = core
                    .prepare(PrepareInput {
                        lease: lease.clone(),
                        value: r["input"].clone(),
                    })
                    .await;
                if !external {
                    core.release_preparation(&lease);
                }
                result?
            }
            "acquire" => {
                let lease = core.acquire_preparation(r["input"].clone());
                let acquired = lease.is_some();
                if let Some(lease) = lease {
                    self.leases.lock().unwrap().insert(text(r, "name"), lease);
                }
                Value::from_serialize(&acquired)
            }
            "bind" | "active" | "release" => {
                let lease = self
                    .leases
                    .lock()
                    .unwrap()
                    .get(r["lease"].as_str().unwrap())
                    .cloned();
                match r["method"].as_str().unwrap() {
                    "bind" => Value::from_serialize(&lease.is_some_and(|l| {
                        core.bind_preparation(&l, r["kind"].clone(), r["resource"].clone())
                    })),
                    "active" => {
                        Value::from_serialize(&lease.is_some_and(|l| core.preparation_active(&l)))
                    }
                    _ => {
                        if let Some(lease) = lease {
                            core.release_preparation(&lease);
                        }
                        Value::Null
                    }
                }
            }
            "matches" => Value::from_serialize(&core.matches(capability, authorization)),
            "activate" => Value::from_serialize(&core.activate(
                capability,
                authorization,
                r["outcome"].as_str().unwrap(),
            )),
            "renew" => core.renew(capability, authorization).await?,
            "telemetry" => core
                .record_telemetry(capability, authorization, r["input"].clone())
                .unwrap_or(Value::Null),
            "finalTelemetry" => core
                .record_final_telemetry(capability, authorization, r["input"].clone())
                .unwrap_or(Value::Null),
            "tunnelLease" => core
                .tunnel_lease(capability, authorization)
                .unwrap_or(Value::Null),
            "revoke" => Value::from_serialize(
                &core
                    .revoke(
                        capability,
                        r["reason"].as_str().unwrap(),
                        r.get("authorization"),
                    )
                    .await,
            ),
            "offline" => {
                core.worker_offline(&r["worker"]);
                Value::Null
            }
            "close" => {
                core.close().await;
                Value::Null
            }
            "scope" => {
                let scope = match r["scope"].as_str().unwrap() {
                    "owner" => Scope::Owner(r["owner"].clone()),
                    "session" => Scope::Session(r["account"].clone()),
                    "attachment" => Scope::Attachment(r["attachment"].clone()),
                    _ => Scope::Resource {
                        owner: r["owner"].clone(),
                        kind: r["kind"].clone(),
                        resource: r["resource"].clone(),
                    },
                };
                if matches!(scope, Scope::Owner(_) | Scope::Session(_)) {
                    core.revoke_scope(scope).await;
                    Value::Null
                } else {
                    let result = r.get("result").cloned().unwrap_or(Value::Null);
                    let control = self.control.clone();
                    core.mutate(scope, async move {
                        control
                            .observers
                            .lock()
                            .unwrap()
                            .push(js!({"kind":"mutation","event":result}));
                        control.response("mutation", None).await?;
                        Ok(result)
                    })
                    .await?
                }
            }
            method => anyhow::bail!("Unknown direct fixture method {method}"),
        })
    }
    async fn dispatch(self: &Arc<Self>, r: Value) -> Result<Value> {
        match r["op"].as_str().unwrap() {
            "behavior" => {
                let mut values = self.control.behavior.lock().unwrap();
                let kind = text(&r, "type");
                if r["value"].is_null() {
                    values.remove(&kind);
                } else {
                    values.insert(kind, r["value"].clone());
                }
                Ok(Value::Object(Default::default()))
            }
            "connected" => {
                self.connected.store(r["value"] == true, Ordering::SeqCst);
                Ok(Value::Object(Default::default()))
            }
            "release" => {
                let held = self
                    .control
                    .held
                    .lock()
                    .unwrap()
                    .remove(&text(&r, "type"))
                    .unwrap_or_default();
                for send in held {
                    let _ = send.send(r.get("value").cloned().unwrap_or(Value::Null));
                }
                Ok(Value::Object(Default::default()))
            }
            "time" | "advance" => {
                self.now
                    .store(r["now"].as_f64().unwrap() as i64, Ordering::SeqCst);
                if r["op"] == "advance" {
                    let core = self.core.clone();
                    let mut f = Box::pin(async move {
                        core.sweep_expired().await;
                    });
                    if f.as_mut().now_or_never().is_none() {
                        tokio::spawn(f);
                    }
                }
                Ok(Value::Object(Default::default()))
            }
            "snapshot" => Ok(
                js!({"commands":self.control.commands.lock().unwrap().clone(),"logs":self.control.logs.lock().unwrap().clone(),"observers":self.control.observers.lock().unwrap().clone(),"held":Value::object(self.control.held.lock().unwrap().iter().map(|(k,v)|(k.clone(),Value::from_serialize(&v.len()))))}),
            ),
            "join" => {
                let f = self
                    .pending
                    .lock()
                    .unwrap()
                    .get(&text(&r, "name"))
                    .context("Started direct operation")?
                    .clone();
                Ok(f.await)
            }
            "start" => {
                let request = resolve(&r["request"], &self.control.saved.lock().unwrap(), None);
                let driver = self.clone();
                let f = async move { driver.call(request).await }.boxed().shared();
                self.pending
                    .lock()
                    .unwrap()
                    .insert(text(&r, "name"), f.clone());
                let _ = f.clone().now_or_never();
                tokio::spawn(f);
                Ok(Value::Object(Default::default()))
            }
            _ => {
                let request = resolve(&r["request"], &self.control.saved.lock().unwrap(), None);
                Ok(self.clone().call(request).await)
            }
        }
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    let mut driver = None;
    while let Some(line) = lines.next_line().await? {
        let request: Value = serde_json::from_str(&line)?;
        let result = if request["op"] == "init" {
            driver = Some(Driver::new(&request));
            Value::Object(Default::default())
        } else {
            match driver
                .as_ref()
                .context("Initialized direct driver")?
                .dispatch(request)
                .await
            {
                Ok(value) => value,
                Err(cause) => js!({"driverError":cause.to_string()}),
            }
        };
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        output.write_all(result.stringify().as_bytes()).await?;
        output.write_all(b"\n").await?;
        output.flush().await?;
    }
    Ok(())
}
