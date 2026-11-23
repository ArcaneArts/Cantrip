//! Controlled RPC/storage outcomes for actual live history mechanisms.
use super::*;
use cantrip_crypto::Zeroizing;
use cantrip_history::content::{Encryption, Material};
use std::collections::VecDeque;
pub struct Keys {
    pub owner: JsString,
    pub server: JsString,
    pub byte: u8,
}
impl Encryption for Keys {
    fn identity(&self) -> Result<(JsString, JsString)> {
        Ok((self.owner.clone(), self.server.clone()))
    }
    fn material(&self, revision: Option<u64>) -> Result<Material> {
        Ok(Material {
            owner_id: self.owner.clone(),
            server_id: self.server.clone(),
            key_revision: revision.unwrap_or(1),
            key: Zeroizing::new(vec![self.byte; 32]),
        })
    }
}
pub struct Context {
    pub config: Mutex<Value>,
    pub trace: Mutex<Vec<Value>>,
    pub events: Mutex<HashMap<String, Vec<Value>>>,
    pub errors: Mutex<Vec<Value>>,
    changed: tokio::sync::watch::Sender<()>,
}
impl Context {
    pub fn new(config: Value) -> Arc<Self> {
        let (changed, _) = tokio::sync::watch::channel(());
        Arc::new(Self {
            config: Mutex::new(config),
            trace: Mutex::new(Vec::new()),
            events: Mutex::new(HashMap::new()),
            errors: Mutex::new(Vec::new()),
            changed,
        })
    }
    pub fn configure(&self, patch: &Value) {
        let mut config = self.config.lock().unwrap();
        if let Value::Object(fields) = &mut *config {
            for (key, value) in patch.as_object().unwrap() {
                fields.insert(key.clone(), value.clone());
            }
        }
        drop(config);
        self.changed.send_replace(());
    }
    pub fn begin(self: &Arc<Self>, kind: &'static str, input: Value) -> Work<()> {
        self.trace
            .lock()
            .unwrap()
            .push(json!({"kind":kind,"input":input}));
        let failure = {
            let mut config = self.config.lock().unwrap();
            let key = format!("{kind}FailNext");
            let remaining = config[key.as_str()].as_u64().unwrap_or(0);
            if remaining > 0 {
                config[key.as_str()] = json!(remaining - 1);
                Some(
                    config[format!("{kind}Error").as_str()]
                        .as_js_string()
                        .cloned()
                        .unwrap_or_else(|| format!("fixture {kind} failed").into()),
                )
            } else {
                None
            }
        };
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let mut changed = this.changed.subscribe();
            loop {
                if this.config.lock().unwrap()[format!("{kind}Held").as_str()] != true {
                    break;
                }
                changed.changed().await?;
            }
            if let Some(error) = failure {
                return Err(cantrip_worker::error::WireError(error).into());
            }
            Ok(())
        })
    }
    pub fn read(self: &Arc<Self>, thread: JsString) -> Work<Value> {
        let reply = {
            let mut config = self.config.lock().unwrap();
            let next = config["snapshots"]
                .as_array()
                .filter(|v| !v.is_empty())
                .map(|v| v[0].clone());
            if next.is_some() {
                let mut replies: VecDeque<_> = config["snapshots"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .cloned()
                    .collect();
                replies.pop_front();
                config["snapshots"] = Value::Array(replies.into());
            }
            next.unwrap_or_else(|| {
                config["histories"]
                    .get(&thread.lossy())
                    .unwrap_or(&config["snapshot"])
                    .clone()
            })
        };
        let running = self.begin("read", Value::String(thread.clone()));
        cantrip_transport::lifecycle::owned(async move {
            running.await?;
            if let Some(error) = reply["error"].as_js_string() {
                return Err(cantrip_worker::error::WireError(error.clone()).into());
            }
            let raw = if reply.is_null() {
                json!({"thread":json!({"id":thread,"status":json!({"type":"idle"}),"turns":Vec::<Value>::new()})})
            } else {
                reply
            };
            cantrip_history::native::snapshot(&raw, &thread)
        })
    }
    pub fn diagnostics(&self, error: live::Failure, phase: &str) {
        self.errors
            .lock()
            .unwrap()
            .push(json!({"phase":phase,"error":cantrip_worker::error::message(&error.error())}));
    }
    pub fn append(self: &Arc<Self>, journal: Journal, frame: Value) -> Work<Value> {
        let running = self.begin("append", frame.clone());
        let lost = {
            let mut config = self.config.lock().unwrap();
            let lost = config["lostAckNext"] == true;
            if lost {
                config["lostAckNext"] = json!(false);
            }
            lost
        };
        cantrip_transport::lifecycle::owned(async move {
            running.await?;
            let record = journal.append(&frame).await?;
            if lost {
                bail!("lost source persistence acknowledgment");
            }
            Ok(record)
        })
    }
}
pub struct ClientContext(pub Arc<Context>);
impl cantrip_worker::history::projector::Resolver for ClientContext {
    fn resolve(
        &self,
        input: Value,
        signal: Option<cantrip_worker::metadata::Signal>,
    ) -> Work<Value> {
        live::identity::ClientApi::resolve(self, input, signal)
    }
}
impl live::identity::ClientApi for ClientContext {
    fn open(&self, input: Value, signal: Option<cantrip_worker::metadata::Signal>) -> Work<Value> {
        let thread = input["threadId"].clone();
        let running = self.0.begin("open", input);
        let this = self.0.clone();
        cantrip_transport::lifecycle::owned(async move {
            if let Some(signal) = signal {
                signal.check()?;
                tokio::select! { result=running=>result?, reason=signal.cancelled()=>return Err(reason.into()) }
            } else {
                running.await?;
            }
            let config = this.config.lock().unwrap();
            Ok(config
                .get("bindings")
                .and_then(|bindings| bindings.get(thread.as_str().unwrap_or("")))
                .or_else(|| config.get("openResult"))
                .unwrap_or(&config["binding"])
                .clone())
        })
    }
    fn resolve(&self, input: Value, _: Option<cantrip_worker::metadata::Signal>) -> Work<Value> {
        let running = self.0.begin("resolve", input.clone());
        let this = self.0.clone();
        cantrip_transport::lifecycle::owned(async move {
            running.await?;
            let config = this.config.lock().unwrap();
            if let Some(value) = config.get("resolveResult") {
                return Ok(value.clone());
            }
            let mappings = input["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| {
                    config["mappings"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|v| {
                            v["identity"].stringify_canonical()
                                == item["identity"].stringify_canonical()
                        })
                        .cloned()
                        .ok_or_else(|| anyhow!("fixture mapping missing"))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(Value::Array(mappings))
        })
    }
}
