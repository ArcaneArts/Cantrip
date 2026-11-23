//! Direct descendant algorithms and the complete coordinator over real journals.
use super::*;
use cantrip_worker::{
    attachments,
    history::{
        client,
        managed::{self, coordinator, descendants, sources},
    },
};
use std::sync::atomic::AtomicBool;
#[derive(Default)]
pub struct Engine {
    descendants: Option<descendants::Descendants>,
    history: Option<coordinator::History>,
    runtime: Option<Arc<RuntimeHub>>,
    journal: Option<Journal>,
    keys: Option<Arc<Keys>>,
    worker: Option<JsString>,
    directory: PathBuf,
    pending: HashMap<String, Work<Value>>,
    captures: Vec<Capture>,
}
impl Engine {
    pub async fn run(&mut self, input: &Value, hub: Hub, context: Arc<Context>) -> Result<Value> {
        let name = input["name"].as_str().unwrap_or("a").to_owned();
        match input["op"].as_str().unwrap() {
            "children.start" | "history.start" => {
                if let Some(owner) = self.history.take() {
                    owner.stop().await?;
                }
                if let Some(owner) = self.descendants.take() {
                    owner.stop().await?;
                }
                self.pending.clear();
                self.captures.clear();
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
                let read = context.clone();
                self.runtime = Some(Arc::new(RuntimeHub {
                    hub,
                    read: Arc::new(move |thread| read.read(thread)),
                }));
                let client = if let Some(server) = config["serverUrl"].as_str() {
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
                self.directory = input["directory"]
                    .as_str()
                    .map(PathBuf::from)
                    .unwrap_or_default();
                let report = context.clone();
                let diagnostics: managed::Diagnostic = Arc::new(move |error, scope| {
                    report.diagnostics(
                        error,
                        scope["phase"].as_str().unwrap_or("discover-children"),
                    );
                    Ok(())
                });
                if input["op"] == "history.start" {
                    self.history = Some(coordinator::History::new(coordinator::Options {
                        directory: self.directory.clone(),
                        worker_id: worker.clone(),
                        service: keys.clone(),
                        attachment_keys: keys.clone(),
                        client: client
                            .ok_or_else(|| anyhow!("History coordinator requires actual HTTP"))?,
                        attachments: attachments::Store::new(&self.directory, None)?,
                        on_error: Some(diagnostics),
                        timing: Timing::new(
                            config["retryDelayMs"].as_f64(),
                            config["maxRetryDelayMs"].as_f64(),
                            config["snapshotDelayMs"].as_f64(),
                        )?,
                        retry: managed::Retry::new(
                            config["retryDelayMs"].as_f64(),
                            config["maxRetryDelayMs"].as_f64(),
                        )?,
                    })?);
                } else {
                    let client: Arc<dyn live::identity::ClientApi> = match client {
                        Some(client) => Arc::new(client),
                        None => Arc::new(ClientContext(context.clone())),
                    };
                    let bind = context.clone();
                    self.descendants = Some(descendants::Descendants::new(descendants::Options {
                        client,
                        on_error: Some(diagnostics),
                        retry_delay: Duration::from_millis(
                            config["retryDelayMs"].as_u64().unwrap_or(5),
                        ),
                        bind: Arc::new(move |input| {
                            let scope = json!({"chatId":input.chat_id,"threadId":input.thread_id,"provenance":input.provenance});
                            bind.trace
                                .lock()
                                .unwrap()
                                .push(json!({"kind":"bind","input":scope}));
                            let context = bind.clone();
                            Ok(Some(Arc::new(move || {
                                context
                                    .trace
                                    .lock()
                                    .unwrap()
                                    .push(json!({"kind":"reconcile","input":scope}))
                            })
                                as descendants::Reconcile))
                        }),
                    }));
                }
                self.keys = Some(keys);
                self.worker = Some(worker);
                self.journal = None;
                Ok(Value::Null)
            }
            "children.source" => {
                let scope = cantrip_history::source::scope(
                    self.keys.as_ref().unwrap().as_ref(),
                    self.worker.as_ref().unwrap(),
                    &string(input, "chatId"),
                    &string(input, "bindingId"),
                    &string(input, "threadId"),
                )?;
                let journal =
                    Journal::open(self.directory.clone(), scope, self.keys.clone().unwrap())
                        .await?;
                for frame in input["frames"].as_array().unwrap() {
                    journal.append(frame).await?;
                }
                let path = journal.directory().to_string_lossy().into_owned();
                self.journal = Some(journal);
                Ok(json!(path))
            }
            "children.wake" => {
                let journal = self.journal.clone().unwrap();
                let scope = journal.scope();
                self.descendants.as_ref().unwrap().wake(
                    journal,
                    managed::Scope {
                        chat_id: scope["chatId"].as_js_string().unwrap().clone(),
                        thread_id: scope["threadId"].as_js_string().unwrap().clone(),
                        binding_id: scope["bindingId"].as_js_string().unwrap().clone(),
                    },
                    self.runtime.clone().unwrap(),
                );
                Ok(Value::Null)
            }
            "children.resolve.start" => {
                let work = self.descendants.as_ref().unwrap().resolve(
                    sources::Input {
                        chat_id: string(input, "chatId"),
                        thread_id: string(input, "rootThreadId"),
                        runtime: self.runtime.clone().unwrap(),
                        provenance: input.get("provenance").cloned(),
                    },
                    string(input, "threadId"),
                );
                self.pending.insert(name, work);
                Ok(Value::Null)
            }
            "history.bind" => {
                let capture = self.history.as_ref().unwrap().bind(sources::Input {
                    chat_id: string(input, "chatId"),
                    thread_id: string(input, "threadId"),
                    runtime: self.runtime.clone().unwrap(),
                    provenance: input.get("provenance").cloned(),
                })?;
                self.captures.push(capture);
                Ok(Value::Null)
            }
            "history.scope.start" => {
                let work = self.history.as_ref().unwrap().output_scope(
                    &string(input, "chatId"),
                    &string(input, "rootThreadId"),
                    string(input, "threadId"),
                );
                self.pending.insert(name, work);
                Ok(Value::Null)
            }
            "children.flush.start"
            | "children.stop.start"
            | "history.flush.start"
            | "history.stop.start" => {
                let work = match input["op"].as_str().unwrap() {
                    "children.flush.start" => self.descendants.as_ref().unwrap().flush(),
                    "children.stop.start" => self.descendants.as_ref().unwrap().stop(),
                    "history.flush.start" => self.history.as_ref().unwrap().flush(),
                    _ => {
                        let work = self.history.as_ref().unwrap().stop();
                        self.pending
                            .insert(name, Box::pin(async move { Ok(Value::Array(work.await?)) }));
                        return Ok(Value::Null);
                    }
                };
                self.pending.insert(
                    name,
                    Box::pin(async move {
                        work.await?;
                        Ok(Value::Null)
                    }),
                );
                Ok(Value::Null)
            }
            "children.await" | "history.await" => self.pending.remove(&name).unwrap().await,
            "children.state" | "history.state" => Ok(
                json!({"trace":*context.trace.lock().unwrap(),"errors":*context.errors.lock().unwrap(),"revision":self.descendants.as_ref().map(|v|v.revision())}),
            ),
            "history.records" => {
                let mut scan = Journal::recover(
                    self.directory.join("native-history-sources"),
                    self.worker.clone().unwrap(),
                    self.keys.clone().unwrap(),
                    Arc::new(AtomicBool::new(false)),
                    None,
                )
                .await?;
                let mut sources = Vec::new();
                while let Some(found) = scan.next().await? {
                    let journal = found.journal?;
                    sources.push(
                        json!({"scope":journal.scope(),"records":journal.read(0,512).await?}),
                    );
                }
                Ok(Value::Array(sources))
            }
            _ => bail!("Unknown history children fixture operation"),
        }
    }
}
