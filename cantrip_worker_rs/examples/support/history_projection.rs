//! Controlled projection callbacks over the real native journal/outbox. The
//! durable synthetic receiver is fixture data, not a production HTTP adapter.
use super::*;
use cantrip_history::{
    outbox::{self, Outbox},
    projection::{self, BatchRejected, Projected, Projection},
};
use std::io::Write;

#[derive(Default)]
pub struct Engine {
    projections: HashMap<String, Projection>,
    contexts: HashMap<String, Arc<Context>>,
}
struct Context {
    config: Mutex<Value>,
    stats: Mutex<Value>,
    stop: Mutex<Option<String>>,
    thread: JsString,
}
fn push(stats: &mut Value, key: &str, value: Value) {
    let mut values = stats[key].as_array().cloned().unwrap_or_default();
    values.push(value);
    stats[key] = json!(values);
}
fn increment(stats: &mut Value, key: &str) -> usize {
    let previous = stats[key].as_u64().unwrap_or(0) as usize;
    stats[key] = json!(previous + 1);
    previous
}
impl Context {
    fn project(&self, records: Vec<Value>, previous: Value, rebase: bool) -> Result<Projected> {
        let config = self.config.lock().unwrap().clone();
        let index = {
            let mut stats = self.stats.lock().unwrap();
            let n = increment(
                &mut stats,
                if rebase {
                    "rebaseCalls"
                } else {
                    "projectCalls"
                },
            );
            push(
                &mut stats,
                if rebase {
                    "rebaseInputs"
                } else {
                    "projectInputs"
                },
                json!({"records":records.iter().map(|v|v["recordId"].clone()).collect::<Vec<_>>(),"state":previous}),
            );
            n
        };
        let selected = if rebase {
            config["rebases"]
                .as_array()
                .and_then(|v| v.get(index))
                .unwrap_or(&config)
        } else {
            &config
        };
        if let Some(error) = selected[if rebase {
            "rebaseError"
        } else {
            "projectError"
        }]
        .as_str()
        {
            bail!("{error}");
        }
        let state = if let Some(state) = selected.get("state") {
            state.clone()
        } else {
            cantrip_history::reducer::reduce(Some(&previous), &records, &self.thread)?
        };
        let batches = selected["batches"].as_array().cloned().unwrap_or_default();
        if rebase && let Some(path) = config["rebaseObstruction"].as_str() {
            std::fs::create_dir_all(path)?;
        }
        Ok(Projected { state, batches })
    }
    fn deliver(&self, scope: Value, record: Value, body: JsString) -> Result<Value> {
        let config = self.config.lock().unwrap().clone();
        {
            let mut stats = self.stats.lock().unwrap();
            increment(&mut stats, "deliverCalls");
        }
        let path = PathBuf::from(config["serverFile"].as_str().unwrap());
        let mut ledger = match std::fs::read_to_string(&path) {
            Ok(text) => parse_json_text(&text).map_err(|e| anyhow!("{}", e.lossy()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                json!({"attempts":Vec::<Value>::new(),"commits":Vec::<Value>::new(),"rejections":Vec::<Value>::new()})
            }
            Err(error) => return Err(error.into()),
        };
        let attempt = ledger["attempts"].as_array().unwrap().len() + 1;
        push(
            &mut ledger,
            "attempts",
            json!({"recordId":record["recordId"],"digest":record["digest"],"body":body}),
        );
        let save = |ledger: &Value| -> Result<()> {
            use std::fs::OpenOptions;
            let mut options = OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&path)?;
            file.write_all(ledger.stringify().as_bytes())?;
            file.sync_all()?;
            Ok(())
        };
        if config["mode"] == "fail"
            || config["mode"] == "ordinary-409"
            || config["failAt"]
                .as_array()
                .is_some_and(|values| values.iter().any(|v| v.as_u64() == Some(attempt as u64)))
        {
            save(&ledger)?;
            bail!(if config["mode"] == "ordinary-409" {
                "ordinary conflict"
            } else {
                "fixture delivery unavailable"
            });
        }
        if config["rejectAt"]
            .as_array()
            .is_some_and(|values| values.iter().any(|v| v.as_u64() == Some(attempt as u64)))
        {
            let batch = parse_json_text(&body.lossy()).map_err(|e| anyhow!("{}", e.lossy()))?;
            let request = json!({"workerId":"worker","chatId":scope["chatId"],"bindingId":scope["bindingId"],"streamId":record["streamId"],"sequence":record["sequence"],"recordId":record["recordId"],"digest":record["digest"],"previousDigest":record["previousDigest"],"batch":batch});
            let rejection = json!({"rejected":true,"rejectionId":uuid::Uuid::new_v4().to_string(),"code":"item-revision-conflict","workerId":"worker","chatId":scope["chatId"],"bindingId":scope["bindingId"],"streamId":record["streamId"],"sequence":record["sequence"],"recordId":record["recordId"],"digest":record["digest"],"previousDigest":record["previousDigest"],"payloadDigest":outbox::baseline::payload_digest(&batch,&record["previousDigest"])});
            push(&mut ledger, "rejections", rejection.clone());
            save(&ledger)?;
            return Err(BatchRejected::verified(&rejection, &request, &rejection["code"])?.into());
        }
        let existing = ledger["commits"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["receipt"]["recordId"] == record["recordId"]);
        let receipt = if let Some(existing) = existing {
            if existing["receipt"]["digest"] != record["digest"]
                || existing["body"].as_js_string() != Some(&body)
            {
                bail!("fixture receiver saw different frozen content");
            }
            existing["receipt"].clone()
        } else {
            let receipt = json!({"committed":true,"streamId":record["streamId"],"sequence":record["sequence"],"recordId":record["recordId"],"digest":record["digest"],"commitId":uuid::Uuid::new_v4().to_string()});
            push(
                &mut ledger,
                "commits",
                json!({"receipt":receipt,"body":body,"previousDigest":record["previousDigest"]}),
            );
            receipt
        };
        save(&ledger)?;
        if config["mode"] == "lost"
            || config["loseAt"]
                .as_array()
                .is_some_and(|values| values.iter().any(|v| v.as_u64() == Some(attempt as u64)))
        {
            bail!("fixture final reply lost");
        }
        if let Some(path) = config["commitObstruction"].as_str() {
            std::fs::create_dir_all(path)?;
        }
        if config["stopAfterCommit"] == true {
            *self.stop.lock().unwrap() = Some("fixture stopped".into());
        }
        Ok(receipt)
    }
}
impl Engine {
    pub async fn run(
        &mut self,
        service: Arc<Keys>,
        sources: &HashMap<String, Journal>,
        outboxes: &HashMap<String, Outbox>,
        input: &Value,
    ) -> Result<Value> {
        let handle = input["handle"].as_str().unwrap_or("a");
        match input["op"].as_str().unwrap() {
            "projection.open" => {
                let source = sources
                    .get(input["source"].as_str().unwrap_or("a"))
                    .ok_or_else(|| anyhow!("Missing source"))?
                    .clone();
                let outbox = outboxes
                    .get(input["outbox"].as_str().unwrap_or("a"))
                    .ok_or_else(|| anyhow!("Missing outbox"))?
                    .clone();
                let source_scope = source.scope();
                let context = Arc::new(Context {
                    config: Mutex::new(input["config"].clone()),
                    stats: Mutex::new(json!({"projectCalls":0,"rebaseCalls":0,"deliverCalls":0})),
                    stop: Mutex::new(input["stop"].as_str().map(str::to_owned)),
                    thread: source_scope["threadId"].as_js_string().unwrap().clone(),
                });
                let (project_context, rebase_context, deliver_context, check_context) = (
                    context.clone(),
                    context.clone(),
                    context.clone(),
                    context.clone(),
                );
                let native_service = service.clone();
                let rebase_service = service.clone();
                let rebase_source = source.clone();
                let options = projection::Options {
                    worker_id: input["workerId"]
                        .as_js_string()
                        .cloned()
                        .unwrap_or_else(|| "worker".into()),
                    chat_id: input["chatId"]
                        .as_js_string()
                        .cloned()
                        .unwrap_or_else(|| source_scope["chatId"].as_js_string().unwrap().clone()),
                    binding_id: input["bindingId"]
                        .as_js_string()
                        .cloned()
                        .unwrap_or_else(|| {
                            source_scope["bindingId"].as_js_string().unwrap().clone()
                        }),
                    service,
                    source,
                    outbox,
                    project: Arc::new(move |records, previous| {
                        let context = project_context.clone();
                        let service = native_service.clone();
                        Box::pin(async move {
                            let config = context.config.lock().unwrap().clone();
                            if config["nativeProjector"].is_object() {
                                increment(&mut context.stats.lock().unwrap(), "projectCalls");
                                if let Some(error) = config["projectError"].as_str() {
                                    bail!("{error}");
                                }
                                let mut options = config["nativeProjector"].clone();
                                options["serverUrl"] = config["serverUrl"].clone();
                                options["token"] = config["token"].clone();
                                return history_projector::build(service, options)?
                                    .0
                                    .project(records, previous)
                                    .await;
                            }
                            tokio::task::spawn_blocking(move || {
                                context.project(records, previous, false)
                            })
                            .await?
                        })
                    }),
                    rebase: if input["allowRebase"] == true {
                        Some(Arc::new(move |records, previous| {
                            let context = rebase_context.clone();
                            let service = rebase_service.clone();
                            let source = rebase_source.clone();
                            Box::pin(async move {
                                let config = context.config.lock().unwrap().clone();
                                if config["nativeProjector"].is_object() {
                                    increment(&mut context.stats.lock().unwrap(), "rebaseCalls");
                                    let mut options = config["nativeProjector"].clone();
                                    options["serverUrl"] = config["serverUrl"].clone();
                                    options["token"] = config["token"].clone();
                                    let binding = options["binding"].clone();
                                    let token = config["token"].as_str().unwrap().to_owned();
                                    let client = cantrip_worker::history::client::Client::new(
                                        cantrip_worker::history::client::Options {
                                            server_url: config["serverUrl"]
                                                .as_str()
                                                .unwrap()
                                                .to_owned(),
                                            worker_id: binding["workerId"]
                                                .as_js_string()
                                                .unwrap()
                                                .clone(),
                                            token: Arc::new(move || Ok(token.clone())),
                                            metadata_signal: None,
                                        },
                                    )?;
                                    let projector =
                                        history_projector::build(service.clone(), options)?.0;
                                    return cantrip_worker::history::projector::rebase::recover(
                                        binding,
                                        client,
                                        service,
                                        source,
                                        records.last().unwrap().clone(),
                                        projector,
                                        None,
                                    )
                                    .await;
                                }
                                tokio::task::spawn_blocking(move || {
                                    context.project(records, previous, true)
                                })
                                .await?
                            })
                        }))
                    } else {
                        None
                    },
                    deliver: Arc::new(move |scope, record, body| {
                        let context = deliver_context.clone();
                        Box::pin(async move {
                            let config = context.config.lock().unwrap().clone();
                            if let Some(server_url) = config["serverUrl"].as_str() {
                                let token = config["token"].as_str().unwrap().to_owned();
                                let client = cantrip_worker::history::client::Client::new(
                                    cantrip_worker::history::client::Options {
                                        server_url: server_url.to_owned(),
                                        worker_id: config["workerId"]
                                            .as_js_string()
                                            .unwrap()
                                            .clone(),
                                        token: Arc::new(move || Ok(token.clone())),
                                        metadata_signal: None,
                                    },
                                )?;
                                return client.deliver(&scope, &record, &body, None).await;
                            }
                            tokio::task::spawn_blocking(move || {
                                context.deliver(scope, record, body)
                            })
                            .await?
                        })
                    }),
                    check: Some(Arc::new(move || {
                        if let Some(reason) = &*check_context.stop.lock().unwrap() {
                            bail!("{reason}");
                        }
                        Ok(())
                    })),
                };
                let projection =
                    Projection::open(PathBuf::from(input["directory"].as_str().unwrap()), options)
                        .await?;
                let result = json!({"directory":projection.directory().to_string_lossy()});
                self.projections.insert(handle.to_owned(), projection);
                self.contexts.insert(handle.to_owned(), context);
                Ok(result)
            }
            "projection.config" => {
                *self.contexts.get(handle).unwrap().config.lock().unwrap() =
                    input["config"].clone();
                Ok(Value::Null)
            }
            "projection.stats" => Ok(self
                .contexts
                .get(handle)
                .unwrap()
                .stats
                .lock()
                .unwrap()
                .clone()),
            "projection.stop" => {
                *self.contexts.get(handle).unwrap().stop.lock().unwrap() = Some(
                    input["reason"]
                        .as_str()
                        .unwrap_or("fixture stopped")
                        .to_owned(),
                );
                Ok(Value::Null)
            }
            "projection.drain" => {
                self.projections.get(handle).unwrap().drain().await?;
                Ok(Value::Null)
            }
            "projection.checkpoint" => self.projections.get(handle).unwrap().checkpoint().await,
            "projection.abandon" => {
                let projection = self.projections.get(handle).unwrap();
                drop(projection.drain());
                projection.checkpoint().await
            }
            _ => bail!("Unknown projection fixture operation"),
        }
    }
}
