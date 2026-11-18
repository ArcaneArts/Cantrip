//! Disposable live history RPC/consumer fixture. No production fallback.
use anyhow::{Result, anyhow, bail};
use cantrip_history::{projection::Work, source::Journal};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use cantrip_worker::history::live::{
    self,
    capture::{Capture, Timing},
    observation::{Hub, Observer, RuntimeHub, Subscription},
};
use futures::FutureExt;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
#[path = "support/history_live_context.rs"]
mod context;
use context::{ClientContext, Context, Keys};
#[path = "support/history_managed.rs"]
mod history_managed;
struct Fixture {
    manager: history_managed::Engine,
    hub: Hub,
    context: Arc<Context>,
    subscriptions: HashMap<String, Subscription>,
    capture: Option<Capture>,
    journal: Option<Journal>,
    pending: HashMap<String, Work<Value>>,
    bound: Option<live::identity::Bound>,
    managed: Option<live::identity::Managed>,
    mode: Option<live::mode::Resolver>,
}
fn string(value: &Value, key: &str) -> JsString {
    value[key]
        .as_js_string()
        .cloned()
        .unwrap_or_else(|| "thread".into())
}
impl Fixture {
    fn runtime(&self) -> Arc<RuntimeHub> {
        let context = self.context.clone();
        Arc::new(RuntimeHub {
            hub: self.hub.clone(),
            read: Arc::new(move |thread| context.read(thread)),
        })
    }
    fn state(&self) -> Value {
        json!({"events":*self.context.events.lock().unwrap(),"errors":*self.context.errors.lock().unwrap(),"trace":*self.context.trace.lock().unwrap(),"pendingRecords":self.capture.as_ref().map_or(0,Capture::pending_records),"aborted":self.capture.as_ref().is_some_and(|v|v.signal().check().is_err())})
    }
    async fn run(&mut self, input: Value) -> Result<Value> {
        let op = input["op"].as_str().unwrap();
        if op.starts_with("manager.") {
            return self
                .manager
                .run(&input, self.hub.clone(), self.context.clone())
                .await;
        }
        let name = input["name"].as_str().unwrap_or("a").to_owned();
        match op {
            "init" => {
                if let Some(capture) = self.capture.take() {
                    capture.stop();
                    capture.when_stopped().await?;
                }
                self.hub.replace(None);
                self.subscriptions.clear();
                self.pending.clear();
                self.context = Context::new(input["config"].clone());
                self.hub.replace(Some(string(&input, "generation")));
                if let Some(directory) = input["directory"].as_str() {
                    let selected = &input["sourceScope"];
                    let service = Arc::new(Keys {
                        owner: selected["ownerId"]
                            .as_js_string()
                            .cloned()
                            .unwrap_or_else(|| "owner".into()),
                        server: selected["serverId"]
                            .as_js_string()
                            .cloned()
                            .unwrap_or_else(|| "server".into()),
                        byte: input["keyByte"].as_u64().unwrap_or(31) as u8,
                    });
                    let scope = cantrip_history::source::scope(
                        service.as_ref(),
                        &selected["workerId"]
                            .as_js_string()
                            .cloned()
                            .unwrap_or_else(|| "worker".into()),
                        &selected["chatId"]
                            .as_js_string()
                            .cloned()
                            .unwrap_or_else(|| "chat".into()),
                        &selected["bindingId"]
                            .as_js_string()
                            .cloned()
                            .unwrap_or_else(|| "binding".into()),
                        &selected["threadId"]
                            .as_js_string()
                            .cloned()
                            .unwrap_or_else(|| "thread".into()),
                    )?;
                    self.journal =
                        Some(Journal::open(PathBuf::from(directory), scope, service).await?);
                }
                Ok(Value::Null)
            }
            "configure" => {
                self.context.configure(&input["config"]);
                Ok(Value::Null)
            }
            "replace" => {
                self.hub
                    .replace(input["generation"].as_js_string().cloned());
                Ok(Value::Null)
            }
            "notification" => {
                self.hub.notification(
                    string(&input, "method"),
                    input["params"].clone(),
                    input.get("cursor"),
                );
                Ok(self.state())
            }
            "notifications" => {
                for event in input["entries"].as_array().unwrap() {
                    self.hub.notification(
                        string(event, "method"),
                        event["params"].clone(),
                        event.get("cursor"),
                    );
                }
                Ok(self.state())
            }
            "directory" => Ok(json!(
                self.journal.as_ref().unwrap().directory().to_string_lossy()
            )),
            "pending" => {
                let result = self.pending.get_mut(&name).unwrap().as_mut().now_or_never();
                if let Some(result) = result {
                    self.pending.remove(&name);
                    Ok(json!({"ready":true,"value":result?}))
                } else {
                    Ok(json!({"ready":false}))
                }
            }
            "tick" => {
                tokio::time::sleep(Duration::from_millis(input["ms"].as_u64().unwrap_or(3))).await;
                Ok(self.state())
            }
            "state" => Ok(self.state()),
            "subscribe" => {
                let context = self.context.clone();
                let errors = context.clone();
                let read = context.clone();
                let selected = name.clone();
                let thread = string(&input, "threadId");
                let read_thread = thread.clone();
                let subscription=self.hub.subscribe(thread,Observer {
                    capture:Arc::new(move |frame| { context.events.lock().unwrap().entry(selected.clone()).or_default().push(frame.clone()); if context.config.lock().unwrap()["captureFails"]==true { bail!("fixture observer failed"); } Ok(None) }),
                    on_error:Arc::new(move |error,source| { errors.errors.lock().unwrap().push(json!({"phase":"observe","error":error.to_string(),"source":source})); if errors.config.lock().unwrap()["diagnosticsFail"]==true { bail!("fixture diagnostic failed"); } Ok(()) }),
                },Arc::new(move || read.read(read_thread.clone())))?;
                self.subscriptions.insert(name, subscription);
                Ok(Value::Null)
            }
            "read.start" => {
                let pending = self.subscriptions[&name].read_snapshot();
                self.pending.insert(
                    input["pending"].as_str().unwrap_or("read").to_owned(),
                    pending,
                );
                Ok(Value::Null)
            }
            "subscription.close" => {
                self.subscriptions[&name].close();
                Ok(Value::Null)
            }
            "capture.start" => {
                let context = self.context.clone();
                let append = context.clone();
                let journal = self.journal.clone().unwrap();
                let errors = context.clone();
                let config = context.config.lock().unwrap().clone();
                self.capture = Some(Capture::new(live::capture::Options {
                    runtime: self.runtime(),
                    thread_id: "thread".into(),
                    append: Arc::new(move |frame| append.append(journal.clone(), frame)),
                    on_persisted: Some(Arc::new(move |record| context.begin("notify", record))),
                    on_error: Some(Arc::new(move |error, phase| {
                        errors.diagnostics(error, phase.as_str());
                        if errors.config.lock().unwrap()["diagnosticsFail"] == true {
                            bail!("fixture diagnostic failed");
                        }
                        Ok(())
                    })),
                    timing: Timing::new(
                        config["retryDelayMs"].as_f64(),
                        config["maxRetryDelayMs"].as_f64(),
                        config["snapshotDelayMs"].as_f64(),
                    )?,
                })?);
                Ok(Value::Null)
            }
            "capture.reconcile" => {
                for _ in 0..input["count"].as_u64().unwrap_or(1) {
                    self.capture
                        .as_ref()
                        .unwrap()
                        .reconcile(input["delay"].as_u64());
                }
                Ok(Value::Null)
            }
            "capture.stop" => {
                self.capture.as_ref().unwrap().stop();
                Ok(self.state())
            }
            "capture.flush" => {
                self.capture.as_ref().unwrap().flush().await?;
                Ok(self.state())
            }
            "capture.flush.start" | "capture.close.start" | "capture.stopped.start" => {
                let capture = self.capture.as_ref().unwrap();
                let pending = match op {
                    "capture.flush.start" => capture.flush(),
                    "capture.close.start" => capture.close(),
                    _ => capture.when_stopped(),
                };
                self.pending.insert(
                    name,
                    cantrip_transport::lifecycle::owned(async move {
                        pending.await?;
                        Ok(Value::Null)
                    }),
                );
                Ok(Value::Null)
            }
            "capture.snapshot.start" => {
                let pending = self.capture.as_ref().unwrap().snapshot();
                self.pending.insert(
                    name,
                    cantrip_transport::lifecycle::owned(async move {
                        let value = pending.await?;
                        Ok(json!({"observation":value.observation,"record":value.record}))
                    }),
                );
                Ok(Value::Null)
            }
            "await" => {
                self.pending
                    .remove(&name)
                    .ok_or_else(|| anyhow!("fixture pending missing"))?
                    .await
            }
            "records" => Ok(Value::Array(
                self.journal
                    .as_ref()
                    .unwrap()
                    .read(0, 512)
                    .await?
                    .into_iter()
                    .map(|v| v["frame"].clone())
                    .collect(),
            )),
            "identity.start" => {
                let client = Arc::new(ClientContext(self.context.clone()));
                let context = self.context.clone();
                let config = context.config.lock().unwrap().clone();
                let observe = if config["observeMode"] == true {
                    Some(self.runtime() as Arc<dyn live::observation::Runtime>)
                } else {
                    None
                };
                let read = context.clone();
                let mode =
                    live::mode::Resolver::new(Arc::new(move |thread| read.read(thread)), observe);
                self.mode = Some(mode.clone());
                if input["managed"] == true {
                    let scope = context.clone();
                    self.managed = Some(live::identity::Managed::new(live::identity::Options {
                        client,
                        scope: Arc::new(move |thread, agent| {
                            scope.trace.lock().unwrap().push(json!({"kind":"scope","input":json!({"threadId":thread,"agentScope":agent})}));
                            let selected = scope.config.lock().unwrap()["scope"].clone();
                            Box::pin(async move {
                                Ok(if selected.is_null() {
                                    None
                                } else {
                                    Some(selected)
                                })
                            })
                        }),
                        mode: live::identity::with_mode(mode),
                        signal: None,
                    }));
                    self.bound = None;
                } else {
                    let selected = config["identity"].clone();
                    self.bound = Some(live::identity::Bound::new(
                        config["binding"].clone(),
                        client,
                        Arc::new(move |_| {
                            Ok(if selected.is_null() {
                                None
                            } else {
                                Some(selected.clone())
                            })
                        }),
                    ));
                    self.managed = None;
                }
                Ok(Value::Null)
            }
            "identity.resolve.start" => {
                let output = input["output"].clone();
                let pending = match &self.managed {
                    Some(managed) => managed.resolve(output),
                    None => self.bound.as_ref().unwrap().resolve(output),
                };
                self.pending.insert(
                    name,
                    cantrip_transport::lifecycle::owned(async move {
                        Ok(pending.await?.unwrap_or(Value::Null))
                    }),
                );
                Ok(Value::Null)
            }
            "mode.resolve.start" => {
                self.pending.insert(
                    name,
                    self.mode
                        .as_ref()
                        .unwrap()
                        .resolve(input["identity"].clone()),
                );
                Ok(Value::Null)
            }
            _ => bail!("Unknown live history fixture operation"),
        }
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let mut fixture = Fixture {
        manager: history_managed::Engine::default(),
        hub: Hub::new(Arc::new(|| 1000.)),
        context: Context::new(json!({})),
        subscriptions: HashMap::new(),
        capture: None,
        journal: None,
        pending: HashMap::new(),
        bound: None,
        managed: None,
        mode: None,
    };
    let mut input = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    while let Some(line) = input.next_line().await? {
        let input = parse_json_text(&line).map_err(|e| anyhow!("{}", e.lossy()))?;
        let result = match fixture.run(input).await {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":cantrip_worker::error::message(&error)}),
        };
        output
            .write_all((result.stringify() + "\n").as_bytes())
            .await?;
        output.flush().await?;
    }
    if let Some(capture) = fixture.capture {
        capture.stop();
        capture.when_stopped().await?;
    }
    Ok(())
}
