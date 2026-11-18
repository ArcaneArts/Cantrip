//! Owned admission/keeper driver; only disposable profiles are supplied by QA.
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use cantrip_worker::{
    codex::{process_transport, session::Session},
    inference::{
        identity,
        journal::{AdoptOptions, Journal},
        ownership::{Options, Owner, Scope},
    },
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
#[path = "support/inference_journal_driver.rs"]
mod driver;
#[path = "support/inference_owner_peer.rs"]
mod peer;
#[path = "support/inference_journal_setup.rs"]
mod setup;
fn text(input: &Value, key: &str) -> JsString {
    input[key]
        .as_js_string()
        .cloned()
        .unwrap_or_else(|| "".into())
}
fn some(work: Work<Value>) -> Work<Option<Value>> {
    cantrip_transport::lifecycle::owned(async move { work.await.map(Some) })
}
fn unit(work: Work<()>) -> Work<Option<Value>> {
    cantrip_transport::lifecycle::owned(async move { work.await.map(|_| Some(Value::Null)) })
}
#[derive(Default)]
struct Trace {
    calls: Vec<Value>,
    reports: Vec<JsString>,
}
#[derive(Default)]
struct Fixture {
    owner: Option<Owner>,
    journal: Option<Journal>,
    session: Option<Session>,
    events: Option<tokio::sync::mpsc::UnboundedReceiver<cantrip_worker::codex::session::Event>>,
    pending: HashMap<String, Work<Option<Value>>>,
    fault: Arc<Mutex<String>>,
    trace: Arc<Mutex<Trace>>,
    lost: Arc<AtomicUsize>,
    binary: PathBuf,
    home: PathBuf,
}
impl Fixture {
    async fn reset(&mut self) -> Result<()> {
        if let Some(session) = self.session.take() {
            session.close().await?;
        }
        if let Some(journal) = self.journal.take() {
            journal.flush().await?;
        }
        if let Some(owner) = self.owner.take() {
            owner.close().await?;
        }
        self.events = None;
        self.pending.clear();
        self.trace = Arc::new(Mutex::new(Trace::default()));
        self.lost = Arc::new(AtomicUsize::new(0));
        *self.fault.lock().unwrap() = String::new();
        Ok(())
    }
    async fn call(&mut self, input: Value) -> Result<Option<Value>> {
        let operation = input["op"].as_str().unwrap();
        match operation {
            "identity" => return Ok(Some(json!(identity::recovery(&input["value"])))),
            "queue" => {
                return Ok(Some(json!(identity::queue(
                    &input["chat"],
                    &input["value"]
                ))));
            }
            "key" => {
                return Ok(Some(json!(identity::key(
                    &text(&input, "worker"),
                    &text(&input, "runtime"),
                    &text(&input, "operation")
                ))));
            }
            "schema" => {
                return cantrip_worker::inference::journal::checked(
                    input["schema"].as_str().unwrap(),
                    input.get("value"),
                )
                .map(Some);
            }
            "new" => return setup::configure(self, &input).await,
            "fault" => {
                *self.fault.lock().unwrap() = input["value"].as_str().unwrap().into();
                return Ok(Some(Value::Null));
            }
            "recovery" => {
                return Ok(Some(json!(
                    self.journal.as_ref().unwrap().recovery_snapshot()
                )));
            }
            "status" => {
                let trace = self.trace.lock().unwrap();
                return Ok(Some(
                    json!({"available":self.owner.as_ref().unwrap().available(),"lost":self.lost.load(Ordering::SeqCst),"reports":trace.reports,"calls":trace.calls}),
                ));
            }
            "await" => {
                return self
                    .pending
                    .remove(input["name"].as_str().unwrap())
                    .unwrap()
                    .await;
            }
            "tick" => {
                tokio::time::sleep(Duration::from_millis(input["ms"].as_u64().unwrap_or(20))).await;
                return Ok(Some(Value::Null));
            }
            _ => {}
        }
        let journal = self.journal.as_ref().unwrap();
        let owner = self.owner.as_ref().unwrap();
        let key = input["key"].as_str().unwrap_or("").to_owned();
        let work = match operation {
            "prepare" => {
                let work = owner.prepare(text(&input, "runtime"));
                cantrip_transport::lifecycle::owned(async move {
                    let env = work.await?;
                    Ok(Some(Value::object(
                        env.into_iter().map(|(k, v)| (k, Value::String(v.into()))),
                    )))
                })
            }
            "retire" => unit(owner.retire(text(&input, "runtime"))),
            "close" => unit(owner.close()),
            "raw" => owner.journal(input["command"].clone()),
            "initialize" => unit(journal.initialize()),
            "snapshot" => {
                let work = journal.snapshot();
                cantrip_transport::lifecycle::owned(
                    async move { Ok(Some(Value::Array(work.await?))) },
                )
            }
            "flush" => unit(journal.flush()),
            "enqueue" => some(journal.enqueue(key, input["identity"].clone())),
            "burst" => {
                let pending = input["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| {
                        journal.enqueue(
                            item["key"].as_str().unwrap().into(),
                            item["identity"].clone(),
                        )
                    })
                    .collect::<Vec<_>>();
                cantrip_transport::lifecycle::owned(async move {
                    Ok(Some(Value::Array(
                        futures::future::try_join_all(pending).await?,
                    )))
                })
            }
            "seal" => some(journal.seal_unstarted(key, input["identity"].clone())),
            "grant" => some(journal.grant(key)),
            "requeue" => some(journal.requeue(key)),
            "bind" => some(journal.bind_native(key, input["execution"].clone())),
            "release" => some(journal.release(key, text(&input, "outcome"))),
            "forget" => unit(journal.forget(input["previous"].clone())),
            "adopt" => {
                let mut options = AdoptOptions {
                    retained_order: input["retainedOrder"].as_f64(),
                    ..Default::default()
                };
                for (name, set) in [
                    (
                        "taskInputNotDispatched",
                        &mut options.task_input_not_dispatched,
                    ),
                    (
                        "goalInputNotDispatched",
                        &mut options.goal_input_not_dispatched,
                    ),
                    (
                        "taskGoalCycleNotDispatched",
                        &mut options.task_goal_cycle_not_dispatched,
                    ),
                ] {
                    if let Some(keys) = input[name].as_array() {
                        set.extend(keys.iter().map(|v| v.as_js_string().unwrap().clone()));
                    }
                }
                if input["cancel"] == true {
                    options.assert_current = Arc::new(|| bail!("owned operation canceled"));
                }
                some(journal.adopt(
                    key,
                    input["identity"].clone(),
                    input["previous"].as_array().unwrap().clone(),
                    options,
                ))
            }
            _ => return driver::session(self, &input).await,
        };
        if input["start"] == true {
            self.pending
                .insert(input["name"].as_str().unwrap().into(), work);
            Ok(Some(Value::Null))
        } else {
            work.await
        }
    }
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    #[cfg(target_os = "linux")]
    codex_utils_pty::init_spawn_helper(std::env::args_os());
    if std::env::args().any(|v| v == "cantrip-runtime-owner") {
        return peer::run().await;
    }
    let mut fixture = Fixture::default();
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let input = parse_json_text(&line).map_err(|e| anyhow!("{}", e.lossy()))?;
        let value = match fixture.call(input).await {
            Ok(value) => {
                let mut result = json!({"ok":true});
                if let Some(value) = value {
                    result["value"] = value;
                }
                result
            }
            Err(error) => json!({"ok":false,"error":cantrip_worker::error::message(&error)}),
        };
        out.write_all((value.stringify() + "\n").as_bytes()).await?;
        out.flush().await?;
    }
    fixture.reset().await?;
    Ok(())
}
