//! Disposable manager driver. Real journal/lease authority stays in bundled Codex.
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value, value::json};
use cantrip_worker::inference::{
    admission::{
        Clock, Lease, Lifetime, Manager, Options, Outcome, Promise, Request, Runtime, Ticket,
    },
    ownership::{Options as OwnerOptions, Owner, Scope},
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
#[path = "support/admission_gate.rs"]
mod gate;
#[derive(Default)]
struct Trace {
    diagnostic: Vec<Value>,
    errors: Vec<JsString>,
}
#[derive(Default)]
struct Fixture {
    manager: Option<Manager>,
    runtimes: HashMap<String, Runtime>,
    lifetimes: HashMap<String, Lifetime>,
    tickets: HashMap<String, Ticket>,
    leases: Arc<Mutex<HashMap<String, Lease>>>,
    pending: HashMap<String, Promise<Value>>,
    gates: Arc<gate::Gates>,
    clock: Arc<Mutex<f64>>,
    trace: Arc<Mutex<Trace>>,
}
fn text(input: &Value, field: &str) -> String {
    input[field].as_str().unwrap_or("").to_owned()
}
fn js(input: &Value, field: &str) -> JsString {
    input[field]
        .as_js_string()
        .cloned()
        .unwrap_or_else(|| "".into())
}
fn unit(work: Work<()>) -> Work<Value> {
    Box::pin(async move {
        work.await?;
        Ok(Value::Null)
    })
}
impl Fixture {
    async fn reset(&mut self) -> Result<()> {
        self.gates.release_all();
        if let Some(manager) = self.manager.take() {
            manager.close().await?;
        }
        self.runtimes.clear();
        self.lifetimes.clear();
        self.tickets.clear();
        self.leases.lock().unwrap().clear();
        self.pending.clear();
        self.gates = Arc::new(gate::Gates::default());
        self.trace = Arc::new(Mutex::new(Trace::default()));
        Ok(())
    }
    async fn call(&mut self, input: Value) -> Result<Value> {
        let op = text(&input, "op");
        let name = text(&input, "name");
        match op.as_str() {
            "new" => {
                self.reset().await?;
                *self.clock.lock().unwrap() = 0.;
                let scope = &input["scope"];
                let scope = Scope {
                    server_id: js(scope, "serverId"),
                    owner_id: js(scope, "ownerId"),
                    worker_id: js(scope, "workerId"),
                    worker_generation: js(scope, "workerGeneration"),
                };
                let mut options = Options::local(scope.clone());
                let wall = self.clock.clone();
                let monotonic = self.clock.clone();
                options.clock = Clock {
                    wall: Arc::new(move || 1_700_000_000_000. + *wall.lock().unwrap()),
                    monotonic: Arc::new(move || *monotonic.lock().unwrap()),
                };
                let trace = self.trace.clone();
                options.diagnostic = Arc::new(move |event| {
                    trace.lock().unwrap().diagnostic.push(event);
                    Ok(())
                });
                let trace = self.trace.clone();
                options.journal_error = Arc::new(move |error| {
                    trace.lock().unwrap().errors.push(error.message());
                    Ok(())
                });
                options.observer_error = options.journal_error.clone();
                if let Some(binary) = input["binary"].as_str() {
                    let data = PathBuf::from(input["data"].as_str().unwrap());
                    let mut environment = std::env::vars().collect::<HashMap<_, _>>();
                    environment.insert("PATH".into(), "/usr/bin:/bin".into());
                    let owner = Owner::new(
                        binary.into(),
                        &data,
                        scope,
                        OwnerOptions::local(data.clone(), environment),
                    );
                    options.ownership = Some(Arc::new(gate::Proxy {
                        owner,
                        gates: self.gates.clone(),
                    }));
                }
                if input["recover"] == true {
                    let replies = input["recoveryReplies"].clone();
                    options.reconcile = Some(Arc::new(move |record, _signal| {
                        let mut reply = replies
                            [record["identity"]["operationId"].as_str().unwrap_or("")]
                        .clone();
                        if !reply.is_object() {
                            reply = json!({"disposition":"requeued","chatId":record["identity"]["chatId"]});
                        }
                        reply["key"] = record["key"].clone();
                        Box::pin(async move { Ok(reply) })
                    }));
                }
                self.manager = Some(Manager::new(options));
                return Ok(Value::Null);
            }
            "advance" => {
                *self.clock.lock().unwrap() += input["ms"].as_f64().unwrap();
                return Ok(Value::Null);
            }
            "hold" => {
                self.gates
                    .hold(input["action"].as_str().unwrap(), input["held"] == true);
                return Ok(Value::Null);
            }
            "barrier" => {
                self.gates
                    .barrier(
                        input["action"].as_str().unwrap(),
                        input["count"].as_u64().unwrap_or(1),
                    )
                    .await?;
                return Ok(Value::Null);
            }
            "await" => {
                return self
                    .pending
                    .get(&name)
                    .ok_or_else(|| anyhow!("unknown pending operation"))?
                    .work()
                    .await;
            }
            "poll" => {
                use futures::FutureExt;
                return match self.pending[&name].work().now_or_never() {
                    None => Ok(json!({"pending":true})),
                    Some(result) => Ok(match result {
                        Ok(value) => json!({"pending":false,"ok":true,"value":value}),
                        Err(error) => {
                            json!({"pending":false,"ok":false,"error":cantrip_worker::error::message(&error)})
                        }
                    }),
                };
            }
            _ => {}
        }
        let manager = self.manager.as_ref().unwrap();
        let runtime_name = text(&input, "runtime");
        let ticket_name = text(&input, "ticket");
        match op.as_str() {
            "configure" => return manager.configure(input["input"].clone()).map(|v| json!(v)),
            "catalog" => {
                return manager
                    .configure_catalog(input["input"].clone())
                    .map(|v| json!(v));
            }
            "snapshot" => return Ok(manager.snapshot()),
            "trace" => {
                let trace = self.trace.lock().unwrap();
                return Ok(json!({"diagnostic":trace.diagnostic,"errors":trace.errors}));
            }
            "recovery" => return Ok(Value::Array(manager.recovery_snapshot())),
            "runtime" => {
                let runtime = manager.create_runtime()?;
                let value = json!(runtime.generation());
                self.runtimes.insert(name, runtime);
                return Ok(value);
            }
            "lifetime" => {
                let lifetime = self.runtimes[&runtime_name]
                    .create_operation_lifetime(js(&input, "operation"))?;
                self.lifetimes.insert(name, lifetime);
                return Ok(Value::Null);
            }
            "lifetime.close" => {
                self.lifetimes[&name].close();
                return Ok(Value::Null);
            }
            "lifetime.current" => {
                self.lifetimes[&name].assert_current()?;
                return Ok(Value::Null);
            }
            "request" => {
                let mut request = Request::new(
                    self.lifetimes[&text(&input, "lifetime")].clone(),
                    js(&input, "provider"),
                );
                if let Some(purpose) = input["input"]["purpose"].as_js_string() {
                    request.purpose = Some(purpose.clone());
                }
                request.provider_creation_revision =
                    input["input"]["providerCreationRevision"].as_f64();
                request.chat_id = input["input"].get("chatId").cloned();
                request.project_id = input["input"].get("projectId").cloned();
                request.recovery_key = input["input"].get("recoveryKey").cloned();
                request.recovery = input["input"].get("recovery").cloned();
                request.initially_suspended = input["input"]["initiallySuspended"] == true;
                let ticket = self.runtimes[&runtime_name].request(request)?;
                self.tickets.insert(name, ticket);
                return Ok(Value::Null);
            }
            "status" => return Ok(self.tickets[&ticket_name].status()),
            "cancel" => {
                self.tickets[&ticket_name].cancel(None);
                return Ok(Value::Null);
            }
            "pause" => {
                return Ok(json!(
                    self.tickets[&ticket_name].pause_waiting(input["unforwarded"] == true)
                ));
            }
            "unpark" => {
                self.tickets[&ticket_name].resume_waiting()?;
                return Ok(Value::Null);
            }
            "start" => {
                self.leases.lock().unwrap()[&ticket_name].start()?;
                return Ok(Value::Null);
            }
            "suspend" => {
                self.leases.lock().unwrap()[&ticket_name].suspend()?;
                return Ok(Value::Null);
            }
            "settle" => {
                let outcome = match input["outcome"].as_str().unwrap() {
                    "completed" => Outcome::Completed,
                    "failed" => Outcome::Failed,
                    "interrupted" => Outcome::Interrupted,
                    "runtime-exited" => Outcome::RuntimeExited,
                    "never-started" => Outcome::NeverStarted,
                    _ => bail!("bad settlement"),
                };
                self.leases.lock().unwrap()[&ticket_name].settle(outcome)?;
                return Ok(Value::Null);
            }
            _ => {}
        }
        let work: Work<Value> = match op.as_str() {
            "prepare" => {
                let pending = self.runtimes[&runtime_name].prepare_native_launch();
                Box::pin(async move {
                    let env = pending.await?;
                    Ok(Value::object(env.into_iter().map(|(k, v)| (k, json!(v)))))
                })
            }
            "ready" => {
                let ticket = self.tickets[&ticket_name].clone();
                let leases = self.leases.clone();
                Box::pin(async move {
                    let lease = ticket.ready().await?;
                    leases.lock().unwrap().insert(ticket_name, lease);
                    Ok(Value::Null)
                })
            }
            "queued" => unit(self.tickets[&ticket_name].queued()),
            "confirm-pause" => unit(self.tickets[&ticket_name].confirm_pause()),
            "resume" => unit(self.leases.lock().unwrap()[&ticket_name].resume()),
            "bind" => unit(
                self.leases.lock().unwrap()[&ticket_name]
                    .bind_native(input["execution"].clone())?,
            ),
            "unused" => self.tickets[&ticket_name].unstarted_source(),
            "task-unused" => self.tickets[&ticket_name].private_task_goal_source(),
            "task-withdraw" => self.tickets[&ticket_name]
                .withdraw_task_goal_before_allow(anyhow!("private task gate withdrawn"))?,
            "withdraw" => self.tickets[&ticket_name]
                .withdraw_unstarted(None, input["queueRevision"].as_u64())?,
            "exit" => unit(self.runtimes[&runtime_name].exited()),
            "confirm-owner" => unit(manager.confirm_native_ownership()),
            "close" => unit(manager.close()),
            _ => bail!("unknown admission fixture operation"),
        };
        if input["start"] == true {
            self.pending.insert(name, Promise::spawn(work));
            Ok(Value::Null)
        } else {
            work.await
        }
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let mut fixture = Fixture::default();
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let input =
            cantrip_wire::parse_json_text(&line).map_err(|error| anyhow!("{}", error.lossy()))?;
        let result = match fixture.call(input).await {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":cantrip_worker::error::message(&error)}),
        };
        output
            .write_all((result.stringify() + "\n").as_bytes())
            .await?;
        output.flush().await?;
    }
    fixture.reset().await?;
    Ok(())
}
