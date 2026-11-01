//! Controlled peers around the actual native turn engine and durable writers.
use anyhow::{Context, Result};
use cantrip_server::{
    chats::{
        Repository,
        automatic_title::MessageTitles,
        live_mutations::Service as Live,
        managed_console::ManagedConsole,
        routing::ModelRouting,
        runtime_quota,
        runtime_telemetry::RuntimeTelemetry,
        turn_runtime::{
            bootstrap::{Bootstrap, PreparedTurn},
            engine::{Completed, Continuation, Dependencies, Failed, Hooks, Runtime, Structured},
            events,
        },
    },
    database::Database,
    operations::logging::{LogCall, Logger},
    relay::RelayQuotas,
    wire::{self, Value},
    workers::{
        bridge::{BridgeStats, CommandError, EventHandler},
        command_bus::{CommandDelegate, CommandLimits, CommandOutcome, LimitedCommandBus},
    },
};
use futures::{FutureExt, future::BoxFuture};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?})=>{Value::object([$(( $key,Value::from_serialize(&$value))),*])};
    ($value:expr)=>{Value::from_serialize(&$value)};
}
struct Control {
    database: Arc<Database>,
    input: Value,
    commands: Arc<Mutex<Vec<Value>>>,
    attempt: AtomicUsize,
    chat_attempts: Mutex<std::collections::HashMap<String, usize>>,
    gate: Arc<WorkerGate>,
    peer_trace: Arc<Mutex<Vec<Value>>>,
}
#[derive(Default)]
pub(super) struct WorkerGate {
    released: AtomicBool,
    notify: tokio::sync::Notify,
}
impl WorkerGate {
    pub fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub(super) async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.released.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}
