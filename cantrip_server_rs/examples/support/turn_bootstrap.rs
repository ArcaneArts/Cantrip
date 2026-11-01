use anyhow::{Context, Result};
use cantrip_server::{
    chats::{
        Repository, live_mutations::Service as Live, managed_console::ManagedConsole,
        routing::ModelRouting, turn_runtime::bootstrap::Bootstrap,
    },
    database::Database,
    operations::logging::{LogCall, Logger},
    relay::RelayQuotas,
    wire::Value,
    workers::{
        bridge::{BridgeStats, CommandError, EventHandler},
        command_bus::{CommandDelegate, CommandLimits, CommandOutcome, LimitedCommandBus},
    },
};
use futures::{FutureExt, future::BoxFuture};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
struct Control {
    input: Value,
    commands: Mutex<Vec<Value>>,
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
        _: String,
        worker: String,
        command: Value,
        _: Option<Duration>,
        _: Option<EventHandler>,
    ) -> BoxFuture<'static, CommandOutcome> {
        async move {
            self.commands.lock().unwrap().push(Value::object([
                ("worker", Value::from_serialize(&worker)),
                ("command", command.clone()),
            ]));
            let kind = command["type"].as_str().unwrap_or("");
            let error = |message: &str| CommandError {
                message: message.into(),
                code: None,
                unavailable: false,
                encoding_error: None,
                request_id: None,
            };
            if self.input["failCommand"] == kind {
                return Err(error("Controlled bootstrap worker failure"));
            }
            if let Some(reply) = self.input["responses"].get(kind) {
                return Ok(Some(reply.clone()));
            }
            match kind {
                "chat.message.protect" => {
                    let mut message = self.input["protectedMessage"].clone();
                    message["id"] = command["message"]["id"].clone();
                    message["idempotencyKey"] = command["message"]["idempotencyKey"].clone();
                    Ok(Some(message))
                }
                "chat.turn.rollback" => {
                    Ok(Some(Value::object([("rolledBack", Value::Bool(true))])))
                }
                "chat.native-logical.complete" => Ok(Some(Value::Null)),
                _ => Err(error(&format!(
                    "Unexpected bootstrap worker command {kind}"
                ))),
            }
        }
        .boxed()
    }
}
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let control = Arc::new(Control {
        input: input.clone(),
        commands: Mutex::new(Vec::new()),
    });
    let owner = input["owner"]
        .as_str()
        .context("Bootstrap fixture owner")?
        .to_owned();
    let principal = owner.clone();
    let commands = LimitedCommandBus::with_parts(
        control.clone(),
        RelayQuotas::with_limits(64 << 20, 64 << 20, 64 << 20, 64 << 20, 100, 100),
        CommandLimits {
            account_concurrency: 100,
            account_rate_per_minute: 10000,
            worker_concurrency: 100,
            worker_rate_per_minute: 10000,
        },
        Arc::new(move |_| {
            let principal = principal.clone();
            async move { Ok(Some(principal)) }.boxed()
        }),
        Arc::new(|| 0),
    );
    let events = Arc::new(Mutex::new(Vec::new()));
    let stages = Arc::new(Mutex::new(Vec::new()));
    let logger: Logger = {
        let stages = stages.clone();
        Arc::new(move |call: LogCall| {
            if call.context["event"] == "task.turn-bootstrap-stage"
                && call.context["stage"] != "load-worker-attribution"
            {
                let mut record = call.context;
                if let Value::Object(fields) = &mut record {
                    fields.shift_remove("durationMs");
                    fields.shift_remove("err");
                }
                record["message"] = Value::from_serialize(&call.message);
                stages.lock().unwrap().push(record);
            }
        })
    };
    let live = Live::new(
        database.clone(),
        commands.clone(),
        {
            let events = events.clone();
            Arc::new(move |event| {
                events.lock().unwrap().push(event);
                Ok(())
            })
        },
        {
            let events = events.clone();
            Arc::new(move |event| events.lock().unwrap().push(event))
        },
        Arc::new(|| true),
        logger.clone(),
    );
    let routing = ModelRouting::with_logger(
        database.clone(),
        {
            let control = control.clone();
            Arc::new(move |_| control.input["connected"] != false)
        },
        Arc::new(|_, _| async { Ok(false) }.boxed()),
        Arc::new(|| chrono::Utc::now().timestamp_millis() as f64),
        logger.clone(),
    );
    let console = ManagedConsole::new(database.clone(), routing.clone(), commands.clone());
    let bootstrap = Bootstrap::with_observation(
        database.clone(),
        routing,
        console,
        commands.clone(),
        live.clone(),
        logger,
        Arc::new(|| chrono::Utc::now().timestamp_millis()),
    );
    let context = if let Some(context) = input.get("context") {
        context.clone()
    } else {
        Repository::new(database)
            .execution_context(
                &owner,
                input["chat"].as_str().context("Bootstrap fixture Chat")?,
            )
            .await?
            .context("Bootstrap context")?
    };
    let empty = Value::object([] as [(&str, Value); 0]);
    let turn = bootstrap
        .prepare(
            &owner,
            &context,
            input.get("input").unwrap_or(&empty),
            input.get("options").unwrap_or(&empty),
        )
        .await;
    bootstrap.drained().await;
    live.drained().await;
    commands.drained().await;
    let turn = turn?;
    let mut result = Value::object([
        ("execution", turn.execution),
        ("userMessage", turn.user_message),
        ("routePairs", Value::Array(turn.route_pairs)),
        ("attachments", Value::Array(turn.attachments)),
        ("events", Value::Array(events.lock().unwrap().clone())),
        (
            "commands",
            Value::Array(control.commands.lock().unwrap().clone()),
        ),
        ("stageLogs", Value::Array(stages.lock().unwrap().clone())),
    ]);
    if let Some(receipt) = turn.native_receipt {
        result["nativeCommandReceipt"] = receipt;
    }
    Ok(result)
}
