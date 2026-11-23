//! Actual managed sources and production canonical pumps over owned fixtures.
use super::*;
use cantrip_history::content::Encryption;
use cantrip_worker::{
    attachments,
    history::{
        adapters, client,
        managed::{self, canonical, projection, sources},
    },
};
use std::sync::atomic::AtomicBool;
impl attachments::content::Keys for Keys {
    fn attachment_identity(&self) -> Result<(JsString, JsString)> {
        self.identity()
    }
    fn attachment_material(&self) -> Result<cantrip_history::content::Material> {
        self.material(None)
    }
}
#[derive(Default)]
pub struct Engine {
    sources: Option<sources::Sources>,
    pump: Option<projection::Pump>,
    runtime: Option<Arc<RuntimeHub>>,
    captures: HashMap<String, Capture>,
    pending: HashMap<String, Work<Value>>,
    directory: PathBuf,
    worker: Option<JsString>,
    keys: Option<Arc<Keys>>,
    factory: Option<projection::Factory>,
}
impl Engine {
    pub async fn run(&mut self, input: &Value, hub: Hub, context: Arc<Context>) -> Result<Value> {
        let name = input["name"].as_str().unwrap_or("a").to_owned();
        match input["op"].as_str().unwrap() {
            "manager.start" => {
                if let Some(sources) = self.sources.take() {
                    sources.stop_and_wait().await?;
                }
                if let Some(pump) = self.pump.take() {
                    pump.stop().await?;
                }
                let config = context.config.lock().unwrap().clone();
                let scope = &input["sourceScope"];
                let keys = Arc::new(Keys {
                    owner: scope["ownerId"]
                        .as_js_string()
                        .cloned()
                        .unwrap_or_else(|| "owner".into()),
                    server: scope["serverId"]
                        .as_js_string()
                        .cloned()
                        .unwrap_or_else(|| "server".into()),
                    byte: input["keyByte"].as_u64().unwrap_or(31) as u8,
                });
                let worker = scope["workerId"]
                    .as_js_string()
                    .cloned()
                    .unwrap_or_else(|| "worker".into());
                let directory = PathBuf::from(input["directory"].as_str().unwrap());
                let real = if let Some(server) = config["serverUrl"].as_str() {
                    let token = config["token"].as_str().unwrap().to_owned();
                    Some(client::Client::new(client::Options {
                        server_url: server.to_owned(),
                        worker_id: worker.clone(),
                        token: Arc::new(move || Ok(token.clone())),
                        metadata_signal: None,
                    })?)
                } else {
                    None
                };
                let client: Arc<dyn live::identity::ClientApi> = match &real {
                    Some(client) => Arc::new(client.clone()),
                    None => Arc::new(ClientContext(context.clone())),
                };
                let read = context.clone();
                let runtime = Arc::new(RuntimeHub {
                    hub,
                    read: Arc::new(move |thread| read.read(thread)),
                });
                if input["project"] == true {
                    let binding_keys = keys.clone();
                    let materialized = directory.join("canonical/materialized");
                    let files = attachments::Store::new(&directory.join("files"), None)?;
                    let adapters: canonical::AdapterFactory =
                        Arc::new(move |binding, signal, source| {
                            let result = adapters::Verified::new(adapters::Options {
                                directory: materialized.clone(),
                                binding,
                                source,
                                keys: binding_keys.clone(),
                                files: files.clone(),
                                signal: Some(signal),
                                child_scope: None,
                                child_association: None,
                                published_attachments: None,
                            });
                            Box::pin(async move {
                                Ok(Arc::new(result?)
                                    as Arc<dyn cantrip_worker::history::projector::Adapters>)
                            })
                        });
                    let factory = canonical::Canonical {
                        directory: directory.join("canonical"),
                        worker_id: worker.clone(),
                        service: keys.clone(),
                        client: real
                            .ok_or_else(|| anyhow!("Canonical fixture requires actual HTTP"))?,
                        adapters,
                    }
                    .factory();
                    let errors = context.clone();
                    let recover = context.clone();
                    self.pump = Some(projection::Pump::new(projection::Options {
                        worker_id: worker.clone(),
                        service: keys.clone(),
                        source_directory: (input["recover"] == true)
                            .then(|| directory.join("sources")),
                        factory: factory.clone(),
                        retry: managed::Retry::new(
                            config["projectionRetryMs"].as_f64(),
                            config["projectionMaxRetryMs"].as_f64(),
                        )?,
                        on_error: Some(Arc::new(move |error, _| {
                            errors.diagnostics(error, "project");
                            Ok(())
                        })),
                        on_recovery_error: Some(Arc::new(move |error, _| {
                            recover.diagnostics(error, "recover");
                            Ok(())
                        })),
                    }));
                    self.factory = Some(factory);
                }
                let persisted = context.clone();
                let errors = context.clone();
                let pump = self.pump.clone();
                self.sources = Some(sources::Sources::new(sources::Options {
                    directory: directory.join("sources"),
                    worker_id: worker.clone(),
                    service: keys.clone(),
                    client,
                    on_persisted: Some(Arc::new(move |journal, scope, _| {
                        let result = pump
                            .as_ref()
                            .map(|pump| pump.wake(journal, scope.clone()))
                            .transpose();
                        let running = persisted.begin("persisted", scope.value());
                        cantrip_transport::lifecycle::owned(async move {
                            result?;
                            running.await
                        })
                    })),
                    on_error: Some(Arc::new(move |error, scope| {
                        errors.diagnostics(error, scope["phase"].as_str().unwrap());
                        Ok(())
                    })),
                    timing: Timing::new(
                        config["retryDelayMs"].as_f64(),
                        config["maxRetryDelayMs"].as_f64(),
                        config["snapshotDelayMs"].as_f64(),
                    )?,
                    binding_timeout_ms: config["bindingTimeoutMs"].as_f64(),
                })?);
                self.directory = directory;
                self.worker = Some(worker);
                self.keys = Some(keys);
                self.runtime = Some(runtime);
                self.captures.clear();
                Ok(Value::Null)
            }
            "manager.bind" => {
                let capture = self.sources.as_ref().unwrap().bind(sources::Input {
                    chat_id: input["chatId"]
                        .as_js_string()
                        .cloned()
                        .unwrap_or_else(|| "chat".into()),
                    thread_id: input["threadId"]
                        .as_js_string()
                        .cloned()
                        .unwrap_or_else(|| "thread".into()),
                    runtime: self.runtime.clone().unwrap(),
                    provenance: input.get("provenance").cloned(),
                })?;
                let value = json!({"generation":capture.generation(),"aborted":capture.signal().check().is_err()});
                self.captures.insert(name, capture);
                Ok(value)
            }
            "manager.state" => Ok(
                json!({"captures":self.captures.iter().map(|(name,c)|json!({"name":name,"generation":c.generation(),"aborted":c.signal().check().is_err(),"pendingRecords":c.pending_records()})).collect::<Vec<_>>(),"trace":*context.trace.lock().unwrap(),"errors":*context.errors.lock().unwrap()}),
            ),
            "manager.flush.start" | "manager.close.start" => {
                let sources = self.sources.as_ref().unwrap();
                let work = if input["op"] == "manager.close.start" {
                    sources.close()
                } else {
                    sources.flush()
                };
                let pump = self.pump.clone();
                self.pending.insert(
                    name,
                    cantrip_transport::lifecycle::owned(async move {
                        work.await?;
                        if let Some(pump) = pump {
                            pump.flush().await?;
                        }
                        Ok(Value::Null)
                    }),
                );
                Ok(Value::Null)
            }
            "manager.stop" => {
                let sources = self.sources.as_ref().unwrap().stop_and_wait();
                let pump = self.pump.clone().map(|p| p.stop());
                let (pending, stopped) = tokio::join!(sources, async move {
                    if let Some(pump) = pump {
                        pump.await?;
                    }
                    Ok::<_, anyhow::Error>(())
                });
                stopped?;
                Ok(Value::Array(pending?))
            }
            "manager.stop.start" => {
                let sources = self.sources.as_ref().unwrap().stop_and_wait();
                let pump = self.pump.clone().map(|p| p.stop());
                self.pending.insert(
                    name,
                    cantrip_transport::lifecycle::owned(async move {
                        let (pending, stopped) = tokio::join!(sources, async move {
                            if let Some(pump) = pump {
                                pump.await?;
                            }
                            Ok::<_, anyhow::Error>(())
                        });
                        stopped?;
                        Ok(Value::Array(pending?))
                    }),
                );
                Ok(Value::Null)
            }
            "manager.await" => self.pending.remove(&name).unwrap().await,
            "manager.poll" => {
                if let Some(result) = self.pending.get_mut(&name).unwrap().as_mut().now_or_never() {
                    self.pending.remove(&name);
                    Ok(json!({"ready":true,"value":result?}))
                } else {
                    Ok(json!({"ready":false}))
                }
            }
            "manager.records" | "manager.checkpoints" => {
                let mut scan = Journal::recover(
                    self.directory.join("sources"),
                    self.worker.clone().unwrap(),
                    self.keys.clone().unwrap(),
                    Arc::new(AtomicBool::new(false)),
                    None,
                )
                .await?;
                let mut values = Vec::new();
                while let Some(found) = scan.next().await? {
                    let journal = found.journal?;
                    if input["op"] == "manager.records" {
                        values.extend(
                            journal
                                .read(0, 512)
                                .await?
                                .into_iter()
                                .map(|v| v["frame"].clone()),
                        );
                    } else {
                        let scope = journal.scope();
                        let (_abort, signal) = cantrip_worker::metadata::Abort::new();
                        let opened = self.factory.as_ref().unwrap()(
                            journal,
                            managed::Scope {
                                chat_id: scope["chatId"].as_js_string().unwrap().clone(),
                                thread_id: scope["threadId"].as_js_string().unwrap().clone(),
                                binding_id: scope["bindingId"].as_js_string().unwrap().clone(),
                            },
                            signal,
                        )
                        .await?;
                        values.push(opened.projection.checkpoint().await?);
                    }
                }
                Ok(Value::Array(values))
            }
            _ => bail!("Unknown managed history fixture operation"),
        }
    }
}
