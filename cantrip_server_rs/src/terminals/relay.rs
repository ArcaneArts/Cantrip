//! Legacy encrypted terminal relay. Workers retain plaintext and PTY ownership.
use crate::{
    auth::service::AuthService,
    live::Socket,
    wire::{self, Value, value::json},
    workers::{
        bridge::{CommandError, EventHandler},
        command_bus::{CommandFailure, RequestTimeout},
    },
};
use anyhow::{Context, Result};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;

pub(crate) struct Relay {
    service: Arc<AuthService>,
    owner: String,
    operation: Value,
    attachment: String,
    peer: Arc<dyn Socket>,
    context: Mutex<Option<Value>>,
    closed: AtomicBool,
    inputs: Mutex<Option<mpsc::UnboundedSender<Value>>>,
}
impl Relay {
    pub fn attach(
        service: Arc<AuthService>,
        owner: String,
        operation: Value,
        terminal: String,
        peer: Arc<dyn Socket>,
    ) -> Arc<Self> {
        let (send, mut receive) = mpsc::unbounded_channel();
        let relay = Arc::new(Self {
            service: service.clone(),
            owner,
            operation,
            attachment: uuid::Uuid::new_v4().to_string(),
            peer,
            context: Mutex::new(None),
            closed: AtomicBool::new(false),
            inputs: Mutex::new(Some(send)),
        });
        let pending = Arc::downgrade(&relay);
        service.worker_maintenance.spawn_child(async move {
            while let Some(command) = receive.recv().await {
                if let Some(relay) = pending.upgrade() {
                    relay.command(command).await;
                }
            }
            Ok(())
        });
        let pending = relay.clone();
        service
            .worker_maintenance
            .spawn_child(async move { pending.start(&terminal).await });
        relay
    }
    fn send(&self, value: Value) -> Result<()> {
        if self.peer.is_open() {
            let value = wire::parse("terminalServerMessageSchema", Some(&value))
                .map_err(crate::settings::response_error)?;
            let text = value.stringify();
            self.peer.send(text.clone().into())?;
            self.service
                .usage
                .record(&self.owner, "terminal-relay", false, text.len(), 1, true);
        }
        Ok(())
    }
    fn error(&self, message: impl Into<wire::JsString>) {
        let _ = self.send(json!({"type":"error","message":Value::String(message.into())}));
    }
    pub fn receive(self: &Arc<Self>, bytes: &[u8]) {
        self.service
            .usage
            .record(&self.owner, "terminal-relay", true, bytes.len(), 1, true);
        if self.context.lock().unwrap().is_none() {
            return;
        }
        let parsed: Result<Value> = (|| {
            let value = serde_json::from_str::<Value>(&String::from_utf8_lossy(bytes))?;
            wire::parse("terminalClientMessageSchema", Some(&value))
                .map_err(crate::settings::response_error)
        })();
        let Ok(message) = parsed else {
            self.error("Invalid terminal message.");
            return;
        };
        let input = message["type"] == "input";
        if input && message["operationId"] != self.operation {
            self.error("Invalid terminal stream.");
            return;
        }
        let terminal = self.context.lock().unwrap().as_ref().unwrap()["terminalId"].clone();
        let command = if input {
            json!({"type":"terminal.input","terminalId":terminal,"serverId":self.service.server_id,"operationId":self.operation,"sequence":message["sequence"],"protectedData":message["protectedData"],"complete":false})
        } else {
            json!({"type":"terminal.resize","terminalId":terminal,"cols":message["cols"],"rows":message["rows"]})
        };
        if input {
            if let Some(send) = self.inputs.lock().unwrap().as_ref() {
                let _ = send.send(command);
            }
        } else {
            let relay = self.clone();
            self.service.worker_maintenance.spawn_child(async move {
                relay.command(command).await;
                Ok(())
            });
        }
    }
    async fn command(&self, command: Value) {
        let worker = self.context.lock().unwrap().as_ref().unwrap()["workerId"]
            .as_str()
            .unwrap()
            .to_owned();
        if let Err(cause) = self
            .service
            .workers
            .commands
            .request(&worker, command, Some(Duration::from_secs(30)), None)
            .await
        {
            self.error(crate::settings::operation_error_message(&cause.into()));
        }
    }
    pub fn close(self: &Arc<Self>) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.inputs.lock().unwrap().take();
        let context = self.context.lock().unwrap().clone();
        if let Some(context) = context {
            let worker = context["workerId"].as_str().unwrap().to_owned();
            if self.service.workers.bridge.is_connected(&worker) {
                let service = self.service.clone();
                let attachment = self.attachment.clone();
                self.service.worker_maintenance.spawn_child(async move {
                    let _ = service.workers.commands.request(&worker,json!({"type":"terminal.detach","terminalId":context["terminalId"],"attachmentId":attachment}),None,None).await;
                    Ok(())
                });
            }
        }
    }
    async fn status(&self, context: &Value, status: &str) -> Result<()> {
        self.service
            .worker_maintenance
            .record_status(&self.owner, context["terminalId"].as_str().unwrap(), status)
            .await
    }
    async fn event(&self, event: &Value) -> Result<()> {
        let context = self.context.lock().unwrap().clone().unwrap();
        if event["type"] == "terminal.ready" {
            if self.closed.load(Ordering::Acquire) {
                self.service.workers.commands.request(
                    context["workerId"].as_str().unwrap(),
                    json!({"type":"terminal.detach","terminalId":context["terminalId"],"attachmentId":self.attachment}),
                    None, None,
                ).await?;
            } else {
                self.status(&context, "running").await?;
                self.send(json!({"type":"ready"}))?;
            }
        } else if event["type"] == "terminal.output" {
            self.send(json!({"type":"output","operationId":event["operationId"],"sequence":event["sequence"],"protectedData":event["protectedData"]}))?;
        }
        Ok(())
    }
    async fn start(self: &Arc<Self>, terminal: &str) -> Result<()> {
        let Some(context) = super::Repository::new(self.service.repository.database.clone())
            .context(&self.owner, terminal)
            .await?
        else {
            self.error("Terminal not found.");
            self.peer.close(1008, "Terminal not found");
            return Ok(());
        };
        if context["kind"] == "run-configuration"
            || !wire::coercion::truthy(context.get("stateProtection"))
        {
            self.error(
                "Run configuration terminals are read-only and use the managed runtime output API.",
            );
            self.peer
                .close(1008, "Run configuration terminal is read-only");
            return Ok(());
        }
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        *self.context.lock().unwrap() = Some(context.clone());
        let worker = context["workerId"]
            .as_str()
            .context("Terminal relay worker")?;
        if !self.service.workers.bridge.is_connected(worker) {
            self.status(&context, "offline").await?;
            self.error("Project worker is offline.");
            self.peer.close(1013, "Worker offline");
            return Ok(());
        }
        if self.closed.load(Ordering::Acquire) {
            self.status(&context, "idle").await?;
            return Ok(());
        }
        let result: Result<()> = async {
            let mut launch = json!({"type":"shell"});
            if wire::coercion::truthy(context.get("linkedChatId")) {
                let chat = crate::chats::Repository::new(self.service.repository.database.clone()).execution_context(&self.owner,context["linkedChatId"].as_str().context("Linked relay chat")?).await?;
                let runtime = if let Some(chat)=chat.as_ref(){self.service.model_routing.runtime_for_context(&self.owner,chat).await?}else{None};
                let (Some(chat),Some(runtime))=(chat,runtime)else{anyhow::bail!("Choose a model for this chat before opening its Codex console.")};
                launch=self.service.managed_console.prepare_launch(&self.owner,&chat,&runtime).await?;
            }
            let relay = self.clone();
            let event: EventHandler = Arc::new(move |event| {
                let relay = relay.clone();
                Box::pin(async move {
                    let result = relay.event(&event).await;
                    result.map_err(|cause| match cause.downcast_ref::<CommandFailure>() {
                        Some(CommandFailure::Bridge(error)) => error.clone(),
                        _ => CommandError { message:crate::settings::operation_error_message(&cause), code:None, unavailable:false, encoding_error:None },
                    })
                })
            });
            let result = self.service.workers.commands.request_with_timeout(worker,json!({"type":"terminal.open","terminalId":context["terminalId"],"attachmentId":self.attachment,"operationId":self.operation,"serverId":self.service.server_id,"worktreePath":context["worktreePath"],"stateProtection":context["stateProtection"],"cols":80,"rows":24,"launch":launch}),RequestTimeout::Disabled,Some(event)).await?;
            let result = crate::settings::parse_response("terminalOpenResultSchema",result.as_ref())?;
            if result["status"] == "exited" {
                self.status(&context,"exited").await?;
                if !self.closed.load(Ordering::Acquire) { self.send(json!({"type":"exit","exitCode":result["exitCode"],"signal":result["signal"]}))?; }
            }
            Ok(())
        }.await;
        if let Err(cause) = result {
            let offline = matches!(cause.downcast_ref::<CommandFailure>(),Some(CommandFailure::Bridge(error)) if error.unavailable);
            self.status(&context, if offline { "offline" } else { "failed" })
                .await?;
            if !self.closed.load(Ordering::Acquire) {
                self.error(crate::settings::operation_error_message(&cause));
            }
        }
        Ok(())
    }
}
