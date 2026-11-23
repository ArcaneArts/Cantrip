//! Controlled authorized context/files/identity callbacks around the production
//! projector. All keys, mappings and input records are synthetic fixture data.
use super::*;
use cantrip_history::projection::Work;
use cantrip_worker::{
    history::{
        client,
        projector::{self, Adapters, Materialization, Projector, Resolver},
    },
    metadata::{Abort, Signal},
};
#[derive(Clone)]
pub struct Callbacks {
    config: Value,
    trace: Arc<Mutex<Vec<Value>>>,
    abort: Arc<Abort>,
}
impl Callbacks {
    fn call(&self, kind: &str, detail: Value) -> Result<()> {
        self.trace
            .lock()
            .unwrap()
            .push(Value::object([("kind", json!(kind)), ("detail", detail)]));
        if self.config["stopAt"] == kind {
            self.abort.abort(anyhow!("fixture stopped"));
        }
        if self.config["throwAt"] == kind {
            bail!("fixture {kind} error");
        }
        Ok(())
    }
    fn selected(&self, key: &str, item: &Value) -> Option<Value> {
        self.config[key]
            .as_object()?
            .get(item["id"].as_js_string()?)
            .cloned()
    }
}
impl Adapters for Callbacks {
    fn prepare(&self) -> Work<()> {
        let this = self.clone();
        Box::pin(async move {
            if this.config["prepare"] == true {
                this.call("prepare", Value::Null)?;
            }
            Ok(())
        })
    }
    fn bootstrap(&self) -> Work<Value> {
        let this = self.clone();
        Box::pin(async move {
            if this.config.get("bootstrap").is_some() {
                this.call("bootstrap", Value::Null)?;
            }
            Ok(this.config["bootstrap"].clone())
        })
    }
    fn context(&self, item: Value, turn: Value) -> Work<Value> {
        let this = self.clone();
        Box::pin(async move {
            this.call("context", json!({"itemId":item["id"],"turnId":turn["id"]}))?;
            Ok(this
                .selected("contexts", &item)
                .unwrap_or_else(|| this.config["context"].clone()))
        })
    }
    fn materialize(
        &self,
        item: Value,
        turn: Value,
        context: Value,
        published: Option<Value>,
    ) -> Work<Materialization> {
        let this = self.clone();
        Box::pin(async move {
            let mut detail = json!({"itemId":item["id"],"turnId":turn["id"],"context":context});
            if let Some(published) = published {
                detail["publishedAttachments"] = published;
            }
            this.call("materialize", detail)?;
            let selected = this
                .selected("materials", &item)
                .unwrap_or_else(|| this.config["material"].clone());
            Ok(Materialization {
                input_parts: selected.get("inputParts").cloned(),
                attachments: selected
                    .get("attachments")
                    .cloned()
                    .unwrap_or_else(|| json!(Vec::<Value>::new())),
            })
        })
    }
    fn associate(&self, draft: Value, turn: Value) -> Work<Value> {
        let this = self.clone();
        Box::pin(async move {
            this.call(
                "associate",
                json!({"identity":draft["identity"],"turnId":turn["id"]}),
            )?;
            Ok(this
                .config
                .get("association")
                .cloned()
                .unwrap_or_else(|| json!({"kind":"native"})))
        })
    }
}
impl Resolver for Callbacks {
    fn resolve(&self, input: Value, _signal: Option<Signal>) -> Work<Value> {
        let this = self.clone();
        Box::pin(async move {
            this.call("resolve", input.clone())?;
            if let Some(override_value) = this.config.get("resolveResult") {
                return Ok(override_value.clone());
            }
            let values = input["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|request| {
                    this.config["mappings"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|mapping| {
                            mapping["identity"].stringify_canonical()
                                == request["identity"].stringify_canonical()
                        })
                        .cloned()
                        .ok_or_else(|| anyhow!("fixture mapping missing"))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(Value::Array(values))
        })
    }
}
pub fn build(
    service: Arc<Keys>,
    config: Value,
    source: Option<Journal>,
) -> Result<(Projector, Arc<Callbacks>)> {
    let (abort, signal) = Abort::new();
    if config["aborted"] == true {
        abort.abort(anyhow!("fixture stopped"));
    }
    let callbacks = Arc::new(Callbacks {
        config: config.clone(),
        trace: Arc::new(Mutex::new(Vec::new())),
        abort: Arc::new(abort),
    });
    let resolver: Arc<dyn Resolver> = if let Some(server) = config["serverUrl"].as_str() {
        let token = config["token"].as_str().unwrap().to_owned();
        Arc::new(client::Client::new(client::Options {
            server_url: server.to_owned(),
            worker_id: config["binding"]["workerId"]
                .as_js_string()
                .unwrap()
                .clone(),
            token: Arc::new(move || Ok(token.clone())),
            metadata_signal: None,
        })?)
    } else {
        callbacks.clone()
    };
    let adapters: Arc<dyn Adapters> = if config["nativeAdapters"].is_object() {
        let directory = PathBuf::from(config["nativeAdapters"]["directory"].as_str().unwrap());
        let files = cantrip_worker::attachments::Store::new(&directory.join("files"), None)?;
        Arc::new(cantrip_worker::history::adapters::Verified::new(
            cantrip_worker::history::adapters::Options {
                directory,
                binding: config["binding"].clone(),
                source: source
                    .ok_or_else(|| anyhow!("Verified projector needs its actual source"))?,
                keys: service.clone(),
                files,
                signal: Some(signal.clone()),
                child_scope: None,
                child_association: None,
                published_attachments: None,
            },
        )?)
    } else {
        callbacks.clone()
    };
    let projector = Projector::new(projector::Options {
        binding: config["binding"].clone(),
        service,
        client: resolver,
        adapters,
        max_items_per_batch: config.get("maxItemsPerBatch").cloned(),
        signal: Some(signal),
    })?;
    Ok((projector, callbacks))
}
pub async fn run(service: Arc<Keys>, input: &Value, source: Option<Journal>) -> Result<Value> {
    match input["op"].as_str().unwrap() {
        "projector.restore" => projector::bootstrap::restore(&input["recovery"]),
        "projector.fingerprint" => Ok(projector::source_fingerprint(
            &input["item"],
            &input["turnOrdinal"],
            &input["itemOrdinal"],
        )),
        "projector.run" | "projector.rebase" => {
            let (projector, callbacks) = build(service, input["config"].clone(), source.clone())?;
            let result = if input["op"] == "projector.rebase" {
                projector::rebase::replay(
                    input["config"]["binding"].clone(),
                    input["recovery"].clone(),
                    source.unwrap(),
                    input["through"].clone(),
                    projector,
                    None,
                )
                .await
            } else {
                projector
                    .project(
                        input["records"].as_array().cloned().unwrap_or_default(),
                        input["previous"].clone(),
                    )
                    .await
            };
            let trace = callbacks.trace.lock().unwrap().clone();
            match result {
                Ok(result) => {
                    Ok(json!({"state":result.state,"batches":result.batches,"trace":trace}))
                }
                Err(error) => {
                    Ok(json!({"error":cantrip_worker::error::message(&error),"trace":trace}))
                }
            }
        }
        _ => bail!("Unknown canonical projector fixture operation"),
    }
}
