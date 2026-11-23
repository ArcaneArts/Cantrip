//! Development driver: native authority/local coordinator, actual Redis and controlled workers.
use anyhow::{Context, Result, bail};
use cantrip_server::{
    coordination::{Options as RedisOptions, RedisCoordinator},
    wire::{Value, parse_json_text},
    worker_links::{
        Coordinator, Error, Options, authority::Authority, relay::Relay, service::Service,
    },
    workers::bridge::WorkerBridge,
};
use futures::FutureExt;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt},
    sync::mpsc,
};
macro_rules! j { ({$($key:literal:$value:expr),*$(,)?}) => { Value::object([$(( $key, Value::from_serialize(&$value) )),*]) }; }
#[path = "support/worker_link_authority_control.rs"]
mod control;
type Events = Arc<Mutex<Vec<Value>>>;
fn text(r: &Value, key: &str) -> String {
    r[key].as_str().expect("typed fixture string").into()
}
fn record(events: &Events, value: Value) {
    events.lock().unwrap().push(value);
}
struct Driver {
    coordinator: Arc<RedisCoordinator>,
    authority: Arc<Authority>,
    service: Arc<Service>,
    relay_sockets: control::RelaySockets,
    workers: Arc<Mutex<control::Workers>>,
    listeners: Arc<control::Listeners>,
    events: Events,
}
impl Driver {
    async fn new(r: &Value) -> Result<Arc<Self>> {
        let c = &r["options"];
        let mut options = RedisOptions::new(text(c, "url"), text(c, "instanceId"));
        options.key_prefix = text(c, "keyPrefix");
        options.presence_ttl_ms = c["presenceTtlMs"].as_u64().unwrap_or(60000);
        options.maximum_instances = c["maximumInstances"].as_u64().unwrap_or(4);
        let coordinator = RedisCoordinator::new(options)?;
        coordinator.start().await?;
        let events: Events = Arc::default();
        let workers = Arc::new(Mutex::new(control::Workers::default()));
        let request = control::Workers::request(
            workers.clone(),
            r["serverId"].clone(),
            r["workerGeneration"].clone(),
        );
        let mut options = Options::new(text(r, "serverId"), text(r, "serverGeneration"));
        options.peer_configuration = r.get("configuration").cloned();
        if let Some(value) = r["sessionLeaseMs"].as_f64() {
            options.session_lease_ms = value;
        }
        if let Some(value) = r["sessionLifetimeMs"].as_f64() {
            options.session_lifetime_ms = value;
        }
        let observed = events.clone();
        options.logger = Arc::new(move |call| {
            record(
                &observed,
                j!({"kind":"log","level":call.level,"message":call.message,"context":call.context}),
            )
        });
        let relay = Relay::new(
            WorkerBridge::new(std::time::Duration::from_secs(15)),
            Default::default(),
        );
        let service = Service::compose(
            Coordinator::new(request, options),
            relay.clone(),
            Some(coordinator.clone()),
        );
        let authority = service.authority.clone();
        let listeners = control::Listeners::new(&authority, events.clone());
        let observed = events.clone();
        coordinator.subscribe(Arc::new(move |message| {
            if message["kind"] == "fixture-barrier" {
                record(&observed, j!({"kind":"barrier","name":message["name"]}));
            }
            Box::pin(async { Ok(()) })
        }));
        Ok(Arc::new(Self {
            coordinator,
            authority,
            service,
            relay_sockets: control::RelaySockets::new(relay, events.clone()),
            workers,
            listeners,
            events,
        }))
    }
    async fn invoke(self: &Arc<Self>, r: Value) -> Value {
        let c = &self.authority;
        let result: cantrip_server::worker_links::Result<Value> = async {
            Ok(match r["method"].as_str().unwrap_or("") {
                "open" => c.open_session(r["input"].clone()).await?,
                "authorize" => c
                    .session_for_authorization(
                        &text(&r, "session"),
                        r["owner"].clone(),
                        r["account"].clone(),
                    )
                    .await?
                    .unwrap_or(Value::Null),
                "renew" => c.renew_session(&text(&r, "session")).await?,
                "route" => {
                    self.service
                        .replace_route(&text(&r, "session"), r["route"].clone())
                        .await?
                }
                "openPeer" => {
                    self.service
                        .open_peer(&text(&r, "session"), &r["input"])
                        .await?
                }
                "signal" => {
                    c.signal_peer(&text(&r, "session"), r["input"].clone())
                        .await?;
                    Value::Null
                }
                "mailbox" => {
                    c.read_peer_mailbox(&text(&r, "session"), &text(&r, "peer"), r["input"].clone())
                        .await?
                }
                "revokePeer" => Value::Bool(
                    c.revoke_peer(&text(&r, "session"), &text(&r, "peer"))
                        .await?,
                ),
                "issue" => c.issue_grant(r["input"].clone()).await?,
                "renewGrant" => {
                    c.renew_grant(&text(&r, "session"), &text(&r, "grant"))
                        .await?
                }
                "revokeGrant" => Value::Bool(
                    c.revoke_grant(
                        &text(&r, "session"),
                        &text(&r, "grant"),
                        r["reason"].as_str().unwrap_or("released"),
                    )
                    .await?,
                ),
                "revokeSession" => Value::Bool(
                    self.service
                        .revoke_session(
                            &text(&r, "session"),
                            r["reason"].as_str().unwrap_or("released"),
                        )
                        .await?,
                ),
                "revokeAccount" => {
                    Value::from_serialize(&self.service.revoke_account(&text(&r, "account")).await?)
                }
                "revokeOwner" => {
                    Value::from_serialize(&self.service.revoke_owner(&text(&r, "owner")).await?)
                }
                "revokeResource" => Value::from_serialize(
                    &self
                        .service
                        .revoke_resource(
                            &text(&r, "owner"),
                            &text(&r, "kind"),
                            &text(&r, "resource"),
                            r["reason"].as_str().unwrap_or("resource-stopped"),
                        )
                        .await?,
                ),
                "revokeAttachment" => Value::from_serialize(&if r.get("reason").is_none() {
                    self.service
                        .revoke_attachment(
                            &text(&r, "owner"),
                            &text(&r, "kind"),
                            &text(&r, "resource"),
                            &text(&r, "attachment"),
                        )
                        .await?
                } else {
                    c.revoke_attachment(
                        r["owner"].clone(),
                        r["kind"].clone(),
                        r["resource"].clone(),
                        r["attachment"].clone(),
                        r["reason"].clone(),
                    )
                    .await?
                }),
                "close" => {
                    self.service.close().await?;
                    Value::Null
                }
                _ => return Err(anyhow::anyhow!("Unknown authority method").into()),
            })
        }
        .await;
        match result {
            Ok(result) => j!({"ok":true,"result":result}),
            Err(error) => {
                let unavailable = matches!(error, Error::Unavailable(_));
                let message = match error {
                    Error::Unavailable(message) => message,
                    Error::Failure(error) => error.to_string().into(),
                };
                j!({"ok":false,"error":j!({"name":"Error","class":if unavailable {"WorkerLinkUnavailableError"} else {"Error"},"message":message,"unavailable":unavailable})})
            }
        }
    }
    async fn dispatch(self: Arc<Self>, r: Value) -> Result<Value> {
        match r["op"].as_str().unwrap_or("") {
            "call" => Ok(self.invoke(r["call"].clone()).await),
            "begin" => {
                let d = self.clone();
                tokio::spawn(async move {
                    let outcome = d.invoke(r["call"].clone()).await;
                    record(
                        &d.events,
                        j!({"kind":"completion","name":r["name"],"outcome":outcome}),
                    );
                });
                Ok(Value::Null)
            }
            "abandon" => {
                // Poll through the first suspension, then drop the caller future.
                // The Authority's owned work must finish without this waiter.
                let mut operation = Box::pin(self.invoke(r["call"].clone()));
                let _ = operation.as_mut().now_or_never();
                Ok(Value::Null)
            }
            "abandonServiceResource" => {
                drop(self.service.revoke_resource(
                    &text(&r, "owner"),
                    &text(&r, "kind"),
                    &text(&r, "resource"),
                    "resource-stopped",
                ));
                Ok(Value::Null)
            }
            "behavior" => {
                let mut state = self.workers.lock().unwrap();
                if r["value"].is_null() {
                    state.behavior.remove(&text(&r, "command"));
                } else {
                    state
                        .behavior
                        .insert(text(&r, "command"), r["value"].clone());
                }
                Ok(Value::Null)
            }
            "held" => Ok(Value::from_serialize(
                &self
                    .workers
                    .lock()
                    .unwrap()
                    .held
                    .get(&text(&r, "command"))
                    .map_or(0, Vec::len),
            )),
            "release" => {
                let held = self
                    .workers
                    .lock()
                    .unwrap()
                    .held
                    .remove(&text(&r, "command"))
                    .unwrap_or_default();
                let count = held.len();
                for sender in held {
                    let _ = sender.send(r["value"].clone());
                }
                Ok(Value::from_serialize(&count))
            }
            "commands" => Ok(Value::Array(self.workers.lock().unwrap().commands.clone())),
            "events" => Ok(Value::Array(std::mem::take(
                &mut *self.events.lock().unwrap(),
            ))),
            "stats" => Ok(self.authority.stats()),
            "attachRelay" => Ok(Value::Bool(
                self.relay_sockets
                    .attach(text(&r, "name"), r["session"].clone()),
            )),
            "relayOpen" => Ok(Value::Bool(self.relay_sockets.open(&text(&r, "name")))),
            "relayStats" => Ok(self.service.relay.stats()),
            "coordinationStats" => Ok(self.coordinator.stats()),
            "claim" => Ok(self
                .coordinator
                .find_worker_link_session(&text(&r, "session").into())
                .await?
                .unwrap_or(Value::Null)),
            "notify" => {
                self.authority
                    .local
                    .receive_notification(r["worker"].clone(), r["input"].clone())
                    .await;
                Ok(Value::Null)
            }
            "subscribe" => {
                self.listeners
                    .add(text(&r, "name"), text(&r, "token"), r["spec"].clone())?;
                Ok(Value::Null)
            }
            "unsubscribe" => {
                self.listeners.remove(&text(&r, "token"));
                Ok(Value::Null)
            }
            "publish" => {
                self.coordinator.publish(r["payload"].clone(), None).await?;
                Ok(Value::Null)
            }
            "barrier" => {
                self.coordinator.publish(j!({"kind":"fixture-barrier","targetInstanceId":r["target"],"name":r["name"]}),None).await?;
                Ok(Value::Null)
            }
            "close" => {
                self.service.close().await?;
                self.service.drained().await;
                self.coordinator.close().await?;
                Ok(Value::Null)
            }
            _ => bail!("Unknown authority fixture operation"),
        }
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let first = lines.next_line().await?.context("Authority fixture init")?;
    let request = parse_json_text(&first).map_err(|_| anyhow::anyhow!("Fixture init JSON"))?;
    let driver = Driver::new(&request).await?;
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let output = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(value) = rx.recv().await {
            out.write_all((value.stringify() + "\n").as_bytes()).await?;
            out.flush().await?;
        }
        Ok::<_, std::io::Error>(())
    });
    tx.send(j!({"id":request["id"],"result":Value::Null}))?;
    while let Some(line) = lines.next_line().await? {
        let request = parse_json_text(&line).map_err(|_| anyhow::anyhow!("Fixture RPC JSON"))?;
        let (d, tx) = (driver.clone(), tx.clone());
        tokio::spawn(async move {
            let id = request["id"].clone();
            let result = match d.dispatch(request).await {
                Ok(value) => j!({"id":id,"result":value}),
                Err(error) => j!({"id":id,"error":error.to_string()}),
            };
            let _ = tx.send(result);
        });
    }
    driver.service.close().await?;
    driver.service.drained().await;
    driver.coordinator.close().await?;
    drop(tx);
    output.await??;
    Ok(())
}