fn template(value: &Value, command: &Value, attempt: &Value) -> Value {
    if let Some(v) = value.as_str() {
        return match v {
            "<goal-message-id>" => command["taskContext"]["message"]["id"].clone(),
            "<goal-message-key>" => command["taskContext"]["message"]["idempotencyKey"].clone(),
            "<goal-thread>" => command["threadId"].clone(),
            "<task-response-id>" => command["resultMode"]["messageId"].clone(),
            "<task-chat>" => command["task"]["chatId"].clone(),
            "<task-operation-id>" => command
                .get("operationId")
                .filter(|v| !v.is_null())
                .unwrap_or(&command["resultMode"]["operation"]["operationId"])
                .clone(),
            "<task-response-key>" => command["resultMode"]["idempotencyKey"].clone(),
            "<lane>" => command["executionLaneId"].clone(),
            "<request>" => command["clientMessageId"].clone(),
            "<thread>" => command
                .get("threadId")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!("stream-thread")),
            "<turn>" => attempt["result"]
                .get("turnId")
                .cloned()
                .unwrap_or_else(|| json!("stream-turn")),
            "<chat>" => command["chatId"].clone(),
            "<worker>" => json!("alpha"),
            _ => value.clone(),
        };
    }
    match value {
        Value::Array(a) => Value::Array(a.iter().map(|v| template(v, command, attempt)).collect()),
        Value::Object(o) => Value::object(
            o.iter()
                .map(|(k, v)| (k.clone(), template(v, command, attempt))),
        ),
        _ => value.clone(),
    }
}
impl CommandDelegate for Control {
    fn stats(&self) -> BridgeStats {
        BridgeStats {
            active_requests: 0,
            connected_workers: 1,
            failed_requests: 0,
            routed_requests: 0,
            succeeded_requests: 0,
        }
    }
    fn is_connected(&self, _: &str) -> bool {
        self.input["connected"] != false
    }
    fn request(
        self: Arc<Self>,
        owner: String,
        worker: String,
        command: Value,
        timeout: Option<Duration>,
        on_event: Option<EventHandler>,
    ) -> BoxFuture<'static, CommandOutcome> {
        async move {
            let (label_index,pause_index)={let mut commands=self.commands.lock().unwrap();commands.push(json!({"worker":worker,"command":command,"timeoutMs":timeout.map(|v|v.as_millis() as u64)}));(commands.iter().filter(|c|c["command"]["type"]=="label.generate").count().saturating_sub(1),commands.iter().filter(|c|matches!(c["command"]["type"].as_str(),Some("chat.pause.set"|"chat.native-control"))).count().saturating_sub(1))};
            if command["type"]=="chat.goal.get" && (self.input["holdGoal"]==true || self.input["holdGoalChats"].as_array().is_some_and(|chats|chats.contains(&command["chatId"]))) { self.gate.wait().await; }
            let failure=|message:String,code:Option<String>,unavailable:bool|CommandError {message:message.into(),code,unavailable,request_id:None,encoding_error:None};
            if self.input.get("failCommand")==command.get("type") {return Err(failure("Controlled recovery worker failure".into(),None,false));}
            match command["type"].as_str().unwrap_or("") {
                "chat.pause.set"|"chat.native-control"=>super::automation_pause::reply(self.database.clone(),&self.input,&owner,&worker,&command,super::automation_pause::Peer{index:pause_index,trace:self.peer_trace.clone(),gate:self.gate.clone()}).await.map(Some).map_err(|error| {
                    let message=error.downcast_ref::<super::automation_pause::PeerMessage>().map(|e|e.0.clone()).unwrap_or_else(||error.to_string().into());
                    CommandError{message,code:None,unavailable:false,request_id:None,encoding_error:None}
                }),
                "task.operation.prepare"=>{
                    if let Some(ms)=self.input["prepareDelayMs"].as_u64(){tokio::time::sleep(Duration::from_millis(ms)).await;}
                    if let Some(sql)=self.input["prepareBeforeReplySQL"].as_str(){self.database.query(sql,&[]).await.map_err(|e|failure(e.to_string(),None,false))?;}
                    let prepared=self.input["preparedTasks"].get(command["task"]["chatId"].as_str().unwrap_or("")).or_else(||self.input.get("preparedTask"));
                    Ok(prepared.map(|value|if self.input["templatePreparedTask"]==true{template(value,&command,&Value::Null)}else{value.clone()}))
                },
                "chat.queue.execute"=>Ok(Some(Value::Null)),
                "chat.thread.ensure"=>Ok(Some(json!({"threadId":"recovery-thread"}))),
                "worktree.status"=>Ok(self.input.get("worktreeStatus").cloned()),
                "chat.turn"=>{
                    let attempt=if let Some(attempts)=self.input["chatAttempts"].get(command["chatId"].as_str().unwrap_or("")) {
                        let index={let mut indices=self.chat_attempts.lock().unwrap();let index=indices.entry(command["chatId"].as_str().unwrap_or("").to_owned()).or_default();let selected=*index;*index+=1;selected};
                        attempts.as_array().and_then(|v|v.get(index))
                    }else{let index=self.attempt.fetch_add(1,Ordering::SeqCst);self.input["attempts"].as_array().and_then(|v|v.get(index))};
                    let Some(attempt)=attempt else{return Err(failure("Unexpected stream attempt".into(),None,false));};
                    if self.input["holdTurnChats"].as_array().is_some_and(|chats|chats.contains(&command["chatId"])) {self.gate.wait().await;}
                    for event in attempt["events"].as_array().into_iter().flatten() {
                        let event=template(event,&command,attempt);
                        let envelope=json!({"kind":"event","requestId":"77777777-7777-4777-8777-000000000001","event":event});
                        let event=wire::parse("workerServerEnvelopeSchema",Some(&envelope)).map_err(|e|{
                            let message=match &e {wire::ValidationError::Invalid(issues)=>Value::Array(issues.clone()).stringify_pretty(),_=>"Worker event validation failed".into()};
                            CommandError{message:message.into(),code:None,unavailable:false,request_id:None,encoding_error:Some(Arc::new(e))}
                        })?["event"].clone();
                        let Some(handler)=&on_event else{return Err(failure("Missing stream event handler".into(),None,false));};
                        handler(event).await?;
                    }
                    if let Some(error)=attempt.get("error") {return Err(failure(error["message"].as_str().unwrap_or("").into(),error["code"].as_str().map(str::to_owned),error["unavailable"]==true));}
                    Ok(attempt.get("result").map(|result|if attempt["templateResult"]==true {template(result,&command,attempt)}else{result.clone()}))
                },
                "chat.message.protect"=>{
                    if self.input["holdProtection"]==true {self.gate.wait().await;}
                    let mut message=self.input["protectedMessage"].clone();
                    message["id"]=command["message"]["id"].clone();message["idempotencyKey"]=command["message"]["idempotencyKey"].clone();
                    message["classification"]["role"]=command["message"]["role"].clone();
                    message["classification"]["mode"]=command["message"].get("mode").filter(|v|!v.is_null()).cloned().unwrap_or_else(||json!("default"));
                    Ok(Some(message))
                },
                "chat.goal.create"|"chat.goal.get"|"chat.goal.update"|"chat.automation.resume"=>{
                    if let Some(sql)=self.input["goalBeforeReplySQL"].as_str(){self.database.query(sql,&[]).await.map_err(|e|failure(e.to_string(),None,false))?;}
                    if let Some(sql)=self.input["goalBeforeReplyByType"].get(command["type"].as_str().unwrap_or("")).and_then(Value::as_str){self.database.query(sql,&[]).await.map_err(|e|failure(e.to_string(),None,false))?;}
                    let fallback=if !command["taskContext"]["message"].is_null(){self.input.get("goalControlReply").unwrap_or(&self.input["goalReply"])}else{&self.input["goalReply"]};
                    let reply=self.input["goalReplies"].get(command["type"].as_str().unwrap_or("")).unwrap_or(fallback);
                    Ok(Some(template(reply,&command,&Value::Null)))
                },
                "task.message.protect"=>Ok(Some(self.input["taskMessage"].clone())),
                "chat.native-logical.complete"|"agent.interaction.cancel"=>Ok(Some(Value::Null)),
                "chat.turn.rollback"=>Ok(Some(json!({"rolledBack":true}))),
                "label.generate"=>{
                    let before=self.input["labelBeforeReplySQL"].as_array().and_then(|a|a.get(label_index)).or_else(||self.input.get("beforeReplySQL"));
                    if let Some(before)=before { for statement in before.as_array().map(Vec::as_slice).unwrap_or_else(||std::slice::from_ref(before)) { if let Some(sql)=statement.as_str(){self.database.query(sql,&[]).await.map_err(|e|failure(e.to_string(),None,false))?;} } }
                    if self.input["failRequest"]==true {return Err(failure("private-provider-error-marker".into(),None,false));}
                    Ok(Some(self.input["labelResults"].as_array().and_then(|a|a.get(label_index)).or_else(||self.input.get("labelResult")).cloned().unwrap_or_else(||json!({"titleProtection":Value::Null}))))
                },
                kind=>Err(failure(format!("Unexpected stream worker command {kind}"),None,false)),
            }
        }.boxed()
    }
}
struct ControlledContinuation {
    trace: Arc<Mutex<Vec<Value>>>,
    pending: bool,
}
impl Continuation for ControlledContinuation {
    fn cancel_outcome_recovery(&self, turn: &PreparedTurn) {
        self.trace.lock().unwrap().push(json!({"kind":"cancel-recovery","worker":turn.execution["workerId"],"chatId":turn.execution["chatId"],"messageId":turn.user_message["id"]}));
    }
    fn continue_worktree(&self, turn: Arc<PreparedTurn>) -> BoxFuture<'static, Result<bool>> {
        self.trace
            .lock()
            .unwrap()
            .push(json!({"kind":"continue-worktree","chatId":turn.execution["chatId"]}));
        let pending = self.pending;
        async move { Ok(pending) }.boxed()
    }
    fn dispatch_queue(&self, turn: Arc<PreparedTurn>) -> BoxFuture<'static, Result<()>> {
        self.trace
            .lock()
            .unwrap()
            .push(json!({"kind":"dispatch-queue","chatId":turn.execution["chatId"]}));
        async { Ok(()) }.boxed()
    }
}
fn completed_hook(trace: Arc<Mutex<Vec<Value>>>, kind: &'static str, fail: bool) -> Completed {
    Arc::new(move |value| {
        let trace = trace.clone();
        async move {
            trace.lock().unwrap().push(json!({"kind":kind,"chatId":value.turn.execution["chatId"],"messageId":value.turn.user_message["id"],"turnId":value.result["turnId"],"attribution":value.turn.attribution}));
            anyhow::ensure!(!fail, "Controlled post-processing failure");
            Ok(())
        }.boxed()
    })
}
fn failed_hook(trace: Arc<Mutex<Vec<Value>>>, kind: &'static str, fail: bool) -> Failed {
    Arc::new(move |value| {
        let trace = trace.clone();
        async move {
            trace.lock().unwrap().push(json!({"kind":kind,"chatId":value.turn.execution["chatId"],"messageId":value.turn.user_message["id"]}));
            anyhow::ensure!(!fail, "Controlled post-processing failure");
            Ok(())
        }.boxed()
    })
}
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    if input["op"] == "native-command-automatic-title" && input["action"] != "generate" {
        let chats = Repository::new(database);
        let owner = input["owner"].as_str().context("Title owner")?;
        let chat = input["chat"].as_str().context("Title Chat")?;
        return match input["action"].as_str() {
            Some("claim") => Ok(json!(
                chats
                    .claim_automatic_title(owner, chat, input["messageId"].as_str())
                    .await?
            )),
            Some("finish") => Ok(chats
                .finish_automatic_title(
                    owner,
                    chat,
                    input["claim"].as_str().context("Title claim")?,
                    input.get("title"),
                    input["empty"] == true,
                )
                .await?
                .unwrap_or(Value::Null)),
            _ => anyhow::bail!("Unknown title action"),
        };
    }
    let control = Arc::new(Control {
        database: database.clone(),
        input: input.clone(),
        commands: Arc::default(),
        attempt: AtomicUsize::new(0),
        chat_attempts: Mutex::default(),
        gate: Arc::default(),
        peer_trace: Arc::default(),
    });
    let owner = input["owner"]
        .as_str()
        .context("Stream fixture owner")?
        .to_owned();
    let principal = owner.clone();
    let worker_owners = cantrip_server::workers::repository::WorkerRepository {
        database: database.clone(),
    };
    let automatic = input["op"] == "native-command-task-automatic"
        || input["op"] == "native-command-task-background"
        || input["op"] == "native-command-turn-outcome";
    let commands = LimitedCommandBus::with_parts(
        control.clone(),
        RelayQuotas::with_limits(64 << 20, 64 << 20, 64 << 20, 64 << 20, 100, 100),
        CommandLimits {
            account_concurrency: 100,
            account_rate_per_minute: 10000,
            worker_concurrency: 100,
            worker_rate_per_minute: 10000,
        },
        Arc::new(move |worker| {
            let p = principal.clone();
            let repo = worker_owners.clone();
            async move {
                if automatic {
                    repo.owner(worker.as_str().context("Worker fixture id")?)
                        .await
                } else {
                    Ok(Some(p))
                }
            }
            .boxed()
        }),
        Arc::new(|| 0),
    );
    let (events, logs, trace, publications) = (
        Arc::new(Mutex::new(Vec::new())),
        Arc::new(Mutex::new(Vec::new())),
        control.peer_trace.clone(),
        Arc::new(Mutex::new(Vec::new())),
    );
    let began = chrono::Utc::now().timestamp_millis();
    let logger: Logger = {
        let logs = logs.clone();
        Arc::new(move |call: LogCall| {
            let mut context = call.context;
            let error = !context["err"].is_null();
            let call_error_message = context["err"]["message"].clone();
            if let Some(duration) = context.get("durationMs") {
                let duration = duration.as_i64().expect("Stream duration");
                assert!(
                    duration >= 0
                        && duration <= chrono::Utc::now().timestamp_millis() - began + 1000
                );
                context["durationMs"] = json!("<duration>");
            }
            if let Value::Object(fields) = &mut context {
                fields.shift_remove("err");
            }
            context["level"] = json!(call.level);
            context["message"] = json!(call.message);
            context["error"] = json!(error);
            if error {
                context["errorMessage"] = call_error_message;
            }
            logs.lock().unwrap().push(context);
        })
    };
    let live = Live::new(
        database.clone(),
        commands.clone(),
        {
            let e = events.clone();
            Arc::new(move |v| {
                e.lock().unwrap().push(v);
                Ok(())
            })
        },
        {
            let e = events.clone();
            Arc::new(move |v| e.lock().unwrap().push(v))
        },
        Arc::new(|| true),
        logger.clone(),
    );
    let routing = ModelRouting::with_logger(
        database.clone(),
        {
            let c = control.clone();
            Arc::new(move |_| c.input["connected"] != false)
        },
        Arc::new(|_, _| async { Ok(false) }.boxed()),
        Arc::new(|| chrono::Utc::now().timestamp_millis() as f64),
        logger.clone(),
    );
    let console = ManagedConsole::new(database.clone(), routing.clone(), commands.clone());
    if input["op"] == "native-command-task-goal"
        || input["op"] == "native-command-task-automatic"
        || input["op"] == "native-command-automation-pause"
    {
        let mut value = super::task_goals::run(
            database,
            input,
            super::task_goals::Environment {
                live: live.clone(),
                commands: commands.clone(),
                routing,
                console,
                logger,
                command_log: control.commands.clone(),
                gate: control.gate.clone(),
                peer_trace: control.peer_trace.clone(),
            },
        )
        .await?;
        live.drained().await;
        commands.drained().await;
        value["commands"] = Value::Array(control.commands.lock().unwrap().clone());
        value["events"] = Value::Array(events.lock().unwrap().clone());
        value["logs"] = Value::Array(logs.lock().unwrap().clone());
        return Ok(value);
    }
    if input["op"] == "native-command-recovery" {
        let mut value = super::recovery::run(
            database,
            input,
            live.clone(),
            commands.clone(),
            routing,
            console,
            logger,
        )
        .await?;
        live.drained().await;
        commands.drained().await;
        value["commands"] = Value::Array(control.commands.lock().unwrap().clone());
        value["events"] = Value::Array(events.lock().unwrap().clone());
        value["logs"] = Value::Array(logs.lock().unwrap().clone());
        return Ok(value);
    }
    let bootstrap = Bootstrap::with_observation(
        database.clone(),
        routing.clone(),
        console.clone(),
        commands.clone(),
        live.clone(),
        logger.clone(),
        Arc::new(|| chrono::Utc::now().timestamp_millis()),
    );
    let titles = MessageTitles::new(
        database.clone(),
        routing.clone(),
        commands.clone(),
        live.clone(),
        logger.clone(),
    );
    let telemetry = Arc::new(RuntimeTelemetry::new(
        database.clone(),
        {
            let p = publications.clone();
            Arc::new(move |v| {
                let mut v = v;
                v["kind"] = json!("usage");
                p.lock().unwrap().push(v)
            })
        },
        logger.clone(),
    ));
    let quota = runtime_quota::Service::new(
        database.clone(),
        commands.clone(),
        {
            let p = publications.clone();
            Arc::new(move |v| p.lock().unwrap().push(v))
        },
        logger.clone(),
    );
    let runtime = Runtime::new(Dependencies {
        events: events::Dependencies {
            database: database.clone(),
            live: live.clone(),
            commands: commands.clone(),
            telemetry,
            quota: quota.clone(),
            clock: Arc::new(|| chrono::Utc::now().timestamp_millis()),
        },
        bootstrap,
        routing: routing.clone(),
        titles: titles.clone(),
        continuation: Arc::new(ControlledContinuation {
            trace: trace.clone(),
            pending: input["pendingTransition"] == true,
        }),
        logger: logger.clone(),
        server_id: "stream-server".into(),
    });
    if input["op"] == "native-command-task-background"
        || input["op"] == "native-command-turn-outcome"
    {
        let environment = super::task_background::Environment {
            runtime: runtime.clone(),
            console,
            routing,
            live: live.clone(),
            commands: commands.clone(),
            logger,
            titles,
            trace: trace.clone(),
            command_log: control.commands.clone(),
            gate: control.gate.clone(),
        };
        let mut value = if input["op"] == "native-command-turn-outcome" {
            super::turn_outcomes::run(database, input, environment).await?
        } else {
            super::task_background::run(database, input, environment).await?
        };
        live.drained().await;
        commands.drained().await;
        quota.close().await;
        value["commands"] = Value::Array(control.commands.lock().unwrap().clone());
        value["events"] = Value::Array(events.lock().unwrap().clone());
        value["publications"] = Value::Array(publications.lock().unwrap().clone());
        value["trace"] = Value::Array(trace.lock().unwrap().clone());
        value["logs"] = Value::Array(logs.lock().unwrap().clone());
        return Ok(value);
    }
    if input["op"] == "native-command-task-claimed" {
        let mut value = super::task_claimed::run(
            database,
            input,
            super::task_claimed::Environment {
                runtime: runtime.clone(),
                goals_console: console,
                routing,
                live: live.clone(),
                commands: commands.clone(),
                logger,
                trace: trace.clone(),
            },
        )
        .await?;
        live.drained().await;
        commands.drained().await;
        quota.close().await;
        value["commands"] = Value::Array(control.commands.lock().unwrap().clone());
        value["events"] = Value::Array(events.lock().unwrap().clone());
        value["publications"] = Value::Array(publications.lock().unwrap().clone());
        value["trace"] = Value::Array(trace.lock().unwrap().clone());
        value["logs"] = Value::Array(logs.lock().unwrap().clone());
        return Ok(value);
    }
    if input["op"] == "native-command-task-queue" {
        let ticks = Arc::new(AtomicUsize::new(0));
        let queue = cantrip_server::task_scheduling::operation_queue::Service::new(
            database.clone(),
            live.clone(),
            titles.clone(),
            {
                let ticks = ticks.clone();
                Arc::new(move || {
                    ticks.fetch_add(1, Ordering::SeqCst);
                })
            },
        );
        let chat = input["chat"].as_str().context("Task queue Chat")?;
        let value = if input["action"] == "retry" {
            let task = if input["task"].as_object().is_some() {
                input["task"].clone()
            } else {
                cantrip_server::tasks::Repository::new(database)
                    .get(&owner, chat)
                    .await?
                    .unwrap_or(Value::Null)
            };
            queue
                .retry(
                    &owner,
                    &task,
                    input.get("operationId"),
                    input["automatic"] == true,
                )
                .await
        } else {
            queue
                .queue(
                    &owner,
                    chat,
                    &input["input"],
                    input["kind"].as_str().context("Task queue kind")?,
                    input["automatic"] == true,
                )
                .await
        };
        queue.drained().await;
        commands.drained().await;
        quota.close().await;
        return Ok(
            json!({"value":value?,"ticks":ticks.load(Ordering::SeqCst),"commands":Value::Array(control.commands.lock().unwrap().clone()),"events":Value::Array(events.lock().unwrap().clone()),"logs":Value::Array(logs.lock().unwrap().clone())}),
        );
    }
    if input["op"] == "native-command-automatic-title" {
        if input
            .get("task")
            .is_some_and(|v| *v == true || v.as_object().is_some())
        {
            let task = if input["task"].as_object().is_some() {
                Some(input["task"].clone())
            } else {
                cantrip_server::tasks::Repository::new(database)
                    .get(&owner, input["chat"].as_str().context("Title Chat")?)
                    .await?
            };
            if let Some(task) = task {
                titles
                    .generate_task(&owner, input["chat"].as_str().context("Title Chat")?, &task)
                    .await?;
            }
        } else {
            titles
                .generate(
                    &owner,
                    input["chat"].as_str().context("Title Chat")?,
                    &input["message"],
                )
                .await?;
        }
        titles.drained().await;
        live.drained().await;
        commands.drained().await;
        quota.close().await;
        return Ok(
            json!({"commands":Value::Array(control.commands.lock().unwrap().clone()),"events":Value::Array(events.lock().unwrap().clone()),"logs":Value::Array(logs.lock().unwrap().clone())}),
        );
    }
    let context = match input.get("context") {
        Some(v) => v.clone(),
        None => Repository::new(database)
            .execution_context(&owner, input["chat"].as_str().context("Stream Chat")?)
            .await?
            .context("Stream context")?,
    };
    let empty = Value::object([] as [(&str, Value); 0]);
    let hooks = Hooks {
        structured: input["options"]
            .get("structuredResult")
            .map(|_| Structured {
                completed: completed_hook(
                    trace.clone(),
                    "structured-completed",
                    input["failHook"] == "structured-completed",
                ),
                failed: failed_hook(
                    trace.clone(),
                    "structured-failed",
                    input["failHook"] == "structured-failed",
                ),
                after_completed: (input["structuredAfter"] == true).then(|| {
                    completed_hook(
                        trace.clone(),
                        "structured-after",
                        input["failHook"] == "structured-after",
                    )
                }),
            }),
        after_completed: (input["afterCompleted"] == true).then(|| {
            completed_hook(
                trace.clone(),
                "after-completed",
                input["failHook"] == "after-completed",
            )
        }),
        after_failed: (input["afterFailed"] == true).then(|| {
            failed_hook(
                trace.clone(),
                "after-failed",
                input["failHook"] == "after-failed",
            )
        }),
    };
    let result = runtime
        .begin(
            &owner,
            &context,
            input.get("input").unwrap_or(&empty),
            input.get("options").unwrap_or(&empty),
            hooks,
        )
        .await;
    runtime.drained().await;
    quota.close().await;
    live.drained().await;
    commands.drained().await;
    let (result, error) = match result {
        Ok(v) => (v, Value::Null),
        Err(e) => (Value::Null, json!(e.to_string())),
    };
    Ok(
        json!({"result":result,"beginError":error,"commands":Value::Array(control.commands.lock().unwrap().clone()),"events":Value::Array(events.lock().unwrap().clone()),"publications":Value::Array(publications.lock().unwrap().clone()),"trace":Value::Array(trace.lock().unwrap().clone()),"logs":Value::Array(logs.lock().unwrap().clone())}),
    )
}
